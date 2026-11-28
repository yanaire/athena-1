import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { privateTestDirectory } from './platform-test-helpers.ts';
import { hash } from '../runtime/orchestration.ts';
import type { Attempt, Context } from '../runtime/orchestration.ts';
import { ResearchLedger } from '../runtime/research.ts';
import type { ResearchResolver, ResearchTarget } from '../runtime/research.ts';
import { Storage } from '../runtime/storage.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const directory = privateTestDirectory(join(tmpdir(), 'athena-research-'));
  let storage = new Storage(directory);
  storage.putProject({ id: 'project', name: 'Research' });
  storage.putProject({ id: 'other-project', name: 'Other research' });
  storage.putSession({ id: 'conversation', projectId: 'project', title: 'Study', sessionDir: directory, sessionFile: join(directory, 'main.jsonl') });
  storage.putSession({ id: 'other-conversation', projectId: 'other-project', title: 'Other', sessionDir: directory, sessionFile: join(directory, 'other.jsonl') });
  const parent: Context = { projectId: 'project', sessionId: 'conversation', runId: 'run', taskId: 'root', parentTaskId: null, agentSessionId: 'conversation', attemptId: 'root-attempt' };
  const author: Context = { ...parent, taskId: 'author', parentTaskId: 'root', agentSessionId: 'author-session', attemptId: 'author-attempt' };
  const reviewer: Context = { ...parent, taskId: 'reviewer', parentTaskId: 'root', agentSessionId: 'reviewer-session', attemptId: 'reviewer-attempt' };
  const saveAttempt = (ctx: Context, status: Attempt['status'] = 'running') => storage.putRecord('attempt', {
    ...ctx, id: ctx.attemptId, requestId: ctx.attemptId, prompt: 'Public task', status,
    acceptedAt: 1, startedAt: 2, endedAt: null, fileIds: ['input'],
    ...(ctx.taskId === reviewer.taskId ? { artifactGrants: ['result'] } : {}),
  } satisfies Attempt);
  [parent, author, reviewer].forEach(ctx => saveAttempt(ctx));
  const target = (kind: 'file' | 'artifact', id: string, producer = author): ResearchTarget => ({ kind, id,
    projectId: 'project', sessionId: 'conversation', version: 'version-' + id, sha256: hash(id + '-bytes'), bytes: id.length + 6,
    ...(kind === 'artifact' ? { taskId: producer.taskId, attemptId: producer.attemptId, agentSessionId: producer.agentSessionId, processId: 'process-' + id,
      inputVersions: [{ id: 'input', version: 'version-input' }] } : {}) });
  const targets = new Map<string, ResearchTarget>([['input', target('file', 'input')], ['result', target('artifact', 'result')], ['reproduction', target('artifact', 'reproduction', reviewer)]]);
  const resolve: ResearchResolver = async (_ctx, wanted) => {
    const row = targets.get(wanted.id);
    if (!row) throw new Error('Unavailable target');
    return structuredClone(row);
  };
  let ledger = new ResearchLedger(storage);
  const mission = ledger.plan(parent, { objective: 'Characterize measurement input', acceptanceCriteria: ['Use actual input bytes', 'Report missing values'] });
  const evidence = () => ledger.addEvidence(parent, { missionId: mission.id, title: 'Measurement result', fileIds: ['input'], artifactIds: ['result'] }, resolve);
  const review = async () => {
    const record = await evidence();
    const pending = await ledger.prepareReview(parent, { missionId: mission.id, question: 'Check the original input and published result', evidenceIds: [record.id] }, resolve);
    ledger.registerReviewer(parent, pending.id, reviewer);
    return { evidence: record, review: pending };
  };
  const knowledge = (evidenceId: string, reviewIds: string[] = []) => ledger.proposeKnowledge(parent, {
    missionId: mission.id, title: 'Measurement procedure', method: 'Read the original CSV and calculate with the registered tool.',
    rationale: 'Preserve missing and zero observations.', applicability: ['Measurement CSV with stated units'], evidenceIds: [evidenceId], reviewIds,
  });
  const snapshot = () => ledger.snapshot({ projectId: 'project', sessionId: 'conversation' });
  const restart = () => { storage.close(); storage = new Storage(directory); ledger = new ResearchLedger(storage); return ledger; };
  t.after(() => { storage.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get ledger() { return ledger; }, get storage() { return storage; }, parent, author, reviewer, targets, resolve, mission, evidence, review, knowledge, snapshot, target, saveAttempt, restart };
}

