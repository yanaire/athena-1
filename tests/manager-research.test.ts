import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { privateTestDirectory } from './platform-test-helpers.ts';
import { JobRunner } from '../runtime/jobs.ts';
import { CrossrefProvider } from '../runtime/crossref.ts';
import { TaskManager } from '../runtime/manager.ts';
import { Papers } from '../runtime/papers.ts';
import { Storage } from '../runtime/storage.ts';
import type { ResearchEvidence, ResearchMission, ResearchReview } from '../runtime/research.ts';

type Wire = { model: string; messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[] };
type Call = { name: string; args: object };
type Snapshot = ReturnType<TaskManager['getSnapshot']>;
type Assignment = Pick<ResearchReview, 'id' | 'missionId' | 'question' | 'targets' | 'contextFiles'> & { reviewId: string };
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => part && typeof part === 'object' && 'text' in part ? String(part.text) : '').join('\n');
  return '';
}
function users(wire: Wire) { return wire.messages.filter(message => message.role === 'user'); }
function outputs(wire: Wire): string[] {
  return wire.messages.slice(wire.messages.findLastIndex(message => message.role === 'user') + 1)
    .filter(message => message.role === 'tool').map(message => text(message.content));
}
function parent(wire: Wire) { return wire.tools.some(tool => tool.function.name === 'spawn_agent'); }
function complete(response: ServerResponse, next: string | Call) {
  const delta = typeof next === 'string' ? { role: 'assistant', content: next } : { role: 'assistant', tool_calls: [{ index: 0,
    id: 'call_' + randomUUID(), type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [chunk, reason] of [[delta, null], [{}, typeof next === 'string' ? 'stop' : 'tool_calls']]) {
    response.write('data: ' + JSON.stringify({ id: 'research-fixture', object: 'chat.completion.chunk', created: 1,
      model: 'research-fixture', choices: [{ index: 0, delta: chunk, finish_reason: reason }] }) + '\n\n');
  }
  response.end('data: [DONE]\n\n');
}
function when(manager: TaskManager, predicate: (snapshot: Snapshot) => boolean): Promise<Snapshot> {
  if (predicate(manager.getSnapshot())) return Promise.resolve(manager.getSnapshot());
  return new Promise(resolve => {
    const off = manager.subscribe(() => { const snapshot = manager.getSnapshot(); if (predicate(snapshot)) { off(); resolve(snapshot); } });
  });
}
const terminal = (manager: TaskManager) => when(manager, snapshot => ['succeeded', 'failed', 'cancelled', 'paused'].includes(snapshot.run.status));

async function fixture(t: TestContext, { cancelFirstReview = false, executionEnabled = true } = {}) {
  const directory = await realpath(privateTestDirectory(join(tmpdir(), 'athena-research-manager-')));
  const failures: unknown[] = []; const hits: Wire[] = [];
  const state = { recovering: false, inputId: '', missionId: '', evidenceId: '', authorArtifactId: '', initialReviewId: '',
    reviewerInputs: [] as string[], reviewerQuestions: [] as string[] };

  // This narrowly controlled discovery flag enables the existing approved
  // artifact-transfer gate on hosts without native WASI. No WASI call is made:
  // every actual calculation below uses the real bundled Node CSV MCP worker.
  t.mock.method(JobRunner.prototype, 'analysisAccess', async () => ({ available: true as const, engine: 'Wasmtime 51.0.0' as const,
    node: { path: 'qjs.wasm', version: 'QuickJS-ng 0.18.0' }, python: { path: 'python.wasm', version: 'CPython 3.15.2' } }));

  function answer(wire: Wire): string | Call {
    const results = outputs(wire);
    if (parent(wire)) {
      if (!executionEnabled) {
        switch (results.length) {
          case 0: return { name: 'plan_research', args: { objective: 'Calculate the original measurements and retain an unreviewed observation.', acceptanceCriteria: ['Use the attached original bytes', 'Disclose that independent review and reproduction have not run'], stages: ['Calculate', 'Record observation'] } };
          case 1: {
            state.missionId = (JSON.parse(results[0]!) as ResearchMission).id;
            return { name: 'spawn_agent', args: { title: 'Measurement author', prompt: 'Calculate the original measurement_mV CSV. Report only the published values.', fileIds: [state.inputId] } };
          }
          case 2: return { name: 'wait_for_agents', args: {} };
          case 3: {
            const joined = JSON.parse(results[2]!); state.authorArtifactId = joined.tasks[0].artifacts[0].id;
            assert.equal(joined.tasks[0].status, 'succeeded');
            return { name: 'add_research_evidence', args: { missionId: state.missionId, title: 'Original measurement calculation', fileIds: [state.inputId], artifactIds: [state.authorArtifactId] } };
          }
          case 4: {
            state.evidenceId = (JSON.parse(results[3]!) as ResearchEvidence).id;
            // Deliberately request an unavailable tool to exercise the SDK boundary.
            return { name: 'request_review', args: { missionId: state.missionId, evidenceIds: [state.evidenceId], question: 'Independently reproduce the calculation.' } };
          }
          case 5: {
            assert.match(results[4]!, /request_review.*not found/);
            // Direct delegation must not bypass the host's artifact-transfer gate.
            return { name: 'spawn_agent', args: { title: 'Forbidden reviewer', prompt: 'Review this result.', fileIds: [state.inputId], artifactIds: [state.authorArtifactId] } };
          }
          case 6: {
            assert.match(results[5]!, /Offline execution is not enabled/);
            return { name: 'propose_knowledge', args: { missionId: state.missionId, title: 'Unreviewed voltage summary', method: 'Calculate the granted original CSV; independent reproduction remains pending.', rationale: 'Preserve the observed result without claiming independent verification.', applicability: ['CSV with a measurement_mV column and stated units'], evidenceIds: [state.evidenceId] } };
          }
          case 7: {
            assert.equal(JSON.parse(results[6]!).level, 'observation');
            return { name: 'remember_research', args: { scope: 'project', text: 'The original calculation is saved; independent review and reproduction have not run.' } };
          }
          default: return 'The child reported a mean of 19 mV. Evidence and an observation are saved; independent review and reproduction have not run.';
        }
      }
      if (users(wire).length > 1) return results.length ? 'The manually retried independent reviewer completed; the original result remains 19 mV.' : { name: 'list_tasks', args: {} };
      switch (results.length) {
        case 0: return { name: 'load_skill', args: { id: 'athena-research-intake', reason: 'Define acceptance criteria for the requested measurement study.', mode: 'automatic' } };
        case 1: return { name: 'plan_research', args: { objective: 'Compute measurement statistics and independently reproduce the saved result.', acceptanceCriteria: ['Use the attached original bytes', 'Preserve missing and zero observations', 'Compare the independently calculated result with the published result'], stages: ['Plan', 'Calculate', 'Review', 'Retain method'] } };
        case 2: {
          state.missionId = (JSON.parse(results[1]!) as ResearchMission).id;
          return { name: 'spawn_agent', args: { title: 'Measurement author', prompt: 'Calculate the original measurement_mV CSV. Report only the published values.', fileIds: [state.inputId] } };
        }
        case 3: return { name: 'wait_for_agents', args: {} };
        case 4: {
          const joined = JSON.parse(results[3]!); state.authorArtifactId = joined.tasks[0].artifacts[0].id;
          return { name: 'read_file', args: { artifactId: state.authorArtifactId } };
        }
        case 5: {
          const verified = JSON.parse(JSON.parse(results[4]!).content);
          assert.equal(verified.statistics[0].mean, 19);
          return { name: 'add_research_evidence', args: { missionId: state.missionId, title: 'Original measurement calculation', fileIds: [state.inputId], artifactIds: [state.authorArtifactId] } };
        }
        case 6: {
          state.evidenceId = (JSON.parse(results[5]!) as ResearchEvidence).id;
          return { name: 'request_review', args: { missionId: state.missionId, evidenceIds: [state.evidenceId], question: 'Recompute from the original input, compare all statistics and state any discrepancy.' } };
        }
        case 7: {
          state.initialReviewId = JSON.parse(results[6]!).review.id;
          return { name: 'wait_for_agents', args: {} };
        }
        case 8: {
          if (cancelFirstReview) return 'The author result is preserved. Independent review was cancelled and remains incomplete.';
          return { name: 'propose_knowledge', args: { missionId: state.missionId, title: 'Reproducible voltage summary',
            method: 'Calculate the granted original CSV and independently recalculate before reusing the conclusion.',
            rationale: 'Explicit input versions preserve reproducibility.', applicability: ['CSV with a measurement_mV column and stated units'],
            evidenceIds: [state.evidenceId], reviewIds: [state.initialReviewId] } };
        }
        case 9: {
          assert.equal(JSON.parse(results[8]!).level, 'verified');
          return { name: 'remember_research', args: { scope: 'project', text: 'Report measurement_mV as millivolts and distinguish missing values from valid zeros.' } };
        }
        default: return 'Mean 19 mV; the independent reproduction agrees with the exact saved input and artifact.';
      }
    }
    const input = text(users(wire).at(-1)?.content);
    if (!input.includes('Review assignment: ')) {
      if (!results.length) return { name: 'load_skill', args: { id: 'athena-data-quality', reason: 'Distinguish missing, nonnumeric and valid zero measurements.', mode: 'automatic' } };
      if (results.length === 1) return { name: 'calculate_csv', args: { fileId: state.inputId, column: 'measurement_mV' } };
      assert.equal(JSON.parse(results[1]!).statistics.statistics[0].mean, 19);
      return 'The original CSV mean is 19 mV.';
    }
    const assignmentLine = input.split('\n').find(line => line.startsWith('Review assignment: ')); assert.ok(assignmentLine);
    const assignment = JSON.parse(assignmentLine.slice('Review assignment: '.length)) as Assignment;
    if (!results.length) {
      state.reviewerInputs.push(input); state.reviewerQuestions.push(assignment.reviewId);
      return { name: 'read_file', args: { artifactId: state.authorArtifactId } };
    }
    if (results.length === 1) return { name: 'calculate_csv', args: { fileId: state.inputId, column: 'measurement_mV' } };
    if (results.length === 2) {
      const original = JSON.parse(results[0]!); const computed = JSON.parse(results[1]!);
      assert.deepEqual(computed.statistics.statistics, original.statistics);
      assert.equal(computed.statistics.statistics[0].mean, 19);
      return { name: 'add_research_evidence', args: { missionId: assignment.missionId, title: 'Independent measurement reproduction', fileIds: [state.inputId], artifactIds: [computed.artifact.id] } };
    }
    if (results.length === 3) return { name: 'submit_review', args: { reviewId: assignment.reviewId, verdict: 'supported',
      checks: ['Read the published artifact and recomputed from the same granted input bytes; all saved statistics match.'], findings: [], reproductionEvidenceIds: [JSON.parse(results[2]!).id] } };
    assert.equal(JSON.parse(results[3]!).verdict, 'supported');
    return 'The independently recomputed mean is 19 mV, with all recorded statistics matching.';
  }

  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const wire = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Wire; hits.push(wire);
      const input = text(users(wire).at(-1)?.content);
      if (cancelFirstReview && !state.recovering && !parent(wire) && input.includes('Review assignment: ')) {
        await new Promise<void>(resolve => response.once('close', resolve)); return;
      }
      complete(response, answer(wire));
    } catch (error) {
      failures.push(error);
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Controlled research provider assertion failed.', type: 'authentication_error' } }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const environment = { ATHENA_ENDPOINT: `http://127.0.0.1:${address.port}/v1`, ATHENA_MODEL: 'research-fixture', ATHENA_PROVIDER: '',
    ATHENA_API_KEY: '', ATHENA_MODEL_CONCURRENCY: '1', ATHENA_MAX_CHILDREN: '3', ATHENA_MAX_DEPTH: '1' };
  const restore = Object.entries(environment).map(([key, value]) => { const old = process.env[key]; process.env[key] = value; return () => { if (old === undefined) delete process.env[key]; else process.env[key] = old; }; });
  const managers: TaskManager[] = [];
  t.after(async () => {
    try { for (const manager of managers) await manager.close(); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); restore.forEach(fn => fn()); await rm(directory, { recursive: true, force: true }); }
  });
  async function launch() { const manager = new TaskManager({ dataDir: directory }); managers.push(manager); await manager.initialize(); return manager; }
  const manager = await launch(); const { project } = await manager.createProject({ name: 'Research integration' });
  const { sessionId } = await manager.createSession({ projectId: project.id, title: 'Independent voltage study' });
  await manager.setProjectExecution(project.id, executionEnabled);
  const csv = await readFile(new URL('../docs/measurements.csv', import.meta.url), 'utf8');
  const { fileReferences } = await manager.stageFiles(sessionId, [{ name: 'measurements.csv', mimeType: 'text/csv', data: Buffer.from(csv).toString('base64') }]);
  state.inputId = fileReferences[0]!.id;
  return { manager, launch, project, sessionId, fileReferences, csv, state, failures, hits };
}

