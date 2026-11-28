import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager } from '../runtime/manager.ts';
import { Storage } from '../runtime/storage.ts';
import { Papers } from '../runtime/papers.ts';
import { hash } from '../runtime/orchestration.ts';
import { privateTestDirectory } from './platform-test-helpers.ts';

test('a reviewed edition reports unresolved links without exposing unselected sources or hiding the findings',async t=>{
  const directory=privateTestDirectory(join(tmpdir(),'reviewed-source-links-'));
  const manager=new TaskManager({dataDir:directory}),db=new Storage(directory),papers=new Papers(db);
  t.after(async()=>{await manager.close();db.close();await rm(directory,{recursive:true,force:true});});
  await manager.initialize();
  const {project}=await manager.createProject({name:'Reviewed evidence',researchWorkflow:true});
  const {sessionId}=await manager.createSession({projectId:project.id,title:'Calibration'});
  const scope={projectId:project.id,sessionId,runId:'study'},context={...scope,taskId:'editor',parentTaskId:null,agentSessionId:'editor-session',attemptId:'edit'};
  const origin={kind:'artifact' as const,id:'sample',projectId:project.id,sessionId,version:'v1',sha256:hash('sample'),bytes:6};
  const selected=papers.saveSource(project.id,'Selected','sample','full_text',origin);
  const unselected=papers.saveSource(project.id,'Other study','sample','full_text',{...origin,id:'other-result'});
  const paper=papers.create(project.id,{title:'Calibration',goal:'Report a measurement',evidence:[selected]});
  const body='The sample was measured.',artifact={...origin,id:'draft',sha256:hash(body),bytes:body.length};
  const findings=['Select the evidence used for both unresolved citations.'];
  papers.update(project.id,paper.id,p=>p.runs.push({id:'write',requestId:'write',mode:'write',context,baseVersion:null,stage:'completed',outline:[],sections:[],attempts:[],versions:[],uploads:[],reviews:[
    {id:'review',missionId:'verify',evidenceIds:[],question:'Are the passages supported?',createdAt:1,requestedBy:context,state:'completed',verdict:'changes_required',targets:[artifact],findings}
  ]}));
  const link=(sourceId:string,locator:string)=>({kind:'claim',sourceId,locator,quote:body,excerpt:'sample'});
  const edition=papers.save(project.id,paper.id,{title:paper.title,text:body,expectedCurrentVersion:null,evidence:[selected]},
    {artifact,runId:'write',links:[link(selected.sourceId,'selected'),link('missing','unknown'),link(unselected.sourceId,'not selected')]});
  db.putRecord('run',{...scope,id:scope.runId,taskId:'root',title:paper.title,status:'succeeded'});
  db.set('research.flow:'+scope.runId,{runId:scope.runId,input:body,fileIds:[],searchIds:[],drafts:[],documentId:paper.id});
  const read=async()=>await manager.paperRequest('researchFlow',scope) as {sources:unknown[];stages:{title:string;status:string}[]};
  const unresolved=(locator:string)=>({quote:body,locator,unresolved:true});
  const report=await read();
  assert.deepEqual(report.sources,[{quote:body,locator:'selected',source:origin},unresolved('unknown'),unresolved('not selected')]);
  assert.equal(report.stages.find(s=>s.title==='Independent review')?.status,'Waiting for input');
  const document=await manager.paperRequest('getDocument',{...scope,documentId:paper.id,version:edition.version}) as {assessment:{findings:string[]}};
  assert.deepEqual(document.assessment.findings,findings);

  // Even stale positive offsets in stored links cannot grant a source outside the edition.
  const versionKey='papers.v1:'+JSON.stringify([project.id,'version',edition.version]);
  db.set(versionKey,{...edition,links:edition.links.map(l=>({...l,sourceOffset:0}))});
  assert.deepEqual((await read()).sources,report.sources);
  const sourceKey='papers.v1:'+JSON.stringify([project.id,'source',selected.sourceId]);
  db.set(sourceKey,{...selected,content:'changed'});
  assert.deepEqual((await read()).sources,[unresolved('selected'),unresolved('unknown'),unresolved('not selected')]);
});

