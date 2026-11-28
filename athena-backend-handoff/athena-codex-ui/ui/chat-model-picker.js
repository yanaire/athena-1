/* Conversation model controls. The connected runtime is the source of truth. */
(() => {
  'use strict';

  const LEVELS = {
    off: ['Off', 'Do not request additional reasoning.', 'circle-slash'],
    minimal: ['Minimal', 'Use the smallest reasoning budget.', 'feather'],
    low: ['Low', 'Keep the reasoning effort light.', 'zap'],
    medium: ['Medium', 'Use a moderate reasoning effort.', 'brain-circuit'],
    high: ['High', 'Allow more effort for complex work.', 'scan'],
    xhigh: ['Extra high', 'Use the highest supported reasoning effort.', 'sparkles'],
    max: ['Max', 'Use the maximum reasoning budget this model supports.', 'gauge']
  };
  const CHANGES = ['set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level'];
  const modelKey = model => model?.provider && model?.id ? model.provider + '\u241f' + model.id : '';
  const profileKey = profile => profile?.id ? 'profile\u241f' + profile.id : '';
  const array = value => Array.isArray(value) ? value : [];
  const levelInfo = level => LEVELS[level] || [String(level || ''), 'Reasoning level provided by this model.', 'brain-circuit'];
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  function mount(slot, options = {}) {
    if (!slot || !options.runtime) throw new TypeError('Chat model controls need a slot and runtime.');
    const runtime = options.runtime, portal = slot.closest('#athena-codex') || slot;
    const controller = new AbortController();
    const listen = (target, type, callback, extra = {}) => target?.addEventListener(type, callback, { ...extra, signal: controller.signal });
    let snapshot = runtime.getState(), preferences = options.preferences || {}, open = null, pending = null;
    let error = '', loading = false, destroyed = false, actionVersion = 0, readVersion = 0, menuSignature = '';
    let previousSession = snapshot.session?.sessionId || snapshot.session?.id || '';
    let profilesAdapter = null, profileContext = null, profilesList = null, profilesLoading = false, profilesError = '', profilesEpoch = 0;
    let profileLevels = null, profileLevelsKey = '', levelsLoading = false;

    slot.innerHTML = `<div class="acmp-controls" role="group" aria-label="Conversation model and reasoning">
      <button type="button" id="ac-chat-model-trigger" class="acmp-trigger acmp-model-trigger cursor-interaction" aria-haspopup="dialog" aria-expanded="false" aria-controls="ac-chat-model-menu"><i data-lucide="cpu" aria-hidden="true"></i><span id="aw-model-label">Choose model</span><i data-lucide="chevron-down" aria-hidden="true"></i></button>
      <button type="button" id="ac-chat-reasoning-trigger" class="acmp-trigger acmp-reasoning-trigger cursor-interaction" aria-haspopup="dialog" aria-expanded="false" aria-controls="ac-chat-model-menu"><i data-lucide="brain-circuit" aria-hidden="true"></i><span id="ac-chat-reasoning-label">Reasoning</span><i data-lucide="chevron-down" aria-hidden="true"></i></button>
    </div>`;
    const modelTrigger = slot.querySelector('#ac-chat-model-trigger'), reasoningTrigger = slot.querySelector('#ac-chat-reasoning-trigger');
    const modelLabel = slot.querySelector('#aw-model-label'), reasoningLabel = slot.querySelector('#ac-chat-reasoning-label');
    const menu = document.createElement('section');
    menu.id = 'ac-chat-model-menu'; menu.className = 'acmp-menu'; menu.hidden = true;
    menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-labelledby', 'acmp-title'); menu.tabIndex = -1;
    menu.innerHTML = `<header class="acmp-heading"><div><h2 id="acmp-title"></h2><p class="acmp-subtitle"></p></div><button type="button" class="acmp-close cursor-interaction" aria-label="Close model menu"><i data-lucide="x" aria-hidden="true"></i></button></header>
      <label class="acmp-search"><i data-lucide="search" aria-hidden="true"></i><input type="search" aria-label="Search models" aria-controls="acmp-options" placeholder="Search models or providers" autocomplete="off" spellcheck="false"></label>
      <div class="acmp-body"><p class="acmp-notice" role="status" hidden></p><p class="acmp-error" role="alert" hidden></p><div class="acmp-options" id="acmp-options" role="listbox"></div><div class="acmp-empty" hidden><i data-lucide="plug" aria-hidden="true"></i><strong></strong><p></p></div></div>
      <footer class="acmp-footer"><button type="button" class="acmp-settings cursor-interaction" data-acmp-settings><i data-lucide="sliders-horizontal" aria-hidden="true"></i><span>Manage models</span><i data-lucide="arrow-up-right" aria-hidden="true"></i></button><button type="button" class="acmp-refresh cursor-interaction" aria-label="Refresh available models"><i data-lucide="refresh-cw" aria-hidden="true"></i></button></footer>`;
    portal.appendChild(menu);
    const q = selector => menu.querySelector(selector);
    const search = q('input'), list = q('.acmp-options'), notice = q('.acmp-notice'), errorNode = q('.acmp-error'), empty = q('.acmp-empty');
    const icon = (name, parent) => { const element = document.createElement('i'); element.dataset.lucide = name; element.setAttribute('aria-hidden', 'true'); parent.appendChild(element); return element; };
    const allowed = id => Boolean(snapshot.connected && snapshot.capabilities?.[id]?.available);
    const changing = () => Boolean(pending || CHANGES.some(id => array(snapshot.busy).includes(id)));
    const activeWork = () => Boolean(options.isBusy?.() || snapshot.session?.isStreaming || snapshot.session?.isCompacting || array(snapshot.busy).some(id => ['prompt', 'invoke_command', 'compact', 'new_session', 'switch_session', 'fork', 'clone', 'navigate_tree', 'import_session', 'reload'].includes(id)));
    const gated = kind => options.isSessionBound?.() === false || !allowed(kind === 'model' ? 'set_model' : 'set_thinking_level') || activeWork() || changing() || kind === 'reasoning' && snapshot.thinkingLevelsPending;
    const profileById = id => id && profilesList ? array(profilesList.profiles).find(item => item.id === id) || null : null;
    const currentProfile = () => profilesAdapter && profilesList ? profileById(profileContext?.profileId)
      || profileById(profileContext?.projectDefaultProfileId) || profileById(profilesList.appDefaultProfileId) : null;
    const profileGated = kind => options.isSessionBound?.() === false || !profileContext?.sessionId || (!profileContext.researchWorkflow&&activeWork()) || changing() || kind === 'reasoning' && levelsLoading;

    function position() {
      if (!open || destroyed) return;
      const box = portal.getBoundingClientRect(), anchor = (open === 'model' ? modelTrigger : reasoningTrigger).getBoundingClientRect();
      const viewport = window.visualViewport;
      const vx = viewport?.offsetLeft || 0, vy = viewport?.offsetTop || 0;
      const vw = viewport?.width || window.innerWidth || box.width, vh = viewport?.height || window.innerHeight || box.height;
      const left = Math.max(box.left + 10, vx + 10), right = Math.min(box.right - 10, vx + vw - 10);
      const top = Math.max(box.top + 10, vy + 10), bottom = Math.min(box.bottom - 10, vy + vh - 10);
      const width = Math.max(1, Math.min(open === 'model' ? 360 : 320, right - left));
      menu.style.width = width + 'px';
      const above = Math.max(0, Math.min(anchor.top - 8, bottom) - top), below = Math.max(0, bottom - Math.max(anchor.bottom + 8, top));
      const placeAbove = above >= 240 || above >= below;
      const maxHeight = Math.max(1, Math.min(460, placeAbove ? above : below));
      menu.style.maxHeight = maxHeight + 'px';
      const height = Math.min(menu.scrollHeight || 360, maxHeight);
      const x = clamp(anchor.right - width, left, Math.max(left, right - width));
      const y = placeAbove ? anchor.top - 8 - height : anchor.bottom + 8;
      menu.style.left = x - box.left + (portal.scrollLeft || 0) + 'px';
      menu.style.top = clamp(y, top, Math.max(top, bottom - height)) - box.top + (portal.scrollTop || 0) + 'px';
      menu.dataset.placement = placeAbove ? 'above' : 'below';
    }

    function renderTriggers() {
      const bound = options.isSessionBound?.() !== false;
      if (profilesAdapter) {
        const profile = currentProfile();
        const host = profilesList?.hostModel;
        const name = !profileContext?.sessionId ? 'No conversation' : !bound ? 'Connect session' : profile?.name || (host ? [host.name || host.modelId || host.id, host.provider].filter(Boolean).join(' · ') : 'Choose model');
        modelLabel.textContent = name;
        modelTrigger.setAttribute('aria-label', 'Choose model' + (name !== 'Choose model' ? ': ' + name : ''));
        modelTrigger.title = profile ? [profileContext?.profileId?'Conversation':profileContext?.projectDefaultProfileId?'Inherited from project':'Inherited from app',profile.name, profile.provider, profile.modelId].filter(Boolean).join(' · ') : name;
        const account=profile?.authMode==='chatgpt'&&profilesList?.accountStates?.find(a=>a.authRef===profile.authRef);
        if(profile?.authMode==='chatgpt'&&profilesList?.accountStates&&(!account||account.state!=='connected'||account.planUsage!=='enabled')){
          modelLabel.textContent=name+' · '+(account?.state==='connected'?'Enable plan usage':'Sign in');
          modelTrigger.title=modelLabel.textContent;
        }
        const level = profile?.thinkingLevel;
        reasoningLabel.textContent = level ? 'Reasoning · ' + levelInfo(level)[0] : 'Reasoning';
        reasoningTrigger.setAttribute('aria-label', 'Choose reasoning level' + (level ? ': ' + levelInfo(level)[0] : ''));
        reasoningTrigger.title = level ? 'Reasoning effort: ' + levelInfo(level)[0] + ' · saved to ' + (profile.name || profile.id) : 'Choose reasoning effort';
        modelTrigger.setAttribute('aria-expanded', String(open === 'model'));
        reasoningTrigger.setAttribute('aria-expanded', String(open === 'reasoning'));
        modelTrigger.setAttribute('aria-busy', String(changing()));
        reasoningTrigger.setAttribute('aria-busy', String(changing() || levelsLoading));
        return;
      }
      const current = snapshot.connected && bound ? snapshot.model : null;
      const saved = preferences.defaultModel && preferences.defaultModel !== 'workspace-default' ? preferences.defaultModel : '';
      const name = !bound ? 'Connect session' : current?.name || current?.id || (snapshot.connected ? 'Choose model' : saved || 'Choose model');
      modelLabel.textContent = name;
      modelTrigger.setAttribute('aria-label', 'Choose model' + (current || saved ? ': ' + name : ''));
      modelTrigger.title = [name, current?.provider || (!snapshot.connected && saved ? 'Saved preference · not connected' : '')].filter(Boolean).join(' · ');
      const level = bound && snapshot.connected && !snapshot.thinkingLevelsPending && array(snapshot.thinkingLevels).includes(snapshot.thinkingLevel) ? levelInfo(snapshot.thinkingLevel)[0] : '';
      reasoningLabel.textContent = level ? 'Reasoning · ' + level : 'Reasoning';
      reasoningTrigger.setAttribute('aria-label', 'Choose reasoning level' + (level ? ': ' + level : ''));
      reasoningTrigger.title = level ? 'Reasoning effort: ' + level : 'Choose reasoning effort';
      modelTrigger.setAttribute('aria-expanded', String(open === 'model'));
      reasoningTrigger.setAttribute('aria-expanded', String(open === 'reasoning'));
      modelTrigger.setAttribute('aria-busy', String(changing()));
      reasoningTrigger.setAttribute('aria-busy', String(changing() || Boolean(snapshot.thinkingLevelsPending)));
    }

    function emptyState(title, text) {
      empty.hidden = false; empty.querySelector('strong').textContent = title; empty.querySelector('p').textContent = text;
    }
    function addOption(value, name, description, glyph, selected) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'acmp-option cursor-interaction';
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(selected));
      row.tabIndex = -1;
      row.dataset.acmpKey = value; row.dataset[open === 'model' ? 'acmpModel' : 'acmpLevel'] = value;
      row.disabled = Boolean(profilesAdapter ? profileGated(open) : gated(open));
      const symbol = document.createElement('span'); symbol.className = 'acmp-option-symbol'; icon(glyph, symbol); row.appendChild(symbol);
      const copy = document.createElement('span'); copy.className = 'acmp-option-copy';
      const title = document.createElement('strong'); title.textContent = name; copy.appendChild(title);
      const detail = document.createElement('small'); detail.textContent = description; copy.appendChild(detail); row.appendChild(copy);
      const mark = document.createElement('span'); mark.className = 'acmp-check'; icon('check', mark); row.appendChild(mark);
      list.appendChild(row);
    }
    function renderMenu() {
      if (!open) return;
      const key = JSON.stringify([open, search.value, pending, loading, error, snapshot.connected, snapshot.model, snapshot.models, snapshot.thinkingLevel, snapshot.thinkingLevels, snapshot.thinkingLevelsPending, snapshot.capabilities, activeWork(), changing(), options.isSessionBound?.(), profilesAdapter ? [profilesList, profileContext, profilesLoading, profilesError, profileLevelsKey, profileLevels, levelsLoading] : null]);
      if (key === menuSignature) { position(); return; } menuSignature = key;
      const focused = list.contains(document.activeElement) ? document.activeElement.dataset.acmpKey : null;
      q('#acmp-title').textContent = open === 'model' ? 'Choose a model' : 'Reasoning effort';
      q('.acmp-subtitle').textContent = profilesAdapter
        ? open === 'model' ? 'Saved profiles · for this conversation' : 'Reasoning effort · saved to ' + (currentProfile()?.name || 'the selected profile')
        : open === 'model' ? 'For this conversation' : 'How much reasoning to use for your reply';
      q('.acmp-search').hidden = open !== 'model';
      list.setAttribute('aria-label', open === 'model' ? 'Available models' : 'Supported reasoning levels');
      menu.setAttribute('aria-busy', String(loading || profilesLoading || levelsLoading || changing() || open === 'reasoning' && Boolean(snapshot.thinkingLevelsPending)));
      if (profilesAdapter) { q('.acmp-refresh').hidden = false; q('.acmp-refresh').disabled = loading || profilesLoading || levelsLoading || changing(); }
      else {
        q('.acmp-refresh').hidden = !allowed(open === 'model' ? 'get_available_models' : 'get_available_thinking_levels');
        q('.acmp-refresh').disabled = loading || changing();
      }
      q('.acmp-refresh').setAttribute('aria-label', open === 'model' ? 'Refresh available models' : 'Refresh reasoning levels');
      errorNode.textContent = error; errorNode.hidden = !error;
      const reason = changing() ? 'Applying your selection…' : activeWork() ? profileContext?.researchWorkflow?'Changes apply to the next research request.':'You can change these after the current reply finishes.' : open === 'reasoning' && snapshot.thinkingLevelsPending ? 'Checking this model’s reasoning levels…' : loading ? 'Refreshing available choices…' : '';
      notice.textContent = reason; notice.hidden = !reason;
      list.replaceChildren(); empty.hidden = true;
      if (profilesAdapter && !profileContext?.sessionId) {
        emptyState('No open conversation', 'Open or create a conversation to select its model profile.');
      } else if (profilesAdapter && open === 'model') {
        if (profilesLoading) {
          emptyState('Loading saved profiles', 'Your host model profiles will appear here.');
        } else {
          const profiles = profilesList ? array(profilesList.profiles) : [];
          const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
          const match = profile => terms.every(term => [profile.name, profile.id, profile.provider, profile.modelId].join(' ').toLocaleLowerCase().includes(term));
          const projectProfile=profileById(profileContext?.projectDefaultProfileId);
          const fallback = projectProfile ? 'Project · '+projectProfile.name+' · '+projectProfile.modelId : profilesList?.appDefaultProfileId ? 'Falls back to ' + (profileById(profilesList.appDefaultProfileId)?.name || 'the app default profile') : 'Host · '+(profilesList?.hostModel?.modelId||'No configured host model');
          addOption('inherit\u241f', 'Inherit default', fallback, 'circle-dashed', !profileContext?.profileId);
          const matches = profiles.filter(match);
          for (const profile of matches) {
            const details = [profile.provider, profile.modelId, profile.authMode === 'chatgpt' ? 'ChatGPT plan usage' : profile.provider === 'openai-codex' ? 'Legacy Codex' : 'API key', 'reasoning ' + levelInfo(profile.thinkingLevel)[0]].filter(Boolean).join(' · ');
            addOption(profileKey(profile), profile.name || profile.id, details, profile.id === profilesList?.appDefaultProfileId ? 'star' : 'cpu', profile.id === profileContext?.profileId);
          }
          if (!matches.length) emptyState(terms.length ? 'No matching profiles' : profilesError ? 'Profiles unavailable' : 'No saved profiles', terms.length ? 'Try another profile, provider, or model name.' : profilesError || 'Create a profile in Settings → Models & connections.');
        }
      } else if (profilesAdapter && open === 'reasoning') {
        const profile = currentProfile();
        if (!profile) emptyState('No saved profile', 'Select a model profile first; reasoning is saved with the profile.');
        else if (levelsLoading) emptyState('Checking supported levels', 'The catalog for ' + (profile.name || profile.id) + ' determines the reasoning options.');
        else {
          for (const level of array(profileLevels)) { const [name, description, glyph] = levelInfo(level); addOption(level, name, description + ' · saved to ' + (profile.name || profile.id), glyph, level === profile.thinkingLevel); }
          if (!array(profileLevels).length) emptyState('Reasoning is not available', 'The selected connection has no reasoning levels available for this model.');
        }
      } else if (options.isSessionBound?.() === false) {
        emptyState('Connect this conversation', 'The model connection belongs to another session. Your current draft has not been sent.');
      } else if (!snapshot.connected) {
        emptyState('Connect a model to get started', 'Available models and reasoning levels will appear here when your workspace is connected.');
      } else if (open === 'model') {
        const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const models = array(snapshot.models).filter(model => modelKey(model) && terms.every(term => [model.name, model.id, model.provider].join(' ').toLocaleLowerCase().includes(term)));
        const seen = new Set();
        for (const model of models) {
          const key = modelKey(model); if (seen.has(key)) continue; seen.add(key);
          const details = [model.provider];
          if (model.name && model.name !== model.id) details.push(model.id);
          addOption(key, model.name || model.id, details.join(' · '), 'cpu', key === modelKey(snapshot.model));
        }
        if (!models.length) emptyState(terms.length ? 'No matching models' : loading ? 'Loading models' : 'No available models', terms.length ? 'Try a different model name or provider.' : 'Check your provider connection in model settings.');
      } else if (snapshot.thinkingLevelsPending) {
        emptyState('Checking supported levels', 'Your model determines which reasoning options are available.');
      } else {
        const levels = [...new Set(array(snapshot.thinkingLevels).filter(level => typeof level === 'string'))];
        for (const level of levels) { const [name, description, glyph] = levelInfo(level); addOption(level, name, description, glyph, level === snapshot.thinkingLevel); }
        if (!levels.length) emptyState('Reasoning is not available', 'This connection has not provided adjustable reasoning levels for the current model.');
      }
      if (!profilesAdapter && snapshot.connected && !allowed(open === 'model' ? 'set_model' : 'set_thinking_level') && !reason) {
        notice.textContent = 'This connection does not allow changing ' + (open === 'model' ? 'models.' : 'reasoning levels.'); notice.hidden = false;
      }
      options.icons?.(); position();
      const enabledRows = [...list.querySelectorAll('button:not([disabled])')];
      const activeRow = enabledRows.find(row => row.dataset.acmpKey === focused) || enabledRows.find(row => row.getAttribute('aria-selected') === 'true') || enabledRows[0];
      if (activeRow) activeRow.tabIndex = 0;
      if (focused != null) {
        const replacement = [...list.querySelectorAll('button')].find(row => row.dataset.acmpKey === focused && !row.disabled);
        (replacement || (open === 'model' ? search : menu)).focus({ preventScroll: true });
      }
    }
    function render() { if (destroyed) return; renderTriggers(); renderMenu(); }
    function close(restoreFocus = true) {
      if (!open) return;
      const trigger = open === 'model' ? modelTrigger : reasoningTrigger;
      open = null; menu.hidden = true; menuSignature = ''; renderTriggers();
      if (restoreFocus && trigger.isConnected && !options.isUnavailable?.()) trigger.focus({ preventScroll: true });
    }
    async function loadProfileLevels(version) {
      const profile = currentProfile();
      if (!profile) { levelsLoading = false; profileLevels = null; profileLevelsKey = ''; return; }
      const accountRef = profile.authMode === 'chatgpt' ? profile.authRef : null;
      const key = JSON.stringify([profile.provider, profile.modelId, accountRef]);
      if (profileLevelsKey === key && profileLevels) { levelsLoading = false; return; }
      levelsLoading = true; error = ''; render();
      try {
        const catalog = await profilesAdapter.getProviderCatalog(profile.provider, { query: profile.modelId,
          ...(profile.provider === 'openai' ? { accountRef } : {}) });
        if (destroyed || version !== readVersion) return;
        const model = array(catalog?.models).find(item => item.id === profile.modelId) || null;
        profileLevels = model ? array(model.thinkingLevels).filter(level => typeof level === 'string') : [];
        profileLevelsKey = model ? key : '';
      } catch (cause) {
        if (destroyed || version !== readVersion) return;
        error = String(cause?.message || 'Could not load this profile’s reasoning levels.');
        profileLevels = null; profileLevelsKey = '';
      }
      if (!destroyed && version === readVersion) { levelsLoading = false; render(); }
    }
    async function refresh() {
      if (!open) return;
      if (profilesAdapter) {
        if (changing() || profilesLoading || levelsLoading) return;
        const section = open, version = ++readVersion;
        if (!profilesList || section === 'model') {
          profilesLoading = true; error = ''; render();
          try { profilesList = await profilesAdapter.listModelProfiles(); profilesError = ''; }
          catch (cause) { profilesError = String(cause?.message || 'Could not load saved profiles.'); }
          if (destroyed || version !== readVersion) return;
          profilesLoading = false;
        }
        if (section === 'reasoning') { await loadProfileLevels(version); return; }
        render(); return;
      }
      if (!snapshot.connected || changing() || loading) return;
      const section = open, version = ++readVersion;
      const ids = [section === 'model' ? 'get_available_models' : 'get_available_thinking_levels'].filter(id => allowed(id) && !array(snapshot.busy).includes(id));
      if (!ids.length) return;
      loading = true; error = ''; render();
      const results = await Promise.allSettled(ids.map(id => runtime.execute(id)));
      if (destroyed || version !== readVersion) return;
      loading = false;
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected && open === section && snapshot.connected) error = String(rejected.reason?.message || 'Could not refresh available choices.');
      render();
    }
    function show(kind) {
      if (destroyed || options.isUnavailable?.()) return;
      if (kind !== 'model' && kind !== 'reasoning') return;
      if (open === kind) { close(); return; }
      options.beforeOpen?.(); open = kind; error = ''; search.value = ''; menuSignature = ''; menu.hidden = false;
      render();
      (kind === 'model' ? search : list.querySelector('[aria-selected="true"]:not([disabled])') || list.querySelector('button:not([disabled])') || menu).focus({ preventScroll: true });
      refresh();
    }
    async function chooseProfile(kind, value) {
      if (profileGated(kind)) { render(); return; }
      if (kind === 'model') {
        const inherit = value === 'inherit\u241f';
        const profile = inherit ? null : array(profilesList?.profiles).find(item => profileKey(item) === value) || null;
        if (!inherit && !profile) return;
        if (profile ? profile.id === profileContext?.profileId : !profileContext?.profileId) { close(); return; }
        const version = ++actionVersion; pending = kind; error = ''; render();
        try {
          await profilesAdapter.setConversationModelProfile(profileContext.sessionId, profile ? profile.id : null);
          if (destroyed || version !== actionVersion) return;
          profileContext = { ...profileContext, profileId: profile ? profile.id : null };
          options.announce?.(profile ? 'Conversation model set to ' + (profile.name || profile.id) + '.' : 'This conversation inherits the project or app default.');
          if (open === kind) close();
        } catch (cause) {
          if (!destroyed && version === actionVersion) error = String(cause?.message || 'Your selection could not be applied.');
        } finally {
          if (!destroyed && version === actionVersion) { pending = null; render(); }
        }
        return;
      }
      const profile = currentProfile();
      if (!profile) { error = 'Select a model profile before changing reasoning.'; render(); return; }
      if (!array(profileLevels).includes(value)) return;
      if (value === profile.thinkingLevel) { close(); return; }
      const version = ++actionVersion; pending = kind; error = ''; render();
      try {
        const input = { id: profile.id, revision: profile.revision, name: profile.name, provider: profile.provider, modelId: profile.modelId, thinkingLevel: value };
        /* A reasoning-only edit preserves the account binding and echoes the
         * profile's own opaque reference; a freshly switched account is never
         * accepted through this path. */
        if (profile.authMode === 'chatgpt') {
          input.authMode = 'chatgpt';
          if (typeof profile.authRef === 'string' && profile.authRef.length) input.accountRef = profile.authRef;
        }
        await profilesAdapter.saveModelProfile(input);
        if (destroyed || version !== actionVersion) return;
        try { profilesList = await profilesAdapter.listModelProfiles(); } catch (_) { /* The level change was confirmed; refreshing the list is best-effort. */ }
        options.announce?.('Reasoning for ' + (profile.name || profile.id) + ' set to ' + levelInfo(value)[0] + '.');
        if (open === kind) close();
      } catch (cause) {
        if (!destroyed && version === actionVersion) error = String(cause?.message || 'Your selection could not be applied.');
      } finally {
        if (!destroyed && version === actionVersion) { pending = null; render(); }
      }
    }
    async function choose(kind, value) {
      snapshot = runtime.getState();
      if (profilesAdapter) { await chooseProfile(kind, value); return; }
      if (gated(kind)) { render(); return; }
      const item = kind === 'model' ? array(snapshot.models).find(model => modelKey(model) === value) : array(snapshot.thinkingLevels).includes(value);
      if (!item) return;
      if (kind === 'model' ? value === modelKey(snapshot.model) : value === snapshot.thinkingLevel) { close(); return; }
      const version = ++actionVersion; pending = kind; error = ''; render();
      try {
        await runtime.execute(kind === 'model' ? 'set_model' : 'set_thinking_level', kind === 'model' ? { modelKey: value } : { level: value });
        if (destroyed || version !== actionVersion) return;
        options.announce?.(kind === 'model' ? 'Model changed to ' + (snapshot.model?.name || snapshot.model?.id || 'the selected model') + '.' : 'Reasoning effort changed to ' + levelInfo(snapshot.thinkingLevel)[0] + '.');
        if (open === kind) close();
      } catch (cause) {
        if (!destroyed && version === actionVersion && snapshot.connected) error = String(cause?.message || 'Your selection could not be applied.');
      } finally {
        if (!destroyed && version === actionVersion) { pending = null; render(); }
      }
    }

    listen(modelTrigger, 'click', () => show('model'));
    listen(reasoningTrigger, 'click', () => show('reasoning'));
    for (const [trigger, kind] of [[modelTrigger, 'model'], [reasoningTrigger, 'reasoning']]) listen(trigger, 'keydown', event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault(); if (open !== kind) show(kind);
      const rows = [...list.querySelectorAll('button:not([disabled])')];
      (event.key === 'ArrowUp' ? rows.at(-1) : rows[0])?.focus({ preventScroll: true });
    });
    listen(search, 'input', () => renderMenu());
    listen(q('.acmp-close'), 'click', () => close());
    listen(q('.acmp-refresh'), 'click', refresh);
    listen(q('[data-acmp-settings]'), 'click', () => { close(); options.onOpenSettings?.(); });
    listen(list, 'click', event => {
      const row = event.target.closest('[data-acmp-key]'); if (!row || row.disabled) return;
      // A runtime publication can replace this row before the click bubbles.
      // Keep this selection from becoming an outside click on a detached node.
      event.stopPropagation();
      choose(row.hasAttribute('data-acmp-model') ? 'model' : 'reasoning', row.dataset.acmpKey);
    });
    listen(list, 'focusin', event => {
      const row = event.target.closest('[data-acmp-key]');
      if (row) for (const option of list.querySelectorAll('button')) option.tabIndex = option === row ? 0 : -1;
    });
    listen(menu, 'keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Tab') {
        const controls = [...menu.querySelectorAll('button:not([disabled]),input')].filter(element => !element.closest('[hidden]') && element.tabIndex !== -1);
        const index = controls.indexOf(document.activeElement);
        // The portal has its own tab order; leave through the composer trigger.
        if (event.shiftKey && index <= 0 || !event.shiftKey && index === controls.length - 1) { event.preventDefault(); close(); return; }
      }
      const rows = [...list.querySelectorAll('button:not([disabled])')];
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && rows.length) {
        if (event.target === search && ['Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = rows.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : index < 0 ? event.key === 'ArrowUp' ? rows.length - 1 : 0 : (index + (event.key === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length;
        rows[next].focus({ preventScroll: true }); rows[next].scrollIntoView?.({ block: 'nearest' });
      }
    });
    const outside = event => { if (open && !menu.contains(event.target) && !slot.contains(event.target)) close(false); };
    listen(document, 'pointerdown', outside, { capture: true }); listen(document, 'click', outside); listen(document, 'focusin', outside);
    listen(window, 'resize', position); listen(window, 'scroll', position, { capture: true });
    listen(window.visualViewport, 'resize', position); listen(window.visualViewport, 'scroll', position);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(position) : null;
    observer?.observe(slot); observer?.observe(portal);
    const unsubscribe = runtime.subscribe(next => {
      const session = next.session?.sessionId || next.session?.id || '';
      if (!next.connected && snapshot.connected || session && previousSession && session !== previousSession) {
        actionVersion++; readVersion++; pending = null; loading = false; error = ''; close(false);
      }
      previousSession = session; snapshot = next; render();
    });
    render(); options.icons?.();
    return {
      open: show, close,
      sync() { snapshot = runtime.getState(); render(); },
      setPreferences(next) { preferences = next || {}; renderTriggers(); },
      setModelProfiles(adapter) {
        profilesAdapter = adapter || null; profilesList = null; profileLevels = null; profileLevelsKey = '';
        profilesError = ''; profilesEpoch++; readVersion++; actionVersion++;
        pending = null; levelsLoading = false; profilesLoading = false; error = '';
        close(false); render();
        if (profilesAdapter) {
          const version = ++readVersion;
          void profilesAdapter.listModelProfiles().then(result => {
            if (destroyed || version !== readVersion) return;
            profilesList = result;
            render();
          }, cause => {
            if (destroyed || version !== readVersion) return;
            profilesError = String(cause?.message || 'Could not load saved profiles.');
            render();
          });
        }
      },
      setProfileContext(context) {
        const next = context || null;
        const changed = JSON.stringify([next?.sessionId, next?.profileId, next?.projectId]) !== JSON.stringify([profileContext?.sessionId, profileContext?.profileId, profileContext?.projectId]);
        profileContext = next;
        if (changed && open === 'reasoning' && profilesList && !profilesLoading) {
          void loadProfileLevels(++readVersion);
        }
        if (changed) menuSignature = '';
        render();
      },
      getState: () => ({ open, pending, profiles: profilesAdapter ? { loaded: Boolean(profilesList), context: profileContext } : null }),
      destroy() { if (destroyed) return; destroyed = true; actionVersion++; readVersion++; unsubscribe?.(); controller.abort(); observer?.disconnect(); menu.remove(); slot.replaceChildren(); }
    };
  }
  window.AthenaChatModelPicker = { mount };
})();
