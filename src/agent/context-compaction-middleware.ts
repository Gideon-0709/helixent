import type { AssistantMessage, AssistantMessageContent, Model, NonSystemMessage, UserMessageContent } from "@/foundation";

import type { AgentMiddleware } from "./agent-middleware";

const SUMMARY_PREFIX = "Helixent compacted context summary";

export interface ContextCompactionOptions {
  keepRecentMessages?: number;
  maxMessagesBeforeCompact?: number;
  maxSummaryCharacters?: number;
  // eslint-disable-next-line no-unused-vars
  summarize: (params: {
    messages: NonSystemMessage[];
    signal?: AbortSignal;
  }) => Promise<string>;
}

export function createContextCompactionMiddleware({
  keepRecentMessages = 8,
  maxMessagesBeforeCompact = 24,
  maxSummaryCharacters = 4_000,
  summarize,
}: ContextCompactionOptions): AgentMiddleware {
  return {
    async beforeModel({ agentContext, modelContext }) {
      const messages = agentContext.messages;
      if (messages.length <= maxMessagesBeforeCompact) return;
      if (messages.at(-1)?.role !== "user") return;

      const splitIndex = chooseSplitIndex(messages, keepRecentMessages);
      if (splitIndex <= 0) return;

      const olderMessages = messages.slice(0, splitIndex);
      const recentMessages = messages.slice(splitIndex);
      const summary = await safeSummarize({ messages: olderMessages, signal: modelContext.signal, summarize });
      if (!summary) return;

      const compactedMessages = [
        createSummaryMessage(truncateSummary(summary, maxSummaryCharacters)),
        ...recentMessages,
      ];
      messages.splice(0, messages.length, ...compactedMessages);
      modelContext.messages = messages;
    },
  };
}

export function createModelContextSummarizer(model: Model): ContextCompactionOptions["summarize"] {
  return async ({ messages, signal }) => {
    const response = await model.invoke({
      prompt: [
        "You compact conversation history for a ReAct-style agent.",
        "Write a concise, factual summary that preserves user goals, constraints, decisions, tool results, and unresolved tasks.",
        "Do not invent details. Keep names, IDs, dates, and numbers exactly when they matter.",
      ].join("\n"),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Please compact conversation history into a durable summary:\n\n${formatMessagesForSummary(messages)}`,
            },
          ],
        },
      ],
      signal,
    });
    return assistantText(response);
  };
}

async function safeSummarize({
  messages,
  signal,
  summarize,
}: {
  messages: NonSystemMessage[];
  signal?: AbortSignal;
  summarize: ContextCompactionOptions["summarize"];
}): Promise<string | null> {
  try {
    return (await summarize({ messages, signal })).trim();
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw error;
    }
    return null;
  }
}

function chooseSplitIndex(messages: NonSystemMessage[], keepRecentMessages: number): number {
  let splitIndex = Math.max(0, messages.length - Math.max(1, keepRecentMessages));
  while (splitIndex > 0 && messages[splitIndex]?.role === "tool") {
    splitIndex -= 1;
  }
  return splitIndex;
}

function createSummaryMessage(summary: string): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `${SUMMARY_PREFIX}:\n${summary}`,
      },
    ],
  };
}

function truncateSummary(summary: string, maxSummaryCharacters: number): string {
  if (summary.length <= maxSummaryCharacters) return summary;
  return `${summary.slice(0, maxSummaryCharacters).trimEnd()}\n[summary truncated]`;
}

function formatMessagesForSummary(messages: NonSystemMessage[]): string {
  return messages.map(formatMessageForSummary).join("\n\n");
}

function formatMessageForSummary(message: NonSystemMessage): string {
  if (message.role === "tool") {
    return `tool: ${message.content.map((content) => content.content).join("\n")}`;
  }
  return `${message.role}: ${message.content.map(formatContentForSummary).join("\n")}`;
}

function formatContentForSummary(content: AssistantMessageContent[number] | UserMessageContent[number]): string {
  if (content.type === "text") return content.text;
  if (content.type === "image_url") return `[image: ${content.image_url.url}]`;
  if (content.type === "thinking") return "[thinking omitted]";
  return `[tool_use: ${content.name} ${JSON.stringify(content.input)}]`;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}
