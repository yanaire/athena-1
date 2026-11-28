import { createHash } from 'node:crypto';

export const EXTERNAL_MCP_PROTOCOL = '2025-06-18' as const;
export const EXTERNAL_MCP_LIMITS = Object.freeze({ requestBytes: 256 * 1024, responseBytes: 512 * 1024,
  schemaBytes: 32 * 1024, tools: 64, pages: 8, timeoutMs: 30_000, schemaDepth: 16, valueDepth: 32 });
export type ExternalServerDefinition = {
  readonly id: string; readonly name: string; readonly transport: 'streamable-http'; readonly url: string;
  readonly capability?:'browser'|'computer'|'program'; readonly allowedTools: readonly string[]; readonly auth?: 'none' | 'bearer'; readonly timeoutMs?: number;
};
export type ExternalTool = {
  readonly name: string; readonly title?: string; readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>; readonly outputSchema?: Readonly<Record<string, unknown>>;
};
export type ExternalVerification = {
  readonly protocolVersion: typeof EXTERNAL_MCP_PROTOCOL; readonly serverInfo: { readonly name: string; readonly version: string };
  readonly configDigest: string; readonly tools: readonly ExternalTool[]; readonly digest: string; readonly checkedAt: number;
  /** Assigned by the host credential store; never accepted from a plugin manifest. */
  readonly credentialRef?: string;
};
export type ExternalToolResult = {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
};
export type ExternalClientOptions = {
  readonly token?: string; readonly signal?: AbortSignal;
  readonly onPhase?: (phase: 'initialize' | 'tools/list' | 'tools/call') => void;
};
export class ExternalMcpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'ExternalMcpError'; this.code = code; }
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  throw new ExternalMcpError('INVALID_JSON', 'Expected finite JSON data.');
}
export const extensionDigest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const str = (v: unknown, max = 256): v is string => typeof v === 'string' && v.trim().length > 0 && Buffer.byteLength(v) <= max && !/[\u0000-\u001f\u007f]/.test(v);
export function validateExternalServer(value: unknown): ExternalServerDefinition {
  if (!object(value) || Object.keys(value).some(k => !['id', 'name', 'transport', 'url', 'allowedTools', 'auth', 'timeoutMs','capability'].includes(k)))
    throw new ExternalMcpError('INVALID_SERVER', 'External MCP configuration contains unsupported fields.');
  if(value.capability!==undefined&&value.capability!=='browser'&&value.capability!=='computer'&&value.capability!=='program')
    throw new ExternalMcpError('INVALID_SERVER','Unknown research tool capability.');
  if (value.transport !== 'streamable-http') throw new ExternalMcpError('UNSUPPORTED_TRANSPORT', 'Only Streamable HTTP MCP is supported. Athena does not launch external stdio commands.');
  if (!str(value.id, 64) || !/^[a-z][a-z0-9-]*$/.test(value.id) || !str(value.name, 128) || !str(value.url, 2048))
    throw new ExternalMcpError('INVALID_SERVER', 'A server ID, name and endpoint URL are required.');
  let url: URL;
  try { url = new URL(value.url); } catch { throw new ExternalMcpError('INVALID_ENDPOINT', 'Invalid MCP endpoint URL.'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search || !(url.protocol === 'https:' || url.protocol === 'http:' && loopback))
    throw new ExternalMcpError('INVALID_ENDPOINT', 'Use HTTPS or an explicit loopback HTTP endpoint, without credentials, query parameters or a fragment.');
  if (!Array.isArray(value.allowedTools) || value.allowedTools.length < 1 || value.allowedTools.length > EXTERNAL_MCP_LIMITS.tools
    || !value.allowedTools.every(name => str(name, 128) && /^[a-zA-Z0-9_.:-]+$/.test(name)) || new Set(value.allowedTools).size !== value.allowedTools.length)
    throw new ExternalMcpError('INVALID_SERVER', 'Choose a bounded, distinct list of exact MCP tool names.');
  if (value.auth !== undefined && value.auth !== 'none' && value.auth !== 'bearer') throw new ExternalMcpError('INVALID_SERVER', 'Unsupported MCP authentication mode.');
  if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 100 || Number(value.timeoutMs) > EXTERNAL_MCP_LIMITS.timeoutMs))
    throw new ExternalMcpError('INVALID_SERVER', 'MCP timeout must be between 100 and 30000 milliseconds.');
  return { ...(value.capability?{capability:value.capability}:{}),id: value.id, name: value.name, transport: 'streamable-http', url: url.href,
    allowedTools: [...value.allowedTools] as string[], auth: value.auth ?? 'none', timeoutMs: value.timeoutMs as number | undefined };
}