test('research plans are scoped persisted records, with planned stages and no invented completion', t => {
  const f = setup(t);
  assert.equal(f.snapshot().missions[0]?.phase, 'planned');
  assert.equal(f.snapshot().missions[0]?.evidenceCount, 0);
  assert.equal(f.snapshot().missions[0]?.stages.length, 4);
  assert.throws(() => f.ledger.plan(f.author, { objective: 'Child plan', acceptanceCriteria: ['Pass'] }), /coordinator/);
  assert.throws(() => f.ledger.plan({ ...f.parent, projectId: 'other-project' }, { objective: 'Foreign plan', acceptanceCriteria: ['Pass'] }), /scoped attempt/);
  assert.throws(() => f.ledger.plan(f.parent, { objective: 'Fake complete', acceptanceCriteria: ['Pass'], status: 'verified' }), /Unknown research/);
  assert.deepEqual(f.restart().snapshot({ projectId: 'project' }).missions[0]?.objective, f.mission.objective);
});

test('evidence takes scoped host-resolved bytes and exact producer identities, never model digests', async t => {
  const f = setup(t); const e = await f.evidence();
  assert.equal(e.targets[0]?.sha256, hash('input-bytes'));
  assert.equal(e.targets[1]?.attemptId, f.author.attemptId);
  assert.equal(f.snapshot().missions[0]?.phase, 'evidence_recorded');
  await assert.rejects(f.ledger.addEvidence(f.parent, { missionId: f.mission.id, title: 'Fake', artifactIds: ['result'], sha256: hash('fake') }, f.resolve), /Unknown research/);
  for (const mutation of [{ projectId: 'other-project' }, { sessionId: 'other-conversation' }, { sha256: 'abc' }, { bytes: -1 }, { version: '' }, { attemptId: 'absent' }, { processId: '' }]) {
    await assert.rejects(f.ledger.addEvidence(f.parent, { missionId: f.mission.id, title: 'Wrong host target', artifactIds: ['result'] }, async () => ({ ...f.targets.get('result')!, ...mutation })), /verify|bounded|producer|scoped/i);
  }
  assert.equal(f.snapshot().evidence.length, 1);
});

test('evidence and plans preserve request idempotency across restarts and reject conflicting requests', async t => {
  const f = setup(t);
  const args = { missionId: f.mission.id, title: 'Request', fileIds: ['input'], requestId: 'same-request' };
  const a = await f.ledger.addEvidence(f.parent, args, f.resolve);
  f.restart();
  const b = await f.ledger.addEvidence(f.parent, args, f.resolve);
  assert.equal(a.id, b.id);
  await assert.rejects(f.ledger.addEvidence(f.parent, { ...args, title: 'Different request' }, f.resolve), /different arguments/);
  assert.equal(f.snapshot().evidence.length, 1);
});

test('asynchronous evidence verification does not overwrite concurrent agent records', async t => {
  const f = setup(t);
  await Promise.all([
    f.ledger.addEvidence(f.parent, { missionId: f.mission.id, title: 'Input record', fileIds: ['input'] }, f.resolve),
    f.ledger.addEvidence(f.author, { missionId: f.mission.id, title: 'Result record', artifactIds: ['result'] }, f.resolve),
  ]);
  assert.deepEqual(f.snapshot().evidence.map(row => row.title).sort(), ['Input record', 'Result record']);
});

