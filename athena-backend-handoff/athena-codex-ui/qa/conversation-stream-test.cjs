'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const base = path.resolve(__dirname, '..');

function environment(options = {}) {
  const { window, document } = parseHTML('<html><body><main id="root"><section id="transcript"></section><section id="aw-activity"></section></main></body></html>');
  Object.defineProperty(window.HTMLElement.prototype, 'open', { configurable: true, get() { return this.hasAttribute('open'); }, set(value) { this.toggleAttribute('open', Boolean(value)); } });
  const copied = [], context = vm.createContext({ window, document, AbortController, URL, Blob, Date, setTimeout, clearTimeout, navigator: { clipboard: { writeText: async value => copied.push(value) } } });
  for (const name of ['activity-labels', 'pi-activity', 'pi-session-view', 'conversation-stream', 'result-files', 'workspace-chrome']) vm.runInContext(fs.readFileSync(path.join(base, 'ui', name + '.js'), 'utf8'), context, { filename: name });
  window.AthenaAvatars = { html: () => '<span></span>' };
  let state = { mode: 'runtime', revision: 1, sessionId: 'session-one', run: { id: 'run-one', status: 'running' }, tasks: [], agents: [], attempts: [], tools: [], processes: [], artifacts: [], approvals: [], events: [], capabilities: { retryTask: true } };
  const host = document.querySelector('#transcript'), fallback = document.querySelector('#aw-activity');
  const view = window.AthenaConversationStream.mount(host, { getWorkspace: () => state, getActivityFallback: () => fallback, ...options });
  return { window, document, host, fallback, view, copied, get state() { return state; }, set state(value) { state = value; }, click(node) { assert.ok(node); node.dispatchEvent(new window.Event('click', { bubbles: true })); }, close() { view.destroy(); } };
}
const owner = (runId = 'run-one', attemptId = 'attempt-parent-one') => ({ projectId: 'project-one', sessionId: 'session-one', runId, taskId: 'parent-' + runId, parentTaskId: null, agentSessionId: 'agent-' + runId, attemptId });
const message = (role, content, athena, timestamp) => ({ role, content, ...(athena ? { athena } : {}), timestamp });
function historyRun(context, start, title = 'Compare the measurement') {
  return [message('user', title, context, start), message('assistant', [{ type: 'text', text: 'I will inspect the file.' }, { type: 'toolCall', id: 'call-' + context.runId, name: 'spawn_agent', arguments: { title: 'Calculate voltage statistics' } }], context, start + 10), { ...message('toolResult', [{ type: 'text', text: '{"taskId":"private-task-value"}' }], context, start + 20), toolCallId: 'call-' + context.runId, isError: false }, message('assistant', 'The result is ready.', context, start + 100)];
}
const order = host => [...host.children].flatMap(node => node.matches('.ac-stream-activity') ? [...node.querySelector('.ac-stream-steps').children] : [node]).filter(node => !node.hidden).map(node => node.dataset.awAttempt ? 'attempt:' + node.dataset.awAttempt : node.dataset.role === 'user' ? 'user:' + node.querySelector('p').textContent : node.dataset.role === 'assistant' ? 'text:' + node.querySelector('p').textContent : node.querySelector('[data-ap-tool]') ? 'tool:' + node.querySelector('[data-ap-tool]').dataset.apTool : 'other');

test('verified attachment labels survive history hydration including an attachment-only message', () => {
  const e = environment(), context = owner();
  const attachments = [{name: '<img onerror=alert(1)>.csv', mimeType: 'text/csv', size: 10}];
  try {
    e.view.beginUser('', [{name: 'local-name.csv'}]);
    e.view.observe({type: 'message_start', ...context, message: {role: 'user', content: '', attachments}});
    assert.equal(e.host.querySelector('.ac-message-attachment').textContent, attachments[0].name);
    assert.equal(e.host.querySelector('img'), null);
    const records = [{...message('user', '', context, 100), attachments}, message('assistant', 'File received.', context, 110)];
    e.view.history(records);
    assert.equal(e.host.querySelector('[data-role="user"]').hidden, false);
    assert.equal(e.host.querySelector('[data-role="user"] .ac-stream-text').textContent, '');
    assert.equal(e.host.querySelector('.ac-message-attachment').textContent, attachments[0].name);
    e.view.history([message('user', 'Unrelated text', context, 200)]);
    assert.equal(e.host.querySelector('.ac-message-attachments'), null);
    e.view.history(records);
    assert.equal(e.host.querySelectorAll('.ac-message-attachment').length, 1);
  } finally { e.close(); }
});