test('real Pi research tools bind skills, CSV evidence, separate reviewer reproduction and durable verified Books', { timeout: 45_000 }, async t => {
  const f = await fixture(t); let manager = f.manager;
  await manager.pi(f.sessionId, { type: 'prompt', id: 'full-research', message: 'Run the complete measurement study and independently reproduce its evidence.', fileReferences: f.fileReferences });
  const snapshot = await terminal(manager); assert.deepEqual(f.failures, []);
  assert.equal(snapshot.run.status, 'succeeded');
  assert.equal(snapshot.processes.length, 2); assert.equal(snapshot.artifacts.length, 2);
  for (const calculation of snapshot.processes) {
    assert.equal(calculation.status, 'succeeded'); assert.equal(calculation.job.mcp?.server, 'athena-measurements');
    assert.equal(calculation.job.mcp?.tool, 'calculate_csv'); assert.equal(calculation.job.analysis, undefined);
    assert.equal(calculation.job.program, process.execPath);
    assert.ok(calculation.job.args.some(argument => argument.endsWith('mcp-worker.mjs')), 'Real Node MCP worker was spawned.');
  }
  const board = manager.getResearch(f.project.id, f.sessionId); const review = board.reviews[0]; const knowledge = board.books[0];
  assert.ok(review?.reviewer && knowledge);
  assert.equal(review.state, 'completed'); assert.equal(review.verdict, 'supported'); assert.equal(knowledge.level, 'verified');
  const author = snapshot.tasks.find(task => task.title === 'Measurement author')!;
  assert.notEqual(review.reviewer.agentSessionId, author.agentSessionId); assert.notEqual(review.reviewer.taskId, author.id);
  const reviewerAttempt = snapshot.attempts.find(attempt => attempt.id === review.reviewer!.attemptId)!;
  assert.deepEqual(reviewerAttempt.fileIds, [f.state.inputId]); assert.deepEqual(reviewerAttempt.artifactGrants, [f.state.authorArtifactId]);
  assert.ok(f.state.reviewerInputs.every(input => !input.includes('The original CSV mean is 19 mV.')), 'Author conclusion is not copied into the review prompt.');
  const versions = [{ id: f.state.inputId, version: sha256(f.csv) }];
  const downloaded = new Map<string, string>();
  for (const artifact of snapshot.artifacts) {
    assert.deepEqual(artifact.evidence, versions);
    const file = await manager.artifactDownload(f.sessionId, artifact.id); downloaded.set(artifact.id, sha256(file.bytes));
    assert.equal(sha256(file.bytes), artifact.file.sha256);
    assert.equal(JSON.parse(file.bytes.toString('utf8')).statistics[0].mean, 19);
  }
  const reproduction = board.evidence.find(evidence => review.reproductionEvidenceIds?.includes(evidence.id))!;
  assert.deepEqual(reproduction.targets.find(target => target.kind === 'artifact')?.inputVersions, versions);
  const extensions = manager.getExtensions(f.project.id);
  assert.ok(extensions.skillUses.some(use => use.skillId === 'athena-research-intake'));
  assert.ok(extensions.skillUses.some(use => use.skillId === 'athena-data-quality'));
  for (const use of extensions.skillUses) { assert.match(use.sha256, /^[a-f0-9]{64}$/); assert.ok(snapshot.attempts.some(attempt => attempt.id === use.attemptId)); }
  await manager.close(); manager = await f.launch();
  assert.deepEqual(manager.getResearch(f.project.id, f.sessionId), board);
  assert.deepEqual(manager.getExtensions(f.project.id).skillUses, extensions.skillUses);
  for (const [id, digest] of downloaded) assert.equal(sha256((await manager.artifactDownload(f.sessionId, id)).bytes), digest);
});

