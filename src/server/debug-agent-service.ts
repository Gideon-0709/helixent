import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  InMemoryTraceStore,
  type Agent,
  type AgentEvent,
  readWorkflowFile,
  type TraceEvent,
  type TraceEventInput,
  type TraceRunSummary,
  type TraceStore,
  runWorkflow,
} from "@/agent";
import { AGENT_PROFILES, isAgentType, type AgentType } from "@/coding";
import { applyPatchTool } from "@/coding/tools/apply-patch";
import { bashTool } from "@/coding/tools/bash";
import { fileInfoTool } from "@/coding/tools/file-info";
import { globSearchTool } from "@/coding/tools/glob-search";
import { grepSearchTool } from "@/coding/tools/grep-search";
import { listFilesTool } from "@/coding/tools/list-files";
import { mkdirTool } from "@/coding/tools/mkdir";
import { movePathTool } from "@/coding/tools/move-path";
import { readFileTool } from "@/coding/tools/read-file";
import { strReplaceTool } from "@/coding/tools/str-replace";
import { writeFileTool } from "@/coding/tools/write-file";
import type { NonSystemMessage, Tool } from "@/foundation";

import { createDefaultDebugAgent, resolveDebugContextCompactionPolicy, resolveDebugModelEntry } from "./coding-agent";
import { createDebugResourceStore, type DebugReadableResourceType, type DebugResourceStore, type DebugResourceType } from "./debug-resource-store";

export interface DebugAgentService {
  fetch(request: Request): Promise<Response>;
  traceStore: TraceStore;
}

// eslint-disable-next-line no-unused-vars
type WebhookFetch = (...args: [string, RequestInit?]) => Promise<Response>;

export interface DebugAgentServiceOptions {
  archiveDir?: string;
  createAgent?: (agentType?: AgentType) => Promise<Agent>;
  resourceStore?: DebugResourceStore;
  traceStore?: TraceStore;
  webhookFetch?: WebhookFetch;
  workflowTools?: Tool[];
}

type UserSafeEvent = Pick<TraceEvent, "id" | "runId" | "type" | "timestamp" | "sequence"> & Record<string, unknown>;

interface DebugSession {
  id: string;
  title: string;
  agentType: AgentType;
  createdAt: string;
  updatedAt: string;
  context?: Record<string, unknown>;
  externalConversationId?: string;
  metadata?: Record<string, unknown>;
  agent?: Agent;
  runCount: number;
  deleted: boolean;
  queue: Promise<void>;
}

interface DebugSessionSummary {
  id: string;
  title: string;
  agentType: AgentType;
  createdAt: string;
  updatedAt: string;
  context?: Record<string, unknown>;
  externalConversationId?: string;
  metadata?: Record<string, unknown>;
  active: boolean;
  runCount: number;
}

