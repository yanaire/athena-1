import type { ModelReference } from '../athena-backend-handoff/athena-codex-ui/integrations/task-manager.d.ts';

export const workerRoles = {
  worker: 'General worker',
  mission: 'Experiment mission planner',
  literature: 'Literature research',
  experiment: 'Experiment',
  verification: 'Experiment verification',
  writer: 'Manuscript writing',
  editor: 'Manuscript editing',
  reviewer: 'Independent manuscript review',
} as const satisfies Record<import('../athena-backend-handoff/athena-codex-ui/integrations/model-profiles.d.ts').WorkerRoleKey, string>;
export type WorkerRole = keyof typeof workerRoles;
export type RoleModels = Partial<Record<WorkerRole, ModelReference>>;