test('cancelled reviewer retries with a new pinned review ID while original CSV result and grants survive restart', { timeout: 45_000 }, async t => {
  const f = await fixture(t, { cancelFirstReview: true }); let manager = f.manager;
  await manager.pi(f.sessionId, { type: 'prompt', id: 'cancel-research-review', message: 'Calculate and request independent review.', fileReferences: f.fileReferences });
  const running = await when(manager, snapshot => snapshot.tasks.some(task => task.title === 'Independent evidence review' && task.status === 'running'));
  const reviewer = running.tasks.find(task => task.title === 'Independent evidence review')!; assert.ok(reviewer.attemptId);
  await manager.cancelTask(reviewer.id); const before = await terminal(manager); assert.deepEqual(f.failures, []);
  assert.equal(before.tasks.find(task => task.id === reviewer.id)?.status, 'cancelled');
  const boardBefore = manager.getResearch(f.project.id, f.sessionId); assert.equal(boardBefore.reviews.length, 1);
  assert.equal(boardBefore.reviews[0]?.state, 'cancelled'); assert.equal(boardBefore.books.length, 0);
  const artifact = before.artifacts[0]!; const digest = sha256((await manager.artifactDownload(f.sessionId, artifact.id)).bytes);
  await manager.close(); const callsBeforeRestart = f.hits.length; manager = await f.launch();
  assert.equal(f.hits.length, callsBeforeRestart, 'Restart does not run the paused or cancelled review automatically.');
  f.state.recovering = true;
  const retry = await manager.retryTask(reviewer.id, { requestId: 'manual-review-retry', expectedAttemptId: reviewer.attemptId });
  const after = await terminal(manager); assert.deepEqual(f.failures, []);
  assert.equal(after.tasks.find(task => task.id === reviewer.id)?.status, 'succeeded');
  const board = manager.getResearch(f.project.id, f.sessionId); assert.equal(board.reviews.length, 2);
  const original = board.reviews.find(review => review.id === boardBefore.reviews[0]!.id)!;
  const recovered = board.reviews.find(review => review.previousReviewId === original.id)!;
  assert.equal(original.state, 'cancelled'); assert.equal(original.verdict, undefined);
  assert.equal(recovered.state, 'completed'); assert.equal(recovered.verdict, 'supported');
  assert.equal(recovered.reviewer?.attemptId, retry.attemptId); assert.notEqual(recovered.id, original.id);
  assert.deepEqual(recovered.targets, original.targets);
  const attempts = after.attempts.filter(attempt => attempt.taskId === reviewer.id);
  assert.deepEqual(attempts.map(attempt => attempt.status), ['cancelled', 'succeeded']);
  assert.deepEqual(attempts[1]!.fileIds, attempts[0]!.fileIds); assert.deepEqual(attempts[1]!.artifactGrants, attempts[0]!.artifactGrants);
  assert.equal(sha256((await manager.artifactDownload(f.sessionId, artifact.id)).bytes), digest);
  assert.equal(after.artifacts.find(item => item.id === artifact.id)?.version, artifact.version);
  assert.equal(board.books.length, 0, 'Read-only parent reconciliation cannot silently promote new knowledge.');
  assert.ok(after.attempts.some(attempt => attempt.kind === 'reconciliation' && attempt.result?.includes('retried independent reviewer completed')));
  assert.equal(after.processes.length, 2); assert.ok(after.processes.every(process => process.job.mcp?.tool === 'calculate_csv' && process.job.analysis === undefined));
});

