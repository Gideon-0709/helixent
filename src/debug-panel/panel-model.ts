export type ResourceType = "archive" | "prompt" | "skill" | "tool";
export type WritableResourceType = Exclude<ResourceType, "archive">;

export interface EditableResource {
  id: string;
  type?: ResourceType;
  name: string;
  content: string;
  path?: string;
  language?: "json" | "markdown" | "typescript" | "xml";
  active?: boolean;
  readOnly?: boolean;
}

export type ResourceMap = Record<ResourceType, EditableResource[]>;

export type PanelTraceEvent = {
  id: string;
  runId: string;
  type: string;
  timestamp: string;
  sequence: number;
} & Record<string, unknown>;

export interface KeyEvent {
  kind: "user" | "ai" | "tool" | "error" | "meta";
  title: string;
  text: string;
  time: string;
  raw: PanelTraceEvent;
}

export interface TokenStats {
  prompt: number;
  completion: number;
  total: number;
}

export interface PanelSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  runCount?: number;
  draft?: boolean;
}

export interface ComposerKeyState {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
}

export const DRAFT_SESSION_PREFIX = "draft_";

export const defaultResources: ResourceMap = {
  prompt: [
    {
      id: "system",
      name: "System Prompt",
      content:
        "You are Helixent, a coding agent. Inspect context, use tools carefully, and explain useful results clearly.",
    },
  ],
  skill: [
    {
      id: "frontend-design",
      name: "frontend-design",
      content: "# frontend-design\n\nUse for UI layout, visual hierarchy, interaction design, and browser verification.",
    },
  ],
  tool: [
    {
      id: "read_file",
      name: "read_file",
      content: JSON.stringify({ name: "read_file", description: "Read a file from the workspace." }, null, 2),
    },
  ],
  archive: [],
};

export function cloneDefaultResources(): ResourceMap {
  return {
    prompt: defaultResources.prompt.map((resource) => ({ ...resource })),
    skill: defaultResources.skill.map((resource) => ({ ...resource })),
    tool: defaultResources.tool.map((resource) => ({ ...resource })),
    archive: defaultResources.archive.map((resource) => ({ ...resource })),
  };
}

export function createResource(type: WritableResourceType, index: number, timestamp = Date.now()): EditableResource {
  const name = `New ${type} ${index}`;
  return {
    id: `${type}_${timestamp}`,
    name,
    content: defaultResourceContent(type, name),
  };
}

export function toKeyEvent(event: PanelTraceEvent): KeyEvent | null {
  const time = new Date(event.timestamp).toLocaleTimeString();
  if (event.type === "run_started") {
    return { kind: "user", title: "User Input", text: stringValue(event.input), time, raw: event };
  }
  if (event.type === "assistant_message") {
    const text = assistantText(event.message);
    if (!text) return null;
    return { kind: "ai", title: "AI Message", text, time, raw: event };
  }
  if (event.type === "final_answer") {
    return { kind: "ai", title: "Final Answer", text: stringValue(event.text), time, raw: event };
  }
  if (event.type === "tool_started") {
    return {
      kind: "tool",
      title: `Tool Call: ${stringValue(event.toolName)}`,
      text: JSON.stringify(event.input),
      time,
      raw: event,
    };
  }
  if (event.type === "tool_completed") {
    return {
      kind: "tool",
      title: `Tool Result: ${stringValue(event.toolName)}`,
      text: summarizeResult(event.result),
      time,
      raw: event,
    };
  }
  if (event.type === "run_failed" || event.type === "tool_failed") {
    return { kind: "error", title: "Error", text: eventErrorMessage(event), time, raw: event };
  }
  if (event.type === "token_usage") {
    return { kind: "meta", title: "Token Usage", text: `${numberValue(event.totalTokens)} total tokens`, time, raw: event };
  }
  return null;
}

export function aggregateTokenStats(events: PanelTraceEvent[]): TokenStats {
  return events
    .filter((event) => event.type === "token_usage")
    .reduce(
      (acc, event) => ({
        prompt: acc.prompt + numberValue(event.promptTokens),
        completion: acc.completion + numberValue(event.completionTokens),
        total: acc.total + numberValue(event.totalTokens),
      }),
      { prompt: 0, completion: 0, total: 0 },
    );
}

export function subtractTokenStats(stats: TokenStats, baseline: TokenStats): TokenStats {
  return {
    prompt: Math.max(0, stats.prompt - baseline.prompt),
    completion: Math.max(0, stats.completion - baseline.completion),
    total: Math.max(0, stats.total - baseline.total),
  };
}

export function visibleSessions(sessions: PanelSessionSummary[]): PanelSessionSummary[] {
  return sessions.filter((session) => !isEmptyDefaultSession(session));
}

export function isDraftSessionId(sessionId: string | null): boolean {
  return typeof sessionId === "string" && sessionId.startsWith(DRAFT_SESSION_PREFIX);
}

export function shouldSubmitComposerKey(event: ComposerKeyState): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

function isEmptyDefaultSession(session: PanelSessionSummary): boolean {
  return !session.draft && !session.active && session.title === "New conversation" && (session.runCount ?? 0) === 0;
}

function defaultResourceContent(type: WritableResourceType, name: string): string {
  if (type === "prompt") return `You are configuring ${name}.`;
  if (type === "skill") return `# ${name}\n\nDescribe when and how this skill should be used.`;
  return JSON.stringify({ name, description: "Describe this tool." }, null, 2);
}

function assistantText(value: unknown): string {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) return "";
  return value.content
    .filter((part): part is { type: "text"; text: string } => isTextPart(part))
    .map((part) => part.text)
    .join("\n");
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

function summarizeResult(result: unknown): string {
  if (result && typeof result === "object" && "summary" in result) {
    return stringValue(result.summary);
  }
  return typeof result === "string" ? result : JSON.stringify(result);
}

function eventErrorMessage(event: PanelTraceEvent): string {
  const error = event.error;
  if (error && typeof error === "object" && "message" in error) {
    return stringValue(error.message);
  }
  return "Unknown error";
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}
