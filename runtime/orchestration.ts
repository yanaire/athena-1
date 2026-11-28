import { createHash } from 'node:crypto';
import type { Artifact, Task, Status, ModelReference } from '../athena-backend-handoff/athena-codex-ui/integrations/task-manager.d.ts';
import type { McpArtifact, JobAttempt } from './jobs.ts';
import type { AnalysisArtifact } from './analysis-files.ts';

export class ManagerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ManagerError('INVALID_INPUT', name + ' is required.');
  return value;
}
export function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function pending(status: Status): boolean { return status === 'queued' || status === 'running' || status === 'blocked'; }
export function executionProjects(): ReadonlySet<string> {
  return new Set((process.env.ATHENA_EXECUTION_PROJECTS ?? '').split(',').map(id => id.trim()).filter(id => id && id !== '*'));
}
export function limit(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max || raw?.trim() === '') throw new ManagerError('INVALID_LIMIT', name + ' is out of range.');
  return n;
}
export type Context = { readonly projectId: string; readonly sessionId: string; readonly runId: string;
  readonly taskId: string; readonly parentTaskId: string | null; readonly agentSessionId: string; readonly attemptId: string };
export type Attempt = Context & { readonly workerRole?:import("./worker-roles.ts").WorkerRole; readonly id: string; readonly requestId: string; readonly status: Status;
  readonly prompt: string; readonly acceptedAt: number; readonly startedAt: number | null; readonly endedAt: number | null;
  readonly result?: string; readonly error?: string; readonly fileIds: readonly string[];
  readonly artifactGrants?: readonly string[]; readonly model?: ModelReference;
  readonly explicitSkillIds?:readonly string[]; readonly kind?: 'reconciliation'; readonly retryOfAttemptId?: string };
export type TaskRow = Task & Context & { readonly result?: string; readonly error?: string };
export type AgentSession = { readonly id: string; readonly projectId: string; readonly sessionId: string;
  readonly sessionDir: string; readonly sessionFile: string; readonly role: 'parent' | 'child'; readonly workerRole?:import('./worker-roles.ts').WorkerRole; readonly model?: ModelReference | null };
export type Evidence = {readonly id:string; readonly version:string};
export type ProcessRow = Context & { readonly id: string; readonly processId: string; readonly toolId: string;
  readonly status: JobAttempt['status']; readonly job: JobAttempt; readonly evidence?: readonly Evidence[] };
export type ArtifactRow = Artifact & Context & { readonly file: McpArtifact | AnalysisArtifact; readonly toolId: string; readonly processId: string };
export function artifactRef(file: McpArtifact | AnalysisArtifact) {
  const versionId='versionId' in file?file.versionId:file.sha256;
  return { id: file.id, title: file.name, name: file.name, version: versionId, versionId, sha256: file.sha256,
    bytes: file.bytes, mimeType: file.mimeType,
    uri: '/api/artifacts/' + encodeURIComponent(file.sessionId) + '/' + encodeURIComponent(file.id) };
}

/** One lease per actual Pi session, plus an independently releasable model slot. */
export class TurnScheduler {
  readonly #limit: number;
  readonly #sessions = new Map<string, string>();
  readonly #active = new Set<string>();
  readonly #queue: (() => boolean)[] = [];
  constructor(max: number) { this.#limit = max; }
  acquire(ctx: Context, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => { this.#queue.splice(this.#queue.indexOf(grant), 1); reject(signal.reason); };
      const grant = () => {
        const owner = this.#sessions.get(ctx.agentSessionId);
        if ((owner && owner !== ctx.attemptId) || this.#active.size >= this.#limit) return false;
        signal.removeEventListener('abort', abort);
        this.#sessions.set(ctx.agentSessionId, ctx.attemptId);
        this.#active.add(ctx.attemptId);
        resolve(); return true;
      };
      signal.throwIfAborted();
      if (!grant()) { this.#queue.push(grant); signal.addEventListener('abort', abort, { once: true }); }
    });
  }
  release(ctx: Context, keepSession = false) {
    this.#active.delete(ctx.attemptId);
    if (!keepSession && this.#sessions.get(ctx.agentSessionId) === ctx.attemptId) this.#sessions.delete(ctx.agentSessionId);
    for (let i = 0; i < this.#queue.length;) {
      if (this.#queue[i]?.()) this.#queue.splice(i, 1); else i++;
    }
  }
}
