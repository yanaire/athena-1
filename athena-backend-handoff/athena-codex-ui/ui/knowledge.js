/* Project-scoped references. Original bytes stay in memory unless an attached service confirms storage. */
(() => {
  'use strict';

  const instances = new WeakMap();
  const KNOWLEDGE_NAMESPACE = 'athena.knowledge.v1';
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_NOTE_LENGTH = 20000;
  const MAX_NOTES = 50;
  const FILTERS = ['all', 'documents', 'notes', 'datasets'];
  const KINDS = { documents: 'Document', notes: 'Note', datasets: 'Dataset' };
  const GLYPHS = { documents: 'file-text', notes: 'sticky-note', datasets: 'table-2' };
  let instanceNumber = 0;
  const icon = name => '<i data-lucide="' + name + '" aria-hidden="true"></i>';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const byteSize = value => value < 1024 ? value + ' B' : value < 1048576 ? (value / 1024).toFixed(value < 10240 ? 1 : 0) + ' KB' : (value / 1048576).toFixed(1) + ' MB';
  const count = value => Number(value).toLocaleString('en-US');

  const SAMPLES = [
    {
      id: 'sample-brief', title: 'RC low-pass filter · Brief', kind: 'documents', format: 'TEXT',
      artifactId: 'research-brief', description: 'Objective, nominal components, and the analytical model.',
      text: 'RC low-pass filter — research brief\n\nObjective\nCompare the frequency response of an ideal RC low-pass filter with its analytical cutoff frequency.\n\nNominal components\nR = 1 kΩ\nC = 100 nF\nTime constant, τ = RC = 100 µs\nCutoff frequency, fc = 1 / (2πRC) ≈ 1.5915 kHz\n\nMethod\nEvaluate the ideal transfer function H(jω) = 1 / (1 + jωRC) from 10 Hz to 100 kHz. Check magnitude and phase around the cutoff frequency.\n\nAcceptance criterion\nCompare a reported cutoff with the nominal analytical value, using a 1% relative-error threshold.\n\nScope\nThe example assumes ideal components. It does not include component tolerance, parasitics, loading, or measurement uncertainty.\n\nExample material for this local UI prototype.'
    },
    {
      id: 'sample-sources', title: 'Analytical reference notes', kind: 'documents', format: 'TEXT',
      artifactId: 'research-brief', description: 'Equations and assumptions used in the example study.',
      text: 'Analytical reference notes\n\nIdeal RC low-pass filter\nTransfer function: H(jω) = 1 / (1 + jωRC)\nMagnitude: |H| = 1 / √(1 + (ωRC)²)\nPhase: φ = −arctan(ωRC)\nCutoff frequency: fc = 1 / (2πRC)\n\nAt cutoff\nMagnitude is 1 / √2 of the low-frequency value (approximately −3.01 dB), and phase is −45°.\n\nReference assumptions\nThe resistance and capacitance are nominal, frequency-independent values. The example excludes loading and component nonidealities.\n\nThese are bundled example notes, not retrieved publications. Add your own readings to build a project-specific reference collection.'
    },
    {
      id: 'sample-data', title: 'RC frequency sweep.csv', kind: 'datasets', format: 'CSV',
      artifactId: 'response-plot', description: 'Nine analytical sample points for the ideal circuit.',
      text: 'frequency_hz,magnitude_ratio,phase_deg\n10,0.999980,-0.3600\n50,0.999507,-1.7994\n100,0.998032,-3.5953\n500,0.954028,-17.4406\n1000,0.846733,-32.1419\n1591.5494,0.707107,-45.0000\n5000,0.303314,-72.3432\n10000,0.157177,-80.9569\n100000,0.015913,-89.0882'
    },
    {
      id: 'sample-note', title: 'Validation checklist', kind: 'notes', format: 'NOTE',
      artifactId: 'research-note', description: 'Review points before turning results into a report.',
      text: 'Validation checklist\n\n• Confirm the resistor and capacitor units.\n• Compare the reported cutoff with 1 / (2πRC).\n• Check the magnitude and phase near the cutoff.\n• State the frequency range and sampling assumptions.\n• Keep analytical example values separate from physical measurements.\n• Explain the effect of component tolerance and loading before claiming hardware agreement.\n\nExample note for the RC low-pass filter project.'
    }
  ];

  function mount(host, options = {}) {
    if (!host) throw new TypeError('AthenaKnowledge.mount requires a host element.');
    instances.get(host)?.destroy();
    const controller = new AbortController();
    const listen = (element, type, callback) => element.addEventListener(type, callback, { signal: controller.signal });
    const prefix = 'akn-' + (++instanceNumber) + '-';
    const files = new Map();
    const fileVersions = new Map();
    const blobUrls = new Map();
    let destroyed = false;
    let importBusy = false;
    let storageMode = 'local';
    let initialNotice = '';
    let serial = 0;
    let query = '';
    let filter = 'all';
    let pinnedOnly = false;
    let projectId = options.projectId || 'project-rc';
    let service = null, serviceUnsubscribe = null, serviceEpoch = 0, projectEpoch = 0;
    const projectBuckets = new Map(), sourceOperations = new Set();
    let selectedId = projectId === 'project-rc' ? 'sample-brief' : null;
    const sourceDefaults = (source, project = projectId) => ({ ...source, projectId: project, sourceVersion: String(source.sourceVersion || '1'), originalLocation: source.originalLocation || { uri: null, label: source.isSample ? 'Bundled example' : source.origin === 'note' ? 'Note created in Athena' : source.title }, persistence: source.persistence || (source.isSample ? 'bundled' : source.origin === 'note' ? 'device' : 'session'), extraction: source.extraction || { status: source.format === 'PDF' ? 'not_requested' : 'ready', version: String(source.sourceVersion || '1'), method: source.format === 'PDF' ? null : 'plain-text' }, review: source.review || { status: 'unreviewed', version: String(source.sourceVersion || '1') }, versions: source.versions || [] });
    let runtimeMode = Boolean(options.hosted);
    const initialSources = project => !runtimeMode && project === 'project-rc' ? SAMPLES.map((source, index) => sourceDefaults({ ...source, origin: 'sample', isSample: true, sessionOnly: false, pinned: index === 0, createdAt: '', order: index }, project)) : [];
    let sources = initialSources(projectId);
    const storageKey = () => KNOWLEDGE_NAMESPACE + ':' + encodeURIComponent(projectId);
    const editionPinKey = source => storageKey() + ':pin:' + encodeURIComponent(source.id) + ':' + encodeURIComponent(source.sourceVersion);
    function loadProjectStorage() {
    try {
      const raw = window.localStorage.getItem(storageKey()) || (projectId === 'project-rc' ? window.localStorage.getItem(KNOWLEDGE_NAMESPACE) : null);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid collection');
          if (Array.isArray(parsed.notes)) {
            const seen = new Set();
            parsed.notes.slice(0, MAX_NOTES).forEach(note => {
              if (!note || typeof note !== 'object' || typeof note.id !== 'string' || !/^note-[a-zA-Z0-9-]{1,90}$/.test(note.id) || seen.has(note.id)) return;
              if (typeof note.title !== 'string' || !note.title.trim() || note.title.length > 120 || typeof note.text !== 'string' || !note.text.trim() || note.text.length > MAX_NOTE_LENGTH) return;
              seen.add(note.id);
              sources.push(sourceDefaults({ id: note.id, title: note.title, text: note.text, kind: 'notes', format: 'NOTE', origin: 'note', isSample: false, sessionOnly: false, pinned: false, createdAt: typeof note.createdAt === 'string' && Number.isFinite(Date.parse(note.createdAt)) ? note.createdAt : '', order: sources.length }));
            });
          }
          if (Array.isArray(parsed.pins)) {
            const pins = new Set(parsed.pins.filter(value => typeof value === 'string'));
            sources.forEach(source => { source.pinned = pins.has(source.id); });
          }
        } catch (_) { initialNotice = 'Unreadable saved notes were skipped. Example sources are still available.'; }
      }
    } catch (_) { storageMode = 'session'; }
    }
    loadProjectStorage();

    const root = document.createElement('section');
    root.className = 'akn-root';
    root.setAttribute('aria-labelledby', prefix + 'title');
    root.innerHTML = `
      <header class="akn-heading">
        <div class="akn-heading-top"><span class="akn-eyebrow">PROJECT LIBRARY</span><span class="akn-count" data-akn-total></span></div>
        <h2 id="${prefix}title">Knowledge</h2>
        <p class="akn-project-scope" data-akn-project></p>
        <div class="akn-top-actions">
          <button type="button" class="akn-button akn-import-button cursor-interaction" data-akn-action="import">${icon('upload')}<span data-akn-import-label>Import files</span></button>
          <button type="button" class="akn-button cursor-interaction" data-akn-action="add-note" aria-expanded="false" aria-controls="${prefix}note-form">${icon('plus')}Add note</button>
        </div>
        <input class="akn-file-input" type="file" accept=".pdf,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv" multiple aria-label="Choose local reference files" tabindex="-1">
        <p class="akn-file-hint">PDF, TXT, Markdown, CSV · up to 10 MB each</p>
      </header>
      <div class="akn-toolbar">
        <label class="akn-search"><span class="akn-sr-only">Search sources</span>${icon('search')}<input type="search" name="knowledge-search" placeholder="Search titles and text…" autocomplete="off" spellcheck="false"><button type="button" class="akn-search-clear cursor-interaction" data-akn-action="clear-search" aria-label="Clear source search" hidden>${icon('x')}</button></label>
        <button type="button" class="akn-button" data-akn-find-papers hidden>Search and save papers</button><div class="akn-filters"><label class="akn-filter-label"><span class="akn-sr-only">Source type</span><select class="akn-filter cursor-interaction" aria-label="Source type"><option value="all">All sources</option><option value="documents">Documents</option><option value="notes">Notes</option><option value="datasets">Datasets</option></select></label><button type="button" class="akn-pinned-filter cursor-interaction" data-akn-action="pinned-filter" aria-pressed="false">${icon('pin')}Pinned</button></div>
      </div>
      <div class="akn-scroll">
        <form class="akn-note-form" id="${prefix}note-form" aria-labelledby="${prefix}note-title" novalidate hidden>
          <div class="akn-form-heading"><h3 id="${prefix}note-title">A note for this project</h3>${icon('sticky-note')}</div>
          <label for="${prefix}note-name">Title</label><input class="akn-input" id="${prefix}note-name" name="note-title" type="text" maxlength="120" placeholder="What should you remember?" aria-describedby="${prefix}note-error" required>
          <label for="${prefix}note-body">Note</label><textarea class="akn-input" id="${prefix}note-body" name="note-body" rows="6" maxlength="${MAX_NOTE_LENGTH}" placeholder="Add a thought, a source, or a useful detail…" aria-describedby="${prefix}note-error" required></textarea>
          <p class="akn-form-help">Saved on this device when local storage is available.</p><p class="akn-error" id="${prefix}note-error" role="alert" hidden></p>
          <div class="akn-form-actions"><button class="akn-button cursor-interaction" type="button" data-akn-action="cancel-note">Cancel</button><button class="akn-button akn-primary cursor-interaction" type="submit">Save note</button></div>
        </form>
        <p class="akn-notice" role="status" aria-live="polite" hidden></p>
        <div class="akn-list-heading"><h3 data-akn-list-title>All sources</h3><span data-akn-match-count aria-live="polite"></span></div>
        <div class="akn-list" role="list" aria-label="Project sources"></div>
        <div class="akn-empty" hidden>${icon('search')}<h3>No sources found</h3><p>Try a different search or source type.</p><button type="button" class="akn-button cursor-interaction" data-akn-action="reset-filters">Clear filters</button></div>
        <section class="akn-detail" aria-label="Selected source"></section>
        <footer class="akn-footer">${icon('hard-drive')}<p data-akn-storage-note></p></footer>
      </div>`;
    host.replaceChildren(root);
    const q = selector => root.querySelector(selector);
    const searchInput = q('[name="knowledge-search"]');
    const filterSelect = q('.akn-filter');
    const pinnedFilter = q('[data-akn-action="pinned-filter"]');
    const fileInput = q('.akn-file-input');
    const importButton = q('[data-akn-action="import"]');
    const noteForm = q('.akn-note-form');
    const noteTitle = q('[name="note-title"]');
    const noteBody = q('[name="note-body"]');
    const noteError = q('.akn-error');
    const list = q('.akn-list');
    const detail = q('.akn-detail');
    const notice = q('.akn-notice');
    const storageNote = q('[data-akn-storage-note]');

    function showNotice(message, tone = '') {
      notice.textContent = message;
      notice.hidden = !message;
      notice.dataset.tone = tone;
    }
    let searchingPapers=false;
    const findPapers=q('[data-akn-find-papers]');
    listen(findPapers,'click',async()=>{
      const term=searchInput.value.trim(),project=projectId,bound=serviceEpoch;
      if(!term){showNotice('Enter a public research topic or DOI.');searchInput.focus();return;}
      if(searchingPapers||!service?.canSearch?.(project))return;
      searchingPapers=true;findPapers.disabled=true;showNotice('Searching public literature…');
      try{
        const result=await service.searchAndSave({projectId:project,term,mode:/^10\.\d{4,9}\//i.test(term)?'doi':'query',requestId:crypto.randomUUID()});
        if(destroyed||bound!==serviceEpoch||project!==projectId)return;
        await refreshSources();
        if(destroyed||bound!==serviceEpoch||project!==projectId)return;
        if(result.saved?.length){query='';searchInput.value='';filter='documents';filterSelect.value=filter;selectedId=result.saved[0].sourceId;renderCollection();}
        showNotice((result.saved?.length||0)+' paper editions saved.'+(result.error?' Crossref: '+result.error:''));
      }catch(e){if(bound===serviceEpoch&&project===projectId)showNotice(e.message,'warning');}
      finally{searchingPapers=false;findPapers.disabled=false;}
    });
    function refreshStorageNote() {
      findPapers.hidden=!service?.canSearch?.(projectId);
      storageNote.textContent = service ? 'Project file storage is connected. Each source shows whether its original was stored. Extraction and review are separate steps.' : storageMode === 'local' ? 'Files stay in this session. Notes and pins are saved for this project on this device. Original-file storage and PDF extraction are not connected.' : 'Storage is unavailable. Project files, notes, and pins stay in this session. Original-file storage and PDF extraction are not connected.';
      if(service?.listSources&&service?.searchAndSave)storageNote.textContent='Research papers are saved in the project’s Athena Library folder and can be cited across its conversations.';
      q('[data-akn-project]').textContent = 'Project · ' + projectId;
    }
    function persist() {
      const persistent = sources.filter(source => source.origin !== 'file' && source.origin !== 'host');
      try {
        window.localStorage.setItem(storageKey(), JSON.stringify({ version: 2, projectId, notes: persistent.filter(source => source.origin === 'note').map(({ id, title, text, createdAt }) => ({ id, title, text, createdAt })), pins: persistent.filter(source => source.pinned).map(source => source.id) }));
        storageMode = 'local';
      } catch (_) { storageMode = 'session'; }
      sources.filter(source => source.origin === 'note').forEach(source => { source.sessionOnly = source.persistence !== 'host' && storageMode === 'session'; if (source.persistence !== 'host') source.persistence = storageMode === 'session' ? 'session' : 'device'; });
      refreshStorageNote();
    }
    function publicSource(source) {
      return { id: source.id, title: source.title, kind: source.kind, format: source.format, origin: source.origin, isSample: source.isSample, sessionOnly: source.persistence !== 'host' && (source.origin === 'file' || (source.origin === 'note' && storageMode === 'session')), pinned: source.pinned, size: source.size || null, textAvailable: Boolean(source.text), createdAt: source.createdAt, artifactId: source.artifactId || null, projectId: source.projectId, sourceVersion: source.sourceVersion, originalLocation: { ...source.originalLocation }, persistence: source.persistence, extraction: { ...source.extraction }, review: { ...source.review }, priorVersions: source.versions.map(version => ({ version: version.sourceVersion, extraction: version.extraction, review: version.review, originalLocation: version.originalLocation })), understanding: 'not-assessed' };
    }
    function visibleSources() {
      const needle = query.trim().toLocaleLowerCase();
      return sources.filter(source => (filter === 'all' || source.kind === filter) && (!pinnedOnly || source.pinned) && (!needle || (source.title + '\n' + (source.text || '')).toLocaleLowerCase().includes(needle))).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order);
    }
    function sourceMeta(source) {
      return source.persistence === 'host' ? 'Project source · v' + source.sourceVersion : source.isSample ? 'Example' : source.origin === 'file' ? byteSize(source.size) + ' · Session file' : storageMode === 'local' ? 'Local note' : 'Session note';
    }
    function shortDate(value) {
      if (!value || !Number.isFinite(Date.parse(value))) return '';
      return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(value));
    }
    function excerptFor(source) {
      if (!source.text) return 'PDF reference: ' + source.title + ' (' + byteSize(source.size || 0) + '). Source ' + source.id + ', version ' + source.sourceVersion + '. PDF preview does not provide extracted or understood content.';
      const text = source.text;
      const needle = query.trim().toLocaleLowerCase();
      const match = needle ? text.toLocaleLowerCase().indexOf(needle) : -1;
      const start = match > 180 ? match - 180 : 0;
      const prefixText = start ? '…' : '';
      const room = 1600 - prefixText.length;
      const truncated = start + room < text.length;
      return prefixText + text.slice(start, start + room - (truncated ? 1 : 0)) + (truncated ? '…' : '');
    }
    function renderDetail() {
      const source = sources.find(item => item.id === selectedId);
      if (!source) { detail.hidden = true; detail.replaceChildren(); return; }
      detail.hidden = false;
      const isPdf = source.format === 'PDF';
      const previewText = source.text ? source.text.slice(0, 16000) : '';
      const date = shortDate(source.createdAt);
      detail.innerHTML = `
        <div class="akn-detail-top"><span class="akn-detail-type">${icon(GLYPHS[source.kind])}${escape(KINDS[source.kind])}${source.isSample ? '<span class="akn-example-badge">Example</span>' : ''}</span><button type="button" class="akn-icon-button cursor-interaction" data-akn-action="pin" aria-pressed="${source.pinned}" aria-label="${source.pinned ? 'Unpin source' : 'Pin source'}" title="${source.pinned ? 'Unpin source' : 'Pin source'}">${icon('pin')}</button></div>
        <h3 class="akn-detail-title" tabindex="-1">${escape(source.title)}</h3>
        ${source.description ? '<p class="akn-detail-description">' + escape(source.description) + '</p>' : ''}
        <dl class="akn-metadata"><div><dt>Source</dt><dd>${source.persistence === 'host' ? 'Project original' : source.isSample ? 'Bundled example' : source.origin === 'file' ? 'Local file · this session' : storageMode === 'local' ? 'Note · this device' : 'Note · this session'}</dd></div><div><dt>Format</dt><dd>${escape(source.format)}${source.size ? ' · ' + byteSize(source.size) : ''}</dd></div>${date ? '<div><dt>Added</dt><dd>' + escape(date) + '</dd></div>' : ''}<div><dt>Text</dt><dd>${source.extraction.status === 'ready' ? count((source.text || '').length) + ' characters' : escape(source.extraction.status.replaceAll('_', ' '))}</dd></div><div><dt>Project</dt><dd>${escape(source.projectId)}</dd></div><div><dt>Version</dt><dd>${escape(source.sourceVersion)}</dd></div><div><dt>Original</dt><dd>${escape(source.originalLocation.uri || source.originalLocation.label || 'Not stored')}</dd></div><div><dt>Storage</dt><dd>${source.persistence === 'host' ? 'Confirmed by project service' : source.persistence === 'bundled' ? 'Bundled example' : source.persistence === 'device' ? 'Note on this device' : 'Session only'}</dd></div><div><dt>Review</dt><dd>${escape(source.review.status.replaceAll('_', ' '))} · v${escape(source.review.version)}</dd></div></dl>
        ${isPdf ? '<div class="akn-pdf-note">' + icon('info') + '<p>' + (source.extraction.status === 'ready' ? 'Extracted text is available for this version. PDF preview and extraction do not establish that its contents are correct or reviewed.' : service ? 'Native PDF preview only. Extraction status: ' + escape(source.extraction.status.replaceAll('_', ' ')) + '. Previewing a file does not read or understand its contents.' : 'Native PDF preview only. Text extraction, OCR, and indexing are not available. Previewing a file does not read or understand its contents.') + '</p></div><div class="akn-pdf-preview"></div>' + (source.text ? '<div class="akn-preview-heading"><h4>Extracted text</h4><span>Review: ' + escape(source.review.status.replaceAll('_', ' ')) + '</span></div><pre class="akn-text-preview" tabindex="0">' + escape(previewText) + '</pre>' + (source.text.length > 16000 ? '<p class="akn-truncated">Showing the first 16,000 characters. Search includes the full extracted text.</p>' : '') : '') : '<div class="akn-preview-heading"><h4>' + (source.format === 'CSV' ? 'CSV preview' : 'Text preview') + '</h4><span>Plain text</span></div><pre class="akn-text-preview" tabindex="0">' + escape(previewText) + '</pre>' + (source.text && source.text.length > 16000 ? '<p class="akn-truncated">Showing the first 16,000 characters. Search includes the full text.</p>' : '')}
        <div class="akn-source-actions"><button type="button" class="akn-button akn-primary cursor-interaction" data-akn-action="use-source">${icon('corner-down-left')}${!source.text ? 'Use file details in chat' : 'Use excerpt in chat'}</button>${source.artifactId && typeof options.onOpenArtifact === 'function' ? '<button type="button" class="akn-button cursor-interaction" data-akn-action="open-artifact">' + icon('arrow-up-right') + 'Open example artifact</button>' : ''}</div>
        ${!source.text ? '' : '<p class="akn-excerpt-hint">Adds up to 1,600 characters to the composer for your review. The exact source and version stay attached as metadata.</p>'}
        ${source.paperCoverage ? '<p class="akn-service-note">'+escape(source.paperCoverage)+' · '+escape(source.originalLocation.label)+'</p>'+(source.paperDetail?'<p>'+escape(source.paperDetail)+'</p>':'')+(source.originalUri?'<a class="akn-button" href="'+escape(source.originalUri)+'" download>Download original</a>':'') : !source.isSample ? '<div class="akn-service-actions"><button type="button" class="akn-button cursor-interaction" data-akn-action="store-original" ' + (!serviceAvailable('storeSource') || source.persistence === 'host' || sourceOperations.has(source.id) ? 'disabled' : '') + '>' + icon('hard-drive-upload') + (source.persistence === 'host' ? 'Original stored' : 'Store original') + '</button>' + (isPdf ? '<button type="button" class="akn-button cursor-interaction" data-akn-action="extract-text" ' + (!serviceAvailable('extractSource') || source.persistence !== 'host' || sourceOperations.has(source.id) || ['queued', 'extracting'].includes(source.extraction.status) ? 'disabled' : '') + '>' + icon('text-search') + 'Extract text</button>' : '') + '</div><p class="akn-service-note">' + (service ? 'Storage, extraction, and review require separate confirmations from the project service.' : 'Connect project storage to preserve original files beyond this session.') + '</p>' : ''}
        ${source.isSample || source.paperCoverage ? '' : '<button type="button" class="akn-remove-button cursor-interaction" data-akn-action="remove">' + icon('trash-2') + 'Remove source</button>'}`;
      if (isPdf) {
        const container = detail.querySelector('.akn-pdf-preview');
        const url = fileVersions.get(source.id) === source.sourceVersion ? blobUrls.get(source.id) : null;
        if (url) {
          const object = document.createElement('object');
          object.setAttribute('type', 'application/pdf');
          object.setAttribute('data', url);
          object.setAttribute('aria-label', 'PDF preview: ' + source.title);
          object.className = 'akn-pdf-object';
          const fallback = document.createElement('p');
          fallback.textContent = 'A PDF preview is not available in this browser. You can open the local file below.';
          object.appendChild(fallback);
          container.appendChild(object);
          const link = document.createElement('a');
          link.className = 'akn-pdf-link cursor-interaction';
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = 'Open local PDF';
          container.appendChild(link);
        } else {
          const fallback = document.createElement('p');
          fallback.className = 'akn-pdf-unavailable';
          fallback.textContent = source.persistence === 'host' ? 'The original for this revision is stored by the project service. Native preview needs that revision’s bytes or a preview URL.' : 'The native preview is unavailable in this browser. File details remain available.';
          container.appendChild(fallback);
        }
      }
    }
    function renderCollection() {
      const visible = visibleSources();
      if (!visible.some(source => source.id === selectedId)) selectedId = visible[0]?.id || null;
      q('[data-akn-total]').textContent = sources.length + (sources.length === 1 ? ' source' : ' sources');
      q('[data-akn-match-count]').textContent = visible.length + ' shown';
      q('[data-akn-list-title]').textContent = pinnedOnly ? 'Pinned sources' : filter === 'all' ? 'All sources' : filter[0].toUpperCase() + filter.slice(1);
      q('[data-akn-action="clear-search"]').hidden = !query;
      pinnedFilter.setAttribute('aria-pressed', String(pinnedOnly));
      list.innerHTML = visible.map(source => `<div role="listitem"><button type="button" class="akn-source cursor-interaction" data-akn-source="${escape(source.id)}" aria-pressed="${source.id === selectedId}"><span class="akn-source-icon">${icon(GLYPHS[source.kind])}</span><span class="akn-source-copy"><strong>${escape(source.title)}</strong><small><span>${escape(source.format)}</span>${escape(sourceMeta(source))}</small></span>${source.pinned ? '<span class="akn-source-pin" aria-label="Pinned">' + icon('pin') + '</span>' : ''}</button></div>`).join('');
      q('.akn-empty').hidden = visible.length > 0;
      renderDetail();
      options.icons?.();
    }
    function clearNoteError() {
      noteError.hidden = true;
      noteError.textContent = '';
      noteTitle.removeAttribute('aria-invalid');
      noteBody.removeAttribute('aria-invalid');
    }
    function setNoteOpen(open) {
      noteForm.hidden = !open;
      q('[data-akn-action="add-note"]').setAttribute('aria-expanded', String(open));
      if (open) noteTitle.focus({ preventScroll: false });
      else { noteTitle.value = ''; noteBody.value = ''; clearNoteError(); }
    }
    function restoreFullList() {
      query = ''; filter = 'all'; pinnedOnly = false;
      searchInput.value = ''; filterSelect.value = 'all';
    }
    function uniqueId(kind) {
      let id;
      do { id = kind + '-' + Date.now().toString(36) + '-' + (++serial).toString(36); } while (sources.some(source => source.id === id));
      return id;
    }
    async function readText(file) {
      if (typeof file.text === 'function') return file.text();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Unable to read file'));
        reader.readAsText(file);
      });
    }
    async function importFiles(selectedFiles) {
      if (importBusy || destroyed || !selectedFiles.length) return;
      importBusy = true;
      importButton.disabled = true;
      q('[data-akn-import-label]').textContent = 'Importing…';
      const errors = [];
      const importProject = projectId, importSources = sources;
      let imported = 0;
      let newestId = null;
      if (selectedFiles.length > 10) errors.push('Only the first 10 files were considered.');
      for (const file of selectedFiles.slice(0, 10)) {
        if (destroyed) break;
        const extension = String(file.name).split('.').pop().toLowerCase();
        if (!['pdf', 'txt', 'md', 'csv'].includes(extension)) { errors.push(file.name + ': use PDF, TXT, MD, or CSV.'); continue; }
        if (file.size > MAX_FILE_BYTES) { errors.push(file.name + ': exceeds the 10 MB limit.'); continue; }
        if (!file.size) { errors.push(file.name + ': this file is empty.'); continue; }
        if (importSources.some(source => { const existing = files.get(source.id); return existing && existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified; })) { errors.push(file.name + ': already in this session.'); continue; }
        if (files.size >= 50) { errors.push('This session can hold up to 50 files. Remove a file before adding more.'); break; }
        try {
          const text = extension === 'pdf' ? '' : await readText(file);
          if (destroyed) break;
          if (extension !== 'pdf' && text.includes('\u0000')) { errors.push(file.name + ': this does not appear to be a plain-text file.'); continue; }
          const id = uniqueId('file');
          const source = sourceDefaults({ id, title: String(file.name), text, kind: extension === 'csv' ? 'datasets' : 'documents', format: extension.toUpperCase(), origin: 'file', isSample: false, sessionOnly: true, pinned: false, size: file.size, originalLocation: { uri: null, label: String(file.name) }, createdAt: new Date().toISOString(), order: -Date.now() - serial }, importProject);
          if (extension === 'pdf' && typeof URL.createObjectURL === 'function') {
            try { blobUrls.set(id, URL.createObjectURL(file)); } catch (_) { /* Metadata is usable even when native preview support is absent. */ }
          }
          files.set(id, file); fileVersions.set(id, source.sourceVersion);
          importSources.push(source);
          newestId = id;
          imported += 1;
        } catch (_) { errors.push(file.name + ': could not read this file. Try saving a new copy.'); }
      }
      if (destroyed) return;
      importBusy = false;
      importButton.disabled = false;
      q('[data-akn-import-label]').textContent = 'Import files';
      fileInput.value = '';
      if (importProject !== projectId) { showNotice('The import finished in project ' + importProject + '. Switch back to see its files.'); return; }
      if (imported) {
        restoreFullList();
        selectedId = newestId;
        renderCollection();
        options.toast?.(imported + (imported === 1 ? ' file added for this session.' : ' files added for this session.'));
      }
      showNotice((imported ? imported + (imported === 1 ? ' file added. ' : ' files added. ') : '') + errors.join(' '), errors.length ? 'warning' : 'success');
    }

    function serviceAvailable(method) {
      return Boolean(service && typeof service[method] === 'function' && (!Array.isArray(service.capabilities) || service.capabilities.includes(method)));
    }
    function checkedHostSource(value, expectedProject = projectId, expectedId = null) {
      if (!value || value.projectId !== expectedProject || typeof value.sourceId !== 'string' || !value.sourceId || value.version == null || typeof value.title !== 'string' || !['documents', 'notes', 'datasets'].includes(value.kind) || value.persistence !== 'host' || typeof value.originalLocation?.uri !== 'string' || !value.originalLocation.uri) throw new Error('The source service did not return a stored original with its project, ID, version, and location.');
      if (expectedId && value.sourceId !== expectedId) throw new Error('The source service returned a different source ID. The local original was preserved.');
      const version = String(value.version);
      const validExtraction = ['not_requested', 'queued', 'extracting', 'ready', 'failed', 'unsupported'].includes(value.extraction?.status) && String(value.extraction.version) === version;
      const validReview = ['unreviewed', 'in_review', 'approved', 'changes_requested'].includes(value.review?.status) && String(value.review.version) === version;
      if (value.extraction?.status === 'ready' && (!validExtraction || typeof value.text !== 'string')) throw new Error('Extraction was reported as ready without text for this source version.');
      return sourceDefaults({ id: value.sourceId, title: value.title, text: typeof value.text === 'string' ? value.text : '', kind: value.kind, format: String(value.format || 'TEXT').toUpperCase(), origin: 'host', isSample: false, sessionOnly: false, pinned: false, size: value.size || null, createdAt: value.createdAt || '', order: -Date.now(), sourceVersion: version, originalLocation: { ...value.originalLocation }, persistence: 'host', paperCoverage:value.coverage, paperDetail:value.detail, originalFile:value.originalFile, originalUri: /^\/api\/artifacts\/[\w-]+\/library-[a-f0-9]{64}$/.test(value.originalUri || '') ? value.originalUri : null, extraction: validExtraction ? { ...value.extraction } : { status: 'not_requested', version }, review: validReview ? { ...value.review } : { status: 'unreviewed', version } }, expectedProject);
    }
    function mergeHostSource(value, expectedId = null, render = true) {
      const next = checkedHostSource(value, projectId, expectedId), existing = sources.find(item => item.id === next.id);
      if (existing && existing.sourceVersion === next.sourceVersion) {
        next.pinned = existing.pinned;
      } else {
        try { next.pinned = window.localStorage.getItem(editionPinKey(next)) === '1'; }
        catch (_) { /* Storage may be unavailable in this window. */ }
      }
      if (!existing) sources.push(next);
      else {
        const versions = existing.versions;
        if (existing.sourceVersion !== next.sourceVersion && !versions.some(version => version.sourceVersion === existing.sourceVersion)) {
          const previous = { ...existing, originalLocation: { ...existing.originalLocation }, extraction: { ...existing.extraction }, review: { ...existing.review } }; delete previous.versions; versions.push(previous);
        }
        Object.assign(existing, next, { origin: existing.origin, order: existing.order, versions });
      }
      if (render) { renderCollection(); refreshStorageNote(); }
      return next;
    }
    async function refreshSources() {
      if (!serviceAvailable('listSources') || destroyed) return false;
      const target = service, bound = serviceEpoch, project = projectId, scope = projectEpoch;
      try {
        const result = await target.listSources({ projectId: project });
        if (destroyed || bound !== serviceEpoch || scope !== projectEpoch || target !== service || project !== projectId) return false;
        if (!Array.isArray(result?.sources)) throw new Error('The source service did not return a project source list.');
        result.sources.forEach(value => checkedHostSource(value, project));
        result.sources.forEach(value => mergeHostSource(value, null, false));
        refreshStorageNote(); renderCollection(); return true;
      } catch (error) {
        if (!destroyed && bound === serviceEpoch && scope === projectEpoch) showNotice(String(error?.message || error), 'warning');
        return false;
      }
    }
    async function sourceOperation(source, method) {
      if (!serviceAvailable(method) || destroyed || sourceOperations.has(source.id)) return;
      const target = service, bound = serviceEpoch, project = projectId, scope = projectEpoch;
      const priorExtraction = { ...source.extraction };
      sourceOperations.add(source.id); renderCollection();
      try {
        let result;
        if (method === 'storeSource') {
          const file = files.get(source.id);
          if (source.origin === 'file' && !file) throw new Error('The original file is no longer available in this session. Import it again before storing it.');
          result = await target.storeSource({ projectId: project, sourceId: source.id, version: source.sourceVersion, title: source.title, kind: source.kind, format: source.format, ...(file ? { file } : { text: source.text || '' }) });
        } else {
          if (source.persistence !== 'host') throw new Error('Store the original before requesting extraction.');
          source.extraction = { status: 'extracting', version: source.sourceVersion }; renderDetail();
          result = await target.extractSource({ projectId: project, sourceId: source.id, version: source.sourceVersion, originalLocation: { ...source.originalLocation } });
          if (String(result?.version) !== source.sourceVersion) throw new Error('Extraction returned a different source version.');
        }
        if (destroyed || bound !== serviceEpoch || scope !== projectEpoch || target !== service || project !== projectId) { if (method === 'extractSource') source.extraction = priorExtraction; return; }
        mergeHostSource(result, source.id);
        showNotice(method === 'storeSource' ? 'The project service confirmed storage of this original.' : result.extraction?.status === 'ready' ? 'Text is available for this source version. Its content still needs review.' : 'Extraction status: ' + String(result.extraction?.status || 'not_requested').replaceAll('_', ' ') + '.', 'success');
      } catch (error) {
        if (method === 'extractSource') source.extraction = { ...priorExtraction, status: 'failed', error: String(error?.message || error) };
        if (!destroyed && bound === serviceEpoch && scope === projectEpoch) showNotice(String(error?.message || error) + ' The original remains available.', 'warning');
      } finally { sourceOperations.delete(source.id); if (!destroyed && scope === projectEpoch) renderCollection(); }
    }
    const storeOriginal = source => sourceOperation(source, 'storeSource');
    const extractText = source => sourceOperation(source, 'extractSource');
    function detachRecords() {
      serviceEpoch++; serviceUnsubscribe?.(); serviceUnsubscribe = null; service = null;
      if (!destroyed) { refreshStorageNote(); renderCollection(); }
    }
    function attachRecords(next) {
      if (!next || typeof next !== 'object') throw new TypeError('A research record service adapter is required.');
      detachRecords(); service = next; const bound = serviceEpoch;
      if (typeof next.subscribe === 'function') {
        const off = next.subscribe(event => {
          if (destroyed || bound !== serviceEpoch || service !== next || event?.type !== 'source.updated' || event.projectId !== projectId) return;
          try { mergeHostSource(event.source); } catch (error) { showNotice(String(error.message || error), 'warning'); }
        });
        serviceUnsubscribe = typeof off === 'function' ? off : null;
      }
      refreshStorageNote(); renderCollection(); void refreshSources();
      return () => { if (service === next && bound === serviceEpoch) detachRecords(); };
    }
    function setProject(value) {
      if (typeof value !== 'string' || !value || value.length > 512) throw new Error('A project ID is required for Knowledge.');
      if (value === projectId || destroyed) return;
      projectBuckets.set(projectId, { sources, selectedId, query, filter, pinnedOnly, noteDraft: { title: noteTitle.value, text: noteBody.value, open: !noteForm.hidden } });
      projectEpoch++; projectId = value;
      const saved = projectBuckets.get(projectId);
      if (saved) { sources = saved.sources; selectedId = saved.selectedId; query = saved.query; filter = saved.filter; pinnedOnly = saved.pinnedOnly; }
      else { sources = initialSources(projectId); selectedId = sources[0]?.id || null; query = ''; filter = 'all'; pinnedOnly = false; initialNotice = ''; loadProjectStorage(); }
      searchInput.value = query; filterSelect.value = filter; noteTitle.value = saved?.noteDraft.title || ''; noteBody.value = saved?.noteDraft.text || ''; noteForm.hidden = !saved?.noteDraft.open;
      q('[data-akn-action="add-note"]').setAttribute('aria-expanded', String(!noteForm.hidden)); clearNoteError();
      showNotice(importBusy ? 'A file import is finishing in its original project.' : initialNotice); refreshStorageNote(); renderCollection(); void refreshSources();
    }

    listen(searchInput, 'input', () => { query = searchInput.value; renderCollection(); });
    listen(filterSelect, 'change', () => { filter = FILTERS.includes(filterSelect.value) ? filterSelect.value : 'all'; renderCollection(); });
    listen(fileInput, 'change', () => { void importFiles(Array.from(fileInput.files || [])); });
    listen(noteForm, 'input', clearNoteError);
    listen(noteForm, 'submit', event => {
      event.preventDefault();
      const title = noteTitle.value.trim();
      const text = noteBody.value.trim();
      const invalid = !title ? noteTitle : !text ? noteBody : null;
      if (invalid) {
        noteError.textContent = !title ? 'Give this note a title.' : 'Write a note before saving.';
        noteError.hidden = false;
        invalid.setAttribute('aria-invalid', 'true');
        invalid.focus();
        return;
      }
      if (title.length > 120 || text.length > MAX_NOTE_LENGTH) {
        noteError.textContent = 'Keep the title within 120 characters and the note within 20,000 characters.';
        noteError.hidden = false;
        return;
      }
      if (sources.filter(source => source.origin === 'note').length >= MAX_NOTES) {
        noteError.textContent = 'This collection can hold 50 notes. Remove one before adding another.';
        noteError.hidden = false;
        return;
      }
      const id = uniqueId('note');
      sources.push(sourceDefaults({ id, title, text, kind: 'notes', format: 'NOTE', origin: 'note', isSample: false, sessionOnly: false, pinned: false, createdAt: new Date().toISOString(), order: -Date.now() - serial }));
      persist();
      restoreFullList();
      selectedId = id;
      setNoteOpen(false);
      renderCollection();
      detail.querySelector('.akn-detail-title')?.focus({ preventScroll: true });
      showNotice(storageMode === 'local' ? 'Note saved on this device.' : 'Note saved for this session. Persistent storage is unavailable.', 'success');
      options.toast?.(storageMode === 'local' ? 'Note added to knowledge.' : 'Note added for this session.');
    });
    listen(root, 'click', event => {
      const sourceButton = event.target.closest('[data-akn-source]');
      if (sourceButton && root.contains(sourceButton)) {
        selectedId = sourceButton.dataset.aknSource;
        renderCollection();
        [...list.querySelectorAll('[data-akn-source]')].find(row => row.dataset.aknSource === selectedId)?.focus({ preventScroll: true });
        return;
      }
      const button = event.target.closest('[data-akn-action]');
      if (!button || !root.contains(button)) return;
      const action = button.dataset.aknAction;
      const source = sources.find(item => item.id === selectedId);
      if (action === 'import') { if (!importBusy) fileInput.click(); }
      if (action === 'add-note') setNoteOpen(true);
      if (action === 'cancel-note') { setNoteOpen(false); q('[data-akn-action="add-note"]').focus({ preventScroll: true }); }
      if (action === 'clear-search') { query = ''; searchInput.value = ''; renderCollection(); searchInput.focus({ preventScroll: true }); }
      if (action === 'pinned-filter') { pinnedOnly = !pinnedOnly; renderCollection(); }
      if (action === 'reset-filters') { restoreFullList(); renderCollection(); searchInput.focus({ preventScroll: true }); }
      if (action === 'pin' && source) {
        source.pinned = !source.pinned;
        let sessionOnly = false;
        if (source.origin !== 'host') {
          // A promoted device note is restored before its host edition arrives.
          persist();
          sessionOnly = storageMode === 'session';
        }
        if (source.persistence === 'host') {
          try {
            const key = editionPinKey(source);
            if (source.pinned) window.localStorage.setItem(key, '1');
            else window.localStorage.removeItem(key);
          } catch (_) { sessionOnly = true; }
        }
        renderCollection();
        (detail.querySelector('[data-akn-action="pin"]') || pinnedFilter).focus({ preventScroll: true });
        if (sessionOnly) showNotice('Pin changes are kept for this session because persistent storage is unavailable.');
      }
      if (action === 'use-source' && source) {
        if (typeof options.onUseSource === 'function') {
          options.onUseSource({ id: source.id, title: source.title, kind: source.kind, excerpt: excerptFor(source), metadata: publicSource(source), artifactId: source.artifactId || null });
        } else showNotice('Open this collection inside the workspace to add an excerpt to chat.');
      }
      if (action === 'store-original' && source && !button.disabled) void storeOriginal(source);
      if (action === 'extract-text' && source && !button.disabled) void extractText(source);
      if (action === 'open-artifact' && source?.artifactId) options.onOpenArtifact?.(source.artifactId);
      if (action === 'remove' && source && !source.isSample) {
        const url = fileVersions.get(source.id) === source.sourceVersion ? blobUrls.get(source.id) : null;
        if (url) { URL.revokeObjectURL(url); blobUrls.delete(source.id); }
        files.delete(source.id); fileVersions.delete(source.id);
        sources = sources.filter(item => item.id !== source.id);
        persist();
        renderCollection();
        searchInput.focus({ preventScroll: true });
        showNotice('“' + source.title + '” was removed from this collection.' + (source.persistence === 'host' ? ' The stored original has not been deleted.' : ''));
        options.toast?.('Source removed.');
      }
    });

    refreshStorageNote();
    renderCollection();
    if (initialNotice) showNotice(initialNotice, 'warning');
    const api = {
      open(settings = {}) {
        if (destroyed) return;
        refreshStorageNote();if(service?.searchAndSave)void refreshSources();
        if (settings && typeof settings === 'object') {
          if (typeof settings.query === 'string') { query = settings.query; searchInput.value = query; }
          if (typeof settings.sourceId === 'string' && sources.some(source => source.id === settings.sourceId)) {
            selectedId = settings.sourceId;
            filter = 'all'; filterSelect.value = 'all'; pinnedOnly = false;
            if (typeof settings.query !== 'string') { query = ''; searchInput.value = ''; }
          }
        }
        renderCollection();
      },
      focus() { if (!destroyed) searchInput.focus({ preventScroll: true }); },
      setProject, attachRecords, detachRecords, refreshSources,
      setRuntimeMode(active) {
        if (runtimeMode === active) return;
        runtimeMode = active;
        sources = [...initialSources(projectId), ...sources.filter(source => !source.isSample)];
        if (runtimeMode) for (const bucket of projectBuckets.values()) bucket.sources = bucket.sources.filter(source => !source.isSample);
        renderCollection();
      },
      getOriginalFile(sourceId, version) { return fileVersions.get(sourceId) === String(version) ? files.get(sourceId) || null : null; },
      getState: () => ({ projectId, recordsConnected: Boolean(service), pendingSourceIds: [...sourceOperations], query, filter, pinnedOnly, selectedId, storageMode, importBusy, noteDraft: { title: noteTitle.value, text: noteBody.value }, sources: sources.map(publicSource) }),
      destroy() {
        if (destroyed) return;
        destroyed = true;
        serviceEpoch++; serviceUnsubscribe?.(); serviceUnsubscribe = null; service = null;
        projectBuckets.clear(); sourceOperations.clear();
        controller.abort();
        blobUrls.forEach(url => { URL.revokeObjectURL(url); });
        blobUrls.clear();
        files.clear(); fileVersions.clear();
        sources = [];
        root.remove();
        instances.delete(host);
      }
    };
    instances.set(host, api);
    if (options.recordsAdapter) attachRecords(options.recordsAdapter);
    return api;
  }

  window.AthenaKnowledge = Object.freeze({ mount });
})();
