import type { WorkspaceSnapshot, SessionActivation, AthenaTaskManager } from './task-manager.d.ts';
import type { ConnectionSnapshot } from './connections.d.ts';
import type { FileReference, InputContract } from './pi-bridge-contracts.d.ts';
import type { ModelProfileInput, WorkerModelPreference } from './model-profiles.d.ts';

/** JSON only. The browser supplies subscribe/request methods after activation. */
export type WireSessionActivation = Omit<SessionActivation, 'connection'>;
export interface EventCursor { readonly epoch: string; readonly sequence: number }
export interface HostBootstrap {
  readonly snapshot: WorkspaceSnapshot;
  readonly execution?: WorkspaceSnapshot['execution'];
  /** Absent only on legacy M1 hosts and fixtures. */
  readonly cursor?: EventCursor;
  readonly connection: ConnectionSnapshot;
  readonly capabilities: readonly (AthenaTaskManager['capabilities'][number] | 'system_web_links' | 'native_oauth_browser')[];
  /** Includes stage_files only when the host can stage and resolve attachments. */
  readonly piCapabilities: readonly string[];
  readonly inputContract?: InputContract;
}
export interface StagedWireFile {
  readonly name: string;
  readonly mimeType: string;
  /** Base64 encoded bytes, without a data URL prefix. */
  readonly data: string;
}
export interface PiCommand {
  readonly type: string;
  readonly id?: string;
  readonly [parameter: string]: unknown;
}
export interface PiResponse {
  readonly type: 'response';
  readonly command: string;
  readonly id?: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}
export type HostRpcRequest =
  | { readonly method: 'openWebAddress'; readonly args: readonly [address: string] }
  | { readonly method: 'createProject'; readonly args: readonly [Parameters<NonNullable<AthenaTaskManager['createProject']>>[0]] }
  | { readonly method: 'createSession'; readonly args: readonly [Parameters<NonNullable<AthenaTaskManager['createSession']>>[0]] }
  | { readonly method: 'openSession'; readonly args: readonly [string] }
  | { readonly method: 'cancelRun' | 'cancelTask'; readonly args: readonly [string] }
  | { readonly method: 'getAgentHistory'; readonly args: readonly [conversationId: string, agentSessionId: string] }
  | { readonly method: 'setProjectDefaultModel'; readonly args: Parameters<NonNullable<AthenaTaskManager['setProjectDefaultModel']>> }
  | { readonly method: 'verifyConnection' | 'saveConfig'; readonly args: readonly [unknown] }
  | { readonly method: 'listProviders'; readonly args: readonly [query?: string] }
  | { readonly method: 'getProviderCatalog'; readonly args: readonly [providerId: string, options?: { readonly query?: string; readonly refresh?: boolean; readonly accountRef?: string | null }] }
  | { readonly method: 'saveProviderApiKey'; readonly args: readonly [providerId: string, key: string] }
  | { readonly method: 'importLegacyCredentials'; readonly args: readonly [confirmed: true] }
  | { readonly method: 'logoutProvider'; readonly args: readonly [providerId: string] }
  | { readonly method: 'startProviderOAuth'; readonly args: readonly [providerId: string, accountRef?: string] }
  | { readonly method: 'listChatGPTAccounts'; readonly args: readonly [] }
  | { readonly method: 'openChatGPTUsage'; readonly args: readonly [] }
  | { readonly method: 'signOutChatGPTAccount'; readonly args: readonly [accountRef: string] }
  | { readonly method: 'getProviderOAuth' | 'cancelProviderOAuth' | 'openProviderOAuthBrowser'; readonly args: readonly [flowId: string] }
  | { readonly method: 'listModelProfiles'; readonly args: readonly [] }
  | { readonly method: 'saveModelProfile'; readonly args: readonly [ModelProfileInput] }
  | { readonly method: 'deleteModelProfile'; readonly args: readonly [id: string, revision: number] }
  | { readonly method: 'setWorkerModelPreference'; readonly args: readonly [WorkerModelPreference] }
  | { readonly method: 'listLibrarySources'; readonly args: readonly [{ readonly projectId:string }] }
  | { readonly method: 'searchAndSavePapers'; readonly args: readonly [{ readonly projectId:string; readonly sessionId:string; readonly mode:'query'|'doi'; readonly term:string; readonly requestId:string }] }
  | { readonly method: 'setAppModelProfile'; readonly args: readonly [id: string | null] }
  | { readonly method: 'setProjectModelProfile' | 'setConversationModelProfile'; readonly args: readonly [scopeId: string, profileId: string | null] }
  | { readonly method: 'verifyModelProfile'; readonly args: readonly [profileId: string] }
  | { readonly method: 'registerCompatibleEndpoint'; readonly args: readonly [{ readonly name: string; readonly endpoint: string; readonly apiKey?: string }] }
  | { readonly method: 'pi'; readonly args: readonly [string, PiCommand] }
  | { readonly method: 'stageFiles'; readonly args: readonly [string, readonly StagedWireFile[]] };
export type HostRpcResponse<T = unknown> = { readonly result: T } | { readonly error: string; readonly code?: string };
export type HostEvent =
  | { readonly type: 'snapshot'; readonly snapshot: WorkspaceSnapshot }
  | { readonly type: 'connection'; readonly connection: ConnectionSnapshot }
  | { readonly type: 'pi'; readonly sessionId: string; readonly event: Readonly<Record<string, unknown>> };
export type SequencedHostEvent = EventCursor & (HostEvent | { readonly type: 'reset' });
export interface StagedFilesResult { readonly fileReferences: readonly FileReference[] }
