// A controlled model selects real Athena tools. CAD geometry comes from CadQuery/Open CASCADE.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createFixture} from './chat-browser-fixture.mjs';

const example=new URL('../../../examples/cad-spacer/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('plugin.json',example)));
const paperRequested = process.env.ATHENA_CAD_PAPER === '1';
const title = 'Volume verification of STEP spacers with three bore diameters';
const headings = ['Introduction', 'Methods', 'Results', 'Limitations'];
const parseLine = (message, prefix) => JSON.parse(message.split(prefix)[1].split('\n')[0]);
let manuscript;
const dimensions={outer_mm:30,height_mm:6,bores_mm:[8,12,16]};
const call=(name,args)=>({name,args}),hash=v=>createHash('sha256').update(v).digest('hex');
const evidence=process.env.ATHENA_BROWSER_EVIDENCE||await mkdtemp(join(tmpdir(),'athena-cad-evidence-'));
await mkdir(evidence,{recursive:true});
let fixture,browser,context,cad,measured,loaded=false,reviewed=false;
const markers=[];let start;
const mark=label=>markers.push({label,seconds:(Date.now()-start)/1000});
function check(output){
  assert.equal(output.engine,'CadQuery');assert.equal(output.outer_mm,30);assert.equal(output.height_mm,6);
  assert.deepEqual(output.rows.map(r=>r.bore_mm),dimensions.bores_mm);
  for(const r of output.rows){
    assert.equal(r.solid_count,1);
    assert.ok(Math.abs(r.volume_mm3-6*Math.PI*(15**2-(r.bore_mm/2)**2))<1e-6);
  }
}
function writePaper(input, outputs) {
  const sources = parseLine(input, 'Sources: ');
  if (outputs.length < sources.length) return call('read_file', {fileId: sources[outputs.length].fileId});
  const artifact = sources.findIndex(source => source.title === 'mcp-result.json');
  const original = sources.findIndex(source => source.title === 'spacer-dimensions.json');
  const output = JSON.parse(outputs[artifact]).result.structuredContent;
  const spec = JSON.parse(outputs[original]);
  check(output);
  assert.deepEqual(spec, dimensions);
  const maxError = Math.max(...output.rows.map(row => Math.abs(row.volume_mm3-row.expected_mm3)));
  const method = 'The input specifies a height of '+spec.height_mm+' mm and an outside diameter of '+spec.outer_mm+' mm.';
  const finding = 'At the largest bore the measured volume was '+output.rows.at(-1).volume_mm3.toFixed(3)+' cubic mm.';
  const table = ['| Bore (mm) | STEP volume (cubic mm) | Theoretical volume (cubic mm) | Valid solids |','| --- | --- | --- | --- |',
    ...output.rows.map(row => '| '+[row.bore_mm,row.volume_mm3.toFixed(3),row.expected_mm3.toFixed(3),row.solid_count].join(' | ')+' |')].join('\n');
  const sections = [
    'This numerical experiment asks how changing the through-bore diameter affects the material volume of a circular spacer and whether exporting the part to STEP preserves that volume.',
    method+' CadQuery '+output.version+' extruded two concentric circles for each bore. Each STEP file was re-imported and checked for one valid solid. We compared the imported volume with pi times height times the difference of the squared radii.',
    finding+' The maximum absolute discrepancy across all three models was '+maxError.toExponential(2)+' cubic mm.\n\n'+table,
    'These measurements concern ideal CAD geometry. The experiment includes no machining tolerances, material deformation or physical measurements.'
  ].map((text,i) => ({heading: headings[i],text}));
  manuscript = '# '+title+'\n\n'+sections.map(s => '## '+s.heading+'\n'+s.text).join('\n\n');
  if (input.includes('Return only a JSON array')) return JSON.stringify(sections);
  if (outputs.length === sources.length) return call('publish_manuscript',{text:manuscript,links:[
    {kind:'claim',quote:finding,sourceId:sources[artifact].sourceId,excerpt:String(output.rows.at(-1).volume_mm3),locator:'result.structuredContent.rows[2].volume_mm3'},
    {kind:'citation',quote:method,sourceId:sources[original].sourceId,excerpt:JSON.stringify(spec),locator:'spacer dimensions in mm'}
  ]});
  return 'Published the measured volumes and linked the dimension file.';
}
async function respond({coordinator,input,outputs,messages}){
  await delay(400);
  const n=outputs.length;
  if(coordinator && input.startsWith('Manuscript write request')) return n ? 'Completed manuscript review.' : call('compose_manuscript',{});
  if(coordinator){
    const file = JSON.parse(input.match(/\{"fileId":"[^"]+","name":"spacer-dimensions.json"\}/)[0]).fileId;
    if(!n){
      assert.match(input,/\$cad-spacer\/measure/);
      assert.ok(messages.some(m=>JSON.stringify(m.content).includes(manifest.skills[0].body)),'Pi must receive the pinned skill body before answering');
      loaded=true;
      return call('plan_research',{objective:'Effect of through-bore diameter on spacer volume',
        stages:['Build annular solids','Export and re-import STEP','Check against the analytical volume'],
        acceptanceCriteria:['One valid solid per file and absolute volume error below 1e-6 cubic mm.']});
    }
    if(n===1)return call('spawn_agent',{role:'experiment',title:'Build and measure STEP solids',prompt:'Run model_spacers using the dimension input '+file,fileIds:[file]});
    if(n===2)return call('wait_for_agents',{});
    const artifact=JSON.parse(outputs[2]).tasks[0].artifacts[0];
    if(n===3)return call('record_experiment_table',{artifactId:artifact.id,path:['result','structuredContent','rows'],condition:'bore diameters'});
    if(n===4)return call('add_research_evidence',{missionId:JSON.parse(outputs[0]).id,title:'Three STEP imports',fileIds:[file],artifactIds:[artifact.id]});
    if(n===5)return call('request_review',{missionId:JSON.parse(outputs[0]).id,evidenceIds:[JSON.parse(outputs[4]).id],question:'Read the CAD artifact, recompute the three analytical volumes and check the STEP digests.'});
    if(n===6)return call('wait_for_agents',{});
    assert.ok(reviewed);
    if (n === 7 && paperRequested) return call('prepare_research_paper',{reviewId:JSON.parse(outputs[5]).review.id,artifactIds:[artifact.id],inputIds:[file],title,template:'article',outline:headings});
    if (paperRequested) assert.ok(JSON.parse(outputs[7]).documentId);
    return 'CadQuery produced three valid STEP solids. For 8, 12 and 16 mm bores the volumes were '+measured.rows.map(r=>r.volume_mm3.toFixed(3)).join(', ')+' mm³. Each agreed with the analytical volume within 1e-6 mm³.';
  }
  if(input.includes('Review assignment: ')){
    const review=JSON.parse(input.split('Review assignment: ')[1].split('\n')[0]);
    if(n < review.targets.length) {
      const target = review.targets[n];
      return call('read_file',target.kind==='file'?{fileId:target.id}:{artifactId:target.id});
    }
    if(n === review.targets.length){
      review.targets.forEach((target,index)=>assert.equal(hash(outputs[index]), target.sha256));
      const receipt = outputs.map(text=>{try{return JSON.parse(text);}catch{return {};}}).find(obj=>obj.result?.structuredContent);
      check(receipt.result.structuredContent);
      assert.ok(outputs.includes(JSON.stringify(dimensions)));
      for(const file of receipt.result.structuredContent.models)assert.equal(hash(file.step),file.sha256);
      const checks = ['Claims: recalculated pi*h*(R²-r²) for each bore using the granted dimensions.',
        'Figures: checked the STEP bytes against all three digests.'];
      if(input.includes('Check exact quotes')){
        assert.ok(outputs.includes(manuscript));
        for(const row of receipt.result.structuredContent.rows) assert.ok(manuscript.includes(row.volume_mm3.toFixed(3)));
        checks.push('Citations: matched the input dimensions and table values to the pinned sources.');
      }
      reviewed=true;
      return call('submit_review',{reviewId:review.reviewId,verdict:'supported',checks,findings:[]});
    }
    return 'CAD dimensions and exported model digests checked.';
  }
  if (input.includes('Sources: ')) return writePaper(input,outputs);
  if(!n)return call('read_file',{fileId:input.match(/dimension input ([0-9a-f-]{36})/)[1]});
  if(n===1)return call('call_external_mcp',{serverId:'cad-spacer/kernel',tool:'model_spacers',arguments:JSON.parse(outputs[0])});
  const response=JSON.parse(outputs[1]);
  measured=response.result.result.structuredContent;check(measured);return 'Three re-imported solids measured and saved.';
}
try{
  cad=spawn(process.env.ATHENA_CAD_PYTHON||'python3',[fileURLToPath(new URL('server.py',example)),'--port','0'],{stdio:['ignore','pipe','inherit']});
  const line=createInterface({input:cad.stdout});
  const [url]=await Promise.race([once(line,'line'),once(cad,'exit').then(()=>{throw Error('Start a Python with CadQuery installed.');})]);line.close();
  manifest.mcpServers[0].url=url;
  fixture=await createFixture(respond);
  const {rpc}=fixture;
  const {project}=await rpc('createProject',[{name:'CAD spacer study',researchWorkflow:true}]);
  const {sessionId}=await rpc('createSession',[{projectId:project.id,title:'Bore diameter sweep'}]);
  browser=await chromium.launch({executablePath:process.env.ATHENA_CHROMIUM||undefined});
  context=await browser.newContext({viewport:{width:1440,height:900},recordVideo:{dir:evidence,size:{width:1440,height:900}}});
  start=Date.now();const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(fixture.origin);
  await page.waitForFunction(()=>window.AthenaApp?.getState().workspace.sessionBound);
  await page.locator('[data-action="settings"]').first().click();
  await page.locator('#ast-tab-tools').click();
  await page.locator('[data-aex-detail="import"] summary').click();
  await page.locator('[data-aex-file]').setInputFiles({name:'cad-spacer.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(manifest))});
  await page.locator('[data-aex-action="install"]').click();
  const toggle=page.locator('[data-aex-action="toggle-plugin"][data-plugin="cad-spacer"]');
  await toggle.waitFor();assert.equal(await toggle.isDisabled(),true);
  mark('connection');await page.locator('[data-aex-action="check"][data-plugin="cad-spacer"]').click();
  await toggle.click();await page.getByText('Disable',{exact:true}).and(toggle).waitFor();
  await toggle.scrollIntoViewIfNeeded();await delay(650);await page.screenshot({path:join(evidence,'plugin.png')});await delay(1200);
  await page.getByRole('button',{name:'Close settings'}).click();
  const field=page.locator('#ac-prompt-input'),picker=page.locator('#ac-mention-listbox');
  await field.fill('Compare $25');assert.equal(await field.getAttribute('aria-expanded'),'false');
  await field.fill('$cad');await picker.getByText('$cad-spacer/measure',{exact:true}).waitFor();
  await field.press('Tab');assert.equal(await field.inputValue(),'$cad-spacer/measure ');
  await field.fill('Run $cad');await picker.getByText('$cad-spacer/measure',{exact:true}).waitFor();
  assert.equal(await picker.locator('button:visible').count(),1);
  mark('skill');await delay(650);await page.screenshot({path:join(evidence,'skill-picker.png')});await delay(1200);
  await field.press('Enter');assert.equal(await field.inputValue(),'Run $cad-spacer/measure ');
  await field.press('End');await field.pressSequentially('for a 30 mm outer diameter, 6 mm tall spacer. Compare 8, 12 and 16 mm bores; export STEP and independently verify the volumes.');
  await page.locator('.acm-file-input').setInputFiles({name:'spacer-dimensions.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(dimensions))});
  if (paperRequested) {await field.focus();await field.press('End');await field.pressSequentially(' Typeset a short paper using the article template.');}
  mark('send');await page.getByRole('button',{name:'Send message',exact:true}).click();
  const complete=await fixture.waitSnapshot(s=>(paperRequested || s.run.status==='succeeded') && s.attempts?.some(a=>a.workerRole==='verification' && a.status==='succeeded'),60000);
  const run=await rpc('researchFlow',[{projectId:project.id,sessionId}]);
  const ext=await rpc('getExtensions',[project.id]),uses=ext.skillUses.filter(u=>u.runId===run.runId&&u.skillId==='cad-spacer/measure');
  assert.equal(uses.length,1);assert.equal(uses[0].mode,'explicit');assert.equal(uses[0].status,'loaded');assert.equal(uses[0].sha256,hash(manifest.skills[0].body));
  assert.equal(run.tables[0].count,3);assert.equal(run.stages.find(s=>s.title==='Verify results').status,'Succeeded');
  const file=complete.artifacts.find(a=>a.id===run.tables[0].artifactId);assert.equal(file?.file?.name,'mcp-result.json');
  const response=await page.request.get(fixture.origin+file.location.uri);assert.ok(response.ok());
  const bytes=await response.body(),receipt=JSON.parse(bytes);assert.equal(receipt.tool,'model_spacers');check(receipt.result.structuredContent);
  await writeFile(join(evidence,'mcp-result.json'),bytes);
  for(const model of receipt.result.structuredContent.models){assert.match(model.filename,/^spacer-(8|12|16)mm\.step$/);assert.equal(hash(model.step),model.sha256);await writeFile(join(evidence,model.filename),model.step);}
  mark('verified');await page.getByText('3 bore diameters',{exact:true}).waitFor();
  await delay(500);await page.screenshot({path:join(evidence,'results.png')});await delay(1800);
  let paper;
  if (paperRequested) {
    await page.locator('[data-flow-tab="preview"]').click();
    await page.waitForFunction(()=>document.querySelector('.ac-flow-page')?.naturalWidth>0,{},{timeout:90000});
    const flow=await rpc('researchFlow',[{projectId:project.id,sessionId}]);
    const revision=await rpc('getDocument',[{projectId:project.id,documentId:flow.documentId,version:flow.version}]);
    assert.equal(revision.review.status,'approved');
    assert.equal(flow.stages.at(-1).status,'Succeeded');
    assert.equal(revision.text,manuscript);
    for (const file of [revision.compilation.tex,revision.compilation.pdf]) {
      const pending=page.waitForEvent('download');
      await page.getByRole('link',{name:file.name}).click();
      const download=await pending;
      const path=join(evidence,file.name);
      await download.saveAs(path);
      assert.equal(hash(await readFile(path)),file.sha256);
    }
    const pending=page.waitForEvent('download');
    await page.getByRole('button',{name:'Review JSON',exact:true}).click();
    await (await pending).saveAs(join(evidence,'review.json'));
    paper={documentId:flow.documentId,version:flow.version,review:revision.review.status,pdfSha256:revision.compilation.pdf.sha256};
    mark('paper');await page.screenshot({path:join(evidence,'paper.png')});await delay(1800);
  }
  await fixture.stopHost();await fixture.startHost();
  const restored=await rpc('getExtensions',[project.id]);assert.deepEqual(restored.skillUses,ext.skillUses);
  const disabled=await rpc('setPluginEnabled',[project.id,'cad-spacer',false,restored.revision]);
  assert.equal(disabled.skills.find(s=>s.id==='cad-spacer/measure').enabled,false);
  await page.reload();await page.waitForFunction(()=>window.AthenaApp?.getState().workspace.sessionBound);
  await field.fill('$cad-spacer');await delay(300);assert.equal(await field.getAttribute('aria-expanded'),'false');
  assert.deepEqual(errors,[]);assert.ok(loaded&&reviewed);
  await writeFile(join(evidence,'verification.json'),JSON.stringify({runId:run.runId,skillUse:uses[0],plugin:receipt.server,tool:receipt.tool,engineVersion:measured.version,dimensions,rows:measured.rows,
    paper,artifactSha256:hash(bytes),models:measured.models.map(({filename,sha256})=>({filename,sha256})),review:run.stages.find(s=>s.title==='Verify results'),markers,model:'controlled local provider',restored:true},null,2));
  console.log('Verified CAD and skill selection in Athena:',evidence);
}catch(error){
  const page=context?.pages()[0];if(page){await page.screenshot({path:join(evidence,'error.png')}).catch(()=>{});console.error((await page.locator('body').innerText()).slice(-1700));}
  throw error;
}finally{await context?.close();await browser?.close();await fixture?.close();cad?.kill();}
