import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, writeFileSync, chmodSync } from 'node:fs';
import { hash } from '../runtime/orchestration.ts';
import { Storage } from '../runtime/storage.ts';
import { Papers, inspectLinks, manuscriptSectionChecks, type PaperRun } from '../runtime/papers.ts';
import { privateTestDirectory } from './platform-test-helpers.ts';

test('paper source and version references are project-bound and missing evidence is retained', t=>{
  const dir=privateTestDirectory(join(tmpdir(),'papers-')),db=new Storage(dir),p=new Papers(db);
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  for(const id of ['one','two'])db.putProject({id,name:id});
  const src=p.saveSource('one','Data','potential 19 mV');
  const d=p.create('one',{title:'Study',goal:'Report voltage',evidence:[src]});
  assert.throws(()=>p.source('two',src.sourceId));assert.throws(()=>p.paper('two',d.id));
  assert.throws(()=>p.create('two',{title:'Foreign',goal:'Inspect',evidence:[src]}));
  const v=p.save('one',d.id,{title:'Study',text:'Other data 10.1000/missing',expectedCurrentVersion:null,evidence:[src],review:{status:'approved'}});
  assert.equal(v.review.status,'unreviewed');assert.equal(v.issues.length,2);
  assert.throws(()=>p.version('two',d.id,v.version));assert.throws(()=>p.save('one',d.id,{...v,expectedCurrentVersion:null}),{code:'VERSION_CONFLICT'});
  const target={kind:'artifact' as const,id:'data',projectId:'one',sessionId:'s',version:'v',sha256:src.sha256,bytes:15};
  const body='Figure 1. Potential in volts.';
  const figure={kind:'figure',quote:body,sourceId:src.sourceId,locator:'row 1',excerpt:'19 mV',caption:body,variable:'potential',unit:'V',transformation:'none'};
  const invalid=inspectLinks([figure],body,[{...src,origin:target}]);
  assert.ok(invalid.issues.some(i=>i.includes('unit')));
  const corrected=inspectLinks([{...figure,unit:'mV'}],body,[{...src,origin:target}]);
  assert.ok(!corrected.issues.some(i=>i.includes('unit')));
});

test('older compiled editions retain their download while an updated renderer is available',t=>{
  const dir=privateTestDirectory(join(tmpdir(),'paper-renderer-')),db=new Storage(dir),papers=new Papers(db);
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  db.putProject({id:'project',name:'Project'});
  const key='papers.v1:'+JSON.stringify(['project','typeset',JSON.stringify(['document','version'])]);
  const pdf={id:'original',uri:'/api/artifacts/session/original'};
  db.set(key,{state:'succeeded',template:'article',engine:'pdflatex',version:'version',pdf});
  const historic=papers.compilation('project','document','version');
  assert.ok(historic && 'updateAvailable' in historic && historic.updateAvailable);
  assert.deepEqual(historic.pdf,pdf);
});

test('saved section checks use Markdown heading boundaries and exact quote offsets',()=>{
  const text=['# Study','Results is mentioned in the introduction.','', 'Methods','-------','Tested one specimen.',
    '```text','# Example heading','```','> ## Quoted heading','', '## Results','Measured 19 mV.',
    '### Sensitivity','Measured 20 mV.','## Results','A second check.'].join('\r\n');
  const link=(quote:string,sourceOffset=0)=>({kind:'claim' as const,quote,sourceId:'source',excerpt:quote,locator:'table',
    manuscriptOffset:text.indexOf(quote),sourceOffset});
  const links=[link('Results is mentioned'),link('Tested one'),link('Measured 19'),link('Measured 20'),link('A second'),link('mV.',-1)];
  assert.deepEqual(manuscriptSectionChecks({text,title:'Original project title',links}),[
    {heading:'Methods',linkedPassages:1},{heading:'Results',linkedPassages:1},
    {heading:'Sensitivity',linkedPassages:1},{heading:'Results',linkedPassages:1}]);
});

