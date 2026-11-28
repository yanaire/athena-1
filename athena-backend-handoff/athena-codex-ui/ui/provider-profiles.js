/* M3 provider credentials, SDK catalogs, and saved model profiles.
 * The host owns every real credential write; this panel only calls the
 * model-profiles RPC adapter. API keys are never rendered, stored in the DOM,
 * or echoed back; the OAuth surface shows only the safe authorization URL.
 * ChatGPT-account catalogs are exclusive host output: this panel never adds
 * fallback models and never states limits or prices the account did not
 * supply. The opaque accountRef is echoed to the host on save only. */
(() => {
  'use strict';

  const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const LEVEL_LABELS = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
  const AUTH_LABELS = { not_checked: 'Credential status not checked', unconfigured: 'Not configured', configured: 'Configured', refresh_required: 'Sign-in refresh required', error: 'Credential error' };
  const CHECK_ERRORS = {
    authentication: 'Check the selected account’s sign-in and granted permissions.',
    permission: 'The selected account or workspace lacks permission for this request.',
    usage_limit: 'ChatGPT plan usage reached a limit. Check Manage usage in ChatGPT before trying again.',
    model_unavailable: 'Refresh the selected account’s model catalog and choose an available model.',
    rate_limited: 'Too many requests. Wait before trying again.',
    invalid_request: 'The provider rejected the model request. Check the model and supported options.',
    connection: 'The provider connection failed. Check connectivity and try again.',
    service_unavailable: 'The provider is temporarily unavailable. Try again later.',
    timeout: 'The provider request timed out. Try again.'
  };
  const AUTH_FLOWS = { browser: 'OAuth browser login', device: 'OAuth device flow' };
  /* Backend OAuth terminal values are exactly succeeded | failed | cancelled. Start
   * returns only {id, status:'pending'}; the authorizeUrl arrives on polling and
     is surfaced as a user-activated link so popup blocking never blocks sign-in. */
  const OAUTH_DONE = ['succeeded'];
  const OAUTH_FAILED = ['failed', 'cancelled'];
  const PROBE_FAILED = ['failed', 'error', 'unavailable'];
  /* ~15 minutes of polling at the interval below. */
  const OAUTH_POLL_MS = 2000, OAUTH_MAX_POLLS = 450;

  const rows = value => Array.isArray(value) ? value : [];
  const text = value => value == null ? '' : String(value);
  const icon = name => '<i data-lucide="' + name + '" aria-hidden="true"></i>';
  const idOf = value => typeof value === 'string' && value.length ? value : null;
  const escapeHTML = value => text(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const elapsed = when => {
    const at = Date.parse(when);
    if (!Number.isFinite(at)) return text(when);
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.round(seconds / 60) + ' minutes ago';
    if (seconds < 86400) return Math.round(seconds / 3600) + ' hours ago';
    return new Date(at).toLocaleDateString();
  };

  function validEndpoint(endpoint) {
    try {
      const url = new URL(String(endpoint).trim());
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return 'Use a full http:// or https:// URL.';
      if (url.username || url.password || url.search || url.hash) return 'Use a base URL without credentials, query parameters, or a fragment.';
      if (endpoint.length > 2048) return 'Keep the endpoint URL under 2,048 characters.';
      return '';
    } catch (_) { return 'Use a full http:// or https:// URL.'; }
  }

  function mount(slot, options = {}) {
    if (!slot) throw new TypeError('AthenaProviderProfiles.mount requires a host element.');
    const controller = new AbortController();
    const listen = (element, type, callback) => element?.addEventListener(type, callback, { signal: controller.signal });
    let destroyed = false, adapter = null, generation = 0;
    const owners = new Map();
    let providers = [], providerQuery = '', providersError = '';
    let catalog = null, catalogProvider = '', catalogQuery = '', catalogError = '';
    let accounts = [], catalogAccount = null;
    let list = { profiles: [], appDefaultProfileId: null, credentialMode: null, hostModel: null }, listError = '';
    /* One provider sign-in at a time, keyed by providerId. */
    let flow = null, flowPolls = 0;
    /* null | { id?, revision?, name, provider, modelId, thinkingLevel } */
    let editing = null;
    const busyActions = new Set();
    const providerNotes = new Map();
    const at = key => busyActions.has(key);

    slot.innerHTML = `
      <div class="amp-root" data-amp-mounted="false" hidden>
        <header class="amp-heading">
          <div><span class="ams-eyebrow">HOST MODEL PROFILES</span><h2>Providers &amp; saved models</h2></div>
          <span class="ams-local-badge">${icon('server')}<span data-amp-credential-mode>Host credentials</span></span>
        </header>
        <p class="ams-intro">Saved model profiles name a provider model plus a reasoning level. The app default applies to new conversations; a project or a single conversation can select its own profile. The connected host owns every credential write.</p>
        <p class="ams-section-copy" data-amp-local-privacy hidden>API keys and tokens are saved unencrypted in a private local file. Other programs running as your macOS user can read them.</p>
        <p class="ams-section-copy" role="status" data-amp-migration-status hidden></p>
        <button type="button" class="ams-btn cursor-interaction" data-amp-import-credentials hidden>Approve import from Keychain</button>

        <section class="amp-section" data-amp-routing hidden aria-labelledby="amp-routing-title">
          <h3 id="amp-routing-title">Worker models</h3>
          <p class="ams-section-copy">Choose a saved profile and reasoning level for each role. Changes apply to the next research request.</p>
          <div data-amp-roles></div>
        </section>
        <section class="amp-section" aria-labelledby="amp-providers-title">
          <div class="ams-section-title"><h3 id="amp-providers-title">Provider credentials</h3></div>
          <p class="ams-section-copy">Search the providers registered by the installed Pi SDK. Sign-in methods come from the SDK and Athena's provider policy.</p>
          <label class="amp-search">${icon('search')}<input type="search" data-amp-provider-search placeholder="Search providers" aria-label="Search providers" autocomplete="off" spellcheck="false"></label>
          <div class="amp-list" role="list" data-amp-providers></div>
          <p class="amp-error" role="alert" data-amp-providers-error hidden></p>
          <details class="amp-register">
            <summary class="cursor-interaction">${icon('plus')}Register an OpenAI-compatible endpoint</summary>
            <form class="amp-register-form" novalidate>
              <div class="amp-register-grid">
                <div class="amp-field"><label for="amp-register-name">Name</label><input class="ams-input" id="amp-register-name" data-amp-register="name" maxlength="60" autocomplete="off" placeholder="Team gateway"></div>
                <div class="amp-field"><label for="amp-register-endpoint">Endpoint base URL</label><input class="ams-input" id="amp-register-endpoint" data-amp-register="endpoint" type="url" maxlength="2048" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="https://gateway.example/v1"></div>
                <div class="amp-field"><label for="amp-register-key">API key <span class="amp-optional">(optional)</span></label><input class="ams-input" id="amp-register-key" data-amp-register="apiKey" type="password" maxlength="8192" autocomplete="off" placeholder="Stored by the host, never displayed"></div>
              </div>
              <div class="amp-actions"><button type="button" class="ams-button cursor-interaction" data-amp-register-submit>${icon('plug-zap')}Register endpoint</button><p class="amp-status" role="status" data-amp-register-status></p></div>
            </form>
          </details>
        </section>

        <section class="amp-section" aria-labelledby="amp-catalog-title">
          <div class="ams-section-title"><h3 id="amp-catalog-title">Model catalog</h3></div>
          <p class="ams-section-copy">The catalog lists models registered in the SDK. Eligibility marks the models your credentials can select. Only an explicit profile verification probes a live inference.</p>
          <div class="amp-catalog-bar">
            <select class="ams-input cursor-interaction" data-amp-catalog-provider aria-label="Catalog provider"></select>
            <label class="amp-search amp-catalog-search">${icon('search')}<input type="search" data-amp-catalog-search placeholder="Search catalog models" aria-label="Search catalog models" autocomplete="off" spellcheck="false"></label>
            <button type="button" class="ams-button cursor-interaction" data-amp-catalog-refresh>${icon('refresh-cw')}Refresh</button>
          </div>
          <div class="amp-actions" data-amp-accounts hidden>
            <label for="amp-chatgpt-account">OpenAI connection</label>
            <select class="ams-input cursor-interaction" id="amp-chatgpt-account" data-amp-account></select>
            <button type="button" class="ams-button cursor-interaction" data-amp-account-reconnect>Reconnect</button>
            <button type="button" class="ams-button cursor-interaction" data-amp-account-signout>Sign out</button>
            <button type="button" class="ams-button cursor-interaction" data-amp-chatgpt-usage hidden>Manage usage in ChatGPT</button>
            <p class="amp-status" role="status" data-amp-account-status hidden></p>
          </div>
          <p class="amp-catalog-meta" data-amp-catalog-meta></p>
          <div class="amp-list" role="list" data-amp-models></div>
          <p class="amp-error" role="alert" data-amp-catalog-error hidden></p>
        </section>

        <section class="amp-section" aria-labelledby="amp-profiles-title">
          <div class="ams-section-title"><h3 id="amp-profiles-title">Saved model profiles</h3></div>
          <p class="amp-section-copy" data-amp-profiles-intro></p>
          <div class="amp-list" role="list" data-amp-profiles></div>
          <p class="amp-error" role="alert" data-amp-profiles-error hidden></p>
          <div class="amp-actions amp-profiles-actions">
            <button type="button" class="ams-button cursor-interaction" data-amp-profile-new>${icon('plus')}New model profile</button>
          </div>
          <form class="amp-profile-form" data-amp-profile-form novalidate hidden>
            <div class="amp-profile-form-grid">
              <div class="amp-field"><label for="amp-profile-name">Profile name</label><input class="ams-input" id="amp-profile-name" data-amp-profile-field="name" maxlength="80" autocomplete="off" placeholder="Fast writer"></div>
              <div class="amp-field"><label for="amp-profile-provider">Provider</label><select class="ams-input cursor-interaction" id="amp-profile-provider" data-amp-profile-field="provider"></select></div>
              <div class="amp-field"><label for="amp-profile-model">Model</label><select class="ams-input cursor-interaction" id="amp-profile-model" data-amp-profile-field="modelId"></select></div>
              <div class="amp-field"><label for="amp-profile-level">Reasoning level</label><select class="ams-input cursor-interaction" id="amp-profile-level" data-amp-profile-field="thinkingLevel"></select></div>
            </div>
            <p class="amp-catalog-meta" data-amp-profile-auth-mode></p>
            <p class="amp-error" role="alert" data-amp-profile-form-error hidden></p>
            <div class="amp-actions">
              <button type="button" class="ams-button ams-primary cursor-interaction" data-amp-profile-save>${icon('check')}Save profile</button>
              <button type="button" class="ams-button cursor-interaction" data-amp-profile-cancel>Cancel</button>
            </div>
          </form>
        </section>
      </div>`;
    const root = slot.querySelector('.amp-root');
    const q = selector => root.querySelector(selector);
    const routingPanel = q('[data-amp-routing]');
    const roleList = q('[data-amp-roles]');
    const routingSlot = slot.closest('[role="tabpanel"]')?.querySelector('#ast-worker-models-slot');
    routingSlot?.appendChild(routingPanel);
    const listNode = key => q('[data-amp-' + key + ']');

    const workspace = () => options.getWorkspace?.() || {};
    const currentSession = () => rows(workspace().sessions).find(item => item.id === workspace().sessionId) || null;
    const currentProject = () => rows(workspace().projects).find(item => item.id === workspace().projectId) || null;
    const profileById = id => rows(list.profiles).find(item => item.id === id) || null;
    const busy = (key, value) => { if (value) busyActions.add(key); else busyActions.delete(key); render(); };
    const note = (element, message, tone) => { element.textContent = message; element.dataset.tone = tone || ''; element.hidden = !message; };
    const providerNote = (providerId, message, tone) => {
      if (message) providerNotes.set(providerId, { message, tone });
      else providerNotes.delete(providerId);
      render();
    };

    /* Per-key request ownership: only the current owner of a key may apply a
     * result or clear that key's busy flag, so overlapping independent
     * requests cannot supersede or strand each other. A distinct attachment
     * generation retires every in-flight request from a previous host. */
    async function call(key, action, after, replace = false) {
      if (!adapter || (at(key) && !replace)) return;
      const attach = generation;
      const token = Symbol(key);
      owners.set(key, token);
      busy(key, true);
      try {
        const result = await action();
        if (destroyed || attach !== generation || owners.get(key) !== token) return null;
        if (after) await after(result);
        return result;
      } catch (error) {
        if (!destroyed && attach === generation && owners.get(key) === token) { options.toast?.(String(error?.message || error)); render(); }
        return null;
      } finally {
        if (attach === generation && owners.get(key) === token) { owners.delete(key); busy(key, false); }
      }
    }

    async function loadProviders() {
      await call('providers', () => adapter.listProviders(providerQuery), result => {
        providers = rows(result); providersError = '';
        if (catalog?.provider) providers = providers.map(provider => provider.id === catalog.provider.id ? { ...provider, ...catalog.provider } : provider);
        if (!providers.length && providerQuery) providersError = 'No provider matches this search.';
        if (!catalogProvider && providers.length) { catalogProvider = providers[0].id; void loadCatalog(false); }
        syncCatalogOptions();
      }, true);
    }
    async function saveKey(providerId) {
      const input = root.querySelector('[data-amp-key-input="' + providerId + '"]');
      const key = input ? String(input.value) : '';
      if (!key || /\s|[\x00-\x1f\x7f]/u.test(key) || key.length > 8192) {
        providerNote(providerId, 'Enter a nonempty API key without whitespace. The key is sent to the host only.', 'error');
        return;
      }
      input.value = '';
      await call('key:' + providerId, () => adapter.saveProviderApiKey(providerId, key), result => {
        const mode = result?.credentialMode || list.credentialMode;
        providerNote(providerId, mode === 'memory' ? 'API key stored for this host session only.'
          : mode === 'keychain' ? 'API key saved in the encrypted Keychain-backed vault.'
          : mode === 'local_file' ? 'API key saved to the local credential file.'
            : 'API key stored by the host' + (mode ? ' in the ' + mode.replace(/_/g, ' ') + ' vault' : '') + '.', 'success');
      });
      await Promise.all([loadProviders(), loadCatalog(false)]);
    }
    async function removeKey(providerId) {
      await call('logout:' + providerId, () => adapter.logoutProvider(providerId), () => {
        providerNote(providerId, 'Credentials removed by the host.', 'success');
      });
      await Promise.all([loadProviders(), loadCatalog(false)]);
    }
    async function refreshAccounts() {
      if (!adapter?.listChatGPTAccounts) return;
      await call('accounts', () => adapter.listChatGPTAccounts(), result => {
        accounts = rows(result);
      });
    }
    function selectCatalogAccount(ref) {
      catalogAccount = ref;
      catalog = null;
      if (editing?.provider === 'openai' && !editing.id) {
        editing.modelId = '';
        loadProfileModels();
      }
    }
    async function startOAuth(providerId, accountRef) {
      if (flow?.status === 'pending') return;
      await call('oauth:' + providerId, () => accountRef ? adapter.startProviderOAuth(providerId, accountRef) : adapter.startProviderOAuth(providerId), result => {
        const authUrl = text(result?.authUrl || result?.auth_url || result?.authorizeUrl);
        const flowId = idOf(result?.flowId || result?.id);
        if (!flowId) throw new Error('The host did not return a sign-in flow.');
        flow = { providerId, flowId, authUrl, browserReady: result?.browserReady === true, status: 'pending', message: '' };
        flowPolls = 0;
        if (authUrl) window.open?.(authUrl, '_blank', 'noopener,noreferrer');
        render();
        pollOAuth();
      });
    }
    function pollOAuth() {
      if (destroyed || !flow || !adapter) return;
      const current = flow, attach = generation;
      if (flowPolls > OAUTH_MAX_POLLS) {
        void call('oauth:' + current.providerId, () => adapter.cancelProviderOAuth(current.flowId));
        flow = { ...current, status: 'error', message: 'Sign-in timed out. Try again.' }; render(); return;
      }
      adapter.getProviderOAuth(current.flowId).then(async state => {
        if (destroyed || attach !== generation || !flow || flow.flowId !== current.flowId) return;
        const status = text(state?.status || state?.state).toLowerCase();
        const url = text(state?.authorizeUrl || state?.authUrl || state?.auth_url);
        flowPolls++;
        if (OAUTH_DONE.includes(status)) {
          if (current.providerId === 'openai') await refreshAccounts();
          if (destroyed || attach !== generation || flow?.flowId !== current.flowId) return;
          if (current.providerId === 'openai' && state.accountRef) {
            catalogProvider = 'openai';
            selectCatalogAccount(state.accountRef);
            catalogQuery = ''; q('[data-amp-catalog-search]').value = '';
            syncCatalogOptions();
          }
          flow = { ...current, status: 'authorized', message: '' };
        }
        else if (OAUTH_FAILED.includes(status)) flow = { ...current, status: 'error', message: state?.error === 'credential_save_failed'
          ? 'Sign-in was verified but the host could not save the credential.' : status === 'cancelled'
            ? 'Sign-in was cancelled.' : CHECK_ERRORS[state?.error] || 'The provider rejected the sign-in or the callback could not be verified.' };
        else flow = { ...current, status: 'pending', authUrl: current.authUrl || url, browserReady: state?.browserReady === true, message: text(state?.message) || (status && status !== 'pending' ? 'Provider sign-in status: ' + status : '') };
        render();
        if (flow?.status === 'pending') { flowTimer = setTimeout(pollOAuth, OAUTH_POLL_MS); return; }
        if (current.providerId !== 'openai' || !OAUTH_DONE.includes(status)) void refreshAccounts();
        void loadProviders(); void loadCatalog(false); void loadList();
      }).catch(() => {
        if (destroyed || attach !== generation || !flow || flow.flowId !== current.flowId) return;
        flow = { ...current, status: 'error', message: 'The host could not be reached while checking this sign-in.' };
        render();
      });
    }
    async function cancelOAuth() {
      if (!flow) return;
      const current = flow; flow = null; clearTimeout(flowTimer); flowTimer = null;
      await call('oauth:' + current.providerId, () => adapter.cancelProviderOAuth(current.flowId));
      render();
    }
    let flowTimer = null;

    async function registerEndpoint() {
      const fields = {};
      for (const input of root.querySelectorAll('[data-amp-register]')) fields[input.dataset.ampRegister] = input.value;
      const name = String(fields.name || '').trim(), endpoint = String(fields.endpoint || '').trim(), apiKey = String(fields.apiKey || '');
      const errorNode = q('[data-amp-register-status]');
      if (!name) { note(errorNode, 'Enter a name for this endpoint.', 'error'); return; }
      const endpointError = validEndpoint(endpoint);
      if (endpointError) { note(errorNode, endpointError, 'error'); return; }
      if (apiKey && (/\s|[\x00-\x1f\x7f]/u.test(apiKey) || apiKey.length > 8192)) { note(errorNode, 'Enter an API key without whitespace, or leave it empty.', 'error'); return; }
      await call('register', () => adapter.registerCompatibleEndpoint(apiKey ? { name, endpoint, apiKey } : { name, endpoint }), () => {
        for (const input of root.querySelectorAll('[data-amp-register]')) input.value = '';
        q('.amp-register').open = false;
        note(errorNode, 'Endpoint registered by the host. Configure its key there if you left it empty.', 'success');
      });
      await loadProviders();
    }

    async function loadCatalog(refresh) {
      if (!catalogProvider) return;
      await call('catalog', () => adapter.getProviderCatalog(catalogProvider, { query: catalogQuery, refresh,
        ...(catalogProvider === 'openai' && adapter.listChatGPTAccounts ? { accountRef: catalogAccount } : {}) }), result => {
        catalog = result && rows(result.models) === result.models ? result : { ...result, models: rows(result?.models) };
        catalogError = text(result?.error) || '';
        if (catalog.provider) providers = providers.map(provider => provider.id === catalog.provider.id ? { ...provider, ...catalog.provider } : provider);
      }, true);
      render();
    }
    function syncCatalogOptions() {
      const select = q('[data-amp-catalog-provider]');
      const seen = catalogProvider;
      select.replaceChildren(...providers.map(provider => {
        const option = document.createElement('option');
        option.value = provider.id; option.textContent = provider.name || provider.id;
        if (provider.id === seen) option.selected = true;
        return option;
      }));
      if (!providers.some(provider => provider.id === seen)) catalogProvider = providers[0]?.id || '';
      if (window.HTMLElement) select.value = catalogProvider;
    }

    async function loadList() {
      await call('list', () => adapter.listModelProfiles(), result => {
        list = {
          profiles: rows(result?.profiles), workerRoles:rows(result?.workerRoles),
          appDefaultProfileId: idOf(result?.appDefaultProfileId),
          credentialMode: idOf(result?.credentialMode),
          credentialMigration: idOf(result?.credentialMigration),
          hostModel: result?.hostModel || null
        };
        listError = '';
        if (!rows(list.profiles).length) listError = '';
      });
      render();
    }
    async function saveProfile() {
      if (!editing || at('profile-catalog')) return;
      const draft = { ...editing };
      const errorNode = q('[data-amp-profile-form-error]');
      const name = String(draft.name || '').trim();
      if (!name) { note(errorNode, 'Enter a profile name.', 'error'); return; }
      if (!draft.provider || !draft.modelId) { note(errorNode, 'Choose a provider and a model.', 'error'); return; }
      const input = { name, provider: draft.provider, modelId: draft.modelId, thinkingLevel: draft.thinkingLevel };
      if (draft.id) { input.id = draft.id; input.revision = draft.revision; }
      /* ChatGPT plan usage is attributed from the account catalog currently
       * displayed in this form. An existing account profile never silently
       * re-binds to a freshly switched account, nor converts to an API key
       * while its account is stale or disconnected. The opaque accountRef is
       * echoed to the host only and never rendered. */
      const accountCatalog = profileCatalogSource === 'chatgpt_account';
      if (draft.authMode === 'chatgpt') {
        if (accountCatalog && profileCatalogAccountRef && draft.authRef && profileCatalogAccountRef !== draft.authRef) {
          note(errorNode, 'This profile keeps its signed-in ChatGPT account, which no longer matches the account catalog. Save a new profile for the switched account instead.', 'error');
          return;
        }
        input.authMode = 'chatgpt';
        if (accountCatalog && profileCatalogAccountRef) input.accountRef = profileCatalogAccountRef;
        else if (draft.authRef) input.accountRef = draft.authRef;
      } else if (accountCatalog) {
        input.authMode = 'chatgpt';
        if (profileCatalogAccountRef) input.accountRef = profileCatalogAccountRef;
      }
      await call('profile-save', () => adapter.saveModelProfile(input), () => { editing = null; });
      if (editing === null) await loadList();
    }
    async function deleteProfile(profile) {
      await call('profile-delete:' + profile.id, () => adapter.deleteModelProfile(profile.id, profile.revision));
      await loadList();
    }
    async function setAppDefault(profile) {
      await call('app-default:' + profile.id, () => adapter.setAppModelProfile(profile.id));
      await loadList();
    }
    async function clearAppDefault() {
      await call('app-default:null', () => adapter.setAppModelProfile(null));
      await loadList();
    }
    async function setProjectDefault(profileId) {
      const projectId = idOf(workspace().projectId);
      if (!projectId) { options.toast?.('Project defaults need an open project.'); return; }
      await call('project-default', () => adapter.setProjectModelProfile(projectId, profileId));
      await loadList();
    }
    async function setConversationDefault(profileId) {
      const sessionId = idOf(workspace().sessionId);
      if (!sessionId) { options.toast?.('Conversation defaults need an open conversation.'); return; }
      await call('conversation-default', () => adapter.setConversationModelProfile(sessionId, profileId));
      await loadList();
    }
    function normalizeProbe(result) {
      if (result?.lastCheck) return result.lastCheck;
      const raw = text(result?.status || result?.result || result?.state).toLowerCase();
      if (!raw && !result?.checkedAt) return null;
      return { checkedAt: text(result?.checkedAt) || new Date().toISOString(),
        ...(PROBE_FAILED.includes(raw) ? { error: text(result?.message || result?.error) || 'The probe did not complete.' } : {}) };
    }
    async function verifyProfile(profile) {
      await call('probe:' + profile.id, () => adapter.verifyModelProfile(profile.id), result => {
        const check = normalizeProbe(result);
        if (!check) throw new Error('The host did not return a probe result for this profile.');
        list = { ...list, profiles: rows(list.profiles).map(item => item.id === profile.id ? { ...item, lastCheck: check } : item) };
      });
    }

    function methodMarkup(provider) {
      return rows(provider.methods).map(method => {
        if (method.kind === 'api_key') return '<span class="amp-method">' + icon('key') + escapeHTML(text(method.label) || 'API key') + '</span>';
        if (method.kind === 'oauth') {
          const flows = rows(method.flows).map(flow => AUTH_FLOWS[flow]).filter(Boolean).join(' / ');
          return '<span class="amp-method">' + icon('log-in') + escapeHTML(text(method.label) || 'Sign in') + (method.enabled ? '' : provider.id === 'openai-codex' ? ' · legacy path · unavailable' : ' · unavailable') + (flows ? ' · ' + escapeHTML(flows) : '') + '</span>';
        }
        return '<span class="amp-method">' + icon('server') + escapeHTML(text(method.label) || 'Host setup') + '</span>';
      }).join('');
    }
    function controlsMarkup(provider) {
      const parts = [];
      for (const method of rows(provider.methods)) {
        if (method.kind === 'api_key' && method.enabled) {
          parts.push(`<div class="amp-key-row">
            <input class="ams-input" type="password" data-amp-key-input="${escapeHTML(provider.id)}" maxlength="8192" autocomplete="off" placeholder="${escapeHTML(text(method.label) || 'API key')} · sent to the host only" aria-label="API key for ${escapeHTML(provider.name || provider.id)}">
            <button type="button" class="ams-button cursor-interaction" data-amp-save-key="${escapeHTML(provider.id)}">${icon('key-round')}${provider.credentialSource === 'stored' && provider.credentialType === 'api_key' ? 'Change key' : 'Save key'}</button>
            <button type="button" class="ams-button cursor-interaction" data-amp-remove-key="${escapeHTML(provider.id)}">${icon('log-out')}Remove</button>
          </div>`);
        } else if (method.kind === 'oauth' && method.enabled) {
          const label = text(method.label) || provider.name || provider.id;
          parts.push('<div class="amp-key-row"><button type="button" class="ams-button cursor-interaction" data-amp-oauth="' + escapeHTML(provider.id) + '"' + (flow?.status === 'pending' ? ' disabled' : '') + '>' + icon('log-in') + escapeHTML(/^(?:sign in|continue) with /i.test(label) ? label : 'Sign in with ' + label) + '</button></div>');
        } else if (method.reason) {
          parts.push('<p class="amp-method-reason">' + icon('info') + escapeHTML(text(method.reason)) + '</p>');
        }
      }
      parts.push('<button type="button" class="ams-button cursor-interaction" data-amp-check-auth="' + escapeHTML(provider.id) + '">' + icon('plug-zap') + 'Check authentication</button>');
      return parts.join('');
    }
    function oauthMarkup(provider) {
      if (!flow || flow.providerId !== provider.id) return '';
      const done = flow.status === 'authorized';
      const failed = flow.status === 'error';
      let markup = '<div class="amp-oauth" data-amp-oauth-flow="' + escapeHTML(provider.id) + '">';
      markup += '<p class="amp-oauth-status" data-amp-oauth-status="' + escapeHTML(provider.id) + '">' + (done ? icon('check') + 'Signed in with the provider.' : failed ? icon('circle-x') + escapeHTML(flow.message || 'The sign-in did not complete.') : icon('loader') + 'Waiting for the provider sign-in to finish' + (flow.message ? ' · ' + escapeHTML(flow.message) : '…')) + '</p>';
      if (flow.authUrl && !done && !failed) markup += '<p class="amp-oauth-url"><a href="' + escapeHTML(flow.authUrl) + '" target="_blank" rel="noopener noreferrer">' + icon('external-link') + 'Open the authorization page</a></p>';
      if (flow.browserReady && !done && !failed) markup += '<button type="button" class="ams-button cursor-interaction" data-amp-oauth-browser' + (at('oauth-browser') ? ' disabled' : '') + '>' + icon('external-link') + 'Open in system browser</button>';
      if (!done && !failed) markup += '<button type="button" class="ams-button cursor-interaction" data-amp-oauth-cancel="' + escapeHTML(provider.id) + '">' + icon('x') + 'Cancel sign-in</button>';
      markup += '</div>';
      return markup;
    }
    function renderProviders() {
      const target = listNode('providers');
      target.replaceChildren();
      if (!providers.length && !providersError) {
        const empty = document.createElement('p'); empty.className = 'amp-empty'; empty.textContent = 'Providers appear here once the host lists them.';
        target.appendChild(empty);
      }
      for (const provider of providers) {
        const article = document.createElement('article');
        article.className = 'amp-provider'; article.dataset.ampProvider = provider.id; article.setAttribute('role', 'listitem');
        const auth = flow?.providerId === provider.id && flow.status === 'pending' ? 'Sign-in in progress'
          : provider.auth === 'configured' && provider.credentialSource === 'stored' ? provider.credentialType === 'oauth' ? oauthLabel(provider) : 'API key saved'
            : provider.auth === 'configured' && provider.credentialSource === 'keyless' ? 'Keyless endpoint configured'
              : provider.auth === 'configured' && provider.credentialSource === 'host' ? 'Host credentials configured'
                : provider.auth === 'unconfigured' && rows(provider.methods).some(method => method.kind === 'host') ? 'Host setup required'
                  : provider.auth === 'unconfigured' && rows(provider.methods).every(method => !method.enabled) ? 'Login unavailable by policy'
                    : AUTH_LABELS[provider.auth] || text(provider.auth);
        article.innerHTML = `
          <header class="amp-provider-head">
            <strong>${icon(provider.id.startsWith('compatible-') ? 'server' : 'boxes')} ${escapeHTML(provider.name || provider.id)}</strong>
            <span class="amp-auth amp-auth-${escapeHTML(provider.auth)}" data-amp-auth="${escapeHTML(provider.id)}">${escapeHTML(auth)}</span>
          </header>
          <p class="amp-methods">${methodMarkup(provider)}</p>
          ${controlsMarkup(provider)}
          ${oauthMarkup(provider)}
          <p class="amp-status" role="status" data-amp-provider-status="${escapeHTML(provider.id)}" hidden></p>`;
        target.appendChild(article);
        const stored = providerNotes.get(provider.id);
        const statusNode = article.querySelector('[data-amp-provider-status]');
        if (statusNode) { statusNode.textContent = stored?.message || ''; statusNode.dataset.tone = stored?.tone || ''; statusNode.hidden = !stored; }
      }
      note(listNode('providers-error'), adapter ? providersError : '', 'error');
      q('[data-amp-credential-mode]').textContent = list.credentialMode === 'memory' ? 'Memory only · credentials clear on restart'
        : list.credentialMode === 'keychain' ? 'Keychain-backed vault · saved across restarts'
          : list.credentialMode === 'local_file' ? 'Local credentials · saved across restarts'
          : list.credentialMode ? 'Host vault · ' + list.credentialMode.replace(/_/g, ' ') : 'Host credentials';
      q('[data-amp-local-privacy]').hidden = list.credentialMode !== 'local_file';
      const importButton = q('[data-amp-import-credentials]');
      importButton.hidden = list.credentialMigration !== 'approval_required' || !adapter?.importLegacyCredentials;
      importButton.disabled = at('credential-migration');
      const migrationCopy = {
        approval_required: 'An older credential vault is available. Importing may ask for your Keychain approval once. You can also keep it untouched and connect a provider below.',
        unavailable: 'Athena cannot import the older credential vault here. Connect a provider below. API-key providers need a key entered in Athena once.',
        imported: 'Athena checked the imported credentials. The older vault and any existing local credentials were kept.'
      };
      note(q('[data-amp-migration-status]'), migrationCopy[list.credentialMigration] || '', '');
    }

    function oauthLabel(provider) {
      return provider.oauthExpiresAt > 0 && provider.oauthExpiresAt <= Date.now() ? 'Sign-in expired · reconnect' : 'Signed in';
    }

    function eligibilityLabel(model, availableIds, accountSource, configured) {
      if (accountSource) return availableIds.includes(model.id)
        ? '<span class="amp-badge amp-badge-eligible">' + icon('check') + 'On your ChatGPT plan · account-listed</span>'
        : '<span class="amp-badge amp-badge-listed">' + icon('list') + 'Not offered on your ChatGPT plan</span>';
      if (availableIds.includes(model.id)) return '<span class="amp-badge amp-badge-eligible">' + icon('check') + 'Pi reports available · inference unverified</span>';
      if (!configured) return '<span class="amp-badge amp-badge-unknown">' + icon('circle-help') + 'Eligibility unknown · configure credentials first</span>';
      return '<span class="amp-badge amp-badge-listed">' + icon('list') + 'SDK catalog only · not returned as available</span>';
    }
    function renderCatalog() {
      const accountRow = q('[data-amp-accounts]');
      const active = accounts.find(account => account.authRef === catalogAccount);
      accountRow.hidden = catalogProvider !== 'openai' || (!accounts.length && !catalogAccount);
      if (!accountRow.hidden) {
        const select = q('[data-amp-account]');
        const choices = [{ authRef: '', label: 'OpenAI API key' }, ...accounts];
        if (catalogAccount && !active) choices.push({ authRef: catalogAccount, label: 'Selected ChatGPT registration unavailable' });
        select.replaceChildren(...choices.map(account => {
          const option = document.createElement('option');
          option.value = account.authRef;
          option.textContent = account.label + (account.state === 'signed_out' ? ' · signed out'
            : account.state === 'reauth_required' ? ' · reconnect'
              : account.state === 'connected' && account.planUsage !== 'enabled' ? ' · plan usage disabled' : '');
          option.selected = account.authRef === (catalogAccount || '');
          return option;
        }));
        q('[data-amp-account-reconnect]').disabled = !active || flow?.status === 'pending' || at('account-signout');
        q('[data-amp-account-reconnect]').textContent = active?.state === 'connected' && active.planUsage !== 'enabled'
          ? 'Enable ChatGPT plan usage' : 'Reconnect';
        q('[data-amp-account-signout]').disabled = !active || active.state === 'signed_out' || flow?.status === 'pending' || at('account-signout');
        q('[data-amp-chatgpt-usage]').hidden = !adapter?.openChatGPTUsage || active?.planUsage !== 'enabled';
      }
      const meta = q('[data-amp-catalog-meta]');
      if (!catalog) { meta.textContent = ''; listNode('models').replaceChildren(); note(listNode('catalog-error'), '', ''); return; }
      const provider = catalog.provider || {};
      const availableIds = rows(catalog.availableModelIds);
      const configured = provider.auth === 'configured';
      const accountSource = catalog.source === 'chatgpt_account';
      const accountFailed = catalogError === 'account_catalog_failed';
      const planDisabled = accountSource && active?.state === 'connected' && active.planUsage !== 'enabled';
      const fromEndpoint = catalog.source === 'endpoint_catalog';
      const sourceLabel = accountSource ? 'ChatGPT account catalog' : fromEndpoint ? 'Endpoint model catalog' : catalog.source === 'refreshed_catalog' ? 'Refreshed catalog' : 'SDK catalog';
      meta.textContent = sourceLabel + ' for ' + (provider.name || provider.id)
        + (planDisabled ? ' · signed in; plan usage is disabled'
          : accountSource ? ' · ChatGPT plan usage · account models only' : '')
        + ' · checked ' + elapsed(catalog.checkedAt)
        + (accountFailed ? ' · the account model list could not be loaded'
          : catalogError === 'refresh_failed' ? (accountSource ? ' · account token refresh failed' : ' · catalog refresh failed; showing the last SDK catalog')
            : catalogError === 'availability_failed' ? ' · eligibility check failed' : '');
      /* An account-list failure is explicit and exclusive: no static fallback
       * list is ever drawn for the account catalog. */
      const recovery = CHECK_ERRORS[catalog.errorReason];
      note(listNode('catalog-error'), accountSource && recovery ? recovery
        : accountFailed ? 'The ChatGPT account model list could not be loaded. No fallback models are shown. Refresh to try again.'
        : accountSource && active?.state === 'reauth_required' ? 'Reconnect this ChatGPT registration to renew access.'
        : accountSource && active?.planUsage === 'enabled' && provider.auth === 'refresh_required' ? 'Refresh the catalog to renew the access token.'
        : planDisabled ? 'Enable ChatGPT plan usage, or select the OpenAI API key option to use separate API billing.' : '', accountFailed ? 'error' : '');
      const target = listNode('models');
      target.replaceChildren();
      const models = planDisabled ? [] : rows(catalog.models);
      if (!models.length) {
        const empty = document.createElement('p'); empty.className = 'amp-empty';
        empty.textContent = accountFailed ? 'No account models are shown while the account list is unavailable.' : 'No catalog models match this view.';
        target.appendChild(empty);
      }
      for (const model of models) {
        const article = document.createElement('article');
        article.className = 'amp-model'; article.setAttribute('role', 'listitem');
        /* Account entries are named by the account's display name and keep
         * their slug visible; capability metadata the account did not supply
         * stays unstated rather than invented. */
        const modelName = text(model.display_name) || text(model.name) || model.id;
        const details = [model.api, model.id !== modelName ? model.id : '', rows(model.input).join('/'),
          model.contextWindow ? 'context ' + model.contextWindow.toLocaleString() : '',
          model.maxTokens ? 'output limit ' + model.maxTokens.toLocaleString() : '',
          rows(model.thinkingLevels).map(level => LEVEL_LABELS[level] || level).join('/')].filter(Boolean).join(' · ');
        const rate = model.cost && !text(model.provider).startsWith('compatible-')
          ? 'SDK rates (USD per 1M tokens): input ' + model.cost.input + ', output ' + model.cost.output
            + ', cache read ' + model.cost.cacheRead + ', cache write ' + model.cost.cacheWrite
          : accountSource ? 'ChatGPT plan usage · no per-token rates' : 'Price not supplied';
        article.innerHTML = `
          <div class="amp-model-copy">
            <strong>${escapeHTML(modelName)}</strong>
            <small>${escapeHTML(details)}</small>
            <small>${escapeHTML(rate)}</small>
          </div>
          <div class="amp-model-badges">
            <span class="amp-badge amp-badge-sdk">${icon('package')}${accountSource ? 'Official account model' : fromEndpoint ? 'Endpoint-listed model' : 'SDK catalog'}</span>
            ${eligibilityLabel(model, availableIds, accountSource, configured)}
          </div>`;
        target.appendChild(article);
      }
    }

    function probeBadges(profile) {
      const check = profile?.lastCheck;
      if (!check || !check.checkedAt) return '';
      const badge = (name, symbol, state) => '<span class="amp-badge amp-badge-'
        + (state === 'passed' ? 'eligible' : state === 'failed' ? 'failed' : 'listed') + '">' + icon(symbol) + name
        + (state === 'passed' ? ' verified' : state === 'failed' ? ' failed' : ' not checked') + '</span>';
      return '<span class="amp-badge amp-badge-sdk">' + icon('plug-zap') + 'Checked ' + escapeHTML(elapsed(check.checkedAt)) + '</span>'
        + badge('Streaming', 'activity', check.streaming) + badge('Tools', 'wrench', check.tools);
    }
    function profileBadges(profile) {
      const badges = [];
      if (profile.id === list.appDefaultProfileId) badges.push('<span class="amp-badge amp-badge-default">' + icon('star') + 'App default</span>');
      const project = currentProject();
      if (project && idOf(project.defaultProfileId) === profile.id) badges.push('<span class="amp-badge amp-badge-default">' + icon('folder') + 'Project default</span>');
      const session = currentSession();
      if (session && idOf(session.profileId) === profile.id) badges.push('<span class="amp-badge amp-badge-default">' + icon('message-square') + 'This conversation</span>');
      badges.push(profile.authMode === 'chatgpt'
        ? '<span class="amp-badge amp-badge-eligible">' + icon('check') + 'ChatGPT plan usage</span>'
        : profile.provider === 'openai-codex'
          ? '<span class="amp-badge amp-badge-listed">' + icon('list') + 'Legacy Codex</span>'
          : '<span class="amp-badge amp-badge-sdk">' + icon('key') + 'API key</span>');
      badges.push(probeBadges(profile));
      return badges.join('');
    }
    function profileActions(profile) {
      const isAppDefault = profile.id === list.appDefaultProfileId;
      const project = currentProject(), session = currentSession();
      const isProjectDefault = Boolean(project) && idOf(project.defaultProfileId) === profile.id;
      const isConversation = Boolean(session) && idOf(session.profileId) === profile.id;
      return `<div class="amp-profile-actions">
        <button type="button" class="ams-button cursor-interaction" data-amp-action="app-default" data-amp-profile-id="${escapeHTML(profile.id)}" ${isAppDefault ? 'disabled' : ''}>${icon('star')}Use as app default</button>
        ${project ? `<button type="button" class="ams-button cursor-interaction" data-amp-action="${isProjectDefault ? 'project-inherit' : 'project-default'}" data-amp-profile-id="${escapeHTML(profile.id)}">${icon('folder')}${isProjectDefault ? 'Project inherits app default' : 'Use for this project'}</button>` : ''}
        ${session ? `<button type="button" class="ams-button cursor-interaction" data-amp-action="${isConversation ? 'conversation-inherit' : 'conversation'}" data-amp-profile-id="${escapeHTML(profile.id)}">${icon('message-square')}${isConversation ? 'Conversation inherits project default' : 'Use in this conversation'}</button>` : ''}
        <button type="button" class="ams-button cursor-interaction" data-amp-action="verify" data-amp-profile-id="${escapeHTML(profile.id)}" ${at('probe:' + profile.id) ? 'disabled' : ''}>${icon('plug-zap')}Verify</button>
        <button type="button" class="ams-button cursor-interaction" data-amp-action="edit" data-amp-profile-id="${escapeHTML(profile.id)}">${icon('pen-line')}Edit</button>
        <button type="button" class="ams-button cursor-interaction amp-danger" data-amp-action="delete" data-amp-profile-id="${escapeHTML(profile.id)}">${icon('trash-2')}Delete</button>
      </div>`;
    }
    let roleSignature='';
    function renderWorkerRoles(){
      const panel=routingPanel,roles=rows(list.workerRoles);
      panel.hidden=!adapter?.setWorkerModelPreference||!roles.length;
      slot.closest('.ast-content')?.classList.toggle('amp-live-roles',!panel.hidden);
      if(panel.hidden)return;
      const inherited=profileById(currentSession()?.profileId) || profileById(currentProject()?.defaultProfileId) || profileById(list.appDefaultProfileId) || list.hostModel;
      const signature=JSON.stringify([roles,inherited,list.profiles.map(p=>[p.id,p.name,p.modelId,p.thinkingLevel,p.supportedLevels]),at('worker-role')]);
      if(roleSignature===signature)return;
      roleSignature=signature;
      const option=(value,label,selected)=>'<option value="'+escapeHTML(value)+'"'+(selected?' selected':'')+'>'+escapeHTML(label)+'</option>';
      roleList.innerHTML=roles.map(r=>{
        const profile=list.profiles.find(p=>p.id===r.profileId),disabled=at('worker-role')?' disabled':'';
        const models=option('',inherited?.modelId?'Inherit · '+inherited.modelId:'Inherit conversation',!profile)+list.profiles.map(p=>option(p.id,p.name+' · '+p.modelId,p.id===r.profileId)).join('');
        const levels=profile?(option('','Profile · '+profile.thinkingLevel,r.thinkingLevel===null)+(profile.supportedLevels||[profile.thinkingLevel]).map(l=>option(l,LEVEL_LABELS[l]||l,r.thinkingLevel===l)).join('')):option('',inherited?.thinkingLevel?'Inherit · '+inherited.thinkingLevel:'Inherit conversation',true);
        return '<div class="amp-worker-row"><strong>'+escapeHTML(r.label)+'</strong><select class="ams-input" data-role-profile="'+escapeHTML(r.role)+'" aria-label="'+escapeHTML(r.label)+' model"'+disabled+'>'+models+'</select><select class="ams-input" data-role-level="'+escapeHTML(r.role)+'" aria-label="'+escapeHTML(r.label)+' reasoning"'+(!profile||disabled?' disabled':'')+'>'+levels+'</select></div>';
      }).join('');
    }
    listen(roleList,'change',event=>{
      const control=event.target,role=control.dataset.roleProfile||control.dataset.roleLevel;
      const row=list.workerRoles?.find(r=>r.role===role);
      if(!row||!adapter?.setWorkerModelPreference)return;
      const profileId=control.dataset.roleProfile?control.value||null:row.profileId;
      const thinkingLevel=control.dataset.roleLevel?control.value||null:null;
      void call('worker-role',()=>adapter.setWorkerModelPreference({role,profileId,thinkingLevel}),result=>{
        list.workerRoles=rows(result.workerRoles);
      });
    });
    function renderProfiles() {
      const intro = q('[data-amp-profiles-intro]');
      const hostModel = list.hostModel;
      const resolved = hostModel ? [hostModel.name || hostModel.modelId || hostModel.id, hostModel.provider].filter(Boolean).join(' · ') : '';
      intro.textContent = 'App default: ' + (list.appDefaultProfileId ? (profileById(list.appDefaultProfileId)?.name || 'profile ' + list.appDefaultProfileId) : 'None') + (resolved ? ' · host model: ' + resolved : ' · The host has not confirmed a model.');
      const target = listNode('profiles');
      target.replaceChildren();
      const profiles = rows(list.profiles);
      if (!profiles.length) {
        const empty = document.createElement('p'); empty.className = 'amp-empty'; empty.textContent = 'No saved profiles yet. Create one to name a provider model and a reasoning level.';
        target.appendChild(empty);
      }
      for (const profile of profiles) {
        const article = document.createElement('article');
        article.className = 'amp-profile'; article.dataset.ampProfile = profile.id; article.setAttribute('role', 'listitem');
        const detail = [profile.provider, profile.modelId, 'reasoning ' + (LEVEL_LABELS[profile.thinkingLevel] || text(profile.thinkingLevel))].filter(Boolean).join(' · ');
        article.innerHTML = `
          <div class="amp-profile-copy">
            <strong>${escapeHTML(profile.name || profile.id)}</strong>
            <small>${escapeHTML(detail)}</small>
          </div>
          <div class="amp-model-badges">${profileBadges(profile)}</div>
          ${profile.lastCheck?.error ? '<p class="amp-method-reason amp-probe-error">' + icon('info') + escapeHTML((profile.authMode === 'chatgpt' && CHECK_ERRORS[profile.lastCheck.error]) || text(profile.lastCheck.error)) + '</p>' : ''}
          ${profileActions(profile)}`;
        target.appendChild(article);
      }
      if (!profiles.some(item => item.id === list.appDefaultProfileId) && list.appDefaultProfileId) {
        const warning = document.createElement('p'); warning.className = 'amp-empty';
        warning.textContent = 'The app-default profile is missing from the host list. Choose another default.';
        target.appendChild(warning);
      }
      note(listNode('profiles-error'), adapter ? listError : '', 'error');
    }
    function renderRegisterAndForm() {
      const form = q('[data-amp-profile-form]');
      if (!editing) { form.hidden = true; return; }
      form.hidden = false;
      q('[data-amp-profile-field="name"]').value = text(editing.name);
      const providerSelect = q('[data-amp-profile-field="provider"]');
      const choices = [...providers];
      if (editing.provider && !choices.some(provider => provider.id === editing.provider)) {
        choices.unshift({ id: editing.provider, name: editing.provider });
      }
      providerSelect.replaceChildren(...choices.map(provider => {
        const option = document.createElement('option');
        option.value = provider.id; option.textContent = provider.name || provider.id;
        option.selected = provider.id === editing.provider;
        return option;
      }));
      const modeNode = q('[data-amp-profile-auth-mode]');
      if (modeNode) {
        const accountCatalog = profileCatalogSource === 'chatgpt_account';
        modeNode.textContent = editing.authMode === 'chatgpt'
          ? 'ChatGPT plan usage · this profile keeps its signed-in account' + (accountCatalog ? '' : ' · account catalog currently unavailable')
          : accountCatalog ? 'ChatGPT plan usage · account models save with this profile' : 'API key · SDK catalog models';
      }
    }
    let profileModels = [];
    let profileCatalogSource = '', profileCatalogAccountRef = null;
    function selectProfileModel(id, keepUnknown = false) {
      if (!editing) return;
      const model = profileModels.find(item => item.id === id);
      editing.modelId = model?.id || (keepUnknown && id ? id : '');
      let levels = rows(model?.thinkingLevels).filter(level => LEVELS.includes(level));
      if (!model && keepUnknown && id && editing.thinkingLevel && !levels.includes(editing.thinkingLevel)) {
        /* A saved model missing from the current account list keeps its
         * selector; limits and levels are never invented for it. */
        levels = [editing.thinkingLevel];
      }
      editing.thinkingLevel = levels.includes(editing.thinkingLevel) ? editing.thinkingLevel
        : levels.includes('medium') ? 'medium' : levels[0] || 'off';
      q('[data-amp-profile-field="thinkingLevel"]').replaceChildren(...levels.map(level => {
        const option = document.createElement('option');
        option.value = level; option.textContent = LEVEL_LABELS[level];
        option.selected = level === editing.thinkingLevel;
        return option;
      }));
    }
    function loadProfileModels() {
      if (!editing) return;
      const draft = editing;
      const provider = draft.provider;
      const preferred = draft.modelId;
      const preferredLevel = draft.thinkingLevel;
      const modelSelect = q('[data-amp-profile-field="modelId"]');
      modelSelect.replaceChildren();
      profileModels = [];
      profileCatalogSource = '';
      profileCatalogAccountRef = null;
      selectProfileModel('');
      if (!provider) return;
      const ref = draft.authMode === 'chatgpt' ? draft.authRef : !draft.id && provider === catalogProvider ? catalogAccount : null;
      void call('profile-catalog', () => adapter.getProviderCatalog(provider,
        provider === 'openai' && adapter.listChatGPTAccounts ? { accountRef: ref ?? null } : {}), result => {
        if (editing !== draft || draft.provider !== provider) return;
        profileModels = rows(result?.models);
        profileCatalogSource = text(result?.source);
        /* Opaque account reference: echoed to the host on save, never rendered. */
        profileCatalogAccountRef = idOf(result?.accountRef);
        const selected = preferred ? profileModels.find(model => model.id === preferred) : profileModels[0];
        const stale = Boolean(preferred) && !selected;
        const placeholder = document.createElement('option');
        placeholder.value = ''; placeholder.textContent = 'Choose a model'; placeholder.selected = !selected && !stale;
        modelSelect.replaceChildren(placeholder, ...profileModels.map(model => {
          const option = document.createElement('option');
          option.value = model.id;
          const label = text(model.display_name) || text(model.name);
          option.textContent = label && label !== model.id ? label + ' · ' + model.id : model.id;
          option.selected = model.id === selected?.id;
          return option;
        }));
        if (stale) {
          /* A re-edit keeps the saved selector when the account list no longer
           * carries it; the profile is never silently re-bound instead. */
          const saved = document.createElement('option');
          saved.value = preferred; saved.textContent = preferred + ' · saved model, not in the current account list'; saved.selected = true;
          modelSelect.appendChild(saved);
        }
        draft.thinkingLevel = preferredLevel;
        selectProfileModel(selected ? selected.id : stale ? preferred : '', stale);
      }, true);
    }
    function render() {
      if (destroyed) return;
      root.hidden = !adapter;
      root.dataset.ampMounted = String(Boolean(adapter));
      renderWorkerRoles();
      if (!adapter) return;
      renderProviders();
      renderCatalog();
      renderProfiles();
      renderRegisterAndForm();
      const busyAny = busyActions.size > 0;
      root.dataset.busy = String(busyAny);
      q('[data-amp-catalog-refresh]').disabled = at('catalog');
      q('[data-amp-profile-new]').disabled = at('list');
      q('[data-amp-profile-save]').disabled = at('profile-save') || at('profile-catalog') || !editing?.modelId;
      options.icons?.();
    }

    listen(q('[data-amp-provider-search]'), 'input', event => {
      providerQuery = event.target.value;
      clearTimeout(providerSearchTimer);
      providerSearchTimer = setTimeout(() => { void loadProviders(); }, 180);
    });
    listen(q('[data-amp-import-credentials]'), 'click', () => {
      if (list.credentialMigration !== 'approval_required' || !adapter?.importLegacyCredentials) return;
      void call('credential-migration', () => adapter.importLegacyCredentials(), async () => {
        await Promise.all([loadList(), loadProviders(), loadCatalog(false), refreshAccounts()]);
      });
    });
    let providerSearchTimer = null;
    listen(q('[data-amp-catalog-provider]'), 'change', event => {
      catalogProvider = event.target.value; catalog = null; void loadCatalog(false);
    });
    listen(q('[data-amp-account]'), 'change', event => {
      selectCatalogAccount(event.target.value || null);
      note(q('[data-amp-account-status]'), '', ''); void loadCatalog(false);
    });
    listen(q('[data-amp-account-reconnect]'), 'click', () => { if (catalogAccount) void startOAuth('openai', catalogAccount); });
    listen(q('[data-amp-chatgpt-usage]'), 'click', () => {
      if (adapter?.openChatGPTUsage) void call('chatgpt-usage', () => adapter.openChatGPTUsage());
    });
    listen(q('[data-amp-account-signout]'), 'click', () => {
      if (!catalogAccount || !adapter?.signOutChatGPTAccount) return;
      const ref = catalogAccount;
      void call('account-signout', () => adapter.signOutChatGPTAccount(ref), async result => {
        note(q('[data-amp-account-status]'), result?.remote === 'unconfirmed'
          ? 'Signed out on this Mac. OpenAI did not confirm remote revocation.' : 'Signed out on this Mac.', result?.remote === 'unconfirmed' ? 'error' : 'success');
        await refreshAccounts(); await loadCatalog(false);
      });
    });
    listen(q('[data-amp-catalog-search]'), 'input', event => {
      catalogQuery = event.target.value; void loadCatalog(false);
    });
    listen(q('[data-amp-catalog-refresh]'), 'click', () => { void loadCatalog(true); });
    listen(q('[data-amp-register-submit]'), 'click', () => { void registerEndpoint(); });
    listen(q('[data-amp-profile-new]'), 'click', () => {
      editing = { id: null, revision: null, name: '', provider: catalogProvider || providers[0]?.id || '', modelId: '', thinkingLevel: 'medium', authMode: '', authRef: null };
      note(q('[data-amp-profile-form-error]'), '', '');
      render();
      loadProfileModels();
      q('[data-amp-profile-field="name"]').focus?.();
    });
    listen(q('[data-amp-profile-field="provider"]'), 'change', event => {
      if (!editing) return;
      editing.provider = event.target.value;
      editing.modelId = '';
      editing.authMode = ''; editing.authRef = null; /* A provider switch is a fresh credential choice. */
      loadProfileModels();
    });
    listen(q('[data-amp-profile-field="modelId"]'), 'change', event => { selectProfileModel(event.target.value); });
    listen(q('[data-amp-profile-field="thinkingLevel"]'), 'change', event => {
      if (editing) editing.thinkingLevel = event.target.value;
    });
    listen(q('[data-amp-profile-save]'), 'click', () => { void saveProfile(); });
    listen(q('[data-amp-profile-cancel]'), 'click', () => { editing = null; render(); });
    listen(root, 'click', event => {
      const target = event.target;
      const saveButton = target.closest?.('[data-amp-save-key]');
      if (saveButton && !saveButton.disabled) { void saveKey(saveButton.dataset.ampSaveKey); return; }
      const removeButton = target.closest?.('[data-amp-remove-key]');
      if (removeButton && !removeButton.disabled) { void removeKey(removeButton.dataset.ampRemoveKey); return; }
      const check = target.closest?.('[data-amp-check-auth]');
      if (check && !check.disabled && adapter) {
        catalogProvider = check.dataset.ampCheckAuth; catalog = null;
        syncCatalogOptions(); void loadCatalog(false); return;
      }
      const oauth = target.closest?.('[data-amp-oauth]');
      if (oauth && !oauth.disabled) { void startOAuth(oauth.dataset.ampOauth); return; }
      const browser = target.closest?.('[data-amp-oauth-browser]');
      if (browser && !browser.disabled && flow?.status === 'pending' && adapter?.openProviderOAuthBrowser) {
        const flowId = flow.flowId;
        void call('oauth-browser', () => adapter.openProviderOAuthBrowser(flowId)); return;
      }
      const cancel = target.closest?.('[data-amp-oauth-cancel]');
      if (cancel) { void cancelOAuth(); return; }
      const action = target.closest?.('[data-amp-action]');
      if (!action || action.disabled || !adapter) return;
      const profile = profileById(action.dataset.ampProfileId);
      if (!profile) return;
      if (action.dataset.ampAction === 'app-default') void setAppDefault(profile);
      if (action.dataset.ampAction === 'project-default') void setProjectDefault(profile.id);
      if (action.dataset.ampAction === 'project-inherit') void setProjectDefault(null);
      if (action.dataset.ampAction === 'conversation') void setConversationDefault(profile.id);
      if (action.dataset.ampAction === 'conversation-inherit') void setConversationDefault(null);
      if (action.dataset.ampAction === 'verify') void verifyProfile(profile);
      if (action.dataset.ampAction === 'delete') void deleteProfile(profile);
      if (action.dataset.ampAction === 'edit') {
        editing = { id: profile.id, revision: profile.revision, name: text(profile.name), provider: text(profile.provider), modelId: text(profile.modelId), thinkingLevel: profile.thinkingLevel || 'medium', authMode: profile.authMode === 'chatgpt' ? 'chatgpt' : '', authRef: idOf(profile.authRef) };
        note(q('[data-amp-profile-form-error]'), '', '');
        render();
        loadProfileModels();
      }
    });
    listen(q('[data-amp-profile-form]'), 'submit', event => { event.preventDefault(); void saveProfile(); });
    for (const input of root.querySelectorAll('[data-amp-profile-field="name"]')) {
      listen(input, 'input', () => { if (editing) editing.name = input.value; });
    }

    function setModelProfiles(next) {
      clearTimeout(flowTimer); flowTimer = null; flow = null; flowPolls = 0;
      editing = null; profileModels = []; profileCatalogSource = ''; profileCatalogAccountRef = null;
      adapter = next || null; generation++; owners.clear(); busyActions.clear();
      accounts = []; catalogAccount = null;
      if (!adapter) { providers = []; catalog = null; list = { profiles: [], appDefaultProfileId: null, credentialMode: null, hostModel: null }; render(); return; }
      void loadList(); void loadProviders(); void loadCatalog(false); void refreshAccounts();
      render();
    }

    render();
    const api = {
      setModelProfiles,
      /* Snapshot-driven scope labels for the legacy model-scopes panel. */
      resolveScopes(snapshot) {
        if (!adapter) return null;
        const session = rows(snapshot?.sessions).find(item => item.id === snapshot?.sessionId) || null;
        const project = rows(snapshot?.projects).find(item => item.id === snapshot?.projectId) || null;
        const label = profileId => {
          const profile = profileById(profileId);
          return profile ? { name: profile.name, provider: profile.provider, modelId: profile.modelId, thinkingLevel: profile.thinkingLevel } : null;
        };
        const runModel = snapshot?.run?.id && snapshot.run.model;
        const app = label(list.appDefaultProfileId) || list.hostModel || null;
        const projectProfile = project?.defaultProfileId ? label(project.defaultProfileId) : null;
        const effective = projectProfile || project?.defaultModel || app;
        const inherited = value => value ? 'Inherit · '+(value.name || value.modelId || value.id) : null;
        return {
          appDefault: app,
          projectDefault: project && idOf(project.defaultProfileId) ? projectProfile || 'Profile ' + project.defaultProfileId : project ? inherited(app) : null,
          conversation: session && idOf(session.profileId) ? label(session.profileId) || 'Profile ' + session.profileId : session ? inherited(effective) || 'Inherit project default' : null,
          runLocked: runModel ? { name: runModel.name || runModel.modelId || runModel.id, provider: runModel.provider, modelId: runModel.modelId || runModel.id, thinkingLevel: runModel.thinkingLevel } : null
        };
      },
      getAppDefaultProfileId: () => list.appDefaultProfileId,
      getHostModel: () => list.hostModel || null,
      refresh: () => { if (adapter) { void loadList(); void loadProviders(); } },
      focus() { if (!destroyed) q('[data-amp-provider-search]')?.focus?.({ preventScroll: true }); },
      destroy() {
        if (destroyed) return;
        destroyed = true; generation++; owners.clear();
        clearTimeout(flowTimer); clearTimeout(providerSearchTimer);
        controller.abort();
        routingPanel.remove();
        root.remove();
      }
    };
    return api;
  }

  window.AthenaProviderProfiles = Object.freeze({ mount });
})();
