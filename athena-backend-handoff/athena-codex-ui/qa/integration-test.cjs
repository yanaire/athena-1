#!/usr/bin/env node
'use strict';

/**
 * Athena UI integration checks, using the real app fragment and source scripts.
 * Run: node qa/integration-test.cjs
 *
 * This is a deterministic Node + LinkeDOM DOM test, NOT a browser or visual test.
 * No browser, HTTP server, external request, simulator, or Figma API is used.
 * Media queries, frame timing, WAAPI, layout, focus and absent form APIs are
 * explicitly mocked below. CSS rendering and actual accessibility behavior are
 * outside this test's evidence. The JSON result repeats those limitations.
 */

const assert = require('node:assert/strict');
// LinkeDOM nodes point at the entire document. Keep failed identity assertions
// precise instead of asking Node to inspect a large cyclic application tree.
const strictEqual = assert.equal;
assert.equal = (actual, expected, message) => {
  if (actual?.nodeType || expected?.nodeType) {
    const describe = value => value?.nodeType ? value.nodeName + (value.id ? '#' + value.id : '') + (value.className ? '.' + String(value.className).trim().replace(/\s+/g, '.') : '') : String(value);
    return strictEqual(actual === expected, true, message || 'Expected the same DOM node: actual ' + describe(actual) + '; expected ' + describe(expected));
  }
  return strictEqual(actual, expected, message);
};
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { File } = require('node:buffer');
const { setMaxListeners } = require('node:events');
const dependencyPaths = [__dirname, '/workspace/scratch/79c4ece81d27/athena-codex-ui/qa'];
const { parseHTML } = require(require.resolve('linkedom', { paths: dependencyPaths }));
const linkedomVersion = require(require.resolve('linkedom/package.json', { paths: dependencyPaths })).version;

const appDir = path.resolve(__dirname, '..');
const buildSource = fs.readFileSync(path.join(appDir, 'build.py'), 'utf8');
const buildScripts = JSON.parse(buildSource.match(/^JS_FILES\s*=\s*(\[[^\n]+\])/m)?.[1] || '[]');
const buildStyles = JSON.parse(buildSource.match(/^CSS_FILES\s*=\s*(\[[^\n]+\])/m)?.[1] || '[]');
assert.ok(buildScripts.length && buildScripts.includes('ui/workspace-store.js'), 'Read the current build JS_FILES list.');
const sourceNames = ['build.py', 'app.html', ...buildScripts, ...buildStyles, 'vendor/lucide.min.js', 'integrations/athena-host.js', 'qa/host-restart-snapshot.json'];
// One immutable snapshot per run. A concurrent app edit cannot mix revisions.
const sources = Object.fromEntries(sourceNames.map(name => [name, fs.readFileSync(path.join(appDir, name), 'utf8')]));
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const sourceHashes = Object.fromEntries(sourceNames.map(name => [name, sha(sources[name])]));
const results = [];
const tests = [];
const environments = [];
const mocks = [
  'matchMedia: controlled prefers-reduced-motion state; no actual OS preference.',
  'requestAnimationFrame, performance.now and timers: deterministic virtual 60 Hz clock.',
  'Web Animations API: lifecycle/finish/cancel only; no interpolation or rendering.',
  'Geometry, getComputedStyle, ResizeObserver: fixed approximate boxes and manual resize notifications; scrollIntoView calls are recorded without scrolling; CSS is not rendered.',
  'Focus/activeElement/focus events, tabIndex reflection, textarea selection/range editing, select values, native details toggling and abortable DOM listeners are compatibility shims for LinkeDOM.',
  'Native form submission defaults and constraint validation are not simulated; form submit events are dispatched explicitly to exercise application validation.',
  'Lucide icon replacement is a no-op; accessibility assertions check DOM attributes, not a browser accessibility tree or screen reader.',
  'File input changes use real Node File objects in a supplied array; no native file picker, upload, or file-system access is exercised.',
  'localStorage, clipboard, window.open, object URLs and anchor downloads are in-memory records; no external page, OS clipboard, PDF viewer, or downloaded file is opened.',
];

class Clock {
  constructor() { this.now = 0; this.nextId = 1; this.jobs = new Map(); this.microtasks = []; }
  schedule(fn, delay, kind, args = []) {
    const id = this.nextId++;
    this.jobs.set(id, { id, fn, args, kind, delay: Math.max(1, Number(delay) || 0), at: this.now + Math.max(1, Number(delay) || 0) });
    return id;
  }
  timeout(fn, delay, ...args) { return this.schedule(fn, delay, 'timeout', args); }
  interval(fn, delay, ...args) { return this.schedule(fn, delay, 'interval', args); }
  raf(fn) { return this.schedule(fn, 1000 / 60, 'raf'); }
  clear(id) { this.jobs.delete(id); }
  microtask(fn) { this.microtasks.push(fn); }
  flush() {
    let count = 0;
    while (this.microtasks.length) {
      assert.ok(++count < 10000, 'mock microtask queue must terminate');
      this.microtasks.shift()();
    }
  }
  advance(milliseconds) {
    const until = this.now + milliseconds;
    this.flush();
    let count = 0;
    while (true) {
      let next;
      for (const job of this.jobs.values()) {
        if (job.at <= until && (!next || job.at < next.at || (job.at === next.at && job.id < next.id))) next = job;
      }
      if (!next) break;
      assert.ok(++count < 100000, 'mock timer/RAF queue must terminate');
      this.now = next.at;
      if (next.kind === 'interval') next.at += next.delay;
      else this.jobs.delete(next.id);
      if (next.kind === 'raf') next.fn(this.now);
      else next.fn(...next.args);
      this.flush();
    }
    this.now = until;
    this.flush();
  }
  counts() {
    const result = { raf: 0, timeout: 0, interval: 0, microtasks: this.microtasks.length };
    for (const job of this.jobs.values()) result[job.kind]++;
    return result;
  }
}

// LinkeDOM shares DOM prototypes between documents. Shims look up the owning
// document's harness, so each test keeps its own isolated clock and state.
const domTypes = parseHTML('<html><body></body></html>');
const ElementProto = domTypes.HTMLElement.prototype;
const EventTargetProto = domTypes.EventTarget.prototype;
const originalAdd = EventTargetProto.addEventListener;
const originalRemove = EventTargetProto.removeEventListener;
Object.defineProperty(ElementProto, 'open', { configurable: true, get() { return this.hasAttribute('open'); }, set(value) { this.toggleAttribute('open', Boolean(value)); } });
// LinkeDOM 0.18.15 reads an explicit tabindex="0" as -1. Reflect zero
// correctly, including the native default tab stop on interactive elements.
Object.defineProperty(ElementProto, 'tabIndex', { configurable: true,
  get() {
    const attribute = this.getAttribute('tabindex');
    const parsed = attribute === null ? NaN : Number.parseInt(attribute, 10);
    if (Number.isFinite(parsed)) return parsed;
    return this.matches('button,input,select,textarea,summary,a[href],area[href],iframe,[contenteditable="true"]') ? 0 : -1;
  },
  set(value) { this.setAttribute('tabindex', String(value)); }
});
EventTargetProto.addEventListener = function (type, handler, options) {
  if (options?.signal?.aborted) return;
  originalAdd.call(this, type, handler, options);
  const env = harnessOf(this) || this._qaHarness;
  const capture = Boolean(typeof options === 'boolean' ? options : options?.capture);
  if (env?.trackingListeners && ![...env.listenerRecords].some(record => record.target === this && record.type === type && record.handler === handler && record.capture === capture)) {
    env.listenerRecords.add({ target: this, type, handler, capture });
  }
  if (options?.signal) {
    const target = this;
    options.signal.addEventListener('abort', () => target.removeEventListener(type, handler, options), { once: true });
  }
};
EventTargetProto.removeEventListener = function (type, handler, options) {
  originalRemove.call(this, type, handler, options);
  const env = harnessOf(this) || this._qaHarness;
  const capture = Boolean(typeof options === 'boolean' ? options : options?.capture);
  for (const record of env?.listenerRecords || []) {
    if (record.target === this && record.type === type && record.handler === handler && record.capture === capture) env.listenerRecords.delete(record);
  }
};

function harnessOf(node) { return node.ownerDocument?._qaHarness; }
function fire(node, type, properties = {}) {
  const env = harnessOf(node) || node._qaHarness;
  const event = new env.window.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { configurable: true, value });
  node.dispatchEvent(event);
  env.clock.flush();
  return event;
}
const originalAnchorClick = domTypes.HTMLAnchorElement.prototype.click;
domTypes.HTMLAnchorElement.prototype.click = function () {
  const env = harnessOf(this);
  if (env && (this.download || this.hasAttribute('download'))) {
    env.downloads.push({ name: this.download || this.getAttribute('download'), href: this.href });
    return;
  }
  originalAnchorClick.call(this);
};
ElementProto.focus = function () {
  const env = harnessOf(this);
  if (!env || env.activeElement === this) return;
  const previous = env.activeElement;
  env.activeElement = this;
  if (previous) { fire(previous, 'blur', { relatedTarget: this }); fire(previous, 'focusout', { relatedTarget: this }); }
  fire(this, 'focus', { relatedTarget: previous });
  fire(this, 'focusin', { relatedTarget: previous });
};
ElementProto.blur = function () {
  const env = harnessOf(this);
  if (env?.activeElement === this) {
    env.activeElement = env.document.body;
    fire(this, 'blur', { relatedTarget: env.document.body });
    fire(this, 'focusout', { relatedTarget: env.document.body });
  }
};
for (const prototype of [domTypes.HTMLTextAreaElement.prototype, domTypes.HTMLInputElement.prototype]) {
  for (const key of ['selectionStart', 'selectionEnd']) {
    Object.defineProperty(prototype, key, { configurable: true,
      get() { return this['_qa_' + key] ?? this.value.length; },
      set(value) { this['_qa_' + key] = Math.max(0, Math.min(this.value.length, Number(value) || 0)); },
    });
  }
  prototype.setSelectionRange = function (start, end) { this.selectionStart = start; this.selectionEnd = end; };
  prototype.setRangeText = function (replacement, start, end, selectionMode = 'preserve') {
    const oldStart = this.selectionStart, oldEnd = this.selectionEnd;
    this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
    if (selectionMode === 'end') this.setSelectionRange(start + replacement.length, start + replacement.length);
    else if (selectionMode === 'start') this.setSelectionRange(start, start);
    else if (selectionMode === 'select') this.setSelectionRange(start, start + replacement.length);
    else this.setSelectionRange(oldStart, oldEnd);
  };
}
Object.defineProperty(domTypes.HTMLSelectElement.prototype, 'value', {
  configurable: true,
  get() { return Array.from(this.options).find(option => option.hasAttribute('selected'))?.value || this.options[0]?.value || ''; },
  set(value) { for (const option of this.options) option.toggleAttribute('selected', option.value === String(value)); },
});
Object.defineProperty(domTypes.HTMLSelectElement.prototype, 'selectedOptions', {
  configurable: true,
  get() { return Array.from(this.options).filter(option => option.hasAttribute('selected')); },
});

function approximateBox(node) {
  const env = harnessOf(node);
  const width = env?.width || 1440;
  const root = env?.document.getElementById('athena-codex');
  const leftWidth = parseFloat(root?.style.getPropertyValue('--ac-left-width')) || 240;
  const rightWidth = parseFloat(root?.style.getPropertyValue('--ac-right-width')) || 440;
  if (node.id === 'athena-codex' || node === env?.document.body || node === env?.document.documentElement) return { x: 0, y: 0, width, height: env?.height || 1000 };
  if (node.id === 'ac-sidebar') return { x: 0, y: 0, width: leftWidth, height: 1000 };
  if (node.id === 'ac-research-panel') return { x: Math.max(0, width - rightWidth), y: 62, width: Math.min(width, rightWidth), height: 938 };
  if (node.id === 'ac-response-chart') return { x: width - 380, y: 230, width: 360, height: 220 };
  if (node.classList?.contains('ac-morph-label')) return { x: 0, y: 0, width: Math.max(60, node.textContent.length * 7), height: 30 };
  if (node.classList?.contains('acm-tools-left')) return { x: 260, y: 930, width: 450, height: 36 };
  if (node.matches?.('button')) return { x: 280, y: 220, width: 120, height: 36 };
  if (node.classList?.contains('ar-loading')) return { x: 0, y: 0, width: 150, height: 24 };
  if (node.classList?.contains('ar-stream-word')) return { x: 0, y: 0, width: Math.max(8, node.textContent.length * 7), height: 23 };
  return { x: 260, y: 150, width: Math.max(280, Math.min(680, width - 280)), height: 150 };
}
ElementProto.getBoundingClientRect = function () {
  const { x, y, width, height } = approximateBox(this);
  return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON() { return { x, y, width, height }; } };
};
ElementProto.getClientRects = function () { return this.closest('[hidden]') ? [] : [this.getBoundingClientRect()]; };
for (const [property, get] of Object.entries({
  clientWidth: function () { return approximateBox(this).width; },
  clientHeight: function () { return approximateBox(this).height; },
  offsetWidth: function () { return approximateBox(this).width; },
  offsetHeight: function () { return this.classList?.contains('ar-stream-word') ? 23 : (parseFloat(this.style.height) || approximateBox(this).height); },
  offsetTop: function () { return this.classList?.contains('ar-text') ? 10 : 0; },
  scrollHeight: function () { return Math.max(48, Math.ceil((this.value || this.textContent || '').length / 50) * 24); },
  scrollTop: function () { return this._qaScrollTop || 0; },
})) Object.defineProperty(ElementProto, property, { configurable: true, get, ...(property === 'scrollTop' ? { set(value) { this._qaScrollTop = value; } } : {}) });
ElementProto.scrollIntoView = function (options) { harnessOf(this)?.scrolls.push({ element: this, options }); };
ElementProto.animate = function (keyframes, options = {}) { return harnessOf(this).animate(this, keyframes, options); };
ElementProto.getAnimations = function ({ subtree } = {}) {
  return [...harnessOf(this).animations].filter(animation => animation.element === this || (subtree && this.contains(animation.element)));
};

function createEnvironment({ width = 1440, height = 1000, reduced = false, storage = new Map(), demo = false, host = null } = {}) {
  const clock = new Clock();
  const parsed = parseHTML('<!doctype html><html><head></head><body>' + sources['app.html'] + '</body></html>');
  const document = parsed.document;
  const window = new parsed.EventTarget();
  const env = { clock, document, window, width, height, storage, reduced, scrolls: [], activeElement: document.body, observers: new Set(), media: new Set(), animations: new Set(), logs: [], networkCalls: [], openedWindows: [], clipboardWrites: [], downloads: [], objectUrls: new Map(), listenerRecords: new Set(), cleanups: [], trackingListeners: false };
  document._qaHarness = env; window._qaHarness = env;
  // A VM's global proxy has a different identity from LinkeDOM's EventTarget.
  // Bind window event methods to the actual target that owns its listener map.
  window.addEventListener = window.addEventListener.bind(window);
  window.removeEventListener = window.removeEventListener.bind(window);
  window.dispatchEvent = window.dispatchEvent.bind(window);
  Object.defineProperty(document, 'defaultView', { configurable: true, get: () => window });
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => env.activeElement });
  Object.defineProperty(window, 'innerWidth', { get: () => env.width });
  Object.defineProperty(window, 'innerHeight', { get: () => env.height });
  document.addEventListener('click', event => {
    const anchor = event.target.closest?.('a[download]');
    if (anchor) { event.preventDefault(); env.downloads.push({ name: anchor.download, href: anchor.href }); }
  });

  class MockResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); env.observers.add(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  class AppAbortController extends AbortController { constructor() { super(); setMaxListeners(0, this.signal); } }
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [1700000000000 + clock.now])); }
    static now() { return 1700000000000 + clock.now; }
  }
  let nextObjectUrl = 1;
  class MockURL extends URL {
    static createObjectURL(blob) { const url = 'blob:athena-qa-' + nextObjectUrl++; env.objectUrls.set(url, blob); return url; }
    static revokeObjectURL(url) { env.objectUrls.delete(url); }
  }
  const mediaQuery = query => {
    const listeners = new Set();
    const mql = { media: query, matches: env.reduced,
      addEventListener(type, callback) { if (type === 'change') listeners.add(callback); },
      removeEventListener(type, callback) { if (type === 'change') listeners.delete(callback); },
      addListener(callback) { listeners.add(callback); }, removeListener(callback) { listeners.delete(callback); }, listeners,
    };
    env.media.add(mql); return mql;
  };
  env.animate = (element, keyframes, options) => {
    let timer;
    const animation = { element, keyframes, options, playState: 'running', onfinish: null,
      cancel() { clock.clear(timer); this.playState = 'idle'; env.animations.delete(this); },
      finish() { if (this.playState !== 'running') return; clock.clear(timer); this.playState = 'finished'; env.animations.delete(this); this.onfinish?.(); },
    };
    env.animations.add(animation);
    timer = clock.timeout(() => animation.finish(), (options.delay || 0) + (options.duration || 0));
    return animation;
  };
  const computedStyle = element => new Proxy({
    getPropertyValue: name => element.style.getPropertyValue(name) || '',
    lineHeight: element.style.lineHeight || '23.8px',
    columnGap: '8px', opacity: element.style.opacity || '1', transform: element.style.transform || 'none',
  }, { get(target, name) { return target[name] ?? element.style[name] ?? ''; } });
  const blockedNetwork = (...args) => { env.networkCalls.push(String(args[0])); throw new Error('Network calls are outside this local DOM integration test.'); };
  Object.assign(window, {
    document, window, self: window, crypto: crypto.webcrypto,
    Event: parsed.Event, CustomEvent: parsed.CustomEvent,
    Element: parsed.Element, HTMLElement: parsed.HTMLElement, Node: parsed.Node,
    navigator: { platform: 'Linux x86_64', clipboard: { writeText(text) { env.clipboardWrites.push(text); return Promise.resolve(); } } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    open: (...args) => { env.openedWindows.push(args); return null; },
    console: { log: (...args) => env.logs.push(['log', ...args]), warn: (...args) => env.logs.push(['warn', ...args]), error: (...args) => env.logs.push(['error', ...args]) },
    AbortController: AppAbortController, AbortSignal,
    performance: { now: () => clock.now }, Date: FakeDate,
    setTimeout: clock.timeout.bind(clock), clearTimeout: clock.clear.bind(clock),
    setInterval: clock.interval.bind(clock), clearInterval: clock.clear.bind(clock),
    requestAnimationFrame: clock.raf.bind(clock), cancelAnimationFrame: clock.clear.bind(clock),
    queueMicrotask: clock.microtask.bind(clock), matchMedia: mediaQuery,
    getComputedStyle: computedStyle, ResizeObserver: MockResizeObserver,
    URL: MockURL, Blob, File, btoa, atob, fetch: blockedNetwork, XMLHttpRequest: function () { blockedNetwork('XMLHttpRequest'); },
    lucide: { createIcons() {} },
  });
  window.globalThis = window;
  if (host) Object.assign(window, { AthenaHosted: true, fetch: host.fetch, EventSource: host.EventSource });
  const context = vm.createContext(window, { name: 'Athena DOM integration — no browser' });
  env.trackingListeners = true;
  for (const name of buildScripts) new vm.Script(sources[name], { filename: name }).runInContext(context);
  if (host) new vm.Script(sources['integrations/athena-host.js'], { filename: 'integrations/athena-host.js' }).runInContext(context);
  env.q = selector => { const found = document.querySelector(selector); assert.ok(found, 'Expected DOM element: ' + selector); return found; };
  env.qa = selector => [...document.querySelectorAll(selector)];
  env.click = selector => {
    const element = typeof selector === 'string' ? env.q(selector) : selector;
    assert.ok(!element.disabled, 'Cannot activate disabled element: ' + (element.id || element.className));
    assert.ok(!element.closest('[hidden]'), 'Cannot activate hidden element: ' + (element.id || element.className));
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      assert.ok(!ancestor.inert, 'Cannot activate an inert background: ' + (element.id || element.className));
      if (ancestor.localName === 'details' && !ancestor.open) {
        const summary = [...ancestor.children].find(child => child.localName === 'summary');
        assert.ok(summary?.contains(element), 'Cannot activate content inside closed details: ' + (element.id || element.className));
      }
    }
    const down = fire(element, 'pointerdown', { pointerType: 'mouse', button: 0 });
    if (!down.defaultPrevented) element.focus();
    fire(element, 'pointerup', { pointerType: 'mouse', button: 0 });
    const click = fire(element, 'click', { detail: 1 });
    const summary = element.closest('summary');
    if (summary?.parentElement?.localName === 'details' && !click.defaultPrevented) {
      const details = summary.parentElement; details.open = !details.open; fire(details, 'toggle');
    }
    return element;
  };
  env.key = (selector, key, extra = {}) => fire(typeof selector === 'string' ? env.q(selector) : selector, 'keydown', { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, ...extra });
  env.type = (selector, value) => { const input = env.q(selector); input.value = value; input.setSelectionRange?.(value.length, value.length); fire(input, 'input'); return input; };
  env.choose = (selector, value) => { const input = env.q(selector); input.value = value; fire(input, 'change'); return input; };
  env.waitFor = async (predicate, message = 'Asynchronous local operation completes') => {
    for (let turn = 0; turn < 30 && !predicate(); turn++) { await new Promise(resolve => setImmediate(resolve)); clock.flush(); }
    assert.ok(predicate(), message);
  };
  env.state = () => window.AthenaApp.getState();
  env.resize = value => {
    env.width = value;
    for (const observer of env.observers) {
      if (observer.targets.size) observer.callback([...observer.targets].map(target => ({ target, contentRect: target.getBoundingClientRect() })), observer);
    }
    fire(window, 'resize'); clock.flush();
  };
  env.setReduced = value => {
    env.reduced = value;
    for (const mql of env.media) { mql.matches = value; for (const callback of mql.listeners) callback({ matches: value, media: mql.media }); }
    clock.flush();
  };
  env.destroy = () => { if (!env.destroyed) { env.destroyed = true; for (const cleanup of env.cleanups.reverse()) cleanup(); window.AthenaHost?.destroy(); window.AthenaApp.destroy(); clock.flush(); } };
  environments.push(env); clock.flush(); if (demo) window.AthenaApp.setDemoMode(true); return env;
}

function test(name, callback) { tests.push({ name, callback }); }
const plain = value => JSON.parse(JSON.stringify(value));

function hostedFixture({ stage = true, restart = false, recovery = false } = {}) {
  const fixture = { stream: null, fail: null, sent: [], files: [], bootstraps: 0, retryRequests: [], snapshotReads: 0 };
  const configuration = { version: 1, provider: 'custom', endpoint: 'https://models.example/v1', defaultModel: 'pinned-model', roleModels: {}, parallelLimit: 1, contextBudget: 32768, outputBudget: 4096 };
  let snapshot = { revision: 1, projectId: 'p1', sessionId: 's1', projects: [{ id: 'p1', name: 'Real project' }], sessions: [{ id: 's1', projectId: 'p1', title: 'Saved conversation' }], run: { id: null, status: 'ready', elapsedMs: 0, startedAt: null, model: null }, tasks: [], agents: [], tools: [], artifacts: [], events: [], approvals: [] };
  // Captured from the real acceptance host on 2026-11-20; local cwd and
  // repetitive historical event rows are omitted from this UI projection.
  if (restart) snapshot = JSON.parse(sources['qa/host-restart-snapshot.json']);
  if (recovery) {
    const scope = { projectId: 'p1', sessionId: 's1', runId: 'recovery-run' };
    snapshot = { ...snapshot, run: { ...snapshot.run, id: scope.runId, status: 'paused' },
      tasks: [{ ...scope, id: 'recovery-root', title: 'Summarize the study', status: 'failed', attemptId: 'root-attempt', parentTaskId: null, retryable: false, dependencies: [] },
        { ...scope, id: 'completed-sibling', title: 'Read the source', status: 'succeeded', attemptId: 'sibling-attempt', parentTaskId: 'recovery-root', retryable: false, dependencies: [] },
        { ...scope, id: 'interrupted-child', title: 'Check measurements', status: 'paused', attemptId: 'interrupted-attempt', parentTaskId: 'recovery-root', retryable: true, dependencies: [] }],
      attempts: [{ ...scope, id: 'root-attempt', taskId: 'recovery-root', status: 'failed' }, { ...scope, id: 'sibling-attempt', taskId: 'completed-sibling', status: 'succeeded', result: 'Source checked.' }, { ...scope, id: 'interrupted-attempt', taskId: 'interrupted-child', status: 'paused', error: 'Host restarted before this task finished.' }],
      tools: [{ ...scope, id: 'retained-tool', taskId: 'interrupted-child', attemptId: 'interrupted-attempt', name: 'read', sdkToolName: 'read', status: 'failed', command: 'read measurements.csv', logs: [{ at: 1, text: 'Prior tool output' }] }],
      artifacts: [{ ...scope, id: 'retained-artifact', taskId: 'completed-sibling', title: 'Checked source', kind: 'text', version: 'v1', text: 'Preserved result' }] };
  }
  fixture.history = new Map([['s1', [{ role: 'user', content: 'Saved question' }, { role: 'assistant', content: [{ type: 'text', text: 'Saved answer' }] }]]]);
  if (restart) fixture.history.set(snapshot.sessionId, [{ role: 'user', content: snapshot.tasks[0].title }, { role: 'assistant', content: 'ATH-18d86b35b3' }]);
  fixture.EventSource = class {
    constructor(url) { assert.equal(url, '/api/events'); fixture.stream = this; this.readyState = 0; }
    open() { this.readyState = 1; this.onopen(); }
    error() { this.readyState = 0; this.onerror(); }
    emit(data) { this.onmessage({ data: JSON.stringify(data) }); }
    close() { this.readyState = 2; }
  };
  fixture.fetch = async (url, options) => {
    if (url === '/api/bootstrap') {
      assert.equal(fixture.stream.readyState, 1, 'SSE must be established before history hydration.');
      fixture.bootstraps++;
      if (fixture.fail === 'bootstrap') return { ok: false, json: async () => ({ error: 'Bootstrap unavailable' }) };
      return { ok: true, json: async () => ({ snapshot, connection: { status: 'configured', configuration }, capabilities: ['create_project', 'create_session', 'open_session', 'set_project_model', 'cancel_run', ...(recovery ? ['retry_task'] : [])], piCapabilities: ['get_state', 'get_messages', 'prompt', 'abort', ...(stage ? ['stage_files'] : [])] }) };
    }
    assert.equal(url, '/api/rpc');
    assert.equal(options.headers['Content-Type'], 'application/json');
    const { method, args } = JSON.parse(options.body);
    if (fixture.fail === method) return { ok: true, json: async () => ({ error: method + ' rejected' }) };
    let result;
    if (method === 'getSnapshot') {
      fixture.snapshotReads++; result = snapshot;
    } else if (method === 'retryTask') {
      fixture.retryRequests.push(plain(args));
      await fixture.holdRetry?.();
      if (fixture.retryError) return { ok: false, json: async () => ({ error: fixture.retryError, code: 'RUN_BUSY' }) };
      assert.equal(args[0], 'interrupted-child');
      assert.equal(args[1].expectedAttemptId, 'interrupted-attempt'); assert.ok(args[1].requestId);
      snapshot = { ...snapshot, revision: snapshot.revision + 1, run: { ...snapshot.run, status: 'running' },
        tasks: snapshot.tasks.map(task => task.id === args[0] ? { ...task, status: 'queued', retryable: false, attemptId: 'retried-attempt' } : task),
        attempts: [...snapshot.attempts, { id: 'retried-attempt', taskId: args[0], status: 'queued', retryOfAttemptId: args[1].expectedAttemptId }, { id: 'reconciliation-attempt', taskId: 'recovery-root', status: 'queued', kind: 'reconciliation' }] };
      result = { taskId: args[0], parentTaskId: 'recovery-root', agentSessionId: 'retry-agent-session', attemptId: 'retried-attempt', runId: snapshot.run.id, status: 'queued', reconciliationAttemptId: 'reconciliation-attempt' };
      // Intentionally no SSE snapshot: the real adapter must refresh state after
      // an immutable receipt even when stream delivery is delayed.
    } else if (method === 'pi') {
      const [sessionId, command] = args;
      if (fixture.fail === command.type) return { ok: true, json: async () => ({ result: { type: 'response', id: command.id, command: command.type, success: false, error: 'Prompt rejected' } }) };
      let data = {};
      if (command.type === 'get_state') data = { sessionId, sessionName: snapshot.sessions.find(s => s.id === sessionId)?.title, isStreaming: false };
      if (command.type === 'get_messages') { await fixture.readHistory?.(); data = { messages: fixture.history.get(sessionId) || [] }; }
      if (command.type === 'prompt') fixture.sent.push({ sessionId, ...command });
      result = { type: 'response', id: command.id, command: command.type, success: true, data };
    } else if (method === 'openSession' || method === 'createSession') {
      const sessionId = method === 'openSession' ? args[0] : 's2';
      if (method === 'createSession') snapshot = { ...snapshot, sessions: [...snapshot.sessions, { id: sessionId, projectId: args[0].projectId, title: args[0].title, model: args[0].model }] };
      snapshot = { ...snapshot, revision: snapshot.revision + 1, sessionId, projectId: snapshot.sessions.find(session => session.id === sessionId).projectId };
      result = { sessionId, projectId: snapshot.projectId, snapshot };
    } else if (method === 'createProject') {
      const project = { id: 'p2', name: args[0].name, defaultModel: args[0].defaultModel };
      snapshot = { ...snapshot, revision: snapshot.revision + 1, projectId: project.id, sessionId: null, projects: [...snapshot.projects, project] };
      result = { project, snapshot };
    } else if (method === 'stageFiles') {
      fixture.files = args[1].map(file => ({ ...file, text: Buffer.from(file.data, 'base64').toString() }));
      result = { fileReferences: fixture.files.map((file, i) => ({ id: 'stored-' + i, projectId: snapshot.projectId, name: file.name, mimeType: file.mimeType, size: Buffer.from(file.data, 'base64').length })) };
    } else if (method === 'saveConfig') {
      fixture.saved = args[0]; result = { saved: true, configurationId: 'config-1', configuration: args[0] };
    } else if (method === 'cancelRun') {
      fixture.cancelledRun = args[0]; result = { cancellationRequested: true };
    } else throw new Error('Unexpected host method: ' + method);
    return { ok: true, json: async () => ({ result }) };
  };
  fixture.startRun = () => {
    snapshot = { ...snapshot, revision: snapshot.revision + 1, run: { ...snapshot.run, id: 'real-run', status: 'running' } };
    fixture.stream.emit({ type: 'snapshot', snapshot });
  };
  return fixture;
}

test('Hosted bootstrap hydrates saved history and pinned unsaved configuration after SSE opens', async () => {
  const host = hostedFixture(), env = createEnvironment({ host });
  assert.equal(env.state().workspace.mode, 'runtime');
  assert.equal(host.bootstraps, 0);
  host.stream.open();
  await env.waitFor(() => env.q('#ac-pi-transcript').textContent.includes('Saved answer'));
  assert.equal(env.qa('#ac-pi-transcript article').length, 2);
  assert.equal(env.q('[name="endpoint"]').value, 'https://models.example/v1');
  assert.equal(env.q('[name="defaultModel"]').value, 'pinned-model');
  for (const name of ['parallelLimit', 'contextBudget', 'outputBudget', 'role-main']) assert.equal(env.q('[name="' + name + '"]').disabled, true);
  env.window.AthenaApp.openSettings('models');
  env.q('.ams-form').dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
  await env.waitFor(() => host.saved);
  assert.deepEqual(host.saved.roleModels, { main: '', researcher: '', analyst: '', reviewer: '', writer: '' });
  assert.equal(host.saved.parallelLimit, 1);
  env.destroy();
});

