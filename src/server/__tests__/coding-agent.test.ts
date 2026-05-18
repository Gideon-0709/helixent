import { afterEach, describe, expect, test } from "bun:test";

import { resolveDebugModelEntry } from "../coding-agent";

const originalEnv = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
};

afterEach(() => {
  setEnv("DEEPSEEK_API_KEY", originalEnv.DEEPSEEK_API_KEY);
  setEnv("DEEPSEEK_MODEL", originalEnv.DEEPSEEK_MODEL);
  setEnv("DEEPSEEK_BASE_URL", originalEnv.DEEPSEEK_BASE_URL);
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
});

function setEnv(name: string, value: string | undefined) {
  if (value == null) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
