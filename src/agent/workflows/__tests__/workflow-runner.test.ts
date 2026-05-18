import { describe, expect, test } from "bun:test";

import { z } from "zod";

import { Agent } from "@/agent";
import { defineTool, Model, type AssistantMessage, type ModelProvider, type ModelProviderInvokeParams } from "@/foundation";

import { runWorkflow } from "../workflow-runner";
import type { WorkflowRunnerEvent } from "../workflow-runner";

class FinalTextProvider implements ModelProvider {
  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    for await (const message of this.stream(params)) {
      if (!message.streaming) return message;
    }
    throw new Error("No message");
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    const input = params.messages.at(-1)?.content.find((content) => content.type === "text")?.text ?? "";
    yield {
      role: "assistant",
      content: [{ type: "text", text: `agent saw ${input}` }],
    };
  }
}

describe("workflow runner", () => {
  test("runs tool and agent steps in order with referenced inputs", async () => {
    const calls: unknown[] = [];
    const tool = defineTool({
      name: "erp.query_metrics",
      description: "Query metrics",
      parameters: z.object({ scopeId: z.string() }),
      invoke: async (input) => {
        calls.push(input);
        return { revenue: 3500, scopeId: input.scopeId };
      },
    });
    const agent = new Agent({
      model: new Model("workflow-test-model", new FinalTextProvider()),
      prompt: "You are a workflow test agent.",
    });

    const events: WorkflowRunnerEvent[] = [];
    let result;
    for await (const event of runWorkflow({
      workflow: {
        id: "business-brief",
        name: "Business Brief",
        version: 1,
        steps: [
          {
            id: "query_metrics",
            type: "tool",
            tool: "erp.query_metrics",
            input: { scopeId: "$input.scopeId" },
          },
          {
            id: "generate_brief",
            type: "agent",
            message: "Revenue is $steps.query_metrics.result.revenue",
          },
        ],
      },
      input: { scopeId: "company" },
      tools: [tool],
      resolveAgent: async () => agent,
    })) {
      events.push(event);
      if (event.type === "workflow_completed") {
        result = event.result;
      }
    }

    expect(calls).toEqual([{ scopeId: "company" }]);
    expect(events.map((event) => event.type)).toEqual([
      "workflow_started",
      "workflow_step_started",
      "workflow_step_completed",
      "workflow_step_started",
      "workflow_step_completed",
      "workflow_completed",
    ]);
    expect(result).toMatchObject({
      steps: {
        query_metrics: { result: { revenue: 3500, scopeId: "company" } },
        generate_brief: { result: "agent saw Revenue is 3500" },
      },
    });
  });

  test("fails when a tool step references an unknown tool", async () => {
    const events: WorkflowRunnerEvent[] = [];

    await expect(async () => {
      for await (const event of runWorkflow({
        workflow: {
          id: "missing-tool",
          name: "Missing Tool",
          version: 1,
          steps: [{ id: "call_missing", type: "tool", tool: "missing.tool" }],
        },
      })) {
        events.push(event);
      }
    }).toThrow('Tool "missing.tool" not found');

    expect(events.map((event) => event.type)).toEqual(["workflow_started", "workflow_step_started", "workflow_step_failed", "workflow_failed"]);
  });
});