test('Hosted restart mounts bridge controls with cached markup and renders a completed actual run', async () => {
  const host = hostedFixture({ restart: true }), env = createEnvironment({ host });
  host.stream.open();
  await env.waitFor(() => env.q('#ac-pi-transcript').textContent.includes('ATH-18d86b35b3'));
  assert.equal(env.state().piConnected, true);
  assert.equal(env.state().workspace.run.status, 'succeeded');
  assert.equal(env.state().workspace.tools[0].sdkToolName, 'read');
  assert.equal(env.q('#ac-host-reconnect').hidden, true);
  assert.equal(env.qa('#ac-pi-transcript article').length, 2);
  env.destroy();
});

test('Hosted model hydration preserves fields edited while bootstrap is pending', async () => {
  const host = hostedFixture(), env = createEnvironment({ host });
  env.type('[name="endpoint"]', 'https://draft.example/v1');
  env.type('[name="defaultModel"]', 'unsaved-draft-model');
  host.stream.open();
  await env.waitFor(() => env.q('#ac-pi-transcript').textContent.includes('Saved answer'));
  assert.equal(env.q('[name="endpoint"]').value, 'https://draft.example/v1');
  assert.equal(env.q('[name="defaultModel"]').value, 'unsaved-draft-model');
  assert.equal(env.state().models.saved.defaultModel, 'pinned-model');
  env.destroy();
});

test('Hosted bootstrap errors and detach never expose demo data or accept a demo send', async () => {
  const host = hostedFixture(); host.fail = 'bootstrap';
  const env = createEnvironment({ host });
  host.stream.open();
  await env.waitFor(() => env.q('#ac-pi-session-status').textContent.includes('Bootstrap unavailable'));
  env.window.AthenaApp.detachTaskManager(); env.window.AthenaApp.setDemoMode(true);
  await env.window.AthenaApp.submit('Keep this draft');
  assert.equal(env.state().workspace.mode, 'runtime');
  assert.deepEqual(plain(env.state().workspace.tasks), []);
  assert.deepEqual(plain(env.state().workspace.artifacts), []);
  assert.equal(host.sent.length, 0);
  env.destroy();
});

test('New research can create the first conversation in another project using its default model', async () => {
  const host = hostedFixture(), env = createEnvironment({ host }), app = env.window.AthenaApp;
  const model = { provider: 'athena', modelId: 'empty-project-default' };
  host.stream.open();
  await env.waitFor(() => env.state().workspace.sessionId === 's1');
  await app.createProject({ name: 'Empty project', defaultModel: model });
  await app.openResearchSession('s1');
  env.click('[data-action="new-research"]');
  assert.equal(env.q('#ac-new-project').value, 'p1');
  env.type('#ac-new-project', 'p2');
  env.q('#ac-new-project').dispatchEvent(new env.window.Event('change', { bubbles: true }));
  assert.match(env.q('#ac-new-model').textContent, /empty-project-default/);
  env.type('#ac-new-thread', 'First conversation'); env.click('#ac-dialog-primary');
  await env.waitFor(() => env.state().workspace.sessionId === 's2');
  const sessions = env.state().workspace.sessions;
  assert.equal(sessions.find(session => session.id === 's1').projectId, 'p1');
  assert.deepEqual(plain(sessions.find(session => session.id === 's2')), {id:'s2', projectId:'p2', title:'First conversation', model});
  env.destroy();
});

test('Hosted activations isolate events and restore drafts while new projects have empty workspaces', async () => {
  const host = hostedFixture(), env = createEnvironment({ host });
  host.stream.open();
  await env.waitFor(() => env.q('#ac-pi-transcript').textContent.includes('Saved answer'));
  env.type('#ac-prompt-input', 'First draft');
  await env.window.AthenaApp.createResearch('Second conversation');
  await env.waitFor(() => env.state().piRuntime.session.sessionId === 's2');
  assert.equal(env.state().prompt, '');
  host.stream.emit({ type: 'pi', sessionId: 's1', event: { type: 'message_start', message: { role: 'user', content: 'Old session event' } } });
  assert.equal(env.q('#ac-live-user').hidden, true);
  env.type('#ac-prompt-input', 'Second draft');
  await env.window.AthenaApp.openResearchSession('s1');
  await env.waitFor(() => env.q('#ac-pi-transcript').textContent.includes('Saved answer'));
  assert.equal(env.state().prompt, 'First draft');
  await env.window.AthenaApp.createProject({ name: 'Empty project' });
  assert.equal(env.state().workspace.projectId, 'p2');
  assert.equal(env.state().workspace.sessionId, null);
  assert.equal(env.state().piConnected, false);
  assert.equal(env.q('#ac-pi-transcript').children.length, 0);
  assert.deepEqual(plain(env.state().workspace.tasks), []);
  env.destroy();
});

test('Hosted staging sends actual bytes and rejected prompts retain text and attachments', async () => {
  const host = hostedFixture(), env = createEnvironment({ host });
  host.stream.open();
  await env.waitFor(() => env.state().piRuntime.session.sessionId === 's1');
  const file = new File(['PDF contents'], 'evidence.pdf', { type: 'application/pdf' });
  env.type('#ac-prompt-input', 'Read evidence');
  host.fail = 'prompt';
  await env.window.AthenaApp.submit('Read evidence', { attachments: [file], mentions: [] });
  await env.waitFor(() => !env.state().busy && env.state().prompt === 'Read evidence');
  assert.equal(host.files[0].text, 'PDF contents');
  assert.equal(env.state().prompt, 'Read evidence');
  assert.equal(env.qa('.acm-attachment-chip').length, 1);
  host.fail = null;
  await env.window.AthenaApp.submit('Read evidence', { attachments: [file], mentions: [] });
  await env.waitFor(() => host.sent.length === 1);
  assert.equal(host.sent[0].sessionId, 's1');
  assert.equal(host.sent[0].fileReferences[0].id, 'stored-0');
  env.destroy();
});

test('Hosted reconnect reloads saved history and preserves the current composer draft', async () => {
  const host = hostedFixture(), env = createEnvironment({ host });
  host.stream.open();
  await env.waitFor(() => env.q('#ac-pi-transcript').textContent.includes('Saved answer'));
  env.type('#ac-prompt-input', 'Draft during reconnect');
  host.stream.error();
  assert.equal(env.state().piConnected, false);
  host.history.get('s1').push({ role: 'assistant', content: 'Completed while offline' });
  host.stream.open();
  await env.waitFor(() => env.q('#ac-pi-transcript').textContent.includes('Completed while offline'));
  assert.equal(env.state().prompt, 'Draft during reconnect');
  assert.equal(env.qa('#ac-pi-transcript article').length, 3);
  env.destroy();
});

test('Hosted cancellation targets the confirmed run without inventing a terminal outcome', async () => {
  const host = hostedFixture(), env = createEnvironment({ host });
  host.stream.open();
  await env.waitFor(() => env.state().piRuntime.session.sessionId === 's1');
  host.startRun();
  await env.window.AthenaApp.cancelDemo();
  assert.equal(host.cancelledRun, 'real-run');
  assert.equal(env.state().workspace.run.status, 'running');
  env.destroy();
});

test('Hosted child retry coordinates workflow and inline controls, refreshes the real adapter, and preserves previous work', async () => {
  const host = hostedFixture({ recovery: true }), gate = deferred();
  host.holdRetry = () => gate.promise;
  const env = createEnvironment({ host }); host.stream.open();
  await env.waitFor(() => env.state().workspace.capabilities?.retryTask);
  const before = plain(env.state().workspace);
  env.window.AthenaApp.openWorkspace('workflow', { taskId: 'interrupted-child' });
  assert.match(env.q('[data-aw-task-recovery]').textContent, /Host restarted/);
  env.click('[data-awv-retry="interrupted-child"]');
  assert.equal(env.q('[data-awv-retry="interrupted-child"]').disabled, true);
  assert.equal(env.q('[data-aw-retry="interrupted-child"]').disabled, true);
  fire(env.q('[data-aw-retry="interrupted-child"]'), 'click');
  await env.waitFor(() => host.retryRequests.length === 1);
  assert.equal(host.retryRequests[0][1].expectedAttemptId, 'interrupted-attempt');
  assert.match(env.q('[data-awv-retry="interrupted-child"]').textContent, /Retrying/);
  gate.resolve();
  await env.waitFor(() => env.state().workspace.tasks.find(task => task.id === 'interrupted-child')?.attemptId === 'retried-attempt' && !env.state().workspace.retryOperations['interrupted-child']);
  const after = plain(env.state().workspace);
  assert.equal(host.snapshotReads, 1); assert.equal(host.retryRequests.length, 1);
  assert.equal(after.run.id, before.run.id); assert.equal(env.state().workspaceView.taskId, 'interrupted-child');
  assert.deepEqual(after.tasks.find(task => task.id === 'completed-sibling'), before.tasks.find(task => task.id === 'completed-sibling'));
  assert.deepEqual(after.artifacts, before.artifacts); assert.deepEqual(after.tools, before.tools);
  assert.deepEqual(after.attempts.slice(0, before.attempts.length), before.attempts);
  assert.equal(env.qa('[data-awv-retry]').length, 0); assert.equal(env.qa('[data-aw-task-recovery]').length, 0);
  assert.match(env.q('[data-awv-task-detail]').textContent, /Retry of Attempt 1/);
  env.destroy();
});

test('Hosted retry rejection stays beside the task and reuses the same request from either view', async () => {
  const host = hostedFixture({ recovery: true }); host.retryError = 'Wait for the active run to finish.';
  const env = createEnvironment({ host }); host.stream.open();
  await env.waitFor(() => env.state().workspace.capabilities?.retryTask);
  const attempt = env.q('[data-aw-task-details="interrupted-child"]').closest('[data-aw-attempt]');
  assert.equal(attempt.open, false);
  const activity = attempt.closest('.ac-stream-activity');
  if (activity && !activity.open) env.click(activity.querySelector('summary'));
  env.click(attempt.querySelector('summary'));
  env.click('[data-aw-task-details="interrupted-child"]');
  assert.equal(env.state().workspaceView.taskId, 'interrupted-child');
  env.click('[data-awv-retry="interrupted-child"]');
  await env.waitFor(() => env.qa('[data-awv-retry-error]').length === 1 && !env.q('[data-awv-retry]').disabled);
  assert.match(env.q('[data-awv-retry-error]').textContent, /Wait for the active run/);
  assert.match(env.q('[data-aw-retry-error]').textContent, /Wait for the active run/);
  assert.equal(env.state().workspace.error, null); assert.equal(env.state().workspace.taskManagerStatus, 'connected');
  host.retryError = null;
  env.click('[data-aw-retry="interrupted-child"]');
  await env.waitFor(() => env.state().workspace.tasks.find(task => task.id === 'interrupted-child')?.attemptId === 'retried-attempt');
  assert.deepEqual(host.retryRequests[1], host.retryRequests[0]); assert.equal(host.snapshotReads, 2);
  env.destroy();
});

test('Hidden reconciliation context stays out of hydrated and streaming transcripts while original user text is preserved', async () => {
  const host = hostedFixture();
  const content = JSON.stringify({ taskId: 'internal-recovery-task', attemptId: 'internal-recovery-attempt', artifactIds: ['internal-recovery-artifact'] });
  const internal = { role: 'custom', customType: 'athena-reconciliation', display: false, content };
  host.history.set('s1', [{ role: 'user', content }, internal, { role: 'assistant', content: 'The previous result.' }]);
  const env = createEnvironment({ host }); host.stream.open();
  await env.waitFor(() => env.qa('#ac-pi-transcript article').length === 2);
  assert.equal(env.q('#ac-pi-transcript article[data-role="user"] p').textContent, content);
  assert.equal(env.q('#ac-pi-transcript article[data-role="assistant"] p').textContent, 'The previous result.');
  for (const type of ['message_start', 'message_end']) host.stream.emit({ type: 'pi', sessionId: 's1', event: { type, message: internal } });
  assert.equal(env.qa('#ac-pi-transcript article').length, 2);
  assert.equal(env.q('#ac-live-user').hidden, true, 'Internal context does not create a synthetic user bubble.');
  host.stream.emit({ type: 'pi', sessionId: 's1', event: { type: 'message_start', message: { role: 'user', content } } });
  assert.equal(env.q('#ac-live-user').hidden, true, 'Connected messages now occupy their own transcript position.');
  assert.equal(env.qa('#ac-pi-transcript article[data-role="user"] p').at(-1).textContent, content, 'A real user message is not altered by content heuristics.');
  env.destroy();
});

