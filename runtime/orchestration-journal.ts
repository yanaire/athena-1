import { randomUUID } from 'node:crypto';
import { Storage } from './storage.ts';
import { pending, object, hash, artifactRef } from './orchestration.ts';
import type { Context, Attempt, TaskRow, ArtifactRow, ProcessRow } from './orchestration.ts';
import type { Run } from './manager.ts';
import type { Status, Tool } from '../athena-backend-handoff/athena-codex-ui/integrations/task-manager.d.ts';
import type { JobEvent } from './jobs.ts';

type Event = Readonly<Record<string, unknown>> & { readonly type: string };
export const context = ({projectId, sessionId, runId, taskId, parentTaskId, agentSessionId, attemptId}:Context):Context =>
  ({projectId,sessionId,runId,taskId,parentTaskId,agentSessionId,attemptId});
export const toolId = (a:Context, raw:string) => 'tool-' + hash(JSON.stringify([a.attemptId,raw])).slice(0,32);
export function normalizeEvent(a:Context,event:Event):Event {
  const id = (v:unknown) => typeof v === 'string' ? toolId(a,v) : v;
  const part = (v:unknown) => object(v) && v.type === 'toolCall' ? {...v,id:id(v.id)} : v;
  const msg = (v:unknown) => object(v) ? {...v,...(Array.isArray(v.content)?{content:v.content.map(part)}:{}),
    ...(v.toolCallId?{toolCallId:id(v.toolCallId)}:{})} : v;
  const u = event.assistantMessageEvent;
  return {...event,...context(a),...(event.toolCallId?{toolCallId:id(event.toolCallId)}:{}),
    ...(event.message?{message:msg(event.message)}:{}), ...(object(u)?{assistantMessageEvent:{...u,
      ...(typeof u.type === 'string' && u.type.startsWith('toolcall_') && u.id?{id:id(u.id)}:{}),
      ...(u.toolCall?{toolCall:part(u.toolCall)}:{}),...(u.partial?{partial:msg(u.partial)}:{})}}:{})};
}

