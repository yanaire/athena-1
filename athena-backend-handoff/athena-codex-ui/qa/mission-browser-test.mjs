// Real host, scoped Pi sessions, CAD plugin and LaTeX. The local test provider
// computes the next bore from the first measured STEP volume.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createFixture } from './chat-browser-fixture.mjs';

const evidence=process.env.ATHENA_BROWSER_EVIDENCE||await mkdtemp(join(tmpdir(),'athena-mission-'));
await mkdir(evidence,{recursive:true});
const variant=process.env.ATHENA_MISSION_CASE||'paper';
const example=new URL('../../../examples/cad-spacer/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('plugin.json',example)));
const contract={protocol:'Hold outside diameter at 30 mm and height at 6 mm. Start at 8 mm bore, vary only its integer diameter. Measure one re-imported STEP solid per trial in cubic millimetres.',
  resultFile:'mcp-result.json',metricPath:['result','structuredContent','rows','0','volume_mm3'],
  measurementTool:{serverId:'cad-spacer/kernel',tool:'model_spacers'},direction:'at_most',target:3200,maxTrials:variant==='budget'?1:3};
if(variant==='missing')contract.metricPath=['result','undefined_metric'];
const expectedStatus={budget:'exhausted',missing:'stopped'}[variant]||'reached';
const hasPaper=expectedStatus==='reached';
const call=(name,args)=>({name,args});
const line=(msg,prefix)=>JSON.parse(msg.split(prefix)[1].split('\n')[0]);
const hash=s=>createHash('sha256').update(s).digest('hex');
const outline=['Methods','Results','Limitations'];
const dimensions={outer_mm:30,height_mm:6,starting_bore_mm:8,target_volume_mm3:3200};
const title='Adaptive bore selection for a fixed cylindrical spacer';
let plan,study,reviewId,interrupted=false,measuredBores=[],lastDraft='';
let cad,fixture,browser,context,page;
async function respond({coordinator,input,outputs,model}) {
  const n=outputs.length;
  await delay(220);
  if(coordinator && input.startsWith('Manuscript write request'))
    return n?'The manuscript run has finished.':call('compose_manuscript',{});
  if(coordinator){
    const resumed=input.startsWith('Continue this research request');
    if(!resumed && n===0)return call('plan_research',{objective:title,stages:['Set the volume threshold','Model one bore at a time','Verify both STEP volumes','Write up the result'],acceptanceCriteria:['Measured STEP volume ≤ 3200 cubic mm with height and outside diameter fixed.']});
    if(!resumed && n===1){plan=JSON.parse(outputs[0]).id;
      contract.fileIds=[input.match(/\{"fileId":"([^"]+)","name":"protocol.json"\}/)[1]];return call('run_experiment_mission',{missionId:plan,contract});}
    if(resumed && !n)return call('run_experiment_mission',{missionId:plan});
    const i=resumed?0:1;
    study=JSON.parse(outputs[i]);
    assert.equal(study.status,expectedStatus,JSON.stringify(study));
    if(n===i+1)return call('run_experiment_mission',{missionId:plan});
    assert.deepEqual(JSON.parse(outputs[i+1]),study);
    if(!hasPaper)return 'The run ended without meeting the target: '+study.reason;
    const ids=study.trials.map(t=>t.outcome.artifact.id);
    if(n===i+2)return call('get_research_board',{});
    if(n===i+3){const board=JSON.parse(outputs[i+2]);assert.deepEqual(board.experimentMission,study);
      for(const t of study.trials)assert.ok(board.evidence.some(e=>e.id===t.outcome.evidenceId));
      return call('request_review',{missionId:plan,question:'Check each STEP solid, its dimensions, digest and analytical volume against the threshold.',evidenceIds:study.trials.map(t=>t.outcome.evidenceId)});}
    if(n===i+4){reviewId=JSON.parse(outputs[i+3]).review.id;return call('wait_for_agents',{});}
    if(n===i+5)return call('prepare_research_paper',{reviewId,artifactIds:ids,inputIds:contract.fileIds,title,template:'article',outline});
    assert.ok(JSON.parse(outputs[i+5]).documentId);
    return 'Trial 2 met the target. Both CAD measurements passed independent review.';
  }
  if(input.includes('Select the next experiment under this fixed contract')){
    if(variant==='routing')assert.equal(model,'paper-reader');
    const history=line(input,'Trial history: '), prior=history.at(-1);
    if(variant==='restart' && prior && !interrupted){interrupted=true;await delay(2200);}
    if(prior?.outcome.error)return JSON.stringify({action:'stop',reason:'The configured result path is missing in the CAD output. Correct the metric specification before further experiments.'});
    const bore=prior?Math.ceil(Math.sqrt(8**2+4*(prior.outcome.value-contract.target)/(6*Math.PI))):8;
    return JSON.stringify({action:'experiment',instruction:'Run model_spacers at bore '+bore+' mm with the fixed dimensions.',
      reason:prior?'Use the observed excess volume to calculate the next whole-millimetre bore.':'Measure the baseline spacer.',
      parentTrial:prior?.number??null});
  }
  if(input.includes('Experiment instruction: ')){
    if(!n)return call('read_file',{fileId:contract.fileIds[0]});
    const spec=JSON.parse(outputs[0]);assert.deepEqual(spec,dimensions);
    if(n>1)return variant==='budget'?'I claim the volume was zero and the target was reached.':'Published the measured STEP result.';
    const bore=Number(input.match(/Experiment instruction: .*?bore (\d+) mm/)[1]);
    measuredBores.push(bore);
    return call('call_external_mcp',{...contract.measurementTool,arguments:{outer_mm:spec.outer_mm,height_mm:spec.height_mm,bores_mm:[bore]}});
  }
  if(input.includes('Review assignment: ')){
    const {targets,reviewId:id}=line(input,'Review assignment: ');
    if(n<targets.length){const t=targets[n];return call('read_file',t.kind==='file'?{fileId:t.id}:{artifactId:t.id});}
    if(n===targets.length){
      const data=[];
      for(const [i,t] of targets.entries()){
        assert.equal(hash(outputs[i]),t.sha256);
        try{const json=JSON.parse(outputs[i]);if(json.result?.structuredContent)data.push(json.result.structuredContent);}catch{}
      }
      assert.equal(data.length,2);assert.ok(outputs.includes(JSON.stringify(dimensions)));
      for(const d of data){
        const row=d.rows[0];assert.equal(d.outer_mm,30);assert.equal(d.height_mm,6);assert.equal(row.solid_count,1);
        assert.ok(Math.abs(row.volume_mm3-Math.PI*(30**2-row.bore_mm**2)*6/4)<1e-6);
        assert.equal(hash(d.models[0].step),d.models[0].sha256);
        if(input.includes('Check exact quotes'))assert.ok(lastDraft.includes(row.volume_mm3.toFixed(3)));
      }
      return call('submit_review',{reviewId:id,verdict:'supported',checks:['Claims: checked both imported volumes against the annular cylinder formula.',
        'Citations: verified the source digests and assigned bore dimensions.','Figures: checked both numeric values and their cubic-millimetre units.'],findings:[]});
    }
    return 'Submitted independent checks on the pinned sources.';
  }
  if(input.includes('Sources: ')){
    const sources=line(input,'Sources: ');
    if(n<sources.length)return call('read_file',{fileId:sources[n].fileId});
    const measured=sources.map((s,i)=>({source:s,data:JSON.parse(outputs[i])})).filter(x=>x.data.result);
    const rows=measured.map(x=>x.data.result.structuredContent.rows[0]);
    const finding=rows.map(row=>'The '+row.bore_mm+' mm bore gave '+row.volume_mm3.toFixed(3)+' cubic mm.');
    const sections=[{heading:outline[0],text:'CadQuery exported one spacer per trial to STEP and measured the volume after re-import. Outside diameter and height were held at 30 and 6 mm.'},
      {heading:outline[1],text:finding.join(' ')},{heading:outline[2],text:'These calculations describe ideal solid geometry. No physical tolerances were measured.'}];
    if(input.includes('Return only a JSON array'))return JSON.stringify(sections);
    if(n===sources.length){
      lastDraft='# '+title+'\n\n'+sections.map(s=>'## '+s.heading+'\n'+s.text).join('\n\n');
      return call('publish_manuscript',{text:lastDraft,links:rows.map((r,i)=>({kind:'claim',quote:finding[i],sourceId:measured[i].source.sourceId,excerpt:String(r.volume_mm3),locator:'rows[0].volume_mm3'}))});
    }
    return 'Published measured volumes and source links.';
  }
  throw Error('Unexpected assignment: '+input.slice(0,200));
}

try{
  cad=spawn(process.env.ATHENA_CAD_PYTHON||'python3',[fileURLToPath(new URL('server.py',example)),'--port','0'],{stdio:['ignore','pipe','inherit']});
  const lines=createInterface({input:cad.stdout});
  const [url]=await Promise.race([once(lines,'line'),once(cad,'exit').then(()=>{throw Error('CadQuery is required.');})]);lines.close();
  manifest.mcpServers[0].url=url;
  fixture=await createFixture(respond,{modelConcurrency:variant==='restart'?1:2,streamSections:variant==='draft'});
  const {rpc}=fixture;
  if(variant==='routing'){
    const provider=await rpc('registerCompatibleEndpoint',[{name:'Test endpoint',endpoint:fixture.providerEndpoint}]);
    const profile=async(name,modelId)=>rpc('saveModelProfile',[{provider:provider.id,name,modelId,thinkingLevel:'off'}]);
    const main=await profile('Coordinator','browser-fixture'),planner=await profile('Mission planner','paper-reader');
    await rpc('setAppModelProfile',[main.id]);
    await rpc('setWorkerModelPreference',[{role:'mission',profileId:planner.id,thinkingLevel:'off'}]);
  }
  const {project}=await rpc('createProject',[{name:'Adaptive CAD mission',researchWorkflow:true}]);
  const {sessionId}=await rpc('createSession',[{projectId:project.id,title:'Spacer volume constraint'}]);
  const scope={projectId:project.id,sessionId};
  const report=()=>rpc('researchFlow',[scope]);
  let ext=await rpc('getExtensions',[project.id]);
  ext=await rpc('installPlugin',[project.id,manifest,ext.revision]);
  ext=await rpc('checkMcpServer',[project.id,manifest.id,'kernel',ext.revision]);
  await rpc('setPluginEnabled',[project.id,manifest.id,true,ext.revision]);
  browser=await chromium.launch({executablePath:process.env.ATHENA_CHROMIUM||undefined});
  context=await browser.newContext({viewport:{width:1440,height:900},recordVideo:{dir:evidence,size:{width:1440,height:900}}});
  page=await context.newPage();await page.goto(fixture.origin);
  await page.waitForFunction(()=>window.AthenaApp?.getState().workspace.sessionBound);
  if(variant==='draft')await page.evaluate(()=>{
    window.draftSamples=[];
    const box=document.querySelector('.ac-live-manuscript');
    new MutationObserver(()=>{
      if(!box.hidden && box.querySelector('strong').textContent==='Writing manuscript'){
        const text=box.querySelector('pre').textContent;
        if(text && text!==window.draftSamples.at(-1))window.draftSamples.push(text);
      }
    }).observe(box,{subtree:true,characterData:true,childList:true,attributes:true});
  });
  await page.locator('#ac-prompt-input').fill('Use $cad-spacer/measure to find a whole-mm bore with spacer volume ≤ 3200 mm³. Fix OD 30 mm and height 6 mm. Begin at 8 mm, adapt from measured STEP results, independently review and typeset the paper.');
  await page.locator('.acm-file-input').setInputFiles({name:'protocol.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(dimensions))});
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  const details=page.locator('.ac-flow-stages > li > details').filter({has:page.locator('summary strong',{hasText:/^Experiment$/})});
  await details.locator(':scope > summary').evaluate(summary=>summary.click());
  if(variant==='routing'){
    const snap=await fixture.waitSnapshot(s=>s.attempts?.some(t=>t.workerRole==='mission'));
    const planner=snap.attempts.find(t=>t.workerRole==='mission');
    assert.equal(planner.model.modelId,'paper-reader');assert.equal(planner.model.thinkingLevel,'off');
    assert.equal(snap.run.model.modelId,'browser-fixture');
    // The next planner turn in this same run must retain its original selection.
    await rpc('setWorkerModelPreference',[{role:'mission',profileId:null,thinkingLevel:null}]);
  }
  if(variant==='restart'){
    await fixture.waitSnapshot(()=>interrupted);
    const first=(await report()).experimentMission.trials[0];
    await fixture.stopHost();await fixture.startHost();
    const restored=await report();assert.deepEqual(restored.experimentMission.trials[0],first);
    await rpc('resumeResearch',[{...scope,runId:restored.runId,expectedAttemptId:restored.checkpoint}]);
  }
  if(variant==='draft'){
    const draft=page.getByRole('region',{name:'Live manuscript'});
    await draft.waitFor({timeout:90000});
    await page.waitForFunction(()=>window.draftSamples.some((text,i,all)=>i>0 && text.startsWith(all[i-1]) && text.length>all[i-1].length),null,{timeout:20000});
    const samples=await page.evaluate(()=>window.draftSamples);
    assert.match(samples[0],/^## Methods/);
    await page.screenshot({path:join(evidence,'live-draft.png')});
  }
  if(!hasPaper)await fixture.waitSnapshot(s=>s.run?.status==='succeeded');
  else {
    // Wait for model validation errors as well as the rendered typeset edition.
    await fixture.waitSnapshot(s=>s.run?.status==='succeeded' && s.tasks?.some(t=>t.title==='Review manuscript 1'&&t.status==='succeeded'),110000);
    await page.getByText('LaTeX',{exact:true}).first().waitFor();
  }
  assert.deepEqual(fixture.failures,[]);
  const final=await report();assert.equal(final.experimentMission.status,expectedStatus);
  assert.deepEqual(measuredBores,hasPaper?[8,15]:[8]);
  assert.equal(final.experimentMission.trials.filter(t=>t.worker).length,measuredBores.length);
  if(variant==='missing'){assert.ok(final.experimentMission.trials[0].outcome.candidate.sha256);assert.equal(final.experimentMission.best,null);}
  if(variant==='budget'){assert.match(final.experimentMission.trials[0].workerNote,/volume was zero/);assert.ok(final.experimentMission.best.value>contract.target);}
  for(const trial of final.experimentMission.trials){
    const ref=trial.outcome?.artifact??trial.outcome?.candidate;
    if(!ref)continue;
    const artifact=final.artifacts.find(row=>row.id===ref.id && row.version===ref.version);
    const response=await page.request.get(fixture.origin+artifact.uri);
    assert.ok(response.ok());const bytes=await response.body();assert.equal(hash(bytes),ref.sha256);
    await writeFile(join(evidence,'trial-'+trial.number+'.json'),bytes);
  }
  const stage=final.stages.find(s=>s.title==='Experiment');
  assert.equal(stage.status,variant==='missing'?'Stopped':variant==='budget'?'Waiting for input':'Succeeded');
  await details.evaluate(d=>{d.open=true;d.scrollIntoView({block:'center'});});
  if(variant!=='missing')await page.getByText(/Best measured value:/).waitFor();
  await delay(1500);
  await page.screenshot({path:join(evidence,'trials.png')});
  if(hasPaper){
    await page.locator('[data-flow-tab="preview"]').click();
    await page.waitForFunction(()=>document.querySelector('.ac-flow-page')?.naturalWidth>0,{},{timeout:60000});
    const r=await report();const edition=await rpc('getDocument',[{projectId:project.id,documentId:r.documentId,version:r.version}]);
    assert.equal(edition.review.status,'approved');
    for(const [suffix,file] of [['tex',edition.compilation.tex],['pdf',edition.compilation.pdf]]){
      const download=page.waitForEvent('download');
      await page.getByRole('link',{name:file.name}).click();
      const path=join(evidence,'paper.'+suffix);await (await download).saveAs(path);
      assert.equal(hash(await readFile(path)),file.sha256);
    }
    const review=page.waitForEvent('download');
    await page.getByRole('button',{name:'Review JSON',exact:true}).click();
    await (await review).saveAs(join(evidence,'review.json'));
    await page.screenshot({path:join(evidence,'paper.png')});await delay(1300);
    if(variant==='draft'){
      const handoff=page.locator('.ac-stream-handoff').last();
      assert.equal(await handoff.locator('.ac-stream-text').isVisible(),false);
      assert.match(await handoff.textContent(),/Call compose_manuscript/);
      const card=page.locator('details[data-aw-attempt]').filter({has:page.locator('.aw-attempt-heading strong',{hasText:/^Review manuscript 1$/})}).last();
      const heading=card.locator(':scope > summary');
      const activity=card.locator('xpath=ancestor::details[contains(@class,"ac-stream-activity")][1]');
      const progress=activity.locator(':scope > summary');
      await progress.scrollIntoViewIfNeeded();
      assert.equal(await activity.getAttribute('open'),null);
      assert.equal(await heading.isVisible(),false);
      await page.screenshot({path:join(evidence,'activity-summary.png')});
      await delay(1500);await progress.click();await heading.waitFor({state:'visible'});
      assert.equal(await card.getAttribute('open'),null);
      assert.equal(await card.locator('.aw-attempt-result').isVisible(),false);
      await page.screenshot({path:join(evidence,'activity-closed.png')});
      await delay(1100);await heading.focus();await heading.press('Enter');
      const reads=card.locator('[data-pi-tool="read_file"]');
      const row=reads.filter({has:page.locator('[data-aw-log]',{hasText:'starting_bore_mm'})}).first();
      await card.locator('.aw-agent-events').evaluate(el=>el.scrollIntoView({block:'center'}));
      await row.locator(':scope > summary').waitFor({state:'visible'});
      assert.equal(await row.locator('[data-aw-log]').isVisible(),false);
      assert.equal(await card.locator('[data-pi-tool="read_file"][open]').count(),0);
      await page.screenshot({path:join(evidence,'activity-list.png')});
      await delay(1100);await row.locator(':scope > summary').click();
      await row.locator('[data-aw-log]').waitFor({state:'visible'});
      assert.ok((await row.locator('[data-aw-log]').textContent()).trim());
      assert.equal(await card.locator('[data-pi-tool="read_file"][open]').count(),1);
      await row.locator('[data-aw-log]').evaluate(el=>el.scrollIntoView({block:'center'}));
      await page.screenshot({path:join(evidence,'activity-result.png')});
      await delay(1100);await row.locator(':scope > summary').focus();await row.locator(':scope > summary').press('Space');
      assert.equal(await row.locator('[data-aw-log]').isVisible(),false);
      await heading.click();assert.equal(await row.isVisible(),false);
      await progress.click();assert.equal(await heading.isVisible(),false);await delay(1300);
    }

  }
  await fixture.stopHost();await fixture.startHost();
  const after=await report();assert.deepEqual(final.experimentMission,after.experimentMission);
  await writeFile(join(evidence,'verification.json'),JSON.stringify({variant,model:'controlled local provider',bores:measuredBores,
    mission:after.experimentMission,stages:after.stages,recovered:true},null,2));
  console.log('Verified '+variant+' mission at '+evidence);
} catch(e) {
  console.error('Provider errors:',fixture?.failures);
  if(page){await page.screenshot({path:join(evidence,'error.png')}).catch(()=>{});console.error((await page.locator('body').innerText()).slice(-1400));}
  throw e;
} finally {await context?.close();await browser?.close();await fixture?.close();cad?.kill();}
