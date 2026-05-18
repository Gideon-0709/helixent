import type { Agent } from "@/agent/agent";
import type { TraceEventInput } from "@/agent/trace";
import type { Tool, UserMessage } from "@/foundation";

import { validateWorkflowDefinition } from "./workflow-reader";
import type { WorkflowAgentStep, WorkflowDefinition, WorkflowRunResult, WorkflowStep, WorkflowStepResult, WorkflowToolStep } from "./workflow-types";

export interface WorkflowRunOptions {
  workflow: WorkflowDefinition;
  input?: Record<string, unknown>;
  tools?: Tool[];
  resolveAgent?: (step: WorkflowAgentStep, context: WorkflowExecutionContext) => Agent | Promise<Agent>;
  signal?: AbortSignal;
}

export interface WorkflowExecutionContext {
  input: Record<string, unknown>;
  steps: Record<string, WorkflowStepResult>;
}

export type WorkflowRunnerEvent = Extract<
  TraceEventInput,
  {
    type:
    | "workflow_started"
    | "workflow_step_started"
    | "workflow_step_completed"
    | "workflow_step_failed"
    | "workflow_completed"
    | "workflow_failed";
  }
>;

export async function* runWorkflow(options: WorkflowRunOptions): AsyncGenerator<WorkflowRunnerEvent, WorkflowRunResult> {
  const workflow = validateWorkflowDefinition(options.workflow);
  const input = options.input ?? {};
  const context: WorkflowExecutionContext = { input, steps: {} };
  const workflowStartedAt = Date.now();

  yield {
    type: "workflow_started",
    workflowId: workflow.id,
    workflowName: workflow.name,
    input,
  };

  try {
    for (const [index, step] of workflow.steps.entries()) {
      options.signal?.throwIfAborted();
      const stepStartedAt = Date.now();
      yield {
        type: "workflow_step_started",
        workflowId: workflow.id,
        stepId: step.id,
        stepIndex: index,
        stepType: step.type,
      };

      try {
        const result = step.type === "tool"
          ? await runToolStep(step, context, options)
          : await runAgentStep(step, context, options);
        const stepResult: WorkflowStepResult = {
          id: step.id,
          type: step.type,
          result,
          durationMs: Date.now() - stepStartedAt,
        };
        context.steps[step.id] = stepResult;
        yield {
          type: "workflow_step_completed",
          workflowId: workflow.id,
          stepId: step.id,
          stepIndex: index,
          stepType: step.type,
          durationMs: stepResult.durationMs,
          result,
        };
      } catch (error) {
        const message = errorMessage(error);
        yield {
          type: "workflow_step_failed",
          workflowId: workflow.id,
          stepId: step.id,
          stepIndex: index,
          stepType: step.type,
          durationMs: Date.now() - stepStartedAt,
          error: { message },
        };
        throw error;
      }
    }

    const result = buildRunResult(workflow, context);
    yield {
      type: "workflow_completed",
      workflowId: workflow.id,
      workflowName: workflow.name,
      durationMs: Date.now() - workflowStartedAt,
      result,
    };
    return result;
  } catch (error) {
    yield {
      type: "workflow_failed",
      workflowId: workflow.id,
      workflowName: workflow.name,
      durationMs: Date.now() - workflowStartedAt,
      error: { message: errorMessage(error) },
    };
    throw error;
  }
}

async function runToolStep(step: WorkflowToolStep, context: WorkflowExecutionContext, options: WorkflowRunOptions): Promise<unknown> {
  const tool = options.tools?.find((candidate) => candidate.name === step.tool);
  if (!tool) {
    throw new Error(`Tool "${step.tool}" not found`);
  }
  return tool.invoke(resolveStepInput(step, context), options.signal);
}

async function runAgentStep(step: WorkflowAgentStep, context: WorkflowExecutionContext, options: WorkflowRunOptions): Promise<string> {
  if (!options.resolveAgent) {
    throw new Error(`Agent step "${step.id}" requires resolveAgent`);
  }

  const agent = await options.resolveAgent(step, context);
  const messageText = step.message ? resolveTemplate(step.message, context) : JSON.stringify(resolveStepInput(step, context));
  const message: UserMessage = { role: "user", content: [{ type: "text", text: messageText }] };
  let finalAnswer = "";

  if (step.skill) {
    agent.setRequestedSkillName(step.skill);
  }
  try {
    for await (const event of agent.stream(message)) {
      if (event.type === "final_answer") {
        finalAnswer = event.text;
      }
    }
  } finally {
    if (step.skill) {
      agent.setRequestedSkillName(null);
    }
  }

  return finalAnswer;
}

function resolveStepInput(step: WorkflowStep, context: WorkflowExecutionContext): Record<string, unknown> {
  const rawInput = step.input === undefined ? "$input" : step.input;
  const resolved = resolveValue(rawInput, context);
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
    throw new Error(`Workflow step "${step.id}" input must resolve to an object`);
  }
  return resolved as Record<string, unknown>;
}

function resolveValue(value: unknown, context: WorkflowExecutionContext): unknown {
  if (typeof value === "string") {
    if (value.startsWith("$") && isSingleReference(value)) {
      return resolveReference(value, context);
    }
    return resolveTemplate(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, context));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveValue(item, context)]),
    );
  }
  return value;
}

function resolveTemplate(value: string, context: WorkflowExecutionContext): string {
  return value.replace(/\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*/g, (match) => {
    const resolved = resolveReference(match, context);
    return typeof resolved === "string" ? resolved : String(resolved);
  });
}

function resolveReference(reference: string, context: WorkflowExecutionContext): unknown {
  const segments = reference.slice(1).split(".");
  let current: unknown = { input: context.input, steps: context.steps };

  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error(`Workflow reference "${reference}" could not be resolved`);
    }
    current = (current as Record<string, unknown>)[segment];
  }

  if (current === undefined) {
    throw new Error(`Workflow reference "${reference}" could not be resolved`);
  }
  return current;
}

function isSingleReference(value: string): boolean {
  return /^\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*$/.test(value);
}

function buildRunResult(workflow: WorkflowDefinition, context: WorkflowExecutionContext): WorkflowRunResult {
  const lastStep = workflow.steps.at(-1);
  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    steps: context.steps,
    result: lastStep ? context.steps[lastStep.id]?.result : undefined,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