interface MainSystemRunMetadata {
  callbackUrl?: string;
  conversationId: string;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

export function createDebugAgentService({
  archiveDir = join(process.cwd(), ".helixent", "debug-panel", "archives"),
  createAgent = createDefaultDebugAgent,
  resourceStore = createDebugResourceStore(),
  traceStore = new InMemoryTraceStore(),
  webhookFetch = fetch,
  workflowTools = createDefaultWorkflowTools(),
}: DebugAgentServiceOptions = {}): DebugAgentService {
  const activeRunSessions = new Map<string, DebugSession>();
  const runMetadata = new Map<string, MainSystemRunMetadata>();
  const sessions = new Map<string, DebugSession>();

  return {
    traceStore,
    fetch: async (request) => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/health") {
        return jsonResponse({ ok: true, service: "helixent-debug-agent" });
      }

      if (request.method === "GET" && url.pathname === "/api/v1/health") {
        return jsonResponse({ ok: true, service: "helixent-debug-agent", version: "v1" });
      }

      if (request.method === "GET" && url.pathname === "/api/v1/status") {
        return jsonResponse(summarizeServiceStatus({ activeRunSessions, sessions, traceStore }));
      }

      if (request.method === "GET" && url.pathname === "/api/v1/agents") {
        return jsonResponse({
          agents: Object.values(AGENT_PROFILES).map(toMainSystemAgentProfile),
        });
      }

      const agentMatch = url.pathname.match(/^\/api\/v1\/agents\/([^/]+)$/);
      if (request.method === "GET" && agentMatch) {
        const agentType = decodeURIComponent(agentMatch[1]!);
        if (!isAgentType(agentType)) {
          return jsonResponse({ error: "agent not found" }, 404);
        }
        return jsonResponse({ agent: toMainSystemAgentProfile(AGENT_PROFILES[agentType]) });
      }

      if (request.method === "GET" && url.pathname === "/api/v1/conversations") {
        const page = paginateItems(listMainSystemConversations(sessions, url), url);
        return jsonResponse({ conversations: page.items, nextCursor: page.nextCursor });
      }

      const externalConversationMatch = url.pathname.match(/^\/api\/v1\/conversations\/by-external\/([^/]+)$/);
      if (request.method === "GET" && externalConversationMatch) {
        const externalConversationId = decodeURIComponent(externalConversationMatch[1]!);
        const session = listSessions(sessions).find((candidate) => candidate.externalConversationId === externalConversationId);
        if (!session) {
          return jsonResponse({ error: "conversation not found" }, 404);
        }
        return jsonResponse({ conversation: session });
      }

      if (request.method === "POST" && url.pathname === "/api/v1/conversations") {
        const body = await readJson<{
          agentType?: unknown;
          context?: unknown;
          externalConversationId?: string;
          metadata?: unknown;
          title?: string;
        }>(request);
        const agentType = readAgentType(body.agentType);
        const session = createSession(sessions, body.title?.trim() || AGENT_PROFILES[agentType].name, agentType, {
          context: readOptionalObject(body.context),
          externalConversationId: body.externalConversationId?.trim() || undefined,
          metadata: readOptionalObject(body.metadata),
        });
        return jsonResponse({ conversationId: session.id, conversation: summarizeSession(session) });
      }

      const conversationMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)$/);
      if (request.method === "GET" && conversationMatch) {
        const conversationId = decodeURIComponent(conversationMatch[1]!);
        const session = sessions.get(conversationId);
        if (!session) {
          return jsonResponse({ error: "conversation not found" }, 404);
        }
        return jsonResponse({ conversation: summarizeSession(session) });
      }
      if (request.method === "PATCH" && conversationMatch) {
        const conversationId = decodeURIComponent(conversationMatch[1]!);
        const session = sessions.get(conversationId);
        if (!session) {
          return jsonResponse({ error: "conversation not found" }, 404);
        }
        const body = await readJson<{
          agentType?: unknown;
          context?: unknown;
          externalConversationId?: unknown;
          metadata?: unknown;
          title?: unknown;
        }>(request);
        if (body.agentType !== undefined) {
          const nextAgentType = typeof body.agentType === "string" && isAgentType(body.agentType) ? body.agentType : undefined;
          if (nextAgentType !== session.agentType) {
            return jsonResponse({ error: "agentType cannot be changed for an existing conversation" }, 400);
          }
        }
        updateSession(session, body);
        return jsonResponse({ conversation: summarizeSession(session) });
      }
      if (request.method === "DELETE" && conversationMatch) {
        const conversationId = decodeURIComponent(conversationMatch[1]!);
        const session = sessions.get(conversationId);
        if (!session) {
          return jsonResponse({ error: "conversation not found" }, 404);
        }
        session.deleted = true;
        session.agent?.abort();
        sessions.delete(conversationId);
        const deletedRunCount = deleteSessionRuns(traceStore, conversationId);
        return jsonResponse({ conversationId, deletedRunCount });
      }

      const conversationContextMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/context$/);
      if (request.method === "GET" && conversationContextMatch) {
        const conversationId = decodeURIComponent(conversationContextMatch[1]!);
        const session = sessions.get(conversationId);
        if (!session) {
          return jsonResponse({ error: "conversation not found" }, 404);
        }
        return jsonResponse({ context: summarizeConversationContext({ session, traceStore }) });
      }

      const conversationContextSummaryMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/context\/summary$/);
      if (request.method === "GET" && conversationContextSummaryMatch) {
        const conversationId = decodeURIComponent(conversationContextSummaryMatch[1]!);
        const session = sessions.get(conversationId);
        if (!session) {
          return jsonResponse({ error: "conversation not found" }, 404);
        }
        return jsonResponse({ summary: summarizeContextSummary({ session, traceStore }) });
      }

      const conversationContextCompactMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/context\/compact$/);
      if (request.method === "POST" && conversationContextCompactMatch) {
        const conversationId = decodeURIComponent(conversationContextCompactMatch[1]!);
        const session = sessions.get(conversationId);
        if (!session) {
          return jsonResponse({ error: "conversation not found" }, 404);
        }
        const compacted = compactConversationContext({ session, traceStore });
        return jsonResponse({ compacted, context: summarizeConversationContext({ session, traceStore }) });
      }

      const conversationContextResetMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/context\/reset$/);
      if (request.method === "POST" && conversationContextResetMatch) {
        const conversationId = decodeURIComponent(conversationContextResetMatch[1]!);
        const session = sessions.get(conversationId);
        if (!session) {
          return jsonResponse({ error: "conversation not found" }, 404);
        }
        session.agent?.clearMessages();
        session.updatedAt = new Date().toISOString();
        return jsonResponse({ reset: true, context: summarizeConversationContext({ session, traceStore }) });
      }

      const conversationRunsMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/runs$/);
      if (request.method === "GET" && conversationRunsMatch) {
        const conversationId = decodeURIComponent(conversationRunsMatch[1]!);
        if (!sessions.has(conversationId)) {
          return jsonResponse({ error: "conversation not found" }, 404);
        }
        const runs = listMainSystemRuns({ conversationId, runMetadata, traceStore });
        const page = paginateItems(runs, url);
        return jsonResponse({ runs: page.items, nextCursor: page.nextCursor });
      }

      const conversationMessagesMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/messages$/);
      if (request.method === "GET" && conversationMessagesMatch) {
        const conversationId = decodeURIComponent(conversationMessagesMatch[1]!);
        if (!sessions.has(conversationId)) {
          return jsonResponse({ error: "conversation not found" }, 404);
        }
        const messages = listMainSystemMessages({ conversationId, runMetadata, traceStore });
        const page = paginateItems(messages, url);
        return jsonResponse({ messages: page.items, nextCursor: page.nextCursor });
      }

      if (request.method === "POST" && url.pathname === "/api/v1/agent/messages") {
        const body = await readJson<{
          agentType?: unknown;
          conversationId?: string;
          context?: unknown;
          externalConversationId?: string;
          callbackUrl?: unknown;
          message?: string;
          metadata?: unknown;
          requestId?: string;
          title?: string;
        }>(request);
        const message = body.message?.trim();
        if (!message) {
          return jsonResponse({ error: "message is required" }, 400);
        }
        const agentType = readAgentType(body.agentType);
        const session = body.conversationId
          ? sessions.get(body.conversationId)
          : createSession(sessions, body.title?.trim() || AGENT_PROFILES[agentType].name, agentType, {
            context: readOptionalObject(body.context),
            externalConversationId: body.externalConversationId?.trim() || undefined,
            metadata: readOptionalObject(body.metadata),
          });
        if (!session) {
          return jsonResponse({ error: "conversation not found" }, 404);
        }
        const runId = `run_${crypto.randomUUID()}`;
        const metadata = {
          callbackUrl: readOptionalString(body.callbackUrl),
          conversationId: session.id,
          context: readOptionalObject(body.context),
          metadata: readOptionalObject(body.metadata),
          requestId: body.requestId?.trim() || undefined,
        } satisfies MainSystemRunMetadata;
        runMetadata.set(runId, metadata);
        void enqueueRun({ activeRunSessions, session, runId, message, createAgent, traceStore })
          .then(() => sendWebhookCallback({ metadata, runId, traceStore, webhookFetch }));
        return jsonResponse({ runId, conversationId: session.id, status: "running" });
      }

      const conversationMessageRunMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/messages:run$/);
      if (request.method === "POST" && conversationMessageRunMatch) {
        const conversationId = decodeURIComponent(conversationMessageRunMatch[1]!);
        const session = sessions.get(conversationId);
        if (!session) {
          return jsonResponse({ error: "conversation not found" }, 404);
        }
        const body = await readJson<{ callbackUrl?: unknown; context?: unknown; message?: string; metadata?: unknown; requestId?: string }>(request);
        const message = body.message?.trim();
        if (!message) {
          return jsonResponse({ error: "message is required" }, 400);
        }
        const runId = `run_${crypto.randomUUID()}`;
        const metadata = {
          callbackUrl: readOptionalString(body.callbackUrl),
          conversationId: session.id,
          context: readOptionalObject(body.context),
          metadata: readOptionalObject(body.metadata),
          requestId: body.requestId?.trim() || undefined,
        } satisfies MainSystemRunMetadata;
        runMetadata.set(runId, metadata);
        await enqueueRun({ activeRunSessions, session, runId, message, createAgent, traceStore });
        void sendWebhookCallback({ metadata, runId, traceStore, webhookFetch });
        return jsonResponse(toMainSystemRunResult({ runId, metadata, traceStore }));
      }

      const conversationMessageMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/messages$/);
      if (request.method === "POST" && conversationMessageMatch) {
        const conversationId = decodeURIComponent(conversationMessageMatch[1]!);
        const session = sessions.get(conversationId);
        if (!session) {
          return jsonResponse({ error: "conversation not found" }, 404);
        }
        const body = await readJson<{ callbackUrl?: unknown; context?: unknown; message?: string; metadata?: unknown; requestId?: string }>(request);
        const message = body.message?.trim();
        if (!message) {
          return jsonResponse({ error: "message is required" }, 400);
        }
        const runId = `run_${crypto.randomUUID()}`;
        const metadata = {
          callbackUrl: readOptionalString(body.callbackUrl),
          conversationId: session.id,
          context: readOptionalObject(body.context),
          metadata: readOptionalObject(body.metadata),
          requestId: body.requestId?.trim() || undefined,
        } satisfies MainSystemRunMetadata;
        runMetadata.set(runId, metadata);
        void enqueueRun({ activeRunSessions, session, runId, message, createAgent, traceStore })
          .then(() => sendWebhookCallback({ metadata, runId, traceStore, webhookFetch }));
        return jsonResponse({ runId, conversationId: session.id, status: "running" });
      }

      const v1RunCancelMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && v1RunCancelMatch) {
        const runId = decodeURIComponent(v1RunCancelMatch[1]!);
        const session = activeRunSessions.get(runId);
        if (!session?.agent?.streaming) {
          return jsonResponse({ error: "run is not running" }, 404);
        }
        session.agent.abort();
        return jsonResponse({ runId, status: "aborting" });
      }

      const v1RunRetryMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/retry$/);
      if (request.method === "POST" && v1RunRetryMatch) {
        const retryOfRunId = decodeURIComponent(v1RunRetryMatch[1]!);
        const summary = traceStore.listRuns().find((run) => run.runId === retryOfRunId);
        if (!summary) {
          return jsonResponse({ error: "run not found" }, 404);
        }
        const originalMetadata = runMetadata.get(retryOfRunId);
        const conversationId = originalMetadata?.conversationId ?? summary.sessionId;
        const session = conversationId ? sessions.get(conversationId) : undefined;
        if (!session) {
          return jsonResponse({ error: "conversation not found" }, 404);
        }
        const originalInput = traceStore.getEvents(retryOfRunId).find((event) => event.type === "run_started");
        if (!originalInput || !("input" in originalInput)) {
          return jsonResponse({ error: "run input not found" }, 400);
        }
        const body = await readJson<{ callbackUrl?: unknown; context?: unknown; metadata?: unknown; requestId?: string }>(request);
        const runId = `run_${crypto.randomUUID()}`;
        const metadata = {
          callbackUrl: readOptionalString(body.callbackUrl) ?? originalMetadata?.callbackUrl,
          conversationId: session.id,
          context: Object.hasOwn(body, "context") ? readOptionalObject(body.context) : originalMetadata?.context,
          metadata: Object.hasOwn(body, "metadata") ? readOptionalObject(body.metadata) : originalMetadata?.metadata,
          requestId: body.requestId?.trim() || originalMetadata?.requestId,
        } satisfies MainSystemRunMetadata;
        runMetadata.set(runId, metadata);
        void enqueueRun({ activeRunSessions, session, runId, message: originalInput.input, createAgent, traceStore })
          .then(() => sendWebhookCallback({ metadata, runId, traceStore, webhookFetch }));
        return jsonResponse({ runId, retryOfRunId, conversationId: session.id, status: "running" });
      }

      const v1RunEventsMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/events$/);
      if (request.method === "GET" && v1RunEventsMatch) {
        const runId = decodeURIComponent(v1RunEventsMatch[1]!);
        if (!traceStore.listRuns().some((run) => run.runId === runId)) {
          return jsonResponse({ error: "run not found" }, 404);
        }
        const events = traceStore.getEvents(runId).map(toUserSafeEvent).filter((event): event is UserSafeEvent => Boolean(event));
        const page = paginateItems(events, url);
        return jsonResponse({ events: page.items, nextCursor: page.nextCursor });
      }

      const v1RunMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
      if (request.method === "GET" && v1RunMatch) {
        const runId = decodeURIComponent(v1RunMatch[1]!);
        const summary = traceStore.listRuns().find((run) => run.runId === runId);
        if (!summary) {
          return jsonResponse({ error: "run not found" }, 404);
        }
        return jsonResponse(toMainSystemRun(summary, runMetadata.get(runId)));
      }

      const v1RunResultMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/result$/);
      if (request.method === "GET" && v1RunResultMatch) {
        const runId = decodeURIComponent(v1RunResultMatch[1]!);
        const summary = traceStore.listRuns().find((run) => run.runId === runId);
        if (!summary) {
          return jsonResponse({ error: "run not found" }, 404);
        }
        const events = traceStore.getEvents(runId);
        return jsonResponse(toMainSystemRunResult({ events, metadata: runMetadata.get(runId), runId, summary, traceStore }));
      }

      const v1RunStreamMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/stream$/);
      if (request.method === "GET" && v1RunStreamMatch) {
        return sseResponse((send) => {
          const runId = decodeURIComponent(v1RunStreamMatch[1]!);
          for (const event of traceStore.getEvents(runId)) {
            const userEvent = toUserSafeEvent(event);
            if (userEvent) send(userEvent);
          }
          return traceStore.subscribe((event) => {
            if (event.runId !== runId) return;
            const userEvent = toUserSafeEvent(event);
            if (userEvent) send(userEvent);
          });
        });
      }

      if (request.method === "POST" && url.pathname === "/api/agent/runs") {
        const body = await readJson<{ agentType?: unknown; message?: string; sessionId?: string }>(request);
        const message = body.message?.trim();
        if (!message) {
          return jsonResponse({ error: "message is required" }, 400);
        }
        const agentType = readAgentType(body.agentType);

        const session = body.sessionId
          ? sessions.get(body.sessionId)
          : createSession(sessions, AGENT_PROFILES[agentType].name, agentType);
        if (!session) {
          return jsonResponse({ error: "session not found" }, 404);
        }

        const runId = `run_${crypto.randomUUID()}`;
        void enqueueRun({ activeRunSessions, session, runId, message, createAgent, traceStore });
        return jsonResponse({ runId, sessionId: session.id });
      }

      if (request.method === "POST" && url.pathname === "/api/workflows/runs") {
        const body = await readJson<{ agentType?: unknown; input?: unknown; sessionId?: string; workflowId?: string }>(request);
        const workflowId = body.workflowId?.trim();
        if (!workflowId) {
          return jsonResponse({ error: "workflowId is required" }, 400);
        }
        const sessionId = body.sessionId?.trim();
        if (sessionId && !sessions.has(sessionId)) {
          return jsonResponse({ error: "session not found" }, 404);
        }

        const resources = await resourceStore.listResources();
        const workflowResource = resources.workflow.find((resource) => resource.id === workflowId);
        if (!workflowResource) {
          return jsonResponse({ error: "workflow not found" }, 404);
        }

        const workflowRunId = `workflow_run_${crypto.randomUUID()}`;
        const session = sessionId ? sessions.get(sessionId) : undefined;
        const input = {
          cwd: process.cwd(),
          ...readObject(body.input),
        };
        runWorkflowInBackground({
          agentType: readAgentType(body.agentType),
          createAgent,
          input,
          runId: workflowRunId,
          session,
          sessionId,
          tools: workflowTools,
          traceStore,
          workflowPath: workflowResource.path,
        });
        return jsonResponse({ workflowRunId, status: "running" });
      }

      if (request.method === "GET" && url.pathname === "/api/internal/sessions") {
        return jsonResponse(listSessions(sessions));
      }

      if (request.method === "DELETE" && url.pathname === "/api/internal/sessions") {
        const deletedSessionCount = sessions.size;
        for (const session of sessions.values()) {
          session.deleted = true;
        }
        sessions.clear();
        const deletedRunCount = traceStore.clear();
        return jsonResponse({ deletedSessionCount, deletedRunCount });
      }

      if (request.method === "POST" && url.pathname === "/api/internal/sessions") {
        const body = await readJson<{ agentType?: unknown; title?: string }>(request);
        const agentType = readAgentType(body.agentType);
        const session = createSession(sessions, body.title?.trim() || AGENT_PROFILES[agentType].name, agentType);
        return jsonResponse({ sessionId: session.id, session: summarizeSession(session) });
      }

      const archiveMatch = url.pathname.match(/^\/api\/internal\/sessions\/([^/]+)\/archive$/);
      if (request.method === "POST" && archiveMatch) {
        const sessionId = decodeURIComponent(archiveMatch[1]!);
        const session = sessions.get(sessionId);
        if (!session) {
          return jsonResponse({ error: "session not found" }, 404);
        }
        try {
          return jsonResponse(await archiveSession({ archiveDir, session, traceStore }));
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
        }
      }

      const sessionMatch = url.pathname.match(/^\/api\/internal\/sessions\/([^/]+)$/);
      if (request.method === "DELETE" && sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]!);
        const session = sessions.get(sessionId);
        if (!session) {
          return jsonResponse({ error: "session not found" }, 404);
        }
        session.deleted = true;
        sessions.delete(sessionId);
        const deletedRunCount = deleteSessionRuns(traceStore, sessionId);
        return jsonResponse({ sessionId, deletedRunCount });
      }

      if (request.method === "GET" && url.pathname === "/api/internal/resources") {
        return jsonResponse(await resourceStore.listResources());
      }

      if (request.method === "GET" && url.pathname === "/api/internal/context-policy") {
        return jsonResponse(resolveDebugContextCompactionPolicy());
      }

      if (request.method === "POST" && url.pathname === "/api/internal/resources") {
        const body = await readJson<{ type?: DebugResourceType; name?: string }>(request);
        if (!isResourceType(body.type) || !body.name?.trim()) {
          return jsonResponse({ error: "type and name are required" }, 400);
        }
        try {
          return jsonResponse(await resourceStore.createResource({ type: body.type, name: body.name }));
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
      }

      const resourceMatch = url.pathname.match(/^\/api\/internal\/resources\/([^/]+)\/([^/]+)$/);
      if (request.method === "DELETE" && resourceMatch) {
        const type = decodeURIComponent(resourceMatch[1]!);
        const id = decodeURIComponent(resourceMatch[2]!);
        if (!isReadableResourceType(type)) {
          return jsonResponse({ error: "valid resource type is required" }, 400);
        }
        try {
          return jsonResponse(await resourceStore.deleteResource({ type, id }));
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 404);
        }
      }

      if (request.method === "PUT" && resourceMatch) {
        const type = decodeURIComponent(resourceMatch[1]!);
        const id = decodeURIComponent(resourceMatch[2]!);
        const body = await readJson<{ content?: string }>(request);
        if (!isResourceType(type) || typeof body.content !== "string") {
          return jsonResponse({ error: "valid resource type and content are required" }, 400);
        }
        try {
          return jsonResponse(await resourceStore.updateResource({ type, id, content: body.content }));
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 404);
        }
      }

      const streamMatch = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/stream$/);
      if (request.method === "GET" && streamMatch) {
        return sseResponse((send) => {
          const runId = decodeURIComponent(streamMatch[1]!);
          for (const event of traceStore.getEvents(runId)) {
            const userEvent = toUserSafeEvent(event);
            if (userEvent) send(userEvent);
          }
          return traceStore.subscribe((event) => {
            if (event.runId !== runId) return;
            const userEvent = toUserSafeEvent(event);
            if (userEvent) send(userEvent);
          });
        });
      }

      if (request.method === "GET" && url.pathname === "/api/internal/runs") {
        return jsonResponse(traceStore.listRuns());
      }

      const eventsMatch = url.pathname.match(/^\/api\/internal\/runs\/([^/]+)\/events$/);
      if (request.method === "GET" && eventsMatch) {
        return jsonResponse(traceStore.getEvents(decodeURIComponent(eventsMatch[1]!)));
      }

      if (request.method === "GET" && url.pathname === "/api/internal/events/live") {
        return sseResponse((send) => traceStore.subscribe(send));
      }

      return jsonResponse({ error: "Not found" }, 404);
    },
  };
}