test('execution disabled preserves CSV evidence and observations after joining, without granting review or artifact transfer', { timeout: 45_000 }, async t => {
  // Controlled replies exercise the real SDK and host boundaries, not real-model instruction following.
  const f = await fixture(t, { executionEnabled: false }); let manager = f.manager;
  await manager.pi(f.sessionId, { type: 'prompt', id: 'research-observation', message: 'Calculate the measurements and save the evidence and an observation. Keep offline execution disabled.', fileReferences: f.fileReferences });
  const snapshot = await terminal(manager); assert.deepEqual(f.failures, []);
  assert.equal(snapshot.run.status, 'succeeded'); assert.equal(snapshot.execution.enabled, false);
  assert.equal(snapshot.processes.length, 1, 'Completed child calculation is not repeated.');
  assert.equal(snapshot.processes[0]?.status, 'succeeded');
  assert.equal(snapshot.processes[0]?.job.mcp?.tool, 'calculate_csv');
  assert.equal(snapshot.processes[0]?.job.analysis, undefined);
  assert.equal(snapshot.artifacts.length, 1);
  assert.equal(snapshot.tasks.some(task => task.title === 'Forbidden reviewer'), false);
  const board = manager.getResearch(f.project.id, f.sessionId);
  assert.equal(board.missions.length, 1); assert.equal(board.evidence.length, 1);
  assert.equal(board.reviews.length, 0); assert.equal(board.books.length, 1);
  assert.equal(board.books[0]?.level, 'observation'); assert.deepEqual(board.books[0]?.reviewIds, []);
  assert.equal(board.memories.project.length, 1); assert.equal(f.state.reviewerInputs.length, 0);
  const artifact = snapshot.artifacts[0]!;
  const bytes = (await manager.artifactDownload(f.sessionId, artifact.id)).bytes;
  assert.equal(JSON.parse(bytes.toString('utf8')).statistics[0].mean, 19);
  assert.equal(sha256(bytes), artifact.file.sha256);
  assert.equal(board.evidence[0]?.targets.find(target => target.kind === 'artifact')?.sha256, sha256(bytes));
  assert.equal(board.evidence[0]?.targets.find(target => target.kind === 'file')?.sha256, sha256(f.csv));
  for (const wire of f.hits) {
    const tools = wire.tools.map(tool => tool.function.name);
    for (const unavailable of ['request_review', 'read_file', 'write_file', 'run_command']) assert.equal(tools.includes(unavailable), false);
  }
  const instructions = f.hits.find(parent)!.messages.filter(message => message.role === 'system').map(message => text(message.content)).join('\n');
  assert.doesNotMatch(instructions, /do not call more tools/);
  assert.match(instructions, /Independent evidence review is unavailable/);
  await manager.close(); manager = await f.launch();
  assert.equal(manager.getSnapshot().execution.enabled, false);
  assert.deepEqual(manager.getResearch(f.project.id, f.sessionId), board);
  assert.equal(sha256((await manager.artifactDownload(f.sessionId, artifact.id)).bytes), sha256(bytes));
});

