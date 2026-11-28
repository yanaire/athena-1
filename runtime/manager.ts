import { builtins, bindCall } from './mcp-registry.ts';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Storage } from './storage.ts';
import { createPrivateDirectory, hasPrivatePermissions, writeNewPrivateFileSync } from './private-storage.ts';
import type { StoredSession } from './storage.ts';
import type { AthenaTaskManager, ModelReference, Project, SessionActivation, Status, Task, Tool, WorkspaceEvent, WorkspaceSnapshot, Agent } from '../athena-backend-handoff/athena-codex-ui/integrations/task-manager.d.ts';
import type { FileReference } from '../athena-backend-handoff/athena-codex-ui/integrations/pi-bridge-contracts.d.ts';
import type { PiOrchestration } from './agent-tools.ts';
import type { PiModelSelection, PiSessionOptions } from './pi.ts';
import { JobRunner, ANALYSIS_LIMITS, MCP_LIMITS } from './jobs.ts';
import { AnalysisFiles, ANALYSIS_FILE_LIMITS, validateAnalysisName, validateOutputNames } from './analysis-files.ts';
import type { AnalysisSnapshot } from './analysis-files.ts';
import type { JobEvent } from './jobs.ts';
import { ManagerError, object, text, hash, pending, limit, TurnScheduler, artifactRef, executionProjects } from './orchestration.ts';
import type { AgentSession, Context, TaskRow, Attempt, ProcessRow, ArtifactRow } from './orchestration.ts';
import { Journal, context, toolId, normalizeEvent } from './orchestration-journal.ts';
import { projectHistory, withoutAttachmentContext, withMessageOwner } from './history.ts';
import { ToolFailureBudget } from './tool-failure-budget.ts';
import { ExtensionStore, emptyExtensionPin, mentionedSkills, type ExtensionPin } from './extensions.ts';
import { discoverExternalMcp, extensionDigest } from './external-mcp-client.ts';
import { Bibliography } from './bibliography.ts';
import { CrossrefProvider, type BibliographicProvider } from './crossref.ts';
import { experimentContract, plannerDecision, missionPlannerPrompt, measuredMetric, missionProgress, type ExperimentMission, type MissionTrial } from './experiment-mission.ts';
import type { RoleModels, WorkerRole } from './worker-roles.ts';
import { ProjectLibrary, type PaperAcquisition } from './project-library.ts';
import { projectFolder } from './project-folder.ts';
import { template, readTemplate } from './typesetting.ts';
import { parseManuscriptJson, streamedManuscript, sectionBriefs, type ManuscriptDraft } from './manuscript-draft.ts';
import { manuscriptSectionChecks, Papers, bounded, headings, inspectLinks, sectionDrafts, type Paper, type PaperRun, type PaperSource } from './papers.ts';
import { ResearchLedger, type ResearchTarget } from './research.ts';
import type { CredentialStore } from '@earendil-works/pi-ai';
import type { AttachmentMessage, HistoryEvent } from './history.ts';
export { ManagerError } from './orchestration.ts';
export type PiCommand = Readonly<Record<string, unknown>> & { readonly type: string; readonly id?: string };
export type StagedFileInput = { readonly name: string; readonly mimeType: string; readonly data: string };
type PiEvent = Readonly<Record<string, unknown>> & { readonly type: string };
export interface ManagedPiSession {
  readonly sessionId: string;
  readonly sessionFile: string;
  command(command: PiCommand): Promise<unknown>;
  subscribe(listener: (event: PiEvent) => void): () => void;
  close(): void;
  getState(): unknown;
  getMessages(): unknown;
  publicText?(text: string): string;
  prompt(message: string, options?: { readonly kind?: 'reconciliation'; readonly skillContext?:string }): Promise<void>;
}
export type PiSessionFactory = (options: PiSessionOptions) => Promise<ManagedPiSession>;
type ModelResolver = {
  roleModels?():RoleModels;
  resolve(conversation: string | null | undefined, project: string | null | undefined): ModelReference | null;
  pin(model: ModelReference): Promise<PiModelSelection>;
  requireProfile(id: string): void;
};
export type TaskManagerOptions = { readonly dataDir: string; readonly createPiSession?: PiSessionFactory; readonly models?: ModelResolver;
  readonly acquirePaper?:PaperAcquisition; readonly bibliographyProvider?: BibliographicProvider; readonly externalCredentials?: Pick<CredentialStore, 'read' | 'modify' | 'delete'> };
export type Run = {
  readonly roleModels?:RoleModels;
  readonly id: string; readonly projectId: string; readonly sessionId: string;
  readonly requestId: string; readonly taskId: string; readonly title: string;
  readonly status: Status; readonly startedAt: number | null; readonly endedAt: number | null;
  readonly model: ModelReference | null; readonly error?: string;
  readonly extensions?: ExtensionPin;
  readonly cancellationRequested?: boolean;
  readonly recovery?: { readonly requestId: string; readonly reconciliationAttemptId: string };
};
type ResearchFlow={planMode?:'coordinator';runId:string;input:string;fileIds:readonly string[];searchIds:string[];drafts:{heading:string;text:string}[];
  tables?:{artifactId:string;version:string;condition:string;count:number;rows:Record<string,string|number>[];path:string[]}[];
  inputs?:{sourceId:string;version:string;title:string}[];pages?:{sourceId:string;version:string;url:string;retrievedAt:string;claim:string;coverage:string}[];documentId?:string;handoff?:string;citations?:{sourceId:string;claim:string}[];error?:string};
type StoredFile = FileReference & {
  readonly projectId: string; readonly sessionId: string; readonly path: string; readonly digest: string;
};
// Inputs, available resources and prior records can inform the coordinator's plan.
const planningTools = new Set(['plan_research','read','read_file','list_skills','load_skill','get_research_board',
  'search_project_library','read_project_paper','get_task','list_tasks','cancel_task','wait_for_agents']);
const uploadBytes = 256 * 1024;
// Versioned source bytes (including a browser's returned passage) are read through
// the granted fileId. Prompts carry short labels and research uses for those files.
function paperSourceDirectory(sources:readonly PaperSource[],fileIds:readonly string[],paper:Paper,flow?:ResearchFlow) {
  const label=(value:string,limit:number)=>{
    const line=value.replace(/[\s\u0000-\u001f]+/gu,' ').trim();
    return line.length<=limit?line:line.slice(0,limit-1)+'…';
  };
  return JSON.stringify(sources.map((source,i)=>{
    const refs=paper.workflow?.references?.filter(r=>r.sourceId===source.sourceId)??[];
    const visit=flow?.pages?.find(p=>p.sourceId===source.sourceId);
    const ref=refs[0]??visit;
    const claims=refs.length?refs.map(r=>r.claim):[flow?.citations?.find(c=>c.sourceId===source.sourceId)?.claim??visit?.claim];
    const uses=claims.filter((claim):claim is string=>!!claim).map(claim=>label(claim,192));
    // Older browser records append up to 12,000 passage characters to coverage.
    const coverage=ref?.coverage.split('Returned passage:',1)[0]?.replace(/\s*·\s*$/,'').trim()||
      (visit?'Verified browser passage':source.level);
    return {sourceId:source.sourceId,version:source.version,fileId:fileIds[i],title:label(source.title,160),coverage:label(coverage,96),
      ...(ref?{retrievedAt:ref.retrievedAt,...(ref.url.length<=240?{url:ref.url}:{})}:{}),
      ...(uses.length?{claims:uses}:{})};
  }));
}

