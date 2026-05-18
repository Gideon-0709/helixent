import { extname } from "node:path";

import YAML from "yaml";

import type { WorkflowDefinition, WorkflowInputDefinition, WorkflowStep } from "./workflow-types";

export async function readWorkflowFile(path: string): Promise<WorkflowDefinition> {
  const content = await Bun.file(path).text();
  const extension = extname(path).toLowerCase();
  const parsed = extension === ".json" ? JSON.parse(content) : YAML.parse(content);
  return validateWorkflowDefinition(parsed);
}

export function validateWorkflowDefinition(value: unknown): WorkflowDefinition {
  const workflow = expectRecord(value, "Workflow");
  const id = expectString(workflow.id, "Workflow id");
  const name = expectString(workflow.name, "Workflow name");
  const version = expectNumber(workflow.version, "Workflow version");
  const steps = expectArray(workflow.steps, "Workflow steps").map((step, index) => validateWorkflowStep(step, index));
  if (steps.length === 0) {
    throw new Error("Workflow must contain at least one step");
  }

  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new Error(`Duplicate workflow step id "${step.id}"`);
    }
    seen.add(step.id);
  }

  return {
    id,
    name,
    version,
    agentTypes: workflow.agentTypes === undefined ? undefined : expectStringArray(workflow.agentTypes, "Workflow agentTypes"),
    inputs: workflow.inputs === undefined ? undefined : validateWorkflowInputs(workflow.inputs),
    steps,
  };
}

function validateWorkflowInputs(value: unknown): Record<string, WorkflowInputDefinition> {
  const inputs = expectRecord(value, "Workflow inputs");
  return Object.fromEntries(
    Object.entries(inputs).map(([key, input]) => {
      const definition = expectRecord(input, `Workflow input "${key}"`);
      return [
        key,
        {
          type: definition.type === undefined ? undefined : expectString(definition.type, `Workflow input "${key}" type`),
          required: definition.required === undefined ? undefined : expectBoolean(definition.required, `Workflow input "${key}" required`),
          description: definition.description === undefined
            ? undefined
            : expectString(definition.description, `Workflow input "${key}" description`),
        },
      ];
    }),
  );
}

function validateWorkflowStep(value: unknown, index: number): WorkflowStep {
  const label = `Workflow step ${index + 1}`;
  const step = expectRecord(value, label);
  const id = expectString(step.id, `${label} id`);
  const type = expectString(step.type, `${label} type`);
  const base = {
    id,
    name: step.name === undefined ? undefined : expectString(step.name, `${label} name`),
    input: step.input,
  };

  if (type === "tool") {
    return {
      ...base,
      type,
      tool: expectString(step.tool, `${label} tool`),
    };
  }

  if (type === "agent") {
    return {
      ...base,
      type,
      skill: step.skill === undefined ? undefined : expectString(step.skill, `${label} skill`),
      message: step.message === undefined ? undefined : expectString(step.message, `${label} message`),
      outputSchema: step.outputSchema === undefined ? undefined : expectString(step.outputSchema, `${label} outputSchema`),
    };
  }

  throw new Error(`${label} type must be "tool" or "agent"`);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function expectStringArray(value: unknown, label: string): string[] {
  return expectArray(value, label).map((item, index) => expectString(item, `${label}[${index}]`));
}
