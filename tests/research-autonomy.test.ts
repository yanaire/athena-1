import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { TaskManager, type PiSessionFactory } from '../runtime/manager.ts';
import type { ResearchAutonomy } from '../runtime/research-continuation.ts';
import { analysisAccess } from '../runtime/analysis-sandbox.ts';
import { Storage } from '../runtime/storage.ts';
import { privateTestDirectory } from './platform-test-helpers.ts';

type Flow = {
  runId:string;
  checkpoint:string;
  documentId?:string;
  compilationReceipt?:string;
  autonomy?:ResearchAutonomy & {canStop:boolean};
};
const enabled=(await analysisAccess()).available;
const options={skip:enabled?false:'Prepare the local WASI runtime to admit research workflows.'};
const prompt='Measure the response, have the result verified and typeset the reviewed manuscript.';

async function waitFor<T>(read:()=>T|Promise<T>,check:(value:T)=>boolean) {
  const deadline=Date.now()+20_000;
  let value=await read();
  while(!check(value) && Date.now()<deadline){
    await delay(20);
    value=await read();
  }
  assert.ok(check(value),'Timed out waiting for the research checkpoint: '+JSON.stringify(value));
  return value;
}

// The scripted Pi coordinator finishes its message without creating a paper.
// TaskManager, its timer, SQLite, budget, stop and restart paths are real.
async function setup(t:TestContext) {
  const dataDir=privateTestDirectory(join(tmpdir(),'research-autonomy-'));
  const db=new Storage(dataDir);
  const prompts:string[]=[];
  const histories=new Map<string,{role:string;content:string}[]>();
  let hold=false;
  let nextOpen:(()=>Promise<void>)|undefined;
  const createPiSession:PiSessionFactory=async options=>{
    if(options.sessionFile && nextOpen){
      const wait=nextOpen;nextOpen=undefined;await wait();
    }
    const file=options.sessionFile??join(options.sessionDir,randomUUID()+'.jsonl');
    const messages=histories.get(file)??[];
    histories.set(file,messages);
    const sessionId=basename(file,'.jsonl');
    const listeners=new Set<(event:{type:string})=>void>();
    const ended=Promise.withResolvers<void>();
    const emit=(type:string)=>{for(const listener of listeners)listener({type});};
    return {
      sessionId,sessionFile:file,
      getState:()=>({sessionId}),getMessages:()=>messages,close:()=>{},
      subscribe:listener=>{listeners.add(listener);return ()=>listeners.delete(listener);},
      command:async command=>{if(command.type==='abort')ended.resolve();},
      prompt:async message=>{
        prompts.push(message);
        messages.push({role:'user',content:message});
        emit('agent_start');
        if(hold){await ended.promise;return;}
        emit('agent_settled');
      }
    };
  };
  let manager=new TaskManager({dataDir,createPiSession});
  t.after(async()=>{await manager.close();db.close();await rm(dataDir,{recursive:true,force:true});});
  await manager.initialize();
  const {project}=await manager.createProject({name:'Autonomous study',researchWorkflow:true});
  const {sessionId}=await manager.createSession({projectId:project.id,title:'One request'});
  const scope={projectId:project.id,sessionId};
  const flow=async()=>await manager.paperRequest('researchFlow',scope) as Flow;
  return {
    prompts,db,scope,flow,get manager(){return manager;},hold(value:boolean){hold=value;},
    pauseNextReopen(){
      let started=false;
      const finished=Promise.withResolvers<void>();
      nextOpen=()=>{started=true;return finished.promise;};
      return {started:()=>started,release:finished.resolve};
    },
    async start(){
      await manager.pi(sessionId,{type:'prompt',id:'study',message:prompt});
      return flow();
    },
    async restart(){
      await manager.close();
      manager=new TaskManager({dataDir,createPiSession});
      await manager.initialize();
    },
    stop:async(runId:string)=>manager.paperRequest('stopResearch',{...scope,runId}),
  };
}

test('an interrupted coordinator resumes once in the same study after the host reopens',options,async t=>{
  const f=await setup(t);
  f.hold(true);
  const initial=await f.start();
  await waitFor(()=>f.prompts.length,count=>count===1);
  f.hold(false);
  await f.restart();
  const resumed=await waitFor(f.flow,r=>r.autonomy?.attempts===1 && r.checkpoint!==initial.checkpoint);
  await f.stop(resumed.runId);
  assert.equal(resumed.runId,initial.runId);
  const attempts=f.manager.getSnapshot().attempts;
  assert.deepEqual(attempts.map(a=>[a.id,a.status]),[[initial.checkpoint,'paused'],[resumed.checkpoint,'succeeded']]);
  assert.equal(f.prompts.length,2);
  assert.equal(f.db.receipt(f.scope.sessionId,'study')?.state,'interrupted');
});

test('a stop between coordinator attempts remains in force after reopening the app',options,async t=>{
  const f=await setup(t);
  const first=await f.start();
  await waitFor(()=>f.manager.getSnapshot().run.status,s=>s==='succeeded');
  assert.equal((await f.flow()).autonomy?.canStop,true);
  await f.stop(first.runId);
  await f.restart();
  await delay(1100);
  const stopped=await f.flow();
  assert.equal(stopped.autonomy?.state,'stopped');
  assert.equal(stopped.autonomy?.canStop,false);
  assert.equal(stopped.checkpoint,first.checkpoint);
  assert.deepEqual(f.prompts,[prompt]);
});

