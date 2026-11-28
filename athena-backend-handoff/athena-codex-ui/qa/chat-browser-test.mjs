// Run: node qa/chat-browser-test.mjs (from the UI folder, after python3 build.py).
// Requires pinned Playwright + Chromium. ATHENA_BROWSER_EVIDENCE selects artifacts.
// --fixture-smoke checks the real host/provider fixture without claiming browser QA.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture, inputs, prompts } from './chat-browser-fixture.mjs';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const smoke = process.argv.includes('--fixture-smoke');
const evidence = resolve(process.env.ATHENA_BROWSER_EVIDENCE || join(tmpdir(), 'athena-browser-evidence-' + randomUUID()));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const html = await readFile(join(repo, 'athena-backend-handoff/athena-codex-ui/athena-preview.html'));
const workflowEvent = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) : null;
const source = {
  checkoutRevision: git(['rev-parse', 'HEAD']),
  checkoutTree: git(['rev-parse', 'HEAD^{tree}']),
  parentRevisions: git(['show', '-s', '--format=%P', 'HEAD']).split(' ').filter(Boolean),
  ...(workflowEvent?.pull_request ? { pullRequestHeadRevision: workflowEvent.pull_request.head.sha, pullRequestBaseRevision: workflowEvent.pull_request.base.sha } : {}),
  ...(process.env.GITHUB_RUN_ID ? { workflowRunId: process.env.GITHUB_RUN_ID, workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT } : {}),
  generatedHtmlSha256: sha(html), generatedHtmlBytes: html.length,
  trackedChanges: git(['diff', '--name-only', 'HEAD', '--']).split('\n').filter(Boolean),
};
const fixture = await createFixture();
const checks = [], pageErrors = [], downloads = [];
let browser, page;
const report = { browser: !smoke, model: 'controlled compatible SSE provider', realChatGPTAccount: false,
  source, environment: { node: process.version, platform: process.platform, arch: process.arch },
  host: 'runtime/server.ts', workers: ['athena-measurements', 'athena-circuits'], checks, downloads, evidenceDirectory: evidence, screenshots: [], graphGeometry: [], chatScroll: [], limitations: [
    'The model response is controlled. This does not verify real model reasoning, ChatGPT accounts, native macOS rendering, or two-account switching.',
    'Cancellation covers a streaming model response. The short MCP calculations are not cancelled in flight.',
  ] };