// Deliberately bounded JSON Schema subset. Unsupported keywords reject discovery;
// no remote/local $ref resolution, regexp execution, code generation or coercion.
const schemaKeys = new Set(['type', 'title', 'description', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'anyOf', 'oneOf', 'allOf', 'not', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems',
  'minProperties', 'maxProperties', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', '$schema', 'x-mcp-header']);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
function boundedJson(value: unknown, maxBytes: number, depth = 0, count = { nodes: 0 }): void {
  if (depth > EXTERNAL_MCP_LIMITS.valueDepth || ++count.nodes > 20000) throw new ExternalMcpError('VALUE_LIMIT', 'JSON structure exceeds supported limits.');
  if (Array.isArray(value)) value.forEach(v => boundedJson(v, maxBytes, depth + 1, count));
  else if (object(value)) Object.values(value).forEach(v => boundedJson(v, maxBytes, depth + 1, count));
  else if (value !== null && !['string', 'boolean', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value))
    throw new ExternalMcpError('INVALID_JSON', 'Expected finite JSON data.');
  if (depth === 0 && Buffer.byteLength(canonicalJson(value)) > maxBytes) throw new ExternalMcpError('VALUE_LIMIT', 'JSON content exceeds the byte limit.');
}
export function validateExternalSchema(value: unknown, root = true): asserts value is Record<string, unknown> {
  boundedJson(value, EXTERNAL_MCP_LIMITS.schemaBytes);
  let nodes = 0;
  const visit = (schema: unknown, depth: number) => {
    if (++nodes > 1024 || depth > EXTERNAL_MCP_LIMITS.schemaDepth || !object(schema) || Object.keys(schema).some(k => !schemaKeys.has(k)))
      throw new ExternalMcpError('UNSUPPORTED_SCHEMA', 'MCP schema exceeds the supported bounded JSON Schema subset.');
    // Upstream GitHub includes this descriptive annotation even for 2025-06-18.
    // Keep it in the pinned schema. Our transport constructs its own fixed headers.
    const header = schema['x-mcp-header'];
    if (header !== undefined && (typeof header !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(header)))
      throw new ExternalMcpError('UNSUPPORTED_SCHEMA', 'Invalid MCP header annotation.');
    if (schema.type !== undefined && !(typeof schema.type === 'string' && types.has(schema.type))
      && !(Array.isArray(schema.type) && schema.type.length > 0 && schema.type.length <= types.size && new Set(schema.type).size === schema.type.length && schema.type.every(t => typeof t === 'string' && types.has(t))))
      throw new ExternalMcpError('UNSUPPORTED_SCHEMA', 'Unsupported JSON Schema type.');
    for (const key of ['title', 'description', '$schema']) if (schema[key] !== undefined && typeof schema[key] !== 'string')
      throw new ExternalMcpError('UNSUPPORTED_SCHEMA', 'Invalid schema description.');
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'])
      if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || Number(schema[key]) < 0)) throw new ExternalMcpError('UNSUPPORTED_SCHEMA', 'Invalid schema bound.');
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'])
      if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]) || key === 'multipleOf' && schema[key] <= 0))
        throw new ExternalMcpError('UNSUPPORTED_SCHEMA', 'Invalid numeric schema bound.');
    for (const key of ['uniqueItems', 'deprecated', 'readOnly', 'writeOnly']) if (schema[key] !== undefined && typeof schema[key] !== 'boolean')
      throw new ExternalMcpError('UNSUPPORTED_SCHEMA', 'Invalid boolean schema field.');
    if (schema.properties !== undefined) {
      if (!object(schema.properties) || Object.keys(schema.properties).length > 256) throw new ExternalMcpError('UNSUPPORTED_SCHEMA', 'Invalid schema properties.');
      for (const sub of Object.values(schema.properties)) visit(sub, depth + 1);
    }
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length > 256
      || !schema.required.every(k => typeof k === 'string') || new Set(schema.required).size !== schema.required.length))
      throw new ExternalMcpError('UNSUPPORTED_SCHEMA', 'Invalid required property list.');
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') visit(schema.additionalProperties, depth + 1);
    if (schema.items !== undefined) visit(schema.items, depth + 1);
    if (schema.not !== undefined) visit(schema.not, depth + 1);
    for (const key of ['anyOf', 'oneOf', 'allOf']) if (schema[key] !== undefined) {
      if (!Array.isArray(schema[key]) || schema[key].length < 1 || schema[key].length > 32) throw new ExternalMcpError('UNSUPPORTED_SCHEMA', 'Invalid schema alternatives.');
      for (const sub of schema[key]) visit(sub, depth + 1);
    }
    if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length < 1 || schema.enum.length > 256
      || new Set(schema.enum.map(canonicalJson)).size !== schema.enum.length))
      throw new ExternalMcpError('UNSUPPORTED_SCHEMA', 'Invalid schema enumeration.');
  };
  visit(value, 0);
  if (root && (!object(value) || value.type !== 'object')) throw new ExternalMcpError('UNSUPPORTED_SCHEMA', 'MCP tool schemas must describe an object.');
}
export function matchesExternalSchema(schema: Readonly<Record<string, unknown>>, value: unknown, maxBytes: number = EXTERNAL_MCP_LIMITS.requestBytes): boolean {
  boundedJson(value, maxBytes);
  let budget = 100000;
  const match = (s: Readonly<Record<string, unknown>>, v: unknown): boolean => {
    if (--budget < 0) throw new ExternalMcpError('VALUE_LIMIT', 'Schema validation exceeded its complexity limit.');
    const typeMatch = (type: unknown) => type === 'null' ? v === null : type === 'array' ? Array.isArray(v) : type === 'object' ? object(v)
      : type === 'integer' ? Number.isInteger(v) : type === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === type;
    if (s.type !== undefined && !(Array.isArray(s.type) ? s.type.some(typeMatch) : typeMatch(s.type))) return false;
    if (Object.hasOwn(s, 'const') && canonicalJson(s.const) !== canonicalJson(v)) return false;
    if (Array.isArray(s.enum) && !s.enum.some(item => canonicalJson(item) === canonicalJson(v))) return false;
    const alternatives = (key: string) => (s[key] as Record<string, unknown>[]).map(item => match(item, v));
    if (Array.isArray(s.anyOf) && !alternatives('anyOf').some(Boolean)) return false;
    if (Array.isArray(s.oneOf) && alternatives('oneOf').filter(Boolean).length !== 1) return false;
    if (Array.isArray(s.allOf) && !alternatives('allOf').every(Boolean)) return false;
    if (object(s.not) && match(s.not, v)) return false;
    if (typeof v === 'string') {
      const length = Array.from(v).length;
      if (typeof s.minLength === 'number' && length < s.minLength || typeof s.maxLength === 'number' && length > s.maxLength) return false;
    }
    if (typeof v === 'number') {
      if (typeof s.minimum === 'number' && v < s.minimum || typeof s.maximum === 'number' && v > s.maximum
        || typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum || typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) return false;
      if (typeof s.multipleOf === 'number') {
        const quotient = v / s.multipleOf;
        if (!Number.isFinite(quotient) || Math.abs(quotient - Math.round(quotient)) > 1e-10) return false;
      }
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === 'number' && v.length < s.minItems || typeof s.maxItems === 'number' && v.length > s.maxItems) return false;
      if (s.uniqueItems === true && new Set(v.map(canonicalJson)).size !== v.length) return false;
      if (object(s.items) && !v.every(item => match(s.items as Record<string, unknown>, item))) return false;
    }
    if (object(v)) {
      const keys = Object.keys(v), properties = object(s.properties) ? s.properties : {};
      if (typeof s.minProperties === 'number' && keys.length < s.minProperties || typeof s.maxProperties === 'number' && keys.length > s.maxProperties) return false;
      if (Array.isArray(s.required) && !s.required.every(key => Object.hasOwn(v, String(key)))) return false;
      for (const key of keys) {
        if (Object.hasOwn(properties, key)) { if (!match(properties[key] as Record<string, unknown>, v[key])) return false; }
        else if (s.additionalProperties === false || object(s.additionalProperties) && !match(s.additionalProperties, v[key])) return false;
      }
    }
    return true;
  };
  return match(schema, value);
}

