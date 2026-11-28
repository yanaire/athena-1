/* Keyed inline presentation of normalized Pi events. Never executes tool input. */
(() => {
  'use strict';
  function mount(host, options = {}) {
    const rows = new Map();
    const controller = new AbortController();
    let destroyed = false, runId = null, lastSnapshot = null;
    const error = document.createElement('p');
    error.className = 'ap-session-error'; error.hidden = true;
    error.setAttribute('role', 'alert');
    if (!options.managedLayout) host.appendChild(error);
    function createRow(id) {
      const element = document.createElement('details');
      element.className = 'ap-tool-event'; element.dataset.apTool = id;
      element.innerHTML = '<summary class="cursor-interaction"><span class="ap-tool-icon"></span><span class="ap-tool-copy"><span class="ap-tool-label"></span><span class="ap-tool-target"></span></span><i data-lucide="chevron-down" aria-hidden="true"></i></summary><div class="ap-tool-body"><dl><div><dt>Status</dt><dd data-ap-state></dd></div></dl><details class="aw-diagnostics" data-aw-diagnostics><summary class="cursor-interaction">Technical details</summary><dl><div><dt>Tool</dt><dd data-ap-name></dd></div><div><dt>Tool call ID</dt><dd data-ap-call-id></dd></div></dl><pre data-ap-input aria-label="Tool input"></pre><pre data-ap-output aria-label="Tool output"></pre><div class="ap-tool-actions"><button type="button" class="cursor-interaction" data-ap-copy="input">Copy input</button><button type="button" class="cursor-interaction" data-ap-copy="output">Copy output</button></div><label class="ap-copy-label" hidden>Select and copy manually<textarea readonly aria-label="Copy tool text manually"></textarea></label></details></div>';
      element.querySelector('summary').dataset.apToolSummary = id;
      element.querySelector('[data-aw-diagnostics]').dataset.awDiagnostics = 'pi-tool-' + id;
      if (options.managedLayout) host.appendChild(element); else host.insertBefore(element, error);
      const row = { element, tool: null, iconKey: '' };
      rows.set(id, row); return row;
    }
    function render(snapshot) {
      if (destroyed) return;
      if (runId !== snapshot.runId) { reset(); runId = snapshot.runId; }
      lastSnapshot = snapshot;
      const tasks = options.getWorkspace?.()?.tasks || [];
      const ids = new Set(snapshot.tools.map(tool => tool.id));
      for (const [id, row] of rows) if (!ids.has(id)) { row.element.remove(); rows.delete(id); }
      let iconsChanged = false;
      for (const tool of snapshot.tools) {
        const isNew = !rows.has(tool.id);
        const row = rows.get(tool.id) || createRow(tool.id);
        row.tool = tool;
        const q = selector => row.element.querySelector(selector);
        const presentation = window.AthenaPiActivity.toolPresentation(tool.toolName, tool.args, tool.status, tasks);
        row.element.dataset.piTool = tool.toolName;
        row.element.dataset.piStatus = tool.status;
        row.element.dataset.toolId = tool.toolCallId || tool.id;
        if (tool.taskId) row.element.dataset.taskId = tool.taskId; else delete row.element.dataset.taskId;
        if (tool.sessionId) row.element.dataset.sessionId = tool.sessionId; else delete row.element.dataset.sessionId;
        row.element.dataset.piActive = String(tool.active);
        const iconKey = presentation.icon + ':' + tool.active;
        if (row.iconKey !== iconKey) {
          q('.ap-tool-icon').innerHTML = window.AthenaPiActivity.iconHTML(presentation.icon, { active: tool.active });
          row.iconKey = iconKey; iconsChanged = true;
        }
        q('.ap-tool-label').textContent = presentation.label;
        q('.ap-tool-target').textContent = presentation.detail;
        q('.ap-tool-target').hidden = !presentation.detail;
        q('[data-ap-name]').textContent = tool.toolName;
        q('[data-ap-call-id]').textContent = tool.toolCallId || tool.id;
        q('[data-ap-state]').textContent = ({ running: 'Running', queued: 'Waiting', succeeded: 'Complete', failed: 'Needs attention', stopped: 'Stopped' })[tool.status] || tool.status;
        const input = JSON.stringify(tool.args, null, 2);
        const inputNode = q('[data-ap-input]'), outputNode = q('[data-ap-output]');
        if (inputNode.textContent !== input) inputNode.textContent = input;
        const output = tool.output || (tool.active ? 'Waiting for output…' : 'No text output.');
        if (outputNode.textContent !== output) outputNode.textContent = output;
        let limitNote = row.element.querySelector('.ap-preview-limit');
        if(!limitNote){limitNote=document.createElement('p');limitNote.className='ap-preview-limit';row.element.querySelector('.ap-tool-body').appendChild(limitNote);}
        limitNote.hidden=!(tool.inputTruncated||tool.outputTruncated);
        limitNote.textContent=[tool.inputTruncated?'Input preview is shortened ('+(tool.inputCharacters??'unknown')+' characters received).':'',tool.outputTruncated?'Output preview shows the last '+tool.outputPreviewCharacters+' of '+tool.outputCharacters+' characters.':'',tool.inputTruncated||tool.outputTruncated?'Full output requires the host execution-log service. Copy includes this preview only.':''].filter(Boolean).join(' ');
        iconsChanged ||= isNew;
      }
      error.textContent = snapshot.error || '';
      error.hidden = !snapshot.error;
      if (options.managedLayout) { if (snapshot.error) host.appendChild(error); else error.remove(); }
      if (!options.managedLayout) host.hidden = !rows.size && !snapshot.error;
      if (iconsChanged) options.icons?.();
    }
    async function onClick(event) {
      const button = event.target.closest('[data-ap-copy]');
      const element = button?.closest('[data-ap-tool]');
      if (!element || !host.contains(element)) return;
      const row = rows.get(element.dataset.apTool);
      const value = button.dataset.apCopy === 'input' ? JSON.stringify(row.tool.args, null, 2) : row.tool.output;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Unavailable');
        await navigator.clipboard.writeText(value);
        if (!destroyed) options.toast?.('Copied.');
      } catch (_) {
        if (destroyed || !element.isConnected) return;
        const label = element.querySelector('.ap-copy-label'), field = label.querySelector('textarea');
        label.hidden = false; field.value = value; field.focus(); field.select?.();
      }
    }
    host.addEventListener('click', onClick, { signal: controller.signal });
    function reset() {
      for (const row of rows.values()) row.element.remove();
      rows.clear(); lastSnapshot = null; error.textContent = ''; error.hidden = true; if (!options.managedLayout) host.hidden = true;
    }
    reset();
    return Object.freeze({ render, refresh() { if (lastSnapshot) render(lastSnapshot); }, reset, getToolElement: id => rows.get(id)?.element || null, revealTool(id) { const row = [...rows.values()].find(item => item.tool?.toolCallId === id || item.tool?.id === id); if (!row) return false; const group = row.element.closest('.ac-stream-activity'); if (group) group.open = true; row.element.open = true; row.element.querySelector('summary').focus({preventScroll:true}); row.element.scrollIntoView?.({block:'nearest'}); return true; }, destroy() { if (destroyed) return; destroyed = true; controller.abort(); reset(); error.remove(); } });
  }
  window.AthenaPiSessionView = Object.freeze({ mount });
})();
