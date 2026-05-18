import type { AssistantMessage, ToolMessage } from "@/foundation";

export type RunStatus = "running" | "completed" | "failed" | "aborted";

export interface TraceEventBase {
  id: string;
  runId: string;
  type: string;
  timestamp: string;
  sequence: number;
}

export interface RunStartedEvent extends TraceEventBase {
  type: "run_started";
  input: string;
  agentName?: string;
  sessionId?: string;
}

export interface RunCompletedEvent extends TraceEventBase {
  type: "run_completed";
  durationMs: number;
}

export interface RunFailedEvent extends TraceEventBase {
  type: "run_failed";
  error: {
    message: string;
    code?: string;
  };
}

export interface RunAbortedEvent extends TraceEventBase {
  type: "run_aborted";
  reason?: string;
}

export interface PromptLoadedEvent extends TraceEventBase {
  type: "prompt_loaded";
  prompt: string;
}

export interface SkillsLoadedEvent extends TraceEventBase {
  type: "skills_loaded";
  skills: Array<{
    name: string;
    description?: string;
    path?: string;
  }>;
}

export interface ToolsRegisteredEvent extends TraceEventBase {
  type: "tools_registered";
  tools: Array<{
    name: string;
    description?: string;
  }>;
}

export interface StepStartedEvent extends TraceEventBase {
  type: "step_started";
  step: number;
}

export interface StepCompletedEvent extends TraceEventBase {
  type: "step_completed";
  step: number;
  durationMs: number;
}

export interface ModelStartedEvent extends TraceEventBase {
  type: "model_started";
  step: number;
  model: string;
}

export interface ModelCompletedEvent extends TraceEventBase {
  type: "model_completed";
  step: number;
  durationMs: number;
}

export interface TokenUsageEvent extends TraceEventBase {
  type: "token_usage";
  step: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AssistantMessageEvent extends TraceEventBase {
  type: "assistant_message";
  step: number;
  message: AssistantMessage;
}

export interface ToolResultMessageEvent extends TraceEventBase {
  type: "tool_result_message";
  step: number;
  message: ToolMessage;
}

export interface FinalAnswerEvent extends TraceEventBase {
  type: "final_answer";
  text: string;
}

export interface ToolStartedEvent extends TraceEventBase {
  type: "tool_started";
  step: number;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolCompletedEvent extends TraceEventBase {
  type: "tool_completed";
  step: number;
  toolCallId: string;
  toolName: string;
  durationMs: number;
  result: unknown;
}

export interface ToolFailedEvent extends TraceEventBase {
  type: "tool_failed";
  step: number;
  toolCallId: string;
  toolName: string;
  durationMs: number;
  error: {
    message: string;
    code?: string;
  };
}

export interface ProgressThinkingTraceEvent extends TraceEventBase {
  type: "progress";
  subtype: "thinking";
}

export interface ProgressToolTraceEvent extends TraceEventBase {
  type: "progress";
  subtype: "tool";
  name: string;
  input: unknown;
}

export type TraceEvent =
  | RunStartedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunAbortedEvent
  | PromptLoadedEvent
  | SkillsLoadedEvent
  | ToolsRegisteredEvent
  | StepStartedEvent
  | StepCompletedEvent
  | ModelStartedEvent
  | ModelCompletedEvent
  | TokenUsageEvent
  | AssistantMessageEvent
  | ToolResultMessageEvent
  | FinalAnswerEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | ProgressThinkingTraceEvent
  | ProgressToolTraceEvent;

type TraceEventMetadataKey = "id" | "runId" | "timestamp" | "sequence";

export type TraceEventInput = TraceEvent extends infer Event
  ? Event extends TraceEvent
    ? Omit<Event, TraceEventMetadataKey>
    : never
  : never;

export interface TraceRunSummary {
  runId: string;
  sessionId?: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  inputPreview?: string;
  durationMs?: number;
  lastEventType: string;
}
