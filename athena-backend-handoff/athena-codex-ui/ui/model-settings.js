/* Nonsecret model preferences. Format checks are local; explicit saves and connection checks use an optional host adapter. */
(() => {
  'use strict';

  const instances = new WeakMap();
  const STORAGE_KEY = 'athena.model-settings.v1';
  const PROVIDERS = ['openai-compatible', 'local', 'custom'];
  const ROLES = [
    ['main', 'Main', 'Coordinates the work', 'orbit'],
    ['researcher', 'Researcher', 'Finds and reads evidence', 'search'],
    ['analyst', 'Analyst', 'Works with data and calculations', 'chart-no-axes-combined'],
    ['reviewer', 'Reviewer', 'Checks reasoning and quality', 'scan-eye'],
    ['writer', 'Writer', 'Shapes notes and reports', 'pen-line']
  ];
  const DEFAULTS = {
    version: 1,
    provider: 'openai-compatible',
    endpoint: 'http://localhost:11434/v1',
    defaultModel: 'workspace-default',
    roleModels: { main: '', researcher: '', analyst: '', reviewer: '', writer: '' },
    parallelLimit: 2,
    contextBudget: 32768,
    outputBudget: 4096
  };
  let instanceNumber = 0;
  const copy = value => JSON.parse(JSON.stringify(value));
  const icon = name => '<i data-lucide="' + name + '" aria-hidden="true"></i>';

  function validate(candidate) {
    const errors = {};
    const provider = String(candidate.provider || '');
    const endpoint = String(candidate.endpoint || '').trim();
    const defaultModel = String(candidate.defaultModel || '').trim();
    const roleModels = {};
    const validModel = value => value.length <= 160 && !/[\s\u0000-\u001f\u007f]/u.test(value);
    if (!PROVIDERS.includes(provider)) errors.provider = 'Choose a provider preset.';
    if (!endpoint) errors.endpoint = 'Enter an endpoint base URL.';
    else {
      try {
        const url = new URL(endpoint);
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
          errors.endpoint = 'Use a full http:// or https:// URL.';
        } else if (url.username || url.password || url.search || url.hash) {
          errors.endpoint = 'Use a base URL without credentials, query parameters, or a fragment.';
        } else if (endpoint.length > 2048) errors.endpoint = 'Keep the endpoint URL under 2,048 characters.';
      } catch (_) { errors.endpoint = 'Use a full http:// or https:// URL.'; }
    }
    if (!defaultModel) errors.defaultModel = 'Enter the model identifier expected by your endpoint.';
    else if (!validModel(defaultModel)) errors.defaultModel = 'Use a model identifier of up to 160 characters, without spaces.';
    ROLES.forEach(([role]) => {
      const value = String(candidate.roleModels?.[role] || '').trim();
      roleModels[role] = value;
      if (value && !validModel(value)) errors['role-' + role] = 'Use up to 160 characters without spaces, or leave blank.';
    });
    const parallelLimit = Number(candidate.parallelLimit);
    const contextBudget = Number(candidate.contextBudget);
    const outputBudget = Number(candidate.outputBudget);
    if (!Number.isInteger(parallelLimit) || parallelLimit < 1 || parallelLimit > 4) {
      errors.parallelLimit = 'Choose between 1 and 4 parallel agents.';
    }
    if (!Number.isInteger(contextBudget) || contextBudget < 1024 || contextBudget > 1048576) {
      errors.contextBudget = 'Enter a whole number from 1,024 to 1,048,576.';
    }
    if (!Number.isInteger(outputBudget) || outputBudget < 128 || outputBudget > 65536) {
      errors.outputBudget = 'Enter a whole number from 128 to 65,536.';
    } else if (!errors.contextBudget && outputBudget > contextBudget) {
      errors.outputBudget = 'The output budget cannot exceed the context budget.';
    }
    return {
      errors,
      config: { version: 1, provider, endpoint, defaultModel, roleModels, parallelLimit, contextBudget, outputBudget }
    };
  }

  function mount(host, options = {}) {
    if (!host) throw new TypeError('AthenaModelSettings.mount requires a host element.');
    instances.get(host)?.destroy();
    const controller = new AbortController();
    const listen = (element, type, callback) => element.addEventListener(type, callback, { signal: controller.signal });
    const prefix = 'ams-' + (++instanceNumber) + '-';
    let saved = copy(DEFAULTS);
    let draft;
    let storageMode = 'local';
    let storageNotice = '';
    let destroyed = false;
    let validation = { state: 'unchecked', errors: {} };
    let connectionManager = null, connectionUnsubscribe = null, connectionState = { capabilities: {}, busy: [] };
    let busy = false, saveEpoch = 0, canEditProject = false;
    let hostConfigurationSeen = '', formEdited = false, projectExecution = null;
    const hosted = () => window.AthenaHosted === true || options.hosted === true;
    let modelScopes = { appDefault: null, projectDefault: null, conversation: null, runLocked: null };

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid settings');
          const checked = validate(parsed);
          if (Object.keys(checked.errors).length) throw new Error('Invalid settings');
          saved = checked.config;
        } catch (_) { storageNotice = 'Unreadable saved settings were replaced with defaults.'; }
      }
    } catch (_) { storageMode = 'session'; }
    draft = copy(saved);

    const root = document.createElement('div');
    root.className = 'ams-root';
    const field = (name, label, type, help, attrs = '') => `
      <div class="ams-field">
        <label for="${prefix + name}">${label}</label>
        <input class="ams-input" id="${prefix + name}" name="${name}" type="${type}" aria-describedby="${prefix + name}-help ${prefix + name}-error" ${attrs}>
        <p class="ams-help" id="${prefix + name}-help">${help}</p>
        <p class="ams-error" id="${prefix + name}-error" data-ams-error="${name}" hidden></p>
      </div>`;
    root.innerHTML = `
      <header class="ams-heading">
        <div><span class="ams-eyebrow">APP DEFAULTS</span><h2>Models &amp; connections</h2></div>
        <span class="ams-local-badge">${icon('hard-drive')}Local configuration</span>
      </header>
      <p class="ams-intro">Choose the app default used when a new conversation has no project or conversation override.</p>
      <div class="ams-notice">${icon('info')}<p>Format validation checks these fields locally. Saving and checking a connection are separate actions; their results identify the actual storage and connection scope.</p></div>
      <section class="ams-scopes" aria-label="Model inheritance"><h3>Model scopes</h3><dl>${[['appDefault','App default'],['projectDefault','Project default'],['conversation','Current conversation'],['runLocked','Active run · locked at start']].map(([key,label])=>`<div><dt>${label}</dt><dd data-ams-scope="${key}"></dd></div>`).join('')}</dl><div class="ams-project-actions"><button type="button" class="ams-button cursor-interaction" data-ams-project-action="current">Use conversation model for project</button><button type="button" class="ams-button cursor-interaction" data-ams-project-action="inherit">Inherit app default</button></div><p class="ams-help" data-ams-project-help>Project defaults require a connected project host.</p></section>
      <form class="ams-form" novalidate>
        <section class="ams-section" aria-labelledby="${prefix}connection-title">
          <div class="ams-section-title"><h3 id="${prefix}connection-title">Provider &amp; model</h3><span>01</span></div>
          <div class="ams-field">
            <label for="${prefix}provider">Provider preset</label>
            <select class="ams-input cursor-interaction" id="${prefix}provider" name="provider" aria-describedby="${prefix}provider-help ${prefix}provider-error">
              <option value="openai-compatible">OpenAI-compatible</option><option value="local">Local endpoint</option><option value="custom">Custom</option>
            </select>
            <p class="ams-help" id="${prefix}provider-help">A saved routing preference. Enter your endpoint and model identifier below.</p>
            <p class="ams-error" id="${prefix}provider-error" data-ams-error="provider" hidden></p>
          </div>
          ${field('endpoint', 'Endpoint base URL', 'url', 'Credentials and query parameters are not stored in endpoint URLs.', 'autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="2048" placeholder="http://localhost:11434/v1" required')}
          ${field('defaultModel', 'App default model', 'text', 'Used for new conversations unless the project or conversation selects another model.', 'autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="160" placeholder="your-model-id" required')}
        </section>
        <section class="ams-section" data-ams-execution-section data-legacy-role-routing aria-labelledby="${prefix}routing-title">
          <div class="ams-section-title"><h3 id="${prefix}routing-title">Role routing</h3><span>02</span></div>
          <p class="ams-section-copy">Leave a role blank to inherit the default model.</p>
          <div class="ams-routes">
            ${ROLES.map(([role, name, description, glyph]) => `<div class="ams-route">
              <div class="ams-role-copy"><span class="ams-role-icon">${icon(glyph)}</span><div><label for="${prefix}role-${role}">${name}<span class="ams-visually-hidden"> model</span></label><p>${description}</p></div></div>
              <div class="ams-route-field"><input class="ams-input" id="${prefix}role-${role}" name="role-${role}" type="text" maxlength="160" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="${prefix}role-${role}-error" placeholder="Use default model"><p class="ams-error" id="${prefix}role-${role}-error" data-ams-error="role-${role}" hidden></p></div>
            </div>`).join('')}
          </div>
        </section>
        <section class="ams-section" data-ams-execution-section aria-labelledby="${prefix}limits-title">
          <div class="ams-section-title"><h3 id="${prefix}limits-title">Execution limits</h3><span>03</span></div>
          <div class="ams-field">
            <label for="${prefix}parallelLimit">Parallel agents</label>
            <div class="ams-parallel-row"><select class="ams-input cursor-interaction" id="${prefix}parallelLimit" name="parallelLimit" aria-describedby="${prefix}parallelLimit-help ${prefix}parallelLimit-error"><option value="1">1 agent</option><option value="2">2 agents</option><option value="3">3 agents</option><option value="4">4 agents</option></select><span class="ams-limit-note">Saved execution preference</span></div>
            <p class="ams-help" id="${prefix}parallelLimit-help">The maximum number of roles working at once.</p>
            <p class="ams-error" id="${prefix}parallelLimit-error" data-ams-error="parallelLimit" hidden></p>
          </div>
          <div class="ams-budget-grid">
            ${field('contextBudget', 'Context budget', 'number', 'Tokens per model request · 1,024–1,048,576', 'inputmode="numeric" min="1024" max="1048576" step="1" required')}
            ${field('outputBudget', 'Output budget', 'number', 'Maximum output tokens · 128–65,536', 'inputmode="numeric" min="128" max="65536" step="1" required')}
          </div>
          <p class="ams-help ams-limits-footnote">Athena TaskManager owns real scheduling. These values are preferences until the host accepts them; changing defaults does not rewrite a running task’s confirmed configuration.</p>
        </section>
        <div class="ams-save-area">
          <div class="ams-save-state"><span class="ams-dirty-dot" aria-hidden="true"></span><span data-ams-dirty>Saved preferences</span></div>
          <p class="ams-status" role="status" aria-live="polite" data-ams-status></p>
          <div class="ams-actions">
            <button class="ams-button ams-format-button cursor-interaction" type="button" data-ams-action="validate">${icon('list-checks')}Validate format</button>
            <button class="ams-button cursor-interaction" type="button" data-ams-action="verify">${icon('plug-zap')}Check connection</button>
            <button class="ams-button cursor-interaction" type="button" data-ams-action="revert" disabled>Revert changes</button>
            <button class="ams-button ams-primary cursor-interaction" type="submit">${icon('check')}Save settings</button>
          </div>
          <p class="ams-help" data-ams-connection-status>Connection checking requires a host adapter.</p>
        </div>
      </form>`;
    host.replaceChildren(root);
    const form = root.querySelector('form');
    const status = root.querySelector('[data-ams-status]');
    const dirtyLabel = root.querySelector('[data-ams-dirty]');
    const revertButton = root.querySelector('[data-ams-action="revert"]');
    const controls = {};
    form.id = prefix + 'configuration-form';
    form.querySelectorAll('[name]').forEach(input => { controls[input.name] = input; });
    const executionSlot = host.closest('.ast-content')?.querySelector('#ast-agent-model-settings-slot');
    let executionRoot = null;
    if (executionSlot) {
      executionRoot = document.createElement('div'); executionRoot.className = 'ams-root ams-execution-preferences';
      for (const section of Array.from(form.querySelectorAll('[data-ams-execution-section]'))) {
        for (const input of section.querySelectorAll('input,select,textarea')) input.setAttribute('form', form.id);
        executionRoot.appendChild(section);
      }
      const saveRow = document.createElement('div'); saveRow.className = 'ams-actions';
      saveRow.innerHTML = '<button type="button" class="ams-button cursor-interaction" data-ams-save-execution>Save settings</button><p class="ams-help">Explicitly saves the model, role and execution preferences together.</p><p class="ams-status" role="status" aria-live="polite" data-ams-execution-status></p>';
      executionRoot.appendChild(saveRow); executionSlot.appendChild(executionRoot);
    }
    const eventRoot = host.closest('.ast-sheet') || root;

    const hostPanel = document.createElement('section');
    hostPanel.className = 'ams-section'; hostPanel.hidden = true;
    hostPanel.innerHTML = '<div class="ams-section-title"><h3>Project execution</h3></div><p class="ams-section-copy" data-ams-policy-status></p><button type="button" class="ams-button cursor-interaction" data-ams-analysis-toggle hidden></button><p class="ams-status" role="status" data-ams-analysis-status></p><dl class="ams-host-limits"></dl>';
    (executionRoot || form).prepend(hostPanel);
    const analysisToggle = hostPanel.querySelector('[data-ams-analysis-toggle]');
    const analysisStatus = hostPanel.querySelector('[data-ams-analysis-status]');
    let analysisSaving = false;
    listen(analysisToggle, 'click', async () => {
      const { projectId, enabled } = projectExecution ?? {};
      if (!projectId || analysisToggle.disabled || analysisSaving) return;
      analysisSaving = true;
      analysisStatus.textContent = '';
      renderPolicy(projectExecution);
      try {
        const result = await options.onSetProjectExecution(projectId, !enabled);
        if (result?.saved !== true) throw new Error('The host did not confirm the new permission.');
        if (!destroyed && projectExecution?.projectId === projectId) analysisStatus.textContent = 'Project permission saved.';
      } catch (error) {
        if (!destroyed && projectExecution?.projectId === projectId) analysisStatus.textContent = error?.message || 'Could not update project permission.';
      } finally {
        analysisSaving = false;
        if (!destroyed) renderPolicy(projectExecution);
      }
    });
    function renderPolicy(execution) {
      hostPanel.hidden = !hosted();
      if (!hosted()) return;
      const status = hostPanel.querySelector('[data-ams-policy-status]');
      status.textContent = execution ? (execution.projectId ? (execution.enabled ? 'Enabled' : 'Disabled') + ' for this project' : 'No project selected') + (execution.canEdit ? ' · Allows agents to run Python or JavaScript on granted files.' : ' · Read-only host policy.') : 'The host has not reported an execution policy for this project.';
      analysisToggle.hidden = !execution?.canEdit || typeof options.onSetProjectExecution !== 'function';
      analysisToggle.disabled = analysisSaving || !execution?.runtime?.available;
      analysisToggle.textContent = execution?.enabled ? 'Disable offline analysis' : 'Enable offline analysis';
      const list = hostPanel.querySelector('dl'); list.replaceChildren();
      const add = (label, value) => {
        if (value == null) return;
        const term = document.createElement('dt'), detail = document.createElement('dd');
        term.textContent = label; detail.textContent = String(value); list.append(term, detail);
      };
      if (execution) {
        add('Project', execution.projectId); add('Backend', execution.backend);
        add('Network', execution.network === false ? 'Disabled' : null); add('Shell', execution.shell === false ? 'Disabled' : null);
        const runtime = execution.runtime;
        if (runtime?.available === false) add('Runtime unavailable', runtime.reason);
        if (runtime?.available === true) {
          add('Runtime', runtime.engine);
          for (const [label, runtimeInfo] of [['JavaScript', runtime.node], ['Python', runtime.python]]) {
            add(label, runtimeInfo ? [runtimeInfo.version, runtimeInfo.path].filter(Boolean).join(' · ') : 'Not reported');
          }
        }
        for (const [name, value] of Object.entries(execution.limits || {})) {
          if (Number.isFinite(value)) add(name === 'concurrency' ? 'Concurrent processes' : name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()), value);
        }
      }
      const config = connectionState.configuration;
      add('Context budget (tokens)', config?.contextBudget); add('Output budget (tokens)', config?.outputBudget);
    }

    function fillForm(config) {
      ['provider', 'endpoint', 'defaultModel', 'parallelLimit', 'contextBudget', 'outputBudget'].forEach(name => { controls[name].value = String(config[name]); });
      ROLES.forEach(([role]) => { controls['role-' + role].value = config.roleModels[role] || ''; });
    }
    function readDraft() {
      const result = { version: 1, roleModels: {} };
      ['provider', 'endpoint', 'defaultModel', 'parallelLimit', 'contextBudget', 'outputBudget'].forEach(name => { result[name] = controls[name].value; });
      ROLES.forEach(([role]) => { result.roleModels[role] = controls['role-' + role].value; });
      return result;
    }
    function isDirty() { return JSON.stringify(validate(draft).config) !== JSON.stringify(saved); }
    function setStatus(message, tone = '') {
      status.textContent = message; status.dataset.tone = tone;
      const executionStatus = executionRoot?.querySelector('[data-ams-execution-status]');
      if (executionStatus) { executionStatus.textContent = message; executionStatus.dataset.tone = tone; }
    }
    function refreshDirty() {
      const dirty = isDirty();
      root.dataset.dirty = String(dirty);
      dirtyLabel.textContent = dirty ? 'Unsaved changes' : hosted() && hostConfigurationSeen && !connectionState.configurationId ? 'Host defaults · not saved' : (storageMode === 'session' ? 'Saved in this session' : 'Preferences up to date');
      revertButton.disabled = busy || !dirty;
      for (const button of eventRoot.querySelectorAll('[data-ams-save-execution],.ams-primary,[data-ams-action=verify]')) button.disabled = busy || (button.dataset.amsAction === 'verify' && !connectionState.capabilities?.verifyConnection);
      ROLES.forEach(([role]) => { controls['role-' + role].placeholder = draft.defaultModel.trim() || 'Use default model'; });
    }
    function showErrors(errors) {
      Object.entries(controls).forEach(([name, input]) => {
        const message = errors[name];
        const target = eventRoot.querySelector('[data-ams-error="' + name + '"]');
        input.setAttribute('aria-invalid', message ? 'true' : 'false');
        if (target) { target.textContent = message || ''; target.hidden = !message; }
      });
    }
    function checkForm() {
      draft = readDraft();
      const checked = validate(draft);
      const first = Object.keys(checked.errors)[0];
      validation = { state: first ? 'invalid' : 'valid', errors: { ...checked.errors } };
      showErrors(checked.errors);
      if (first) {
        setStatus('Check the highlighted fields before saving.', 'error');
        const panel = controls[first]?.closest('.ast-panel');
        if (panel?.hidden) eventRoot.querySelector('#' + panel.getAttribute('aria-labelledby'))?.click();
        controls[first]?.focus();
      }
      return first ? null : checked.config;
    }
    function handleEdit() {
      formEdited = true;
      draft = readDraft();
      validation = { state: 'unchecked', errors: {} };
      showErrors({});
      setStatus(isDirty() ? 'Your changes are kept here until you save or revert them.' : '');
      refreshDirty();
    }

    function scopeLabel(value, fallback) {
      if (!value) return fallback;
      if (typeof value === 'string') return value;
      return [value.name || value.modelId || value.id, value.provider].filter(Boolean).join(' · ') || fallback;
    }
    function renderScopes() {
      const fallback = { appDefault: hosted() || storageMode === 'host' ? 'Awaiting a confirmed runtime default' : 'Local preference · ' + (saved.defaultModel || 'Not configured'), projectDefault: 'Inherit app default', conversation: 'No active conversation', runLocked: 'No run has started' };
      for (const [key, value] of Object.entries(modelScopes)) root.querySelector('[data-ams-scope="' + key + '"]').textContent = scopeLabel(value, fallback[key]);
      const current = modelScopes.conversation;
      root.querySelector('[data-ams-project-action="current"]').disabled = busy || !canEditProject || !current || typeof current !== 'object' || !current.provider || !(current.modelId || current.id);
      root.querySelector('[data-ams-project-action="inherit"]').disabled = busy || !canEditProject;
      root.querySelector('[data-ams-project-help]').textContent = canEditProject ? 'Project defaults apply to new conversations. The active run keeps its confirmed model.' : 'Project defaults require a connected project host with model-setting support.';
    }
    function renderConnection() {
      const incoming = connectionState.configuration;
      const signature = incoming ? JSON.stringify(incoming) : '';
      if (signature && signature !== hostConfigurationSeen) {
        const checked = validate(incoming);
        if (!Object.keys(checked.errors).length) {
          const dirty = isDirty();
          hostConfigurationSeen = signature;
          saved = checked.config; storageMode = connectionState.configurationId ? 'host' : 'session';
          if (!formEdited || !dirty) { draft = copy(saved); fillForm(draft); formEdited = false; }
        }
      }
      if (hosted()) {
        for (const name of ['parallelLimit', 'contextBudget', 'outputBudget', ...ROLES.map(([role]) => 'role-' + role)]) controls[name].disabled = true;
        for (const section of eventRoot.querySelectorAll('[data-ams-execution-section]')) section.hidden = true;
        if (executionRoot) executionRoot.querySelector('.ams-actions').hidden = true;
        renderPolicy(projectExecution);
        if (!hostConfigurationSeen && !formEdited) { controls.endpoint.value = ''; controls.defaultModel.value = ''; }
        draft = readDraft();
      }
      const capable = Boolean(connectionState.capabilities?.saveConfig);
      root.querySelector('.ams-local-badge').innerHTML = icon(capable ? 'server' : 'hard-drive') + (capable ? 'Host configuration' : 'Local configuration');
      const status = root.querySelector('[data-ams-connection-status]');
      const verification = connectionState.verification || {};
      status.textContent = connectionState.capabilities?.verifyConnection ? verification.status === 'connected' ? 'The last host connection check passed. Use Check connection to verify changed fields.' : verification.status === 'failed' ? 'The last connection check failed. ' + (verification.message || '') : 'Check connection asks the host to contact this endpoint; it does not save these fields.' : 'Connection checking is unavailable until a compatible host adapter is attached.';
      refreshDirty(); renderScopes(); options.icons?.();
    }
    function setConnectionManager(manager) {
      saveEpoch++; connectionUnsubscribe?.(); connectionUnsubscribe = null; busy = false;
      connectionManager = manager || null; connectionState = manager?.getState?.() || { capabilities: {}, busy: [] };
      if (manager?.subscribe) connectionUnsubscribe = manager.subscribe(next => { connectionState = next; if (!destroyed) renderConnection(); });
      renderConnection();
    }
    async function saveConfiguration() {
      if (busy || destroyed) return;
      const next = checkForm(); if (!next) return;
      const submittedDraft = JSON.stringify(readDraft()), version = ++saveEpoch;
      busy = true; refreshDirty(); renderScopes();
      setStatus(connectionState.capabilities?.saveConfig ? 'Saving configuration with the host…' : 'Saving preferences locally…');
      try {
        let confirmed = next, hostSaved = false;
        if (connectionManager && connectionState.capabilities?.saveConfig) {
          const result = await connectionManager.saveConfig(next);
          if (destroyed || version !== saveEpoch) return;
          if (result?.saved !== true) throw new Error('The host did not confirm this configuration.');
          hostSaved = true;
          if (result.configuration) { const checked = validate(result.configuration); if (Object.keys(checked.errors).length) throw new Error('The host returned an invalid configuration.'); confirmed = checked.config; }
        }
        saved = confirmed;
        try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); storageMode = hostSaved ? 'host' : 'local'; }
        catch (_) { storageMode = hostSaved ? 'host' : 'session'; }
        if (JSON.stringify(readDraft()) === submittedDraft) { draft = copy(saved); fillForm(saved); }
        else draft = readDraft();
        const message = hostSaved ? 'Configuration saved by the host. New conversations use defaults confirmed by that host.' : storageMode === 'local' ? 'Settings saved locally. No endpoint connection was attempted.' : 'Settings saved for this session. Persistent storage is unavailable.';
        setStatus(message, 'success'); options.onChange?.(copy(saved)); options.toast?.(message);
      } catch (error) { if (!destroyed && version === saveEpoch) setStatus(String(error?.message || error), 'error'); }
      finally { if (!destroyed && version === saveEpoch) { busy = false; refreshDirty(); renderScopes(); } }
    }
    async function verifyConnection() {
      if (busy || !connectionManager || !connectionState.capabilities?.verifyConnection) return;
      const next = checkForm(); if (!next) return;
      const version = ++saveEpoch; busy = true; refreshDirty();
      setStatus('Checking the endpoint through the connected host…');
      try {
        const result = await connectionManager.verify(next);
        if (destroyed || version !== saveEpoch) return;
        setStatus(result.status === 'connected' ? 'Connection check passed. These fields have not been saved by this check.' : 'Connection check failed. ' + (result.message || ''), result.status === 'connected' ? 'success' : 'error');
      } catch (error) { if (!destroyed && version === saveEpoch) setStatus(String(error?.message || error), 'error'); }
      finally { if (!destroyed && version === saveEpoch) { busy = false; renderConnection(); } }
    }
    for (const input of Object.values(controls)) { listen(input, 'input', handleEdit); listen(input, 'change', handleEdit); }
    listen(form, 'submit', event => { event.preventDefault(); saveConfiguration(); });
    if (executionRoot) listen(executionRoot.querySelector('[data-ams-save-execution]'), 'click', saveConfiguration);
    listen(root, 'click', event => {
      const projectAction = event.target.closest('[data-ams-project-action]');
      if (projectAction && !projectAction.disabled && canEditProject && options.onSetProjectDefaultModel) {
        const value = modelScopes.conversation;
        const chosen = projectAction.dataset.amsProjectAction === 'inherit' ? null : { provider: value.provider, modelId: value.modelId || value.id, ...(value.thinkingLevel ? { thinkingLevel: value.thinkingLevel } : {}) };
        busy = true; refreshDirty(); renderScopes();
        Promise.resolve().then(() => options.onSetProjectDefaultModel(chosen)).then(result => {
          if (result === false || result?.success === false) throw new Error(result?.error || 'The project host rejected this change.');
          if (!destroyed) setStatus(result?.saved === true || result?.confirmed === true ? 'Project default update was confirmed by the host.' : 'Request sent. Waiting for the project host to report its confirmed default.', result?.saved === true || result?.confirmed === true ? 'success' : '');
        }).catch(error => { if (!destroyed) setStatus(String(error?.message || error), 'error'); }).finally(() => { if (!destroyed) { busy = false; refreshDirty(); renderScopes(); } });
        return;
      }
      const button = event.target.closest('[data-ams-action]');
      if (!button || !root.contains(button) || button.disabled || busy) return;
      if (button.dataset.amsAction === 'validate') {
        if (checkForm()) setStatus('The format is valid. No connection or model availability check was attempted.', 'success');
      }
      if (button.dataset.amsAction === 'verify') verifyConnection();
      if (button.dataset.amsAction === 'revert') {
        draft = copy(saved); fillForm(saved); validation = { state: 'unchecked', errors: {} }; showErrors({}); refreshDirty();
        setStatus('Changes reverted to your last saved preferences.');
      }
    });

    fillForm(saved);
    refreshDirty();
    setStatus(storageNotice || (storageMode === 'session' ? 'Persistent storage is unavailable. Settings will stay in this session.' : ''));
    setConnectionManager(options.connectionManager);
    renderScopes();
    options.icons?.();
    const api = {
      getState: () => ({ saved: copy(saved), draft: copy(draft), isDirty: isDirty(), storageMode, validation: copy(validation), busy, connection: copy(connectionState), modelScopes: copy(modelScopes) }),
      setConnectionManager,
      setExecution(execution) { if (execution?.projectId !== projectExecution?.projectId) analysisStatus.textContent = ''; projectExecution = execution; renderPolicy(execution); },
      setModelScopes(next, settings = {}) { modelScopes = { appDefault: null, projectDefault: null, conversation: null, runLocked: null, ...next }; canEditProject = settings.canEditProject === true && typeof options.onSetProjectDefaultModel === 'function'; renderScopes(); },
      focus() { if (!destroyed) controls.provider.focus({ preventScroll: true }); },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        saveEpoch++; connectionUnsubscribe?.();
        controller.abort();
        executionRoot?.remove(); root.remove();
        instances.delete(host);
      }
    };
    instances.set(host, api);
    return api;
  }

  window.AthenaModelSettings = Object.freeze({ mount });
})();
