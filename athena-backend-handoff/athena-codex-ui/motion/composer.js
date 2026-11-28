/* Athena's native-textarea composer. Design references: DesignBookmark Motion Studies
   (https://designbookmark.com/motion): Prompt Box, Mention Picker and Ghost Suggestion.
   See docs/ui-motion-provenance.md for the source comparison.
   Observed physics (stiffness / damping), preserved below:
   Prompt: height 420/34; status 380/30; send/stop 520/30.
   Mention: soft 260/24; fade 420/32; lead 620/36; trail 190/19;
            chip pop 520/16; position follow 900/50.
   Ghost: key 520/24; opacity 300/30; letter hop 520/16;
          offer stagger .008s; accept stagger .016s; hop velocity -70.
   Integrator: dt capped at 1/30s, four substeps, as in shared/motion.js.
   Gallery autoplay, theme mutation, postMessage and external assets are omitted.
   Motion values below are design references, not a license assertion.
*/
(function () {
  'use strict';
  const SUGGESTION = 'Compare the results with component tolerances.';
  const ITEMS = Object.freeze([
    { id: 'baseline-circuit', label: 'baseline.cir', description: 'Reference the baseline circuit and component values', kind: 'Circuit', group: 'project', icon: 'file-code-2', aliases: 'circuit 회로 기준 파일' },
    { id: 'ac-response', label: 'ac_response.csv', description: 'Reference the frequency response data', kind: 'Result', group: 'project', icon: 'chart-no-axes-combined', aliases: 'ac 응답 결과 csv 파일' },
    { id: 'ngspice', label: 'ngspice', description: 'Simulate circuits and compare component values', kind: 'Plugin', group: 'plugins', icon: 'cpu', aliases: 'spice 회로 시뮬레이션 프로그램 plugin' },
    { id: 'python', label: 'Python', description: 'Process data, run calculations, and plot results', kind: 'Plugin', group: 'plugins', icon: 'code-2', aliases: 'python 파이썬 분석 프로그램 plugin' },
    { id: 'literature-review', label: 'Literature review', description: 'Compare papers and organize supporting evidence', kind: 'Skill', group: 'skills', icon: 'book-open', aliases: '논문 리서치 literature review skill' },
    { id: 'data-analysis', label: 'Data analysis', description: 'Plan analyses and validate results step by step', kind: 'Skill', group: 'skills', icon: 'chart-no-axes-combined', aliases: '통계 분석 검증 data analysis skill' },
    { id: 'manuscript', label: 'Draft writing', description: 'Draft research notes with linked evidence', kind: 'Skill', group: 'skills', icon: 'file-pen-line', aliases: '문서 원고 논문 writing manuscript skill' }
  ]);
  const UPLOAD = Object.freeze({ id: 'upload', label: 'Add photos and files', description: 'Choose images and documents from your computer', kind: 'File', group: 'upload', icon: 'paperclip', action: 'upload' });
  const GROUPS = Object.freeze([{ id: 'upload', label: '' }, { id: 'project', label: 'Project files' }, { id: 'plugins', label: 'Plugins' }, { id: 'skills', label: 'Skills' }, { id: 'prompts', label: 'Prompt templates' }, { id: 'commands', label: 'Commands' }]);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const newSpring = (value, stiffness, damping) => ({ x: value, v: 0, t: value, k: stiffness, c: damping });
  const stepSpring = (spring, dt) => {
    spring.v += (-spring.k * (spring.x - spring.t) - spring.c * spring.v) * dt;
    spring.x += spring.v * dt;
  };
  const settled = spring => Math.abs(spring.x - spring.t) < .001 && Math.abs(spring.v) < .001;
  const makeIcon = name => {
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', name);
    icon.setAttribute('aria-hidden', 'true');
    return icon;
  };
  const refreshIcons = root => {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons({ root, attrs: { 'aria-hidden': 'true' } });
    }
  };

  function mount(slot, options) {
    if (!slot || slot.nodeType !== 1) throw new TypeError('AthenaComposer.mount requires a DOM element.');
    if (slot.__athenaComposer) slot.__athenaComposer.destroy();
    const callbacks = options || {};
    const hosted = () => window.AthenaHosted === true || callbacks.hosted === true;
    const frame = document.createElement('section');
    frame.className = 'acm-composer';
    frame.setAttribute('aria-label', 'Research message composer');
    frame.innerHTML = `
      <div class="acm-box">
        <div class="acm-status" role="status" aria-live="polite"><span class="acm-status-mark" aria-hidden="true"></span><span class="acm-status-label"></span></div>
        <div class="acm-input-row">
          <div class="acm-editor">
            <div class="acm-ghost-viewport" aria-hidden="true"><div class="acm-ghost-layer"><span class="acm-ghost-prefix"></span><span class="acm-ghost-text"></span><kbd class="acm-ghost-tab">Tab</kbd></div></div>
            <textarea id="ac-prompt-input" class="acm-input" rows="2" aria-label="Research question or task" aria-describedby="ac-composer-help ac-composer-suggestion" aria-controls="ac-mention-listbox" aria-autocomplete="both" aria-haspopup="dialog" aria-expanded="false" placeholder="Ask a question or describe your research" spellcheck="false"></textarea>
          </div>
          <button type="button" class="acm-send cursor-interaction" aria-label="Send message" data-morph-tooltip="Send message (Enter)" disabled><span class="acm-send-arrow" aria-hidden="true"><i data-lucide="arrow-up"></i></span><span class="acm-send-stop" aria-hidden="true"></span></button>
        </div>
        <div class="acm-contexts" aria-label="Selected files, plugins, and skills"></div>
        <div class="acm-tools"><div class="acm-tools-left"><button type="button" class="acm-add-trigger acm-mention-trigger cursor-interaction" aria-label="Add photos, files, plugins, and skills" aria-haspopup="dialog" aria-expanded="false" aria-controls="ac-mention-listbox"><i data-lucide="plus" aria-hidden="true"></i></button><div id="ac-command-slot"></div></div><div id="ac-model-picker-slot"></div><span class="acm-hint" aria-hidden="true">Enter to send · Shift+Enter for a new line</span></div>
      </div>
      <input class="acm-file-input" type="file" multiple hidden aria-label="Choose photos and files">
      <div class="acm-picker" id="ac-mention-listbox" role="dialog" aria-label="Add photos, files, plugins, and skills" aria-hidden="true">
        <div class="acm-picker-search"><i data-lucide="search" aria-hidden="true"></i><input type="search" placeholder="Search files, plugins, and skills" aria-label="Search files, plugins, and skills" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">Esc</kbd></div>
        <div class="acm-picker-scroll"><div class="acm-picker-content" role="menu" aria-label="Items to add"><span class="acm-picker-highlight" aria-hidden="true"></span></div><p class="acm-picker-empty" hidden>No matches.<br>Try another search.</p></div>
        <div class="acm-picker-footer" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> Move</span><span><kbd>↵</kbd> Select</span><span><kbd>esc</kbd> Close</span></div>
      </div>
      <span id="ac-composer-help" class="acm-sr-only">Press Enter to send or Shift+Enter for a new line. Use the add button to choose files, plugins, and skills, or type @ to find a project item.</span>
      <span id="ac-composer-suggestion" class="acm-sr-only"></span>
      <span class="acm-live acm-sr-only" role="status" aria-live="polite"></span>`;
    slot.appendChild(frame);
    const q = selector => frame.querySelector(selector);
    const input = q('.acm-input'), send = q('.acm-send'), arrow = q('.acm-send-arrow'), stop = q('.acm-send-stop');
    const status = q('.acm-status'), statusLabel = q('.acm-status-label'), contexts = q('.acm-contexts');
    const ghostLayer = q('.acm-ghost-layer'), ghostPrefix = q('.acm-ghost-prefix'), ghostText = q('.acm-ghost-text'), tabKey = q('.acm-ghost-tab');
    const suggestionHelp = q('#ac-composer-suggestion'), live = q('.acm-live');
    const picker = q('.acm-picker'), highlight = q('.acm-picker-highlight');
    const trigger = q('.acm-add-trigger'), fileInput = q('.acm-file-input');
    const menuSearch = q('.acm-picker-search input'), searchBar = q('.acm-picker-search');
    const menuScroll = q('.acm-picker-scroll'), menuContent = q('.acm-picker-content'), menuEmpty = q('.acm-picker-empty'), menuFooter = q('.acm-picker-footer');
    // A sibling portal escapes the independently scrolling conversation and dock.
    // Coordinates are clamped to both this app's bounds and the visible viewport.
    const portal = slot.closest('#athena-codex') || slot;
    portal.appendChild(picker);
    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const prefersReduced = () => reduceQuery.matches || portal.dataset.reducedMotion === 'true';
    const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '');
    let reduce = prefersReduced(), destroyed = false, busy = false, composing = false, stopRequested = false, canStop = true;
    let sendKey = typeof callbacks.getSendKey === 'function' && callbacks.getSendKey() === 'mod-enter' ? 'mod-enter' : 'enter';
    let compositionEndedAt = -Infinity, activeIndex = 0, query = null, queryDismissed = null, pickerOpen = false, list = [];
    let menuMode = 'mention', menuMaxHeight = 520, activeRowHeight = 60, attachments = [], attachmentSequence = 0;
    let searchComposing = false, searchCompositionEndedAt = -Infinity;
    let runtimeConnected = false, runtimeSignature = '', runtimeSequence = 0;
    const runtimeRows = new Map();
    let latestCommands = [], projectSkills = [];
    const selectedItems = new Set();
    let letters = [], chips = [], ghostOffered = false, ghostAccepting = false, ghostSuffix = null;
    let raf = 0, lastTime = 0, timers = [], statusTimer = null, measureQueued = false, ticking = false;
    const listeners = [];
    const listen = (target, event, handler, config) => {
      target.addEventListener(event, handler, config);
      listeners.push(() => target.removeEventListener(event, handler, config));
    };
    const readSpring = (name, fallback) => {
      const values = getComputedStyle(frame).getPropertyValue(name).trim().split(/\s+/).map(Number);
      return values.length === 2 && values.every(Number.isFinite) ? values : fallback;
    };
    const presets = {
      soft: readSpring('--acm-spring-soft', [260, 24]), fade: readSpring('--acm-spring-fade', [420, 32]),
      lead: readSpring('--acm-spring-lead', [620, 36]), trail: readSpring('--acm-spring-trail', [190, 19]),
      pop: readSpring('--acm-spring-pop', [520, 16])
    };
    const height = newSpring(47.6, 420, 34), statusHeight = newSpring(0, 380, 30), sendMorph = newSpring(0, 520, 30);
    const menuHeight = newSpring(0, ...presets.soft), menuOpacity = newSpring(0, ...presets.fade);
    const lead = newSpring(4, ...presets.lead), trail = newSpring(4, ...presets.trail);
    const menuX = newSpring(0, 900, 50), menuY = newSpring(0, 900, 50);
    const tabSpring = newSpring(0, 520, 24), ghostFade = newSpring(1, 300, 30);
    const rowHeight = 60;
    const baseSprings = [height, statusHeight, sendMorph, menuHeight, menuOpacity, lead, trail, menuX, menuY, tabSpring, ghostFade];
    const groupElements = new Map(GROUPS.map(group => {
      const section = document.createElement('div'); section.className = 'acm-picker-group'; section.setAttribute('role', 'group');
      if (group.label) { section.setAttribute('aria-label', group.label); const heading = document.createElement('div'); heading.className = 'acm-picker-heading'; heading.textContent = group.label; section.appendChild(heading); }
      menuContent.appendChild(section); return [group.id, section];
    }));
    function createRow(item) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'acm-picker-row cursor-interaction';
      button.id = 'ac-mention-option-' + item.id;
      button.disabled = true;
      button.tabIndex = -1;
      button.setAttribute('role', item.action ? 'menuitem' : 'menuitemcheckbox');
      if (!item.action) button.setAttribute('aria-checked', 'false');
      const glyph = makeIcon(item.icon); button.appendChild(glyph);
      const copy = document.createElement('span'); copy.className = 'acm-picker-copy';
      const name = document.createElement('span'); name.className = 'acm-picker-name'; name.textContent = item.label;
      const description = document.createElement('span'); description.className = 'acm-picker-description'; description.textContent = item.description;
      copy.append(name, description); button.appendChild(copy);
      const check = document.createElement('span'); check.className = 'acm-picker-check'; check.setAttribute('aria-hidden', 'true'); check.appendChild(makeIcon(item.action === 'command' ? 'corner-down-left' : item.action ? 'arrow-up-from-line' : 'check')); button.appendChild(check);
      groupElements.get(item.group).appendChild(button);
      const removers = [];
      const row = { item, button, name, description, glyph, available: true, Y: newSpring(0, ...presets.soft), O: newSpring(0, ...presets.fade), on: false, destroy() { removers.forEach(remove => remove()); button.remove(); } };
      const rowListen = (event, handler) => { button.addEventListener(event, handler); removers.push(() => button.removeEventListener(event, handler)); };
      rowListen('pointerdown', event => { if (menuMode === 'mention') event.preventDefault(); });
      rowListen('pointerenter', () => { const indexInList = list.indexOf(row); if (indexInList >= 0 && pickerOpen) activate(indexInList); });
      rowListen('focus', () => { const indexInList = list.indexOf(row); if (indexInList >= 0 && pickerOpen) activate(indexInList); });
      rowListen('click', () => { const indexInList = list.indexOf(row); if (indexInList >= 0) { activeIndex = indexInList; pickMention(); } });
      if (item.action === 'command') { button.classList.add('acm-runtime-command'); button.dataset.runtimeCommand = item.command; }
      return row;
    }
    const rows = [UPLOAD, ...ITEMS].map(createRow);
    const baseRows = rows.slice();
    function allSprings() { return baseSprings.concat(rows.flatMap(row => [row.Y, row.O]), letters.flatMap(letter => [letter.o, letter.y]), chips.map(chip => chip.K)); }
    function wake() {
      if (destroyed || raf || ticking) return;
      lastTime = performance.now();
      raf = requestAnimationFrame(tick);
    }
    function later(delay, callback, group) {
      if (destroyed) return null;
      if (reduce) { callback(); return null; }
      const timer = { remaining: delay, callback, group };
      timers.push(timer); wake(); return timer;
    }
    function cancelTimer(timer) { timers = timers.filter(item => item !== timer); }
    function cancelGroup(group) { timers = timers.filter(item => item.group !== group); }
    function tick(now) {
      raf = 0;
      if (destroyed) return;
      ticking = true;
      const dt = Math.min((now - lastTime) / 1000, 1 / 30); lastTime = now;
      const due = [];
      timers = timers.filter(timer => { timer.remaining -= dt; if (reduce || timer.remaining <= 0) { due.push(timer); return false; } return true; });
      due.forEach(timer => { if (!destroyed) timer.callback(); });
      const springs = allSprings();
      if (reduce) springs.forEach(spring => { spring.x = spring.t; spring.v = 0; });
      else for (let substep = 0; substep < 4; substep++) springs.forEach(spring => stepSpring(spring, dt / 4));
      springs.forEach(spring => { if (settled(spring)) { spring.x = spring.t; spring.v = 0; } });
      render();
      ticking = false;
      if (timers.length || springs.some(spring => !settled(spring))) raf = requestAnimationFrame(tick);
    }
    function render() {
      input.style.height = Math.max(23.8, height.x).toFixed(2) + 'px';
      const statusProgress = statusHeight.x;
      status.style.height = `${(30 * Math.max(statusProgress, 0)).toFixed(2)}px`;
      status.style.opacity = clamp(statusProgress, 0, 1).toFixed(3);
      const turn = clamp(sendMorph.x, 0, 1.2);
      arrow.style.scale = String(Math.max(1 - turn, 0));
      arrow.style.rotate = `${90 * turn}deg`;
      stop.style.scale = String(turn);
      const opacity = clamp(menuOpacity.x, 0, 1);
      picker.style.height = clamp(menuHeight.x, 0, menuMaxHeight).toFixed(1) + 'px';
      picker.style.opacity = opacity.toFixed(3);
      picker.style.visibility = opacity < .001 && !pickerOpen ? 'hidden' : 'visible';
      picker.style.transform = `translate(${menuX.x.toFixed(1)}px,${(menuY.x + (1 - opacity) * 5).toFixed(1)}px)`;
      const top = Math.min(lead.x, trail.x);
      highlight.style.transform = `translateY(${top.toFixed(1)}px)`;
      highlight.style.height = (Math.abs(lead.x - trail.x) + activeRowHeight).toFixed(1) + 'px';
      highlight.style.opacity = list.length ? '1' : '0';
      rows.forEach(row => {
        const value = clamp(row.O.x, 0, 1);
        row.button.style.opacity = value.toFixed(3);
        row.button.style.transform = `translateY(${row.Y.x.toFixed(1)}px)`;
        row.button.style.visibility = row.on && pickerOpen || value >= .01 ? 'visible' : 'hidden';
        row.button.style.pointerEvents = row.on && pickerOpen ? '' : 'none';
      });
      chips.forEach(chip => { chip.el.style.transform = `scale(${chip.K.x.toFixed(3)})`; });
      ghostLayer.style.opacity = clamp(ghostFade.x, 0, 1).toFixed(3);
      ghostLayer.style.transform = `translateY(${-input.scrollTop}px)`;
      const key = clamp(tabSpring.x, -.2, 1.2);
      tabKey.style.opacity = clamp(key, 0, 1).toFixed(3);
      tabKey.style.transform = `scale(${(.6 + .4 * clamp(key, 0, 1.2)).toFixed(4)})`;
      letters.forEach(letter => {
        letter.el.style.opacity = clamp(letter.o.x, 0, 1).toFixed(3);
        letter.el.style.transform = `translateY(${letter.y.x.toFixed(2)}px)`;
      });
    }
    function fit() {
      if (destroyed) return;
      const previous = input.style.height;
      input.style.height = 'auto';
      const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 23.8;
      input.style.minHeight = lineHeight + 'px';
      input.style.maxHeight = (lineHeight * 6) + 'px';
      const content = Math.max(input.scrollHeight, (ghostOffered || ghostAccepting) ? ghostLayer.scrollHeight : 0);
      height.t = clamp(content, lineHeight * 2, lineHeight * 6);
      input.style.height = previous || height.x + 'px';
      input.style.overflowY = content > lineHeight * 6 ? 'auto' : 'hidden';
      send.classList.toggle('is-ready', busy || !!input.value.trim() || attachments.length > 0);
      send.disabled = busy ? stopRequested || !canStop : !input.value.trim() && !attachments.length;
      wake();
    }
    function caretRect() {
      const mirror = document.createElement('div'); mirror.className = 'acm-caret-mirror';
      mirror.style.width = input.clientWidth + 'px';
      mirror.textContent = input.value.slice(0, input.selectionStart);
      const marker = document.createElement('span'); marker.textContent = '\u200b'; mirror.appendChild(marker);
      q('.acm-editor').appendChild(mirror);
      const result = marker.getBoundingClientRect();
      const value = { left: result.left, top: result.top - input.scrollTop, bottom: result.bottom - input.scrollTop };
      mirror.remove(); return value;
    }
    function placePicker(fresh) {
      if (!pickerOpen) return;
      const rootBounds = portal.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportLeft = viewport ? viewport.offsetLeft : 0, viewportTop = viewport ? viewport.offsetTop : 0;
      const viewportWidth = viewport ? viewport.width : window.innerWidth || document.documentElement.clientWidth || rootBounds.width;
      const viewportHeight = viewport ? viewport.height : window.innerHeight || document.documentElement.clientHeight || rootBounds.height;
      const leftEdge = Math.max(rootBounds.left + 10, viewportLeft + 10);
      const rightEdge = Math.min(rootBounds.right - 10, viewportLeft + viewportWidth - 10);
      const topEdge = Math.max(rootBounds.top + 10, viewportTop + 10);
      const bottomEdge = Math.min(rootBounds.bottom - 10, viewportTop + viewportHeight - 10);
      const anchor = menuMode === 'mention' && query ? caretRect() : trigger.getBoundingClientRect();
      const width = Math.max(1, Math.min(384, rightEdge - leftEdge));
      picker.style.width = width + 'px';
      const sectionCount = GROUPS.filter(group => !groupElements.get(group.id).hidden && group.label).length;
      const fallbackContent = list.length * rowHeight + sectionCount * 28 + 12;
      const contentHeight = (menuContent.scrollHeight || fallbackContent) + (menuEmpty.hidden ? 0 : menuEmpty.offsetHeight || 100);
      const fullHeight = Math.min(520, (searchBar.hidden ? 0 : searchBar.offsetHeight || 52) + contentHeight + (menuFooter.offsetHeight || 34) + 2);
      const aboveSpace = Math.max(0, Math.min(anchor.top - 10, bottomEdge) - topEdge);
      const belowSpace = Math.max(0, bottomEdge - Math.max(anchor.bottom + 10, topEdge));
      const above = aboveSpace >= Math.min(fullHeight, 260) || aboveSpace >= belowSpace;
      menuMaxHeight = Math.max(1, Math.min(520, above ? aboveSpace : belowSpace));
      const actualHeight = Math.min(fullHeight, menuMaxHeight);
      const left = clamp(anchor.left - (menuMode === 'mention' ? 8 : 0), leftEdge, Math.max(leftEdge, rightEdge - width));
      const top = above ? Math.min(anchor.top - 10, bottomEdge) - actualHeight : Math.max(anchor.bottom + 10, topEdge);
      menuX.t = left - rootBounds.left + (portal.scrollLeft || 0);
      menuY.t = clamp(top, topEdge, Math.max(topEdge, bottomEdge - actualHeight)) - rootBounds.top + (portal.scrollTop || 0);
      menuHeight.t = actualHeight;
      picker.dataset.placement = above ? 'above' : 'below';
      if (fresh || menuOpacity.x < .05) { menuX.x = menuX.t; menuY.x = menuY.t; }
      wake();
    }
    function setPickerOpen(open) {
      const fresh = open && !pickerOpen;
      pickerOpen = open;
      picker.classList.toggle('is-open', open);
      picker.setAttribute('aria-hidden', String(!open));
      picker.inert = !open;
      trigger.setAttribute('aria-expanded', String(open && menuMode === 'add'));
      input.setAttribute('aria-expanded', String(open && menuMode === 'mention'));
      menuSearch.disabled = !open;
      rows.forEach(row => { row.button.disabled = !open || !row.on; if (open && row.on) row.button.style.visibility = 'visible'; });
      menuOpacity.t = open ? 1 : 0;
      if (!open) menuHeight.t = 0;
      if (fresh) {
        picker.style.visibility = 'visible';
        menuScroll.scrollTop = 0;
        menuOpacity.x = 0;
        rows.forEach(row => { if (row.on) { row.Y.x = -6; row.O.x = 0; } });
        const active = list[activeIndex];
        lead.x = trail.x = active ? active.button.offsetTop : 0;
      }
      if (!open) input.removeAttribute('aria-activedescendant');
      else placePicker(fresh);
      wake();
    }
    function activate(index, ensureVisible = false) {
      activeIndex = clamp(index, 0, Math.max(0, list.length - 1));
      const active = list[activeIndex];
      const top = active ? active.button.offsetTop : 0;
      activeRowHeight = active ? active.button.offsetHeight || rowHeight : rowHeight;
      lead.t = trail.t = top;
      rows.forEach(row => { const isActive = row === active && row.on; row.button.classList.toggle('is-active', isActive); row.button.tabIndex = pickerOpen && isActive ? 0 : -1; });
      if (pickerOpen && active && menuMode === 'mention') input.setAttribute('aria-activedescendant', active.button.id);
      if (ensureVisible && active) {
        if (top < menuScroll.scrollTop) menuScroll.scrollTop = top;
        else if (top + activeRowHeight > menuScroll.scrollTop + menuScroll.clientHeight) menuScroll.scrollTop = Math.max(0, top + activeRowHeight - menuScroll.clientHeight);
      }
      wake();
    }
    function readQuery() {
      if (composing || input.selectionStart !== input.selectionEnd) return null;
      const before = input.value.slice(0, input.selectionStart);
      const match = /(?:^|[\s(])([@$])([^\s@$]{0,129})$/u.exec(before);
      if (match?.[1] === '$' && /^\d/u.test(match[2])) return null;
      return match ? { start: before.lastIndexOf(match[1]), end: input.selectionStart, trigger: match[1], text: match[2] } : null;
    }
    function filterPicker() {
      query = readQuery();
      if (!query || queryDismissed === `${query.start}:${query.text}`) { rows.forEach(row => { row.O.t = 0; row.on = false; }); setPickerOpen(false); return; }
      menuMode = 'mention';
      searchBar.hidden = true;
      filterRows(query.text);
      setPickerOpen(list.length > 0); activate(activeIndex);
      if (!list.length) live.textContent = query.trigger === '$' ? 'No matching skills.' : runtimeConnected ? 'No matching files or Pi commands.' : 'No matching files, plugins, or skills.';
    }
    function filterRows(value) {
      const search = String(value || '').trim().toLocaleLowerCase();
      const skillsOnly = menuMode === 'mention' && query?.trigger === '$';
      list = rows.filter(({ available, item }) => {
        if (!available || (skillsOnly && (item.group !== 'skills' || item.action !== 'command'))) return false;
        if (item.action === 'upload') return menuMode === 'add';
        return !search || [item.label, item.description, item.kind, item.aliases].join(' ').toLocaleLowerCase().includes(search);
      });
      rows.forEach(row => {
        const index = list.indexOf(row); row.on = index >= 0; row.O.t = row.on ? 1 : 0;
        row.button.hidden = !row.on;
        row.button.setAttribute('aria-hidden', String(!row.on));
        row.Y.t = 0;
      });
      GROUPS.forEach(group => { groupElements.get(group.id).hidden = !list.some(row => row.item.group === group.id); });
      menuEmpty.hidden = list.some(row => row.item.action !== 'upload');
      activeIndex = menuMode === 'add' && search ? Math.max(0, list.findIndex(row => row.item.action !== 'upload')) : clamp(activeIndex, 0, Math.max(0, list.length - 1));
      syncRowChecks();
      if (pickerOpen) { setPickerOpen(true); activate(activeIndex); }
    }
    function openAddMenu() {
      if (pickerOpen && menuMode === 'add') { closePicker(true); return; }
      endGhostAcceptance(); resetGhost(); query = null; menuMode = 'add';
      activeIndex = 0; menuSearch.value = ''; searchBar.hidden = false;
      filterRows(''); setPickerOpen(true); activate(0);
      menuSearch.focus({ preventScroll: true });
    }
    function closePicker(restoreFocus) {
      if (query) queryDismissed = `${query.start}:${query.text}`;
      const target = menuMode === 'add' ? trigger : input;
      setPickerOpen(false);
      if (restoreFocus) target.focus({ preventScroll: true });
    }
    function syncRowChecks() {
      rows.forEach(row => {
        if (row.item.action) return;
        const checked = selectedItems.has(row.item.id) || hasMention(row.item);
        row.button.setAttribute('aria-checked', String(checked));
        row.button.classList.toggle('is-selected', checked);
      });
    }
    function hasMention(item) {
      const marker = '@' + item.label;
      let cursor = input.value.indexOf(marker);
      while (cursor >= 0) {
        const before = input.value[cursor - 1], after = input.value[cursor + marker.length];
        if ((!before || /[\s(]/u.test(before)) && (!after || /[\s),.!?]/u.test(after))) return true;
        cursor = input.value.indexOf(marker, cursor + marker.length);
      }
      return false;
    }
    function syncChips(popId) {
      const wanted = [...ITEMS.filter(item => selectedItems.has(item.id) || hasMention(item)), ...attachments];
      chips.filter(chip => !wanted.some(item => item.id === chip.item.id)).forEach(chip => chip.el.remove());
      chips = chips.filter(chip => wanted.some(item => item.id === chip.item.id));
      wanted.forEach(item => {
        if (chips.some(chip => chip.item.id === item.id)) return;
        const chip = document.createElement('span'); chip.className = 'acm-context-chip' + (item.file ? ' acm-attachment-chip' : '');
        chip.appendChild(makeIcon(item.icon));
        const copy = document.createElement('span'); copy.className = 'acm-chip-copy';
        const label = document.createElement('span'); label.className = 'acm-chip-name'; label.textContent = item.label; label.title = item.label; copy.appendChild(label);
        if (item.file) { const size = document.createElement('small'); size.textContent = formatBytes(item.file.size); copy.appendChild(size); }
        chip.appendChild(copy);
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'acm-remove-context cursor-interaction';
        remove.setAttribute('aria-label', (item.file ? 'Remove attachment ' : 'Remove ') + item.label); remove.appendChild(makeIcon('x'));
        // The chip owns this listener; removing the chip also removes its only reference.
        remove.addEventListener('click', () => {
          if (item.file) attachments = attachments.filter(attachment => attachment.id !== item.id);
          else { selectedItems.delete(item.id); input.value = input.value.split('@' + item.label).join('').replace(/ {2,}/g, ' '); }
          queryDismissed = null; changed(); input.focus();
          live.textContent = item.label + ' removed.';
          if (item.file && typeof callbacks.onAttachmentsChange === 'function') callbacks.onAttachmentsChange(getAttachments());
        });
        chip.appendChild(remove); contexts.appendChild(chip);
        const K = newSpring(popId === item.id && !reduce ? .6 : 1, ...presets.pop); K.t = 1;
        chips.push({ item, el: chip, K });
      });
      chips.forEach(chip => {
        let caption = chip.el.querySelector('.acm-chip-context-note');
        if (runtimeConnected && !chip.item.file) {
          if (!caption) { caption = document.createElement('small'); caption.className = 'acm-chip-context-note'; chip.el.querySelector('.acm-chip-copy').appendChild(caption); }
          caption.textContent = 'Sample context';
        } else caption?.remove();
      });
      syncRowChecks(); refreshIcons(contexts); wake();
    }
    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' MB';
      return (bytes / (1024 * 1024 * 1024)).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' GB';
    }
    function addFiles(files) {
      let added = 0;
      for (const file of Array.from(files || [])) {
        if (!file || typeof file.name !== 'string') continue;
        if (attachments.some(item => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified && item.file.type === file.type)) continue;
        attachments.push({ id: 'attachment-' + (++attachmentSequence), label: file.name, kind: 'File', icon: String(file.type || '').startsWith('image/') ? 'image' : 'file', file });
        added++;
      }
      syncChips(); refreshGhost(); fit();
      live.textContent = added ? added + (added === 1 ? ' file selected.' : ' files selected.') + ' Not uploaded yet.' : 'The selected files are already attached.';
      if (added && typeof callbacks.onAttachmentsChange === 'function') callbacks.onAttachmentsChange(getAttachments());
      input.focus({ preventScroll: true });
    }
    function getAttachments() { return attachments.map(item => item.file); }
    function clearContext() {
      selectedItems.clear(); attachments = []; syncChips(); refreshGhost(); fit();
      if (typeof callbacks.onAttachmentsChange === 'function') callbacks.onAttachmentsChange([]);
    }
    function pickMention() {
      const selected = list[activeIndex]; if (!pickerOpen || !selected) return;
      if (selected.item.action === 'upload') { setPickerOpen(false); fileInput.click(); return; }
      if (selected.item.skillId) {
        const current = menuMode === 'mention' ? readQuery() : null;
        if (menuMode === 'mention' && (!current || current.start !== query?.start || current.text !== query.text || current.trigger !== query.trigger)) { filterPicker(); return; }
        const start = current?.start ?? input.selectionStart;
        const end = current ? current.end + (input.value.slice(current.end).match(/^[a-z0-9/-]+/u)?.[0].length || 0) : input.selectionEnd;
        const space = start && !/[\s(]/u.test(input.value[start-1]) ? ' ' : '';
        input.setRangeText(space + '$' + selected.item.skillId + ' ', start, end, 'end');
        query = null; queryDismissed = null; setPickerOpen(false); changed(); input.focus();
        live.textContent = selected.item.label + ' added to your draft.'; return;
      }
      if (selected.item.action === 'command') { pickRuntimeCommand(selected.item); return; }
      if (menuMode === 'add') {
        if (selectedItems.has(selected.item.id) || hasMention(selected.item)) {
          selectedItems.delete(selected.item.id);
          input.value = input.value.split('@' + selected.item.label).join('').replace(/ {2,}/g, ' ');
          live.textContent = selected.item.label + ' removed.';
        } else {
          selectedItems.add(selected.item.id); live.textContent = selected.item.label + ' selected.';
          if (typeof callbacks.onMention === 'function') callbacks.onMention({ ...selected.item });
          frame.dispatchEvent(new CustomEvent('ac:mention', { bubbles: true, detail: { ...selected.item } }));
        }
        setPickerOpen(false); syncChips(selected.item.id); fit(); refreshGhost(); input.focus({ preventScroll: true }); return;
      }
      const currentQuery = readQuery();
      if (!pickerOpen || !currentQuery || !query || currentQuery.start !== query.start || currentQuery.end !== query.end || currentQuery.text !== query.text) { filterPicker(); return; }
      if (!query) return;
      endGhostAcceptance();
      const insertion = '@' + selected.item.label + ' ';
      input.setRangeText(insertion, query.start, query.end, 'end');
      query = null; queryDismissed = null; setPickerOpen(false); syncChips(selected.item.id); refreshGhost(); fit();
      input.focus(); live.textContent = selected.item.label + ' added.';
      if (typeof callbacks.onMention === 'function') callbacks.onMention({ ...selected.item });
      frame.dispatchEvent(new CustomEvent('ac:mention', { bubbles: true, detail: { ...selected.item } }));
    }
    function pickRuntimeCommand(item) {
      let draft = input.value;
      if (menuMode === 'mention') {
        const currentQuery = readQuery();
        if (!currentQuery || !query || currentQuery.start !== query.start || currentQuery.end !== query.end || currentQuery.text !== query.text) { filterPicker(); return; }
        draft = draft.slice(0, query.start) + draft.slice(query.end);
      }
      endGhostAcceptance(); resetGhost();
      // A Pi command must begin the prompt. Preserve the user's instructions
      // when replacing a previously chosen command or removing an @ query.
      const leading = /^\/([^\s]+)(?:\s+|$)/u.exec(draft);
      if (leading && runtimeRows.has(leading[1])) draft = draft.slice(leading[0].length);
      input.value = '/' + item.command + ' ' + draft.replace(/^\s+/u, '');
      input.setSelectionRange(input.value.length, input.value.length);
      query = null; queryDismissed = null;
      setPickerOpen(false); syncChips(); refreshGhost(); fit();
      input.focus({ preventScroll: true });
      live.textContent = '/' + item.command + ' added to your draft. Add instructions, then press ' + sendShortcut() + ' to send.';
      frame.dispatchEvent(new CustomEvent('ac:command-selected', { bubbles: true, detail: { name: item.command, source: item.source } }));
    }
    function getSelections() {
      if (hosted()) return [];
      return ITEMS.filter(item => selectedItems.has(item.id) || hasMention(item)).map(item => runtimeConnected ? { ...item, kind: 'Sample context', source: 'preview' } : { ...item });
    }
    function setRuntimeCommands(commands, config = {}) {
      if (destroyed) return;
      latestCommands = commands;
      const connected = config.connected === true;
      const normalized = [], seen = new Set();
      if (connected) for (const entry of Array.isArray(commands) ? commands : []) {
        if (!entry || typeof entry !== 'object') continue;
        const name = String(entry.name || '').replace(/^\//u, '');
        // One command token only: no control characters, argument injection,
        // or generated slash prefixes for names already returned by Pi.
        if (!name || name.startsWith('/') || name.length > 160 || /[\s\u0000-\u001f\u007f]/u.test(name) || seen.has(name)) continue;
        seen.add(name);
        const source = ['extension', 'prompt', 'skill'].includes(entry.source) ? entry.source : 'command';
        normalized.push({ name, source, description: String(entry.description || '').slice(0, 1200) });
        if (normalized.length >= 200) break;
      }
      if (connected) for (const skill of projectSkills) {
        const name = '$' + skill.id;
        if (!seen.has(name)) normalized.push({ name, skillId: skill.id, title: skill.name, source: 'skill', description: skill.description });
      }
      const signature = JSON.stringify([connected, hosted(), normalized]);
      if (signature === runtimeSignature) return;
      runtimeSignature = signature; runtimeConnected = connected;
      const oldActive = list[activeIndex]?.item.id;
      const focused = document.activeElement;
      const focusedRow = rows.find(row => row.button === focused);
      const wasOpen = pickerOpen, scrollTop = menuScroll.scrollTop;
      const nextNames = new Set(normalized.map(entry => entry.name));
      for (const [name, row] of runtimeRows) if (!nextNames.has(name)) { row.destroy(); runtimeRows.delete(name); }
      for (const entry of normalized) {
        const group = ({ extension: 'plugins', skill: 'skills', prompt: 'prompts', command: 'commands' })[entry.source];
        const glyph = ({ extension: 'plug', skill: 'book-open', prompt: 'file-text', command: 'slash' })[entry.source];
        const kind = ({ extension: 'Extension', skill: 'Skill', prompt: 'Prompt template', command: 'Command' })[entry.source];
        let row = runtimeRows.get(entry.name);
        const item = { id: row?.item.id || 'runtime-command-' + (++runtimeSequence), label: entry.skillId ? entry.name : '/' + entry.name, skillId: entry.skillId, command: entry.name, source: entry.source, description: entry.skillId ? [entry.title, entry.description].filter(Boolean).join(' · ') : entry.description || 'Add this ' + kind.toLowerCase() + ' to your next message', kind, group, icon: glyph, action: 'command', aliases: entry.name + ' ' + kind };
        if (!row) { row = createRow(item); runtimeRows.set(entry.name, row); }
        else {
          const previousIcon = row.item.icon;
          row.item = item; row.name.textContent = item.label; row.description.textContent = item.description;
          if (previousIcon !== glyph) { const previous = row.button.firstElementChild; row.glyph = makeIcon(glyph); previous.replaceWith(row.glyph); }
        }
      }
      baseRows.forEach(row => { row.available = row.item.action === 'upload' || (!hosted() && (!connected || row.item.group === 'project')); });
      const nextRows = GROUPS.flatMap(group => [...baseRows.filter(row => row.item.group === group.id), ...normalized.map(entry => runtimeRows.get(entry.name)).filter(row => row.item.group === group.id)]);
      rows.splice(0, rows.length, ...nextRows);
      for (const group of GROUPS) {
        const section = groupElements.get(group.id);
        const heading = section.querySelector('.acm-picker-heading');
        if (heading) { heading.textContent = connected && group.id === 'plugins' ? 'Extensions' : connected && group.id === 'project' ? 'Sample project context' : group.label; section.setAttribute('aria-label', heading.textContent); }
        // Move only nodes whose actual sibling order changed. Ordinary runtime
        // snapshots leave the focused menu item attached in the same place.
        const ordered = rows.filter(row => row.item.group === group.id);
        let previous = heading;
        for (const row of ordered) {
          const next = previous ? previous.nextElementSibling : section.firstElementChild;
          if (next !== row.button) section.insertBefore(row.button, next || null);
          previous = row.button;
        }
      }
      frame.dataset.runtimeConnected = String(connected); picker.dataset.runtimeConnected = String(connected);
      const label = connected ? 'Add photos, files, Pi commands, and skills' : 'Add photos, files, plugins, and skills';
      trigger.setAttribute('aria-label', label); picker.setAttribute('aria-label', label);
      menuSearch.placeholder = connected ? 'Search files, commands, and skills' : 'Search files, plugins, and skills';
      menuSearch.setAttribute('aria-label', menuSearch.placeholder);
      filterRows(wasOpen ? menuMode === 'add' ? menuSearch.value : query?.text || '' : '');
      if (wasOpen) {
        const index = list.findIndex(row => row.item.id === oldActive);
        activate(index >= 0 ? index : Math.min(activeIndex, list.length - 1));
        menuScroll.scrollTop = scrollTop;
        if (focusedRow) {
          const retained = list.find(row => row.button === focused);
          (retained?.button || (menuMode === 'add' ? menuSearch : input)).focus({ preventScroll: true });
        }
        placePicker(false);
        if (menuMode === 'mention' && !list.length) setPickerOpen(false);
      }
      syncChips(); updateSendHints(); refreshIcons(picker); wake();
    }
    function resetGhost() {
      cancelGroup('ghost');
      ghostOffered = false; ghostSuffix = null; letters = []; ghostText.replaceChildren(); ghostPrefix.textContent = '';
      tabSpring.t = 0; ghostFade.t = 0; suggestionHelp.textContent = '';
      input.placeholder = 'Ask a question or describe your research';
      wake();
    }
    function endGhostAcceptance() {
      if (!ghostAccepting) return;
      ghostAccepting = false; input.classList.remove('is-accepting'); ghostLayer.classList.remove('is-accepting'); resetGhost();
    }
    function refreshGhost() {
      if (ghostAccepting) return;
      const value = input.value;
      const eligible = !hosted() && !composing && !busy && !pickerOpen && !attachments.length && !selectedItems.size && input.selectionStart === value.length && input.selectionEnd === value.length && SUGGESTION.startsWith(value) && value.length < SUGGESTION.length;
      if (!eligible) { resetGhost(); return; }
      const suffix = SUGGESTION.slice(value.length);
      if (ghostOffered && ghostSuffix === suffix) return;
      resetGhost(); ghostSuffix = suffix; ghostPrefix.textContent = value;
      const suggestion = document.createDocumentFragment();
      for (const segment of suffix.match(/ +|[^ ]+/gu) ?? []) {
        if (segment.startsWith(' ')) {
          suggestion.append(segment);
          continue;
        }
        const span = document.createElement('span');
        span.className = 'acm-ghost-word';
        for (const glyph of segment) {
          const el = document.createElement('span');
          el.className = 'acm-ghost-letter';
          el.textContent = glyph;
          el.style.opacity = '0';
          const fade = newSpring(0, 300, 30);
          later(letters.length * .008, () => { fade.t = 1; }, 'ghost');
          letters.push({ el, o: fade, y: newSpring(0, 520, 16) });
          span.append(el);
        }
        suggestion.append(span);
      }
      ghostText.append(suggestion);
      ghostOffered = true; tabSpring.t = 1; ghostFade.x = ghostFade.t = 1; input.placeholder = '';
      suggestionHelp.textContent = 'Suggestion: ' + SUGGESTION + ' Press Tab to accept.';
      wake();
    }
    function acceptGhost() {
      if (!ghostOffered || composing || busy) return false;
      if (input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length || !SUGGESTION.startsWith(input.value)) { resetGhost(); return false; }
      cancelGroup('ghost'); ghostOffered = false; ghostAccepting = true;
      input.value = SUGGESTION; input.setSelectionRange(SUGGESTION.length, SUGGESTION.length);
      input.classList.add('is-accepting'); ghostLayer.classList.add('is-accepting');
      tabSpring.v = -9; tabSpring.t = 0;
      letters.forEach((letter, index) => later(index * .016, () => { letter.el.classList.add('is-accepted'); letter.y.v = -70; letter.o.t = 1; }, 'ghost'));
      suggestionHelp.textContent = ''; live.textContent = 'Suggestion accepted. Press ' + sendShortcut() + ' to send.';
      if (reduce) endGhostAcceptance(); else later(letters.length * .016 + 1.7, endGhostAcceptance, 'ghost');
      fit(); wake(); return true;
    }
    function changed() {
      endGhostAcceptance(); syncChips();
      if (!composing) filterPicker();
      refreshGhost(); fit();
    }
    function submit() {
      if (busy || composing || !input.value.trim() && !attachments.length) return;
      endGhostAcceptance(); setPickerOpen(false);
      const value = input.value;
      const detail = { value, mentions: getSelections(), attachments: getAttachments() };
      if (typeof callbacks.onSubmit === 'function') callbacks.onSubmit(value, { mentions: detail.mentions, attachments: detail.attachments });
      else frame.dispatchEvent(new CustomEvent('ac:submit', { bubbles: true, detail }));
    }
    function requestStop() {
      if (!busy || stopRequested || !canStop) return;
      stopRequested = true; fit();
      try {
        if (typeof callbacks.onStop === 'function') callbacks.onStop();
        else frame.dispatchEvent(new CustomEvent('ac:stop-request', { bubbles: true }));
      } catch (error) {
        stopRequested = false; fit(); throw error;
      }
    }
    function sendShortcut() { return sendKey === 'mod-enter' ? mac ? '⌘Enter' : 'Ctrl+Enter' : 'Enter'; }
    function updateSendHints() {
      const shortcut = sendShortcut();
      send.setAttribute('aria-label', busy ? 'Stop response' : 'Send message');
      send.setAttribute('data-morph-tooltip', busy ? 'Stop response' : 'Send message (' + shortcut + ')');
      if (busy) send.removeAttribute('aria-keyshortcuts');
      else send.setAttribute('aria-keyshortcuts', sendKey === 'mod-enter' ? 'Control+Enter Meta+Enter' : 'Enter');
      q('.acm-hint').textContent = shortcut + ' to send · ' + (sendKey === 'mod-enter' ? 'Enter for a new line' : 'Shift+Enter for a new line');
      q('#ac-composer-help').textContent = 'Press ' + shortcut + ' to send or ' + (sendKey === 'mod-enter' ? 'Enter' : 'Shift+Enter') + ' for a new line. ' + (runtimeConnected ? 'Type $ to choose a project skill, or use the add button for files and Pi commands.' : 'Use the add button to choose files, plugins, and skills, or type @ to find a project item.');
    }
    function setSendKey(mode) {
      if (destroyed) return;
      sendKey = mode === 'mod-enter' ? 'mod-enter' : 'enter';
      updateSendHints();
    }
    function setBusy(value, message, options = {}) {
      canStop = options.canStop !== false;
      if (destroyed) return;
      const wasBusy = busy; busy = !!value; cancelTimer(statusTimer); statusTimer = null;
      if (!busy || !wasBusy) stopRequested = false;
      sendMorph.t = busy ? 1 : 0; input.setAttribute('aria-busy', String(busy));
      updateSendHints();
      status.classList.toggle('is-thinking', busy); status.classList.toggle('is-done', !busy);
      if (busy) { statusLabel.textContent = message || 'Reviewing your request'; statusHeight.t = 1; }
      else if (wasBusy || message) {
        statusLabel.textContent = message || 'Ready for your next message'; statusHeight.t = 1;
        statusTimer = later(1.6, () => { statusHeight.t = 0; statusTimer = null; }, 'status');
      } else statusHeight.t = 0;
      if (busy) { endGhostAcceptance(); setPickerOpen(false); }
      refreshGhost(); fit(); wake();
    }
    listen(input, 'input', () => { queryDismissed = null; changed(); });
    listen(input, 'compositionstart', () => { composing = true; endGhostAcceptance(); resetGhost(); setPickerOpen(false); });
    listen(input, 'compositionend', () => { composing = false; compositionEndedAt = performance.now(); queryDismissed = null; changed(); });
    listen(input, 'keydown', event => {
      if (composing || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && performance.now() - compositionEndedAt < 80) return;
      if (pickerOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault(); activate((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length, true); return;
      }
      if (pickerOpen && event.key === 'Enter') { event.preventDefault(); if (!event.repeat) pickMention(); return; }
      if (event.key === 'Escape') {
        if (pickerOpen) { event.preventDefault(); closePicker(false); }
        if (ghostOffered || ghostAccepting) { event.preventDefault(); endGhostAcceptance(); resetGhost(); }
        return;
      }
      if (event.key === 'Tab' && pickerOpen) {
        if (query?.trigger === '$' && !event.shiftKey) { event.preventDefault(); pickMention(); }
        else closePicker(false);
        return;
      }
      if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && ghostOffered && acceptGhost()) { event.preventDefault(); return; }
      const sendCombination = sendKey === 'mod-enter' ? event.ctrlKey || event.metaKey : !event.ctrlKey && !event.metaKey;
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey && sendCombination && !busy) { event.preventDefault(); if (!event.repeat) submit(); }
    });
    listen(input, 'keyup', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { filterPicker(); refreshGhost(); } });
    listen(input, 'click', () => { filterPicker(); refreshGhost(); });
    listen(input, 'select', () => { filterPicker(); refreshGhost(); });
    listen(input, 'focus', () => { refreshGhost(); fit(); });
    listen(input, 'scroll', () => { render(); if (pickerOpen) placePicker(false); });
    listen(send, 'click', event => { if (event.detail > 1 || send.disabled) return; busy ? requestStop() : submit(); });
    listen(send, 'keydown', event => { if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault(); });
    listen(trigger, 'click', openAddMenu);
    listen(trigger, 'keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!pickerOpen) openAddMenu(); activate(event.key === 'ArrowUp' ? list.length - 1 : 0, true); list[activeIndex]?.button.focus({ preventScroll: true }); } });
    listen(menuSearch, 'input', () => { activeIndex = 0; filterRows(menuSearch.value); menuScroll.scrollTop = 0; });
    listen(menuSearch, 'compositionstart', () => { searchComposing = true; });
    listen(menuSearch, 'compositionend', () => { searchComposing = false; searchCompositionEndedAt = performance.now(); });
    listen(picker, 'keydown', event => {
      if (!pickerOpen || searchComposing || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && performance.now() - searchCompositionEndedAt < 80) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePicker(true); return; }
      if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); setPickerOpen(false); (event.shiftKey ? trigger : input).focus({ preventScroll: true }); return; }
      if (!list.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        if (event.target === menuSearch && (event.key === 'Home' || event.key === 'End')) return;
        event.preventDefault();
        const firstSearchResult = menuSearch.value.trim() ? Math.max(0, list.findIndex(row => row.item.action !== 'upload')) : 0;
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : event.target === menuSearch ? event.key === 'ArrowUp' ? list.length - 1 : firstSearchResult : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
        activate(index, true); list[activeIndex].button.focus({ preventScroll: true });
      } else if (event.key === 'Enter' && event.target === menuSearch) { event.preventDefault(); if (menuSearch.value.trim() && !list.some(row => row.item.action !== 'upload')) { live.textContent = 'No matching items.'; return; } if (!event.repeat) pickMention(); }
      else if (event.key === 'Enter' && event.repeat) event.preventDefault();
    });
    listen(fileInput, 'change', () => { addFiles(fileInput.files); fileInput.value = ''; });
    listen(fileInput, 'cancel', () => input.focus({ preventScroll: true }));
    const containsInteractiveArea = target => frame.contains(target) || picker.contains(target);
    listen(document, 'pointerdown', event => { if (pickerOpen && !containsInteractiveArea(event.target)) closePicker(false); });
    listen(document, 'focusin', event => { if (pickerOpen && !containsInteractiveArea(event.target)) closePicker(false); });
    listen(document, 'scroll', event => { if (pickerOpen && !picker.contains(event.target)) placePicker(false); }, true);
    listen(window, 'resize', () => { fit(); if (pickerOpen) placePicker(false); });
    if (window.visualViewport) { listen(window.visualViewport, 'resize', () => { if (pickerOpen) placePicker(false); }); listen(window.visualViewport, 'scroll', () => { if (pickerOpen) placePicker(false); }); }
    const onReduceChange = () => { reduce = prefersReduced(); if (reduce && ghostAccepting) endGhostAcceptance(); wake(); };
    if (reduceQuery.addEventListener) listen(reduceQuery, 'change', onReduceChange);
    else { reduceQuery.addListener(onReduceChange); listeners.push(() => reduceQuery.removeListener(onReduceChange)); }
    listen(portal, 'ac:settings-change', event => {
      onReduceChange();
      if (event.detail?.settings?.sendKey) setSendKey(event.detail.settings.sendKey);
      else if (typeof callbacks.getSendKey === 'function') setSendKey(callbacks.getSendKey());
      const key = event.detail?.key;
      if (!key || key === 'textSize' || key === 'restore') {
        const scrollTop = input.scrollTop;
        fit();
        input.scrollTop = scrollTop;
        if (pickerOpen) placePicker(false);
      }
    });
    let observedWidth = 0;
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
      const width = entries[0] && entries[0].contentRect.width;
      if (!width || Math.abs(width - observedWidth) < .5 || measureQueued) return;
      observedWidth = width; measureQueued = true;
      queueMicrotask(() => { measureQueued = false; if (!destroyed) { fit(); if (pickerOpen) placePicker(false); } });
    }) : null;
    if (resizeObserver) resizeObserver.observe(frame);
    const api = {
      getValue: () => input.value,
      getAttachments,
      getSelections,
      clearContext,
      captureDraft: () => ({ value: input.value, attachments: getAttachments(), mentions: getSelections() }),
      restoreDraft(draft = {}) {
        if (destroyed) return;
        clearContext(); input.value = String(draft.value || '');
        for (const item of draft.mentions || []) if (ITEMS.some(entry => entry.id === item.id)) selectedItems.add(item.id);
        addFiles(draft.attachments || []); changed();
      },
      openMenu: openAddMenu,
      closeMenu: () => closePicker(false),
      setSendKey,
      setRuntimeCommands,
      setProjectSkills(skills) {
        projectSkills = (skills || []).filter(s => s.enabled && s.roles?.includes('parent'));
        setRuntimeCommands(latestCommands, {connected:runtimeConnected});
        if (document.activeElement === input && readQuery()?.trigger === '$') filterPicker();
      },
      getSendKey: () => sendKey,
      setValue(value) { if (destroyed) return; endGhostAcceptance(); input.value = value == null ? '' : String(value); input.setSelectionRange(input.value.length, input.value.length); queryDismissed = null; activeIndex = 0; changed(); },
      focus() { if (!destroyed) input.focus(); },
      setBusy,
      destroy() {
        if (destroyed) return; destroyed = true;
        if (raf) cancelAnimationFrame(raf); raf = 0; timers = []; letters = []; chips = [];
        listeners.splice(0).forEach(remove => remove()); rows.forEach(row => row.destroy()); runtimeRows.clear(); if (resizeObserver) resizeObserver.disconnect();
        picker.remove(); frame.remove(); attachments = []; selectedItems.clear(); if (slot.__athenaComposer === api) delete slot.__athenaComposer;
      }
    };
    slot.__athenaComposer = api;
    refreshIcons(frame); refreshIcons(picker); picker.inert = true; menuSearch.disabled = true; updateSendHints(); refreshGhost(); fit(); render(); wake();
    return api;
  }
  window.AthenaComposer = Object.freeze({ mount });
})();