test('Hosted events received during history hydration reach the active conversation', async () => {
  const host = hostedFixture(), env = createEnvironment({ host });
  host.readHistory = async () => {
    host.readHistory = null;
    for (const event of [
      { type: 'agent_start' },
      { type: 'message_start', message: { id: 'incoming', role: 'assistant', content: [] } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Arrived during hydration' } }
    ]) host.stream.emit({ type: 'pi', sessionId: 's1', event });
  };
  host.stream.open();
  await env.waitFor(() => env.q('.ar-text').textContent === 'Arrived during hydration');
  assert.equal(env.q('#ac-pi-transcript').textContent.includes('Saved answer'), true);
  env.destroy();
});

test('A delayed initial history read cannot erase live work; fresh history restores its prefix and tool sequence once', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp, pending = deferred();
  const context = { projectId: 'timeline-project', sessionId: 'timeline-session', runId: 'timeline-run', taskId: 'timeline-parent', parentTaskId: null, agentSessionId: 'timeline-agent', attemptId: 'timeline-attempt' };
  const prefix = [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }];
  let history = prefix, reads = 0;
  const host = hostFor({ capabilities: ['get_state', 'get_messages'], respond: wire => {
    if (wire.type === 'get_state') return { sessionId: context.sessionId, isStreaming: false };
    if (wire.type === 'get_messages') return ++reads === 1 ? pending.promise : { messages: history };
    return {};
  } });
  app.attachPiTransport(host, { refresh: false }); await app.executePi('get_state');
  const initialRead = app.executePi('get_messages');
  const user = { role: 'user', content: 'Inspect task-2026.csv exactly', timestamp: 100, athena: context };
  const prelude = { role: 'assistant', content: [{ type: 'text', text: 'Inspecting the assigned file.' }, { type: 'toolCall', id: 'timeline-read', name: 'read', arguments: { path: 'task-2026.csv' } }], timestamp: 110, athena: context };
  const result = { role: 'toolResult', toolCallId: 'timeline-read', content: [{ type: 'text', text: 'Observed file text' }], isError: false, timestamp: 120, athena: context };
  const answer = { role: 'assistant', content: [{ type: 'text', text: 'The file was inspected.' }], timestamp: 130, athena: context };
  for (const event of [
    { type: 'agent_start' }, { type: 'message_start', message: user }, { type: 'message_end', message: user },
    { type: 'message_start', message: { ...prelude, content: [] } }, { type: 'message_end', message: prelude },
    { type: 'tool_execution_start', toolCallId: 'timeline-read', toolName: 'read', args: { path: 'task-2026.csv' } },
    { type: 'tool_execution_end', toolCallId: 'timeline-read', toolName: 'read', result }, { type: 'message_end', message: result },
    { type: 'message_start', message: { ...answer, content: [] } }, { type: 'message_end', message: answer }
  ]) host.emit({ ...event, ...context });
  history = [...prefix, user, prelude, result, answer];
  host.emit({ type: 'agent_settled', ...context });
  assert.equal(env.q('#ac-pi-transcript [data-ap-tool="timeline-read"]').dataset.piStatus, 'succeeded');
  pending.resolve({ messages: prefix }); await initialRead;
  env.clock.advance(150);
  await env.waitFor(() => env.q('#ac-pi-transcript').textContent.includes('Earlier answer') && env.q('#ac-pi-transcript').textContent.includes('The file was inspected.'));
  assert.equal(env.qa('#ac-pi-transcript [data-ap-tool="timeline-read"]').length, 1);
  const texts = env.qa('#ac-pi-transcript article p').map(node => node.textContent);
  assert.deepEqual(texts, ['Earlier question', 'Earlier answer', user.content, 'Inspecting the assigned file.', 'The file was inspected.']);
  const flow = [...env.q('#ac-pi-transcript').children].filter(node => !node.hidden);
  const activity = env.q('[data-ap-tool="timeline-read"]').closest('.ac-stream-activity');
  assert.ok(flow.includes(activity));
  assert.ok(flow.indexOf(activity) < flow.indexOf(env.qa('#ac-pi-transcript article').at(-1)));
  assert.equal(env.q('#ac-live-user').hidden, true);
  env.destroy();
});
async function runTest({ name, callback }) {
  const start = Date.now();
  const initialCount = environments.length;
  try { await callback(); results.push({ name, status: 'passed', durationMs: Date.now() - start }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, status: 'failed', durationMs: Date.now() - start, message: error.message, stack: error.stack }); console.error('FAIL ' + name + '\n  ' + error.message); }
  finally { for (const env of environments.slice(initialCount)) { try { env.destroy(); } catch (error) { console.error('Cleanup failed: ' + error.message); } } }
}
function assertPanel(env, tab, artifact) {
  assert.equal(env.state().panelOpen, true);
  assert.equal(env.q('#athena-codex').dataset.panelOpen, 'true');
  assert.equal(env.q('#ac-research-panel').hidden, false);
  assert.equal(env.q('#ac-panel-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(env.state().panelTab, tab);
  assert.equal(env.q('#ac-tab-' + tab).getAttribute('aria-selected'), 'true');
  assert.equal(env.q('#ac-view-' + tab).hidden, false);
  assert.equal(env.qa('.ac-panel-body').filter(element => !element.hidden).length, 1);
  if (artifact) assert.equal(env.state().artifact, artifact);
}

function settingsStorage(preferences, storage = new Map()) {
  storage.set('athena.ui.settings.v1', JSON.stringify(preferences));
  return storage;
}

const workspace = env => env.state().workspace;
const workspaceTask = (env, id) => workspace(env).tasks.find(task => task.id === id);
const pendingApproval = env => workspace(env).approvals.find(approval => approval.status === 'pending');

function assertWorkspaceView(env, view, artifactId) {
  assert.equal(env.state().panelOpen, true);
  assert.equal(env.q('#ac-research-panel').hidden, false);
  assert.equal(env.q('#ac-panel-toggle').getAttribute('aria-expanded'), 'true');
  const sideView = view === 'knowledge' ? 'knowledge' : 'workbench';
  assert.equal(env.state().sideView, sideView);
  assert.equal(env.q('#athena-codex').dataset.sideView, sideView);
  for (const slot of ['surface', 'research', 'workbench', 'knowledge']) assert.equal(env.q('#ac-' + slot + '-slot').hidden, slot !== sideView);
  if (view !== 'knowledge') {
    assert.equal(env.state().workspaceView.view, view);
    assert.equal(env.q('#ac-workbench-slot').dataset.workspaceView, view);
  }
  if (artifactId) {
    assert.equal(env.state().workspaceView.artifactId, artifactId);
    assert.equal(env.q('[data-awv-artifact-select]').value, artifactId);
  }
}

function assertInlineTool(env, toolId) {
  assert.equal(env.state().panelOpen, false, 'Tool details remain inside the conversation.');
  assert.equal(env.q('#ac-research-panel').hidden, true);
  assert.equal(env.q('#ac-panel-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(env.q('#ac-conversation').inert, false);
  assert.equal(env.qa('[data-awv-log],[data-awv-command],[data-awv-exit]').length, 0);
  const content = env.q('[data-aw-tool-details="' + toolId + '"]');
  const details = content.closest('details');
  assert.ok(details, 'Tool inspection uses an inline disclosure.');
  assert.equal(details.open, true);
  assert.ok(env.q('#aw-activity').contains(details));
  return details;
}

function runDemoUI(env) {
  env.window.AthenaApp.setDemoMode(true);
  const thinking = env.q('[data-aw-thinking]');
  if (!thinking.open) env.click(thinking.querySelector('summary'));
  const options = env.q('.aw-demo-options');
  if (!options.open) env.click(options.querySelector('summary'));
  return env.click('[data-aw-action="primary"]');
}

function startToApproval(env) {
  runDemoUI(env);
  env.clock.advance(2250);
  assert.equal(workspace(env).run.status, 'blocked');
  assert.ok(pendingApproval(env));
  assert.equal(env.q('#aw-approval-backdrop').hidden, true, 'An approval never opens itself.');
  return pendingApproval(env);
}

function approvePending(env) {
  const id = pendingApproval(env).id;
  env.window.AthenaApp.openApproval(id);
  env.click('[data-aw-dialog="allow"]');
  assert.equal(env.q('#aw-approval-backdrop').hidden, true);
  assert.equal(workspace(env).approvals.find(approval => approval.id === id).status, 'approved');
}

function completeDemo(env) {
  startToApproval(env); approvePending(env); env.clock.advance(7500);
  assert.equal(workspace(env).run.status, 'succeeded');
}

function assertProjectSidebar(env, open) {
  assert.equal(env.state().leftOpen, open);
  assert.equal(env.q('#athena-codex').dataset.leftOpen, String(open));
  assert.equal(env.q('#ac-sidebar').hidden, !open);
  assert.equal(env.q('#ac-left-toggle').hidden, open);
  assert.equal(env.q('#ac-left-toggle').getAttribute('aria-expanded'), String(open));
  assert.equal(env.q('#ac-sidebar-collapse').getAttribute('aria-expanded'), String(open));
  assert.equal(!!env.q('#ac-sidebar-collapse').closest('[hidden]'), !open);
}

function localValue(value) { return JSON.parse(JSON.stringify(value)); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function runtimeFor(env, options = {}) {
  const runtime = env.window.AthenaPiRuntime.create(options);
  env.cleanups.push(() => runtime.destroy());
  return runtime;
}
function hostFor({ capabilities, respond = () => ({}), send, mode = 'host' } = {}) {
  const calls = [], callbacks = [];
  const host = {
    mode, capabilities, unsubscribed: 0,
    subscribe(listener) { callbacks.push(listener); return () => { host.unsubscribed++; }; },
    async request(wire) {
      calls.push(localValue(wire));
      const data = await respond(wire);
      return data?.type === 'response' ? data : { type: 'response', id: wire.id, command: wire.type, success: true, data };
    },
    async send(wire) { calls.push(localValue(wire)); return send?.(wire); },
    emit(event) { callbacks.at(-1)?.(event); },
    calls, callbacks,
  };
  return host;
}
function workbenchFor(env, runtime, options = {}) {
  const slot = env.document.createElement('section');
  slot.id = 'qa-pi-workbench';
  env.q('#athena-codex').appendChild(slot);
  const view = env.window.AthenaPiWorkbench.mount(slot, { runtime, ...options });
  env.cleanups.push(() => { view.destroy(); slot.remove(); });
  return { view, slot, q(selector) { const element = slot.querySelector(selector); assert.ok(element, 'Workbench element: ' + selector); return element; } };
}
function completedReplySummary(env) {
  assert.equal(env.q('.ar-status-row').hidden, false, 'A completed response retains its compact milestone summary.');
  assert.equal(env.q('.as-header').getAttribute('aria-expanded'), 'false');
  assert.equal(env.q('[data-athena-agent-steps]').dataset.active, 'false');
  env.clock.advance(400);
  assert.equal(env.q('.as-list-panel').hidden, true);
  assert.equal(env.qa('#ac-live-reply .as-spinner,#ac-live-reply .as-wave-letter,#ac-live-reply [data-pi-active="true"]').length, 0);
}

test('Initial workspace: ready, no summoned avatars, no run output, and mounted local controls', () => {
  const env = createEnvironment();
  // Source declarations only: LinkeDOM cannot verify a rendered short window.
  assert.ok(buildStyles.indexOf('ui/layout.css') > buildStyles.indexOf('app.css'));
  assert.match(sources['ui/layout.css'], /#athena-codex\s*\{[^}]*height:\s*100dvh;[^}]*min-height:\s*0;/);
  assert.doesNotMatch(sources['ui/layout.css'], /min-height:\s*520px/);
  assert.match(sources['ui/settings.css'], /\.ast-sheet\s*\{[^}]*max-height:\s*100%;[^}]*min-height:\s*0;/);
  assert.match(sources['ui/settings.css'], /\.ast-content\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/);
  assert.match(sources['ui/pi-workbench.css'], /\.apw-dialog\s*\{[^}]*max-height:\s*100%;[^}]*overflow-y:\s*auto;/);
  assert.equal(env.state().panelOpen, false);
  assert.equal(env.q('#ac-research-panel').hidden, true);
  assert.equal(env.q('#ac-panel-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(workspace(env).run.status, 'ready');
  assert.equal(workspace(env).agents.length, 0);
  assert.equal(workspace(env).artifacts.length, 0);
  assert.equal(workspace(env).approvals.length, 0);
  assert.equal(env.qa('.aav-avatar').length, 0);
  assert.equal(env.q('.aw-baseline').open, false);
  for (const selector of ['.acm-composer', '[data-athena-reply]', '.ac-command', '#ac-morph-tip', '#aw-activity']) env.q(selector);
  assert.equal(env.q('.ar-status-row').hidden, true);
  assert.equal(env.state().surface.surface, 'home');
  assert.equal(env.state().layout.left, 240);
  assert.equal(env.state().layout.right, 440);
  assert.equal(env.q('#ac-left-resizer').getAttribute('role'), 'separator');
  assert.equal(env.q('#ac-right-resizer').hidden, true);
  assertProjectSidebar(env, true);
  const before = JSON.stringify(workspace(env));
  env.clock.advance(10000);
  assert.equal(JSON.stringify(workspace(env)), before, 'The ready workflow never advances automatically.');
  env.window.AthenaApp.openWorkspace('workflow');
  assertWorkspaceView(env, 'workflow');
  assert.equal(env.qa('#ac-workbench-slot .aav-avatar').length, 0, 'Planned task rows do not summon companions.');
  env.type('#ac-prompt-input', 'Keep this disconnected draft'); env.click('.acm-send');
  assert.equal(env.state().workspace.mode, 'preview'); assert.equal(env.state().busy, false);
  assert.equal(env.state().prompt, 'Keep this disconnected draft'); assert.equal(env.state().lastSubmission, null);
  assert.equal(env.state().reply.text, '', 'A disconnected preview cannot invent a reply without opting into demo mode.');
});

test('One canonical right-side toggle opens and closes split and overlay views with synchronized labels', () => {
  for (const width of [1440, 640]) {
    const env = createEnvironment({ width });
    assert.equal(env.qa('[data-action="toggle-panel"],[data-action="close-panel"]').length, 1);
    const toggle = env.q('#ac-panel-toggle');
    assert.equal(toggle.getAttribute('aria-controls'), 'ac-research-panel');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(toggle.getAttribute('aria-label'), 'Open side view');
    env.click(toggle);
    assert.equal(env.state().panelOpen, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(toggle.getAttribute('aria-label'), 'Close side view');
    assert.equal(toggle.closest('[hidden]'), null);
    assert.equal(env.q('.ac-header').inert, false);
    assert.equal(env.qa('[data-action="toggle-panel"],[data-action="close-panel"]').length, 1);
    env.click(toggle);
    assert.equal(env.state().panelOpen, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(toggle.getAttribute('aria-label'), 'Open side view');
    assert.equal(env.document.activeElement, toggle);
    assertProjectSidebar(env, true);
  }
});

test('Legacy execution panel preferences migrate to the picker and no execution surface is exposed', () => {
  for (const defaultSideView of ['execution', 'terminal']) {
    const env = createEnvironment({ storage: settingsStorage({ defaultSideView }) });
    assert.equal(env.state().settings.defaultSideView, 'home');
    env.click('#ac-panel-toggle');
    assert.equal(env.state().sideView, 'surface');
    assert.equal(env.state().surface.surface, 'home');
    assert.equal(env.qa('[data-acs-surface="execution"],[data-acs-surface="terminal"],[data-workspace-view="execution"]').length, 0);
    env.window.AthenaApp.openSettings('general');
    assert.equal(env.q('#ast-default-view').value, 'home');
    assert.equal(env.qa('#ast-default-view option[value="execution"],#ast-default-view option[value="terminal"]').length, 0);
    assert.equal(env.qa('[data-awv-log],[data-awv-command],[data-awv-exit]').length, 0);
  }
});

test('Geometric agent identities remain stable across status and display size with no facial markup', () => {
  const env = createEnvironment();
  const glyph = options => {
    const node = env.document.createElement('div');
    node.innerHTML = env.window.AthenaAvatars.html(options);
    return node.firstElementChild;
  };
  const identity = node => [node.dataset.avatarIdentity, node.dataset.avatarShape, node.dataset.avatarTone, node.style.getPropertyValue('--aav-turn')].join('|');
  const first = glyph({ agentId: 'run-one:task-a', role: 'researcher', status: 'running', size: 24 });
  const expected = identity(first);
  for (const status of ['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled']) {
    const node = glyph({ agentId: 'run-one:task-a', role: 'analyst', status, size: 44 });
    assert.equal(identity(node), expected);
    assert.equal(node.getAttribute('aria-hidden'), 'true');
    assert.equal(node.querySelectorAll('.aav-glyph').length, 1);
    assert.equal(node.children.length, 1);
    assert.equal(node.textContent, '');
    assert.equal(node.querySelectorAll('svg,img,[role],[tabindex],[class*="eye"],[class*="cheek"],[class*="mouth"],[class*="face"]').length, 0);
  }
  const marks = new Set(Array.from({ length: 24 }, (_, index) => identity(glyph({ agentId: 'run-' + index + ':task-a', role: 'researcher' }))));
  const shapes = new Set(Array.from({ length: 24 }, (_, index) => glyph({ agentId: 'run-' + index + ':task-a', role: 'researcher' }).dataset.avatarShape));
  assert.equal(marks.size, 24, 'Different agent IDs receive distinct identity hashes.');
  assert.ok(shapes.size > 4, 'Agent marks vary shape rather than only status or role.');
  assert.deepEqual(env.networkCalls, []);
});

test('Pi state and operation icons use the bundled icon set with distinct accessible phase labels', () => {
  const env = createEnvironment();
  const pi = env.window.AthenaPiActivity;
  assert.ok(pi, 'The Pi presentation module is included in the current build.');
  const vendor = {};
  new vm.Script(sources['vendor/lucide.min.js'], { filename: 'vendor/lucide.min.js' }).runInNewContext(vendor);
  const assertIcon = name => {
    const key = name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
    assert.ok(vendor.lucide[key], 'The bundled Lucide version contains ' + name);
  };
  for (const name of ['idle', 'waiting', 'thinking', 'replying', 'preparing', 'working', 'approval', 'retrying', 'compacting', 'complete', 'error', 'stopped', 'paused']) {
    const phase = pi.phase(name);
    assert.equal(phase.id, name);
    assert.ok(phase.label && phase.icon);
    assertIcon(phase.icon);
    const holder = env.document.createElement('span');
    holder.innerHTML = pi.phaseIcon(name);
    assert.equal(holder.querySelectorAll('i[data-lucide]').length, 1);
    assert.equal(holder.querySelectorAll('svg,img,script,[onerror]').length, 0);
  }
  assert.equal(pi.phase('waiting').label, 'Waiting');
  assert.equal(pi.phase('thinking').label, 'Thinking');
  assert.equal(pi.phase('replying').label, 'Replying');
  assert.ok(new Set(['waiting', 'thinking', 'replying'].map(name => pi.phase(name).icon)).size === 3);
  const operationIcons = new Set();
  for (const name of ['read', 'write', 'edit', 'bash', 'powershell', 'grep', 'find', 'ls', 'codemode']) {
    const task = pi.toolPresentation(name, { path: 'src/app.ts', command: 'npm test', pattern: 'TODO' }, 'running');
    assert.ok(task.label && task.detail !== undefined);
    assertIcon(task.icon); operationIcons.add(task.icon);
    assert.equal(task.active, true);
    assert.equal(pi.toolPresentation(name, {}, 'succeeded').active, false);
  }
  assert.ok(operationIcons.size >= 6, 'File read/write/edit/search and terminal operations have meaningful distinctions.');
  const unknown = pi.toolPresentation('custom_research_tool', { input: '<script>bad()</script>' });
  assertIcon(unknown.icon);
  assert.ok(unknown.label);
  const hostile = env.document.createElement('span');
  hostile.innerHTML = pi.iconHTML('x" onerror="bad()', { className: '\"><img src=x onerror=bad()>' });
  assert.equal(hostile.querySelectorAll('script,img,[onerror]').length, 0);
  assert.deepEqual(env.networkCalls, []);
});

test('Pi message events drive phases and authoritative text without exposing thinking or fabricating completion', () => {
  const env = createEnvironment();
  const changes = [];
  const pi = env.window.AthenaPiActivity.create();
  const unsubscribe = pi.subscribe(state => changes.push(state));
  const update = (type, fields = {}) => pi.receive({ type: 'message_update', assistantMessageEvent: { type, contentIndex: 0, ...fields } });
  try {
    assert.equal(changes.length, 1);
    assert.equal(pi.getState().phase, 'idle');
    pi.receive({ type: 'agent_start' });
    assert.equal(pi.getState().phase, 'waiting');
    pi.receive({ type: 'message_start', message: { role: 'assistant', content: [] } });
    update('thinking_start');
    assert.equal(pi.getState().phase, 'thinking');
    update('thinking_delta', { delta: 'private thought content should not be rendered' });
    assert.ok(pi.getState().thinkingCharacters > 0);
    assert.equal(JSON.stringify(pi.getState()).includes('private thought content'), false);
    update('thinking_end');
    update('text_start');
    update('text_delta', { delta: 'Hello ' });
    update('text_delta', { delta: 'world' });
    assert.equal(pi.getState().phase, 'replying');
    assert.equal(pi.getState().text, 'Hello world');
    update('text_end', { content: 'Hello world!' });
    assert.equal(pi.getState().text, 'Hello world!');
    pi.receive({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world!!' }], stopReason: 'stop' } });
    assert.equal(pi.getState().text, 'Hello world!!');
    pi.receive({ type: 'agent_end', messages: [], willRetry: true });
    assert.equal(pi.getState().phase, 'retrying');
    assert.equal(pi.getState().settled, false);
    env.clock.advance(30000);
    assert.equal(pi.getState().settled, false, 'Only an event can settle the actual session.');
    pi.receive({ type: 'agent_start' });
    pi.receive({ type: 'message_start', message: { role: 'assistant', content: [] } });
    update('text_delta', { delta: 'Follow-up.' });
    pi.receive({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Follow-up.' }], stopReason: 'stop' } });
    assert.equal(pi.getState().text, 'Hello world!!\n\nFollow-up.');
    const beforeUser = pi.getState().sequence;
    assert.equal(pi.receive({ type: 'message_start', message: { role: 'user', content: 'unrelated input' } }), false);
    assert.equal(pi.getState().sequence, beforeUser);
    pi.receive({ type: 'agent_end', messages: [], willRetry: false });
    assert.equal(pi.getState().settled, false);
    pi.receive({ type: 'agent_settled', aborted: false });
    assert.equal(pi.getState().phase, 'complete');
    assert.equal(pi.getState().active, false);
    assert.equal(pi.getState().settled, true);
    const finished = JSON.stringify(pi.getState());
    assert.equal(update('text_delta', { delta: 'late' }), false);
    assert.equal(JSON.stringify(pi.getState()), finished);
    assert.ok(Object.isFrozen(pi.getState()) && Object.isFrozen(pi.getState().messages));
    unsubscribe(); const notifications = changes.length;
    pi.reset();
    assert.equal(pi.getState().phase, 'idle');
    assert.equal(pi.getState().text, '');
    assert.equal(changes.length, notifications);
    pi.destroy();
    assert.equal(pi.receive({ type: 'agent_start' }), false);
    assert.equal(changes.length, notifications);
  } finally { unsubscribe(); pi.destroy(); }
});

test('Pi tool output stays correlated by call ID, replaces cumulative output and supports explicitly configured deltas', () => {
  const env = createEnvironment();
  const pi = env.window.AthenaPiActivity.create({ toolOutputModes: { delta_extension: 'append' }, maxTools: 5, maxActivity: 10 });
  const output = text => ({ content: [{ type: 'text', text }] });
  const tool = id => pi.getState().tools.find(item => item.toolCallId === id);
  try {
    pi.receive({ type: 'agent_start' });
    pi.receive({ type: 'tool_execution_start', toolCallId: 'read:1', toolName: 'read', args: { path: 'src/app.ts' } });
    pi.receive({ type: 'tool_execution_start', toolCallId: 'bash:1', toolName: 'bash', args: { command: 'npm test' } });
    assert.equal(pi.getState().tools.length, 2);
    assert.equal(pi.getState().phase, 'working');
    assert.notEqual(tool('read:1').icon, tool('bash:1').icon);
    pi.receive({ type: 'tool_execution_update', toolCallId: 'read:1', toolName: 'read', partialResult: output('one') });
    pi.receive({ type: 'tool_execution_update', toolCallId: 'read:1', toolName: 'read', partialResult: output('one two') });
    assert.equal(tool('read:1').output, 'one two', 'SDK cumulative partials replace instead of duplicating the prefix.');
    assert.equal(tool('bash:1').output, '');
    pi.receive({ type: 'tool_execution_end', toolCallId: 'read:1', toolName: 'read', result: output('final file text'), isError: false, durationMs: 25 });
    assert.equal(tool('read:1').output, 'final file text');
    assert.equal(tool('read:1').status, 'succeeded');
    assert.equal(tool('read:1').active, false);
    assert.equal(tool('read:1').durationMs, 25);
    assert.equal(pi.getState().phase, 'working', 'The other in-flight call is still running.');
    const finishedRead = JSON.stringify(tool('read:1'));
    assert.equal(pi.receive({ type: 'tool_execution_update', toolCallId: 'read:1', toolName: 'read', partialResult: output('late') }), false);
    assert.equal(JSON.stringify(tool('read:1')), finishedRead);
    pi.receive({ type: 'tool_execution_end', toolCallId: 'bash:1', toolName: 'bash', result: output('test failed'), isError: true });
    assert.equal(tool('bash:1').status, 'failed');
    assert.equal(tool('bash:1').active, false);
    pi.receive({ type: 'tool_execution_start', toolCallId: 'delta:1', toolName: 'delta_extension', args: { input: '<img onerror=bad()>' } });
    for (const text of ['one', ' two']) pi.receive({ type: 'tool_execution_update', toolCallId: 'delta:1', toolName: 'delta_extension', partialResult: output(text) });
    assert.equal(tool('delta:1').output, 'one two');
    assert.equal(tool('delta:1').kind, 'custom');
    pi.receive({ type: 'tool_execution_end', toolCallId: 'delta:1', toolName: 'delta_extension', result: output('one two'), isError: false });
    pi.receive({ type: 'bash_execution_update', id: 'direct', delta: 'A' });
    pi.receive({ type: 'bash_execution_update', id: 'direct', delta: 'B' });
    assert.equal(tool('rpc-bash:direct').output, 'AB');
    pi.receive({ type: 'agent_settled', aborted: true });
    assert.equal(pi.getState().phase, 'stopped');
    assert.ok(pi.getState().tools.every(item => !item.active));
    assert.equal(pi.receive({ type: 'tool_execution_update', toolCallId: 'bash:1', toolName: 'bash', partialResult: output('late') }), false);
    pi.receive({ type: 'agent_start' });
    for (let index = 0; index < 12; index++) {
      pi.receive({ type: 'tool_execution_start', toolCallId: 'bounded:' + index, toolName: 'ls', args: { path: '.' } });
      pi.receive({ type: 'tool_execution_end', toolCallId: 'bounded:' + index, toolName: 'ls', result: output('file.ts'), isError: false });
    }
    assert.equal(pi.getState().tools.length, 5);
    assert.ok(pi.getState().activity.length <= 10);
    assert.equal(pi.getState().tools.at(-1).toolCallId, 'bounded:11');
  } finally { pi.destroy(); }
  assert.deepEqual(env.networkCalls, []);
});

test('Pi retry, compaction and input-wait events have appropriate nonfinal and terminal states', () => {
  const env = createEnvironment();
  const pi = env.window.AthenaPiActivity.create();
  try {
    pi.receive({ type: 'agent_start' });
    pi.receive({ type: 'compaction_start' }); assert.equal(pi.getState().phase, 'compacting');
    pi.receive({ type: 'compaction_end', willRetry: false }); assert.equal(pi.getState().phase, 'waiting');
    pi.receive({ type: 'ui_prompt_start', kind: 'confirm' });
    assert.equal(pi.getState().phase, 'approval'); assert.equal(pi.getState().active, false);
    pi.receive({ type: 'ui_prompt_end', kind: 'confirm' }); assert.equal(pi.getState().phase, 'waiting');
    pi.receive({ type: 'queue_update', steering: [{ text: 'correction' }], followUp: [{ text: 'next' }, { text: 'last' }] });
    assert.equal(pi.getState().queue.steering, 1); assert.equal(pi.getState().queue.followUp, 2);
    pi.receive({ type: 'auto_retry_start', attempt: 1 }); assert.equal(pi.getState().phase, 'retrying');
    pi.receive({ type: 'auto_retry_end', success: false, finalError: 'Connection unavailable' });
    assert.equal(pi.getState().phase, 'error'); assert.equal(pi.getState().active, false);
    pi.receive({ type: 'agent_settled', aborted: false });
    assert.equal(pi.getState().phase, 'error'); assert.equal(pi.getState().settled, true);
    const state = JSON.stringify(pi.getState());
    assert.equal(pi.receive({ type: 'unsupported_extension_event', text: 'ignored' }), false);
    assert.equal(JSON.stringify(pi.getState()), state);
  } finally { pi.destroy(); }
});

test('Pi inline tool rows preserve disclosure, focus and output identity while safely rendering streamed data', async () => {
  const env = createEnvironment();
  const slot = env.document.createElement('section'); env.q('#athena-codex').appendChild(slot);
  const pi = env.window.AthenaPiActivity.create();
  const view = env.window.AthenaPiSessionView.mount(slot);
  const unsubscribe = pi.subscribe(view.render);
  const result = text => ({ content: [{ type: 'text', text }] });
  try {
    pi.receive({ type: 'agent_start' });
    pi.receive({ type: 'tool_execution_start', toolCallId: 'read-live', toolName: 'read', args: { path: 'src/<img onerror=bad()>.ts' } });
    const row = slot.querySelector('[data-ap-tool="read-live"]');
    assert.ok(row && row.matches('details'));
    assert.equal(slot.querySelectorAll('img,script,[onerror]').length, 0);
    assert.match(row.querySelector('.ap-tool-target').textContent, /<img onerror=bad\(\)>/);
    const group = row.closest('.ac-stream-activity');
    if (group && !group.open) env.click(group.querySelector('summary'));
    env.click(row.querySelector('summary'));
    assert.equal(row.open, true);
    const rawDetails = row.querySelector('[data-aw-diagnostics]');
    if (rawDetails) env.click(rawDetails.querySelector('summary'));
    const copy = row.querySelector('[data-ap-copy="output"]'); copy.focus();
    pi.receive({ type: 'tool_execution_update', toolCallId: 'read-live', toolName: 'read', partialResult: result('<b>literal output</b>') });
    assert.equal(slot.querySelector('[data-ap-tool="read-live"]'), row);
    assert.equal(row.open, true);
    assert.equal(env.document.activeElement, copy);
    assert.equal(row.querySelector('[data-ap-output]').textContent, '<b>literal output</b>');
    assert.equal(row.querySelector('[data-ap-output] b'), null);
    pi.receive({ type: 'tool_execution_update', toolCallId: 'read-live', toolName: 'read', partialResult: result('<b>literal output</b> next') });
    assert.equal(row.querySelector('[data-ap-output]').textContent, '<b>literal output</b> next');
    env.click(copy); await env.waitFor(() => env.clipboardWrites.length === 1);
    assert.equal(env.clipboardWrites[0], '<b>literal output</b> next');
    env.window.navigator.clipboard.writeText = () => Promise.reject(new Error('Clipboard disabled'));
    env.click(copy); await env.waitFor(() => !row.querySelector('.ap-copy-label').hidden);
    const manual = row.querySelector('.ap-copy-label textarea');
    assert.ok(manual.hasAttribute('readonly'));
    assert.equal(manual.value, '<b>literal output</b> next');
    assert.equal(env.document.activeElement, manual);
    pi.receive({ type: 'tool_execution_end', toolCallId: 'read-live', toolName: 'read', result: result('Final file content'), isError: false });
    assert.equal(row.dataset.piActive, 'false');
    assert.equal(row.querySelectorAll('[data-pi-active="true"]').length, 0);
    assert.equal(env.document.activeElement, manual);
    assert.equal(row.querySelector('[data-ap-state]').textContent, 'Complete');
    pi.receive({ type: 'extension_error', error: 'Extension output unavailable' });
    assert.equal(slot.querySelector('[role="alert"]').hidden, false);
    assert.equal(env.document.activeElement, manual, 'An error update does not steal focus.');
    assert.equal(env.q('#ac-dialog-backdrop').hidden, true);
    assert.equal(env.state().panelOpen, false);
  } finally { unsubscribe(); pi.destroy(); view.destroy(); slot.remove(); }
});

test('Shell Pi events update inline phases and tool rows and remain busy until session settlement', () => {
  const env = createEnvironment();
  const app = env.window.AthenaApp;
  const emit = app.handlePiEvent;
  emit({ type: 'agent_start' });
  assert.equal(env.state().piActivity.phase, 'waiting');
  assert.equal(env.state().reply.phase, 'waiting');
  assert.equal(env.state().busy, true);
  assert.equal(env.q('.acm-send').disabled, true, 'An event-only presentation cannot pretend to abort a backend.');
  emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } });
  assert.equal(env.q('[data-athena-reply]').dataset.phase, 'thinking');
  assert.equal(env.q('.ar-phase-glyph').dataset.iconProvider, 'pi');
  emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'shell-read', toolName: 'read' } });
  assert.equal(env.state().reply.phase, 'preparing');
  assert.equal(env.q('[data-ap-tool="shell-read"]').dataset.piStatus, 'queued');
  emit({ type: 'tool_execution_start', toolCallId: 'shell-read', toolName: 'read', args: { path: 'README.md' } });
  assert.equal(env.state().reply.phase, 'working');
  const row = env.q('[data-ap-tool="shell-read"]');
  assert.ok(env.q('#ac-conversation').contains(row));
  assert.equal(env.state().panelOpen, false);
  env.click(row.closest('.ac-stream-activity').querySelector('summary'));
  env.click('[data-ap-tool-summary="shell-read"]');
  emit({ type: 'tool_execution_update', toolCallId: 'shell-read', toolName: 'read', partialResult: { content: [{ type: 'text', text: 'Actual event output' }] } });
  assert.equal(env.q('[data-ap-tool="shell-read"]'), row);
  assert.equal(row.open, true);
  assert.equal(row.querySelector('[data-ap-output]').textContent, 'Actual event output');
  emit({ type: 'tool_execution_end', toolCallId: 'shell-read', toolName: 'read', result: { content: [{ type: 'text', text: 'Authoritative file output' }] }, isError: false });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 2, delta: 'Answer ' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 2, delta: 'arrives.' } });
  assert.equal(env.state().reply.phase, 'replying');
  assert.equal(env.q('.ar-text').textContent, 'Answer arrives.');
  assert.equal(env.q('.ar-caret').hidden, false);
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Final authoritative answer.' }], stopReason: 'stop' } });
  assert.equal(env.q('.ar-text').textContent, 'Final authoritative answer.');
  emit({ type: 'agent_end', messages: [], willRetry: false });
  assert.equal(env.state().busy, true);
  assert.equal(env.state().reply.active, true);
  env.clock.advance(30000);
  assert.equal(env.state().busy, true);
  emit({ type: 'agent_settled', aborted: false });
  assert.equal(env.state().busy, false);
  assert.equal(env.state().reply.active, false);
  assert.equal(env.q('.ar-caret').hidden, true);
  assert.equal(env.qa('#ac-live-reply [data-pi-active="true"]').length, 0);
  assert.equal(env.q('.ar-text').textContent, 'Final authoritative answer.');
  assertProjectSidebar(env, true);
  assert.deepEqual(env.networkCalls, []);
});

test('Pi session subscriptions prompt only on explicit send, abort honestly and reject obsolete session deliveries', async () => {
  const env = createEnvironment();
  const app = env.window.AthenaApp;
  const first = { sessionId: 'subscription-first', listener: null, unsubscribed: 0, prompts: [], aborts: 0,
    subscribe(listener) { this.listener = listener; return () => { this.unsubscribed++; }; },
    prompt(text) { this.prompts.push(text); return Promise.resolve(); },
    abort() { this.aborts++; return Promise.resolve(); },
  };
  const cleanupFirst = app.attachPiSession(first, { refresh: false });
  await app.executePi('get_state');
  assert.equal(env.state().piConnected, true);
  assert.equal(first.prompts.length, 0);
  env.type('#ac-prompt-input', 'Explain the selected file'); env.click('.acm-send');
  await env.waitFor(() => first.prompts.length === 1);
  assert.deepEqual(first.prompts, ['Explain the selected file']);
  assert.equal(env.state().busy, true, 'Prompt Promise resolution is not a fabricated settled event.');
  first.listener({ type: 'agent_start' });
  first.listener({ type: 'message_start', message: { role: 'assistant', content: [] } });
  first.listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Partial reply' } });
  assert.equal(env.q('.ar-text').textContent, 'Partial reply');
  assert.equal(env.q('.acm-send').disabled, false);
  env.click('.acm-send'); await env.waitFor(() => first.aborts === 1);
  assert.equal(env.state().busy, true, 'Abort requests wait for the backend settlement event.');
  assert.equal(env.q('.acm-send').disabled, true);
  first.listener({ type: 'agent_settled', aborted: true });
  assert.equal(env.state().busy, false);
  assert.equal(env.state().reply.phase, 'stopped');
  assert.equal(env.q('.ar-text').textContent, 'Partial reply');
  const obsolete = first.listener;
  const second = { sessionId: 'subscription-second', listener: null, unsubscribed: 0,
    subscribe(listener) { this.listener = listener; return () => { this.unsubscribed++; }; }
  };
  app.attachPiSession(second, { refresh: false });
  await app.executePi('get_state');
  assert.equal(first.unsubscribed, 1);
  const current = JSON.stringify(env.state().piActivity);
  obsolete({ type: 'agent_start' });
  assert.equal(JSON.stringify(env.state().piActivity), current, 'A queued callback from a replaced session cannot restart the UI.');
  cleanupFirst(); assert.equal(env.state().piConnected, true);
  assert.equal(second.unsubscribed, 0, 'An old cleanup does not detach a newer binding.');
  second.listener({ type: 'agent_start' });
  assert.equal(env.state().busy, true);
  assert.equal(env.q('.acm-send').disabled, true, 'A subscription without abort is view-only during generation.');
  app.detachPiSession();
  assert.equal(second.unsubscribed, 1);
  const detached = JSON.stringify(env.state().piActivity);
  second.listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'obsolete' } });
  assert.equal(JSON.stringify(env.state().piActivity), detached);
  assert.equal(env.state().busy, false);
  app.attachPiSession(second);
  env.destroy();
  assert.equal(second.unsubscribed, 2);
  assert.equal(app.handlePiEvent({ type: 'agent_start' }), false);
  assert.deepEqual(env.networkCalls, []);
});

test('Explicit response preview demonstrates all built-in operations and finishes or stops its own timers', () => {
  const env = createEnvironment();
  env.click('.aw-demo-options > summary');
  env.click('[data-aw-action="preview-reply"]');
  assert.equal(env.state().piActivity.phase, 'waiting');
  assert.equal(env.q('.ar-preview-label').textContent, 'Local event preview');
  assert.equal(env.q('.ar-preview-label').hidden, false);
  env.clock.advance(350);
  assert.equal(env.state().piActivity.phase, 'thinking');
  env.clock.advance(5700);
  assert.equal(env.state().piActivity.phase, 'replying');
  assert.equal(env.state().piActivity.tools.length, 8);
  const kinds = new Set(env.state().piActivity.tools.map(tool => tool.toolName));
  for (const name of ['read', 'write', 'edit', 'bash', 'powershell', 'grep', 'find', 'ls']) assert.ok(kinds.has(name));
  assert.equal(env.qa('#ac-pi-transcript [data-ap-tool]').length, 8);
  env.clock.advance(15000);
  assert.equal(env.state().piActivity.phase, 'complete');
  assert.equal(env.state().busy, false);
  assert.equal(env.state().reply.active, false);
  assert.equal(env.qa('#ac-live-reply [data-pi-active="true"]').length, 0);
  assert.match(env.q('.ar-text').textContent, /No files were changed and no commands were run/);
  env.window.AthenaApp.previewPiActivity();
  env.clock.advance(400); env.click('.acm-send');
  assert.equal(env.state().piActivity.phase, 'stopped');
  const stopped = JSON.stringify(env.state().piActivity);
  env.clock.advance(30000);
  assert.equal(JSON.stringify(env.state().piActivity), stopped);
  assert.equal(env.state().busy, false);
  assert.equal(env.state().panelOpen, false);
  assert.deepEqual(env.networkCalls, []);
});

test('Demo playback stays inside its disclosure and ordinary conversation has no Pause or Stop toolbar', () => {
  const env = createEnvironment();
  const options = env.q('.aw-demo-options');
  assert.equal(options.open, false);
  assert.ok(options.contains(env.q('[data-aw-action="primary"]')));
  const ordinaryButtons = () => env.qa('#aw-activity button').filter(button => !button.closest('.aw-demo-options'));
  assert.ok(ordinaryButtons().every(button => !/^(Pause|Resume|Stop)(?:\s|$)/.test(button.textContent.trim())));
  runDemoUI(env);
  assert.equal(workspace(env).run.status, 'running');
  assert.equal(env.q('[data-aw-action="primary"]').disabled, true);
  assert.equal(env.qa('#aw-activity [data-aw-action="stop"]').length, 0);
  assert.ok(ordinaryButtons().every(button => !/^(Pause|Resume|Stop)(?:\s|$)/.test(button.textContent.trim())));
  env.click(env.q('.aw-demo-options > summary'));
  assert.equal(env.q('.aw-demo-options').open, false);
  env.window.AthenaApp.cancelDemo();
  assert.equal(workspace(env).run.status, 'cancelled');
});

test('Streamed replies show truthful phases, append received chunks, reconcile final text and end all active indicators', () => {
  const env = createEnvironment();
  const slot = env.document.createElement('section'); env.q('#athena-codex').appendChild(slot);
  const reply = env.window.AthenaReply.mount(slot);
  const query = selector => { const node = slot.querySelector(selector); assert.ok(node, selector); return node; };
  let completed = 0;
  const phases = [];
  try {
    reply.begin({ phase: 'waiting', sample: false, onDone() { completed++; }, onPhase(phase) { phases.push(phase); } });
    assert.equal(reply.getState().active, true);
    assert.equal(reply.getState().phase, 'waiting');
    assert.equal(query('[data-athena-reply]').dataset.active, 'true');
    assert.equal(query('.ar-status-row').hidden, false);
    assert.equal(query('.ar-text').textContent, '');
    reply.setPhase('thinking');
    assert.equal(reply.getState().phase, 'thinking');
    assert.match(query('.ar-phase-label').textContent, /Thinking/);
    env.clock.advance(10000);
    assert.equal(reply.getState().active, true, 'Time alone never fabricates stream completion.');
    assert.equal(completed, 0);
    reply.append('Hello <img src=x onerror=bad()>');
    const first = query('.ar-text').firstChild;
    assert.equal(reply.getState().phase, 'replying');
    assert.equal(query('.ar-text').querySelectorAll('img,script').length, 0);
    reply.append(' world');
    assert.equal(query('.ar-text').firstChild, first, 'Appending a chunk preserves existing text nodes.');
    assert.equal(reply.getState().text, 'Hello <img src=x onerror=bad()> world');
    assert.equal(query('.ar-caret').hidden, false);
    reply.end({ text: 'Hello world.', status: 'done' });
    assert.equal(reply.getState().active, false);
    assert.equal(query('.ar-text').textContent, 'Hello world.');
    assert.equal(query('.ar-caret').hidden, true);
    assert.equal(query('[data-athena-reply]').dataset.active, 'false');
    assert.equal(slot.querySelectorAll('[data-pi-active="true"]').length, 0);
    assert.equal(query('.ar-bubble').getAttribute('aria-busy'), 'false');
    assert.equal(completed, 1);
    reply.append(' late chunk'); env.clock.advance(10000);
    assert.equal(query('.ar-text').textContent, 'Hello world.');
    assert.equal(completed, 1);
    assert.ok(phases.includes('waiting') && phases.includes('thinking') && phases.includes('replying'));
    reply.begin({ phase: 'replying', sample: false, onDone() { completed++; } });
    reply.append('Partial'); reply.stop();
    assert.equal(reply.getState().text, 'Partial');
    assert.equal(query('.ar-caret').hidden, true);
    assert.equal(completed, 1, 'Cancellation is not a successful completion callback.');
  } finally { reply.destroy(); slot.remove(); }
});

test('Reduced motion removes streaming motion while preserving an unfinished Pi reply until its end event', () => {
  const env = createEnvironment({ reduced: true });
  const slot = env.document.createElement('section'); env.q('#athena-codex').appendChild(slot);
  const reply = env.window.AthenaReply.mount(slot);
  let completed = 0;
  try {
    reply.begin({ phase: 'waiting', sample: false, onDone() { completed++; } });
    reply.append('One');
    assert.equal(reply.getState().active, true);
    assert.equal(reply.getState().reducedMotion, true);
    env.clock.advance(30000);
    assert.equal(completed, 0);
    assert.equal(reply.getState().text, 'One');
    env.setReduced(false); reply.append(' two');
    assert.equal(reply.getState().active, true);
    env.setReduced(true);
    assert.equal(reply.getState().active, true, 'A live preference change never pretends the backend finished.');
    assert.equal(reply.getState().reducedMotion, true);
    reply.append(' three');
    assert.equal(reply.getState().text, 'One two three');
    reply.end({ status: 'done' });
    assert.equal(completed, 1);
    assert.equal(reply.getState().active, false);
    assert.equal(slot.querySelectorAll('[data-pi-active="true"]').length, 0);
  } finally { reply.destroy(); slot.remove(); }
});

test('Agent steps retain keyed rows and readable milestones, collapse on success and finish terminal motion', () => {
  const env = createEnvironment();
  const slot = env.document.createElement('section'); env.q('#athena-codex').appendChild(slot);
  const steps = env.window.AthenaAgentSteps.mount(slot);
  env.cleanups.push(() => { steps.destroy(); slot.remove(); });
  const header = slot.querySelector('.as-header'), panel = slot.querySelector('.as-list-panel');
  assert.equal(header.localName, 'button'); assert.equal(header.getAttribute('aria-controls'), panel.id);
  const first = { id: 'inspect', label: 'Review files', status: 'running', detail: ['Read source', 'Read tests'] };
  steps.update([first, { id: 'answer', label: 'Write answer', status: 'pending' }]);
  const row = slot.querySelector('[data-agent-step="inspect"]');
  assert.equal(header.getAttribute('aria-expanded'), 'true');
  assert.equal(row.querySelector('.as-sr-only').textContent, 'Review files');
  assert.equal(row.querySelector('.as-wave-label').getAttribute('aria-hidden'), 'true');
  assert.equal(row.querySelectorAll('.as-log-line').length, 2);
  env.clock.advance(2300);
  steps.update([{ ...first, detail: [...first.detail, 'Trace event', '<img onerror=bad()>'] }, { id: 'answer', label: 'Write answer', status: 'pending' }]);
  assert.equal(slot.querySelector('[data-agent-step="inspect"]'), row);
  assert.equal(row.querySelectorAll('.as-log-line').length, 4);
  assert.equal(row.querySelector('.as-log-viewport').dataset.masked, 'true');
  assert.equal(slot.querySelector('img'), null);
  env.click(header);
  assert.equal(header.getAttribute('aria-expanded'), 'false'); assert.equal(panel.inert, true);
  steps.update([{ ...first, status: 'done' }, { id: 'answer', label: 'Write answer', status: 'running' }]);
  assert.equal(header.getAttribute('aria-expanded'), 'false', 'Progress does not override the user’s fold preference.');
  assert.equal(row.dataset.status, 'done');
  assert.equal(row.querySelector('.as-step-time').textContent, '2.3s');
  env.clock.advance(700);
  steps.update([{ ...first, status: 'done' }, { id: 'answer', label: 'Write answer', status: 'done' }], { outcome: 'complete' });
  assert.equal(steps.getState().active, false);
  assert.match(slot.querySelector('.as-title').textContent, /Worked for 3s/);
  assert.match(slot.querySelector('.as-count').textContent, /2 steps/);
  env.clock.advance(400);
  assert.equal(panel.hidden, true);
  assert.equal(slot.querySelectorAll('.as-spinner,.as-wave-letter,.is-leaving,[data-pi-active="true"]').length, 0);
  env.click(header);
  assert.equal(panel.hidden, false); assert.equal(panel.inert, false);
  assert.equal(slot.querySelectorAll('[data-agent-step][data-status="done"]').length, 2);
  const settled = JSON.stringify(steps.getState()); env.clock.advance(10000);
  assert.equal(JSON.stringify(steps.getState()), settled, 'Completed elapsed time and milestones remain stable.');
});

