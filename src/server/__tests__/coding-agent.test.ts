import { afterEach, describe, expect, test } from "bun:test";

import { resolveDebugContextCompactionPolicy, resolveDebugModelEntry } from "../coding-agent";

const originalEnv = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
  HELIXENT_CONTEXT_COMPACTION: process.env.HELIXENT_CONTEXT_COMPACTION,
  HELIXENT_CONTEXT_MAX_MESSAGES: process.env.HELIXENT_CONTEXT_MAX_MESSAGES,
  HELIXENT_CONTEXT_KEEP_RECENT_MESSAGES: process.env.HELIXENT_CONTEXT_KEEP_RECENT_MESSAGES,
  HELIXENT_CONTEXT_MAX_SUMMARY_CHARS: process.env.HELIXENT_CONTEXT_MAX_SUMMARY_CHARS,
  HELIXENT_HOME: process.env.HELIXENT_HOME,
};

afterEach(() => {
  setEnv("DEEPSEEK_API_KEY", originalEnv.DEEPSEEK_API_KEY);
  setEnv("DEEPSEEK_MODEL", originalEnv.DEEPSEEK_MODEL);
  setEnv("DEEPSEEK_BASE_URL", originalEnv.DEEPSEEK_BASE_URL);
  setEnv("HELIXENT_CONTEXT_COMPACTION", originalEnv.HELIXENT_CONTEXT_COMPACTION);
  setEnv("HELIXENT_CONTEXT_MAX_MESSAGES", originalEnv.HELIXENT_CONTEXT_MAX_MESSAGES);
  setEnv("HELIXENT_CONTEXT_KEEP_RECENT_MESSAGES", originalEnv.HELIXENT_CONTEXT_KEEP_RECENT_MESSAGES);
  setEnv("HELIXENT_CONTEXT_MAX_SUMMARY_CHARS", originalEnv.HELIXENT_CONTEXT_MAX_SUMMARY_CHARS);
  setEnv("HELIXENT_HOME", originalEnv.HELIXENT_HOME);
});

describe("resolveDebugModelEntry", () => {
  test("uses DeepSeek V4 Pro from environment when DEEPSEEK_API_KEY is set", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    delete process.env.DEEPSEEK_MODEL;
    delete process.env.DEEPSEEK_BASE_URL;

    expect(resolveDebugModelEntry()).toEqual({
      name: "deepseek-v4-pro",
      baseURL: "https://api.deepseek.com",
      APIKey: "sk-test",
      provider: "openai",
    });
  });

  test("allows overriding DeepSeek model and base URL", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";
    process.env.DEEPSEEK_BASE_URL = "https://example.test";

    expect(resolveDebugModelEntry()).toMatchObject({
      name: "deepseek-v4-flash",
      baseURL: "https://example.test",
    });
  });

  test("shows a clear error when no model environment or config file exists", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    delete process.env.DEEPSEEK_API_KEY;
    process.env.HELIXENT_HOME = await mkdtemp(join(tmpdir(), "helixent-empty-home-"));

    expect(() => resolveDebugModelEntry()).toThrow("Set DEEPSEEK_API_KEY");
  });
});

describe("resolveDebugContextCompactionPolicy", () => {
  test("reads context compaction defaults from environment", () => {
    process.env.HELIXENT_CONTEXT_COMPACTION = "off";
    process.env.HELIXENT_CONTEXT_MAX_MESSAGES = "36";
    process.env.HELIXENT_CONTEXT_KEEP_RECENT_MESSAGES = "12";
    process.env.HELIXENT_CONTEXT_MAX_SUMMARY_CHARS = "6000";

    expect(resolveDebugContextCompactionPolicy()).toEqual({
      enabled: false,
      maxMessagesBeforeCompact: 36,
      keepRecentMessages: 12,
      maxSummaryCharacters: 6000,
    });
  });
});

function setEnv(name: string, value: string | undefined) {
  if (value == null) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
