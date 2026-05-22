import { describe, expect, test } from "bun:test";

import { Model, type AssistantMessage, type ModelProvider, type ModelProviderInvokeParams } from "@/foundation";

import { AGENT_PROFILES } from "../agent-profiles";
import { createGmaAgent, createRmAgent, createSmAgent } from "../lead-agent";

class NoopProvider implements ModelProvider {
  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    for await (const message of this.stream(params)) {
      return message;
    }
    throw new Error("No message");
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    void params;
    yield {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    };
  }
}

describe("createGmaAgent", () => {
  test("creates a GMA agent", async () => {
    const agent = await createGmaAgent({
      model: new Model("test-model", new NoopProvider()),
    });

    expect(agent.name).toBe("GMA");
  });

  test("adds caller-provided middleware to the role agent", async () => {
    const middleware = { beforeModel: async () => undefined };
    const agent = await createGmaAgent({
      model: new Model("test-model", new NoopProvider()),
      middlewares: [middleware],
    });

    expect(agent.middlewares).toContain(middleware);
  });
});

describe("agent profile factories", () => {
  test("creates RM and SM agents", async () => {
    const model = new Model("test-model", new NoopProvider());

    await expect(createRmAgent({ model })).resolves.toMatchObject({ name: "RM" });
    await expect(createSmAgent({ model })).resolves.toMatchObject({ name: "SM" });
  });

  test("defines regional manager and store manager profiles", () => {
    expect(AGENT_PROFILES.rm).toMatchObject({
      name: "RM",
      role: "regional_manager",
    });
    expect(AGENT_PROFILES.sm).toMatchObject({
      name: "SM",
      role: "store_manager",
    });
  });
});
