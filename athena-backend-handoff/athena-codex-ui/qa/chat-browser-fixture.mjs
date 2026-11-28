// Browser acceptance fixture: the application, host, Pi tool calls, MCP workers,
// storage, event feed and downloads are real. Only model responses are controlled.
// No account credentials or existing workspace data are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const prompts = Object.freeze({
  compare: 'Calculate the attached measurement statistics and RC response in two separate tasks.',
  cancel: 'Keep streaming so I can test Stop response.',
  rejected: 'This draft must survive a rejected send.',
});
export const inputs = Object.freeze([
  { name: 'measurements.csv', mimeType: 'text/csv', buffer: Buffer.from('measurement_mV\n7\n12\n\n22\n35\n') },
  { name: 'circuit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    schemaVersion: 1, resistanceOhm: 10000, capacitanceFarad: 1e-7, inputVolt: 1, sampleTimesSeconds: [0, 0.001, 0.005],
  }) + '\n') },
]);
const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part?.text || '').join('\n') : '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function createFixture(researchResponder, { hostNodeArgs = [], modelConcurrency = 2, streamSections = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'athena-chat-browser-'));
  const failures = [], calls = [];
  let child, origin = '', hostPort = 0, hostOutput = '';
  const provider = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'browser-fixture' }, ...(researchResponder ? [{ id: 'paper-reader' }] : [])] })); return;
    }
    try {
      assert.equal(request.url, '/v1/chat/completions');
      const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const wire = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const lastUserIndex = wire.messages.findLastIndex(message => message.role === 'user');
      const input = text(wire.messages[lastUserIndex]?.content);
      const outputs = wire.messages.slice(lastUserIndex + 1).filter(message => message.role === 'tool').map(message => text(message.content));
      const coordinator = (wire.tools ?? []).some(tool => tool.function.name === 'spawn_agent');
      calls.push({ ...(researchResponder ? {model:wire.model} : {}), role: coordinator ? 'parent' : 'child', toolResults: outputs.length });
      let next, before = '';
      if (researchResponder) next=await researchResponder({coordinator,input,outputs,model:wire.model,messages:wire.messages});
      else if (coordinator && input.startsWith(prompts.cancel)) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const closed = once(response, 'close');
        response.write(frame({ role: 'assistant', content: 'Waiting for cancellation. This response is still streaming.' }));
        await delay(1800); // A second real stream update while the reader scrolls up.
        if (!response.destroyed) response.write(frame({ content: ' More text arrived while the reader reviewed earlier work.' }));
        await closed; return;
      } else if (coordinator && !input.startsWith(prompts.compare)) {
        next = input.startsWith('Please preserve this identifier exactly:')
          ? 'The requested identifier was preserved.' : 'The preserved draft was accepted.';
      } else if (coordinator) {
        const files = [...input.matchAll(/\{"fileId":"([^"]+)","name":"([^"]+)"\}/g)]
          .map(match => ({ id: match[1], name: match[2] }));
        const csv = files.find(file => file.name === 'measurements.csv');
        const rc = files.find(file => file.name === 'circuit.json');
        assert.ok(csv && rc, 'The real composer must stage both inputs and send their exact grants.');
        if (!outputs.length) {
          before = 'I am delegating the two attached inputs.';
          next = { name: 'spawn_agent', args: { title: 'Summarize voltage measurements', prompt: 'Calculate the measurement_mV column from the granted CSV.', fileIds: [csv.id] } };
        } else if (outputs.length === 1) {
          next = { name: 'spawn_agent', args: { title: 'Calculate the RC response', prompt: 'Calculate the ideal RC step response from the granted circuit JSON.', fileIds: [rc.id] } };
        } else if (outputs.length === 2) next = { name: 'wait_for_agents', args: {} };
        else {
          const joined = JSON.parse(outputs[2]);
          assert.equal(joined.tasks.length, 2);
          assert.ok(joined.tasks.every(task => task.status === 'succeeded' && task.artifacts.length === 1));
          next = 'Both calculations completed. The voltage mean is 19 mV; the RC time constant is 0.001 s. Open the saved results to inspect or download the verified files.';
        }
      } else {
        const rc = input.includes('ideal RC step response');
        if (!outputs.length) next = { name: rc ? 'calculate_rc_response' : 'calculate_csv', args: rc ? {} : { column: 'measurement_mV' } };
        else {
          const result = JSON.parse(outputs[0]);
          assert.ok(result.artifact?.id, 'The real MCP result must publish an artifact.');
          if (rc) {
            assert.equal(result.response.timeConstantSeconds, 0.001);
            next = 'The saved RC response has a 0.001 s time constant.';
          } else {
            assert.equal(result.statistics.statistics[0].mean, 19);
            next = 'The saved measurement result has a mean of 19 mV.';
          }
        }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (before) {
        response.write(frame({ role: 'assistant', content: before }));
        await delay(650); // Observe a live streamed message before the tool call arrives.
      }
      const delta = typeof next === 'string' ? { role: 'assistant', content: next } : { role: 'assistant', tool_calls: (Array.isArray(next)?next:[next]).map((call,index)=>({
        index, id: 'call_' + randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) },
      })) };
      if(streamSections && typeof next==='string' && input.includes('Return only a JSON array')){
        // Leave enough time for two host checkpoint polls of incomplete JSON.
        const first=Math.floor(next.length/3),second=2*first;
        response.write(frame({role:'assistant',content:next.slice(0,first)}));await delay(1800);
        response.write(frame({content:next.slice(first,second)}));await delay(1800);
        response.write(frame({content:next.slice(second)}));
      }else response.write(frame(delta));
      response.write(frame({}, typeof next === 'string' ? 'stop' : 'tool_calls'));
      response.end('data: [DONE]\n\n');
    } catch (error) {
      if(researchResponder)console.error(error);
      failures.push(String(error.stack || error));
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Controlled browser provider assertion failed.' } }));
    }
  });
  function frame(delta, finishReason = null) {
    return 'data: ' + JSON.stringify({ id: 'browser-fixture', object: 'chat.completion.chunk', created: 1,
      model: 'browser-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] }) + '\n\n';
  }
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const providerPort = provider.address().port;

  async function startHost() {
    child = spawn(process.execPath, [...hostNodeArgs, 'runtime/server.ts'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, ATHENA_DATA_DIR: directory, ATHENA_PORT: String(hostPort),
      ATHENA_ENDPOINT: `http://127.0.0.1:${providerPort}/v1`, ATHENA_MODEL: 'browser-fixture',
      ATHENA_PROVIDER: '', ATHENA_API_KEY: '', ATHENA_MODEL_CONCURRENCY: String(modelConcurrency), ATHENA_MAX_CHILDREN: '3', ATHENA_MAX_DEPTH: '1',
    } });
    hostOutput = '';
    const started = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Host startup timed out: ' + hostOutput)), 30000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error('Host exited before startup: ' + code + '\n' + hostOutput)); });
      child.stdout.on('data', chunk => {
        hostOutput += chunk;
        const match = /Athena listening at (http:\/\/127\.0\.0\.1:(\d+))/.exec(hostOutput);
        if (match) { origin = match[1]; hostPort = Number(match[2]); clearTimeout(timeout); resolve(); }
      });
      child.stderr.on('data', chunk => { hostOutput += chunk; });
    });
    await started;
  }
  async function stopHost() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const previous = child;
    const stopped = once(previous, 'exit'); previous.kill('SIGTERM');
    const timeout = setTimeout(() => previous.kill('SIGKILL'), 10000);
    const [code, signal] = await stopped; clearTimeout(timeout);
    assert.equal(signal, null, 'Host must finish graceful shutdown, not require forced termination.');
    assert.equal(code, 0, hostOutput);
  }
  async function rpc(method, args = []) {
    const response = await fetch(origin + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(30000) });
    const body = await response.json();
    assert.equal(response.ok, true, JSON.stringify(body)); assert.ok(!body.error, JSON.stringify(body));
    return body.result;
  }
  async function waitSnapshot(predicate, timeout = 30000) {
    const end = Date.now() + timeout;
    let snapshot;
    while (Date.now() < end) {
      assert.deepEqual(failures, [], 'Controlled provider failed.');
      snapshot = await rpc('getSnapshot');
      if (predicate(snapshot)) return snapshot;
      await delay(50);
    }
    throw new Error('Host condition timed out: ' + JSON.stringify({ run: snapshot?.run, tasks: snapshot?.tasks }));
  }
  try { await startHost(); }
  catch (error) { child?.kill('SIGKILL'); provider.closeAllConnections(); provider.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    get providerEndpoint(){return "http://127.0.0.1:"+providerPort+"/v1";}, get origin() { return origin; }, get calls() { return calls; }, get failures() { return failures; },
    rpc, waitSnapshot, stopHost, startHost,
    async createConversation() {
      const { project } = await rpc('createProject', [{ name: 'Browser acceptance', defaultModel: null }]);
      return rpc('createSession', [{ projectId: project.id, title: 'Measurements and circuit', model: null }]);
    },
    async close() {
      try { await stopHost(); } finally { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await rm(directory, { recursive: true, force: true }); }
    },
  };
}