function createDefaultWorkflowTools(): Tool[] {
  return [
    bashTool,
    fileInfoTool,
    listFilesTool,
    globSearchTool,
    grepSearchTool,
    mkdirTool,
    movePathTool,
    readFileTool,
    writeFileTool,
    strReplaceTool,
    applyPatchTool,
  ];
}

function toMainSystemAgentProfile(profile: (typeof AGENT_PROFILES)[AgentType]) {
  return {
    type: profile.type,
    name: profile.name,
    role: profile.role,
    description: profile.description,
  };
}

function summarizeServiceStatus({
  activeRunSessions,
  sessions,
  traceStore,
}: {
  activeRunSessions: Map<string, DebugSession>;
  sessions: Map<string, DebugSession>;
  traceStore: TraceStore;
}) {
  const runs = traceStore.listRuns();
  return {
    ok: true,
    service: "helixent-debug-agent",
    version: "v1",
    model: resolveModelStatus(),
    agents: {
      available: Object.keys(AGENT_PROFILES).length,
      types: Object.keys(AGENT_PROFILES),
    },
    conversations: {
      total: sessions.size,
      active: [...sessions.values()].filter((session) => Boolean(session.agent)).length,
    },
    runs: {
      total: runs.length,
      running: runs.filter((run) => run.status === "running").length,
      active: activeRunSessions.size,
    },
  };
}

