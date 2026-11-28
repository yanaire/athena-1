import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from './orchestration.ts';
import type { Storage } from './storage.ts';
import { canonicalJson, extensionDigest, externalConfigurationDigest, validateExternalServer, validateExternalVerification } from './external-mcp-client.ts';
import type { ExternalServerDefinition, ExternalVerification } from './external-mcp-client.ts';

export type { ExternalServerDefinition, ExternalVerification } from './external-mcp-client.ts';
export type SkillRole = 'parent' | 'child';
export type SkillDefinition = {
  readonly id: string; readonly name: string; readonly description: string; readonly version: string; readonly body: string;
  readonly roles: readonly SkillRole[]; readonly requiredCapabilities: readonly string[];
};
export type PluginManifest = {
  readonly schemaVersion: 1; readonly id: string; readonly name: string; readonly description: string; readonly version: string;
  readonly skills?: readonly SkillDefinition[]; readonly mcpServers?: readonly ExternalServerDefinition[];
};
export type SkillMetadata = Omit<SkillDefinition, 'body'> & {
  readonly sha256: string; readonly automaticEligible: boolean; readonly pluginId: string; readonly pluginRevision: string;
  readonly sourceCommit?: string;
};
export type SelectedSkill = SkillMetadata & { readonly enabled: boolean; readonly configuredEnabled: boolean };
export type PinnedExternalServer = {
  readonly id: string; readonly serverId: string; readonly pluginId: string; readonly pluginRevision: string;
  readonly definition: ExternalServerDefinition; readonly verification: ExternalVerification;
};
export type ExtensionPin = {
  readonly schemaVersion: 1; readonly projectId: string; readonly revision: string; readonly configurationRevision: number;
  readonly plugins: readonly { readonly id: string; readonly revision: string }[];
  readonly skills: readonly SkillMetadata[]; readonly servers: readonly PinnedExternalServer[];
};
export type SkillUse = Context & {
  readonly id: string; readonly skillId: string; readonly skillVersion: string; readonly sha256: string;
  readonly pluginId: string; readonly pluginRevision: string; readonly pinRevision: string; readonly reason: string;
  readonly mode: 'explicit' | 'automatic'; readonly role: SkillRole; readonly status: 'loaded' | 'limited';
  readonly missingCapabilities: readonly string[]; readonly effectiveCapabilities: readonly string[]; readonly loadedAt: number;
};
export type LoadedSkill = {
  readonly metadata: SkillMetadata; readonly instructions: string; readonly use: SkillUse;
  readonly status: 'loaded' | 'limited'; readonly missingCapabilities: readonly string[];
};
export type PublicExternalServer = ExternalServerDefinition & {
  readonly status: 'not_checked' | 'verified' | 'failed'; readonly credentialConfigured: boolean;
  readonly verification?: Omit<ExternalVerification, 'credentialRef'>;
  readonly lastError?: string; readonly checkedAt?: number;
};
export type PluginSnapshot = {
  readonly id: string; readonly name: string; readonly description: string; readonly version: string; readonly revision: string;
  readonly enabled: boolean; readonly builtin: boolean; readonly installedAt: number; readonly updatedAt: number;
  readonly skills: readonly SelectedSkill[]; readonly servers: readonly PublicExternalServer[];
};
export type ExtensionSnapshot = {
  readonly schemaVersion: 1; readonly projectId: string; readonly revision: number;
  readonly plugins: readonly PluginSnapshot[]; readonly skills: readonly SelectedSkill[]; readonly skillUses: readonly SkillUse[];
};
export class ExtensionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'ExtensionError'; this.code = code; }
}
export const EXTENSION_LIMITS = Object.freeze({ packageBytes: 512 * 1024, skillBytes: 64 * 1024, plugins: 32, skills: 32, servers: 16, uses: 10000 });
export const BUILTIN_SKILLS_ID = 'athena-research-skills';
const githubRepositoryPlugin: PluginManifest = {
  schemaVersion: 1, id: 'athena-github', name: 'GitHub', version: '1.0.0',
  description: 'Search repositories and inspect branches and commit history through GitHub’s official read-only MCP server.',
  mcpServers: [{id: 'repositories', name: 'GitHub repositories', transport: 'streamable-http',
    url: 'https://api.githubcopilot.com/mcp/x/repos/readonly', auth: 'bearer',
    allowedTools: ['search_repositories', 'list_branches', 'list_commits']}],
};
const CATALOG_SHA256 = '404f09cd98b20e9790a7dc3d9dbd1e34e5987e5c05f5c2ffdd38e411b2f763aa';
const CATALOG_COMMIT = '987e61d8b922c609b0fda3794a06f835c9b36530';
const AUTOMATIC_SKILLS = new Set(['athena-research-intake', 'athena-source-provenance', 'athena-data-quality']);
/** Resolve explicit mentions against this project's pinned procedures. Ignore literal code and prices. */
export function mentionedSkills(message: string, pin: ExtensionPin, installed: () => readonly SelectedSkill[]): string[] {
  if (!message.includes('$')) return [];
  const ids = new Set<string>();
  const available = new Map(pin.skills.map(skill => [skill.id, skill]));
  let installedIds: Set<string> | undefined;
  let codeDelimiter = 0;
  const tokens = /`+|(?:^|[\s(])\$([a-z][a-z0-9-]{0,63}(?:\/[a-z][a-z0-9-]{0,63})?)(?=$|[\s),.!?;:\]])/gu;
  for (const token of message.matchAll(tokens)) {
    if (token[0].startsWith('`')) {
      if (!codeDelimiter || token[0].length === codeDelimiter) codeDelimiter = codeDelimiter ? 0 : token[0].length;
      continue;
    }
    if (codeDelimiter) continue;
    const id = token[1]!;
    const skill = available.get(id);
    if (skill?.roles.includes('parent')) { ids.add(id); continue; }
    installedIds ??= new Set(installed().map(s => s.id));
    if (skill || installedIds.has(id)) throw new ExtensionError('SKILL_NOT_AVAILABLE',
      skill ? id+' is available to workers only. Delegate it to a worker.' : 'Enable '+id+' in this project before sending the request.');
  }
  return [...ids];
}
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const digestText = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || value.includes('\0'))
    throw new ExtensionError('INVALID_EXTENSION', 'Invalid ' + field + '.');
  return value;
}
function id(value: unknown, field: string): string {
  const checked = text(value, field, 64);
  if (!ID.test(checked)) throw new ExtensionError('INVALID_EXTENSION', field + ' must use lowercase letters, digits and hyphens.');
  return checked;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ExtensionError('INVALID_EXTENSION', 'Manifest contains unsupported fields. No executable hooks or external files are loaded.');
}
function clone<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}
function manifest(value: unknown, builtin = false): PluginManifest {
  if (!object(value)) throw new ExtensionError('INVALID_EXTENSION', 'Expected an Athena plugin manifest object.');
  fields(value, ['schemaVersion', 'id', 'name', 'description', 'version', 'skills', 'mcpServers']);
  if (value.schemaVersion !== 1) throw new ExtensionError('INVALID_EXTENSION', 'Unsupported plugin manifest version.');
  const pluginId = id(value.id, 'plugin ID');
  if (!builtin && pluginId.startsWith('athena-')) throw new ExtensionError('RESERVED_PLUGIN', 'The athena- plugin namespace is reserved for bundled procedures.');
  const version = text(value.version, 'plugin version', 64);
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new ExtensionError('INVALID_EXTENSION', 'Use a semantic plugin version such as 1.0.0.');
  const skills = value.skills ?? [], servers = value.mcpServers ?? [];
  if (!Array.isArray(skills) || skills.length > EXTENSION_LIMITS.skills || !Array.isArray(servers) || servers.length > EXTENSION_LIMITS.servers || skills.length + servers.length === 0)
    throw new ExtensionError('INVALID_EXTENSION', 'A plugin must contain bounded skill or server definitions.');
  const parsedSkills: SkillDefinition[] = skills.map(raw => {
    if (!object(raw)) throw new ExtensionError('INVALID_EXTENSION', 'Invalid skill definition.');
    fields(raw, ['id', 'name', 'description', 'version', 'body', 'roles', 'requiredCapabilities']);
    if (!Array.isArray(raw.roles) || raw.roles.length < 1 || raw.roles.length > 2 || raw.roles.some(role => role !== 'parent' && role !== 'child') || new Set(raw.roles).size !== raw.roles.length)
      throw new ExtensionError('INVALID_EXTENSION', 'Choose parent and/or child skill roles.');
    if (!Array.isArray(raw.requiredCapabilities) || raw.requiredCapabilities.length > 32
      || !raw.requiredCapabilities.every(cap => typeof cap === 'string' && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(cap)) || new Set(raw.requiredCapabilities).size !== raw.requiredCapabilities.length)
      throw new ExtensionError('INVALID_EXTENSION', 'Invalid required capability list.');
    return { id: id(raw.id, 'skill ID'), name: text(raw.name, 'skill name', 128), description: text(raw.description, 'skill description', 2048),
      version: text(raw.version, 'skill version', 64), body: text(raw.body, 'skill body', EXTENSION_LIMITS.skillBytes),
      roles: [...raw.roles] as SkillRole[], requiredCapabilities: [...raw.requiredCapabilities] as string[] };
  });
  const parsedServers = servers.map(validateExternalServer);
  if (new Set(parsedSkills.map(s => s.id)).size !== parsedSkills.length || new Set(parsedServers.map(s => s.id)).size !== parsedServers.length)
    throw new ExtensionError('INVALID_EXTENSION', 'Skill and server IDs must be unique within a plugin.');
  const result: PluginManifest = { schemaVersion: 1, id: pluginId, name: text(value.name, 'plugin name', 128), description: text(value.description, 'plugin description', 2048),
    version, skills: parsedSkills, mcpServers: parsedServers };
  if (Buffer.byteLength(canonicalJson(result)) > EXTENSION_LIMITS.packageBytes) throw new ExtensionError('INVALID_EXTENSION', 'Plugin package exceeds its byte limit.');
  return freeze(clone(result));
}
export const validatePluginManifest = (value: unknown) => manifest(value);