test('review preparation rejects unavailable, conflicting or changed evidence instead of reviewing a stale file', async t => {
  const f = setup(t); const e = await f.evidence();
  f.targets.set('result', { ...f.targets.get('result')!, sha256: hash('changed') });
  await assert.rejects(f.ledger.prepareReview(f.parent, { missionId: f.mission.id, evidenceIds: [e.id], question: 'Review' }, f.resolve), /changed/);
  const newer = await f.evidence();
  await assert.rejects(f.ledger.prepareReview(f.parent, { missionId: f.mission.id, evidenceIds: [e.id, newer.id], question: 'Review both' }, f.resolve), /conflicting versions/);
  assert.equal(f.snapshot().reviews.length, 0);
});

test('review registration requires an actual separate direct child and cannot be rebound to another attempt', async t => {
  const f = setup(t); const e = await f.evidence();
  const r = await f.ledger.prepareReview(f.parent, { missionId: f.mission.id, evidenceIds: [e.id], question: 'Review' }, f.resolve);
  assert.throws(() => f.ledger.registerReviewer(f.parent, r.id, f.author), /producing agent/);
  assert.throws(() => f.ledger.registerReviewer(f.parent, r.id, f.parent), /separate direct child/);
  assert.throws(() => f.ledger.registerReviewer(f.parent, r.id, { ...f.reviewer, attemptId: 'not-real' }), /actual scoped/);
  const attempt = f.storage.record<Attempt>('attempt', f.reviewer.attemptId)!;
  f.storage.putRecord('attempt', { ...attempt, fileIds: ['input', 'hidden-evaluation-key'] });
  assert.throws(() => f.ledger.registerReviewer(f.parent, r.id, f.reviewer), /exactly the frozen review package/);
  f.saveAttempt(f.reviewer);
  f.ledger.registerReviewer(f.parent, r.id, f.reviewer);
  const replacement = { ...f.reviewer, attemptId: 'next-review-attempt' }; f.saveAttempt(replacement);
  assert.throws(() => f.ledger.registerReviewer(f.parent, r.id, replacement), /already fixed/);
});

test('only the actual registered running reviewer can issue a structured immutable review receipt', async t => {
  const f = setup(t); const { review } = await f.review();
  const args = { reviewId: review.id, verdict: 'changes_required', checks: ['Compared row count and the saved result'], findings: ['Units need clarification'] };
  await assert.rejects(f.ledger.submitReview(f.parent, args, f.resolve), /registered reviewer/);
  await assert.rejects(f.ledger.submitReview(f.author, args, f.resolve), /registered reviewer/);
  const receipt = await f.ledger.submitReview(f.reviewer, args, f.resolve);
  assert.equal(receipt.state, 'completed'); assert.equal(receipt.verdict, 'changes_required');
  assert.equal((await f.ledger.submitReview(f.reviewer, args, f.resolve)).id, receipt.id);
  await assert.rejects(f.ledger.submitReview(f.reviewer, { ...args, verdict: 'supported' }, f.resolve), /immutable/);
  assert.equal(f.snapshot().missions[0]?.phase, 'reviewed');
});

test('changed bytes and cancellation during review verification prevent a receipt', async t => {
  const f = setup(t); const { review } = await f.review();
  const args = { reviewId: review.id, verdict: 'supported', checks: ['Read inputs'], findings: [] };
  f.targets.set('input', { ...f.targets.get('input')!, version: 'changed-input-version' });
  await assert.rejects(f.ledger.submitReview(f.reviewer, args, f.resolve), /changed/);
  f.targets.set('input', f.target('file', 'input'));
  const cancellingResolver: ResearchResolver = async (ctx, target) => { const result = await f.resolve(ctx, target); f.saveAttempt(f.reviewer, 'cancelled'); return result; };
  await assert.rejects(f.ledger.submitReview(f.reviewer, args, cancellingResolver), /stopped before submission/);
  assert.equal(f.snapshot().reviews[0]?.state, 'cancelled');
  assert.equal(f.snapshot().reviews[0]?.verdict, undefined);
  assert.equal(f.snapshot().missions[0]?.phase, 'review_interrupted');
});