function tool(value: unknown): ExternalTool {
  if (!object(value) || !str(value.name, 128) || !/^[a-zA-Z0-9_.:-]+$/.test(value.name)
    || value.title !== undefined && !str(value.title, 256) || value.description !== undefined && (typeof value.description !== 'string' || Buffer.byteLength(value.description) > 8192))
    throw new ExternalMcpError('INVALID_TOOL', 'Invalid external MCP tool metadata.');
  validateExternalSchema(value.inputSchema);
  if (value.outputSchema !== undefined) validateExternalSchema(value.outputSchema);
  return { name: value.name, ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}), inputSchema: value.inputSchema,
    ...(value.outputSchema !== undefined ? { outputSchema: value.outputSchema as Record<string, unknown> } : {}) };
}
export function externalConfigurationDigest(server: ExternalServerDefinition): string { return extensionDigest(validateExternalServer(server)); }
export function externalVerificationDigest(verification: Pick<ExternalVerification, 'protocolVersion' | 'serverInfo' | 'configDigest' | 'tools'>): string {
  return extensionDigest({ protocolVersion: verification.protocolVersion, serverInfo: verification.serverInfo, configDigest: verification.configDigest, tools: verification.tools });
}
export function validateExternalVerification(server: ExternalServerDefinition, value: unknown): asserts value is ExternalVerification {
  if (!object(value) || value.protocolVersion !== EXTERNAL_MCP_PROTOCOL || !object(value.serverInfo)
    || !str(value.serverInfo.name) || !str(value.serverInfo.version) || value.configDigest !== externalConfigurationDigest(server)
    || !Array.isArray(value.tools) || value.tools.length !== server.allowedTools.length || !Number.isSafeInteger(value.checkedAt))
    throw new ExternalMcpError('INVALID_VERIFICATION', 'MCP verification does not match this configuration.');
  const checked = value.tools.map(tool);
  if (new Set(checked.map(t => t.name)).size !== checked.length || checked.some(t => !server.allowedTools.includes(t.name))
    || externalVerificationDigest(value as ExternalVerification) !== value.digest)
    throw new ExternalMcpError('INVALID_VERIFICATION', 'MCP verification has invalid tools or a changed schema digest.');
}

