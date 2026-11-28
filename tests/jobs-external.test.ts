import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { privateTestDirectory } from './platform-test-helpers.ts';
import { JobRunner } from '../runtime/jobs.ts';
import type { JobEvent, JobRunnerOptions, ExternalMcpJob } from '../runtime/jobs.ts';
import { ExtensionStore } from '../runtime/extensions.ts';
import { discoverExternalMcp, isTransientExternalConnectionError, probePinnedExternalMcp } from '../runtime/external-mcp-client.ts';
import type { ExternalServerDefinition } from '../runtime/external-mcp-client.ts';
import { Storage } from '../runtime/storage.ts';

const scope = { projectId: 'external-project', sessionId: 'external-session' };
const identity = { ...scope, requestId: 'request-a', taskId: 'task-a', attemptId: 'attempt-a', toolId: 'tool-a' };
async function fixture(t: TestContext, options: Omit<JobRunnerOptions, 'dataDir'> = {}) {
  const dataDir = privateTestDirectory(join(tmpdir(), 'athena-external-jobs-'));
  const storage = new Storage(dataDir), extensions = new ExtensionStore(storage);
  let respond: ((res: ServerResponse, message: { id: number; params: { arguments: { value: number } } }) => void) | undefined;
  let deleted: ((res: ServerResponse) => void) | undefined;
  let discoveryResponse: ((res: ServerResponse) => void) | undefined;
  const requests: string[] = [];
  const http = createServer(async (req, res) => {
    if (req.method === 'DELETE') { if (deleted) deleted(res); else res.writeHead(202).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()); requests.push(message.method);
    if (message.method === 'initialize' && discoveryResponse) { discoveryResponse(res); return; }
    if (message.method.startsWith('notifications/')) { res.writeHead(202).end(); return; }
    res.setHeader('Content-Type', 'application/json');
    let result: unknown;
    if (message.method === 'initialize') { res.setHeader('Mcp-Session-Id', 'job-fixture'); result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'job-fixture', version: '1.0.0' } }; }
    else if (message.method === 'tools/list') result = { tools: [{ name: 'double', inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false } }] };
    else if (respond) { respond(res, message); return; }
    else result = { content: [{ type: 'text', text: String(message.params.arguments.value * 2) }], structuredContent: { doubled: message.params.arguments.value * 2 } };
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const definition: ExternalServerDefinition = { id: 'fixture', name: 'External fixture', transport: 'streamable-http', url: `http://127.0.0.1:${address.port}/mcp`, allowedTools: ['double'], timeoutMs: 1000 };
  extensions.install(scope.projectId, { schemaVersion: 1, id: 'external-fixture', name: 'External fixture', version: '1.0.0', description: 'Controlled external MCP.', mcpServers: [definition] });
  const configured = extensions.getConfiguredServer(scope.projectId, 'external-fixture', 'fixture');
  const checked = await discoverExternalMcp(definition);
  extensions.recordVerification(scope.projectId, 'external-fixture', 'fixture', checked, configured.pluginRevision);
  extensions.setEnabled(scope.projectId, 'external-fixture', true);
  const server = extensions.getServer(extensions.pin(scope.projectId), 'external-fixture/fixture');
  const runners: JobRunner[] = [], make = (other: Omit<JobRunnerOptions, 'dataDir'> = {}) => {
    const runner = new JobRunner({ dataDir, ...options, ...other }); runners.push(runner); return runner;
  };
  const runner = make();
  t.after(async () => {
    for (const instance of runners) await instance.close();
    storage.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });
  const input: ExternalMcpJob = { ...identity, server, tool: 'double', arguments: { value: 7 } };
  return { runner, make, input, dataDir, extensions, requests,
    respond(next: typeof respond) { respond = next; }, onDiscovery(next: typeof discoveryResponse) { discoveryResponse = next; },
    onDelete(next: typeof deleted) { deleted = next; } };
}

test('only transport failures before dispatch can resume when the pinned connection returns', async t => {
  const f = await fixture(t);
  const probe = () => probePinnedExternalMcp(f.input.server.definition, f.input.server.verification);
  for (const failure of ['socket', 503, 401] as const) {
    f.onDiscovery(res => { if (failure === 'socket') res.destroy(); else res.writeHead(failure).end(); });
    const failed = await f.runner.startExternal({ ...f.input, attemptId: String(failure) }).result;
    assert.equal(failed.externalFailure, failure === 401 ? 'blocked' : 'connection');
    await assert.rejects(probe(), err => isTransientExternalConnectionError(err) === (failure !== 401));
  }
  f.onDiscovery(undefined);
  await probe();
  assert.equal(f.requests.filter(method => method === 'tools/call').length, 0);
  f.respond(res => res.destroy());
  const unknown = await f.runner.startExternal({ ...f.input, attemptId: 'lost-response' }).result;
  assert.equal(unknown.status, 'failed');
  assert.equal(unknown.externalFailure, 'outcome_unknown');
  await probe();
  assert.equal(f.requests.filter(method => method === 'tools/call').length, 1);
});