/** Purely durable projections; all callers hold the Storage transaction. */
export class Journal {
  readonly db: Storage;
  constructor(db:Storage){this.db=db;}
  event(a:Context,type:string,summary:string,links: {toolId?:string;artifactId?:string;processId?:string} = {}) {
    this.db.putRecord('event',{...context(a),id:randomUUID(),at:Date.now(),type,summary,...links});
  }
  accept(a:Attempt,title:string) {
    this.db.putRecord('attempt',a);
    const old=this.db.record<TaskRow>('task',a.taskId);
    const role=a.parentTaskId?(a.workerRole??'worker'):'coordinator';
    this.db.putRecord('task',{...context(a),id:a.taskId,title,role,status:'queued',dependencies:[],
      toolIds:old?.toolIds??[],artifactIds:old?.artifactIds??[]} satisfies TaskRow);
    this.db.putRecord('agent',{...context(a),id:a.taskId,name:title,role,status:'queued',...(a.model?{model:a.model}:{})});
    this.event(a,'dispatch_accepted','Turn accepted for one Pi dispatch.');
  }
  wait(a:Attempt,tasks:readonly TaskRow[]) {
    const task=this.db.record<TaskRow>('task',a.taskId);
    if(!task)throw new Error('Wait without an owning task.');
    this.db.putRecord('task',{...task,dependencies:tasks.map(child=>child.id)});
    if(tasks.some(child=>pending(child.status))) {
      this.transition(a,'blocked');
      this.event(a,'wait_started','Waiting for '+tasks.length+' child tasks.');
    }
  }
  transition(a:Attempt,status:Status,error?:string) {
    const prev=this.db.record<Attempt>('attempt',a.id);
    if(!prev || !pending(prev.status)) return;
    const at=Date.now();
    this.db.putRecord('attempt',{...prev,status,startedAt:prev.startedAt??(status==='running'?at:null),
      endedAt:pending(status)?null:at,error});
    if(!pending(status)) {
      for(const t of this.db.records<Tool & Context>('tool',a.sessionId)) if(t.attemptId===a.id && pending(t.status))
        this.db.putRecord('tool',{...t,status:status==='succeeded'?'failed':status});
      this.event(a,status==='paused'?'interrupted':'attempt_'+status,error??('Turn '+status+'.'));
    }
    // A queued send is already durable. Finishing its predecessor must not mark the task terminal.
    const turns=this.db.records<Attempt>('attempt',a.sessionId).filter(t=>t.taskId===a.taskId);
    const current=turns.find(t=>pending(t.status))??turns.at(-1);
    const task=this.db.record<TaskRow>('task',a.taskId);
    if(!task || !current) throw new Error('Attempt without an owning task.');
    this.db.putRecord('task',{...task,attemptId:current.id,status:current.status,result:current.result,error:current.error});
    const agent=this.db.record<{id:string;projectId:string;sessionId:string;runId:string}>('agent',a.taskId);
    if(agent)this.db.putRecord('agent',{...agent,attemptId:current.id,status:current.status});
    const run=this.db.record<Run>('run',a.runId);
    if(!run || !pending(run.status))return;
    const root=this.db.record<TaskRow>('task',run.taskId);
    if(!root)throw new Error('Run without root task.');
    const childrenPending=this.db.records<TaskRow>('task',a.sessionId).some(t=>t.runId===a.runId && t.parentTaskId && pending(t.status));
    const overall=pending(root.status)?root.status:childrenPending?'blocked':root.status;
    if(pending(overall)){
      this.db.putRecord('run',{...run,status:overall,startedAt:run.startedAt??(overall==='running'?at:null),endedAt:null,error:root.error});
    }else if(run.cancellationRequested){
      this.finishRun(run,'cancelled','Run cancelled by request.');
    }else this.finishRun(run,overall,root.error);
  }
  finishRun(run:Run,status:Status,error?:string) {
    this.db.putRecord('run',{...run,status,endedAt:Date.now(),error});
    const receipt=this.db.receipt(run.sessionId,run.requestId);
    // A manual recovery may reopen the run projection, but never rewrites a previously
    // settled prompt receipt. Its own retry receipt names the newly accepted attempts.
    if(receipt?.state==='accepted')this.db.putReceipt({...receipt,state:status==='paused'?'interrupted':status==='succeeded'?'completed':'failed',
      response:status==='succeeded'?receipt.response:{type:'response',command:'prompt',id:run.requestId,success:false,
        error:error??('Run '+status+'.'),data:{runId:run.id,taskId:run.taskId,status}}});
    const root=this.db.record<TaskRow>('task',run.taskId);
    this.db.putRecord('event',{...(root?.attemptId?context(root):{projectId:run.projectId,sessionId:run.sessionId,runId:run.id,taskId:run.taskId}),
      id:randomUUID(),type:status==='paused'?'interrupted':'run_'+status,at:Date.now(),summary:error??('Run '+status+'.')});
  }
  receive(a:Attempt,event:Event,cancelling:boolean) {
    this.db.putRecord('pi_event',{...context(a),id:randomUUID(),at:Date.now(),event});
    const current=this.db.record<Attempt>('attempt',a.id);
    if(!current || !pending(current.status))return;
    switch(event.type){
      case 'agent_start':this.transition(a,'running');break;
      case 'message_end': if(object(event.message)&&event.message.role==='assistant') {
        const msg=event.message;
        const result=Array.isArray(msg.content)?msg.content.filter(object).filter(p=>p.type==='text').map(p=>String(p.text??'')).join('\n'):undefined;
        this.db.putRecord('attempt',{...current,result,error:msg.stopReason==='error'?String(msg.errorMessage??'Assistant failed.'):undefined});
      } break;
      case 'auto_retry_end':if(event.success===false)this.db.putRecord('attempt',{...current,error:String(event.finalError??'Retry failed.')});break;
      case 'agent_settled':this.transition(a,event.aborted===true||cancelling?'cancelled':current.error?'failed':!current.startedAt?'paused':'succeeded',current.error);break;
      case 'tool_execution_start':case 'tool_execution_end':this.tool(a,event);break;
    }
  }
  tool(a:Attempt,event:Event){
    if(typeof event.toolCallId!=='string')return;
    const id=toolId(a,event.toolCallId),prev=this.db.record<Tool>('tool',id);
    const result=event.result??event.partialResult;
    const output=object(result)&&Array.isArray(result.content)?result.content.filter(object).filter(p=>p.type==='text').map(p=>String(p.text??'')).join('\n'):'';
    const name=typeof event.toolName==='string'?event.toolName:prev?.name??'tool';
    this.db.putRecord('tool',{...prev,...context(a),id,name,sdkToolName:name,rawToolCallId:event.toolCallId,args:event.args??prev?.args,
      status:event.type==='tool_execution_end'?event.isError===true?'failed':'succeeded':'running',logs:output?[...(prev?.logs??[]),{at:Date.now(),text:output}]:prev?.logs??[]});
    const task=this.db.record<TaskRow>('task',a.taskId);
    if(task&&!task.toolIds.includes(id))this.db.putRecord('task',{...task,toolIds:[...task.toolIds,id]});
  }
  process(event:JobEvent) {
    const job=event.attempt,tool=this.db.record<Tool & Context>('tool',job.toolId);
    if(!tool || tool.projectId!==job.projectId || tool.sessionId!==job.sessionId || tool.taskId!==job.taskId)throw new Error('Process has no owning tool.');
    const ctx=context(tool), processId=job.attemptId;
    const evidence=job.analysis?.inputs.flatMap(f=>f.fileId && f.versionId?[{id:f.fileId,version:f.versionId}]:[])??
      (job.grant?[{id:job.grant.fileId,version:job.grant.versionId}]:[]);
    this.db.putRecord('process',{...ctx,id:processId,processId,toolId:tool.id,status:job.status,job,evidence} satisfies ProcessRow);
    const files=job.artifacts??(job.artifact?[job.artifact]:[]);
    const links={toolId:tool.id,processId,artifactId:files[0]?.id};
    this.event(ctx,event.type,event.type==='process_output'?event.stream+': '+event.text:event.type+': '+job.status,links);
    this.db.putRecord('tool',{...tool,processId,exitCode:job.exitCode,logs:event.type==='process_output'?[...tool.logs,{at:Date.now(),text:event.text}]:tool.logs});
    if(job.status==='succeeded' && files.length) {
      for(const file of files){
        if(file.projectId!==ctx.projectId || file.sessionId!==ctx.sessionId || file.attemptId!==processId || ('taskId' in file && file.taskId!==ctx.taskId))
          throw new Error('Produced artifact has inconsistent scope.');
        const ref=artifactRef(file);
        this.db.putRecord('artifact',{...ctx,toolId:tool.id,processId,id:file.id,file,version:ref.version,title:file.name,kind:file.name.split('.').at(-1)??'text',status:'ready',location:{uri:ref.uri,label:file.name},
          review:{status:'unreviewed',version:ref.version},evidence:[...evidence]} satisfies ArtifactRow);
      }
      const task=this.db.record<TaskRow>('task',ctx.taskId);
      if(!task)throw new Error('Process has no owning task.');
      this.db.putRecord('task',{...task,artifactIds:[...new Set([...task.artifactIds,...files.map(f=>f.id)])]});
    }
  }
}