test('supported review without actual independent reproduction remains an observation', async t => {
  const f = setup(t); const { evidence, review } = await f.review();
  await f.ledger.submitReview(f.reviewer, { reviewId: review.id, verdict: 'supported', checks: ['Read result'], findings: [] }, f.resolve);
  f.saveAttempt(f.reviewer, 'succeeded');
  const book = f.knowledge(evidence.id, [review.id]);
  assert.equal(book.level, 'observation');
  assert.throws(() => f.ledger.decideKnowledge('project', book.id, { decision: 'convention', reason: 'Looks right' }), /independently verified/);
});

test('reproduction cannot use the producing agent artifact or another agent evidence record', async t => {
  const f = setup(t); const { review } = await f.review();
  const copied = await f.ledger.addEvidence(f.reviewer, { missionId: f.mission.id, title: 'Copied original artifact', fileIds: ['input'], artifactIds: ['result'] }, f.resolve);
  await assert.rejects(f.ledger.submitReview(f.reviewer, { reviewId: review.id, verdict: 'supported', checks: ['Reproduced'], findings: [], reproductionEvidenceIds: [copied.id] }, f.resolve), /actual artifact produced by this reviewer/);
  const other = await f.ledger.addEvidence(f.parent, { missionId: f.mission.id, title: 'Someone else recorded it', fileIds: ['input'], artifactIds: ['reproduction'] }, f.resolve);
  await assert.rejects(f.ledger.submitReview(f.reviewer, { reviewId: review.id, verdict: 'supported', checks: ['Reproduced'], findings: [], reproductionEvidenceIds: [other.id] }, f.resolve), /actual artifact produced by this reviewer/);
});

test('verified Books require completed independent reproduction on exact inputs; human convention and revocation preserve history', async t => {
  const f = setup(t); const { evidence, review } = await f.review();
  const reproduced = await f.ledger.addEvidence(f.reviewer, { missionId: f.mission.id, title: 'Independent calculation', fileIds: ['input'], artifactIds: ['reproduction'] }, f.resolve);
  await f.ledger.submitReview(f.reviewer, { reviewId: review.id, verdict: 'supported', checks: ['Recomputed from the granted original file and compared the published values'], findings: [], reproductionEvidenceIds: [reproduced.id] }, f.resolve);
  assert.equal(f.knowledge(evidence.id, [review.id]).level, 'observation', 'Running reviewer is not a successful reproduction.');
  f.saveAttempt(f.reviewer, 'succeeded');
  const verified = f.knowledge(evidence.id, [review.id]); assert.equal(verified.level, 'verified');
  const convention = f.ledger.decideKnowledge('project', verified.id, { decision: 'convention', reason: 'Confirmed this method for this input type.' });
  assert.equal(convention.level, 'convention'); assert.equal(convention.history.at(-1)?.actor, 'human');
  const revoked = f.ledger.decideKnowledge('project', verified.id, { decision: 'revoke', reason: 'New instrument invalidates the recorded applicability.' });
  assert.equal(revoked.state, 'revoked'); assert.equal(revoked.history.length, 3);
  assert.throws(() => f.ledger.decideKnowledge('project', verified.id, { decision: 'convention', reason: 'Restore' }), /immutable/);
  assert.equal(f.restart().snapshot({ projectId: 'project' }).books.find(row => row.id === verified.id)?.state, 'revoked');
});

test('a reproduction with absent or different input versions cannot confer verified status', async t => {
  const f = setup(t); const { evidence, review } = await f.review();
  const reproduced = await f.ledger.addEvidence(f.reviewer, { missionId: f.mission.id, title: 'Unbound output', artifactIds: ['reproduction'] }, f.resolve);
  await f.ledger.submitReview(f.reviewer, { reviewId: review.id, verdict: 'supported', checks: ['Observed output'], findings: [], reproductionEvidenceIds: [reproduced.id] }, f.resolve);
  f.saveAttempt(f.reviewer, 'succeeded');
  assert.equal(f.knowledge(evidence.id, [review.id]).level, 'observation');
});