test('Reply milestones record only observed Waiting, Thinking and Replying phases and stay truthful under reduced motion', () => {
  const env = createEnvironment();
  const slot = env.document.createElement('section'); env.q('#athena-codex').appendChild(slot);
  const reply = env.window.AthenaReply.mount(slot); env.cleanups.push(() => { reply.destroy(); slot.remove(); });
  reply.begin({ phase: 'waiting' });
  assert.deepEqual(localValue(reply.getState().steps.steps).map(step => step.id), ['waiting']);
  reply.setPhase('thinking', 'Reviewing the supplied files');
  reply.setPhase('preparing', 'Prepare read'); reply.setPhase('working', 'Read source');
  assert.deepEqual(localValue(reply.getState().steps.steps).map(step => step.id), ['waiting', 'thinking']);
  reply.append('Observed text'); reply.setPhase('working', 'Run bash'); reply.setPhase('thinking'); reply.append(' only.');
  assert.deepEqual(localValue(reply.getState().steps.steps).map(step => step.id), ['waiting', 'thinking', 'replying']);
  assert.equal(slot.querySelector('.ar-text').textContent, 'Observed text only.');
  env.setReduced(true); env.clock.advance(400);
  assert.equal(reply.getState().active, true);
  assert.equal(reply.getState().steps.reducedMotion, true);
  assert.equal(slot.querySelectorAll('.as-icon-state.is-leaving,.ar-stream-word.is-incoming').length, 0);
  reply.end({ status: 'done' });
  assert.equal(slot.querySelector('.ar-status-row').hidden, false);
  assert.equal(slot.querySelector('.as-header').getAttribute('aria-expanded'), 'false');
  assert.equal(slot.querySelector('.as-list-panel').hidden, true);
  assert.ok(reply.getState().steps.steps.every(step => step.status === 'done'));
  assert.equal(slot.querySelectorAll('[data-pi-active="true"],.as-spinner,.as-wave-letter').length, 0);
  reply.begin({ phase: 'thinking' }); reply.end({ status: 'error', detail: 'Host error' });
  assert.equal(reply.getState().steps.steps[0].status, 'error');
  assert.equal(slot.querySelector('.ar-phase-detail').textContent, 'Host error');
  reply.begin({ phase: 'waiting' }); reply.stop();
  assert.equal(reply.getState().steps.steps[0].status, 'stopped');
  env.clock.advance(400);
  assert.equal(slot.querySelectorAll('[data-pi-active="true"],.as-spinner,.as-wave-letter').length, 0);
});

test('Pi runtime gates all controls by connection capabilities and never reports unsupported work as successful', async () => {
  const env = createEnvironment(), runtime = runtimeFor(env);
  assert.equal(runtime.getCatalog().length, 53);
  assert.ok(runtime.getCatalog().every(action => action.available === false));
  await assert.rejects(runtime.execute('bash', { command: 'pwd' }), /Connect a Pi runtime/);
  const host = hostFor({ mode: 'rpc' });
  runtime.attach(host, { refresh: false });
  for (const command of env.window.AthenaPiRuntime.RPC_COMMANDS) assert.equal(runtime.available(command), true, command);
  for (const command of env.window.AthenaPiRuntime.NATIVE_COMMANDS) assert.equal(runtime.available(command), false, command);
  await assert.rejects(runtime.execute('reload'), /native Pi host adapter/);
  assert.equal(host.calls.length, 0); assert.equal(runtime.getState().lastResult, null);
  const narrow = hostFor({ capabilities: ['get_state'], respond: () => ({ sessionId: 'a', sessionName: 'Connected' }) });
  runtime.attach(narrow, { refresh: false });
  assert.equal(runtime.available('get_state'), true); assert.equal(runtime.available('abort'), false);
  assert.equal(runtime.available('stop_all'), false); assert.equal(runtime.available('invoke_command'), false);
  await runtime.execute('get_state');
  assert.equal(runtime.getState().session.id, 'a'); assert.equal(runtime.getState().session.name, 'Connected');
  assert.equal(runtime.getState().lastResult.error, undefined);
  const before = JSON.stringify(runtime.getState().lastResult);
  await assert.rejects(runtime.execute('new_session'), /does not expose/);
  assert.equal(JSON.stringify(runtime.getState().lastResult), before);
  assert.equal(narrow.calls.length, 1); assert.deepEqual(env.networkCalls, []);
});

test('Pi runtime correlates overlapping RPC responses and rejects mismatches, explicit failures and timeouts without leaked requests', async () => {
  const env = createEnvironment(), runtime = runtimeFor(env, { requestTimeoutMs: 1000 });
  const sent = [];
  runtime.attach({ mode: 'rpc', capabilities: ['get_state', 'get_session_stats'], subscribe() { return () => {}; }, send(wire) { sent.push(localValue(wire)); } }, { refresh: false });
  const session = runtime.execute('get_state'), stats = runtime.execute('get_session_stats');
  assert.equal(runtime.getPendingRequestCount(), 2); assert.notEqual(sent[0].id, sent[1].id);
  assert.equal(runtime.receive({ type: 'response', id: 'unknown', command: 'get_state', success: true, data: {} }), false);
  runtime.receive({ type: 'response', id: sent[1].id, command: 'get_session_stats', success: true, data: { tokens: { input: 7 } } });
  await stats; assert.equal(runtime.getState().stats.tokens.input, 7); assert.equal(runtime.getPendingRequestCount(), 1);
  runtime.receive({ type: 'response', id: sent[0].id, command: 'get_state', success: true, data: { sessionId: 'correct' } });
  await session; assert.equal(runtime.getState().session.id, 'correct'); assert.equal(runtime.getPendingRequestCount(), 0);
  const timersBefore = env.clock.counts().timeout;
  const mismatch = runtime.execute('get_state');
  const mismatchCheck = assert.rejects(mismatch, /command did not match/);
  runtime.receive({ type: 'response', id: sent.at(-1).id, command: 'get_session_stats', success: true, data: {} });
  await mismatchCheck;
  assert.equal(runtime.getPendingRequestCount(), 0); assert.equal(env.clock.counts().timeout, timersBefore, 'Rejected correlation clears its timeout immediately.');
  const rejected = runtime.execute('get_state'), rejectCheck = assert.rejects(rejected, /Provider unavailable/);
  runtime.receive({ type: 'response', id: sent.at(-1).id, command: 'get_state', success: false, error: 'Provider unavailable' });
  await rejectCheck;
  assert.equal(runtime.getState().lastResult.error, true); assert.match(runtime.getState().error, /Provider unavailable/);
  const timed = runtime.execute('get_state'), timeoutCheck = assert.rejects(timed, /No response from Pi/);
  env.clock.advance(1001); await timeoutCheck;
  assert.equal(runtime.getPendingRequestCount(), 0); assert.deepEqual(localValue(runtime.getState().busy), []);
  assert.equal(env.clock.counts().timeout, timersBefore);
});

test('Pi runtime rebind and disposal ignore late events, pending replies, old cleanup and late extension responses', async () => {
  const env = createEnvironment(), runtime = runtimeFor(env);
  const pending = deferred(), sentUI = deferred();
  const first = hostFor({ capabilities: ['get_state'], respond: () => pending.promise, send: () => sentUI.promise });
  const binding = runtime.attach(first, { refresh: false });
  let observed = 0; const unsubscribe = runtime.subscribeEvents(() => { observed++; });
  const old = runtime.execute('get_state'), oldCheck = assert.rejects(old, /connection changed/);
  runtime.receive({ type: 'extension_ui_request', method: 'input', id: 'old-input' });
  const response = runtime.respondUI('old-input', { value: 'Old' });
  const second = hostFor({ capabilities: ['get_state'], respond: () => ({ sessionId: 'second' }) });
  runtime.attach(second, { refresh: false });
  assert.equal(first.unsubscribed, 1); assert.equal(binding.detach(), false);
  const snapshot = JSON.stringify(runtime.getState());
  first.callbacks[0]({ type: 'agent_start' });
  first.callbacks[0]({ type: 'extension_ui_request', method: 'input', id: 'too-late' });
  assert.equal(JSON.stringify(runtime.getState()), snapshot); assert.equal(observed, 0);
  pending.resolve({ sessionId: 'obsolete' }); await oldCheck;
  sentUI.resolve(); assert.equal(await response, false);
  assert.equal(runtime.getState().session.id, undefined);
  await runtime.execute('get_state'); assert.equal(runtime.getState().session.id, 'second');
  second.emit({ type: 'agent_start' }); assert.equal(observed, 1);
  unsubscribe(); runtime.destroy();
  const destroyed = JSON.stringify(runtime.getState());
  second.callbacks[0]({ type: 'agent_start' }); runtime.receive({ type: 'agent_start' });
  assert.equal(observed, 1); assert.equal(JSON.stringify(runtime.getState()), destroyed);
  assert.equal(second.unsubscribed, 1); assert.equal(runtime.getPendingRequestCount(), 0);
  env.destroy(); assert.deepEqual(env.clock.counts(), { raf: 0, timeout: 0, interval: 0, microtasks: 0 });
});

test('Pi runtime keeps cancelled sessions and queues intact, clears recoverable text before cancellation, and blocks session switches during a run', async () => {
  const env = createEnvironment(), runtime = runtimeFor(env);
  let cancelled = true, abortFailure = true;
  const host = hostFor({ capabilities: ['get_state', 'new_session', 'clear_queue', 'abort'], respond(wire) {
    if (wire.type === 'get_state') return { sessionId: 'old', sessionName: 'Original' };
    if (wire.type === 'new_session') return { cancelled };
    if (wire.type === 'clear_queue') return { steering: ['Correct units'], followUp: ['Explain the result'] };
    if (wire.type === 'abort' && abortFailure) throw new Error('Cancellation failed');
    return {};
  } });
  runtime.attach(host, { refresh: false }); await runtime.execute('get_state');
  runtime.receive({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'Keep history' }] } });
  await runtime.execute('new_session');
  assert.equal(runtime.getState().session.id, 'old'); assert.equal(runtime.getState().messages.length, 1);
  assert.match(runtime.getState().lastResult.message, /cancelled/);
  runtime.receive({ type: 'agent_start' });
  const calls = host.calls.length;
  await assert.rejects(runtime.execute('new_session'), /settle before changing sessions/);
  assert.equal(host.calls.length, calls);
  runtime.receive({ type: 'queue_update', steering: ['Correct units'], followUp: ['Explain the result'] });
  await assert.rejects(runtime.execute('stop_all'), /Cancellation failed/);
  assert.deepEqual(host.calls.slice(-2).map(call => call.type), ['clear_queue', 'abort']);
  assert.deepEqual(localValue(runtime.getState().queues.steering), []);
  assert.deepEqual(localValue(runtime.getState().clearedQueue), { steering: ['Correct units'], followUp: ['Explain the result'] });
  assert.equal(runtime.getState().session.isStreaming, true, 'Cancellation rejection does not claim the run settled.');
  abortFailure = false; await runtime.execute('abort');
  assert.equal(runtime.getState().session.isStreaming, true); assert.match(runtime.getState().lastResult.message, /waiting for the runtime/);
  runtime.receive({ type: 'agent_settled', aborted: true });
  cancelled = false; await runtime.execute('new_session');
  assert.deepEqual(localValue(runtime.getState().messages), []); assert.deepEqual(localValue(runtime.getState().queues.followUp), []);
  assert.equal(runtime.getState().session.id, undefined);
});

test('Pi runtime accepts image-only prompts and validates model-dependent thinking levels and installed commands', async () => {
  const env = createEnvironment(), runtime = runtimeFor(env);
  let levels = ['off', 'low', 'high'];
  const host = hostFor({ capabilities: ['prompt', 'get_available_models', 'set_model', 'get_available_thinking_levels', 'set_thinking_level', 'get_commands'], respond(wire) {
    if (wire.type === 'get_available_models') return { models: [{ provider: 'fixture', id: 'vision', name: 'Vision' }, { provider: 'fixture', id: 'text', name: 'Text' }] };
    if (wire.type === 'get_available_thinking_levels') return { levels };
    if (wire.type === 'set_model') { levels = wire.modelId === 'text' ? ['off'] : ['off', 'low', 'high']; return { provider: wire.provider, id: wire.modelId }; }
    if (wire.type === 'get_commands') return { commands: [{ name: 'skill:review', source: 'skill' }, { name: 'summary', source: 'prompt' }] };
    return { disposition: 'queued' };
  } });
  runtime.attach(host, { refresh: false });
  const images = [{ type: 'image', mimeType: 'image/png', data: 'Zml4dHVyZQ==' }];
  await runtime.execute('prompt', { message: '', images });
  assert.deepEqual(host.calls[0].images, images); assert.equal(host.calls[0].message || '', '');
  assert.match(runtime.getState().lastResult.message, /queued/);
  await runtime.execute('get_available_models'); await runtime.execute('get_available_thinking_levels');
  await runtime.execute('set_thinking_level', { level: 'high' }); assert.equal(runtime.getState().thinkingLevel, 'high');
  await runtime.execute('set_model', { modelKey: 'fixture\u241ftext' }); await runtime.execute('get_available_thinking_levels');
  const count = host.calls.length;
  await assert.rejects(runtime.execute('set_thinking_level', { level: 'high' }), /supported by this model/);
  await assert.rejects(runtime.execute('set_model', { provider: 'other', modelId: 'invented' }), /returned by this connection/);
  assert.equal(host.calls.length, count);
  await runtime.execute('get_commands');
  runtime.receive({ type: 'agent_start' });
  await runtime.execute('invoke_command', { name: 'skill:review', arguments: 'Check event lifecycle' });
  assert.equal(host.calls.at(-1).type, 'prompt'); assert.equal(host.calls.at(-1).message, '/skill:review Check event lifecycle');
  assert.equal(host.calls.at(-1).streamingBehavior, 'followUp');
  await assert.rejects(runtime.execute('invoke_command', { name: 'invented' }), /installed command/);
});

test('Pi model changes discard stale state and supported-level reads before exposing new reasoning choices', async () => {
  const env = createEnvironment(), runtime = runtimeFor(env);
  const oldState = deferred(), oldLevels = deferred(), modelAccepted = deferred();
  const models = [{ provider: 'fixture', id: 'old' }, { provider: 'fixture', id: 'new' }];
  let selected = models[0], level = 'low', holdReads = false;
  const host = hostFor({ capabilities: ['get_state', 'get_available_models', 'set_model', 'get_available_thinking_levels', 'set_thinking_level'], async respond(wire) {
    if (wire.type === 'get_available_models') return { models };
    if (wire.type === 'get_state') return holdReads ? oldState.promise : { sessionId: 'same-session', model: selected, thinkingLevel: level };
    if (wire.type === 'get_available_thinking_levels') return holdReads ? oldLevels.promise : { levels: selected.id === 'old' ? ['off', 'low', 'high'] : ['off'] };
    if (wire.type === 'set_model') { await modelAccepted.promise; selected = models[1]; level = 'off'; return selected; }
    if (wire.type === 'set_thinking_level') { level = wire.level; return {}; }
    return {};
  } });
  runtime.attach(host, { refresh: false });
  await runtime.execute('get_state'); await runtime.execute('get_available_models'); await runtime.execute('get_available_thinking_levels');
  holdReads = true;
  const staleState = runtime.execute('get_state'), staleLevels = runtime.execute('get_available_thinking_levels');
  const changing = runtime.execute('set_model', { modelKey: 'fixture\u241fnew' });
  assert.equal(runtime.getState().thinkingLevelsPending, true);
  assert.deepEqual(localValue(runtime.getState().thinkingLevels), []);
  const count = host.calls.length;
  await assert.rejects(runtime.execute('set_thinking_level', { level: 'high' }));
  assert.equal(host.calls.length, count, 'No reasoning mutation is sent while its model is changing.');
  modelAccepted.resolve(); await changing;
  holdReads = false;
  await runtime.refresh(true);
  assert.equal(runtime.getState().model.id, 'new');
  assert.equal(runtime.getState().thinkingLevel, 'off');
  assert.deepEqual(localValue(runtime.getState().thinkingLevels), ['off']);
  assert.equal(runtime.getState().thinkingLevelsPending, false);
  oldState.resolve({ sessionId: 'same-session', model: models[0], thinkingLevel: 'high' });
  oldLevels.resolve({ levels: ['off', 'low', 'high'] });
  await staleState; await staleLevels;
  assert.equal(runtime.getState().model.id, 'new', 'An old get_state response cannot replace the selected model.');
  assert.equal(runtime.getState().thinkingLevel, 'off');
  assert.deepEqual(localValue(runtime.getState().thinkingLevels), ['off']);
  assert.equal(runtime.getState().thinkingLevelsPending, false);
});

test('Pi workbench preserves dirty drafts through state updates, reports failed actions and keeps unavailable native controls inert', async () => {
  const env = createEnvironment(), runtime = runtimeFor(env);
  const host = hostFor({ capabilities: ['set_session_name', 'get_state'], respond(wire) {
    if (wire.type === 'set_session_name') throw new Error('Rename rejected by host');
    return { sessionName: 'Host name' };
  } });
  runtime.attach(host, { refresh: false });
  const { view, q } = workbenchFor(env, runtime);
  assert.equal(view.getState().actions.length, 53);
  assert.equal(q('[data-apw-run="new_session"]').disabled, true);
  assert.match(q('[data-apw-action="new_session"] .apw-availability').textContent, /does not expose/);
  const action = q('[data-apw-action="set_session_name"]'); env.click(action.querySelector('summary'));
  const input = q('[data-apw-form="set_session_name"] [name="name"]');
  input.value = 'My unfinished draft'; fire(input, 'input'); input.focus();
  await runtime.execute('get_state'); runtime.receive({ type: 'session_info_changed', name: 'Changed elsewhere' });
  assert.equal(input.value, 'My unfinished draft'); assert.equal(env.document.activeElement, input);
  assert.equal(action.dataset.dirty, 'true'); assert.equal(action.open, true);
  fire(q('[data-apw-form="set_session_name"]'), 'submit');
  await env.waitFor(() => q('[data-apw-action="set_session_name"] .apw-form-result').dataset.tone === 'error');
  assert.match(q('[data-apw-action="set_session_name"] .apw-form-result').textContent, /Rename rejected by host/);
  assert.equal(input.value, 'My unfinished draft'); assert.equal(q('[data-apw-run="set_session_name"]').disabled, false);
  env.key(q('[data-apw-tab="session"]'), 'End');
  assert.equal(view.getState().section, 'extensions'); assert.equal(env.document.activeElement, q('[data-apw-tab="extensions"]'));
  env.key(q('[data-apw-tab="extensions"]'), 'Home'); assert.equal(view.getState().section, 'session');
  runtime.detach(); assert.equal(input.value, 'My unfinished draft'); assert.equal(q('[data-apw-run="set_session_name"]').disabled, true);
  assert.equal(q('[data-apw-action="set_session_name"] .apw-form-result').dataset.tone, 'error');
});

test('Pi workbench refreshes supported reasoning choices and offers cleared queue text for explicit draft recovery', async () => {
  const env = createEnvironment(), runtime = runtimeFor(env), drafts = [];
  let levels = ['off', 'high'];
  const host = hostFor({ capabilities: ['get_available_thinking_levels', 'set_thinking_level', 'clear_queue'], respond(wire) {
    if (wire.type === 'get_available_thinking_levels') return { levels };
    if (wire.type === 'clear_queue') return { steering: ['Use SI units'], followUp: ['Show limitations'] };
    return {};
  } });
  runtime.attach(host, { refresh: false });
  const { view, q } = workbenchFor(env, runtime, { onDraft(value) { drafts.push(value); } });
  await runtime.execute('get_available_thinking_levels'); view.open('model');
  const action = q('[data-apw-action="set_thinking_level"]'); env.click(action.querySelector('summary'));
  const select = q('[data-apw-form="set_thinking_level"] select');
  select.value = 'high'; fire(select, 'change');
  levels = ['off']; await runtime.execute('get_available_thinking_levels');
  assert.equal(select.value, 'high', 'An unfinished selection is retained and marked unavailable instead of silently changed.');
  assert.equal(select.selectedOptions[0].disabled, true);
  const before = host.calls.length; fire(q('[data-apw-form="set_thinking_level"]'), 'submit');
  assert.equal(host.calls.length, before); assert.equal(select.getAttribute('aria-invalid'), 'true');
  select.value = 'off'; fire(select, 'change'); fire(q('[data-apw-form="set_thinking_level"]'), 'submit');
  await env.waitFor(() => runtime.getState().thinkingLevel === 'off');
  await runtime.execute('clear_queue'); view.open('queue');
  const recover = q('[data-apw-draft="Use SI units"]');
  assert.equal(drafts.length, 0); env.click(recover.closest('details').querySelector('summary')); env.click(recover);
  assert.deepEqual(drafts, ['Use SI units']);
  assert.deepEqual(localValue(runtime.getState().clearedQueue.followUp), ['Show limitations']);
});

test('Pi extension events cover all nine UI methods, reject invalid selections and sanitize stored results', async () => {
  const env = createEnvironment(), runtime = runtimeFor(env);
  const host = hostFor({ capabilities: ['get_messages'], respond: () => ({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'Private hidden reasoning' }, { type: 'text', text: '<script>visible as text</script>' }, { type: 'image', mimeType: 'image/png', data: 'image-secret' }] }], apiKey: 'secret-key' }) });
  runtime.attach(host, { refresh: false });
  for (const method of ['select', 'confirm', 'input', 'editor']) {
    assert.equal(runtime.receive({ type: 'extension_ui_request', method, id: method, title: method, options: ['Keep', 'Skip'], prefill: 'Draft' }), true);
  }
  assert.equal(runtime.receive({ type: 'extension_ui_request', method: 'select', id: 'select', options: ['Keep'] }), false);
  await assert.rejects(runtime.respondUI('select', { value: 'Invented choice' }), /offered options/);
  assert.equal(host.calls.length, 0);
  await runtime.respondUI('select', { value: 'Keep' }); await runtime.respondUI('confirm', { confirmed: false });
  await runtime.respondUI('input', { value: '' }); await runtime.respondUI('editor', { cancelled: true });
  assert.equal(runtime.getState().ui.requests.length, 0);
  assert.deepEqual(host.calls.map(call => [call.id, call.value ?? call.confirmed ?? call.cancelled]), [['select', 'Keep'], ['confirm', false], ['input', ''], ['editor', true]]);
  runtime.receive({ type: 'extension_ui_request', method: 'notify', message: 'New notice', notifyType: 'warning' });
  runtime.receive({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'branch', statusText: 'main' });
  runtime.receive({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'checks', widgetLines: ['One', '<img onerror=x()>'], widgetPlacement: 'belowEditor' });
  runtime.receive({ type: 'extension_ui_request', method: 'setTitle', title: 'Analysis session' });
  runtime.receive({ type: 'extension_ui_request', method: 'set_editor_text', text: 'Suggested draft' });
  const ui = runtime.getState().ui;
  assert.equal(ui.notifications[0].notifyType, 'warning'); assert.equal(ui.statuses[0].text, 'main');
  assert.equal(ui.widgets[0].placement, 'belowEditor'); assert.equal(ui.title, 'Analysis session'); assert.equal(ui.editorText, 'Suggested draft');
  runtime.receive({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'branch' });
  runtime.receive({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'checks' });
  assert.equal(runtime.getState().ui.statuses.length, 0); assert.equal(runtime.getState().ui.widgets.length, 0);
  await runtime.execute('get_messages');
  const serialized = JSON.stringify(runtime.getState());
  assert.ok(!serialized.includes('Private hidden reasoning') && !serialized.includes('image-secret') && !serialized.includes('secret-key'));
  assert.equal(runtime.getState().messages[0].content[0].hidden, true);
});

test('Pi extension dialogs queue, validate, restore focus, retain failed responses and expire without invented answers', async () => {
  const env = createEnvironment(), runtime = runtimeFor(env), modalStates = [], notices = [];
  let rejectResponse = false;
  const host = hostFor({ capabilities: [], send() { if (rejectResponse) throw new Error('Reply channel unavailable'); } });
  runtime.attach(host, { refresh: false });
  const { view, q } = workbenchFor(env, runtime, { onModalChange(value) { modalStates.push(value); }, toast(value) { notices.push(value); } });
  const opener = q('[data-apw-tab="session"]'); opener.focus();
  runtime.receive({ type: 'extension_ui_request', method: 'select', id: 'pick', title: '<img onerror=bad()>', options: ['One', 'Two'] });
  const dialog = env.q('[data-apw-request="pick"]'), form = dialog.querySelector('form'), input = dialog.querySelector('select');
  assert.equal(view.isDialogOpen(), true); assert.equal(env.document.activeElement, input);
  assert.equal(dialog.querySelector('img'), null); assert.match(dialog.querySelector('h2').textContent, /<img/);
  fire(form, 'submit'); assert.equal(host.calls.length, 0); assert.match(dialog.querySelector('form .apw-error').textContent, /Choose an option/);
  const first = dialog.querySelector('.apw-dialog-close'), last = dialog.querySelector('.apw-primary');
  last.focus(); env.key(last, 'Tab'); assert.equal(env.document.activeElement, first);
  env.key(first, 'Tab', { shiftKey: true }); assert.equal(env.document.activeElement, last);
  input.value = 'Two'; fire(input, 'change'); rejectResponse = true; fire(form, 'submit');
  await env.waitFor(() => dialog.querySelector('form .apw-error').textContent.includes('Reply channel unavailable'));
  assert.equal(view.isDialogOpen(), true); assert.equal(input.disabled, false); assert.equal(input.value, 'Two');
  rejectResponse = false; fire(form, 'submit'); await env.waitFor(() => !view.isDialogOpen());
  assert.equal(env.document.activeElement, opener); assert.equal(runtime.getState().ui.requests.length, 0);
  runtime.receive({ type: 'extension_ui_request', method: 'confirm', id: 'confirm', title: 'Proceed?' });
  assert.equal(env.document.activeElement.textContent.trim(), 'Decline');
  env.click(env.document.activeElement); await env.waitFor(() => !view.isDialogOpen());
  assert.equal(host.calls.at(-1).confirmed, false);
  runtime.receive({ type: 'extension_ui_request', method: 'input', id: 'input', prefill: 'Name' });
  runtime.receive({ type: 'extension_ui_request', method: 'editor', id: 'editor', prefill: 'Two\nlines' });
  assert.equal(view.getState().requestId, 'input'); assert.equal(env.document.activeElement.value, 'Name');
  env.key(env.document.activeElement, 'Escape'); await env.waitFor(() => view.getState().requestId === 'editor');
  assert.equal(host.calls.at(-1).cancelled, true); assert.equal(env.document.activeElement.localName, 'textarea');
  assert.equal(env.document.activeElement.value, 'Two\nlines');
  env.document.activeElement.value = 'Edited\ntext'; fire(env.q('[data-apw-request="editor"] form'), 'submit');
  await env.waitFor(() => !view.isDialogOpen()); assert.equal(host.calls.at(-1).value, 'Edited\ntext');
  const count = host.calls.length;
  runtime.receive({ type: 'extension_ui_request', method: 'input', id: 'expires', title: 'Temporary request', timeout: 500 });
  env.clock.advance(501);
  await env.waitFor(() => !view.isDialogOpen());
  assert.equal(host.calls.length, count + 1, 'Expiry sends a cancellation result before removing the pending request.');
  assert.equal(host.calls.at(-1).id, 'expires'); assert.equal(host.calls.at(-1).cancelled, true);
  assert.equal(env.document.activeElement, opener); assert.ok(notices.some(message => /expired/.test(message)));
  assert.equal(modalStates[0], true); assert.equal(modalStates.at(-1), false);
  runtime.receive({ type: 'extension_ui_request', method: 'input', id: 'dispose', timeout: 10000 });
  env.destroy(); assert.deepEqual(env.clock.counts(), { raf: 0, timeout: 0, interval: 0, microtasks: 0 });
  assert.equal(env.qa('[data-pi-workbench],[data-apw-dialog-backdrop]').length, 0);
});

test('Extension request pages retain every pending request and a failed cancellation keeps its original dialog', async () => {
  const env = createEnvironment(), runtime = runtimeFor(env);
  let rejectCancellation = true;
  const host = hostFor({ capabilities: [], send(wire) { if (wire.cancelled && rejectCancellation) throw new Error('Cancellation delivery failed'); } });
  runtime.attach(host, { refresh: false });
  const { view, q } = workbenchFor(env, runtime);
  view.open('extensions');
  for (let index = 0; index < 25; index++) runtime.receive({ type: 'extension_ui_request', method: 'input', id: 'pending-' + index, title: 'Pending ' + index, prefill: 'Original draft ' + index });
  assert.equal(runtime.getState().ui.requests.length, 25);
  assert.equal(view.getState().requestId, 'pending-0');
  assert.equal(q('.apw-pending-requests').querySelectorAll('[data-apw-pending-request]').length, 20);
  env.click(q('[data-apw-request-page="1"]'));
  assert.equal(q('.apw-pending-requests').querySelectorAll('[data-apw-pending-request]').length, 5);
  assert.match(q('.apw-pending-requests').textContent, /21–25 of 25/);
  assert.equal(runtime.getState().ui.requests.length, 25, 'Changing pages cannot resolve or discard pending requests.');
  const input = env.q('[data-apw-request="pending-0"] input');
  input.value = 'Keep my unfinished response';
  env.key(input, 'Escape');
  await env.waitFor(() => env.q('[data-apw-request="pending-0"] form .apw-error')?.textContent.includes('Cancellation delivery failed'));
  assert.equal(view.getState().requestId, 'pending-0');
  assert.equal(input.value, 'Keep my unfinished response');
  assert.equal(runtime.getState().ui.requests.length, 25);
  rejectCancellation = false;
  env.key(input, 'Escape');
  await env.waitFor(() => view.getState().requestId === 'pending-1');
  assert.equal(host.calls.at(-1).id, 'pending-0'); assert.equal(host.calls.at(-1).cancelled, true);
  assert.equal(runtime.getState().ui.requests.length, 24);
});

test('Chat model menu stays in the composer, explains offline state, and supports search, keyboard focus and outside dismissal', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp;
  const trigger = env.q('#ac-chat-model-trigger');
  assert.ok(env.q('#ac-composer-slot').contains(trigger));
  assert.equal(env.qa('.ac-header [data-action="model-settings"]').length, 0);
  env.click(trigger);
  assert.equal(env.state().settingsOpen, false);
  assert.equal(env.q('#ac-chat-model-menu').getAttribute('role'), 'dialog');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(env.qa('[data-acmp-model]').length, 0, 'Disconnected previews do not invent available models.');
  assert.match(env.q('#ac-chat-model-menu').textContent, /connect/i);
  env.click('[data-acmp-settings]');
  assert.equal(env.q('#ast-panel-models').hidden, false);
  app.closeSettings();

  const models = [{ provider: 'local', id: 'alpha', name: 'Alpha' }, { provider: 'local', id: 'beta', name: 'Beta' }, { provider: 'remote', id: 'gamma', name: 'Gamma' }];
  const host = hostFor({ capabilities: ['get_state', 'get_available_models', 'set_model'], respond(wire) {
    if (wire.type === 'get_state') return { sessionId: 'picker', model: models[0] };
    if (wire.type === 'get_available_models') return { models };
    return models.find(model => model.id === wire.modelId);
  } });
  app.attachPiTransport(host, { refresh: false });
  await app.executePi('get_state'); await app.executePi('get_available_models');
  env.type('#ac-prompt-input', 'Keep this draft while choosing a model');
  env.click(trigger);
  const search = env.q('#ac-chat-model-menu input[aria-label="Search models"]');
  assert.equal(env.document.activeElement, search);
  env.type('#ac-chat-model-menu input[aria-label="Search models"]', 'gamma');
  assert.deepEqual(env.qa('[data-acmp-model]').filter(row => !row.hidden).map(row => row.dataset.acmpModel), ['remote\u241fgamma']);
  env.type('#ac-chat-model-menu input[aria-label="Search models"]', '');
  env.key(search, 'ArrowDown');
  let rows = env.qa('[data-acmp-model]').filter(row => !row.hidden);
  assert.equal(env.document.activeElement, rows[0]);
  assert.equal(rows.filter(row => !row.disabled && row.tabIndex === 0).length, 1);
  assert.equal(rows[0].tabIndex, 0);
  env.key(rows[0], 'End'); assert.equal(env.document.activeElement, rows.at(-1));
  assert.equal(rows.filter(row => !row.disabled && row.tabIndex === 0).length, 1); assert.equal(rows.at(-1).tabIndex, 0);
  assert.equal(env.key(rows.at(-1), 'Tab').defaultPrevented, false, 'Tab leaves the option group through the menu controls; it does not visit every option.');
  env.key(rows.at(-1), 'Home'); assert.equal(env.document.activeElement, rows[0]);
  assert.equal(rows.filter(row => !row.disabled && row.tabIndex === 0).length, 1); assert.equal(rows[0].tabIndex, 0);
  assert.equal(env.key(rows[0], 'Tab', { shiftKey: true }).defaultPrevented, false);
  const menuControls = env.qa('#ac-chat-model-menu button:not([disabled]),#ac-chat-model-menu input').filter(node => !node.closest('[hidden]') && node.tabIndex !== -1);
  menuControls.at(-1).focus();
  assert.equal(env.key(menuControls.at(-1), 'Tab').defaultPrevented, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false'); assert.equal(env.document.activeElement, trigger);
  env.click(trigger); env.key(search, 'ArrowDown'); rows = env.qa('[data-acmp-model]').filter(row => !row.hidden);
  env.key(rows[0], 'Escape');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(env.document.activeElement, trigger);
  env.click(trigger); env.click('#ac-prompt-input');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(env.state().prompt, 'Keep this draft while choosing a model');
  assert.equal(env.state().settingsOpen, false);
  assert.equal(host.calls.filter(call => call.type === 'set_model').length, 0);
  assert.deepEqual(env.networkCalls, []);
});

