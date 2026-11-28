import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createAgentSession, createExtensionRuntime, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, AssistantMessageEvent, Model, ModelThinkingLevel, ToolCall } from "@earendil-works/pi-ai";
import { createPiHostAdapter } from "../athena-backend-handoff/athena-codex-ui/integrations/pi-host-adapter.mjs";
import { createPiToolLoadout } from "./agent-tools.ts";
import type { PiOrchestration } from "./agent-tools.ts";
import { addCompatibleModels, compatibleEndpoint } from './compatible-model.ts';

export type { PiOrchestration } from "./agent-tools.ts";

export class PiRuntimeError extends Error {
  readonly code = "PI_RUNTIME_ERROR";
}

export interface EndpointConfig {
  readonly endpoint: string;
  readonly model: string;
  readonly provider: "athena";
  readonly modelReference: string;
  readonly loopback: boolean;
}

/** Operator configuration only; browser commands never select credential targets. */
export function endpointConfig(): EndpointConfig | undefined {
  const endpoint = process.env.ATHENA_ENDPOINT;
  if (!endpoint) return undefined;
  const model = process.env.ATHENA_MODEL;
  if (!model) throw new PiRuntimeError("ATHENA_MODEL is required with ATHENA_ENDPOINT.");
  const { url, loopback } = compatibleEndpoint(endpoint);
  return { endpoint: url, model, provider: "athena", modelReference: `athena/${model}`, loopback };
}

export function modelReference(): string | undefined {
  const config = endpointConfig();
  if (config) return config.modelReference;
  return process.env.ATHENA_PROVIDER && process.env.ATHENA_MODEL
    ? `${process.env.ATHENA_PROVIDER}/${process.env.ATHENA_MODEL}` : undefined;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Remove credential-bearing fields and accidental provider echoes at the public boundary. */
function publicText(text: string, redact: (text: string) => string): string {
  return redact(text).replace(/Bearer\s+[^\s"',]+/gi, "Bearer [redacted]");
}

function publicValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") {
    return publicText(value, redact);
  }
  if (Array.isArray(value)) return value.map(item => publicValue(item, redact));
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => item !== undefined && !/api.?key|token|secret|password|authorization|headers|credentials|environment|^env$/i.test(key))
    .map(([key, item]) => [key, publicValue(item, redact)]));
}

// Pi persists finalized assistant messages before Athena's public event filter runs.
// Scope redaction to strings here so raw Pi history remains a valid SDK transcript.
function scrubMessage(message: AssistantMessage, redact: (text: string) => string): AssistantMessage {
  type Json = ToolCall['arguments'][string];
  const scrub = (value: Json): Json => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), scrub(item)]));
    return value;
  };
  return { ...message, ...(message.errorMessage ? { errorMessage: redact(message.errorMessage) } : {}),
    content: message.content.map(part => {
      switch (part.type) {
        case 'text': return { ...part, text: redact(part.text) };
        case 'thinking': return { ...part, thinking: redact(part.thinking) };
        case 'toolCall': return { ...part, arguments: Object.fromEntries(Object.entries(part.arguments).map(([key, val]) => [redact(key), scrub(val)])) };
      }
    }) };
}

function scrubEvent(event: AssistantMessageEvent, redact: (text: string) => string,
  redactPartial: (text: string) => string, emitted: Map<number, string>): AssistantMessageEvent {
  switch (event.type) {
    case 'done': return { ...event, message: scrubMessage(event.message, redact) };
    case 'error': return { ...event, error: scrubMessage(event.error, redact) };
    case 'text_delta': case 'thinking_delta': {
      const partial = scrubMessage(event.partial, redactPartial);
      const part = partial.content[event.contentIndex];
      const safe = part?.type === 'text' ? part.text : part?.type === 'thinking' ? part.thinking : '';
      const previous = emitted.get(event.contentIndex) ?? '';
      emitted.set(event.contentIndex, safe);
      return { ...event, delta: safe.startsWith(previous) ? safe.slice(previous.length) : '', partial };
    }
    // Tool arguments remain available as sanitized structured values and at toolcall_end.
    case 'toolcall_delta': return { ...event, delta: '', partial: scrubMessage(event.partial, redactPartial) };
    case 'text_end': case 'thinking_end': return { ...event, content: redact(event.content), partial: scrubMessage(event.partial, redact) };
    case 'toolcall_end': {
      const partial = scrubMessage(event.partial, redact);
      const tool = partial.content[event.contentIndex];
      return tool?.type === 'toolCall' ? { ...event, partial, toolCall: tool } : { ...event, partial };
    }
    default: return { ...event, partial: scrubMessage(event.partial, redactPartial) };
  }
}

export interface PiEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PiSessionOptions {
  readonly projectDir: string;
  readonly sessionDir: string;
  readonly sessionFile?: string;
  readonly orchestration?: PiOrchestration;
  readonly selection?: PiModelSelection;
}