test('an unrelated reproduction artifact cannot gain verification by citing the original input alongside it', async t => {
  const f = setup(t); const { evidence, review } = await f.review();
  f.targets.set('reproduction', { ...f.targets.get('reproduction')!, inputVersions: [{ id: 'other-input', version: 'other-version' }] });
  const reproduced = await f.ledger.addEvidence(f.reviewer, { missionId: f.mission.id, title: 'Unrelated computation', fileIds: ['input'], artifactIds: ['reproduction'] }, f.resolve);
  await f.ledger.submitReview(f.reviewer, { reviewId: review.id, verdict: 'supported', checks: ['Observed output'], findings: [], reproductionEvidenceIds: [reproduced.id] }, f.resolve);
  f.saveAttempt(f.reviewer, 'succeeded');
  assert.equal(f.knowledge(evidence.id, [review.id]).level, 'observation');
});

test('knowledge validation checks reproduction bytes again after a successful review', async t => {
  const f = setup(t); const { evidence, review } = await f.review();
  const reproduced = await f.ledger.addEvidence(f.reviewer, { missionId: f.mission.id, title: 'Reproduction', fileIds: ['input'], artifactIds: ['reproduction'] }, f.resolve);
  await f.ledger.submitReview(f.reviewer, { reviewId: review.id, verdict: 'supported', checks: ['Computed from the same input'], findings: [], reproductionEvidenceIds: [reproduced.id] }, f.resolve);
  f.saveAttempt(f.reviewer, 'succeeded');
  const args = { missionId: f.mission.id, evidenceIds: [evidence.id], reviewIds: [review.id] };
  await f.ledger.verifyKnowledgeEvidence(f.parent, args, f.resolve);
  f.targets.set('reproduction', { ...f.targets.get('reproduction')!, sha256: hash('corrupt-output') });
  await assert.rejects(f.ledger.verifyKnowledgeEvidence(f.parent, args, f.resolve), /changed/);
  assert.equal(f.snapshot().books.length, 0);
});

test('stopped and reconciliation attempts cannot create new research records', async t => {
  const f = setup(t); f.saveAttempt(f.parent, 'cancelled');
  assert.throws(() => f.ledger.remember(f.parent, { scope: 'project', text: 'Cancelled note' }), /executing non-reconciliation/);
  await assert.rejects(f.ledger.addEvidence(f.parent, { missionId: f.mission.id, title: 'Cancelled evidence', fileIds: ['input'] }, f.resolve), /executing non-reconciliation/);
  f.saveAttempt(f.parent);
  const attempt = f.storage.record<Attempt>('attempt', f.parent.attemptId)!;
  f.storage.putRecord('attempt', { ...attempt, kind: 'reconciliation' });
  assert.throws(() => f.ledger.plan(f.parent, { objective: 'Reconcile only', acceptanceCriteria: ['No new jobs'] }), /executing non-reconciliation/);
});

test('manual retry creates a new exact reviewer binding and preserves the cancelled review receipt', async t => {
  const f = setup(t); const { review } = await f.review();
  f.saveAttempt(f.reviewer, 'cancelled');
  const next = { ...f.reviewer, attemptId: 'review-retry' }; f.saveAttempt(next, 'queued');
  const retried = f.ledger.retryReviewer(f.reviewer, next)!;
  assert.notEqual(retried.id, review.id); assert.equal(retried.previousReviewId, review.id);
  assert.equal(retried.reviewer?.attemptId, next.attemptId); assert.equal(retried.verdict, undefined);
  assert.equal(f.ledger.retryReviewer(f.reviewer, next)?.id, retried.id);
  assert.equal(f.snapshot().reviews.find(row => row.id === review.id)?.state, 'cancelled');
  assert.equal(f.snapshot().reviews.find(row => row.id === retried.id)?.state, 'pending');
  f.saveAttempt(next, 'running');
  await assert.rejects(f.ledger.submitReview(next, { reviewId: review.id, verdict: 'supported', checks: ['Read'], findings: [] }, f.resolve), /registered reviewer/);
  assert.equal((await f.ledger.submitReview(next, { reviewId: retried.id, verdict: 'insufficient_evidence', checks: ['Read available input'], findings: ['Missing units'] }, f.resolve)).verdict, 'insufficient_evidence');
});