async function shot(name) {
  // Move off controls so a tooltip cannot cover the evidence being captured.
  await page.mouse.move(2, 2); await page.waitForTimeout(180);
  const file = name + '.png'; await page.screenshot({ path: join(evidence, file), fullPage: true }); report.screenshots.push(file);
}
async function chatScrollMetrics(phase, answerPrefix) {
  const metrics = await page.evaluate(answerPrefix => {
    const scroller = document.querySelector('.ac-conversation-inner');
    const answer = [...document.querySelectorAll('#ac-pi-transcript [data-role="assistant"] .ac-stream-text')]
      .find(node => node.textContent.startsWith(answerPrefix));
    if (!scroller) throw new Error('The conversation scroller is missing.');
    const viewport = scroller.getBoundingClientRect(), rect = answer?.getBoundingClientRect();
    return { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
      distanceFromBottom: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      viewport: { top: viewport.top, bottom: viewport.bottom }, answer: rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null };
  }, answerPrefix);
  report.chatScroll.push({ phase, ...metrics }); return metrics;
}
async function verifyChatFollow() {
  await page.waitForFunction(() => {
    const scroller = document.querySelector('.ac-conversation-inner');
    const answer = [...document.querySelectorAll('#ac-pi-transcript [data-role="assistant"] .ac-stream-text')]
      .find(node => node.textContent.startsWith('Both calculations completed.'));
    if (!scroller || !answer) return false;
    const viewport = scroller.getBoundingClientRect(), rect = answer.getBoundingClientRect();
    return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 24 && rect.bottom <= viewport.bottom + 2 && rect.top >= viewport.top - 2;
  }, null, { timeout: 5000 }).catch(() => {});
  const metrics = await chatScrollMetrics('completed-without-reader-scroll', 'Both calculations completed.');
  assert.ok(metrics.distanceFromBottom <= 24, 'A normal send must keep following the newest content: ' + JSON.stringify(metrics));
  assert.ok(metrics.answer && metrics.answer.bottom <= metrics.viewport.bottom + 2 && metrics.answer.top >= metrics.viewport.top - 2,
    'The completed answer must be readable in the conversation viewport: ' + JSON.stringify(metrics));
}
async function verifyGraphGeometry(dependencies) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = await page.evaluate(dependencies => {
    const svg = document.querySelector('svg.awg-edges'), canvas = document.querySelector('[data-awg-canvas]');
    if (!svg || !canvas) throw new Error('The workflow graph is not rendered.');
    const svgRect = svg.getBoundingClientRect(), canvasRect = canvas.getBoundingClientRect();
    const paths = [...svg.querySelectorAll('[data-awg-edge="dependency"]')];
    if (paths.length !== dependencies.length) throw new Error('Rendered dependency paths differ from the host records.');
    const edges = dependencies.map((dependency, index) => {
      const path = paths[index], matrix = path.getScreenCTM();
      if (!matrix) throw new Error('A dependency path has no screen transform.');
      const localStart = path.getPointAtLength(0), localEnd = path.getPointAtLength(path.getTotalLength());
      const start = new DOMPoint(localStart.x, localStart.y).matrixTransform(matrix);
      const end = new DOMPoint(localEnd.x, localEnd.y).matrixTransform(matrix);
      const source = document.querySelector('[data-awg-node="' + CSS.escape(dependency.source) + '"]');
      const target = document.querySelector('[data-awg-node="' + CSS.escape(dependency.target) + '"]');
      if (!source || !target) throw new Error('The dependency endpoint task is absent.');
      const from = source.getBoundingClientRect(), to = target.getBoundingClientRect();
      return { index, startErrorPx: Math.hypot(start.x - (from.left + from.width / 2), start.y - from.bottom),
        endErrorPx: Math.hypot(end.x - (to.left + to.width / 2), end.y - to.top) };
    });
    return { viewportWidth: window.innerWidth, svg: { width: svgRect.width, height: svgRect.height },
      canvas: { width: canvasRect.width, height: canvasRect.height }, edges };
  }, dependencies);
  assert.ok(Math.abs(geometry.svg.width - geometry.canvas.width) <= 1, 'Dependency SVG width must match the graph canvas, not the shared icon size.');
  assert.ok(Math.abs(geometry.svg.height - geometry.canvas.height) <= 1, 'Dependency SVG height must match the graph canvas, not the shared icon size.');
  for (const edge of geometry.edges) {
    assert.ok(edge.startErrorPx <= 2, 'Dependency ' + edge.index + ' must start at its source task bottom center: ' + edge.startErrorPx);
    assert.ok(edge.endErrorPx <= 2, 'Dependency ' + edge.index + ' must end at its target task top center: ' + edge.endErrorPx);
  }
  report.graphGeometry.push(geometry);
}
async function connected() {
  await page.waitForFunction(() => {
    const state = window.AthenaApp?.getState();
    return state?.piConnected && state.workspace?.mode === 'runtime' && state.workspace.taskManagerConnected && state.workspace.sessionBound !== false;
  });
}
async function idle() { await page.waitForFunction(() => window.AthenaApp?.getState().busy === false); }
async function send(prompt, attachments = []) {
  if (attachments.length) await page.locator('.acm-file-input').setInputFiles(attachments);
  await page.locator('#ac-prompt-input').fill(prompt);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
}
function successful(snapshot) {
  assert.equal(snapshot.run.status, 'succeeded');
  assert.equal(snapshot.tasks.length, 3);
  assert.ok(snapshot.tasks.every(task => task.status === 'succeeded'));
  assert.equal(snapshot.processes.length, 2);
  assert.ok(snapshot.processes.every(process => process.status === 'succeeded'));
  assert.deepEqual(snapshot.artifacts.map(artifact => artifact.file.name).sort(), ['rc-response.json', 'statistics.json']);
}
async function verifyDownloads(snapshot, useBrowser) {
  for (const artifact of snapshot.artifacts) {
    let bytes;
    if (useBrowser) {
      await page.evaluate(id => window.AthenaApp.openWorkspace('artifacts', { artifactId: id }), artifact.id);
      await page.locator('[data-awv-artifact-view] a[download]').first().waitFor({ state: 'visible' });
      const transfer = page.waitForEvent('download');
      await page.locator('[data-awv-artifact-view] a[download]').first().click();
      const download = await transfer;
      const target = join(evidence, artifact.file.name); await download.saveAs(target); bytes = await readFile(target);
      await page.waitForFunction(name => {
        const body = document.querySelector('[data-awv-artifact-view]')?.innerText || '';
        return name === 'statistics.json' ? body.includes('19') : body.includes('0.001');
      }, artifact.file.name);
      await page.locator('[data-awv-artifact-view]').evaluate(element => { element.closest('.awv-scroll').scrollTop = 0; });
      await shot(artifact.file.name === 'statistics.json' ? '03-csv-artifact' : '04-rc-artifact');
    } else {
      const response = await fetch(fixture.origin + artifact.location.uri); assert.equal(response.ok, true); bytes = Buffer.from(await response.arrayBuffer());
    }
    assert.equal(sha(bytes), artifact.file.sha256);
    assert.equal(bytes.length, artifact.file.bytes);
    const result = JSON.parse(bytes.toString('utf8'));
    if (artifact.file.name === 'statistics.json') {
      assert.equal(result.statistics[0].mean, 19); assert.equal(result.statistics[0].min, 7); assert.equal(result.statistics[0].max, 35);
    } else {
      assert.equal(result.timeConstantSeconds, 0.001); assert.ok(Math.abs(result.cutoffHz - 159.154943091895) < 1e-9);
      assert.equal(result.samples.length, 3);
    }
    downloads.push({ name: artifact.file.name, id: artifact.id, sha256: sha(bytes), bytes: bytes.length, via: useBrowser ? 'browser download' : 'host HTTP' });
  }
}
try {
  await mkdir(evidence, { recursive: true });
  const conversation = await fixture.createConversation();
  if (smoke) {
    const staged = await fixture.rpc('stageFiles', [conversation.sessionId, inputs.map(input => ({ name: input.name, mimeType: input.mimeType, data: input.buffer.toString('base64') }))]);
    await fixture.rpc('pi', [conversation.sessionId, { type: 'prompt', id: randomUUID(), message: prompts.compare, fileReferences: staged.fileReferences }]);
  } else {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    report.browserEngine = { name: 'Chromium', version: browser.version(), playwrightVersion: require('playwright/package.json').version, headless: true };
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true, reducedMotion: 'reduce' });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto(fixture.origin); await connected();
    await send(prompts.compare, inputs);
    await page.waitForFunction(() => window.AthenaApp.getState().busy && document.querySelector('#ac-pi-transcript')?.innerText.includes('I am delegating the two attached inputs.'));
    checks.push('User send and incremental assistant streaming are visible before the response finishes.');
    await shot('01-streaming-chat');
  }
  const result = await fixture.waitSnapshot(snapshot => ['succeeded', 'failed', 'cancelled'].includes(snapshot.run.status));
  successful(result);
  checks.push('Two uploaded files retain their grants through parent delegation and real CSV/RC MCP execution.');
  if (!smoke) {
    await idle();
    const transcript = await page.locator('#ac-pi-transcript').innerText();
    assert.match(transcript, /Research activity/);
    assert.equal(await page.locator('#ac-pi-transcript .ac-stream-activity[open]').count(), 0);
    assert.match(transcript, /Both calculations completed/);
    await verifyChatFollow();
    checks.push('Without reader scrolling, streamed work and the completed answer stay at the bottom of the conversation viewport.');
    assert.deepEqual(await page.locator('#ac-pi-transcript [data-role="user"]').first().locator('.ac-message-attachment').allTextContents(), inputs.map(input => input.name));
    assert.equal(transcript.includes('Input attachment (never a result)'), false);
    for (const record of [...result.tasks, ...result.attempts, ...result.processes]) assert.equal(transcript.includes(record.id), false, 'Internal IDs must stay out of ordinary activity text.');
    const sequence = await page.locator('#ac-pi-transcript').evaluate(element => [...element.children].map(node => ({ role: node.dataset.role, attempt: node.matches('.ac-stream-activity') && !!node.querySelector('[data-aw-attempt]'), text: node.innerText })));
    assert.ok(sequence.findIndex(row => row.attempt) > sequence.findIndex(row => row.role === 'user'));
    assert.ok(sequence.findIndex(row => row.attempt) < sequence.findIndex(row => row.text.includes('Both calculations completed.')));
    checks.push('Child activities stay with their originating turn, show real actions and do not expose internal IDs or attachment instructions.');
    await shot('02-completed-chat');
    await page.evaluate(() => window.AthenaApp.openWorkspace('workflow'));
    await page.locator('[data-awv-action="workflow-mode"][data-awv-value="graph"]').click();
    await page.locator('[data-awv-workflow-map]').waitFor({ state: 'visible' });
    assert.match(await page.locator('[data-awv-workflow-map]').innerText(), /Summarize voltage measurements/);
    assert.equal(await page.locator('[data-awg-node]').count(), result.tasks.length);
    const taskIds = new Set(result.tasks.map(task => task.id));
    const dependencies = result.tasks.flatMap(task => [...new Set((task.dependencies || []).filter(id => taskIds.has(id)))].map(id => ({ source: id, target: task.id })));
    assert.equal(await page.locator('[data-awg-edge="dependency"]').count(), dependencies.length);
    const worker = result.tasks.find(task => task.title === 'Summarize voltage measurements');
    assert.ok(worker);
    const node = page.locator('[data-awg-node] [data-awv-task="' + worker.id + '"]');
    await node.focus(); await node.press('Enter');
    await page.waitForFunction(title => document.querySelector('[data-awv-detail-heading]')?.innerText.includes(title), worker.title);
    await page.locator('[data-awv-action="graph-fit"]').click();
    const fitted = Number((await page.locator('[data-awg-zoom]').innerText()).replace('%', ''));
    await page.locator('[data-awv-action="graph-zoom-in"]').click();
    assert.ok(Number((await page.locator('[data-awg-zoom]').innerText()).replace('%', '')) > fitted);
    await page.locator('[data-awv-action="graph-fit"]').click();
    await verifyGraphGeometry(dependencies);
    checks.push('The real workflow graph contains the recorded tasks and dependency edges; keyboard node selection and fit/zoom controls work.');
    await shot('05-workflow-graph');
    await page.setViewportSize({ width: 760, height: 900 });
    await verifyGraphGeometry(dependencies);
    checks.push('At desktop and narrow widths, dependency SVG dimensions match the canvas and transformed endpoints meet the actual task cards.');
    await shot('06-workflow-narrow');
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await verifyDownloads(result, !smoke);
  checks.push(smoke ? 'Direct host HTTP downloads match both real MCP receipts and numerical expectations.'
    : 'The artifact table and browser download read the same saved JSON; downloaded SHA-256 matches both real MCP receipts.');
  if (!smoke) {
    await page.evaluate(() => window.AthenaApp.closePanel());
    const userText = 'Please preserve this identifier exactly: ' + result.tasks[0].id;
    await send(userText);
    await page.waitForFunction(() => document.querySelector('#ac-pi-transcript')?.innerText.includes('The requested identifier was preserved.'));
    await idle();
    assert.ok((await page.locator('#ac-pi-transcript [data-role="user"] .ac-stream-text').allTextContents()).includes(userText));
    checks.push('An actual internal-looking identifier explicitly typed by the user is preserved verbatim.');

    // A rejected transport is explicitly injected; it is not counted as a host execution.
    const beforeReject = await fixture.rpc('getSnapshot');
    const rejectOnce = async route => {
      const body = route.request().postDataJSON();
      if (body.method === 'pi' && body.args[1]?.type === 'prompt') {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected browser transport rejection.' }) });
      } else await route.continue();
    };
    await page.route('**/api/rpc', rejectOnce);
    await send(prompts.rejected);
    await page.waitForFunction(value => document.querySelector('#ac-prompt-input')?.value === value && !window.AthenaApp.getState().busy, prompts.rejected);
    assert.equal((await fixture.rpc('getSnapshot')).attempts.length, beforeReject.attempts.length);
    await page.unroute('**/api/rpc', rejectOnce);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#ac-pi-transcript')?.innerText.includes('The preserved draft was accepted.'));
    await idle();
    await page.waitForFunction(value => [...document.querySelectorAll('#ac-pi-transcript [data-role="user"] .ac-stream-text')].filter(node => node.textContent === value).length === 1, prompts.rejected);
    checks.push('A deliberately rejected send restores the draft and creates no host attempt; resending reaches the real host.');

    await send(prompts.cancel);
    await page.waitForFunction(() => document.querySelector('#ac-pi-transcript')?.innerText.includes('Waiting for cancellation.'));
    await page.locator('.ac-conversation-inner').hover(); await page.mouse.wheel(0, -640);
    await page.waitForFunction(() => {
      const scroller = document.querySelector('.ac-conversation-inner');
      return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 200;
    });
    await page.waitForTimeout(200);
    const readerPosition = await chatScrollMetrics('reader-scrolled-up', 'Waiting for cancellation.');
    await page.waitForFunction(() => document.querySelector('#ac-pi-transcript')?.innerText.includes('More text arrived while the reader reviewed earlier work.'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const afterUpdate = await chatScrollMetrics('stream-update-while-reading', 'Waiting for cancellation.');
    assert.ok(Math.abs(readerPosition.scrollTop - afterUpdate.scrollTop) <= 2, 'Streaming must preserve the reader’s position after they scroll up.');
    checks.push('When the reader scrolls up with the mouse wheel, the next real streaming update preserves that reading position.');
    await page.locator('.ac-conversation-inner').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.getByRole('button', { name: 'Stop response', exact: true }).click();
    await fixture.waitSnapshot(snapshot => snapshot.run.status === 'cancelled'); await idle();
    const stopped = await fixture.rpc('getSnapshot');
    assert.equal(stopped.artifacts.length, result.artifacts.length);
    assert.ok(result.artifacts.every(artifact => stopped.artifacts.some(saved => saved.id === artifact.id && saved.file.sha256 === artifact.file.sha256)));
    checks.push('Stop response cancels the live model stream while preserving earlier successful outputs.');
    await shot('07-cancelled-chat');

    const reconnectBootstrap = page.waitForResponse(response => response.url() === fixture.origin + '/api/bootstrap' && response.ok(), { timeout: 30000 });
    await fixture.stopHost(); await fixture.startHost();
    await reconnectBootstrap;
    await connected();
    await page.waitForFunction(() => window.AthenaApp.getState().workspace.run.status === 'cancelled');
    await page.reload(); await connected();
    await page.waitForFunction(() => document.querySelector('#ac-pi-transcript')?.innerText.includes('Both calculations completed.'));
    const restored = await fixture.rpc('getSnapshot');
    assert.deepEqual(restored.tasks.map(task => task.id), stopped.tasks.map(task => task.id));
    assert.deepEqual(restored.processes.map(process => process.id), stopped.processes.map(process => process.id));
    assert.deepEqual(restored.artifacts.map(artifact => [artifact.id, artifact.file.sha256]), stopped.artifacts.map(artifact => [artifact.id, artifact.file.sha256]));
    assert.ok((await page.locator('#ac-pi-transcript [data-role="user"] .ac-stream-text').allTextContents()).includes(userText));
    assert.equal((await page.locator('#ac-pi-transcript').innerText()).includes('Input attachment (never a result)'), false);
    assert.equal((await page.locator('#ac-pi-transcript [data-role="user"] .ac-stream-text').allTextContents()).filter(text => text === prompts.compare).length, 1);
    assert.deepEqual(await page.locator('#ac-pi-transcript [data-role="user"]').first().locator('.ac-message-attachment').allTextContents(), inputs.map(input => input.name));
    for (const artifact of restored.artifacts) {
      const response = await fetch(fixture.origin + artifact.location.uri);
      assert.equal(sha(Buffer.from(await response.arrayBuffer())), artifact.file.sha256);
    }
    await shot('08-restored-chat');
    await page.evaluate(() => window.AthenaApp.openWorkspace('manuscript'));
    const panel=page.locator('#ac-paper-project');
    await panel.getByText('New manuscript and sources',{exact:true}).click();
    await panel.getByText('Search Crossref',{exact:true}).click();
    await panel.getByLabel('Search term sent to Crossref').fill('bounded synthetic voltage search');
    await panel.getByRole('button',{name:'Authorize for chat'}).click();
    await page.waitForFunction(()=>document.querySelector('[data-paper="search-status"]').textContent.includes('Share this search ID'));
    await panel.getByRole('button',{name:'Cancel search'}).click();
    await page.waitForFunction(()=>document.querySelector('[data-paper="search-status"]').textContent==='cancelled');
    await panel.locator('[data-paper="file"]').setInputFiles({name:'observation.txt',mimeType:'text/plain',buffer:Buffer.from('A 19 mV observation.')});
    await panel.getByRole('button',{name:'Add text source'}).click();
    await panel.getByLabel('Source material').selectOption({label:'observation.txt · full_text'});
    await panel.getByLabel('Title',{exact:true}).fill('Browser manuscript');
    await panel.getByLabel('Research objective').fill('Summarize the observed voltage.');
    await panel.getByRole('button',{name:'Create manuscript'}).click();
    await panel.getByLabel('Section headings, one per line').fill('Observations');
    await panel.getByRole('button',{name:'Save outline'}).click();
    const catalog=await fixture.rpc('listPapers',[{projectId:restored.projectId}]);
    const manuscript=catalog.documents.find(d=>d.title==='Browser manuscript');assert.ok(manuscript);
    await page.waitForFunction(()=>!document.querySelector('[data-paper="write"]').disabled);
    assert.deepEqual((await fixture.rpc('paperDetails',[{projectId:restored.projectId,documentId:manuscript.id}])).outline,['Observations']);
    await shot('08b-manuscript-sources');
    checks.push('The shipped manuscript panel authorizes and cancels a Crossref search, imports user bytes, creates a source-backed manuscript and saves its outline through host RPC.');
    await page.evaluate(()=>window.AthenaApp.closePanel());
    checks.push('A real host restart reconnects and page reload restores the same tasks, processes, outputs, attachment badges and user messages without automatic re-execution.');

    await page.evaluate(() => window.AthenaApp.createResearch('Attachment-only message'));
    await connected();
    await send('', [inputs[0]]);
    await page.waitForFunction(() => document.querySelector('#ac-pi-transcript')?.innerText.includes('The preserved draft was accepted.'));
    await idle();
    assert.deepEqual(await page.locator('#ac-pi-transcript [data-role="user"] .ac-stream-text').allTextContents(), ['']);
    assert.deepEqual(await page.locator('#ac-pi-transcript [data-role="user"] .ac-message-attachment').allTextContents(), ['measurements.csv']);
    await page.reload(); await connected();
    await page.locator('#ac-pi-transcript [data-role="user"] .ac-message-attachment').waitFor({ state: 'visible' });
    assert.deepEqual(await page.locator('#ac-pi-transcript [data-role="user"] .ac-stream-text').allTextContents(), ['']);
    assert.deepEqual(await page.locator('#ac-pi-transcript [data-role="user"] .ac-message-attachment').allTextContents(), ['measurements.csv']);
    checks.push('An attachment-only send is accepted without inventing user text, and its file badge survives reload.');
    await shot('09-attachment-only-restored');

    await page.evaluate(() => window.AthenaApp.openSurface('browser'));
    const surface = page.locator('#ac-surface-slot');
    await surface.getByRole('heading', { name: 'Browser automation is not connected', exact: true }).waitFor({ state: 'visible' });
    assert.match(await surface.innerText(), /cannot read pages, control tabs/);
    await surface.locator('[data-acs-address]').fill('');
    assert.equal(await surface.getByRole('button', { name: 'Copy web address', exact: true }).isDisabled(), true);
    const localAddress = fixture.origin + '/documentation';
    await surface.locator('[data-acs-address]').fill(localAddress);
    assert.equal(await surface.getByRole('button', { name: 'Copy web address', exact: true }).isEnabled(), true);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixture.origin });
    await surface.getByRole('button', { name: 'Copy web address', exact: true }).click();
    await page.waitForFunction(async expected => (await navigator.clipboard.readText()) === expected, localAddress);
    assert.equal(page.context().pages().length, 1, 'Copying the address must not launch or navigate another page.');
    await shot('10-browser-capability');
    await page.evaluate(() => window.AthenaApp.openSurface('device'));
    await surface.getByRole('heading', { name: 'No devices connected', exact: true }).waitFor({ state: 'visible' });
    assert.match(await surface.innerText(), /Device connection is not implemented/);
    assert.match(await surface.innerText(), /cannot pair a computer or lab server/);
    await shot('11-device-capability');
    checks.push('Runtime Browser and Device panels state their missing automation/pairing capabilities; copying a web address works without navigation.');
  }
  assert.deepEqual(fixture.failures, []); assert.deepEqual(pageErrors, []);
  report.status = 'passed'; report.providerRequests = fixture.calls.length;
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack || error); report.pageErrors = pageErrors; report.providerFailures = fixture.failures;
  if (page) await shot('failure').catch(() => {});
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.error(JSON.stringify(report, null, 2)); process.exitCode = 1;
} finally {
  await browser?.close(); await fixture.close();
}
