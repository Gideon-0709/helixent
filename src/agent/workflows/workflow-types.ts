export type WorkflowStepType = "agent" | "tool";

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: number;
  agentTypes?: string[];
  inputs?: Record<string, WorkflowInputDefinition>;
  steps: WorkflowStep[];
}

export interface WorkflowInputDefinition {
  type?: string;
  required?: boolean;
  description?: string;
}

export type WorkflowStep = WorkflowAgentStep | WorkflowToolStep;

export interface WorkflowStepBase {
  id: string;
  name?: string;
  type: WorkflowStepType;
  input?: unknown;
}

export interface WorkflowToolStep extends WorkflowStepBase {
  type: "tool";
  tool: string;
}

export interface WorkflowAgentStep extends WorkflowStepBase {
  type: "agent";
  skill?: string;
  message?: string;
  outputSchema?: string;
}

export interface WorkflowStepResult {
  id: string;
  type: WorkflowStepType;
  result: unknown;
  durationMs: number;
}

export interface WorkflowRunResult {
  workflowId: string;
  workflowName: string;
  steps: Record<string, WorkflowStepResult>;
  result: unknown;
}