test('external, CSV and RC jobs share one queue; actual result bytes and old receipts survive uninstall/restart', { timeout: 10000 }, async t => {
  const events: JobEvent[] = [], f = await fixture(t, { concurrency: 1, onEvent: event => events.push(event) });
  const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.respond((res, msg) => { reached.resolve(); void release.promise.then(() => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
    result: { content: [{ type: 'text', text: '14' }], structuredContent: { doubled: 14 } } }))); });
  const csv = await f.runner.grant({ ...scope, fileId: 'csv', versionId: 'csv-v1', name: 'data.csv', bytes: Buffer.from('value\n7\n13\n21\n35\n\n') });
  const rc = await f.runner.grant({ ...scope, fileId: 'rc', versionId: 'rc-v1', name: 'circuit.json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1,
    resistanceOhm: 10000, capacitanceFarad: 1e-7, inputVolt: 1, sampleTimesSeconds: [0, 0.001, 0.005] })) }, 'calculate_rc_response');
  const external = f.runner.startExternal(f.input); await reached.promise;
  const csvRun = f.runner.start({ ...identity, attemptId: 'csv', grantId: csv.id, column: 'value' });
  const rcRun = f.runner.startMcp('calculate_rc_response', { ...identity, attemptId: 'rc', grantId: rc.id });
  assert.deepEqual(events.filter(event => event.type === 'process_started').map(event => event.attempt.attemptId), ['attempt-a']);
  release.resolve();
  const [remote, stats, circuit] = await Promise.all([external.result, csvRun.result, rcRun.result]);
  assert.equal(remote.status, 'succeeded', remote.error); assert.equal(stats.status, 'succeeded', stats.error); assert.equal(circuit.status, 'succeeded', circuit.error);
  assert.deepEqual(events.filter(event => event.type === 'process_started').map(event => event.attempt.attemptId), ['attempt-a', 'csv', 'rc']);
  assert.ok(remote.artifact && stats.artifact && circuit.artifact);
  const bytes = await f.runner.download(remote.artifact), parsed = JSON.parse(bytes.toString());
  assert.equal(parsed.kind, 'external-mcp-result'); assert.equal(parsed.result.structuredContent.doubled, 14);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), remote.artifact.sha256);
  assert.equal(remote.pid, null); assert.deepEqual(remote.env, {}); assert.equal(remote.artifact.receiptKind, 'external-mcp-v1');
  assert.equal(JSON.parse((await f.runner.download(stats.artifact)).toString()).statistics[0].mean, 19);
  assert.equal(JSON.parse((await f.runner.download(circuit.artifact)).toString()).timeConstantSeconds, 0.001);
  f.extensions.remove(scope.projectId, 'external-fixture');
  await f.runner.close();
  const restarted = f.make({ recoveredAttempts: [remote, stats, circuit] });
  assert.deepEqual(await restarted.download(remote.artifact), bytes);
  await assert.rejects(restarted.download({ ...remote.artifact, sessionId: 'another-conversation' }), { code: 'ARTIFACT_DENIED' });
  assert.throws(() => restarted.startExternal(f.input), { code: 'DUPLICATE_ATTEMPT' });
});

test('external cancellation and timeout preserve uncertain remote state and publish no artifact', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const reached = Promise.withResolvers<void>(); f.respond(() => reached.resolve());
  const cancelled = f.runner.startExternal(f.input); await reached.promise; cancelled.cancel();
  const result = await cancelled.result;
  assert.equal(result.status, 'cancelled'); assert.equal(result.cancellation, 'unknown'); assert.equal(result.artifact, undefined);
  assert.match(result.error ?? '', /may still have completed/);
  assert.equal(result.externalFailure, 'outcome_unknown');
  const timeout = await f.runner.startExternal({ ...f.input, attemptId: 'timeout' }).result;
  assert.equal(timeout.status, 'timed_out'); assert.equal(timeout.cancellation, 'unknown'); assert.equal(timeout.artifact, undefined);
  assert.equal(timeout.externalFailure, 'outcome_unknown');
  assert.ok(f.requests.includes('notifications/cancelled'));
});

