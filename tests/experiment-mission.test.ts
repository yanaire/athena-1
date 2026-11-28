import assert from 'node:assert/strict';
import test from 'node:test';
import { createPiToolLoadout } from '../runtime/agent-tools.ts';
import { experimentContract, measuredMetric, missionProgress, plannerDecision, type ExperimentMission, type MissionTrial } from '../runtime/experiment-mission.ts';
import type { ResearchTarget } from '../runtime/research.ts';

const contract = experimentContract({
  protocol:'Measure the round-trip STEP volume in cubic millimetres.', resultFile:'mcp-result.json',
  metricPath:['rows','0','volume_mm3'], direction:'at_most', target:100, maxTrials:3
},[]);
const artifact:ResearchTarget = {kind:'artifact',id:'a',projectId:'p',sessionId:'s',version:'v',sha256:'digest',bytes:4};

test('experiment contracts bound the budget, file selection, artifact name and numeric target', () => {
  for (const change of [{maxTrials:0},{maxTrials:9},{maxTrials:2.5},{target:NaN},{target:'100'},
    {resultFile:'../mcp-result.json'},{direction:'about'},{fileIds:['another-run']},{fileIds:['granted','granted']},
    {measurementTool:{serverId:'',tool:'cad'}},{metricPath:Array(11).fill('field')}])
    assert.throws(()=>experimentContract({...contract,...change},['granted']));
  assert.deepEqual(experimentContract({...contract,fileIds:['b','a']},['a','b']).fileIds,['a','b']);
});

test('host measures finite JSON numbers from own properties and numeric array indices',()=>{
  const bytes=Buffer.from('{"rows":[{"volume_mm3":0,"text":"0","absent":null}]}');
  assert.equal(measuredMetric(bytes,contract.metricPath),0);
  for (const key of ['text','absent','missing','constructor'])assert.throws(()=>measuredMetric(bytes,['rows','0',key]));
  for (const key of ['length','00','-1'])assert.throws(()=>measuredMetric(bytes,['rows',key]));
  for (const raw of ['1e400','{"value":1','true'])assert.throws(()=>measuredMetric(Buffer.from(raw),[]));
  assert.equal(measuredMetric(Buffer.from('-2'),[]),-2);
});

test('planner decisions can select an earlier branch or stop and must identify a new experiment',()=>{
  const start={action:'experiment',reason:'Measure baseline',parentTrial:null,instruction:'Set bore to 8 mm'};
  const first:MissionTrial={number:1,planners:[],decision:plannerDecision(JSON.stringify(start),[]),outcome:{error:'No output'}};
  assert.equal(plannerDecision(JSON.stringify({...start,instruction:'Set bore to 9 mm',parentTrial:1}),[first]).action,'experiment');
  assert.deepEqual(plannerDecision('{"action":"stop","reason":"Equipment unavailable"}',[first]),{action:'stop',reason:'Equipment unavailable'});
  for(const change of [{parentTrial:2},{parentTrial:'1'},{instruction:' SET BORE   to 8 mm '},{reason:''}])
    assert.throws(()=>plannerDecision(JSON.stringify({...start,instruction:'Try a new bore',...change}),[first]));
  assert.throws(()=>plannerDecision('I measured 70.',[]));
});

test('missing measurements and later regressions do not replace the best observed artifact',()=>{
  const series:ExperimentMission={missionId:'m',contract,status:'running',trials:[]};
  series.trials.push({number:1,planners:[],outcome:{error:'missing'}});
  assert.deepEqual(missionProgress(series),{best:null,reached:false});
  const outcomes=[120,100,110];
  for(const [i,value] of outcomes.entries())series.trials.push({number:i+2,planners:[],outcome:{value,artifact:{...artifact,id:String(i)},evidenceId:String(i)}});
  assert.equal(missionProgress(series).best?.artifact.id,'1');
  assert.equal(missionProgress(series).reached,true);
  series.contract={...contract,direction:'at_least',target:121};
  assert.equal(missionProgress(series).best?.trial,2);
  assert.equal(missionProgress(series).reached,false);
});

test('only the enabled research coordinator can invoke a mission and the planner has no execution tools',()=>{
  const names=(role:'parent'|'child',researchWorkflow:boolean,executionEnabled:boolean,workerRole?:'mission'|'experiment')=>
    createPiToolLoadout('.', {role,executionEnabled,researchWorkflow,workerRole,execute:async()=>null}).customTools.map(t=>t.name);
  assert.ok(names('parent',true,true).includes('run_experiment_mission'));
  for(const set of [names('parent',false,true),names('parent',true,false),names('child',true,true,'experiment')])
    assert.ok(!set.includes('run_experiment_mission'));
  assert.deepEqual(names('child',true,true,'mission'),[]);
});