test('research manuscript recovery follows its exact independent review and the typesetter diagnostic',async t=>{
  const dir=privateTestDirectory(join(tmpdir(),'paper-recovery-')),db=new Storage(dir),papers=new Papers(db);
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const project='project',session='session';
  db.putProject({id:project,name:'Project'});
  db.putSession({id:session,projectId:project,title:'Research',sessionDir:dir,sessionFile:join(dir,'main.jsonl')});
  const src=papers.saveSource(project,'Measurements','Voltage 19 mV');
  const paper=papers.create(project,{title:'Measurements',goal:'Check voltage',outline:['Results'],evidence:[src]},
    {runId:'study',sessionId:session,reviewId:'experiment-review',template:'article'});
  const context={projectId:project,sessionId:session,runId:'write',taskId:'parent',attemptId:'parent-1',agentSessionId:session,parentTaskId:null};
  const reviewer={...context,taskId:'reviewer',attemptId:'review-1',parentTaskId:'parent',agentSessionId:'independent'};
  const writing:PaperRun={id:context.runId,requestId:'write',mode:'write',context,baseVersion:null,stage:'Independent review',
    outline:paper.outline,sections:[],attempts:[],versions:[],reviews:[],uploads:[]};
  papers.update(project,paper.id,d=>{d.runs.push(writing);});
  const body='# Results\nVoltage 19 mV\n![plot](unavailable.png)';
  const artifact={kind:'artifact' as const,id:'draft',projectId:project,sessionId:session,version:'v1',sha256:hash(body),bytes:body.length};
  const v=papers.save(project,paper.id,{title:paper.title,text:body,evidence:[src],expectedCurrentVersion:null},{runId:writing.id,artifact,links:[]});
  const decide=()=>{const d=papers.paper(project,paper.id);return papers.recovery(d,d.runs[0]!);};
  assert.deepEqual(await decide(),{action:'resume'});
  papers.update(project,paper.id,d=>{d.runs[0]!.reviews.push({id:'review',missionId:'mission',evidenceIds:['outputs'],targets:[artifact],
    question:'Assess source coverage',createdAt:Date.now(),requestedBy:context,reviewer,state:'completed',verdict:'insufficient_evidence',findings:['Measure a second condition.']});});
  assert.equal((await decide()).action,'wait');
  db.putRecord('attempt',{id:reviewer.attemptId,...reviewer,status:'succeeded'});
  const missing=await decide();assert.equal(missing.action,'evidence');assert.match(missing.reason,/second condition/);
  papers.update(project,paper.id,d=>{const run=d.runs[0]!;run.reviews[0]={...run.reviews[0]!,verdict:'changes_required'};});
  const revise={action:'revise',version:v.version,reviewId:'review'};
  assert.deepEqual(await decide(),revise);
  papers.update(project,paper.id,d=>{const run=d.runs[0]!;run.reviews[0]={...run.reviews[0]!,verdict:'supported'};});
  assert.deepEqual(await decide(),{action:'resume'});
  await assert.rejects(papers.compile(project,session,paper.id,v.version,'article',new AbortController().signal),/unstaged figure/);
  assert.deepEqual(await decide(),revise);
  if(process.platform==='linux'){
    const key='papers.v1:'+JSON.stringify([project,'typeset',JSON.stringify([paper.id,v.version])]);
    const compiled=papers.compilation(project,paper.id,v.version)!;
    db.set(key,{...compiled,repair:undefined,error:'spawn pdflatex ENOENT'});
    const previous=process.env.PATH;
    try{
      process.env.PATH=dir;
      assert.deepEqual(await decide(),{action:'wait',poll:true,reason:'spawn pdflatex ENOENT'});
      // The availability probe only checks the executable bit. No compiler invocation or model work is permitted during the wait.
      writeFileSync(join(dir,'pdflatex'),'');chmodSync(join(dir,'pdflatex'),0o700);
      assert.deepEqual(await decide(),{action:'resume'});
    }finally{
      if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;
    }
  }
  const current=papers.paper(project,paper.id);
  const correction={...writing,baseVersion:v.version,revisionReviewId:'review',versions:[]};
  assert.deepEqual(await papers.recovery(current,correction),{action:'resume'});
  papers.save(project,paper.id,{title:paper.title,text:'Manually edited',evidence:[src],expectedCurrentVersion:v.version});
  assert.equal((await decide()).action,'wait');
});
