import type { AssistantMessage, ToolMessage } from "@/foundation";

import type { TraceEventInput } from "./trace";

/** Discriminator values for {@link AgentProgressEvent.subtype}. */
export type AgentProgressSubtype = "thinking" | "tool";

/**
 * Fired once per completed assistant turn and once per completed tool result.
 * `message.streaming` is always absent/false on events of this type.
 */
export interface AgentMessageEvent {
  type: "message";
  message: AssistantMessage | ToolMessage;
}

/**
 * Fired while the current model snapshot has only text and/or thinking
 * content — i.e. no `tool_use` entries yet.
 */
export interface AgentProgressThinkingEvent {
  type: "progress";
  subtype: "thinking";
}

/**
 * Fired while the current model snapshot contains at least one `tool_use`.
 * The payload reflects the **last** `tool_use` in the snapshot; its `input`
 * may be a partial / in-progress JSON value.
 */
export interface AgentProgressToolEvent {
  type: "progress";
  subtype: "tool";
  /** Name of the most recent tool_use in the current snapshot. */
  name: string;
  /** Current (possibly partial) input payload of that tool_use. */
  input: unknown;
}

/** Union of all progress events; narrow on `subtype`. */
export type AgentProgressEvent = AgentProgressThinkingEvent | AgentProgressToolEvent;

/** Agent runtime events emitted directly by the ReAct loop. */
export type AgentRuntimeEvent = TraceEventInput;

/** Discriminator values for {@link AgentEvent.type}. */
export type AgentEventType = AgentMessageEvent["type"] | AgentProgressEvent["type"] | AgentRuntimeEvent["type"];

/** Union of all agent events; narrow on `type`, then on `subtype`. */
export type AgentEvent = AgentMessageEvent | AgentProgressEvent | AgentRuntimeEvent;
