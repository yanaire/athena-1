#!/usr/bin/env node
'use strict';
// Source-level/DOM contract tests. No browser rendering or real storage, OCR, or PDF service is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { File } = require('node:buffer');
const { parseHTML } = require(require.resolve('linkedom', { paths: [__dirname, '/workspace/scratch/79c4ece81d27/athena-codex-ui/qa'] }));
const appDir = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(appDir, name), 'utf8');
const local = value => JSON.parse(JSON.stringify(value));
function records() { const window = {}; vm.runInNewContext(read('ui/research-records.js'), { window, AbortController, Date, Map, Set, console }); return window.AthenaResearchRecords.create({ projectId: 'project-rc' }); }
const seed = (store, overrides = {}) => store.ensureDocument({ documentId: 'research-note', title: 'Research note', text: 'Reviewed baseline', version: '1', evidence: [{ sourceId: 'source-a', version: '1' }], review: { status: 'approved', version: '1' }, ...overrides });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('new document revision keeps original text, evidence and review immutable and makes edited content unreviewed', () => {
  const store = records(); seed(store);
  const fullText = 'Revised '.repeat(50000);
  store.updateDraft('research-note', fullText);
  assert.equal(store.getDocument('research-note').draft.text, fullText);
  const next = store.commitDraft('research-note');
  assert.equal(next.review.status, 'unreviewed'); assert.equal(next.review.version, next.version);
  assert.deepEqual(local(next.evidence), [{ sourceId: 'source-a', version: '1' }]);
  const doc = store.getDocument('research-note'); assert.equal(doc.versions.length, 2);
  assert.equal(doc.versions[0].text, 'Reviewed baseline'); assert.equal(doc.versions[0].review.status, 'approved');
  doc.versions[0].text = 'external mutation'; assert.equal(store.getDocument('research-note').versions[0].text, 'Reviewed baseline');
  store.selectVersion('research-note', '1'); assert.throws(() => store.updateDraft('research-note', 'overwrite'), /read-only/);
  store.selectVersion('research-note', next.version); assert.equal(store.getDocument('research-note').draft.text, fullText);
  store.destroy();
});

test('document save and PDF export require a real matching adapter receipt, preserve local drafts on rejection, and bind exports to a version', async () => {
  const store = records(); seed(store); store.updateDraft('research-note', 'New text');
  await assert.rejects(store.saveDocument('research-note'), /not connected/);
  assert.equal(store.getDocument('research-note').draft.text, 'New text'); assert.equal(store.getDocument('research-note').draft.dirty, true);
  await assert.rejects(store.exportPDF('research-note'), /new revision/);
  const version = store.commitDraft('research-note');
  await assert.rejects(store.exportPDF('research-note'), /connected document service/);
  const calls = [];
  store.attach({
    async saveDocument(request) { calls.push(request); return { ...request, version: 'server-2', review: { status: 'approved', version: '1' }, persistence: 'host', originalLocation: { uri: 'project://rc/documents/research-note/server-2' } }; },
    async exportPDF(request) { calls.push(request); return { projectId: request.projectId, documentId: request.documentId, version: request.version, artifactId: 'pdf-2', mediaType: 'application/pdf', location: { uri: 'project://rc/artifacts/pdf-2' } }; }
  });
  await store.saveDocument('research-note');
  assert.equal(calls[0].expectedCurrentVersion, null);
  assert.equal(store.getDocument('research-note').currentVersion, 'server-2');
  assert.equal(store.getDocument('research-note').versions.at(-1).review.status, 'unreviewed');
  const pdf = await store.exportPDF('research-note', 'server-2'); assert.equal(pdf.version, 'server-2');
  assert.equal(calls.at(-1).text, 'New text');
  assert.equal(store.getDocument('research-note').versions.find(item => item.version === version.version).text, 'New text');
  store.attach({ exportPDF: async () => ({ projectId: 'project-rc', documentId: 'research-note', version: '1', mediaType: 'application/pdf', artifactId: 'wrong', location: { uri: 'project://wrong' } }) });
  await assert.rejects(store.exportPDF('research-note', 'server-2'), /matching document version/);
  store.destroy();
});

test('project changes reject delayed document saves and keep review events version-scoped', async () => {
  const store = records(); seed(store); const gate = deferred(); let notify;
  store.attach({ saveDocument: request => gate.promise.then(() => ({ ...request, persistence: 'host' })), subscribe(fn) { notify = fn; return () => {}; } });
  store.updateDraft('research-note', 'Draft in first project'); const task = store.saveDocument('research-note');
  store.setProject('project-other'); seed(store, { text: 'Other project text', review: { status: 'unreviewed', version: '1' } });
  gate.resolve(); await assert.rejects(task, /project changed/);
  assert.equal(store.getDocument('research-note').versions[0].text, 'Other project text');
  notify({ type: 'document.reviewed', projectId: 'project-other', documentId: 'research-note', version: '1', review: { status: 'approved', version: '1' } });
  assert.equal(store.getDocument('research-note').versions[0].review.status, 'approved');
  store.setProject('project-rc'); assert.equal(store.getDocument('research-note').versions.at(-1).text, 'Draft in first project');
  assert.equal(store.getDocument('research-note').versions.at(-1).persistence, 'session');
  store.destroy();
});

