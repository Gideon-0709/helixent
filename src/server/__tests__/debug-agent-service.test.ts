import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { z } from "zod";

import { Agent } from "@/agent";
import type { AgentType } from "@/coding/agents/agent-profiles";
import { defineTool, Model, type AssistantMessage, type ModelProvider, type ModelProviderInvokeParams } from "@/foundation";

import { createDebugAgentService } from "../debug-agent-service";
import { createDebugResourceStore } from "../debug-resource-store";

class FinalAnswerProvider implements ModelProvider {
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
      content: [{ type: "text", text: "hello from agent" }],
      usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
    };
  }
}

class UserCountProvider implements ModelProvider {
  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    for await (const message of this.stream(params)) {
      return message;
    }
    throw new Error("No message");
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    const userMessages = params.messages.filter((message) => message.role === "user").length;
    yield {
      role: "assistant",
      content: [{ type: "text", text: `users:${userMessages}` }],
    };
  }
}

class PriorAssistantProvider implements ModelProvider {
  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    for await (const message of this.stream(params)) {
      return message;
    }
    throw new Error("No message");
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    const sawPriorAssistant = params.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some((content) => content.type === "text" && content.text === "remembered-answer"),
    );
    yield {
      role: "assistant",
      content: [{ type: "text", text: sawPriorAssistant ? "saw-prior-assistant" : "remembered-answer" }],
    };
  }
}

