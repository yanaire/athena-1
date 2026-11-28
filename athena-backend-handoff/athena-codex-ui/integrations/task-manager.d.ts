/** UI projection contract. All scheduling, retries and persistence belong to Athena TaskManager. */
export type ModelReference = { provider: string; modelId: string; thinkingLevel?: string | null; profileId?: string;
  configurationRevision?: number; source?: 'conversation' | 'project' | 'app' | 'host' | 'role'; endpoint?: string; api?: string; authMode?: 'chatgpt'; authRef?: string };
export type VersionRef = { id: string; version: string };
export type Scope = { projectId: string; sessionId: string; runId?: string | null };
export type ExecutionScope = Scope & { readonly taskId: string; readonly parentTaskId: string | null; readonly attemptId: string; readonly agentSessionId: string };
export type Status = 'ready' | 'queued' | 'running' | 'blocked' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
export interface Project { folder?: {path:string;branch?:string}; researchWorkflow?:boolean; id: string; name: string; defaultModel?: ModelReference | null; defaultProfileId?: string | null; offlineAnalysis?: boolean }
export interface Session { id: string; projectId: string; title: string; model?: ModelReference | null; profileId?: string | null }
export interface Task extends Scope, Partial<Omit<ExecutionScope, keyof Scope | 'taskId'>> { id: string; title: string; status: Status; dependencies: string[]; toolIds: string[]; artifactIds: string[]; role?: string; agentName?: string; progress?: number; total?: number; readonly retryable?: boolean; readonly retryUnavailableReason?: string }
export interface Agent extends Scope, Partial<Omit<ExecutionScope, keyof Scope | 'taskId'>> { id: string; taskId: string; name: string; role: string; status: Status; model?: ModelReference }
export interface Tool extends Scope, Partial<Omit<ExecutionScope, keyof Scope | 'taskId'>> { id: string; taskId?: string | null; name: string; sdkToolName: string; status: Status; command?: string; cwd?: string; args?: unknown; logs: { at: number; text: string }[]; exitCode?: number | null }
export interface Artifact extends Scope, Partial<Omit<ExecutionScope, keyof Scope | 'taskId'>> { id: string; readonly processId?: string; readonly toolId?: string; readonly file?: ResultFile; readonly name?: string; readonly sha256?: string; readonly bytes?: number; version: string; taskId?: string; title: string; kind: string; status: string; documentId?: string; documentVersion?: string; text?: string; location?: { uri: string; label?: string }; review: { status: 'unreviewed' | 'in_review' | 'approved' | 'rejected'; version: string }; evidence: VersionRef[] }
export interface ResultFile extends Scope { readonly id: string; readonly attemptId: string; readonly name: string; readonly versionId?: string; readonly mimeType: string; readonly bytes: number; readonly sha256: string; readonly mcpAlias?: string; readonly receiptKind?: 'external-mcp-v1' }
export interface Attempt extends ExecutionScope { readonly workerRole?: import('./model-profiles.d.ts').WorkerRoleKey; readonly id: string; readonly status: Status; readonly prompt?: string; readonly result?: string; readonly error?: string; readonly acceptedAt?: number; readonly startedAt?: number | null; readonly endedAt?: number | null; readonly fileIds: readonly string[]; readonly model?: ModelReference; readonly kind?: 'reconciliation'; readonly retryOfAttemptId?: string }
/** Reuse the request ID when the response is uncertain, including after reload. */
export interface TaskRetryRequest { readonly requestId: string; readonly expectedAttemptId: string }
export interface TaskRetryResult { readonly taskId: string; readonly parentTaskId: string; readonly agentSessionId: string; readonly attemptId: string; readonly runId: string; readonly status: 'queued'; readonly reconciliationAttemptId: string; readonly snapshot?: WorkspaceSnapshot }
/** Project policy is resolved by the host. Missing fields are unreported, never defaults. */
export interface Interpreter { readonly path: string; readonly version: string }
export interface ExecutionPolicy {
  readonly projectId: string | null; readonly enabled: boolean; readonly backend: 'wasi';
  readonly network: false; readonly shell: false; readonly limits: Readonly<Record<string, number>>;
  readonly runtime: { readonly available: false; readonly reason: string } | {
    readonly available: true; readonly engine: string;
    readonly node: Interpreter; readonly python: Interpreter;
  };
}
/** v1 metadata is supplied by the registered host; optional fields preserve historical CSV records. */
export interface ProcessMcp {
  readonly registryVersion?: number; readonly server: string; readonly displayName?: string;
  readonly version: string; readonly protocol: string; readonly tool: string;
  readonly alias?: string; readonly resultKind?: string;
  readonly phase: 'initialize' | 'tools/list' | 'tools/call';
}
export interface ProcessJob {
  readonly mcp?: ProcessMcp;
  readonly externalMcp?: { readonly serverId: string; readonly pluginId: string; readonly pluginRevision: string; readonly verificationDigest: string; readonly url: string; readonly tool: string; readonly argumentDigest?: string };
  readonly program?: string; readonly args?: readonly string[]; readonly cwd?: string | null;
  readonly limits?: Readonly<Record<string, number>>; readonly policy?: Readonly<Record<string, unknown>>;
  readonly pid?: number | null; readonly startedAt?: number | null; readonly endedAt?: number | null;
  readonly exitCode?: number | null; readonly signal?: string | null; readonly cancellation?: string;
  readonly stdout?: string; readonly stderr?: string; readonly error?: string;
  readonly artifact?: ResultFile; readonly artifacts?: readonly ResultFile[];
}
export interface Process extends ExecutionScope, ProcessJob {
  readonly id: string; readonly processId: string; readonly toolId: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
  readonly evidence?: readonly VersionRef[];
  readonly job?: ProcessJob;
}
export interface AgentHistory { readonly conversationId: string; readonly agentSessionId: string; readonly messages: readonly unknown[] }
export interface WorkspaceEvent extends Scope { id: string; type: string; at: number; summary: string; taskId?: string; agentId?: string; toolId?: string; artifactId?: string; artifactVersion?: string }
export interface Approval extends Scope { id: string; taskId?: string; status: 'pending' | 'approved' | 'rejected'; description: string; cwd?: string; scope: string; impact: string; command?: string }
export interface WorkspaceSnapshot {
  /** Monotonically increasing across this subscription, including session switches. */
  revision: number; projectId: string | null; sessionId: string | null;
  projects: Project[]; sessions: Session[];
  run: { id: string | null; status: Status; startedAt: number | null; elapsedMs: number; model: ModelReference | null };
  tasks: Task[]; agents: Agent[]; tools: Tool[]; artifacts: Artifact[]; events: WorkspaceEvent[]; approvals: Approval[];
  readonly execution?: ExecutionPolicy;
  readonly attempts?: readonly Attempt[]; readonly processes?: readonly Process[];
}
export interface SessionActivation { sessionId: string; projectId?: string; title?: string; model?: ModelReference; connection?: unknown; snapshot?: WorkspaceSnapshot }
export interface AthenaTaskManager {
  capabilities: ('create_project' | 'create_session' | 'open_session' | 'set_project_model' | 'set_project_execution' | 'retry_task' | 'cancel_run' | 'cancel_task' | 'get_agent_history' | 'decide_approval' | 'model_profiles' | 'extensions' | 'research_workflow')[];
  getSnapshot(): WorkspaceSnapshot | Promise<WorkspaceSnapshot>;
  subscribe(listener: (snapshot: WorkspaceSnapshot) => void): () => void;
  createProject?(input: { name: string; defaultModel?: ModelReference | null }): Promise<{ project: Project; snapshot?: WorkspaceSnapshot }>;
  createSession?(input: { projectId: string | null; title: string; model?: ModelReference | null; configurationId?: string }): Promise<SessionActivation>;
  openSession?(sessionId: string): Promise<SessionActivation>;
  setProjectDefaultModel?(projectId: string, model: ModelReference | null): Promise<{ saved: true; snapshot: WorkspaceSnapshot }>;
  setProjectExecution?(projectId: string, enabled: boolean): Promise<{ saved: true; snapshot: WorkspaceSnapshot }>;
  retryTask?(taskId: string, request: TaskRetryRequest): Promise<TaskRetryResult>;
  getAgentHistory?(conversationId: string, agentSessionId: string): Promise<AgentHistory>;
  cancelTask?(taskId: string): Promise<unknown>;
  cancelRun?(runId: string): Promise<unknown>;
  decideApproval?(approvalId: string, decision: 'approved' | 'rejected'): Promise<unknown>;
}
