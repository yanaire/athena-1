import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { privateTestDirectory } from './platform-test-helpers.ts';
import { Storage } from '../runtime/storage.ts';
import { BUILTIN_SKILLS_ID, ExtensionStore, emptyExtensionPin, mentionedSkills, validatePluginManifest } from '../runtime/extensions.ts';
import type { PluginManifest } from '../runtime/extensions.ts';
import { externalConfigurationDigest, externalVerificationDigest } from '../runtime/external-mcp-client.ts';
import type { ExternalServerDefinition, ExternalVerification } from '../runtime/external-mcp-client.ts';
import type { Context } from '../runtime/orchestration.ts';

function setup() {
  const directory = privateTestDirectory(join(tmpdir(), 'athena-extensions-'));
  const storage = new Storage(directory), store = new ExtensionStore(storage);
  return { directory, storage, store, close() { storage.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const ctx: Context = { projectId: 'project-a', sessionId: 'conversation-a', runId: 'run-a', taskId: 'task-a',
  parentTaskId: null, agentSessionId: 'agent-a', attemptId: 'attempt-a' };
const plugin: PluginManifest = { schemaVersion: 1, id: 'lab-procedures', name: 'Lab procedures', version: '1.0.0', description: 'A local instruction package.',
  skills: [{ id: 'check-sample', name: 'Check sample', description: 'Check a sample.', version: '1.0.0', body: 'Record the sample identifier from the actual input.', roles: ['child'], requiredCapabilities: ['read'] }] };
const server: ExternalServerDefinition = { id: 'lab', name: 'Lab MCP', transport: 'streamable-http', url: 'https://example.test/mcp', allowedTools: ['measure'], auth: 'none' };
function verification(config = server): ExternalVerification {
  const value = { protocolVersion: '2025-06-18' as const, serverInfo: { name: 'lab-server', version: '1.0.0' }, configDigest: externalConfigurationDigest(config),
    tools: [{ name: 'measure', inputSchema: { type: 'object', properties: { sample: { type: 'string' } }, required: ['sample'], additionalProperties: false } }], checkedAt: Date.now() };
  return { ...value, digest: externalVerificationDigest(value) };
}

test('catalog exposes twelve metadata records and only three automatic selections; selected body and usage are real', () => {
  const s = setup();
  try {
    const view = s.store.snapshot('project-a');
    assert.equal(view.skills.length, 12);
    assert.deepEqual(view.skills.filter(skill => skill.automaticEligible).map(skill => skill.id).sort(),
      ['athena-data-quality', 'athena-research-intake', 'athena-source-provenance']);
    assert.ok(!JSON.stringify(view).includes('## 확인 가능한 범위를 정하라'));
    const pin = s.store.pin('project-a');
    const loaded = s.store.loadSkill(pin, ctx, 'athena-data-quality', 'Inspect the attached CSV before calculation.', ['read'], 'automatic');
    assert.equal(loaded.status, 'loaded');
    assert.ok(loaded.instructions.includes('0을 일괄 결측으로 바꾸지 마라'));
    assert.equal(loaded.use.attemptId, ctx.attemptId);
    assert.equal(loaded.use.sha256, loaded.metadata.sha256);
    assert.equal(s.store.skillUses('project-a', 'run-a').length, 1);
    assert.equal(s.store.loadSkill(pin, ctx, 'athena-data-quality', 'Repeated selection', ['read']).use.id, loaded.use.id);
    assert.equal(s.store.skillUses('project-a').length, 1);
    assert.throws(() => s.store.loadSkill(pin, ctx, 'athena-plan-and-delegate', 'Planning', ['spawn_agent', 'wait_for_agents'], 'automatic'), /explicit/);
    const limited = s.store.loadSkill(pin, ctx, 'athena-literature-search', 'Requested literature search', ['read']);
    assert.equal(limited.status, 'limited'); assert.deepEqual(limited.missingCapabilities, ['literature.search']);
    assert.ok(limited.instructions.includes('Do not claim those steps ran'));
    assert.deepEqual(limited.use.effectiveCapabilities, ['read']);
  } finally { s.close(); }
});

test('skill package updates, disable and removal preserve original run bodies and restart history', () => {
  const s = setup();
  try {
    let view = s.store.install('project-a', plugin, 0);
    assert.equal(view.plugins.find(item => item.id === plugin.id)?.enabled, false);
    assert.equal(s.store.pin('project-a').skills.some(skill => skill.pluginId === plugin.id), false);
    view = s.store.setEnabled('project-a', plugin.id, true, view.revision);
    const pin = s.store.pin('project-a'), child = { ...ctx, parentTaskId: 'parent' };
    const old = s.store.loadSkill(pin, child, 'lab-procedures/check-sample', 'Inspect assigned sample', ['read']);
    assert.throws(() => s.store.loadSkill(pin, ctx, 'lab-procedures/check-sample', 'Wrong role', ['read']), /role/);
    assert.throws(() => s.store.loadSkill(pin, { ...child, projectId: 'project-b' }, 'lab-procedures/check-sample', 'Wrong project', ['read']), /another project/);
    const changed: PluginManifest = { ...plugin, version: '2.0.0', skills: [{ ...plugin.skills![0]!, version: '2.0.0', body: 'A different reviewed procedure.' }] };
    view = s.store.install('project-a', changed, view.revision);
    assert.equal(view.plugins.find(item => item.id === plugin.id)?.enabled, false);
    view = s.store.remove('project-a', plugin.id, view.revision);
    assert.equal(view.plugins.some(item => item.id === plugin.id), false);
    const reopened = new ExtensionStore(s.storage);
    const retry = reopened.loadSkill(pin, { ...child, attemptId: 'retry-a' }, 'lab-procedures/check-sample', 'Manual retry uses original procedure', ['read']);
    assert.equal(retry.instructions, old.instructions);
    assert.equal(reopened.skillUses('project-a').length, 2);
    view = reopened.install('project-a', plugin, view.revision);
    assert.equal(view.plugins.find(item => item.id === plugin.id)?.enabled, false);
    assert.equal(reopened.snapshot('project-b').plugins.length, 1);
  } finally { s.close(); }
});

test('settings revisions reject stale writes and skill disabling affects future selections only', () => {
  const s = setup();
  try {
    const pin = s.store.pin('project-a');
    let view = s.store.setSkillEnabled('project-a', 'athena-data-quality', false, 0);
    assert.throws(() => s.store.setSkillEnabled('project-a', 'athena-research-intake', false, 0), /changed/);
    assert.equal(s.store.pin('project-a').skills.some(skill => skill.id === 'athena-data-quality'), false);
    assert.ok(s.store.loadSkill(pin, ctx, 'athena-data-quality', 'Original run selection', ['read']));
    view = s.store.setEnabled('project-a', BUILTIN_SKILLS_ID, false, view.revision);
    assert.equal(view.skills.some(skill => skill.enabled), false);
    assert.ok(view.skills.some(skill => skill.configuredEnabled));
    assert.equal(s.store.pin('project-a').skills.length, 0);
    assert.throws(() => s.store.remove('project-a', BUILTIN_SKILLS_ID), /disabled/);
    s.store.assertPinAvailable(emptyExtensionPin('project-a'));
    assert.throws(() => s.store.loadSkill(emptyExtensionPin('project-a'), ctx, 'athena-research-intake', 'Legacy run', []), /not enabled/);
  } finally { s.close(); }
});

test('external registration must be verified before enablement and config updates invalidate verification', () => {
  const s = setup();
  try {
    const remote: PluginManifest = { ...plugin, skills: [], mcpServers: [server] };
    let view = s.store.install('project-a', remote);
    assert.throws(() => s.store.setEnabled('project-a', plugin.id, true), /verification/);
    const configured = s.store.getConfiguredServer('project-a', plugin.id, 'lab');
    view = s.store.recordVerification('project-a', plugin.id, 'lab', verification(), configured.pluginRevision, undefined, view.revision);
    view = s.store.setEnabled('project-a', plugin.id, true, view.revision);
    const pin = s.store.pin('project-a');
    assert.equal(pin.servers.length, 1);
    assert.equal(s.store.getServer(pin, 'lab-procedures/lab').definition.url, server.url);
    view = s.store.install('project-a', { ...remote, version: '2.0.0', mcpServers: [{ ...server, url: 'https://second.example.test/mcp' }] }, view.revision);
    assert.equal(view.plugins.find(item => item.id === plugin.id)?.servers[0]?.status, 'not_checked');
    assert.throws(() => s.store.recordVerification('project-a', plugin.id, 'lab', verification(), configured.pluginRevision), /changed/);
    assert.equal(s.store.getServer(pin, 'lab-procedures/lab').definition.url, server.url);
    assert.throws(() => s.store.getServer(s.store.pin('project-a'), 'lab-procedures/lab'), /did not enable/);
  } finally { s.close(); }
});

test('bearer credential refs are host namespaced and excluded from the public snapshot', () => {
  const s = setup();
  try {
    const authenticated = { ...server, auth: 'bearer' as const }, remote: PluginManifest = { ...plugin, skills: [], mcpServers: [authenticated] };
    s.store.install('project-a', remote);
    const configured = s.store.getConfiguredServer('project-a', plugin.id, 'lab'), checked = verification(authenticated);
    assert.throws(() => s.store.recordVerification('project-a', plugin.id, 'lab', checked, configured.pluginRevision, 'openai/default'), /host-owned/);
    const reference = 'athena.external-mcp/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const view = s.store.recordVerification('project-a', plugin.id, 'lab', checked, configured.pluginRevision, reference);
    assert.ok(!JSON.stringify(view).includes(reference));
    assert.equal(view.plugins.find(item => item.id === plugin.id)?.servers[0]?.credentialConfigured, true);
    s.store.setEnabled('project-a', plugin.id, true);
    const pinned = s.store.pin('project-a');
    assert.equal(pinned.servers[0]?.verification.credentialRef, reference);
    let refreshed = s.store.recordVerification('project-a', plugin.id, 'lab', { ...checked, checkedAt: checked.checkedAt + 1 }, configured.pluginRevision, reference);
    assert.equal(refreshed.plugins.find(item => item.id === plugin.id)?.enabled, true);
    const replacement = 'athena.external-mcp/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    refreshed = s.store.recordVerification('project-a', plugin.id, 'lab', checked, configured.pluginRevision, replacement);
    assert.equal(refreshed.plugins.find(item => item.id === plugin.id)?.enabled, false);
    assert.equal(s.store.getServer(pinned, 'lab-procedures/lab').verification.credentialRef, reference);
    s.store.setEnabled('project-a', plugin.id, true);
    const changedTool = { ...checked, tools: [{ name: 'measure', inputSchema: { type: 'object' } }] };
    refreshed = s.store.recordVerification('project-a', plugin.id, 'lab', { ...changedTool, digest: externalVerificationDigest(changedTool) }, configured.pluginRevision, replacement);
    assert.equal(refreshed.plugins.find(item => item.id === plugin.id)?.enabled, false);
  } finally { s.close(); }
});

test('legacy verification-only credentials survive a failed probe without remaining verified or leaking references', () => {
  const s = setup();
  try {
    const authenticated = { ...server, auth: 'bearer' as const };
    const remote: PluginManifest = { ...plugin, skills: [], mcpServers: [authenticated] };
    let view = s.store.install('project-a', remote);
    const configured = s.store.getConfiguredServer('project-a', plugin.id, 'lab');
    const reference = 'athena.external-mcp/cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    view = s.store.recordVerification('project-a', plugin.id, 'lab', verification(authenticated), configured.pluginRevision, reference, view.revision);
    view = s.store.setEnabled('project-a', plugin.id, true, view.revision);
    const pinned = s.store.pin('project-a');
    const key = 'extensions:project:project-a';
    const legacy = s.storage.get<{ plugins: { credentialRefs?: Record<string, string> }[] }>(key)!;
    for (const entry of legacy.plugins) delete entry.credentialRefs;
    s.storage.set(key, legacy);
    const upgraded = new ExtensionStore(s.storage);
    assert.equal(upgraded.getConfiguredServer('project-a', plugin.id, 'lab').credentialRef, reference);
    view = upgraded.recordVerificationFailure('project-a', plugin.id, 'lab', 'Synthetic network failure', configured.pluginRevision, view.revision);
    const reopened = new ExtensionStore(s.storage);
    assert.equal(reopened.getConfiguredServer('project-a', plugin.id, 'lab').credentialRef, reference);
    const failed = reopened.snapshot('project-a').plugins.find(entry => entry.id === plugin.id)!;
    assert.equal(failed.enabled, false);
    assert.equal(failed.servers[0]?.status, 'failed');
    assert.equal(failed.servers[0]?.credentialConfigured, true);
    assert.equal(failed.servers[0]?.verification, undefined);
    assert.ok(!JSON.stringify(failed).includes(reference));
    assert.throws(() => reopened.setEnabled('project-a', plugin.id, true, view.revision), /verification/);
    assert.equal(reopened.getServer(pinned, 'lab-procedures/lab').verification.credentialRef, reference);
    view = reopened.install('project-a', { ...remote, version: '2.0.0', mcpServers: [server] }, view.revision);
    assert.equal(reopened.getConfiguredServer('project-a', plugin.id, 'lab').credentialRef, undefined);
    assert.equal(view.plugins.find(entry => entry.id === plugin.id)?.servers[0]?.credentialConfigured, false);
    assert.throws(() => reopened.recordVerification('project-a', plugin.id, 'lab', verification(),
      reopened.getConfiguredServer('project-a', plugin.id, 'lab').pluginRevision, reference), /authentication mode/);
  } finally { s.close(); }
});

test('manifest and archive validation reject code, namespace injection, unsupported transport and tampered pinned bodies', () => {
  const s = setup();
  try {
    for (const bad of [{ ...plugin, command: 'sh' }, { ...plugin, id: BUILTIN_SKILLS_ID }, { ...plugin, skills: [{ ...plugin.skills![0], automaticEligible: true }] },
      { ...plugin, mcpServers: [{ ...server, transport: 'stdio', command: 'npx' }] }]) assert.throws(() => validatePluginManifest(bad));
    s.store.install('project-a', plugin); s.store.setEnabled('project-a', plugin.id, true);
    const pin = s.store.pin('project-a');
    assert.throws(() => s.store.assertPinAvailable({ ...pin, skills: [] }), /snapshot/);
    const revision = pin.plugins.find(item => item.id === plugin.id)!.revision;
    s.storage.set('extensions:package:' + revision, { builtin: false, manifest: { ...plugin, description: 'tampered' } });
    assert.throws(() => s.store.assertPinAvailable(pin), /unavailable or changed/);
  } finally { s.close(); }
});

test('catalog body tampering and directory symlinks cannot silently replace the reviewed skill', () => {
  const s = setup(), copy = mkdtempSync(join(tmpdir(), 'athena-skills-'));
  try {
    cpSync(new URL('../skills/', import.meta.url), copy, { recursive: true });
    const path = join(copy, 'athena-data-quality', 'SKILL.md');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original + '\nUnexpected replacement.');
    assert.throws(() => new ExtensionStore(s.storage, { catalogDirectory: copy }), /content hash/);
    rmSync(path);
    const outside = join(s.directory, 'untrusted-skill.md'); writeFileSync(outside, original);
    symlinkSync(outside, path);
    assert.throws(() => new ExtensionStore(s.storage, { catalogDirectory: copy }), /reviewed directory/);
  } finally { rmSync(copy, { recursive: true, force: true }); s.close(); }
});

test('chat skill mentions use the admitted project and role, and ignore literal text', () => {
  const s = setup();
  try {
    const installed = () => s.store.snapshot('project-a').skills;
    const extension = { ...plugin, skills: [
      ...plugin.skills!,
      { ...plugin.skills![0]!, id: 'measure', roles: ['parent' as const] },
    ] };
    s.store.install('project-a', extension);
    s.store.setEnabled('project-a', plugin.id, true);
    const pin = s.store.pin('project-a');
    const prompt = [
      '($lab-procedures/measure), $athena-data-quality! $lab-procedures/measure',
      '`$lab-procedures/check-sample`',
      '```text', '$lab-procedures/check-sample', '```',
      'cost $25; variables $x and \\$lab-procedures/check-sample.',
      'foo$lab-procedures/check-sample $lab-procedures/check-sample-other',
    ].join('\n');
    assert.deepEqual(mentionedSkills(prompt, pin, installed), ['lab-procedures/measure', 'athena-data-quality']);
    assert.throws(() => mentionedSkills('$lab-procedures/check-sample', pin, installed), /workers only/);
    s.store.setEnabled('project-a', plugin.id, false);
    assert.throws(() => mentionedSkills('$lab-procedures/measure', s.store.pin('project-a'), installed), /Enable/);
    assert.deepEqual(mentionedSkills('$lab-procedures/measure', pin, installed), ['lab-procedures/measure']);
  } finally { s.close(); }
});

test('GitHub installer pins the official readonly endpoint and isolates installation per project', () => {
  const s = setup();
  try {
    const initial = s.store.installGitHub('project-a', 0);
    const github = initial.plugins.find(plugin => plugin.id === 'athena-github')!;
    assert.equal(github.enabled, false);
    assert.equal(github.servers.length, 1);
    const [server] = github.servers;
    assert.equal(server!.url, 'https://api.githubcopilot.com/mcp/x/repos/readonly');
    assert.deepEqual(server!.allowedTools, ['search_repositories','list_branches','list_commits']);
    assert.equal(server!.auth, 'bearer');
    assert.equal(s.store.installGitHub('project-a', initial.revision).revision, initial.revision);
    assert.throws(() => s.store.setEnabled('project-a', github.id, true), /verification/);
    assert.throws(() => s.store.install('project-a', {...plugin, id: github.id}), /reserved/);
    assert.equal(s.store.snapshot('project-b').plugins.some(p => p.id === github.id), false);
    const reopened = new ExtensionStore(s.storage);
    assert.deepEqual(reopened.snapshot('project-a'), initial);
    assert.equal(reopened.remove('project-a', github.id, initial.revision).plugins.some(p => p.id === github.id), false);
  } finally {s.close();}
});
