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

class SlowProvider implements ModelProvider {
  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    for await (const message of this.stream(params)) {
      return message;
    }
    throw new Error("No message");
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, 1000);
      params.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          reject(params.signal?.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    });
    yield {
      role: "assistant",
      content: [{ type: "text", text: "slow answer" }],
    };
  }
}

describe("createDebugAgentService", () => {
  test("serves health checks", async () => {
    const service = createDebugAgentService();

    const response = await service.fetch(new Request("http://localhost/api/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "helixent-debug-agent" });
  });

  test("serves debug context compaction policy", async () => {
    const service = createDebugAgentService();

    const response = await service.fetch(new Request("http://localhost/api/internal/context-policy"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enabled: true,
      maxMessagesBeforeCompact: 24,
      keepRecentMessages: 8,
      maxSummaryCharacters: 4000,
    });
  });

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

  test("records a failed run when agent creation fails", async () => {
    const service = createDebugAgentService({
      createAgent: async () => {
        throw new Error("model is not configured");
      },
    });

    const response = await service.fetch(
      new Request("http://localhost/api/agent/runs", {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
      }),
    );
    const { runId } = (await response.json()) as { runId: string };

    await waitFor(() => service.traceStore.getEvents(runId).some((event) => event.type === "run_failed"));

    expect(service.traceStore.getEvents(runId)).toEqual([
      expect.objectContaining({ type: "run_started", input: "hello" }),
      expect.objectContaining({
        type: "run_failed",
        error: { message: "model is not configured" },
      }),
    ]);
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

  test("lists stable main system agent profiles", async () => {
    const service = createDebugAgentService();

    const response = await service.fetch(new Request("http://localhost/api/v1/agents"));
    const payload = (await response.json()) as { agents: Array<{ type: string; name: string }> };

    expect(response.status).toBe(200);
    expect(payload.agents.map((agent) => agent.type)).toEqual(["gma", "rm", "sm"]);
    expect(payload.agents[0]).toMatchObject({ type: "gma", name: "GMA" });
  });

  test("returns a main system agent profile by type", async () => {
    const service = createDebugAgentService();

    const response = await service.fetch(new Request("http://localhost/api/v1/agents/rm"));
    const payload = (await response.json()) as { agent: { type: string; name: string; role: string } };

    expect(response.status).toBe(200);
    expect(payload.agent).toMatchObject({ type: "rm", name: "RM", role: "regional_manager" });
  });

  test("returns 404 for an unknown main system agent profile", async () => {
    const service = createDebugAgentService();

    const response = await service.fetch(new Request("http://localhost/api/v1/agents/unknown"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "agent not found" });
  });

  test("lists, updates, and deletes main system conversations", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
    });
    const first = await createMainConversation(service, {
      agentType: "gma",
      title: "First conversation",
      context: { tenantId: "tenant-1", storeId: "store-1" },
      metadata: { channel: "main" },
    });
    const second = await createMainConversation(service, {
      agentType: "rm",
      title: "Second conversation",
    });

    let listResponse = await service.fetch(new Request("http://localhost/api/v1/conversations"));
    let listPayload = (await listResponse.json()) as { conversations: Array<{ agentType?: string; id: string; title?: string }> };
    expect(listResponse.status).toBe(200);
    expect(listPayload.conversations.map((conversation) => conversation.id).sort()).toEqual([first, second].sort());

    const updateResponse = await service.fetch(
      new Request(`http://localhost/api/v1/conversations/${first}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: "Updated conversation",
          context: { tenantId: "tenant-2", regionId: "region-1" },
          metadata: { channel: "api" },
          externalConversationId: "main-conv-updated",
        }),
      }),
    );
    const updatePayload = (await updateResponse.json()) as {
      conversation: {
        title: string;
        context?: Record<string, unknown>;
        externalConversationId?: string;
        metadata?: Record<string, unknown>;
      };
    };
    expect(updateResponse.status).toBe(200);
    expect(updatePayload.conversation).toMatchObject({
      title: "Updated conversation",
      context: { tenantId: "tenant-2", regionId: "region-1" },
      metadata: { channel: "api" },
      externalConversationId: "main-conv-updated",
    });

    const invalidSwitchResponse = await service.fetch(
      new Request(`http://localhost/api/v1/conversations/${first}`, {
        method: "PATCH",
        body: JSON.stringify({ agentType: "sm" }),
      }),
    );
    expect(invalidSwitchResponse.status).toBe(400);
    expect(await invalidSwitchResponse.json()).toEqual({ error: "agentType cannot be changed for an existing conversation" });

    const invalidAgentResponse = await service.fetch(
      new Request(`http://localhost/api/v1/conversations/${first}`, {
        method: "PATCH",
        body: JSON.stringify({ agentType: "custom" }),
      }),
    );
    expect(invalidAgentResponse.status).toBe(400);
    expect(await invalidAgentResponse.json()).toEqual({ error: "agentType cannot be changed for an existing conversation" });

    const deleteResponse = await service.fetch(new Request(`http://localhost/api/v1/conversations/${first}`, { method: "DELETE" }));
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toMatchObject({ conversationId: first, deletedRunCount: 0 });

    listResponse = await service.fetch(new Request("http://localhost/api/v1/conversations"));
    listPayload = (await listResponse.json()) as { conversations: Array<{ id: string }> };
    expect(listPayload.conversations.map((conversation) => conversation.id)).toEqual([second]);
  });

  test("filters and paginates main system conversations", async () => {
    const service = createDebugAgentService();
    const gma = await createMainConversation(service, {
      agentType: "gma",
      externalConversationId: "external-gma",
      title: "GMA conversation",
    });
    const rm = await createMainConversation(service, {
      agentType: "rm",
      externalConversationId: "external-rm",
      title: "RM conversation",
    });
    const sm = await createMainConversation(service, {
      agentType: "sm",
      externalConversationId: "external-sm",
      title: "SM conversation",
    });

    const pageOneResponse = await service.fetch(new Request("http://localhost/api/v1/conversations?limit=2"));
    const pageOne = (await pageOneResponse.json()) as {
      conversations: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(pageOneResponse.status).toBe(200);
    expect(pageOne.conversations).toHaveLength(2);
    expect(pageOne.nextCursor).toBeTruthy();

    const pageTwoResponse = await service.fetch(new Request(`http://localhost/api/v1/conversations?limit=2&cursor=${pageOne.nextCursor}`));
    const pageTwo = (await pageTwoResponse.json()) as { conversations: Array<{ id: string }>; nextCursor?: string };
    expect(pageTwo.conversations).toHaveLength(1);
    expect(pageTwo.nextCursor).toBeUndefined();
    expect([...pageOne.conversations, ...pageTwo.conversations].map((conversation) => conversation.id).sort()).toEqual([gma, rm, sm].sort());

    const agentFilterResponse = await service.fetch(new Request("http://localhost/api/v1/conversations?agentType=rm"));
    const agentFilter = (await agentFilterResponse.json()) as { conversations: Array<{ id: string }> };
    expect(agentFilter.conversations.map((conversation) => conversation.id)).toEqual([rm]);

    const externalFilterResponse = await service.fetch(new Request("http://localhost/api/v1/conversations?externalConversationId=external-sm"));
    const externalFilter = (await externalFilterResponse.json()) as { conversations: Array<{ id: string }> };
    expect(externalFilter.conversations.map((conversation) => conversation.id)).toEqual([sm]);

    const futureFilterResponse = await service.fetch(new Request("http://localhost/api/v1/conversations?createdAfter=2999-01-01T00:00:00.000Z"));
    const futureFilter = (await futureFilterResponse.json()) as { conversations: Array<{ id: string }> };
    expect(futureFilter.conversations).toEqual([]);
  });

  test("returns a main system conversation by external id", async () => {
    const service = createDebugAgentService();
    const conversationId = await createMainConversation(service, {
      agentType: "gma",
      externalConversationId: "main-conv-lookup",
      title: "Lookup conversation",
    });

    const response = await service.fetch(new Request("http://localhost/api/v1/conversations/by-external/main-conv-lookup"));
    const payload = (await response.json()) as { conversation: { externalConversationId?: string; id: string } };

    expect(response.status).toBe(200);
    expect(payload.conversation).toMatchObject({
      id: conversationId,
      externalConversationId: "main-conv-lookup",
    });

    const missingResponse = await service.fetch(new Request("http://localhost/api/v1/conversations/by-external/missing"));
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({ error: "conversation not found" });
  });

  test("returns main system conversation context status", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new UserCountProvider()),
          prompt: "test prompt",
        }),
    });
    const conversationId = await createMainConversation(service, { agentType: "gma", title: "Context status" });
    const messageResponse = await service.fetch(
      new Request(`http://localhost/api/v1/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: "first question" }),
      }),
    );
    const { runId } = (await messageResponse.json()) as { runId: string };
    await waitFor(() => service.traceStore.getEvents(runId).some((event) => event.type === "run_completed"));

    const response = await service.fetch(new Request(`http://localhost/api/v1/conversations/${conversationId}/context`));
    const payload = (await response.json()) as {
      context: {
        compactedCount: number;
        keepRecentMessages: number;
        maxMessagesBeforeCompact: number;
        messageCount: number;
        summaryActive: boolean;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.context).toMatchObject({
      compactedCount: 0,
      keepRecentMessages: 8,
      maxMessagesBeforeCompact: 24,
      messageCount: 2,
      summaryActive: false,
    });
  });

  test("creates a main system conversation and runs messages on it", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
    });

    const conversationResponse = await service.fetch(
      new Request("http://localhost/api/v1/conversations", {
        method: "POST",
        body: JSON.stringify({
          agentType: "gma",
          title: "Main system conversation",
          externalConversationId: "main-conv-1",
          metadata: { tenantId: "tenant-1" },
        }),
      }),
    );
    const conversationPayload = (await conversationResponse.json()) as {
      conversationId: string;
      conversation: { id: string; title: string; agentType: string; externalConversationId?: string; metadata?: Record<string, unknown> };
    };

    expect(conversationResponse.status).toBe(200);
    expect(conversationPayload.conversation).toMatchObject({
      id: conversationPayload.conversationId,
      title: "Main system conversation",
      agentType: "gma",
      externalConversationId: "main-conv-1",
      metadata: { tenantId: "tenant-1" },
    });

    const messageResponse = await service.fetch(
      new Request(`http://localhost/api/v1/conversations/${conversationPayload.conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: "hello from main system", metadata: { source: "main" } }),
      }),
    );
    const messagePayload = (await messageResponse.json()) as { runId: string; conversationId: string; status: string };

    expect(messageResponse.status).toBe(200);
    expect(messagePayload).toMatchObject({
      conversationId: conversationPayload.conversationId,
      status: "running",
    });

    await waitFor(() => service.traceStore.getEvents(messagePayload.runId).some((event) => event.type === "run_completed"));

    const runResponse = await service.fetch(new Request(`http://localhost/api/v1/runs/${messagePayload.runId}`));
    const runPayload = (await runResponse.json()) as { runId: string; status: string; conversationId?: string };
    expect(runResponse.status).toBe(200);
    expect(runPayload).toMatchObject({
      runId: messagePayload.runId,
      status: "completed",
      conversationId: conversationPayload.conversationId,
    });

    const resultResponse = await service.fetch(new Request(`http://localhost/api/v1/runs/${messagePayload.runId}/result`));
    const resultPayload = (await resultResponse.json()) as { status: string; finalAnswer?: string };
    expect(resultResponse.status).toBe(200);
    expect(resultPayload).toMatchObject({
      status: "completed",
      finalAnswer: "hello from agent",
    });
  });

  test("runs a main system message synchronously", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
    });
    const conversationId = await createMainConversation(service, {
      agentType: "gma",
      title: "Sync conversation",
    });

    const response = await service.fetch(
      new Request(`http://localhost/api/v1/conversations/${conversationId}/messages:run`, {
        method: "POST",
        body: JSON.stringify({
          requestId: "sync-req-1",
          message: "answer now",
          context: { storeId: "store-1" },
          metadata: { source: "sync" },
        }),
      }),
    );
    const payload = (await response.json()) as {
      conversationId: string;
      finalAnswer?: string;
      requestId?: string;
      runId: string;
      status: string;
    };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      conversationId,
      finalAnswer: "hello from agent",
      requestId: "sync-req-1",
      status: "completed",
    });
    expect(service.traceStore.getEvents(payload.runId).map((event) => event.type)).toContain("run_completed");
  });

  test("posts a webhook callback when a main system run completes", async () => {
    const callbacks: Array<{ body: unknown; url: string }> = [];
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
      webhookFetch: async (input, init) => {
        callbacks.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        return new Response(null, { status: 204 });
      },
    });
    const conversationId = await createMainConversation(service, { agentType: "gma", title: "Callback conversation" });

    const response = await service.fetch(
      new Request(`http://localhost/api/v1/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          callbackUrl: "https://main-system.example/ai/callback",
          message: "callback please",
          requestId: "callback-req-1",
        }),
      }),
    );
    const payload = (await response.json()) as { runId: string };
    await waitFor(() => callbacks.length === 1);

    expect(callbacks[0]).toEqual({
      url: "https://main-system.example/ai/callback",
      body: expect.objectContaining({
        conversationId,
        finalAnswer: "hello from agent",
        requestId: "callback-req-1",
        runId: payload.runId,
        status: "completed",
      }),
    });
  });

  test("returns main system conversation details, runs, and messages", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
    });

    const conversationResponse = await service.fetch(
      new Request("http://localhost/api/v1/conversations", {
        method: "POST",
        body: JSON.stringify({
          agentType: "gma",
          title: "Conversation detail",
          context: {
            tenantId: "tenant-1",
            userId: "user-1",
            role: "manager",
            storeId: "store-1",
            regionId: "region-1",
            timezone: "Asia/Shanghai",
            locale: "zh-CN",
          },
          metadata: { channel: "main" },
        }),
      }),
    );
    const { conversationId } = (await conversationResponse.json()) as { conversationId: string };

    const messageResponse = await service.fetch(
      new Request(`http://localhost/api/v1/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          requestId: "req-1",
          message: "first question",
          context: { storeId: "store-2" },
          metadata: { source: "message" },
        }),
      }),
    );
    const { runId } = (await messageResponse.json()) as { runId: string };
    await waitFor(() => service.traceStore.getEvents(runId).some((event) => event.type === "run_completed"));

    const detailResponse = await service.fetch(new Request(`http://localhost/api/v1/conversations/${conversationId}`));
    const detailPayload = (await detailResponse.json()) as {
      conversation: {
        id: string;
        context?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
      };
    };
    expect(detailResponse.status).toBe(200);
    expect(detailPayload.conversation).toMatchObject({
      id: conversationId,
      context: { tenantId: "tenant-1", storeId: "store-1" },
      metadata: { channel: "main" },
    });

    const runsResponse = await service.fetch(new Request(`http://localhost/api/v1/conversations/${conversationId}/runs`));
    const runsPayload = (await runsResponse.json()) as { runs: Array<{ runId: string; requestId?: string; context?: Record<string, unknown> }> };
    expect(runsResponse.status).toBe(200);
    expect(runsPayload.runs).toEqual([
      expect.objectContaining({
        runId,
        requestId: "req-1",
        context: { storeId: "store-2" },
      }),
    ]);

    const messagesResponse = await service.fetch(new Request(`http://localhost/api/v1/conversations/${conversationId}/messages`));
    const messagesPayload = (await messagesResponse.json()) as {
      messages: Array<{ role: string; content: string; runId: string; requestId?: string }>;
    };
    expect(messagesResponse.status).toBe(200);
    expect(messagesPayload.messages).toEqual([
      expect.objectContaining({ role: "user", content: "first question", runId, requestId: "req-1" }),
      expect.objectContaining({ role: "assistant", content: "hello from agent", runId, requestId: "req-1" }),
    ]);

    const runResponse = await service.fetch(new Request(`http://localhost/api/v1/runs/${runId}`));
    const runPayload = (await runResponse.json()) as { requestId?: string; context?: Record<string, unknown>; metadata?: Record<string, unknown> };
    expect(runPayload).toMatchObject({
      requestId: "req-1",
      context: { storeId: "store-2" },
      metadata: { source: "message" },
    });
  });

  test("paginates main system conversation runs and messages", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
    });
    const conversationId = await createMainConversation(service, { agentType: "gma", title: "Paginated conversation" });
    const runIds: string[] = [];
    for (const message of ["first", "second", "third"]) {
      const messageResponse = await service.fetch(
        new Request(`http://localhost/api/v1/conversations/${conversationId}/messages`, {
          method: "POST",
          body: JSON.stringify({ message }),
        }),
      );
      const payload = (await messageResponse.json()) as { runId: string };
      runIds.push(payload.runId);
    }
    await waitFor(() => service.traceStore.getEvents(runIds[2]!).some((event) => event.type === "run_completed"));

    const runsPageOneResponse = await service.fetch(new Request(`http://localhost/api/v1/conversations/${conversationId}/runs?limit=2`));
    const runsPageOne = (await runsPageOneResponse.json()) as { nextCursor?: string; runs: Array<{ runId: string }> };
    expect(runsPageOne.runs.map((run) => run.runId)).toEqual(runIds.slice(0, 2));
    expect(runsPageOne.nextCursor).toBeTruthy();

    const runsPageTwoResponse = await service.fetch(
      new Request(`http://localhost/api/v1/conversations/${conversationId}/runs?limit=2&cursor=${runsPageOne.nextCursor}`),
    );
    const runsPageTwo = (await runsPageTwoResponse.json()) as { nextCursor?: string; runs: Array<{ runId: string }> };
    expect(runsPageTwo.runs.map((run) => run.runId)).toEqual([runIds[2]!]);
    expect(runsPageTwo.nextCursor).toBeUndefined();

    const messagesPageOneResponse = await service.fetch(new Request(`http://localhost/api/v1/conversations/${conversationId}/messages?limit=3`));
    const messagesPageOne = (await messagesPageOneResponse.json()) as {
      messages: Array<{ content: string; role: string }>;
      nextCursor?: string;
    };
    expect(messagesPageOne.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:first",
      "assistant:hello from agent",
      "user:second",
    ]);
    expect(messagesPageOne.nextCursor).toBeTruthy();

    const messagesPageTwoResponse = await service.fetch(
      new Request(`http://localhost/api/v1/conversations/${conversationId}/messages?limit=3&cursor=${messagesPageOne.nextCursor}`),
    );
    const messagesPageTwo = (await messagesPageTwoResponse.json()) as { messages: Array<{ content: string; role: string }>; nextCursor?: string };
    expect(messagesPageTwo.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "assistant:hello from agent",
      "user:third",
      "assistant:hello from agent",
    ]);
    expect(messagesPageTwo.nextCursor).toBeUndefined();
  });

  test("lists main system run events and retries a run", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
    });
    const conversationId = await createMainConversation(service, { agentType: "gma", title: "Retry conversation" });
    const messageResponse = await service.fetch(
      new Request(`http://localhost/api/v1/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: "retry source", requestId: "req-original" }),
      }),
    );
    const { runId } = (await messageResponse.json()) as { runId: string };
    await waitFor(() => service.traceStore.getEvents(runId).some((event) => event.type === "run_completed"));

    const eventsPageOneResponse = await service.fetch(new Request(`http://localhost/api/v1/runs/${runId}/events?limit=2`));
    const eventsPageOne = (await eventsPageOneResponse.json()) as { events: Array<{ type: string }>; nextCursor?: string };
    expect(eventsPageOneResponse.status).toBe(200);
    expect(eventsPageOne.events.map((event) => event.type)).toEqual(["run_started", "final_answer"]);
    expect(eventsPageOne.nextCursor).toBeTruthy();

    const retryResponse = await service.fetch(
      new Request(`http://localhost/api/v1/runs/${runId}/retry`, {
        method: "POST",
        body: JSON.stringify({ requestId: "req-retry" }),
      }),
    );
    const retryPayload = (await retryResponse.json()) as { conversationId: string; retryOfRunId: string; runId: string; status: string };
    expect(retryResponse.status).toBe(200);
    expect(retryPayload).toMatchObject({
      conversationId,
      retryOfRunId: runId,
      status: "running",
    });
    expect(retryPayload.runId).not.toBe(runId);
    await waitFor(() => service.traceStore.getEvents(retryPayload.runId).some((event) => event.type === "run_completed"));

    const retryResultResponse = await service.fetch(new Request(`http://localhost/api/v1/runs/${retryPayload.runId}/result`));
    expect(await retryResultResponse.json()).toMatchObject({
      finalAnswer: "hello from agent",
      requestId: "req-retry",
      status: "completed",
    });
  });

  test("manages main system conversation context", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new UserCountProvider()),
          prompt: "test prompt",
        }),
    });
    const conversationId = await createMainConversation(service, { agentType: "gma", title: "Managed context" });
    for (const message of ["one", "two", "three", "four", "five"]) {
      await service.fetch(
        new Request(`http://localhost/api/v1/conversations/${conversationId}/messages:run`, {
          method: "POST",
          body: JSON.stringify({ message }),
        }),
      );
    }

    const compactResponse = await service.fetch(new Request(`http://localhost/api/v1/conversations/${conversationId}/context/compact`, { method: "POST" }));
    const compactPayload = (await compactResponse.json()) as { compacted: boolean; context: { messageCount: number; summaryActive: boolean } };
    expect(compactResponse.status).toBe(200);
    expect(compactPayload.compacted).toBe(true);
    expect(compactPayload.context).toMatchObject({
      messageCount: 9,
      summaryActive: true,
    });

    const summaryResponse = await service.fetch(new Request(`http://localhost/api/v1/conversations/${conversationId}/context/summary`));
    const summaryPayload = (await summaryResponse.json()) as { summary: { active: boolean; preview?: string } };
    expect(summaryPayload.summary).toMatchObject({
      active: true,
      preview: expect.stringContaining("Manual context summary"),
    });

    const resetResponse = await service.fetch(new Request(`http://localhost/api/v1/conversations/${conversationId}/context/reset`, { method: "POST" }));
    const resetPayload = (await resetResponse.json()) as { context: { messageCount: number }; reset: boolean };
    expect(resetResponse.status).toBe(200);
    expect(resetPayload).toMatchObject({
      reset: true,
      context: { messageCount: 0 },
    });

    const nextResponse = await service.fetch(
      new Request(`http://localhost/api/v1/conversations/${conversationId}/messages:run`, {
        method: "POST",
        body: JSON.stringify({ message: "after reset" }),
      }),
    );
    expect(await nextResponse.json()).toMatchObject({
      finalAnswer: "users:1",
      status: "completed",
    });
  });

  test("reports main system service status", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
    });
    const conversationId = await createMainConversation(service, { agentType: "rm", title: "Status conversation" });
    const messageResponse = await service.fetch(
      new Request(`http://localhost/api/v1/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: "status input" }),
      }),
    );
    const { runId } = (await messageResponse.json()) as { runId: string };
    await waitFor(() => service.traceStore.getEvents(runId).some((event) => event.type === "run_completed"));

    const response = await service.fetch(new Request("http://localhost/api/v1/status"));
    const payload = (await response.json()) as {
      agents: { available: number; types: string[] };
      conversations: { active: number; total: number };
      ok: boolean;
      runs: { running: number; total: number };
    };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      agents: { available: 3, types: ["gma", "rm", "sm"] },
      conversations: { active: 1, total: 1 },
      runs: { running: 0, total: 1 },
    });
  });

  test("cancels a running main system run", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new SlowProvider()),
          prompt: "test prompt",
        }),
    });

    const response = await service.fetch(
      new Request("http://localhost/api/v1/agent/messages", {
        method: "POST",
        body: JSON.stringify({ message: "slow question" }),
      }),
    );
    const { runId } = (await response.json()) as { runId: string };
    await waitFor(() => service.traceStore.getEvents(runId).some((event) => event.type === "run_started"));

    const cancelResponse = await service.fetch(new Request(`http://localhost/api/v1/runs/${runId}/cancel`, { method: "POST" }));
    const cancelPayload = (await cancelResponse.json()) as { runId: string; status: string };

    expect(cancelResponse.status).toBe(200);
    expect(cancelPayload).toEqual({ runId, status: "aborting" });
    await waitFor(() => service.traceStore.getEvents(runId).some((event) => event.type === "run_aborted"));

    const resultResponse = await service.fetch(new Request(`http://localhost/api/v1/runs/${runId}/result`));
    const resultPayload = (await resultResponse.json()) as { status: string };
    expect(resultPayload.status).toBe("aborted");
  });

  test("starts a main system message without explicitly creating a conversation", async () => {
    const service = createDebugAgentService({
      createAgent: async () =>
        new Agent({
          model: new Model("test-model", new FinalAnswerProvider()),
          prompt: "test prompt",
        }),
    });

    const response = await service.fetch(
      new Request("http://localhost/api/v1/agent/messages", {
        method: "POST",
        body: JSON.stringify({
          agentType: "rm",
          message: "inspect this",
          metadata: { tenantId: "tenant-1" },
        }),
      }),
    );
    const payload = (await response.json()) as { runId: string; conversationId: string; status: string };

    expect(response.status).toBe(200);
    expect(payload.status).toBe("running");
    expect(payload.runId).toStartWith("run_");
    expect(payload.conversationId).toStartWith("session_");
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

async function createMainConversation(
  service: ReturnType<typeof createDebugAgentService>,
  body: {
    agentType?: string;
    context?: Record<string, unknown>;
    externalConversationId?: string;
    metadata?: Record<string, unknown>;
    title?: string;
  },
): Promise<string> {
  const response = await service.fetch(
    new Request("http://localhost/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  const payload = (await response.json()) as { conversationId: string };
  return payload.conversationId;
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
