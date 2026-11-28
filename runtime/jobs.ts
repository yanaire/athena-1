import { mcpClient, type McpPhase } from './mcp-client.ts';
import { builtins, bindCall, csvRegistration, verifyMcpOutput, MCP_LIMITS, type Registration } from './mcp-registry.ts';
import { analysisAccess, analysisEnv, ANALYSIS_LIMITS, SandboxCleanupError, runSandbox, type SandboxJob, type AnalysisAccess } from './analysis-sandbox.ts';
import { AnalysisFiles, validateOutputNames, type AnalysisArtifact, type AnalysisSnapshot } from './analysis-files.ts';
export { ANALYSIS_LIMITS } from './analysis-sandbox.ts';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { callExternalMcp, EXTERNAL_MCP_LIMITS, ExternalMcpError, isTransientExternalConnectionError, validateExternalVerification, matchesExternalSchema, extensionDigest } from './external-mcp-client.ts';
import type { PinnedExternalServer } from './extensions.ts';
import { createPrivateDirectory } from './private-storage.ts';

type Scope = { readonly projectId: string; readonly sessionId: string };
type FileVersion = Scope & { readonly fileId: string; readonly versionId: string; readonly name: string };
export type McpGrant = FileVersion & { readonly id: string; readonly grantId: string; readonly mcpAlias?: string; readonly bytes: number; readonly sha256: string };
export type CsvJob = Scope & {
  readonly requestId: string; readonly taskId: string; readonly attemptId: string;
  readonly toolId: string; readonly grantId: string; readonly column?: string;
};
export type McpArtifact = Scope & {
  readonly id: string; readonly attemptId: string; readonly name: string; readonly mcpAlias?: string;
  readonly mimeType: 'application/json'; readonly bytes: number; readonly sha256: string;
  readonly receiptKind?: 'external-mcp-v1';
};
type JobErrorCode = 'INVALID_INPUT' | 'CLOSED' | 'QUEUE_FULL' | 'DUPLICATE_ATTEMPT'
  | 'GRANT_DENIED' | 'ARTIFACT_DENIED' | 'INVALID_FILE' | 'UNSUPPORTED_PLATFORM';

export class CsvJobError extends Error {
  readonly name = 'CsvJobError';
  readonly code: JobErrorCode;
  constructor(code: JobErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

// Preserve the public CSV API and on-disk namespace used by older hosts.
export { MCP_LIMITS, MCP_LIMITS as CSV_LIMITS };
const runtimeFile = (name:string) => fileURLToPath(new URL(name, import.meta.url));
const ENV = Object.freeze({ LANG: 'C', LC_ALL: 'C', TZ: 'UTC' });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const sameScope = (a: Scope, b: Scope) => a.projectId === b.projectId && a.sessionId === b.sessionId;
const attemptKey = (job: Scope & { readonly attemptId: string }) => sha256(JSON.stringify([job.projectId, job.sessionId, job.attemptId]));
const errorCode = (error: unknown) => error instanceof Error && 'code' in error ? error.code : undefined;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, label: string, limit = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > limit) {
    throw new CsvJobError('INVALID_INPUT', `Invalid ${label}.`);
  }
  return value;
}

async function privateDirectory(path: string): Promise<string> {
  try { createPrivateDirectory(path); }
  catch (cause) { throw new CsvJobError('INVALID_FILE', 'Job storage must be a private directory owned by the host process.', { cause }); }
  const st = await lstat(path);
  if (!st.isDirectory()) {
    throw new CsvJobError('INVALID_FILE', 'Job storage must be a private directory owned by the host process.');
  }
  return realpath(path);
}

async function readBounded(directory: string, name: string, limit: number): Promise<Buffer> {
  // All paths below the private root use fixed names and generated/digested IDs.
  if (await realpath(directory) !== directory) throw new CsvJobError('INVALID_FILE', 'Job storage path changed.');
  const path = join(directory, name);
  const before = await lstat(path);
  if (!before.isFile()) throw new CsvJobError('INVALID_FILE', 'Invalid job file.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await file.stat();
    if (!st.isFile() || st.nlink !== 1 || st.dev !== before.dev || st.ino !== before.ino || st.size > limit) throw new CsvJobError('INVALID_FILE', 'Invalid job file.');
    const buffer = Buffer.allocUnsafe(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== st.size || size > limit) throw new CsvJobError('INVALID_FILE', 'Job file changed or exceeded its limit.');
    return buffer.subarray(0, size);
  } finally {
    await file.close();
  }
}

function parseGrant(bytes: Buffer, grantId: string, scope: Scope): McpGrant {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!object(value) || value.id !== grantId || value.grantId !== grantId || value.projectId !== scope.projectId
    || value.sessionId !== scope.sessionId || typeof value.fileId !== 'string' || typeof value.versionId !== 'string'
    || typeof value.name !== 'string' || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes)
    || value.bytes < 1 || value.bytes > MCP_LIMITS.inputBytes || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {
    throw new CsvJobError('GRANT_DENIED', 'MCP input grant is unavailable to this project and session.');
  }
  if (value.mcpAlias !== undefined && typeof value.mcpAlias !== 'string') throw new CsvJobError('GRANT_DENIED','Invalid grant registration.');
  return { ...scope, id: grantId, grantId, mcpAlias: value.mcpAlias, fileId: value.fileId, versionId: value.versionId, name: value.name, bytes: value.bytes, sha256: value.sha256 };
}

