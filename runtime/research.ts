import { randomUUID } from 'node:crypto';
import { ManagerError, hash, object } from './orchestration.ts';
import type { Attempt, Context } from './orchestration.ts';
import type { Storage } from './storage.ts';

/** User-visible research records. This module neither schedules agents nor grants tools. */
export type ResearchTarget = {
  readonly kind: 'file' | 'artifact'; readonly id: string; readonly projectId: string;
  readonly sessionId: string; readonly version: string; readonly sha256: string; readonly bytes: number;
  readonly taskId?: string; readonly attemptId?: string; readonly agentSessionId?: string; readonly processId?: string;
  readonly inputVersions?: readonly { readonly id: string; readonly version: string }[];
};
export type ResearchResolver = (ctx: Context, target: { readonly kind: ResearchTarget['kind']; readonly id: string }) => Promise<ResearchTarget>;
export type ResearchMission = {
  readonly id: string; readonly projectId: string; readonly sessionId: string; readonly runId: string;
  readonly objective: string; readonly acceptanceCriteria: readonly string[]; readonly stages: readonly string[];
  readonly createdAt: number; readonly createdBy: Context;
};
export type ResearchMissionProgress = ResearchMission & {
  readonly phase: 'planned' | 'evidence_recorded' | 'review_pending' | 'review_interrupted' | 'reviewed' | 'knowledge_recorded';
  readonly evidenceCount: number; readonly reviewCount: number; readonly knowledgeCount: number;
};
export type ResearchEvidence = {
  readonly id: string; readonly missionId: string; readonly title: string; readonly summary?: string;
  readonly targets: readonly ResearchTarget[]; readonly createdAt: number; readonly createdBy: Context;
};
export type ResearchVerdict = 'supported' | 'changes_required' | 'insufficient_evidence';
export type ResearchReview = {
  readonly id: string; readonly missionId: string; readonly evidenceIds: readonly string[];
  readonly targets: readonly ResearchTarget[]; readonly contextFiles?: readonly ResearchTarget[]; readonly question: string; readonly createdAt: number;
  readonly requestedBy: Context; readonly reviewer?: Context;
  readonly state: 'awaiting_reviewer' | 'pending' | 'completed' | 'failed' | 'cancelled' | 'paused';
  readonly executionStatus?: string; readonly verdict?: ResearchVerdict;
  readonly checks?: readonly string[]; readonly findings?: readonly string[];
  readonly reproductionEvidenceIds?: readonly string[]; readonly submittedAt?: number;
  readonly previousReviewId?: string;
};
export type KnowledgeLevel = 'observation' | 'verified' | 'convention';
export type ResearchKnowledge = {
  readonly id: string; readonly missionId: string; readonly title: string; readonly method: string;
  readonly rationale: string; readonly applicability: readonly string[];
  readonly evidenceIds: readonly string[]; readonly reviewIds: readonly string[];
  readonly level: KnowledgeLevel; readonly state: 'active' | 'revoked' | 'superseded';
  readonly createdAt: number; readonly createdBy: Context;
  readonly history: readonly { readonly at: number; readonly actor: 'agent' | 'human'; readonly action: string; readonly reason: string; readonly replacementId?: string }[];
};
export type ResearchMemory = {
  readonly id: string; readonly scope: 'project' | 'agent'; readonly text: string;
  readonly createdAt: number; readonly createdBy: Context;
};
export type ResearchSnapshot = {
  readonly schemaVersion: 1; readonly projectId: string; readonly missions: readonly ResearchMissionProgress[];
  readonly evidence: readonly ResearchEvidence[]; readonly reviews: readonly ResearchReview[];
  readonly books: readonly ResearchKnowledge[];
  readonly memories: { readonly project: readonly ResearchMemory[]; readonly agents: readonly ResearchMemory[] };
};
type Request = { readonly key: string; readonly fingerprint: string; readonly id: string };
type Document = {
  schemaVersion: 1; projectId: string; missions: ResearchMission[]; evidence: ResearchEvidence[];
  reviews: ResearchReview[]; books: ResearchKnowledge[]; projectMemory: ResearchMemory[];
  agentMemory: ResearchMemory[]; requests: Request[];
};
type Args = Readonly<Record<string, unknown>>;
const DEFAULT_STAGES = ['Define the question and acceptance criteria', 'Collect input and execute', 'Review the exact evidence independently', 'Record findings and reusable methods'];
const MAX_RECORDS = 2048;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
function fail(code: string, message: string): never { throw new ManagerError('RESEARCH_' + code, message); }
function string(value: unknown, name: string, maximum = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) fail('INVALID_INPUT', name + ' must be nonempty bounded text.');
  return value;
}
function strings(value: unknown, name: string, { maximum = 32, minimum = 1, length = 4096 } = {}): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail('INVALID_INPUT', name + ' must be a bounded list.');
  const result = value.map(item => string(item, name, length));
  if (new Set(result).size !== result.length) fail('INVALID_INPUT', name + ' must contain distinct values.');
  return result;
}
function fields(args: Args, allowed: readonly string[]) {
  if (!object(args) || Object.keys(args).some(key => !allowed.includes(key))) fail('INVALID_INPUT', 'Unknown research arguments.');
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function sameContext(a: Context, b: Context): boolean {
  return ['projectId', 'sessionId', 'runId', 'taskId', 'parentTaskId', 'agentSessionId', 'attemptId'].every(key => a[key as keyof Context] === b[key as keyof Context]);
}
function targetKey(target: ResearchTarget): string { return target.kind + ':' + target.id; }
function sameTarget(a: ResearchTarget, b: ResearchTarget): boolean { return stable(a) === stable(b); }
function contextCopy(ctx: Context): Context {
  const { projectId, sessionId, runId, taskId, parentTaskId, agentSessionId, attemptId } = ctx;
  return { projectId, sessionId, runId, taskId, parentTaskId, agentSessionId, attemptId };
}

/** Durable ledger backed by Athena's existing SQLite metadata transaction. */
export class ResearchLedger {
  readonly #storage: Storage;
  constructor(storage: Storage) { this.#storage = storage; }

  #key(projectId: string) { return 'athena.research.v1:' + string(projectId, 'Project ID', 256); }
  #document(projectId: string): Document {
    if (!this.#storage.project(projectId)) fail('SCOPE_DENIED', 'The research project does not exist.');
    const found = this.#storage.get<Document>(this.#key(projectId));
    if (found) {
      if (found.schemaVersion !== 1 || found.projectId !== projectId) fail('INVALID_STORAGE', 'Unsupported research ledger.');
      return found;
    }
    return { schemaVersion: 1, projectId, missions: [], evidence: [], reviews: [], books: [], projectMemory: [], agentMemory: [], requests: [] };
  }
  #save(doc: Document) {
    for (const key of ['missions', 'evidence', 'reviews', 'books', 'projectMemory', 'agentMemory', 'requests'] as const) {
      if (doc[key].length > MAX_RECORDS) fail('LIMIT', 'The research ledger record limit was reached. Existing evidence was preserved.');
    }
    if (Buffer.byteLength(JSON.stringify(doc), 'utf8') > MAX_DOCUMENT_BYTES) fail('LIMIT', 'The research ledger size limit was reached. Existing evidence was preserved.');
    this.#storage.set(this.#key(doc.projectId), doc);
  }
  #context(ctx: Context, parent = false): Attempt {
    for (const key of ['projectId', 'sessionId', 'runId', 'taskId', 'agentSessionId', 'attemptId'] as const) string(ctx[key], key, 256);
    if (ctx.parentTaskId !== null) string(ctx.parentTaskId, 'Parent task ID', 256);
    const session = this.#storage.session(ctx.sessionId);
    const attempt = this.#storage.record<Attempt>('attempt', ctx.attemptId);
    if (!session || session.projectId !== ctx.projectId || !attempt || !sameContext(attempt, ctx)) fail('SCOPE_DENIED', 'Research operations require the actual scoped attempt.');
    if (parent && ctx.parentTaskId !== null) fail('ROLE_DENIED', 'Only the coordinator can change research plans or request a review.');
    return attempt;
  }
  #active(ctx: Context, parent = false) {
    const attempt = this.#context(ctx, parent);
    if (attempt.status !== 'running' || attempt.kind === 'reconciliation') fail('ATTEMPT_INACTIVE', 'Research changes require an executing non-reconciliation attempt.');
    return attempt;
  }
  #mission(doc: Document, ctx: Context, value: unknown): ResearchMission {
    const id = string(value, 'Mission ID', 256);
    const mission = doc.missions.find(row => row.id === id);
    if (!mission || mission.projectId !== ctx.projectId || mission.sessionId !== ctx.sessionId || mission.runId !== ctx.runId) fail('SCOPE_DENIED', 'Mission is outside this attempt scope.');
    return mission;
  }
  #evidence(doc: Document, missionId: string, ids: readonly string[]): ResearchEvidence[] {
    return ids.map(id => {
      const row = doc.evidence.find(item => item.id === id && item.missionId === missionId);
      if (!row) fail('EVIDENCE_MISSING', 'Requested evidence is not recorded for this mission.');
      return row;
    });
  }
  #request(doc: Document, ctx: Context, op: string, args: Args): Request | undefined {
    if (args.requestId === undefined) return undefined;
    const requestId = string(args.requestId, 'Request ID', 256);
    const key = stable([ctx.sessionId, ctx.runId, ctx.taskId, op, requestId]);
    const fingerprint = hash(stable(args));
    const found = doc.requests.find(request => request.key === key);
    if (found && found.fingerprint !== fingerprint) fail('REQUEST_CONFLICT', 'Research request ID already has different arguments.');
    return found ?? { key, fingerprint, id: '' };
  }
  #receipt(doc: Document, request: Request | undefined, id: string) {
    if (request && !request.id) doc.requests.push({ ...request, id });
  }
  #resolved(ctx: Context, requested: { kind: ResearchTarget['kind']; id: string }, target: ResearchTarget): ResearchTarget {
    if (!object(target) || target.kind !== requested.kind || target.id !== requested.id || target.projectId !== ctx.projectId || target.sessionId !== ctx.sessionId ||
        typeof target.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(target.sha256) || !Number.isSafeInteger(target.bytes) || target.bytes < 0) fail('EVIDENCE_INVALID', 'The host could not verify a scoped evidence target.');
    const common: ResearchTarget = { kind: target.kind, id: string(target.id, 'Target ID', 256), projectId: target.projectId,
      sessionId: target.sessionId, version: string(target.version, 'Target version', 256), sha256: target.sha256, bytes: target.bytes };
    if (target.kind === 'file') return common;
    const producer = this.#storage.record<Attempt>('attempt', string(target.attemptId, 'Producer attempt ID', 256));
    if (!producer || producer.projectId !== ctx.projectId || producer.sessionId !== ctx.sessionId || producer.runId !== ctx.runId ||
        producer.taskId !== target.taskId || producer.agentSessionId !== target.agentSessionId) fail('EVIDENCE_INVALID', 'Artifact producer does not belong to this research run.');
    let inputVersions: { id: string; version: string }[] | undefined;
    if (target.inputVersions !== undefined) {
      if (!Array.isArray(target.inputVersions) || target.inputVersions.length > 32) fail('EVIDENCE_INVALID', 'Invalid artifact input provenance.');
      inputVersions = target.inputVersions.map(input => {
        if (!object(input)) fail('EVIDENCE_INVALID', 'Invalid artifact input provenance.');
        return { id: string(input.id, 'Input provenance ID', 256), version: string(input.version, 'Input provenance version', 256) };
      });
      if (new Set(inputVersions.map(input => input.id)).size !== inputVersions.length) fail('EVIDENCE_INVALID', 'Duplicate artifact input provenance.');
      inputVersions.sort((a, b) => a.id.localeCompare(b.id));
    }
    return { ...common, taskId: string(target.taskId, 'Producer task ID', 256), attemptId: producer.id,
      agentSessionId: string(target.agentSessionId, 'Producer session ID', 256), processId: string(target.processId, 'Process ID', 256),
      ...(inputVersions ? { inputVersions } : {}) };
  }
  async #resolve(ctx: Context, requested: { kind: ResearchTarget['kind']; id: string }, resolve: ResearchResolver) {
    return this.#resolved(ctx, requested, await resolve(contextCopy(ctx), requested));
  }
  async #verify(ctx: Context, targets: readonly ResearchTarget[], resolve: ResearchResolver) {
    for (const target of targets) {
      const current = await this.#resolve(ctx, { kind: target.kind, id: target.id }, resolve);
      if (!sameTarget(target, current)) fail('EVIDENCE_CHANGED', 'Evidence bytes, version, or producer changed; request a new review of the new evidence.');
    }
  }

  hasPlan(ctx: Context): boolean {
    return this.#document(ctx.projectId).missions.some(mission => mission.sessionId === ctx.sessionId && mission.runId === ctx.runId);
  }

  plan(ctx: Context, args: Args, coordinatorPlan = false): ResearchMission {
    this.#active(ctx, true);
    fields(args, ['objective', 'acceptanceCriteria', 'stages', 'requestId']);
    const objective = string(args.objective, 'Research objective');
    const acceptanceCriteria = strings(args.acceptanceCriteria, 'Acceptance criteria');
    const stages = !coordinatorPlan && args.stages === undefined ? DEFAULT_STAGES : strings(args.stages, 'Research stages', { maximum: 12, length: 512 });
    const doc = this.#document(ctx.projectId); const request = this.#request(doc, ctx, 'plan', args);
    if (request?.id) return structuredClone(doc.missions.find(row => row.id === request.id)!);
    if (coordinatorPlan) {
      const saved = doc.missions.findLast(mission => mission.runId === ctx.runId);
      if (saved && saved.objective === objective && JSON.stringify(saved.stages) === JSON.stringify(stages)
          && JSON.stringify(saved.acceptanceCriteria) === JSON.stringify(acceptanceCriteria)) {
        this.#receipt(doc, request, saved.id);
        this.#save(doc);
        return structuredClone(saved);
      }
    }
    const mission: ResearchMission = { id: randomUUID(), projectId: ctx.projectId, sessionId: ctx.sessionId, runId: ctx.runId,
      objective, acceptanceCriteria, stages: [...stages], createdAt: Date.now(), createdBy: contextCopy(ctx) };
    doc.missions.push(mission); this.#receipt(doc, request, mission.id); this.#save(doc);
    return structuredClone(mission);
  }

  async addEvidence(ctx: Context, args: Args, resolve: ResearchResolver): Promise<ResearchEvidence> {
    this.#active(ctx);
    fields(args, ['missionId', 'title', 'summary', 'fileIds', 'artifactIds', 'requestId']);
    const title = string(args.title, 'Evidence title', 512);
    const summary = args.summary === undefined ? undefined : string(args.summary, 'Evidence summary');
    const fileIds = args.fileIds === undefined ? [] : strings(args.fileIds, 'Input file IDs', { minimum: 0, length: 256 });
    const artifactIds = args.artifactIds === undefined ? [] : strings(args.artifactIds, 'Artifact IDs', { minimum: 0, length: 256 });
    if (!fileIds.length && !artifactIds.length) fail('EVIDENCE_MISSING', 'Evidence requires at least one actual input or artifact.');
    let doc = this.#document(ctx.projectId); const mission = this.#mission(doc, ctx, args.missionId);
    const previous = this.#request(doc, ctx, 'evidence', args);
    if (previous?.id) return structuredClone(doc.evidence.find(row => row.id === previous.id)!);
    const targets: ResearchTarget[] = [];
    for (const id of fileIds) targets.push(await this.#resolve(ctx, { kind: 'file', id }, resolve));
    for (const id of artifactIds) targets.push(await this.#resolve(ctx, { kind: 'artifact', id }, resolve));
    // Re-read after asynchronous byte verification; do not overwrite another agent's new record.
    this.#active(ctx); doc = this.#document(ctx.projectId); this.#mission(doc, ctx, mission.id);
    const request = this.#request(doc, ctx, 'evidence', args);
    if (request?.id) return structuredClone(doc.evidence.find(row => row.id === request.id)!);
    const evidence: ResearchEvidence = { id: randomUUID(), missionId: mission.id, title, ...(summary ? { summary } : {}),
      targets, createdAt: Date.now(), createdBy: contextCopy(ctx) };
    doc.evidence.push(evidence); this.#receipt(doc, request, evidence.id); this.#save(doc);
    return structuredClone(evidence);
  }

  async prepareReview(ctx: Context, args: Args, resolve: ResearchResolver, contextFileIds: readonly string[] = []): Promise<ResearchReview> {
    this.#active(ctx, true);
    fields(args, ['missionId', 'evidenceIds', 'question', 'requestId']);
    const evidenceIds = strings(args.evidenceIds, 'Evidence IDs', { length: 256 });
    const question = string(args.question, 'Review question');
    let doc = this.#document(ctx.projectId); const mission = this.#mission(doc, ctx, args.missionId);
    const previous = this.#request(doc, ctx, 'review', args);
    if (previous?.id) return structuredClone(doc.reviews.find(row => row.id === previous.id)!);
    const evidence = this.#evidence(doc, mission.id, evidenceIds);
    const unique = new Map<string, ResearchTarget>();
    for (const row of evidence) for (const target of row.targets) {
      const prior = unique.get(targetKey(target));
      if (prior && !sameTarget(prior, target)) fail('EVIDENCE_CONFLICT', 'The review package contains conflicting versions of one target.');
      unique.set(targetKey(target), target);
    }
    const targets = [...unique.values()];
    if (!targets.some(target => target.kind === 'artifact')) fail('EVIDENCE_MISSING', 'An independent result review requires a published artifact.');
    const contextFiles: ResearchTarget[] = [];
    for (const id of contextFileIds) {
      const file = await this.#resolve(ctx, {kind:'file',id}, resolve);
      if (unique.has(targetKey(file))) fail('REVIEWER_GRANTS', 'Review context cannot also be submitted as research evidence.');
      contextFiles.push(file);
    }
    await this.#verify(ctx, targets, resolve);
    this.#active(ctx, true); doc = this.#document(ctx.projectId); this.#mission(doc, ctx, mission.id);
    const request = this.#request(doc, ctx, 'review', args);
    if (request?.id) return structuredClone(doc.reviews.find(row => row.id === request.id)!);
    const review: ResearchReview = { id: randomUUID(), missionId: mission.id, evidenceIds, targets, ...(contextFiles.length ? {contextFiles} : {}),
      question, createdAt: Date.now(), requestedBy: contextCopy(ctx), state: 'awaiting_reviewer' };
    doc.reviews.push(review); this.#receipt(doc, request, review.id); this.#save(doc);
    return structuredClone(review);
  }

  /** Host-only: call after journal acceptance and before scheduling this actual child. */
  registerReviewer(ctx: Context, reviewId: string, reviewer: Context): ResearchReview {
    this.#context(ctx, true); const reviewerAttempt = this.#context(reviewer);
    const doc = this.#document(ctx.projectId); const index = doc.reviews.findIndex(row => row.id === reviewId);
    const review = doc.reviews[index];
    if (!review || !sameContext(ctx, review.requestedBy)) fail('SCOPE_DENIED', 'Review registration belongs to another coordinator attempt.');
    this.#mission(doc, ctx, review.missionId);
    if (reviewer.projectId !== ctx.projectId || reviewer.sessionId !== ctx.sessionId || reviewer.runId !== ctx.runId ||
        reviewer.parentTaskId !== ctx.taskId || reviewer.taskId === ctx.taskId || reviewer.agentSessionId === ctx.agentSessionId) fail('REVIEWER_INVALID', 'A review requires a real separate direct child session in this run.');
    if (review.targets.some(target => target.kind === 'artifact' && (target.taskId === reviewer.taskId || target.agentSessionId === reviewer.agentSessionId)) ||
        this.#evidence(doc, review.missionId, review.evidenceIds).some(row => row.createdBy.taskId === reviewer.taskId || row.createdBy.agentSessionId === reviewer.agentSessionId)) fail('REVIEWER_NOT_INDEPENDENT', 'The producing agent cannot independently review its own evidence.');
    const expectedFiles = [...review.targets, ...(review.contextFiles ?? [])].filter(target => target.kind === 'file').map(target => target.id).sort();
    const expectedArtifacts = review.targets.filter(target => target.kind === 'artifact').map(target => target.id).sort();
    if (stable([...reviewerAttempt.fileIds].sort()) !== stable(expectedFiles) || stable([...(reviewerAttempt.artifactGrants ?? [])].sort()) !== stable(expectedArtifacts)) fail('REVIEWER_GRANTS', 'Reviewer inputs must be exactly the frozen review package, without unrelated inherited inputs.');
    if (review.reviewer) {
      if (!sameContext(review.reviewer, reviewer)) fail('REVIEWER_PINNED', 'The reviewer attempt is already fixed. Request a new review for another attempt.');
      return structuredClone(review);
    }
    const updated: ResearchReview = { ...review, reviewer: contextCopy(reviewer), state: 'pending' };
    doc.reviews[index] = updated; this.#save(doc); return structuredClone(updated);
  }

  /** Host-only manual recovery: preserve the old review and bind a new receipt before scheduling. */
  retryReviewer(previous: Context, next: Context): ResearchReview | undefined {
    const sourceAttempt = this.#context(previous); const nextAttempt = this.#context(next);
    if (!['failed', 'cancelled', 'paused'].includes(sourceAttempt.status)) fail('RETRY_INVALID', 'Only a stopped reviewer attempt can be retried.');
    if (next.projectId !== previous.projectId || next.sessionId !== previous.sessionId || next.runId !== previous.runId ||
        next.taskId !== previous.taskId || next.parentTaskId !== previous.parentTaskId || next.agentSessionId !== previous.agentSessionId || next.attemptId === previous.attemptId) fail('RETRY_INVALID', 'Manual review retry must keep the original task, session, scope and grants.');
    if (stable([...sourceAttempt.fileIds].sort()) !== stable([...nextAttempt.fileIds].sort()) ||
        stable([...(sourceAttempt.artifactGrants ?? [])].sort()) !== stable([...(nextAttempt.artifactGrants ?? [])].sort())) fail('RETRY_INVALID', 'Manual review retry must keep the original input grants.');
    const doc = this.#document(previous.projectId);
    const source = doc.reviews.find(row => row.reviewer && sameContext(row.reviewer, previous));
    if (!source) return undefined;
    const replay = doc.reviews.find(row => row.previousReviewId === source.id && row.reviewer && sameContext(row.reviewer, next));
    if (replay) return structuredClone(replay);
    const review: ResearchReview = { id: randomUUID(), missionId: source.missionId, evidenceIds: [...source.evidenceIds],
      targets: structuredClone(source.targets), ...(source.contextFiles ? {contextFiles:structuredClone(source.contextFiles)} : {}), question: source.question, createdAt: Date.now(), requestedBy: contextCopy(source.requestedBy),
      reviewer: contextCopy(next), state: 'pending', previousReviewId: source.id };
    doc.reviews.push(review); this.#save(doc); return structuredClone(review);
  }

  async submitReview(ctx: Context, args: Args, resolve: ResearchResolver): Promise<ResearchReview> {
    const attempt = this.#context(ctx);
    fields(args, ['reviewId', 'verdict', 'checks', 'findings', 'reproductionEvidenceIds']);
    const reviewId = string(args.reviewId, 'Review ID', 256);
    if (!['supported', 'changes_required', 'insufficient_evidence'].includes(String(args.verdict))) fail('INVALID_INPUT', 'Unknown review verdict.');
    const verdict = args.verdict as ResearchVerdict;
    const checks = strings(args.checks, 'Performed checks');
    const findings = strings(args.findings, 'Review findings', { minimum: 0 });
    const reproductionEvidenceIds = args.reproductionEvidenceIds === undefined ? [] : strings(args.reproductionEvidenceIds, 'Reproduction evidence IDs', { minimum: 0, length: 256 });
    let doc = this.#document(ctx.projectId); const review = doc.reviews.find(row => row.id === reviewId);
    if (!review?.reviewer || !sameContext(review.reviewer, ctx)) fail('REVIEWER_DENIED', 'Only the registered reviewer attempt can submit this review.');
    this.#mission(doc, ctx, review.missionId);
    const payload = { verdict, checks, findings, reproductionEvidenceIds };
    if (review.state === 'completed') {
      if (stable(payload) !== stable({ verdict: review.verdict, checks: review.checks, findings: review.findings, reproductionEvidenceIds: review.reproductionEvidenceIds })) fail('REVIEW_IMMUTABLE', 'Submitted reviews are immutable. Request another review for new findings.');
      return structuredClone(review);
    }
    if (attempt.status !== 'running') fail('ATTEMPT_INACTIVE', 'Review submission requires the executing reviewer attempt.');
    const reproductions = this.#evidence(doc, review.missionId, reproductionEvidenceIds);
    for (const evidence of reproductions) {
      if (!sameContext(evidence.createdBy, ctx) || !evidence.targets.some(target => target.kind === 'artifact' && target.taskId === ctx.taskId && target.attemptId === ctx.attemptId && target.agentSessionId === ctx.agentSessionId)) fail('REPRODUCTION_INVALID', 'Reproduction must include an actual artifact produced by this reviewer attempt.');
    }
    await this.#verify(ctx, [...review.targets, ...(review.contextFiles ?? [])], resolve);
    for (const evidence of reproductions) await this.#verify(ctx, evidence.targets, resolve);
    if (this.#context(ctx).status !== 'running') fail('ATTEMPT_INACTIVE', 'The reviewer stopped before submission was persisted.');
    doc = this.#document(ctx.projectId); const index = doc.reviews.findIndex(row => row.id === reviewId);
    const latest = doc.reviews[index];
    if (latest?.reviewer && sameContext(latest.reviewer, ctx) && latest.state === 'completed' &&
        stable(payload) === stable({ verdict: latest.verdict, checks: latest.checks, findings: latest.findings, reproductionEvidenceIds: latest.reproductionEvidenceIds })) return structuredClone(latest);
    if (!latest?.reviewer || !sameContext(latest.reviewer, ctx) || latest.state !== 'pending') fail('REVIEW_CONFLICT', 'This review changed while evidence was being verified.');
    const updated: ResearchReview = { ...latest, ...payload, state: 'completed', submittedAt: Date.now() };
    doc.reviews[index] = updated; this.#save(doc); return structuredClone(updated);
  }

  remember(ctx: Context, args: Args): ResearchMemory {
    this.#active(ctx);
    fields(args, ['scope', 'text', 'requestId']);
    if (args.scope !== 'project' && args.scope !== 'agent') fail('INVALID_INPUT', 'Memory scope must be project or agent.');
    const text = string(args.text, 'Operational memory', 8192);
    const doc = this.#document(ctx.projectId); const request = this.#request(doc, ctx, 'memory', args);
    const collection = args.scope === 'project' ? doc.projectMemory : doc.agentMemory;
    if (request?.id) return structuredClone(collection.find(row => row.id === request.id)!);
    const memory: ResearchMemory = { id: randomUUID(), scope: args.scope, text, createdAt: Date.now(), createdBy: contextCopy(ctx) };
    collection.push(memory); this.#receipt(doc, request, memory.id); this.#save(doc); return structuredClone(memory);
  }

  #verified(doc: Document, evidenceIds: readonly string[], reviews: readonly ResearchReview[]): boolean {
    if (!reviews.length) return false;
    const covered = new Set<string>();
    for (const review of reviews) {
      if (review.state !== 'completed' || review.verdict !== 'supported' || !review.reviewer ||
          this.#storage.record<Attempt>('attempt', review.reviewer.attemptId)?.status !== 'succeeded') continue;
      const inputs = review.targets.filter(target => target.kind === 'file');
      if (!inputs.length) continue;
      const reproductions = this.#evidence(doc, review.missionId, review.reproductionEvidenceIds ?? []);
      if (!reproductions.some(row => sameContext(row.createdBy, review.reviewer!) &&
          row.targets.some(target => target.kind === 'artifact' && target.attemptId === review.reviewer!.attemptId &&
            inputs.every(input => target.inputVersions?.some(version => version.id === input.id && version.version === input.version))) &&
          inputs.every(input => row.targets.some(target => sameTarget(input, target))))) continue;
      for (const id of review.evidenceIds) covered.add(id);
    }
    return evidenceIds.every(id => covered.has(id));
  }

  /** Host calls this immediately before proposeKnowledge so original and reproduction bytes remain current. */
  async verifyKnowledgeEvidence(ctx: Context, args: Args, resolve: ResearchResolver): Promise<void> {
    this.#active(ctx, true);
    const evidenceIds = strings(args.evidenceIds, 'Evidence IDs', { length: 256 });
    const reviewIds = args.reviewIds === undefined ? [] : strings(args.reviewIds, 'Review IDs', { minimum: 0, length: 256 });
    const doc = this.#document(ctx.projectId); const mission = this.#mission(doc, ctx, args.missionId);
    const allEvidence = new Set(evidenceIds);
    for (const id of reviewIds) {
      const review = doc.reviews.find(row => row.id === id && row.missionId === mission.id);
      if (!review) fail('REVIEW_MISSING', 'Knowledge review is outside this mission.');
      for (const evidenceId of review.evidenceIds) allEvidence.add(evidenceId);
      for (const evidenceId of review.reproductionEvidenceIds ?? []) allEvidence.add(evidenceId);
    }
    for (const evidence of this.#evidence(doc, mission.id, [...allEvidence])) await this.#verify(ctx, evidence.targets, resolve);
    this.#active(ctx, true);
  }

  proposeKnowledge(ctx: Context, args: Args): ResearchKnowledge {
    this.#active(ctx, true);
    fields(args, ['missionId', 'title', 'method', 'rationale', 'applicability', 'evidenceIds', 'reviewIds', 'requestId']);
    const title = string(args.title, 'Knowledge title', 512);
    const method = string(args.method, 'Reusable method', 8192);
    const rationale = string(args.rationale, 'Method rationale');
    const applicability = strings(args.applicability, 'Applicability conditions');
    const evidenceIds = strings(args.evidenceIds, 'Evidence IDs', { length: 256 });
    const reviewIds = args.reviewIds === undefined ? [] : strings(args.reviewIds, 'Review IDs', { minimum: 0, length: 256 });
    const doc = this.#document(ctx.projectId); const mission = this.#mission(doc, ctx, args.missionId);
    const request = this.#request(doc, ctx, 'knowledge', args);
    if (request?.id) return structuredClone(doc.books.find(row => row.id === request.id)!);
    this.#evidence(doc, mission.id, evidenceIds);
    const reviews = reviewIds.map(id => {
      const review = doc.reviews.find(row => row.id === id && row.missionId === mission.id);
      if (!review) fail('REVIEW_MISSING', 'Knowledge review is outside this mission.');
      return review;
    });
    const level: KnowledgeLevel = this.#verified(doc, evidenceIds, reviews) ? 'verified' : 'observation';
    const reason = level === 'verified' ? 'Independent reviewer completed a supported review with a separately produced reproduction artifact and the same pinned inputs.' : 'Recorded evidence is available. Complete independent reproduction has not been established for every cited evidence record.';
    const knowledge: ResearchKnowledge = { id: randomUUID(), missionId: mission.id, title, method, rationale, applicability,
      evidenceIds, reviewIds, level, state: 'active', createdAt: Date.now(), createdBy: contextCopy(ctx),
      history: [{ at: Date.now(), actor: 'agent', action: level, reason }] };
    doc.books.push(knowledge); this.#receipt(doc, request, knowledge.id); this.#save(doc); return structuredClone(knowledge);
  }

  /** Human RPC only. This method must never be registered as an agent tool. */
  decideKnowledge(projectId: string, id: string, args: Args): ResearchKnowledge {
    fields(args, ['decision', 'reason', 'replacementId']);
    const reason = string(args.reason, 'Human decision reason');
    if (!['convention', 'revoke', 'supersede'].includes(String(args.decision))) fail('INVALID_INPUT', 'Unknown knowledge decision.');
    const doc = this.#document(projectId); const index = doc.books.findIndex(row => row.id === id); const entry = doc.books[index];
    if (!entry) fail('KNOWLEDGE_MISSING', 'Knowledge entry is outside this project.');
    if (entry.state !== 'active') fail('KNOWLEDGE_CLOSED', 'Revoked or superseded knowledge remains immutable.');
    if (args.decision === 'convention' && entry.level !== 'verified') fail('KNOWLEDGE_UNVERIFIED', 'Only independently verified knowledge can become a human-confirmed convention.');
    let replacementId: string | undefined;
    if (args.decision === 'supersede') {
      replacementId = string(args.replacementId, 'Replacement knowledge ID', 256);
      if (replacementId === id || !doc.books.some(row => row.id === replacementId && row.state === 'active')) fail('KNOWLEDGE_REPLACEMENT', 'Replacement must be a different active entry in this project.');
    } else if (args.replacementId !== undefined) fail('INVALID_INPUT', 'Only supersession takes a replacement ID.');
    const updated: ResearchKnowledge = { ...entry, level: args.decision === 'convention' ? 'convention' : entry.level,
      state: args.decision === 'revoke' ? 'revoked' : args.decision === 'supersede' ? 'superseded' : 'active',
      history: [...entry.history, { at: Date.now(), actor: 'human', action: String(args.decision), reason, ...(replacementId ? { replacementId } : {}) }] };
    doc.books[index] = updated; this.#save(doc); return structuredClone(updated);
  }

  /** Agent callers must pass agentSessionId. UI may inspect the selected session's operational notes. */
  snapshot(scope: { projectId: string; sessionId?: string; agentSessionId?: string }): ResearchSnapshot {
    const doc = this.#document(scope.projectId);
    if (scope.sessionId && this.#storage.session(scope.sessionId)?.projectId !== scope.projectId) fail('SCOPE_DENIED', 'Conversation is outside this research project.');
    const matches = (ctx: Context) => !scope.sessionId || ctx.sessionId === scope.sessionId;
    const missions = doc.missions.filter(row => !scope.sessionId || row.sessionId === scope.sessionId).map(row => {
      const evidenceCount = doc.evidence.filter(item => item.missionId === row.id).length;
      const relatedReviews = doc.reviews.filter(item => item.missionId === row.id);
      const knowledgeCount = doc.books.filter(item => item.missionId === row.id).length;
      const hasOpenReview = relatedReviews.some(item => item.state !== 'completed' &&
        ['queued', 'running', 'blocked'].includes(this.#storage.record<Attempt>('attempt', (item.reviewer ?? item.requestedBy).attemptId)?.status ?? 'paused'));
      const phase: ResearchMissionProgress['phase'] = hasOpenReview ? 'review_pending' : knowledgeCount ? 'knowledge_recorded' :
        relatedReviews.some(item => item.state === 'completed') ? 'reviewed' : relatedReviews.length ? 'review_interrupted' : evidenceCount ? 'evidence_recorded' : 'planned';
      return { ...row, phase, evidenceCount, reviewCount: relatedReviews.length, knowledgeCount };
    });
    const missionIds = new Set(missions.map(row => row.id));
    const reviews = doc.reviews.filter(row => missionIds.has(row.missionId)).map(row => {
      const status = this.#storage.record<Attempt>('attempt', (row.reviewer ?? row.requestedBy).attemptId)?.status ?? 'paused';
      const state = row.state !== 'completed' && ['failed', 'cancelled', 'paused'].includes(status) ? status as 'failed' | 'cancelled' | 'paused' : row.state;
      return { ...row, state, executionStatus: status };
    });
    return structuredClone({ schemaVersion: 1, projectId: doc.projectId, missions,
      evidence: doc.evidence.filter(row => missionIds.has(row.missionId)), reviews,
      books: doc.books,
      memories: { project: doc.projectMemory,
        agents: doc.agentMemory.filter(row => matches(row.createdBy) && (!scope.agentSessionId || row.createdBy.agentSessionId === scope.agentSessionId)) } });
  }
}