function redactValue(value: unknown, token: string | undefined): unknown {
  if (!token) return value;
  if (typeof value === 'string') return value.replaceAll(token, '[redacted]');
  if (Array.isArray(value)) return value.map(item => redactValue(item, token));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replaceAll(token, '[redacted]'), redactValue(item, token)]));
  return value;
}

class HttpSession {
  readonly server: ExternalServerDefinition;
  readonly signal: AbortSignal;
  readonly options: ExternalClientOptions;
  sessionId?: string;
  nextId = 1;
  constructor(server: ExternalServerDefinition, options: ExternalClientOptions) {
    this.server = validateExternalServer(server); this.options = options;
    if (this.server.auth === 'bearer' && !str(options.token, 8192)) throw new ExternalMcpError('AUTH_REQUIRED', 'This MCP connection needs its own bearer credential.');
    if (this.server.auth === 'none' && options.token !== undefined) throw new ExternalMcpError('UNEXPECTED_CREDENTIAL', 'This MCP connection is configured without authentication.');
    this.signal = AbortSignal.any([AbortSignal.timeout(this.server.timeoutMs ?? 10000), ...(options.signal ? [options.signal] : [])]);
  }
  headers() {
    return { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': EXTERNAL_MCP_PROTOCOL,
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}), ...(this.options.token ? { Authorization: 'Bearer ' + this.options.token } : {}) };
  }
  async post(message: object, id?: number): Promise<unknown> {
    this.signal.throwIfAborted();
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body) > EXTERNAL_MCP_LIMITS.requestBytes) throw new ExternalMcpError('REQUEST_LIMIT', 'MCP request exceeds its byte limit.');
    const response = await fetch(this.server.url, { method: 'POST', headers: this.headers(), body, redirect: 'error', signal: this.signal });
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) {
      if (!/^[\x21-\x7e]{1,512}$/.test(sessionId) || this.sessionId !== undefined && sessionId !== this.sessionId) {
        await response.body?.cancel(); throw new ExternalMcpError('INVALID_SESSION', 'MCP session identifier changed or is invalid.');
      }
      this.sessionId = sessionId;
    }
    if (!response.ok) { await response.body?.cancel(); throw new ExternalMcpError('MCP_HTTP_ERROR', 'MCP endpoint returned HTTP ' + response.status + '.'); }
    if (id === undefined) {
      await response.body?.cancel();
      if (response.status !== 202) throw new ExternalMcpError('MCP_PROTOCOL_ERROR', 'MCP notification was not accepted.');
      return undefined;
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json' && contentType !== 'text/event-stream') {
      await response.body?.cancel(); throw new ExternalMcpError('MCP_PROTOCOL_ERROR', 'MCP returned an unsupported response content type.');
    }
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > EXTERNAL_MCP_LIMITS.responseBytes) { await response.body?.cancel(); throw new ExternalMcpError('RESPONSE_LIMIT', 'MCP response exceeds its byte limit.'); }
    const reader = response.body?.getReader();
    if (!reader) throw new ExternalMcpError('MCP_PROTOCOL_ERROR', 'MCP response body is missing.');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, buffer = '', sse = '';
    const parse = (line: string): { value: unknown } | undefined => {
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { throw new ExternalMcpError('MCP_PROTOCOL_ERROR', 'Malformed MCP JSON response.'); }
      boundedJson(raw, EXTERNAL_MCP_LIMITS.responseBytes);
      const value = redactValue(raw, this.options.token);
      if (!object(value) || value.jsonrpc !== '2.0') throw new ExternalMcpError('MCP_PROTOCOL_ERROR', 'Invalid MCP response envelope.');
      if (typeof value.method === 'string') {
        if (value.id !== undefined || !value.method.startsWith('notifications/')) throw new ExternalMcpError('MCP_PROTOCOL_ERROR', 'Unrequested MCP server capability.');
        return undefined;
      }
      if (value.id !== id || Object.hasOwn(value, 'error') === Object.hasOwn(value, 'result'))
        throw new ExternalMcpError('MCP_PROTOCOL_ERROR', 'MCP response does not match the current request.');
      if (value.error !== undefined) throw new ExternalMcpError('MCP_REMOTE_ERROR', object(value.error) && typeof value.error.message === 'string'
        ? value.error.message.slice(0, 1000) : 'MCP endpoint rejected this request.');
      if (!object(value.result)) throw new ExternalMcpError('MCP_PROTOCOL_ERROR', 'MCP result must be an object.');
      return { value: value.result };
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) bytes += value.byteLength;
        if (bytes > EXTERNAL_MCP_LIMITS.responseBytes) throw new ExternalMcpError('RESPONSE_LIMIT', 'MCP response exceeds its byte limit.');
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (contentType === 'application/json') {
          if (done) { const result = parse(buffer); if (!result) throw new ExternalMcpError('MCP_PROTOCOL_ERROR', 'MCP response was only a notification.'); return result.value; }
        } else {
          // Normalize complete lines only, so CRLF split across network chunks is safe.
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
            if (line === '') {
              if (sse) { const result = parse(sse.endsWith('\n') ? sse.slice(0, -1) : sse); sse = ''; if (result) return result.value; }
            } else if (line.startsWith('data:')) sse += line.slice(5).replace(/^ /, '') + '\n';
          }
          if (done) throw new ExternalMcpError('MCP_PROTOCOL_ERROR', 'MCP event stream ended before a complete matching response.');
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  async request(method: string, params: object): Promise<unknown> {
    const id = this.nextId++;
    try { return await this.post({ jsonrpc: '2.0', id, method, params }, id); }
    catch (error) {
      if (this.signal.aborted && method !== 'initialize') {
        // MCP cancellation is advisory. A dropped HTTP request is not proof that
        // remote effects stopped, even when this notification is accepted.
        await fetch(this.server.url, { method: 'POST', headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(500),
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {
            requestId: id, reason: 'The client cancelled or timed out this request.',
          } }) }).then(response => response.body?.cancel()).catch(() => {});
      }
      throw error;
    }
  }
  async discovery(): Promise<ExternalVerification> {
    this.options.onPhase?.('initialize');
    const init = await this.request('initialize', { protocolVersion: EXTERNAL_MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'Athena', version: '1.0.0' } });
    if (!object(init) || init.protocolVersion !== EXTERNAL_MCP_PROTOCOL || !object(init.capabilities) || !object(init.capabilities.tools)
      || !object(init.serverInfo) || !str(init.serverInfo.name) || !str(init.serverInfo.version))
      throw new ExternalMcpError('INCOMPATIBLE_SERVER', 'MCP server does not support the configured protocol and tools capability.');
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    this.options.onPhase?.('tools/list');
    const tools: ExternalTool[] = [], seen = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < EXTERNAL_MCP_LIMITS.pages; page++) {
      const listed = await this.request('tools/list', cursor ? { cursor } : {});
      if (!object(listed) || !Array.isArray(listed.tools) || listed.tools.length + seen.size > EXTERNAL_MCP_LIMITS.tools)
        throw new ExternalMcpError('INVALID_TOOL_LIST', 'MCP returned an invalid or oversized tool list.');
      for (const item of listed.tools) {
        if (!object(item) || !str(item.name, 128) || seen.has(item.name)) throw new ExternalMcpError('INVALID_TOOL_LIST', 'MCP tool names are invalid or duplicated.');
        seen.add(item.name);
        if (this.server.allowedTools.includes(item.name)) tools.push(tool(item));
      }
      if (listed.nextCursor === undefined) { cursor = undefined; break; }
      if (!str(listed.nextCursor, 2048) || cursors.has(listed.nextCursor)) throw new ExternalMcpError('INVALID_TOOL_LIST', 'MCP pagination did not advance.');
      cursor = listed.nextCursor; cursors.add(cursor);
    }
    if (cursor !== undefined || tools.length !== this.server.allowedTools.length) throw new ExternalMcpError('INVALID_TOOL_LIST', 'Configured MCP tools were not found within the listing limits.');
    tools.sort((a, b) => a.name.localeCompare(b.name));
    const verification = { protocolVersion: EXTERNAL_MCP_PROTOCOL, serverInfo: { name: init.serverInfo.name, version: init.serverInfo.version },
      configDigest: externalConfigurationDigest(this.server), tools, checkedAt: Date.now() };
    return { ...verification, digest: externalVerificationDigest(verification) };
  }
  async close() {
    if (!this.sessionId) return;
    // Best-effort session cleanup. A dropped connection never proves remote work stopped.
    await fetch(this.server.url, { method: 'DELETE', headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(500) })
      .then(response => response.body?.cancel()).catch(() => {});
  }
}
export async function discoverExternalMcp(server: ExternalServerDefinition, options: ExternalClientOptions = {}): Promise<ExternalVerification> {
  const client = new HttpSession(server, options);
  try { return await client.discovery(); } finally { await client.close(); }
}
export async function callExternalMcp(server: ExternalServerDefinition, verification: ExternalVerification, toolName: string,
  args: Readonly<Record<string, unknown>>, options: ExternalClientOptions = {}): Promise<ExternalToolResult> {
  validateExternalVerification(server, verification);
  const expected = verification.tools.find(item => item.name === toolName);
  if (!expected || !object(args) || !matchesExternalSchema(expected.inputSchema, args)) throw new ExternalMcpError('INVALID_ARGUMENTS', 'Arguments do not match the configured MCP tool.');
  const client = new HttpSession(server, options);
  try {
    const current = await client.discovery();
    if (current.digest !== verification.digest) throw new ExternalMcpError('MCP_CONFIGURATION_CHANGED', 'MCP identity or tool schema changed. Check the connection again before a new run.');
    options.onPhase?.('tools/call');
    const result = await client.request('tools/call', { name: toolName, arguments: args });
    if (!object(result) || !Array.isArray(result.content) || result.content.length > 128
      || !result.content.every(item => object(item) && item.type === 'text' && typeof item.text === 'string')
      || result.structuredContent !== undefined && !object(result.structuredContent) || result.isError !== undefined && typeof result.isError !== 'boolean')
      throw new ExternalMcpError('UNSUPPORTED_RESULT', 'This connection supports bounded text and structured JSON results. External resources, images and audio are not fetched.');
    if (result.isError === true) throw new ExternalMcpError('MCP_TOOL_FAILED', result.content.filter(object).map(item => item.text).join('\n').slice(0, 1000) || 'External MCP tool failed.');
    if (expected.outputSchema && !matchesExternalSchema(expected.outputSchema, result.structuredContent, EXTERNAL_MCP_LIMITS.responseBytes))
      throw new ExternalMcpError('INVALID_RESULT', 'External MCP result does not match its pinned output schema.');
    client.signal.throwIfAborted();
    return { content: result.content.map(item => ({ type: 'text', text: (item as { text: string }).text })),
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent as Record<string, unknown> } : {}), isError: false };
  } finally { await client.close(); }
}