test('Chat picks wait for host confirmation, preserve failures and drafts, and share model and reasoning state with Settings', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp, accepted = deferred();
  const models = [{ provider: 'fixture', id: 'first', name: 'First model' }, { provider: 'fixture', id: 'second', name: 'Second model' }];
  let selected = models[0], level = 'low', rejectSelection = true;
  const host = hostFor({ capabilities: ['get_state', 'get_available_models', 'set_model', 'get_available_thinking_levels', 'set_thinking_level', 'prompt'], async respond(wire) {
    if (wire.type === 'get_state') return { sessionId: 'picker-confirmation', model: selected, thinkingLevel: level };
    if (wire.type === 'get_available_models') return { models };
    if (wire.type === 'get_available_thinking_levels') return { levels: ['off', 'low', 'high'] };
    if (wire.type === 'set_model') {
      if (rejectSelection) throw new Error('Provider rejected this model');
      await accepted.promise; selected = models.find(model => model.id === wire.modelId); return selected;
    }
    if (wire.type === 'set_thinking_level') { level = wire.level; return {}; }
    return {};
  } });
  app.attachPiTransport(host, { refresh: false });
  await app.executePi('get_state'); await app.executePi('get_available_models'); await app.executePi('get_available_thinking_levels');
  env.type('#ac-prompt-input', 'Retain my unsent question');
  env.click('#ac-chat-model-trigger'); env.click('[data-acmp-model="fixture\u241fsecond"]');
  await env.waitFor(() => !env.state().modelPicker.pending);
  assert.equal(env.state().piRuntime.model.id, 'first');
  assert.equal(env.q('#aw-model-label').textContent, 'First model');
  assert.match(env.q('#ac-chat-model-menu [role="alert"]').textContent, /Provider rejected this model/);
  assert.equal(env.state().prompt, 'Retain my unsent question');
  rejectSelection = false;
  env.click('[data-acmp-model="fixture\u241fsecond"]');
  assert.equal(env.state().piRuntime.model.id, 'first', 'Pending requests do not optimistically select a model.');
  assert.ok(env.state().modelPicker.pending);
  env.click('.acm-send');
  assert.equal(env.state().prompt, 'Retain my unsent question');
  assert.equal(host.calls.filter(call => call.type === 'prompt').length, 0, 'Sending during a model switch preserves the draft without using the previous model.');
  accepted.resolve();
  await env.waitFor(() => env.state().piRuntime.model.id === 'second' && !env.state().modelPicker.pending);
  assert.equal(env.q('#aw-model-label').textContent, 'Second model');
  assert.equal(env.q('#ac-chat-model-trigger').getAttribute('aria-expanded'), 'false');
  assert.equal(env.state().settingsOpen, false);
  assert.equal(env.state().prompt, 'Retain my unsent question');
  await app.executePi('get_available_thinking_levels');
  app.openPi('model');
  assert.match(env.q('[data-apw-panel="model"]').textContent, /Second model/);
  const action = env.q('[data-apw-action="set_thinking_level"]');
  if (!action.open) env.click(action.querySelector('summary'));
  const select = env.q('[data-apw-form="set_thinking_level"] select');
  select.value = 'high'; fire(select, 'change'); fire(env.q('[data-apw-form="set_thinking_level"]'), 'submit');
  await env.waitFor(() => env.state().piRuntime.thinkingLevel === 'high');
  app.closeSettings();
  assert.match(env.q('#ac-chat-reasoning-label').textContent, /High/);
  env.click('#ac-chat-reasoning-trigger');
  await env.waitFor(() => env.qa('[data-acmp-level="low"]').some(row => !row.disabled));
  env.click('[data-acmp-level="low"]');
  await env.waitFor(() => env.state().piRuntime.thinkingLevel === 'low' && !env.state().modelPicker.pending);
  app.openPi('model');
  assert.equal(env.q('[data-apw-form="set_thinking_level"] select').value, 'low');
  assert.equal(host.calls.filter(call => call.type === 'prompt').length, 0);
});

test('Chat reasoning follows model capabilities and model choices are gated during work and after disconnect', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp;
  const models = [{ provider: 'fixture', id: 'reasoner', name: 'Reasoner', reasoning: true }, { provider: 'fixture', id: 'plain', name: 'Plain', reasoning: false }];
  let selected = models[0], level = 'low';
  const host = hostFor({ capabilities: ['get_state', 'get_available_models', 'set_model', 'get_available_thinking_levels', 'set_thinking_level'], respond(wire) {
    if (wire.type === 'get_state') return { sessionId: 'picker-capabilities', model: selected, thinkingLevel: level };
    if (wire.type === 'get_available_models') return { models };
    if (wire.type === 'get_available_thinking_levels') return { levels: selected.id === 'plain' ? ['off'] : ['off', 'low', 'high'] };
    if (wire.type === 'set_model') { selected = models.find(model => model.id === wire.modelId); level = 'off'; return selected; }
    if (wire.type === 'set_thinking_level') { level = wire.level; return {}; }
    return {};
  } });
  app.attachPiTransport(host, { refresh: false });
  await app.executePi('get_state'); await app.executePi('get_available_models'); await app.executePi('get_available_thinking_levels');
  env.click('#ac-chat-reasoning-trigger');
  await env.waitFor(() => env.qa('[data-acmp-level]').length === 3);
  assert.deepEqual(env.qa('[data-acmp-level]').map(row => row.dataset.acmpLevel), ['off', 'low', 'high']);
  env.key(env.document.activeElement, 'Escape');
  env.click('#ac-chat-model-trigger');
  host.emit({ type: 'agent_start' });
  assert.ok(env.qa('[data-acmp-model]').every(row => row.disabled), 'An active run cannot be reconfigured from chat.');
  host.emit({ type: 'agent_settled' });
  assert.ok(env.qa('[data-acmp-model]').every(row => !row.disabled));
  env.click('[data-acmp-model="fixture\u241fplain"]');
  await env.waitFor(() => env.state().piRuntime.model.id === 'plain' && !env.state().modelPicker.pending);
  await app.executePi('get_state'); await app.executePi('get_available_thinking_levels');
  env.click('#ac-chat-reasoning-trigger');
  await env.waitFor(() => !env.state().piRuntime.thinkingLevelsPending);
  assert.equal(env.qa('[data-acmp-level="high"]').length, 0);
  assert.ok(env.qa('[data-acmp-level]').every(row => row.dataset.acmpLevel === 'off'));
  env.key(env.document.activeElement, 'Escape');
  env.click('#ac-chat-model-trigger');
  host.emit({ type: 'compaction_start' });
  assert.ok(env.qa('[data-acmp-model]').every(row => row.disabled));
  app.detachPiSession();
  assert.equal(env.qa('[data-acmp-model]').filter(row => !row.closest('[hidden]')).length, 0);
  assert.equal(env.qa('[data-acmp-level]').filter(row => !row.closest('[hidden]')).length, 0);
  assert.equal(env.state().piRuntime.connected, false);
  assert.equal(host.calls.filter(call => call.type === 'set_thinking_level').length, 0);
});

test('Connected Pi commands appear in the composer menu and only stage exact command names without sending or losing instructions', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp;
  let commands = [{ name: 'skill:review', source: 'skill', description: 'Review changes' }, { name: 'summarize', source: 'prompt' }, { name: 'extension-check', source: 'extension' }, { name: 'skill:review', source: 'skill' }, { name: 'invalid command', source: 'extension' }];
  const host = hostFor({ capabilities: ['get_state', 'get_commands', 'prompt'], respond(wire) { return wire.type === 'get_state' ? { sessionId: 'commands-session' } : wire.type === 'get_commands' ? { commands } : { disposition: 'handled' }; } });
  app.attachPiTransport(host, { refresh: false }); await app.executePi('get_state'); await app.executePi('get_commands');
  env.type('#ac-prompt-input', 'Keep the equations'); env.click('.acm-add-trigger');
  assert.equal(env.qa('.acm-picker-row').filter(row => !row.hidden)[0].id, 'ac-mention-option-upload');
  assert.equal(env.qa('[data-runtime-command]').length, 3);
  assert.equal(env.q('#ac-mention-option-python').hidden, true);
  assert.equal(env.q('#ac-mention-option-literature-review').hidden, true);
  assert.match(env.q('#ac-mention-listbox').textContent, /Sample project context/);
  const review = env.q('[data-runtime-command="skill:review"]');
  assert.equal(review.getAttribute('role'), 'menuitem');
  const search = env.q('.acm-picker-search input'); env.type('.acm-picker-search input', 'review'); search.focus();
  await app.executePi('get_commands');
  assert.equal(env.q('[data-runtime-command="skill:review"]'), review);
  assert.equal(search.value, 'review'); assert.equal(env.document.activeElement, search);
  env.click(review);
  assert.equal(env.state().prompt, '/skill:review Keep the equations');
  assert.equal(env.state().busy, false); assert.equal(host.calls.filter(call => call.type === 'prompt').length, 0);
  assert.equal(env.q('#ac-composer-slot').__athenaComposer.getSelections().length, 0);
  env.click('.acm-add-trigger'); env.click('[data-runtime-command="summarize"]');
  assert.equal(env.state().prompt, '/summarize Keep the equations');
  assert.equal(host.calls.filter(call => call.type === 'prompt').length, 0);
  env.click('.acm-send'); await env.waitFor(() => !env.state().busy && host.calls.some(call => call.type === 'prompt'));
  assert.equal(host.calls.find(call => call.type === 'prompt').message, '/summarize Keep the equations');
  commands = []; app.detachPiSession(); env.click('.acm-add-trigger');
  assert.equal(env.qa('[data-runtime-command]').length, 0); assert.equal(env.q('#ac-mention-option-python').hidden, false);
});

test('Connected Pi images and text files reach the attached host, unsupported files and rejected sends preserve retryable drafts', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp, composer = env.q('#ac-composer-slot').__athenaComposer;
  let accept = false;
  const host = hostFor({ capabilities: ['prompt', 'get_state'], respond(wire) {
    if (wire.type === 'get_state') return { sessionId: 'attachments-session', model: { provider: 'fixture', id: 'vision', input: ['text', 'image'] } };
    if (!accept) throw new Error('Temporary provider failure');
    return { disposition: 'handled' };
  } });
  app.attachPiTransport(host, { refresh: false }); await app.executePi('get_state');
  const image = new File(['image fixture'], 'diagram.png', { type: 'image/png' });
  const source = new File(['<script>literal source</script>'], 'notes.md', { type: 'text/markdown' });
  const input = env.q('.acm-file-input');
  Object.defineProperty(input, 'files', { configurable: true, value: [image, source] }); fire(input, 'change');
  env.type('#ac-prompt-input', 'Read these'); env.click('.acm-send');
  await env.waitFor(() => env.state().reply.phase === 'error');
  assert.equal(env.state().busy, false); assert.equal(env.state().prompt, 'Read these');
  assert.equal(composer.getAttachments().length, 2, 'Host rejection keeps both original File objects for a retry.');
  assert.equal(composer.getAttachments()[0], image); assert.equal(composer.getAttachments()[1], source);
  const request = host.calls.find(call => call.type === 'prompt');
  assert.match(request.message, /Read these\n\n\[Attached file: notes.md\]/);
  assert.match(request.message, /<script>literal source<\/script>/);
  assert.equal(request.images[0].mimeType, 'image/png'); assert.equal(request.images[0].data, Buffer.from('image fixture').toString('base64'));
  assert.equal(env.qa('#ac-live-user script,.acm-contexts script').length, 0);
  accept = true; env.click('.acm-send'); await env.waitFor(() => !env.state().busy && host.calls.filter(call => call.type === 'prompt').length === 2);
  assert.equal(composer.getAttachments().length, 0);
  Object.defineProperty(input, 'files', { configurable: true, value: [image] }); fire(input, 'change');
  env.click('.acm-send'); await env.waitFor(() => !env.state().busy && host.calls.filter(call => call.type === 'prompt').length === 3);
  assert.equal(host.calls.filter(call => call.type === 'prompt').at(-1).images.length, 1, 'An image-only message is accepted.');
  const unsupported = new File(['pdf fixture'], 'paper.pdf', { type: 'application/pdf' });
  Object.defineProperty(input, 'files', { configurable: true, value: [unsupported] }); fire(input, 'change');
  env.type('#ac-prompt-input', 'Keep this draft'); const before = host.calls.length; env.click('.acm-send');
  await env.waitFor(() => env.q('#ac-toast').textContent.includes('file-reference service'));
  assert.equal(host.calls.length, before); assert.equal(composer.getAttachments()[0], unsupported); assert.equal(env.state().prompt, 'Keep this draft');
  assert.deepEqual(env.networkCalls, []);
});

test('Composer sends the exact leading, trailing and indented whitespace entered by the user', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp;
  const host = hostFor({ capabilities: ['get_state', 'prompt'], respond(wire) { return wire.type === 'get_state' ? { sessionId: 'exact-text', model: { provider: 'fixture', id: 'text' } } : { disposition: 'handled' }; } });
  app.attachPiTransport(host, { refresh: false }); await app.executePi('get_state');
  const value = '  \n\tKeep this indentation.\n    Code and trailing spaces.  \n\n';
  env.type('#ac-prompt-input', value); env.click('.acm-send');
  await env.waitFor(() => host.calls.some(call => call.type === 'prompt') && !env.state().busy);
  assert.equal(host.calls.find(call => call.type === 'prompt').message, value);
  assert.equal(env.state().lastSubmission.text, value);
  assert.equal(env.q('#ac-live-user').textContent, value);
});

test('A newer composer draft survives an asynchronous attachment read and acknowledgment of the original send', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp, read = deferred();
  const composer = env.q('#ac-composer-slot').__athenaComposer;
  let reading = false;
  const host = hostFor({ capabilities: ['get_state', 'prompt'], respond(wire) { return wire.type === 'get_state' ? { sessionId: 'slow-read', model: { provider: 'fixture', id: 'text' } } : { disposition: 'handled' }; } });
  app.attachPiTransport(host, { refresh: false }); await app.executePi('get_state');
  const original = new File(['Deferred text contents'], 'slow.txt', { type: 'text/plain' });
  Object.defineProperty(original, 'text', { value() { reading = true; return read.promise; } });
  const later = new File(['Newer attachment'], 'newer.txt', { type: 'text/plain' });
  const input = env.q('.acm-file-input');
  Object.defineProperty(input, 'files', { configurable: true, value: [original] }); fire(input, 'change');
  env.type('#ac-prompt-input', 'Original request'); env.click('.acm-send');
  await env.waitFor(() => reading);
  const newerText = '  A newer unsent draft\n';
  env.type('#ac-prompt-input', newerText);
  Object.defineProperty(input, 'files', { configurable: true, value: [later] }); fire(input, 'change');
  read.resolve('Deferred text contents');
  await env.waitFor(() => host.calls.some(call => call.type === 'prompt') && !env.state().busy);
  assert.match(host.calls.find(call => call.type === 'prompt').message, /^Original request\n\n\[Attached file: slow\.txt\]/);
  assert.equal(env.state().prompt, newerText, 'Preparing the prior send cannot clear newer input.');
  assert.ok(composer.getAttachments().includes(later), 'Acknowledging the prior send cannot clear newer files.');
});

test('An attachment-only newer draft survives delayed file staging for an earlier send', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp, staged = deferred();
  const composer = env.q('#ac-composer-slot').__athenaComposer, stagedCalls = [];
  const host = hostFor({ capabilities: ['get_state', 'prompt'], respond(wire) { return wire.type === 'get_state' ? { sessionId: 'file-stage', model: { provider: 'fixture', id: 'text' } } : { disposition: 'handled' }; } });
  host.supportsFileReferences = true;
  host.stageFiles = (files, context) => { stagedCalls.push({ files, context }); return staged.promise; };
  app.attachPiTransport(host, { refresh: false }); await app.executePi('get_state');
  const original = new File(['Original PDF'], 'original.pdf', { type: 'application/pdf' });
  const later = new File(['Unsent PDF'], 'unsent.pdf', { type: 'application/pdf' });
  const input = env.q('.acm-file-input');
  Object.defineProperty(input, 'files', { configurable: true, value: [original] }); fire(input, 'change');
  env.type('#ac-prompt-input', 'Read the original'); env.click('.acm-send');
  await env.waitFor(() => stagedCalls.length === 1);
  assert.equal(stagedCalls[0].files[0], original);
  env.type('#ac-prompt-input', ''); env.click('[aria-label="Remove attachment original.pdf"]');
  Object.defineProperty(input, 'files', { configurable: true, value: [later] }); fire(input, 'change');
  staged.resolve({ fileReferences: [{ id: 'stored-original', projectId: null, name: original.name, mimeType: original.type, size: original.size, versionId: '1' }] });
  await env.waitFor(() => host.calls.some(call => call.type === 'prompt') && !env.state().busy);
  assert.equal(host.calls.find(call => call.type === 'prompt').fileReferences[0].id, 'stored-original');
  assert.equal(env.state().prompt, '');
  assert.equal(composer.getAttachments().length, 1); assert.equal(composer.getAttachments()[0], later);
});

test('Disconnect before prompt acknowledgment keeps the complete original message and Files recoverable beside a newer draft', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp, accepted = deferred();
  const composer = env.q('#ac-composer-slot').__athenaComposer;
  const host = hostFor({ capabilities: ['get_state', 'prompt'], respond(wire) { return wire.type === 'get_state' ? { sessionId: 'pending-ack', model: { provider: 'fixture', id: 'text' } } : accepted.promise; } });
  app.attachPiTransport(host, { refresh: false }); await app.executePi('get_state');
  const originalText = '  Original unsent request\nwith its final whitespace. \n';
  const original = new File(['Full original attachment'], 'original.txt', { type: 'text/plain' });
  const later = new File(['Newer draft attachment'], 'later.txt', { type: 'text/plain' });
  const input = env.q('.acm-file-input');
  Object.defineProperty(input, 'files', { configurable: true, value: [original] }); fire(input, 'change');
  env.type('#ac-prompt-input', originalText); env.click('.acm-send');
  await env.waitFor(() => host.calls.some(call => call.type === 'prompt'));
  env.type('#ac-prompt-input', 'My newer draft'); env.click('[aria-label="Remove attachment original.txt"]');
  Object.defineProperty(input, 'files', { configurable: true, value: [later] }); fire(input, 'change');
  app.detachPiSession();
  assert.equal(env.state().prompt, 'My newer draft'); assert.equal(env.state().busy, false);
  assert.equal(env.q('#ac-unsent-draft').hidden, false);
  env.click('[data-action="restore-unsent"]');
  assert.equal(env.state().prompt, originalText + '\n\nMy newer draft');
  assert.ok(composer.getAttachments().includes(original)); assert.ok(composer.getAttachments().includes(later));
  assert.equal(env.q('#ac-unsent-draft').hidden, true);
  accepted.resolve({ disposition: 'handled' }); await new Promise(resolve => setImmediate(resolve)); env.clock.flush();
  assert.equal(env.state().prompt, originalText + '\n\nMy newer draft', 'A late response from the detached host cannot consume the recovered draft.');
  assert.ok(composer.getAttachments().includes(original)); assert.ok(composer.getAttachments().includes(later));
});

test('A newly created session without a matching model binding blocks sends and model choices from the old session', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp;
  const models = [{ provider: 'fixture', id: 'model-a' }, { provider: 'fixture', id: 'model-b' }];
  const host = hostFor({ capabilities: ['get_state', 'get_available_models', 'set_model', 'prompt'], respond(wire) {
    if (wire.type === 'get_state') return { sessionId: 'session-a', sessionName: 'Conversation A', model: models[0] };
    if (wire.type === 'get_available_models') return { models };
    return { disposition: 'handled' };
  } });
  app.attachPiTransport(host, { refresh: false }); await app.executePi('get_state'); await app.executePi('get_available_models');
  app.attachConnectionManager({ async createSession() { return { sessionId: 'session-b', projectId: 'project-b', title: 'Conversation B' }; } });
  await app.createResearch('Conversation B');
  assert.equal(env.state().workspace.sessionId, 'session-b'); assert.equal(env.state().workspace.sessionBound, false);
  assert.equal(env.state().piRuntime.session.sessionId, 'session-a'); assert.equal(env.state().workspace.modelScopes.conversation, null);
  assert.equal(env.q('#ac-thread-title').textContent, 'Conversation B');
  await app.executePi('get_state');
  assert.equal(env.q('#ac-thread-title').textContent, 'Conversation B', 'A refresh of A cannot relabel the selected B conversation.');
  assert.match(env.q('#ac-pi-session-status').textContent, /Connect.*conversation/);
  env.click('#ac-chat-model-trigger');
  assert.match(env.q('#ac-chat-model-menu').textContent, /Connect this conversation/);
  assert.equal(env.qa('[data-acmp-model]:not([disabled])').length, 0);
  env.key(env.q('#ac-chat-model-menu input'), 'Escape');
  env.type('#ac-prompt-input', 'This belongs to B'); const before = host.calls.filter(call => call.type === 'prompt').length;
  env.click('.acm-send');
  assert.equal(env.state().prompt, 'This belongs to B'); assert.equal(env.state().busy, false);
  assert.equal(host.calls.filter(call => call.type === 'prompt').length, before);
});

test('A TaskManager-only workspace never substitutes demonstration tasks or artifacts for an empty live snapshot', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp;
  const snapshot = { revision: 1, projectId: 'empty-project', sessionId: 'empty-session', projects: [{ id: 'empty-project', name: 'Empty live project' }], sessions: [{ id: 'empty-session', projectId: 'empty-project', title: 'Empty conversation' }], run: { id: null, status: 'ready', startedAt: null, elapsedMs: 0, model: null }, tasks: [], agents: [], tools: [], artifacts: [], events: [], approvals: [] };
  await app.attachTaskManager({ capabilities: [], getSnapshot() { return snapshot; }, subscribe() { return () => {}; } });
  assert.equal(env.state().workspace.mode, 'runtime'); assert.equal(env.state().piConnected, false);
  assert.equal(env.state().workspace.sessionBound, false); assert.equal(env.state().workspace.taskManagerConnected, true);
  assert.deepEqual(localValue(env.state().workspace.tasks), []); assert.deepEqual(localValue(env.state().workspace.artifacts), []);
  assert.equal(env.q('#athena-codex').dataset.workspaceMode, 'runtime'); assert.equal(env.q('#ac-example-projects').hidden, true);
  app.openWorkspace('workflow'); assert.equal(env.qa('#ac-workbench-slot [data-awv-task]').length, 0);
  assert.match(env.q('[data-awv-task-detail]').textContent, /No tasks in this run/);
  app.openWorkspace('artifacts', { artifactId: 'research-note' });
  assert.equal(env.q('[data-awv-artifact-select]').disabled, true);
  assert.equal([...env.q('[data-awv-artifact-select]').options].filter(option => option.value !== '').length, 0, 'The sole empty-state placeholder is not a substitute artifact.');
  assert.match(env.q('[data-awv-artifact-view]').textContent, /requested artifact version is not available/);
  assert.equal(env.qa('#ac-workbench-slot [data-awv-action="original-reference"]').length, 0);
  assert.equal(app.startDemo(), false); assert.equal(env.state().workspace.mode, 'runtime');
});

test('Pi workbench hides unsupported streaming delivery and enables idle sends after settlement', async () => {
  const env = createEnvironment(), runtime = runtimeFor(env);
  const host = hostFor({ capabilities: ['get_state', 'prompt', 'abort'] });
  host.inputContract = { supportsStreamingPrompts: false };
  const { session } = runtime.attach(host, { refresh: false });
  assert.equal(session.inputContract.supportsStreamingPrompts, false);
  const { view, slot, q } = workbenchFor(env, runtime);
  view.open('queue');
  assert.equal(slot.querySelector('[data-apw-form="prompt"] [name="streamingBehavior"]'), null);
  const send = q('[data-apw-run="prompt"]');
  assert.equal(send.disabled, false);

  host.emit({ type: 'agent_start' });
  assert.equal(send.disabled, true);
  await assert.rejects(runtime.execute('prompt', { message: 'During streaming' }), /wait for the current response/i);
  host.emit({ type: 'agent_settled', aborted: false });
  assert.equal(send.disabled, false);
  await assert.rejects(runtime.execute('prompt', { message: 'Unsupported delivery', streamingBehavior: 'followUp' }), /streaming delivery/i);
  assert.equal(host.calls.filter(call => call.type === 'prompt').length, 0);

  await runtime.execute('prompt', { message: 'Send when idle' });
  assert.equal(host.calls.filter(call => call.type === 'prompt').at(-1).message, 'Send when idle');
  env.destroy();
});

test('Pi shell queues explicit instructions without completing the active run and preserves newer drafts until recovery is chosen', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp, queued = deferred();
  let fail = true;
  const host = hostFor({ capabilities: ['get_state', 'steer', 'follow_up', 'clear_queue', 'abort'], respond(wire) {
    if (wire.type === 'get_state') return { sessionId: 'queued-session' };
    if (wire.type === 'follow_up') { if (fail) throw new Error('Queue unavailable'); return queued.promise; }
    if (wire.type === 'clear_queue') return { steering: [], followUp: ['Queued instruction'] };
    return {};
  } });
  app.attachPiTransport(host, { refresh: false }); await app.executePi('get_state'); host.emit({ type: 'agent_start' });
  assert.equal(env.q('#ac-pi-queue-controls').hidden, false); assert.equal(env.state().busy, true);
  env.choose('#ac-pi-delivery', 'follow_up'); env.type('#ac-prompt-input', 'Queued instruction'); env.click('#ac-pi-send-queued');
  await env.waitFor(() => env.q('#ac-toast').textContent.includes('Queue unavailable'));
  assert.equal(env.state().prompt, 'Queued instruction'); assert.equal(env.state().busy, true);
  fail = false; env.click('#ac-pi-send-queued'); await env.waitFor(() => host.calls.filter(call => call.type === 'follow_up').length === 2);
  env.type('#ac-prompt-input', 'Newer unfinished text'); queued.resolve({ disposition: 'queued' });
  await env.waitFor(() => !env.q('#ac-pi-send-queued').disabled);
  assert.equal(env.state().prompt, 'Newer unfinished text'); assert.equal(env.state().busy, true);
  host.emit({ type: 'queue_update', steering: [], followUp: ['Queued instruction'] });
  assert.equal(env.q('#ac-pi-queue-count').textContent, '1 queued');
  await app.executePi('clear_queue'); assert.equal(env.q('#ac-pi-queue-count').textContent, '0 queued');
  assert.equal(env.state().prompt, 'Newer unfinished text');
  app.openPi('queue'); const recover = env.q('[data-apw-draft="Queued instruction"]');
  env.click(recover.closest('details').querySelector('summary')); env.click(recover);
  assert.equal(env.state().settingsOpen, false); assert.equal(env.state().prompt, 'Newer unfinished text\n\nQueued instruction');
  assert.equal(env.state().busy, true); host.emit({ type: 'agent_settled', aborted: false });
  assert.equal(env.state().busy, false);
});

test('Pi extension dialogs take modal priority over Settings and editor offers append only after explicit user selection', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp;
  const host = hostFor({ capabilities: [] }); app.attachPiTransport(host, { refresh: false });
  env.type('#ac-prompt-input', 'My existing text'); app.openPi('extensions');
  const opener = env.q('#ast-tab-tools'); opener.focus();
  host.emit({ type: 'extension_ui_request', method: 'input', id: 'nested', title: 'Enter a label' });
  const dialog = env.q('[data-apw-request="nested"]');
  assert.equal(env.q('#ac-settings-backdrop').inert, true); assert.equal(env.q('#ac-sidebar').inert, true);
  assert.equal(env.q('#ac-conversation').inert, true); assert.equal(dialog.contains(env.document.activeElement), true);
  host.emit({ type: 'extension_ui_resolved', id: 'nested' });
  assert.equal(env.state().piWorkbench.requestId, null); assert.equal(env.q('#ac-settings-backdrop').inert, false);
  assert.equal(env.document.activeElement, opener); assert.equal(host.calls.length, 0);
  host.emit({ type: 'extension_ui_request', method: 'set_editor_text', text: 'Suggested addition' });
  host.emit({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'progress', statusText: 'Inspecting files' });
  host.emit({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'progress', widgetLines: ['<img onerror=bad()>'], widgetPlacement: 'belowEditor' });
  assert.equal(env.state().prompt, 'My existing text'); assert.equal(env.q('#ac-pi-draft-offer').hidden, false);
  assert.equal(env.q('#ac-pi-statuses').textContent, 'Inspecting files');
  assert.equal(env.q('#ac-pi-widgets-below').textContent, '<img onerror=bad()>'); assert.equal(env.q('#ac-pi-widgets-below').querySelector('img'), null);
  app.closeSettings(); env.click('[data-action="pi-use-draft"]');
  assert.equal(env.state().prompt, 'My existing text\n\nSuggested addition'); assert.equal(env.q('#ac-pi-draft-offer').hidden, true);
  assert.equal(host.calls.length, 0); assert.equal(env.document.activeElement, env.q('#ac-prompt-input'));
});