test('live public text and tools retain observed order, duplicate text, exact user text and closed raw results', async () => {
  const e = environment(), pi = e.window.AthenaPiActivity.create({ now: () => 2000 });
  const off = pi.subscribe(snapshot => { if (snapshot.sequence) e.view.render(snapshot); });
  const context = owner(), send = event => { e.view.observe({ ...event, ...context }); pi.receive({ ...event, ...context }); };
  try {
    const literal = 'Keep task-child-1 and 2026-11-24 exactly.\n[Attached file: literal.csv]';
    e.view.beginUser(literal, [{ name: 'task-2026.csv' }]);
    send({ type: 'agent_start' });
    send({ type: 'message_start', message: { role: 'user', content: literal, timestamp: 1000 } });
    send({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1100 } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'PRIVATE REASONING MUST NOT APPEAR' } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Checking the input.' } });
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Checking the input.' }] } });
    send({ type: 'tool_execution_start', toolCallId: 'read-one', toolName: 'read', args: { path: 'task-2026.csv' } });
    const row = e.host.querySelector('[data-ap-tool="read-one"]'); row.open = true;
    send({ type: 'tool_execution_end', toolCallId: 'read-one', toolName: 'read', result: { content: [{ type: 'text', text: 'private-task-value' }] } });
    send({ type: 'message_start', message: { role: 'assistant', content: [] } });
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Checking the input.' }] } });
    send({ type: 'agent_settled' });
    assert.deepEqual(order(e.host), ['user:' + literal, 'text:Checking the input.', 'tool:read-one', 'text:Checking the input.']);
    assert.equal(e.host.querySelector('[data-ap-tool="read-one"]'), row, 'Updates preserve the keyed tool row.');
    assert.equal(row.open, true);
    assert.equal(row.querySelector('[data-aw-diagnostics]').open, false);
    assert.equal(row.querySelector('[data-ap-state]').textContent, 'Complete');
    assert.equal(e.host.textContent.includes('PRIVATE REASONING'), false);
    e.click(row.querySelector('[data-ap-copy="output"]')); await Promise.resolve();
    assert.equal(e.copied[0], 'private-task-value');
    e.view.reset(); e.view.beginUser('Next request');
    assert.deepEqual(order(e.host).slice(0, 4), ['user:' + literal, 'text:Checking the input.', 'tool:read-one', 'text:Checking the input.'], 'A new request does not flatten the prior tool/message sequence.');
  } finally { off(); pi.destroy(); e.close(); }
});