test('the recorded experiment stays in progress until its workers settle and the coordinator pins an output edition', async t=>{
  const directory=privateTestDirectory(join(tmpdir(),'experiment-progress-'));
  const manager=new TaskManager({dataDir:directory}),db=new Storage(directory);
  t.after(async()=>{await manager.close();db.close();await rm(directory,{recursive:true,force:true});});
  await manager.initialize();
  const {project}=await manager.createProject({name:'Regression progress',researchWorkflow:true});
  const {sessionId}=await manager.createSession({projectId:project.id,title:'Measured response'});
  const scope={projectId:project.id,sessionId,runId:'analysis-run'};
  const root={...scope,taskId:'coordinator',id:scope.runId,title:'Regression'};
  const task={...scope,id:'worker',taskId:'worker',parentTaskId:root.taskId,role:'experiment'};
  const process={...scope,id:'summary-process',processId:'summary-process',taskId:task.id,status:'succeeded',job:{}};
  const file={...scope,id:'summary-file',name:'statistics.json',sha256:'sha256',bytes:8,versionId:'summary-v1'};
  const flow={runId:scope.runId,input:'Fit a regression.',fileIds:[],searchIds:[],drafts:[]};
  const key='research.flow:'+scope.runId;
  const report=async()=>{
    const response=await manager.paperRequest('researchFlow',scope) as {stages:{title:string;taskId?:string;status:string}[]};
    const stage=response.stages.find(s=>s.title==='Experiment')!;
    return [stage.status,stage.taskId];
  };
  db.putRecord('run',{...root,status:'running'});
  db.set(key,{...flow,planMode:'coordinator'});
  db.putRecord('process',{...process,id:'repo-lookup',taskId:root.taskId,job:{externalMcp:{serverId:'github'}},status:'running'});
  assert.deepEqual(await report(),['Planned',undefined],'An unrelated coordinator plugin call is not an experiment.');
  db.putRecord('task',{...task,status:'running'});
  assert.deepEqual(await report(),['Running',task.id]);
  db.putRecord('process',process);
  db.putRecord('artifact',{...scope,id:file.id,taskId:task.id,processId:process.id,version:file.versionId,file});
  db.putRecord('task',{...task,role:'worker',status:'running'}); // Older and general workers publish through the same process journal.
  assert.deepEqual(await report(),['Running',task.id]);
  const table={artifactId:file.id,version:file.versionId,condition:'condition',count:1,rows:[{n:1}],path:[]};
  db.set(key,{...flow,planMode:'coordinator',tables:[table]});
  assert.deepEqual(await report(),['Running',task.id], 'Pinning a partial table cannot settle its active producer.');
  db.putRecord('task',{...task,status:'failed'});
  assert.deepEqual(await report(),['Failed',task.id]);
  db.putRecord('task',{...task,status:'paused'});
  assert.deepEqual(await report(),['Stopped',task.id]);
  db.putRecord('task',{...task,status:'succeeded'});
  db.putRecord('task',{...task,id:'reviewer',taskId:'reviewer',role:'verification',status:'running'});
  db.putRecord('process',{...process,id:'independent-check',taskId:'reviewer',status:'running'});
  assert.deepEqual(await report(),['Succeeded',task.id], 'The separate verification stage can still be running.');
  db.putRecord('run',{...root,status:'succeeded'});
  db.set(key,{...flow,planMode:'coordinator',tables:[{...table,version:'different-edition'}]});
  assert.deepEqual(await report(),['Waiting for input',task.id], 'A different edition cannot complete the stage.');
  db.set(key,flow);
  assert.deepEqual(await report(),['Succeeded',task.id], 'A settled legacy record retains its published outcome.');
  db.set(key,{...flow,planMode:'coordinator'});
  const ledger='athena.research.v1:'+project.id;
  const document={schemaVersion:1,projectId:project.id,missions:[{...scope,id:'mission'}],reviews:[],books:[],projectMemory:[],agentMemory:[],requests:[]};
  const evidence={id:'evidence',missionId:'mission',targets:[{kind:'artifact',id:file.id,version:file.versionId}]};
  db.set(ledger,{...document,evidence:[{...evidence,createdBy:{...scope,runId:'other-run'}}]});
  assert.deepEqual(await report(),['Waiting for input',task.id]);
  db.set(ledger,{...document,evidence:[{...evidence,createdBy:{...scope,parentTaskId:root.taskId}}]});
  assert.deepEqual(await report(),['Waiting for input',task.id], 'An unselected worker observation does not settle the coordinator’s experiment.');
  db.set(ledger,{...document,evidence:[{...evidence,createdBy:{...scope,parentTaskId:null}}]});
  assert.deepEqual(await report(),['Succeeded',task.id]);
  db.set('experiment.mission:'+scope.runId,{missionId:'mission',status:'exhausted',contract:{direction:'at_most',target:0},trials:[]});
  assert.deepEqual(await report(),['Waiting for input',undefined], 'Adaptive runs retain the mission outcome.');
});