test('Manual Pi shell requests produce one keyed inline row and finalize actual output on success and failure', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp;
  let pending = deferred();
  const host = hostFor({ capabilities: ['get_state', 'bash'], respond: wire => wire.type === 'get_state' ? { sessionId: 'manual-shell-session' } : pending.promise });
  app.attachPiTransport(host, { refresh: false }); await app.executePi('get_state');
  const request = app.executePi('bash', { command: 'fixture-only command' });
  const id = host.calls.find(call => call.type === 'bash').id;
  const row = env.q('#ac-pi-manual-activity [data-ap-tool="manual:' + id + '"]');
  assert.equal(env.state().panelOpen, false); assert.equal(row.dataset.piStatus, 'queued');
  env.click(row.querySelector('summary'));
  host.emit({ type: 'bash_execution_update', id, delta: 'Partial ' });
  host.emit({ type: 'bash_execution_update', id, delta: 'output' });
  assert.equal(row.querySelector('[data-ap-output]').textContent, 'Partial output'); assert.equal(row.dataset.piStatus, 'running');
  pending.resolve({ output: 'Authoritative output', exitCode: 0, cancelled: false, truncated: false }); await request;
  assert.equal(env.q('#ac-pi-manual-activity [data-ap-tool="manual:' + id + '"]'), row);
  assert.equal(row.open, true); assert.equal(row.dataset.piStatus, 'succeeded');
  assert.equal(row.querySelector('[data-ap-output]').textContent, 'Authoritative output');
  assert.equal(row.querySelectorAll('[data-pi-active="true"]').length, 0);
  pending = deferred(); const failed = app.executePi('bash', { command: 'fixture-only failure' }), failedCheck = assert.rejects(failed, /Shell rejected/);
  const failId = host.calls.at(-1).id; pending.reject(new Error('Shell rejected')); await failedCheck;
  const failedRow = env.q('#ac-pi-manual-activity [data-ap-tool="manual:' + failId + '"]');
  assert.equal(failedRow.dataset.piStatus, 'failed'); assert.match(failedRow.querySelector('[data-ap-output]').textContent, /Shell rejected/);
  assert.equal(failedRow.querySelectorAll('[data-pi-active="true"]').length, 0);
  assert.equal(env.state().busy, false); assert.deepEqual(env.networkCalls, []);
});

test('Manual Pi compaction, summarization retry and idle extension errors keep the composer idle while submitted compaction waits for actual settlement', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp;
  const compactResult = deferred(), promptResult = deferred();
  const host = hostFor({ capabilities: ['get_state', 'compact', 'prompt'], respond(wire) {
    if (wire.type === 'get_state') return { sessionId: 'compaction-session' };
    return wire.type === 'compact' ? compactResult.promise : promptResult.promise;
  } });
  app.attachPiTransport(host, { refresh: false }); await app.executePi('get_state');
  env.type('#ac-prompt-input', 'Keep this question ready');
  const compact = app.executePi('compact', { customInstructions: 'Preserve open questions' });
  host.emit({ type: 'compaction_start', reason: 'manual' });
  assert.equal(env.state().piRuntime.session.isCompacting, true);
  assert.match(env.q('#ac-pi-session-status').textContent, /Compacting context/);
  assert.equal(env.state().busy, false); assert.equal(env.state().reply.active, false);
  env.click('.acm-send');
  assert.equal(env.state().prompt, 'Keep this question ready');
  assert.equal(host.calls.filter(call => call.type === 'prompt').length, 0, 'A draft submitted during manual compaction is retained instead of starting a competing response.');
  for (const event of [
    { type: 'summarization_retry_scheduled', attempt: 1, delayMs: 1000 },
    { type: 'summarization_retry_attempt_start', attempt: 1 },
    { type: 'summarization_retry_finished', success: true },
    { type: 'compaction_end', reason: 'manual', willRetry: false }
  ]) {
    host.emit(event);
    assert.equal(env.state().busy, false, event.type + ' is runtime maintenance, not an unfinished assistant response.');
    assert.equal(env.state().reply.active, false); assert.equal(env.state().piActivity.sequence, 0);
  }
  compactResult.resolve({ summary: 'Compacted by the attached host' }); await compact;
  host.emit({ type: 'extension_error', error: 'Idle extension notification' });
  assert.equal(env.state().piRuntime.error, 'Idle extension notification');
  assert.equal(env.state().busy, false); assert.equal(env.state().reply.active, false); assert.equal(env.state().piActivity.sequence, 0);
  env.clock.advance(10000);
  assert.equal(env.state().busy, false); assert.equal(env.q('.acm-send').getAttribute('aria-label'), 'Send message');
  assert.equal(env.state().prompt, 'Keep this question ready');

  env.click('.acm-send'); await env.waitFor(() => host.calls.some(call => call.type === 'prompt'));
  assert.equal(env.state().busy, true); assert.equal(env.state().reply.phase, 'waiting');
  assert.notEqual(env.state().piRuntime.session.isStreaming, true, 'The next compaction occurs before agent_start.');
  host.emit({ type: 'compaction_start', reason: 'threshold' });
  assert.equal(env.state().reply.phase, 'compacting'); assert.equal(env.state().busy, true);
  host.emit({ type: 'summarization_retry_scheduled', attempt: 1 });
  assert.equal(env.state().reply.phase, 'retrying');
  host.emit({ type: 'summarization_retry_attempt_start', attempt: 1 });
  assert.equal(env.state().reply.phase, 'compacting');
  host.emit({ type: 'summarization_retry_finished', success: true });
  host.emit({ type: 'compaction_end', willRetry: false });
  promptResult.resolve({ disposition: 'started' }); await env.waitFor(() => !env.state().piRuntime.busy.includes('prompt'));
  env.clock.advance(10000);
  assert.equal(env.state().busy, true); assert.equal(env.state().reply.active, true, 'Finishing pre-response compaction is not assistant completion.');
  host.emit({ type: 'agent_start' });
  host.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  host.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Actual answer after compaction' } });
  host.emit({ type: 'agent_settled', aborted: false });
  assert.equal(env.state().busy, false); assert.equal(env.state().reply.active, false);
  assert.equal(env.q('.ar-text').textContent, 'Actual answer after compaction');
  const completed = JSON.stringify(env.state().piActivity);
  host.emit({ type: 'compaction_start', reason: 'manual' }); host.emit({ type: 'compaction_end', willRetry: false });
  assert.equal(env.state().busy, false); assert.equal(JSON.stringify(env.state().piActivity), completed, 'Maintenance after a completed turn does not reopen its reply.');
});

test('Pi branch changes clear the prior live response while keeping composer drafts and rejecting stale session reads', async () => {
  const env = createEnvironment(), app = env.window.AthenaApp, staleRead = deferred();
  let oldRead = false;
  const host = hostFor({ capabilities: ['get_state', 'get_messages', 'navigate_tree'], respond(wire) {
    if (wire.type === 'get_state') return { sessionId: 'same-session', sessionName: 'Branches' };
    if (wire.type === 'get_messages') return oldRead ? staleRead.promise : { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'New branch answer' }] }] };
    return { cancelled: false, leafId: 'new-branch' };
  } });
  app.attachPiTransport(host, { refresh: false }); await app.executePi('get_state');
  host.emit({ type: 'agent_start' });
  host.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  host.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Old branch answer' } });
  host.emit({ type: 'agent_settled', aborted: false });
  env.type('#ac-prompt-input', 'Keep my draft');
  oldRead = true; const outdated = app.executePi('get_messages'), outdatedCheck = assert.rejects(outdated, /session changed/);
  await app.executePi('navigate_tree', { targetId: 'new-branch' });
  assert.equal(env.state().piActivity.sequence, 0); assert.equal(env.state().prompt, 'Keep my draft');
  assert.equal(env.q('#ac-live-reply').hidden || !env.q('#ac-live-reply').textContent.includes('Old branch answer'), true, 'Same-session branch navigation removes the old answer from the displayed conversation.');
  staleRead.resolve({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Stale old branch' }] }] }); await outdatedCheck;
  oldRead = false; await app.executePi('get_state'); await app.executePi('get_messages');
  assert.equal(env.q('#ac-pi-transcript').textContent.includes('New branch answer'), true);
  assert.equal(env.q('#ac-pi-transcript').textContent.includes('Stale old branch'), false);
  assert.equal(env.state().prompt, 'Keep my draft');
});

test('프로젝트 목록: 상시 기본 표시, 아이콘으로 접기/펼치기, 저장값 false/true 복원', () => {
  const storage = new Map();
  const first = createEnvironment({ storage });
  assertProjectSidebar(first, true);
  first.click('#ac-sidebar-collapse');
  assertProjectSidebar(first, false);
  assert.equal(first.document.activeElement, first.q('#ac-left-toggle'));
  assert.equal(storage.get('athena.ui.project-sidebar-open.v1'), 'false');
  first.destroy();

  const collapsed = createEnvironment({ width: 744, storage });
  assertProjectSidebar(collapsed, false);
  collapsed.click('#ac-left-toggle');
  assertProjectSidebar(collapsed, true);
  assert.equal(collapsed.document.activeElement, collapsed.q('#ac-sidebar-collapse'));
  assert.equal(storage.get('athena.ui.project-sidebar-open.v1'), 'true');
  collapsed.destroy();

  const expanded = createEnvironment({ width: 640, storage });
  assertProjectSidebar(expanded, true);
  assert.equal(expanded.state().leftDrawer, false);
  assert.equal(expanded.state().layout.modes.left, 'docked');
});

test('프로젝트 목록 유지: 화면 폭·오른쪽 화면·현재 대화 선택이 자동으로 접지 않음', () => {
  const env = createEnvironment();
  for (const width of [1440, 960, 744, 640, 600, 390, 744, 1200]) {
    env.resize(width); env.clock.advance(34);
    assertProjectSidebar(env, true);
    assert.equal(env.state().leftDrawer, width <= 600);
    assert.equal(env.state().layout.modes.left, width <= 600 ? 'drawer' : 'docked');
    env.click('[data-action="current-thread"]');
    assertProjectSidebar(env, true);
  }
  env.resize(744); env.clock.advance(34);
  env.click('#ac-panel-toggle');
  assertProjectSidebar(env, true);
  env.click('[data-acs-surface="files"]');
  assertProjectSidebar(env, true);
  env.click('[data-action="current-thread"]');
  assertProjectSidebar(env, true);
  env.click('#ac-panel-toggle');
  assertProjectSidebar(env, true);
  env.window.AthenaApp.openPanel('manuscript');
  assertPanel(env, 'manuscript');
  assertProjectSidebar(env, true);
});

test('Conversation artifact links open exact previews and preserve the selected artifact across closing', () => {
  const env = createEnvironment({ storage: settingsStorage({ defaultSideView: 'artifacts' }) });
  env.click('.aw-baseline > summary');
  env.click('.ac-artifact[data-workspace-artifact="response-plot"]');
  assertWorkspaceView(env, 'artifacts', 'response-plot');
  assert.match(env.q('[data-awv-provenance]').textContent, /Example library/);
  assert.equal(workspace(env).artifacts.length, 0);
  env.click('.ac-artifact[data-workspace-artifact="validation-table"]');
  assertWorkspaceView(env, 'artifacts', 'validation-table');
  env.click('#ac-panel-toggle'); env.click('#ac-panel-toggle');
  assertWorkspaceView(env, 'artifacts', 'validation-table');
  env.click('.ac-artifact[data-workspace-artifact="research-note"]');
  assertWorkspaceView(env, 'artifacts', 'research-note');
  env.click('#ac-panel-toggle'); env.click('#ac-panel-toggle');
  assertWorkspaceView(env, 'artifacts', 'research-note');
  env.click('.aw-side-nav [data-workspace-view="workflow"]');
  assertWorkspaceView(env, 'workflow');
  assertProjectSidebar(env, true);
});

test('원고 편집: 패널 닫기/재열기 및 탭 전환 뒤 입력과 편집 상태 보존', () => {
  const env = createEnvironment({ storage: settingsStorage({ defaultSideView: 'research' }) });
  env.window.AthenaApp.openPanel('manuscript'); env.click('#ac-edit-manuscript');
  const edited = 'RC 필터 연구 노트\n\n부품 허용 오차: R ±1%, C ±5%.\n추가 검증 필요.';
  env.type('#ac-document-editor', edited);
  env.click('#ac-panel-toggle'); env.click('#ac-panel-toggle');
  assertPanel(env, 'manuscript'); assert.equal(env.q('#ac-document-editor').value, edited);
  assert.equal(env.q('#ac-document-editor').hidden, false); assert.equal(env.state().documentEditing, true);
  env.click('#ac-tab-results'); env.click('#ac-tab-manuscript');
  assert.equal(env.q('#ac-document-editor').value, edited);
  env.click('#ac-edit-manuscript'); assert.equal(env.q('#ac-document').textContent, edited);
  env.click('#ac-panel-toggle'); env.click('#ac-panel-toggle');
  assert.equal(env.q('#ac-document').textContent, edited); assert.equal(env.state().document, edited);
});

test('원고 편집: 수정 후 원래 텍스트로 되돌리면 표시 원고도 동기화', () => {
  const env = createEnvironment({ storage: settingsStorage({ defaultSideView: 'research' }) }); const original = env.state().document;
  env.window.AthenaApp.openPanel('manuscript'); env.click('#ac-edit-manuscript');
  env.type('#ac-document-editor', '임시 수정 원고'); env.click('#ac-edit-manuscript');
  env.click('#ac-edit-manuscript'); env.type('#ac-document-editor', original); env.click('#ac-edit-manuscript');
  assert.equal(env.q('#ac-document').textContent.replace(/\s+/g, ' ').trim(), original.replace(/\s+/g, ' ').trim());
});

test('Command 검색: 검색창 열기, Enter 결과, 결과 선택, Ctrl+K/Escape', () => {
  const env = createEnvironment();
  env.click('.ac-command-button'); assert.equal(env.q('.ac-command-field').hidden, false);
  assert.equal(env.document.activeElement, env.q('.ac-command-field input'));
  env.type('.ac-command-field input', 'baseline'); env.key('.ac-command-field input', 'Enter');
  assert.equal(env.q('#ac-dialog-backdrop').hidden, false); assert.equal(env.q('.ac-command-field').hidden, true);
  assert.equal(env.qa('[data-search-result]').length, 1);
  env.click('[data-search-result]'); assertPanel(env, 'results', 'baseline.cir');
  assert.equal(env.q('#ac-dialog-backdrop').hidden, true);
  env.key('#athena-codex', 'k', { ctrlKey: true, code: 'KeyK' });
  assert.equal(env.q('.ac-command-field').hidden, false);
  env.key('.ac-command-field input', 'Escape');
  assert.equal(env.q('.ac-command-field').hidden, true);
  assert.equal(env.document.activeElement, env.q('.ac-command-button'));
});

test('검색 대화상자 닫기: 접힌 검색 입력 대신 표시 중인 Command 버튼으로 초점 복귀', () => {
  const env = createEnvironment();
  env.click('.ac-command-button'); env.type('.ac-command-field input', 'baseline');
  env.key('.ac-command-field input', 'Enter');
  assert.equal(env.q('#ac-dialog-backdrop').hidden, false);
  assert.equal(env.q('.ac-command-field').hidden, true);
  env.click('.ac-dialog [data-action="close-dialog"]');
  assert.equal(env.q('#ac-dialog-backdrop').hidden, true);
  assert.equal(env.document.activeElement, env.q('.ac-command-button'));
  assert.equal(env.document.activeElement.closest('[hidden]'), null);
});

test('전송 버튼 툴팁: 캐시된 문구가 전송 → 응답 중단 → 전송 상태와 동기화', () => {
  const env = createEnvironment({ demo: true });
  env.type('#ac-prompt-input', '툴팁 상태 확인');
  env.q('.acm-send').focus();
  assert.equal(env.q('#ac-morph-tip .ac-morph-label').textContent, 'Send message (Enter)');
  env.click('.acm-send');
  assert.equal(env.state().busy, true);
  assert.equal(env.q('.acm-send').dataset.morphTooltip, 'Stop response');
  assert.equal(env.q('#ac-morph-tip').getAttribute('aria-label'), 'Stop response');
  assert.equal(env.q('#ac-morph-tip .ac-morph-label').textContent, 'Stop response');
  env.click('.acm-send'); assert.equal(env.state().busy, false);
  env.type('#ac-prompt-input', '다음 요청');
  env.q('#ac-prompt-input').focus(); env.q('.acm-send').focus();
  assert.equal(env.q('#ac-morph-tip').getAttribute('aria-label'), 'Send message (Enter)');
  assert.equal(env.q('#ac-morph-tip .ac-morph-label').textContent, 'Send message (Enter)');
});

test('검색: 사이드바 검색과 무결과 문구, 입력 HTML은 실행 요소가 되지 않음', () => {
  const env = createEnvironment();
  env.click('[data-action="search"]'); env.type('#ac-search-input', '원고'); env.click('#ac-dialog-primary');
  assert.equal(env.qa('[data-search-result]').length, 1);
  env.click('[data-search-result]'); assertPanel(env, 'manuscript');
  env.click('.ac-command-button'); env.type('.ac-command-field input', '<img src=x onerror=alert(1)>'); env.key('.ac-command-field input', 'Enter');
  assert.equal(env.qa('#ac-dialog-content img').length, 0);
  assert.match(env.q('#ac-dialog-content').textContent, /No resources match/);
});

test('Workflow and inline tool activity share real transitions, expandable logs, approval state and completed outputs', () => {
  const env = createEnvironment();
  runDemoUI(env);
  env.clock.advance(750);
  env.window.AthenaApp.openWorkspace('execution', { taskId: 'sources' });
  assertInlineTool(env, 'source-lookup');
  assert.equal(env.q('[data-aw-command="source-lookup"]').textContent, workspace(env).tools.find(t => t.taskId === 'sources').command);
  assert.match(env.q('[data-aw-log="source-lookup"]').textContent, /Sample source list/);
  env.click('[data-aw-output-mode="output"][data-aw-tool="source-lookup"]');
  assert.equal(env.q('[data-aw-log="source-lookup"]').textContent, workspace(env).tools.find(t => t.taskId === 'sources').logs.map(log => log.text).join('\n'));
  env.clock.advance(1500);
  assert.equal(workspace(env).run.status, 'blocked');
  env.window.AthenaApp.openWorkspace('workflow', { taskId: 'analyze' });
  assertWorkspaceView(env, 'workflow');
  assert.equal(env.q('[data-awv-task="analyze"]').getAttribute('aria-pressed'), 'true');
  assert.match(env.q('[data-awv-task-detail]').textContent, /Collect sample sources|Inspect sample component data/);
  env.click('[data-awv-open-tool="python-analysis"]');
  const pending = assertInlineTool(env, 'python-analysis');
  assert.ok(pending.matches('[data-aw-pending-tool="python-analysis"]'));
  assert.equal(pending.querySelectorAll('.aav-avatar').length, 0, 'An approval request does not invent a spawned agent.');
  assert.match(env.q('[data-aw-log="python-analysis"]').textContent, /Awaiting an explicit simulated approval/);
  env.click('.aw-approval-inline [data-aw-approval-open]');
  assert.equal(env.state().approval.approvalId, pendingApproval(env).id);
  assert.equal(env.q('#aw-approval-command').textContent, workspace(env).tools.find(t => t.id === 'python-analysis').command);
  env.click('[data-aw-dialog="allow"]');
  const spawned = assertInlineTool(env, 'python-analysis');
  assert.ok(spawned.hasAttribute('data-aw-agent'), 'The pending disclosure becomes the actual spawned agent disclosure.');
  env.clock.advance(3000);
  assert.equal(workspaceTask(env, 'analyze').status, 'succeeded');
  assert.equal(env.q('[data-aw-exit="python-analysis"]').textContent, '0');
  assert.match(env.q('[data-aw-log="python-analysis"]').textContent, /No output file was written/);
  assert.equal(workspace(env).artifacts.length, 3);
  env.clock.advance(4500);
  env.window.AthenaApp.openWorkspace('artifacts', { artifactId: 'research-note' });
  assert.match(env.q('[data-awv-provenance]').textContent, /Document revision/);
  assert.match(env.q('[data-awv-provenance]').textContent, /research-note · v1 · Session revision/);
  assert.match(env.q('[data-awv-action="original-reference"]').textContent, /Original sample PDF\/reference/);
  assert.equal(env.q('[data-awv-action="export-record-pdf"]').disabled, true, 'The current document cannot claim a PDF export without a research service.');
  assert.equal(workspace(env).run.status, 'succeeded');
  assert.equal(workspace(env).artifacts.length, 5);
  assert.equal(workspace(env).run.elapsedMs, 9750);
  assert.deepEqual(env.networkCalls, []);
});

test('답변 전송과 즉시 중지: 빈 요청 차단, busy 중 중복 전송 차단, 중지 후 지연 답변 없음', () => {
  const env = createEnvironment({ demo: true });
  env.type('#ac-prompt-input', '  '); assert.equal(env.q('.acm-send').disabled, true);
  env.type('#ac-prompt-input', '부품 허용 오차를 반영해 줘'); env.key('#ac-prompt-input', 'Enter');
  assert.equal(env.state().busy, true); assert.equal(env.state().prompt, '');
  assert.equal(env.q('#ac-live-user').hidden, false); assert.equal(env.q('#ac-live-user').textContent, '부품 허용 오차를 반영해 줘');
  assert.equal(env.q('.acm-send').getAttribute('aria-label'), 'Stop response');
  env.window.AthenaApp.submit('중복 요청'); assert.equal(env.q('#ac-live-user').textContent, '부품 허용 오차를 반영해 줘');
  env.clock.advance(100); env.click('.acm-send');
  assert.equal(env.state().busy, false); assert.equal(env.q('.ar-text').textContent, '');
  assert.equal(env.q('.ar-status-row').hidden, false); assert.equal(env.q('[data-athena-reply]').classList.contains('is-stopped'), true);
  assert.equal(env.q('.ar-phase-label').textContent, 'Stopped');
  env.clock.advance(15000); assert.equal(env.q('.ar-text').textContent, '');
  assert.match(env.q('#ac-live-status').textContent, /stopped/);
});

test('스트리밍 중지와 새 전송: 보인 단어만 남고 다음 예시 답변은 완료 상태로 복귀', () => {
  const env = createEnvironment({ demo: true });
  env.type('#ac-prompt-input', '완료 예시 확인'); env.click('.acm-send'); env.clock.advance(20000);
  const completeText = env.q('.ar-text').textContent;
  env.type('#ac-prompt-input', '첫 요청'); env.click('.acm-send');
  assert.equal(env.q('.ar-text').textContent, '', 'Unreceived text is not prepopulated in hidden spans.');
  env.clock.advance(1100); env.click('.acm-send');
  const partial = env.q('.ar-text').textContent;
  assert.ok(partial.length > 0 && partial.length < completeText.length);
  assert.ok(completeText.startsWith(partial));
  env.clock.advance(12000); assert.equal(env.q('.ar-text').textContent, partial);
  env.type('#ac-prompt-input', '두 번째 요청'); env.click('.acm-send'); env.clock.advance(20000);
  assert.equal(env.state().busy, false); assert.equal(env.q('.ar-text').textContent, completeText);
  assert.equal(env.q('.ar-bubble').getAttribute('aria-busy'), 'false');
  assert.equal(env.q('[data-athena-reply]').classList.contains('is-settled'), true);
  completedReplySummary(env);
  assert.match(env.q('.ar-text').textContent, /no calculation has been submitted/);
});

test('한국어 입력 안전: 조합 중 Enter와 조합 종료 직후 Enter는 전송하지 않음', () => {
  const env = createEnvironment({ demo: true }); env.type('#ac-prompt-input', '한국어 연구 질문');
  fire(env.q('#ac-prompt-input'), 'compositionstart'); env.key('#ac-prompt-input', 'Enter', { isComposing: true });
  assert.equal(env.state().busy, false);
  fire(env.q('#ac-prompt-input'), 'compositionend'); env.key('#ac-prompt-input', 'Enter'); assert.equal(env.state().busy, false);
  env.clock.advance(81); env.key('#ac-prompt-input', 'Enter', { shiftKey: true }); assert.equal(env.state().busy, false);
  env.key('#ac-prompt-input', 'Enter'); assert.equal(env.state().busy, true);
});

test('추천 입력과 자료 연결: Tab 수락, @ 선택, 연결을 포함한 요청 전송', () => {
  const env = createEnvironment({ demo: true }); env.q('#ac-prompt-input').focus();
  env.key('#ac-prompt-input', 'Tab'); assert.match(env.state().prompt, /component tolerances/);
  env.type('#ac-prompt-input', '@base');
  assert.equal(env.q('#ac-mention-listbox').getAttribute('aria-hidden'), 'false');
  env.key('#ac-prompt-input', 'Enter');
  assert.equal(env.state().busy, false); assert.equal(env.state().prompt, '@baseline.cir ');
  assert.match(env.q('.acm-contexts').textContent, /baseline.cir/);
  env.key('#ac-prompt-input', 'Enter'); assert.equal(env.state().busy, true);
  assert.equal(env.q('#ac-live-user').textContent, '@baseline.cir ');
});

test('+ 메뉴: 파일 추가가 맨 위, 검색·키보드 닫기·바깥 클릭·작은 화면 좌표', () => {
  const env = createEnvironment({ width: 390, height: 600 });
  env.click('#ac-sidebar-collapse');
  const trigger = env.click('.acm-add-trigger');
  const picker = env.q('#ac-mention-listbox');
  assert.equal(picker.parentElement, env.q('#athena-codex'));
  assert.equal(picker.getAttribute('aria-hidden'), 'false');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(env.document.activeElement, env.q('.acm-picker-search input'));
  const visible = env.qa('.acm-picker-row').filter(row => !row.hidden);
  assert.equal(visible[0].id, 'ac-mention-option-upload');
  assert.match(visible[0].textContent, /Add photos and files/);
  assert.equal(visible.length, 8);
  env.clock.advance(2000);
  assert.ok(parseFloat(picker.style.width) <= 370);
  assert.ok(!/NaN|Infinity/.test(picker.getAttribute('style')));
  env.type('.acm-picker-search input', '존재하지않는항목');
  assert.equal(env.q('.acm-picker-empty').hidden, false);
  assert.equal(env.q('#ac-mention-option-upload').hidden, false);
  env.key('.acm-picker-search input', 'Escape');
  assert.equal(picker.getAttribute('aria-hidden'), 'true');
  assert.equal(env.document.activeElement, trigger);
  env.click(trigger); env.key('.acm-picker-search input', 'Tab');
  assert.equal(picker.getAttribute('aria-hidden'), 'true');
  assert.equal(env.document.activeElement, env.q('#ac-prompt-input'));
  env.click(trigger); env.click('.ac-header-title');
  assert.equal(picker.getAttribute('aria-hidden'), 'true');
});

test('+ 메뉴 선택: 플러그인·스킬 칩, 검색 Enter, 해제, 요청 메타데이터 전달', () => {
  const env = createEnvironment({ demo: true });
  const composer = env.q('#ac-composer-slot').__athenaComposer;
  env.type('#ac-prompt-input', '첨부 자료의 조건을 비교해 줘');
  env.click('.acm-add-trigger');
  env.type('.acm-picker-search input', 'Python');
  env.key('.acm-picker-search input', 'Enter');
  assert.equal(composer.getSelections().map(item => item.id).join(','), 'python');
  assert.equal(env.state().prompt, '첨부 자료의 조건을 비교해 줘');
  env.click('.acm-add-trigger'); env.click('#ac-mention-option-literature-review');
  assert.equal(composer.getSelections().length, 2);
  env.click('.acm-remove-context[aria-label="Remove Python"]');
  assert.equal(composer.getSelections().map(item => item.id).join(','), 'literature-review');
  env.click('.acm-add-trigger'); env.click('#ac-mention-option-python');
  env.click('.acm-send');
  assert.equal(env.state().busy, true);
  assert.equal(env.state().lastSubmission.mentions.map(item => item.id).join(','), 'python,literature-review');
  assert.equal(composer.getSelections().length, 0);
  assert.equal(env.q('.acm-contexts').children.length, 0);
});

test('실제 File 메타데이터: 여러 첨부·중복 제거·파일명 안전 표시·본문 없이 전송', () => {
  const env = createEnvironment({ demo: true });
  const composer = env.q('#ac-composer-slot').__athenaComposer;
  const input = env.q('.acm-file-input');
  const paper = new File(['research notes'], '<script>연구노트</script>.pdf', { type: 'application/pdf', lastModified: 1 });
  const image = new File(['image fixture'], '회로.png', { type: 'image/png', lastModified: 2 });
  env.click('.acm-add-trigger'); env.click('#ac-mention-option-upload');
  Object.defineProperty(input, 'files', { configurable: true, value: [paper, image, paper] });
  fire(input, 'change');
  assert.equal(composer.getAttachments().length, 2);
  assert.equal(composer.getAttachments()[0], paper);
  assert.equal(env.qa('.acm-attachment-chip').length, 2);
  assert.equal(env.qa('.acm-contexts script').length, 0);
  assert.match(env.q('.acm-contexts').textContent, /연구노트/);
  env.click('.acm-remove-context[aria-label="Remove attachment 회로.png"]');
  assert.equal(composer.getAttachments().length, 1);
  assert.equal(env.q('.acm-send').disabled, false);
  assert.equal(env.state().prompt, '');
  env.click('.acm-send');
  assert.equal(env.state().busy, true);
  assert.equal(env.state().lastSubmission.text, '');
  assert.equal(env.state().lastSubmission.attachments[0].name, paper.name);
  assert.equal(env.state().lastSubmission.attachments[0].size, paper.size);
  assert.equal(env.state().lastSubmission.attachments[0].type, 'application/pdf');
  assert.equal(env.q('#ac-live-user .ac-message-attachment').textContent, paper.name);
  assert.equal(env.qa('#ac-live-user script').length, 0);
  assert.equal(composer.getAttachments().length, 0);
  env.clock.advance(20000);
  assert.equal(env.state().busy, false);
  assert.match(env.q('.ar-text').textContent, /has not analyzed the files or run a calculation/);
  assert.deepEqual(env.networkCalls, []);
});

test('Surface shortcuts retain workspace views while legacy execution and terminal routes reveal inline activity', () => {
  const env = createEnvironment();
  env.click('#ac-panel-toggle');
  assert.equal(env.state().sideView, 'surface');
  assert.equal(env.q('#ac-surface-slot').hidden, false);
  assert.equal(env.qa('[data-acs-surface][disabled]').length, 2);
  assert.equal(env.qa('[data-acs-surface="execution"],[data-acs-surface="terminal"]').length, 0);
  env.key('[data-acs-surface="browser"]', 'a');
  assertWorkspaceView(env, 'timeline');
  assert.equal(env.document.activeElement.closest('[hidden]'), null);
  env.click('#ac-side-picker'); env.click('[data-acs-surface="diff"]');
  assert.equal(env.qa('.acs-diff-added').length, 2);
  assert.equal(env.qa('.acs-diff-removed').length, 2);
  env.click('[data-acs-action="home"]'); env.click('[data-acs-surface="device"]');
  assert.match(env.q('.acs-device-pane').textContent, /No devices connected/);
  env.click('[data-acs-action="home"]'); env.click('[data-acs-surface="research"]');
  assertPanel(env, 'results');
  env.key('#ac-tab-results', 'ArrowRight'); assertPanel(env, 'manuscript');
  env.click('#ac-tab-workflow'); assertWorkspaceView(env, 'workflow');
  env.window.AthenaApp.openSurface('terminal');
  assert.equal(env.state().panelOpen, false);
  assert.equal(env.qa('#aw-activity .aav-avatar').length, 0);
  assert.equal(workspace(env).agents.length, 0);
  assert.ok(env.q('#aw-activity').contains(env.document.activeElement));
  env.window.AthenaApp.openAgents(); assertWorkspaceView(env, 'timeline');
  env.window.AthenaApp.openWorkspace('execution', { toolId: 'source-lookup' });
  assertInlineTool(env, 'source-lookup');
  assert.match(env.q('[data-aw-log="source-lookup"]').textContent, /No output yet/);
  assert.equal(workspace(env).agents.length, 0);
  assert.deepEqual(env.networkCalls, []);
});

