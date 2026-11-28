/* Project-owned declarative packages and selected skills. All mutations belong
 * to the host; this panel never installs executable code or runs a server. */
(() => {
  'use strict';
  const rows = value => Array.isArray(value) ? value : [];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const MAX_PACKAGE_BYTES = 512 * 1024;
  const icon = name => '<i data-lucide="' + name + '" aria-hidden="true"></i>';
  const when = value => Number.isFinite(Number(value)) ? new Date(Number(value)).toLocaleString() : 'Time not reported';

  function mount(host, options = {}) {
    if (!host) throw new TypeError('AthenaExtensions.mount requires a host element.');
    const controller = new AbortController();
    let service = null, snapshot = null, projectId = null, sessionId = null;
    let destroyed = false, busy = false, request = 0, attachment = 0, refreshTimer = null, workspaceRevision = null;
    let failure = '', status = '';
    const details = new Map();
    const q = selector => host.querySelector(selector);
    const workspace = () => options.getWorkspace?.() || {};
    const supported = () => Boolean(service?.getExtensions && projectId);
    const safe = value => window.AthenaActivityLabels ? window.AthenaActivityLabels.text(value, '', [projectId, sessionId, ...rows(workspace().tasks).map(item => item.id), ...rows(workspace().attempts).map(item => item.id)]) : String(value ?? '');
    const diagnostics = (fields, key) => '<details class="aex-details" data-aex-detail="' + esc(key) + '"><summary>Technical details</summary><dl>' + fields.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([label, value]) => '<div><dt>' + esc(label) + '</dt><dd>' + esc(typeof value === 'object' ? JSON.stringify(value, null, 2) : value) + '</dd></div>').join('') + '</dl></details>';
    host.classList.add('aex-host');
    host.innerHTML = '<div class="aex-heading"><div><h3>Project tools &amp; skills</h3><p data-aex-project></p></div><button type="button" class="ast-button cursor-interaction" data-aex-action="refresh">' + icon('refresh-cw') + 'Refresh</button></div>'
      + '<p class="aex-note" data-aex-availability></p><p class="aex-error" role="alert" data-aex-error hidden></p><p class="aex-note" role="status" data-aex-status hidden></p>'
      + '<div data-aex-content hidden><button type="button" class="ast-button cursor-interaction" data-aex-action="install-github">Install GitHub plugin</button><details class="aex-import" data-aex-detail="import"><summary class="cursor-interaction">Import or update a plugin</summary>'
      + '<p class="aex-note">Import a declarative JSON package containing skills and MCP server settings. New and updated packages start disabled. No package scripts are executed.</p>'
      + '<label class="aex-field">Package file<input type="file" accept=".json,application/json" data-aex-file></label>'
      + '<label class="aex-field">Package JSON<textarea rows="7" spellcheck="false" autocomplete="off" data-aex-manifest placeholder="Paste the plugin manifest"></textarea></label>'
      + '<button type="button" class="ast-button cursor-interaction" data-aex-action="install">Import package</button></details>'
      + '<section aria-label="Installed plugins"><div class="aex-section-heading"><h3>Installed plugins</h3><span data-aex-plugin-count></span></div><p class="aex-note">Enabling, disabling or removing a package affects new research runs. Ongoing work keeps its original package versions and permissions.</p><div data-aex-plugins></div></section>'
      + '<section aria-label="Available skills"><div class="aex-section-heading"><h3>Skills</h3><span data-aex-skill-count></span></div><p class="aex-note">Skills provide procedures. File, tool and network permissions remain controlled by the host.</p><div data-aex-skills></div></section>'
      + '<section aria-label="Skill loading history"><div class="aex-section-heading"><h3>Skill use</h3><span data-aex-use-count></span></div><div data-aex-uses></div></section></div>';

    function replace(selector, html) {
      const node = q(selector);
      if (!node || node._aexHTML === html) return;
      for (const detail of node.querySelectorAll('[data-aex-detail]')) details.set(detail.dataset.aexDetail, detail.open);
      const focusKey = node.contains(document.activeElement) ? document.activeElement?.dataset.aexFocus : null;
      node.innerHTML = html; node._aexHTML = html;
      for (const detail of node.querySelectorAll('[data-aex-detail]')) detail.open = details.get(detail.dataset.aexDetail) === true;
      if (focusKey) [...node.querySelectorAll('[data-aex-focus]')].find(element => element.dataset.aexFocus === focusKey && !element.disabled)?.focus({ preventScroll: true });
    }

    function serverHTML(plugin, server) {
      const checked = server.status === 'verified';
      const github = plugin.id === 'athena-github';
      const credential = server.auth === 'bearer' ? '<label class="aex-field">' + (github ? 'GitHub personal access token' : 'Bearer token') + ' <span class="aex-note">(leave blank to use the saved connection)</span><input type="password" autocomplete="off" maxlength="8192" data-aex-token data-plugin="' + esc(plugin.id) + '" data-server="' + esc(server.id) + '" aria-label="Bearer token for ' + esc(server.name) + '"></label>' : '';
      const toolNames = rows(server.verification?.tools).map(tool => tool.name);
      return '<div class="aex-server"><div class="aex-card-heading"><strong>' + esc(server.name) + '</strong><span class="aex-badge" data-state="' + (checked ? 'checked' : 'idle') + '">' + (checked ? 'Connection checked' : server.status === 'failed' ? 'Connection failed' : 'Not checked') + '</span></div>'
        + '<p class="aex-endpoint">' + esc(server.url) + '</p><p class="aex-note">Calls are restricted to the tools listed below. Local project files are not transferred automatically.</p>'
        + (rows(server.allowedTools).length ? '<p class="aex-note">Approved tools: ' + rows(server.allowedTools).map(esc).join(', ') + '</p>' : '')
        + (server.lastError ? '<p class="aex-error">' + esc(server.lastError) + '</p>' : '')
        + (server.auth === 'bearer' ? '<p class="aex-note">' + (server.credentialConfigured ? 'A dedicated connection token is saved by the host.' : 'This server requires a dedicated connection token.') + '</p>' : '') + (github ? '<p class="aex-note">Use a fine-grained token with read access to contents and metadata for the repositories you select.</p>' : '') + credential
        + '<button type="button" class="ast-button cursor-interaction" data-aex-action="check" data-plugin="' + esc(plugin.id) + '" data-server="' + esc(server.id) + '" data-aex-focus="check-' + esc(plugin.id + '-' + server.id) + '">' + icon('plug-zap') + (github && !plugin.enabled ? 'Connect and enable GitHub' : checked ? 'Check connection again' : 'Check connection') + '</button>'
        + (checked ? '<p class="aex-note">Discovery completed ' + esc(when(server.verification?.checkedAt)) + '. A connection check does not execute a research calculation.</p>' : '')
        + diagnostics([['Transport', server.transport], ['Server ID', server.id], ['Server identity', server.verification?.serverInfo], ['MCP protocol', server.verification?.protocolVersion], ['Schema digest', server.verification?.digest], ['Discovered tools', toolNames]], 'server-' + plugin.id + '-' + server.id) + '</div>';
    }

    function pluginHTML(plugin) {
      const ready = rows(plugin.servers).every(server => server.status === 'verified');
      const disabled = !plugin.enabled && !ready;
      return '<article class="aex-card" data-aex-plugin="' + esc(plugin.id) + '"><div class="aex-card-heading"><div><h4>' + esc(plugin.name) + '</h4><span class="aex-note">Version ' + esc(plugin.version) + (plugin.builtin ? ' · Built in' : '') + '</span></div><span class="aex-badge" data-state="' + (plugin.enabled ? 'enabled' : 'idle') + '">' + (plugin.enabled ? 'Enabled' : 'Installed · Disabled') + '</span></div>'
        + '<p>' + esc(plugin.description) + '</p>' + (rows(plugin.servers).length ? '<p class="aex-note">Enabling permits calls to the approved endpoints below. Each call sends its tool arguments from this device to that endpoint.</p>' : '') + '<div class="aex-actions"><button type="button" class="ast-button cursor-interaction" data-aex-action="toggle-plugin" data-plugin="' + esc(plugin.id) + '" data-aex-focus="plugin-' + esc(plugin.id) + '"' + (disabled ? ' disabled title="Check each MCP connection before enabling this package"' : '') + '>' + (plugin.enabled ? 'Disable' : 'Enable') + '</button>'
        + (!plugin.builtin || plugin.id === 'athena-github' ? '<button type="button" class="aex-text-button cursor-interaction" data-aex-action="remove" data-plugin="' + esc(plugin.id) + '">Remove</button>' : '') + '</div>'
        + (disabled ? '<p class="aex-note">Check each MCP connection before enabling this package.</p>' : '')
        + rows(plugin.servers).map(server => serverHTML(plugin, server)).join('')
        + diagnostics([['Package ID', plugin.id], ['Revision', plugin.revision], ['Installed', when(plugin.installedAt)], ['Updated', when(plugin.updatedAt)], ['Skills', rows(plugin.skills).map(skill => skill.name)]], 'plugin-' + plugin.id) + '</article>';
    }

    function skillHTML(skill) {
      const configured = skill.configuredEnabled ?? skill.enabled;
      const plugin = rows(snapshot?.plugins).find(item => item.id === skill.pluginId);
      return '<article class="aex-card aex-skill" data-aex-skill="' + esc(skill.id) + '"><div class="aex-card-heading"><div><h4>' + esc(skill.name) + '</h4><span class="aex-note">Version ' + esc(skill.version) + ' · ' + (skill.automaticEligible ? 'Guided or explicit selection' : 'Explicit selection') + '</span></div>'
        + '<label class="aex-toggle"><input type="checkbox" data-aex-skill-enabled="' + esc(skill.id) + '" data-aex-focus="skill-' + esc(skill.id) + '"' + (configured ? ' checked' : '') + '><span>Use</span></label></div><p>' + esc(skill.description) + '</p>'
        + '<p class="aex-note">' + (skill.enabled ? 'Available to ' + rows(skill.roles).map(role => role === 'parent' ? 'coordinator' : 'worker').join(' and ') : plugin?.enabled === false ? 'The package is disabled for this project.' : 'Disabled for this project.') + '</p>'
        + (rows(skill.requiredCapabilities).length ? '<p class="aex-note">Requires: ' + rows(skill.requiredCapabilities).map(esc).join(', ') + '</p>' : '')
        + '<button type="button" class="aex-text-button cursor-interaction" data-aex-action="use-skill" data-skill="' + esc(skill.id) + '"' + (!skill.enabled || !options.onUseSkill ? ' disabled' : '') + '>Add to request</button>'
        + diagnostics([['Skill ID', skill.id], ['Package', plugin?.name || skill.pluginId], ['SHA-256', skill.sha256], ['Package revision', skill.pluginRevision]], 'skill-' + skill.id) + '</article>';
    }

    function useHTML(use) {
      const skill = rows(snapshot?.skills).find(item => item.id === use.skillId);
      const task = rows(workspace().tasks).find(item => item.id === use.taskId);
      const name = skill?.name || 'Saved skill version';
      const taskName = window.AthenaActivityLabels?.task(task, rows(workspace().tasks), use.role === 'parent' ? 'Coordinator' : 'Worker') || (use.role === 'parent' ? 'Coordinator' : 'Worker');
      return '<article class="aex-use"><div class="aex-card-heading"><strong>' + esc(name) + '</strong><span class="aex-badge">' + (use.status === 'limited' ? 'Limited capabilities' : 'Loaded') + '</span></div><p class="aex-note">' + esc(taskName) + ' · Version ' + esc(use.skillVersion) + ' · ' + esc(when(use.loadedAt)) + '</p><p>' + esc(safe(use.reason)) + '</p>'
        + (rows(use.missingCapabilities).length ? '<p class="aex-note">Unavailable: ' + rows(use.missingCapabilities).map(esc).join(', ') + '. These operations were not enabled by loading the skill.</p>' : '')
        + diagnostics([['Skill ID', use.skillId], ['SHA-256', use.sha256], ['Selection', use.mode], ['Effective capabilities', use.effectiveCapabilities], ['Project ID', use.projectId], ['Conversation ID', use.sessionId], ['Run ID', use.runId], ['Task ID', use.taskId], ['Attempt ID', use.attemptId], ['Agent session ID', use.agentSessionId], ['Package revision', use.pluginRevision]], 'use-' + use.id) + '</article>';
    }

    function render() {
      if (destroyed) return;
      options.onSkillsChange?.(sessionId && supported() ? snapshot?.skills || [] : []);
      const project = rows(workspace().projects).find(item => item.id === projectId);
      q('[data-aex-project]').textContent = project?.name || (projectId ? 'Current project' : 'Select a project');
      q('[data-aex-availability]').textContent = !service ? 'Connect an Athena host with extension support to manage real packages and skills.' : !projectId ? 'Open a project conversation to manage its tools and skills.' : '';
      q('[data-aex-availability]').hidden = Boolean(service && projectId);
      q('[data-aex-error]').textContent = failure; q('[data-aex-error]').hidden = !failure;
      q('[data-aex-status]').textContent = status; q('[data-aex-status]').hidden = !status;
      q('[data-aex-content]').hidden = !snapshot || !supported();
      if (snapshot) {
        q('[data-aex-plugin-count]').textContent = rows(snapshot.plugins).length + ' installed';
        q('[data-aex-skill-count]').textContent = rows(snapshot.skills).filter(skill => skill.enabled).length + ' available';
        const uses = rows(snapshot.skillUses).filter(use => !sessionId || use.sessionId === sessionId);
        q('[data-aex-use-count]').textContent = uses.length + ' in this conversation';
        replace('[data-aex-plugins]', rows(snapshot.plugins).map(pluginHTML).join('') || '<p class="aex-empty">No plugins are installed for this project.</p>');
        replace('[data-aex-skills]', rows(snapshot.skills).map(skillHTML).join('') || '<p class="aex-empty">No enabled package provides skills.</p>');
        replace('[data-aex-uses]', uses.slice().reverse().map(useHTML).join('') || '<p class="aex-empty">No skill body has been loaded in this conversation yet.</p>');
      }
      for (const button of host.querySelectorAll('button')) {
        if (button.dataset.aexAction === 'refresh') button.disabled = !supported() || busy;
        else if (button.dataset.aexAction === 'install-github') {
          button.hidden = !service?.installGitHubPlugin || rows(snapshot?.plugins).some(plugin => plugin.id === 'athena-github');
          button.disabled = !supported() || !snapshot || busy;
        }
        else if (button.dataset.aexAction === 'install') button.disabled = !supported() || !snapshot || busy;
        else if (busy || !supported()) button.disabled = true;
      }
      for (const input of host.querySelectorAll('input,textarea')) input.disabled = busy || !supported();
      options.icons?.();
    }

    async function refresh() {
      clearTimeout(refreshTimer); refreshTimer = null;
      if (destroyed || !supported() || busy) return;
      const token = ++request, owner = attachment, scope = projectId;
      try {
        const next = await service.getExtensions(scope);
        if (destroyed || token !== request || owner !== attachment || scope !== projectId) return;
        if (!next || next.schemaVersion !== 1 || next.projectId !== scope || !Number.isSafeInteger(next.revision) || !Array.isArray(next.plugins) || !Array.isArray(next.skills) || !Array.isArray(next.skillUses)) throw new Error('The host returned an invalid extension snapshot.');
        if (snapshot && next.revision < snapshot.revision) return;
        snapshot = next; failure = ''; render();
      } catch (error) {
        if (destroyed || token !== request || owner !== attachment || scope !== projectId) return;
        failure = String(error?.message || error); render();
      }
    }

    async function mutate(action, message) {
      if (destroyed || busy || !supported() || !snapshot) return;
      const owner = attachment, scope = projectId, revision = snapshot.revision;
      ++request; busy = true; failure = ''; status = 'Saving…'; render();
      try {
        await action(scope, revision);
        if (destroyed || owner !== attachment || scope !== projectId) return;
        status = message;
      } catch (error) {
        if (destroyed || owner !== attachment || scope !== projectId) return;
        failure = String(error?.message || error); status = '';
      } finally {
        if (!destroyed && owner === attachment && scope === projectId) {
          busy = false;
          // Rebuild controls from the authoritative snapshot, then refresh it.
          for (const node of host.querySelectorAll('[data-aex-plugins],[data-aex-skills]')) delete node._aexHTML;
          render();
          const savedFailure = failure;
          await refresh();
          if (savedFailure && owner === attachment && scope === projectId) { failure = savedFailure; render(); }
        }
      }
    }

    function setWorkspace() {
      if (destroyed) return;
      const next = workspace();
      if (next.projectId !== projectId || next.sessionId !== sessionId) {
        ++attachment; ++request; busy = false; snapshot = null; failure = ''; status = ''; details.clear();
        projectId = next.projectId || null; sessionId = next.sessionId || null;
        q('[data-aex-manifest]').value = ''; q('[data-aex-file]').value = '';
        for (const input of host.querySelectorAll('[data-aex-token]')) input.value = '';
        workspaceRevision = next.revision; render(); void refresh(); return;
      }
      if (workspaceRevision !== next.revision) {
        workspaceRevision = next.revision;
        clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150);
      }
    }

    host.addEventListener('change', event => {
      const input = event.target;
      if (input.matches('[data-aex-skill-enabled]')) {
        const id = input.dataset.aexSkillEnabled, value = input.checked;
        void mutate((scope, revision) => service.setSkillEnabled(scope, id, value, revision), 'Skill preference saved. New runs use the updated selection.');
      }
      if (input.matches('[data-aex-file]')) {
        const file = input.files?.[0]; if (!file) return;
        const owner = attachment;
        if (file.size > MAX_PACKAGE_BYTES) { failure = 'The package exceeds the 512 KiB import limit.'; input.value = ''; render(); return; }
        void file.text().then(value => { if (!destroyed && owner === attachment) { q('[data-aex-manifest]').value = value; failure = ''; render(); } }, () => { if (!destroyed && owner === attachment) { failure = 'Could not read the selected package.'; render(); } });
      }
    }, { signal: controller.signal });

    host.addEventListener('click', event => {
      const button = event.target.closest('[data-aex-action]');
      if (!button || !host.contains(button) || button.disabled) return;
      const action = button.dataset.aexAction;
      if (action === 'refresh') { void refresh(); return; }
      if (action === 'install-github') {
        void mutate((scope, revision) => service.installGitHubPlugin(scope, revision), 'GitHub installed. Enter a personal access token to connect this project.');
        return;
      }
      if (action === 'install') {
        const value = q('[data-aex-manifest]').value;
        let manifest;
        try {
          if (new TextEncoder().encode(value).length > MAX_PACKAGE_BYTES) throw new Error('The package exceeds the 512 KiB import limit.');
          manifest = JSON.parse(value);
        } catch (error) { failure = error instanceof SyntaxError ? 'Enter a valid JSON plugin package.' : String(error.message || error); render(); return; }
        void mutate((scope, revision) => service.installPlugin(scope, manifest, revision), 'Package imported and disabled. Review its connections and skills before enabling it.'); return;
      }
      if (action === 'use-skill') {
        const skill = rows(snapshot?.skills).find(item => item.id === button.dataset.skill);
        if (skill?.enabled) options.onUseSkill?.(skill); return;
      }
      const plugin = rows(snapshot?.plugins).find(item => item.id === button.dataset.plugin);
      if (!plugin) return;
      if (action === 'toggle-plugin') void mutate((scope, revision) => service.setPluginEnabled(scope, plugin.id, !plugin.enabled, revision), plugin.enabled ? 'Package disabled for new runs.' : 'Package enabled for new runs.');
      if (action === 'remove' && (!plugin.builtin || plugin.id === 'athena-github')) void mutate((scope, revision) => service.removePlugin(scope, plugin.id, revision), 'Package removed from future selection. Existing research keeps its saved versions.');
      if (action === 'check') {
        const server = rows(plugin.servers).find(item => item.id === button.dataset.server); if (!server) return;
        const field = [...host.querySelectorAll('[data-aex-token]')].find(item => item.dataset.plugin === plugin.id && item.dataset.server === server.id);
        const token = field?.value || ''; if (field) field.value = '';
        if (plugin.id === 'athena-github' && !plugin.enabled) {
          void mutate(async (scope, revision) => {
            const checked = await service.checkMcpServer(scope, plugin.id, server.id, revision, token ? {token} : {});
            await service.setPluginEnabled(scope, plugin.id, true, checked.revision);
          }, 'GitHub connected. Repository tools are available to workers in new runs.');
          return;
        }
        void mutate((scope, revision) => service.checkMcpServer(scope, plugin.id, server.id, revision, token ? { token } : {}), 'MCP connection and approved tool schemas checked.');
      }
    }, { signal: controller.signal });

    render();
    return {
      setService(value) { service = value || null; ++attachment; ++request; busy = false; snapshot = null; failure = ''; status = ''; for (const input of host.querySelectorAll('[data-aex-token]')) input.value = ''; render(); void refresh(); },
      setWorkspace,
      refresh,
      getState: () => ({ connected: Boolean(service), projectId, sessionId, snapshot, busy, error: failure }),
      destroy() { if (destroyed) return; destroyed = true; ++attachment; ++request; clearTimeout(refreshTimer); controller.abort(); for (const input of host.querySelectorAll('[data-aex-token]')) input.value = ''; host.replaceChildren(); host.classList.remove('aex-host'); }
    };
  }

  window.AthenaExtensions = Object.freeze({ mount });
})();
