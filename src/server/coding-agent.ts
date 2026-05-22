import { join } from "node:path";

import { createContextCompactionMiddleware, createModelContextSummarizer } from "@/agent";
import type { ModelEntry } from "@/cli/config";
import { loadConfig, ensureHelixentHomeEnv, getConfigFilePath } from "@/cli/config";
import { createRoleAgent, type AgentType } from "@/coding";
import { AnthropicModelProvider } from "@/community/anthropic";
import { OpenAIModelProvider } from "@/community/openai";
import type { ModelProvider } from "@/foundation";
import { Model } from "@/foundation";

import { createDebugResourceStore } from "./debug-resource-store";

export interface DebugContextCompactionPolicy {
  enabled: boolean;
  keepRecentMessages: number;
  maxMessagesBeforeCompact: number;
  maxSummaryCharacters: number;
}

export async function createDefaultDebugAgent(agentType: AgentType = "gma") {
  ensureHelixentHomeEnv();
  const cwd = process.cwd();
  const entry = resolveDebugModelEntry();
  const resourceStore = createDebugResourceStore({ cwd });

  let provider: ModelProvider;
  if (entry.provider === "anthropic") {
    provider = new AnthropicModelProvider({
      baseURL: entry.baseURL,
      apiKey: entry.APIKey,
    });
  } else {
    provider = new OpenAIModelProvider({
      baseURL: entry.baseURL,
      apiKey: entry.APIKey,
    });
  }

  const model = new Model(entry.name, provider, {
    max_tokens: 16 * 1024,
    thinking: {
      type: "enabled",
    },
  });

  return createRoleAgent({
    agentType,
    model,
    cwd,
    prompt: await resourceStore.getActivePromptContent(),
    skillsDirs: [
      join(cwd, "skills"),
      join(cwd, ".agents/skills"),
      join(Bun.env.HELIXENT_HOME!, "skills"),
      "~/.agents/skills",
      "~/.helixent/skills",
    ],
    askUser: async () => "deny",
    middlewares: createDebugContextCompactionMiddlewares(model),
  });
}

export const createDefaultDebugGmaAgent = createDefaultDebugAgent;

export function resolveDebugModelEntry(): ModelEntry {
  const deepSeekApiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (deepSeekApiKey) {
    return {
      name: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-pro",
      baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
      APIKey: deepSeekApiKey,
      provider: "openai",
    };
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (isMissingConfigError(error)) {
      throw new Error(`No model configured. Set DEEPSEEK_API_KEY in deploy/compose/.env or create ${getConfigFilePath()}.`, {
        cause: error,
      });
    }
    throw error;
  }
  const defaultModelName = config.defaultModel ?? config.models[0]?.name;
  const entry = defaultModelName ? config.models.find((model) => model.name === defaultModelName) : undefined;
  if (!entry) {
    throw new Error("No models configured. Set DEEPSEEK_API_KEY or run `helixent config model add`.");
  }
  return entry;
}

function createDebugContextCompactionMiddlewares(model: Model) {
  const policy = resolveDebugContextCompactionPolicy();
  if (!policy.enabled) {
    return [];
  }
  return [
    createContextCompactionMiddleware({
      maxMessagesBeforeCompact: policy.maxMessagesBeforeCompact,
      keepRecentMessages: policy.keepRecentMessages,
      maxSummaryCharacters: policy.maxSummaryCharacters,
      summarize: createModelContextSummarizer(model),
    }),
  ];
}

export function resolveDebugContextCompactionPolicy(): DebugContextCompactionPolicy {
  return {
    enabled: !isEnvDisabled(process.env.HELIXENT_CONTEXT_COMPACTION),
    maxMessagesBeforeCompact: readPositiveInteger(process.env.HELIXENT_CONTEXT_MAX_MESSAGES, 24),
    keepRecentMessages: readPositiveInteger(process.env.HELIXENT_CONTEXT_KEEP_RECENT_MESSAGES, 8),
    maxSummaryCharacters: readPositiveInteger(process.env.HELIXENT_CONTEXT_MAX_SUMMARY_CHARS, 4_000),
  };
}

function isEnvDisabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off";
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isMissingConfigError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
