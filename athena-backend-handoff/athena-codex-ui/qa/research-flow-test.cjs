'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const vm=require('node:vm');
const {parseHTML}=require('linkedom');

async function panel(autonomy,edition,catalog={documents:[],sources:[]},ordinary) {
  const {document,window}=parseHTML('<div id="flow"><button data-flow-tab="progress">Workflow</button><button data-flow-tab="results">Experiment results</button><button data-flow-tab="preview">Paper</button><p data-flow-notice></p><div data-flow-body></div></div>');
  const root=document.querySelector('#flow'),calls=[];
  let scheduled,stage;
  const context={document,window,AbortController,performance,
    setTimeout:fn=>{scheduled=fn;return 1;},clearTimeout:()=>{scheduled=null;}};
  for(const file of ['project-graph.js','research-flow.js'])vm.runInNewContext(readFileSync(join(__dirname,'../ui/'+file),'utf8'),context);
  const report={autonomy,history:[],runId:'research',stages:[{title:'Experiment',status:'Succeeded'}],artifacts:[],
    connections:[],canResume:true,checkpoint:'first',documentId:'paper',version:edition?.version};
  const api=window.AthenaResearchFlow.mount(root,{stage:value=>{stage=value;}});
  api.attach(async(method,args)=>{
    if(method==='researchFlow')return ordinary?null:report;
    if(method==='getDocument')return edition;
    if(method==='listPapers')return catalog;
    calls.push([method,JSON.parse(JSON.stringify(args))]);
    if(method==='stopResearch')report.autonomy={state:'stopped',canStop:false,reason:'Stopped by user.'};
  });
  api.scope(ordinary||{projectId:'p',projects:[{id:'p',researchWorkflow:true}],sessionId:'s',run:{id:'linked-paper',status:'succeeded'}});
  await new Promise(setImmediate);
  return {root,report,api,calls,stage:()=>stage,poll:()=>scheduled(),button:label=>[...root.querySelectorAll('button')].find(b=>b.textContent===label)};
}

test('waiting between attempts shows the recorded cause and next check on both tabs, and stops the selected research root',async t=>{
  const reason='The experiment server disconnected.';
  const p=await panel({state:'waiting',reason,attempts:1,limit:4,nextAttemptAt:1800000000000,canStop:true});
  t.after(()=>p.api.destroy());
  assert.match(p.stage(),/Waiting to resume/);
  assert.match(p.root.textContent,/1 of 4 recovery attempts used/);
  assert.ok(p.root.querySelector('time'));
  assert.ok(p.root.textContent.includes(reason));
  assert.equal(p.button('Resume from saved checkpoint'),undefined);
  p.button('Paper').click();
  assert.ok(p.root.textContent.includes(reason));
  assert.equal(p.calls.length,0);
  await p.button('Stop research').onclick();
  assert.deepEqual(p.calls,[['stopResearch',{projectId:'p',sessionId:'s',runId:'research'}]]);
  assert.equal(p.stage(),'Research stopped');
  assert.equal(p.button('Stop research'),undefined);
});

test('review findings remain readable during automatic correction, with manual revision available at a blocked checkpoint',async t=>{
  const edition={title:'Study',version:'v1',currentVersion:'v1',review:{status:'reviewed'},
    assessment:{verdict:'changes_required',findings:['Identify the public dataset.']}};
  const p=await panel({state:'recovering',reason:'Addressing the review.',canStop:true},edition);
  t.after(()=>p.api.destroy());
  p.button('Paper').click();
  assert.match(p.root.textContent,/Identify the public dataset/);
  assert.equal(p.button('Revise from review'),undefined);
  p.report.autonomy={state:'blocked',reason:'Supply the missing dataset.',attempts:4,limit:4,canStop:false};
  await p.poll();
  assert.match(p.root.textContent,/Supply the missing dataset/);
  assert.equal(p.stage(),'Research needs attention');
  assert.ok(p.button('Revise from review'));
  assert.equal(p.button('Stop research'),undefined);
});

test('saved flows from earlier hosts retain the manual checkpoint action',async t=>{
  const p=await panel(undefined);
  t.after(()=>p.api.destroy());
  await p.button('Resume from saved checkpoint').onclick();
  assert.deepEqual(p.calls,[['resumeResearch',{projectId:'p',sessionId:'s',runId:'research',expectedAttemptId:'first'}]]);
});

test('results and paper have separate views and the project graph follows only exact source editions',async t=>{
  const catalog={documents:[{id:'paper',title:'Experiment A',evidence:[{sourceId:'s1',version:'1'},{sourceId:'s2',version:'older'}]}],
    sources:[{sourceId:'s1',version:'1',title:'Method'},{sourceId:'s2',version:'2',title:'Updated paper'}],
    library:[{sourceId:'s1',version:'1',url:'https://example.org/method',coverage:'Full text',originalUri:'/api/artifacts/s/library-s1',originalFile:'method.pdf'}]};
  const p=await panel(undefined,undefined,catalog);t.after(()=>p.api.destroy());
  p.report.artifacts=[{id:'a',name:'published.json',version:'1'}];
  await p.poll();
  assert.equal(p.button('published.json'),undefined);
  p.button('Experiment results').click();
  assert.ok(p.button('published.json'));
  p.button('Paper').click();
  assert.equal(p.button('published.json'),undefined);
  const graph=p.root.querySelector('.ac-project-graph');graph.open=true;graph.ontoggle();await new Promise(setImmediate);
  assert.ok(p.button('Updated paper'));
  p.button('Experiment A').click();
  assert.equal(p.button('Updated paper'),undefined);
  p.button('Method').click();
  assert.equal(graph.querySelector('h4').textContent,'Method');
  assert.equal(graph.querySelector('a[download]').getAttribute('href'),'/api/artifacts/s/library-s1');
  assert.ok(p.button('Experiment A'));
  p.button('← Project library').click();p.button('Updated paper').click();
  assert.match(graph.textContent,/No manuscript is linked/);
});

test('an uncertain external call can only be acknowledged from the displayed checkpoint',async t=>{
  const p=await panel({state:'blocked',reason:'Confirm the remote outcome before continuing.',uncertainProcessIds:['process-one'],canStop:false});
  t.after(()=>p.api.destroy());
  assert.equal(p.button('Resume from saved checkpoint'),undefined);
  await p.button('I checked the remote outcome · resume').onclick();
  assert.deepEqual(p.calls,[['resumeResearch',{projectId:'p',sessionId:'s',runId:'research',expectedAttemptId:'first',confirmedProcessIds:['process-one']}]]);
});

test('ordinary live projects show their recorded tasks and outputs and clear them on switching conversation',async t=>{
  const snapshot={mode:'runtime',projectId:'p',sessionId:'old-chat',projects:[{id:'p'}],run:{id:'r',status:'succeeded'},
    tasks:[{runId:'r',id:'worker',title:'Measure response',status:'succeeded'}],artifacts:[{id:'a',title:'Original CSV',version:'2'}]};
  const p=await panel(undefined,undefined,undefined,snapshot);t.after(()=>p.api.destroy());
  assert.ok(p.button('Measure response · succeeded'));assert.equal(p.button('Original CSV'),undefined);
  p.button('Experiment results').click();assert.ok(p.button('Original CSV'));
  p.api.scope({...snapshot,sessionId:'other',tasks:[],artifacts:[],run:{status:'ready'}});
  assert.equal(p.button('Original CSV'),undefined);
  assert.match(p.root.textContent,/No experiment outputs/);
  p.button('Paper').click();assert.ok(p.root.querySelector('.ac-project-graph'));
});