test('Inline agents: only spawned tasks receive stable geometric identities, including workflow and timeline views', () => {
  const env = createEnvironment();
  runDemoUI(env);
  assert.equal(workspace(env).run.status, 'running');
  assert.equal(workspace(env).agents.map(a => a.taskId).join(','), 'sources,inspect');
  assert.equal(env.qa('#aw-activity [data-aw-agent]').length, 2);
  assert.ok(env.qa('#aw-activity .aav-avatar').length >= 2, 'Spawned agents may also appear in the compact grouped indicator.');
  assert.ok(env.qa('.aav-avatar').every(avatar => avatar.getAttribute('aria-hidden') === 'true'));
  assert.equal(env.qa('.aav-avatar [tabindex],.aav-avatar [role],.aav-avatar img,.aav-avatar svg').length, 0);
  const identities = new Map();
  for (const agent of workspace(env).agents) {
    const fixture = env.document.createElement('div');
    fixture.innerHTML = env.window.AthenaAvatars.html({ agentId: agent.id });
    const expected = fixture.firstElementChild.dataset.avatarIdentity;
    const actual = env.q('[data-aw-agent-reveal="' + agent.id + '"] .aav-avatar');
    assert.equal(actual.dataset.avatarIdentity, expected, 'The inline mark uses the runtime agent ID.');
    identities.set(agent.id, expected);
  }
  assert.ok(env.qa('#aw-activity .aav-avatar').every(node => [...identities.values()].includes(node.dataset.avatarIdentity)), 'Every grouped or inline mark belongs to a spawned agent.');
  env.clock.advance(2250);
  assert.equal(workspace(env).run.status, 'blocked');
  assert.equal(workspace(env).agents.length, 2);
  assert.equal(env.q('#aw-approval-backdrop').hidden, true);
  env.clock.advance(20000);
  assert.equal(workspaceTask(env, 'analyze').progress, 0);
  assert.equal(workspace(env).run.elapsedMs, 2250);
  assert.equal(workspace(env).agents.length, 2);
  env.window.AthenaApp.openWorkspace('workflow');
  assert.equal(env.qa('#ac-workbench-slot .aav-avatar').length, 2, 'Only tasks that actually spawned receive geometric marks.');
  for (const agent of workspace(env).agents) {
    assert.equal(env.q('[data-aw-agent-reveal="' + agent.id + '"] .aav-avatar').dataset.avatarIdentity, identities.get(agent.id), 'Progress changes keep the inline identity.');
    assert.equal(env.q('[data-awv-task="' + agent.taskId + '"] .aav-avatar').dataset.avatarIdentity, identities.get(agent.id), 'Workflow and inline identity agree.');
  }
  env.window.AthenaApp.openWorkspace('timeline');
  env.choose('[data-awv-timeline-type]', 'agent');
  for (const event of workspace(env).events.filter(event => event.type.startsWith('agent.'))) {
    assert.equal(env.q('[data-awv-event-id="' + event.id + '"] .aav-avatar').dataset.avatarIdentity, identities.get(event.agentId), 'Timeline and inline identity agree.');
  }
  assertProjectSidebar(env, true);
});

test('Approval modal: scope, focus trap, close without decision, reject and renewed explicit approval', () => {
  const env = createEnvironment();
  const first = startToApproval(env);
  const opener = env.click('.aw-approval-inline [data-aw-approval-open]');
  assert.equal(env.state().approval.approvalId, first.id);
  assert.equal(env.document.activeElement, env.q('[data-aw-dialog="close"]'));
  assert.equal(env.q('#ac-sidebar').inert, true);
  assert.equal(env.q('#ac-conversation').inert, true);
  assert.equal(env.q('#ac-research-panel').inert, true);
  assert.equal(env.q('#aw-approval-cwd').textContent, '/workspace/biosignal-circuits');
  assert.match(env.q('#aw-approval-scope').textContent, /results\/rc_sweep\.csv/);
  assert.match(env.q('#aw-approval-impact').textContent, /changes no project files/);
  assert.equal(env.key('[data-aw-dialog="close"]', 'Tab', { shiftKey: true }).defaultPrevented, true);
  assert.equal(env.document.activeElement, env.q('[data-aw-dialog="allow"]'));
  env.key('[data-aw-dialog="allow"]', 'Tab');
  assert.equal(env.document.activeElement, env.q('[data-aw-dialog="close"]'));
  env.q('#ac-prompt-input').focus();
  assert.equal(env.document.activeElement, env.q('[data-aw-dialog="close"]'), 'Programmatic background focus is contained.');
  env.key('[data-aw-dialog="close"]', 'Escape');
  assert.equal(pendingApproval(env).id, first.id);
  assert.equal(env.document.activeElement, opener);
  env.click(opener); env.click('#aw-approval-backdrop');
  assert.equal(pendingApproval(env).id, first.id);
  env.click(opener); env.click('[data-aw-dialog="reject"]');
  assert.equal(pendingApproval(env), undefined);
  assert.equal(workspaceTask(env, 'review').status, 'blocked');
  assert.equal(workspaceTask(env, 'write').status, 'blocked');
  assert.equal(workspace(env).agents.length, 2);
  assert.equal(env.q('#aw-approval-backdrop').hidden, true);
  env.click('[data-aw-retry="analyze"]');
  assert.notEqual(pendingApproval(env).id, first.id);
  assert.equal(workspaceTask(env, 'review').status, 'queued');
  assert.equal(workspaceTask(env, 'sources').status, 'succeeded');
  assert.equal(workspaceTask(env, 'inspect').status, 'succeeded');
  approvePending(env); env.clock.advance(7500);
  assert.equal(workspace(env).run.status, 'succeeded');
  assert.equal(workspace(env).agents.length, 5);
  assert.deepEqual(env.networkCalls, []);
});

test('Pause and resume preserve progress and pending decisions, including approval recorded while paused', () => {
  const env = createEnvironment();
  runDemoUI(env); env.clock.advance(1000);
  env.window.AthenaApp.pauseDemo();
  assert.equal(workspace(env).run.status, 'paused');
  assert.equal(workspaceTask(env, 'sources').progress, 1);
  const paused = JSON.stringify(workspace(env));
  env.clock.advance(10000); assert.equal(JSON.stringify(workspace(env)), paused);
  env.window.AthenaApp.resumeDemo(); env.clock.advance(499);
  assert.equal(workspaceTask(env, 'sources').progress, 1);
  env.clock.advance(751); assert.equal(workspace(env).run.status, 'blocked');
  const id = pendingApproval(env).id;
  env.window.AthenaApp.pauseDemo();
  env.clock.advance(5000); assert.equal(pendingApproval(env).id, id);
  approvePending(env);
  assert.equal(workspace(env).run.status, 'paused');
  assert.equal(workspace(env).agents.length, 2);
  assert.equal(workspaceTask(env, 'analyze').progress, 0);
  env.clock.advance(5000); assert.equal(workspaceTask(env, 'analyze').progress, 0);
  env.window.AthenaApp.resumeDemo(); env.clock.advance(7500);
  assert.equal(workspace(env).run.status, 'succeeded');
  assert.equal(workspace(env).run.elapsedMs, 9750);
  const finished = JSON.stringify(workspace(env));
  env.clock.advance(30000); assert.equal(JSON.stringify(workspace(env)), finished);
});

test('Recoverable analysis error: inline failed log and blocked graph lead to retry without repeating completed prerequisites', () => {
  const env = createEnvironment();
  env.click('.aw-demo-options > summary');
  env.choose('#aw-demo-scenario', 'analysis-error');
  startToApproval(env); approvePending(env); env.clock.advance(2250);
  assert.equal(workspace(env).run.status, 'failed');
  assert.equal(workspaceTask(env, 'analyze').progress, 3);
  assert.equal(workspaceTask(env, 'review').status, 'blocked');
  assert.equal(workspace(env).artifacts.map(a => a.id).join(','), 'research-brief');
  env.window.AthenaApp.openWorkspace('execution', { taskId: 'analyze' });
  assertInlineTool(env, 'python-analysis');
  assert.equal(env.q('[data-aw-exit="python-analysis"]').textContent, '1');
  assert.match(env.q('[data-aw-log="python-analysis"]').textContent, /Simulated ValueError/);
  env.click('[data-aw-retry="analyze"]');
  assert.ok(pendingApproval(env));
  assert.equal(workspaceTask(env, 'sources').progress, 3);
  assert.equal(workspaceTask(env, 'inspect').progress, 2);
  assert.equal(workspaceTask(env, 'review').status, 'queued');
  approvePending(env); env.clock.advance(7500);
  assert.equal(workspace(env).run.status, 'succeeded');
  assert.equal(workspace(env).events.filter(e => e.type === 'task.failed').length, 1);
  assert.equal(workspace(env).events.filter(e => e.type === 'task.started' && e.taskId === 'sources').length, 1);
  assert.equal(workspace(env).events.filter(e => e.type === 'task.started' && e.taskId === 'inspect').length, 1);
  assert.equal(workspace(env).run.elapsedMs, 12000);
  assert.equal(env.q('[data-aw-exit="python-analysis"]').textContent, '0');
});

test('Cancel stops queued callbacks and explicit Run again resets agents and outputs before a fresh start', () => {
  const env = createEnvironment();
  runDemoUI(env); env.clock.advance(900);
  env.window.AthenaApp.openWorkspace('execution', { taskId: 'sources' });
  assertInlineTool(env, 'source-lookup');
  env.window.AthenaApp.cancelDemo();
  assert.equal(workspace(env).run.status, 'cancelled');
  const cancelled = JSON.stringify(workspace(env));
  env.clock.advance(30000); assert.equal(JSON.stringify(workspace(env)), cancelled);
  assert.ok(workspace(env).tasks.every(task => task.status === 'cancelled'));
  runDemoUI(env);
  assert.equal(workspace(env).run.status, 'running');
  assert.equal(workspace(env).agents.length, 2);
  assert.equal(workspace(env).artifacts.length, 0);
  assert.equal(workspaceTask(env, 'sources').progress, 0);
  env.clock.advance(2250);
  const id = pendingApproval(env).id;
  env.window.AthenaApp.cancelDemo();
  assert.equal(workspace(env).approvals.find(a => a.id === id).status, 'rejected');
  assert.equal(workspace(env).run.status, 'cancelled');
  assert.equal(env.window.AthenaApp.openApproval(id), false);
  assert.equal(env.q('#aw-approval-backdrop').hidden, true);
});

test('Graph/list selection and inline log actions retain inspectable task output without an execution window', () => {
  const env = createEnvironment();
  runDemoUI(env); env.clock.advance(750);
  const sourceAgent = workspace(env).agents.find(a => a.taskId === 'sources');
  env.click('[data-aw-summary="' + sourceAgent.id + '"]');
  assertInlineTool(env, 'source-lookup');
  env.click('[data-aw-tool-action="copy-log"][data-aw-tool="source-lookup"]');
  assert.ok(env.clipboardWrites[0].includes(workspace(env).tools.find(t => t.id === 'source-lookup').logs[1].text));
  env.click('[data-aw-tool-action="download-log"][data-aw-tool="source-lookup"]');
  assert.match(env.downloads[0].name, /source-lookup\.log$/);
  env.window.AthenaApp.openWorkspace('workflow');
  env.click('[data-awv-action="workflow-mode"][data-awv-value="graph"]');
  assert.equal(env.state().workspaceView.workflowMode, 'graph');
  env.click('[data-awv-task="analyze"]');
  assert.equal(env.state().workspaceView.taskId, 'analyze');
  assert.equal(env.qa('[data-awg-node]').length, workspace(env).tasks.length);
  assert.equal(env.qa('[data-awg-edge="dependency"]').length, workspace(env).tasks.reduce((count, task) => count + task.dependencies.length, 0));
  assert.equal(env.q('[data-awg-node="analyze"] [data-awv-task]').getAttribute('aria-pressed'), 'true');
  env.click('[data-awv-action="workflow-mode"][data-awv-value="list"]');
  assert.equal(env.q('[data-awv-task="analyze"]').getAttribute('aria-pressed'), 'true');
  env.click('[data-awv-task-detail] [data-awv-task="inspect"]');
  assert.equal(env.state().workspaceView.taskId, 'inspect');
  env.click('[data-awv-open-tool="dataset-inspector"]');
  const inline = assertInlineTool(env, 'dataset-inspector');
  assert.ok(inline.contains(env.document.activeElement));
  env.window.AthenaApp.openWorkspace('execution', { taskId: 'analyze' });
  assertInlineTool(env, 'python-analysis');
  env.clock.advance(1500);
  assert.match(env.q('[data-aw-log="python-analysis"]').textContent, /Awaiting an explicit simulated approval/);
  assertProjectSidebar(env, true);
});

test('Inline tool navigation closes an overlay, preserves the project sidebar and keeps pending tasks avatar-free', () => {
  const env = createEnvironment({ width: 640 });
  env.window.AthenaApp.openWorkspace('workflow', { taskId: 'analyze' });
  assert.equal(env.q('#ac-conversation').inert, true);
  const untouched = JSON.stringify(workspace(env));
  env.click('[data-awv-open-tool="python-analysis"]');
  const pending = assertInlineTool(env, 'python-analysis');
  assert.ok(pending.matches('[data-aw-pending-tool="python-analysis"]'));
  assert.equal(env.document.activeElement, env.q('[data-aw-tool-summary="python-analysis"]'));
  assert.equal(pending.querySelectorAll('.aav-avatar').length, 0);
  assert.equal(JSON.stringify(workspace(env)), untouched, 'Inspecting a pending tool does not start the demo.');
  assert.ok(env.scrolls.some(item => pending.contains(item.element) || item.element.contains(pending)), 'The inline destination requests scrolling into view.');
  assertProjectSidebar(env, true);
});

test('Inline log mode and expanded state survive progress updates; copy failure remains an inline selectable field', async () => {
  const env = createEnvironment();
  runDemoUI(env);
  const thinking = env.q('[data-aw-thinking]');
  assert.equal(thinking.open, true);
  env.click(thinking.querySelector('summary'));
  assert.equal(thinking.open, false);
  env.window.AthenaApp.openWorkspace('execution', { toolId: 'source-lookup' });
  assert.equal(env.q('[data-aw-thinking]').open, true, 'Navigation reveals the outer disclosure as well as the selected tool.');
  const first = assertInlineTool(env, 'source-lookup');
  env.click('[data-aw-output-mode="output"][data-aw-tool="source-lookup"]');
  env.clock.advance(750);
  const latest = assertInlineTool(env, 'source-lookup');
  assert.notEqual(first, latest, 'The application replaces progress markup during ticks.');
  assert.equal(env.q('[data-aw-log="source-lookup"]').textContent, workspace(env).tools.find(tool => tool.id === 'source-lookup').logs.map(entry => entry.text).join('\n'));
  assert.equal(env.document.activeElement, env.q('[data-aw-output-mode="output"][data-aw-tool="source-lookup"]'));
  env.window.navigator.clipboard.writeText = () => Promise.reject(new Error('Clipboard fixture is unavailable'));
  env.click('[data-aw-tool-action="copy-log"][data-aw-tool="source-lookup"]');
  await env.waitFor(() => env.document.querySelector('[data-aw-copy-fallback="source-lookup"]'));
  const fallback = env.q('[data-aw-copy-fallback="source-lookup"]');
  assert.equal(fallback.localName, 'textarea');
  assert.equal(fallback.hasAttribute('readonly'), true);
  assert.ok(env.q('#aw-activity').contains(fallback));
  assert.ok(workspace(env).tools.find(tool => tool.id === 'source-lookup').logs.every(entry => fallback.value.includes(entry.text)), 'The fallback contains the selected tool log.');
  assert.equal(env.q('#ac-dialog-backdrop').hidden, true);
  assert.equal(env.q('#aw-approval-backdrop').hidden, true);
  assert.equal(env.state().settingsOpen, false);
});

test('Timeline filters persist during ticks and exact approval/artifact events open the right targets', () => {
  const env = createEnvironment();
  runDemoUI(env);
  env.window.AthenaApp.openWorkspace('timeline');
  env.choose('[data-awv-timeline-task]', 'sources');
  env.choose('[data-awv-timeline-type]', 'tool');
  const taskFilter = env.q('[data-awv-timeline-task]'); taskFilter.focus();
  env.clock.advance(750);
  assert.equal(env.q('[data-awv-timeline-task]'), taskFilter);
  assert.equal(env.document.activeElement, taskFilter);
  assert.equal(env.state().workspaceView.timelineTask, 'sources');
  const expected = workspace(env).events.filter(e => e.taskId === 'sources' && e.type.startsWith('tool.'));
  assert.equal(env.qa('[data-awv-event-id]').length, expected.length);
  env.clock.advance(1500);
  env.choose('[data-awv-timeline-task]', 'analyze');
  env.choose('[data-awv-timeline-type]', 'approval');
  const approvalEvent = workspace(env).events.find(e => e.type === 'approval.requested');
  env.click('[data-awv-event="' + approvalEvent.id + '"]');
  assert.equal(env.state().approval.approvalId, pendingApproval(env).id);
  env.click('[data-aw-dialog="allow"]'); env.clock.advance(7500);
  env.window.AthenaApp.openWorkspace('timeline');
  env.choose('[data-awv-timeline-task]', 'analyze'); env.choose('[data-awv-timeline-type]', 'artifact');
  const codeEvent = workspace(env).events.find(e => e.type === 'artifact.available' && e.artifactId === 'analysis-code');
  assert.ok(codeEvent, 'Artifact events identify exact output IDs.');
  assert.equal(env.qa('[data-awv-event-id]').length, 2);
  env.click('[data-awv-event="' + codeEvent.id + '"]');
  assertWorkspaceView(env, 'artifacts', 'analysis-code');
  assert.match(env.q('[data-awv-code-content]').textContent, /def cutoff/);
  env.window.AthenaApp.openWorkspace('timeline');
  env.choose('[data-awv-timeline-task]', 'inspect'); env.choose('[data-awv-timeline-type]', 'artifact');
  assert.match(env.q('[data-awv-events]').textContent, /No matching events/);
  env.click('[data-awv-action="reset-filters"]');
  assert.equal(env.state().workspaceView.timelineTask, 'all');
  assert.equal(env.state().workspaceView.timelineType, 'all');
  assert.equal(env.qa('[data-awv-event-id]').length, workspace(env).events.length);
});

test('Artifact evidence links, report citations and selector route exact outputs while preserving preview provenance', () => {
  const env = createEnvironment();
  env.window.AthenaApp.openWorkspace('artifacts', { artifactId: 'validation-table' });
  env.click('[data-awv-citation="cutoff"][data-awv-target="analysis-code"]');
  assertWorkspaceView(env, 'artifacts', 'analysis-code');
  env.click('[data-awv-action="code-tab"][data-awv-value="diff"]');
  assert.equal(env.state().workspaceView.codeTab, 'diff');
  assert.match(env.q('[data-awv-code-content]').textContent, /R_TOL/);
  env.choose('[data-awv-artifact-select]', 'research-note');
  env.click('[data-awv-action="original-reference"]');
  env.choose('[data-awv-page-select]', '3');
  env.click('[data-awv-citation="code"]');
  assertWorkspaceView(env, 'artifacts', 'analysis-code');
  env.choose('[data-awv-artifact-select]', 'response-plot');
  env.click('[data-awv-action="toggle-data"]');
  assert.equal(env.q('[data-awv-data-table]').hidden, false);
  env.click('[data-awv-open-artifact="validation-table"]');
  assertWorkspaceView(env, 'artifacts', 'validation-table');
  env.click('[data-awv-citation="formula"][data-awv-target="research-brief"]');
  assertWorkspaceView(env, 'artifacts', 'research-brief');
  assert.match(env.q('[data-awv-provenance]').textContent, /Example library/);
  assert.equal(workspace(env).artifacts.length, 0);
  assert.equal(workspace(env).agents.length, 0);
  assert.deepEqual(env.networkCalls, []);
});

test('Knowledge search, note validation, pins and excerpts persist without submitting or executing the draft', () => {
  const storage = new Map(); const env = createEnvironment({ storage });
  env.click('#ac-knowledge-nav'); assertWorkspaceView(env, 'knowledge');
  env.type('[name="knowledge-search"]', 'magnitude_ratio');
  assert.equal(env.qa('[data-akn-source]').length, 1);
  assert.equal(env.state().knowledge.selectedId, 'sample-data');
  env.click('[data-akn-action="open-artifact"]');
  assertWorkspaceView(env, 'artifacts', 'response-plot');
  env.click('#ac-knowledge-nav'); env.click('[data-akn-action="clear-search"]');
  env.click('[data-akn-action="add-note"]'); fire(env.q('.akn-note-form'), 'submit');
  assert.equal(env.q('[name="note-title"]').getAttribute('aria-invalid'), 'true');
  const title = 'Evidence <img src=x onerror=alert(1)>';
  const note = 'Check the ideal RC assumptions before testing real components. <script>literal()</script>';
  env.type('[name="note-title"]', title); env.type('[name="note-body"]', note);
  fire(env.q('.akn-note-form'), 'submit');
  const id = env.state().knowledge.selectedId;
  assert.equal(env.q('.akn-detail-title').textContent, title);
  assert.equal(env.qa('#ac-knowledge-slot img,#ac-knowledge-slot script,[onerror]').length, 0);
  env.click('[data-akn-action="pin"]');
  assert.equal(env.state().knowledge.sources.find(source => source.id === id).pinned, true);
  env.click('[data-akn-action="use-source"]');
  assert.equal(env.state().panelOpen, false);
  assert.ok(env.state().prompt.includes(title)); assert.ok(env.state().prompt.includes(note));
  assert.equal(env.state().lastSubmission, null);
  assert.equal(workspace(env).run.status, 'ready');
  assert.equal(env.document.activeElement, env.q('#ac-prompt-input'));
  env.destroy();
  const restored = createEnvironment({ storage }); restored.click('#ac-knowledge-nav');
  assert.equal(restored.state().knowledge.sources.find(source => source.id === id).pinned, true);
  restored.type('[name="knowledge-search"]', 'testing real components');
  assert.equal(restored.state().knowledge.selectedId, id);
  assert.equal(restored.qa('[data-akn-source]').length, 1);
});

test('Knowledge import reads session text, labels PDF metadata, rejects duplicates and keeps files out of storage', async () => {
  const storage = new Map(); const env = createEnvironment({ storage }); env.click('#ac-knowledge-nav');
  const textFile = new File(['Session-only fixture text for the RC design.'], 'readings.txt', { type: 'text/plain', lastModified: 10 });
  const csvFile = new File(['r_ohm,c_farad\n1000,0.0000001\n'], 'components.csv', { type: 'text/csv', lastModified: 11 });
  const pdfFile = new File(['%PDF-1.4\n% Metadata fixture; no native rendering is claimed.'], 'reference.pdf', { type: 'application/pdf', lastModified: 12 });
  const unsupported = new File(['unsafe extension fixture'], 'ignore.exe', { lastModified: 13 });
  const input = env.q('.akn-file-input');
  Object.defineProperty(input, 'files', { configurable: true, value: [textFile, csvFile, pdfFile, textFile, unsupported] });
  fire(input, 'change'); await env.waitFor(() => !env.state().knowledge.importBusy, 'The local file reads complete.');
  const imported = env.state().knowledge.sources.filter(source => source.origin === 'file');
  assert.equal(imported.length, 3); assert.ok(imported.every(source => source.sessionOnly));
  assert.equal(imported.find(source => source.format === 'PDF').textAvailable, false);
  assert.match(env.q('.akn-notice').textContent, /already in this session/);
  assert.match(env.q('.akn-notice').textContent, /use PDF, TXT, MD, or CSV/);
  assert.match(env.q('.akn-detail').textContent, /Text extraction, OCR, and indexing are not available/);
  assert.equal(env.objectUrls.size, 1);
  env.type('[name="knowledge-search"]', 'Session-only fixture text');
  assert.equal(env.qa('[data-akn-source]').length, 1);
  env.click('[data-akn-action="use-source"]');
  assert.match(env.state().prompt, /Session-only fixture text/);
  assert.equal(env.state().lastSubmission, null);
  assert.ok(![...storage.values()].some(value => /Session-only fixture text|reference\.pdf|components\.csv/.test(value)));
  assert.deepEqual(env.networkCalls, []);
  env.destroy(); assert.equal(env.objectUrls.size, 0);
  const restored = createEnvironment({ storage });
  assert.equal(restored.state().knowledge.sources.filter(source => source.origin === 'file').length, 0);
});

test('Six settings categories reuse one runtime view and distinguish explicit, device and session-scoped changes', () => {
  const storage = new Map(), env = createEnvironment({ storage }), app = env.window.AthenaApp;
  assert.deepEqual(env.qa('[data-ast-section]').map(tab => tab.dataset.astSection), ['models', 'execution', 'tools', 'files', 'appearance', 'about']);
  const models = env.q('#ast-model-settings-slot'), runtime = env.q('#ast-pi-workbench-slot');
  app.openSettings('models');
  assert.equal(env.q('.ast-footer').dataset.saveMode, 'explicit');
  assert.match(env.q('[data-ast-save-status]').textContent, /require Save settings/);
  env.type('.ams-form [name="defaultModel"]', 'unsaved-choice');
  assert.equal(storage.has('athena.model-settings.v1'), false);
  env.click('#ast-tab-execution');
  assert.equal(env.q('#ast-agent-model-settings-slot [name="parallelLimit"]').closest('.ast-panel').id, 'ast-panel-execution');
  assert.equal(env.q('.ast-footer').dataset.saveMode, 'explicit');
  env.click('#ast-tab-appearance');
  assert.equal(env.q('.ast-footer').dataset.saveMode, 'automatic');
  env.click('[data-ast-size="large"]');
  assert.equal(JSON.parse(storage.get('athena.ui.settings.v1')).textSize, 'large');
  assert.equal(storage.has('athena.model-settings.v1'), false, 'Saving a UI preference does not commit model drafts.');
  app.openPi('resources');
  assert.equal(env.q('#ast-panel-tools').hidden, false);
  assert.equal(runtime.closest('.ast-panel').id, 'ast-panel-tools');
  assert.match(env.q('[data-ast-save-status]').textContent, /current runtime/);
  app.openPi('session');
  assert.equal(runtime.closest('.ast-panel').id, 'ast-panel-files');
  app.openPi('model');
  assert.equal(runtime.closest('.ast-panel').id, 'ast-panel-models');
  assert.equal(env.q('#ast-model-settings-slot'), models);
  assert.equal(env.qa('#ast-pi-workbench-slot').length, 1);
  assert.equal(env.q('.ams-form [name="defaultModel"]').value, 'unsaved-choice');
});

test('Model configuration keeps four scopes distinct and only host-confirmed saves change its saved default', async () => {
  const env = createEnvironment(), manager = env.window.AthenaConnectionManager.create();
  const slot = env.document.createElement('div'); env.document.body.appendChild(slot);
  const receipts = [], calls = []; let rejectSave = true, verified = 0;
  manager.attach({
    async saveConfig(config) { calls.push(localValue(config)); if (rejectSave) throw new Error('Configuration was not saved'); return { saved: true, configurationId: 'cfg', defaultModel: { provider: 'host', modelId: config.defaultModel } }; },
    async verifyConnection() { verified++; return { status: 'connected', checkedAt: '2026-11-20T00:00:00Z' }; }
  });
  const view = env.window.AthenaModelSettings.mount(slot, { connectionManager: manager, onChange(value) { receipts.push(value); } });
  env.cleanups.push(() => { view.destroy(); manager.destroy(); slot.remove(); });
  view.setModelScopes({ appDefault: { provider: 'p', modelId: 'app' }, projectDefault: { provider: 'p', modelId: 'project' }, conversation: { provider: 'p', modelId: 'conversation' }, runLocked: { provider: 'p', modelId: 'run-original', runId: 'run-1' } });
  assert.deepEqual([...slot.querySelectorAll('[data-ams-scope]')].map(node => node.textContent), ['app · p', 'project · p', 'conversation · p', 'run-original · p']);
  assert.equal(slot.querySelector('[data-ams-project-action="current"]').disabled, true);
  const model = slot.querySelector('[name="defaultModel"]'); model.value = 'app-next'; fire(model, 'input');
  fire(slot.querySelector('[data-ams-action="validate"]'), 'click');
  assert.equal(calls.length, 0); assert.equal(verified, 0);
  fire(slot.querySelector('form'), 'submit');
  await env.waitFor(() => !view.getState().busy);
  assert.equal(view.getState().saved.defaultModel, 'workspace-default'); assert.equal(model.value, 'app-next'); assert.equal(receipts.length, 0);
  assert.match(slot.querySelector('[data-ams-status]').textContent, /not saved/);
  rejectSave = false; fire(slot.querySelector('form'), 'submit');
  await env.waitFor(() => !view.getState().busy);
  assert.equal(view.getState().saved.defaultModel, 'app-next'); assert.equal(view.getState().storageMode, 'host'); assert.equal(receipts.length, 1);
  assert.equal(verified, 0, 'Saving does not perform a connection check.');
  fire(slot.querySelector('[data-ams-action="verify"]'), 'click'); await env.waitFor(() => !view.getState().busy);
  assert.equal(verified, 1); assert.equal(calls.length, 2);
  assert.equal(slot.querySelector('[data-ams-scope="runLocked"]').textContent, 'run-original · p', 'Changing defaults cannot rewrite the model pinned to an existing run.');
});

