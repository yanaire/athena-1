import type { ProcessRow } from './orchestration.ts';

export type ResearchAutonomy = {
  state:'active'|'recovering'|'waiting'|'blocked'|'stopped'|'completed';
  reason:string;
  attempts:number;
  limit:number;
  nextAttemptAt?:number;
  failures?:number;
  uncertainProcessIds?:string[];
};
export const newAutonomy = ():ResearchAutonomy => ({
  state:'active',reason:'The research coordinator is carrying out the plan.',attempts:0,limit:6
});
export const autonomous = (s:ResearchAutonomy) =>
  s.state==='active' || s.state==='recovering' || s.state==='waiting';

// A later successful handshake clears a pre-dispatch outage. An invocation
// with unknown remote effects still requires reconciliation by its operator.
export function recoveryConnections(processes:readonly ProcessRow[],confirmed:readonly string[]=[]) {
  const uncertain:ProcessRow[]=[];
  const unavailable=new Map<string,ProcessRow>();
  for(const row of processes){
    const {externalMcp,externalFailure}=row.job;
    if(!externalMcp)continue;
    if(externalFailure==='outcome_unknown' || (!externalFailure && row.status!=='succeeded' &&
        (row.job.cancellation==='unknown'||row.job.mcp?.phase==='tools/call')))
      {if(!confirmed.includes(row.id))uncertain.push(row);}
    if(externalFailure==='blocked'||externalFailure==='connection')
      unavailable.set(externalMcp.serverId,row);
    if(row.status==='succeeded')unavailable.delete(externalMcp.serverId);
  }
  if(uncertain.length){
    const calls=uncertain.map(row=>row.job.externalMcp!.serverId+'/'+row.job.externalMcp!.tool);
    return {blocked:'Check the remote outcome before resuming. The server may have executed '+[...new Set(calls)].join(', ')+'.',
      uncertainProcessIds:uncertain.map(r=>r.id)};
  }
  return {unavailable:[...unavailable.values()]};
}