test('knowledge supersession preserves original evidence and does not cross project boundaries', async t => {
  const f = setup(t); const evidence = await f.evidence(); const first = f.knowledge(evidence.id); const second = f.knowledge(evidence.id);
  assert.throws(() => f.ledger.decideKnowledge('project', first.id, { decision: 'supersede', reason: 'Use new method', replacementId: 'absent' }), /different active entry/);
  assert.throws(() => f.ledger.decideKnowledge('other-project', first.id, { decision: 'revoke', reason: 'Other project' }), /outside this project/);
  const changed = f.ledger.decideKnowledge('project', first.id, { decision: 'supersede', reason: 'Updated procedure', replacementId: second.id });
  assert.equal(changed.state, 'superseded'); assert.deepEqual(changed.evidenceIds, first.evidenceIds);
  assert.equal(changed.history.at(-1)?.replacementId, second.id);
});

test('project memory, agent-private operational memory and Books remain separate and scoped after restart', t => {
  const f = setup(t);
  f.ledger.remember(f.author, { scope: 'agent', text: 'Next: inspect the missing rows.' });
  f.ledger.remember(f.reviewer, { scope: 'agent', text: 'Review checklist not yet completed.' });
  f.ledger.remember(f.parent, { scope: 'project', text: 'The user requested millivolt units.' });
  f.restart();
  const authorView = f.ledger.snapshot({ projectId: 'project', sessionId: 'conversation', agentSessionId: f.author.agentSessionId });
  assert.equal(authorView.memories.agents.length, 1); assert.match(authorView.memories.agents[0]!.text, /missing rows/);
  assert.equal(authorView.memories.project.length, 1); assert.equal(authorView.books.length, 0);
  assert.equal(f.ledger.snapshot({ projectId: 'other-project' }).memories.agents.length, 0);
  assert.throws(() => f.ledger.snapshot({ projectId: 'other-project', sessionId: 'conversation' }), /outside this research project/);
});

test('coordinator plans require explicit ordered steps, survive retries, and retain earlier plans on revision', t => {
  const f = setup(t);
  const spec = {objective: 'Select a reproducible revision', acceptanceCriteria: ['A branch points to the recorded commit']};
  assert.throws(() => f.ledger.plan(f.parent, spec, true), /Research stages/);
  assert.throws(() => f.ledger.plan(f.author, {...spec, stages:['Inspect branches']}, true), /coordinator/);
  const first = {...spec, stages: ['Read the refs', 'Record the SHA']};
  const plan = f.ledger.plan(f.parent, {...first, requestId:'first'}, true);
  assert.equal(f.ledger.plan(f.parent, {...first, requestId:'second'}, true).id, plan.id);
  const revised = f.ledger.plan(f.parent, {...first, stages:['Resolve the release tag'], requestId:'revision'}, true);
  assert.notEqual(revised.id, plan.id);
  f.restart();
  assert.deepEqual(f.snapshot().missions.slice(-2).map(m => m.stages), [first.stages, revised.stages]);
  assert.ok(f.ledger.hasPlan(f.parent));
  assert.equal(f.ledger.plan(f.parent, {...first, requestId:'first'}, true).id, plan.id);
  assert.equal(f.snapshot().missions.at(-1)?.id, revised.id);
});