export type PiModelSelection = {
  readonly modelRuntime: ModelRuntime;
  readonly model: Model<Api>;
  readonly thinkingLevel: ModelThinkingLevel;
  readonly endpoint?: string;
  readonly authRef?: string;
  readonly redact?: (text: string) => string;
  readonly redactPartial?: (text: string) => string;
};

export function streamRedactor(secrets: ReadonlySet<string>) {
  const redact = (text: string) => [...secrets].reduce((clean, secret) => clean.replaceAll(secret, '[redacted]'), text);
  function redactPartial(text: string) {
    let hold = 0;
    for (const secret of secrets) {
      for (let length = Math.min(text.length, secret.length - 1); length > hold; length--) {
        if (text.endsWith(secret.slice(0, length))) { hold = length; break; }
      }
    }
    return redact(text.slice(0, text.length - hold));
  }
  return { redact, redactPartial };
}

interface HostAdapter {
  request(command: unknown): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
  destroy(): void;
}

function hostAdapter(value: unknown): value is HostAdapter {
  return object(value) && typeof value.request === "function"
    && typeof value.subscribe === "function" && typeof value.destroy === "function";
}

/** No automatic discovery. Athena mounts tools from its pinned registry and
 * loads selected skill text through load_skill; arbitrary SDK extensions,
 * project context files and executable packages remain unavailable. */
function fixedResources(systemPrompt: string): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new PiRuntimeError("Resources are fixed for this host."); },
    reload: async () => {},
  };
}

