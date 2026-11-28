/* Public conversation messages and observed actions in their original order.
 * Context links work to a turn; it is not a message identity. Hidden reasoning
 * and raw tool results are never used as progress descriptions.
 */
(() => {
  'use strict';
  const text = content => typeof content === 'string' ? content : (Array.isArray(content) ? content : []).filter(block => block?.type === 'text').map(block => String(block.text || '')).join('\n');
  const context = value => value && typeof value.runId === 'string' && typeof value.attemptId === 'string' ? Object.fromEntries(['projectId', 'sessionId', 'runId', 'taskId', 'parentTaskId', 'agentSessionId', 'attemptId'].filter(key => typeof value[key] === 'string' || key === 'parentTaskId' && value[key] === null).map(key => [key, value[key]])) : null;
  const timestamp = value => Number.isFinite(value) ? value : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  const attachmentNames = value => (Array.isArray(value) ? value : []).filter(file => file && typeof file.name === 'string' && file.name).map(file => ({ name: file.name }));

  function mount(host, options = {}) {
    const view = window.AthenaPiSessionView.mount(host, { ...options, managedLayout: true });
    const nodes = new Map(), tools = new Map(), activities = new Map();
    let entries = [], generation = 0, userCounter = 0, lastObservedOrder = 0, pendingUser = null, liveOwner = null, liveKeys = new Set(), destroyed = false, error = null;

    function toolRecord(block, owner, status = 'queued') {
      return { id: block.id, toolCallId: block.id, toolName: block.name || 'custom', args: block.arguments || {}, status, active: status === 'running', output: '', athena: owner };
    }
    function assign(node, owner) {
      for (const key of ['runId', 'taskId', 'attemptId']) {
        if (owner?.[key]) node.dataset[key] = owner[key]; else delete node.dataset[key];
      }
    }
    function makeNode(entry) {
      const article = document.createElement(entry.kind === 'handoff' ? 'details' : entry.kind === 'tool' ? 'div' : 'article');
      article.className = entry.kind === 'tool' ? 'ac-stream-tool' : 'ac-pi-history-message ac-stream-message';
      article.dataset.streamKey = entry.key;
      if (entry.kind === 'handoff') {
        article.className = 'ac-stream-handoff';
        const label = document.createElement('summary'); label.className = 'cursor-interaction'; label.textContent = 'Manuscript instructions';
        const body = document.createElement('p'); body.className = 'ac-stream-text';
        article.append(label, body);
      } else if (entry.kind !== 'tool') {
        article.dataset.role = entry.role;
        const label = document.createElement('strong'); label.textContent = entry.role === 'user' ? 'You' : 'Athena';
        const body = document.createElement('p'); body.className = 'ac-stream-text';
        article.append(label, body);
      }
      nodes.set(entry.key, article);
      return article;
    }
    function currentTools() {
      const workspace = options.getWorkspace?.();
      return [...tools.values()].map(tool => {
        // Saved host tool outcomes remain authoritative across retries and
        // restarts, even if the parent task's latest status has changed.
        const recorded = workspace?.tools?.find(item => item.id === tool.id || item.toolCallId === tool.id);
        if (!recorded) return tool;
        const status = ['succeeded','failed','stopped','cancelled'].includes(tool.status) && ['queued','running'].includes(recorded.status) ? tool.status : recorded.status;
        return { ...tool, status, active: status === 'running', taskId: recorded.taskId, sessionId: recorded.sessionId };
      });
    }
    const groups = new Map();
    function arrange(parent, children) {
      let cursor = parent.firstElementChild;
      for (const node of children) {
        if (node === cursor) cursor = cursor.nextElementSibling;
        else parent.insertBefore(node, cursor);
      }
    }
    function activityBlocks(ordered) {
      const visible = [], kept = new Set();
      let block = null;
      for (const item of ordered) {
        if (!item.activity && !['tool', 'handoff'].includes(item.entry.kind)) {
          visible.push(item.node); block = null; continue;
        }
        const run = item.activity?.runId || item.entry?.athena?.runId || '';
        if (!block || block.run !== run) {
          const anchor = item.activity?.attemptId || item.activity?.key || item.entry?.toolId || item.entry?.athena?.attemptId || item.entry?.key;
          const key = JSON.stringify([run, anchor]);
          block = groups.get(key);
          if (!block) {
            const node = document.createElement('details'), summary = document.createElement('summary'), body = document.createElement('div');
            node.className = 'ac-stream-activity'; summary.className = 'cursor-interaction';
            body.className = 'ac-stream-steps'; node.append(summary, body);
            block = { node, summary, body, run };
            groups.set(key, block);
          }
          kept.add(key); visible.push(block.node);
          block.children = []; block.statuses = [];
        }
        block.children.push(item.node);
        block.statuses.push(item.activity ? item.node.querySelector('.aw-attempt-heading [data-status]')?.dataset.status : item.node.querySelector('[data-pi-status]')?.dataset.piStatus);
      }
      for (const [key, group] of groups) {
        if (!kept.has(key)) { group.node.remove(); groups.delete(key); continue; }
        arrange(group.body, group.children);
        const state = group.statuses.includes('failed') ? 'Needs attention' : group.statuses.includes('blocked') ? 'Waiting for input'
          : group.statuses.includes('running') ? 'Working' : group.statuses.some(s => ['stopped','cancelled'].includes(s)) ? 'Stopped' : '';
        const count = group.children.length;
        const label = ['Research activity', count + (count === 1 ? ' step' : ' steps'), state].filter(Boolean).join(' · ');
        if (group.summary.textContent !== label) group.summary.textContent = label;
      }
      return visible;
    }
    function layout() {
      if (destroyed) return;
      const arranged = entries.filter(entry => entry.kind === 'tool' || entry.text !== '' || entry.attachments?.length).map(entry => ({ entry, node: nodes.get(entry.key) })).filter(item => item.node);
      // A child attempt belongs to an exact run supplied by the host. Use
      // recorded timestamps only for placement within that run; unmatched
      // legacy records stay in the workspace fallback instead of being guessed.
      for (const item of [...activities.values()].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))) {
        const owned = arranged.filter(row => row.entry?.athena?.runId === item.runId);
        if (!owned.length) { const fallback = options.getActivityFallback?.(); if (fallback && item.node.parentElement !== fallback) fallback.appendChild(item.node); else if (!fallback) item.node.remove(); continue; }
        const next = item.at == null ? null : owned.find(row => row.entry.at != null && row.entry.at > item.at);
        const anchor = next || owned[owned.length - 1];
        let index = arranged.indexOf(anchor) + (next ? 0 : 1);
        // Preserve sibling/retry order when they share one message anchor.
        while (index < arranged.length && arranged[index].activity && arranged[index].activity.runId === item.runId && (arranged[index].activity.at ?? Infinity) <= (item.at ?? Infinity)) index++;
        arranged.splice(index, 0, { node: item.node, activity: item });
      }
      arrange(host, activityBlocks(arranged));
      host.hidden = !arranged.length && !error;
    }
    function withLayout(change) {
      options.onBeforeLayout?.();
      try { return change(); } finally { options.onAfterLayout?.(); }
    }
    function render() {
      if (!destroyed) return withLayout(renderContents);
    }
    function renderContents() {
      if (destroyed) return;
      view.render({ runId: 'conversation', tools: currentTools(), error });
      const present = new Set(entries.map(entry => entry.key));
      for (const [key, node] of nodes) if (!present.has(key)) { node.remove(); nodes.delete(key); }
      for (const entry of entries) {
        const node = nodes.get(entry.key) || makeNode(entry);
        assign(node, entry.athena);
        if (entry.kind === 'tool') {
          const row = view.getToolElement(entry.toolId);
          if (row && row.parentElement !== node) node.appendChild(row);
        } else {
          const body = node.querySelector('.ac-stream-text');
          if (body.textContent !== entry.text) body.textContent = entry.text;
          node.hidden = !entry.text && !entry.attachments?.length;
          let attachmentList = node.querySelector('.ac-message-attachments');
          if (entry.attachments?.length) {
            if (!attachmentList) { attachmentList = document.createElement('div'); attachmentList.className = 'ac-message-attachments'; node.appendChild(attachmentList); }
            const signature = JSON.stringify(entry.attachments.map(file => file.name));
            if (attachmentList.dataset.attachments !== signature) {
              attachmentList.replaceChildren(); attachmentList.dataset.attachments = signature;
              for (const file of entry.attachments) { const label = document.createElement('span'); label.className = 'ac-message-attachment'; label.textContent = file.name; attachmentList.appendChild(label); }
            }
          } else attachmentList?.remove();
        }
      }
      layout();
    }
    function clear(keepActivities = false) {
      generation++; entries = []; tools.clear(); pendingUser = null; liveOwner = null; liveKeys.clear(); lastObservedOrder = 0; error = null;
      for (const node of nodes.values()) node.remove();
      nodes.clear();
      if (!keepActivities) {
        for (const group of groups.values()) group.node.remove();
        groups.clear();
        for (const item of activities.values()) item.node.remove(); activities.clear(); }
      view.reset(); host.hidden = true;
    }
    function history(messages) {
      if (destroyed) return;
      // History replacement must start its transaction before clear() removes
      // the old height; a render-only hook would mistake that empty view for
      // a user at the bottom and pull someone reading earlier messages down.
      return withLayout(() => restoreHistory(messages));
    }
    function restoreHistory(messages) {
      // The live feed and the durable transcript share host-owned call IDs.
      // Keep a reader's place when a settled run replaces its streaming rows.
      const expanded = new Map();
      for (const entry of entries) {
        if (entry.kind !== 'tool' || !entry.athena) continue;
        const row = view.getToolElement(entry.toolId);
        if (!row?.open) continue;
        const diagnostic = row.querySelector('[data-aw-diagnostics]');
        expanded.set(entry.toolId, { attempt: entry.athena.attemptId, diagnostic: diagnostic.open,
          focused: document.activeElement === row.querySelector('summary') ? 'summary' :
            document.activeElement === diagnostic.querySelector('summary') ? '[data-aw-diagnostics] > summary' : null });
      }
      clear(true);
      for (const [index, message] of (messages || []).entries()) {
        const owner = context(message.athena), at = timestamp(message.timestamp);
        if (message.role === 'toolResult') {
          const tool = tools.get(message.toolCallId);
          if (tool) { tool.status = message.isError === true ? 'failed' : 'succeeded'; tool.active = false; tool.output = text(message.content); }
          continue;
        }
        if (!['user', 'assistant'].includes(message.role)) continue;
        if (message.role === 'user') {
          entries.push({ key: 'history:' + index, kind: owner && message.manuscriptHandoff === true ? 'handoff' : 'message', role: 'user', text: text(message.content), attachments: attachmentNames(message.attachments), athena: owner, at });
          continue;
        }
        const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [];
        for (const [part, block] of content.entries()) {
          if (block?.type === 'text') entries.push({ key: 'history:' + index + ':' + part, kind: 'message', role: 'assistant', text: String(block.text || ''), athena: owner, at });
          else if (block?.type === 'toolCall' && typeof block.id === 'string' && !tools.has(block.id)) {
            tools.set(block.id, toolRecord(block, owner));
            entries.push({ key: 'tool:' + block.id, kind: 'tool', toolId: block.id, athena: owner, at });
          }
        }
      }
      render();
      for (const entry of entries) {
        const saved = expanded.get(entry.toolId);
        if (!saved || saved.attempt !== entry.athena?.attemptId) continue;
        const row = view.getToolElement(entry.toolId);
        row.open = true;
        row.querySelector('[data-aw-diagnostics]').open = saved.diagnostic;
        if (saved.focused) row.querySelector(saved.focused).focus({preventScroll:true});
      }
    }
    function finish() { generation++; pendingUser = null; liveOwner = null; liveKeys.clear(); lastObservedOrder = 0; error = null; }
    function beginUser(value, attachments = []) {
      finish();
      pendingUser = { key: 'user:' + generation + ':' + (++userCounter), kind: 'message', role: 'user', text: String(value), attachments: attachments.map(file => ({ name: file.name })), athena: null, at: null, order: 0, observed: false };
      entries.push(pendingUser); liveKeys.add(pendingUser.key); render();
    }
    function observe(event) {
      const owner = context(event);
      if (owner) {
        liveOwner = owner;
        if (pendingUser && !pendingUser.athena) pendingUser.athena = owner;
      }
      if (event.type === 'message_start' && event.message?.role === 'user') {
        const handoff = owner && event.message.manuscriptHandoff === true;
        if (!pendingUser || pendingUser.observed || handoff) {
          pendingUser = { key: 'user:' + generation + ':' + (++userCounter), kind: handoff ? 'handoff' : 'message', role: 'user', text: '', athena: owner, at: null, order: lastObservedOrder + 0.5 };
          entries.push(pendingUser); liveKeys.add(pendingUser.key);
        }
        pendingUser.observed = true;
        pendingUser.text = text(event.message.content);
        if (Array.isArray(event.message.attachments)) pendingUser.attachments = attachmentNames(event.message.attachments);
        pendingUser.at = timestamp(event.message.timestamp);
        pendingUser.athena = owner || pendingUser.athena;
        render();
      }
    }
    function live(snapshot) {
      const added = [];
      for (const message of snapshot.messages || []) {
        const prefix = 'live:' + generation + ':' + message.id + ':';
        const parts = message.parts?.length ? message.parts : [{ index: 0, text: message.text, order: message.order }];
        const present = new Set(parts.map(part => prefix + part.index));
        entries = entries.filter(entry => !entry.key.startsWith(prefix) || present.has(entry.key));
        for (const part of parts) {
          const key = prefix + part.index;
          let entry = entries.find(item => item.key === key);
          if (!entry) { entry = { key, kind: 'message', role: 'assistant', text: '', order: part.order ?? Infinity, athena: context(message.athena) || liveOwner, at: timestamp(message.timestamp) }; added.push(entry); liveKeys.add(key); }
          entry.text = part.text;
          entry.order = part.order ?? Infinity;
          entry.athena ||= context(message.athena) || liveOwner;
          entry.at ??= timestamp(message.timestamp);
        }
      }
      for (const tool of snapshot.tools || []) {
        tools.set(tool.id, { ...tool });
        const key = 'tool:' + tool.id;
        if (!entries.some(item => item.key === key)) {
          added.push({ key, kind: 'tool', toolId: tool.id, order: tool.order ?? Infinity, athena: context(tool.athena) || liveOwner, at: timestamp(tool.startedAt) }); liveKeys.add(key);
        }
      }
      entries.push(...added);
      lastObservedOrder = Math.max(lastObservedOrder, ...entries.filter(entry => liveKeys.has(entry.key) && Number.isFinite(entry.order)).map(entry => entry.order));
      const liveEntries = entries.filter(entry => liveKeys.has(entry.key)).sort((a, b) => a.order - b.order);
      entries = entries.filter(entry => !liveKeys.has(entry.key)).concat(liveEntries);
      error = snapshot.error || null;
      render();
    }
    return Object.freeze({
      history, beginUser, observe, render: live, reset: finish, clear, refresh: render,
      revealTool: view.revealTool, hasTool: id => tools.has(id),
      removeActivity(id) { return withLayout(() => { const item = activities.get(id); item?.node.remove(); activities.delete(id); }); },
      placeActivity(node, details) { return withLayout(() => { const key = details.attemptId || details.key, previous = activities.get(key); if (previous && previous.node !== node) previous.node.remove(); const item = { node, ...details, at: timestamp(details.at) }; activities.set(key, item); layout(); return entries.some(entry => entry.athena?.runId === details.runId); }); },
      destroy() { if (destroyed) return; clear(); view.destroy(); destroyed = true; }
    });
  }
  window.AthenaConversationStream = Object.freeze({ mount });
})();