function knowledge(storage = new Map()) {
  const { window, document } = parseHTML('<html><body><div id="host"></div></body></html>');
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true, get() { return [...this.options].find(option => option.hasAttribute('selected'))?.value || this.options[0]?.value || ''; }, set(value) { for (const option of this.options) option.toggleAttribute('selected', option.value === String(value)); } });
  window.localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const urls = new Set();
  const URL = { createObjectURL() { const url = 'blob:fixture-' + urls.size; urls.add(url); return url; }, revokeObjectURL(url) { urls.delete(url); } };
  vm.runInNewContext(read('ui/knowledge.js'), { window, document, AbortController, URL, Date, Intl, FileReader: class {} });
  const api = window.AthenaKnowledge.mount(document.querySelector('#host'));
  const q = selector => document.querySelector(selector);
  const fire = (node, type) => node.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  const click = selector => fire(typeof selector === 'string' ? q(selector) : selector, 'click');
  const wait = async predicate => { for (let i = 0; i < 30 && !predicate(); i++) await Promise.resolve(); assert.ok(predicate(), 'The controlled async operation completed.'); };
  return { api, q, fire, click, wait, urls, storage };
}
function addNote(env, title, body) {
  env.click('[data-akn-action="add-note"]'); env.q('[name="note-title"]').value = title; env.q('[name="note-body"]').value = body;
  env.fire(env.q('.akn-note-form'), 'submit');
}

test('Knowledge keeps notes, files, search and unfinished drafts isolated by project and restores project notes from device storage', () => {
  const storage = new Map(), env = knowledge(storage);
  addNote(env, 'RC note', 'First project evidence'); const firstId = env.api.getState().selectedId;
  env.click('[data-akn-action="add-note"]'); env.q('[name="note-title"]').value = 'Unfinished RC'; env.q('[name="note-body"]').value = 'Keep this draft';
  env.api.setProject('project-other'); assert.equal(env.api.getState().sources.length, 0); assert.equal(env.api.getState().noteDraft.text, '');
  addNote(env, 'Other note', 'Second project evidence'); assert.equal(env.api.getState().sources.length, 1);
  env.api.setProject('project-rc'); assert.equal(env.api.getState().noteDraft.text, 'Keep this draft');
  assert.ok(env.api.getState().sources.some(source => source.id === firstId)); assert.ok(!env.api.getState().sources.some(source => source.title === 'Other note'));
  env.api.destroy(); const restored = knowledge(storage);
  assert.ok(restored.api.getState().sources.some(source => source.title === 'RC note'));
  restored.api.setProject('project-other'); assert.equal(restored.api.getState().sources[0].title, 'Other note'); restored.api.destroy();
});

test('an archived paper pin survives a reload only for the same project and edition', async () => {
  const storage = new Map();
  let version = 'first';
  const service = { async listSources({projectId}) {
    return {sources: [{projectId,sourceId:'paper-1',version,title:'Measurements',kind:'documents',format:'Paper',
      persistence:'host',originalLocation:{uri:'project://'+projectId+'/papers/1'}}]};
  }};
  async function open(projectId) {
    const env = knowledge(storage);
    env.api.setProject(projectId);
    env.api.attachRecords(service);
    await env.wait(() => env.api.getState().sources.some(source => source.id === 'paper-1'));
    env.click('[data-akn-source="paper-1"]');
    return env;
  }
  const pinned = env => env.q('[data-akn-action="pin"]').getAttribute('aria-pressed') === 'true';
  let env = await open('first-project');
  env.click('[data-akn-action="pin"]'); assert.ok(pinned(env)); env.api.destroy();
  env = await open('another-project'); assert.equal(pinned(env),false); env.api.destroy();
  env = await open('first-project'); assert.ok(pinned(env));
  version = 'second';
  await env.api.refreshSources(); assert.equal(pinned(env),false);
  version = 'first';
  await env.api.refreshSources(); assert.ok(pinned(env));
  env.click('[data-akn-action="pin"]'); env.api.destroy();
  env = await open('first-project'); assert.equal(pinned(env),false); env.api.destroy();
});