type Identity = Omit<CsvJob,'grantId'|'column'>;
export type ExternalMcpJob = Identity & {readonly server:PinnedExternalServer;readonly tool:string;readonly arguments:Readonly<Record<string,unknown>>;readonly token?:string};
export type AnalysisJob = Identity & SandboxJob & { readonly inputs: readonly (AnalysisSnapshot & {readonly fileId?:string; readonly versionId?:string})[] };
export type JobAttempt = Identity & { readonly grantId?: string; readonly column?: string;
  readonly mcp?: { readonly server:string; readonly version:string; readonly protocol:string; readonly tool:string; readonly phase:McpPhase;
    readonly alias?:string; readonly resultKind?:string; readonly displayName?:string; readonly registryVersion?:number };
  readonly toolArguments?: Readonly<Record<string,unknown>>;
  readonly externalMcp?: {readonly serverId:string;readonly pluginId:string;readonly pluginRevision:string;readonly verificationDigest:string;readonly url:string;readonly tool:string;readonly argumentDigest:string};
  /** Stored before tools/call can leave the host. Older receipts have no dispatch fence. */
  readonly externalDispatch?: 'pending' | 'dispatching';
  readonly externalFailure?: 'connection' | 'blocked' | 'tool_error' | 'outcome_unknown';
  readonly artifacts?: readonly AnalysisArtifact[]; readonly containerId?: string; readonly executionId?: string;
  readonly analysis?: { readonly language: SandboxJob['language']; readonly script: string; readonly outputs: readonly string[];
    readonly inputs: readonly {readonly name:string; readonly sha256:string; readonly fileId?:string; readonly versionId?:string}[];
    readonly limits: Readonly<Record<string, number>>; readonly imageId?:string; readonly version?:string; readonly backend?: 'wasi'; readonly engine?: string };

  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly limits: typeof MCP_LIMITS & { readonly timeoutMs: number };
  readonly pid: number | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly cancellation: 'not_requested' | 'confirmed' | 'unknown';
  readonly stdout: string;
  readonly stderr: string;
  readonly grant?: McpGrant;
  readonly artifact?: McpArtifact;
  readonly error?: string;
};

export type JobEvent =
  | { readonly type: 'process_queued' | 'process_started' | 'process_finished'; readonly attempt: JobAttempt }
  | { readonly type: 'process_output'; readonly attempt: JobAttempt; readonly stream: 'stdout' | 'stderr'; readonly text: string };

export type JobRunnerOptions = {
  readonly dataDir: string;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  // Admission and completion receipts must be persisted synchronously and atomically.
  readonly onEvent?: (event: JobEvent) => void;
  readonly recoveredAttempts?: readonly JobAttempt[];
};

type StopReason = 'cancelled' | 'timed_out' | 'output_limit';
type JobHandle = { readonly result: Promise<JobAttempt>; cancel(): void };
type Pending = {
  cancelBeforePublication?: boolean;
  attempt: JobAttempt;
  readonly analysis?: SandboxJob;
  readonly registration?: Registration;
  readonly external?: Pick<ExternalMcpJob,'server'|'tool'|'arguments'|'token'>;
  readonly result: Promise<JobAttempt>;
  readonly resolve: (attempt: JobAttempt) => void;
  stop?: StopReason;
  terminate?: () => void;
  exited?: boolean;
};

type ProcessResult = {
  readonly outputDigest?: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly termination: 'not_requested' | 'confirmed' | 'unknown';
  readonly stop?: StopReason;
  readonly error?: string;
};

function boundedInt(value: number | undefined, fallback: number, limit: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > limit) {
    throw new CsvJobError('INVALID_INPUT', `Invalid ${label}; expected 1 to ${limit}.`);
  }
  return selected;
}

/** Only this host's live child handle can request a group signal. */
export class JobRunner {
  readonly #directory: string;
  readonly #files: AnalysisFiles;
  #discovery?: Promise<AnalysisAccess>;
  readonly #concurrency: number;
  readonly #limits: JobAttempt['limits'];
  readonly #observer: JobRunnerOptions['onEvent'];
  readonly #queue: Pending[] = [];
  readonly #active = new Set<Pending>();
  readonly #known = new Set<string>();
  #admitting = 0;
  #closed = false;
  #halted = false;
  #closePromise?: Promise<void>;

