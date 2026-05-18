import { describe, expect, test } from "bun:test";

import { z } from "zod";

import {
  defineTool,
  Model,
  type AssistantMessage,
  type ModelProvider,
  type ModelProviderInvokeParams,
} from "@/foundation";

import { Agent } from "../agent";

class ToolCallingProvider implements ModelProvider {
  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    for await (const message of this.stream(params)) {
      if (!message.streaming) return message;
    }
    throw new Error("No message");
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    const hasToolResult = params.messages.some((message) => message.role === "tool");
    if (!hasToolResult) {
      yield {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_call_1",
            name: "echo",
            input: { value: "hello" },
          },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
      return;
    }

    yield {
      role: "assistant",
      content: [{ type: "text", text: "final answer" }],
      usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 },
    };
  }
}

describe("Agent trace events", () => {
  test("emits run, model, tool, token, and completion events around the loop", async () => {
    const tool = defineTool({
      name: "echo",
      description: "Echo a value",
      parameters: z.object({ value: z.string() }),
      invoke: async (input) => ({ ok: true, summary: input.value }),
    });
    const agent = new Agent({
      model: new Model("test-model", new ToolCallingProvider()),
      prompt: "You are a test agent.",
      tools: [tool],
    });

    const events = [];
    for await (const event of agent.stream({ role: "user", content: [{ type: "text", text: "run" }] })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toContain("run_started");
    expect(events.map((event) => event.type)).toContain("model_started");
    expect(events.map((event) => event.type)).toContain("model_completed");
    expect(events.map((event) => event.type)).toContain("tool_started");
    expect(events.map((event) => event.type)).toContain("tool_completed");
    expect(events.map((event) => event.type)).toContain("token_usage");
    expect(events.at(-1)).toMatchObject({ type: "run_completed" });
  });
});