export async function createPiSession(options: PiSessionOptions) {
  const projectDir = await realpath(options.projectDir);
  const sessionDir = resolve(options.sessionDir);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  if (options.sessionFile) {
    // SessionManager.open silently starts anew for absent/malformed files. Reject those here.
    const text = await readFile(options.sessionFile, "utf8");
    const header: unknown = JSON.parse(text.split("\n")[0] ?? "");
    if (!object(header) || header.type !== "session" || typeof header.id !== "string"
      || typeof header.cwd !== "string" || await realpath(header.cwd) !== projectDir) {
      throw new PiRuntimeError("Session header does not belong to this project.");
    }
  }
  const manager = options.sessionFile
    ? SessionManager.open(options.sessionFile, sessionDir, projectDir)
    : SessionManager.create(projectDir, sessionDir);
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new PiRuntimeError("Pi did not assign a persistent session file.");
  if (!options.sessionFile) {
    // The SDK defers its first flush and opens with "wx". Persist its genuine header,
    // then reopen through the public API so subsequent SDK writes append to this file.
    await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
    await writeFile(sessionFile, `${JSON.stringify(manager.getHeader())}\n`, { flag: "wx", mode: 0o600 });
    manager.setSessionFile(sessionFile);
  }
  const config = options.selection ? undefined : endpointConfig();
  const provider = options.selection?.model.provider ?? config?.provider ?? process.env.ATHENA_PROVIDER;
  const modelId = options.selection?.model.id ?? config?.model ?? process.env.ATHENA_MODEL;
  if (provider === 'openai-codex') throw new PiRuntimeError('The independent Codex OAuth provider is not supported.');
  const secret = options.selection ? undefined : process.env.ATHENA_API_KEY;
  const legacyRedactor = streamRedactor(new Set(secret ? [secret] : []));
  const redact = options.selection?.redact ?? legacyRedactor.redact;
  const redactPartial = options.selection?.redactPartial ?? legacyRedactor.redactPartial;
  const modelRuntime = options.selection?.modelRuntime ?? await ModelRuntime.create({
    ...(process.env.ATHENA_AUTH_PATH && !config ? { authPath: process.env.ATHENA_AUTH_PATH }
      : { credentials: new InMemoryCredentialStore() }),
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
  });
  if (config) {
    await addCompatibleModels(modelRuntime, config.provider, 'Athena configured endpoint',
      { url: config.endpoint, loopback: config.loopback }, [config.model], secret);
  } else if (provider && secret) {
    await modelRuntime.setRuntimeApiKey(provider, secret);
  }
  const model = options.selection?.model ?? (provider && modelId ? modelRuntime.getModel(provider, modelId) : undefined);
  if (provider && modelId && !model) throw new PiRuntimeError("The configured official Pi model was not found.");
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
    packages: [], extensions: [], skills: [], cacheWarming: "off",
    enableAnalytics: false, enableInstallTelemetry: false,
  });
  const { customTools, systemPrompt } = createPiToolLoadout(projectDir, options.orchestration);
  const thinkingLevel = options.selection?.thinkingLevel ?? "off";
  if (options.selection && options.sessionFile) {
    const lastModel = manager.getBranch().findLast(entry => entry.type === 'model_change');
    if (lastModel?.provider !== options.selection.model.provider || lastModel.modelId !== options.selection.model.id) {
      manager.appendModelChange(options.selection.model.provider, options.selection.model.id);
    }
    if (manager.getBranch().findLast(entry => entry.type === 'thinking_level_change')?.thinkingLevel !== thinkingLevel) {
      manager.appendThinkingLevelChange(thinkingLevel);
    }
  }
  const { session } = await createAgentSession({
    cwd: projectDir, agentDir: join(sessionDir, ".agent"),
    sessionManager: manager, modelRuntime, settingsManager,
    ...(model ? { model } : {}),
    thinkingLevel, tools: customTools.map(tool => tool.name), customTools,
    resourceLoader: fixedResources(systemPrompt),
  });
  if (options.selection?.redact || secret) {
    const upstream = session.agent.streamFunction;
    session.agent.streamFunction = async (...args) => {
      const source = await upstream(...args);
      const clean = createAssistantMessageEventStream();
      const emitted = new Map<number, string>();
      void (async () => {
        for await (const event of source) clean.push(scrubEvent(event, redact, redactPartial, emitted));
        clean.end(scrubMessage(await source.result(), redact));
      })();
      return clean;
    };
  }
  const adapter = createPiHostAdapter({ session, sessionManager: manager, modelRuntime });
  if (!hostAdapter(adapter)) {
    session.dispose();
    throw new PiRuntimeError("The attached Pi host adapter has an incompatible API.");
  }
  let closed = false;
  function ensureOpen() {
    if (closed) throw new PiRuntimeError("The Pi session is closed.");
  }
  async function assertPromptReady() {
    ensureOpen();
    if (!model) throw new PiRuntimeError("Configure ATHENA_MODEL and ATHENA_ENDPOINT, or ATHENA_PROVIDER, before prompting.");
    if (config && !config.loopback && !secret) throw new PiRuntimeError("ATHENA_API_KEY is required for this endpoint.");
    if (!options.selection && provider === 'openai' && process.env.ATHENA_AUTH_PATH
      && (await modelRuntime.checkAuth('openai'))?.type === 'oauth') {
      throw new PiRuntimeError('ChatGPT OAuth must use an Athena account profile. Imported OAuth credentials cannot run.');
    }
  }
  const api = {
    sessionId: session.sessionId,
    sessionFile,
    getState() {
      ensureOpen();
      return {
        sessionId: session.sessionId, sessionFile, isStreaming: session.isStreaming,
        isIdle: session.isIdle, messageCount: session.messages.length,
        model: session.model ? { provider: session.model.provider, id: session.model.id, name: session.model.name, baseUrl: session.model.baseUrl } : null,
        thinkingLevel: session.thinkingLevel,
      };
    },
    getMessages(): readonly unknown[] {
      ensureOpen();
      return session.messages.map(message => publicValue(message, redact));
    },
    publicText: (text: string) => publicText(text, redact),
    subscribe(listener: (event: PiEvent) => void): () => void {
      ensureOpen();
      return adapter.subscribe((value: unknown) => {
        const clean = publicValue(value, redact);
        if (object(clean) && typeof clean.type === "string") listener({ ...clean, type: clean.type });
      });
    },
    /** Completion promise, unlike command(prompt)'s early acceptance response. */
    async prompt(message: string, options?: { readonly kind?: 'reconciliation'; readonly skillContext?:string }): Promise<void> {
      await assertPromptReady();
      try {
        if (options?.kind === 'reconciliation') {
          await session.sendCustomMessage({ customType: 'athena-reconciliation', content: message, display: false, details: undefined }, { triggerTurn: true });
        } else {
          if (options?.skillContext) {
            await session.sendCustomMessage({ customType: 'athena-selected-skills', content: options.skillContext, display: false, details: undefined });
          }
          await session.prompt(message, { expandPromptTemplates: false, source: "rpc" });
        }
      } catch (error) {
        if (error instanceof Error) throw new PiRuntimeError(String(publicValue(error.message, redact)));
        throw error;
      }
    },
    async command(command: unknown): Promise<unknown> {
      ensureOpen();
      if (!object(command) || typeof command.type !== "string") throw new PiRuntimeError("A typed command object is required.");
      switch (command.type) {
        case "prompt": await assertPromptReady(); break;
        case "abort":
        case "get_state":
        case "get_messages":
        case "get_entries":
        case "get_tools":
        case "get_session_stats":
        case "get_available_thinking_levels":
        case "set_thinking_level": break;
        case "get_available_models":
          return {
            type: "response", command: command.type, success: true,
            ...(typeof command.id === "string" ? { id: command.id } : {}),
            data: { models: model ? [{ id: model.id, provider: model.provider, name: model.name,
              reasoning: model.reasoning, input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens }] : [] },
          };
        default: throw new PiRuntimeError("Command is not allowed by this host.");
      }
      return publicValue(await adapter.request(command), redact);
    },
    close(): void {
      if (session.isStreaming) throw new PiRuntimeError("Abort and settle the session before closing it.");
      adapter.destroy();
      session.dispose();
      closed = true;
    },
  };
  return api;
}

export type PiSession = Awaited<ReturnType<typeof createPiSession>>;