test('a note stored by the project service keeps its device pin selection across reload', async () => {
  const storage = new Map(), env = knowledge(storage);
  addNote(env,'Protocol','Measured in triplicate.');
  env.click('[data-akn-action="pin"]');
  const sourceId=env.api.getState().selectedId;
  const receipt={projectId:'project-rc',sourceId,version:'1',title:'Protocol',kind:'notes',format:'NOTE',
    persistence:'host',originalLocation:{uri:'project://project-rc/originals/note'}};
  env.api.attachRecords({ storeSource: async () => receipt });
  env.click('[data-akn-action="store-original"]');
  await env.wait(() => env.api.getState().sources.find(item => item.id === sourceId)?.persistence === 'host');
  env.click('[data-akn-action="pin"]');
  env.api.destroy();
  const restored = knowledge(storage);
  restored.api.attachRecords({ listSources: async () => ({sources:[receipt]}) });
  await restored.wait(() => restored.api.getState().sources.find(item => item.id === sourceId)?.persistence === 'host');
  assert.equal(restored.api.getState().sources.find(item => item.id === sourceId).pinned,false);
  restored.api.destroy();
});

test('Knowledge hands off original bytes explicitly, separates PDF preview/extraction, and preserves prior-version reviews', async () => {
  const env = knowledge(), file = new File(['%PDF-1.4\nFixture original'], 'paper.pdf', { type: 'application/pdf' });
  Object.defineProperty(env.q('.akn-file-input'), 'files', { configurable: true, value: [file] }); env.fire(env.q('.akn-file-input'), 'change'); await env.wait(() => !env.api.getState().importBusy);
  let source = env.api.getState().sources.find(item => item.origin === 'file');
  assert.equal(source.extraction.status, 'not_requested'); assert.equal(source.textAvailable, false); assert.equal(source.persistence, 'session');
  assert.ok(env.q('[data-akn-action="store-original"]').disabled); assert.match(env.q('.akn-detail').textContent, /Previewing a file does not read or understand/);
  let notify, handoff;
  const receipt = overrides => ({ projectId: 'project-rc', sourceId: source.id, version: '1', title: 'paper.pdf', kind: 'documents', format: 'PDF', persistence: 'host', originalLocation: { uri: 'project://rc/originals/paper.pdf' }, extraction: { status: 'not_requested', version: '1' }, review: { status: 'unreviewed', version: '1' }, ...overrides });
  env.api.attachRecords({ capabilities: ['storeSource', 'extractSource'], subscribe(fn) { notify = fn; return () => {}; }, async storeSource(request) { handoff = request; return receipt(); }, async extractSource(request) { assert.equal(request.version, '1'); return receipt({ text: 'Actual extracted fixture text', extraction: { status: 'ready', version: '1' }, review: { status: 'approved', version: '1' } }); } });
  assert.equal(handoff, undefined, 'Attaching does not upload the original.'); env.click('[data-akn-action="store-original"]'); await env.wait(() => !env.api.getState().pendingSourceIds.length);
  assert.equal(handoff.file, file); source = env.api.getState().sources.find(item => item.origin === 'file'); assert.equal(source.persistence, 'host'); assert.equal(source.textAvailable, false);
  env.click('[data-akn-action="extract-text"]'); await env.wait(() => !env.api.getState().pendingSourceIds.length);
  source = env.api.getState().sources.find(item => item.origin === 'file'); assert.equal(source.extraction.status, 'ready'); assert.equal(source.textAvailable, true);
  assert.match(env.q('.akn-detail').textContent, /do not establish that its contents are correct or reviewed/);
  notify({ type: 'source.updated', projectId: 'project-rc', source: receipt({ version: '2', text: 'Updated source text', extraction: { status: 'ready', version: '2' }, review: { status: 'approved', version: '1' } }) });
  source = env.api.getState().sources.find(item => item.origin === 'file'); assert.equal(source.review.status, 'unreviewed'); assert.equal(source.review.version, '2');
  assert.equal(source.priorVersions[0].review.status, 'approved'); assert.equal(source.priorVersions[0].version, '1');
  assert.equal(env.q('.akn-pdf-object'), null, 'The old version’s local PDF is never presented as the new original.');
  assert.equal(env.api.getOriginalFile(source.id, '1'), file); assert.equal(env.api.getOriginalFile(source.id, '2'), null);
  env.api.destroy(); assert.equal(env.urls.size, 0);
});

test('opening a historical project revision first keeps the current host version and draft intact', async () => {
  const store = records();
  const revisions = ['old','current'].map(version => ({
    projectId:'project-rc',documentId:'study',title:'Study',text:version,version,currentVersion:'current',evidence:[]
  }));
  store.attach({getDocument: async request => revisions[request.version==='old'?0:1]});
  await store.loadDocument('study','old');
  assert.equal(store.getDocument('study').currentVersion,'current');
  store.selectVersion('study','old');assert.throws(()=>store.updateDraft('study','replacement'),/read-only/);
  store.selectVersion('study','current');store.updateDraft('study','my edits');
  await store.loadDocument('study','old');
  assert.equal(store.getDocument('study').draft.text,'my edits');
  store.destroy();
});
