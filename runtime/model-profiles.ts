import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelCheck, ModelProfile, ResolvedModelReference } from '../athena-backend-handoff/athena-codex-ui/integrations/model-profiles.d.ts';
import { object } from './connections.ts';
import { ManagerError } from './orchestration.ts';
import type { CompatibleProvider } from './provider-manager.ts';
import { workerRoles, type WorkerRole, type RoleModels } from './worker-roles.ts';
import { CHATGPT_RESOURCE } from './chatgpt-catalog.ts';

type CatalogLookup = (provider: string, model: string) => Model<Api> | undefined;

function field(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new ManagerError('INVALID_PROFILE', `Enter a valid ${label}.`);
  }
  return value.trim();
}

function decode(body: unknown): ModelProfile {
  if (typeof body !== 'string') throw new ManagerError('INVALID_PROFILE', 'The stored model profile could not be read.');
  const profile: ModelProfile = JSON.parse(body);
  return profile;
}

export class ModelProfiles {
  readonly #db: DatabaseSync;
  readonly #lookup: CatalogLookup;
  readonly #endpoint: (provider: string) => string | undefined;

  constructor(directory: string, lookup: CatalogLookup, endpoint: (provider: string) => string | undefined = () => undefined) {
    this.#lookup = lookup;
    this.#endpoint = endpoint;
    this.#db = new DatabaseSync(join(directory, 'connections.sqlite'));
    this.#db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS model_profiles (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS worker_model_preferences (
      role TEXT PRIMARY KEY, profile TEXT NOT NULL REFERENCES model_profiles(id), thinking TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS model_profile_default (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT REFERENCES model_profiles(id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS compatible_providers (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;`);
  }

  compatibleProviders(): readonly CompatibleProvider[] {
    return this.#db.prepare('SELECT body FROM compatible_providers ORDER BY rowid').all().map(row => {
      if (typeof row.body !== 'string') throw new Error('Invalid stored endpoint.');
      const provider: CompatibleProvider = JSON.parse(row.body);
      return provider;
    });
  }

  saveEndpoint(provider: CompatibleProvider): void {
    this.#db.prepare('INSERT INTO compatible_providers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(provider.id, JSON.stringify(provider));
  }

  list(): readonly ModelProfile[] {
    return this.#db.prepare('SELECT body FROM model_profiles ORDER BY rowid').all().map(row => decode(row.body));
  }

  get(id: string): ModelProfile {
    const row = this.#db.prepare('SELECT body FROM model_profiles WHERE id=?').get(id);
    if (!row) throw new ManagerError('PROFILE_NOT_FOUND', 'The selected model profile no longer exists.');
    return decode(row.body);
  }

  get appDefaultProfileId(): string | null {
    const value = this.#db.prepare('SELECT id FROM model_profile_default WHERE singleton=1').get()?.id;
    return typeof value === 'string' ? value : null;
  }

  setAppDefault(id: string | null): void {
    if (id !== null) this.get(id);
    this.#db.prepare('INSERT INTO model_profile_default VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET id=excluded.id').run(id);
  }

  save(input: unknown, chatGPT?: { readonly model: Model<'openai-responses'>; readonly authRef: string }): ModelProfile {
    if (!object(input)) throw new ManagerError('INVALID_PROFILE', 'Expected a model profile.');
    const id = input.id === undefined ? randomUUID() : field(input.id, 'profile ID');
    const old = input.id === undefined ? undefined : this.get(id);
    if (old && input.revision !== old.revision) throw new ManagerError('PROFILE_CONFLICT', 'The profile changed. Reload it before saving.');
    const name = field(input.name, 'profile name');
    const provider = field(input.provider, 'provider');
    const modelId = field(input.modelId, 'model ID');
    const mode = input.authMode;
    if (mode !== undefined && mode !== 'chatgpt') throw new ManagerError('INVALID_PROFILE', 'Unknown profile authentication mode.');
    if (old?.authMode === 'chatgpt' && (mode !== 'chatgpt' || old.authRef !== chatGPT?.authRef)) {
      throw new ManagerError('PROFILE_CONFLICT', 'This profile belongs to a different ChatGPT registration. Create another profile.');
    }
    if (mode === 'chatgpt' && (!chatGPT || provider !== 'openai' || modelId !== chatGPT.model.id || input.accountRef !== chatGPT.authRef)) {
      throw new ManagerError('MODEL_UNAVAILABLE', 'Reload the current ChatGPT account catalog before saving.');
    }
    const model = mode === 'chatgpt' ? chatGPT?.model : this.#lookup(provider, modelId);
    if (!model) throw new ManagerError('MODEL_UNAVAILABLE', 'This model is not in the selected provider catalog.');
    const supportedLevels = getSupportedThinkingLevels(model);
    const thinkingLevel = supportedLevels.find(level => level === (input.thinkingLevel ?? 'off'));
    if (thinkingLevel === undefined) throw new ManagerError('MODEL_UNAVAILABLE', 'The model does not support the requested reasoning level.');
    const endpoint = mode === 'chatgpt' ? CHATGPT_RESOURCE : this.#endpoint(provider);
    if (old && this.workerPreferences().some(role => role.profileId === id && role.thinkingLevel !== null &&
      !supportedLevels.some(level => level === role.thinkingLevel))) {
      throw new ManagerError('PROFILE_IN_USE', 'Update the assigned worker reasoning levels before changing this profile to that model.');
    }
    const profile: ModelProfile = { id, name, provider, modelId, thinkingLevel,
      supportedLevels, revision: (old?.revision ?? 0) + 1, authRef: chatGPT?.authRef ?? provider,
      ...(mode === 'chatgpt' ? { authMode: mode } : {}), ...(endpoint ? { endpoint } : {}) };
    this.#db.prepare(`INSERT INTO model_profiles VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body`)
      .run(id, profile.revision, JSON.stringify(profile));
    return profile;
  }

  supportedLevels(profile:ModelProfile){
    const model=profile.authMode==='chatgpt'?undefined:this.#lookup(profile.provider,profile.modelId);
    return model?getSupportedThinkingLevels(model):profile.supportedLevels??[profile.thinkingLevel];
  }
  workerPreferences(){
    return Object.entries(workerRoles).map(([role,label])=>{
      const row=this.#db.prepare('SELECT profile,thinking FROM worker_model_preferences WHERE role=?').get(role);
      return {role,label,profileId:row?String(row.profile):null,thinkingLevel:row?.thinking==null?null:String(row.thinking)};
    });
  }
  setWorkerPreference(role:string,profileId:string|null,level:string|null){
    if(!Object.hasOwn(workerRoles,role))throw new ManagerError('INVALID_ROLE','Unknown worker role.');
    if(profileId===null){
      if(level!==null)throw new ManagerError('INVALID_ROLE','Select a profile before setting a reasoning level.');
      this.#db.prepare('DELETE FROM worker_model_preferences WHERE role=?').run(role);
    }else{
      const profile=this.get(profileId);
      if(level!==null&&!this.supportedLevels(profile).some(value=>value===level))throw new ManagerError('MODEL_UNAVAILABLE','This profile does not support that reasoning level.');
      this.#db.prepare('INSERT INTO worker_model_preferences VALUES(?,?,?) ON CONFLICT(role) DO UPDATE SET profile=excluded.profile, thinking=excluded.thinking').run(role,profileId,level);
    }
  }
  roleModels():RoleModels{
    const models:RoleModels={};
    for(const pref of this.workerPreferences())if(pref.profileId){
      const selected=this.resolve(pref.profileId,null)!;
      models[pref.role as WorkerRole]={...selected,source:'role',thinkingLevel:pref.thinkingLevel??selected.thinkingLevel};
    }
    return models;
  }

  remove(id: string, revision: unknown): void {
    if(this.#db.prepare('SELECT 1 FROM worker_model_preferences WHERE profile=?').get(id))throw new ManagerError('PROFILE_IN_USE','Clear worker role selections before deleting this profile.');
    const profile = this.get(id);
    if (profile.revision !== revision) throw new ManagerError('PROFILE_CONFLICT', 'The profile changed. Reload it before deleting.');
    if (this.appDefaultProfileId === id) throw new ManagerError('PROFILE_IN_USE', 'Clear the app default before deleting this profile.');
    this.#db.prepare('DELETE FROM model_profiles WHERE id=? AND revision=?').run(id, profile.revision);
  }

  recordCheck(id: string, revision: number, lastCheck: ModelCheck): ModelProfile {
    const profile = this.get(id);
    if (profile.revision !== revision) throw new ManagerError('PROFILE_CONFLICT', 'The profile changed during verification. Check the new revision.');
    const update = { ...profile, lastCheck };
    this.#db.prepare('UPDATE model_profiles SET body=? WHERE id=? AND revision=?').run(JSON.stringify(update), id, revision);
    return update;
  }

  resolve(conversation: string | null | undefined, project: string | null | undefined): ResolvedModelReference | null {
    const id = conversation ?? project ?? this.appDefaultProfileId;
    if (id === null) return null;
    const profile = this.get(id);
    const api = profile.authMode === 'chatgpt' ? 'openai-responses' : this.#lookup(profile.provider, profile.modelId)?.api;
    if (!api) throw new ManagerError('MODEL_UNAVAILABLE', 'The selected profile model is no longer in its provider catalog.');
    return { provider: profile.provider, modelId: profile.modelId, thinkingLevel: profile.thinkingLevel,
      profileId: profile.id, configurationRevision: profile.revision, api,
      ...(profile.authMode === 'chatgpt' ? { authMode: profile.authMode, authRef: profile.authRef } : {}),
      ...(profile.endpoint ? { endpoint: profile.endpoint } : {}), source: conversation ? 'conversation' : project ? 'project' : 'app' };
  }

  close(): void { this.#db.close(); }
}
