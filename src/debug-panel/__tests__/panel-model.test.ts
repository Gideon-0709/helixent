import { describe, expect, test } from "bun:test";

import {
  aggregateTokenStats,
  createResource,
  defaultResources,
  isDraftSessionId,
  shouldSubmitComposerKey,
  subtractTokenStats,
  toKeyEvent,
  visibleSessions,
  type PanelTraceEvent,
  type WritableResourceType,
} from "../panel-model";

describe("debug panel model", () => {
  test("starts with editable prompt, skill, and tool resources", () => {
    expect(defaultResources.prompt[0]).toMatchObject({ id: "system", name: "System Prompt" });
    expect(defaultResources.skill[0]?.content).toContain("frontend-design");
    expect(defaultResources.tool[0]?.content).toContain("read_file");
    expect(defaultResources.archive).toEqual([]);
  });

  test("creates a resource with type-specific default content", () => {
    const types: WritableResourceType[] = ["prompt", "skill", "tool"];

    for (const type of types) {
      const resource = createResource(type, 2, 1000);

      expect(resource.id).toBe(`${type}_1000`);
      expect(resource.name).toBe(`New ${type} 2`);
      expect(resource.content).not.toBe("");
    }
  });

  test("maps raw trace events into focused event cards", () => {
    const event = {
      id: "evt_1",
      runId: "run_1",
      sequence: 1,
      timestamp: "2026-05-18T01:02:03.000Z",
      type: "tool_started",
      toolName: "read_file",
      input: { path: "/tmp/a.ts" },
    } satisfies PanelTraceEvent;

    expect(toKeyEvent(event)).toMatchObject({
      kind: "tool",
      title: "Tool Call: read_file",
      text: "{\"path\":\"/tmp/a.ts\"}",
    });
  });

  test("aggregates token usage across loaded events", () => {
    expect(
      aggregateTokenStats([
        tokenUsageEvent("a", 10, 4, 14),
        tokenUsageEvent("b", 3, 7, 10),
      ]),
    ).toEqual({ prompt: 13, completion: 11, total: 24 });
  });

  test("subtracts token stats without going below zero", () => {
    expect(subtractTokenStats({ prompt: 13, completion: 11, total: 24 }, { prompt: 10, completion: 20, total: 18 })).toEqual({
      prompt: 3,
      completion: 0,
      total: 6,
    });
  });

  test("hides empty default server sessions but keeps real and draft conversations", () => {
    expect(
      visibleSessions([
        session("empty", "New conversation", false, 0),
        session("real", "你好", true, 1),
        { ...session("draft_1", "New conversation", false, 0), draft: true },
      ]).map((item) => item.id),
    ).toEqual(["real", "draft_1"]);
  });

  test("detects local draft sessions", () => {
    expect(isDraftSessionId("draft_123")).toBe(true);
    expect(isDraftSessionId("session_123")).toBe(false);
  });

  test("submits composer on enter but keeps shift-enter and composition for editing", () => {
    expect(shouldSubmitComposerKey({ key: "Enter" })).toBe(true);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", isComposing: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "a" })).toBe(false);
  });
});

function tokenUsageEvent(id: string, promptTokens: number, completionTokens: number, totalTokens: number): PanelTraceEvent {
  return {
    id,
    runId: "run_1",
    sequence: 1,
    timestamp: "2026-05-18T01:02:03.000Z",
    type: "token_usage",
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function session(id: string, title: string, active: boolean, runCount: number) {
  return {
    id,
    title,
    active,
    runCount,
    createdAt: "2026-05-18T01:02:03.000Z",
    updatedAt: "2026-05-18T01:02:03.000Z",
  };
}