// Staged inputs must be independently readable UTF-8. Preserve the exact text when
// a large brief or review record spans several files.
function manuscriptContextFiles(name:string, value:string):StagedFileInput[] {
  const bytes=Buffer.from(value);
  const parts:StagedFileInput[]=[];
  for(let start=0;start<bytes.length;){
    let end=Math.min(start+uploadBytes,bytes.length);
    while(end<bytes.length && (bytes[end]! & 0xc0)===0x80)end--;
    parts.push({name:bytes.length>uploadBytes?name+'.part-'+(parts.length+1):name,
      mimeType:'text/plain',data:bytes.subarray(start,end).toString('base64')});
    start=end;
  }
  return parts;
}
type Response = {
  readonly type: 'response'; readonly command: string; readonly id?: string;
  readonly success: boolean; readonly data?: unknown; readonly error?: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function reply(command: PiCommand, data: unknown): Response {
  return { type: 'response', command: command.type, ...(command.id ? { id: command.id } : {}), success: true, data };
}
const READ_COMMANDS = ['get_state', 'get_messages', 'get_available_models', 'get_entries', 'get_tools', 'get_resources', 'get_session_stats', 'get_available_thinking_levels'] as const;
const SNAPSHOT_EVENTS = new Set([
  'agent_start', 'agent_end', 'agent_settled', 'message_end', 'auto_retry_start', 'auto_retry_end',
  'tool_execution_start', 'tool_execution_end', 'compaction_start', 'compaction_end',
]);

type Accepted = { readonly taskId: string; readonly parentTaskId: string | null; readonly agentSessionId: string; readonly attemptId: string; readonly status: Status };
type Dispatch = { readonly id: string; readonly projectId: string; readonly sessionId: string; readonly runId: string; readonly taskId: string; readonly fingerprint: string; readonly response?: Accepted };
export type RetryTaskOptions = { readonly requestId: string; readonly expectedAttemptId: string };
export type RetryTaskResult = Omit<Accepted, 'status' | 'parentTaskId'> & { readonly parentTaskId: string; readonly runId: string; readonly status: 'queued'; readonly reconciliationAttemptId: string };
type RetryReceipt = { readonly id: string; readonly projectId: string; readonly sessionId: string; readonly runId: string;
  readonly taskId: string; readonly requestId: string; readonly expectedAttemptId: string; readonly fingerprint: string;
  readonly response: RetryTaskResult };
type Live = { runtime: ManagedPiSession; controller: AbortController; attempt: Attempt; finished: Promise<void> };

export class TaskManager implements AthenaTaskManager {
  readonly capabilities: AthenaTaskManager['capabilities'] = ['create_project', 'create_session', 'open_session', 'set_project_model', 'set_project_execution', 'cancel_run', 'cancel_task', 'retry_task', 'get_agent_history', 'extensions', 'research_workflow'];
  readonly inputContract = {
    maxMessageCharacters: 262144, lengthUnit: 'utf16-code-units',
    supportsFileReferences: true, canStageFiles: true, supportsStreamingPrompts: false,
  } as const;
  readonly #storage: Storage;
  readonly #directory: string;
  readonly #factory: PiSessionFactory;
  readonly #models: ModelResolver | undefined;
  readonly #pins = new Map<string, PiModelSelection>();
  readonly #workerPins = new Map<string, Map<WorkerRole, PiModelSelection>>();
  #releasePins(runId:string){
    this.#pins.delete(runId);
    this.#workerPins.delete(runId);
  }
  readonly #runtimeModels = new WeakMap<ManagedPiSession, ModelReference>();
  readonly #listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
  readonly #piListeners = new Set<(sessionId: string, event: PiEvent) => void>();
  readonly #journal: Journal;
  readonly #jobs: JobRunner;
  readonly #files: AnalysisFiles;
  readonly #extensions: ExtensionStore;
  readonly #papers: Papers;
  readonly #shutdown=new AbortController();
  readonly #draftStreams=new Map<string,{draft:ManuscriptDraft;sampled:number;saved:number}>();
  readonly #manualCompiles=new Set<Promise<unknown>>();
  readonly #library:ProjectLibrary;
  readonly #bibliography: Bibliography;
  readonly #paperStarting=new Set<string>();
  readonly #research: ResearchLedger;
  readonly #externalCredentials: TaskManagerOptions['externalCredentials'];
  readonly #runtimeExtensions = new WeakMap<ManagedPiSession, ExtensionPin>();
  readonly #enabledProjects = executionProjects();
  readonly #runtimeExecution = new WeakMap<ManagedPiSession, boolean>();
  readonly #concurrency = limit('ATHENA_PROCESS_CONCURRENCY', 1, 1, 4);
  #access: Awaited<ReturnType<JobRunner['analysisAccess']>> = {available:false,reason:'Analysis runtime has not been checked.'};
  readonly #timeoutMs = 5000;
  readonly #registry = new Map<string, ManagedPiSession>();
  readonly #loading = new Map<string, Promise<ManagedPiSession>>();
  readonly #retrying = new Map<string, { fingerprint: string; promise: Promise<RetryTaskResult> }>();
  readonly #retryTasks = new Set<string>();
  readonly #turns = new Map<string, Live>();
  readonly #executing = new Map<string, Attempt>();
  readonly #waiters = new Set<() => void>();
  readonly #modelConcurrency = limit('ATHENA_MODEL_CONCURRENCY', 2, 1, 64);
  readonly #scheduler = new TurnScheduler(this.#modelConcurrency);
  readonly #maxChildren = limit('ATHENA_MAX_CHILDREN', 8, 0, 128);
  readonly #depth = limit('ATHENA_MAX_DEPTH', 1, 0, 1);
  #active: string | null = null;
  #busy = false;
  #ready = false;
  #closed = false;

  constructor(options: TaskManagerOptions) {
    this.#directory = options.dataDir;
    this.#models = options.models;
    this.#storage = new Storage(options.dataDir);
    this.#extensions = new ExtensionStore(this.#storage);
    this.#papers=new Papers(this.#storage);
    this.#library=new ProjectLibrary(this.#storage,this.#papers,this.#directory,options.acquirePaper);
    this.#bibliography=new Bibliography(this.#storage,this.#papers,options.bibliographyProvider??new CrossrefProvider());
    this.#research = new ResearchLedger(this.#storage);
    this.#externalCredentials = options.externalCredentials;
    this.#journal = new Journal(this.#storage);
    this.#files = new AnalysisFiles(options.dataDir);
    this.#jobs = new JobRunner({dataDir: options.dataDir, concurrency: this.#concurrency, timeoutMs:this.#timeoutMs,
      recoveredAttempts: this.#storage.sessions().flatMap(s => this.#storage.records<ProcessRow>('process', s.id).map(p => p.job)),
      onEvent: event => this.#processEvent(event) });
    this.#factory = options.createPiSession ?? (async options => {
      const { createPiSession } = await import('./pi.ts');
      return createPiSession(options);
    });
  }

  get piCapabilities(): string[] { return ['prompt', ...READ_COMMANDS, 'abort', 'stage_files']; }

  async initialize(): Promise<void> {
    if (this.#ready) return;
    if (this.#closed || this.#busy) throw new ManagerError('BUSY', 'Manager is closed or initializing.');
    this.#busy = true;
    try {
      this.#storage.transaction(() => {
        for (const session of this.#storage.sessions()) this.#interrupt(session.id, 'Host restarted before execution settled.');
        for (const receipt of this.#storage.pendingReceipts()) {
          this.#storage.putReceipt({ ...receipt, state: 'interrupted', response: {
            type: 'response', command: 'prompt', id: receipt.requestId, success: false,
            error: 'Execution was interrupted; this request ID will not be dispatched again.',
          } });
        }
        this.#storage.advanceRevision();
      });
      this.#active = this.#storage.get<string | null>('activeSession') ?? null;
      this.#access = await this.#jobs.analysisAccess();
      if (this.#active) await this.#openRoot(this.#session(this.#active));
      this.#ready = true;
    } finally { this.#busy = false; }
  }
  #assertReady(): void {
    if (!this.#ready || this.#closed) throw new ManagerError('NOT_READY', 'TaskManager is not initialized.');
  }
  #assertIdle(): void {
    this.#assertReady();
    if (this.#busy || (this.#active && this.#runs(this.#active).some(run => pending(run.status)))) {
      throw new ManagerError('SESSION_BUSY', 'The active session must settle before switching.');
    }
  }
  #session(id: string): StoredSession {
    const session = this.#storage.session(id);
    if (!session) throw new ManagerError('SESSION_NOT_FOUND', 'Session does not exist.');
    return session;
  }
  #bound(id: string) {
    this.#assertReady();
    const runtime = this.#registry.get(id);
    if (this.#busy || id !== this.#active || !runtime) throw new ManagerError('SESSION_MISMATCH', 'Request is not bound to the selected Pi session.');
    return {session:this.#session(id),runtime};
  }
  #projectDir(projectId:string) { return join(this.#directory, 'projects', projectId); }
  #uploadDirectory(projectId: string): string {
    const root = realpathSync(this.#directory);
    const directory = join(root, 'projects', projectId, 'uploads');
    try { createPrivateDirectory(directory); }
    catch { throw new ManagerError('FILE_SCOPE_MISMATCH', 'Upload storage is not a private project directory.'); }
    const status = lstatSync(directory);
    if (!status.isDirectory() || realpathSync(directory) !== directory) {
      throw new ManagerError('FILE_SCOPE_MISMATCH', 'Upload storage is not a private project directory.');
    }
    return directory;
  }
  #readUpload(file: StoredFile): Buffer {
    if (!/^[a-f0-9-]{36}$/u.test(file.id) || file.path !== join(this.#projectDir(file.projectId), 'uploads', `${file.id}.txt`) ||
      !Number.isSafeInteger(file.size) || file.size < 0 || file.size > uploadBytes) {
      throw new ManagerError('FILE_SCOPE_MISMATCH', 'The saved upload is outside its original project or exceeds its grant.');
    }
    const directory = this.#uploadDirectory(file.projectId);
    const path = join(directory, `${file.id}.txt`);
    try {
      const before = lstatSync(path);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const actual = fstatSync(fd);
        if (!actual.isFile() || actual.nlink !== 1 || !before.isFile() || !hasPrivatePermissions(path, actual) ||
          actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== file.size || realpathSync(path) !== path) {
          throw new ManagerError('FILE_CHANGED', 'The staged upload is no longer the granted file.');
        }
        const bytes = Buffer.allocUnsafe(file.size + 1);
        let size = 0;
        while (size < bytes.length) {
          const count = readSync(fd, bytes, size, bytes.length - size, size);
          if (count === 0) break;
          size += count;
        }
        const snapshot = bytes.subarray(0, size);
        if (size !== file.size || hash(snapshot) !== file.digest) throw new ManagerError('FILE_CHANGED', 'The staged file content changed.');
        return snapshot;
      } finally { closeSync(fd); }
    } catch (error) {
      if (error instanceof ManagerError) throw error;
      if (!(error instanceof Error)) throw error;
      throw new ManagerError('FILE_CHANGED', 'The staged file could not be read securely. Attach it again.');
    }
  }
  #executionEnabled(projectId: string): boolean {
    return this.#access.available && (this.#storage.project(projectId)?.offlineAnalysis ?? this.#enabledProjects.has(projectId));
  }
  async #make(projectId:string, sessionDir:string, role:PiOrchestration['role'], sessionFile?:string, selection?:PiModelSelection, extensions = this.#extensions.pin(projectId),workerRole?:WorkerRole) {
    let runtime: ManagedPiSession;
    // Pi may execute tools from a single model response concurrently. Bind each call at entry,
    // and serialize its manager effects (including spawn then join) in SDK call order.
    let chain = Promise.resolve();
    const executionEnabled = this.#executionEnabled(projectId);
    runtime = await this.#factory({projectDir:this.#projectDir(projectId), sessionDir, sessionFile, selection, orchestration:{role,workerRole,
      executionEnabled, extensions, researchWorkflow:!!this.#storage.project(projectId)?.researchWorkflow,
      execute:(name,raw,args,signal) => {
        const a = this.#executing.get(runtime.sessionId);
        if (!a) throw new ManagerError('ATTEMPT_INACTIVE','No dispatched attempt owns this tool.');
        const work = chain.then(() => this.#operation(a,name,raw,args,signal));
        chain = work.then(()=>{},()=>{}); return work;
      }}});
    if (this.#closed || this.#registry.has(runtime.sessionId)) {
      runtime.close(); throw new ManagerError('SESSION_UNAVAILABLE','Manager closed or duplicate Pi identity.');
    }
    this.#runtimeExecution.set(runtime, executionEnabled);
    this.#runtimeExtensions.set(runtime, structuredClone(extensions));
    if (selection) this.#runtimeModels.set(runtime, { provider: selection.model.provider, modelId: selection.model.id,
      thinkingLevel: selection.thinkingLevel, ...(selection.endpoint ? { endpoint: selection.endpoint } : {}),
      ...(selection.authRef ? { authRef: selection.authRef } : {}) });
    this.#registry.set(runtime.sessionId,runtime); return runtime;
  }
  #load(s: AgentSession, selection?: PiModelSelection, extensions?: ExtensionPin): Promise<ManagedPiSession> {
    const runtime = this.#registry.get(s.id); if (runtime) return Promise.resolve(runtime);
    const loading = this.#loading.get(s.id); if (loading) return loading;
    const promise = this.#make(s.projectId,s.sessionDir,s.role,s.sessionFile,selection,extensions,s.workerRole).then(value => {
      if (value.sessionId !== s.id) { this.#registry.delete(value.sessionId); value.close(); throw new ManagerError('SESSION_ID_MISMATCH','Unexpected Pi identity.'); }
      return value;
    }).finally(()=>this.#loading.delete(s.id));
    this.#loading.set(s.id,promise); return promise;
  }
  #openRoot(s: StoredSession, extensions?: ExtensionPin) { return this.#load({...s,sessionId:s.id,role:'parent'}, undefined, extensions); }
  hasPendingRuns(): boolean {
    return this.#busy || this.#storage.sessions().some(s => this.#runs(s.id).some(r => pending(r.status)));
  }
  profileInUse(id: string): boolean {
    return this.#storage.projects().some(p => p.defaultProfileId === id) || this.#storage.sessions().some(s => s.profileId === id);
  }
  #extensionProject(projectId: string) {
    this.#assertReady();
    if (!this.#storage.project(projectId)) throw new ManagerError('PROJECT_NOT_FOUND','Project does not exist.');
  }
  getExtensions(projectId: string) { this.#extensionProject(projectId); return this.#extensions.snapshot(projectId); }
  installGitHubPlugin(projectId: string, expectedRevision?: number) {
    this.#extensionProject(projectId);
    this.#commit(() => this.#extensions.installGitHub(projectId, expectedRevision));
    return this.getExtensions(projectId);
  }
  installPlugin(projectId: string, manifest: unknown, expectedRevision?: number) {
    this.#extensionProject(projectId);
    this.#commit(()=>{this.#extensions.install(projectId,manifest,expectedRevision);});
    return this.getExtensions(projectId);
  }
  setPluginEnabled(projectId: string, id: string, enabled: boolean, expectedRevision?: number) {
    this.#extensionProject(projectId);
    this.#commit(()=>{this.#extensions.setEnabled(projectId,id,enabled,expectedRevision);});
    return this.getExtensions(projectId);
  }
  removePlugin(projectId: string, id: string, expectedRevision?: number) {
    this.#extensionProject(projectId);
    this.#commit(()=>{this.#extensions.remove(projectId,id,expectedRevision);});
    return this.getExtensions(projectId);
  }
  setSkillEnabled(projectId: string, id: string, enabled: boolean, expectedRevision?: number) {
    this.#extensionProject(projectId);
    this.#commit(()=>{this.#extensions.setSkillEnabled(projectId,id,enabled,expectedRevision);});
    return this.getExtensions(projectId);
  }
  async checkMcpServer(projectId:string,pluginId:string,serverId:string,expectedRevision?:number,options:{token?:string}={}) {
    this.#extensionProject(projectId);
    if (!object(options) || Object.keys(options).some(key=>key!=='token') || options.token !== undefined && (typeof options.token!=='string' || !options.token.trim() || options.token.length>8192 || /[\r\n\0]/.test(options.token))) throw new ManagerError('INVALID_INPUT','Supply only an optional external MCP bearer credential.');
    const configured=this.#extensions.getConfiguredServer(projectId,pluginId,serverId);
    if (expectedRevision !== undefined && expectedRevision !== configured.configurationRevision) throw new ManagerError('STALE_EXTENSION_REVISION','The extension settings changed. Refresh before checking this connection.');
    const revision=expectedRevision ?? configured.configurationRevision;
    let newReference:string|undefined;
    try {
      if (options.token !== undefined && !this.#externalCredentials) throw new ManagerError('MCP_CREDENTIAL_UNAVAILABLE','External MCP credential storage is unavailable.');
      const reference=configured.credentialRef;
      const token=options.token ?? await this.#externalToken(reference);
      const verification=await discoverExternalMcp(configured.server,{token});
      this.#extensionProject(projectId);
      if (this.#extensions.snapshot(projectId).revision!==revision) throw new ManagerError('STALE_EXTENSION_REVISION','The extension settings changed during verification. Check the selected configuration again.');
      let credentialRef=reference;
      if (options.token !== undefined) {
        newReference='athena.external-mcp/'+randomUUID();
        await this.#externalCredentials!.modify(newReference,async()=>({type:'api_key',key:options.token!}));
        credentialRef=newReference;
      }
      this.#extensionProject(projectId);
      this.#commit(()=>{this.#extensions.recordVerification(projectId,pluginId,serverId,verification,configured.pluginRevision,credentialRef,revision);});
      newReference=undefined; // Saved configuration and immutable verification now own this reference.
      return this.getExtensions(projectId);
    } catch(error) {
      if (newReference) await this.#externalCredentials?.delete(newReference);
      const message=error instanceof Error ? error.message : 'External MCP connection check failed.';
      const safe=options.token ? message.replaceAll(options.token,'[redacted]') : message;
      // Do not overwrite a newer user edit with a late probe failure.
      if (!this.#closed && this.#extensions.snapshot(projectId).revision===revision) {
        this.#commit(()=>{this.#extensions.recordVerificationFailure(projectId,pluginId,serverId,safe,configured.pluginRevision,revision);});
      }
      throw new ManagerError('MCP_CONNECTION_FAILED',safe);
    }
  }
  #flow(runId:string) {return this.#storage.get<ResearchFlow>('research.flow:'+runId);}
  #saveFlow(flow:ResearchFlow){this.#storage.set('research.flow:'+flow.runId,flow);}
  #experimentMission(runId:string) {
    return this.#storage.get<ExperimentMission>('experiment.mission:'+runId);
  }

  // Admission and its receipt share #dispatch's transaction. A restored parent
  // joins the exact accepted attempt before it can propose any further work.
  async #missionChild(a:Attempt,study:ExperimentMission,trial:MissionTrial,role:'mission'|'experiment',prompt:string,artifactIds:string[],signal:AbortSignal) {
    let ref = role==='mission' ? trial.planners.at(-1) : trial.worker;
    if (role==='mission' && ref && a.requestId.startsWith('resume:')) {
      const previous=this.#storage.record<Attempt>('attempt',ref.attemptId);
      if (previous && !pending(previous.status) && previous.status!=='succeeded' && ref.coordinatorAttemptId!==a.id)
        trial.rejectedPlanner=previous.id;
    }
    if (!ref || (role==='mission' && ref.attemptId===trial.rejectedPlanner)) {
      const tasks = study.trials.flatMap(t => role==='mission' ? t.planners : t.worker ? [t.worker] : []);
      const prior = tasks.at(-1);
      const requestId = ['mission',study.missionId,trial.number,role,a.id,trial.planners.length].join(':');
      const assignment = prior ? {taskId:prior.taskId,message:prompt} :
        {title:role==='mission'?'Plan experiment trials':'Run experiment trials',prompt};
      const accepted = await this.#dispatch(a,prior?'send_to_agent':'spawn_agent',requestId,{
        ...assignment,requestId,fileIds:role==='experiment'?study.contract.fileIds:[],artifactIds
      },signal,next=>{
        const receipt = {coordinatorAttemptId:a.id,taskId:next.taskId,attemptId:next.id};
        if (role==='mission') trial.planners.push(receipt);
        else trial.worker=receipt;
        this.#storage.set('experiment.mission:'+a.runId,study);
      },!!prior && a.requestId.startsWith('resume:'),role);
      ref={coordinatorAttemptId:a.id,taskId:accepted.taskId,attemptId:accepted.attemptId};
    }
    if (pending(this.#child(a,ref.taskId).status)) await this.#wait(a,[ref.taskId],signal);
    signal.throwIfAborted();
    const result=this.#storage.record<Attempt>('attempt',ref.attemptId);
    if (!result || result.runId!==a.runId || result.taskId!==ref.taskId || result.workerRole!==role || pending(result.status))
      throw new ManagerError('MISSION_RECEIPT','The accepted experiment attempt could not be reconciled.');
    return result;
  }

  async #measureTrial(a:Attempt,study:ExperimentMission,trial:MissionTrial,worker:Attempt,signal:AbortSignal):Promise<NonNullable<MissionTrial['outcome']>> {
    if (worker.status!=='succeeded') return {error:worker.error || 'Experiment worker '+worker.status};
    const {contract}=study;
    const outputs=this.#storage.records<ArtifactRow>('artifact',a.sessionId).filter(row=>
      row.runId===a.runId && row.taskId===worker.taskId && row.attemptId===worker.id && row.file.name===contract.resultFile);
    if (outputs.length!==1) return {error:'Expected one '+contract.resultFile+' from this attempt, found '+outputs.length+'.'};
    const row=outputs[0]!;
    const invocation=this.#storage.record<ProcessRow>('process',row.processId)?.job.externalMcp;
    const binding=contract.measurementTool;
    if (binding && (invocation?.serverId!==binding.serverId || invocation.tool!==binding.tool))
      return {error:'Artifact was produced outside the selected measurement tool.'};
    const artifact=await this.#researchTarget(context(a),{kind:'artifact',id:row.id});
    const bytes=await this.#readArtifact(row);
    let value:number;
    try { value=measuredMetric(bytes,contract.metricPath); }
    catch(error) {return {error:error instanceof Error?error.message:'The metric could not be read.',candidate:artifact};}
    const evidence=await this.#research.addEvidence(a,{
      missionId:study.missionId,requestId:'mission-trial:'+study.missionId+':'+trial.number,
      title:'Experiment trial '+trial.number,summary:(contract.metricPath.join('.')||contract.resultFile)+' = '+value,
      fileIds:contract.fileIds,artifactIds:[row.id]
    },(ctx,t)=>{signal.throwIfAborted();return this.#researchTarget(ctx,t);});
    return {value,artifact,evidenceId:evidence.id};
  }

  async #runExperimentMission(a:Attempt,args:Readonly<Record<string,unknown>>,signal:AbortSignal) {
    this.#requireEnabled(a);
    this.#requireCoordinatorWrites(a);
    const mission = this.#research.snapshot(a).missions.find(m => m.runId===a.runId && m.id===args.missionId);
    if (!mission || a.parentTaskId || !this.#flow(a.runId) || this.#storage.get('paper.run:'+a.runId))
      throw new ManagerError('MISSION_DENIED','Choose a saved plan in the current research run.');
    const saved = this.#experimentMission(a.runId);
    const contract = args.contract===undefined && saved ? saved.contract : experimentContract(args.contract,a.fileIds);
    if (saved && (saved.missionId!==mission.id || canonical(saved.contract)!==canonical(contract)))
      throw new ManagerError('MISSION_CONFLICT','This run already has a frozen experiment contract.');
    const binding=contract.measurementTool;
    if (binding && !this.#runExtensions(a).servers.some(s=>s.id===binding.serverId && s.verification.tools.some(t=>t.name===binding.tool)))
      throw new ManagerError('MISSION_INPUT','The measurement tool must be enabled and verified for this run.');
    const study:ExperimentMission = saved ?? {missionId:mission.id,contract,status:'running',trials:[]};
    const key = 'experiment.mission:'+a.runId;
    const store = () => this.#storage.set(key,study);
    const checkpoint = () => this.#commit(store);
    const report = () => ({...study,...missionProgress(study)});
    if (study.status!=='running' && study.status!=='blocked') return report();
    if (study.status==='blocked' && a.id===study.blockedAttempt) return report();
    study.status='running';
    const repairHint=study.reason;
    delete study.reason;
    delete study.blockedAttempt;
    checkpoint();

    try {
      while (study.status==='running') {
        signal.throwIfAborted();
        this.#requireEnabled(a);
        let trial=study.trials.at(-1);
        if (!trial || trial.outcome) {
          if (missionProgress(study).reached) {study.status='reached';break;}
          if (study.trials.length>=contract.maxTrials) {study.status='exhausted';study.reason='The fixed trial budget was used.';break;}
          trial={number:study.trials.length+1,planners:[]};
          study.trials.push(trial);
          checkpoint();
        }
        const previous=study.trials.slice(0,-1);
        if (!trial.decision) {
          const prompt=missionPlannerPrompt(mission,contract,previous)+(trial.rejectedPlanner && repairHint?'\nCorrect the previous decision: '+repairHint:'');
          const planner=await this.#missionChild(a,study,trial,'mission',prompt,[],signal);
          if (planner.status==='cancelled') {study.status='stopped';study.reason='The mission planner was stopped.';break;}
          if (planner.status!=='succeeded') {
            trial.rejectedPlanner=planner.id;
            throw new Error(planner.error || 'Mission planner '+planner.status);
          }
          try {trial.decision=plannerDecision(planner.result??'',previous);}
          catch(error) {trial.rejectedPlanner=planner.id;throw error;}
          checkpoint();
        }
        const decision=trial.decision;
        if (decision.action==='stop') {study.status='stopped';study.reason=decision.reason;break;}
        const base=previous.find(t=>t.number===decision.parentTrial)?.outcome;
        const grants=base && 'artifact' in base ? [base.artifact.id] : [];
        const worker=await this.#missionChild(a,study,trial,'experiment','Execute the assigned experiment using the available tools.\nContract: '+
          JSON.stringify(contract)+'\nExperiment instruction: '+decision.instruction+
          '\nPublish the actual output using the agreed measurement method. Report any failure or concern about the method in your final response.',grants,signal);
        if (worker.status==='cancelled' && !(a.requestId.startsWith('resume:') && trial.worker?.coordinatorAttemptId!==a.id)) {study.status='stopped';study.reason='The experiment worker was stopped.';break;}
        if(worker.result)trial.workerNote=worker.result.slice(0,600);
        trial.outcome=await this.#measureTrial(a,study,trial,worker,signal);
        signal.throwIfAborted();
        checkpoint();
      }
    } catch(error) {
      signal.throwIfAborted();
      study.status='blocked';
      study.blockedAttempt=a.id;
      study.reason=error instanceof Error?error.message.slice(0,512):'The experiment mission was interrupted.';
    }
    checkpoint();
    return report();
  }

  async #prepareResearchPaper(a:Attempt,args:Readonly<Record<string,unknown>>,signal:AbortSignal) {
    this.#requireCoordinatorWrites(a);this.#requireEnabled(a);
    const flow=this.#flow(a.runId);
    if(a.parentTaskId||!flow)throw new ManagerError('FLOW_DENIED','This tool requires a research project request.');
    const fingerprint=hash(canonical(args));
    if(flow.documentId){
      if(flow.handoff!==fingerprint)throw new ManagerError('REQUEST_ID_CONFLICT','A different handoff was already saved.');
      return {documentId:flow.documentId};
    }
    const review=this.#research.snapshot(a).reviews.find(r=>r.id===args.reviewId&&r.requestedBy.runId===a.runId);
    if(review?.state!=='completed'||review.executionStatus!=='succeeded'||review.verdict!=='supported')
      throw new ManagerError('REVIEW_REQUIRED','Join a successful independent review of these experiment outputs first.');
    const visited=flow.pages??[], selected=args.pageSourceIds;
    if(selected!==undefined && (!Array.isArray(selected)||selected.length>6||new Set(selected).size!==selected.length||
      selected.some(id=>typeof id!=='string'||!visited.some(page=>page.sourceId===id))))
      throw new ManagerError('SOURCE_DENIED','Select distinct visited page source IDs recorded for this research request.');
    const pages=selected===undefined?visited:visited.filter(page=>selected.includes(page.sourceId));
    const attachments=a.fileIds.map(id=>this.#storage.record<StoredFile>('file',id)).filter(f=>f?.name.toLowerCase().endsWith('.tex'));
    const attached=attachments.find(f=>f?.name===args.template);
    const layout=attached?readTemplate(this.#upload(a,attached.id).bytes.toString('utf8')):undefined;
    const style=layout?.style??template(args.template),outline=headings(args.outline);
    if(!Array.isArray(args.artifactIds)||!args.artifactIds.length||args.artifactIds.length>8)throw Error('Select one to eight reviewed experiment outputs.');
    const evidence=[];
    const tables:NonNullable<NonNullable<Paper['workflow']>['tables']>=[];
    const upstreamPages=new Set(visited.map(p=>this.#papers.source(a.projectId,p.sourceId).origin).flatMap(o=>o&&'kind' in o?[o.id]:[]));
    for(const id of args.artifactIds) {
      const target=await this.#researchTarget(a,{kind:'artifact',id:text(id,'Artifact ID')});
      if(!review.targets.some(t=>canonical(t)===canonical(target)))throw Error('The review does not cover this exact artifact.');
      if(upstreamPages.has(target.id)&&!flow.tables?.some(t=>t.artifactId===target.id))throw Error('A cited page alone is not an experiment output.');
      const row=this.#artifact(a,id),bytes=await this.#readArtifact(row);
      const source=this.#papers.saveSource(a.projectId,row.file.name,new TextDecoder('utf-8',{fatal:true}).decode(bytes),'full_text',target);
      evidence.push({sourceId:source.sourceId,version:source.version});
      const table=flow.tables?.find(t=>t.artifactId===target.id&&t.version===target.version);
      if(table)tables.push({sourceId:source.sourceId,version:source.version,path:table.path});
    }
    for(const page of pages)if(!evidence.some(s=>s.sourceId===page.sourceId))evidence.push({sourceId:page.sourceId,version:page.version});
    const citations:NonNullable<ResearchFlow['citations']>=[];
    for(const cite of Array.isArray(args.citations)?args.citations:[]) {
      if(!object(cite)||!flow.searchIds.includes(String(cite.searchId)))throw Error('Bibliography source belongs to a different research request.');
      const source=this.#bibliography.add(a.projectId,a.sessionId,String(cite.searchId),cite.doi);
      citations.push({sourceId:source.sourceId,claim:bounded(cite.claim,'claim',512)});
      evidence.push({sourceId:source.sourceId,version:source.version});
    }
    signal.throwIfAborted();
    const inputs:NonNullable<ResearchFlow['inputs']>=[];
    for(const id of Array.isArray(args.inputIds)?args.inputIds:[]){
      const target=await this.#researchTarget(a,{kind:'file',id:text(id,'Original input')});
      const {f,bytes}=this.#upload(a,target.id);
      const source=this.#papers.saveSource(a.projectId,f.name,bytes.toString('utf8'),'full_text',target);
      inputs.push({title:f.name,sourceId:source.sourceId,version:source.version});
      evidence.push({sourceId:source.sourceId,version:source.version});
    }
    const retained:NonNullable<NonNullable<Paper['workflow']>['references']>=[];
    for(const item of Array.isArray(args.librarySources)?args.librarySources:[]){
      if(!object(item))throw new ManagerError('SOURCE_DENIED','Select a project library edition.');
      const version=text(item.version,'Source version');
      const {entry}=this.#library.read(a.projectId,text(item.sourceId,'Library source'),version);
      const claim=bounded(item.claim,'claim',512);
      retained.push({sourceId:entry.sourceId,url:entry.url,retrievedAt:entry.retrievedAt,coverage:entry.coverage,claim});
      if(!evidence.some(s=>s.sourceId===entry.sourceId))evidence.push({sourceId:entry.sourceId,version});
    }
    if(!retained.length&&!pages.length&&!citations.length&&!inputs.length)throw Error('Supply the reviewed source of the method or data: a visited page, Crossref record, or granted research input.');
    signal.throwIfAborted();
    if(evidence.length>8)throw new ManagerError('INVALID_EVIDENCE','Select at most eight source editions across results, inputs, visited pages and bibliography. Use pageSourceIds to choose visited pages.');
    const pageRefs=pages.map(p=>({url:p.url,retrievedAt:p.retrievedAt,coverage:p.coverage,claim:p.claim,sourceId:p.sourceId}));
    const doiRefs=citations.map(c=>{
      const origin=this.#papers.source(a.projectId,c.sourceId).origin;
      if(!origin||!('provider' in origin))throw Error('Expected a Crossref source.');
      return {url:'https://doi.org/'+origin.providerId,retrievedAt:origin.retrievedAt,coverage:origin.hasAbstract?'metadata and abstract':'metadata',...c};
    });
    const d=this.#papers.create(a.projectId,{title:args.title,goal:flow.input.slice(0,4096),outline,evidence},
      {runId:a.runId,sessionId:a.sessionId,reviewId:review.id,template:style,tables,...(layout&&attached?{layout:{preamble:layout.preamble,name:attached.name,version:attached.versionId!}}:{}),references:[...pageRefs,...doiRefs,...retained]},
      doc=>this.#saveFlow({...this.#flow(a.runId)!,documentId:doc.id,handoff:fingerprint,citations:[...citations,...retained.map(r=>({sourceId:r.sourceId,claim:r.claim}))],inputs}));
    this.#commit(()=>this.#journal.event(a,'research_handoff','Pinned experiment sources for manuscript.'));
    return {documentId:d.id,sources:evidence};
  }
  async #searchAndSave(project:string,session:string,id:string,signal:AbortSignal,execution?:{runId:string;taskId:string;attemptId:string;toolId:string}){
    const result=await this.#bibliography.execute(project,session,id,signal,execution);
    const saved=[];
    for(const record of result.records){
      signal.throwIfAborted();
      const source=this.#bibliography.add(project,session,id,record.doi);
      const entry=await this.#library.savePaper(project,source,signal);
      saved.push({sourceId:entry.sourceId,version:entry.version,doi:entry.doi,coverage:entry.coverage,file:entry.note,original:entry.original?.file,detail:entry.detail});
    }
    return {...result,saved};
  }
  #continueFlow(run:Run) {
    const flow=this.#flow(run.id);
    if(!flow?.documentId||run.status!=='succeeded'||run.cancellationRequested||this.#active!==run.sessionId)
      throw new ManagerError('FLOW_BLOCKED','Resume from a successful verified experiment in its original conversation.');
    return this.#startPaper(run.projectId,flow.documentId,{sessionId:run.sessionId,mode:'write',requestId:'workflow:'+run.id},run);
  }
  async #resumeFlow(project:string,args:Record<string,unknown>) {
    this.#assertReady();
    const flowRun=this.#storage.record<Run>('run',text(args.runId,'Research run'));
    if(!flowRun||flowRun.projectId!==project||flowRun.sessionId!==this.#active)throw new ManagerError('CHECKPOINT_UNAVAILABLE','Open the owning conversation first.');
    const flow=this.#flow(flowRun.id);
    if(!flow)throw new ManagerError('CHECKPOINT_UNAVAILABLE','No research workflow for this request.');
    const paper=flow.documentId?this.#papers.paper(project,flow.documentId):undefined;
    const paperRun=paper?.runs.findLast(r=>r.mode==='write'&&r.context.sessionId===flowRun.sessionId);
    if(paper&&!paperRun&&flowRun.status==='succeeded')return this.#continueFlow(flowRun);
    const run=paperRun?this.#storage.record<Run>('run',paperRun.id):flowRun;
    if(!run||run.id!==this.#currentRun(flowRun.sessionId)?.id)throw new ManagerError('CHECKPOINT_UNAVAILABLE','Only the latest request can resume.');
    const task=this.#storage.record<TaskRow>('task',run.taskId),previous=task&&this.#storage.record<Attempt>('attempt',task.attemptId);
    const expected=text(args.expectedAttemptId,'Checkpoint attempt');
    const key='flow.resume:'+run.id+':'+expected;
    const accepted=this.#storage.get<{runId:string;attemptId:string}>(key);
    if(accepted)return accepted;
    this.#assertIdle();
    if(!previous||previous.id!==expected)throw new ManagerError('CHECKPOINT_UNAVAILABLE','The checkpoint changed. Refresh progress.');
    if(!this.#executionEnabled(project))throw new ManagerError('CHECKPOINT_UNAVAILABLE','Restore project analysis access first.');
    if(paper&&paperRun){
      const saved=paperRun.versions.at(-1)??paperRun.baseVersion;
      if((paper.versions.at(-1)??null)!==saved)throw new ManagerError('CHECKPOINT_UNAVAILABLE','The manuscript changed. Review its edited version separately.');
      if(saved&&this.#papers.version(project,paper.id,saved).compilation?.state==='succeeded')throw new ManagerError('CHECKPOINT_UNAVAILABLE','This revision is already typeset.');
      if(paperRun.reviews.at(-1)?.verdict==='insufficient_evidence')throw new ManagerError('CHECKPOINT_UNAVAILABLE','The reviewer needs additional evidence for a new manuscript request.');
    }
    const session=this.#session(run.sessionId),extensions=this.#runExtensions(previous);
    this.#busy=true;
    try{
      for(const id of previous.fileIds)this.#upload(previous,id);
      for(const server of extensions.servers)await this.#externalToken(server.verification.credentialRef);
      const pin=run.model?.profileId&&this.#models?await this.#models.pin(run.model):undefined;
      const runtime=await this.#retryRuntime({...session,sessionId:session.id,role:'parent'},run.model,pin,true,extensions);
      const held=this.#children(previous).map(t=>({taskId:t.id,title:t.title,status:t.status,artifactIds:t.artifactIds}));
      const board=this.#research.snapshot(previous);
      const adaptive=this.#experimentMission(run.id);
      const prompt=paper?'Manuscript write request. Resume the saved manuscript checkpoints with compose_manuscript({}).':
        'Continue this research request from the stored checkpoints. '+(flow.planMode && !board.missions.some(m=>m.runId===run.id)?'Create the missing plan with plan_research. ':'Use the existing plan. ')+
        (adaptive?'Call run_experiment_mission with only missionId '+adaptive.missionId+' to reconcile its saved trials. ':'')+
        'Reuse saved evidence, reviews and published artifacts. Do not repeat completed experiments. '+
        'Use get_research_board and list_tasks. Retry only missing or failed work. Once a review supports the results call prepare_research_paper. Original request: '+flow.input+
        '\nExisting tasks: '+JSON.stringify(held)+'\nMission IDs: '+JSON.stringify(board.missions.filter(m=>m.runId===run.id).map(m=>m.id));
      const next=this.#attempt(context(previous),'resume:'+expected,prompt,previous.fileIds,run.model??undefined);
      const response={runId:run.id,attemptId:next.id};
      this.#commit(()=>{
        this.#storage.putRecord('run',{...run,endedAt:null,status:'queued',error:undefined,cancellationRequested:false,recovery:undefined});
        this.#journal.accept(next,task!.title);
        if(paper&&paperRun){
          paperRun.context=context(next);paperRun.stage='requested';delete paperRun.error;this.#papers.put(paper);
        }
        this.#saveFlow({...flow,error:undefined});this.#storage.set(key,response);
      });
      if(pin)this.#pins.set(run.id,pin);
      this.#schedule(next,runtime);return response;
    }finally{this.#busy=false;}
  }
  #flowReport(project:string,session:string,selected?:unknown) {
    if(session!==this.#active||this.#session(session).projectId!==project)throw new ManagerError('SESSION_MISMATCH','Open the owning research conversation.');
    const runs=this.#runs(session);
    const history=runs.filter(r=>this.#flow(r.id));
    const run=selected?history.find(r=>r.id===selected):history.at(-1);
    if(!run)return null;
    const flow=this.#flow(run.id)!;
    const board=this.#research.snapshot({projectId:project,sessionId:session});
    const missions=board.missions.filter(m=>m.runId===run.id);
    const study=this.#experimentMission(run.id);
    const mission=study?missions.find(m=>m.id===study.missionId):flow.planMode?missions.at(-1):missions[0];
    const reviews=board.reviews.filter(r=>r.requestedBy.runId===run.id);
    const paper=flow.documentId?this.#papers.paper(project,flow.documentId):undefined;
    const writing=paper?.runs.findLast(r=>r.mode==='write'&&r.context.sessionId===session),written=writing&&this.#storage.record<Run>('run',writing.id);
    const author=writing?.attempts.at(-1);
    const draft=author && (this.#draftStreams.get(author.attemptId)?.draft??this.#storage.get<ManuscriptDraft>('paper.draft:'+author.attemptId));
    const drafting=draft && this.#storage.record<Attempt>('attempt',draft.attemptId);
    const current=paper?.versions.at(-1),version=current?this.#papers.version(project,paper!.id,current):undefined;
    const processes=this.#storage.records<ProcessRow>('process',session).filter(p=>p.runId===run.id);
    const artifacts=this.#storage.records<ArtifactRow>('artifact',session).filter(f=>f.runId===run.id);
    const searches=this.#bibliography.list(project,session).filter(s=>flow.searchIds.includes(s.id));
    const retained=paper?.workflow?.references?.filter(ref=>flow.citations?.some(c=>c.sourceId===ref.sourceId))??[];
    const succeeded=reviews.findLast(r=>r.verdict==='supported'&&r.executionStatus==='succeeded');
    const states=(status:string|undefined)=>status==='cancelled'||status==='paused'||status==='interrupted'?'Stopped':status==='failed'||status==='timed_out'?'Failed':
      status==='running'||status==='queued'||status==='blocked'?'Running':'Waiting for input';
    const upcoming=pending(run.status)?'Planned':states(run.status);
    const phase=(title:string,status:string,taskId?:string,description?:string)=>({title,status,taskId,description});
    const studyStatus=study?.status==='reached'?'Succeeded':study?.status==='stopped'?'Stopped':
      study?.status==='exhausted'||study?.status==='blocked'?'Waiting for input':pending(run.status)?'Running':states(run.status);
    // A worker can publish a preliminary result and run another analysis in the same
    // attempt. Project completion only from settled work and exact artifact editions.
    const experimentStage=()=>{
      const row=(status:string,taskId?:string,reason?:string)=>phase('Experiment',status,taskId,reason);
      if(study)return row(studyStatus,study.trials.at(-1)?.worker?.taskId,study.reason);
      const artifactKey=(id:string,version:string)=>JSON.stringify([id,version]);
      const pinned=new Set((flow.tables??[]).map(t=>artifactKey(t.artifactId,t.version)));
      const evidence=board.evidence.filter(e=>e.createdBy.runId===run.id && e.createdBy.parentTaskId===null);
      for(const record of [...evidence,...reviews]){
        for(const target of record.targets)if(target.kind==='artifact')pinned.add(artifactKey(target.id,target.version));
      }
      const pinnedProcesses=new Set(artifacts.filter(f=>f.version && pinned.has(artifactKey(f.id,f.version))).map(f=>f.processId));
      const tasks=this.#storage.records<TaskRow>('task',session).filter(t=>t.runId===run.id);
      const assignedWorkers=new Set(tasks.filter(t=>t.role==='experiment').map(t=>t.id));
      const excludedTasks=new Set(tasks.filter(t=>['literature','mission','verification','reviewer','writer','editor'].includes(t.role??'')).map(t=>t.id));
      for(const review of reviews)if(review.reviewer)excludedTasks.add(review.reviewer.taskId);
      const experiments=processes.filter(p=>{
        if(excludedTasks.has(p.taskId))return false;
        const external=p.job.externalMcp;
        if(!external)return true;
        const capability=run.extensions?.servers.find(s=>s.id===external.serverId)?.definition.capability;
        return capability!=='browser' && (assignedWorkers.has(p.taskId)||pinnedProcesses.has(p.id));
      });
      const processOwners=new Set(experiments.map(p=>p.taskId));
      const workers=tasks.filter(t=>t.parentTaskId && !excludedTasks.has(t.id) && (assignedWorkers.has(t.id)||processOwners.has(t.id)));
      const activeWorker=workers.find(t=>pending(t.status));
      const completed=experiments.findLast(p=>p.status==='succeeded' && pinnedProcesses.has(p.id));
      const failedWorker=workers.findLast(t=>['failed','cancelled','paused'].includes(t.status));
      if(activeWorker)return row(states(activeWorker.status),activeWorker.id);
      const active=experiments.find(p=>p.status==='running'||p.status==='queued');
      if(active)return row('Running',active.taskId);
      if(failedWorker && !flow.documentId)return row(states(failedWorker.status),failedWorker.id);
      if(completed)return row('Succeeded',completed.taskId);
      // Older research flows predate explicit evidence pins. Keep their final outcome.
      if(!flow.planMode && run.status==='succeeded' && !pinned.size){
        const legacy=experiments.findLast(p=>p.status==='succeeded' && artifacts.some(f=>f.processId===p.id));
        if(legacy)return row('Succeeded',legacy.taskId);
      }
      const last=experiments.at(-1),worker=workers.at(-1);
      if(last && last.status!=='succeeded')return row(states(last.status),last.taskId);
      if(last||worker){
        const waiting=pending(run.status);
        const explanation=last?.status==='succeeded'?'Waiting for the coordinator to record the result edition.':undefined;
        return row(waiting?'Running':states(run.status),last?.taskId??worker?.id,explanation);
      }
      return row(upcoming);
    };
    const writingActive=!!writing && !!written && pending(written.status);
    const editing=writingActive && ['requested','planning','Plan manuscript evidence','Draft sections','Edit manuscript','Revise manuscript'].includes(writing.stage);
    const reviewing=writingActive && writing.stage==='Independent review';
    const editorTask=writing?.attempts.findLast(t=>t.role==='Revise manuscript'||t.role==='Edit manuscript')?.taskId;
    const latest=written??run,checkpoint=this.#storage.record<TaskRow>('task',latest.taskId)?.attemptId;
    const isLatest=this.#currentRun(session)?.id===latest.id;
    // A stopped revision still displays its previously reviewed base until the
    // editor publishes. That assessment belongs to the base, not this attempt.
    const unfinishedRevision=!!writing?.revisionReviewId && !writing.versions.length && writing.baseVersion===current;
    const revisionRecovery=unfinishedRevision && written && !pending(written.status) && checkpoint?
      (isLatest?'resume':'restart'):undefined;
    const stages=[
      phase('Research plan',mission?'Succeeded':states(run.status),run.taskId,mission?.objective),
      phase('Sources',flow.pages?.length||flow.inputs?.length||retained.length?'Succeeded':searches.some(s=>s.records.length)?'Succeeded':searches.length?states(searches[0]?.status):upcoming,run.taskId,
        [...(flow.inputs??[]).map(p=>p.title+' · supplied input'),...[...(flow.pages??[]),...retained].map(p=>[p.url,p.retrievedAt,p.coverage,p.claim].join(' · ')),...searches.map(s=>[s.term,s.status,s.error,...s.records.map(r=>r.doi+' · '+r.level+' · '+r.retrievedAt)].filter(Boolean).join(' · '))].join('\n')),
      experimentStage(),
      phase('Verify results',succeeded?'Succeeded':reviews.length?states(reviews.at(-1)?.executionStatus):upcoming,reviews.at(-1)?.reviewer?.taskId,reviews.at(-1)?.verdict),
      phase('Manuscript',editing?'Running':revisionRecovery?states(writing?.stage==='failed'?'failed':written?.status):current?'Succeeded':written?states(written.status):paper?'Waiting for input':'Planned',editorTask,writing?.error||flow.error),
      phase('Independent review',reviewing?'Running':editing?'Planned':version?.review.status==='approved'?'Succeeded':version?.assessment?'Waiting for input':'Planned',
        reviewing?writing.attempts.at(-1)?.taskId:version?.assessment?.reviewer?.taskId,editing||reviewing?undefined:version?.assessment?.verdict),
      phase('LaTeX',version?.compilation?.state==='succeeded'?'Succeeded':version?.compilation?.state==='stopped'?'Stopped':version?.compilation?states(version.compilation.state):'Planned',written?.taskId,version?.compilation?.error)
    ];
    return {revisionRecovery,history:history.map(r=>({runId:r.id,title:r.title})),checkpoint,runId:run.id,model:run.model,documentId:paper?.id,manuscriptRunId:writing?.id,version:current,
      plan:mission && {missionId:mission.id, objective:mission.objective, stages:mission.stages, acceptanceCriteria:mission.acceptanceCriteria,
        coordinatorModel:flow.planMode ? run.model?.modelId : undefined},
      liveDraft:draft && (!current||drafting && pending(drafting.status))?{...draft,active:!!drafting && pending(drafting.status)}:undefined,
      compilationReceipt:version?.compilation?.pdf?.id,
      sectionBriefs:paper && writing && (current??null)===(writing.versions.at(-1)??writing.baseVersion)?this.#papers.sectionPlan(paper,writing):undefined,
      experimentMission:study?{...study,...missionProgress(study)}:undefined,
      tables:flow.tables??[],stages,sections:writing?.sections.length?writing.sections:flow.drafts,artifacts:artifacts.map(f=>({...artifactRef(f.file),taskId:f.taskId,inputs:f.evidence})),
      sources:version?.links.map(link=>{
        const passage={quote:link.quote,locator:link.locator};
        const pinned=version.evidence.find(ref=>ref.sourceId===link.sourceId);
        if(pinned && link.sourceOffset!==-1 && link.manuscriptOffset!==-1){
          try{
            const source=this.#papers.source(project,pinned.sourceId);
            if(source.version===pinned.version)return {...passage,source:source.origin};
          }catch(error){
            if(!(error instanceof ManagerError) || error.code!=='SOURCE_DENIED')throw error;
          }
        }
        return {...passage,unresolved:true};
      }),
      connections:run.extensions?.servers.map(s=>({name:s.definition.name,capability:s.definition.capability,checkedAt:s.verification.checkedAt,calls:processes.filter(p=>p.job.externalMcp?.serverId===s.id).map(p=>({tool:p.job.externalMcp!.tool,status:p.status})),tools:s.verification.tools.map(t=>t.name)}))??[],
      searches:searches.map(s=>({status:s.status,term:s.term})),canResume:!pending(latest.status)&&isLatest&&(!writing||(current??null)===(writing.versions.at(-1)??writing.baseVersion))&&(!paper||!writing||unfinishedRevision||(!version?.assessment&&writing.stage!=='insufficient_evidence')||writing.stage==='failed'&&version?.review.status!=='approved'),error:flow.error??latest.error};
  }
  paperCatalog(project:string) { this.#paperProject(project); return this.#papers.list(project); }
  #paperProject(project:string) {
    if(!this.#active||this.#session(this.#active).projectId!==project) throw new ManagerError('PROJECT_MISMATCH','Open the project conversation first.');
    this.#assertReady();
  }
  async paperRequest(method:string,args:Record<string,unknown>) {
    const project=text(args.projectId,'Project');this.#paperProject(project);
    if(['bibliographyHistory','authorizeSearch','executeSearch','cancelSearch','addSearchSource'].includes(method)){
      const session=text(args.sessionId,'Conversation');
      if(session!==this.#active)throw new ManagerError('SESSION_MISMATCH','Open the conversation that authorized the search.');
      if(method==='bibliographyHistory')return this.#bibliography.list(project,session);
      if(method==='authorizeSearch')return this.#bibliography.prepare(project,session,args);
      const searchId=text(args.searchId,'Search ID');
      if(method==='executeSearch')return this.#bibliography.execute(project,session,searchId);
      if(method==='cancelSearch')return this.#bibliography.cancel(project,session,searchId);
      return this.#bibliography.add(project,session,searchId,args.doi);
    }
    if(method==='listLibrarySources')return this.#library.uiSources(project,this.#active!);
    if(method==='searchAndSavePapers'){
      const session=text(args.sessionId,'Conversation');
      if(session!==this.#active||!this.#storage.project(project)?.researchWorkflow)throw new ManagerError('SEARCH_DENIED','Open a research project conversation.');
      const search=this.#bibliography.prepare(project,session,{mode:args.mode,term:args.term,pages:1,requestId:args.requestId});
      return this.#searchAndSave(project,session,search.id,this.#shutdown.signal);
    }
    if(method==='researchFlow')return this.#flowReport(project,text(args.sessionId,'Conversation'),args.runId);
    if(method==='researchTableInputs'){
      const session=text(args.sessionId,'Conversation'),run=this.#storage.record<Run>('run',text(args.runId,'Research run'));
      if(!run||session!==this.#active||run.projectId!==project||run.sessionId!==session)throw new ManagerError('EVIDENCE_DENIED','Open the owning research conversation.');
      const flow=this.#flow(run.id),table=flow?.tables?.find(t=>t.artifactId===args.artifactId&&t.version===args.version);
      const root=this.#storage.record<TaskRow>('task',run.taskId);
      const attempt=root&&this.#storage.record<Attempt>('attempt',root.attemptId);
      if(!table||!attempt)throw new ManagerError('EVIDENCE_DENIED','Select a recorded experiment table.');
      const row=this.#artifact(attempt,table.artifactId);
      if(row.version!==table.version)throw new ManagerError('EVIDENCE_DENIED','The result version changed.');
      const target=await this.#researchTarget(attempt,{kind:'artifact',id:row.id});
      const inputs=(target.inputVersions??[]).map(ref=>{
        if(!attempt.fileIds.includes(ref.id))return ref;
        const {f,bytes}=this.#upload(attempt,ref.id);
        if(f.versionId!==ref.version)throw new ManagerError('EVIDENCE_DENIED','The granted input version changed.');
        return {...ref,name:f.name,sha256:hash(bytes),...(!f.mimeType?.startsWith('image/')?{excerpt:bytes.toString('utf8').slice(0,8000)}:{})};
      });
      return {result:artifactRef(row.file),taskId:row.taskId,inputs};
    }
    if(method==='resumeResearch')return this.#resumeFlow(project,args);
    if(method==='listPapers')return this.paperCatalog(project);
    if(method==='createPaper')return this.#papers.create(project,args);
    if(method==='addPaperSource') {
      if(args.artifactId!==undefined) {
        const id=text(args.artifactId,'Artifact'),row=this.#storage.record<ArtifactRow>('artifact',id);
        if(!row||row.projectId!==project||row.sessionId!==this.#active)throw new ManagerError('ARTIFACT_DENIED','Select a result from this conversation.');
        const bytes=await this.#readArtifact(row);this.#paperProject(project);
        const target:ResearchTarget={kind:'artifact',id,projectId:project,sessionId:row.sessionId,version:row.version,
          sha256:hash(bytes),bytes:bytes.length,taskId:row.taskId,agentSessionId:row.agentSessionId,attemptId:row.attemptId,processId:row.processId};
        return this.#papers.saveSource(project,row.title,new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),'full_text',target);
      }
      return this.#papers.saveSource(project,bounded(args.title,'source title',512),bounded(args.text,'source text',240000));
    }
    const id=text(args.documentId,'Document');
    if(method==='compilePaper'){
      this.#assertIdle();
      const d=this.#papers.paper(project,id);
      if(!this.#executionEnabled(project))throw Error('Enable project execution before typesetting.');
      const compile=this.#papers.compile(project,this.#active!,id,text(args.version,'Version'),template(d.workflow?.template??args.template),AbortSignal.any([this.#shutdown.signal,AbortSignal.timeout(65000)]));
      this.#manualCompiles.add(compile);
      try{return await compile;}finally{this.#manualCompiles.delete(compile);}
    }
    if(method==='getDocument'){
      const version=this.#papers.version(project,id,args.version===undefined?undefined:text(args.version,'Version'));
      return {...version,sectionChecks:manuscriptSectionChecks(version)};
    }
    if(method==='saveDocument')return this.#papers.save(project,id,args);
    if(method==='exportPaper')return this.#papers.export(project,this.#active!,id,text(args.version,'Version'),args.format);
    if(method==='paperDetails') {
      const d=this.#papers.paper(project,id);
      return {...d,runs:d.runs.map(r=>({...r,executionStatus:this.#storage.record<Run>('run',r.id)?.status}))};
    }
    if(method==='setPaperOutline')return this.#papers.update(project,id,d=>{
      if(d.runs.some(r=>pending(this.#storage.record<Run>('run',r.id)?.status??'paused')))throw new ManagerError('RUN_BUSY','Wait for the active manuscript run.');
      d.outline=headings(args.outline);
    });
    if(method!=='startPaper')throw new ManagerError('INVALID_INPUT','Unknown manuscript operation.');
    return this.#startPaper(project,id,args);
  }
  async #startPaper(project:string,id:string,args:Record<string,unknown>,original?:Run) {
    const sessionId=text(args.sessionId,'Conversation'),{session,runtime}=this.#bound(sessionId);
    if(session.projectId!==project)throw new ManagerError('PROJECT_MISMATCH','Wrong conversation for this manuscript.');
    const mode=args.mode;
    if(mode!=='outline'&&mode!=='write')throw new ManagerError('INVALID_INPUT','Select outlining or writing.');
    const requestId=bounded(args.requestId,'request ID',128),d=this.#papers.paper(project,id);
    const expected=args.expectedBaseVersion===undefined?undefined:text(args.expectedBaseVersion,'Reviewed revision');
    const old=d.runs.find(r=>r.requestId===requestId);
    if(old) {
      if(old.mode!==mode||old.context.sessionId!==sessionId||(expected!==undefined&&old.baseVersion!==expected))throw new ManagerError('REQUEST_ID_CONFLICT','Start request changed.');
      return {runId:old.id};
    }
    if(expected!==undefined){
      if(mode!=='write'||d.versions.at(-1)!==expected||this.#papers.version(project,id,expected).assessment?.verdict!=='changes_required')
        throw new ManagerError('VERSION_CONFLICT','Open the latest revision with requested changes.');
      if(d.workflow){
        const origin=this.#storage.record<Run>('run',d.workflow.runId);
        if(d.workflow.sessionId!==sessionId||origin?.sessionId!==sessionId||origin.projectId!==project)
          throw new ManagerError('SESSION_MISMATCH','Revise this manuscript in its original research conversation.');
        original=origin;
      }
    }
    if(this.#paperStarting.has(sessionId))throw new ManagerError('RUN_BUSY','Manuscript start is in progress.');
    this.#assertIdle();
    if(!this.#executionEnabled(project))throw new ManagerError('EXECUTION_DISABLED','Enable offline analysis for this project before starting a manuscript.');
    if(mode==='write'&&(!d.outline.length||this.#maxChildren<3||!this.#depth))throw new ManagerError('PAPER_LIMIT','Writing needs an outline and capacity for three direct children.');
    if(d.runs.length>=32)throw new ManagerError('PAPER_LIMIT','Manuscript run limit reached.');
    this.#paperStarting.add(sessionId);
    try {
      const sources=d.evidence.map(ref=>this.#papers.source(project,ref.sourceId));
      for(const source of sources) {
        if(source.origin&&'kind' in source.origin&&source.origin.kind==='file'){
          const saved=this.#storage.record<StoredFile>('file',source.origin.id);
          if(!saved||saved.projectId!==project||saved.sessionId!==sessionId||saved.versionId!==source.origin.version||hash(this.#readUpload(saved))!==source.sha256)throw Error('The source input no longer matches its original grant.');
        }else if(source.origin&&'kind' in source.origin) {
          const row=this.#storage.record<ArtifactRow>('artifact',source.origin.id);
          if(!row||row.projectId!==project||row.version!==source.origin.version||original&&row.sessionId!==sessionId||hash(await this.#readArtifact(row))!==source.sha256)
            throw new ManagerError('ARTIFACT_DENIED','The selected result changed.');
        }
      }
      const files=sources.map((s,i)=>({name:'source-'+(i+1)+'.txt',mimeType:'text/plain',data:Buffer.from(s.content).toString('base64')}));
      const base=d.versions.at(-1);
      const previous=mode==='write'&&base?this.#papers.version(project,id,base):undefined;
      const review=previous?.assessment;
      if(previous && review?.verdict==='changes_required'){
        if(!review.reviewer || this.#storage.record<Attempt>('attempt',review.reviewer.attemptId)?.status!=='succeeded')
          throw new ManagerError('PAPER_NO_REVIEW','The prior edition needs a completed independent review.');
        files.push(...manuscriptContextFiles('prior-manuscript.md',previous.text),
          ...manuscriptContextFiles('prior-review.json',JSON.stringify({version:previous.version,sha256:previous.sha256,
            reviewId:review.id,verdict:review.verdict,checks:review.checks,findings:review.findings,linkIssues:previous.issues})));
      }
      const userBrief=d.workflow?.sessionId===sessionId?this.#flow(d.workflow.runId)?.input??d.goal:d.goal;
      if(mode==='write'&&JSON.stringify(userBrief).length>2048)files.push(...manuscriptContextFiles('user-research-brief.txt',userBrief));
      const {fileReferences}=await this.stageFiles(sessionId,files);
      const flow=original&&this.#flow(original.id);
      const contextDraft=flow?.drafts.length?'\nSaved preliminary sections: '+JSON.stringify(flow.drafts.map(s=>s.heading)):'';
      const sourceDirectory=paperSourceDirectory(sources,fileReferences.map(f=>f.id),d,flow);
      const message='Manuscript '+mode+' request. Objective: '+d.goal+'\n'+(mode==='outline'?'Inspect the selected sources and call compose_manuscript with an outline of 1–8 headings.':'Call compose_manuscript with {} to execute the approved outline: '+JSON.stringify(d.outline))+
        '\nReport the returned manuscript status. Read granted source files for exact passages and URLs. Sources: '+sourceDirectory+contextDraft;
      const response=await this.#prompt(session,runtime,{type:'prompt',id:'paper:'+id+':'+requestId,message,fileReferences},a=>{
        const current=this.#papers.paper(project,id);
        if(JSON.stringify([current.evidence,current.outline,current.versions])!==JSON.stringify([d.evidence,d.outline,d.versions]))throw new ManagerError('VERSION_CONFLICT','Manuscript changed during start.');
        current.runs.push({id:a.runId,requestId,mode,baseVersion:d.versions.at(-1)??null,context:context(a),stage:'requested',outline:[...d.outline],sections:[],
          attempts:[],versions:[],reviews:[],...(review?.verdict==='changes_required'?{revisionReviewId:review.id}:{}),
          contextFileIds:fileReferences.slice(sources.length).map(f=>f.id),uploads:fileReferences.slice(0,sources.length).map((f,i)=>({fileId:f.id,sourceId:sources[i]!.sourceId}))});
        this.#papers.put(current);this.#storage.set('paper.run:'+a.runId,id);
      },original);
      return response.data;
    } finally {this.#paperStarting.delete(sessionId);}
  }
  async #composePaper(a:Attempt,id:string,args:Readonly<Record<string,unknown>>,signal:AbortSignal) {
    const current=()=>this.#papers.paper(a.projectId,id);
    const run=()=>current().runs.find(r=>r.id===a.runId)!;
    const update=(change:(r:PaperRun,d:Paper)=>void)=>this.#papers.update(a.projectId,id,d=>change(d.runs.find(r=>r.id===a.runId)!,d));
    this.#requireCoordinatorWrites(a);this.#requireEnabled(a);
    if(a.id!==run().context.attemptId||run().stage!=='requested')throw new ManagerError('PAPER_ALREADY_STARTED','This manuscript run has already been dispatched.');
    if(run().mode==='outline') {
      const outline=headings(args.outline);update((r,d)=>{r.outline=outline;d.outline=outline;r.stage='outlined';});
      return {outline};
    }
    const doc=current(),sources=doc.evidence.map(ref=>this.#papers.source(a.projectId,ref.sourceId));
    const upstream=doc.workflow&&this.#flow(doc.workflow.runId);
    const paperRun=run(),sourceFileIds=paperRun.uploads.map(u=>u.fileId);
    const contextFileIds=paperRun.contextFileIds??[];
    const userBrief=doc.workflow?.sessionId===a.sessionId?upstream?.input??doc.goal:doc.goal;
    const userContext='User-provided research brief (scope and requirements only; substantive claims require independent evidence): '+
      (JSON.stringify(userBrief).length>2048 && contextFileIds.length?'read the granted user-research-brief.txt file(s).':JSON.stringify(userBrief).slice(0,2048));
    const revisionContext=paperRun.revisionReviewId?
      'Use read_file with each granted prior-manuscript.md and prior-review.json fileId (all parts). Previous edition '+paperRun.baseVersion+
      ', independent review '+paperRun.revisionReviewId+'. Check each recorded finding and preserve supported material. These inputs describe the revision history and are not sources for empirical claims.':'';
    const study=upstream && this.#experimentMission(upstream.runId);
    const measurements=study?.trials.flatMap(t=>{
      if (!t.outcome || !('value' in t.outcome)) return [];
      const {artifact,value}=t.outcome;
      const source=sources.find(s=>s.origin && 'kind' in s.origin && s.origin.id===artifact.id && s.origin.version===artifact.version);
      return source?[{trial:t.number,sourceId:source.sourceId,value}]:[];
    });
    const trialContext=study && measurements?.length?'\nMeasured trial evidence: '+JSON.stringify({
      protocol:study.contract.protocol,metricPath:study.contract.metricPath,target:study.contract.target,direction:study.contract.direction,
      status:study.status,measurements
    }):'';
    const description=paperSourceDirectory(sources,sourceFileIds,doc,upstream);
    // Reserve a fresh reviewer for a possible revision before reserving a literature session.
    const separatePlanner=this.#maxChildren>=5;
    const child=async(role:string,prompt:string,previous?:string,correcting=false)=>{
      signal.throwIfAborted();
      const prior=run().attempts.findLast(t=>t.role===role);
      if(prior){
        const finished=this.#storage.record<Attempt>('attempt',prior.attemptId);
        if(finished?.status==='succeeded'&&!correcting)return this.#summary(this.#child(a,prior.taskId));
        previous=prior.taskId;
      }
      const requestId='paper:'+a.runId+':'+role+':'+a.id+(correcting?':correct':'');
      update(r=>{r.stage=role;});
      const fileIds=role==='Edit manuscript'||role==='Revise manuscript'?a.fileIds:sourceFileIds;
      const task=await this.#dispatch(a,previous?'send_to_agent':'spawn_agent',requestId,previous?{taskId:previous,message:prompt,requestId,fileIds}:{title:role,prompt,requestId,fileIds},signal,next=>{
        // Called inside the existing child admission transaction.
        const d=current();d.runs.find(r=>r.id===a.runId)!.attempts.push({role,taskId:next.taskId,attemptId:next.id});this.#papers.put(d);
      },!!prior||!!previous&&a.requestId.startsWith('resume:'),role==='Plan manuscript evidence'&&separatePlanner?'literature':role==='Draft sections'||role==='Plan manuscript evidence'?'writer':'editor');
      const joined=await this.#wait(a,[task.taskId],signal);signal.throwIfAborted();
      const row=joined.tasks[0];if(!row||row.status!=='succeeded')throw new ManagerError('PAPER_CHILD_FAILED',role+' did not succeed.');
      return row;
    };
    const structuredChild=async<T>(role:string,prompt:string,validate:(reply:unknown)=>T,previous?:string)=>{
      let row=await child(role,prompt,previous);
      try { return {taskId:row.taskId,value:validate(parseManuscriptJson(row.result))}; }
      catch(error){
        signal.throwIfAborted();
        const detail=error instanceof Error?error.message:'Invalid manuscript stage response.';
        row=await child(role,prompt+'\nCorrect your previous response. Validation: '+detail,row.taskId,true);
        return {taskId:row.taskId,value:validate(parseManuscriptJson(row.result))};
      }
    };
    update(r=>{r.stage='planning';});
    try {
      const mission=this.#research.snapshot(a).missions.find(m=>m.runId===a.runId)??this.#research.plan(a,{objective:doc.goal,acceptanceCriteria:['Check claims, citations and figure data against exact sources.'],stages:doc.outline});
      let briefs=this.#papers.sectionPlan(doc,paperRun);
      if(briefs && !paperRun.sectionBriefs)update(r=>{r.sectionBriefs=briefs;});
      const scholarly=sources.some(s=>s.origin && 'provider' in s.origin);
      let planner=run().attempts.find(t=>t.role==='Plan manuscript evidence')?.taskId;
      if(!revisionContext && !briefs && (scholarly || args.sectionBriefs!==undefined)){
        const validate=(reply:unknown)=>sectionBriefs(reply,doc.outline,sources);
        if(args.sectionBriefs!==undefined)briefs=validate(args.sectionBriefs);
        else {
          const planned=await structuredChild('Plan manuscript evidence','Plan the literature synthesis and visuals for this paper. Read relevant granted sources. Distinguish metadata from full text. Use sequential source numbers starting at 1. For each heading identify the comparison, finding or limitation and any useful plot, table or method diagram. Return a JSON array of {heading,purpose,sources:[numbers],visual:"description or empty string"}.\nSources: '+description+'\nOutline: '+JSON.stringify(doc.outline),validate);
          planner=planned.taskId;briefs=planned.value;
        }
        update(r=>{r.sectionBriefs=briefs;});
      }
      const briefContext=briefs?'\nSection evidence and visual plan: '+JSON.stringify(briefs):'';
      const revisionRoom=this.#maxChildren>=4;
      let sections=run().sections;
      if(!revisionContext && !sections.length){
        const writer=await structuredChild('Draft sections','Read the granted source material. Objective: '+doc.goal+'\nSources: '+description+
        trialContext+briefContext+(upstream?.drafts.length?'\nPreliminary sections to refine: '+JSON.stringify(upstream.drafts):'')+
        '\nReturn only a JSON array of {heading,text} in this exact order: '+JSON.stringify(doc.outline),reply=>sectionDrafts(reply,doc.outline),separatePlanner?undefined:planner);
        sections=writer.value;
        update(r=>{r.sections=sections;});
      }
      let editor:string|undefined,findings:string[]=[];
      for(let cycle=0;cycle<=1;cycle++) {
        const saved=run().versions[cycle];
        const priorVersion=saved?this.#papers.version(a.projectId,id,saved):undefined;
        const priorReview=priorVersion?.assessment;
        if(priorReview?.verdict){
          update(r=>{r.stage=priorReview.verdict!;});editor=priorVersion?.artifact?.taskId;findings=[...(priorReview.findings??[]),...(priorVersion?.issues??[])];
          if(priorReview.verdict==='changes_required'&&cycle===0&&revisionRoom)continue;
          break;
        }
        const result=priorVersion?.artifact?.taskId?await this.#summary(this.#child(a,priorVersion.artifact.taskId)):await child(cycle?'Revise manuscript':'Edit manuscript',
          (revisionContext?(cycle?'Amend your newly published revision in light of the latest independent review. ':'Revise the prior edition directly. ')+revisionContext:'Read granted sources and edit these sections into Markdown: '+JSON.stringify(sections))+
          '\n'+userContext+'\nSources: '+description+trialContext+briefContext+
          (doc.workflow?.tables?.length?'\nFor numeric results you can put ![Caption](athena-plot:sourceId/xKey/yKey) or ![Caption](athena-table:sourceId/xKey/yKey) on a separate line. Use the exact sourceId and numeric field names from these verified arrays: '+JSON.stringify(doc.workflow.tables):'')+
          '\nFor a method diagram, use ![caption](athena-diagram:sourceId/label1/label2) on a separate line. Copy 2–6 short ordered labels from one linked full-text source and URL-encode each label.'+
          '\nUse publish_manuscript exactly once. Supply claim/citation/figure links with exact manuscript and source quotes. Include data units for figures. Unavailable evidence must be disclosed.'+
          (cycle?'\nIndependent review findings: '+JSON.stringify(findings).slice(0,4000):''),editor);
        editor=result.taskId;
        const r=run();if(r.versions.length!==cycle+1)throw new ManagerError('PAPER_NO_ARTIFACT','Editor did not publish a manuscript.');
        const version=this.#papers.version(a.projectId,id,r.versions[cycle]);
        if(!version.artifact||current().versions.at(-1)!==version.version)throw new ManagerError('VERSION_CONFLICT','The manuscript changed before review.');
        const artifactIds=result.artifacts.filter(f=>f.id===version.artifact!.id||f.name==='links.json'&&this.#storage.record<ArtifactRow>('artifact',f.id)?.processId===version.artifact!.processId).map(f=>f.id);
        if(artifactIds.length!==2)throw new ManagerError('PAPER_NO_ARTIFACT','Missing verified evidence map.');
        const resolver=(ctx:Context,t:{kind:'file'|'artifact';id:string})=>{signal.throwIfAborted();return this.#researchTarget(ctx,t);};
        const durableReview=this.#research.snapshot(a).reviews.find(r=>r.requestedBy.runId===a.runId&&r.verdict&&r.executionStatus==='succeeded'&&r.targets.some(t=>t.id===version.artifact!.id&&t.sha256===version.sha256));
        if(durableReview){
          update(r=>{r.reviews.push(durableReview);r.stage=durableReview.verdict!;});
          if(durableReview.verdict==='changes_required'&&cycle===0&&revisionRoom){findings=[...(durableReview.findings??[]),...version.issues];continue;}
          break;
        }
        const evidence=await this.#research.addEvidence(a,{missionId:mission.id,title:'Manuscript '+(cycle+1),artifactIds,fileIds:sourceFileIds},resolver);
        const review=await this.#research.prepareReview(a,{missionId:mission.id,evidenceIds:[evidence.id],question:
          'Use read_file with each exact artifactId and fileId to read manuscript.md, links.json and all granted sources. Check exact quotes, cited scope, and data variables, units, transformations and captions. Include a separate substantive check beginning Claims:, Citations:, and Figures:. Report unsupported statements, missing citations or unit errors. Do not claim reproduction.\n'+userContext+'\n'+revisionContext},resolver,contextFileIds);
        update(r=>{r.stage='Independent review';});
        const name='Review manuscript '+(cycle+1);
        const prior=run().attempts.findLast(t=>t.role===name);
        const assignment=prior?{taskId:prior.taskId,message:this.#reviewPrompt(review)}:{title:name,prompt:this.#reviewPrompt(review)};
        const task=await this.#dispatch(a,prior?'send_to_agent':'spawn_agent',review.id,{...assignment,artifactIds,fileIds:a.fileIds,requestId:review.id},signal,next=>{
          this.#research.registerReviewer(a,review.id,next);
          const d=current();d.runs.find(r=>r.id===a.runId)!.attempts.push({role:name,taskId:next.taskId,attemptId:next.id});this.#papers.put(d);
        },!!prior,'reviewer');
        const joined=await this.#wait(a,[task.taskId],signal);signal.throwIfAborted();
        const checked=this.#research.snapshot({projectId:a.projectId,sessionId:a.sessionId}).reviews.find(row=>row.id===review.id);
        if(joined.tasks[0]?.status!=='succeeded'||checked?.state!=='completed'||!checked.verdict)throw new ManagerError('PAPER_NO_REVIEW','Reviewer did not submit a structured verdict.');
        update((r,d)=>{if(d.versions.at(-1)!==version.version)throw new ManagerError('VERSION_CONFLICT','Manuscript changed during review.');r.reviews.push(checked);r.stage=checked.verdict!;});
        if(checked.verdict!=='changes_required'||cycle===1||!revisionRoom)break;
        findings=[...(checked.findings??[]),...version.issues];
      }
      if(doc.workflow&&run().stage==='supported'){
        const version=run().versions.at(-1)!;
        update(r=>{r.stage='Typesetting';});
        await this.#papers.compile(a.projectId,a.sessionId,id,version,doc.workflow.template,signal);
        update(r=>{r.stage='Typeset';});
      }
      return {documentId:id,versions:run().versions,verdict:run().stage};
    } catch(error) {
      update(r=>{r.stage=signal.aborted?'cancelled':'failed';r.error=error instanceof Error?error.message.slice(0,512):'Manuscript workflow failed.';});throw error;
    }
  }
  async #publishPaper(a:Attempt,id:string,raw:string,args:Readonly<Record<string,unknown>>,signal:AbortSignal) {
    const d=this.#papers.paper(a.projectId,id),r=d.runs.find(r=>r.id===a.runId)!;
    const expectedRole=r.versions.length?'Revise manuscript':'Edit manuscript';
    if(r.versions.length>=2||r.stage!==expectedRole||!r.attempts.some(t=>t.role===expectedRole&&t.attemptId===a.id))
      throw new ManagerError('EDITOR_DENIED','Only the assigned editor may publish this revision once.');
    if(r.revisionReviewId && !r.versions.length){
      const reads=this.#storage.records<Tool>('tool',a.sessionId).filter(t=>t.attemptId===a.id&&t.name==='read_file'&&t.status==='succeeded');
      if(r.contextFileIds?.some(id=>!reads.some(t=>object(t.args)&&t.args.fileId===id)))
        throw new ManagerError('REVISION_UNREAD','Read the assigned revision context with read_file before publishing this revision.');
    }
    const expected=r.versions.at(-1)??r.baseVersion;
    if((d.versions.at(-1)??null)!==expected)throw new ManagerError('VERSION_CONFLICT','Manuscript changed since assignment.');
    const body=bounded(args.text,'manuscript',120000),sources=r.uploads.map(u=>this.#papers.source(a.projectId,u.sourceId));
    const {links,issues}=inspectLinks(args.links,body,sources);
    const map=JSON.stringify({sources:r.uploads.map((u,i)=>({...u,title:sources[i]!.title,version:sources[i]!.version,level:sources[i]!.level})),links,issues});
    await this.#files.write(a,'draft.txt',body);await this.#files.write(a,'map.txt',map);
    const script="import * as std from 'qjs:std';\nfor (const [input,output] of [['draft.txt','manuscript.md'],['map.txt','links.json']]) {const file=std.open('/outputs/'+output,'w');file.puts(std.loadFile('/workspace/'+input));file.close();}";
    await this.#files.write(a,'publish.mjs',script);
    const result=await this.#analysis(a,raw,{language:'node',script:'publish.mjs',inputs:['draft.txt','map.txt'],outputs:['manuscript.md','links.json']},signal);
    const f=result.artifacts.find(x=>x.name==='manuscript.md');if(!f)throw new ManagerError('PAPER_NO_ARTIFACT','Manuscript publication failed.');
    const artifact=await this.#researchTarget(a,{kind:'artifact',id:f.id});signal.throwIfAborted();
    const version=this.#papers.save(a.projectId,id,{title:d.title,text:body,evidence:d.evidence,expectedCurrentVersion:expected},{artifact,links,runId:a.runId});
    return {version:version.version,artifact:f,issues};
  }

  getResearch(projectId:string,sessionId?:string) {
    this.#extensionProject(projectId);
    return this.#research.snapshot({projectId,sessionId});
  }
  decideKnowledge(projectId:string,id:string,decision:Readonly<Record<string,unknown>>) {
    this.#extensionProject(projectId);
    this.#commit(()=>{this.#research.decideKnowledge(projectId,id,decision);});
    return this.#research.snapshot({projectId});
  }

  setProjectProfile(projectId: string, id: string | null) {
    this.#assertReady();
    const project = this.#storage.project(projectId);
    if (!project) throw new ManagerError('PROJECT_NOT_FOUND', 'Project does not exist.');
    if (id !== null) this.#models?.requireProfile(id);
    this.#commit(() => this.#storage.putProject({ ...project, defaultProfileId: id }));
    return this.getSnapshot();
  }

  setConversationProfile(sessionId: string, id: string | null) {
    this.#assertReady();
    const session = this.#session(sessionId);
    if (id !== null) this.#models?.requireProfile(id);
    this.#commit(() => this.#storage.putSession({ ...session, profileId: id }));
    return this.getSnapshot();
  }
  async setProjectExecution(projectId: string, enabled: boolean) {
    this.#assertReady();
    if (this.hasPendingRuns()) throw new ManagerError('RUN_BUSY', 'Wait for research to finish before changing analysis permission.');
    const project = this.#storage.project(projectId);
    const active = this.#active ? this.#session(this.#active).projectId : this.#storage.get<string>('activeProject');
    if (!project || projectId !== active) throw new ManagerError('PROJECT_NOT_FOUND', 'Select the project before changing its analysis permission.');
    if (enabled && !this.#access.available) throw new ManagerError('EXECUTION_UNAVAILABLE', this.#access.reason);
    this.#commit(() => this.#storage.putProject({ ...project, offlineAnalysis: enabled }));
    return { saved: true as const, snapshot: this.getSnapshot() };
  }
  #runs(sessionId: string): Run[] { return this.#storage.records<Run>('run', sessionId); }
  #currentRun(sessionId: string): Run | undefined { return this.#runs(sessionId).at(-1); }

  getSnapshot() {
    this.#assertReady();
    const session = this.#active ? this.#session(this.#active) : undefined;
    const run = session ? this.#currentRun(session.id) : undefined;
    const projectId = session?.projectId ?? this.#storage.get<string | null>('activeProject') ?? null;
    return structuredClone({
      revision: this.#storage.revision(), projectId, sessionId: session?.id ?? null,
      execution: {projectId, enabled:projectId!==null && this.#executionEnabled(projectId), backend:'wasi' as const,
        shell:false as const, network:false as const, runtime:this.#access,
        limits:{...ANALYSIS_FILE_LIMITS,...ANALYSIS_LIMITS,queue:MCP_LIMITS.queue,timeoutMs:this.#timeoutMs,concurrency:this.#concurrency,modelConcurrency:this.#modelConcurrency,maxDepth:this.#depth,maxChildren:this.#maxChildren}},
      projects: this.#storage.projects(),
      sessions: this.#storage.sessions().map(({ sessionFile: _file, sessionDir: _dir, ...metadata }) => metadata),
      run: { id: run?.id ?? null, status: run?.status ?? 'ready', startedAt: run?.startedAt ?? null,
        elapsedMs: run?.startedAt ? (run.endedAt ?? Date.now()) - run.startedAt : 0, model: run?.model ?? session?.model ?? null },
      tasks: session ? this.#storage.records<TaskRow>('task', session.id).map(task => {
        let retryUnavailableReason: string | undefined;
        try { this.#retryTarget(task.id); if (this.#busy) retryUnavailableReason = 'Another session operation is being prepared.'; }
        catch (error) { retryUnavailableReason = error instanceof Error ? error.message : 'This task cannot be retried.'; }
        return { ...task, retryable: retryUnavailableReason === undefined, ...(retryUnavailableReason ? { retryUnavailableReason } : {}) };
      }) : [],
      attempts: session ? this.#storage.records<Attempt>('attempt', session.id) : [],
      processes: session ? this.#storage.records<ProcessRow>('process', session.id) : [],
      agents: session ? this.#storage.records<Agent>('agent', session.id) : [], tools: session ? this.#storage.records<Tool>('tool', session.id) : [],
      artifacts: session ? this.#storage.records<ArtifactRow>('artifact', session.id).map(row=>({...row,location:{uri:artifactRef(row.file).uri,label:row.title}})) : [], events: session ? this.#storage.records<WorkspaceEvent>('event', session.id) : [], approvals: [],
    });
  }

  subscribe(listener: (snapshot: WorkspaceSnapshot) => void): () => void {
    this.#assertReady();
    this.#listeners.add(listener);
    listener(this.getSnapshot());
    return () => { this.#listeners.delete(listener); };
  }
  subscribeAllPi(listener: (sessionId: string, event: PiEvent) => void): () => void {
    this.#piListeners.add(listener);
    return () => { this.#piListeners.delete(listener); };
  }
  subscribePi(sessionId: string, listener: (event: PiEvent) => void): () => void {
    this.#session(sessionId);
    return this.subscribeAllPi((id, event) => { if (id === sessionId) listener(event); });
  }
  #publish(): void {
    for (const check of this.#waiters) check();
    if (!this.#ready || this.#closed) return;
    for (const listener of this.#listeners) listener(this.getSnapshot());
  }
  #commit(action: () => void): void {
    this.#storage.transaction(() => { action(); this.#storage.advanceRevision(); });
    this.#publish();
  }

  async createProject(input: { name: string; defaultModel?: ModelReference | null;folder?:string;requestId?:string;researchWorkflow?:boolean }) {
    this.#assertIdle();
    const key=input.requestId?'create-project:'+bounded(input.requestId,'request ID',128):undefined;
    const previous=key&&this.#storage.get<{fingerprint:string;id:string}>(key);
    const fingerprint=hash(canonical(input));
    if(previous){
      if(previous.fingerprint!==fingerprint)throw new ManagerError('REQUEST_ID_CONFLICT','Project request changed. Reopen New project.');
      return {project:this.#storage.project(previous.id)!,snapshot:this.getSnapshot()};
    }
    const folder=input.folder?projectFolder(input.folder,this.#directory):undefined;
    const project: Project = { id: randomUUID(), name: text(input.name, 'Project name'), defaultModel: input.defaultModel ?? null, ...(folder?{folder}:{}), ...(input.researchWorkflow?{researchWorkflow:true,offlineAnalysis:true}:{}) };
    createPrivateDirectory(this.#projectDir(project.id));
    this.#active = null;
    this.#commit(() => {
      this.#storage.putProject(project);
      if(key)this.#storage.set(key,{id:project.id,fingerprint});
      this.#storage.set('activeProject', project.id);
      this.#storage.set('activeSession', null);
    });
    return { project, snapshot: this.getSnapshot() };
  }

  async createSession(input: { projectId: string | null; title: string; model?: ModelReference | null; configurationId?: string;firstForProject?:boolean }): Promise<SessionActivation> {
    this.#assertIdle();
    const projectId = text(input.projectId ?? this.#storage.get<string | null>('activeProject'), 'Project ID');
    const project = this.#storage.project(projectId);
    if (!project) throw new ManagerError('PROJECT_NOT_FOUND', 'Project does not exist.');
    const existing=input.firstForProject&&this.#storage.sessions().find(s=>s.projectId===projectId);
    if(existing)return this.openSession(existing.id);
    const title = text(input.title, 'Session title');
    const sessionDir = join(this.#directory, 'sessions', randomUUID());
    this.#busy = true;
    let runtime: ManagedPiSession | undefined;
    try {
      runtime = await this.#make(projectId,sessionDir,'parent');
      const id = runtime.sessionId;
      const model = input.model ?? project.defaultModel ?? this.#model(runtime);
      this.#validateModel(runtime, model);
      const session: StoredSession = { id, projectId, title, model, sessionFile: runtime.sessionFile, sessionDir };
      this.#storage.transaction(() => {
        this.#storage.putSession(session);
        this.#storage.putRecord('agent_session',{...session,sessionId:id,role:'parent'});
        this.#storage.set('activeSession', id);
        this.#storage.set('activeProject', projectId);
        this.#storage.advanceRevision();
      });
      this.#active = id;
      runtime = undefined;
    } finally {
      if (runtime) { this.#registry.delete(runtime.sessionId); runtime.close(); }
      this.#busy = false;
    }
    this.#publish();
    const snapshot = this.getSnapshot();
    return { sessionId: text(snapshot.sessionId, 'Created session ID'), projectId, title, snapshot };
  }

  async openSession(sessionId: string): Promise<SessionActivation> {
    this.#assertReady();
    if (this.#busy) throw new ManagerError('SESSION_BUSY','Another selection is in progress.');
    const session = this.#session(sessionId);
    if (this.#active !== sessionId) {
      this.#busy = true;
      try {
        await this.#openRoot(session);
        this.#active = session.id;
        this.#commit(()=>{this.#storage.set('activeSession',sessionId);this.#storage.set('activeProject',session.projectId);});
      } finally { this.#busy = false; }
    }
    return {sessionId, projectId:session.projectId,title:session.title,snapshot:this.getSnapshot()};
  }
  #model(runtime: ManagedPiSession): ModelReference | null {
    const state = runtime.getState();
    if (!object(state) || !object(state.model)) return null;
    const provider = state.model.provider;
    const id = state.model.id ?? state.model.modelId;
    return typeof provider === 'string' && typeof id === 'string' ? { provider, modelId: id,
      ...(typeof state.model.baseUrl === 'string' ? { endpoint: state.model.baseUrl } : {}),
      ...(typeof state.thinkingLevel === 'string' ? { thinkingLevel: state.thinkingLevel } : {}) } : null;
  }
  #validateModel(runtime: ManagedPiSession, requested: ModelReference | null): void {
    const actual = this.#model(runtime);
    const state = runtime.getState();
    const level = object(state) ? state.thinkingLevel ?? 'off' : 'off';
    if (requested && (!actual || requested.provider !== actual.provider || requested.modelId !== actual.modelId ||
        (requested.thinkingLevel != null && requested.thinkingLevel !== level))) {
      throw new ManagerError('MODEL_UNAVAILABLE', 'This host cannot use the requested model or thinking level.');
    }
  }
  async setProjectDefaultModel(projectId: string, model: ModelReference | null) {
    this.#assertReady();
    const project = this.#storage.project(projectId);
    if (!project) throw new ManagerError('PROJECT_NOT_FOUND', 'Project does not exist.');
    if (model) {
      const runtime = this.#active ? this.#registry.get(this.#active) : undefined;
      if (!runtime) throw new ManagerError('MODEL_UNAVAILABLE', 'Open a session before selecting its supported model.');
      this.#validateModel(runtime, model);
    }
    this.#commit(() => this.#storage.putProject({ ...project, defaultModel: model }));
    return { saved: true as const, snapshot: this.getSnapshot() };
  }

  stageFiles(sessionId: string, files: readonly StagedFileInput[]): Promise<{ fileReferences: FileReference[] }> {
    const { session } = this.#bound(sessionId);
    if (!Array.isArray(files) || !files.length) throw new ManagerError('INVALID_FILES', 'Supply at least one file.');
    const prepared = files.map(file => {
      if (!object(file) || typeof file.name !== 'string' || !file.name.trim() || typeof file.mimeType !== 'string' ||
          !(file.mimeType.startsWith('text/') || ['application/json', 'application/xml'].includes(file.mimeType)) ||
          typeof file.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) {
        throw new ManagerError('UNSUPPORTED_FILE', 'Only base64 encoded UTF-8 text files can be staged.');
      }
      const bytes = Buffer.from(file.data, 'base64');
      if (bytes.length > uploadBytes) throw new ManagerError('FILE_TOO_LARGE', 'Files must not exceed 256 KiB.');
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const id = randomUUID();
      const record: StoredFile = { id, projectId: session.projectId, sessionId, name: file.name,
        mimeType: file.mimeType, size: bytes.length, versionId: hash(bytes), digest: hash(bytes),
        path: join(this.#projectDir(session.projectId), 'uploads', `${id}.txt`) };
      return { bytes, record };
    });
    const written: string[] = [];
    try {
      const directory = this.#uploadDirectory(session.projectId);
      for (const { bytes, record } of prepared) {
        const path = join(directory, `${record.id}.txt`);
        writeNewPrivateFileSync(path, bytes, { mode: 0o600 });
        written.push(path);
      }
      this.#storage.transaction(() => {
        for (const { record } of prepared) this.#storage.putRecord('file', record);
      });
    } catch (error) {
      for (const path of written) rmSync(path);
      throw error;
    }
    return Promise.resolve({ fileReferences: prepared.map(({ record: { path: _path, digest: _digest, sessionId: _sessionId, ...ref } }) => ref) });
  }

  #message(command: PiCommand, session: StoredSession): string {
    if (typeof command.message !== 'string' || (!command.message.trim() && !(Array.isArray(command.fileReferences) && command.fileReferences.length))) throw new ManagerError('INVALID_INPUT', 'Enter a message or attach a file.');
    if (command.images !== undefined) throw new ManagerError('UNSUPPORTED_INPUT', 'This host accepts text messages and staged text files.');
    let message = command.message;
    if (command.fileReferences !== undefined) {
      if (!Array.isArray(command.fileReferences)) throw new ManagerError('INVALID_FILES', 'File references must be an array.');
      for (const ref of command.fileReferences) {
        if (!object(ref) || typeof ref.id !== 'string') throw new ManagerError('INVALID_FILES', 'Invalid file reference.');
        const stored = this.#storage.record<StoredFile>('file', ref.id);
        if (!stored || stored.sessionId !== session.id || stored.projectId !== session.projectId ||
            ref.projectId !== stored.projectId || ref.versionId !== stored.versionId ||
            ref.name !== stored.name || ref.size !== stored.size || ref.mimeType !== stored.mimeType) {
          throw new ManagerError('FILE_SCOPE_MISMATCH', 'The staged file does not belong to this session or version.');
        }
        this.#readUpload(stored);
        message += this.#attachmentInstruction(stored);
      }
    }
    if (message.length > this.inputContract.maxMessageCharacters) throw new ManagerError('INPUT_TOO_LARGE', 'The complete message exceeds 262144 UTF-16 code units.');
    return message;
  }

  #attachmentInstruction(file: StoredFile): string {
    // This is the granted tool namespace, independent of host path separators.
    return `\n\nInput attachment (never a result): ${JSON.stringify({fileId:file.id,name:file.name})}. ` +
      `Children receive this input by fileId. Only report output locations returned in verified artifact references.\nFor direct input inspection only: ` +
      `Call read with these exact arguments: ${JSON.stringify({ path: `uploads/${file.id}.txt` })}`;
  }

  #attachmentMessage(attempt: Attempt, runtime: ManagedPiSession): AttachmentMessage | undefined {
    if (attempt.parentTaskId !== null || attempt.kind === 'reconciliation') return;
    const manuscriptHandoff = Boolean(this.#storage.get<string>('paper.run:' + attempt.runId));
    if (!attempt.fileIds.length && !manuscriptHandoff) return;
    let suffix = '';
    const attachments = [];
    for (const fileId of attempt.fileIds) {
      const file = this.#storage.record<StoredFile>('file', fileId);
      if (!file || file.sessionId !== attempt.sessionId || file.projectId !== attempt.projectId) return;
      suffix += this.#attachmentInstruction(file);
      // Display metadata comes from the owning attempt's persisted inputs,
      // never from model text. Do not expose transport IDs or filesystem paths.
      attachments.push({name: runtime.publicText?.(file.name) ?? file.name, mimeType: runtime.publicText?.(file.mimeType) ?? file.mimeType, size: file.size});
    }
    // Older attempts stored the full dispatch and file IDs. The immutable upload
    // metadata identifies their exact appended suffix without scanning user text.
    if (!attempt.prompt.endsWith(suffix)) return;
    const user = suffix ? attempt.prompt.slice(0, -suffix.length) : attempt.prompt;
    return {dispatch: runtime.publicText?.(attempt.prompt) ?? attempt.prompt, user: runtime.publicText?.(user) ?? user, attachments, manuscriptHandoff};
  }

  async pi(sessionId: string, command: PiCommand): Promise<unknown> {
    const { session, runtime } = this.#bound(sessionId);
    if (!object(command) || typeof command.type !== 'string') throw new ManagerError('INVALID_COMMAND', 'Pi command type is required.');
    switch (command.type) {
      case 'prompt': return this.#prompt(session, runtime, command);
      case 'get_state': {
        const state = runtime.getState();
        return reply(command, { ...(object(state) ? state : {}), inputContract: this.inputContract });
      }
      case 'get_messages': return reply(command, { messages: this.#history(session, runtime) });
      case 'get_resources': {
        const pin=this.#runtimeExtensions.get(runtime) ?? emptyExtensionPin(session.projectId);
        return reply(command,{skills:pin.skills.map(skill=>({name:skill.id,displayName:skill.name,description:skill.description,
          version:skill.version,sha256:skill.sha256,requiredCapabilities:skill.requiredCapabilities,source:'athena-host',loadTool:'load_skill'})),
          prompts:[],extensions:pin.plugins.map(plugin=>({name:plugin.id,revision:plugin.revision,kind:'athena-declarative-plugin'})),themes:[],contextFiles:[],diagnostics:[]});
      }
      case 'get_entries': {
        const since = typeof command.since === 'string' && command.since.trim() ? command.since : undefined;
        // Project the whole transcript before slicing so a repeated message can be
        // matched to its original occurrence even when the requested page omits it.
        const response = await runtime.command(since === undefined ? command : {...command,since:undefined});
        if (!object(response) || !object(response.data) || !Array.isArray(response.data.entries)) return response;
        const entries = response.data.entries;
        const messages = this.#history(session, runtime, entries.map(entry => object(entry) ? entry.message : undefined), false);
        const index = since === undefined ? -1 : entries.findIndex(entry => object(entry) && entry.id === since);
        if (since !== undefined && index === -1) return runtime.command(command);
        return { ...response, data: { ...response.data, entries: entries.map((entry, index) =>
          object(entry) && entry.type === 'message' ? { ...entry, message: messages[index] } : entry).slice(index + 1) } };
      }
      case 'abort': {
        const run = this.#currentRun(sessionId);
        if (run && pending(run.status)) { await this.cancelRun(run.id); return reply(command,{runId:run.id}); }
        const response = await runtime.command(command);
        return response;
      }
      default:
        if (!READ_COMMANDS.some(type => type === command.type)) throw new ManagerError('UNSUPPORTED_COMMAND', 'Pi command is not supported by this host.');
        return runtime.command(command);
    }
  }

  async #prompt(session: StoredSession, runtime: ManagedPiSession, command: PiCommand, onAccept?:(a:Attempt)=>void, original?:Run): Promise<Response> {
    const requestId = text(command.id, 'Request ID');
    const fingerprint = hash(canonical(command));
    const previous = this.#storage.receipt(session.id, requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ManagerError('REQUEST_ID_CONFLICT', 'Request ID was already used for different input.');
      const response = previous.response;
      if (!object(response) || response.type !== 'response' || typeof response.command !== 'string' || typeof response.success !== 'boolean') {
        throw new ManagerError('INVALID_RECEIPT', 'Stored dispatch receipt is invalid.');
      }
      return { type: 'response', command: response.command, id: requestId, success: response.success,
        ...(response.data !== undefined ? { data: response.data } : {}), ...(typeof response.error === 'string' ? { error: response.error } : {}) };
    }
    if (this.#runs(session.id).some(run => pending(run.status))) throw new ManagerError('RUN_BUSY', 'The current run has not settled.');
    const message = this.#message(command, session);
    const extensions=original?.extensions??this.#extensions.pin(session.projectId);
    this.#extensions.assertPinAvailable(extensions);
    const explicitSkillIds = onAccept ? [] : mentionedSkills(String(command.message), extensions,
      () => this.#extensions.snapshot(session.projectId).skills);
    const first=!onAccept&&this.#storage.project(session.projectId)?.researchWorkflow;
    if(first&&!this.#executionEnabled(session.projectId))throw new ManagerError('EXECUTION_DISABLED',this.#access.available?'Enable offline analysis in this project.':this.#access.reason);
    const roleModels:RoleModels=original?{...original.roleModels}:{...this.#models?.roleModels?.()};
    let selection = original ? (original.model?.profileId?original.model:null) : this.#models?.resolve(session.profileId, this.#storage.project(session.projectId)?.defaultProfileId) ?? null;
    const workerPins=new Map<WorkerRole,PiModelSelection>();
    // Freeze credential identity and reasoning before admitting the run or any child.
    if(Object.keys(roleModels).length&&this.#models){
      this.#busy=true;
      try{
        const resolved=new Map<string,PiModelSelection>();
        for(const role of Object.keys(roleModels) as WorkerRole[]){
          const reference=roleModels[role]!,key=canonical(reference);
          const pin=resolved.get(key)??await this.#models.pin(reference);
          if(original && ((reference.authRef && reference.authRef!==pin.authRef)||(reference.endpoint && reference.endpoint!==pin.endpoint))){
            throw new ManagerError('MODEL_UNAVAILABLE','Restore the original account and endpoint for the '+role+' role.');
          }
          resolved.set(key,pin);
          workerPins.set(role,pin);
          roleModels[role]={...reference,...(pin.endpoint?{endpoint:pin.endpoint}:{}),...(pin.authRef?{authRef:pin.authRef}:{})};
        }
      }finally{this.#busy=false;}
    }
    let pin: PiModelSelection | undefined;
    if (selection && this.#models) {
      this.#busy = true;
      try {
        pin = await this.#models.pin(selection);
        selection = { ...selection, ...(pin.endpoint ? { endpoint: pin.endpoint } : {}), ...(pin.authRef ? { authRef: pin.authRef } : {}) };
        // The public profile revision need not change when its credential is rotated.
        // Reopen the same conversation with this run's freshly resolved runtime every time.
        {
          runtime.close();
          this.#registry.delete(runtime.sessionId);
          try {
            runtime = await this.#make(session.projectId, session.sessionDir, 'parent', session.sessionFile, pin, extensions);
            if (runtime.sessionId !== session.id) {
              this.#registry.delete(runtime.sessionId);
              runtime.close();
              throw new ManagerError('SESSION_ID_MISMATCH', 'The selected model did not reopen the same Pi conversation.');
            }
            this.#runtimeModels.set(runtime, selection);
          } catch (error) {
            if (!this.#closed) await this.#openRoot(session);
            throw error;
          }
        }
        this.#validateModel(runtime, selection);
      } finally { this.#busy = false; }
    } else if (this.#runtimeModels.has(runtime) || this.#runtimeExecution.get(runtime) !== this.#executionEnabled(session.projectId)
      || this.#runtimeExtensions.get(runtime)?.revision !== extensions.revision) {
      this.#busy = true;
      try {
        runtime.close(); this.#registry.delete(runtime.sessionId);
        runtime = await this.#openRoot(session, extensions);
      } finally { this.#busy = false; }
    } else this.#validateModel(runtime, session.model ?? null);
    if(original && canonical(original.model)!==canonical(selection??this.#model(runtime)))throw Error('The original model and reasoning selection is unavailable.');
    const run: Run = { id: randomUUID(), projectId: session.projectId, sessionId: session.id, requestId,
      taskId: randomUUID(), title: command.message && typeof command.message === 'string' ? command.message.slice(0, 120) : 'Research',
      status: 'queued', startedAt: null, endedAt: null, model: selection ?? this.#model(runtime), extensions,...(Object.keys(roleModels).length?{roleModels}:{}) };
    const fileIds=Array.isArray(command.fileReferences)?command.fileReferences.filter(object).map(ref=>text(ref.id,'File ID')):[];
    const a={...this.#attempt({projectId:session.projectId,sessionId:session.id,runId:run.id,taskId:run.taskId,
      parentTaskId:null,agentSessionId:runtime.sessionId},requestId,message,fileIds,selection ?? undefined),
      ...(explicitSkillIds.length?{explicitSkillIds}:{})};
    const response=reply(command,{accepted:true,...context(a)});
    this.#commit(()=>{
      this.#storage.putRecord('run',{...run,agentSessionId:a.agentSessionId,attemptId:a.id});
      this.#journal.accept(a,run.title);onAccept?.(a);
      if(first)this.#saveFlow({planMode:'coordinator',runId:run.id,input:String(command.message),fileIds,searchIds:[],drafts:[]});
      this.#storage.putReceipt({sessionId:session.id,requestId,fingerprint,state:'accepted',response});
    });
    if (pin) this.#pins.set(run.id, pin);
    if(workerPins.size)this.#workerPins.set(run.id,workerPins);
    this.#schedule(a,runtime);
    return response;
  }
  #attempt(owner:Omit<Context,'attemptId'>,requestId:string,prompt:string,fileIds:readonly string[], model?:ModelReference):Attempt {
    const id=randomUUID();
    return {...owner,id,attemptId:id,requestId,prompt,fileIds,status:'queued',acceptedAt:Date.now(),startedAt:null,endedAt:null,...(model?{model}:{})};
  }
  #schedule(a:Attempt,runtime:ManagedPiSession) {
    if (this.#closed) return;
    if (!pending(this.#storage.record<Attempt>('attempt', a.id)?.status ?? 'ready')) {
      if (!pending(this.#storage.record<Run>('run', a.runId)?.status ?? 'ready')) this.#releasePins(a.runId);
      return;
    }
    // Snapshot listeners can request cancellation synchronously during acceptance.
    // Honor that newer decision before starting either of the durable retry turns.
    if (this.#storage.record<Run>('run', a.runId)?.cancellationRequested) {
      this.#commit(() => this.#journal.transition(a, 'cancelled', 'Run cancelled before this queued attempt started.'));
      if (!pending(this.#storage.record<Run>('run', a.runId)?.status ?? 'ready')) this.#releasePins(a.runId);
      return;
    }
    const controller=new AbortController();
    const finished=this.#execute(a,runtime,controller.signal);
    this.#turns.set(a.id,{controller,runtime,attempt:a,finished});
  }
  async #execute(a:Attempt,runtime:ManagedPiSession,signal:AbortSignal) {
    let unsubscribe:(()=>void)|undefined;
    const failureBudget = new ToolFailureBudget();
    try {
      await this.#scheduler.acquire(a,signal);
      signal.throwIfAborted();
      let prompt = a.prompt;
      if (a.kind === 'reconciliation') {
        // Waiting releases only the model slot. The root session lease prevents an
        // earlier coordinator turn and this continuation from entering Pi together.
        let joined: unknown;
        let recoveryRequest: string | undefined;
        do {
          recoveryRequest = this.#storage.record<Run>('run', a.runId)?.recovery?.requestId;
          joined = await this.#wait(a, undefined, signal);
        } while (this.#children(a).some(child => pending(child.status)) ||
          recoveryRequest !== this.#storage.record<Run>('run', a.runId)?.recovery?.requestId);
        signal.throwIfAborted();
        prompt = 'A user-requested retry has settled. Update the final answer to the original request using the current child results below. '
          + 'Reuse completed sibling results and preserve their provenance. Report remaining failures honestly. '
          + 'This is a read-only reconciliation: do not spawn, send work to, or cancel agents. Read relevant result artifacts before answering.\n'
          + 'Current verified child results: ' + JSON.stringify(joined);
        this.#commit(() => {
          const current = this.#storage.record<Attempt>('attempt', a.id);
          if (current && pending(current.status)) this.#storage.putRecord('attempt', { ...current, prompt });
        });
      }
      this.#executing.set(a.agentSessionId,a);
      const attachment = this.#attachmentMessage(a, runtime);
      const publicMessage = (message: unknown) => withMessageOwner(withoutAttachmentContext(message, attachment), a);
      const authorRole=a.workerRole==='writer'||a.workerRole==='editor'?a.workerRole:undefined;
      const paperId=authorRole && this.#storage.get<string>('paper.run:'+a.runId);
      const paper=paperId?this.#papers.paper(a.projectId,paperId):undefined;
      const paperRun=paper?.runs.find(r=>r.id===a.runId && r.attempts.some(t=>t.attemptId===a.id && ['Draft sections','Edit manuscript','Revise manuscript'].includes(t.role)));
      unsubscribe=runtime.subscribe(event=>{
        if(this.#closed || this.#executing.get(a.agentSessionId)!==a)return;
        if(paperRun && authorRole && (event.type==='message_update'||event.type==='message_end')){
          const prior=this.#draftStreams.get(a.id),now=Date.now();
          if(!prior||now-prior.sampled>=160||event.type==='message_end'){
            const text=streamedManuscript(authorRole,event.message,paperRun.outline);
            if(text && text!==prior?.draft.text){
              const draft={role:authorRole,attemptId:a.id,text,updatedAt:now};
              const persist=!prior||now-prior.saved>=1000||event.type==='message_end';
              if(persist)this.#storage.set('paper.draft:'+a.id,draft);
              this.#draftStreams.set(a.id,{draft,sampled:now,saved:persist?now:prior.saved});
              if(paper?.workflow)for(const listener of this.#piListeners)listener(a.sessionId,{
                type:'manuscript_draft',sessionId:a.sessionId,runId:paper.workflow.runId,paperRunId:a.runId,draft:{...draft,active:true}
              });
            }
          }
        }
        const semantic=SNAPSHOT_EVENTS.has(event.type);
        const failure = failureBudget.observe(event);
        this.#storage.transaction(()=>{
          this.#journal.receive(a,event,signal.aborted);
          if (failure) {
            this.#journal.transition(a, 'failed', failure.message);
            this.#journal.event(a, 'tool_failure_limit', failure.message,
              typeof event.toolCallId === 'string' ? {toolId:toolId(a,event.toolCallId)} : {});
          }
          if(semantic){this.#journal.event(a,event.type,event.type,typeof event.toolCallId==='string'?{toolId:toolId(a,event.toolCallId)}:{});this.#storage.advanceRevision();}
        });
        if (failure && this.#executing.get(a.agentSessionId) === a) {
          this.#turns.get(a.id)?.controller.abort(new ManagerError(failure.code, failure.message));
          void runtime.command({type:'abort',id:randomUUID()}).catch(() => {});
        }
        const normalized=normalizeEvent(a,{...event,
          ...('message' in event ? {message:publicMessage(event.message)} : {}),
          ...(Array.isArray(event.messages) ? {messages:event.messages.map(publicMessage)} : {}),
        });
        for(const listener of this.#piListeners)listener(a.agentSessionId,structuredClone(normalized));
        if(semantic)this.#publish();
      });
      let skillContext: string | undefined;
      const selected = a.explicitSkillIds;
      if (selected?.length && !a.kind) {
        const pin = this.#runExtensions(a), capabilities = this.#effectiveCapabilities(a);
        this.#commit(() => {
          const instructions = selected.map(id => {
            const loaded = this.#extensions.loadSkill(pin, context(a), id, 'Explicit $' + id + ' in the chat request.', capabilities, 'explicit');
            this.#journal.event(a, 'skill_loaded', 'Loaded research skill: ' + loaded.metadata.name + ' (' + loaded.status + ')');
            return loaded.instructions;
          });
          skillContext = ['Selected procedures for the following user request.', ...instructions].join('\n\n');
          if (skillContext.length + prompt.length > this.inputContract.maxMessageCharacters)
            throw new ManagerError('INPUT_TOO_LARGE', 'The selected skills exceed the request limit. Choose fewer skills.');
        });
      }
      await runtime.prompt(prompt, a.kind === 'reconciliation' ? {kind: 'reconciliation'} : {skillContext});
      if(!this.#closed && pending(this.#storage.record<Attempt>('attempt',a.id)?.status??'ready'))
        this.#commit(()=>this.#journal.transition(a,signal.aborted?'cancelled':'paused','Pi returned without settling the attempt.'));
    }catch(error){
      if(!this.#closed)this.#commit(()=>this.#journal.transition(a,signal.aborted?'cancelled':'failed',error instanceof Error?error.message:'Pi failed.'));
    }finally{
      unsubscribe?.();
      const preview=this.#draftStreams.get(a.id);
      if(preview && !this.#closed)this.#storage.set('paper.draft:'+a.id,preview.draft);
      this.#draftStreams.delete(a.id);
      if(this.#executing.get(a.agentSessionId)===a)this.#executing.delete(a.agentSessionId);
      this.#scheduler.release(a);this.#turns.delete(a.id);
      if(!a.parentTaskId&&!this.#closed){
        const flow=this.#flow(a.runId),run=this.#storage.record<Run>('run',a.runId);
        if(flow?.documentId&&run?.status==='succeeded'&&!run.cancellationRequested){
          try{await this.#continueFlow(run);}catch(error){
            if(!this.#closed)this.#commit(()=>this.#saveFlow({...flow,error:(error as Error).message}));
          }
        }
      }
      if (!this.#closed && !pending(this.#storage.record<Run>('run',a.runId)?.status ?? 'ready')) this.#releasePins(a.runId);
    }
  }
  #children(a:Context) {return this.#storage.records<TaskRow>('task',a.sessionId).filter(t=>t.runId===a.runId && t.parentTaskId===a.taskId);}
  #child(a:Context,id:unknown) {
    const task=this.#storage.record<TaskRow>('task',text(id,'Task ID'));
    if(!task || task.sessionId!==a.sessionId || task.runId!==a.runId || task.parentTaskId!==a.taskId)
      throw new ManagerError('TASK_SCOPE_MISMATCH','This is not a direct child of the calling task.');
    return task;
  }
  async #summary(t:TaskRow) {
    const artifacts=[];
    for(const id of t.artifactIds) {
      const row=this.#storage.record<ArtifactRow>('artifact',id);
      if(!row || row.projectId!==t.projectId || row.sessionId!==t.sessionId || row.runId!==t.runId || row.taskId!==t.id)
        throw new ManagerError('ARTIFACT_DENIED','Task artifact linkage is inconsistent.');
      await this.#readArtifact(row);
      artifacts.push(artifactRef(row.file));
    }
    return {taskId:t.id,parentTaskId:t.parentTaskId,agentSessionId:t.agentSessionId,attemptId:t.attemptId,
      title:t.title,status:t.status,result:t.result??null,error:t.error,artifactIds:t.artifactIds,artifacts};
  }
  #runExtensions(a: Context): ExtensionPin {
    const run = this.#storage.record<Run>('run', a.runId);
    if (!run || run.projectId !== a.projectId || run.sessionId !== a.sessionId) throw new ManagerError('RUN_SCOPE_MISMATCH', 'Research resources belong to another run.');
    const selected=run.extensions ?? emptyExtensionPin(a.projectId);
    this.#extensions.assertPinAvailable(selected);
    return structuredClone(selected);
  }
  async #externalToken(reference?: string): Promise<string | undefined> {
    if (reference === undefined) return;
    if (!/^athena\.external-mcp\/[a-f0-9-]{36}$/.test(reference) || !this.#externalCredentials) {
      throw new ManagerError('MCP_CREDENTIAL_UNAVAILABLE', 'The original external MCP credential is unavailable. Reconnect for a new run.');
    }
    const credential = await this.#externalCredentials.read(reference);
    if (credential?.type !== 'api_key' || typeof credential.key !== 'string' || !credential.key) {
      throw new ManagerError('MCP_CREDENTIAL_UNAVAILABLE', 'The original external MCP credential is unavailable. Reconnect for a new run.');
    }
    return credential.key;
  }
  #effectiveCapabilities(a: Context): string[] {
    const result = ['read','list_skills','load_skill','get_research_board','add_research_evidence','remember_research'];
    if (this.#executionEnabled(a.projectId)) result.push('read_file','artifact.read','artifact.transfer');
    if (a.parentTaskId === null) result.push('spawn_agent','send_to_agent','wait_for_agents','get_task','list_tasks','cancel_task','plan_research','propose_knowledge');
    else {
      result.push(...builtins.keys(),'submit_review');
      if (this.#executionEnabled(a.projectId)) result.push('write_file','run_command');
      if (this.#runExtensions(a).servers.length) result.push('call_external_mcp');
    }
    if (a.parentTaskId===null && this.#executionEnabled(a.projectId)) result.push('request_review');
    return result;
  }
  async #researchTarget(ctx: Context, requested: {kind:'file'|'artifact';id:string}): Promise<ResearchTarget> {
    const a = this.#storage.record<Attempt>('attempt', ctx.attemptId);
    if (!a || Object.entries(context(a)).some(([key,value]) => value !== ctx[key as keyof Context])) throw new ManagerError('EVIDENCE_DENIED', 'Evidence belongs to another attempt.');
    if (requested.kind === 'file') {
      const {f,bytes} = this.#upload(a, requested.id);
      return {kind:'file',id:f.id,projectId:a.projectId,sessionId:a.sessionId,version:text(f.versionId,'Version'),sha256:hash(bytes),bytes:bytes.length};
    }
    const row = this.#artifact(a, requested.id);
    const bytes = await this.#readArtifact(row);
    const process = this.#storage.record<ProcessRow>('process', row.processId);
    if (!process || process.status !== 'succeeded' || process.taskId !== row.taskId || process.attemptId !== row.attemptId) throw new ManagerError('EVIDENCE_DENIED', 'Evidence does not have a successfully published process.');
    return {kind:'artifact',id:row.id,projectId:row.projectId,sessionId:row.sessionId,version:text(row.version,'Artifact version'),sha256:hash(bytes),bytes:bytes.length,
      taskId:row.taskId,attemptId:row.attemptId,agentSessionId:row.agentSessionId,processId:row.processId,
      inputVersions: (row.evidence ?? process.evidence ?? []).map(input => ({id:input.id,version:input.version}))};
  }
  async #researchOperation(a:Attempt,name:string,raw:string,args:Readonly<Record<string,unknown>>,signal:AbortSignal):Promise<unknown> {
    const resources = this.#runExtensions(a);
    if (name === 'list_skills') return {skills:resources.skills.filter(skill => skill.roles.includes(a.parentTaskId ? 'child' : 'parent'))};
    if (name === 'get_research_board') {
      const board=this.#research.snapshot({projectId:a.projectId,sessionId:a.sessionId,agentSessionId:a.agentSessionId});
      const study=!a.parentTaskId && this.#experimentMission(a.runId);
      return study?{...board,experimentMission:{...study,...missionProgress(study)}}:board;
    }
    if (name === 'load_skill') {
      if (Object.keys(args).some(key => !['id','reason','mode'].includes(key)) || args.mode !== undefined && args.mode !== 'automatic' && args.mode !== 'explicit') throw new ManagerError('INVALID_INPUT', 'Invalid skill selection.');
      const loaded = this.#extensions.loadSkill(resources,context(a),text(args.id,'Skill ID'),text(args.reason,'Selection reason'),this.#effectiveCapabilities(a),args.mode ?? 'explicit');
      this.#commit(() => this.#journal.event(a,'skill_loaded','Loaded research skill: ' + loaded.metadata.name));
      return loaded;
    }
    if (a.kind === 'reconciliation') throw new ManagerError('RECOVERY_READ_ONLY','Recovery may inspect research records but cannot create new research work.');
    const resolver = (ctx:Context,target:{kind:'file'|'artifact';id:string}) => {signal.throwIfAborted(); return this.#researchTarget(ctx,target);};
    let result: unknown;
    switch (name) {
      case 'plan_research': {
        this.#requireCoordinatorWrites(a);
        result = this.#research.plan(a, {...args,requestId:args.requestId ?? raw}, this.#flow(a.runId)?.planMode === 'coordinator');
        break;
      }
      case 'add_research_evidence': result=await this.#research.addEvidence(a,{...args,requestId:args.requestId ?? raw},resolver); break;
      case 'submit_review': result=await this.#research.submitReview(a,args,resolver); break;
      case 'remember_research': result=this.#research.remember(a,{...args,requestId:args.requestId ?? raw}); break;
      case 'propose_knowledge': {
        this.#requireCoordinatorWrites(a);
        // Include both original and independently reproduced bytes. The
        // earlier review alone cannot bless a later corrupted artifact.
        await this.#research.verifyKnowledgeEvidence(a,args,resolver);
        result=this.#research.proposeKnowledge(a,{...args,requestId:args.requestId ?? raw}); break;
      }
      case 'request_review': {
        this.#requireCoordinatorWrites(a); this.#requireEnabled(a);
        const review=await this.#research.prepareReview(a,{...args,requestId:args.requestId ?? raw},resolver);
        if (review.reviewer) return {review,task:await this.#summary(this.#child(a,review.reviewer.taskId))};
        const task=await this.#dispatch(a,'spawn_agent','research-review:'+review.id,{
          title:'Independent evidence review',requestId:'research-review:'+review.id,
          prompt: this.#reviewPrompt(review),
          fileIds:[...new Set(review.targets.filter(target=>target.kind==='file').map(target=>target.id))],
          artifactIds:[...new Set(review.targets.filter(target=>target.kind==='artifact').map(target=>target.id))],
        },signal,next=>this.#research.registerReviewer(a,review.id,next),false,'verification');
        result={review:this.#research.snapshot({projectId:a.projectId,sessionId:a.sessionId}).reviews.find(item=>item.id===review.id),task}; break;
      }
      default: throw new ManagerError('TOOL_DENIED','This research operation is unavailable.');
    }
    this.#commit(()=>this.#journal.event(a,'research_updated','Research record saved.'));
    return result;
  }
  #reviewPrompt(review: {id:string;missionId:string;question:string;targets:readonly ResearchTarget[];contextFiles?:readonly ResearchTarget[]}) {
    return 'You are a fresh independent evidence reviewer. Begin with the original question and the exact evidence below. Assess the current deliverable on its own evidence. '
      + 'Inspect actual files, test the stated criteria, record failures and missing evidence. A separate session can still share model biases. '
      + 'When possible, independently reproduce the calculation using the granted original input and publish your own result. Use add_research_evidence with both the original fileIds and your own artifactIds; include its evidence ID in submit_review.reproductionEvidenceIds. '
      + 'Do not call a re-read of the author result a reproduction. Submit your supported, changes_required or insufficient_evidence verdict with submit_review; checks must describe work actually performed. '
      + '\nReview assignment: ' + JSON.stringify({reviewId:review.id,missionId:review.missionId,question:review.question,targets:review.targets,...(review.contextFiles?{contextFiles:review.contextFiles}: {})});
  }
  async #operation(a:Attempt,name:string,raw:string,args:Readonly<Record<string,unknown>>,sdkSignal?:AbortSignal):Promise<unknown> {
    const turn=this.#turns.get(a.id);
    if(!turn || this.#executing.get(a.agentSessionId)!==a || this.#closed)throw new ManagerError('ATTEMPT_INACTIVE','This attempt is no longer active.');
    const signal=sdkSignal?AbortSignal.any([sdkSignal,turn.controller.signal]):turn.controller.signal;
    signal.throwIfAborted();
    const paperId=this.#storage.get<string>('paper.run:'+a.runId);
    if(a.workerRole==='mission')throw new ManagerError('TOOL_DENIED','The mission planner can only return a decision.');
    if (!a.parentTaskId && !a.kind && !paperId && !planningTools.has(name)
        && this.#flow(a.runId)?.planMode === 'coordinator' && !this.#research.hasPlan(a))
      throw new ManagerError('PLAN_REQUIRED','The main coordinator must call plan_research with its own objective, ordered stages and acceptance criteria before starting research work.');
    if(name==='run_experiment_mission')return this.#runExperimentMission(a,args,signal);
    if(name==='compose_manuscript'||name==='publish_manuscript'){
      if(!paperId||a.kind==='reconciliation')throw new ManagerError('PAPER_DENIED','Start a manuscript from the project workspace.');
      return name==='compose_manuscript'?this.#composePaper(a,paperId,args,signal):this.#publishPaper(a,paperId,raw,args,signal);
    }
    if(name==='search_project_library'||name==='read_project_paper'){
      if(paperId||a.workerRole==='verification'||!this.#storage.project(a.projectId)?.researchWorkflow)throw new ManagerError('SOURCE_DENIED','Open a research project.');
      if(name==='search_project_library')return this.#library.search(a.projectId,bounded(args.query,'search query',300),12);
      const {entry,source}=this.#library.read(a.projectId,text(args.sourceId,'Source'),text(args.version,'Version'));
      const offset=args.offset??0;
      if(typeof offset!=='number'||!Number.isSafeInteger(offset)||offset<0)throw new ManagerError('INVALID_INPUT','Choose a valid text offset.');
      return {entry,text:source.content.slice(offset,offset+12000),nextOffset:offset+12000<source.content.length?offset+12000:null};
    }
    if(['prepare_research_paper','search_research_literature','save_research_draft','record_browser_source','record_experiment_table'].includes(name)){
      const flow=this.#flow(a.runId);
      if(!flow||a.parentTaskId&&!(name==='search_research_literature'&&a.workerRole==='literature')||paperId)throw Error('This tool belongs to the research coordinator.');
      this.#requireCoordinatorWrites(a);
      if(name==='prepare_research_paper')return this.#prepareResearchPaper(a,args,signal);
      if(name==='record_experiment_table'){
        const row=this.#artifact(a,args.artifactId);
        const target=await this.#researchTarget(a,{kind:'artifact',id:row.id});
        if(!Array.isArray(args.path)||args.path.length>8||!args.path.every(k=>typeof k==='string'&&k.length<=128))throw Error('Supply a bounded path to condition rows.');
        let data:unknown=JSON.parse((await this.#readArtifact(row)).toString('utf8'));
        for(const key of args.path){
          if(!object(data)||!Object.hasOwn(data,key))throw Error('Table path does not exist in the published result.');
          data=data[key];
        }
        if(!Array.isArray(data)||!data.length||!data.every(item=>object(item)&&Object.keys(item).length>0&&Object.values(item).every(v=>typeof v==='string'||typeof v==='number')))throw Error('Expected an array of measured condition records.');
        const rows=data.slice(0,24).map(item=>Object.fromEntries(Object.entries(item).slice(0,8).map(([k,v])=>[k.slice(0,128),typeof v==='number'?v:String(v).slice(0,256)])));
        const table={artifactId:row.id,version:target.version,condition:bounded(args.condition,'condition label',128),count:data.length,rows,path:args.path};
        flow.tables??=[];flow.tables=flow.tables.filter(t=>t.artifactId!==row.id);
        if(flow.tables.length>=16)throw Error('Experiment table limit reached.');
        flow.tables.push(table);signal.throwIfAborted();this.#commit(()=>this.#saveFlow({...this.#flow(a.runId)!,tables:flow.tables}));return table;
      }
      if(name==='record_browser_source'){
        const row=this.#artifact(a,args.artifactId),target=await this.#researchTarget(a,{kind:'artifact',id:row.id});
        const p=this.#storage.record<ProcessRow>('process',row.processId);
        if(!p?.job.externalMcp||!p.job.endedAt)throw Error('Select the published receipt of a completed external page-reading tool.');
        const url=bounded(args.url,'source URL',2048),parsed=new URL(url);
        if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw Error('Enter the visited HTTP(S) page URL.');
        const excerpt=bounded(args.excerpt,'page excerpt',12000),claim=bounded(args.claim,'claim',512);
        const payload=JSON.parse((await this.#readArtifact(row)).toString('utf8'));
        const values=(v:unknown):string[]=>typeof v==='string'?[v]:object(v)||Array.isArray(v)?Object.values(v).flatMap(values):[];
        const content=values(payload.result);
        const declared=p.job.externalMcp && this.#runExtensions(a).servers.find(s=>s.id===p.job.externalMcp!.serverId)?.definition.capability;
        if(declared&&declared!=='browser')throw Error('Choose a result from a page-reading MCP connection.');
        if(!content.some(s=>s.includes(url))||!content.some(s=>s.includes(excerpt)))throw Error('The URL and passage must occur in the actual MCP result.');
        const retrievedAt=new Date(p.job.endedAt).toISOString();
        // Preserve the immutable raw receipt as the source; keep the quoted scope and use alongside it.
        const source=this.#papers.saveSource(a.projectId,'Visited page: '+parsed.hostname,JSON.stringify(payload),'full_text',target);
        const page={sourceId:source.sourceId,version:source.version,url,retrievedAt,claim,coverage:(typeof payload.result?.structuredContent?.coverage==='string'?payload.result.structuredContent.coverage.slice(0,512)+' · ':'')+'Returned passage: '+excerpt};
        this.#library.savePassage(a.projectId,page,source,excerpt);
        flow.pages??=[];
        if(!flow.pages.some(x=>x.sourceId===page.sourceId&&x.claim===claim)){
          if(flow.pages.length>=6)throw Error('Page citation limit reached.');
          flow.pages.push(page);this.#commit(()=>this.#saveFlow({...this.#flow(a.runId)!,pages:flow.pages}));
        }
        return page;
      }
      if(name==='save_research_draft'){
        if(!['Introduction','Methods'].includes(String(args.heading)))throw Error('Select Introduction or Methods.');
        flow.drafts=flow.drafts.filter(s=>s.heading!==args.heading).concat({heading:String(args.heading),text:bounded(args.text,'section draft',6000)});
        this.#commit(()=>this.#saveFlow(flow));return {saved:true};
      }
      if(flow.searchIds.length>=4)throw Error('The four-search research limit was reached.');
      const search=this.#bibliography.prepare(a.projectId,a.sessionId,{...args,pages:1,requestId:toolId(a,raw)});
      if(!flow.searchIds.includes(search.id))flow.searchIds.push(search.id);
      this.#commit(()=>this.#saveFlow(flow));
      return this.#searchAndSave(a.projectId,a.sessionId,search.id,signal,{...context(a),toolId:toolId(a,raw)});
    }
    if(paperId){
      if(!['read_file','read','submit_review'].includes(name))throw new ManagerError('PAPER_DENIED','Use the assigned manuscript stage.');
      if(name==='submit_review'){
        const d=this.#papers.paper(a.projectId,paperId),r=d.runs.find(r=>r.id===a.runId)!;
        const current=r.versions.at(-1);
        if(!current||d.versions.at(-1)!==current)throw new ManagerError('VERSION_CONFLICT','The reviewed version is stale.');
        const reads=this.#storage.records<Tool>('tool',a.sessionId).filter(t=>t.attemptId===a.id&&t.name==='read_file'&&t.status==='succeeded').map(t=>t.args).filter(object);
        if(a.fileIds.some(id=>!reads.some(t=>t.fileId===id))||a.artifactGrants?.some(id=>!reads.some(t=>t.artifactId===id)))
          throw new ManagerError('EVIDENCE_UNREAD','Read every assigned source and result with read_file before submitting.');
        if(!Array.isArray(args.checks)||!['Claims:','Citations:','Figures:'].every(category=>(args.checks as unknown[]).some(s=>typeof s==='string'&&s.startsWith(category)&&s.slice(category.length).trim())))
          throw new ManagerError('PAPER_CHECKS','Record claims, citations and figure-data checks.');
        if(args.verdict==='supported'&&this.#papers.version(a.projectId,paperId,current).issues.length)throw new ManagerError('EVIDENCE_MISSING','Resolve the missing evidence before supporting this version.');
      }
    }
    if(!paperId&&this.#flow(a.runId)&&name==='submit_review'&&args.verdict==='supported'){
      const review=this.#research.snapshot(a).reviews.find(r=>r.id===args.reviewId&&r.reviewer?.attemptId===a.id);
      const reads=this.#storage.records<Tool>('tool',a.sessionId).filter(t=>t.attemptId===a.id&&t.status==='succeeded'&&t.name==='read_file').map(t=>t.args).filter(object);
      if(!review||!review.targets.every(t=>reads.some(call=>call[t.kind==='file'?'fileId':'artifactId']===t.id)))throw Error('Read each assigned input and artifact before supporting this experiment.');
    }
    if (['list_skills','load_skill','get_research_board','plan_research','add_research_evidence','request_review','submit_review','remember_research','propose_knowledge'].includes(name)) return this.#researchOperation(a,name,raw,args,signal);
    if(a.parentTaskId)return this.#childTool(a,name,raw,args,signal);
    if (['spawn_agent', 'send_to_agent', 'cancel_task'].includes(name)) this.#requireCoordinatorWrites(a);
    switch(name){
      case 'read':{
        this.#requireEnabled(a);
        const path=text(args.path,'Granted path');
        const id=a.fileIds.find(id=>path==='uploads/'+id+'.txt');
        if(!id)throw new ManagerError('GRANT_DENIED','Path is not an input attached to this turn.');
        return this.#upload(a,id).bytes.toString('utf8');
      }
      case 'run_bibliography_search':
        this.#requireCoordinatorWrites(a);
        return this.#bibliography.execute(a.projectId,a.sessionId,text(args.searchId,'Authorized search'),signal,
          {runId:a.runId,taskId:a.taskId,attemptId:a.id,toolId:toolId(a,raw)});
      case 'spawn_agent':case 'send_to_agent':return this.#dispatch(a,name,raw,args,signal);
      case 'get_task':return this.#summary(this.#child(a,args.taskId));
      case 'list_tasks':return {tasks:await Promise.all(this.#children(a).map(t=>this.#summary(t)))};
      case 'read_file':{
        this.#requireEnabled(a);
        if(Object.keys(args).length!==1)throw new ManagerError('INVALID_INPUT','Supply only an artifactId.');
        const row=this.#artifact(a,args.artifactId);
        return {artifact:artifactRef(row.file),content:(await this.#readArtifact(row)).toString('utf8')};
      }
      case 'wait_for_agents':return this.#wait(a,args.taskIds,signal);
      case 'cancel_task':{
        const child=this.#child(a,args.taskId);
        await this.#cancel(child);
        return this.#summary(this.#child(a,child.id));
      }
      default:throw new ManagerError('TOOL_DENIED','Tool is not available to this agent.');
    }
  }
  #requireCoordinatorWrites(a: Attempt) {
    if (a.kind === 'reconciliation' || this.#storage.record<Run>('run', a.runId)?.recovery) {
      throw new ManagerError('RECOVERY_READ_ONLY', 'Manual recovery preserves completed work. The coordinator may only inspect child results and produce the final answer.');
    }
  }
  async #dispatch(a:Attempt,name:'spawn_agent'|'send_to_agent',raw:string,args:Readonly<Record<string,unknown>>,signal:AbortSignal,onAccepted?:(attempt:Attempt)=>void,resumeChild=false,assignedRole?:WorkerRole):Promise<Accepted>{
    const requestId=text(args.requestId??raw,'Request ID');
    const id=hash(canonical([a.sessionId,a.runId,a.taskId,name,requestId]));
    const kind=name==='spawn_agent'?'spawn':'send';
    const fingerprint=hash(canonical(args));
    const existing=this.#storage.record<Dispatch>(kind,id);
    if(existing){
      if(existing.fingerprint!==fingerprint)throw new ManagerError('REQUEST_ID_CONFLICT','Request ID already has different arguments.');
      if(existing.response)return existing.response;
      throw new ManagerError('DISPATCH_INTERRUPTED','This reservation will not be dispatched again.');
    }
    const child=kind==='send'?this.#child(a,args.taskId):undefined;
    if (child && this.#retryTasks.has(child.id)) throw new ManagerError('TASK_RETRY_PENDING', 'A manual retry is being prepared for this child.');
    if(child && !assignedRole && this.#missionOwnsTask(child))throw new ManagerError('MISSION_OWNED','Continue this task through its experiment mission.');
    const previous=child?this.#storage.records<Attempt>('attempt',a.sessionId).filter(t=>t.taskId===child.id).at(-1):undefined;
    const select=(arg:unknown,fallback:readonly string[])=>{
      if(arg===undefined)return fallback;
      if(!Array.isArray(arg)||arg.length>32||new Set(arg).size!==arg.length||!arg.every((id:unknown):id is string=>typeof id==='string' && id.length>0))
        throw new ManagerError('INVALID_INPUT','Grants must be a bounded list of distinct IDs.');
      return arg;
    };
    if(args.role!==undefined&&!['literature','experiment','worker'].includes(String(args.role)))throw new ManagerError('INVALID_ROLE','Choose a general, literature or experiment worker.');
    const role=previous?.workerRole??assignedRole??(args.role as WorkerRole|undefined)??'worker';
    const selected=this.#storage.record<Run>('run',a.runId)?.roleModels?.[role];
    const model=previous?.model??selected??a.model;
    const fileIds=select(args.fileIds,previous?.fileIds??a.fileIds);
    if(fileIds.some(id=>!a.fileIds.includes(id)))throw new ManagerError('GRANT_DENIED','Cannot transfer an input outside the parent grants.');
    const artifactGrants=select(args.artifactIds,previous?.artifactGrants??[]);
    const transfers=[];
    if(artifactGrants.length)this.#requireEnabled(a);
    for(const id of artifactGrants){const row=this.#artifact(a,id);await this.#readArtifact(row);transfers.push(artifactRef(row.file));}
    if(child && !resumeChild && (child.status==='cancelled'||child.status==='paused'))throw new ManagerError('TASK_CLOSED','Cannot send to a cancelled or interrupted task.');
    const taskId=child?.id??randomUUID();
    const title=child?.title??text(args.title,'Child title');
    const message=text(child?args.message:args.prompt,'Child message');
    if(message.length>32768)throw new ManagerError('INPUT_TOO_LARGE','Child message exceeds 32768 characters.');
    const grantInfo=fileIds.map(id=>({fileId:id,name:this.#storage.record<StoredFile>('file',id)?.name}));
    const prompt=message+'\nGranted input files: '+JSON.stringify(grantInfo)+(transfers.length?'\nGranted result artifacts: '+JSON.stringify(transfers):'');
    if(!child && assignedRole!=='mission' && assignedRole!=='experiment' && a.requestId.startsWith('resume:') && this.#flow(a.runId)){
      const tasks=this.#children(a).filter(t=>t.status==='succeeded'&&t.title===title);
      for(const task of tasks){
        const saved=this.#storage.record<Attempt>('attempt',task.attemptId);
        if(saved?.prompt===prompt && (saved.workerRole??'worker')===role &&
          canonical(saved.fileIds)===canonical(fileIds)&&canonical(saved.artifactGrants??[])===canonical(artifactGrants))
          return {taskId:task.id,parentTaskId:a.taskId,agentSessionId:task.agentSessionId,attemptId:saved.id,status:task.status};
      }
    }
    if(!child && (this.#depth===0||this.#children(a).length>=this.#maxChildren))throw new ManagerError('CHILD_LIMIT','Direct child limit reached.');
    const reservation:Dispatch={...context(a),id,taskId,fingerprint};
    this.#commit(()=>this.#storage.putRecord(kind,reservation));
    const sessionDir=join(this.#directory,'agents',randomUUID());
    const storedAgent=child&&resumeChild?this.#storage.record<AgentSession>('agent_session',child.agentSessionId):undefined;
    const pin=selected&&model&&this.#models?(this.#workerPins.get(a.runId)?.get(role)??await this.#models.pin(model)):this.#pins.get(a.runId);
    if(selected&&pin&&((model?.authRef&&model.authRef!==pin.authRef)||(model?.endpoint&&model.endpoint!==pin.endpoint)))
      throw new ManagerError('MODEL_UNAVAILABLE','Restore the original account and endpoint for the '+role+' role.');
    const runtime=storedAgent?await this.#retryRuntime(storedAgent,model??null,pin,true,this.#runExtensions(a)):
      child?this.#registry.get(child.agentSessionId):await this.#make(a.projectId,sessionDir,'child',undefined,pin,this.#runExtensions(a),role);
    if(!runtime)throw new ManagerError('SESSION_UNAVAILABLE','Child Pi session unavailable.');
    if(model)this.#validateModel(runtime,model);
    signal.throwIfAborted();
    this.#requireCoordinatorWrites(a);
    if (child && this.#retryTasks.has(child.id)) throw new ManagerError('TASK_RETRY_PENDING', 'A manual retry is being prepared for this child.');
    const next={...this.#attempt({...context(a),taskId,parentTaskId:a.taskId,agentSessionId:runtime.sessionId},requestId,prompt,fileIds,model),artifactGrants,workerRole:role};
    const response={taskId,parentTaskId:a.taskId,agentSessionId:runtime.sessionId,attemptId:next.id,status:next.status};
    this.#commit(()=>{
      if(!child)this.#storage.putRecord('agent_session',{projectId:a.projectId,sessionId:a.sessionId,id:runtime.sessionId,
        role:'child',workerRole:role,sessionDir,sessionFile:runtime.sessionFile,...(model?{model}:{})} satisfies AgentSession);
      this.#journal.accept(next,title);
      // A reviewer must be bound to its durable identity before the scheduler
      // can run its first tool. The binding shares the acceptance transaction.
      onAccepted?.(next);
      this.#storage.putRecord(kind,{...reservation,response});
      this.#journal.event(next,child?'send_queued':'child_spawned',title);
    });
    this.#schedule(next,runtime);
    return response;
  }
  async #wait(a:Attempt,list:unknown,signal:AbortSignal) {
    if(list!==undefined && !Array.isArray(list))throw new ManagerError('INVALID_INPUT','taskIds must be an array.');
    const tasks=list?.length?list.map(id=>this.#child(a,id)):this.#children(a);
    const current=()=>tasks.map(t=>this.#child(a,t.id));
    this.#commit(()=>this.#journal.wait(a,tasks));
    if(tasks.some(t=>pending(t.status))) {
      this.#scheduler.release(a,true);
      try {
        await new Promise<void>((resolve,reject)=>{
          const clear=()=>{this.#waiters.delete(check);signal.removeEventListener('abort',abort);};
          const abort=()=>{clear();reject(signal.reason);};
          const check=()=>{if(!current().some(t=>pending(t.status))){clear();resolve();}};
          signal.throwIfAborted();
          this.#waiters.add(check);signal.addEventListener('abort',abort,{once:true});check();
        });
      }finally{
        if(!signal.aborted){await this.#scheduler.acquire(a,signal);
          this.#commit(()=>{this.#journal.transition(a,'running');this.#journal.event(a,'wait_completed','Child tasks settled; model slot reacquired.');});}
      }
    }
    const joined=await Promise.all(current().map(t=>this.#summary(t)));
    if(!this.#executionEnabled(a.projectId))return {tasks:joined};
    // Supply exact read arguments for published data files; never mark them as read here.
    const inspect=joined.flatMap(t=>t.artifacts.filter(f=>/\.(json|csv)$/i.test(f.name)).map(f=>({
      name:f.name,tool:'read_file',arguments:{artifactId:f.id}
    })));
    return {tasks:joined,...(inspect.length ? {nextStep:'Call read_file for these outputs before answering. Check their contents against the request.',inspect} : {})};
  }
  #upload(a:Attempt,selected:unknown) {
    const id=selected===undefined && a.fileIds.length===1?a.fileIds[0]:selected;
    if(typeof id!=='string' || !a.fileIds.includes(id))throw new ManagerError('GRANT_DENIED','Choose one of the explicitly granted file IDs.');
    const f=this.#storage.record<StoredFile>('file',id);
    if(!f || f.sessionId!==a.sessionId || f.projectId!==a.projectId)throw new ManagerError('GRANT_DENIED','File is outside this conversation.');
    return {f,bytes:this.#readUpload(f)};
  }
  #requireEnabled(a:Context) {
    if(!this.#executionEnabled(a.projectId))throw new ManagerError('EXECUTION_DISABLED','Offline execution is not enabled for this project.');
  }
  #artifact(a:Attempt,id:unknown) {
    const row=this.#storage.record<ArtifactRow>('artifact',text(id,'Artifact ID'));
    if(!row || row.projectId!==a.projectId || row.sessionId!==a.sessionId || row.runId!==a.runId ||
      (a.parentTaskId ? row.taskId!==a.taskId && !a.artifactGrants?.includes(row.id) : row.parentTaskId!==a.taskId))
      throw new ManagerError('ARTIFACT_DENIED','Artifact is outside the calling task grants.');
    return row;
  }
  async #readArtifact(row:ArtifactRow) {
    const f=row.file;
    if (f.id!==row.id || f.projectId!==row.projectId || f.sessionId!==row.sessionId || f.attemptId!==row.processId ||
      artifactRef(f).version!==row.version || ('taskId' in f && f.taskId!==row.taskId)) throw new ManagerError('ARTIFACT_DENIED','Inconsistent artifact ownership.');
    return 'kind' in f ? this.#files.download(f) : this.#jobs.download(f);
  }
  async #analysisInput(a:Attempt,ref:unknown,index?:number):Promise<AnalysisSnapshot & {fileId?:string;versionId?:string}> {
    const field=index===undefined?undefined:`inputs[${index}]${typeof ref==='string'?'':'.name'}`;
    const name=validateAnalysisName(text(typeof ref==='string'?ref:object(ref)?ref.name:null,field??'Input name'),
      field===undefined?undefined:{field,mount:'/workspace/'});
    if(typeof ref==='string') {
      if(await this.#files.has(a,name)) {
        const [snapshot]=await this.#files.snapshot(a,[name]);
        if(!snapshot)throw new ManagerError('INVALID_INPUT','Private snapshot missing.');
        return snapshot;
      }
      const matches=a.fileIds.filter(id=>this.#storage.record<StoredFile>('file',id)?.name===name);
      if(matches.length!==1)throw new ManagerError('GRANT_DENIED','Input name is absent or ambiguous; specify an exact granted fileId.');
      const {f,bytes}=this.#upload(a,matches[0]);
      return {name,bytes,fileId:f.id,versionId:f.digest};
    }
    if(!object(ref) || Object.keys(ref).length!==2)throw new ManagerError('INVALID_INPUT','Choose exactly one input source.');
    if(typeof ref.fileId==='string') {
      const {f,bytes}=this.#upload(a,ref.fileId);
      return {name,bytes,fileId:f.id,versionId:f.digest};
    }
    const row=this.#artifact(a,ref.artifactId);
    return {name,bytes:await this.#readArtifact(row),fileId:row.id,versionId:row.version};
  }
  #requirePrivateNames(a:Attempt,names:readonly string[]) {
    const granted=new Set(a.fileIds.map(id=>this.#storage.record<StoredFile>('file',id)?.name.toLowerCase()));
    for(const name of names)if(granted.has(name.toLowerCase()))throw new ManagerError('GRANT_DENIED',
      `Granted upload ${name} is read-only. Put it in run_command.inputs and give outputs a different name.`);
  }
  async #analysis(a:Attempt,raw:string,args:Readonly<Record<string,unknown>>,signal:AbortSignal) {
    const {language,inputs,outputs,args:argv=[]}=args;
    if(Object.keys(args).some(k=>!['language','inputs','outputs','args','script'].includes(k)) ||
      (language!=='node' && language!=='python') || !Array.isArray(inputs) || inputs.length>ANALYSIS_FILE_LIMITS.batchFiles ||
      !Array.isArray(outputs) || !outputs.every((o:unknown)=>typeof o==='string') || !Array.isArray(argv) ||
      !argv.every((o:unknown)=>typeof o==='string'))throw new ManagerError('INVALID_INPUT','Invalid analysis command.');
    const declared=validateOutputNames(outputs,true);
    this.#requirePrivateNames(a,declared);
    const scriptName=text(args.script,'Script name');
    if(!await this.#files.has(a,scriptName))throw new ManagerError('SCRIPT_NOT_FOUND',
      `run_command.script ${JSON.stringify(scriptName)} is not in this task's workspace. No process was started. Write the program with write_file using that name before calling run_command.`);
    const [script]=await this.#files.snapshot(a,[scriptName]);
    if(!script)throw new ManagerError('INVALID_INPUT','A private script is required.');
    const snapshots=await Promise.all(inputs.map((input,index)=>this.#analysisInput(a,input,index)));
    signal.throwIfAborted();
    const processId=randomUUID();
    const job=this.#jobs.startAnalysis({projectId:a.projectId,sessionId:a.sessionId,taskId:a.taskId,requestId:raw,attemptId:processId,
      toolId:toolId(a,raw),language,script,inputs:snapshots,outputs:declared,args:argv});
    const cancel=()=>job.cancel();signal.addEventListener('abort',cancel,{once:true});
    try {
      const result=await job.result;
      const diagnostics={processId,status:result.status,stdout:result.stdout,stderr:result.stderr,exitCode:result.exitCode};
      if(result.status!=='succeeded')throw new ManagerError('ANALYSIS_FAILED',JSON.stringify({...diagnostics,error:result.error??('Analysis '+result.status)}));
      if(!result.artifacts?.length)throw new ManagerError('ANALYSIS_FAILED','Successful analysis is missing artifact receipts.');
      const artifacts=[];
      for(const f of result.artifacts){const row=this.#artifact(a,f.id);await this.#readArtifact(row);artifacts.push(artifactRef(row.file));}
      return {...diagnostics,artifacts};
    }finally{signal.removeEventListener('abort',cancel);}
  }
  async #childTool(a:Attempt,name:string,raw:string,args:Readonly<Record<string,unknown>>,signal:AbortSignal) {
    if (name==='call_external_mcp') {
      if (Object.keys(args).some(key=>!['serverId','tool','arguments'].includes(key)) || !object(args.arguments)) throw new ManagerError('INVALID_INPUT','Choose an approved server, tool and JSON arguments.');
      const server=this.#extensions.getServer(this.#runExtensions(a),text(args.serverId,'Server ID'));
      const tool=text(args.tool,'Tool name');
      const processId=hash(canonical(['external-mcp',context(a),raw]));
      const prior=this.#storage.record<ProcessRow>('process',processId);
      const resultOf=async(result:ProcessRow['job'])=>{
        if (result.status!=='succeeded' || !result.artifact) throw new ManagerError('EXTERNAL_MCP_FAILED',result.error??('External MCP call '+result.status));
        const output:unknown=JSON.parse((await this.#jobs.download(result.artifact)).toString('utf8'));
        return {result:output,artifact:artifactRef(result.artifact),artifactId:result.artifact.id,processId,sha256:result.artifact.sha256};
      };
      if (prior) {
        if (prior.job.externalMcp?.serverId!==server.id || prior.job.externalMcp.tool!==tool || prior.job.externalMcp.argumentDigest!==extensionDigest(args.arguments)) throw new ManagerError('REQUEST_ID_CONFLICT','This external tool call ID was already used with other arguments.');
        // Never replay an unknown, failed or interrupted external side effect.
        return resultOf(prior.job);
      }
      const token=await this.#externalToken(server.verification.credentialRef);
      signal.throwIfAborted();
      const job=this.#jobs.startExternal({projectId:a.projectId,sessionId:a.sessionId,taskId:a.taskId,attemptId:processId,toolId:toolId(a,raw),requestId:raw,server,tool,arguments:args.arguments,token});
      const cancel=()=>job.cancel(); signal.addEventListener('abort',cancel,{once:true});
      try { return await resultOf(await job.result); }
      finally { signal.removeEventListener('abort',cancel); }
    }
    if(['read_file','write_file','run_command'].includes(name)) {
      this.#requireEnabled(a);
      if(name==='run_command')return this.#analysis(a,raw,args,signal);
      if(name==='write_file') {
        if(typeof args.content!=='string' || Object.keys(args).length!==2)throw new ManagerError('INVALID_INPUT','Supply a filename and UTF-8 content.');
        const filename=text(args.name,'Name');this.#requirePrivateNames(a,[filename]);await this.#files.write(a,filename,args.content);
        return {name:filename,bytes:Buffer.byteLength(args.content),sha256:hash(args.content),scope:'private workspace',
          execution:'not executed',published:false};
      }
      if(Object.keys(args).length!==1)throw new ManagerError('INVALID_INPUT','Choose exactly one file source.');
      if(typeof args.fileId==='string')return this.#upload(a,args.fileId).bytes.toString('utf8');
      if(typeof args.artifactId==='string')return (await this.#readArtifact(this.#artifact(a,args.artifactId))).toString('utf8');
      return Buffer.from((await this.#analysisInput(a,text(args.name,'Name'))).bytes).toString('utf8');
    }
    if (name === 'read') {
      if (Object.keys(args).some(key => key !== 'fileId')) throw new ManagerError('INVALID_INPUT','Unexpected read argument.');
      return this.#upload(a,args.fileId).bytes.toString('utf8');
    }
    const entry = builtins.get(name);
    if (!entry || entry.role !== 'child') throw new ManagerError('TOOL_DENIED','Tool is not available to this agent.');
    const {fileId, wire} = bindCall(entry,args);
    const {f,bytes} = this.#upload(a,fileId);
    const grant = await this.#jobs.grant({projectId:a.projectId,sessionId:a.sessionId,fileId:f.id,versionId:text(f.versionId,'Version'),name:f.name,bytes},name);
    signal.throwIfAborted();
    const tid=toolId(a,raw);
    // A process owns its own attempt key: multiple jobs within one Pi turn remain distinct.
    const processId=randomUUID();
    const request={projectId:a.projectId,sessionId:a.sessionId,taskId:a.taskId,attemptId:processId,
      toolId:tid,grantId:grant.id,requestId:raw};
    const job=this.#jobs.startMcp(name,request,wire);
    const cancel=()=>job.cancel();signal.addEventListener('abort',cancel,{once:true});
    try{
      const result=await job.result;
      if(result.status!=='succeeded' || !result.artifact)throw new ManagerError(entry.errorCode,result.error??('MCP process '+result.status));
      const output:unknown=JSON.parse((await this.#jobs.download(result.artifact)).toString('utf8'));
      return {[entry.resultField]:output,artifact:artifactRef(result.artifact),artifactId:result.artifact.id,processId,sha256:result.artifact.sha256};
    }finally{signal.removeEventListener('abort',cancel);}
  }
  #processEvent(event:JobEvent){
    this.#storage.transaction(()=>{this.#journal.process(event);this.#storage.advanceRevision();});
    // The runner treats a thrown completion callback as an uncommitted result.
    // A listener failure after commit must not revoke an already published artifact.
    try{this.#publish();}
    catch(error){process.emitWarning('The committed process update could not notify every listener.',{
      code:'PROCESS_NOTIFICATION_FAILED',detail:error instanceof Error?error.message:String(error),
    });}
  }
  #history(conversation:StoredSession,runtime:ManagedPiSession,messages=runtime.getMessages(),linkTools=true) {
    if(!Array.isArray(messages))throw new ManagerError('INVALID_HISTORY','Invalid Pi history.');
    const attempts=new Map(this.#storage.records<Attempt>('attempt',conversation.id).map(attempt=>[attempt.id,attempt]));
    const journal=this.#storage.records<HistoryEvent>('pi_event',conversation.id)
      .filter(row=>{
        const attempt=attempts.get(row.attemptId);
        return row.projectId===conversation.projectId && row.sessionId===conversation.id && row.agentSessionId===runtime.sessionId &&
          attempt && Object.entries(context(attempt)).every(([key,value])=>row[key as keyof Context]===value);
      });
    return projectHistory(messages,journal,(message, owner)=>{
      const attempt=attempts.get(owner.attemptId);
      return attempt ? withoutAttachmentContext(message,this.#attachmentMessage(attempt,runtime)) : message;
    },linkTools);
  }
  async getAgentHistory(conversationId:string,agentSessionId:string) {
    this.#assertReady();
    const conversation=this.#session(conversationId);
    const agent=this.#storage.record<AgentSession>('agent_session',agentSessionId);
    if(agentSessionId!==conversationId && (!agent || agent.sessionId!==conversationId || agent.projectId!==conversation.projectId))
      throw new ManagerError('SESSION_MISMATCH','Agent session is outside the requested conversation.');
    const runtime=agent?await this.#load(agent):await this.#openRoot(conversation);
    return {conversationId,agentSessionId,messages:this.#history(conversation,runtime)};
  }
  async artifactDownload(conversationId:string,artifactId:string){
    this.#assertReady();
    const library=/^library-([a-f0-9]{64})$/.exec(artifactId);
    if(library){
      if(conversationId!==this.#active)throw new ManagerError('SOURCE_DENIED','Open the project conversation to download its paper.');
      return this.#library.original(this.#session(conversationId).projectId,library[1]!);
    }
    const file=this.#storage.record<ArtifactRow>('artifact',artifactId);
    if(!file)return this.#papers.download(conversationId,artifactId);
    if(file.sessionId!==conversationId)throw new ManagerError('ARTIFACT_DENIED','Artifact is outside this conversation.');
    return {bytes:await this.#readArtifact(file),name:file.file.name,mimeType:file.file.mimeType};
  }
  #retryTarget(taskId: string, expectedAttemptId?: string) {
    const task = this.#storage.record<TaskRow>('task', taskId);
    if (task && this.#storage.get('paper.run:'+task.runId))throw new ManagerError('TASK_NOT_RETRYABLE','Manuscript runs retain partial results; start a new explicit run.');
    if (!task || task.sessionId !== this.#active) throw new ManagerError('TASK_SCOPE_MISMATCH', 'Task is outside the selected conversation.');
    const runs = this.#runs(task.sessionId);
    if (runs.some(run => run.id !== task.runId && pending(run.status))) throw new ManagerError('RUN_BUSY', 'Another run is still active in this conversation.');
    const run = runs.at(-1);
    if (!run || run.id !== task.runId) throw new ManagerError('STALE_RUN', 'Only a task from the latest run can be retried.');
    if (pending(run.status) && run.cancellationRequested) throw new ManagerError('RUN_CANCELLED', 'Wait for the current cancellation to settle before retrying.');
    if (expectedAttemptId !== undefined && expectedAttemptId !== task.attemptId) throw new ManagerError('STALE_ATTEMPT', 'This task has a newer attempt. Refresh before retrying.');
    if (!task.parentTaskId || !['failed', 'paused', 'cancelled'].includes(task.status)) throw new ManagerError('TASK_NOT_RETRYABLE', 'Only failed, interrupted, or cancelled child tasks can be retried.');
    const previous = this.#storage.record<Attempt>('attempt', task.attemptId);
    const root = this.#storage.record<TaskRow>('task', run.taskId);
    const rootAttempt = root && this.#storage.record<Attempt>('attempt', root.attemptId);
    const agent = this.#storage.record<AgentSession>('agent_session', task.agentSessionId);
    if (!previous || previous.taskId !== task.id || previous.runId !== run.id || previous.sessionId !== task.sessionId ||
        previous.projectId !== task.projectId || previous.agentSessionId !== task.agentSessionId || pending(previous.status) ||
        !root || root.id !== task.parentTaskId || root.parentTaskId !== null || root.agentSessionId !== task.sessionId ||
        !rootAttempt || rootAttempt.runId !== run.id || !agent || agent.sessionId !== task.sessionId || agent.projectId !== task.projectId ||
        this.#storage.records<Attempt>('attempt', task.sessionId).some(a => a.taskId === task.id && pending(a.status))) {
      throw new ManagerError('TASK_NOT_RETRYABLE', 'The saved task does not have a complete, settled retry context.');
    }
    return { task, run, previous, root, rootAttempt, agent, session: this.#session(task.sessionId) };
  }
  async #retryRuntime(agent: AgentSession, model: ModelReference | null, pin: PiModelSelection | undefined, refresh: boolean, extensions: ExtensionPin) {
    await this.#loading.get(agent.id);
    let runtime = this.#registry.get(agent.id);
    const live = [...this.#turns.values()].filter(turn => turn.attempt.agentSessionId === agent.id);
    if (live.length && agent.role === 'child') await Promise.all(live.map(turn => turn.finished));
    // The active coordinator keeps its existing lease and runtime. Its read-only
    // reconciliation is queued on that same lease, never a parallel Pi conversation.
    if (runtime && (refresh || this.#runtimeExtensions.get(runtime)?.revision !== extensions.revision) && !(agent.role === 'parent' && live.length)) {
      runtime.close(); this.#registry.delete(agent.id); runtime = undefined;
    }
    runtime ??= await this.#load(agent, pin, extensions);
    if (this.#runtimeExtensions.get(runtime)?.revision !== extensions.revision) throw new ManagerError('EXTENSION_UNAVAILABLE', 'The original research resources are not mounted in this agent.');
    this.#validateModel(runtime, model);
    const actual = this.#runtimeModels.get(runtime) ?? this.#model(runtime);
    if (model?.endpoint && model.endpoint !== actual?.endpoint) throw new ManagerError('MODEL_UNAVAILABLE', 'The original model endpoint is no longer selected.');
    if (model?.authRef && model.authRef !== actual?.authRef) throw new ManagerError('MODEL_UNAVAILABLE', 'The original model account is no longer selected.');
    if (model) this.#runtimeModels.set(runtime, model);
    return runtime;
  }
  #missionOwnsTask(task:TaskRow) {
    return this.#experimentMission(task.runId)?.trials.some(t=>t.worker?.taskId===task.id||t.planners.some(p=>p.taskId===task.id));
  }
  async retryTask(taskId: string, options: RetryTaskOptions): Promise<RetryTaskResult> {
    this.#assertReady();
    text(taskId, 'Task ID');
    if (!object(options) || Object.keys(options).some(key => key !== 'requestId' && key !== 'expectedAttemptId')) throw new ManagerError('INVALID_INPUT', 'Supply a request ID and the displayed attempt ID.');
    const requestId = text(options.requestId, 'Request ID');
    const expectedAttemptId = text(options.expectedAttemptId, 'Expected attempt ID');
    const task = this.#storage.record<TaskRow>('task', taskId);
    if (task && this.#storage.get('paper.run:'+task.runId))throw new ManagerError('TASK_NOT_RETRYABLE','Manuscript runs retain partial results; start a new explicit run.');
    if (!task || task.sessionId !== this.#active) throw new ManagerError('TASK_SCOPE_MISMATCH', 'Task is outside the selected conversation.');
    if(this.#missionOwnsTask(task))throw new ManagerError('TASK_NOT_RETRYABLE','Resume the research checkpoint to reconcile experiment trials.');
    const id = hash(canonical([task.sessionId, 'retry', requestId]));
    const fingerprint = hash(canonical({ taskId, expectedAttemptId }));
    const previous = this.#storage.record<RetryReceipt>('retry', id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ManagerError('REQUEST_ID_CONFLICT', 'Retry request ID was already used for different input.');
      return structuredClone(previous.response);
    }
    const inFlight = this.#retrying.get(id);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) throw new ManagerError('REQUEST_ID_CONFLICT', 'Retry request ID was already used for different input.');
      return inFlight.promise;
    }
    this.#retryTarget(taskId, expectedAttemptId);
    if (this.#busy || this.#retryTasks.has(taskId)) throw new ManagerError('RUN_BUSY', 'Another session operation is being prepared.');
    const promise = this.#prepareRetry(taskId, { requestId, expectedAttemptId }, id, fingerprint);
    this.#retrying.set(id, { fingerprint, promise });
    try { return await promise; } finally { this.#retrying.delete(id); }
  }
  async #prepareRetry(taskId: string, options: RetryTaskOptions, id: string, fingerprint: string): Promise<RetryTaskResult> {
    this.#busy = true; this.#retryTasks.add(taskId);
    try {
      const source = this.#retryTarget(taskId, options.expectedAttemptId);
      const currentSource = () => {
        this.#assertReady();
        const current = this.#retryTarget(taskId, options.expectedAttemptId);
        if (!source.run.cancellationRequested && current.run.cancellationRequested) throw new ManagerError('RUN_CANCELLED', 'The run was cancelled while this retry was being prepared.');
        return current;
      };
      const model = source.previous.model ?? source.run.model;
      // Revalidate immutable grants before accepting a new execution. No current
      // project default, new upload, or additional sibling artifact is inherited.
      for (const fileId of source.previous.fileIds) this.#upload(source.previous, fileId);
      for (const artifactId of source.previous.artifactGrants ?? []) await this.#readArtifact(this.#artifact(source.previous, artifactId));
      const extensions = this.#runExtensions(source.previous);
      // Old run definitions and credential references must be available before
      // admitting a retry; live project settings cannot replace them.
      for (const server of extensions.servers) await this.#externalToken(server.verification.credentialRef);
      let pin = source.previous.workerRole&&source.run.roleModels?.[source.previous.workerRole]?this.#workerPins.get(source.run.id)?.get(source.previous.workerRole):this.#pins.get(source.run.id);
      const managedModel = Boolean(model?.profileId);
      const refresh = !pending(source.run.status) || (!pin && Boolean(this.#models && managedModel));
      if (!pin && this.#models && model && managedModel) {
        pin = await this.#models.pin(model);
        if ((model.endpoint && pin.endpoint !== model.endpoint) || (model.authRef && pin.authRef !== model.authRef)) throw new ManagerError('MODEL_UNAVAILABLE', 'The original model endpoint or account is no longer available.');
      }
      currentSource();
      const childRuntime = await this.#retryRuntime(source.agent, model, pin, refresh, extensions);
      currentSource();
      const parentModel=source.run.model;
      const parentPin=canonical(parentModel)===canonical(model)?pin:this.#pins.get(source.run.id)??(parentModel?.profileId&&this.#models?await this.#models.pin(parentModel):undefined);
      const rootRuntime = await this.#retryRuntime({ ...source.session, sessionId: source.session.id, role: 'parent' }, parentModel, parentPin, refresh, extensions);
      const current = currentSource();
      for (const fileId of current.previous.fileIds) this.#upload(current.previous, fileId);
      let next: Attempt = { ...this.#attempt({ ...context(current.previous) }, options.requestId, current.previous.prompt, current.previous.fileIds, model ?? undefined),
        workerRole:current.previous.workerRole, artifactGrants: current.previous.artifactGrants, retryOfAttemptId: current.previous.id };
      const pendingReconciliation = this.#storage.records<Attempt>('attempt', current.session.id).find(a => a.runId === current.run.id && a.taskId === current.root.id && a.kind === 'reconciliation' && pending(a.status) && this.#executing.get(a.agentSessionId)?.id !== a.id);
      const reconciliation: Attempt = pendingReconciliation ?? { ...this.#attempt({ ...context(current.rootAttempt) }, 'reconcile:' + options.requestId,
        'Reconcile the manually retried child with the preserved results of this request.', current.rootAttempt.fileIds, parentModel ?? undefined), kind: 'reconciliation' };
      const response: RetryTaskResult = { taskId, parentTaskId: current.root.id, agentSessionId: childRuntime.sessionId, attemptId: next.id,
        runId: current.run.id, status: 'queued', reconciliationAttemptId: reconciliation.id };
      this.#commit(() => {
        this.#storage.putRecord('run', { ...current.run, status: 'queued', endedAt: null, error: undefined, cancellationRequested: false,
          recovery: { requestId: options.requestId, reconciliationAttemptId: reconciliation.id } });
        this.#journal.accept(next, current.task.title);
        const retriedReview=this.#research.retryReviewer(current.previous,next);
        if (retriedReview) {
          const grantInfo=next.fileIds.map(id=>({fileId:id,name:this.#storage.record<StoredFile>('file',id)?.name}));
          const transfers=(next.artifactGrants??[]).map(id=>artifactRef(this.#artifact(next,id).file));
          next={...next,prompt:this.#reviewPrompt(retriedReview)+'\nGranted input files: '+JSON.stringify(grantInfo)+'\nGranted result artifacts: '+JSON.stringify(transfers)};
          this.#storage.putRecord('attempt',next);
        }
        if (!pendingReconciliation) this.#journal.accept(reconciliation, current.root.title);
        this.#storage.putRecord('retry', { id, projectId: current.task.projectId, sessionId: current.task.sessionId, runId: current.run.id,
          taskId, requestId: options.requestId, expectedAttemptId: options.expectedAttemptId, fingerprint, response } satisfies RetryReceipt);
        this.#journal.event(next, 'task_retry_accepted', 'Manual retry accepted; previous attempts and successful sibling results are preserved.');
        this.#journal.event(reconciliation, 'run_reopened', 'Manual recovery queued a read-only coordinator reconciliation.');
      });
      if (parentPin) this.#pins.set(current.run.id,parentPin);
      this.#schedule(next, childRuntime);
      if (!pendingReconciliation) this.#schedule(reconciliation, rootRuntime);
      return response;
    } finally {
      this.#retryTasks.delete(taskId); this.#busy = false; this.#publish();
    }
  }
  async #cancel(task:TaskRow){
    const turns=[...this.#turns.values()].filter(t=>t.attempt.taskId===task.id || (!task.parentTaskId && t.attempt.runId===task.runId));
    // Acceptance is durable before its snapshot is published. A listener can cancel
    // a queued attempt before #schedule registers its live controller.
    const queued=this.#storage.records<Attempt>('attempt',task.sessionId).filter(a=>a.status==='queued' && !this.#turns.has(a.id) &&
      (a.taskId===task.id || (!task.parentTaskId && a.runId===task.runId)));
    if(queued.length)this.#commit(()=>{
      for(const a of queued)this.#journal.transition(a,'cancelled','Task cancelled before this queued attempt started.');
    });
    for(const t of turns)t.controller.abort(new ManagerError('CANCELLED','Task cancellation requested.'));
    await Promise.all(turns.filter(t=>this.#executing.get(t.attempt.agentSessionId)===t.attempt).map(t=>t.runtime.command({type:'abort',id:randomUUID()})));
    await Promise.all(turns.map(t=>t.finished));
  }
  async cancelTask(taskId:string) {
    this.#assertReady();
    const task=this.#storage.record<TaskRow>('task',taskId);
    if(!task || task.sessionId!==this.#active)throw new ManagerError('TASK_SCOPE_MISMATCH','Task is outside the selected conversation.');
    if(!pending(task.status))throw new ManagerError('TASK_NOT_ACTIVE','Task is not active.');
    await this.#cancel(task);
    const updated=this.#storage.record<TaskRow>('task',taskId);
    if(!updated)throw new Error('Missing cancelled task.');
    return this.#summary(updated);
  }
  async cancelRun(runId:string) {
    this.#assertReady();
    const run=this.#storage.record<Run>('run',runId);
    if(!run || run.sessionId!==this.#active || !pending(run.status))throw new ManagerError('RUN_NOT_ACTIVE','Run is not active.');
    const task=this.#storage.record<TaskRow>('task',run.taskId);
    if(!task)throw new Error('Missing root task.');
    // Record the user's run-level decision before aborting any Pi turn. The root may already be done.
    this.#storage.transaction(()=>this.#storage.putRecord('run',{...run,cancellationRequested:true}));
    await this.#cancel(task);
    return reply({type:'abort'},{runId});
  }
  #interrupt(sessionId:string,reason:string){
    // Settle the interrupted run in the same transaction as its outstanding work. A completed
    // coordinator cannot establish the outcome of work that was still pending when the host died.
    for(const r of this.#runs(sessionId))if(pending(r.status)){
      this.#journal.finishRun(r,'paused',reason);
      // M1 may have a pending root or tool without a corresponding M2 attempt.
      const root=this.#storage.record<Task>('task',r.taskId);
      if(root && pending(root.status))this.#storage.putRecord('task',{...root,status:'paused'});
      for(const tool of this.#storage.records<Tool>('tool',sessionId))if(tool.runId===r.id && pending(tool.status))this.#storage.putRecord('tool',{...tool,status:'paused'});
    }
    for(const a of this.#storage.records<Attempt>('attempt',sessionId))if(pending(a.status))this.#journal.transition(a,'paused',reason);
  }
  async close(){
    if(this.#closed)return;
    this.#closed=true;this.#shutdown.abort();await Promise.allSettled(this.#manualCompiles);
    const turns=[...this.#turns.values()];
    for(const t of turns)t.controller.abort();
    await Promise.all(turns.filter(t=>this.#executing.get(t.attempt.agentSessionId)===t.attempt).map(t=>t.runtime.command({type:'abort',id:randomUUID()})));
    await Promise.all(turns.map(t=>t.finished));
    await this.#bibliography.close();
    await this.#jobs.close();
    for(const runtime of this.#registry.values())runtime.close();
    this.#registry.clear();this.#pins.clear();this.#workerPins.clear();
    this.#storage.transaction(()=>{
      for(const s of this.#storage.sessions())this.#interrupt(s.id,'Host closed before execution settled.');
      this.#storage.advanceRevision();
    });
    this.#listeners.clear();this.#piListeners.clear();this.#storage.close();
  }
}