test('cancellation after a complete remote result but before local publication suppresses the output', { timeout: 10000 }, async t => {
  const f = await fixture(t), cleanup = Promise.withResolvers<ServerResponse>();
  f.onDelete(res => cleanup.resolve(res));
  const handle = f.runner.startExternal(f.input);
  const response = await cleanup.promise; // tools/call returned; client cleanup holds the publication boundary.
  handle.cancel(); response.writeHead(202).end();
  const result = await handle.result;
  assert.equal(result.status, 'cancelled'); assert.equal(result.artifact, undefined);
  assert.equal(result.cancellation, 'unknown');
});

test('failed external results and terminal persistence failures never return a published result', { timeout: 10000 }, async t => {
  let failedPublication = false;
  const f = await fixture(t, { onEvent(event) {
    if (event.type === 'process_finished' && event.attempt.status === 'succeeded' && !failedPublication) {
      failedPublication = true; throw new Error('Controlled terminal storage failure');
    }
  } });
  const first = await f.runner.startExternal(f.input).result;
  assert.equal(first.status, 'failed'); assert.equal(first.artifact, undefined); assert.match(first.error ?? '', /persist process completion/);
  f.respond((res, msg) => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'Controlled remote rejection' }] } })));
  const rejected = await f.runner.startExternal({ ...f.input, attemptId: 'rejected' }).result;
  assert.equal(rejected.status, 'failed'); assert.equal(rejected.artifact, undefined); assert.match(rejected.error ?? '', /Controlled remote rejection/);
  assert.equal(rejected.externalFailure, 'tool_error');
  f.respond(undefined);
  const next = await f.runner.startExternal({ ...f.input, attemptId: 'next' }).result;
  assert.equal(next.status, 'succeeded', next.error);
});

test('interrupted external attempts restore once as interrupted without network replay', { timeout: 10000 }, async t => {
  const events: JobEvent[] = [], f = await fixture(t, { onEvent: event => events.push(event) });
  const reached = Promise.withResolvers<void>(); f.respond(() => reached.resolve());
  const handle = f.runner.startExternal(f.input); await reached.promise;
  const active = events.filter(event => event.type === 'process_output').at(-1)?.attempt; assert.ok(active);
  await f.runner.close(); await handle.result;
  const before = f.requests.length, restored: JobEvent[] = [];
  const restarted = f.make({ recoveredAttempts: [active], onEvent: event => restored.push(event) });
  await new Promise<void>(resolve => queueMicrotask(resolve));
  assert.equal(restored.length, 1); assert.equal(restored[0]?.attempt.status, 'interrupted'); assert.equal(restored[0]?.attempt.cancellation, 'unknown');
  assert.equal(restored[0]?.attempt.artifact, undefined); assert.equal(f.requests.length, before);
  assert.equal(restored[0]?.attempt.externalFailure, 'outcome_unknown');
  assert.throws(() => restarted.startExternal(f.input), { code: 'DUPLICATE_ATTEMPT' });
});

test('crash during discovery is safe to resume only with a durable pre-dispatch receipt', async t=>{
  const events:JobEvent[]=[];
  const f=await fixture(t,{onEvent:event=>events.push(event)});
  const reached=Promise.withResolvers<void>();
  f.onDiscovery(()=>reached.resolve());
  const handle=f.runner.startExternal(f.input); await reached.promise;
  const active=events.at(-1)!.attempt;
  assert.equal(active.externalDispatch,'pending');
  await f.runner.close(); await handle.result;
  const restored:JobEvent[]=[];
  const legacy={...active,attemptId:'old',externalDispatch:undefined};
  f.make({recoveredAttempts:[active,legacy],onEvent:event=>restored.push(event)});
  await new Promise<void>(resolve=>queueMicrotask(resolve));
  assert.deepEqual(restored.map(({attempt})=>[attempt.externalFailure,attempt.cancellation]),[
    ['connection','confirmed'],['outcome_unknown','unknown']
  ]);
  assert.ok(!f.requests.includes('tools/call'));
});

test('a failing dispatch journal prevents the external operation from starting', async t=>{
  const f=await fixture(t,{onEvent(event){
    if(event.type==='process_output' && event.attempt.externalDispatch==='dispatching')throw Error('Dispatch journal unavailable');
  }});
  const result=await f.runner.startExternal(f.input).result;
  assert.equal(result.status,'failed');
  assert.equal(result.externalDispatch,'pending');
  assert.equal(result.externalFailure,'blocked');
  assert.match(result.error??'',/Dispatch journal unavailable/);
  assert.ok(!f.requests.includes('tools/call'));
});
