// Run explicitly with network access to the Journal of Open Source Software archive.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createFixture } from './chat-browser-fixture.mjs';

const doi='10.21105/joss.00024', call=(name,args)=>({name,args});
let saved,readEdition,searchCount=0;
const started=Promise.withResolvers(),proceed=Promise.withResolvers();
const fixture=await createFixture(async({coordinator,input,outputs,model})=>{
  await delay(400);
  if(!coordinator){
    assert.equal(model,'paper-reader');
    if(!outputs.length){searchCount++;return call('search_research_literature',{mode:'doi',term:doi});}
    const result=JSON.parse(outputs[0]);
    assert.ok(result.saved?.[0]?.original?.endsWith('.pdf'),outputs[0]);
    saved=result.saved[0];
    return 'Archived the publisher PDF of corner.py, by Daniel Foreman-Mackey, in this project.';
  }
  assert.equal(model,'browser-fixture');
  if(input.startsWith('Find and save')){
    if(!outputs.length){started.resolve();await proceed.promise;}
    if(!outputs.length)return call('plan_research',{objective:'Retain the requested version of the article',stages:['Resolve the DOI','Archive the accessible publisher edition'],acceptanceCriteria:['The saved edition contains the requested DOI and original PDF.']});
    if(outputs.length===1)return call('spawn_agent',{role:'literature',title:'Retrieve the published article',prompt:'Look up DOI '+doi+' and retain the accessible original.'});
    if(outputs.length===2)return call('wait_for_agents',{});
    assert.equal(JSON.parse(outputs[2]).tasks[0].status,'succeeded');
    return 'The published article is saved. Open Knowledge to inspect its full text and download the original PDF.';
  }
  if(!outputs.length)return call('search_project_library',{query:'corner'});
  const record=JSON.parse(outputs[0])[0];
  assert.equal(record.sourceId,saved.sourceId);
  if(outputs.length===1)return call('read_project_paper',{sourceId:record.sourceId,version:record.version});
  const paper=JSON.parse(outputs[1]);
  assert.equal(paper.entry.version,saved.version);
  assert.match(paper.text,/Daniel Foreman-Mackey/);
  assert.match(paper.text,/multidimensional/i);
  readEdition=paper.entry;
  return 'The saved article describes corner.py for visualizing multidimensional samples using a scatterplot matrix. Source: Daniel Foreman-Mackey (2016), DOI '+doi+'.';
});
const folder=await mkdtemp(join(tmpdir(),'athena-library-workspace-'));
const evidence=process.env.ATHENA_BROWSER_EVIDENCE||await mkdtemp(join(tmpdir(),'athena-library-proof-'));
await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.ATHENA_CHROMIUM||undefined});
const context=await browser.newContext({viewport:{width:1440,height:900},recordVideo:{dir:evidence,size:{width:1440,height:900}}});
const start=Date.now(),markers=[];
const mark=step=>markers.push({step,seconds:(Date.now()-start)/1000});
const page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const {rpc}=fixture,ready=()=>page.waitForFunction(()=>window.AthenaApp?.getState().workspace.sessionBound);
async function send(message){
  await page.locator('#ac-prompt-input').fill(message);
  await delay(1000);
  await page.getByRole('button',{name:'Send message',exact:true}).click();
}
try{
  const provider=await rpc('registerCompatibleEndpoint',[{name:'Acceptance provider',endpoint:fixture.providerEndpoint}]);
  const profile=async(name,modelId)=>rpc('saveModelProfile',[{provider:provider.id,name,modelId,thinkingLevel:'off'}]);
  const main=await profile('Research coordinator','browser-fixture'),reader=await profile('Paper reader','paper-reader');
  await rpc('setAppModelProfile',[main.id]);
  await page.goto(fixture.origin);
  await page.getByRole('button',{name:'Add project'}).click();
  mark('project');
  await page.locator('#ac-project-name').fill('Scientific visualization');
  await page.locator('#ac-project-folder').fill(folder);
  await delay(700);
  await page.locator('#ac-dialog-primary').click();
  await ready();
  const {projectId,sessionId}=await rpc('getSnapshot');
  await page.locator('[data-action="settings"]').first().click();
  await page.locator('#ast-tab-models').click();
  const role=page.locator('[data-role-profile="literature"]'),level=page.locator('[data-role-level="literature"]');
  mark('settings');
  await role.selectOption(reader.id);
  await level.selectOption('off');
  await page.waitForFunction(()=>document.querySelector('[data-role-level="literature"]')?.value==='off'&&!document.querySelector('[data-role-level="literature"]')?.disabled);
  assert.equal((await rpc('listModelProfiles')).workerRoles.find(r=>r.role==='literature').thinkingLevel,'off');
  assert.equal(await page.locator('[data-role-profile]').count(),(await rpc('listModelProfiles')).workerRoles.length);
  await page.locator('[data-role-profile="mission"]').waitFor();
  await page.locator('#amp-routing-title').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(evidence,'role-settings.png')});await delay(1800);
  await page.getByRole('button',{name:'Close settings'}).click();
  mark('send');
  await send('Find and save the paper with DOI '+doi+' to this project. Delegate the lookup to the literature researcher.');
  await Promise.race([started.promise,delay(10000,undefined,{ref:false}).then(()=>{throw Error('Parent turn did not start.');})]);
  await rpc('setWorkerModelPreference',[{role:'literature',profileId:main.id,thinkingLevel:null}]);
  proceed.resolve();
  const research=await fixture.waitSnapshot(s=>Boolean(saved)&&s.run.status==='succeeded',50000);
  const child=research.attempts.find(a=>a.workerRole==='literature');
  assert.equal(child.model.modelId,'paper-reader');assert.equal(child.model.source,'role');
  assert.equal(research.run.model.profileId,main.id);
  mark('library');
  await page.locator('#ac-knowledge-nav').click();
  await page.locator('[data-akn-source]').filter({hasText:'corner.py'}).click();
  await page.locator('.akn-detail-title').scrollIntoViewIfNeeded();await delay(1700);
  const original=page.getByRole('link',{name:'Download original'});await original.scrollIntoViewIfNeeded();
  await page.screenshot({path:join(evidence,'project-library.png')});await delay(1800);
  mark('download');
  const downloadUri=await original.getAttribute('href');assert.ok(downloadUri.startsWith('/api/artifacts/'+sessionId+'/library-'));
  const waiting=page.waitForEvent('download');await original.click();await (await waiting).saveAs(join(evidence,'publisher.pdf'));
  const downloaded=await readFile(join(evidence,'publisher.pdf'));
  assert.equal(downloaded.subarray(0,5).toString(),'%PDF-');
  assert.deepEqual(downloaded,await readFile(join(folder,'Athena Library',projectId,saved.original)));
  const note=await readFile(join(folder,'Athena Library',projectId,saved.file),'utf8');
  assert.match(note,/Daniel Foreman-Mackey/);await writeFile(join(evidence,'saved-note.md'),note);
  mark('restart');
  await fixture.stopHost();await fixture.startHost();
  const next=await rpc('createSession',[{projectId,title:'Interpret the saved article'}]);assert.notEqual(next.sessionId,sessionId);
  await page.reload();await ready();
  mark('reuse');
  await send('Using our archived paper, what does corner.py visualize? Cite the saved edition.');
  await fixture.waitSnapshot(s=>s.sessionId===next.sessionId&&Boolean(readEdition)&&s.run.status==='succeeded');
  mark('citation');
  await page.getByText(/The saved article describes corner.py/).first().waitFor();
  await delay(1800);await page.screenshot({path:join(evidence,'new-conversation.png')});
  assert.equal(searchCount,1);assert.deepEqual(errors,[]);
  const sha256=createHash('sha256').update(downloaded).digest('hex');
  assert.equal(sha256,readEdition.original.sha256);
  const foreign=(await rpc('createProject',[{name:'Separate project',folder,researchWorkflow:true}])).project;
  const isolated=await rpc('createSession',[{projectId:foreign.id,title:'Isolated conversation'}]);
  assert.equal((await rpc('listLibrarySources',[{projectId:foreign.id}])).sources.length,0);
  assert.equal((await fetch(fixture.origin+downloadUri)).ok,false);
  assert.equal((await fetch(fixture.origin+'/api/artifacts/'+isolated.sessionId+'/library-'+saved.sourceId)).ok,false);
  await writeFile(join(evidence,'library-acceptance.json'),JSON.stringify({markers,doi,bytes:downloaded.length,sha256,projectId,sessionId,nextSession:next.sessionId,edition:readEdition,externalSearchCount:searchCount,main:research.run.model,worker:child.model,workerRole:child.workerRole,isolatedProjects:true,keptWorkerAfterSettingChanged:true,fixture:'Real Node host, Pi sessions, publisher lookup and Chromium UI. Controlled local model replies.'},null,2));
  console.log('Verified library and worker settings:',evidence);
}catch(error){
  await page.screenshot({path:join(evidence,'error.png')}).catch(()=>{});
  console.error(errors,(await page.locator('body').innerText()).slice(-2500));throw error;
}finally{proceed.resolve();await context.close();await browser.close();await fixture.close();await rm(folder,{recursive:true,force:true});}