type StoredPlugin = { id: string; revision: string; enabled: boolean; installedAt: number; updatedAt: number;
  credentialRefs?: Record<string, string>;
  verifications: Record<string, ExternalVerification>; errors: Record<string, { message: string; checkedAt: number }> };
type ProjectState = { schemaVersion: 1; revision: number; plugins: StoredPlugin[]; skillEnabled: Record<string, boolean>; uses: SkillUse[] };
type Archive = { manifest: PluginManifest; builtin: boolean };
type MetadataStorage = Pick<Storage, 'get' | 'set'>;
const savedCredentialRef = (plugin: StoredPlugin, serverId: string) => plugin.credentialRefs && Object.hasOwn(plugin.credentialRefs, serverId)
  ? plugin.credentialRefs[serverId] : undefined;
const qualifiedSkillId = (plugin: PluginManifest, localId: string) => plugin.id === BUILTIN_SKILLS_ID ? localId : plugin.id + '/' + localId;
const archiveKey = (revision: string) => 'extensions:package:' + revision;
const stateKey = (projectId: string) => 'extensions:project:' + encodeURIComponent(text(projectId, 'project ID'));
function pinValue(value: Omit<ExtensionPin, 'revision'>): ExtensionPin { return freeze({ ...value, revision: extensionDigest(value) }); }
export function emptyExtensionPin(projectId: string): ExtensionPin {
  return pinValue({ schemaVersion: 1, projectId: text(projectId, 'project ID'), configurationRevision: 0, plugins: [], skills: [], servers: [] });
}

