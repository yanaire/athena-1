import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { callExternalMcp, discoverExternalMcp, EXTERNAL_MCP_LIMITS, matchesExternalSchema, validateExternalSchema, validateExternalServer } from '../runtime/external-mcp-client.ts';
import type { ExternalServerDefinition } from '../runtime/external-mcp-client.ts';

type RecordCall = { method: string; params: Record<string, unknown>; headers: IncomingMessage['headers'] };
type FixtureOptions = { sse?: boolean; auth?: boolean; paginate?: boolean; mutate?: (method: string, result: Record<string, unknown>) => Record<string, unknown>;
  call?: (res: ServerResponse, id: unknown, args: Record<string, unknown>) => void; intercept?: (req: IncomingMessage, res: ServerResponse) => boolean };
const inputSchema = { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false };
const outputSchema = { type: 'object', properties: { doubled: { type: 'number' } }, required: ['doubled'], additionalProperties: false };
async function fixture(options: FixtureOptions = {}) {
  const calls: RecordCall[] = [], cleanups: string[] = [];
  const respond = (res: ServerResponse, id: unknown, result: Record<string, unknown>) => {
    res.setHeader('Content-Type', options.sse ? 'text/event-stream' : 'application/json');
    if (options.sse) {
      res.write(': connection established\r\n\r\n');
      res.write('event: message\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }) + '\r\n\r\n');
      for (const line of JSON.stringify({ jsonrpc: '2.0', id, result }, null, 2).split('\n')) res.write('data: ' + line + '\r\n');
      res.end('\r\n');
    } else res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  const http = createServer(async (req, res) => {
    if (options.intercept?.(req, res)) return;
    if (req.method === 'DELETE') { cleanups.push(req.headers['mcp-session-id'] as string); res.writeHead(202).end(); return; }
    const parts: Buffer[] = []; for await (const chunk of req) parts.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(parts).toString()) as { method: string; id?: number; params: Record<string, unknown> };
    calls.push({ method: message.method, params: message.params, headers: req.headers });
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') { res.writeHead(202).end(); return; }
    let result: Record<string, unknown>;
    if (message.method === 'initialize') {
      res.setHeader('Mcp-Session-Id', 'fixture-session');
      result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'lab-fixture', version: '1.0.0' } };
    } else if (message.method === 'tools/list') {
      const actual = { name: 'double', description: 'Double the supplied value', inputSchema, outputSchema };
      result = options.paginate && !message.params.cursor ? { tools: [{ name: 'unused', inputSchema: { type: 'object' } }], nextCursor: 'second' } : { tools: [actual] };
    } else if (message.method === 'tools/call') {
      if (options.call) { options.call(res, message.id, message.params.arguments as Record<string, unknown>); return; }
      const value = Number((message.params.arguments as Record<string, unknown>).value) * 2;
      result = { content: [{ type: 'text', text: 'Result ' + value }], structuredContent: { doubled: value } };
    } else { res.writeHead(400).end(); return; }
    respond(res, message.id, options.mutate?.(message.method, result) ?? result);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No test listener');
  const server: ExternalServerDefinition = { id: 'lab', name: 'Lab fixture', transport: 'streamable-http', url: `http://127.0.0.1:${address.port}/mcp`, allowedTools: ['double'], auth: options.auth ? 'bearer' : 'none' };
  return { calls, cleanups, server, async close() { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); } };
}

