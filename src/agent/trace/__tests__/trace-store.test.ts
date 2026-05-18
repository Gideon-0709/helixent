import { describe, expect, test } from "bun:test";

import { InMemoryTraceStore } from "../trace-store";

describe("InMemoryTraceStore", () => {
  test("appends events with run-local sequence numbers and lists recent runs", () => {
    const store = new InMemoryTraceStore();

    store.append("run_1", { type: "run_started", input: "hello" });
    store.append("run_1", { type: "run_completed", durationMs: 12 });
    store.append("run_2", { type: "run_started", input: "second" });

    expect(store.getEvents("run_1").map((event) => event.sequence)).toEqual([1, 2]);
    expect(store.getEvents("run_2").map((event) => event.sequence)).toEqual([1]);
    expect(store.listRuns()).toMatchObject([
      { runId: "run_2", status: "running", inputPreview: "second" },
      { runId: "run_1", status: "completed", inputPreview: "hello", durationMs: 12 },
    ]);
  });

  test("notifies subscribers and stops after unsubscribe", () => {
    const store = new InMemoryTraceStore();
    const seen: string[] = [];
    const unsubscribe = store.subscribe((event) => {
      seen.push(event.type);
    });

    store.append("run_1", { type: "run_started", input: "hello" });
    unsubscribe();
    store.append("run_1", { type: "run_completed", durationMs: 1 });

    expect(seen).toEqual(["run_started"]);
  });

  test("clears all runs and events", () => {
    const store = new InMemoryTraceStore();

    store.append("run_1", { type: "run_started", input: "hello" });
    store.append("run_2", { type: "run_started", input: "second" });

    expect(store.clear()).toBe(2);
    expect(store.listRuns()).toEqual([]);
    expect(store.getEvents("run_1")).toEqual([]);
    expect(store.getEvents("run_2")).toEqual([]);
  });

  test("summarizes workflow runs from workflow events", () => {
    const store = new InMemoryTraceStore();

    store.append("workflow_run_1", {
      type: "workflow_started",
      workflowId: "business-brief",
      workflowName: "Business Brief",
      input: { scopeId: "company" },
    });
    store.append("workflow_run_1", {
      type: "workflow_completed",
      workflowId: "business-brief",
      workflowName: "Business Brief",
      durationMs: 12,
      result: { ok: true },
    });

    expect(store.listRuns()[0]).toMatchObject({
      runId: "workflow_run_1",
      status: "completed",
      inputPreview: "Business Brief",
      durationMs: 12,
      lastEventType: "workflow_completed",
    });
  });
});