  constructor(options: JobRunnerOptions) {
    if (process.release.name !== 'node' || !['darwin', 'linux', 'win32'].includes(process.platform) || Number(process.versions.node.split('.')[0]) < 24) {
      throw new CsvJobError('UNSUPPORTED_PLATFORM', 'Job execution requires Node 24+ on macOS, Windows or Linux.');
    }
    this.#directory = resolve(options.dataDir, 'csv-jobs');
    this.#files = new AnalysisFiles(options.dataDir);
    this.#concurrency = boundedInt(options.concurrency, 1, MCP_LIMITS.maxConcurrency, 'job concurrency');
    this.#limits = Object.freeze({ ...MCP_LIMITS, timeoutMs: boundedInt(options.timeoutMs, 5_000, MCP_LIMITS.maxTimeoutMs, 'job timeout') });
    this.#observer = options.onEvent;
    for (const prior of options.recoveredAttempts ?? []) {
      const key = attemptKey(prior);
      if (this.#known.has(key)) continue;
      this.#known.add(key);
      if (prior.status === 'running' || prior.status === 'queued') {
        const beforeDispatch=!!prior.externalMcp && prior.externalDispatch==='pending';
        const attempt: JobAttempt = Object.freeze({ ...prior, status: 'interrupted', endedAt: Date.now(),
          exitCode: null, signal: null, cancellation: beforeDispatch?'confirmed':'unknown', artifact: undefined, artifacts: undefined,
          ...(prior.externalMcp ? {externalFailure:beforeDispatch?'connection' as const:'outcome_unknown' as const} : {}),
          error: beforeDispatch?'Host restarted before the external tool was invoked.':
            'Host restarted before the process attempt settled. Process termination was not observed; the attempt will not rerun.' });
        queueMicrotask(() => this.#emit({ type: 'process_finished', attempt }));
      }
    }
  }

  async grant(input: FileVersion & { readonly bytes: Uint8Array }, alias: string = csvRegistration.binding.identity.alias): Promise<McpGrant> {
    this.#assertOpen();
    const fields = { projectId: text(input.projectId, 'project ID'), sessionId: text(input.sessionId, 'session ID'),
      fileId: text(input.fileId, 'file ID'), versionId: text(input.versionId, 'version ID'), name: text(input.name, 'file name') };
    const entry = builtins.get(alias);
    if (!entry || !entry.acceptsFile(fields.name)) throw new CsvJobError('GRANT_DENIED','Input file does not match the registered tool.');
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > entry.binding.inputBytes) {
      throw new CsvJobError('INVALID_INPUT', 'Input exceeds the registered file bounds.');
    }
    const bytes = Buffer.from(input.bytes);
    const id = randomUUID();
    const grant: McpGrant = Object.freeze({ ...fields, id, grantId: id, mcpAlias:alias, bytes: bytes.length, sha256: sha256(bytes) });
    const directory = join(await this.#root('grants'), id);
    this.#assertOpen();
    await mkdir(directory, { mode: 0o700 });
    try {
      await writeFile(join(directory, entry.binding.inputName), bytes, { flag: 'wx', mode: 0o400 });
      await writeFile(join(directory, 'grant.json'), JSON.stringify(grant), { flag: 'wx', mode: 0o400 });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return grant;
  }

  start(input: CsvJob): JobHandle {
    this.#assertOpen();
    return this.startMcp(csvRegistration.binding.identity.alias, input, input.column === undefined ? {} : {column:input.column});
  }

  startMcp(alias: string, input: Identity & {grantId:string}, args: Readonly<Record<string,unknown>> = {}): JobHandle {
    this.#assertOpen();
    const registration = builtins.get(alias);
    if (!registration) throw new CsvJobError('INVALID_INPUT','Unknown built-in MCP tool.');
    const {fileId, wire} = bindCall(registration,args);
    if (fileId !== undefined) throw new CsvJobError('INVALID_INPUT','Runner requires an already resolved grant.');
    const job = {
      projectId: text(input.projectId, 'project ID'), sessionId: text(input.sessionId, 'session ID'),
      requestId: text(input.requestId, 'request ID'), taskId: text(input.taskId, 'task ID'),
      toolId: text(input.toolId, 'tool ID'), attemptId: text(input.attemptId, 'attempt ID'),
      grantId: text(input.grantId, 'grant ID'),
      toolArguments: Object.freeze(wire),
    };
    if (!UUID.test(job.grantId)) throw new CsvJobError('GRANT_DENIED', 'Invalid MCP grant ID.');
    return this.#admit(job, undefined, registration);
  }

  startExternal(input:ExternalMcpJob):JobHandle {
    this.#assertOpen();
    const server=structuredClone(input.server);
    validateExternalVerification(server.definition,server.verification);
    const tool=server.verification.tools.find(item=>item.name===input.tool);
    if (!tool || !object(input.arguments) || !matchesExternalSchema(tool.inputSchema,input.arguments)) throw new CsvJobError('INVALID_INPUT','External MCP arguments do not match the pinned tool.');
    const args=structuredClone(input.arguments);
    const job={projectId:text(input.projectId,'project ID'),sessionId:text(input.sessionId,'session ID'),
      requestId:text(input.requestId,'request ID'),taskId:text(input.taskId,'task ID'),toolId:text(input.toolId,'tool ID'),attemptId:text(input.attemptId,'attempt ID'),
      externalMcp:{serverId:server.id,pluginId:server.pluginId,pluginRevision:server.pluginRevision,verificationDigest:server.verification.digest,url:server.definition.url,tool:input.tool,argumentDigest:extensionDigest(args)}};
    // The secret is kept only on the live private handle. No credential, auth
    // reference or remote session token enters process events or stored output.
    return this.#admit(job,undefined,undefined,{server,tool:input.tool,arguments:args,token:input.token});
  }

  analysisAccess(): Promise<AnalysisAccess> {
    // Coalesce concurrent probes, including UI discovery while admitting an execution.
    return this.#discovery ??= analysisAccess().finally(() => {this.#discovery = undefined;});
  }

  startAnalysis(input: AnalysisJob): JobHandle {
    this.#assertOpen();
    const {language} = input;
    if (language !== 'node' && language !== 'python') throw new CsvJobError('INVALID_INPUT','Unsupported analysis language.');
    if (!Array.isArray(input.inputs) || input.inputs.length > ANALYSIS_LIMITS.maxFiles) throw new CsvJobError('INVALID_INPUT','Too many input files.');
    const names = validateOutputNames(input.inputs.map(f=>f.name));
    const outputs = validateOutputNames(input.outputs);
    const [scriptName] = validateOutputNames([input.script.name]);
    if (!scriptName || !(language === 'node' ? /\.(m?js|cjs)$/i : /\.py$/i).test(scriptName)) throw new CsvJobError('INVALID_INPUT','Script extension does not match interpreter.');
    const all = [scriptName,...names,...outputs].map(n=>n.toLowerCase());
    if (new Set(all).size !== all.length) throw new CsvJobError('INVALID_INPUT','Script, inputs and outputs must have distinct names.');
    let total=0;
    const snapshot = (f:AnalysisSnapshot) => {
      if (!(f.bytes instanceof Uint8Array) || f.bytes.length > ANALYSIS_LIMITS.fileBytes || (total+=f.bytes.length)>ANALYSIS_LIMITS.snapshotBytes) throw new CsvJobError('INVALID_INPUT','Analysis snapshot exceeds limit.');
      return {name:f.name,bytes:Buffer.from(f.bytes)};
    };
    if (input.args !== undefined && (!Array.isArray(input.args) || input.args.length>ANALYSIS_LIMITS.maxArgs)) throw new CsvJobError('INVALID_INPUT','Invalid script arguments.');
    const args = Object.freeze(Array.from(input.args ?? [],arg=>{
      if (typeof arg!=='string' || arg.includes('\0') || Buffer.byteLength(arg)>ANALYSIS_LIMITS.argBytes) throw new CsvJobError('INVALID_INPUT','Invalid script argument.');
      return arg;
    }));
    const script=snapshot(input.script), inputs=input.inputs.map(snapshot);
    const receipts = inputs.map((f,i)=>{
      const prior=input.inputs[i];
      return Object.freeze({name:f.name,sha256:sha256(f.bytes),...(prior?.fileId!==undefined || prior?.versionId!==undefined ?
        {fileId:text(prior.fileId,'file ID'),versionId:text(prior.versionId,'version ID')}:{})});
    });
    const job = {projectId:text(input.projectId,'project ID'),sessionId:text(input.sessionId,'session ID'),taskId:text(input.taskId,'task ID'),
      requestId:text(input.requestId,'request ID'),attemptId:text(input.attemptId,'attempt ID'),toolId:text(input.toolId,'tool ID'),
      analysis:Object.freeze({language,script:script.name,inputs:Object.freeze(receipts),outputs,limits:ANALYSIS_LIMITS}),args};
    return this.#admit(job,{language,script,inputs,outputs,args});
  }

  #admit(job: Identity & Partial<Pick<JobAttempt,'grantId'|'column'|'analysis'|'args'|'toolArguments'|'externalMcp'>>, analysis?: SandboxJob, registration?: Registration, external?:Pending['external']):JobHandle {
    const key = attemptKey(job);
    if (this.#known.has(key)) throw new CsvJobError('DUPLICATE_ATTEMPT', 'Job attempt IDs cannot be reused.');
    if (this.#queue.length >= MCP_LIMITS.queue) throw new CsvJobError('QUEUE_FULL', 'The job queue is full.');
    this.#known.add(key);
    const { promise: result, resolve } = Promise.withResolvers<JobAttempt>();
    const externalIdentity=external ? {registryVersion:1,server:external.server.verification.serverInfo.name,displayName:external.server.definition.name,
      version:external.server.verification.serverInfo.version,protocol:external.server.verification.protocolVersion,tool:external.tool,
      alias:'external:'+external.server.id+':'+external.tool,resultKind:'mcp-result',phase:'initialize' as const} : undefined;
    const pending: Pending = { result, resolve, analysis, registration, external, attempt: Object.freeze({ ...job,
      ...(externalIdentity ? {mcp:externalIdentity,externalDispatch:'pending' as const} : registration ? { mcp: { ...registration.binding.identity, phase: 'initialize' as const } } : {}),
      program: external ? 'External MCP' : analysis ? analysis.language : process.execPath, args: job.args ?? Object.freeze([]),
      cwd: null, env: external ? {} : analysis ? analysisEnv : ENV,
      limits: external ? {...this.#limits,artifactBytes:EXTERNAL_MCP_LIMITS.responseBytes+16*1024,timeoutMs:external.server.definition.timeoutMs ?? 10000} : this.#limits, pid: null, status: 'queued', startedAt: null, endedAt: null,
      exitCode: null, signal: null, cancellation: 'not_requested', stdout: '', stderr: '' }) };
    this.#queue.push(pending);
    this.#admitting++;
    try {
      // Admission is the host's synchronous persistence boundary. A failed
      // observer may have already written the receipt; keep the ID reserved.
      this.#observer?.({ type: 'process_queued', attempt: pending.attempt });
    } catch (error) {
      const index = this.#queue.indexOf(pending);
      if (index >= 0) this.#queue.splice(index, 1);
      throw error;
    } finally {
      this.#admitting--;
      this.#drain();
    }
    return { result, cancel: () => this.#stop(pending, 'cancelled') };
  }

  /** Only persisted, session-authorized artifact records should reach the runner. */
  async download(artifact: McpArtifact): Promise<Buffer> {
    const { id, projectId, sessionId, attemptId, bytes, sha256: digest } = artifact;
    // External outputs have a self-contained immutable receipt. A plugin may
    // be updated or removed after publication without breaking past downloads.
    const binding = artifact.receiptKind==='external-mcp-v1'
      ? {outputName:'mcp-result.json',mimeType:'application/json',outputBytes:EXTERNAL_MCP_LIMITS.responseBytes+16*1024}
      : builtins.get(artifact.mcpAlias ?? csvRegistration.binding.identity.alias)?.binding;
    if (artifact.receiptKind !== undefined && artifact.receiptKind !== 'external-mcp-v1') throw new CsvJobError('ARTIFACT_DENIED','Unknown artifact receipt format.');
    if (!binding || !UUID.test(id) || !SHA256.test(digest) || artifact.name !== binding.outputName || artifact.mimeType !== binding.mimeType
      || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > binding.outputBytes) {
      throw new CsvJobError('ARTIFACT_DENIED', 'Invalid MCP artifact reference.');
    }
    try {
      const directory = join(await this.#root('attempts'), attemptKey({ projectId, sessionId, attemptId }));
      const receipt: unknown = JSON.parse((await readBounded(directory, 'artifact.json', 8 * 1024)).toString('utf8'));
      if (!object(receipt) || receipt.id !== id || receipt.projectId !== projectId || receipt.sessionId !== sessionId
        || receipt.attemptId !== attemptId || receipt.bytes !== bytes || receipt.sha256 !== digest
        || receipt.mcpAlias !== artifact.mcpAlias || receipt.name !== artifact.name || receipt.mimeType !== artifact.mimeType || receipt.receiptKind !== artifact.receiptKind) {
        throw new CsvJobError('ARTIFACT_DENIED', 'MCP artifact reference does not match its receipt.');
      }
      const content = await readBounded(directory, binding.outputName, binding.outputBytes);
      if (content.length !== bytes || sha256(content) !== digest) throw new CsvJobError('ARTIFACT_DENIED', 'MCP artifact failed verification.');
      return content;
    } catch (error) {
      if (error instanceof CsvJobError && error.code === 'ARTIFACT_DENIED') throw error;
      throw new CsvJobError('ARTIFACT_DENIED', 'MCP artifact is unreadable or failed verification.', { cause: error });
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    const jobs = [...this.#queue, ...this.#active];
    this.#closePromise = Promise.all(jobs.map(job => job.result)).then(() => {});
    for (const job of jobs) this.#stop(job, 'cancelled');
    return this.#closePromise;
  }

  #root(kind: 'grants' | 'attempts'): Promise<string> {
    return privateDirectory(this.#directory).then(root => privateDirectory(join(root, kind)));
  }

  #assertOpen(): void {
    if (this.#closed || this.#halted) throw new CsvJobError('CLOSED', 'The job runner is not accepting work.');
  }

  #emit(event: JobEvent): void {
    try {
      this.#observer?.(event);
    } catch (error) {
      process.emitWarning('The job event observer failed.', { code: 'CSV_OBSERVER_FAILED', detail: error instanceof Error ? error.message : String(error) });
    }
  }

  #finish(pending: Pending, result: Partial<JobAttempt> & { readonly status: JobAttempt['status'] }): void {
    let attempt: JobAttempt = Object.freeze({ ...pending.attempt, ...result, endedAt: Date.now() });
    let haltQueue = false;
    pending.terminate = undefined;
    pending.attempt = attempt;
    try {
      // Completion publishes artifacts in the same transaction as the terminal
      // process record. A computed file alone is not a successful publication.
      this.#observer?.({ type: 'process_finished', attempt });
    } catch {
      attempt = Object.freeze({ ...attempt, status: 'failed', artifact: undefined, artifacts: undefined,
        ...(attempt.externalMcp ? {externalFailure:'outcome_unknown' as const} : {}),
        error: 'Could not persist process completion. Result artifacts were not published.' });
      pending.attempt = attempt;
      try {
        this.#observer?.({ type: 'process_finished', attempt });
      } catch (error) {
        // Never leave promises or queued work waiting on an unavailable store.
        haltQueue = !this.#halted;
        this.#halted = true;
        process.emitWarning('The failed process completion could not be persisted.', {
          code: 'CSV_COMPLETION_PERSIST_FAILED', detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.#active.delete(pending);
    pending.resolve(attempt);
    if (haltQueue) for (const queued of [...this.#queue]) this.#stop(queued, 'cancelled');
    this.#drain();
  }

  #stop(pending: Pending, reason: StopReason): void {
    if (pending.stop || pending.attempt.endedAt !== null) return;
    if (pending.exited && reason !== 'output_limit') {
      // A clean worker exit can precede asynchronous verification and receipt persistence.
      if ((pending.registration || pending.external) && reason === 'cancelled') pending.cancelBeforePublication = true;
      return;
    }
    pending.stop = reason;
    const index = this.#queue.indexOf(pending);
    if (index >= 0) {
      this.#queue.splice(index, 1);
      this.#finish(pending, { status: 'cancelled', cancellation: 'confirmed' });
    } else {
      pending.terminate?.();
    }
  }

  #drain(): void {
    while (!this.#closed && !this.#halted && !this.#admitting && this.#active.size < this.#concurrency) {
      const pending = this.#queue.shift();
      if (!pending) break;
      this.#active.add(pending);
      void this.#run(pending);
    }
  }

  async #run(pending: Pending): Promise<void> {
    const job = pending.attempt;
    let processResult: ProcessResult | undefined;
    try {
      const cwd = join(await this.#root('attempts'), attemptKey(job));
      // An existing directory is an attempt receipt, even if a previous host crashed mid-write.
      await mkdir(cwd, { mode: 0o700 });
      if (pending.stop) {
        this.#finish(pending, { status: 'cancelled', cancellation: 'confirmed' });
        return;
      }
      if (pending.analysis) {
        await this.#runAnalysis(pending,pending.analysis,cwd);
        return;
      }
      if (pending.external) {
        await this.#runExternal(pending,pending.external,cwd);
        return;
      }
      const registration = pending.registration;
      if (!registration) throw new CsvJobError('INVALID_INPUT','Missing MCP registration.');
      const binding = registration.binding;
      if (!job.grantId) throw new CsvJobError('GRANT_DENIED','Missing MCP grant ID.');
      const grantDir = join(await this.#root('grants'), job.grantId);
      let grant: McpGrant;
      let bytes: Buffer;
      try {
        grant = parseGrant(await readBounded(grantDir, 'grant.json', 8 * 1024), job.grantId, {
          projectId: job.projectId, sessionId: job.sessionId,
        });
        if ((grant.mcpAlias ?? csvRegistration.binding.identity.alias) !== binding.identity.alias || !registration.acceptsFile(grant.name)) {
          throw new CsvJobError('GRANT_DENIED','Input grant belongs to a different tool.');
        }
        bytes = await readBounded(grantDir, binding.inputName, binding.inputBytes);
        if (bytes.length !== grant.bytes || sha256(bytes) !== grant.sha256) {
          throw new CsvJobError('GRANT_DENIED', 'MCP input failed grant verification.');
        }
      } catch (error) {
        if (error instanceof CsvJobError && error.code === 'GRANT_DENIED') throw error;
        throw new CsvJobError('GRANT_DENIED', 'MCP input grant is unavailable to this project and session.', { cause: error });
      }

      const inputPath = join(cwd, binding.inputName);
      const outputPath = join(cwd, binding.outputName);
      const worker = runtimeFile(binding.worker);
      const modules = [worker, runtimeFile('mcp-contract.mjs'), runtimeFile('mcp-worker.mjs')];
      const args = Object.freeze([
        '--permission', ...modules.map(path => `--allow-fs-read=${path}`), `--allow-fs-read=${inputPath}`, `--allow-fs-write=${outputPath}`,
        `--max-old-space-size=${MCP_LIMITS.heapMiB}`, '--disallow-code-generation-from-strings', '--no-addons',
        '--', worker,
      ]);
      await writeFile(inputPath, bytes, { flag: 'wx', mode: 0o400 });
      if (pending.stop) {
        this.#finish(pending, { status: 'cancelled', cancellation: 'confirmed' });
        return;
      }
      pending.attempt = Object.freeze({ ...pending.attempt, cwd, args, grant });
      processResult = await this.#execute(pending, cwd, args, registration);
      const { exitCode, signal, termination, stop, error } = processResult;
      const exit = { exitCode, signal, cancellation: termination };
      if (termination === 'unknown') {
        // Do not refill a slot when the old process might still exist.
        this.#halted = true;
        for (const queued of [...this.#queue]) this.#stop(queued, 'cancelled');
      }
      switch (stop) {
        case 'cancelled': case 'timed_out':
          this.#finish(pending, { ...exit, status: stop,
            error: stop === 'timed_out' ? 'MCP process exceeded its time limit.' : undefined });
          return;
        case 'output_limit':
          this.#finish(pending, { ...exit, status: 'failed', error: 'MCP process exceeded a stdout or stderr byte limit.' });
          return;
        case undefined:
          break;
      }
      if (exitCode !== 0 || signal !== null || error) {
        this.#finish(pending, { ...exit, status: 'failed', error: error ?? 'MCP process did not exit successfully.' });
        return;
      }
      const content = await readBounded(cwd, binding.outputName, binding.outputBytes);
      const digest = verifyMcpOutput(registration, content, processResult.outputDigest);
      const artifact: McpArtifact = Object.freeze({ id: randomUUID(), projectId: job.projectId, sessionId: job.sessionId,
        attemptId: job.attemptId, mcpAlias:binding.identity.alias, name: binding.outputName, mimeType: binding.mimeType, bytes: content.length, sha256: digest });
      await writeFile(join(cwd, 'artifact.json'), JSON.stringify(artifact), { flag: 'wx', mode: 0o400 });
      if (pending.cancelBeforePublication) {
        await rm(join(cwd, 'artifact.json'));
        this.#finish(pending, { ...exit, status: 'cancelled', cancellation: 'confirmed' });
        return;
      }
      this.#finish(pending, { ...exit, status: 'succeeded', artifact });
    } catch (error) {
      if (!processResult && pending.stop) {
        this.#finish(pending, { status: 'cancelled', cancellation: 'confirmed' });
      } else {
        this.#finish(pending, { status: 'failed', exitCode: processResult?.exitCode ?? null, signal: processResult?.signal ?? null,
          error: error instanceof Error ? error.message : 'Job attempt failed.' });
      }
    }
  }

  async #runExternal(pending:Pending,external:NonNullable<Pending['external']>,cwd:string):Promise<void> {
    const ctl=new AbortController();
    pending.terminate=()=>ctl.abort();
    let dispatched=false;
    const timeout=setTimeout(()=>this.#stop(pending,'timed_out'),pending.attempt.limits.timeoutMs);
    try {
      if (pending.stop) ctl.abort();
      ctl.signal.throwIfAborted();
      pending.attempt=Object.freeze({...pending.attempt,status:'running',startedAt:Date.now()});
      this.#emit({type:'process_started',attempt:pending.attempt});
      const result=await callExternalMcp(external.server.definition,external.server.verification,external.tool,external.arguments,{
        token:external.token,signal:ctl.signal,onPhase:phase=>{
          const attempt=Object.freeze({...pending.attempt,mcp:{...pending.attempt.mcp!,phase},
            ...(phase==='tools/call'?{externalDispatch:'dispatching' as const}:{})});
          const event:JobEvent={type:'process_output',attempt,stream:'stdout',text:'MCP '+phase+'\n'};
          if (phase==='tools/call') {
            // Invoke the publication observer synchronously. The HTTP request
            // is never sent if its write-ahead dispatch receipt cannot commit.
            this.#observer?.(event);
            dispatched=true;
          } else this.#emit(event);
          pending.attempt=attempt;
        },
      });
      ctl.signal.throwIfAborted();
      pending.exited=true;
      const server=external.server;
      const content=Buffer.from(JSON.stringify({schemaVersion:1,kind:'external-mcp-result',
        server:{id:server.id,name:server.verification.serverInfo.name,version:server.verification.serverInfo.version,
          pluginId:server.pluginId,pluginRevision:server.pluginRevision,verificationDigest:server.verification.digest},tool:external.tool,result}));
      if (content.length>pending.attempt.limits.artifactBytes) throw new Error('External MCP result exceeds the saved artifact limit.');
      const artifact:McpArtifact={id:randomUUID(),projectId:pending.attempt.projectId,sessionId:pending.attempt.sessionId,
        attemptId:pending.attempt.attemptId,mcpAlias:pending.attempt.mcp!.alias,receiptKind:'external-mcp-v1',name:'mcp-result.json',mimeType:'application/json',bytes:content.length,sha256:sha256(content)};
      await writeFile(join(cwd,artifact.name),content,{flag:'wx',mode:0o400});
      await writeFile(join(cwd,'artifact.json'),JSON.stringify(artifact),{flag:'wx',mode:0o400});
      if (pending.cancelBeforePublication || pending.stop || ctl.signal.aborted) {
        await rm(join(cwd,'artifact.json'));
        this.#finish(pending,{status:pending.stop==='timed_out'?'timed_out':'cancelled',cancellation:'unknown',externalFailure:'outcome_unknown',error:'Result publication was cancelled. Remote completion cannot be confirmed.'});
        return;
      }
      this.#finish(pending,{status:'succeeded',artifact});
    } catch(error) {
      const message=error instanceof Error ? error.message : 'External MCP call failed.';
      const safe=external.token ? message.replaceAll(external.token,'[redacted]') : message;
      const timedOut=pending.stop==='timed_out' || error instanceof Error && error.name==='TimeoutError';
      let externalFailure: JobAttempt['externalFailure'];
      if (dispatched) {
        // A lost response or invalid receipt cannot establish whether remote side effects happened.
        externalFailure = error instanceof ExternalMcpError && error.code === 'MCP_TOOL_FAILED' ? 'tool_error' : 'outcome_unknown';
      } else if (pending.stop !== 'cancelled') {
        externalFailure = timedOut || isTransientExternalConnectionError(error) ? 'connection' : 'blocked';
      }
      this.#finish(pending,{status:timedOut?'timed_out':pending.stop==='cancelled'?'cancelled':'failed',
        externalFailure,
        cancellation:pending.stop || timedOut ? dispatched?'unknown':'confirmed' : 'not_requested',
        error:pending.stop==='cancelled' ? dispatched?'Request cancelled locally. The external server may still have completed the operation.':undefined
          :timedOut?'External MCP call exceeded its time limit; it will not be replayed automatically.':safe});
    } finally { clearTimeout(timeout); }
  }

  async #runAnalysis(pending:Pending, job:SandboxJob, cwd:string):Promise<void> {
    const ctl=new AbortController();
    pending.terminate=()=>ctl.abort();
    let exitCode:number|null=null;
    let exitSignal:NodeJS.Signals|null=null;
    let cancellation:JobAttempt['cancellation']='not_requested';
    let artifacts:readonly AnalysisArtifact[]|undefined;
    let failure:string|undefined;
    try {
      const access=await this.analysisAccess();
      if (!access.available) throw new Error('Offline analysis unavailable: '+access.reason);
      ctl.signal.throwIfAborted();
      const meta=pending.attempt.analysis;
      if (!meta) throw new Error('Missing analysis metadata.');
      const program=access[job.language];
      pending.attempt=Object.freeze({...pending.attempt,cwd:'/workspace',program:program.path,
        args:Object.freeze(['/workspace/'+job.script.name,...job.args ?? []]),
        analysis:Object.freeze({...meta,backend:'wasi',engine:access.engine,version:program.version})});
      const result=await runSandbox({job,cwd,timeoutMs:this.#limits.timeoutMs,signal:ctl.signal,
        started:(id,pid)=>{pending.attempt=Object.freeze({...pending.attempt,status:'running',startedAt:Date.now(),executionId:id,pid});
          this.#emit({type:'process_started',attempt:pending.attempt});},
        output:(stream,text)=>{pending.attempt=Object.freeze({...pending.attempt,[stream]:pending.attempt[stream]+text});
          this.#emit({type:'process_output',attempt:pending.attempt,stream,text});},
        stop:reason=>this.#stop(pending,reason)});
      exitCode=result.exitCode;
      exitSignal=result.signal;
      // Unix may deliver the cumulative native CPU limit before the wall or
      // guest-epoch watchdog exits. It is still a confirmed execution timeout.
      if (exitSignal === 'SIGXCPU') this.#stop(pending,'timed_out');
      ctl.signal.throwIfAborted();
      pending.exited=true;
      const phase = result.started ? 'during analysis' : 'before the interpreter was ready';
      if (exitSignal) throw new Error(`Analysis process terminated by ${exitSignal} ${phase}.`);
      if (exitCode === 126) throw new Error('The sandbox exceeded its native memory limit or memory accounting failed.');
      if (!result.started) throw new Error(`Analysis process exited with code ${exitCode} ${phase}.`);
      if (exitCode !== 0) throw new Error(`Analysis interpreter returned ${exitCode}.`);
      const produced=await Promise.all(job.outputs.map(async name=>{
        const bytes=await readBounded(join(cwd,'outputs'),name,ANALYSIS_LIMITS.fileBytes).catch(error=>{
          if (errorCode(error)==='ENOENT') throw new Error('Declared output was not written: '+name);
          throw error;
        });
        return {name,bytes};
      }));
      await rm(join(cwd,'outputs'),{recursive:true,force:true}).catch(error=>{
        throw new SandboxCleanupError('Could not remove the analysis output scratch directory.', {cause:error});
      });
      artifacts=Object.freeze(await this.#files.publish(pending.attempt,job.outputs,produced,job.script));
    } catch(error) {
      failure=error instanceof Error ? error.message : 'Analysis execution failed.';
      if (error instanceof SandboxCleanupError) {
        cancellation='unknown'; this.#halted=true;
        for (const queued of [...this.#queue]) this.#stop(queued,'cancelled');
      } else if (pending.stop) cancellation='confirmed';
      if (!(error instanceof SandboxCleanupError)) {
        try { await rm(join(cwd,'outputs'),{recursive:true,force:true}); }
        catch (cleanupError) {
          if (!(cleanupError instanceof Error)) throw cleanupError;
          failure='Could not remove the analysis output scratch directory.';
          this.#halted=true;
          for (const queued of [...this.#queue]) this.#stop(queued,'cancelled');
        }
      }
    }
    const stop=pending.stop;
    const status=cancellation==='unknown' ? 'failed' : stop==='output_limit' ? 'failed' : stop ?? (failure ? 'failed' : 'succeeded');
    const timeoutError=pending.attempt.startedAt === null
      ? 'The analysis runtime did not become ready before its startup deadline.'
      : 'Analysis exceeded its time limit.';
    const error=cancellation==='unknown' ? failure : stop==='output_limit' ? 'Analysis exceeded its output limit.' :
      stop==='timed_out' ? timeoutError : stop==='cancelled' ? undefined : failure;
    this.#finish(pending,{status,exitCode,signal:exitSignal,artifacts,cancellation,error});
  }

  #execute(pending: Pending, cwd: string, args: readonly string[], registration:Registration): Promise<ProcessResult> {
    const child = spawn(pending.attempt.program, args, { cwd, env: ENV, shell: false,
      detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    return new Promise(resolveResult => {
      let ended = false;
      let signalled = false;
      let exitCode: number | null = null;
      let signal: NodeJS.Signals | null = null;
      let error: string | undefined;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      const stdout = { size: 0, text: '', decoder: new StringDecoder('utf8') };
      const stderr = { size: 0, text: '', decoder: new StringDecoder('utf8') };

      const output = (stream: 'stdout' | 'stderr', text: string) => {
        if (text) this.#emit({ type: 'process_output', attempt: pending.attempt, stream, text });
      };
      const consume = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        const sink = stream === 'stdout' ? stdout : stderr;
        const remaining = MCP_LIMITS.streamBytes - sink.size;
        const accepted = chunk.subarray(0, remaining);
        const fragment = sink.decoder.write(accepted);
        sink.size += accepted.length;
        sink.text += fragment;
        output(stream, fragment);
        if (chunk.length > remaining) {
          // The normal worker emits only short, fixed messages; protect both pipes even if it regresses.
          this.#stop(pending, 'output_limit');
        }
      };

      const client = mcpClient(child.stdin, registration, pending.attempt.toolId, pending.attempt.toolArguments ?? {}, phase => {
        pending.attempt = Object.freeze({ ...pending.attempt, mcp: { ...registration.binding.identity, phase } });
        consume('stdout', Buffer.from('MCP ' + phase + '\n'));
      });
      let wireBytes = 0;
      const wireDecoder = new StringDecoder('utf8');
      child.stdin.on('error', failure => { error ??= 'MCP input pipe closed: ' + failure.message; });
      const settle = () => {
        if (ended) return;
        ended = true;
        clearTimeout(timeout);
        clearTimeout(stopTimer);
        // Probe only this freshly spawned child's process group, and only after observing its exit.
        const pid = child.pid;
        let termination: ProcessResult['termination'] = pending.stop ? 'unknown' : 'not_requested';
        if (pending.stop && pid === undefined) termination = 'confirmed';
        if (pending.stop && pending.exited && pid !== undefined && (signalled || pending.stop === 'output_limit')) {
          // The permission-confined, fixed MCP worker cannot spawn children.
          // Windows has no POSIX process groups; observing its exit confirms
          // termination of this sole process, without PID-based tree killing.
          if (process.platform === 'win32') termination = 'confirmed';
          else try { process.kill(-pid, 0); } catch (failure) { if (errorCode(failure) === 'ESRCH') termination = 'confirmed'; }
        }
        for (const [stream, sink] of [['stdout', stdout], ['stderr', stderr]] as const) {
          const rest = sink.decoder.end();
          sink.text += rest;
          output(stream, rest);
        }
        pending.attempt = Object.freeze({ ...pending.attempt, stdout: stdout.text, stderr: stderr.text });
        const outputDigest = client.digest();
        if (!pending.stop && !error && !outputDigest) error = 'MCP server closed before a successful tools/call response.';
        resolveResult({ exitCode, signal, termination, stop: pending.stop, error, outputDigest });
      };

      const timeout = setTimeout(() => this.#stop(pending, 'timed_out'), this.#limits.timeoutMs);
      pending.terminate = () => {
        const pid = child.pid;
        if (pid !== undefined && !pending.exited && child.exitCode === null && child.signalCode === null) {
          try { signalled = process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-pid, 'SIGKILL'); } catch (failure) {
            if (errorCode(failure) !== 'ESRCH') error = 'Could not signal the live MCP process group.';
          }
        }
        stopTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          settle();
        }, MCP_LIMITS.killWaitMs);
      };
      child.once('spawn', () => {
        pending.attempt = Object.freeze({ ...pending.attempt, status: 'running', pid: child.pid ?? null, startedAt: Date.now() });
        this.#emit({ type: 'process_started', attempt: pending.attempt });
        if (!pending.stop) client.initialize();
      });
      child.once('error', failure => { error = `MCP process failed to launch: ${failure.message}`; });
      child.once('exit', (code, terminatingSignal) => {
        pending.exited = true;
        exitCode = code;
        signal = terminatingSignal;
        if (!stopTimer) {
          clearTimeout(timeout);
          // The fixed worker cannot spawn children. Still bound pipe drain if that assumption is violated.
          stopTimer = setTimeout(() => {
            error = 'MCP process exited without closing its output pipes.';
            child.stdout.destroy();
            child.stderr.destroy();
            settle();
          }, MCP_LIMITS.killWaitMs);
        }
      });
      child.once('close', settle);
      child.stdout.on('data', (chunk: Buffer) => {
        if (error || pending.stop) return;
        wireBytes += chunk.length;
        if (wireBytes > MCP_LIMITS.streamBytes) { this.#stop(pending, 'output_limit'); return; }
        try { client.consume(wireDecoder.write(chunk)); }
        catch (failure) {
          error = failure instanceof Error ? failure.message : 'Invalid MCP response.';
          if (!client.finished) pending.terminate?.();
        }
      });
      child.stderr.on('data', chunk => consume('stderr', chunk));
    });
  }
}

export { JobRunner as CsvJobRunner };
export type { JobRunnerOptions as CsvJobRunnerOptions, JobEvent as CsvJobEvent,
  JobAttempt as CsvAttempt, McpArtifact as CsvArtifact, McpGrant as CsvGrant };
