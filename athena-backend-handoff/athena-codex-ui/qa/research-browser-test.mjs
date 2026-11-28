// Controlled model turns; actual Pi, Chromium MCP page read, circuit worker, WASI, SQLite and TeX.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createFixture } from './chat-browser-fixture.mjs';

const evidence=process.env.ATHENA_BROWSER_EVIDENCE||await mkdtemp(join(tmpdir(),'research-acceptance-'));
await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.ATHENA_CHROMIUM||undefined});
const context=await browser.newContext({viewport:{width:1440,height:900},recordVideo:{dir:evidence,size:{width:1440,height:900}}});
const videoStart=Date.now(),markers=[];
const mark=step=>markers.push({step,seconds:(Date.now()-videoStart)/1000});
const preliminaryObserved=Promise.withResolvers();
const screencast=process.env.ATHENA_SCREENCAST==='1';
const background=process.env.ATHENA_BACKGROUND_RESEARCH==='1';
const notebookOpened=Promise.withResolvers();
const autoRecovery=background || process.env.ATHENA_AUTORECOVERY==='1';
const notePrompt='Check that this separate conversation is responsive.';
const evidenceReturn=process.env.ATHENA_EVIDENCE_RETURN==='1';
const loseHandoffAck=process.env.ATHENA_HANDOFF_ACK_LOSS==='1';
let handedOffDocument;
const missingEvidence='Measure the time to reach half the input voltage and compare it with the circuit time constant.';
let rejectedPaperReview;
const missingCheck='Independently confirm the method page before accepting the measured voltages.';
let offlineUntil=0, disconnectedReview, unavailableRequests=0;
const paperVerdicts=[];
const page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const reference=await browser.newPage();
const digest=s=>createHash('sha256').update(s).digest('hex');
const config={schemaVersion:1,resistanceOhm:10000,capacitanceFarad:1e-7,inputVolt:1,sampleTimesSeconds:[0,0.0005,0.001,0.002,0.005]};
const title='Charging an ideal first-order RC circuit';
const headings=['Introduction','Methods','Results','Limitations'];
const intro='We asked how rapidly a first-order low-pass circuit approaches a unit step.';
const method='The circuit used a 10 kOhm resistor and a 100 nF capacitor. Five time points covered zero through five time constants.';
const templateFile=process.env.ATHENA_LATEX_TEMPLATE_FILE;
const selectedTemplate=templateFile?basename(templateFile):'article';
const referenceQuote='const timeConstantSeconds = r * c;';
const citeLibrary=process.env.ATHENA_CITE_LIBRARY==='1';
const selectInputs=process.env.ATHENA_HANDOFF_CASE==='inputs';
const longPages=process.env.ATHENA_HANDOFF_CASE==='long-pages';
const recordedPages=[];
const pageMarker='Archived page excerpt ';
const longPassage=index=>(pageMarker+index+' '+referenceQuote+' ').repeat(500).slice(0,12000);
let browserReads=0;
const libraryClaim='Foreman-Mackey (2016) describes scatterplot matrices for multidimensional samples.';
let libraryEdition;
const sourceUrl='https://raw.githubusercontent.com/yanaire/athena/feefe81e49211151549b793b4ff029c2d797fe7d/runtime/rc-worker.mjs';
const sha= 'feefe81e49211151549b793b4ff029c2d797fe7d';
let visitedUrl,rc,markdown,sections,guiCalls=0,interrupted=false;
const supersedeRevision=process.env.ATHENA_INTERRUPT_REVISION==='supersede';
const interruptRevision=supersedeRevision||process.env.ATHENA_INTERRUPT_REVISION==='1',editorReleased=Promise.withResolvers();
let stoppedRevision,editorStarted=false;
const gui=process.env.ATHENA_GUI_CHECK==='1',interrupt=process.env.ATHENA_INTERRUPT_REVIEW==='1';
const call=(name,args)=>({name,args});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const parser=(input,marker)=>JSON.parse(input.split(marker)[1].split('\n')[0]);
const upstream=process.env.ATHENA_PUBLIC_METHOD==='1';
const mcp=createServer(async(req,res)=>{
  try{
    if(req.method==='GET'&&req.url.split('?')[0]==='/method'){
      const index=new URL(req.url,'http://localhost').searchParams.get('edition');
      res.writeHead(200,{'content-type':'text/plain'});res.end(index?longPassage(index):await readFile(new URL('../../../runtime/rc-worker.mjs',import.meta.url)));return;
    }
    if(req.method==='DELETE'){res.writeHead(202).end();return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const m=JSON.parse(Buffer.concat(chunks)),reply=result=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
    if(m.method==='initialize' && Date.now()<offlineUntil){unavailableRequests++;res.writeHead(503).end('Local reference plugin temporarily offline');return;}
    if(m.method.startsWith('notifications/')){res.writeHead(202).end();return;}
    if(m.method==='initialize'){reply({protocolVersion:'2025-06-18',serverInfo:{name:'Acceptance page reader',version:'1.0'},capabilities:{tools:{}}});return;}
    if(m.method==='tools/list'){reply({tools:[{name:'read_method_page',description:'Open the fixed RC reference page in Chromium and read its contents.',inputSchema:{type:'object',properties:{},additionalProperties:false}},...(gui?[{name:'click_circuit_calculator',description:'Click Calculate in a dedicated native test window and read its output.',inputSchema:{type:'object',properties:{input:{type:'object'}},required:['input'],additionalProperties:false}}]:[])]});return;}
    assert.equal(m.method,'tools/call');
    if(gui&&m.params.name==='click_circuit_calculator'){
      const args=m.params.arguments.input;assert.deepEqual(args,config);
      const job=new Promise((resolve,reject)=>{
        const child=execFile('xvfb-run',['-a','python3',fileURLToPath(new URL('research-gui-check.py',import.meta.url))],{timeout:8000},(err,stdout)=>err?reject(err):resolve(JSON.parse(stdout)));
        child.stdin.end(JSON.stringify(args));
      });
      const result=await job;guiCalls++;reply({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result});return;
    }
    assert.equal(m.params.name,'read_method_page');
    const url=longPages?visitedUrl+'?edition='+(++browserReads):visitedUrl;
    const response=await reference.goto(url,{timeout:10000});assert.equal(response.status(),200);
    const content=await reference.locator('body').innerText();
    assert.ok(content.includes(referenceQuote));
    reply({content:[{type:'text',text:content}],structuredContent:{url:reference.url(),retrievedAt:new Date().toISOString(),coverage:'Complete RC worker source file',text:content}});
  }catch(e){res.writeHead(500).end(String(e));}
});
mcp.listen(0,'127.0.0.1');await once(mcp,'listening');
const address='http://127.0.0.1:'+mcp.address().port;
visitedUrl=upstream?sourceUrl:address+'/method';
if(upstream){
  // The CI proxy root is trusted by the OS. Fetch the visited URL with system TLS, then render those bytes in Chromium.
  await reference.route(sourceUrl,async route=>{
    const {stdout}=await promisify(execFile)('curl',['--fail','--silent','--show-error','--max-time','8','--proto','=https',sourceUrl]);
    await route.fulfill({status:200,contentType:'text/plain',body:stdout});
  });
}
async function respond({coordinator,input,outputs}){
  await pause(screencast?650:220);
  const n=outputs.length;
  if(background && coordinator && input.startsWith(notePrompt))return 'This notes conversation is ready.';
  if(coordinator&&input==='Separate research request')return 'Ready for another topic.';
  if(longPages && (input.startsWith('Manuscript write request') || input.includes('Sources: '))){
    assert.ok(input.length<32768,'A source manifest must fit the worker dispatch budget.');assert.ok(!input.includes(pageMarker));
  }
  if(coordinator&&input.startsWith('Manuscript write request'))return n?'The manuscript review and publication have settled.':call('compose_manuscript',{});
  if(evidenceReturn && coordinator && input.startsWith('Continue this research request')){
    assert.ok(input.includes(missingEvidence));
    if(!n)return call('get_research_board',{});
    const board=JSON.parse(outputs[0]),old=board.reviews.find(r=>r.verdict==='supported');
    const inputIds=old.targets.filter(t=>t.kind==='file').map(t=>t.id),first=old.targets.find(t=>t.kind==='artifact').id;
    const prepare=(reviewId,artifactIds)=>call('prepare_research_paper',{reviewId,artifactIds,inputIds,title,template:selectedTemplate,outline:headings});
    if(n===1)return prepare(old.id,[first]);
    if(n===2){
      assert.match(outputs.at(-1),/newly collected/);
      return call('spawn_agent',{role:'experiment',title:'Estimate half-rise time',prompt:'Measure the half-rise time from circuit.json by bisection.',fileIds:inputIds});
    }
    if(n===3)return call('wait_for_agents',{});
    const extra=JSON.parse(outputs[3]).tasks.flatMap(t=>t.artifacts).find(a=>a.name==='half-time.json');
    assert.ok(extra);
    if(n===4)return call('add_research_evidence',{missionId:old.missionId,title:'Half-rise time by bisection',fileIds:inputIds,artifactIds:[first,extra.id]});
    if(n===5)return call('request_review',{missionId:old.missionId,evidenceIds:[JSON.parse(outputs[4]).id],question:'Verify the half-rise measurement against ln(2) times RC and the original five measurements.'});
    if(n===6)return call('wait_for_agents',{});
    if(n===7)return prepare(JSON.parse(outputs[5]).review.id,[first,extra.id]);
    assert.ok(JSON.parse(outputs[7]).documentId);
    return 'The additional measurement and independent verification were handed back to the manuscript.';
  }
  if(autoRecovery && coordinator && input.startsWith('Continue this research request')){
    assert.ok(input.includes(missingCheck),'The new coordinator attempt must receive the independent finding.');
    if(!n)return call('get_research_board',{});
    const board=JSON.parse(outputs[0]),failed=board.reviews.find(r=>r.id===disconnectedReview);
    assert.equal(failed.verdict,'changes_required');
    if(n===1)return call('request_review',{missionId:failed.missionId,evidenceIds:failed.evidenceIds,
      question:'Reconnect to the method page, then independently check all five voltages against the original input.'});
    if(n===2)return call('wait_for_agents',{});
    if(n===3)return call('prepare_research_paper',{reviewId:JSON.parse(outputs[1]).review.id,
      artifactIds:failed.targets.filter(t=>t.kind==='artifact').map(t=>t.id),
      inputIds:failed.targets.filter(t=>t.kind==='file').map(t=>t.id),title,template:selectedTemplate,outline:headings});
    assert.ok(JSON.parse(outputs[3]).documentId);
    return 'The independent check now supports the original measurements; the manuscript can proceed.';
  }
  if(coordinator){
    const file=JSON.parse(input.match(/\{"fileId":"[^"]+","name":"circuit.json"\}/)[0]).fileId;
    if(n===0)return call('plan_research',{objective:title,stages:['Read method','Sample transient','Validate against analytical response'],acceptanceCriteria:['Each of the five computed voltages must match 1-exp(-t/RC) within 1e-12 V.']});
    if(n===1)return call('spawn_agent',{role:'literature',title:'Read the reference implementation',prompt:'Use the connected page reader to inspect the RC reference.',fileIds:[]});
    if(n===2)return call('spawn_agent',{role:'experiment',title:'Calculate the step response',prompt:'Run calculate_rc_response on the attached circuit.',fileIds:[file]});
    if(n===3)return call('save_research_draft',{heading:'Introduction',text:intro});
    if(n===4)return call('save_research_draft',{heading:'Methods',text:method});
    if(n===5){if(!interrupt)await preliminaryObserved.promise;return call('wait_for_agents',{});}
    const joined=JSON.parse(outputs[5]).tasks;
    const result=joined.flatMap(t=>t.artifacts).find(a=>a.name==='rc-response.json'),ref=joined.flatMap(t=>t.artifacts).find(a=>a.name==='mcp-result.json');
    assert.ok(result&&ref,JSON.stringify(joined));
    const extraPages=longPages?2:0;
    if(longPages&&n===6)return recordedPages.map(({artifactId,url,excerpt})=>call('record_browser_source',{artifactId,url,excerpt,claim:'The calculation defines its time constant as resistance times capacitance.'}));
    if(n===6)return call('record_browser_source',{artifactId:ref.id,url:visitedUrl,excerpt:referenceQuote,claim:'The calculation defines its time constant as resistance times capacitance.'});
    if(n===7+extraPages)return call('add_research_evidence',{missionId:JSON.parse(outputs[0]).id,title:'Five computed conditions',fileIds:[file],artifactIds:[result.id]});
    if(n===8+extraPages)return call('request_review',{missionId:JSON.parse(outputs[0]).id,evidenceIds:[JSON.parse(outputs[7+extraPages]).id],question:'Independently calculate all voltages from the input and check the absolute errors.'});
    if(n===9+extraPages)return call('wait_for_agents',{});
    if(n===10+extraPages)return call('record_experiment_table',{artifactId:result.id,path:['samples'],condition:'sampled times'});
    if(autoRecovery && n===11){
      // Hold the first controlled coordinator until navigation has bound the
      // other conversation. Any recovery attempt must then run in the background.
      if(background)await notebookOpened.promise;
      return 'The local method reader disconnected and independent review requested changes. The five measured voltages have been saved.';
    }
    const prepare=pageSourceIds=>call('prepare_research_paper',{reviewId:JSON.parse(outputs[8+extraPages]).review.id,artifactIds:[result.id],inputIds:[file],title,template:selectedTemplate,outline:headings,
      ...(pageSourceIds?{pageSourceIds}:{}),...(citeLibrary?{librarySources:[{sourceId:libraryEdition.sourceId,version:libraryEdition.version,claim:libraryClaim}]}:{})});
    if(n===11+extraPages && selectInputs)return prepare(['unknown-page']);
    const first=(selectInputs?12:11)+extraPages;
    if(n===first){
      if(selectInputs)assert.match(outputs[11],/visited page source IDs/);
      const handoff=prepare(selectInputs?[]:undefined);
      return [handoff,handoff];
    }
    assert.equal(n,first+2);
    const receipt=JSON.parse(outputs[first]);assert.ok(receipt.documentId);assert.equal(JSON.parse(outputs[first+1]).documentId,receipt.documentId);
    if(loseHandoffAck){
      handedOffDocument=receipt.documentId;
      return Response.json({error:{message:'Coordinator acknowledgment was lost after manuscript handoff.'}},{status:400});
    }
    return 'The verified circuit results have been handed to the manuscript workflow.';
  }
  if(input.includes('Review assignment: ')){
    const {targets:evidenceTargets,contextFiles=[],reviewId}=parser(input,'Review assignment: ');
    const targets=[...evidenceTargets,...contextFiles];
    if(n<targets.length){const t=targets[n];return call('read_file',t.kind==='file'?{fileId:t.id}:{artifactId:t.id});}
    const paperReview=input.includes('Check exact quotes');
    if(autoRecovery && !paperReview && n===targets.length){
      if(!disconnectedReview){disconnectedReview=reviewId;offlineUntil=Date.now()+3000;}
      return call('call_external_mcp',{serverId:'page-reader/browser',tool:'read_method_page',arguments:{}});
    }
    if(autoRecovery && !paperReview && n===targets.length+1){
      if(reviewId===disconnectedReview){
        assert.match(outputs.at(-1),/503/);
        return call('submit_review',{reviewId,verdict:'changes_required',checks:['Five original samples read.'],findings:[missingCheck]});
      }
      const verifiedPage=JSON.parse(outputs.at(-1)).result.result.structuredContent;
      assert.equal(verifiedPage.url,visitedUrl);assert.ok(verifiedPage.text.includes(referenceQuote));
    }
    if(!paperReview&&gui&&n===targets.length){
      const original=JSON.parse(outputs.find(t=>t.includes('"resistanceOhm"')));
      return call('call_external_mcp',{serverId:'page-reader/device',tool:'click_circuit_calculator',arguments:{input:original}});
    }
    if(n>targets.length+(!paperReview&&(gui||autoRecovery)?1:0))return 'Recorded the independent checks.';
    targets.forEach((t,i)=>assert.equal(digest(outputs[i]),t.sha256));
    const result=outputs.map(s=>{try{return JSON.parse(s);}catch{return {};}}).find(s=>s.samples);
    assert.ok(result);
    const manuscript=outputs.find(s=>s.startsWith('# '+title));
    const parameters=outputs.map(s=>{try{return JSON.parse(s);}catch{return {};}}).find(s=>s.sampleTimesSeconds);
    assert.ok(parameters);
    const maxError=Math.max(...result.samples.map(s=>Math.abs(s.outputVolt-parameters.inputVolt*(1-Math.exp(-s.timeSeconds/(parameters.resistanceOhm*parameters.capacitanceFarad))))));
    assert.ok(maxError<=1e-12);
    if(gui&&!paperReview){
      const receipt=JSON.parse(outputs.at(-1));
      const observed=receipt.result.result.structuredContent.voltages;
      assert.equal(observed.length,result.samples.length);
      assert.ok(observed.every((v,i)=>Math.abs(v-result.samples[i].outputVolt)<1e-12));
    }
    if(manuscript){assert.equal(manuscript,markdown);assert.ok(result.samples.every(s=>manuscript.includes(s.outputVolt.toFixed(4))));}
    if(evidenceReturn){
      const measurement=outputs.map(s=>{try{return JSON.parse(s).halfTimeSeconds;}catch{return undefined;}}).find(t=>t!==undefined);
      if(paperReview && measurement===undefined){
        rejectedPaperReview=reviewId;
        return call('submit_review',{reviewId,verdict:'insufficient_evidence',checks:['Claims: original voltage measurements checked.','Citations: reference implementation read.','Figures: original voltage plot verified.'],findings:[missingEvidence]});
      }
      if(measurement!==undefined){
        assert.ok(Math.abs(measurement-Math.LN2*parameters.resistanceOhm*parameters.capacitanceFarad)<1e-12);
        if(paperReview)assert.ok(manuscript.includes(measurement.toPrecision(6)));
      }
    }
    const reviewFinding='State the numerical comparison tolerance.';
    const secondFinding='Specify that the samples describe an ideal simulated circuit.';
    const openFinding=autoRecovery && paperReview && (!manuscript.includes('absolute-error tolerance')?reviewFinding:
      !manuscript.includes('No physical circuit was measured.')?secondFinding:null);
    const requestChanges=Boolean(openFinding)||interruptRevision&&paperReview&&!contextFiles.length;
    if(autoRecovery && paperReview)paperVerdicts.push(requestChanges?'changes_required':'supported');
    return call('submit_review',{reviewId,verdict:requestChanges?'changes_required':'supported',checks:[
      'Claims: calculated every voltage independently and found a maximum absolute error of '+maxError+' V.',
      'Citations: checked the scope of the reference implementation.','Figures: checked all five tabulated outputs and their units.'],findings:requestChanges?[openFinding||reviewFinding]:[]});
  }
  if(input.includes('connected page reader')){
    if(longPages){
      if(n<3)return call('call_external_mcp',{serverId:'page-reader/browser',tool:'read_method_page',arguments:{}});
      for(const output of outputs){
        const record=JSON.parse(output),page=record.result.result.structuredContent;
        assert.equal(page.text.length,12000);
        recordedPages.push({artifactId:record.artifactId,url:page.url,excerpt:page.text});
      }
      return 'Saved three separate browser receipts.';
    }
    if(citeLibrary&&!n)return call('search_research_literature',{mode:'doi',term:'10.21105/joss.00024'});
    if(citeLibrary){libraryEdition=JSON.parse(outputs[0]).saved[0];assert.ok(libraryEdition.original);}
    return n>(citeLibrary?1:0)?'Read the pinned reference page and saved the response.':call('call_external_mcp',{serverId:'page-reader/browser',tool:'read_method_page',arguments:{}});
  }
  if(evidenceReturn && input.includes('by bisection.')){
    if(!n)return call('write_file',{name:'half.py',content:[
      'import json, math','c=json.load(open("/workspace/circuit.json"))','tau=c["resistanceOhm"]*c["capacitanceFarad"]',
      'lo,hi=0,4*tau','for i in range(48):','    t=(lo+hi)/2','    if -math.expm1(-t/tau)<0.5: lo=t','    else: hi=t',
      'json.dump({"halfTimeSeconds":(lo+hi)/2}, open("/outputs/half-time.json","w"))'].join('\n')});
    if(n===1)return call('run_command',{language:'python',script:'half.py',inputs:['circuit.json'],outputs:['half-time.json']});
    assert.ok(JSON.parse(outputs[1]).artifacts.some(f=>f.name==='half-time.json'));
    return 'Published the half-rise measurement from the original circuit parameters.';
  }
  if(input.includes('Run calculate_rc_response'))return n?'Published all five computed conditions.':call('calculate_rc_response',{});
  const revising=input.includes('Revise the prior edition directly.');
  if(interruptRevision && revising && !n){editorStarted=true;await editorReleased.promise;}
  const sources=parser(input,'Sources: ');
  if(n<sources.length)return call('read_file',{fileId:sources[n].fileId});
  if(longPages){
    const pages=sources.map((source,i)=>({source,bytes:outputs[i]})).filter(row=>row.source.title.startsWith('Visited page'));
    assert.equal(pages.length,3);
    for(const {source,bytes} of pages){
      const expected=recordedPages.find(p=>p.url===source.url);assert.ok(expected);assert.ok(bytes.includes(expected.excerpt));
      assert.ok(source.claims.length);
    }
  }
  rc=JSON.parse(outputs[sources.findIndex(s=>s.title==='rc-response.json')]);
  const table='| Time (ms) | Output (V) |\n| --- | --- |\n'+rc.samples.map(s=>'| '+(1000*s.timeSeconds).toFixed(1)+' | '+s.outputVolt.toFixed(4)+' |').join('\n');
  const finding='At one time constant, the predicted output was '+rc.samples.find(s=>s.timeSeconds===rc.timeConstantSeconds).outputVolt.toFixed(4)+' V.';
  const series=sources.find(s=>s.title==='rc-response.json').sourceId;
  const figure='![Simulated voltage across five sampling times](athena-plot:'+series+'/timeSeconds/outputVolt)';
  sections=[intro,method+(selectInputs?'':'\nThe reference implementation defines the time constant as resistance times capacitance.'),finding+'\n\n'+table+'\n\n'+figure,'The ideal first-order model omits tolerances, noise and loading. These values are simulated.'+(citeLibrary?' '+libraryClaim:'')].map((text,i)=>({heading:headings[i],text}));
  const measured=sources.findIndex(s=>s.title==='half-time.json'),extraClaim=measured<0?'':'The half-rise time was '+JSON.parse(outputs[measured]).halfTimeSeconds.toPrecision(6)+' s.';
  if(extraClaim)sections[2].text+='\n'+extraClaim;
  markdown='# '+title+'\n\n'+sections.map(s=>'## '+s.heading+'\n'+s.text).join('\n\n');
  if(input.includes('Return only a JSON array'))return JSON.stringify(sections);
  const contextGrants=revising?parser(input,'Granted input files: ').filter(f=>f.name.startsWith('prior-')):[];
  if(n<sources.length+contextGrants.length)return call('read_file',{fileId:contextGrants[n-sources.length].fileId});
  if(autoRecovery && revising)markdown+='\n\nNo physical circuit was measured.';
  if(revising || autoRecovery && input.includes('Independent review findings:'))markdown+='\n\nThe absolute-error tolerance was 1e-12 V.';
  if(evidenceReturn && extraClaim){
    if(!revising)markdown=markdown.replace('| Time (ms) | Output (V) |','| Time (ms) | Output (V) | |');
    else{
      const log=outputs.slice(sources.length).map(s=>{try{return JSON.parse(s);}catch{return {};}}).find(v=>v.typesettingError);
      assert.match(log.typesettingError,/different number of columns/);
    }
  }
  if(n===sources.length+contextGrants.length)return call('publish_manuscript',{text:markdown,links:[
    ...(extraClaim?[{kind:'claim',quote:extraClaim,sourceId:sources[measured].sourceId,excerpt:String(JSON.parse(outputs[measured]).halfTimeSeconds),locator:'halfTimeSeconds'}]:[]),
    {kind:'claim',quote:finding,sourceId:sources.find(s=>s.title==='rc-response.json').sourceId,excerpt:String(rc.samples[2].outputVolt),locator:'samples[2].outputVolt'},
    ...(selectInputs?[]:[{kind:'citation',quote:'defines the time constant as resistance times capacitance',sourceId:sources.find(s=>s.title.startsWith('Visited page')).sourceId,excerpt:referenceQuote,locator:'calculate(text)'}]),...(citeLibrary?[{kind:'citation',quote:libraryClaim,sourceId:libraryEdition.sourceId,excerpt:'using a scatterplot matrix',locator:'Summary, p. 1'}]:[])]});
  return 'Published the revision and evidence links.';
}
const projectFolder=await mkdtemp(join(tmpdir(),'athena-circuit-project-'));
await promisify(execFile)('git',['-C',projectFolder,'init','-q','-b','main']);
const fixture=await createFixture(respond,{maxChildren:evidenceReturn?5:autoRecovery?4:3});
const {rpc}=fixture;
try{
  const provider=await rpc('registerCompatibleEndpoint',[{name:'Controlled research provider',endpoint:fixture.providerEndpoint}]);
  const profile=await rpc('saveModelProfile',[{provider:provider.id,modelId:'browser-fixture',name:'Research test model',thinkingLevel:'off'}]);
  const specialist=await rpc('saveModelProfile',[{provider:provider.id,modelId:'paper-reader',name:'Research specialist',thinkingLevel:'off'}]);
  for(const role of ['verification','writer','editor','reviewer'])await rpc('setWorkerModelPreference',[{role,profileId:specialist.id,thinkingLevel:'off'}]);
  let otherSession;
  if(background){
    const {project}=await rpc('createProject',[{name:'Research notes'}]);
    otherSession=(await rpc('createSession',[{projectId:project.id,title:'Notebook'}])).sessionId;
    await rpc('setConversationModelProfile',[otherSession,profile.id]);
  }
  await page.goto(fixture.origin);await page.bringToFront();
  await page.waitForFunction(()=>window.AthenaApp?.getState().workspace.taskManagerConnected);
  await page.getByRole('button',{name:'Add project'}).click();
  mark('project');if(screencast)await pause(700);
  await page.locator('#ac-project-name').fill('Circuit response study');
  await page.locator('#ac-project-folder').fill(projectFolder);
  await pause(screencast?1700:500);
  await page.locator('#ac-dialog-primary').click();
  await page.waitForFunction(previous=>{
    const state=window.AthenaApp?.getState().workspace;
    return state?.sessionBound && state.sessionId!==previous;
  },otherSession||null);
  const snap=await rpc('getSnapshot'),project=snap.projectId,session=snap.sessionId;
  const again=await rpc('createSession',[{projectId:project,title:'Research',firstForProject:true}]);assert.equal(again.sessionId,session);
  let e=await rpc('getExtensions',[project]);
  const manifest={schemaVersion:1,id:'page-reader',name:'Browser Use acceptance',version:'1.0.0',description:'Read a fixed method reference in a separate Chromium page.',skills:[],mcpServers:[{id:'browser',name:'Browser Use',capability:'browser',transport:'streamable-http',url:address+'/mcp',allowedTools:['read_method_page'],auth:'none',timeoutMs:10000}]};
  if(gui)manifest.mcpServers.push({id:'device',name:'Computer Use',capability:'computer',transport:'streamable-http',url:address+'/mcp',allowedTools:['click_circuit_calculator'],auth:'none',timeoutMs:10000});
  e=await rpc('installPlugin',[project,manifest,e.revision]);e=await rpc('checkMcpServer',[project,manifest.id,'browser',e.revision]);
  if(gui)e=await rpc('checkMcpServer',[project,manifest.id,'device',e.revision]);
  await rpc('setPluginEnabled',[project,manifest.id,true,e.revision]);
  mark('model');await page.locator('#ac-chat-model-trigger').click();if(screencast)await pause(1100);
  await page.locator('[data-acmp-key]').filter({hasText:'Research test model'}).click();
  await page.locator('#ac-chat-reasoning-trigger').click();if(screencast)await pause(1000);
  await page.locator('[data-acmp-key]').filter({hasText:/off/i}).first().click();
  mark('request');const attachments=[{name:'circuit.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(config))}];
  if(templateFile)attachments.push({name:selectedTemplate,mimeType:'text/plain',buffer:await readFile(templateFile)});
  await page.locator('.acm-file-input').setInputFiles(attachments);
  const prompt='How fast does the attached RC circuit charge? Read its reference implementation, test the five times, independently check the voltages and typeset a short paper using the '+(templateFile?'attached '+selectedTemplate+' LaTeX template.':'article LaTeX template.');
  await page.locator('#ac-prompt-input').fill(prompt);
  await pause(screencast?2100:600);mark('send');await page.getByRole('button',{name:'Send message',exact:true}).click();
  if(screencast){
    await page.locator('.ac-flow-stages summary').first().waitFor({timeout:45000});
    assert.ok((await page.locator('.ac-flow-stages').innerText()).includes('Planned'));
    mark('live');
  }
  const flow=()=>rpc('researchFlow',[{projectId:project,sessionId:session,...(stoppedRevision?{runId:stoppedRevision.runId}:{})}]);
  const end=Date.now()+120000;let status,switched=false,viewedDraft=false;
  const nextModel=interrupt?await rpc('saveModelProfile',[{provider:provider.id,modelId:'browser-fixture',name:'Next request model',thinkingLevel:'off'}]):null;
  while(Date.now()<end){
    assert.deepEqual(fixture.failures,[]);
    status=await flow();
    if(!interrupt&&!viewedDraft&&status?.sections?.length&&!status.documentId){
      await page.locator('[data-flow-tab="preview"]').click();
      await page.getByText('Draft · awaiting review',{exact:true}).first().waitFor({timeout:5000});
      mark('draft');await pause(screencast?2400:1100);await page.locator('[data-flow-tab="progress"]').click();viewedDraft=true;preliminaryObserved.resolve();mark('verification');
    }
    if(background && disconnectedReview && !markers.some(m=>m.step==='other-conversation')){
      // Switch during the failed verification, send an unrelated prompt, and wait
      // for the research to reach manuscript review while viewing the other chat.
      const visit=async id=>{
        const thread=page.locator('[data-open-session="'+id+'"]');
        const group=thread.locator('xpath=ancestor::details[1]');
        if(!(await group.evaluate(el=>el.open)))await group.locator(':scope > summary').click();
        await thread.click();
        await page.waitForFunction(id=>window.AthenaApp?.getState().workspace.sessionId===id,id,{timeout:6000});
      };
      await visit(otherSession);mark('other-conversation');
      assert.deepEqual(paperVerdicts,[]);notebookOpened.resolve();
      await page.locator('#ac-prompt-input').fill(notePrompt);
      await page.getByRole('button',{name:'Send message',exact:true}).click();
      await fixture.waitSnapshot(s=>s.sessionId===otherSession && s.run?.status==='succeeded');
      await page.getByText('This notes conversation is ready.',{exact:true}).first().waitFor();
      assert.equal(await page.getByText('5 sampled times',{exact:true}).count(),0);
      const until=Date.now()+45000;
      while(!paperVerdicts.length && Date.now()<until){assert.deepEqual(fixture.failures,[]);await pause(300);}
      assert.ok(paperVerdicts.length,'The hidden study should already have reached manuscript review.');
      assert.equal((await rpc('getSnapshot')).sessionId,otherSession);
      await page.screenshot({path:join(evidence,'other-conversation.png')});
      await visit(session);mark('returned-to-research');
      await page.locator('[data-action="notes"]').first().click();
    }
    if(nextModel&&status?.runId&&!switched){
      await rpc('setConversationModelProfile',[session,nextModel.id]);switched=true;
    }
    if(interruptRevision&&!stoppedRevision&&editorStarted){
      // The host schedules the reviewed edition for correction. Stop after the
      // new editor actually starts, to exercise its explicit resume checkpoint.
      stoppedRevision=await flow();
      await rpc('cancelRun',[stoppedRevision.manuscriptRunId]);
      editorReleased.resolve();
      await fixture.stopHost();await fixture.startHost();await page.reload();
      await page.waitForFunction(()=>window.AthenaApp?.getState().workspace.sessionBound);
      if(supersedeRevision){
        await rpc('pi',[session,{type:'prompt',id:'superseding-request',message:'Separate research request'}]);
        await fixture.waitSnapshot(s=>s.run.id!==stoppedRevision.manuscriptRunId&&s.run.status==='succeeded');
      }
      const restored=await flow();
      assert.equal(restored.version,stoppedRevision.version);assert.equal(restored.manuscriptRunId,stoppedRevision.manuscriptRunId);
      assert.equal(restored.canResume,!supersedeRevision);assert.equal(restored.revisionRecovery,supersedeRevision?'restart':'resume');
      assert.equal(restored.stages.find(s=>s.title==='Manuscript').status,'Stopped');
      await page.locator('[data-action="notes"]').first().click();
      await page.locator('[data-flow-tab="preview"]').click();
      if(supersedeRevision)await page.getByRole('combobox',{name:'Research request'}).selectOption(stoppedRevision.runId);
      await page.getByRole('button',{name:supersedeRevision?'Restart revision':'Resume revision',exact:true}).click();
    }
    if(interrupt&&!interrupted&&status?.stages.some(s=>s.title==='Independent review'&&s.status==='Running')){
      interrupted=true;
      const old=await rpc('getSnapshot');
      const ids=old.processes.map(p=>p.id);
      await rpc('cancelRun',[old.run.id]);
      await fixture.stopHost();await fixture.startHost();await page.reload();
      await page.waitForFunction(()=>window.AthenaApp?.getState().workspace.sessionBound);
      const checkpoint=await flow();assert.equal(checkpoint.canResume,true);
      const restored=await rpc('getSnapshot');assert.deepEqual(restored.processes.map(p=>p.id),ids);
      const recovery={projectId:project,sessionId:session,runId:checkpoint.runId,expectedAttemptId:checkpoint.checkpoint};
      const accepted=await rpc('resumeResearch',[recovery]);assert.deepEqual(await rpc('resumeResearch',[recovery]),accepted);
      await page.locator('[data-action="notes"]').first().click();
    }
    if(status?.stages.some(s=>s.title==='Manuscript'&&s.status==='Running')&&!markers.some(m=>m.step==='writing'))mark('writing');
    if(status?.stages.some(s=>s.title==='Independent review'&&s.status==='Running')&&!markers.some(m=>m.step==='review'))mark('review');
    if(status?.stages.at(-1).status==='Succeeded')break;
    if(status?.stages.some(s=>s.status==='Failed' && !(evidenceReturn && s.title==='LaTeX' && s.description?.includes('different number of columns'))))throw Error(JSON.stringify(status.stages));
    await pause(350);
  }
  assert.equal(status?.stages.at(-1).status,'Succeeded',JSON.stringify(status));
  await page.locator('[data-flow-tab="results"]').click();
  await page.getByText('5 sampled times',{exact:true}).waitFor();
  mark('results');await pause(screencast?2400:1100);await page.screenshot({path:join(evidence,'progress.png')});
  if(interruptRevision){
    assert.ok(stoppedRevision);assert.equal(status.manuscriptRunId===stoppedRevision.manuscriptRunId,!supersedeRevision);
    assert.notEqual(status.version,stoppedRevision.version);
    const paper=await rpc('paperDetails',[{projectId:project,documentId:status.documentId}]);
    assert.equal(paper.runs.length,supersedeRevision?3:2);assert.deepEqual(paper.runs.at(-1).versions,[status.version]);
  }
  assert.equal(interrupted,interrupt);if(!interrupt)assert.equal(viewedDraft,true);assert.equal(guiCalls,gui?1:0);
  await page.locator('[data-flow-tab="preview"]').click();
  await page.locator('.ac-flow-page').first().waitFor();
  await page.waitForFunction(()=>document.querySelector('.ac-flow-page')?.naturalWidth>0);
  await page.locator('.ac-flow-page').first().evaluate(img=>img.scrollIntoView({block:'nearest'}));
  mark('pdf');await pause(screencast?3000:1800);await page.screenshot({path:join(evidence,'workspace.png')});
  const receipt=await rpc('getDocument',[{projectId:project,documentId:status.documentId,version:status.version}]);
  if(background){
    const graph=page.locator('details[data-disclosure="project-library"]');
    await graph.locator('summary').click();
    await graph.getByRole('heading',{name:'Project library'}).waitFor();
    const node=graph.getByRole('button',{name:title,exact:true});
    await node.hover();assert.ok(await graph.locator('svg path').count()>0);
    await page.screenshot({path:join(evidence,'project-map.png')});mark('source-map');await pause(1500);
    await node.click();
    await graph.getByRole('button',{name:'rc-response.json',exact:true}).waitFor();
    await page.screenshot({path:join(evidence,'project-sources.png')});mark('source-graph');await pause(1200);
    await graph.getByRole('button',{name:'rc-response.json',exact:true}).click();
    await graph.getByRole('button',{name:title,exact:true}).waitFor();await pause(900);
    await graph.locator('summary').click();
  }
  if(interruptRevision){
    const checks=page.locator('[data-flow-body] details').filter({has:page.getByText('Section checks',{exact:true})});
    await checks.locator('summary').click();
    assert.deepEqual((await checks.locator('p').allTextContents()).map(label=>label.split(' · ')[0]),headings);
  }
  for(const file of [receipt.compilation.tex,receipt.compilation.pdf]){
    const wait=page.waitForEvent('download');await page.getByRole('link',{name:file.name}).click();
    const download=await wait;const path=join(evidence,file.name);await download.saveAs(path);assert.equal(digest(await readFile(path)),file.sha256);
  }
  const waiting=page.waitForEvent('download');await page.getByRole('button',{name:'Review JSON',exact:true}).click();await (await waiting).saveAs(join(evidence,'review.json'));
  mark('download');const complete=await fixture.waitSnapshot(s=>s.run.status==='succeeded');
  await page.locator('[data-flow-tab="results"]').click();
  await page.getByText('5 sampled times · result and inputs',{exact:true}).click();
  await page.locator('[data-flow-body] details[open] pre').filter({hasText:'resistanceOhm'}).waitFor();
  const probe={projectId:project,sessionId:session,runId:status.runId,artifactId:status.tables[0].artifactId,version:status.tables[0].version};
  const pinned=await rpc('researchTableInputs',[probe]);assert.deepEqual(JSON.parse(pinned.inputs[0].excerpt),config);
  await assert.rejects(rpc('researchTableInputs',[{...probe,version:'other-version'}]),/recorded experiment table/);
  for(const role of (interruptRevision||autoRecovery||evidenceReturn?['editor','reviewer']:['writer','editor','reviewer'])){
    const attempts=complete.attempts.filter(a=>a.runId===complete.run.id&&a.workerRole===role);
    assert.ok(attempts.length,role);
    assert.ok(attempts.every(a=>a.model.profileId===specialist.id&&a.model.source==='role'),role);
  }
  assert.equal(complete.run.model.profileId,profile.id);assert.equal(status.model.profileId,profile.id);
  assert.ok(receipt.text.includes('athena-plot:'));assert.ok((await readFile(join(evidence,'manuscript.tex'),'utf8')).includes('\\begin{picture}'));
  if(templateFile)assert.ok((await readFile(join(evidence,'manuscript.tex'),'utf8')).startsWith((await readFile(templateFile,'utf8')).split('\n')[0]));
  if(citeLibrary){
    assert.ok(receipt.evidence.some(s=>s.sourceId===libraryEdition.sourceId&&s.version===libraryEdition.version));
    const pdfText=(await promisify(execFile)('pdftotext',[join(evidence,'manuscript.pdf'),'-'])).stdout;
    assert.match(pdfText,/Foreman-Mackey/);assert.match(pdfText.replace(/\s+/g,''),/10\.21105\/joss\.00024/);
  }
  const catalog=await rpc('listPapers',[{projectId:project}]);assert.equal(catalog.documents.length,evidenceReturn?2:1);
  if(loseHandoffAck){
    assert.equal(status.documentId,handedOffDocument);
    const roots=complete.attempts.filter(a=>a.runId===status.runId && !a.parentTaskId);
    assert.equal(roots.length,1);assert.equal(roots[0].status,'failed');assert.match(roots[0].error,/acknowledgment was lost/);
    const manuscript=await rpc('paperDetails',[{projectId:project,documentId:handedOffDocument}]);
    assert.equal(manuscript.runs.length,1);
    const board=await rpc('getResearch',[project,session]);
    const review=board.reviews.find(r=>r.id===manuscript.workflow.reviewId);
    assert.equal(review.verdict,'supported');assert.equal(review.executionStatus,'succeeded');
    const result=review.targets.find(t=>t.kind==='artifact');
    const manifest=JSON.parse(await readFile(join(evidence,'review.json'),'utf8'));
    assert.ok(manifest.evidence.some(source=>source.origin?.id===result.id && source.origin?.version===result.version));
    await writeFile(join(evidence,'handoff-recovery.json'),JSON.stringify({runId:status.runId,attempt:roots[0].id,error:roots[0].error,
      experimentReview:review.id,manuscriptRunId:manuscript.runs[0].id,version:receipt.version,pdf:receipt.compilation.pdf.sha256},null,2));
  }
  if(evidenceReturn){
    const [archived]=status.evidenceRevisions;
    assert.equal(archived.reviewId,rejectedPaperReview);assert.notEqual(archived.documentId,status.documentId);
    const rejected=await rpc('getDocument',[{projectId:project,documentId:archived.documentId,version:archived.version}]);
    assert.equal(rejected.assessment.verdict,'insufficient_evidence');assert.ok(!rejected.compilation);
    assert.equal(status.history.length,1);
    const studyChecks=(await rpc('getResearch',[project,session])).reviews.filter(r=>r.requestedBy.runId===status.runId);
    assert.equal(studyChecks.length,2);assert.equal(studyChecks[1].verdict,'supported');
    assert.equal(studyChecks[1].targets.filter(t=>t.kind==='artifact').length,2);
    const corrected=await rpc('paperDetails',[{projectId:project,documentId:status.documentId}]);
    assert.equal(corrected.runs.length,2);
    const failed=await rpc('getDocument',[{projectId:project,documentId:corrected.id,version:corrected.runs[1].baseVersion}]);
    assert.equal(failed.review.status,'approved');assert.equal(failed.compilation.repair.kind,'manuscript');
    assert.ok(corrected.runs[1].typesettingRepair);assert.equal(corrected.runs[1].revisionReviewId,failed.assessment.id);
    assert.notEqual(failed.assessment.reviewer.agentSessionId,receipt.assessment.reviewer.agentSessionId);
    await writeFile(join(evidence,'evidence-return.json'),JSON.stringify({rootRunId:status.runId,archived,
      typesettingCorrection:{originalVersion:failed.version,error:failed.compilation.error},
      experimentReviews:studyChecks.map(({id,verdict,targets})=>({id,verdict,targets})),
      finalDocumentId:status.documentId,finalVersion:status.version,finalPdfSha256:receipt.compilation.pdf.sha256},null,2));
  }
  const reviewed=JSON.parse(await readFile(join(evidence,'review.json'),'utf8'));
  assert.equal(reviewed.evidence.some(s=>s.title.startsWith('Visited page')), !selectInputs);
  assert.ok(receipt.evidence.length>=(selectInputs?2:3));assert.equal(receipt.review.status,'approved');assert.equal(status.stages.filter(s=>s.status==='Succeeded').length,7);
  await fixture.stopHost();await fixture.startHost();await page.reload();await page.waitForFunction(()=>window.AthenaApp?.getState().workspace.sessionBound);
  const restored=await flow();assert.equal(restored.version,status.version);
  const uniqueRoles=complete.tasks.filter(t=>t.runId===complete.run.id&&(t.title==='Edit manuscript'||t.title==='Draft sections')).map(t=>t.id);
  assert.equal(uniqueRoles.length,interruptRevision||autoRecovery||evidenceReturn?1:2);
  assert.equal(complete.attempts.filter(a=>uniqueRoles.includes(a.taskId)).length,supersedeRevision||autoRecovery||evidenceReturn?1:2);
  if(autoRecovery){
    assert.ok(unavailableRequests>0);
    const results=complete.processes.filter(p=>p.runId===status.runId && p.job.mcp?.tool==='calculate_rc_response');
    assert.equal(results.length,1,'The completed RC simulation must not be repeated.');
    const board=await rpc('getResearch',[project,session]);
    const checks=board.reviews.filter(r=>r.requestedBy.runId===status.runId);
    assert.deepEqual(checks.map(r=>r.verdict),['changes_required','supported']);
    assert.notEqual(checks[0].reviewer.agentSessionId,checks[1].reviewer.agentSessionId);
    assert.deepEqual(checks[0].targets,checks[1].targets);
    assert.deepEqual(paperVerdicts,['changes_required','changes_required','supported']);
    const doc=await rpc('paperDetails',[{projectId:project,documentId:status.documentId}]);
    assert.equal(doc.runs.length,2);
    assert.equal(doc.runs[1].baseVersion,doc.runs[0].versions.at(-1));
    const original=await rpc('getDocument',[{projectId:project,documentId:doc.id,version:doc.runs[0].versions[0]}]);
    assert.equal(original.assessment.verdict,'changes_required');assert.ok(!original.compilation);
    assert.equal(status.history.length,1);
    await writeFile(join(evidence,'recovery.json'),JSON.stringify({runId:status.runId,unavailableRequests,
      ...(background?{foregroundSessionDuringRecovery:otherSession,researchSession:session}:{}),
      calculationProcessId:results[0].id,evidenceReviews:checks,paperVerdicts,versions:doc.versions,
      finalPdfSha256:receipt.compilation.pdf.sha256},null,2));
  }
  const before=complete.attempts.map(a=>a.id);assert.deepEqual((await rpc('getSnapshot')).attempts.map(a=>a.id),before);
  await rpc('compilePaper',[{projectId:project,documentId:status.documentId,version:status.version}]);assert.deepEqual((await rpc('getSnapshot')).attempts.map(a=>a.id),before);
  const edit=await rpc('saveDocument',[{projectId:project,documentId:status.documentId,title,text:markdown+'\nManual change.',evidence:receipt.evidence,expectedCurrentVersion:status.version}]);
  assert.equal(edit.review.status,'unreviewed');assert.ok(!edit.compilation);
  await assert.rejects(rpc('compilePaper',[{projectId:project,documentId:status.documentId,version:edit.version}]),/approved revision/);
  assert.deepEqual(errors,[]);
  await writeFile(join(evidence,'acceptance.json'),JSON.stringify({markers,model:'Controlled local Pi provider',libraryEdition,template:selectedTemplate,templateClass:receipt.compilation.template,native:false,keptModelAcrossHandoff:complete.run.model.profileId===status.model.profileId,changedNextSelectionDuringRun:switched,viewedPreliminaryDraft:viewedDraft,source:visitedUrl,base:sha,completed:status.stages,pdfSha256:receipt.compilation.pdf.sha256,version:status.version,session,attemptCount:before.length,nativeGuiToolCalls:guiCalls,interruptedReviewResumed:interrupted,interruptedRevisionRecovery:stoppedRevision?(supersedeRevision?'restart':'resume'):null,restartAndRevisionChecks:true},null,2));
  console.log('Verified research workflow:',evidence);
}catch(err){await page.screenshot({path:join(evidence,'error.png')}).catch(()=>{});console.error('Page errors:',errors,'\nVisible:',(await page.locator('body').innerText()).slice(-2800));throw err;}
finally{notebookOpened.resolve();editorReleased.resolve();preliminaryObserved.resolve();await context.close();await browser.close();await fixture.close();mcp.closeAllConnections();mcp.close();await rm(projectFolder,{recursive:true,force:true});}