function readCatalog(directory: string): PluginManifest {
  const root = realpathSync(directory), path = join(root, 'catalog.json');
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size > 64 * 1024) throw new ExtensionError('CATALOG_INVALID', 'The bundled skill catalog is unavailable.');
  const bytes = readFileSync(path);
  if (digestText(bytes) !== CATALOG_SHA256) throw new ExtensionError('CATALOG_CHANGED', 'The bundled skill catalog hash does not match this host.');
  const catalog: unknown = JSON.parse(bytes.toString('utf8'));
  if (!object(catalog) || !Array.isArray(catalog.skills) || catalog.skills.length !== 12) throw new ExtensionError('CATALOG_INVALID', 'Expected the reviewed twelve-skill catalog.');
  const skills = catalog.skills.map(row => {
    if (!object(row) || !ID.test(String(row.id)) || row.path !== row.id + '/SKILL.md' || row.sourceCommit !== CATALOG_COMMIT || typeof row.sha256 !== 'string')
      throw new ExtensionError('CATALOG_INVALID', 'Invalid bundled skill reference.');
    const path = resolve(root, String(row.path));
    if (!path.startsWith(root + sep) || realpathSync(path) !== path || !lstatSync(path).isFile() || lstatSync(path).size > EXTENSION_LIMITS.skillBytes)
      throw new ExtensionError('CATALOG_INVALID', 'A bundled skill is outside its reviewed directory or size limit.');
    const body = readFileSync(path);
    if (digestText(body) !== row.sha256) throw new ExtensionError('SKILL_CHANGED', 'A bundled skill no longer matches its reviewed content hash.');
    const source = new TextDecoder('utf-8', { fatal: true }).decode(body);
    if (!source.startsWith('---\nname: ' + row.id + '\n') || !source.includes('\n---\n')) throw new ExtensionError('CATALOG_INVALID', 'Bundled skill frontmatter does not match its catalog ID.');
    return { id: row.id, name: row.name, description: row.description, version: row.version, body: source,
      roles: row.roles, requiredCapabilities: row.requiredCapabilities };
  });
  return manifest({ schemaVersion: 1, id: catalog.id, name: catalog.name, description: catalog.description, version: catalog.version, skills }, true);
}

