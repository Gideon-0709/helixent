import { join } from "node:path";

import type { ModelEntry } from "@/cli/config";
import { loadConfig, ensureHelixentHomeEnv } from "@/cli/config";
import { createCodingAgent } from "@/coding";
import { AnthropicModelProvider } from "@/community/anthropic";
import { OpenAIModelProvider } from "@/community/openai";
import type { ModelProvider } from "@/foundation";
import { Model } from "@/foundation";

import { createDebugResourceStore } from "./debug-resource-store";

export async function createDefaultDebugCodingAgent() {
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

  return createCodingAgent({
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
  });
}

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

  const config = loadConfig();
  const defaultModelName = config.defaultModel ?? config.models[0]?.name;
  const entry = defaultModelName ? config.models.find((model) => model.name === defaultModelName) : undefined;
  if (!entry) {
    throw new Error("No models configured. Set DEEPSEEK_API_KEY or run `helixent config model add`.");
  }
  return entry;
}
