import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  InMemoryTraceStore,
  type Agent,
  type AgentEvent,
  readWorkflowFile,
  type TraceEvent,
  type TraceEventInput,
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
import type { Tool } from "@/foundation";

import { createDefaultDebugAgent } from "./coding-agent";
import { createDebugResourceStore, type DebugReadableResourceType, type DebugResourceStore, type DebugResourceType } from "./debug-resource-store";

export interface DebugAgentService {
  fetch(request: Request): Promise<Response>;
  traceStore: TraceStore;
}

export interface DebugAgentServiceOptions {
  archiveDir?: string;
  createAgent?: (agentType?: AgentType) => Promise<Agent>;
  resourceStore?: DebugResourceStore;
  traceStore?: TraceStore;
  workflowTools?: Tool[];
}

type UserSafeEvent = Pick<TraceEvent, "id" | "runId" | "type" | "timestamp" | "sequence"> & Record<string, unknown>;

interface DebugSession {
  id: string;
  title: string;
  agentType: AgentType;
  createdAt: string;
  updatedAt: string;
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
  active: boolean;
  runCount: number;
}

export function createDebugAgentService({
  archiveDir = join(process.cwd(), ".helixent", "debug-panel", "archives"),
  createAgent = createDefaultDebugAgent,
  resourceStore = createDebugResourceStore(),
  traceStore = new InMemoryTraceStore(),
  workflowTools = createDefaultWorkflowTools(),
}: DebugAgentServiceOptions = {}): DebugAgentService {
  const sessions = new Map<string, DebugSession>();

  return {
    traceStore,
    fetch: async (request) => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/health") {
        return jsonResponse({ ok: true, service: "helixent-debug-agent" });
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
        enqueueRun({ session, runId, message, createAgent, traceStore });
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

function createSession(sessions: Map<string, DebugSession>, title: string, agentType: AgentType = "gma"): DebugSession {
  const now = new Date().toISOString();
  const session = {
    id: `session_${crypto.randomUUID()}`,
    title,
    agentType,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    deleted: false,
    queue: Promise.resolve(),
  } satisfies DebugSession;
  sessions.set(session.id, session);
  return session;
}

function listSessions(sessions: Map<string, DebugSession>): DebugSessionSummary[] {
  return [...sessions.values()].map(summarizeSession).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function summarizeSession(session: DebugSession): DebugSessionSummary {
  return {
    id: session.id,
    title: session.title,
    agentType: session.agentType,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    active: Boolean(session.agent),
    runCount: session.runCount,
  };
}

function enqueueRun({
  session,
  runId,
  message,
  createAgent,
  traceStore,
}: {
  session: DebugSession;
  runId: string;
  message: string;
  createAgent: (agentType?: AgentType) => Promise<Agent>;
  traceStore: TraceStore;
}) {
  session.updatedAt = new Date().toISOString();
  session.runCount += 1;
  session.queue = session.queue
    .catch(() => undefined)
    .then(async () => {
      if (session.deleted) return;
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
    });
}

function deleteSessionRuns(traceStore: TraceStore, sessionId: string): number {
  const runIds = traceStore.listRuns().filter((run) => run.sessionId === sessionId).map((run) => run.runId);
  for (const runId of runIds) {
    traceStore.deleteRun(runId);
  }
  return runIds.length;
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
