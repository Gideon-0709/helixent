import type { TraceEvent, TraceEventInput, TraceRunSummary } from "./trace-event";

export type TraceSubscriber = (event: TraceEvent) => void;
export type UnsubscribeTrace = () => void;

export interface TraceStore {
  append(runId: string, event: TraceEventInput): TraceEvent;
  clear(): number;
  deleteRun(runId: string): boolean;
  getEvents(runId: string): TraceEvent[];
  listRuns(): TraceRunSummary[];
  subscribe(subscriber: TraceSubscriber): UnsubscribeTrace;
}

interface RunState {
  events: TraceEvent[];
  nextSequence: number;
  updatedOrder: number;
}

export class InMemoryTraceStore implements TraceStore {
  private readonly _runs = new Map<string, RunState>();
  private readonly _subscribers = new Set<TraceSubscriber>();
  private _nextUpdatedOrder = 1;

  append(runId: string, input: TraceEventInput): TraceEvent {
    const state = this._runs.get(runId) ?? { events: [], nextSequence: 1, updatedOrder: 0 };
    this._runs.set(runId, state);

    const event = {
      ...input,
      id: crypto.randomUUID(),
      runId,
      timestamp: new Date().toISOString(),
      sequence: state.nextSequence++,
    } as TraceEvent;

    state.events.push(event);
    state.updatedOrder = this._nextUpdatedOrder++;
    for (const subscriber of this._subscribers) {
      subscriber(event);
    }
    return event;
  }

  deleteRun(runId: string): boolean {
    return this._runs.delete(runId);
  }

  clear(): number {
    const deletedRunCount = this._runs.size;
    this._runs.clear();
    return deletedRunCount;
  }

  getEvents(runId: string): TraceEvent[] {
    return [...(this._runs.get(runId)?.events ?? [])];
  }

  listRuns(): TraceRunSummary[] {
    return [...this._runs.entries()]
      .map(([runId, state]) => ({ summary: summarizeRun(runId, state.events), updatedOrder: state.updatedOrder }))
      .sort((a, b) => b.updatedOrder - a.updatedOrder)
      .map((entry) => entry.summary);
  }

  subscribe(subscriber: TraceSubscriber): UnsubscribeTrace {
    this._subscribers.add(subscriber);
    return () => {
      this._subscribers.delete(subscriber);
    };
  }
}

function summarizeRun(runId: string, events: TraceEvent[]): TraceRunSummary {
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const runStarted = events.find((event) => event.type === "run_started");
  const runCompleted = [...events].reverse().find((event) => event.type === "run_completed");
  const runFailed = [...events].reverse().find((event) => event.type === "run_failed");
  const runAborted = [...events].reverse().find((event) => event.type === "run_aborted");

  return {
    runId,
    sessionId: runStarted && "sessionId" in runStarted ? runStarted.sessionId : undefined,
    status: runFailed ? "failed" : runAborted ? "aborted" : runCompleted ? "completed" : "running",
    startedAt: first.timestamp,
    updatedAt: last.timestamp,
    inputPreview: runStarted && "input" in runStarted ? previewText(runStarted.input) : undefined,
    durationMs: runCompleted && "durationMs" in runCompleted ? runCompleted.durationMs : undefined,
    lastEventType: last.type,
  };
}

function previewText(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
