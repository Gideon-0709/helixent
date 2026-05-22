import { describe, expect, test } from "bun:test";

import {
  Model,
  type AssistantMessage,
  type Message,
  type ModelContext,
  type ModelProvider,
  type ModelProviderInvokeParams,
  type NonSystemMessage,
  type UserMessage,
} from "@/foundation";

import { Agent, type AgentContext } from "../agent";
import { createContextCompactionMiddleware, createModelContextSummarizer } from "../context-compaction-middleware";

class CapturingProvider implements ModelProvider {
  readonly calls: Message[][] = [];

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    for await (const message of this.stream(params)) {
      return message;
    }
    throw new Error("No message");
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    this.calls.push(params.messages);
    yield {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    };
  }
}

describe("createContextCompactionMiddleware", () => {
  test("summarizes older transcript messages and keeps recent messages verbatim", async () => {
    const provider = new CapturingProvider();
    const compactedMessageCounts: number[] = [];
    const agent = new Agent({
      model: new Model("test-model", provider),
      prompt: "test prompt",
      messages: [
        textMessage("user", "u1"),
        textMessage("assistant", "a1"),
        textMessage("user", "u2"),
        textMessage("assistant", "a2"),
        textMessage("user", "u3"),
        textMessage("assistant", "a3"),
      ],
      middlewares: [
        createContextCompactionMiddleware({
          maxMessagesBeforeCompact: 4,
          keepRecentMessages: 2,
          summarize: async ({ messages }) => {
            compactedMessageCounts.push(messages.length);
            return "summary of older messages";
          },
        }),
      ],
    });

    await drain(agent.stream(userMessage("u4")));

    expect(compactedMessageCounts).toEqual([5]);
    const sentMessages = provider.calls[0]!;
    expect(sentMessages).toHaveLength(4);
    expect(textContent(sentMessages[1]!)).toContain("summary of older messages");
    expect(textContent(sentMessages[2]!)).toBe("a3");
    expect(textContent(sentMessages[3]!)).toBe("u4");
    expect(agent.messages.map((message) => message.role)).toEqual(["assistant", "assistant", "user", "assistant"]);
  });

  test("emits a context compaction event before invoking the model", async () => {
    const provider = new CapturingProvider();
    const agent = new Agent({
      model: new Model("test-model", provider),
      prompt: "test prompt",
      messages: [
        textMessage("user", "u1"),
        textMessage("assistant", "a1"),
        textMessage("user", "u2"),
        textMessage("assistant", "a2"),
      ],
      middlewares: [
        createContextCompactionMiddleware({
          maxMessagesBeforeCompact: 4,
          keepRecentMessages: 2,
          summarize: async () => "summary of earlier messages",
        }),
      ],
    });

    const events = [];
    for await (const event of agent.stream(userMessage("u3"))) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "prompt_loaded",
      "skills_loaded",
      "tools_registered",
      "step_started",
      "context_compacted",
      "model_started",
      "model_completed",
      "assistant_message",
      "message",
      "final_answer",
      "step_completed",
      "run_completed",
    ]);
    expect(events[5]).toMatchObject({
      type: "context_compacted",
      previousMessageCount: 5,
      currentMessageCount: 3,
      compactedMessageCount: 3,
      keptMessageCount: 2,
      summaryPreview: "Helixent compacted context summary:\nsummary of earlier messages",
    });
  });

  test("keeps assistant tool calls with their tool results when choosing the recent window", async () => {
    const provider = new CapturingProvider();
    const agent = new Agent({
      model: new Model("test-model", provider),
      prompt: "test prompt",
      messages: [
        textMessage("user", "u1"),
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool_1", name: "lookup", input: {} }],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "lookup result" }],
        },
        textMessage("assistant", "a1"),
        textMessage("user", "u2"),
      ],
      middlewares: [
        createContextCompactionMiddleware({
          maxMessagesBeforeCompact: 4,
          keepRecentMessages: 4,
          summarize: async () => "summary before tool call",
        }),
      ],
    });

    await drain(agent.stream(userMessage("u3")));

    expect(provider.calls[0]!.map((message) => message.role)).toEqual(["system", "assistant", "assistant", "tool", "assistant", "user", "user"]);
    expect(agent.messages.map((message) => message.role)).toEqual(["assistant", "assistant", "tool", "assistant", "user", "user", "assistant"]);
  });

  test("leaves the transcript uncompressed when summarization fails", async () => {
    const provider = new CapturingProvider();
    const agent = new Agent({
      model: new Model("test-model", provider),
      prompt: "test prompt",
      messages: [
        textMessage("user", "u1"),
        textMessage("assistant", "a1"),
        textMessage("user", "u2"),
        textMessage("assistant", "a2"),
      ],
      middlewares: [
        createContextCompactionMiddleware({
          maxMessagesBeforeCompact: 4,
          keepRecentMessages: 2,
          summarize: async () => {
            throw new Error("summary unavailable");
          },
        }),
      ],
    });

    await drain(agent.stream(userMessage("u3")));

    expect(provider.calls[0]!.map((message) => textContent(message))).toEqual([
      "test prompt",
      "u1",
      "a1",
      "u2",
      "a2",
      "u3",
    ]);
  });

  test("summarizes transcript text with a model-backed summarizer", async () => {
    const provider = new CapturingSummaryProvider();
    const summarize = createModelContextSummarizer(new Model("summary-model", provider));

    const summary = await summarize({
      messages: [
        textMessage("user", "What happened yesterday?"),
        textMessage("assistant", "Revenue increased by 12%."),
      ],
    });

    expect(summary).toBe("compressed summary");
    expect(textContent(provider.calls[0]![0]!)).toContain("compact conversation history");
    expect(textContent(provider.calls[0]![1]!)).toContain("user: What happened yesterday?");
    expect(textContent(provider.calls[0]![1]!)).toContain("assistant: Revenue increased by 12%.");
  });

  test("propagates aborts while summarizing", async () => {
    const abortController = new AbortController();
    abortController.abort(new DOMException("aborted", "AbortError"));
    const middleware = createContextCompactionMiddleware({
      maxMessagesBeforeCompact: 2,
      keepRecentMessages: 1,
      summarize: async ({ signal }) => {
        signal?.throwIfAborted();
        return "summary";
      },
    });

    await expect(
      middleware.beforeModel?.({
        agentContext: {
          prompt: "test prompt",
          messages: [textMessage("user", "u1"), textMessage("assistant", "a1"), userMessage("u2")],
        } satisfies AgentContext,
        modelContext: {
          prompt: "test prompt",
          messages: [],
          signal: abortController.signal,
        } satisfies ModelContext,
      }),
    ).rejects.toThrow("aborted");
  });
});

class CapturingSummaryProvider implements ModelProvider {
  readonly calls: Message[][] = [];

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    this.calls.push(params.messages);
    return {
      role: "assistant",
      content: [{ type: "text", text: "compressed summary" }],
    };
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    yield await this.invoke(params);
  }
}

function textMessage(role: "assistant" | "user", text: string): NonSystemMessage {
  return {
    role,
    content: [{ type: "text", text }],
  };
}

function userMessage(text: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
  };
}

function textContent(message: Message): string {
  return message.content
    .map((content) => {
      if (content.type === "text") return content.text;
      if (content.type === "tool_result") return content.content;
      return "";
    })
    .join("\n");
}

async function drain(stream: AsyncGenerator<unknown>) {
  for await (const event of stream) {
    void event;
  }
}