test('real Streamable HTTP initialization, paginated discovery, schema-bound call and saved JSON values', async () => {
  const f = await fixture({ paginate: true });
  try {
    const verification = await discoverExternalMcp(f.server);
    assert.deepEqual(verification.tools.map(t => t.name), ['double']);
    const phases: string[] = [];
    const result = await callExternalMcp(f.server, verification, 'double', { value: 7 }, { onPhase: phase => phases.push(phase) });
    assert.deepEqual(result.structuredContent, { doubled: 14 });
    assert.deepEqual(phases, ['initialize', 'tools/list', 'tools/call']);
    assert.equal(f.calls.filter(call => call.method === 'tools/call').length, 1);
    assert.equal(f.calls.find(call => call.method === 'tools/call')?.headers['mcp-session-id'], 'fixture-session');
    assert.equal(f.calls.find(call => call.method === 'tools/call')?.headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(f.cleanups.length, 2);
    await assert.rejects(callExternalMcp(f.server, verification, 'double', { value: '7' }), /Arguments/);
    await assert.rejects(callExternalMcp(f.server, verification, 'unlisted', {}), /Arguments/);
    assert.equal(f.calls.filter(call => call.method === 'tools/call').length, 1);
  } finally { await f.close(); }
});

test('bounded SSE accepts notifications and multiline data without exposing a second URL or fetching resources', async () => {
  const f = await fixture({ sse: true });
  try {
    const verified = await discoverExternalMcp(f.server);
    assert.deepEqual((await callExternalMcp(f.server, verified, 'double', { value: -2 })).structuredContent, { doubled: -4 });
  } finally { await f.close(); }
});

test('output schemas accept the response byte budget while equally large tool arguments remain rejected', async () => {
  const large = 'x'.repeat(300 * 1024);
  const f = await fixture({ mutate: (method, result) => {
    if (method === 'tools/list') return { tools: [{ name: 'double', inputSchema: { ...inputSchema,
      properties: { value: { type: 'number' }, payload: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] };
    if (method === 'tools/call') return { content: [], structuredContent: { text: large } };
    return result;
  } });
  try {
    const verified = await discoverExternalMcp(f.server);
    const result = await callExternalMcp(f.server, verified, 'double', { value: 1 });
    assert.equal(result.structuredContent?.text, large);
    const requests = f.calls.length;
    await assert.rejects(callExternalMcp(f.server, verified, 'double', { value: 1, payload: large }), /byte limit/);
    assert.equal(f.calls.length, requests, 'Oversized inputs fail before any HTTP request');
  } finally { await f.close(); }
});

test('schema and server identity drift reject before the side-effecting tools/call', async () => {
  let changed = false;
  const f = await fixture({ mutate: (method, result) => changed && method === 'tools/list'
    ? { tools: [{ name: 'double', inputSchema: { ...inputSchema, properties: { value: { type: 'string' } } }, outputSchema }] } : result });
  try {
    const verified = await discoverExternalMcp(f.server); changed = true;
    await assert.rejects(callExternalMcp(f.server, verified, 'double', { value: 3 }), /schema changed/);
    assert.equal(f.calls.some(call => call.method === 'tools/call'), false);
  } finally { await f.close(); }
});

test('unsupported schemas reject discovery and do not masquerade as validated tool contracts', async () => {
  for (const schema of [{ type: 'object', $ref: 'https://bad.example/schema' }, { type: 'object', properties: { value: { type: 'string', pattern: '(a+)+$' } } },
    { type: 'object', required: 'value' }, { type: 'object', properties: { value: { type: 'number', multipleOf: 0 } } }]) assert.throws(() => validateExternalSchema(schema));
  const f = await fixture({ mutate: (method, result) => method === 'tools/list' ? { tools: [{ name: 'double', inputSchema: { type: 'object', $ref: '#/$defs/unsafe' } }] } : result });
  try { await assert.rejects(discoverExternalMcp(f.server), /subset/); assert.equal(f.calls.some(call => call.method === 'tools/call'), false); }
  finally { await f.close(); }
});

test('schema validation covers nested objects, arrays, alternatives and extra properties without coercion', () => {
  const schema = { type: 'object', required: ['samples'], additionalProperties: false, properties: { samples: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true,
    items: { anyOf: [{ type: 'number', minimum: 0, maximum: 4 }, { type: 'null' }] } } } };
  validateExternalSchema(schema);
  assert.equal(matchesExternalSchema(schema, { samples: [0, null, 4] }), true);
  for (const value of [{ samples: [] }, { samples: [1, 1] }, { samples: ['2'] }, { samples: [5] }, { samples: [1], injected: true }]) assert.equal(matchesExternalSchema(schema, value), false);
  assert.throws(() => matchesExternalSchema(schema, { samples: [Number.NaN] }), /finite JSON/);
  assert.equal(matchesExternalSchema({ type: 'number', multipleOf: 1e-308 }, 1e308), false);
});

test('only explicitly supplied external credentials are sent and token echoes are redacted from results', async () => {
  const token = 'private-external-fixture-token', ambient = process.env.ATHENA_API_KEY;
  process.env.ATHENA_API_KEY = 'provider-token-must-never-escape';
  const plain = await fixture(), authenticated = await fixture({ auth: true, mutate: (method, result) => method === 'tools/call'
    ? { ...result, content: [{ type: 'text', text: 'Do not expose ' + token }] } : result });
  try {
    await discoverExternalMcp(plain.server);
    assert.equal(plain.calls.some(call => call.headers.authorization !== undefined), false);
    await assert.rejects(discoverExternalMcp(authenticated.server), /own bearer credential/);
    const verified = await discoverExternalMcp(authenticated.server, { token });
    const result = await callExternalMcp(authenticated.server, verified, 'double', { value: 5 }, { token });
    assert.ok(result.content[0]?.text.includes('[redacted]'));
    assert.ok(!JSON.stringify(result).includes(token));
    assert.equal(authenticated.calls.every(call => call.headers.authorization === 'Bearer ' + token), true);
  } finally { if (ambient === undefined) delete process.env.ATHENA_API_KEY; else process.env.ATHENA_API_KEY = ambient; await plain.close(); await authenticated.close(); }
});

test('redirects and unsupported endpoints never forward a request or token to another destination', async () => {
  let destinationHits = 0;
  const destination = await fixture({ intercept: (_req, res) => { destinationHits++; res.writeHead(200).end('{}'); return true; } });
  const redirect = await fixture({ auth: true, intercept: (_req, res) => { res.writeHead(307, { Location: destination.server.url }).end(); return true; } });
  try {
    await assert.rejects(discoverExternalMcp(redirect.server, { token: 'private-external-fixture-token' }));
    assert.equal(destinationHits, 0);
    for (const url of ['http://remote.example/mcp', 'https://user:password@example.com/mcp', 'file:///etc/passwd', 'https://example.com/mcp?token=secret'])
      assert.throws(() => validateExternalServer({ ...redirect.server, url }));
    assert.throws(() => validateExternalServer({ ...redirect.server, transport: 'stdio' }), /does not launch/);
  } finally { await redirect.close(); await destination.close(); }
});

test('in-flight cancellation and timeout settle without accepting a late remote result', async () => {
  let started: (() => void) | undefined;
  const f = await fixture({ call: () => started?.() });
  try {
    const verified = await discoverExternalMcp(f.server), controller = new AbortController();
    const reached = new Promise<void>(resolve => { started = resolve; });
    const result = callExternalMcp(f.server, verified, 'double', { value: 1 }, { signal: controller.signal });
    await reached; controller.abort();
    await assert.rejects(result, error => error instanceof Error && error.name === 'AbortError');
    assert.equal(f.calls.filter(call => call.method === 'notifications/cancelled').length, 1);
    assert.equal(typeof f.calls.find(call => call.method === 'notifications/cancelled')?.params.requestId, 'number');
    const timed = { ...f.server, timeoutMs: 100 };
    const timeoutVerification = await discoverExternalMcp(timed);
    await assert.rejects(callExternalMcp(timed, timeoutVerification, 'double', { value: 1 }), error => error instanceof Error && error.name === 'TimeoutError');
  } finally { await f.close(); }
});

test('oversized bodies, malformed output and linked resources are rejected without further fetches', async () => {
  for (const variant of ['oversized', 'resource', 'bad-output'] as const) {
    const f = await fixture({ mutate: (method, result) => {
      if (method !== 'tools/call') return result;
      if (variant === 'oversized') return { content: [{ type: 'text', text: 'x'.repeat(EXTERNAL_MCP_LIMITS.responseBytes + 1) }] };
      if (variant === 'resource') return { content: [{ type: 'resource_link', uri: 'http://127.0.0.1/private', name: 'Do not fetch' }] };
      return { content: [], structuredContent: { doubled: 'not a number' } };
    } });
    try {
      const verified = await discoverExternalMcp(f.server);
      await assert.rejects(callExternalMcp(f.server, verified, 'double', { value: 1 }));
      assert.equal(f.calls.filter(call => call.method === 'tools/call').length, 1);
    } finally { await f.close(); }
  }
});

test('GitHub header annotations retain normal required argument validation', () => {
  const schema = {type:'object',properties:{repo:{type:'string','x-mcp-header':'repo'}},required:['repo']};
  validateExternalSchema(schema);
  assert.ok(matchesExternalSchema(schema, {repo:'athena'}));
  assert.equal(matchesExternalSchema(schema, {}), false);
  assert.throws(() => validateExternalSchema({type:'object','x-mcp-header':['other']}), /header annotation/);
});