function resolveModelStatus() {
  try {
    const model = resolveDebugModelEntry();
    return {
      configured: true,
      name: model.name,
      provider: model.provider,
      baseURL: model.baseURL,
    };
  } catch (error) {
    return {
      configured: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function createSession(
  sessions: Map<string, DebugSession>,
  title: string,
  agentType: AgentType = "gma",
  options: { context?: Record<string, unknown>; externalConversationId?: string; metadata?: Record<string, unknown> } = {},
): DebugSession {
  const now = new Date().toISOString();
  const session = {
    id: `session_${crypto.randomUUID()}`,
    title,
    agentType,
    createdAt: now,
    updatedAt: now,
    context: options.context,
    externalConversationId: options.externalConversationId,
    metadata: options.metadata,
    runCount: 0,
    deleted: false,
    queue: Promise.resolve(),
  } satisfies DebugSession;
  sessions.set(session.id, session);
  return session;
}

function updateSession(
  session: DebugSession,
  body: {
    context?: unknown;
    externalConversationId?: unknown;
    metadata?: unknown;
    title?: unknown;
  },
) {
  if (typeof body.title === "string" && body.title.trim()) {
    session.title = body.title.trim();
  }
  if (Object.hasOwn(body, "context")) {
    session.context = readOptionalObject(body.context);
  }
  if (Object.hasOwn(body, "metadata")) {
    session.metadata = readOptionalObject(body.metadata);
  }
  if (Object.hasOwn(body, "externalConversationId")) {
    session.externalConversationId = typeof body.externalConversationId === "string" && body.externalConversationId.trim()
      ? body.externalConversationId.trim()
      : undefined;
  }
  session.updatedAt = new Date().toISOString();
}

function listSessions(sessions: Map<string, DebugSession>): DebugSessionSummary[] {
  return [...sessions.values()].map(summarizeSession).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function listMainSystemConversations(sessions: Map<string, DebugSession>, url: URL): DebugSessionSummary[] {
  const agentType = url.searchParams.get("agentType");
  const externalConversationId = url.searchParams.get("externalConversationId");
  const createdAfter = readTimestamp(url.searchParams.get("createdAfter"));
  const createdBefore = readTimestamp(url.searchParams.get("createdBefore"));

  return listSessions(sessions).filter((session) => {
    if (agentType && (!isAgentType(agentType) || session.agentType !== agentType)) return false;
    if (externalConversationId && session.externalConversationId !== externalConversationId) return false;
    const createdAt = Date.parse(session.createdAt);
    if (createdAfter !== undefined && createdAt <= createdAfter) return false;
    if (createdBefore !== undefined && createdAt >= createdBefore) return false;
    return true;
  });
}

function paginateItems<T>(items: T[], url: URL): { items: T[]; nextCursor?: string } {
  const limit = readPageLimit(url.searchParams.get("limit"));
  const offset = readCursorOffset(url.searchParams.get("cursor"));
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    nextCursor: nextOffset < items.length ? String(nextOffset) : undefined,
  };
}

function readPageLimit(value: string | null): number {
  if (!value) return DEFAULT_PAGE_LIMIT;
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_PAGE_LIMIT;
  return Math.min(limit, MAX_PAGE_LIMIT);
}

function readCursorOffset(value: string | null): number {
  if (!value) return 0;
  const offset = Number.parseInt(value, 10);
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

function readTimestamp(value: string | null): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function summarizeSession(session: DebugSession): DebugSessionSummary {
  return {
    id: session.id,
    title: session.title,
    agentType: session.agentType,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    context: session.context,
    externalConversationId: session.externalConversationId,
    metadata: session.metadata,
    active: Boolean(session.agent),
    runCount: session.runCount,
  };
}

function summarizeConversationContext({ session, traceStore }: { session: DebugSession; traceStore: TraceStore }) {
  const policy = resolveDebugContextCompactionPolicy();
  const compactionEvents = traceStore
    .listRuns()
    .filter((run) => run.sessionId === session.id)
    .flatMap((run) => traceStore.getEvents(run.runId))
    .filter((event) => event.type === "context_compacted");
  const messageCount = session.agent?.messages.length ?? estimateMessageCountFromTrace({ sessionId: session.id, traceStore });
  const percent = Math.min(100, Math.round((messageCount / policy.maxMessagesBeforeCompact) * 100));
  const lastCompactedAt = compactionEvents.at(-1)?.timestamp;
  const summaryPreview = currentContextSummaryPreview(session);
  return {
    conversationId: session.id,
    enabled: policy.enabled,
    maxMessagesBeforeCompact: policy.maxMessagesBeforeCompact,
    keepRecentMessages: policy.keepRecentMessages,
    maxSummaryCharacters: policy.maxSummaryCharacters,
    messageCount,
    percent,
    status: percent >= 90 ? "danger" : percent >= 70 ? "warning" : "normal",
    summaryActive: Boolean(summaryPreview),
    summaryPreview,
    compactedCount: compactionEvents.length,
    lastCompactedAt,
  };
}

function compactConversationContext({ session, traceStore }: { session: DebugSession; traceStore: TraceStore }): boolean {
  const messages = session.agent?.messages;
  if (!messages?.length) return false;
  const policy = resolveDebugContextCompactionPolicy();
  const keepRecentMessages = Math.min(policy.keepRecentMessages, messages.length);
  if (messages.length <= keepRecentMessages + 1) return false;

  const previousMessageCount = messages.length;
  const compactedMessageCount = previousMessageCount - keepRecentMessages;
  const summaryPreview = `Manual context summary: ${compactedMessageCount} older messages were compacted. Recent context is preserved.`;
  const summaryMessage: NonSystemMessage = {
    role: "assistant",
    content: [{ type: "text", text: summaryPreview }],
  };
  messages.splice(0, compactedMessageCount, summaryMessage);
  session.updatedAt = new Date().toISOString();

  const runId = latestConversationRunId({ sessionId: session.id, traceStore });
  if (runId) {
    traceStore.append(runId, {
      type: "context_compacted",
      previousMessageCount,
      currentMessageCount: messages.length,
      compactedMessageCount,
      keptMessageCount: keepRecentMessages,
      summaryPreview,
    });
  }
  return true;
}

function summarizeContextSummary({ session, traceStore }: { session: DebugSession; traceStore: TraceStore }) {
  const lastEvent = latestContextCompactionEvent({ sessionId: session.id, traceStore });
  const preview = currentContextSummaryPreview(session) ?? lastEvent?.summaryPreview;
  return {
    active: Boolean(currentContextSummaryPreview(session)),
    preview,
    compactedCount: traceStore
      .listRuns()
      .filter((run) => run.sessionId === session.id)
      .flatMap((run) => traceStore.getEvents(run.runId))
      .filter((event) => event.type === "context_compacted").length,
    lastCompactedAt: lastEvent?.timestamp,
  };
}

function currentContextSummaryPreview(session: DebugSession): string | undefined {
  const first = session.agent?.messages[0];
  if (first?.role !== "assistant") return undefined;
  return messageText(first);
}

function messageText(message: NonSystemMessage): string {
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

function latestContextCompactionEvent({ sessionId, traceStore }: { sessionId: string; traceStore: TraceStore }) {
  return traceStore
    .listRuns()
    .filter((run) => run.sessionId === sessionId)
    .flatMap((run) => traceStore.getEvents(run.runId))
    .filter((event) => event.type === "context_compacted")
    .at(-1);
}

function latestConversationRunId({ sessionId, traceStore }: { sessionId: string; traceStore: TraceStore }): string | undefined {
  return traceStore.listRuns().find((run) => run.sessionId === sessionId)?.runId;
}

function estimateMessageCountFromTrace({ sessionId, traceStore }: { sessionId: string; traceStore: TraceStore }): number {
  return traceStore
    .listRuns()
    .filter((run) => run.sessionId === sessionId)
    .flatMap((run) => traceStore.getEvents(run.runId))
    .filter((event) => event.type === "run_started" || event.type === "final_answer")
    .length;
}

function toMainSystemRun(
  summary: TraceRunSummary,
  metadata?: MainSystemRunMetadata,
): TraceRunSummary & {
  context?: Record<string, unknown>;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
} {
  return {
    ...summary,
    context: metadata?.context,
    conversationId: metadata?.conversationId ?? summary.sessionId,
    metadata: metadata?.metadata,
    requestId: metadata?.requestId,
  };
}

function toMainSystemRunResult({
  events,
  metadata,
  runId,
  summary,
  traceStore,
}: {
  events?: TraceEvent[];
  metadata?: MainSystemRunMetadata;
  runId: string;
  summary?: TraceRunSummary;
  traceStore: TraceStore;
}) {
  const runSummary = summary ?? traceStore.listRuns().find((run) => run.runId === runId);
  const runEvents = events ?? traceStore.getEvents(runId);
  const finalAnswer = [...runEvents].reverse().find((event) => event.type === "final_answer");
  const failure = [...runEvents].reverse().find((event) => event.type === "run_failed" || event.type === "workflow_failed");
  return {
    ...(runSummary ? toMainSystemRun(runSummary, metadata) : { runId, conversationId: metadata?.conversationId, status: "unknown" }),
    finalAnswer: finalAnswer && "text" in finalAnswer ? finalAnswer.text : undefined,
    error: failure && "error" in failure ? failure.error : undefined,
    requestId: metadata?.requestId,
  };
}

async function sendWebhookCallback({
  metadata,
  runId,
  traceStore,
  webhookFetch,
}: {
  metadata: MainSystemRunMetadata;
  runId: string;
  traceStore: TraceStore;
  webhookFetch: WebhookFetch;
}) {
  if (!metadata.callbackUrl) return;
  try {
    await webhookFetch(metadata.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(toMainSystemRunResult({ metadata, runId, traceStore })),
    });
  } catch {
    // Webhook delivery is best-effort so a callback outage does not change run state.
  }
}

function enqueueRun({
  activeRunSessions,
  session,
  runId,
  message,
  createAgent,
  traceStore,
}: {
  activeRunSessions: Map<string, DebugSession>;
  session: DebugSession;
  runId: string;
  message: string;
  createAgent: (agentType?: AgentType) => Promise<Agent>;
  traceStore: TraceStore;
}): Promise<void> {
  session.updatedAt = new Date().toISOString();
  session.runCount += 1;
  session.queue = session.queue
    .catch(() => undefined)
    .then(async () => {
      if (session.deleted) return;
      activeRunSessions.set(runId, session);
      try {
        session.agent ??= await createAgent(session.agentType);
        if (session.agent.name) {
          session.title = session.agent.name;
        }
        await runAgent({
          runId,
          sessionId: session.id,
          message,
          agent: session.agent,
          traceStore,
          shouldRecord: () => !session.deleted,
        });
        if (session.deleted) return;
        session.updatedAt = new Date().toISOString();
      } catch (error) {
        if (session.deleted) return;
        recordRunStartupFailure({ runId, sessionId: session.id, message, error, traceStore });
        session.updatedAt = new Date().toISOString();
      } finally {
        activeRunSessions.delete(runId);
      }
    });
  return session.queue;
}

function recordRunStartupFailure({
  runId,
  sessionId,
  message,
  error,
  traceStore,
}: {
  runId: string;
  sessionId: string;
  message: string;
  error: unknown;
  traceStore: TraceStore;
}) {
  if (!traceStore.getEvents(runId).some((event) => event.type === "run_started")) {
    traceStore.append(runId, { type: "run_started", input: message, sessionId });
  }
  if (!traceStore.getEvents(runId).some((event) => event.type === "run_failed")) {
    traceStore.append(runId, {
      type: "run_failed",
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function deleteSessionRuns(traceStore: TraceStore, sessionId: string): number {
  const runIds = traceStore.listRuns().filter((run) => run.sessionId === sessionId).map((run) => run.runId);
  for (const runId of runIds) {
    traceStore.deleteRun(runId);
  }
  return runIds.length;
}

function listMainSystemMessages({
  conversationId,
  runMetadata,
  traceStore,
}: {
  conversationId: string;
  runMetadata: Map<string, MainSystemRunMetadata>;
  traceStore: TraceStore;
}): Array<{
  content: string;
  requestId?: string;
  role: "assistant" | "user";
  runId: string;
  timestamp: string;
}> {
  return listMainSystemRuns({ conversationId, runMetadata, traceStore })
    .flatMap((run) => {
      const metadata = runMetadata.get(run.runId);
      const events = traceStore.getEvents(run.runId);
      const messages: Array<{
        content: string;
        requestId?: string;
        role: "assistant" | "user";
        runId: string;
        timestamp: string;
      }> = [];
      const started = events.find((event) => event.type === "run_started");
      if (started && "input" in started) {
        messages.push({
          role: "user",
          content: started.input,
          runId: run.runId,
          requestId: metadata?.requestId,
          timestamp: started.timestamp,
        });
      }
      const finalAnswer = events.find((event) => event.type === "final_answer");
      if (finalAnswer && "text" in finalAnswer) {
        messages.push({
          role: "assistant",
          content: finalAnswer.text,
          runId: run.runId,
          requestId: metadata?.requestId,
          timestamp: finalAnswer.timestamp,
        });
      }
      return messages;
    });
}

function listMainSystemRuns({
  conversationId,
  runMetadata,
  traceStore,
}: {
  conversationId: string;
  runMetadata: Map<string, MainSystemRunMetadata>;
  traceStore: TraceStore;
}): Array<TraceRunSummary & {
  context?: Record<string, unknown>;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
}> {
  return traceStore
    .listRuns()
    .filter((run) => run.sessionId === conversationId)
    .reverse()
    .map((run) => toMainSystemRun(run, runMetadata.get(run.runId)));
}

function runWorkflowInBackground({
  agentType,
  createAgent,
  input,
  runId,
  session,
  sessionId,
  tools,
  traceStore,
  workflowPath,
}: {
  agentType: AgentType;
  createAgent: (agentType?: AgentType) => Promise<Agent>;
  input: Record<string, unknown>;
  runId: string;
  session?: DebugSession;
  sessionId?: string;
  tools: Tool[];
  traceStore: TraceStore;
  workflowPath: string;
}) {
  const executeWorkflow = async () => {
    try {
      const workflow = await readWorkflowFile(workflowPath);
      for await (const event of runWorkflow({
        workflow,
        input,
        tools,
        resolveAgent: async () => {
          if (!session) {
            return createAgent(agentType);
          }
          session.agent ??= await createAgent(session.agentType);
          if (session.agent.name) {
            session.title = session.agent.name;
          }
          return session.agent;
        },
      })) {
        traceStore.append(runId, sessionId ? { ...event, sessionId } : event);
      }
      if (session) {
        session.updatedAt = new Date().toISOString();
      }
    } catch (error) {
      if (traceStore.getEvents(runId).some((event) => event.type === "workflow_failed")) return;
      traceStore.append(runId, {
        type: "workflow_failed",
        workflowId: "unknown",
        workflowName: "Unknown Workflow",
        durationMs: 0,
        sessionId,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      if (session) {
        session.updatedAt = new Date().toISOString();
      }
    }
  };

  if (!session) {
    void executeWorkflow();
    return;
  }

  session.updatedAt = new Date().toISOString();
  session.runCount += 1;
  session.queue = session.queue
    .catch(() => undefined)
    .then(async () => {
      if (session.deleted) return;
      await executeWorkflow();
    });
}

async function archiveSession({
  archiveDir,
  session,
  traceStore,
}: {
  archiveDir: string;
  session: DebugSession;
  traceStore: TraceStore;
}): Promise<{ sessionId: string; resourceId: string; path: string; archivedRunCount: number; archivedEventCount: number }> {
  const archivedAt = new Date().toISOString();
  const runs = traceStore
    .listRuns()
    .filter((run) => run.sessionId === session.id)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((summary) => ({
      summary,
      events: traceStore.getEvents(summary.runId),
    }));
  const archive = {
    type: "helixent.debug-session-archive",
    version: 1,
    archivedAt,
    session: summarizeSession(session),
    runs,
  };
  await mkdir(archiveDir, { recursive: true });
  const archiveName = `${fileSafeTimestamp(archivedAt)}-${safeFileSegment(session.title)}-${session.id}`;
  const path = join(archiveDir, `${archiveName}.json`);
  await writeFile(path, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
  return {
    sessionId: session.id,
    resourceId: safeFileSegment(archiveName),
    path,
    archivedRunCount: runs.length,
    archivedEventCount: runs.reduce((count, run) => count + run.events.length, 0),
  };
}

function safeFileSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "agent";
}

function fileSafeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function isResourceType(value: unknown): value is DebugResourceType {
  return value === "prompt" || value === "skill" || value === "tool" || value === "workflow";
}

function isReadableResourceType(value: unknown): value is DebugReadableResourceType {
  return isResourceType(value) || value === "archive";
}

function readAgentType(value: unknown): AgentType {
  return isAgentType(value) ? value : "gma";
}

async function runAgent({
  runId,
  sessionId,
  message,
  agent,
  traceStore,
  shouldRecord,
}: {
  runId: string;
  sessionId: string;
  message: string;
  agent: Agent;
  traceStore: TraceStore;
  shouldRecord: () => boolean;
}) {
  try {
    for await (const event of agent.stream({ role: "user", content: [{ type: "text", text: message }] })) {
      if (!shouldRecord()) return;
      const traceEvent = toTraceEventInput(event, sessionId);
      if (traceEvent) {
        traceStore.append(runId, traceEvent);
      }
    }
  } catch (error) {
    if (!shouldRecord()) return;
    if (traceStore.getEvents(runId).some((event) => event.type === "run_aborted")) return;
    traceStore.append(runId, {
      type: "run_failed",
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function toTraceEventInput(event: AgentEvent, sessionId: string): TraceEventInput | null {
  if (event.type === "message") return null;
  if (event.type === "run_started") return { ...event, sessionId };
  return event;
}

function toUserSafeEvent(event: TraceEvent): UserSafeEvent | null {
  if (event.type === "run_started") {
    return pickEvent(event, { agentName: event.agentName, input: event.input, sessionId: event.sessionId });
  }
  if (event.type === "final_answer") {
    return pickEvent(event, { text: event.text });
  }
  if (event.type === "run_completed") {
    return pickEvent(event, { durationMs: event.durationMs });
  }
  if (event.type === "run_failed") {
    return pickEvent(event, { error: { message: event.error.message } });
  }
  if (event.type === "run_aborted") {
    return pickEvent(event, { reason: event.reason });
  }
  if (event.type === "context_compacted") {
    return pickEvent(event, {
      compactedMessageCount: event.compactedMessageCount,
      currentMessageCount: event.currentMessageCount,
      keptMessageCount: event.keptMessageCount,
      previousMessageCount: event.previousMessageCount,
      summaryPreview: event.summaryPreview,
    });
  }
  return null;
}

function pickEvent(event: TraceEvent, extra: Record<string, unknown>): UserSafeEvent {
  return {
    id: event.id,
    runId: event.runId,
    type: event.type,
    timestamp: event.timestamp,
    sequence: event.sequence,
    ...extra,
  };
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readOptionalObject(value: unknown): Record<string, unknown> | undefined {
  const object = readObject(value);
  return Object.keys(object).length > 0 ? object : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function sseResponse(subscribe: (send: (event: unknown) => void) => () => void): Response {
  let unsubscribe: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(": connected\n\n"));
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      unsubscribe = subscribe(send);
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