test('a message that first emits text after a tool stays after that tool', () => {
  const e = environment(), pi = e.window.AthenaPiActivity.create();
  const off = pi.subscribe(snapshot => { if (snapshot.sequence) e.view.render(snapshot); });
  try {
    pi.receive({ type: 'agent_start', ...owner() });
    pi.receive({ type: 'message_start', ...owner(), message: { role: 'assistant', content: [] } });
    pi.receive({ type: 'tool_execution_start', ...owner(), toolCallId: 'first-action', toolName: 'read', args: { path: 'input.csv' } });
    pi.receive({ type: 'message_update', ...owner(), assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Now I can report the file.' } });
    assert.deepEqual(order(e.host), ['tool:first-action', 'text:Now I can report the file.']);
  } finally { off(); pi.destroy(); e.close(); }
});

test('an observed steering message does not replace the original user request or reorder earlier work', () => {
  const e = environment(), pi = e.window.AthenaPiActivity.create();
  const off = pi.subscribe(snapshot => { if (snapshot.sequence) e.view.render(snapshot); });
  const send = event => { e.view.observe({ ...event, ...owner() }); pi.receive({ ...event, ...owner() }); };
  try {
    e.view.beginUser('First instruction'); send({ type: 'agent_start' });
    send({ type: 'message_start', message: { role: 'user', content: 'First instruction' } });
    send({ type: 'message_start', message: { role: 'assistant', content: [] } });
    send({ type: 'message_end', message: { role: 'assistant', content: 'Initial observation.' } });
    send({ type: 'message_start', message: { role: 'user', content: 'Keep the original zero value.' } });
    send({ type: 'message_start', message: { role: 'assistant', content: [] } });
    send({ type: 'message_end', message: { role: 'assistant', content: 'The zero value is retained.' } });
    assert.deepEqual(order(e.host), ['user:First instruction', 'text:Initial observation.', 'user:Keep the original zero value.', 'text:The zero value is retained.']);
  } finally { off(); pi.destroy(); e.close(); }
});

test('hydrated multi-turn history restores tool results in place and does not deduplicate identical assistant messages', () => {
  const e = environment(), first = owner(), second = owner('run-two', 'attempt-parent-two');
  try {
    const records = [...historyRun(first, 100), message('assistant', 'The result is ready.', first, 210), ...historyRun(second, 300, 'Compare another measurement')];
    records[1].content.unshift({ type: 'thinking', thinking: 'PRIVATE HISTORY' });
    e.view.history(records);
    assert.deepEqual(order(e.host), ['user:Compare the measurement', 'text:I will inspect the file.', 'tool:call-run-one', 'text:The result is ready.', 'text:The result is ready.', 'user:Compare another measurement', 'text:I will inspect the file.', 'tool:call-run-two', 'text:The result is ready.']);
    const rows = e.host.querySelectorAll('[data-ap-tool]');
    assert.equal(rows.length, 2); assert.equal(rows[0].dataset.piStatus, 'succeeded');
    assert.equal(rows[0].querySelector('[data-aw-diagnostics]').open, false);
    assert.equal(e.host.textContent.includes('PRIVATE HISTORY'), false);
    e.view.clear(); e.view.history(records);
    assert.equal(e.host.querySelectorAll('[data-ap-tool]').length, 2, 'Restart hydration retains one row per normalized call ID.');
  } finally { e.close(); }
});

test('child attempts stay with the originating request; retries preserve prior failures, successful siblings and moved controls', async () => {
  const e = environment(), first = owner(), second = owner('run-two', 'attempt-parent-two');
  const task = { id: 'child-one', parentTaskId: first.taskId, runId: first.runId, title: 'Inspect voltage CSV', status: 'failed', attemptId: 'child-attempt-one', retryable: true };
  const attempt = { id: task.attemptId, taskId: task.id, parentTaskId: task.parentTaskId, runId: first.runId, status: 'failed', acceptedAt: 130, error: 'Column was not found.' };
  const tool = { id: 'csv-tool-one', taskId: task.id, attemptId: attempt.id, runId: first.runId, sdkToolName: 'calculate_csv', name: 'calculate_csv', args: { column: 'voltage' }, status: 'succeeded', logs: [{ at: 140, text: 'Calculated four values.' }], command: '', cwd: '/assigned', source: 'task-manager' };
  const sibling = { ...task, id: 'successful-sibling', title: 'Calculate circuit response', status: 'succeeded', attemptId: 'sibling-attempt', retryable: false };
  const siblingAttempt = { ...attempt, id: sibling.attemptId, taskId: sibling.id, status: 'succeeded', acceptedAt: 135, error: null };
  const receipt = { id: 'rc-result-file', attemptId: siblingAttempt.id, name: 'rc-response.json', mimeType: 'application/json', mcpAlias: 'calculate_rc_response', sessionId: 'session-one' };
  const process = { id: 'rc-process', processId: 'rc-process', attemptId: siblingAttempt.id, taskId: sibling.id, runId: first.runId, status: 'succeeded', job: { artifact: receipt, mcp: { registryVersion: 1, server: 'athena-circuits', tool: 'calculate_rc_response', alias: 'calculate_rc_response', resultKind: 'rc-step-response', version: '1.0.0', protocol: '2025-06-18' } } };
  const artifact = { id: receipt.id, title: 'RC response', taskId: sibling.id, attemptId: siblingAttempt.id, processId: process.id, sessionId: 'session-one', file: receipt, location: { uri: '/api/artifacts/session-one/rc-result-file' } };
  e.state = { ...e.state, tasks: [task, sibling], attempts: [attempt, siblingAttempt], tools: [tool], processes: [process], artifacts: [artifact] };
  let update, retries = 0; const navigations = [];
  const store = { getState: () => e.state, subscribe(fn) { update = fn; fn(e.state); return () => {}; }, retryTask(id) { assert.equal(id, task.id); retries++; } };
  e.view.history([...historyRun(first, 100), ...historyRun(second, 300)]);
  const chrome = e.window.AthenaWorkspaceChrome.mount(e.document.querySelector('#root'), { store, placeActivity: e.view.placeActivity, removeActivity: e.view.removeActivity, hasConversationTool: e.view.hasTool, onNavigate: (...args) => navigations.push(args) });
  try {
    const firstCard = e.host.querySelector('[data-aw-attempt="child-attempt-one"]');
    assert.ok(firstCard, 'The child is inline, not collected below the whole conversation.');
    assert.ok(order(e.host).indexOf('attempt:child-attempt-one') < order(e.host).lastIndexOf('user:Compare the measurement'), 'Repeated user text is linked by owner, not text matching.');
    assert.match(firstCard.querySelector('[data-aw-event-tool] > summary').textContent, /CSV statistics calculated/);
    e.click(firstCard.querySelector('[data-aw-retry]')); assert.equal(retries, 1);
    e.click(firstCard.querySelector('[data-aw-task-details]')); assert.equal(navigations[0][0], 'workflow');
    e.click(firstCard.querySelector('[data-aw-tool-action="copy-log"]')); await Promise.resolve(); assert.match(e.copied[0], /Calculated four values/);
    const siblingCard = e.host.querySelector('[data-aw-attempt="sibling-attempt"]');
    assert.equal(siblingCard.querySelector('a[download]').getAttribute('href'), artifact.location.uri);
    e.state = { ...e.state, revision: 2, tasks: [{ ...task, attemptId: 'child-attempt-two', status: 'running', retryable: false }, sibling], attempts: [attempt, siblingAttempt, { ...attempt, id: 'child-attempt-two', status: 'running', acceptedAt: 250, error: null }] };
    update(e.state);
    const previous = e.host.querySelector('[data-aw-attempt="child-attempt-one"]'), retry = e.host.querySelector('[data-aw-attempt="child-attempt-two"]');
    assert.equal(previous.querySelector('.aw-attempt-heading [data-status]').dataset.status, 'failed');
    assert.equal(previous.querySelector('[data-aw-retry]'), null, 'A historical failed attempt cannot trigger the latest task retry.');
    assert.equal(retry.querySelector('.aw-attempt-heading [data-status]').dataset.status, 'running');
    assert.match(previous.querySelector('[data-aw-event-tool] > summary').textContent, /CSV statistics calculated/, 'Successful tools retain their own outcome during retry.');
    assert.deepEqual(order(e.host).filter(item => item.startsWith('attempt:')), ['attempt:child-attempt-one', 'attempt:sibling-attempt', 'attempt:child-attempt-two']);
    const preservedSibling = e.host.querySelector('[data-aw-attempt="sibling-attempt"]');
    assert.equal(preservedSibling, siblingCard);
    assert.equal(preservedSibling.querySelector('.aw-attempt-heading [data-status]').dataset.status, 'succeeded');
    assert.equal(preservedSibling.querySelector('a[download]').getAttribute('href'), artifact.location.uri, 'The same published file stays downloadable while another child retries.');
  } finally { chrome.destroy(); e.close(); }
});

test('consecutive actions are folded together between public messages, with separate disclosure for each turn', () => {
  const e = environment(), first = owner(), second = owner('run-two','parent-two');
  try {
    const records = historyRun(first, 10);
    records[1].content.push({type:'toolCall', id:'other-call', name:'read', arguments:{path:'data.csv'}});
    e.view.history([...records, ...historyRun(second, 300)]);
    const groups=() => [...e.host.querySelectorAll('.ac-stream-activity')];
    assert.equal(groups().length,2);
    assert.match(groups()[0].firstElementChild.textContent,/2 steps/);
    assert.ok(groups().every(group=>!group.open));
    assert.equal(e.host.querySelector('[data-role="assistant"] .ac-stream-text').closest('details'),null);
    groups()[0].open=true;
    e.view.history([...records, ...historyRun(second, 300)]);
    assert.equal(groups()[0].open,true);assert.equal(groups()[1].open,false);
    e.view.revealTool('call-run-two');
    assert.equal(groups()[1].open,true);
  } finally { e.close(); }
});

test('a settled history refresh preserves the opened call only in its owning attempt', () => {
  const e = environment(), first = owner(), records = historyRun(first, 100);
  try {
    e.view.history(records);
    const row = () => e.host.querySelector('[data-ap-tool]');
    row().open = true; row().querySelector('[data-aw-diagnostics]').open = true;
    e.view.history(records);
    assert.equal(row().open, true);
    assert.equal(row().querySelector('[data-aw-diagnostics]').open, true);
    e.view.history(historyRun(owner('run-one', 'another-attempt'), 300));
    assert.equal(row().open, false);
  } finally { e.close(); }
});

test('unmatched ownership is kept in fallback and session/branch changes remove prior inline activity', () => {
  const e = environment(), context = owner();
  try {
    e.view.history(historyRun(context, 100));
    const card = e.document.createElement('section'); card.dataset.awAttempt = 'attempt-child'; card.textContent = 'Original child work';
    e.view.placeActivity(card, { runId: context.runId, attemptId: 'attempt-child', at: 130 });
    assert.ok(e.host.contains(card));
    e.view.history([message('user', 'Unknown owner'), message('assistant', 'Legacy answer')]);
    assert.equal(card.parentElement, e.fallback, 'An unmatched history branch does not leave stale work under a new turn.');
    const replacement = e.document.createElement('section'); replacement.dataset.awAttempt = 'attempt-child';
    e.view.placeActivity(replacement, { runId: context.runId, attemptId: 'attempt-child', at: 130 });
    assert.equal(card.isConnected, false);
    assert.equal(e.fallback.querySelectorAll('[data-aw-attempt]').length, 1);
    e.view.clear();
    e.view.history(historyRun(owner('different-run', 'different-attempt'), 400, 'Different conversation'));
    assert.equal(e.host.textContent.includes('Original child work'), false);
    assert.equal(e.host.querySelectorAll('[data-aw-attempt]').length, 0);
    assert.equal(e.fallback.querySelectorAll('[data-aw-attempt]').length, 0);
  } finally { e.close(); }
});

test('history layout transaction captures the old transcript before clear and encloses its nested render', () => {
  const events = []; let depth = 0, e;
  const hooks = {
    onBeforeLayout() { events.push({ phase: 'before', depth: depth++, text: e.host.textContent }); },
    onAfterLayout() { events.push({ phase: 'after', depth: --depth, text: e.host.textContent }); }
  };
  e = environment(hooks);
  try {
    e.view.history([message('user', 'Earlier request retained for reading.', owner(), 100), message('assistant', 'Earlier response.', owner(), 110)]);
    events.length = 0;
    e.view.history([message('user', 'Newly hydrated request.', owner(), 100), message('assistant', 'Complete hydrated response.', owner(), 110)]);
    assert.equal(events[0].phase, 'before'); assert.equal(events[0].depth, 0);
    assert.match(events[0].text, /Earlier request retained for reading/);
    assert.deepEqual(events.map(event => [event.phase, event.depth]), [['before', 0], ['before', 1], ['after', 1], ['after', 0]]);
    assert.match(events.at(-1).text, /Complete hydrated response/); assert.equal(depth, 0);
  } finally { e.close(); }
});

test('separate host snapshots begin layout before replacing an already inline child card', () => {
  const events = []; let depth = 0, e;
  const hooks = {
    onBeforeLayout() { events.push({ phase: 'before', depth: depth++, text: e.host.textContent }); },
    onAfterLayout() { events.push({ phase: 'after', depth: --depth, text: e.host.textContent }); }
  };
  e = environment(hooks); e.view.history(historyRun(owner(), 100));
  const child = { id: 'child-layout', parentTaskId: owner().taskId, runId: 'run-one', title: 'Calculate measurements', status: 'running', attemptId: 'attempt-layout' };
  const attempt = { id: child.attemptId, taskId: child.id, parentTaskId: child.parentTaskId, runId: child.runId, status: 'running', acceptedAt: 130, result: 'Short prior child result.' };
  e.state = { ...e.state, tasks: [child], attempts: [attempt] };
  let update; const store = { getState: () => e.state, subscribe(fn) { update = fn; fn(e.state); return () => {}; } };
  const chrome = e.window.AthenaWorkspaceChrome.mount(e.document.querySelector('#root'), { store, ...hooks, placeActivity: e.view.placeActivity, removeActivity: e.view.removeActivity, hasConversationTool: e.view.hasTool });
  try {
    const originalCard = e.host.querySelector('[data-aw-attempt="attempt-layout"]'); assert.ok(originalCard);
    events.length = 0;
    const newResult = 'Updated child result with saved calculation and output details.';
    e.state = { ...e.state, revision: 2, attempts: [{ ...attempt, status: 'succeeded', result: newResult }] };
    update(e.state);
    assert.equal(e.host.querySelector('[data-aw-attempt="attempt-layout"]'), originalCard);
    assert.match(events[0].text, /Short prior child result/);
    assert.equal(events[0].text.includes(newResult), false, 'The outer scroll owner observes height before existing card contents grow.');
    assert.deepEqual(events.map(event => [event.phase, event.depth]), [['before', 0], ['before', 1], ['after', 1], ['after', 0]]);
    assert.match(events.at(-1).text, /Updated child result/); assert.equal(depth, 0);
    assert.throws(() => update({ ...e.state, revision: 3, tools: null }), /filter/);
    assert.equal(depth, 0, 'A failed host render still releases the scroll transaction.');
    update({ ...e.state, revision: 4 }); assert.equal(depth, 0);
  } finally { chrome.destroy(); e.close(); }
});

test('stream render and history failures always close layout hooks before a later successful update', () => {
  let depth = 0, before = 0, after = 0, fail = false;
  const e = environment({
    onBeforeLayout() { depth++; before++; }, onAfterLayout() { depth--; after++; },
    getWorkspace() { if (fail) throw new Error('Injected workspace read failure'); return null; }
  });
  try {
    fail = true;
    assert.throws(() => e.view.beginUser('A retained draft'), /Injected workspace read failure/);
    assert.equal(depth, 0); assert.equal(before, after);
    assert.throws(() => e.view.history({ not: 'messages' }), /entries/);
    assert.equal(depth, 0); assert.equal(before, after);
    fail = false; e.view.history([message('assistant', 'Rendering recovered.', owner(), 200)]);
    assert.equal(depth, 0); assert.equal(before, after); assert.match(e.host.textContent, /Rendering recovered/);
  } finally { e.close(); }
});
