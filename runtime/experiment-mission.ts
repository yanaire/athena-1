import { ManagerError, object } from './orchestration.ts';
import type { ResearchTarget, ResearchMission } from './research.ts';

export const maxMissionTrials = 8;
export type ExperimentContract = {
  protocol: string;
  resultFile: string;
  measurementTool?: {serverId:string;tool:string};
  metricPath: string[];
  direction: 'at_most' | 'at_least';
  target: number;
  maxTrials: number;
  fileIds: string[];
};
export type MissionDecision =
  | { action: 'stop'; reason: string }
  | { action: 'experiment'; reason: string; instruction: string; parentTrial: number | null };
export type ChildReceipt = { coordinatorAttemptId:string; taskId: string; attemptId: string };
export type MissionTrial = {
  number: number;
  planners: ChildReceipt[];
  rejectedPlanner?: string;
  decision?: MissionDecision;
  worker?: ChildReceipt;
  workerNote?: string;
  outcome?: { value: number; artifact: ResearchTarget; evidenceId:string } | { error: string; candidate?:ResearchTarget };
};
export type ExperimentMission = {
  missionId: string;
  contract: ExperimentContract;
  status: 'running' | 'reached' | 'exhausted' | 'stopped' | 'blocked';
  trials: MissionTrial[];
  reason?: string;
  blockedAttempt?: string;
};

function invalid(message: string): never {
  throw new ManagerError('MISSION_INPUT', message);
}

export function experimentContract(input: unknown, grants: readonly string[]): ExperimentContract {
  if (!object(input)) invalid('Supply the measurement contract on the first mission call.');
  const {protocol, resultFile, metricPath, direction, target, maxTrials, fileIds = []} = input;
  if (typeof protocol !== 'string' || !protocol.trim() || protocol.length > 2500)
    invalid('Define the fixed method, units and permitted changes in at most 2500 characters.');
  if (typeof resultFile !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,90}\.json$/i.test(resultFile))
    invalid('Name one published JSON file.');
  if (!Array.isArray(metricPath) || metricPath.length > 10 ||
    !metricPath.every(k => typeof k === 'string' && k.length > 0 && k.length <= 100))
    invalid('Use at most ten JSON keys or array indices as strings.');
  if (direction !== 'at_most' && direction !== 'at_least') invalid('Choose at_most or at_least.');
  if (typeof target !== 'number' || !Number.isFinite(target)) invalid('Choose a finite numeric target.');
  if (typeof maxTrials !== 'number' || !Number.isSafeInteger(maxTrials) || maxTrials < 1 || maxTrials > maxMissionTrials)
    invalid('Choose between one and eight experiment trials.');
  if (!Array.isArray(fileIds) || fileIds.length > 32 || new Set(fileIds).size !== fileIds.length ||
    !fileIds.every(id => typeof id === 'string' && grants.includes(id)))
    invalid('Choose distinct file IDs granted to the coordinator.');
  let measurementTool: ExperimentContract['measurementTool'];
  if (input.measurementTool !== undefined) {
    const binding = input.measurementTool;
    const validId = (s:unknown): s is string => typeof s==='string' && s.length>0 && s.length<=256;
    if (!object(binding) || !validId(binding.serverId) || !validId(binding.tool))
      invalid('Identify the enabled measurement server and tool.');
    measurementTool={serverId:binding.serverId,tool:binding.tool};
  }
  return { protocol:protocol.trim(), resultFile, metricPath, direction, target, maxTrials,
    fileIds:[...fileIds].sort(), ...(measurementTool ? {measurementTool} : {}) };
}

export function missionPlannerPrompt(mission:ResearchMission, contract:ExperimentContract, previous:readonly MissionTrial[]) {
  const history=previous.map(t=>({
    number:t.number, parentTrial:t.decision?.action==='experiment'?t.decision.parentTrial:null,
    workerNote:t.workerNote, instruction:t.decision?.action==='experiment'?t.decision.instruction.slice(0,950):undefined,
    outcome:t.outcome && 'artifact' in t.outcome?
      {value:t.outcome.value,artifactId:t.outcome.artifact.id,version:t.outcome.artifact.version}:t.outcome && {error:t.outcome.error}
  }));
  return 'Select the next experiment under this fixed contract. Use host-measured values for comparisons. Treat worker notes as unverified observations, including any challenge to the method. '+
    'Return only JSON: {"action":"experiment","instruction":"concrete settings and method","reason":"why this test","parentTrial":null or an earlier trial number} '+
    'or {"action":"stop","reason":"why further trials cannot answer the question"}. Choose a different experiment when a prior one missed.\n'+
    'Objective: '+mission.objective.slice(0,3500)+'\nAcceptance criteria: '+JSON.stringify(mission.acceptanceCriteria).slice(0,3500)+
    '\nContract: '+JSON.stringify(contract)+'\nTrial history: '+JSON.stringify(history);
}

export function plannerDecision(reply: string, previous: readonly MissionTrial[]): MissionDecision {
  let parsed: unknown;
  try { parsed = JSON.parse(reply); } catch { invalid('The mission planner returned invalid JSON.'); }
  if (!object(parsed) || typeof parsed.reason !== 'string' || !parsed.reason.trim() || parsed.reason.length > 1000)
    invalid('The mission planner must give a short reason for its decision.');
  const reason = parsed.reason.trim();
  if (parsed.action === 'stop') return { action:'stop', reason };
  const { instruction, parentTrial } = parsed;
  if (parsed.action !== 'experiment' || typeof instruction !== 'string' || !instruction.trim() || instruction.length > 2500)
    invalid('The mission planner must specify a bounded experiment instruction.');
  if (parentTrial !== null && (typeof parentTrial !== 'number' || !previous.some(t => t.number === parentTrial && t.outcome)))
    invalid('The selected parent must be an earlier finished trial or null.');
  const normalized = (s: string) => s.trim().replace(/\s+/g,' ').toLowerCase();
  if (previous.some(t => t.decision?.action === 'experiment' && normalized(t.decision.instruction) === normalized(instruction)))
    invalid('The planner repeated an earlier experiment instruction.');
  return { action:'experiment', reason, instruction:instruction.trim(), parentTrial };
}

export function measuredMetric(bytes: Uint8Array, path: readonly string[]): number {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { invalid('Published result is invalid JSON.'); }
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value,key) ||
      (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)))
      invalid('Missing metric at '+JSON.stringify(path)+'.');
    value = (value as Record<string,unknown>)[key];
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid('The published metric must be a finite JSON number.');
  return value;
}

export function missionProgress(mission: ExperimentMission) {
  const {direction, target} = mission.contract;
  let best: {trial:number;value:number;artifact:ResearchTarget;evidenceId:string} | null = null;
  for (const t of mission.trials) {
    if (!t.outcome || !('value' in t.outcome)) continue;
    if (!best || (direction === 'at_most' ? t.outcome.value < best.value : t.outcome.value > best.value))
      best = {trial:t.number, ...t.outcome};
  }
  return {best, reached:best !== null && (direction === 'at_most' ? best.value <= target : best.value >= target)};
}