test('stopping while a recovery opens the pinned model prevents the pending admission',options,async t=>{
  const f=await setup(t);
  const first=await f.start();
  const gate=f.pauseNextReopen();
  try{
    await waitFor(gate.started,Boolean);
    await f.stop(first.runId);
  }finally{gate.release();}
  await delay(1000);
  const stopped=await f.flow();
  assert.equal(stopped.autonomy?.state,'stopped');
  assert.equal(stopped.autonomy?.attempts,0);
  assert.equal(stopped.checkpoint,first.checkpoint);
  assert.deepEqual(f.prompts,[prompt]);
});

test('a summary without reviewed artifacts cannot complete the study or exceed its recovery budget',options,async t=>{
  const f=await setup(t);
  const first=await f.start();
  const blocked=await waitFor(f.flow,r=>r.autonomy?.state==='blocked');
  assert.match(blocked.autonomy!.reason,/limit/i);
  assert.equal(blocked.autonomy?.attempts,first.autonomy!.limit);
  assert.equal(blocked.documentId,undefined);
  assert.equal(blocked.compilationReceipt,undefined);
  assert.equal(f.prompts.length,1+first.autonomy!.limit);
  assert.equal(f.manager.getSnapshot().attempts.filter(a=>a.runId===first.runId).length,f.prompts.length);
  await f.restart();
  await delay(1100);
  assert.equal((await f.flow()).checkpoint,blocked.checkpoint);
  assert.equal(f.prompts.length,1+first.autonomy!.limit);
});

test('a pre-upgrade checkpoint remains readable and joins autonomous recovery on explicit resume',options,async t=>{
  const f=await setup(t);
  const initial=await f.start();
  await waitFor(()=>f.manager.getSnapshot().run.status,s=>s==='succeeded');
  // An installed version predating recovery had no controller for this run.
  f.db.set('research.autonomy:'+initial.runId,null);
  await f.restart();
  await delay(1100);
  const old=await f.flow();
  assert.ok(!old.autonomy);
  assert.equal(old.checkpoint,initial.checkpoint);
  assert.equal(f.prompts.length,1);
  const args={...f.scope,runId:old.runId,expectedAttemptId:old.checkpoint};
  await f.manager.paperRequest('resumeResearch',args);
  const next=await waitFor(f.flow,r=>!!r.autonomy && r.checkpoint!==old.checkpoint);
  await f.manager.paperRequest('resumeResearch',args); // replay of the original UI action
  await f.stop(next.runId);
  assert.equal(next.runId,initial.runId);
  assert.equal(f.prompts.length,2);
  assert.equal(f.manager.getSnapshot().attempts.length,2);
});

test('opening a second conversation keeps recovery in its owning study',options,async t=>{
  const f=await setup(t);
  const first=await f.start();
  await waitFor(()=>f.manager.getSnapshot().run.status,s=>s==='succeeded');
  const next=await f.manager.createSession({projectId:f.scope.projectId,title:'Separate study'});
  await waitFor(()=>f.prompts.length,n=>n===2);
  const current=f.manager.getSnapshot();
  assert.equal(current.sessionId,next.sessionId);
  assert.equal(current.run.id,null);
  assert.equal(current.attempts.length,0);
  await f.manager.openSession(f.scope.sessionId);
  const resumed=await f.flow();
  assert.equal(resumed.runId,first.runId);
  assert.equal(resumed.autonomy?.attempts,1);
  assert.notEqual(resumed.checkpoint,first.checkpoint);
  await f.stop(first.runId);
});

test('a foreground conversation can read only its own transcript while a background coordinator reconnects',options,async t=>{
  const f=await setup(t);
  const otherProject=await f.manager.createProject({name:'Project notes'});
  const other=await f.manager.createSession({projectId:otherProject.project.id,title:'Existing notes'});
  const note='Retain this separate conversation note.';
  await f.manager.pi(other.sessionId,{type:'prompt',id:'note',message:note});
  await waitFor(()=>f.manager.getSnapshot().run.status,s=>s==='succeeded');
  await f.manager.openSession(f.scope.sessionId);
  const initial=await f.start();
  await waitFor(()=>f.manager.getSnapshot().run.status,s=>s==='succeeded');
  await f.manager.openSession(other.sessionId);
  const gate=f.pauseNextReopen();
  const messages=async(id:string)=>{
    const reply=await f.manager.pi(id,{type:'get_messages'}) as {data:{messages:{content:string}[]}};
    return reply.data.messages.map(m=>m.content);
  };
  try{
    await waitFor(gate.started,Boolean);
    const state=await f.manager.pi(other.sessionId,{type:'get_state'}) as {data:{sessionId:string}};
    assert.equal(state.data.sessionId,other.sessionId);
    assert.deepEqual(await messages(other.sessionId),[note]);
    await assert.rejects(messages(f.scope.sessionId),{code:'SESSION_MISMATCH'});
  }finally{gate.release();}
  await waitFor(()=>f.prompts.length,n=>n===3);
  assert.deepEqual(await messages(other.sessionId),[note]);
  await f.manager.openSession(f.scope.sessionId);
  const resumed=await f.flow();
  assert.equal(resumed.runId,initial.runId);
  assert.notEqual(resumed.checkpoint,initial.checkpoint);
  const researchMessages=await messages(f.scope.sessionId);
  assert.equal(researchMessages[0],prompt);
  assert.equal(researchMessages.length,2);
  assert.ok(!researchMessages.includes(note));
  await f.stop(initial.runId);
});
