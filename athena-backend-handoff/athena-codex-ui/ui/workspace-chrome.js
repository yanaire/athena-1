/* Inline agent, tool, and process activity for runtime and preview snapshots. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const icon = name => '<i data-lucide="' + name + '" aria-hidden="true"></i>';
  const LABELS = { ready: 'Ready', queued: 'Queued', running: 'Working', paused: 'Paused', blocked: 'Waiting', succeeded: 'Complete', failed: 'Needs attention', cancelled: 'Stopped' };

  function mount(root, options) {
    const host = root.querySelector('#aw-activity');
    const store = options.store;
    const controller = new AbortController();
    const { signal } = controller;
    const listen = (element, type, callback, settings = {}) => element.addEventListener(type, callback, { ...settings, signal });
    const attemptSections = new Map();
    const expanded = new Set();
    const expandedTools = new Set();
    const expandedProcesses = new Set();
    const expandedDiagnostics = new Set();
    const requestedTools = new Set();
    const outputModes = new Map();
    const copyFallbacks = new Map();
    const downloadTimers = new Map();
    let snapshot = store.getState();
    let openedApproval = null;
    let opener = null;
    let openerKey = null;
    let demoOptionsOpen = false;
    let thinkingOpen = true;
    let currentRunKey = '';
    let destroyed = false;
    let renderSignature = '';
    let lastRunStatus = '';
    const all = selector => [...new Set([...host.querySelectorAll(selector), ...[...attemptSections.values()].flatMap(node => [...node.querySelectorAll(selector)])])];
    const contains = node => host.contains(node) || [...attemptSections.values()].some(section => section.contains(node));
    const q = selector => all(selector)[0] || null;
    const refreshIcons = () => options.icons?.();
    const labels = window.AthenaActivityLabels;
    const identifiers = state => [state.sessionId, state.run?.id, ...['tasks', 'agents', 'tools', 'attempts', 'processes'].flatMap(key => (state[key] || []).flatMap(item => [item.id, item.taskId, item.parentTaskId, item.agentSessionId, item.attemptId, item.processId, item.toolId, item.toolCallId])), ...Object.values(state.retryOperations || {}).map(item => item.requestId)].filter(Boolean);
    const displayText = (value, fallback = '', state = snapshot) => labels.text(value, fallback, identifiers(state));
    function rememberDiagnostics() {
      for (const element of all('[data-aw-diagnostics]')) {
        if (element.open) expandedDiagnostics.add(element.dataset.awDiagnostics);
        else expandedDiagnostics.delete(element.dataset.awDiagnostics);
      }
    }
    function restoreDiagnostics() {
      for (const element of all('[data-aw-diagnostics]')) element.open = expandedDiagnostics.has(element.dataset.awDiagnostics);
    }
    const backdrop = document.createElement('div');
    backdrop.id = 'aw-approval-backdrop';
    backdrop.className = 'aw-approval-backdrop';
    backdrop.hidden = true;
    backdrop.innerHTML = '<section class="aw-approval-sheet" role="dialog" aria-modal="true" aria-labelledby="aw-approval-title" aria-describedby="aw-approval-description"><header><span class="aw-approval-glyph">' + icon('shield-check') + '</span><div><small>Permission request</small><h2 id="aw-approval-title"></h2></div><button type="button" class="ac-icon-button cursor-interaction" data-aw-dialog="close" aria-label="Close request">' + icon('x') + '</button></header><div class="aw-approval-body"><p id="aw-approval-description"></p><dl><div><dt>Working directory</dt><dd id="aw-approval-cwd"></dd></div><div><dt>Scope</dt><dd id="aw-approval-scope"></dd></div><div><dt>Expected change</dt><dd id="aw-approval-impact"></dd></div></dl><label>Command</label><pre id="aw-approval-command"></pre><p class="aw-local-note">Local UI demo · this decision advances the example. No command is executed on your computer.</p></div><footer><button type="button" class="aw-button cursor-interaction" data-aw-dialog="reject">Reject</button><button type="button" class="aw-button aw-primary cursor-interaction" data-aw-dialog="allow">Allow once</button></footer></section>';
    root.appendChild(backdrop);

    function focusable(element) {
      if (!element?.isConnected || element.disabled || element.closest('[hidden]')) return false;
      for (let parent = element; parent; parent = parent.parentElement) if (parent.inert) return false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.matches('details:not([open])') && !parent.querySelector('summary')?.contains(element)) return false;
      }
      return true;
    }
    function captureKey(element) {
      if (!element) return null;
      if (element.matches?.('[data-aw-diagnostics] > summary')) return { attribute: 'data-aw-diagnostics', value: element.parentElement.dataset.awDiagnostics, summary: true };
      if (element.dataset?.awToolAction) return { attribute: 'data-aw-tool-action', value: element.dataset.awToolAction, tool: element.dataset.awTool };
      if (element.dataset?.awOutputMode) return { attribute: 'data-aw-output-mode', value: element.dataset.awOutputMode, tool: element.dataset.awTool };
      for (const attribute of ['id', 'data-aw-copy-fallback', 'data-aw-agent-reveal', 'data-aw-approval-open', 'data-aw-attempt-summary', 'data-aw-tool-summary', 'data-aw-summary', 'data-aw-process-summary', 'data-aw-thinking-summary', 'data-aw-action', 'data-aw-retry', 'data-aw-task-details', 'data-awv-focus', 'data-awv-action']) {
        const value = element.getAttribute?.(attribute);
        if (value != null) return { attribute, value };
      }
      return null;
    }
    function resolveKey(key) {
      if (!key) return null;
      return Array.from(root.querySelectorAll('[' + key.attribute + ']'))
        .filter(element => element.getAttribute(key.attribute) === key.value && (!key.tool || element.dataset.awTool === key.tool))
        .map(element => key.summary ? element.querySelector('summary') : element)
        .find(focusable) || null;
    }
    function closeApproval(restore = true) {
      if (!openedApproval) return;
      openedApproval = null;
      backdrop.hidden = true;
      options.onModalChange?.(false);
      if (restore) {
        const candidates = [opener, resolveKey(openerKey), q('[data-aw-action="primary"]'), root.querySelector('[data-awv-task-select]'), root.querySelector('[data-awv-task][aria-pressed="true"]'), q('[data-aw-thinking-summary]'), root.querySelector('#ac-panel-toggle')];
        candidates.find(focusable)?.focus({ preventScroll: true });
      }
    }
    function openApproval(id) {
      const request = snapshot.approvals.find(item => item.id === id && item.status === 'pending');
      if (!request || destroyed) return false;
      if (!openedApproval) { opener = document.activeElement; openerKey = captureKey(opener); }
      openedApproval = request.id;
      backdrop.querySelector('#aw-approval-title').textContent = request.title;
      backdrop.querySelector('#aw-approval-description').textContent = request.description;
      backdrop.querySelector('#aw-approval-cwd').textContent = request.cwd;
      backdrop.querySelector('#aw-approval-scope').textContent = request.scope;
      backdrop.querySelector('#aw-approval-impact').textContent = request.impact;
      backdrop.querySelector('#aw-approval-command').textContent = request.command;
      backdrop.querySelector('.aw-local-note').textContent=snapshot.mode==='runtime'?'This decision is sent to the connected TaskManager for this request only.':'Local UI demo · this decision advances the example. No command is executed on your computer.';
      for(const button of backdrop.querySelectorAll('[data-aw-dialog="allow"],[data-aw-dialog="reject"]'))button.disabled=snapshot.mode==='runtime'&&!snapshot.capabilities?.decideApproval;
      backdrop.hidden = false;
      options.onModalChange?.(true);
      backdrop.querySelector('[data-aw-dialog="close"]').focus({ preventScroll: true });
      return true;
    }

    function controlsHTML(state) {
      const status = state.run.status;
      const active = ['running', 'blocked'].includes(status);
      const label = status === 'ready' ? 'Run demo' : status === 'paused' ? 'Resume demo' : active ? 'Demo running' : 'Run again';
      const glyph = active ? 'hourglass' : ['failed', 'cancelled', 'succeeded'].includes(status) ? 'rotate-ccw' : 'play';
      return '<div class="aw-run-controls"><button type="button" class="aw-text-button cursor-interaction" data-aw-action="primary"' + (active ? ' disabled' : '') + '>' + icon(glyph) + label + '</button>'
        + '<button type="button" class="aw-text-button cursor-interaction" data-aw-action="preview-reply">' + icon('message-square-text') + 'Preview response</button>'
        + '<button type="button" class="aw-button aw-quiet cursor-interaction" data-aw-action="workflow">' + icon('workflow') + 'Workflow</button>'
        + '</div>';
    }

    function logText(tool, plain = false) {
      return tool.logs.map(entry => (plain ? '' : '[' + new Date(entry.at).toISOString().slice(11, 19) + '] ') + entry.text).join('\n');
    }

    function toolDetailsHTML(tool, task, state) {
      const results = task.id ? state.artifacts.filter(item => item.toolId ? item.toolId === tool.id : item.taskId === task.id && (!item.attemptId || item.attemptId === tool.attemptId)) : [];
      const approval = task.id && state.approvals.find(item => item.taskId === task.id && item.status === 'pending');
      const mode = outputModes.get(tool.id) || 'log';
      const fallback = copyFallbacks.get(tool.id);
      const progress = state.mode === 'runtime' ? Number.isFinite(task.progress) && Number.isFinite(task.total) && task.total > 0 ? task.progress + ' / ' + task.total + ' reported steps' : 'Progress not reported' : task.progress + ' / ' + task.total + ' demo steps';
      const action = (name, label, glyph) => '<button type="button" class="aw-text-button cursor-interaction" data-aw-tool-action="' + name + '" data-aw-tool="' + esc(tool.id) + '">' + icon(glyph) + label + '</button>';
      const diagnostics = state.mode === 'runtime' ? labels.diagnostics([['Task ID', tool.taskId], ['Tool ID', tool.id], ['Agent session ID', tool.agentSessionId], ['Attempt ID', tool.attemptId]], 'tool:' + tool.id) : '';
      return '<div class="aw-agent-detail" data-aw-tool-details="' + esc(tool.id) + '"><p class="aw-tool-task">' + esc(labels.task(task, state.tasks, 'Session tool')) + ' <span aria-hidden="true">·</span> ' + esc(progress) + '</p><dl class="aw-tool-context"><div><dt>Directory</dt><dd>' + esc(tool.cwd) + '</dd></div><div><dt>Exit code</dt><dd data-aw-exit="' + esc(tool.id) + '">' + (tool.exitCode == null ? '—' : esc(tool.exitCode)) + '</dd></div></dl><code class="aw-tool-command" data-aw-command="' + esc(tool.id) + '">' + esc(tool.command) + '</code><div class="aw-tool-tabs" aria-label="Tool output format"><button type="button" class="aw-text-button cursor-interaction" data-aw-output-mode="log" data-aw-tool="' + esc(tool.id) + '" aria-pressed="' + (mode === 'log') + '">Log</button><button type="button" class="aw-text-button cursor-interaction" data-aw-output-mode="output" data-aw-tool="' + esc(tool.id) + '" aria-pressed="' + (mode === 'output') + '">Output</button></div><pre class="aw-tool-log" data-aw-log="' + esc(tool.id) + '" aria-label="' + esc(displayText(tool.name, 'Tool', state)) + ' ' + (mode === 'output' ? 'output' : 'log') + '">' + esc(logText(tool, mode === 'output') || (state.mode === 'runtime' ? 'No output has been reported.' : 'No output yet. This tool has not started.')) + '</pre><div class="aw-agent-links">' + action('copy-command', 'Copy command', 'copy') + action('copy-log', 'Copy log', 'copy') + action('download-log', 'Download log', 'download') + (state.mode !== 'runtime' && task.status === 'failed' ? '<button type="button" class="aw-text-button cursor-interaction" data-aw-retry="' + esc(task.id) + '">' + icon('rotate-ccw') + 'Retry step</button>' : '') + (approval ? '<button type="button" class="aw-text-button cursor-interaction" data-aw-approval-open="' + esc(approval.id) + '">' + icon('shield-check') + 'Review request</button>' : '') + results.map(result => '<button type="button" class="aw-text-button cursor-interaction" data-aw-artifact="' + esc(result.id) + '" data-aw-artifact-version="' + esc(result.version || '') + '">' + icon('file-check') + esc(displayText(result.title, 'Result file', state)) + '</button>').join('') + resultFilesHTML(results) + '<button type="button" class="aw-text-button cursor-interaction" data-aw-timeline="' + esc(task.id) + '">Timeline' + icon('arrow-up-right') + '</button></div>' + (fallback != null ? '<label class="aw-copy-label">Select and copy manually<textarea class="aw-copy-fallback" data-aw-copy-fallback="' + esc(tool.id) + '" readonly aria-label="Copy tool text manually">' + esc(fallback) + '</textarea></label>' : '') + diagnostics + '</div>';
    }

    function toolEventHTML(tool, state, agent = null) {
      const task = state.tasks.find(item => item.id === tool.taskId) || (state.mode === 'runtime' ? { id: null, title: 'Session tool', status: tool.status } : null);
      if (!task) return '';
      const open = expandedTools.has(tool.id);
      const identity = agent ? 'data-aw-agent="' + esc(agent.id) + '"' : 'data-aw-pending-tool="' + esc(tool.id) + '"';
      const summaryKey = 'data-aw-tool-summary="' + esc(tool.id) + '"' + (agent ? ' data-aw-summary="' + esc(agent.id) + '"' : '');
      // A retry changes the task's current attempt, not the recorded tool outcome.
      // A successful worker process can still be followed by a failed tool wrapper.
      const activityStatus = state.mode === 'runtime' ? tool.status : task.status;
      const presentation = window.AthenaPiActivity.toolPresentation(tool.sdkToolName || tool.name, tool.args || {}, activityStatus, state.tasks);
      const glyph = window.AthenaPiActivity.iconHTML(presentation.icon, { active: presentation.active });
      const owner = agent ? labels.agent(agent, state.tasks) : '';
      const status = LABELS[activityStatus] || displayText(activityStatus, 'Working', state);
      return '<details class="aw-agent-event" ' + identity + ' data-aw-event-tool="' + esc(tool.id) + '" data-pi-tool="' + esc(tool.sdkToolName || 'custom') + '"' + (open ? ' open' : '') + '><summary class="cursor-interaction" ' + summaryKey + '>' + glyph
        + '<span class="aw-agent-copy"><span class="aw-agent-name">' + esc(presentation.label) + '</span><span class="aw-tool-target">' + esc(presentation.detail) + '</span></span>'
        + '<span class="aw-status" data-status="' + esc(activityStatus) + '">' + esc(status) + '</span>' + icon('chevron-down') + '</summary>'
        + (owner ? '<p class="aw-attempt-meta">' + esc(owner) + '</p>' : '') + toolDetailsHTML(tool, task, state) + '</details>';
    }

    function agentGroupHTML(state) {
      if (!state.agents.length) return '';
      const active = state.agents.filter(agent => agent.status === 'running');
      const complete = state.agents.filter(agent => agent.status === 'succeeded');
      const names = [...new Set(state.agents.map(agent => labels.agent(agent, state.tasks)))];
      const label = names.join(', ') + (active.length ? ' working' : state.run.status === 'paused' ? ' paused' : state.run.status === 'failed' ? ' need attention' : state.run.status === 'cancelled' ? ' stopped' : complete.length === state.agents.length ? ' complete' : ' waiting');
      return '<div class="aw-agent-presence"><span class="aw-agent-symbols">' + state.agents.map(agent => '<button type="button" class="aw-agent-symbol cursor-interaction" data-aw-agent-reveal="' + esc(agent.id) + '" aria-label="View ' + esc(labels.agent(agent, state.tasks)) + ' activity: ' + esc(labels.task(agent.taskId, state.tasks, 'Background task')) + '">' + window.AthenaAvatars.html({ agentId: agent.id, role: agent.role, status: agent.status, size: 20 }) + '</button>').join('') + '</span><span>' + esc(label) + '</span></div>';
    }

    function taskRecoveryHTML(task, state) {
      const retry = state.retryOperations?.[task.id];
      const attempt = (state.attempts || []).find(item => item.id === (retry?.expectedAttemptId || task.attemptId));
      const fallback = task.status === 'paused' ? 'This task was interrupted before it finished.' : task.status === 'cancelled' ? 'This task was cancelled before it finished.' : 'The agent could not complete this task.';
      const canRetry = state.capabilities?.retryTask && (task.retryable === true || retry?.pending || retry?.accepted);
      const button = canRetry ? '<button type="button" class="aw-text-button cursor-interaction" data-aw-retry="' + esc(task.id) + '"' + (retry?.pending || retry?.accepted ? ' disabled aria-busy="' + Boolean(retry.pending) + '"' : '') + '>' + icon('rotate-ccw') + (retry?.pending ? 'Retrying…' : retry?.accepted ? 'Retry queued' : 'Retry task') + '</button>' : '';
      return '<section class="aw-approval-inline" data-aw-task-recovery="' + esc(task.id) + '"><span>' + icon('rotate-ccw') + '</span><div><strong>' + esc(labels.task(task, state.tasks)) + '</strong><p>' + esc(displayText(attempt?.error, fallback, state)) + '</p>'
        + (retry?.error ? '<p role="alert" data-aw-retry-error>Retry was not confirmed. ' + esc(displayText(retry.error, 'Check the connection and try again.', state)) + '</p>' : '')
        + (retry?.accepted ? '<p role="status">Retry accepted. Waiting for the task update.</p>' : '')
        + (!canRetry && task.retryUnavailableReason ? '<p>' + esc(displayText(task.retryUnavailableReason, 'This task cannot be retried yet.', state)) + '</p>' : '')
        + '<div class="aw-agent-links">' + button + '<button type="button" class="aw-text-button cursor-interaction" data-aw-task-details="' + esc(task.id) + '">Task details' + icon('arrow-up-right') + '</button></div>'
        + labels.diagnostics([['Attempt ID', attempt?.id], ['Attempt error', attempt?.error], ['Retry request ID', retry?.requestId], ['Retry error', retry?.error]], 'recovery:' + task.id) + '</div></section>';
    }

    function revealTool(selection = {}) {
      if (destroyed) return false;
      if (typeof selection === 'string') selection = { taskId: selection };
      const process = snapshot.processes?.find(item => item.id === selection.processId) || (!selection.toolId && !selection.taskId && !snapshot.tools.length ? snapshot.processes?.[0] : null);
      if (process) {
        expandedProcesses.add(process.id); thinkingOpen = true; renderSignature = ''; render(snapshot);
        const row = [...all('[data-aw-process]')].find(item => item.dataset.awProcess === process.id);
        if (!row) return false;
        const attempt = row.closest('[data-aw-attempt]');
        if (attempt) attempt.open = true;
        const group = row?.closest('.ac-stream-activity');
        if (group) group.open = true;
        row.open = true;
        row.querySelector('summary').focus({ preventScroll: true });
        row.scrollIntoView?.({ block: 'nearest' });
        return true;
      }
      if (selection.processId) return false;
      const tool = (selection.toolId && snapshot.tools.find(item => item.id === selection.toolId)) || (selection.taskId && snapshot.tools.find(item => item.taskId === selection.taskId)) || snapshot.tools.find(item => ['running', 'blocked', 'failed', 'paused'].includes(item.status)) || snapshot.tools[0];
      if (!tool) return false;
      requestedTools.add(tool.id); expandedTools.add(tool.id); thinkingOpen = true;
      const agent = snapshot.agents.find(item => item.taskId === tool.taskId);
      if (agent) expanded.add(agent.id);
      renderSignature = ''; render(snapshot);
      const row = Array.from(all('[data-aw-event-tool]')).find(item => item.dataset.awEventTool === tool.id);
      const attempt = row?.closest('[data-aw-attempt]');
      if (attempt) attempt.open = true;
      const group = row?.closest('.ac-stream-activity');
      if (group) group.open = true;
      const summary = row?.querySelector('summary');
      if (focusable(summary)) { summary.focus({ preventScroll: true }); summary.scrollIntoView?.({ block: 'nearest', behavior: 'auto' }); }
      return true;
    }

    async function copyText(tool, text) {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(text);
        if (!destroyed) options.toast?.('Copied.');
      } catch (_) {
        if (destroyed) return;
        copyFallbacks.set(tool.id, text); revealTool({ toolId: tool.id });
        const field = Array.from(all('[data-aw-copy-fallback]')).find(item => item.dataset.awCopyFallback === tool.id);
        if (focusable(field)) { field.focus({ preventScroll: true }); field.select?.(); }
        options.toast?.('Select and copy the text in the conversation.');
      }
    }

    function downloadLog(tool) {
      const url = URL.createObjectURL(new Blob([logText(tool)], { type: 'text/plain;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = tool.id + '.log'; anchor.click();
      const timer = setTimeout(() => { URL.revokeObjectURL(url); downloadTimers.delete(timer); }, 1000);
      downloadTimers.set(timer, url);
    }

    function resultFilesHTML(results) {
      return results.map(item => {
        const process = snapshot.processes?.find(process => process.id === item.processId);
        const href = window.AthenaResultFiles?.href(snapshot.sessionId, item, process);
        return href ? '<a class="aw-text-button cursor-interaction" href="' + esc(href) + '" download>' + icon('download') + esc(displayText(item.file?.name || item.name || item.filename || item.title, 'Result file')) + '</a>' : '';
      }).join('');
    }

    function processHTML(process) {
      const job = process.job || process;
      const registered = window.AthenaResultFiles?.mcp(job.mcp);
      const processName = job.mcp ? registered?.name || 'Engineering calculation' : displayText(job.program, 'Process');
      const phase = window.AthenaResultFiles?.mcpPhase(job.mcp);
      const cancellation = window.AthenaResultFiles?.mcpCancellation(process);
      const status = LABELS[process.status] || displayText(String(process.status || '').replaceAll('_', ' '), 'Working');
      const field = (name, value) => value == null ? '' : '<div><dt>' + name + '</dt><dd>' + esc(typeof value === 'object' ? JSON.stringify(value) : value) + '</dd></div>';
      const recorded = field('Working directory', job.cwd)
        + field('Exit code', job.exitCode) + field('Signal', job.signal) + field('Cancellation', job.cancellation)
        + field('Limits', job.limits) + field('Policy', job.policy);
      // Argument boundaries matter: a joined shell string would misrepresent empty and spaced arguments.
      const command = job.program ? esc(job.program) + (Array.isArray(job.args) ? '\nArguments: ' + esc(JSON.stringify(job.args)) : '') : '';
      const files = snapshot.artifacts.filter(item => process.processId && item.processId === process.processId || !item.processId && (item.id === job.artifact?.id || job.artifacts?.some(file => file.id === item.id)));
      const output = (name, value) => typeof value === 'string' && value ? '<p class="aw-tool-task">' + name + '</p><pre class="aw-tool-log" aria-label="' + name + '">' + esc(value) + '</pre>' : '';
      const diagnostics = labels.diagnostics([['Task ID', process.taskId], ['Process ID', process.processId || process.id], ['Tool ID', process.toolId], ['Agent session ID', process.agentSessionId], ['Attempt ID', process.attemptId],
        ['MCP server', job.mcp?.server], ['MCP tool', job.mcp?.tool], ['Server version', job.mcp?.version], ['MCP protocol', job.mcp?.protocol], ['Result kind', job.mcp?.resultKind], ['MCP phase', job.mcp?.phase],
        ['Plugin ID', job.externalMcp?.pluginId], ['Plugin revision', job.externalMcp?.pluginRevision], ['Verified schema digest', job.externalMcp?.verificationDigest], ['Endpoint', job.externalMcp?.url]], 'process:' + process.id);
      const task = { ...snapshot.tasks.find(item => item.id === process.taskId), attempts: (snapshot.attempts || []).filter(item => item.taskId === process.taskId) };
      return '<details class="aw-agent-event" data-aw-process="' + esc(process.id) + '"' + (expandedProcesses.has(process.id) ? ' open' : '') + '><summary class="cursor-interaction" data-aw-process-summary="' + esc(process.id) + '">' + icon('square-terminal') + '<span class="aw-agent-copy"><span class="aw-agent-name">' + esc(processName) + '<span class="aw-status" data-status="' + esc(process.status) + '">' + esc(status) + '</span></span>' + (phase && ['queued', 'running'].includes(process.status) ? '<span class="aw-tool-target">' + esc(phase) + '</span>' : '') + '</span>' + icon('chevron-down') + '</summary>'
        + '<div class="aw-agent-detail"><p class="aw-tool-task">' + esc(labels.task(process.taskId, snapshot.tasks)) + (process.attemptId ? ' · ' + esc(labels.attempt(process.attemptId, task)) : '') + '</p>' + (cancellation ? '<p class="aw-tool-task">' + esc(cancellation) + '</p>' : '') + '<dl class="aw-tool-context">' + recorded + '</dl>' + diagnostics
        + (command ? '<code class="aw-tool-command">' + command + '</code>' : '') + output('Standard output', job.stdout) + output('Standard error', job.stderr) + (job.error ? '<p class="aw-tool-task">' + esc(job.error) + '</p>' : '') + '<div class="aw-agent-links">' + resultFilesHTML(files) + '</div></div></details>';
    }

    function renderAttempts(state, availableTools) {
      const placedTools = new Set(), placedProcesses = new Set(), placedTasks = new Set(), kept = new Set();
      if (!options.placeActivity) return { placedTools, placedProcesses, placedTasks };
      const attempts = (state.attempts || []).filter(attempt => state.tasks.some(task => task.id === attempt.taskId && task.parentTaskId));
      for (const attempt of attempts) {
        const task = state.tasks.find(item => item.id === attempt.taskId);
        const tools = availableTools.filter(item => item.attemptId === attempt.id);
        const processes = (state.processes || []).filter(item => item.attemptId === attempt.id);
        const results = state.artifacts.filter(item => item.attemptId === attempt.id);
        const agent = state.agents.find(item => item.taskId === task.id);
        let node = attemptSections.get(attempt.id);
        if (!node) { node = document.createElement('details'); node.className = 'aw-attempt'; node.dataset.awAttempt = attempt.id; attemptSections.set(attempt.id, node); }
        kept.add(attempt.id);
        const ownStatus = LABELS[attempt.status] || displayText(attempt.status, 'Waiting', state);
        const attemptLabel = labels.attempt(attempt.id, { ...task, attempts: attempts.filter(item => item.taskId === task.id) });
        const current = task.attemptId === attempt.id;
        const recovery = current && (['failed','paused','cancelled'].includes(attempt.status) || state.retryOperations?.[task.id]?.pending || state.retryOperations?.[task.id]?.accepted) ? taskRecoveryHTML({ ...task, status: attempt.status }, state) : '';
        const observed = [...tools.map((tool, index) => ({ at: state.events.find(event => event.toolId === tool.id)?.at ?? tool.logs?.[0]?.at ?? Infinity, index, html: toolEventHTML(tool, state, agent) })), ...processes.map((process, index) => ({ at: process.job?.startedAt ?? state.events.find(event => event.processId === process.id)?.at ?? Infinity, index: tools.length + index, html: processHTML(process) }))].sort((a, b) => a.at - b.at || a.index - b.index);
        const summary = attempt.result ? displayText(attempt.result, '', state) : '';
        const resultButtons = results.map(item => '<button type="button" class="aw-text-button cursor-interaction" data-aw-artifact="' + esc(item.id) + '" data-aw-artifact-version="' + esc(item.version || '') + '">' + icon('file-check') + esc(displayText(item.title || item.file?.name, 'View result', state)) + '</button>').join('');
        node.innerHTML = '<summary class="aw-attempt-heading cursor-interaction" data-aw-attempt-summary="' + esc(attempt.id) + '">' + icon('users-round') + '<strong>' + esc(labels.task(task, state.tasks)) + '</strong><span class="aw-status" data-status="' + esc(attempt.status) + '">' + esc(ownStatus) + '</span>' + icon('chevron-down') + '</summary>'
          + '<p class="aw-attempt-meta">' + esc([agent ? labels.agent(agent, state.tasks) : 'Subagent', attemptLabel].join(' · ')) + '</p>'
          + '<div class="aw-agent-events">' + observed.map(item => item.html).join('') + '</div>'
          + (summary && summary.length <= 300 ? '<p class="aw-attempt-result">' + esc(summary) + '</p>' : '')
          + (!current && attempt.error ? '<p class="aw-tool-task">' + esc(displayText(attempt.error, 'This attempt did not finish.', state)) + '</p>' : '')
          + recovery + '<div class="aw-agent-links aw-attempt-results">' + resultButtons + resultFilesHTML(results) + '</div>'
          + labels.diagnostics([['Run ID', attempt.runId || task.runId], ['Task ID', task.id], ['Attempt ID', attempt.id], ['Agent session ID', attempt.agentSessionId]], 'attempt:' + attempt.id);
        // The timeline owns placement only; all existing controls and artifact
        // downloads are still handled here against the host snapshot.
        if (!options.placeActivity(node, { runId: attempt.runId || task.runId, taskId: task.id, attemptId: attempt.id, at: attempt.acceptedAt ?? attempt.startedAt })) host.appendChild(node);
        for (const tool of tools) placedTools.add(tool.id);
        for (const process of processes) placedProcesses.add(process.id);
        placedTasks.add(task.id);
      }
      for (const [id, node] of attemptSections) if (!kept.has(id)) { options.removeActivity?.(id); node.remove(); attemptSections.delete(id); }
      return { placedTools, placedProcesses, placedTasks };
    }

    function render(state) {
      if (destroyed) return;
      // Existing attempt sections may already live inside the conversation.
      // Begin before replacing their innerHTML, not only before placement.
      options.onBeforeLayout?.();
      try { return renderContents(state); } finally { options.onAfterLayout?.(); }
    }

    function renderContents(state) {
      snapshot = state;
      const runKey = JSON.stringify([state.mode, state.sessionId]);
      if (currentRunKey && currentRunKey !== runKey) { expanded.clear(); expandedTools.clear(); expandedProcesses.clear(); expandedDiagnostics.clear(); requestedTools.clear(); outputModes.clear(); copyFallbacks.clear(); }
      else rememberDiagnostics();
      currentRunKey = runKey;
      if (state.mode !== 'runtime') { for (const [id, node] of attemptSections) { options.removeActivity?.(id); node.remove(); } attemptSections.clear(); }
      if(state.mode==='runtime'){
        const signature=JSON.stringify([state.revision,state.sessionId,state.run,state.tasks,state.agents,state.attempts,state.tools,state.processes,state.artifacts,state.approvals,state.retryOperations,[...requestedTools],[...expandedTools]]);
        if(signature!==renderSignature){
          renderSignature=signature;
          const previous=contains(document.activeElement)?captureKey(document.activeElement):null;
          const tools=state.tools.filter(tool=>(tool.source!=='pi'&&!options.hasConversationTool?.(tool.id))||requestedTools.has(tool.id));
          const pending=state.approvals.filter(request=>request.status==='pending');
          const recovery=state.tasks.filter(task=>task.parentTaskId&&(['failed','paused','cancelled'].includes(task.status)||state.retryOperations?.[task.id]?.pending||state.retryOperations?.[task.id]?.accepted));
          const runContext = (LABELS[state.run.status] || displayText(state.run.status, 'Ready', state)) + ' · ' + state.tasks.length + (state.tasks.length === 1 ? ' task' : ' tasks');
          const diagnostics = labels.diagnostics([['Session ID', state.sessionId], ['Run ID', state.run.id]], 'run');
          host.replaceChildren();
          const placed=renderAttempts(state,tools);
          const remainingTools=tools.filter(item=>!placed.placedTools.has(item.id)), remainingProcesses=(state.processes || []).filter(item=>!placed.placedProcesses.has(item.id)), remainingRecovery=recovery.filter(item=>!placed.placedTasks.has(item.id));
          const fallback=document.createElement('div');
          const empty=!remainingTools.length&&!pending.length&&!remainingRecovery.length&&!remainingProcesses.length&&(!state.agents.length||placed.placedTasks.size);
          fallback.innerHTML=empty?'':'<details class="aw-thinking" data-aw-thinking'+(thinkingOpen?' open':'')+'><summary class="aw-thinking-summary cursor-interaction" data-aw-thinking-summary="main">'+icon('workflow')+'<span>Workspace activity</span>'+icon('chevron-down')+'</summary><div class="aw-thinking-body"><p class="aw-run-context">'+esc(runContext)+'</p>'+(placed.placedTasks.size?'':agentGroupHTML(state))+remainingRecovery.map(task=>taskRecoveryHTML(task,state)).join('')+'<div class="aw-agent-events">'+remainingTools.map(tool=>toolEventHTML(tool,state,state.agents.find(agent=>agent.taskId===tool.taskId))).join('')+remainingProcesses.map(processHTML).join('')+'</div>'+pending.map(request=>'<div class="aw-approval-inline"><span>'+icon('shield-check')+'</span><div><strong>Permission requested</strong><p>'+esc(request.description)+'</p><button type="button" class="aw-text-button cursor-interaction" data-aw-approval-open="'+esc(request.id)+'">Review request'+icon('arrow-right')+'</button></div></div>').join('')+diagnostics+'</div></details>';
          host.append(...fallback.childNodes);
          for(const line of host.querySelectorAll('.aw-tool-task'))line.textContent=line.textContent.replace(/\s*·\s*\d+\s*\/\s*\d+\s*demo steps/,'');
          if(!state.capabilities?.retryTask)host.querySelectorAll('[data-aw-retry]').forEach(button=>button.disabled=true);
          restoreDiagnostics();
          refreshIcons();if(previous&&!openedApproval)resolveKey(previous)?.focus({preventScroll:true});
        }
        if(openedApproval&&!state.approvals.some(item=>item.id===openedApproval&&item.status==='pending'))closeApproval();
        return;
      }
      const signature = JSON.stringify([state.run.id, state.run.status, state.run.scenario, state.tasks.map(task => [task.id, task.status, task.progress]), state.approvals.map(item => [item.id, item.status]), state.events.length, state.artifacts.length, state.agents.length]);
      if (signature !== renderSignature) {
        renderSignature = signature;
        const previous = contains(document.activeElement) ? captureKey(document.activeElement) : null;
        const isLocalDemo = state.run.status === 'ready';
        const completed = state.tasks.filter(task => task.status === 'succeeded').length;
        const pending = state.approvals.find(item => item.status === 'pending');
        const rejected = [...state.approvals].reverse().find(item => item.status === 'rejected');
        const active = ['running', 'blocked', 'paused'].includes(state.run.status);
        const phase = window.AthenaPiActivity.phase(pending ? 'approval' : state.run.status);
        const heading = isLocalDemo ? 'Research plan' : phase.label;
        const tools = state.tools.filter(tool => state.agents.some(agent => agent.taskId === tool.taskId) || requestedTools.has(tool.id) || tool.logs.length > 0);
        host.innerHTML = '<details class="aw-thinking" data-aw-thinking' + (thinkingOpen ? ' open' : '') + '><summary class="aw-thinking-summary ap-phase cursor-interaction" data-aw-thinking-summary="main" data-pi-phase="' + phase.id + '" data-pi-active="' + phase.active + '">' + window.AthenaPiActivity.iconHTML(phase.icon, { active: phase.active, motion: phase.motion }) + '<span class="ap-live-label">' + esc(heading) + '</span>' + icon('chevron-down') + '</summary><div class="aw-thinking-body"><p class="aw-run-context">Component tolerance study <span aria-hidden="true">·</span> Local demo' + (isLocalDemo ? '' : ' <span aria-hidden="true">·</span> ' + completed + ' / ' + state.tasks.length + ' complete') + '</p>'
          + (isLocalDemo ? '<p class="aw-plan">I’ll inspect the references and data, compare component conditions, then ask Sage to review the results before Quill writes the report.</p>' : '')
          + agentGroupHTML(state)
          + '<div class="aw-agent-events">' + tools.map(tool => toolEventHTML(tool, state, state.agents.find(agent => agent.taskId === tool.taskId))).join('') + '</div>'
          + (pending ? '<div class="aw-approval-inline"><span>' + icon('shield-check') + '</span><div><strong>Permission needed for Python analysis</strong><p>Review the command and output location before this demo step continues.</p><button type="button" class="aw-text-button cursor-interaction" data-aw-approval-open="' + esc(pending.id) + '">Review request' + icon('arrow-right') + '</button></div></div>' : rejected && state.run.status === 'blocked' ? '<div class="aw-approval-inline"><span>' + icon('shield-x') + '</span><div><strong>Request declined</strong><p>The analysis did not start. You can request approval again when you are ready.</p><button type="button" class="aw-text-button cursor-interaction" data-aw-retry="' + esc(rejected.taskId) + '">Request again' + icon('arrow-right') + '</button></div></div>' : '')
          + (state.run.status === 'succeeded' ? '<div class="aw-run-complete">' + icon('check-check') + '<span>The demo is complete. Review the evidence and final research note.</span><button type="button" class="aw-text-button cursor-interaction" data-aw-artifact="research-note">Open report' + icon('arrow-up-right') + '</button></div>' : '')
          + '<details class="aw-demo-options"' + (demoOptionsOpen ? ' open' : '') + '><summary class="cursor-interaction">Demo options</summary>' + controlsHTML(state) + '<label for="aw-demo-scenario">Scenario</label><select id="aw-demo-scenario"' + (active ? ' disabled' : '') + '><option value="success"' + (state.run.scenario === 'success' ? ' selected' : '') + '>Successful research run</option><option value="analysis-error"' + (state.run.scenario === 'analysis-error' ? ' selected' : '') + '>Analysis error and recovery</option></select><p>Simulated tool events only. Uploaded files and model settings are not sent to a runtime.</p></details></div></details><span class="ac-sr-only" data-aw-live role="status" aria-live="polite"></span>';
        restoreDiagnostics();
        refreshIcons();
        if (previous && !openedApproval) resolveKey(previous)?.focus({ preventScroll: true });
        if (lastRunStatus !== state.run.status) {
          q('[data-aw-live]').textContent = 'Research demo: ' + (LABELS[state.run.status] || state.run.status) + '.';
          lastRunStatus = state.run.status;
        }
      }
      if (openedApproval && !state.approvals.some(item => item.id === openedApproval && item.status === 'pending')) closeApproval();
    }

    listen(root, 'toggle', event => {
      if (!contains(event.target)) return;
      if (event.target.matches?.('[data-aw-diagnostics]')) {
        if (event.target.open) expandedDiagnostics.add(event.target.dataset.awDiagnostics);
        else expandedDiagnostics.delete(event.target.dataset.awDiagnostics);
        return;
      }
      if (event.target.matches?.('.aw-demo-options')) { demoOptionsOpen = event.target.open; return; }
      if (event.target.matches?.('[data-aw-thinking]')) { thinkingOpen = event.target.open; return; }
      if (event.target.matches?.('[data-aw-process]')) {
        if (event.target.open) expandedProcesses.add(event.target.dataset.awProcess);
        else expandedProcesses.delete(event.target.dataset.awProcess);
        return;
      }
      if (!event.target.matches?.('[data-aw-event-tool]')) return;
      const id = event.target.dataset.awAgent, toolId = event.target.dataset.awEventTool;
      if (event.target.open) { if (id) expanded.add(id); expandedTools.add(toolId); }
      else { if (id) expanded.delete(id); expandedTools.delete(toolId); }
    }, { capture: true });
    listen(root, 'change', event => {
      if (!contains(event.target)) return;
      if (event.target.id === 'aw-demo-scenario') {
        const scenario = event.target.value;
        if (!['ready', 'running', 'blocked', 'paused'].includes(snapshot.run.status)) { expanded.clear(); store.reset(); }
        store.setScenario(scenario);
      }
    });
    listen(root, 'click', event => {
      const button = event.target.closest('button');
      if (!button || button.disabled || !contains(button)) return;
      if (button.dataset.awApprovalOpen) { openApproval(button.dataset.awApprovalOpen); return; }
      if (button.dataset.awAgentReveal) {
        const agent = snapshot.agents.find(item => item.id === button.dataset.awAgentReveal);
        if (agent?.agentSessionId && snapshot.capabilities?.agentHistory) options.onNavigate?.('timeline', { taskId: agent.taskId, agentSessionId: agent.agentSessionId });
        else if (agent) revealTool({ taskId: agent.taskId });
        return;
      }
      if (button.dataset.awOutputMode) {
        outputModes.set(button.dataset.awTool, button.dataset.awOutputMode); renderSignature = ''; render(snapshot); return;
      }
      if (button.dataset.awToolAction) {
        const tool = snapshot.tools.find(item => item.id === button.dataset.awTool);
        if (!tool) return;
        if (button.dataset.awToolAction === 'copy-command') copyText(tool, tool.command);
        if (button.dataset.awToolAction === 'copy-log') copyText(tool, logText(tool));
        if (button.dataset.awToolAction === 'download-log') downloadLog(tool);
        return;
      }
      if (button.dataset.awArtifact) { options.onNavigate?.('artifacts', { artifactId: button.dataset.awArtifact, ...(button.dataset.awArtifactVersion ? {version:button.dataset.awArtifactVersion} : {}) }); return; }
      if (button.dataset.awTimeline) { options.onNavigate?.('timeline', { taskId: button.dataset.awTimeline }); return; }
      if (button.dataset.awRetry) { store.retryTask(button.dataset.awRetry); return; }
      if (button.dataset.awTaskDetails) { options.onNavigate?.('workflow', { taskId: button.dataset.awTaskDetails }); return; }
      const action = button.dataset.awAction;
      if (action === 'workflow') options.onNavigate?.('workflow');
      if (action === 'preview-reply') options.onPreviewReply?.();
      if (action === 'primary') {
        if (snapshot.run.status === 'ready') store.start();
        else if (snapshot.run.status === 'paused') store.resume();
        else if (['running', 'blocked'].includes(snapshot.run.status)) return;
        else { expanded.clear(); store.reset(); store.start(); }
      }
    });
    listen(backdrop, 'click', event => {
      if (event.target === backdrop) { closeApproval(); return; }
      const button = event.target.closest('[data-aw-dialog]');
      if (!button) return;
      const action = button.dataset.awDialog;
      if (action === 'close') closeApproval();
      if ((action === 'allow' || action === 'reject') && openedApproval) {
        const id = openedApproval;
        store.decideApproval(id, action === 'allow' ? 'approved' : 'rejected');
        closeApproval();
      }
    });
    listen(backdrop, 'keydown', event => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); closeApproval(); }
      if (event.key === 'Tab') {
        const controls = [...backdrop.querySelectorAll('button:not([disabled])')];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    listen(document, 'focusin', event => {
      if (openedApproval && !backdrop.contains(event.target)) backdrop.querySelector('[data-aw-dialog="close"]').focus({ preventScroll: true });
    });
    const unsubscribe = store.subscribe(render);
    return {
      openApproval, closeApproval, revealTool, refresh() { renderSignature = ''; render(snapshot); }, isApprovalOpen: () => Boolean(openedApproval),
      getState: () => ({ approvalId: openedApproval, expanded: [...expanded], expandedTools: [...expandedTools], thinkingOpen }),
      destroy() {
        if (destroyed) return;
        closeApproval(false);
        destroyed = true;
        for (const [timer, url] of downloadTimers) { clearTimeout(timer); URL.revokeObjectURL(url); }
        downloadTimers.clear();
        unsubscribe(); controller.abort(); backdrop.remove(); host.replaceChildren(); for (const node of attemptSections.values()) node.remove(); attemptSections.clear();
      }
    };
  }
  window.AthenaWorkspaceChrome = Object.freeze({ mount });
})();