describe("createDebugAgentService", () => {
  test("starts a run and exposes trace events", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
    });

    const response = await service.fetch(
      new Request("http://localhost/api/agent/runs", {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
      }),
    );
    expect(response.status).toBe(200);
    const { runId } = (await response.json()) as { runId: string };

    await waitFor(() => service.traceStore.getEvents(runId).some((event) => event.type === "run_completed"));

    const eventsResponse = await service.fetch(new Request(`http://localhost/api/internal/runs/${runId}/events`));
    expect(eventsResponse.status).toBe(200);
    const events = (await eventsResponse.json()) as Array<{ type: string }>;

    expect(events.map((event) => event.type)).toContain("run_started");
    expect(events.map((event) => event.type)).toContain("final_answer");
    expect(events.map((event) => event.type)).toContain("run_completed");
  });

  test("reports run counts for debug sessions", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
    });

    const sessionId = await createSession(service, "Debug session");

    let sessionsResponse = await service.fetch(new Request("http://localhost/api/internal/sessions"));
    let sessions = (await sessionsResponse.json()) as Array<{ id: string; runCount: number }>;
    expect(sessions.find((session) => session.id === sessionId)?.runCount).toBe(0);

    await startRun(service, sessionId, "hello");

    sessionsResponse = await service.fetch(new Request("http://localhost/api/internal/sessions"));
    sessions = (await sessionsResponse.json()) as Array<{ id: string; runCount: number }>;
    expect(sessions.find((session) => session.id === sessionId)?.runCount).toBe(1);
  });

  test("uses the agent name as the auto-created session title", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          name: "GMA",
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
    });

    const runId = await startRun(service, undefined, "summarize revenue");
    await waitFor(() => service.traceStore.getEvents(runId).some((event) => event.type === "run_completed"));

    const sessionsResponse = await service.fetch(new Request("http://localhost/api/internal/sessions"));
    const sessions = (await sessionsResponse.json()) as Array<{ title: string }>;
    expect(sessions[0]?.title).toBe("GMA");
  });

  test("creates runs with the requested agent type", async () => {
    const createdTypes: AgentType[] = [];
    const service = createDebugAgentService({
      createAgent: async (agentType = "gma") => {
        createdTypes.push(agentType);
        return new Agent({
          name: agentType.toUpperCase(),
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        });
      },
    });

    const response = await service.fetch(
      new Request("http://localhost/api/agent/runs", {
        method: "POST",
        body: JSON.stringify({ message: "inspect stores", agentType: "rm" }),
      }),
    );
    const { runId } = (await response.json()) as { runId: string };
    await waitFor(() => service.traceStore.getEvents(runId).some((event) => event.type === "run_completed"));

    const sessionsResponse = await service.fetch(new Request("http://localhost/api/internal/sessions"));
    const sessions = (await sessionsResponse.json()) as Array<{ title: string; agentType: AgentType }>;
    expect(createdTypes).toEqual(["rm"]);
    expect(sessions[0]).toMatchObject({ title: "RM", agentType: "rm" });
  });

  test("deletes a debug session and releases its trace events", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
    });

    const deletedSessionId = await createSession(service, "Delete me");
    const keptSessionId = await createSession(service, "Keep me");
    const deletedRunId = await startRun(service, deletedSessionId, "delete this");
    const keptRunId = await startRun(service, keptSessionId, "keep this");

    await waitFor(() => service.traceStore.getEvents(deletedRunId).some((event) => event.type === "run_completed"));
    await waitFor(() => service.traceStore.getEvents(keptRunId).some((event) => event.type === "run_completed"));

    const response = await service.fetch(new Request(`http://localhost/api/internal/sessions/${deletedSessionId}`, { method: "DELETE" }));

    expect(response.status).toBe(200);
    expect(service.traceStore.getEvents(deletedRunId)).toEqual([]);
    expect(service.traceStore.getEvents(keptRunId).length).toBeGreaterThan(0);
    expect(service.traceStore.listRuns().map((run) => run.runId)).toEqual([keptRunId]);

    const sessionsResponse = await service.fetch(new Request("http://localhost/api/internal/sessions"));
    const sessions = (await sessionsResponse.json()) as Array<{ id: string }>;
    expect(sessions.map((session) => session.id)).toEqual([keptSessionId]);
  });

  test("archives a debug session trace without deleting it from memory", async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const archiveDir = await mkdtemp(join(tmpdir(), "helixent-session-archives-"));
    const service = createDebugAgentService({
      archiveDir,
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
    });

    const sessionId = await createSession(service, "Archive me");
    const runId = await startRun(service, sessionId, "archive this");

    await waitFor(() => service.traceStore.getEvents(runId).some((event) => event.type === "run_completed"));

    const response = await service.fetch(new Request(`http://localhost/api/internal/sessions/${sessionId}/archive`, { method: "POST" }));
    expect(response.status).toBe(200);
    const result = (await response.json()) as { resourceId: string; path: string; archivedRunCount: number; archivedEventCount: number };

    expect(result.path.startsWith(archiveDir)).toBe(true);
    expect(result.resourceId).toContain("archive-me");
    expect(result.archivedRunCount).toBe(1);
    expect(result.archivedEventCount).toBeGreaterThan(0);
    expect(service.traceStore.getEvents(runId).length).toBeGreaterThan(0);

    const archive = JSON.parse(await readFile(result.path, "utf8")) as {
      type: string;
      session: { id: string; title: string };
      runs: Array<{ summary: { runId: string }; events: Array<{ type: string }> }>;
    };
    expect(archive.type).toBe("helixent.debug-session-archive");
    expect(archive.session).toMatchObject({ id: sessionId, title: "Archive me" });
    expect(archive.runs[0]?.summary.runId).toBe(runId);
    expect(archive.runs[0]?.events.map((event) => event.type)).toContain("final_answer");
  });

  test("clears all debug sessions and releases all trace events", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
    });

    const firstSessionId = await createSession(service, "First");
    const secondSessionId = await createSession(service, "Second");
    const firstRunId = await startRun(service, firstSessionId, "first");
    const secondRunId = await startRun(service, secondSessionId, "second");

    await waitFor(() => service.traceStore.getEvents(firstRunId).some((event) => event.type === "run_completed"));
    await waitFor(() => service.traceStore.getEvents(secondRunId).some((event) => event.type === "run_completed"));

    const response = await service.fetch(new Request("http://localhost/api/internal/sessions", { method: "DELETE" }));

    expect(response.status).toBe(200);
    expect(service.traceStore.listRuns()).toEqual([]);
    expect(service.traceStore.getEvents(firstRunId)).toEqual([]);
    expect(service.traceStore.getEvents(secondRunId)).toEqual([]);

    const sessionsResponse = await service.fetch(new Request("http://localhost/api/internal/sessions"));
    expect(await sessionsResponse.json()).toEqual([]);
  });

  test("leaves the debug panel route to the Bun HTML route", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
    });

    const response = await service.fetch(new Request("http://localhost/internal/debug"));

    expect(response.status).toBe(404);
  });

  test("serves and updates editable debug resources", async () => {
    const cwd = await createFixtureProject();
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
      resourceStore: createDebugResourceStore({ cwd }),
    });

    const listResponse = await service.fetch(new Request("http://localhost/api/internal/resources"));
    expect(listResponse.status).toBe(200);
    const resources = (await listResponse.json()) as { prompt: Array<{ id: string; content: string }> };
    expect(resources.prompt[0]?.id).toBe("system");

    const updateResponse = await service.fetch(
      new Request("http://localhost/api/internal/resources/prompt/system", {
        method: "PUT",
        body: JSON.stringify({ content: "updated prompt" }),
      }),
    );
    expect(updateResponse.status).toBe(200);
    const updated = (await updateResponse.json()) as { content: string };
    expect(updated.content).toBe("updated prompt");
  });

  test("deletes a debug resource through the internal resource API", async () => {
    const cwd = await createFixtureProject();
    const archivePath = join(cwd, ".helixent/debug-panel/archives/demo-archive.json");
    await Bun.write(archivePath, JSON.stringify({ type: "archive" }, null, 2));
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
      resourceStore: createDebugResourceStore({ cwd }),
    });

    const deleteResponse = await service.fetch(new Request("http://localhost/api/internal/resources/archive/demo-archive", { method: "DELETE" }));

    expect(deleteResponse.status).toBe(200);
    const deleted = (await deleteResponse.json()) as { id: string; type: string };
    expect(deleted).toMatchObject({ id: "demo-archive", type: "archive" });
    expect(await Bun.file(archivePath).exists()).toBe(false);
  });

  test("starts a workflow run and records workflow trace events", async () => {
    const cwd = await createFixtureProject();
    await Bun.write(
      join(cwd, "workflows/echo.workflow.yaml"),
      "id: echo\nname: Echo\nversion: 1\nsteps:\n  - id: echo_step\n    type: tool\n    tool: echo\n    input:\n      value: $input.value\n",
    );
    const echoTool = defineTool({
      name: "echo",
      description: "Echo a value",
      parameters: z.object({ value: z.string() }),
      invoke: async (input) => ({ echoed: input.value }),
    });
    const service = createDebugAgentService({
      resourceStore: createDebugResourceStore({ cwd }),
      workflowTools: [echoTool],
    });

    const response = await service.fetch(
      new Request("http://localhost/api/workflows/runs", {
        method: "POST",
        body: JSON.stringify({ workflowId: "echo", input: { value: "hello" } }),
      }),
    );
    const payload = (await response.json()) as { workflowRunId: string; status: string };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ status: "running" });
    expect(payload.workflowRunId).toStartWith("workflow_run_");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(service.traceStore.getEvents(payload.workflowRunId).map((event) => event.type)).toEqual([
      "workflow_started",
      "workflow_step_started",
      "workflow_step_completed",
      "workflow_completed",
    ]);
  });

  test("associates workflow runs with the selected debug session", async () => {
    const cwd = await createFixtureProject();
    await Bun.write(
      join(cwd, "workflows/echo.workflow.yaml"),
      "id: echo\nname: Echo\nversion: 1\nsteps:\n  - id: echo_step\n    type: tool\n    tool: echo\n    input:\n      value: $input.value\n",
    );
    const echoTool = defineTool({
      name: "echo",
      description: "Echo a value",
      parameters: z.object({ value: z.string() }),
      invoke: async (input) => ({ echoed: input.value }),
    });
    const service = createDebugAgentService({
      resourceStore: createDebugResourceStore({ cwd }),
      workflowTools: [echoTool],
    });
    const sessionResponse = await service.fetch(
      new Request("http://localhost/api/internal/sessions", {
        method: "POST",
        body: JSON.stringify({ agentType: "gma" }),
      }),
    );
    const sessionPayload = (await sessionResponse.json()) as { sessionId: string };

    const response = await service.fetch(
      new Request("http://localhost/api/workflows/runs", {
        method: "POST",
        body: JSON.stringify({ sessionId: sessionPayload.sessionId, workflowId: "echo", input: { value: "hello" } }),
      }),
    );
    const payload = (await response.json()) as { workflowRunId: string };
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(response.status).toBe(200);
    expect(service.traceStore.listRuns()[0]).toMatchObject({
      runId: payload.workflowRunId,
      sessionId: sessionPayload.sessionId,
    });
  });

  test("runs workflow agent steps on the selected session agent", async () => {
    const cwd = await createFixtureProject();
    await Bun.write(
      join(cwd, "workflows/session-agent.workflow.yaml"),
      "id: session-agent\nname: Session Agent\nversion: 1\nsteps:\n  - id: ask_agent\n    type: agent\n    message: workflow question\n",
    );
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new UserCountProvider()),
          prompt: "test prompt",
        }),
      resourceStore: createDebugResourceStore({ cwd }),
    });
    const sessionId = await createSession(service, "Workflow memory");
    const firstRunId = await startRun(service, sessionId, "first");
    await waitFor(() => service.traceStore.getEvents(firstRunId).some((event) => event.type === "final_answer"));

    const response = await service.fetch(
      new Request("http://localhost/api/workflows/runs", {
        method: "POST",
        body: JSON.stringify({ sessionId, workflowId: "session-agent" }),
      }),
    );
    const payload = (await response.json()) as { workflowRunId: string };
    await waitFor(() => service.traceStore.getEvents(payload.workflowRunId).some((event) => event.type === "workflow_completed"));
    const secondRunId = await startRun(service, sessionId, "after workflow");
    await waitFor(() => service.traceStore.getEvents(secondRunId).some((event) => event.type === "final_answer"));

    const workflowStep = service.traceStore
      .getEvents(payload.workflowRunId)
      .find((event) => event.type === "workflow_step_completed" && event.stepType === "agent");
    expect(workflowStep).toMatchObject({ result: "users:2" });
    expect(finalAnswerText(service.traceStore.getEvents(secondRunId))).toBe("users:3");
  });

  test("continues conversation context for runs in the same session", async () => {
    let createAgentCount = 0;
    const service = createDebugAgentService({
      createAgent: async () => {
        createAgentCount += 1;
        return new Agent({
          model: new Model("test-model", new UserCountProvider()),
          prompt: "test prompt",
        });
      },
    });

    const sessionResponse = await service.fetch(
      new Request("http://localhost/api/internal/sessions", {
        method: "POST",
        body: JSON.stringify({ title: "Debug session" }),
      }),
    );
    const { sessionId } = (await sessionResponse.json()) as { sessionId: string };

    const firstRunId = await startRun(service, sessionId, "first");
    const secondRunId = await startRun(service, sessionId, "second");

    await waitFor(() => service.traceStore.getEvents(secondRunId).some((event) => event.type === "final_answer"));

    expect(createAgentCount).toBe(1);
    expect(finalAnswerText(service.traceStore.getEvents(firstRunId))).toBe("users:1");
    expect(finalAnswerText(service.traceStore.getEvents(secondRunId))).toBe("users:2");
  });

  test("starts a fresh context for a new session", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new UserCountProvider()),
          prompt: "test prompt",
        }),
    });

    const firstSession = await createSession(service, "First");
    const secondSession = await createSession(service, "Second");

    const firstRunId = await startRun(service, firstSession, "first");
    const secondRunId = await startRun(service, secondSession, "second");

    await waitFor(() => service.traceStore.getEvents(secondRunId).some((event) => event.type === "final_answer"));

    expect(finalAnswerText(service.traceStore.getEvents(firstRunId))).toBe("users:1");
    expect(finalAnswerText(service.traceStore.getEvents(secondRunId))).toBe("users:1");
  });

  test("passes prior assistant messages into later runs in the same session", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new PriorAssistantProvider()),
          prompt: "test prompt",
        }),
    });

    const sessionId = await createSession(service, "Memory check");
    const firstRunId = await startRun(service, sessionId, "first");
    const secondRunId = await startRun(service, sessionId, "second");

    await waitFor(() => service.traceStore.getEvents(secondRunId).some((event) => event.type === "final_answer"));

    expect(finalAnswerText(service.traceStore.getEvents(firstRunId))).toBe("remembered-answer");
    expect(finalAnswerText(service.traceStore.getEvents(secondRunId))).toBe("saw-prior-assistant");
  });
});

async function waitFor(predicate: () => boolean) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createFixtureProject() {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cwd = await mkdtemp(join(tmpdir(), "helixent-service-resources-"));
  await Bun.write(join(cwd, "skills/demo-skill/SKILL.md"), "# demo-skill\n\nDemo skill.");
  await Bun.write(join(cwd, "src/coding/tools/read-file.ts"), "export const readFileTool = {};\n");
  return cwd;
}

async function createSession(service: ReturnType<typeof createDebugAgentService>, title: string): Promise<string> {
  const response = await service.fetch(
    new Request("http://localhost/api/internal/sessions", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  );
  const payload = (await response.json()) as { sessionId: string };
  return payload.sessionId;
}

async function startRun(service: ReturnType<typeof createDebugAgentService>, sessionId: string | undefined, message: string): Promise<string> {
  const response = await service.fetch(
    new Request("http://localhost/api/agent/runs", {
      method: "POST",
      body: JSON.stringify({ message, sessionId }),
    }),
  );
  const payload = (await response.json()) as { runId: string };
  return payload.runId;
}

function finalAnswerText(events: Array<{ type: string; text?: string }>): string | undefined {
  return events.find((event) => event.type === "final_answer")?.text;
}
