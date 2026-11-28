import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Connections, object } from './connections.ts';
import { localChatGPTPlanUsage } from './desktop-distribution.ts';
import { DesktopStartupError, desktopCsp, hasDesktopSession, listenHost, lockWorkspace, readDesktopStartup, reportDesktopStartupError } from './desktop-host.ts';
import { TaskManager } from './manager.ts';
import { WorkspaceFeed } from './feed.ts';
import { endpointConfig } from './pi.ts';
import { CredentialVaultError } from './provider-credentials.ts';
import { openLocalCredentials } from './local-credentials.ts';
import { CredentialMigration } from './credential-migration.ts';
import { ProviderError, ProviderManager } from './provider-manager.ts';
import { ProviderOAuthError } from './provider-oauth.ts';
import { ChatGPTRegistrationError } from './chatgpt-registrations.ts';
import { ModelProfiles } from './model-profiles.ts';
import { ManagerError } from './orchestration.ts';
import { ExtensionError } from './extensions.ts';
import { ExternalMcpError } from './external-mcp-client.ts';
import { createPrivateDirectory } from './private-storage.ts';
import { chooseProjectFolder } from './project-folder.ts';
import { nativeBrowserAvailable, openAccountBrowser, openWebAddress } from './native-browser.ts';

const desktopMode = process.argv.includes('--desktop', 2);
async function initialize() {
  const defaultWorkspace = join(homedir(), '.athena', 'workspace');
  const directory = resolve(process.env.ATHENA_DATA_DIR || defaultWorkspace);
  const port = desktopMode ? 0 : Number(process.env.ATHENA_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('Invalid ATHENA_PORT.');
  const modelId = process.env.ATHENA_MODEL?.trim();
  process.umask(0o077);
  createPrivateDirectory(directory);
  const lock = lockWorkspace(directory, desktopMode);
  if (desktopMode) writeSync(1, 'ATHENA_DESKTOP_BOOTSTRAP\n');
  const desktop = desktopMode ? await readDesktopStartup() : undefined;
  const endpoint = endpointConfig();
  const hostModel = endpoint ? { provider: endpoint.provider, modelId: endpoint.model }
    : process.env.ATHENA_PROVIDER && modelId ? { provider: process.env.ATHENA_PROVIDER, modelId } : null;
  const connections = endpoint ? new Connections(directory, endpoint.endpoint, { provider: endpoint.provider, modelId: endpoint.model }, process.env.ATHENA_API_KEY) : undefined;
  const realWorkspace = await realpath(directory);
  const credentialDirectory = process.platform === 'darwin' && directory === defaultWorkspace
    ? join(await realpath(homedir()), 'Library', 'Application Support', 'Athena', 'auth') : join(realWorkspace, 'auth');
  const credentials = await openLocalCredentials(credentialDirectory).catch((error: unknown) => {
    if (desktop && error instanceof CredentialVaultError) throw new DesktopStartupError(error.code);
    throw error;
  });
  const migration = new CredentialMigration({ workspace: realWorkspace, store: credentials,
    requestKey: process.platform === 'darwin' ? desktop?.requestMigrationKey : undefined });
  const nativeBrowser = Boolean(desktop && nativeBrowserAvailable());
  const providers = await ProviderManager.create(credentials, directory, {
    nativeBrowser, chatGPTEnabled: nativeBrowser && localChatGPTPlanUsage,
  });
  const profiles = new ModelProfiles(directory, (provider, id) => providers.model(provider, id), provider => providers.endpoint(provider));
  for (const entry of profiles.compatibleProviders()) await providers.mountCompatible(entry);
  const manager = new TaskManager({ dataDir: directory, externalCredentials: credentials, models: {
    resolve: (conversation, project) => profiles.resolve(conversation, project),
    roleModels:()=>profiles.roleModels(), pin: model => providers.pin(model), requireProfile: id => { profiles.get(id); },
  } });
  await manager.initialize();
  const web = new URL('../athena-backend-handoff/athena-codex-ui/', import.meta.url);
  const html = (await readFile(new URL('athena-preview.html', web), 'utf8')).replace('</body>', '<script src="/athena-host.js"></script></body>');
  const bridge = await readFile(new URL('integrations/athena-host.js', web));
  return { desktop, lock, port, connections, hostModel, migration, providers, profiles, manager, html, bridge };
}

const { desktop, lock, port, connections, hostModel, migration, providers, profiles, manager, html, bridge } = await initialize().catch((error: unknown) => {
  if (!desktopMode) throw error;
  reportDesktopStartupError(error);
  process.exit(1); // Startup did not expose a listener; release any partial resources and the lock.
});
const streams = new Set<ServerResponse>();
const feed = new WorkspaceFeed();
function publish(event: object) {
  const frame = feed.append(event);
  for (const client of streams) {
    if (client.writableLength > 4 * 1024 * 1024) client.destroy(); // reconnect and hydrate from disk
    else client.write(frame);
  }
}
// Many tool events from one Pi turn update the same snapshot. Transport the latest
// projection at most once per frame window; Pi events retain their individual cursors.
let snapshotTimer:ReturnType<typeof setTimeout>|undefined;
let latestSnapshot:import('../athena-backend-handoff/athena-codex-ui/integrations/task-manager.d.ts').WorkspaceSnapshot;
manager.subscribe(snapshot=>{
  latestSnapshot=snapshot;
  if(!snapshot.run?.id||!['running','queued','blocked'].includes(snapshot.run.status)){
    clearTimeout(snapshotTimer);snapshotTimer=undefined;publish({type:'snapshot',snapshot});return;
  }
  if(!snapshotTimer)snapshotTimer=setTimeout(()=>{
    snapshotTimer=undefined;publish({type:'snapshot',snapshot:latestSnapshot});
  },100);
});
manager.subscribeAllPi((sessionId, event) => publish({ type: 'pi', sessionId, event }));

function string(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Expected a nonempty string.');
  return value;
}
function model(value: unknown) {
  if (value == null) return null;
  if (!hostModel || !object(value) || value.provider !== hostModel.provider || value.modelId !== hostModel.modelId || (value.thinkingLevel && value.thinkingLevel !== 'off')) throw new TypeError('Select a saved model profile instead.');
  return hostModel;
}
const idOrNull = (value: unknown) => value === null ? null : string(value);
function booleanArg(value:unknown):boolean {
  if (typeof value!=='boolean') throw new TypeError('Expected a boolean setting.');
  return value;
}
function revisionArg(value:unknown):number|undefined {
  if (value===undefined) return;
  if (typeof value!=='number' || !Number.isSafeInteger(value) || value<0) throw new TypeError('Expected the current settings revision.');
  return value;
}
const profileList = async () => ({ profiles: profiles.list().map(p=>({...p,supportedLevels:profiles.supportedLevels(p)})), workerRoles:profiles.workerPreferences(), appDefaultProfileId: profiles.appDefaultProfileId,
  credentialMode: 'local_file', credentialMigration: await migration.status(), hostModel, accountStates:(await providers.chatGPTAccounts()).map(({authRef,state,planUsage})=>({authRef,state,planUsage})) });
const connectionState = () => connections?.getState() ?? { status: hostModel ? 'configured' : 'disconnected', defaultModel: hostModel, verification: { status: 'not_checked' } };
let credentialWrite = false;
let oauthFlowId: string | undefined;
function oauthPending(): boolean {
  return oauthFlowId !== undefined && providers.oauth?.status(oauthFlowId)?.status === 'pending';
}
function requireCredentialChangeWindow() {
  if (manager.hasPendingRuns() || credentialWrite || oauthPending()) {
    throw new ManagerError('RUN_BUSY', 'Wait for active research or sign-in before replacing or removing provider credentials.');
  }
}
async function changeCredentials<T>(action: () => Promise<T>): Promise<T> {
  requireCredentialChangeWindow();
  credentialWrite = true;
  try { return await action(); }
  finally { credentialWrite = false; }
}
async function rpc(method: string, args: unknown[]) {
  const [input, second] = args;
  switch (method) {
    case 'bibliographyHistory':case 'authorizeSearch':case 'executeSearch':case 'cancelSearch':case 'addSearchSource':
    case 'listPapers':case 'createPaper':case 'addPaperSource':case 'getDocument':case 'saveDocument':
    case 'listLibrarySources':case 'searchAndSavePapers':case 'researchFlow':case 'researchTableInputs':case 'resumeResearch':case 'compilePaper':case 'exportPaper':case 'paperDetails':case 'setPaperOutline':case 'startPaper':
      if(!object(input))throw new TypeError('Expected manuscript request.');
      return manager.paperRequest(method,input);
    case 'chooseProjectFolder': if(!desktop)throw Error('Use the local path field in browser mode.');return chooseProjectFolder();
    case 'getSnapshot': return manager.getSnapshot();
    case 'getExtensions': return manager.getExtensions(string(input));
    case 'installGitHubPlugin': return manager.installGitHubPlugin(string(input),revisionArg(second));
    case 'installPlugin': return manager.installPlugin(string(input),second,revisionArg(args[2]));
    case 'setPluginEnabled': return manager.setPluginEnabled(string(input),string(second),booleanArg(args[2]),revisionArg(args[3]));
    case 'removePlugin': return manager.removePlugin(string(input),string(second),revisionArg(args[2]));
    case 'setSkillEnabled': return manager.setSkillEnabled(string(input),string(second),booleanArg(args[2]),revisionArg(args[3]));
    case 'checkMcpServer': {
      if (args[4] !== undefined && !object(args[4])) throw new TypeError('Expected optional connection credentials.');
      return manager.checkMcpServer(string(input),string(second),string(args[2]),revisionArg(args[3]),args[4] as {token?:string}|undefined);
    }
    case 'getResearch': return manager.getResearch(string(input),second == null ? undefined : string(second));
    case 'decideKnowledge': {
      if (!object(args[2])) throw new TypeError('Expected a human knowledge decision.');
      return manager.decideKnowledge(string(input),string(second),args[2]);
    }
    case 'createProject':
      if (!object(input)) throw new TypeError('Expected project.');
      return manager.createProject({ name: string(input.name), defaultModel: model(input.defaultModel), folder:typeof input.folder==='string'?input.folder:undefined, researchWorkflow:input.researchWorkflow===true, requestId:typeof input.requestId==='string'?input.requestId:undefined });
    case 'createSession': {
      if (!object(input)) throw new TypeError('Expected conversation.');
      if (input.configurationId != null && input.configurationId !== connections?.getState().configurationId) throw new TypeError('The model settings have changed.');
      return manager.createSession({ projectId: string(input.projectId), title: string(input.title ?? 'New research'), firstForProject:input.firstForProject===true, model: model(input.model) });
    }
    case 'openSession': return manager.openSession(string(input));
    case 'getAgentHistory': return manager.getAgentHistory(string(input), string(second));
    case 'cancelTask': return manager.cancelTask(string(input));
    case 'retryTask':
      if (credentialWrite || oauthPending()) throw new ManagerError('CREDENTIAL_BUSY', 'Finish or cancel the credential operation before retrying research.');
      if (!object(second)) throw new TypeError('Expected retry request and attempt IDs.');
      return manager.retryTask(string(input), {requestId:string(second.requestId),expectedAttemptId:string(second.expectedAttemptId)});
    case 'cancelRun': return manager.cancelRun(string(input));
    case 'setProjectDefaultModel': return manager.setProjectDefaultModel(string(input), model(second));
    case 'setProjectExecution':
      if (typeof second !== 'boolean') throw new TypeError('Expected a project analysis permission.');
      return manager.setProjectExecution(string(input), second);
    case 'listProviders': return providers.listProviders(typeof input === 'string' ? input : '');
    case 'getProviderCatalog': {
      if (second !== undefined && !object(second)) throw new TypeError('Expected catalog options.');
      const query = typeof second?.query === 'string' ? second.query : '';
      const accountRef = second?.accountRef === null || typeof second?.accountRef === 'string' ? second.accountRef : undefined;
      const id = string(input);
      if (second?.refresh === true) {
        return changeCredentials(() => providers.catalog(id, { query, refresh: true, accountRef }, entry => profiles.saveEndpoint(entry)));
      }
      return providers.catalog(id, { query, accountRef });
    }
    case 'listChatGPTAccounts': return providers.chatGPTAccounts();
    case 'signOutChatGPTAccount': return changeCredentials(() => providers.signOutChatGPT(string(input)));
    case 'saveProviderApiKey':
      await changeCredentials(() => providers.saveApiKey(string(input), typeof second === 'string' ? second : ''));
      return { saved: true, credentialMode: 'local_file' };
    case 'importLegacyCredentials': {
      if (!desktop || input !== true) throw new ProviderError('UNSUPPORTED_AUTH', 'Use Athena desktop Settings to approve the credential import.');
      return changeCredentials(() => migration.importWithApproval());
    }
    case 'logoutProvider':
      await changeCredentials(() => providers.logout(string(input)));
      return { removed: true };
    case 'startProviderOAuth': {
      requireCredentialChangeWindow();
      const id = string(input);
      if (!providers.providers().find(p => p.id === id)?.methods.some(m => m.kind === 'oauth' && m.enabled) || !providers.oauth) {
        throw new ProviderError('UNSUPPORTED_AUTH', 'OAuth is not available for this provider in Athena.');
      }
      const flow = providers.oauth.start(id, second === undefined ? undefined : string(second));
      oauthFlowId = flow.id;
      return flow;
    }
    case 'getProviderOAuth': {
      // The desktop controller projects browserReady without its private URL.
      return providers.oauth?.status(string(input)) ?? null;
    }
    case 'openWebAddress': {
      if (!desktop || !nativeBrowserAvailable()) throw new TypeError('Opening a system browser requires Athena desktop.');
      if (args.length !== 1 || !await openWebAddress(string(input))) throw new TypeError('Could not open this web address in the system browser.');
      return { opened: true };
    }
    case 'openProviderOAuthBrowser':
    case 'openChatGPTUsage': {
      if (!desktop || !nativeBrowserAvailable() || !providers.oauth) {
        throw new ProviderError('UNSUPPORTED_AUTH', 'The native browser launcher is unavailable.');
      }
      const url = method === 'openChatGPTUsage' ? 'https://chatgpt.com/settings/usage' : providers.oauth.authorizeUrl(string(input));
      const opened = await openAccountBrowser(url);
      if (!opened) throw new ProviderOAuthError('BROWSER_FAILED', 'The system browser could not open the account page. Try again.');
      return { opened: true };
    }
    case 'cancelProviderOAuth': {
      const flow = providers.oauth?.cancel(string(input));
      if (!flow || !desktop) return flow ?? null;
      return { id: flow.id, status: flow.status, ...(flow.error ? { error: flow.error } : {}) };
    }
    case 'listModelProfiles': return profileList();
    case 'saveModelProfile': {
      if (!object(input) || input.authMode !== 'chatgpt') return profiles.save(input);
      return changeCredentials(async () => {
        const model = await providers.authorChatGPTProfile(string(input.modelId), input.accountRef);
        return profiles.save(input, model);
      });
    }
    case 'deleteModelProfile': {
      const id = string(input);
      if (manager.profileInUse(id)) throw new ManagerError('PROFILE_IN_USE', 'Clear project and conversation selections before deleting this profile.');
      profiles.remove(id, second);
      return { removed: true };
    }
    case 'setWorkerModelPreference': {
      if(!object(input))throw new TypeError('Choose a worker role.');
      profiles.setWorkerPreference(string(input.role),idOrNull(input.profileId),idOrNull(input.thinkingLevel));
      return profileList();
    }
    case 'setAppModelProfile': profiles.setAppDefault(idOrNull(input)); return profileList();
    case 'setProjectModelProfile': return manager.setProjectProfile(string(input), idOrNull(second));
    case 'setConversationModelProfile': return manager.setConversationProfile(string(input), idOrNull(second));
    case 'verifyModelProfile': {
      const profile = profiles.get(string(input));
      return profiles.recordCheck(profile.id, profile.revision, await providers.verify(profile));
    }
    case 'registerCompatibleEndpoint': {
      if (!object(input)) throw new TypeError('Expected an endpoint.');
      const name = string(input.name).trim();
      if (name.length > 160 || /[\x00-\x1f\x7f]/u.test(name)) throw new TypeError('Enter an endpoint name under 160 characters.');
      const url = string(input.endpoint).trim();
      if (url.length > 2048) throw new TypeError('Endpoint is too long.');
      return changeCredentials(async () => {
        const provider = await providers.registerCompatible({ id: `compatible-${randomUUID()}`, name, endpoint: url },
          typeof input.apiKey === 'string' && input.apiKey !== '' ? input.apiKey : undefined);
        profiles.saveEndpoint(provider);
        return provider;
      });
    }
    case 'pi': {
      if (!object(second) || typeof second.type !== 'string') throw new TypeError('Expected a Pi command.');
      if (second.type === 'prompt' && (credentialWrite || oauthPending())) {
        throw new ManagerError('CREDENTIAL_BUSY', 'Finish or cancel the credential operation before starting research.');
      }
      return manager.pi(string(input), { ...second, type: second.type, ...(typeof second.id === 'string' ? { id: second.id } : {}) });
    }
    case 'stageFiles': {
      if (!Array.isArray(second)) throw new TypeError('Expected files.');
      return manager.stageFiles(string(input), second.map(item => {
        if (!object(item) || typeof item.data !== 'string' || typeof item.mimeType !== 'string') throw new TypeError('Malformed file.');
        return { name: string(item.name), mimeType: item.mimeType, data: item.data };
      }));
    }
    case 'verifyConnection': case 'saveConfig': {
      if (!connections) throw new TypeError('Configure a model profile under Settings → Models.');
      const result = method === 'verifyConnection' ? await connections.verifyConnection(input) : connections.saveConfig(input);
      publish({ type: 'connection', connection: connections.getState() });
      return result;
    }
    default: throw new TypeError('Unsupported host operation.');
  }
}

async function jsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new RangeError('Request exceeds 16 MiB.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function serve(req: IncomingMessage, res: ServerResponse, draining: boolean) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  const json = (status: number, value: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  const host = `127.0.0.1:${req.socket.localPort}`;
  if (desktop) res.setHeader('Content-Security-Policy', desktopCsp(`http://${host}`));
  if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') { json(403, { error: 'Local same-origin requests only.' }); return; }
  if (desktop) {
    const { host: hosts, origin, 'sec-fetch-site': site } = req.headersDistinct;
    if (hosts?.length !== 1 || (origin && (origin.length !== 1 || origin[0] !== `http://${host}`))
      || (site && (site.length !== 1 || (site[0] !== 'same-origin' && site[0] !== 'none')))) {
      json(403, { error: 'Local same-origin requests only.' }); return;
    }
    if (!hasDesktopSession(req, desktop.token)) { json(401, { error: 'Desktop session required.' }); return; }
  }
  if (draining) { res.setHeader('Connection', 'close'); json(503, { error: 'Host is shutting down.' }); return; }
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', `http://${host}`);
      const artifact = /^\/api\/artifacts\/([\w-]+)\/([\w-]+)$/.exec(url.pathname);
      if (artifact?.[1] && artifact[2]) {
        const { bytes, name, mimeType } = await manager.artifactDownload(artifact[1], artifact[2]);
        res.writeHead(200, { 'Content-Type': mimeType, 'Content-Length': bytes.length, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }).end(bytes);
        return;
      }
      switch (url.pathname) {
        case '/': res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html); return;
        case '/athena-host.js': res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(bridge); return;
        case '/favicon.ico': res.writeHead(204).end(); return;
        case '/api/bootstrap': {
          const snapshot = manager.getSnapshot();
          json(200, { snapshot, execution:snapshot.execution, cursor: feed.cursor, connection: connectionState(), capabilities: [...manager.capabilities, 'manuscripts', ...(desktop?['project_folder_picker']:[]), 'model_profiles', ...(desktop && nativeBrowserAvailable() ? ['system_web_links'] : []), ...(desktop && nativeBrowserAvailable() && providers.oauth ? ['native_oauth_browser'] : [])], piCapabilities: manager.piCapabilities, inputContract: manager.inputContract }); return;
        }
        case '/api/events': {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
          const last = req.headers['last-event-id'];
          const parts = typeof last === 'string' ? last.split(':') : null;
          if (parts || url.searchParams.has('epoch') || url.searchParams.has('after')) {
            const frames = feed.replay(parts ? parts[0] ?? null : url.searchParams.get('epoch'), parts ? parts[1] ?? null : url.searchParams.get('after'));
            if (!frames) { res.end(`data: ${JSON.stringify({ type: 'reset', ...feed.cursor })}\n\n`); return; }
            for (const frame of frames) res.write(frame);
          }
          streams.add(res); res.write(': subscribed\n\n');
          const timer = setInterval(() => res.write(': keepalive\n\n'), 15000);
          res.on('close', () => { clearInterval(timer); streams.delete(res); });
          return;
        }
      }
    }
    if (req.method === 'POST' && req.url === '/api/rpc') {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') { json(415, { error: 'Expected application/json.' }); return; }
      const body = await jsonBody(req);
      if (!object(body) || typeof body.method !== 'string' || !Array.isArray(body.args)) throw new TypeError('Expected {method,args}.');
      json(200, { result: await rpc(body.method, body.args) }); return;
    }
    json(404, { error: 'Not found.' });
  } catch (error) {
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    const known = error instanceof ProviderError || error instanceof ProviderOAuthError || error instanceof ManagerError
      || error instanceof ChatGPTRegistrationError || error instanceof CredentialVaultError
      || error instanceof ExtensionError || error instanceof ExternalMcpError;
    json(error instanceof RangeError ? 413 : 400, { error: known || error instanceof TypeError || error instanceof RangeError ? error.message : 'Request failed.',
      ...(known ? { code: error.code } : {}) });
  }
}

listenHost({ port, desktop, streams, serve, async dispose() {
  try { await manager.close(); }
  finally {
    try { await providers.close(); }
    finally { profiles.close(); connections?.close(); lock.close(); }
  }
} });
