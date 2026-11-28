import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { privateTestDirectory } from './platform-test-helpers.ts';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { WorkspaceSnapshot } from '../athena-backend-handoff/athena-codex-ui/integrations/task-manager.d.ts';
import { TaskManager } from '../runtime/manager.ts';
import { ModelProfiles } from '../runtime/model-profiles.ts';
import { ProviderManager } from '../runtime/provider-manager.ts';

type Request = { readonly model: string; readonly tools?: readonly { readonly function: { readonly name: string } }[];
  readonly messages: readonly { readonly role: string; readonly content: unknown }[] };

test('the next run resolves overrides while already-started parent and child use the pinned revision', { timeout: 20_000 }, async t => {
  const directory = privateTestDirectory(join(tmpdir(), 'athena-profile-test-'));
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const hits: { route: string; model: string; parent: boolean; key: string | undefined }[] = [];
  const firstKey = 'controlled-key-A-should-never-be-persisted';
  const secondKey = 'controlled-key-B-should-never-be-persisted';
  let blocked = false;
  const server = createServer(async (req, res) => {
    const route = req.url ?? '';
    const a = route.startsWith('/a/');
    const model = a ? 'fixture-a' : 'fixture-b';
    const key = req.headers.authorization;
    if (route.endsWith('/models')) {
      res.end(JSON.stringify({ data: [{ id: model }] })); return;
    }
    const parts: Buffer[] = [];
    for await (const bytes of req) parts.push(Buffer.from(bytes));
    const body: Request = JSON.parse(Buffer.concat(parts).toString());
    const parent = body.tools?.some(tool => tool.function.name === 'spawn_agent') ?? false;
    hits.push({ route, model: body.model, parent, key });
    const toolCount = body.messages.filter(message => message.role === 'tool').length;
    let call: { name: string; args: object } | undefined;
    if (a && parent && !blocked) {
      blocked = true; arrived.resolve(); await release.promise;
      call = { name: 'spawn_agent', args: { title: 'Worker', prompt: 'Report this model.' } };
    } else if (a && parent && toolCount === 1) call = { name: 'wait_for_agents', args: {} };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta: object, reason: string | null) => res.write(`data: ${JSON.stringify({
      id: 'completion', object: 'chat.completion.chunk', created: 1, model,
      choices: [{ index: 0, delta, finish_reason: reason }],
    })}\n\n`);
    if (call) {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${toolCount}`, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, null);
      emit({}, 'tool_calls');
    } else {
      const secret = a ? firstKey : secondKey;
      emit({ role: 'assistant', content: `Actual fixture ${model}. ${secret.slice(0, 18)}` }, null);
      emit({ content: `${secret.slice(18)}. Completed.` }, null);
      emit({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const providers = await ProviderManager.create(new InMemoryCredentialStore());
  await providers.registerCompatible({ id: 'profile-provider-a', name: 'A', endpoint: `${origin}/a/v1` }, firstKey);
  await providers.registerCompatible({ id: 'profile-provider-b', name: 'B', endpoint: `${origin}/b/v1` }, secondKey);
  const profileStore = () => new ModelProfiles(directory, (provider, id) => providers.model(provider, id), provider => providers.endpoint(provider));
  let profiles = profileStore();
  const managerFor = () => new TaskManager({ dataDir: directory, models: {
    resolve: (conversation, project) => profiles.resolve(conversation, project), pin: model => providers.pin(model),
    requireProfile: id => { profiles.get(id); },
  } });
  let manager = managerFor();
  t.after(async () => {
    release.resolve(); await manager.close(); profiles.close(); await providers.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await manager.initialize();
  const a = profiles.save({ name: 'A', provider: 'profile-provider-a', modelId: 'fixture-a' });
  const b = profiles.save({ name: 'B', provider: 'profile-provider-b', modelId: 'fixture-b' });
  profiles.setAppDefault(b.id);
  const { project } = await manager.createProject({ name: 'Profile scopes' });
  manager.setProjectProfile(project.id, a.id);
  const session = await manager.createSession({ projectId: project.id, title: 'Same history' });
  const events: unknown[] = [];
  const unsubscribe = manager.subscribeAllPi((_sessionId, event) => events.push(structuredClone(event)));
  t.after(unsubscribe);
  const first = await manager.pi(session.sessionId, { type: 'prompt', id: 'first', message: 'Launch a worker.' });
  assert.ok(first);
  await arrived.promise;
  const later = profiles.save({ ...a, name: 'A revised', provider: b.provider, modelId: b.modelId });
  manager.setConversationProfile(session.sessionId, b.id);
  assert.equal(manager.getSnapshot().run.model?.source, 'project');
  assert.equal(manager.getSnapshot().run.model?.configurationRevision, 1);
  release.resolve();
  const settled = () => new Promise<void>((resolve, reject) => {
    const check = (s: WorkspaceSnapshot) => {
      if (s.run.status === 'succeeded') resolve();
      else if (['failed', 'paused', 'cancelled'].includes(s.run.status)) reject(new Error(JSON.stringify(s.attempts)));
    };
    const stop = manager.subscribe(check);
    t.after(stop);
  });
  await settled();
  const old = manager.getSnapshot();
  assert.equal(old.attempts.length, 2);
  assert.equal(new Set(old.attempts.map(attempt => attempt.agentSessionId)).size, 2);
  assert.ok(old.attempts.every(attempt => attempt.model?.profileId === a.id && attempt.model.configurationRevision === 1));
  assert.ok(hits.some(hit => !hit.parent));
  assert.ok(hits.every(hit => hit.route === '/a/v1/chat/completions' && hit.model === 'fixture-a' && hit.key === `Bearer ${firstKey}`));
  await manager.pi(session.sessionId, { type: 'prompt', id: 'second', message: 'Second model.' });
  await settled();
  assert.deepEqual(hits.at(-1), { route: '/b/v1/chat/completions', model: 'fixture-b', parent: true, key: `Bearer ${secondKey}` });
  assert.equal(manager.getSnapshot().run.model?.profileId, b.id);
  assert.equal(manager.getSnapshot().run.model?.source, 'conversation');
  manager.setConversationProfile(session.sessionId, null);
  await manager.pi(session.sessionId, { type: 'prompt', id: 'third', message: 'Use the revised project configuration.' });
  await settled();
  assert.equal(manager.getSnapshot().run.model?.configurationRevision, later.revision);
  manager.setProjectProfile(project.id, null);
  await manager.pi(session.sessionId, { type: 'prompt', id: 'fourth', message: 'Use the app default.' });
  await settled();
  const before = manager.getSnapshot();
  assert.equal(before.run.model?.source, 'app');
  const history = await manager.getAgentHistory(session.sessionId, session.sessionId);
  const publicEvents = JSON.stringify(events);
  assert.match(publicEvents, /\[redacted\]\. Completed/);
  assert.doesNotMatch(publicEvents, /controlled-key-[AB]|should-never-be-persisted/);
  assert.doesNotMatch(JSON.stringify(history), /should-never-be-persisted/);
  for (const path of (await readdir(directory, { recursive: true })).filter(p => /\.(jsonl|sqlite|sqlite-wal)$/u.test(p))) {
    assert.equal((await readFile(join(directory, path))).includes('should-never-be-persisted'), false, path);
  }
  await manager.close(); profiles.close();
  profiles = profileStore(); manager = managerFor(); await manager.initialize();
  assert.equal(profiles.appDefaultProfileId, b.id);
  assert.deepEqual(manager.getSnapshot().attempts, before.attempts);
  assert.deepEqual(await manager.getAgentHistory(session.sessionId, session.sessionId), history);
});

test('worker reasoning is constrained by each model, persisted per role and copied into each new run selection', async t=>{
  const directory=privateTestDirectory(join(tmpdir(),'athena-role-levels-'));
  const providers=await ProviderManager.create(new InMemoryCredentialStore());
  const open=()=>new ModelProfiles(directory,(provider,id)=>providers.model(provider,id));
  let profiles=open();
  t.after(async()=>{profiles.close();await providers.close();await rm(directory,{recursive:true,force:true});});
  const profile=profiles.save({name:'Research reasoning',provider:'openai',modelId:'o3',thinkingLevel:'medium'});
  profiles.setWorkerPreference('writer',profile.id,'low');
  profiles.setWorkerPreference('reviewer',profile.id,'high');
  profiles.setWorkerPreference('editor',profile.id,null);
  const initial=profiles.roleModels();
  assert.equal(initial.writer?.thinkingLevel,'low');
  assert.equal(initial.reviewer?.thinkingLevel,'high');
  assert.equal(initial.editor?.thinkingLevel,'medium');
  assert.equal(initial.reviewer?.source,'role');assert.equal(initial.experiment,undefined);
  assert.throws(()=>profiles.setWorkerPreference('reviewer',profile.id,'off'),/does not support/);
  assert.throws(()=>profiles.setWorkerPreference('unknown',profile.id,'low'),/Unknown worker/);
  assert.throws(()=>profiles.remove(profile.id,1),/worker role/);
  assert.throws(()=>profiles.save({...profile,modelId:'gpt-4o',thinkingLevel:'off'}),/assigned worker reasoning/);
  profiles.close();profiles=open();
  assert.deepEqual(profiles.roleModels(),initial);
  profiles.setWorkerPreference('reviewer',profile.id,'low');
  assert.equal(initial.reviewer?.thinkingLevel,'high');
  assert.equal(profiles.roleModels().reviewer?.thinkingLevel,'low');
  for(const role of ['writer','editor','reviewer'])profiles.setWorkerPreference(role,null,null);
  profiles.remove(profile.id,1);
  assert.deepEqual(profiles.roleModels(),{});
});