test('Model settings validate fields, save nonsecret routing, and enforce the saved demo concurrency limit', () => {
  const storage = new Map(); const env = createEnvironment({ storage }); env.window.AthenaApp.setDemoMode(true);
  env.click('[data-action="settings"]'); env.click('#ast-tab-models');
  assert.equal(env.q('#ast-panel-models').hidden, false);
  env.type('.ams-form [name="endpoint"]', 'https://user:secret@example.test/v1?token=not-real');
  env.click('[data-ams-action="validate"]');
  assert.equal(env.state().models.validation.state, 'invalid');
  assert.equal(env.document.activeElement, env.q('.ams-form [name="endpoint"]'));
  assert.equal(storage.has('athena.model-settings.v1'), false);
  env.type('.ams-form [name="endpoint"]', 'http://localhost:11434/v1');
  env.type('.ams-form [name="defaultModel"]', 'local-research-model');
  env.click('#ast-tab-execution');
  env.type('#ast-agent-model-settings-slot [name="role-analyst"]', 'local-analysis-model');
  env.type('#ast-agent-model-settings-slot [name="contextBudget"]', '8192');
  env.type('#ast-agent-model-settings-slot [name="outputBudget"]', '16384');
  fire(env.q('.ams-form'), 'submit');
  assert.equal(env.state().models.validation.state, 'invalid');
  assert.equal(env.q('#ast-agent-model-settings-slot [name="outputBudget"]').getAttribute('aria-invalid'), 'true');
  env.type('#ast-agent-model-settings-slot [name="outputBudget"]', '2048');
  env.choose('#ast-agent-model-settings-slot [name="parallelLimit"]', '1');
  assert.equal(workspace(env).configuration.parallelLimit, 2, 'Unsaved fields do not configure execution.');
  fire(env.q('.ams-form'), 'submit');
  assert.equal(env.state().models.validation.state, 'valid');
  assert.equal(workspace(env).configuration.parallelLimit, 1);
  assert.equal(env.q('#aw-model-label').textContent, 'local-research-model');
  const saved = JSON.parse(storage.get('athena.model-settings.v1'));
  assert.deepEqual(Object.keys(saved).sort(), ['contextBudget', 'defaultModel', 'endpoint', 'outputBudget', 'parallelLimit', 'provider', 'roleModels', 'version'].sort());
  assert.equal(saved.roleModels.analyst, 'local-analysis-model');
  assert.equal(env.qa('.ams-form input[type="password"],.ams-form [name*="apiKey"],.ams-form [name*="token"]').length, 0);
  assert.ok(!JSON.stringify(saved).includes('secret'));
  env.window.AthenaApp.closeSettings();
  runDemoUI(env);
  assert.equal(workspace(env).agents.length, 1);
  assert.equal(workspaceTask(env, 'inspect').status, 'queued');
  env.window.AthenaApp.openSettings('execution');
  env.choose('#ast-agent-model-settings-slot [name="parallelLimit"]', '2'); fire(env.q('.ams-form'), 'submit');
  assert.equal(workspace(env).agents.length, 2);
  env.choose('#ast-agent-model-settings-slot [name="parallelLimit"]', '1'); fire(env.q('.ams-form'), 'submit');
  assert.equal(workspace(env).tasks.filter(task => task.status === 'running').length, 2, 'Lowering the cap preserves work already started.');
  env.window.AthenaApp.closeSettings();
  assert.deepEqual(env.networkCalls, []);
  env.destroy(); const restored = createEnvironment({ storage });
  assert.equal(restored.state().models.saved.defaultModel, 'local-research-model');
  assert.equal(workspace(restored).configuration.parallelLimit, 1);
  assert.equal(workspace(restored).run.status, 'ready');
});

test('Settings focus trapping includes embedded read-only text, editable textareas and model form controls', () => {
  const env = createEnvironment(); env.window.AthenaApp.openSettings('models');
  const endpoint = env.q('.ams-form [name="endpoint"]'); endpoint.focus();
  assert.equal(env.document.activeElement, endpoint);
  assert.equal(env.key(endpoint, 'Tab').defaultPrevented, false);
  const readonly = env.document.createElement('textarea'); readonly.readOnly = true; readonly.setAttribute('readonly', ''); readonly.value = 'Inspectable read-only example';
  const editable = env.document.createElement('textarea'); editable.value = 'Editable embedded note';
  env.q('#ast-panel-models').appendChild(readonly);
  env.q('[data-ast-action="close"]').focus(); env.key('[data-ast-action="close"]', 'Tab', { shiftKey: true });
  assert.equal(env.document.activeElement, readonly);
  env.key(readonly, 'Tab'); assert.equal(env.document.activeElement, env.q('[data-ast-action="close"]'));
  env.q('#ast-panel-models').appendChild(editable);
  env.q('[data-ast-action="close"]').focus(); env.key('[data-ast-action="close"]', 'Tab', { shiftKey: true });
  assert.equal(env.document.activeElement, editable);
  env.key(editable, 'Tab'); assert.equal(env.document.activeElement, env.q('[data-ast-action="close"]'));
  env.key('[data-ast-action="close"]', 'Escape'); assert.equal(env.state().settingsOpen, false);
});

test('Timeline default view persists and the overlay leaves header and project controls usable', () => {
  const storage = new Map(); const env = createEnvironment({ width: 640, storage });
  env.window.AthenaApp.openSettings('general');
  env.choose('#ast-default-view', 'timeline');
  env.window.AthenaApp.closeSettings(); env.click('#ac-panel-toggle');
  assertWorkspaceView(env, 'timeline');
  assert.equal(env.state().layout.modes.right, 'overlay');
  assert.equal(env.q('#ac-conversation').inert, true);
  assert.equal(env.q('.ac-header').inert, false); assert.equal(env.q('#ac-sidebar').inert, false);
  assert.equal(workspace(env).agents.length, 0);
  assert.equal(env.document.activeElement.closest('[hidden]'), null);
  env.click('#ac-panel-toggle'); assert.equal(env.q('#ac-conversation').inert, false);
  assertProjectSidebar(env, true); env.destroy();
  const restored = createEnvironment({ storage });
  assert.equal(restored.state().settings.defaultSideView, 'timeline');
  restored.click('#ac-panel-toggle'); assertWorkspaceView(restored, 'timeline');
  assert.equal(workspace(restored).run.status, 'ready');
  assert.equal(workspace(restored).agents.length, 0);
});

test('파일 화면: 대화에서 직접 열기, 검색·선택·복사, 외부 주소 검증', () => {
  const env = createEnvironment();
  env.window.AthenaApp.openPanel('results', 'response');
  env.click('[data-action="open-file"][data-file="baseline.cir"]');
  assert.equal(env.state().sideView, 'surface');
  assert.equal(env.state().surface.surface, 'files');
  assert.equal(env.state().surface.selectedFile, 'baseline.cir');
  assert.match(env.q('.acs-code').textContent, /R1 in out 1k/);
  env.type('[data-acs-search]', 'csv');
  assert.equal(env.qa('.acs-file-item').length, 1);
  env.click('.acs-file-item');
  assert.equal(env.state().surface.selectedFile, 'ac_response.csv');
  env.click('[data-acs-action="copy-file"]');
  assert.match(env.clipboardWrites[0], /frequency_hz,gain_db/);
  env.type('[data-acs-search]', '<img src=x>');
  assert.equal(env.qa('.acs-file-list img').length, 0);
  assert.match(env.q('.acs-empty-search').textContent, /No matching files/);
  env.click('[data-acs-action="home"]'); env.click('[data-acs-surface="browser"]');
  env.type('[data-acs-address]', 'javascript:alert(1)'); fire(env.q('[data-acs-address-form]'), 'submit');
  assert.equal(env.openedWindows.length, 0);
  env.type('[data-acs-address]', 'example.com/research'); fire(env.q('[data-acs-address-form]'), 'submit');
  assert.equal(env.openedWindows.length, 1);
  assert.equal(env.openedWindows[0][0], 'https://example.com/research');
  assert.equal(env.openedWindows[0][2], 'noopener,noreferrer');
  assert.deepEqual(env.networkCalls, []);
});

test('양쪽 패널 폭: 키보드·드래그·취소·복원·모바일 전환·저장', () => {
  const storage = new Map();
  const env = createEnvironment({ storage });
  env.click('#ac-panel-toggle');
  const left = env.q('#ac-left-resizer'), right = env.q('#ac-right-resizer');
  assert.equal(right.hidden, false);
  env.key(left, 'ArrowRight'); assert.equal(env.state().layout.left, 250);
  env.key(right, 'ArrowLeft', { shiftKey: true }); assert.equal(env.state().layout.right, 480);
  const accessibleFocus = () => {
    const focused = env.document.activeElement;
    assert.ok(env.q('#athena-codex').contains(focused)); assert.equal(focused.closest('[hidden]'), null);
    for (let ancestor = focused; ancestor; ancestor = ancestor.parentElement) assert.notEqual(ancestor.inert, true, 'Resize must not leave keyboard focus in an inert ancestor.');
  };
  env.q('#ac-prompt-input').focus(); env.resize(744); env.clock.advance(34);
  assert.equal(env.state().layout.modes.right, 'overlay'); assert.ok(env.q('#ac-research-panel').contains(env.document.activeElement)); accessibleFocus();
  env.resize(390); env.clock.advance(34);
  assert.equal(env.state().leftDrawer, true); assert.ok(env.q('#ac-sidebar').contains(env.document.activeElement)); accessibleFocus();
  const sidebarFocus = env.document.activeElement; env.resize(1440); env.clock.advance(34);
  assert.equal(env.document.activeElement, sidebarFocus); accessibleFocus();
  for (const width of [1440, 1200, 1024, 960, 950, 949, 800, 744, 640, 601, 600, 390]) {
    env.resize(width); env.clock.advance(34);
    const layout = env.state().layout;
    const stage = width - (width > 600 ? layout.left : 0);
    assert.equal(layout.modes.right, stage >= 700 ? 'split' : 'overlay');
    assert.equal(env.q('#athena-codex').dataset.panelLayout, layout.modes.right);
    if (layout.modes.right === 'split') assert.ok(stage - layout.right >= 380);
    else assert.ok(layout.right <= stage - 16);
    assert.equal(left.hidden, width <= 600);
    assert.equal(right.hidden, layout.modes.right !== 'split');
    assertProjectSidebar(env, true);
    accessibleFocus();
  }
  env.resize(1440); env.clock.advance(34);
  assert.equal(env.state().layout.left, 250); assert.equal(env.state().layout.right, 480);
  fire(left, 'pointerdown', { pointerId: 5, button: 0, isPrimary: true, clientX: 250 });
  fire(env.document, 'pointermove', { pointerId: 5, clientX: 330 });
  assert.equal(env.state().layout.left, 330);
  fire(env.document, 'pointercancel', { pointerId: 5 });
  assert.equal(env.state().layout.left, 250);
  assert.equal(env.q('#athena-codex').dataset.resizing, undefined);
  fire(right, 'dblclick'); assert.equal(env.state().layout.right, 440);
  env.destroy();
  const reopened = createEnvironment({ storage });
  assert.equal(reopened.state().layout.left, 250);
  assert.equal(reopened.state().layout.right, 440);
});

test('오른쪽 overlay: 비모달, 헤더·프로젝트 조작 가능, 대화만 inert, 닫기 초점 복귀', () => {
  const env = createEnvironment({ width: 640, storage: settingsStorage({ defaultSideView: 'research' }) });
  const trigger = env.q('#ac-panel-toggle'); trigger.focus();
  env.window.AthenaApp.openPanel('results', 'table');
  assertPanel(env, 'results', 'table');
  assert.equal(env.state().layout.modes.right, 'overlay');
  assert.equal(env.q('#ac-research-panel').hasAttribute('role'), false);
  assert.equal(env.q('#ac-research-panel').hasAttribute('aria-modal'), false);
  assert.equal(env.q('#ac-conversation').inert, true); assert.equal(env.q('#ac-overlay-scrim').hidden, false);
  assert.equal(env.q('.ac-header').inert, false);
  assert.equal(env.q('#ac-sidebar').inert, false);
  assert.equal(env.document.activeElement, env.q('#ac-tab-results'));
  assert.equal(env.key('#ac-tab-results', 'Tab').defaultPrevented, false);
  env.click('[data-action="current-thread"]');
  assertProjectSidebar(env, true); assert.equal(env.state().panelOpen, true);
  env.q('#ac-tab-results').focus();
  env.key('#ac-tab-results', 'Escape'); assert.equal(env.state().panelOpen, false); assert.equal(env.document.activeElement, trigger);
  assertProjectSidebar(env, true);
  env.click('#ac-panel-toggle'); assertPanel(env, 'results', 'table');
  env.resize(1440); env.clock.advance(34); assert.equal(env.q('#ac-research-panel').hasAttribute('aria-modal'), false);
  assert.equal(env.q('#ac-overlay-scrim').hidden, true); assert.equal(env.q('#ac-conversation').inert, false);
  env.resize(744); env.clock.advance(34);
  assert.equal(env.state().layout.modes.right, 'overlay');
  env.click('#ac-sidebar-collapse');
  assertProjectSidebar(env, false); assert.equal(env.state().panelOpen, true);
  assert.equal(env.state().layout.modes.right, 'split');
  assert.equal(env.q('#ac-conversation').inert, false);
  env.click('#ac-left-toggle');
  assertProjectSidebar(env, true); assert.equal(env.state().panelOpen, true);
  assert.equal(env.state().layout.modes.right, 'overlay');
  env.click('#ac-overlay-scrim');
  assert.equal(env.state().panelOpen, false); assertProjectSidebar(env, true);
});

test('600px 이하 왼쪽 drawer: 기본 열림, 바깥 클릭 유지, 아이콘·Escape 닫기와 포커스 제한', () => {
  const env = createEnvironment({ width: 390 });
  assertProjectSidebar(env, true);
  assert.equal(env.state().leftDrawer, true);
  assert.equal(env.q('#ac-sidebar').getAttribute('aria-modal'), 'true');
  assert.equal(env.q('#ac-sidebar').getAttribute('role'), 'dialog');
  assert.equal(env.q('#ac-overlay-scrim').disabled, true);
  assert.equal(env.q('#ac-overlay-scrim').getAttribute('aria-hidden'), 'true');
  assert.equal(env.q('.ac-header').inert, true);
  assert.equal(env.q('#ac-conversation').inert, true);
  // A direct event also must not close it, even though native disabled clicks do not fire.
  fire(env.q('#ac-overlay-scrim'), 'click');
  assertProjectSidebar(env, true);
  env.click('[data-action="current-thread"]');
  assertProjectSidebar(env, true);
  env.q('#ac-sidebar-collapse').focus();
  const backward = env.key('#ac-sidebar-collapse', 'Tab', { shiftKey: true });
  assert.equal(backward.defaultPrevented, true);
  assert.equal(env.document.activeElement, env.q('[data-action="settings"]'));
  const forward = env.key('[data-action="settings"]', 'Tab');
  assert.equal(forward.defaultPrevented, true);
  assert.equal(env.document.activeElement, env.q('#ac-sidebar-collapse'));
  env.key('#ac-sidebar-collapse', 'Escape');
  assertProjectSidebar(env, false);
  assert.equal(env.document.activeElement, env.q('#ac-left-toggle'));
  assert.equal(env.q('.ac-header').inert, false);
  env.click('#ac-left-toggle'); assertProjectSidebar(env, true);
  env.click('#ac-sidebar-collapse'); assertProjectSidebar(env, false);
});

test('대화상자 포커스 제한은 유지되며 닫은 뒤 프로젝트 표시 상태 유지', () => {
  const env = createEnvironment({ width: 744 });
  env.click('[data-action="sample-thread"]');
  assert.equal(env.q('#ac-dialog-backdrop').hidden, false);
  assert.equal(env.q('#ac-sidebar').inert, true);
  const first = env.q('.ac-dialog-heading [data-action="close-dialog"]');
  const last = env.q('.ac-dialog-actions [data-action="close-dialog"]');
  first.focus();
  assert.equal(env.key(first, 'Tab', { shiftKey: true }).defaultPrevented, true);
  assert.equal(env.document.activeElement, last);
  assert.equal(env.key(last, 'Tab').defaultPrevented, true);
  assert.equal(env.document.activeElement, first);
  env.key(first, 'Escape');
  assert.equal(env.q('#ac-dialog-backdrop').hidden, true);
  assertProjectSidebar(env, true);
  assert.equal(env.q('#ac-sidebar').inert, false);
});

test('Settings: English defaults, accessible section tabs, modal focus and close restoration', () => {
  const env = createEnvironment();
  assert.equal(env.state().settings.language, 'en');
  assert.equal(env.state().settings.textSize, 'default');
  assert.equal(env.state().settings.sendKey, 'enter');
  assert.equal(env.state().settings.defaultSideView, 'home');
  assert.equal(env.state().settings.reducedMotion, false);
  assert.doesNotMatch(env.q('#athena-codex').textContent, /[가-힣]/);
  const opener = env.click('[data-action="settings"]');
  assert.equal(env.state().settingsOpen, true);
  assert.equal(env.q('#ac-settings-backdrop').hidden, false);
  assert.equal(env.q('.ast-sheet').getAttribute('aria-modal'), 'true');
  assert.equal(env.q('#ac-sidebar').inert, true);
  assert.equal(env.q('.ac-header').inert, true);
  assert.equal(env.q('#ac-conversation').inert, true);
  assert.equal(env.q('#ac-dialog-backdrop').inert, true);
  assert.equal(env.qa('[data-ast-section]').map(tab => tab.textContent.trim()).join('/'), 'Models & connections/Agents & execution/Tools & plugins/Files & history/Appearance & notifications/About & diagnostics');
  assert.equal(env.document.activeElement, env.q('#ast-tab-appearance'));
  const first = env.q('[data-ast-action="close"]');
  const last = env.q('[data-ast-action="reset-widths"]');
  first.focus(); env.key(first, 'Tab', { shiftKey: true });
  assert.equal(env.document.activeElement, last);
  env.key(last, 'Tab'); assert.equal(env.document.activeElement, first);
  env.q('#ast-tab-appearance').focus();
  env.key('#ast-tab-appearance', 'k', { ctrlKey: true, code: 'KeyK' });
  assert.equal(env.q('.ac-command-field').hidden, true);
  env.key('#ast-tab-appearance', 'End');
  assert.equal(env.q('#ast-tab-about').getAttribute('aria-selected'), 'true');
  assert.equal(env.q('#ast-panel-about').hidden, false);
  assert.match(env.q('.ast-about-brand img').getAttribute('src'), /athena-icon-128\.png$/);
  env.key('#ast-tab-about', 'Escape');
  assert.equal(env.state().settingsOpen, false);
  assert.equal(env.document.activeElement, opener);
  assert.equal(env.q('#ac-sidebar').inert, false);
  env.click(opener); env.click('#ac-settings-backdrop');
  assert.equal(env.state().settingsOpen, false);
  assert.equal(env.document.activeElement, opener);
});

test('Settings preserves modal focus across workflow ticks and restores the current inline control after completion', () => {
  const env = createEnvironment();
  runDemoUI(env);
  const originalDisclosure = env.q('[data-aw-thinking-summary="main"]'); originalDisclosure.focus();
  env.key(originalDisclosure, ',', { ctrlKey: true });
  assert.equal(env.state().settingsOpen, true);
  const modalFocus = env.document.activeElement;
  env.clock.advance(1000);
  assert.equal(workspaceTask(env, 'sources').progress, 1);
  assert.equal(originalDisclosure.isConnected, false);
  assert.equal(env.document.activeElement, modalFocus);
  assert.equal(env.q('#ac-settings-backdrop').contains(modalFocus), true);
  env.key(modalFocus, 'Escape');
  assert.equal(env.document.activeElement, env.q('[data-aw-thinking-summary="main"]'));
  assert.equal(env.document.activeElement.dataset.awThinkingSummary, 'main');
  env.clock.advance(1250); approvePending(env);
  const replacementDisclosure = env.q('[data-aw-thinking-summary="main"]'); replacementDisclosure.focus();
  env.key(replacementDisclosure, ',', { metaKey: true });
  const finalModalFocus = env.document.activeElement;
  env.clock.advance(7500);
  assert.equal(workspace(env).run.status, 'succeeded');
  assert.equal(replacementDisclosure.isConnected, false);
  assert.equal(env.document.activeElement, finalModalFocus);
  env.key(finalModalFocus, 'Escape');
  assert.equal(env.state().settingsOpen, false);
  assert.equal(env.document.activeElement, env.q('[data-aw-thinking-summary="main"]'));
  assert.equal(env.document.activeElement.dataset.awThinkingSummary, 'main');
  assert.equal(env.document.activeElement.closest('[hidden]'), null);
});

test('Settings: Connections content and its Pi resource action and read-only About remain keyboard-focusable', () => {
  const env = createEnvironment({ width: 390, height: 560 });
  env.click('[data-action="settings"]');
  assert.equal(env.q('.ast-nav').getAttribute('aria-orientation'), 'horizontal');
  env.click('#ast-tab-tools');
  const connections = env.q('#ast-panel-tools');
  assert.equal(connections.getAttribute('tabindex'), '0');
  assert.equal(env.key('#ast-tab-tools', 'Tab').defaultPrevented, false);
  connections.focus(); assert.equal(env.document.activeElement, connections);
  assert.match(connections.textContent, /not connected to an execution engine/);
  assert.equal(env.key(connections, 'ArrowDown').defaultPrevented, false);
  assert.equal(env.key(connections, 'Tab').defaultPrevented, false);
  const resources = env.q('#ast-panel-tools [data-action="pi-resources"]');
  resources.focus(); assert.equal(env.key(resources, 'Tab').defaultPrevented, false);
  env.click(resources);
  assert.equal(env.q('#ast-panel-tools').hidden, false);
  assert.equal(env.state().piWorkbench.section, 'resources');
  env.click('#ast-tab-about');
  assert.equal(env.q('#ast-panel-about').getAttribute('tabindex'), '0');
  env.q('#ast-panel-about').focus();
  assert.equal(env.key('#ast-panel-about', 'PageDown').defaultPrevented, false);
  env.resize(1200); env.clock.advance(34);
  assert.equal(env.q('.ast-nav').getAttribute('aria-orientation'), 'vertical');
  env.key('#ast-panel-about', 'Escape');
  assertProjectSidebar(env, true);
});

test('Settings: text size, reduced motion, default view and send shortcut persist and take effect', () => {
  const storage = new Map();
  const env = createEnvironment({ storage, demo: true });
  env.click('[data-action="settings"]'); env.click('#ast-tab-appearance');
  env.click('[data-ast-size="large"]');
  assert.equal(env.state().settings.textSize, 'large');
  assert.equal(env.q('#athena-codex').style.getPropertyValue('--ac-font-size'), '16px');
  assert.equal(env.q('#athena-codex').dataset.textSize, 'large');
  assert.equal(env.q('[data-ast-size="large"]').getAttribute('aria-checked'), 'true');
  env.q('#ast-reduced-motion').checked = true; fire(env.q('#ast-reduced-motion'), 'change');
  assert.equal(env.q('#athena-codex').dataset.reducedMotion, 'true');
  env.click('#ast-tab-appearance');
  env.q('#ast-default-view').value = 'files'; fire(env.q('#ast-default-view'), 'change');
  env.q('#ast-send-key').value = 'mod-enter'; fire(env.q('#ast-send-key'), 'change');
  const stored = JSON.parse(storage.get('athena.ui.settings.v1'));
  assert.equal(stored.textSize, 'large'); assert.equal(stored.reducedMotion, true);
  assert.equal(stored.defaultSideView, 'files'); assert.equal(stored.sendKey, 'mod-enter');
  env.key('#ast-send-key', 'Escape');
  env.click('#ac-panel-toggle'); assert.equal(env.state().surface.surface, 'files');
  env.click('#ac-panel-toggle');
  env.type('#ac-prompt-input', 'Use the configured shortcut');
  env.key('#ac-prompt-input', 'Enter'); assert.equal(env.state().lastSubmission, null);
  env.key('#ac-prompt-input', 'Enter', { shiftKey: true }); assert.equal(env.state().lastSubmission, null);
  env.key('#ac-prompt-input', 'Enter', { ctrlKey: true });
  assert.equal(env.state().lastSubmission.text, 'Use the configured shortcut');
  assert.equal(env.state().busy, false); // Reduced motion completes the example immediately.
  env.type('#ac-prompt-input', 'Meta shortcut'); env.key('#ac-prompt-input', 'Enter', { metaKey: true });
  assert.equal(env.state().lastSubmission.text, 'Meta shortcut');
  env.destroy();
  const restored = createEnvironment({ storage });
  assert.equal(restored.state().settings.textSize, 'large');
  assert.equal(restored.state().settings.reducedMotion, true);
  assert.equal(restored.state().settings.defaultSideView, 'files');
  assert.equal(restored.state().settings.sendKey, 'mod-enter');
  assert.match(restored.q('.acm-send').dataset.morphTooltip, /Ctrl\+Enter/);
  restored.click('#ac-panel-toggle'); assert.equal(restored.state().surface.surface, 'files');
});

test('Settings: workspace checkbox preserves the project preference and reset restores panel widths', () => {
  const storage = new Map();
  const env = createEnvironment({ storage });
  env.key('#ac-left-resizer', 'ArrowRight', { shiftKey: true });
  env.click('#ac-panel-toggle'); env.key('#ac-right-resizer', 'ArrowLeft', { shiftKey: true });
  assert.equal(env.state().layout.left, 280); assert.equal(env.state().layout.right, 480);
  env.window.AthenaApp.openSettings('workspace');
  assert.equal(env.q('#ast-project-sidebar').checked, true);
  env.q('#ast-project-sidebar').checked = false; fire(env.q('#ast-project-sidebar'), 'change');
  assertProjectSidebar(env, false);
  assert.equal(env.state().settingsOpen, true);
  assert.equal(env.document.activeElement, env.q('#ast-project-sidebar'));
  assert.equal(storage.get('athena.ui.project-sidebar-open.v1'), 'false');
  env.click('[data-ast-action="reset-widths"]');
  assert.equal(env.state().layout.preferred.left, 240); assert.equal(env.state().layout.preferred.right, 440);
  assert.match(env.q('[data-ast-live]').textContent, /Panel widths reset/);
  env.key('[data-ast-action="reset-widths"]', 'Escape');
  assert.equal(env.state().settingsOpen, false);
  assertProjectSidebar(env, false);
  env.window.AthenaApp.openSettings('workspace');
  assert.equal(env.q('#ast-project-sidebar').checked, false);
  env.q('#ast-project-sidebar').checked = true; fire(env.q('#ast-project-sidebar'), 'change');
  env.window.AthenaApp.closeSettings();
  assertProjectSidebar(env, true);
  assert.equal(storage.get('athena.ui.project-sidebar-open.v1'), 'true');
});

test('Settings: reduced-motion changes settle an active response and keep the system preference', () => {
  const env = createEnvironment({ demo: true });
  env.type('#ac-prompt-input', 'Active response'); env.click('.acm-send');
  assert.equal(env.state().busy, true);
  env.window.AthenaApp.openSettings('appearance');
  env.q('#ast-reduced-motion').checked = true; fire(env.q('#ast-reduced-motion'), 'change');
  assert.equal(env.state().busy, false);
  assert.equal(env.q('[data-athena-reply]').classList.contains('is-settled'), true);
  env.setReduced(true);
  env.q('#ast-reduced-motion').checked = false; fire(env.q('#ast-reduced-motion'), 'change');
  env.window.AthenaApp.closeSettings();
  env.type('#ac-prompt-input', 'System motion preference'); env.click('.acm-send');
  assert.equal(env.state().busy, false);
  assert.equal(env.q('[data-athena-reply]').classList.contains('is-settled'), true);
});

test('Settings: unavailable storage keeps local controls usable and reports session-only preferences', () => {
  const unavailableStorage = { get() { throw new Error('storage unavailable'); }, set() { throw new Error('storage unavailable'); } };
  const env = createEnvironment({ storage: unavailableStorage });
  env.click('[data-action="settings"]'); env.click('#ast-tab-appearance');
  env.click('[data-ast-size="compact"]');
  assert.equal(env.state().settings.textSize, 'compact');
  assert.equal(env.q('#athena-codex').style.getPropertyValue('--ac-font-size'), '13px');
  assert.equal(env.q('[data-ast-save-status]').textContent, 'UI changes apply to this session. Device storage is unavailable.');
  env.click('#ast-tab-about');
  assert.equal(env.q('[data-ast-storage]').textContent, 'Current session only');
  env.window.AthenaApp.closeSettings();
  assert.equal(env.state().settingsOpen, false);
});

test('동작 줄이기 설정: 시작 및 실행 중 전환에서 답변 완료와 입력 상태 복원', () => {
  const env = createEnvironment({ reduced: true, demo: true }); env.type('#ac-prompt-input', '동작 줄이기 요청'); env.click('.acm-send');
  assert.equal(env.state().busy, false); assert.equal(env.q('[data-athena-reply]').classList.contains('is-settled'), true);
  completedReplySummary(env);
  env.setReduced(false); env.type('#ac-prompt-input', '진행 중 설정 변경'); env.click('.acm-send'); assert.equal(env.state().busy, true);
  env.clock.advance(500); env.setReduced(true); assert.equal(env.state().busy, false);
  completedReplySummary(env);
});

test('Destroy releases shared workflow timers, motion, subscriptions, connected listeners, observers and object URLs', async () => {
  const env = createEnvironment();
  env.click('#ac-knowledge-nav');
  const input = env.q('.akn-file-input');
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['%PDF metadata fixture'], 'cleanup.pdf', { type: 'application/pdf' })] });
  fire(input, 'change'); await env.waitFor(() => !env.state().knowledge.importBusy);
  assert.equal(env.objectUrls.size, 1);
  env.click('#ac-panel-toggle');
  runDemoUI(env);
  env.click('.ac-command-button'); env.window.AthenaApp.submit('Destroy active local work');
  env.clock.advance(150);
  const progress = workspaceTask(env, 'sources').progress;
  assert.equal(workspace(env).run.status, 'running');
  env.destroy();
  assert.doesNotThrow(() => env.window.AthenaApp.destroy());
  assert.deepEqual(env.clock.counts(), { raf: 0, timeout: 0, interval: 0, microtasks: 0 });
  assert.equal([...env.observers].reduce((sum, observer) => sum + observer.targets.size, 0), 0);
  assert.equal([...env.media].reduce((sum, media) => sum + media.listeners.size, 0), 0);
  assert.equal(env.animations.size, 0);
  assert.equal(env.objectUrls.size, 0);
  const connected = [...env.listenerRecords].filter(record => record.target === env.window || record.target === env.document || record.target.isConnected);
  assert.deepEqual(connected.map(record => record.type), [], 'Application listeners on connected targets are removed.');
  assert.equal(env.qa('.acm-composer,#ac-mention-listbox,[data-athena-reply],.athena-task-list,.ac-command,#ac-morph-tip,.ac-resize-handle,#ac-settings-backdrop,#aw-approval-backdrop').length, 0);
  for (const id of ['ac-surface-slot', 'ac-workbench-slot', 'ac-knowledge-slot', 'aw-activity']) assert.equal(env.q('#' + id).children.length, 0);
  env.clock.advance(30000);
  assert.equal(workspaceTask(env, 'sources').progress, progress);
  assert.equal(workspace(env).run.status, 'cancelled');
  assert.deepEqual(env.networkCalls, []);
});

(async () => {
  for (const entry of tests) await runTest(entry);
  const failures = results.filter(result => result.status === 'failed');
  const changedDuringRun = sourceNames.filter(name => sha(fs.readFileSync(path.join(appDir, name), 'utf8')) !== sourceHashes[name]);
  const report = {
    generatedAt: new Date().toISOString(), runtime: { node: process.version, linkedom: linkedomVersion },
    mode: 'Node + LinkeDOM functional integration; no browser, server, visual rendering or external execution',
    inputs: sourceNames, sourceSha256: sourceHashes, sourceChangedDuringRun: changedDuringRun,
    limitations: mocks,
    summary: { total: results.length, passed: results.length - failures.length, failed: failures.length }, tests: results,
  };
  const resultPath = path.join(__dirname, 'integration-results.json');
  fs.writeFileSync(resultPath, JSON.stringify(report, null, 2) + '\n');
  console.log('\n' + report.summary.passed + '/' + results.length + ' passed; ' + failures.length + ' failed.');
  console.log('Report: ' + resultPath);
  console.log('Scope: DOM/state/event integration only. matchMedia, RAF, WAAPI, layout and focus are mocked.');
  if (changedDuringRun.length) console.warn('Source changed while the immutable snapshot ran: ' + changedDuringRun.join(', ') + '. Re-run before claiming the latest revision passed.');
  process.exitCode = failures.length || changedDuringRun.length ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