test('paper outlining, editorial revision, independent frozen reviews and exact exports survive restart', {timeout:90000}, async t=>{
  const directory=await realpath(privateTestDirectory(join(tmpdir(),'paper-integration-')));
  const sourceText='The reported voltage is 19 mV.',title='Voltage study';
  let authorized='',sourceId='',round=0,sectionPlanCalls=0;const errors:string[]=[];
  let held:ReturnType<typeof Promise.withResolvers<void>>|undefined, holdStage='';
  let previous:{version:string;text:string;assessment:ResearchReview}|undefined;
  const remainingFinding='Add the measurement uncertainty or explicitly state it was never reported.';
  const revisedText='# Results\n\n'+sourceText+'\nRevision 2\n\n## Measurement limits\nMeasurement uncertainty was not reported.';
  const server=createServer(async(request,response)=>{
    try {
      const chunks:Buffer[]=[];for await(const c of request)chunks.push(Buffer.from(c));
      const w:Wire=JSON.parse(Buffer.concat(chunks).toString()),prompt=text(users(w).at(-1)?.content),out=outputs(w);
      if(held&&!parent(w)&&prompt.includes(holdStage)){
        held.resolve();await new Promise<void>(resolve=>response.once('close',resolve));return;
      }
      let next:string|Call;
      if(parent(w)&&prompt.startsWith('Execute my approved bibliography search'))next=out.length?'Candidates ready.':{name:'run_bibliography_search',args:{searchId:authorized}};
      else if(parent(w))next=out.length?'Manuscript stage settled.':{name:'compose_manuscript',args:prompt.includes('Manuscript outline request')?{outline:['Results']}:{}};
      else if(prompt.includes('Plan the literature synthesis'))next=JSON.stringify([{heading:'Results',purpose:'Compare the reported voltage.',sources:[++sectionPlanCalls===1?2:1],visual:''}]);
      else if(prompt.includes('Return only a JSON array'))next=['```json',JSON.stringify([{heading:'Results',text:sourceText}]),'```'].join('\n');
      else if(prompt.includes('Use publish_manuscript')) {
        const revision=prompt.includes('Revise the prior edition directly.');
        const contextGrants=revision?(JSON.parse(prompt.split('Granted input files: ')[1]!) as {name:string;fileId:string}[]).filter(f=>f.name.startsWith('prior-')):[];
        if(out.length<contextGrants.length)next={name:'read_file',args:{fileId:contextGrants[out.length]!.fileId}};
        else if(out.length===contextGrants.length){
          round++;
          if(revision){
            assert.ok(previous);assert.match(prompt,new RegExp(previous.version));assert.match(prompt,/Compare the reported voltage/);
            assert.equal(out[0],previous.text);
            const recorded=JSON.parse(out[1]!);
            assert.equal(recorded.reviewId,previous.assessment.id);assert.deepEqual(recorded.findings,[remainingFinding]);
            assert.deepEqual(recorded.checks,previous.assessment.checks);assert.equal(recorded.sha256,sha256(previous.text));
          }
          next={name:'publish_manuscript',args:{text:revision?revisedText:'# Results\n\n'+sourceText+'\nRevision '+round,
            links:[{kind:'claim',sourceId,quote:sourceText,excerpt:sourceText,locator:'line 1'}]}};
        }
        else {assert.ok(JSON.parse(out.at(-1)!).artifact);next='Published the manuscript.';}
      } else {
        const info=JSON.parse(prompt.split('Review assignment: ')[1]!.split('\nGranted input files:')[0]!) as Assignment;
        const inputs=[...info.targets,...(info.contextFiles??[])],target=inputs[out.length];
        if(target)next={name:'read_file',args:target.kind==='file'?{fileId:target.id}:{artifactId:target.id}};
        else if(out.length===inputs.length){
          assert.match(info.question,/User-provided research brief.*Report the measured voltage/);
          if(round===3){
            assert.ok(previous);assert.match(info.question,new RegExp(previous.assessment.id));
            assert.equal(info.contextFiles?.length,2);assert.equal(out.at(-2),previous.text);
            assert.deepEqual(JSON.parse(out.at(-1)!).findings,[remainingFinding]);
            assert.ok(!info.contextFiles.some(f=>info.targets.some(e=>e.id===f.id)));
          }
          next={name:'submit_review',args:{reviewId:info.reviewId,verdict:round<=2?'changes_required':'supported',
            checks:['Claims: inspected underlying voltage.','Citations: compared exact source passage.','Figures: no figures claimed.'],
            findings:round===1?['Clarify units in the edited version.']:round===2?[remainingFinding]:[]}};
        }
        else next='Review recorded.';
      }
      complete(response,next);
    }catch(e){errors.push(String(e));response.writeHead(400);response.end('Controlled provider failed');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const env={ATHENA_ENDPOINT:'http://127.0.0.1:'+address.port+'/v1',ATHENA_MODEL:'paper-fixture',ATHENA_MODEL_CONCURRENCY:'1',ATHENA_MAX_CHILDREN:'4'};
  const restore=Object.entries(env).map(([k,v])=>{const old=process.env[k];process.env[k]=v;return ()=>{if(old===undefined)delete process.env[k];else process.env[k]=old;};});
  const doi='10.9999/voltage-fixture';
  const provider=new CrossrefProvider(async url=>{
    assert.equal(String(url),'https://api.crossref.org/works/'+encodeURIComponent(doi));
    return Response.json({status:'ok',message:{DOI:doi,title:['Voltage observations'],abstract:sourceText}});
  });
  let manager=new TaskManager({dataDir:directory,bibliographyProvider:provider});
  t.after(async()=>{await manager.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));restore.forEach(fn=>fn());await rm(directory,{recursive:true,force:true});});
  await manager.initialize();const {project}=await manager.createProject({name:title});const {sessionId}=await manager.createSession({projectId:project.id,title});
  await manager.setProjectExecution(project.id,true);
  const call=(method:string,args:Record<string,unknown>={})=>manager.paperRequest(method,{projectId:project.id,...args}) as Promise<any>;
  authorized=(await call('authorizeSearch',{sessionId,mode:'doi',term:doi,requestId:'explicit-doi'})).id;
  await manager.pi(sessionId,{type:'prompt',id:'search-bibliography',message:'Execute my approved bibliography search '+authorized});
  const discovery=await terminal(manager);
  const [search]=await call('bibliographyHistory',{sessionId});
  assert.equal(search.status,'succeeded');assert.equal(search.execution.runId,discovery.run.id);
  assert.ok(discovery.tools.some(t=>t.name==='run_bibliography_search'&&t.id===search.execution.toolId));
  const source=await call('addSearchSource',{sessionId,searchId:authorized,doi});sourceId=source.sourceId;
  const paper=await call('createPaper',{title,goal:'Report the measured voltage.',evidence:[source]});const documentId=paper.id;
  for(const mode of ['outline','write']){
    const req={documentId,mode,sessionId,requestId:'paper-'+mode};
    const receipt=await call('startPaper',req);const snap=await terminal(manager);
    assert.equal((await call('startPaper',req)).runId,receipt.runId);
    assert.deepEqual(errors,[]);assert.equal(snap.run.status,'succeeded');
    const d=await call('paperDetails',{documentId});assert.deepEqual(d.outline,['Results'],JSON.stringify(snap.tools));
    if(mode==='write'){assert.equal(d.runs.at(-1).stage,'changes_required',JSON.stringify([d.runs.at(-1),snap.tools.map(t=>[t.name,t.status,t.logs.at(-1)?.text.slice(0,300)])]));
      assert.deepEqual(d.runs.at(-1).sectionBriefs[0].sources,[{sourceId,version:source.version}]);
      const plans=d.runs.at(-1).attempts.filter((attempt:{role:string})=>attempt.role==='Plan manuscript evidence');
      assert.equal(plans.length,2);assert.equal(plans[0].taskId,plans[1].taskId);assert.notEqual(plans[0].attemptId,plans[1].attemptId);
      assert.equal(snap.tasks.filter(t=>t.parentTaskId).length,4);assert.equal(snap.processes.length,2);}
  }
  const exhausted=(await call('paperDetails',{documentId})).runs.at(-1);
  assert.equal(exhausted.reviews.length,2);
  assert.notEqual(exhausted.reviews[0].reviewer.agentSessionId,exhausted.reviews[1].reviewer.agentSessionId);
  previous=await call('getDocument',{documentId});assert.ok(previous);
  assert.deepEqual(previous.assessment.findings,[remainingFinding]);
  await manager.close();manager=new TaskManager({dataDir:directory});await manager.initialize();
  const revisionRequest={documentId,sessionId,mode:'write',requestId:'write-after-exhausted-review',expectedBaseVersion:previous.version};
  const receipt=await call('startPaper',revisionRequest);
  await terminal(manager);assert.deepEqual(errors,[]);
  const d=await call('paperDetails',{documentId}),revised=d.runs.at(-1);
  assert.equal(revised.baseVersion,previous.version);assert.equal(revised.stage,'supported');
  assert.deepEqual(revised.attempts.map((a:{role:string})=>a.role),['Edit manuscript','Review manuscript 1']);
  assert.equal(revised.versions.length,1);assert.equal(revised.uploads.length,1);
  assert.deepEqual(revised.sectionBriefs,exhausted.sectionBriefs);
  const ledger=new Storage(directory);
  try {
    const papers=new Papers(ledger);
    const legacy={...revised,sectionBriefs:undefined};
    const planFor=(run:typeof legacy)=>papers.sectionPlan({...d,runs:d.runs.with(-1,run)},run);
    assert.deepEqual(planFor(legacy),exhausted.sectionBriefs);
    assert.equal(planFor({...legacy,revisionReviewId:exhausted.reviews[0].id}),undefined,'An assessment of an earlier edition cannot supply this plan.');
    assert.equal(planFor({...legacy,context:{...legacy.context,sessionId:'another-conversation'}}),undefined);
  } finally {ledger.close();}
  assert.notEqual(revised.reviews[0].reviewer.agentSessionId,previous.assessment.reviewer?.agentSessionId);
  const first=await call('getDocument',{documentId,version:d.versions[0]}),second=await call('getDocument',{documentId});
  assert.equal((await call('startPaper',revisionRequest)).runId,receipt.runId);
  await assert.rejects(call('startPaper',{...revisionRequest,expectedBaseVersion:first.version}),{code:'REQUEST_ID_CONFLICT'});
  await assert.rejects(call('startPaper',{...revisionRequest,requestId:'stale-review'}),{code:'VERSION_CONFLICT'});
  assert.equal((await call('paperDetails',{documentId})).runs.length,d.runs.length);
  assert.deepEqual(second.sectionChecks,[{heading:'Results',linkedPassages:1},{heading:'Measurement limits',linkedPassages:0}]);
  assert.equal(second.text,revisedText);assert.equal(second.baseVersion,previous.version);
  assert.equal(first.review.status,'changes_requested');assert.equal(second.review.status,'approved');
  assert.deepEqual((await call('getDocument',{documentId,version:previous.version})).assessment,previous.assessment);
  const md=await call('exportPaper',{documentId,version:first.version,format:'md'});
  const manifest=await call('exportPaper',{documentId,version:first.version,format:'json'});
  const saved=await manager.artifactDownload(sessionId,md.id);assert.equal(saved.bytes.toString(),first.text);
  assert.equal(sha256(saved.bytes),first.artifact.sha256);
  assert.deepEqual(saved.bytes,(await manager.artifactDownload(sessionId,first.artifact.id)).bytes);
  const edit={...second,text:'Updated manually.',expectedCurrentVersion:second.version};
  const writes=await Promise.allSettled([call('saveDocument',edit),call('saveDocument',edit)]);
  assert.equal(writes.filter(x=>x.status==='fulfilled').length,1);assert.equal((await call('getDocument',{documentId})).review.status,'unreviewed');
  await manager.close();manager=new TaskManager({dataDir:directory});await manager.initialize();
  assert.deepEqual((await call('paperDetails',{documentId})).runs,d.runs);
  assert.deepEqual((await manager.artifactDownload(sessionId,md.id)).bytes,saved.bytes);
  const exported=JSON.parse((await manager.artifactDownload(sessionId,manifest.id)).bytes.toString());
  assert.equal(exported.assessment.verdict,'changes_required');
  assert.equal(exported.evidence[0].origin.providerId,doi);assert.equal(exported.evidence[0].level,'abstract');
  assert.equal(exported.evidence[0].origin.rawSha256,sha256(JSON.stringify(exported.evidence[0].origin.raw)));
  for(const stage of ['Return only a JSON array','Review assignment: ']){
    holdStage=stage;held=Promise.withResolvers<void>();
    const receipt=await call('startPaper',{documentId,sessionId,requestId:'cancel-'+stage,mode:'write'});
    await held.promise;await manager.cancelRun(receipt.runId);await terminal(manager);held=undefined;
    const last=(await call('paperDetails',{documentId})).runs.at(-1);
    assert.equal(last.executionStatus,'cancelled');assert.equal(last.reviews.length,0);
    assert.equal(last.sections.length,stage.startsWith('Review')?1:0);
    if(stage.startsWith('Review'))assert.equal(last.versions.length,1);
  }
});