export class ExtensionStore {
  readonly #storage: MetadataStorage;
  readonly #builtin: { manifest: PluginManifest; revision: string };
  constructor(storage: MetadataStorage, options: { readonly catalogDirectory?: string } = {}) {
    this.#storage = storage;
    const builtin = readCatalog(options.catalogDirectory ?? fileURLToPath(new URL('../skills/', import.meta.url)));
    const revision = extensionDigest(builtin);
    this.#builtin = { manifest: builtin, revision };
    this.#archive(builtin, true);
  }
  #archive(value: PluginManifest, builtin = false): string {
    const revision = extensionDigest(value), key = archiveKey(revision);
    const previous = this.#storage.get<Archive>(key);
    if (previous) {
      if (previous.builtin !== builtin || extensionDigest(previous.manifest) !== revision) throw new ExtensionError('EXTENSION_CHANGED', 'An archived plugin revision failed its integrity check.');
    } else this.#storage.set(key, { manifest: value, builtin } satisfies Archive);
    return revision;
  }
  #readArchive(revision: string, pluginId?: string): Archive {
    if (!SHA.test(revision)) throw new ExtensionError('EXTENSION_UNAVAILABLE', 'Invalid pinned plugin revision.');
    const value = this.#storage.get<Archive>(archiveKey(revision));
    if (!value || extensionDigest(value.manifest) !== revision || pluginId !== undefined && value.manifest.id !== pluginId)
      throw new ExtensionError('EXTENSION_UNAVAILABLE', 'The original plugin revision is unavailable or changed.');
    manifest(value.manifest, value.builtin);
    return value;
  }
  #state(projectId: string): ProjectState {
    const value = this.#storage.get<ProjectState>(stateKey(projectId));
    if (value) {
      if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || !Array.isArray(value.plugins) || value.plugins.length > EXTENSION_LIMITS.plugins
        || !object(value.skillEnabled) || !Array.isArray(value.uses)) throw new ExtensionError('EXTENSION_STATE_INVALID', 'Invalid saved project extension state.');
      const state = clone(value);
      // Older states bound the saved credential only to a successful probe.
      // Preserve that binding before a later failure invalidates verification.
      for (const plugin of state.plugins) if (plugin.credentialRefs === undefined) {
        plugin.credentialRefs = Object.fromEntries(Object.entries(plugin.verifications).flatMap(([serverId, verification]) =>
          typeof verification.credentialRef === 'string' ? [[serverId, verification.credentialRef]] : []));
      }
      return state;
    }
    return { schemaVersion: 1, revision: 0, plugins: [{ id: BUILTIN_SKILLS_ID, revision: this.#builtin.revision,
      enabled: true, installedAt: 0, updatedAt: 0, credentialRefs: {}, verifications: {}, errors: {} }], skillEnabled: {}, uses: [] };
  }
  #write(projectId: string, state: ProjectState, expectedRevision?: number) {
    const current = this.#state(projectId);
    if (expectedRevision !== undefined && expectedRevision !== current.revision || state.revision !== current.revision)
      throw new ExtensionError('STALE_EXTENSION_REVISION', 'Project extension settings changed. Refresh before saving.');
    state.revision++;
    this.#storage.set(stateKey(projectId), state);
    return this.snapshot(projectId);
  }
  #metadata(value: PluginManifest, revision: string): SkillMetadata[] {
    return (value.skills ?? []).map(skill => {
      const { body, ...fields } = skill;
      return { ...fields, id: qualifiedSkillId(value, skill.id), sha256: digestText(body),
        automaticEligible: value.id === BUILTIN_SKILLS_ID && AUTOMATIC_SKILLS.has(skill.id), pluginId: value.id, pluginRevision: revision,
        ...(value.id === BUILTIN_SKILLS_ID ? { sourceCommit: CATALOG_COMMIT } : {}) };
    });
  }
  snapshot(projectId: string): ExtensionSnapshot {
    const state = this.#state(projectId);
    const plugins = state.plugins.map(stored => {
      const { manifest: value, builtin } = this.#readArchive(stored.revision, stored.id);
      const skills = this.#metadata(value, stored.revision).map(skill => ({ ...skill,
        configuredEnabled: state.skillEnabled[skill.id] !== false, enabled: stored.enabled && state.skillEnabled[skill.id] !== false }));
      const servers: PublicExternalServer[] = (value.mcpServers ?? []).map(server => {
        const verification = stored.verifications[server.id], error = stored.errors[server.id];
        const { credentialRef: _credential, ...safe } = verification ?? {};
        return { ...server, status: verification ? 'verified' : error ? 'failed' : 'not_checked',
          credentialConfigured: server.auth === 'bearer' && Boolean(savedCredentialRef(stored, server.id)), ...(verification ? { verification: safe as Omit<ExternalVerification, 'credentialRef'> } : {}),
          ...(error ? { lastError: error.message, checkedAt: error.checkedAt } : {}) };
      });
      return { id: value.id, name: value.name, description: value.description, version: value.version, revision: stored.revision,
        enabled: stored.enabled, builtin, installedAt: stored.installedAt, updatedAt: stored.updatedAt, skills, servers };
    });
    return freeze({ schemaVersion: 1, projectId, revision: state.revision, plugins, skills: plugins.flatMap(plugin => plugin.skills), skillUses: state.uses });
  }
  install(projectId: string, raw: unknown, expectedRevision?: number): ExtensionSnapshot {
    return this.#install(projectId, manifest(raw), false, expectedRevision);
  }
  installGitHub(projectId: string, expectedRevision?: number): ExtensionSnapshot {
    return this.#install(projectId, manifest(githubRepositoryPlugin, true), true, expectedRevision);
  }
  #install(projectId: string, value: PluginManifest, builtin: boolean, expectedRevision?: number): ExtensionSnapshot {
    const state = this.#state(projectId), revision = extensionDigest(value);
    const old = state.plugins.find(plugin => plugin.id === value.id);
    if (expectedRevision !== undefined && state.revision !== expectedRevision) throw new ExtensionError('STALE_EXTENSION_REVISION', 'Project extension settings changed.');
    if (old?.revision === revision) return this.snapshot(projectId);
    if (old && this.#readArchive(old.revision).manifest.version === value.version) throw new ExtensionError('PLUGIN_VERSION_CONFLICT', 'Change the plugin version before replacing its contents or configuration.');
    if (!old && state.plugins.length >= EXTENSION_LIMITS.plugins) throw new ExtensionError('PLUGIN_LIMIT', 'Project plugin limit reached.');
    this.#archive(value, builtin);
    const next: StoredPlugin = { id: value.id, revision, enabled: false, installedAt: old?.installedAt ?? Date.now(), updatedAt: Date.now(), credentialRefs: {}, verifications: {}, errors: {} };
    state.plugins = old ? state.plugins.map(plugin => plugin.id === value.id ? next : plugin) : [...state.plugins, next];
    return this.#write(projectId, state, expectedRevision);
  }
  setEnabled(projectId: string, pluginId: string, enabled: boolean, expectedRevision?: number): ExtensionSnapshot {
    if (typeof enabled !== 'boolean') throw new ExtensionError('INVALID_EXTENSION', 'Plugin enabled must be boolean.');
    const state = this.#state(projectId), plugin = state.plugins.find(item => item.id === pluginId);
    if (!plugin) throw new ExtensionError('PLUGIN_NOT_FOUND', 'Plugin is not installed in this project.');
    const archive = this.#readArchive(plugin.revision, pluginId);
    if (enabled) for (const server of archive.manifest.mcpServers ?? []) {
      const verification = plugin.verifications[server.id];
      validateExternalVerification(server, verification);
      if (server.auth === 'bearer' && !verification?.credentialRef) throw new ExtensionError('AUTH_REQUIRED', 'Check this server with its dedicated bearer credential before enabling it.');
    }
    plugin.enabled = enabled;
    return this.#write(projectId, state, expectedRevision);
  }
  remove(projectId: string, pluginId: string, expectedRevision?: number): ExtensionSnapshot {
    if (pluginId === BUILTIN_SKILLS_ID) throw new ExtensionError('BUILTIN_PLUGIN', 'Bundled skills may be disabled but not removed.');
    const state = this.#state(projectId);
    if (!state.plugins.some(plugin => plugin.id === pluginId)) throw new ExtensionError('PLUGIN_NOT_FOUND', 'Plugin is not installed in this project.');
    state.plugins = state.plugins.filter(plugin => plugin.id !== pluginId);
    // Archived revisions, pins and usage evidence remain available to historical runs.
    return this.#write(projectId, state, expectedRevision);
  }
  setSkillEnabled(projectId: string, skillId: string, enabled: boolean, expectedRevision?: number): ExtensionSnapshot {
    if (typeof enabled !== 'boolean' || !this.snapshot(projectId).skills.some(skill => skill.id === skillId)) throw new ExtensionError('SKILL_NOT_FOUND', 'Expected an installed skill and boolean selection.');
    const state = this.#state(projectId); state.skillEnabled[skillId] = enabled;
    return this.#write(projectId, state, expectedRevision);
  }
  getConfiguredServer(projectId: string, pluginId: string, serverId: string) {
    const state = this.#state(projectId), plugin = state.plugins.find(item => item.id === pluginId);
    if (!plugin) throw new ExtensionError('PLUGIN_NOT_FOUND', 'Plugin is not installed in this project.');
    const { manifest: value } = this.#readArchive(plugin.revision, pluginId), server = value.mcpServers?.find(item => item.id === serverId);
    if (!server) throw new ExtensionError('SERVER_NOT_FOUND', 'MCP server is not configured in this plugin.');
    return freeze({ pluginRevision: plugin.revision, configurationRevision: state.revision, server,
      credentialRef: server.auth === 'bearer' ? savedCredentialRef(plugin, serverId) : undefined, verification: plugin.verifications[serverId] });
  }
  recordVerification(projectId: string, pluginId: string, serverId: string, verification: ExternalVerification,
    expectedPluginRevision: string, credentialRef?: string, expectedRevision?: number): ExtensionSnapshot {
    const configured = this.getConfiguredServer(projectId, pluginId, serverId);
    if (configured.pluginRevision !== expectedPluginRevision) throw new ExtensionError('STALE_EXTENSION_REVISION', 'The MCP configuration changed during verification.');
    validateExternalVerification(configured.server, verification);
    if (verification.credentialRef !== undefined || credentialRef !== undefined && !/^athena\.external-mcp\/[a-f0-9-]{36}$/.test(credentialRef))
      throw new ExtensionError('INVALID_CREDENTIAL_REFERENCE', 'Only host-owned external MCP credential references may be bound.');
    if (configured.server.auth === 'bearer' && !credentialRef || configured.server.auth !== 'bearer' && credentialRef)
      throw new ExtensionError('INVALID_CREDENTIAL_REFERENCE', 'MCP credential reference does not match this authentication mode.');
    const state = this.#state(projectId), plugin = state.plugins.find(item => item.id === pluginId)!;
    const previous = plugin.verifications[serverId];
    if (plugin.enabled && (!previous || previous.digest !== verification.digest || previous.credentialRef !== credentialRef)) plugin.enabled = false;
    plugin.verifications[serverId] = clone({ ...verification, ...(credentialRef ? { credentialRef } : {}) });
    const credentialRefs = plugin.credentialRefs ??= {};
    if (credentialRef) credentialRefs[serverId] = credentialRef;
    else delete credentialRefs[serverId];
    delete plugin.errors[serverId];
    return this.#write(projectId, state, expectedRevision);
  }
  recordVerificationFailure(projectId: string, pluginId: string, serverId: string, message: string,
    expectedPluginRevision: string, expectedRevision?: number): ExtensionSnapshot {
    const configured = this.getConfiguredServer(projectId, pluginId, serverId);
    if (configured.pluginRevision !== expectedPluginRevision) throw new ExtensionError('STALE_EXTENSION_REVISION', 'The MCP configuration changed during verification.');
    const state = this.#state(projectId), plugin = state.plugins.find(item => item.id === pluginId)!;
    delete plugin.verifications[serverId]; plugin.errors[serverId] = { message: text(message, 'verification error', 2048), checkedAt: Date.now() };
    plugin.enabled = false;
    return this.#write(projectId, state, expectedRevision);
  }
  pin(projectId: string): ExtensionPin {
    const state = this.#state(projectId), selected = state.plugins.filter(plugin => plugin.enabled);
    const skills: SkillMetadata[] = [], servers: PinnedExternalServer[] = [];
    for (const plugin of selected) {
      const { manifest: value } = this.#readArchive(plugin.revision, plugin.id);
      skills.push(...this.#metadata(value, plugin.revision).filter(skill => state.skillEnabled[skill.id] !== false));
      for (const definition of value.mcpServers ?? []) {
        const verification = plugin.verifications[definition.id]; validateExternalVerification(definition, verification);
        if (definition.auth === 'bearer' && !verification?.credentialRef) throw new ExtensionError('AUTH_REQUIRED', 'An enabled MCP server has no verified credential.');
        servers.push({ id: plugin.id + '/' + definition.id, serverId: definition.id, pluginId: plugin.id, pluginRevision: plugin.revision,
          definition, verification: verification! });
      }
    }
    return pinValue({ schemaVersion: 1, projectId, configurationRevision: state.revision, plugins: selected.map(({ id, revision }) => ({ id, revision })), skills, servers });
  }
  assertPinAvailable(pin: ExtensionPin): void {
    const { revision, ...body } = pin;
    if (pin.schemaVersion !== 1 || !SHA.test(revision) || extensionDigest(body) !== revision) throw new ExtensionError('EXTENSION_PIN_INVALID', 'Run extension snapshot failed verification.');
    for (const plugin of pin.plugins) this.#readArchive(plugin.revision, plugin.id);
    for (const skill of pin.skills) {
      if (!pin.plugins.some(plugin => plugin.id === skill.pluginId && plugin.revision === skill.pluginRevision)) throw new ExtensionError('EXTENSION_PIN_INVALID', 'Skill is outside the pinned plugin selection.');
      const { manifest: value } = this.#readArchive(skill.pluginRevision, skill.pluginId);
      const known = this.#metadata(value, skill.pluginRevision).find(item => item.id === skill.id);
      if (!known || canonicalJson(known) !== canonicalJson(skill)) throw new ExtensionError('SKILL_CHANGED', 'Pinned skill metadata changed.');
    }
    for (const server of pin.servers) {
      if (!pin.plugins.some(plugin => plugin.id === server.pluginId && plugin.revision === server.pluginRevision)) throw new ExtensionError('EXTENSION_PIN_INVALID', 'Server is outside the pinned plugin selection.');
      const { manifest: value } = this.#readArchive(server.pluginRevision, server.pluginId);
      const original = value.mcpServers?.find(item => item.id === server.serverId);
      if (!original || server.id !== server.pluginId + '/' + server.serverId || externalConfigurationDigest(original) !== externalConfigurationDigest(server.definition))
        throw new ExtensionError('EXTENSION_PIN_INVALID', 'Pinned MCP server configuration changed.');
      validateExternalVerification(server.definition, server.verification);
      if (server.verification.credentialRef !== undefined && !/^athena\.external-mcp\/[a-f0-9-]{36}$/.test(server.verification.credentialRef))
        throw new ExtensionError('INVALID_CREDENTIAL_REFERENCE', 'Pinned external MCP credential namespace is invalid.');
    }
  }
  getServer(pin: ExtensionPin, serverId: string): PinnedExternalServer {
    this.assertPinAvailable(pin);
    const server = pin.servers.find(item => item.id === serverId);
    if (!server) throw new ExtensionError('SERVER_NOT_ENABLED', 'This run did not enable the requested MCP server.');
    return freeze(clone(server));
  }
  loadSkill(pin: ExtensionPin, ctx: Context, skillId: string, reason: string, capabilities: readonly string[], mode: 'explicit' | 'automatic' = 'explicit'): LoadedSkill {
    this.assertPinAvailable(pin);
    if (ctx.projectId !== pin.projectId) throw new ExtensionError('SKILL_SCOPE_MISMATCH', 'Skill selection belongs to another project.');
    for (const field of ['projectId', 'sessionId', 'runId', 'taskId', 'agentSessionId', 'attemptId'] as const) text(ctx[field], field);
    const metadata = pin.skills.find(skill => skill.id === skillId);
    if (!metadata) throw new ExtensionError('SKILL_NOT_ENABLED', 'This skill was not enabled for the original run.');
    const role: SkillRole = ctx.parentTaskId === null ? 'parent' : 'child';
    if (!metadata.roles.includes(role)) throw new ExtensionError('SKILL_ROLE_DENIED', 'This skill is not available to this agent role.');
    if (mode !== 'explicit' && mode !== 'automatic' || mode === 'automatic' && !metadata.automaticEligible)
      throw new ExtensionError('SKILL_SELECTION_DENIED', 'This procedure requires explicit skill selection.');
    text(reason, 'skill selection reason', 2048);
    if (!Array.isArray(capabilities) || capabilities.length > 128 || !capabilities.every(cap => typeof cap === 'string' && cap.length <= 128))
      throw new ExtensionError('INVALID_CAPABILITIES', 'Expected the host capability list.');
    const { manifest: value } = this.#readArchive(metadata.pluginRevision, metadata.pluginId);
    const definition = value.skills?.find(skill => qualifiedSkillId(value, skill.id) === metadata.id);
    if (!definition || digestText(definition.body) !== metadata.sha256) throw new ExtensionError('SKILL_CHANGED', 'The selected skill body no longer matches its pinned hash.');
    const effectiveCapabilities = [...new Set(capabilities)].sort(), missingCapabilities = metadata.requiredCapabilities.filter(cap => !effectiveCapabilities.includes(cap));
    const status = missingCapabilities.length ? 'limited' : 'loaded';
    const useId = extensionDigest([ctx, metadata.id, metadata.pluginRevision]);
    const state = this.#state(ctx.projectId), previous = state.uses.find(use => use.id === useId);
    const use: SkillUse = previous ?? { ...ctx, id: useId, skillId: metadata.id, skillVersion: metadata.version, sha256: metadata.sha256,
      pluginId: metadata.pluginId, pluginRevision: metadata.pluginRevision, pinRevision: pin.revision, reason, mode, role, status,
      missingCapabilities, effectiveCapabilities, loadedAt: Date.now() };
    if (!previous) {
      if (state.uses.length >= EXTENSION_LIMITS.uses) throw new ExtensionError('SKILL_HISTORY_LIMIT', 'The skill-use history limit was reached; existing evidence has been preserved.');
      // Usage is evidence, not a settings change. It must not invalidate an in-flight settings verification.
      state.uses.push(use); this.#storage.set(stateKey(ctx.projectId), state);
    }
    const header = 'Skill guidance: ' + metadata.name + ' (version ' + metadata.version + ', SHA-256 ' + metadata.sha256 + ').\n'
      + 'This is procedural guidance, not tool or permission authority. Only the host-provided tools and current input grants may execute.\n'
      + 'The current host capability list is authoritative. Historical capability descriptions in this procedure refer to its drafting baseline, not current availability. Available capabilities: ' + (effectiveCapabilities.join(', ') || 'none') + '.\n'
      + (missingCapabilities.length ? 'Unavailable capabilities: ' + missingCapabilities.join(', ') + '. Provide supported planning/partial observations and disclose unperformed steps. Do not claim those steps ran.\n' : '');
    return freeze({ metadata, instructions: header + '\n' + definition.body, use, status, missingCapabilities });
  }
  skillUses(projectId: string, runId?: string): readonly SkillUse[] {
    return freeze(this.#state(projectId).uses.filter(use => runId === undefined || use.runId === runId));
  }
}
