/* Settings navigation. Local preferences and host/session controls have distinct save scopes. */
(() => {
  'use strict';

  const instances = new WeakMap();
  const STORAGE_KEY = 'athena.ui.settings.v1';
  const DEFAULTS = Object.freeze({ language: 'en', textSize: 'default', reducedMotion: false, defaultSideView: 'home', sendKey: 'enter' });
  const SECTIONS = [
    ['models', 'Models & connections', 'cpu'],
    ['execution', 'Agents & execution', 'workflow'],
    ['tools', 'Tools & plugins', 'plug'],
    ['files', 'Files & history', 'folder-clock'],
    ['appearance', 'Appearance & notifications', 'sun'],
    ['about', 'About & diagnostics', 'info']
  ];
  const ALIASES = { general: 'appearance', workspace: 'appearance', connections: 'models', pi: 'execution' };
  const RUNTIME_CATEGORY = { model: 'models', queue: 'execution', context: 'execution', tools: 'tools', resources: 'tools', extensions: 'tools', session: 'files', usage: 'about' };
  const DEFAULT_RUNTIME = { models: 'model', execution: 'queue', tools: 'tools', files: 'session', about: 'usage' };
  const TEXT_SIZES = { compact: ['13px', '0.928571'], default: ['14px', '1'], large: ['16px', '1.142857'] };
  const SIDE_VIEWS = ['home', 'browser', 'files', 'workflow', 'artifacts', 'timeline', 'knowledge', 'research'];
  const icon = name => '<i data-lucide="' + name + '" aria-hidden="true"></i>';

  function mount(root, options = {}) {
    if (!root) throw new TypeError('AthenaSettings.mount requires an application root.');
    instances.get(root)?.destroy();
    const controller = new AbortController();
    const { signal } = controller;
    const listen = (element, type, callback, settings = {}) => element.addEventListener(type, callback, { ...settings, signal });
    const previousAttributes = Object.fromEntries(['data-text-size', 'data-reduced-motion', 'data-settings-open'].map(name => [name, root.getAttribute(name)]));
    const previousVariables = Object.fromEntries(['--ac-font-size', '--ac-font-scale'].map(name => [name, root.style.getPropertyValue(name)]));
    let preferences = { ...DEFAULTS };
    let section = 'models';
    let runtimeSection = 'model';
    let opened = false;
    let destroyed = false;
    let opener = null;
    let openerWasAgent = false;
    let sessionOnly = false;

    try {
      const text = window.localStorage.getItem(STORAGE_KEY);
      let saved = null;
      try { saved = text ? JSON.parse(text) : null; } catch (_) { /* Ignore malformed saved preferences. */ }
      if (saved && typeof saved === 'object') {
        if (Object.hasOwn(TEXT_SIZES, saved.textSize)) preferences.textSize = saved.textSize;
        if (typeof saved.reducedMotion === 'boolean') preferences.reducedMotion = saved.reducedMotion;
        // Tool activity is inline now; stale panel preferences return to the picker.
        if (['execution', 'terminal'].includes(saved.defaultSideView)) preferences.defaultSideView = 'home';
        else if (saved.defaultSideView === 'agents') preferences.defaultSideView = 'timeline';
        else if (SIDE_VIEWS.includes(saved.defaultSideView)) preferences.defaultSideView = saved.defaultSideView;
        if (['enter', 'mod-enter'].includes(saved.sendKey)) preferences.sendKey = saved.sendKey;
      }
    } catch (_) { sessionOnly = true; }

    const backdrop = document.createElement('div');
    backdrop.className = 'ast-backdrop';
    backdrop.id = 'ac-settings-backdrop';
    backdrop.hidden = true;
    backdrop.innerHTML = `
      <section class="ast-sheet" role="dialog" aria-modal="true" aria-labelledby="ast-title" tabindex="-1">
        <header class="ast-header">
          <div class="ast-title-wrap">${icon('settings-2')}<h1 id="ast-title">Settings</h1></div>
          <button type="button" class="ast-close" data-ast-action="close" aria-label="Close settings">${icon('x')}</button>
        </header>
        <div class="ast-body">
          <nav class="ast-nav" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
            ${SECTIONS.map(([id, label, glyph]) => `<button type="button" class="ast-nav-item" id="ast-tab-${id}" data-ast-section="${id}" role="tab" aria-controls="ast-panel-${id}" aria-selected="${id === 'models'}" tabindex="${id === 'models' ? 0 : -1}">${icon(glyph)}<span>${label}</span></button>`).join('')}
          </nav>
          <div class="ast-content">
            <section class="ast-panel" tabindex="0" id="ast-panel-general" role="tabpanel" aria-labelledby="ast-tab-general">
              <div class="ast-section-heading"><h2>General</h2><p>Make Athena work the way you do.</p></div>
              <div class="ast-setting-row">
                <div class="ast-setting-copy"><h3>Language</h3><p>The interface language for this preview.</p></div>
                <div class="ast-static-value">English <span class="ast-badge">Default</span></div>
              </div>
              <div class="ast-setting-row">
                <div class="ast-setting-copy"><label for="ast-send-key">Send messages with</label><p id="ast-send-key-help">Shift + Enter always adds a new line.</p></div>
                <select class="ast-select" id="ast-send-key" data-ast-setting="sendKey" aria-describedby="ast-send-key-help"><option value="enter">Enter</option><option value="mod-enter">Ctrl / ⌘ + Enter</option></select>
              </div>
              <div class="ast-setting-row">
                <div class="ast-setting-copy"><label for="ast-default-view">Default side view</label><p id="ast-default-view-help">The view opened by the side-view button.</p></div>
                <select class="ast-select" id="ast-default-view" data-ast-setting="defaultSideView" aria-describedby="ast-default-view-help"><option value="home">View picker</option><option value="browser">Browser</option><option value="files">Files</option><option value="workflow">Workflow</option><option value="artifacts">Artifacts</option><option value="timeline">Agent timeline</option><option value="knowledge">Knowledge</option><option value="research">Research</option></select>
              </div>
              <div class="ast-inline-tip">${icon('keyboard')}<p>Use the side view to keep files and research notes beside your conversation.</p></div>
            </section>
            <section class="ast-panel" tabindex="0" id="ast-panel-appearance" role="tabpanel" aria-labelledby="ast-tab-appearance" hidden>
              <div class="ast-section-heading"><h2>Appearance</h2><p>A comfortable space for focused work.</p></div>
              <div class="ast-setting-row ast-stacked-row">
                <div class="ast-setting-copy"><h3 id="ast-text-size-label">Text size</h3><p>Adjust conversation, input, and document text.</p></div>
                <div class="ast-size-options" role="radiogroup" aria-labelledby="ast-text-size-label">
                  <button type="button" class="ast-size-option" data-ast-size="compact" role="radio" aria-checked="false" tabindex="-1"><span class="ast-size-symbol ast-size-compact" aria-hidden="true">Aa</span><span>Compact</span></button>
                  <button type="button" class="ast-size-option" data-ast-size="default" role="radio" aria-checked="true" tabindex="0"><span class="ast-size-symbol ast-size-default" aria-hidden="true">Aa</span><span>Default</span></button>
                  <button type="button" class="ast-size-option" data-ast-size="large" role="radio" aria-checked="false" tabindex="-1"><span class="ast-size-symbol ast-size-large" aria-hidden="true">Aa</span><span>Large</span></button>
                </div>
                <div class="ast-text-preview" aria-label="Text size preview"><span class="ast-preview-label">PREVIEW</span><p>Follow your research, one question at a time.</p><span class="ast-preview-caption">Compare findings, keep the evidence, and decide what comes next.</span></div>
              </div>
              <div class="ast-setting-row">
                <div class="ast-setting-copy"><label for="ast-reduced-motion">Reduce motion</label><p id="ast-reduced-motion-help">Minimize interface animation. Your system preference also applies.</p></div>
                <label class="ast-switch"><input id="ast-reduced-motion" type="checkbox" role="switch" data-ast-setting="reducedMotion" aria-describedby="ast-reduced-motion-help"><span class="ast-switch-track" aria-hidden="true"></span></label>
              </div>
              <div class="ast-theme-note"><span class="ast-theme-swatch" aria-hidden="true"></span><span>Warm light appearance</span></div>
            </section>
            <section class="ast-panel" tabindex="0" id="ast-panel-workspace" role="tabpanel" aria-labelledby="ast-tab-workspace" hidden>
              <div class="ast-section-heading"><h2>Workspace</h2><p>Keep the parts you need within reach.</p></div>
              <div class="ast-setting-row">
                <div class="ast-setting-copy"><label for="ast-project-sidebar">Show project sidebar</label><p id="ast-project-sidebar-help">Keep your projects and conversations visible on the left.</p></div>
                <label class="ast-switch"><input id="ast-project-sidebar" type="checkbox" role="switch" aria-describedby="ast-project-sidebar-help"><span class="ast-switch-track" aria-hidden="true"></span></label>
              </div>
              <div class="ast-setting-row">
                <div class="ast-setting-copy"><h3>Panel widths</h3><p>Restore the project and side panels to their default widths.</p></div>
                <button type="button" class="ast-button" data-ast-action="reset-widths">${icon('rotate-ccw')}<span>Reset widths</span></button>
              </div>
              <div class="ast-workspace-illustration" aria-hidden="true"><span class="ast-mini-sidebar"></span><span class="ast-mini-chat"><i></i><i></i><i></i><b></b></span><span class="ast-mini-panel"></span></div>
              <p class="ast-workspace-caption">Drag a panel edge to adjust its width. Double-click the edge to reset it.</p>
            </section>
            <section class="ast-panel" tabindex="0" id="ast-panel-models" role="tabpanel" aria-labelledby="ast-tab-models" hidden><div id="ast-worker-models-slot"></div><div id="ast-model-settings-slot"></div><div id="ast-provider-profiles-slot"></div></section>
            <section class="ast-panel" tabindex="0" id="ast-panel-pi" role="tabpanel" aria-labelledby="ast-tab-pi" hidden><div id="ast-pi-workbench-slot"></div></section>
            <section class="ast-panel" tabindex="0" id="ast-panel-connections" role="tabpanel" aria-labelledby="ast-tab-connections" hidden>
              <div class="ast-section-heading"><h2>Connections</h2><p>Tools and skills available in the composer.</p></div>
              <div class="ast-connection-notice">${icon('unplug')}<p>This preview is not connected to an execution engine.</p></div>
              <button type="button" class="ast-button" data-action="pi-resources">${icon('orbit')}<span>Manage tools &amp; skills</span></button>
              <div id="ast-extensions-slot"></div>
              <p class="ast-connection-footnote">Installed packages, available skills and connection checks come from the connected host.</p>
            </section>
            <section class="ast-panel" tabindex="0" id="ast-panel-about" role="tabpanel" aria-labelledby="ast-tab-about" hidden>
              <div class="ast-section-heading"><h2>About</h2><p>Your research workspace.</p></div>
              <div class="ast-about-brand"><img src="assets/athena-icon-128.png" width="64" height="64" alt=""><div><h3>Athena</h3><p>Desktop UI preview</p></div></div>
              <p class="ast-about-description">A focused workspace for research conversations, evidence, and connected tools.</p>
              <dl class="ast-about-details"><div><dt>Interface</dt><dd>Local prototype</dd></div><div><dt>Default language</dt><dd>English</dd></div><div><dt>Preferences</dt><dd data-ast-storage>Saved on this device</dd></div></dl>
              <p class="ast-about-note">This preview demonstrates the interface. Research answers, execution logs, and connection states use example data.</p>
            </section>
          </div>
        </div>
        <footer class="ast-footer"><span>${icon('check')}<span data-ast-save-status>Changes save automatically on this device.</span></span><kbd>Esc to close</kbd></footer>
        <span class="ac-sr-only" data-ast-live role="status" aria-live="polite"></span>
      </section>`;
    root.appendChild(backdrop);
    // Reuse every existing section and mount; only their grouping changes.
    const content = backdrop.querySelector('.ast-content');
    const oldSections = new Map();
    for (const panel of Array.from(content.children)) {
      const key = panel.id.replace('ast-panel-', '');
      panel.id = 'ast-section-' + key; panel.className = 'ast-subsection';
      panel.removeAttribute('role'); panel.removeAttribute('aria-labelledby'); panel.removeAttribute('tabindex'); panel.hidden = false;
      oldSections.set(key, panel); panel.remove();
    }
    const categoryPanels = new Map();
    for (const [id] of SECTIONS) {
      const panel = document.createElement('section'); panel.className = 'ast-panel'; panel.id = 'ast-panel-' + id;
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'ast-tab-' + id); panel.tabIndex = 0; panel.hidden = id !== 'models';
      content.appendChild(panel); categoryPanels.set(id, panel);
    }
    categoryPanels.get('models').appendChild(oldSections.get('models'));
    categoryPanels.get('execution').innerHTML = '<div class="ast-section-heading"><h2>Agents &amp; execution</h2><p>Execution settings and controls for the current session.</p></div><div class="ast-connection-notice">' + icon('workflow') + '<p>Athena TaskManager owns scheduling. This interface subscribes to task state and sends explicit supported commands.</p></div><div id="ast-agent-model-settings-slot"></div>';
    categoryPanels.get('tools').appendChild(oldSections.get('connections'));
    oldSections.get('connections').querySelector('h2').textContent = 'Tools & plugins';
    oldSections.get('connections').querySelector('.ast-connection-footnote').textContent = 'Installed packages, available skills and connection checks come from the connected host.';
    categoryPanels.get('files').innerHTML = '<div class="ast-section-heading"><h2>Files &amp; history</h2><p>Project sources, document versions and conversation history.</p></div><div class="ast-connection-notice">' + icon('database') + '<p>Durable file storage, extraction and version history require the project host. A PDF preview does not mean its content has been extracted or understood.</p></div><div id="ast-files-contract-slot"></div>';
    for (const id of ['general', 'appearance', 'workspace']) categoryPanels.get('appearance').appendChild(oldSections.get(id));
    oldSections.get('general').querySelector('h2').textContent = 'Conversation';
    oldSections.get('appearance').querySelector('h2').textContent = 'Appearance & notifications';
    const notificationNote = document.createElement('p'); notificationNote.className = 'ast-connection-footnote'; notificationNote.textContent = 'Extension notifications follow the connected session. Operating-system notification permissions are managed by the host.'; oldSections.get('appearance').appendChild(notificationNote);
    categoryPanels.get('about').appendChild(oldSections.get('about'));
    oldSections.get('about').querySelector('h2').textContent = 'About & diagnostics';
    oldSections.get('about').querySelector('.ast-about-note').textContent = 'The preview remains disconnected until an execution host is attached. Live state and development examples are kept separate.';
    const demoControl = document.createElement('div'); demoControl.className = 'ast-setting-row';
    demoControl.innerHTML = '<div class="ast-setting-copy"><label for="ast-demo-mode">Development examples</label><p>Show authored demonstration tasks. Available only without a connected runtime.</p></div><label class="ast-switch"><input id="ast-demo-mode" type="checkbox" role="switch"><span class="ast-switch-track" aria-hidden="true"></span></label>';
    categoryPanels.get('about').appendChild(demoControl);
    for (const id of Object.keys(DEFAULT_RUNTIME)) { const target = document.createElement('div'); target.className = 'ast-runtime-host'; target.dataset.astRuntimeHost = id; categoryPanels.get(id).appendChild(target); }
    const runtimeSlot = oldSections.get('pi').querySelector('#ast-pi-workbench-slot');
    categoryPanels.get('models').querySelector('[data-ast-runtime-host]').appendChild(runtimeSlot);
    const q = selector => backdrop.querySelector(selector);
    const qa = selector => Array.from(backdrop.querySelectorAll(selector));
    qa('button,select,.ast-switch,.ast-setting-copy > label').forEach(element => element.classList.add('cursor-interaction'));
    const sheet = q('.ast-sheet');
    const getState = () => ({ ...preferences });

    function applyPreferences() {
      const [size, scale] = TEXT_SIZES[preferences.textSize];
      root.style.setProperty('--ac-font-size', size);
      root.style.setProperty('--ac-font-scale', scale);
      root.dataset.textSize = preferences.textSize;
      root.dataset.reducedMotion = String(preferences.reducedMotion);
    }

    function syncControls() {
      q('#ast-send-key').value = preferences.sendKey;
      q('#ast-default-view').value = preferences.defaultSideView;
      q('#ast-reduced-motion').checked = preferences.reducedMotion;
      for (const button of qa('[data-ast-size]')) {
        const active = button.dataset.astSize === preferences.textSize;
        button.setAttribute('aria-checked', String(active));
        button.tabIndex = active ? 0 : -1;
      }
      q('#ast-project-sidebar').checked = options.getSidebarOpen ? !!options.getSidebarOpen() : root.dataset.leftOpen !== 'false';
      q('#ast-project-sidebar').disabled = typeof options.onSidebarChange !== 'function';
      q('[data-ast-action="reset-widths"]').disabled = typeof options.onResetLayout !== 'function';
      syncSaveScope();
      q('#ast-demo-mode').checked = Boolean(options.getDemoMode?.());
      q('#ast-demo-mode').disabled = typeof options.onDemoModeChange !== 'function' || Boolean(options.isRuntimeConnected?.());
      q('[data-ast-storage]').textContent = sessionOnly ? 'Current session only' : 'Saved on this device';
      q('.ast-nav').setAttribute('aria-orientation', root.clientWidth <= 620 ? 'horizontal' : 'vertical');
    }

    function changePreference(key, value) {
      if (destroyed || preferences[key] === value) return;
      const allowed = key === 'textSize' ? Object.hasOwn(TEXT_SIZES, value)
        : key === 'reducedMotion' ? typeof value === 'boolean'
        : key === 'defaultSideView' ? SIDE_VIEWS.includes(value)
        : key === 'sendKey' ? ['enter', 'mod-enter'].includes(value) : false;
      if (!allowed) return;
      preferences[key] = value;
      applyPreferences();
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); sessionOnly = false; } catch (_) { sessionOnly = true; }
      syncControls();
      q('[data-ast-live]').textContent = 'Setting updated' + (sessionOnly ? ' for this session.' : '.');
      options.onChange?.(getState(), key);
      root.dispatchEvent(new CustomEvent('ac:settings-change', { bubbles: true, detail: { settings: getState(), key } }));
    }

    function syncSaveScope() {
      const mode = section === 'appearance' ? (sessionOnly ? 'session' : 'automatic') : (section === 'models' || section === 'execution' && !window.AthenaHosted) ? 'explicit' : 'host';
      q('.ast-footer').dataset.saveMode = mode;
      const messages = {
        models: window.AthenaHosted ? 'Worker assignments save when selected and apply to the next run.' : 'Model changes require Save settings. Connection checks are separate.',
        execution: window.AthenaHosted ? 'The host controls execution policy for this project.' : 'Role preferences require Save settings. Runtime controls apply to the current session.',
        tools: 'Package changes apply to new runs. Tool controls reflect the current runtime.',
        files: 'Files and history are stored only when the project host confirms the write.',
        appearance: sessionOnly ? 'UI changes apply to this session. Device storage is unavailable.' : 'UI changes save automatically on this device.',
        about: 'Connection status and diagnostics are reported by the attached host.'
      };
      q('[data-ast-save-status]').textContent = messages[section];
    }
    function selectSection(next, focus = false, notify = true) {
      next = ALIASES[next] || next;
      if (!SECTIONS.some(([id]) => id === next)) next = 'models';
      section = next;
      if (DEFAULT_RUNTIME[section]) {
        if (RUNTIME_CATEGORY[runtimeSection] !== section) runtimeSection = DEFAULT_RUNTIME[section];
        q('[data-ast-runtime-host="' + section + '"]').appendChild(runtimeSlot);
        if (notify) options.onRuntimeSection?.(runtimeSection);
      }
      for (const button of qa('[data-ast-section]')) {
        const active = button.dataset.astSection === section;
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
      }
      for (const panel of qa('.ast-panel')) panel.hidden = panel.id !== 'ast-panel-' + section;
      q('.ast-content').scrollTop = 0;
      syncSaveScope();
      if (focus) {
        const activeTab = q('#ast-tab-' + section);
        activeTab.focus({ preventScroll: true });
        activeTab.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
    }

    function canFocus(element) {
      if (!element?.isConnected || element.closest('[hidden]') || element.disabled) return false;
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.inert) return false;
        if (ancestor.matches?.('details:not([open])') && !ancestor.querySelector('summary')?.contains(element)) return false;
      }
      return true;
    }

    function resolveOpener() {
      if (canFocus(opener)) return opener;
      // Agent progress can replace a control while Settings is open.
      for (const attribute of ['id', 'data-aw-thinking-summary', 'data-ap-tool-summary', 'data-aw-summary', 'data-aw-action', 'data-awv-focus', 'data-awv-action', 'data-workspace-view', 'data-ams-action', 'data-akn-action']) {
        const value = opener?.getAttribute?.(attribute);
        if (value == null) continue;
        const replacement = Array.from(root.querySelectorAll('[' + attribute + ']')).find(element => element.getAttribute(attribute) === value && canFocus(element));
        if (replacement) return replacement;
      }
      return openerWasAgent ? root.querySelector('#aw-activity [data-aw-thinking-summary]') : null;
    }

    function open(nextSection = 'models') {
      if (destroyed) return;
      const wasOpen = opened;
      if (!wasOpen) {
        opener = document.activeElement;
        openerWasAgent = Boolean(opener?.closest?.('#aw-activity'));
      }
      opened = true;
      backdrop.hidden = false;
      root.dataset.settingsOpen = 'true';
      syncControls();
      selectSection(nextSection);
      if (!wasOpen) options.onOpen?.();
      const activeTab = q('#ast-tab-' + section);
      activeTab.focus({ preventScroll: true });
      activeTab.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }

    function close(restoreFocus = true) {
      if (!opened) return;
      opened = false;
      backdrop.hidden = true;
      root.dataset.settingsOpen = 'false';
      options.onClose?.();
      if (restoreFocus) {
        const candidates = [resolveOpener(), root.querySelector('#ac-sidebar-collapse'), root.querySelector('#ac-left-toggle'), root.querySelector('#ac-panel-toggle'), root.querySelector('#ac-prompt-input')];
        candidates.find(canFocus)?.focus({ preventScroll: true });
      }
    }

    listen(backdrop, 'click', event => {
      if (event.target === backdrop) { close(); return; }
      const button = event.target.closest('button');
      if (!button || !backdrop.contains(button) || button.disabled) return;
      if (button.dataset.astSection) selectSection(button.dataset.astSection);
      if (button.dataset.astSize) changePreference('textSize', button.dataset.astSize);
      if (button.dataset.astAction === 'close') close();
      if (button.dataset.astAction === 'reset-widths' && options.onResetLayout) {
        options.onResetLayout();
        q('[data-ast-live]').textContent = 'Panel widths reset to their defaults.';
        options.toast?.('Panel widths reset.');
      }
    });
    listen(backdrop, 'change', event => {
      const input = event.target;
      if (input.dataset.astSetting) changePreference(input.dataset.astSetting, input.type === 'checkbox' ? input.checked : input.value);
      if (input.id === 'ast-demo-mode' && options.onDemoModeChange) { options.onDemoModeChange(input.checked); syncControls(); }
      if (input.id === 'ast-project-sidebar' && options.onSidebarChange) {
        options.onSidebarChange(input.checked);
        syncControls();
        input.focus({ preventScroll: true });
        q('[data-ast-live]').textContent = input.checked ? 'Project sidebar shown.' : 'Project sidebar hidden.';
      }
    });
    listen(backdrop, 'keydown', event => {
      if (!opened) return;
      // Keep application shortcuts and underlying drawer traps outside the sheet.
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key === 'Tab') {
        const items = qa('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]').filter(element => !element.closest('[hidden]') && element.getAttribute('tabindex') !== '-1');
        const first = items[0], last = items[items.length - 1];
        if (!first) { event.preventDefault(); sheet.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        return;
      }
      const tab = event.target.closest('[data-ast-section]');
      if (tab && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const index = SECTIONS.findIndex(([id]) => id === section);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? SECTIONS.length - 1
          : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + SECTIONS.length) % SECTIONS.length;
        selectSection(SECTIONS[next][0], true);
        return;
      }
      const sizeButton = event.target.closest('[data-ast-size]');
      if (sizeButton && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const sizes = Object.keys(TEXT_SIZES);
        const index = sizes.indexOf(preferences.textSize);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? sizes.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + sizes.length) % sizes.length;
        changePreference('textSize', sizes[next]);
        q('[data-ast-size="' + sizes[next] + '"]').focus({ preventScroll: true });
      }
    });
    listen(document, 'focusin', event => {
      if (opened && !backdrop.inert && !backdrop.contains(event.target)) q('#ast-tab-' + section).focus({ preventScroll: true });
    });
    listen(window, 'resize', () => { if (opened) q('.ast-nav').setAttribute('aria-orientation', root.clientWidth <= 620 ? 'horizontal' : 'vertical'); });

    const api = {
      open, close, getState, isOpen: () => opened,
      routeRuntime(next) { runtimeSection = Object.hasOwn(RUNTIME_CATEGORY, next) ? next : 'session'; selectSection(RUNTIME_CATEGORY[runtimeSection], false, false); },
      refresh: syncControls,
      getSection: () => section,
      destroy() {
        if (destroyed) return;
        close(false);
        destroyed = true;
        controller.abort();
        backdrop.remove();
        for (const [name, value] of Object.entries(previousVariables)) {
          if (value) root.style.setProperty(name, value); else root.style.removeProperty(name);
        }
        for (const [name, value] of Object.entries(previousAttributes)) {
          if (value === null) root.removeAttribute(name); else root.setAttribute(name, value);
        }
        if (instances.get(root) === api) instances.delete(root);
      }
    };
    instances.set(root, api);
    applyPreferences();
    syncControls();
    if (options.icons) options.icons();
    else window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
    return api;
  }

  window.AthenaSettings = Object.freeze({ mount });
})();
