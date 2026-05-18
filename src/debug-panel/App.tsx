import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type UIEvent,
} from "react";

import {
  aggregateTokenStats,
  AGENT_PROFILES,
  addDraftSession,
  cloneDefaultResources,
  DRAFT_SESSION_PREFIX,
  isDraftSessionId,
  shouldSubmitComposerKey,
  subtractTokenStats,
  toKeyEvent,
  visibleSessions,
  type AgentType,
  type EditableResource,
  type PanelTraceEvent,
  type PanelSessionSummary,
  type ResourceMap,
  type ResourceType,
  type WritableResourceType,
} from "./panel-model";

interface RunSummary {
  runId: string;
  sessionId?: string;
  status: string;
  updatedAt: string;
  inputPreview?: string;
}

interface SelectedResource {
  type: ResourceType;
  id: string;
}

export function App() {
  const [resources, setResources] = useState<ResourceMap>(() => cloneDefaultResources());
  const [savedResources, setSavedResources] = useState<ResourceMap>(() => cloneDefaultResources());
  const [selectedResource, setSelectedResource] = useState<SelectedResource>({ type: "prompt", id: "system" });
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [newType, setNewType] = useState<WritableResourceType>("prompt");
  const [newResourceName, setNewResourceName] = useState("");
  const [sessions, setSessions] = useState<PanelSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [newAgentType, setNewAgentType] = useState<AgentType>("gma");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runSessionIds, setRunSessionIds] = useState<Map<string, string>>(() => new Map());
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [eventsByRun, setEventsByRun] = useState<Map<string, PanelTraceEvent[]>>(() => new Map());
  const [tokenStatsBaseline, setTokenStatsBaseline] = useState({ prompt: 0, completion: 0, total: 0 });
  const [isSavingResource, setIsSavingResource] = useState(false);
  const [isRunningWorkflow, setIsRunningWorkflow] = useState(false);
  const [editorStatus, setEditorStatus] = useState("Loading resources...");
  const [connectionStatus, setConnectionStatus] = useState("Connecting...");

  const selected = useMemo(
    () => resources[selectedResource.type].find((resource) => resource.id === selectedResource.id),
    [resources, selectedResource],
  );
  const savedSelected = useMemo(
    () => savedResources[selectedResource.type].find((resource) => resource.id === selectedResource.id),
    [savedResources, selectedResource],
  );
  const isDirty = selected?.content !== savedSelected?.content;
  const isReadOnlyResource = selectedResource.type === "archive" || selected?.readOnly === true;
  const sessionRuns = selectedSessionId ? runs.filter((run) => runBelongsToSession(run, selectedSessionId, runSessionIds)) : runs;
  const selectableRuns = useMemo(
    () => includeSelectedRun(sessionRuns, runs, selectedRunId),
    [runs, selectedRunId, sessionRuns],
  );
  const visibleSessionList = useMemo(() => visibleSessions(sessions), [sessions]);
  const selectedSession = selectedSessionId ? sessions.find((session) => session.id === selectedSessionId) : undefined;
  const composerAgentName = selectedSession?.title ?? AGENT_PROFILES[newAgentType].name;
  const agentOptions = useMemo(
    () => Object.values(AGENT_PROFILES).map((profile) => ({ value: profile.type, label: profile.name })),
    [],
  );
  const agentSelectWidth = useMemo(() => {
    const maxLabelLength = Math.max(0, ...agentOptions.map((option) => option.label.length));
    return `calc(${maxLabelLength}ch + 58px)`;
  }, [agentOptions]);
  const selectedEvents = selectedRunId
    ? eventsByRun.get(selectedRunId) ?? []
    : collectSessionEvents({ runs: sessionRuns, eventsByRun, runSessionIds, selectedSessionId });
  const keyEvents = selectedEvents.map(toKeyEvent).filter((event) => event !== null);
  const rawTokenStats = aggregateTokenStats([...eventsByRun.values()].flat());
  const tokenStats = subtractTokenStats(rawTokenStats, tokenStatsBaseline);

  useEffect(() => {
    void loadResources();
    void loadSessions();
    void loadRuns();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveSelectedResource();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedResource, resources, savedResources]);

  useEffect(() => {
    for (const run of sessionRuns) {
      if (!eventsByRun.has(run.runId)) {
        void loadRunEvents(run.runId);
      }
    }
  }, [selectedSessionId, runs]);

  useEffect(() => {
    const source = new EventSource("/api/internal/events/live");
    source.onopen = () => setConnectionStatus("Live trace connected");
    source.onerror = () => setConnectionStatus("Live trace reconnecting...");
    source.onmessage = (payload) => {
      const event = JSON.parse(payload.data) as PanelTraceEvent;
      setEventsByRun((current) => appendEvent(current, event));
      if (typeof event.sessionId === "string") {
        setRunSessionIds((current) => new Map(current).set(event.runId, event.sessionId as string));
      }
      void loadRuns();
      void loadSessions();
    };
    return () => source.close();
  }, []);

  async function loadResources({ updateStatus = true }: { updateStatus?: boolean } = {}) {
    const response = await fetch("/api/internal/resources");
    if (!response.ok) {
      if (updateStatus) {
        setEditorStatus("Resource API unavailable");
      }
      return;
    }
    const nextResources = (await response.json()) as ResourceMap;
    setResources(cloneResourceMap(nextResources));
    setSavedResources(cloneResourceMap(nextResources));
    setSelectedResource((current) => {
      if (nextResources[current.type].some((resource) => resource.id === current.id)) return current;
      return { type: "prompt", id: nextResources.prompt[0]?.id ?? "system" };
    });
    if (updateStatus) {
      setEditorStatus("Resources loaded");
    }
  }

  async function refreshArchiveResources() {
    const response = await fetch("/api/internal/resources");
    if (!response.ok) return;
    const nextResources = (await response.json()) as ResourceMap;
    setResources((current) => ({ ...current, archive: nextResources.archive }));
    setSavedResources((current) => ({ ...current, archive: nextResources.archive }));
  }

  async function loadSessions() {
    const response = await fetch("/api/internal/sessions");
    if (!response.ok) return;
    const payload = await response.json();
    const serverSessions = Array.isArray(payload) ? (payload as PanelSessionSummary[]) : [];
    const nextVisibleSessions = visibleSessions(serverSessions);
    setSessions((current) => [...current.filter((session) => session.draft), ...nextVisibleSessions]);
    setSelectedSessionId((current) => {
      if (current && (isDraftSessionId(current) || nextVisibleSessions.some((session) => session.id === current))) {
        return current;
      }
      return nextVisibleSessions[0]?.id ?? null;
    });
  }

  function handleNewSession() {
    const session = createDraftSession(newAgentType);
    setSessions((current) => addDraftSession(current, session));
    setSelectedSessionId(session.id);
    setSelectedRunId(null);
  }

  async function handleDeleteSession(sessionId: string) {
    const deletedSession = sessions.find((session) => session.id === sessionId);
    if (!deletedSession) return;
    if (!deletedSession.draft && !window.confirm(`Delete "${deletedSession.title}" and release its trace events?`)) return;

    if (!deletedSession.draft) {
      const response = await fetch(`/api/internal/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      if (!response.ok) return;
    }

    const deletedRunIds = runs.filter((run) => runBelongsToSession(run, sessionId, runSessionIds)).map((run) => run.runId);
    setSessions((current) => current.filter((session) => session.id !== sessionId));
    setRuns((current) => current.filter((run) => !deletedRunIds.includes(run.runId)));
    setEventsByRun((current) => {
      const next = new Map(current);
      for (const runId of deletedRunIds) {
        next.delete(runId);
      }
      return next;
    });
    setRunSessionIds((current) => {
      const next = new Map(current);
      for (const runId of deletedRunIds) {
        next.delete(runId);
      }
      return next;
    });
    setSelectedRunId(null);
    setSelectedSessionId((current) => {
      if (current !== sessionId) return current;
      const remaining = visibleSessions(sessions.filter((session) => session.id !== sessionId));
      return remaining[0]?.id ?? null;
    });
    await loadSessions();
    await loadRuns();
  }

  async function handleArchiveSession(sessionId: string) {
    const archivedSession = sessions.find((session) => session.id === sessionId);
    if (!archivedSession || archivedSession.draft) return;
    const response = await fetch(`/api/internal/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "POST" });
    if (!response.ok) {
      setEditorStatus("Archive failed");
      return;
    }
    await response.json();
    await refreshArchiveResources();
  }

  async function handleClearAgents() {
    if (runs.length === 0 && visibleSessionList.length === 0) return;
    if (!window.confirm("Clear all agents, runs, and trace events from memory?")) return;

    const response = await fetch("/api/internal/sessions", { method: "DELETE" });
    if (!response.ok) return;

    setSessions([]);
    setRuns([]);
    setRunSessionIds(new Map());
    setEventsByRun(new Map());
    setTokenStatsBaseline({ prompt: 0, completion: 0, total: 0 });
    setSelectedSessionId(null);
    setSelectedRunId(null);
    await loadSessions();
    await loadRuns();
  }

  function handleClearTokenStats() {
    if (tokenStats.total === 0) return;
    setTokenStatsBaseline(rawTokenStats);
  }

  async function loadRuns() {
    const response = await fetch("/api/internal/runs");
    const nextRuns = (await response.json()) as RunSummary[];
    setRuns(nextRuns);
    setRunSessionIds((current) => mergeRunSessionIds(current, nextRuns));
  }

  async function loadRunEvents(runId: string): Promise<PanelTraceEvent[]> {
    const response = await fetch(`/api/internal/runs/${encodeURIComponent(runId)}/events`);
    if (!response.ok) return [];
    const events = (await response.json()) as PanelTraceEvent[];
    const sessionEvent = events.find((event) => typeof event.sessionId === "string");
    if (sessionEvent && typeof sessionEvent.sessionId === "string") {
      setRunSessionIds((current) => new Map(current).set(runId, sessionEvent.sessionId as string));
    }
    setEventsByRun((current) => new Map(current).set(runId, events));
    return events;
  }

  async function startRun(message: string) {
    const trimmed = message.trim();
    if (!trimmed) return;
    const selectedSession = selectedSessionId ? sessions.find((session) => session.id === selectedSessionId) : undefined;
    const sessionId = selectedSessionId && !isDraftSessionId(selectedSessionId) ? selectedSessionId : undefined;
    const agentType = selectedSession?.agentType ?? newAgentType;
    const response = await fetch("/api/agent/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentType, message: trimmed, sessionId }),
    });
    const payload = (await response.json()) as { runId: string; sessionId: string };
    setSelectedRunId(null);
    setSelectedSessionId(payload.sessionId);
    if (isDraftSessionId(selectedSessionId)) {
      setSessions((current) => current.filter((session) => session.id !== selectedSessionId));
    }
    setRunSessionIds((current) => new Map(current).set(payload.runId, payload.sessionId));
    setEventsByRun((current) => new Map(current).set(payload.runId, []));
    await loadSessions();
    await loadRuns();
    await loadRunEvents(payload.runId);
  }

  async function runSelectedWorkflow() {
    if (selectedResource.type !== "workflow" || !selected || isDirty || isRunningWorkflow) return;
    if (!selectedSession) {
      recordWorkflowStartFailure("Select an agent before running workflow");
      return;
    }
    setIsRunningWorkflow(true);
    setEditorStatus("Starting workflow...");
    try {
      let workflowSession = selectedSession;
      if (isDraftSessionId(workflowSession.id)) {
        const serverSession = await createServerSession(workflowSession);
        if (!serverSession) {
          recordWorkflowStartFailure("Failed to create agent session");
          return;
        }
        workflowSession = serverSession;
      }

      let { response, payload } = await startWorkflowRequest(workflowSession);
      if (!response.ok && payload.error === "session not found") {
        const serverSession = await createServerSession(workflowSession);
        if (!serverSession) {
          recordWorkflowStartFailure("Failed to recreate agent session");
          return;
        }
        workflowSession = serverSession;
        ({ response, payload } = await startWorkflowRequest(workflowSession));
      }

      if (!response.ok || !payload.workflowRunId) {
        recordWorkflowStartFailure(payload.error ?? "Workflow failed to start");
        return;
      }
      setSelectedRunId(payload.workflowRunId);
      setEventsByRun((current) => {
        if (current.has(payload.workflowRunId!)) return current;
        return new Map(current).set(payload.workflowRunId!, []);
      });
      setRunSessionIds((current) => new Map(current).set(payload.workflowRunId!, workflowSession.id));
      setEditorStatus(`Workflow queued: ${payload.workflowRunId}`);
      await loadRuns();
      const events = await loadRunEvents(payload.workflowRunId);
      setEditorStatus(workflowStatusText(payload.workflowRunId, events));
    } catch (error) {
      recordWorkflowStartFailure(error instanceof Error ? error.message : "Workflow failed to start");
    } finally {
      setIsRunningWorkflow(false);
    }
  }

  async function startWorkflowRequest(session: PanelSessionSummary) {
    const response = await fetch("/api/workflows/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentType: session.agentType,
        sessionId: session.id,
        workflowId: selected?.id,
      }),
    });
    const payload = (await response.json()) as { error?: string; workflowRunId?: string };
    return { response, payload };
  }

  async function createServerSession(session: PanelSessionSummary): Promise<PanelSessionSummary | null> {
    const response = await fetch("/api/internal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentType: session.agentType,
        title: session.title,
      }),
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as { sessionId: string; session?: PanelSessionSummary };
    const now = new Date().toISOString();
    const serverSession: PanelSessionSummary = payload.session ?? {
      ...session,
      id: payload.sessionId,
      createdAt: now,
      updatedAt: now,
      active: false,
      draft: false,
      runCount: 0,
    };
    setSessions((current) => [serverSession, ...current.filter((item) => item.id !== session.id && item.id !== serverSession.id)]);
    setSelectedSessionId(serverSession.id);
    return serverSession;
  }

  function recordWorkflowStartFailure(message: string) {
    const runId = `workflow_run_local_${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    const event: PanelTraceEvent = {
      id: crypto.randomUUID(),
      runId,
      type: "workflow_failed",
      timestamp,
      sequence: 1,
      workflowId: selectedResource.type === "workflow" ? selectedResource.id : "unknown",
      workflowName: selected?.name ?? "Unknown Workflow",
      durationMs: 0,
      error: { message },
    };
    setSelectedRunId(runId);
    if (selectedSessionId) {
      setRunSessionIds((current) => new Map(current).set(runId, selectedSessionId));
    }
    setRuns((current) => [
      {
        runId,
        status: "failed",
        updatedAt: timestamp,
        inputPreview: selected?.name ?? "Workflow start",
      },
      ...current,
    ]);
    setEventsByRun((current) => new Map(current).set(runId, [event]));
    setEditorStatus(`Workflow failed to start: ${message}`);
  }

  function updateSelectedResourceContent(content: string) {
    if (isReadOnlyResource) return;
    setResources((current) => ({
      ...current,
      [selectedResource.type]: current[selectedResource.type].map((resource) =>
        resource.id === selectedResource.id ? { ...resource, content } : resource,
      ),
    }));
  }

  function handleResourceSelect(type: ResourceType, id: string) {
    setSelectedResource({ type, id });
    if (type === "archive") {
      setNewMenuOpen(false);
    }
  }

  async function handleCreateResource() {
    const name = newResourceName.trim() || `New ${newType} ${resources[newType].length + 1}`;
    const response = await fetch("/api/internal/resources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: newType, name }),
    });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setEditorStatus(payload.error ?? "Create failed");
      return;
    }
    const nextResource = (await response.json()) as EditableResource;
    setResources((current) => appendResource(current, nextResource));
    setSavedResources((current) => appendResource(current, nextResource));
    setSelectedResource({ type: newType, id: nextResource.id });
    setNewResourceName("");
    setNewMenuOpen(false);
    setEditorStatus(`Created ${nextResource.name}`);
  }

  async function handleDeleteSelectedResource() {
    if (!selected) return;
    if (!window.confirm(`Delete "${selected.name}"?`)) return;
    const { type, id } = selectedResource;
    const currentIndex = resources[type].findIndex((resource) => resource.id === id);
    const response = await fetch(`/api/internal/resources/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setEditorStatus(payload.error ?? "Delete failed");
      return;
    }
    const nextResources = removeResource(resources, type, id);
    setResources(nextResources);
    setSavedResources(removeResource(savedResources, type, id));
    const sameTypeResources = nextResources[type];
    const nextSameType = sameTypeResources[Math.min(currentIndex, Math.max(sameTypeResources.length - 1, 0))];
    if (nextSameType) {
      setSelectedResource({ type, id: nextSameType.id });
      return;
    }
    setSelectedResource({ type: "prompt", id: nextResources.prompt[0]?.id ?? "system" });
  }

  async function saveSelectedResource() {
    if (!selected || !isDirty || isReadOnlyResource || isSavingResource) return;
    setIsSavingResource(true);
    try {
      const response = await fetch(
        `/api/internal/resources/${encodeURIComponent(selectedResource.type)}/${encodeURIComponent(selectedResource.id)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: selected.content }),
        },
      );
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        setEditorStatus(payload.error ?? "Save failed");
        return;
      }
      const saved = (await response.json()) as EditableResource;
      setResources((current) => replaceResource(current, selectedResource.type, saved));
      setSavedResources((current) => replaceResource(current, selectedResource.type, saved));
      setEditorStatus(`Saved ${saved.name}`);
    } finally {
      setIsSavingResource(false);
    }
  }

  function revertSelectedResource() {
    if (!savedSelected) return;
    setResources((current) => replaceResource(current, selectedResource.type, savedSelected));
    setEditorStatus(`Reverted ${savedSelected.name}`);
  }

  function handleRunSelect(runId: string) {
    if (runId === "__session__") {
      setSelectedRunId(null);
      return;
    }
    setSelectedRunId(runId);
    if (!eventsByRun.has(runId)) {
      void loadRunEvents(runId);
    }
  }

  function handleSessionSelect(sessionId: string) {
    setSelectedSessionId(sessionId);
    setSelectedRunId(null);
    for (const run of runs.filter((item) => runBelongsToSession(item, sessionId, runSessionIds))) {
      if (!eventsByRun.has(run.runId)) {
        void loadRunEvents(run.runId);
      }
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <h1>Helixent Debug Panel</h1>
          <span>{connectionStatus}</span>
        </div>
      </header>

      <div className="layout">
        <aside className="stats" data-panel-section="stats">
          <div className="conversations">
            <div className="conversation-header">
              <h2>Agents</h2>
              <div className="conversation-actions">
                <CustomSelect
                  ariaLabel="New agent type"
                  value={newAgentType}
                  options={agentOptions}
                  onChange={(value) => setNewAgentType(value as AgentType)}
                  style={{ width: agentSelectWidth }}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Clear agents"
                  title="Clear agents"
                  disabled={runs.length === 0 && visibleSessionList.length === 0}
                  onClick={() => void handleClearAgents()}
                >
                  <SweepIcon />
                </button>
                <button type="button" className="icon-button" aria-label="New agent" title="New agent" onClick={handleNewSession}>
                  <PlusIcon />
                </button>
              </div>
            </div>
            <div className="conversation-list">
              {visibleSessionList.length === 0 ? <div className="conversation-empty">No agents yet.</div> : null}
              {visibleSessionList.map((session) => (
                <div
                  key={session.id}
                  className={`conversation-item ${session.id === selectedSessionId ? "selected" : ""}`}
                >
                  <button type="button" className="conversation-select" onClick={() => handleSessionSelect(session.id)}>
                    <span>{session.title}</span>
                    <small>{session.active ? "active context" : "fresh context"}</small>
                  </button>
                  <button
                    type="button"
                    className="conversation-archive"
                    aria-label={`Archive ${session.title}`}
                    title={`Archive ${session.title}`}
                    disabled={session.draft}
                    onClick={() => void handleArchiveSession(session.id)}
                  >
                    <ArchiveIcon />
                  </button>
                  <button type="button" className="conversation-delete" aria-label={`Delete ${session.title}`} onClick={() => void handleDeleteSession(session.id)}>
                    <TrashIcon />
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="stats-section">
            <PanelHeader
              title="Stats"
              action={
                <button
                  type="button"
                  className="icon-button panel-icon"
                  aria-label="Clear token stats"
                  title="Clear token stats"
                  disabled={tokenStats.total === 0}
                  onClick={handleClearTokenStats}
                >
                  <RefreshIcon />
                </button>
              }
            />
            <div className="stats-body">
              <StatCard label="Total Tokens" value={tokenStats.total} />
              <StatCard label="Prompt Tokens" value={tokenStats.prompt} />
              <StatCard label="Completion Tokens" value={tokenStats.completion} />
              <StatCard label="Runs" value={runs.length} />
            </div>
          </div>
        </aside>

        <main className="workspace" data-panel-section="workspace">
          <section className="editor-wrap">
            <div className={`editor-panel ${isDirty ? "dirty" : ""}`}>
              <div className="editor-meta">
                <div>
                  <div className={`editor-name ${isDirty ? "dirty" : ""}`}>
                    {selected?.name ?? "No resource selected"}
                    {isDirty ? <span className="dirty-dot" aria-label="Unsaved changes" title="Unsaved changes" /> : null}
                  </div>
                  <div className="editor-kind">
                    {capitalize(selectedResource.type)}
                    {selected?.language ? ` · ${selected.language}` : ""}
                    {selected?.readOnly ? " · read-only" : selected?.active === false ? " · draft" : " · active"}
                  </div>
                </div>
                <div className="editor-actions">
                  <button
                    type="button"
                    className="icon-button editor-action-button"
                    aria-label="Run workflow"
                    title={
                      selectedResource.type === "workflow"
                        ? isDirty
                          ? "Save workflow before running"
                          : "Run workflow"
                        : "Run workflow is only available for workflow files"
                    }
                    disabled={selectedResource.type !== "workflow" || !selected || isDirty || isRunningWorkflow}
                    onClick={() => void runSelectedWorkflow()}
                  >
                    <PlayIcon />
                  </button>
                  <button
                    type="button"
                    className="icon-button editor-action-button"
                    aria-label="Revert resource"
                    title="Revert resource"
                    disabled={!isDirty || isReadOnlyResource}
                    onClick={revertSelectedResource}
                  >
                    <UndoIcon />
                  </button>
                  <button
                    type="button"
                    className="primary icon-button editor-action-button"
                    aria-label={isSavingResource ? "Saving resource" : "Save resource"}
                    title={isSavingResource ? "Saving resource" : "Save resource"}
                    disabled={!isDirty || isReadOnlyResource || isSavingResource}
                    onClick={() => void saveSelectedResource()}
                  >
                    <SaveIcon />
                  </button>
                </div>
              </div>
              <div className="editor-resource-bar">
                <div className="resource-tabs" aria-label="Resource type">
                  {(["prompt", "skill", "tool", "workflow", "archive"] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      className={selectedResource.type === type ? "selected" : ""}
                      onClick={() => handleResourceSelect(type, resources[type][0]?.id ?? "")}
                    >
                      {capitalize(type)}
                    </button>
                  ))}
                </div>
                <div className="resource-picker">
                  <span>File</span>
                  <CustomSelect
                    ariaLabel="File"
                    value={selectedResource.id}
                    className="resource-select"
                    options={resources[selectedResource.type].map((resource) => ({ value: resource.id, label: resource.name }))}
                    onChange={(value) => handleResourceSelect(selectedResource.type, value)}
                  />
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="New resource"
                  title="New resource"
                  disabled={selectedResource.type === "archive"}
                  onClick={() => setNewMenuOpen((open) => !open)}
                >
                  <PlusIcon />
                </button>
                <button
                  type="button"
                  className="icon-button resource-delete"
                  aria-label={selected ? `Delete ${selected.name}` : "Delete resource"}
                  title={selected ? `Delete ${selected.name}` : "Delete resource"}
                  disabled={!selected}
                  onClick={() => void handleDeleteSelectedResource()}
                >
                  <TrashIcon />
                </button>
                {newMenuOpen && selectedResource.type !== "archive" ? (
                  <div className="new-menu">
                    <CustomSelect
                      ariaLabel="New resource type"
                      value={newType}
                      options={[
                        { value: "prompt", label: "Prompt" },
                        { value: "skill", label: "Skill" },
                        { value: "tool", label: "Tool" },
                        { value: "workflow", label: "Workflow" },
                      ]}
                      onChange={(value) => setNewType(value as WritableResourceType)}
                    />
                    <input
                      className="new-resource-name"
                      value={newResourceName}
                      placeholder="Name"
                      onChange={(event) => setNewResourceName(event.target.value)}
                    />
                    <button type="button" onClick={() => void handleCreateResource()}>
                      Create
                    </button>
                  </div>
                ) : null}
              </div>
              <CodeEditor value={selected?.content ?? ""} readOnly={isReadOnlyResource} onChange={updateSelectedResourceContent} />
              <div className="editor-status">
                <span>{selected?.path ?? "No file"}</span>
                <span>
                  {lineCount(selected?.content ?? "")} lines · {(selected?.content ?? "").length} chars · {editorStatus}
                </span>
              </div>
            </div>
          </section>
          <AgentComposer agentName={composerAgentName} selectedRunId={selectedRunId} selectedSessionId={selectedSessionId} onSubmit={startRun} />
        </main>

        <aside className="events" data-panel-section="events">
          <PanelHeader title="Agent Events" />
          <div className="run-filter">
            <CustomSelect
              ariaLabel="Run filter"
              value={selectedRunId ?? "__session__"}
              options={[
                { value: "__session__", label: "Whole agent context" },
                ...selectableRuns.map((run) => ({ value: run.runId, label: `${run.status} · ${run.inputPreview ?? run.runId}` })),
              ]}
              onChange={handleRunSelect}
            />
          </div>
          <div className="events-list">
            {keyEvents.length === 0 ? (
              <div className="empty">Run the agent to see key events.</div>
            ) : (
              keyEvents.map((event) => <EventCard key={`${event.raw.id}-${event.raw.sequence}`} event={event} />)
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function AgentComposer({
  agentName,
  selectedRunId,
  selectedSessionId,
  onSubmit,
}: {
  agentName: string;
  selectedRunId: string | null;
  selectedSessionId: string | null;
  onSubmit: (message: string) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  async function handleSubmit() {
    const trimmed = message.trim();
    if (!trimmed || isRunning) return;
    setIsRunning(true);
    try {
      await onSubmit(trimmed);
      setMessage("");
    } finally {
      setIsRunning(false);
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (!shouldSubmitComposerKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })) return;
    event.preventDefault();
    void handleSubmit();
  }

  return (
    <section className="composer">
      <div className="composer-label">
        <span>Agent Input</span>
      </div>
      <div className="composer-box">
        <textarea
          id="promptInput"
          placeholder={`Ask ${agentName} something...`}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="composer-footer">
          <span>{selectedRunId ?? selectedSessionId ?? "No active agent"}</span>
          <button
            type="button"
            className="primary icon-button composer-send"
            aria-label={isRunning ? "Sending message" : "Send message"}
            title={isRunning ? "Sending message" : "Send message"}
            disabled={isRunning || !message.trim()}
            onClick={() => void handleSubmit()}
          >
            <UpArrowIcon />
          </button>
        </div>
      </div>
    </section>
  );
}

function CustomSelect({
  ariaLabel,
  value,
  options,
  onChange,
  className,
  style,
}: {
  ariaLabel: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen((current) => !current);
    }
  }

  return (
    <div ref={ref} className={`custom-select ${className ?? ""} ${open ? "open" : ""}`} style={style}>
      <button
        type="button"
        className="custom-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        <span>{selectedOption?.label ?? "Select"}</span>
        <ChevronDownIcon />
      </button>
      {open ? (
        <div className="custom-select-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? "selected" : ""}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PanelHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="panel-header">
      <h2>{title}</h2>
      {action}
    </div>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function SweepIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.5 2.5 13.5 5.5" />
      <path d="M4 12 11.5 4.5" />
      <path d="M2.5 12.5h7" />
      <path d="M3.5 10.5h5" />
      <path d="M5.5 8.5h2.5" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M12.8 6.2A5 5 0 0 0 4.1 4.1L2.8 5.4" />
      <path d="M2.8 2.2v3.2H6" />
      <path d="M3.2 9.8a5 5 0 0 0 8.7 2.1l1.3-1.3" />
      <path d="M13.2 13.8v-3.2H10" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 6.25 8 9.75l3.5-3.5" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 4 3 7l3 3" />
      <path d="M3.5 7H10a3 3 0 1 1 0 6H8" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 2.5h8.5L13 4v9.5H3z" />
      <path d="M5 2.5v4h5v-4" />
      <path d="M5 13.5V10h6v3.5" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 3.5v9l7-4.5z" />
    </svg>
  );
}

function UpArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.5h10" />
      <path d="M6.5 4.5V3h3v1.5" />
      <path d="M5 6.5v6" />
      <path d="M8 6.5v6" />
      <path d="M11 6.5v6" />
      <path d="M4.5 4.5 5 14h6l.5-9.5" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.5h10v9H3z" />
      <path d="M4 2.5h8l1 2H3z" />
      <path d="M6 7h4" />
      <path d="M8 7v4" />
    </svg>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function EventCard({ event }: { event: NonNullable<ReturnType<typeof toKeyEvent>> }) {
  return (
    <details className={`event-card ${event.kind}`}>
      <summary>
        <strong>{event.title}</strong>
        <time>{event.time}</time>
      </summary>
      <pre>{JSON.stringify(event.raw, null, 2)}</pre>
    </details>
  );
}

function CodeEditor({ value, readOnly, onChange }: { value: string; readOnly?: boolean; onChange: (value: string) => void }) {
  const lineNumberRef = useRef<HTMLPreElement | null>(null);
  const numbers = useMemo(
    () =>
      Array.from({ length: Math.max(1, lineCount(value)) }, (_, index) => String(index + 1))
        .join("\n")
        .concat("\n"),
    [value],
  );

  function handleScroll(event: UIEvent<HTMLTextAreaElement>) {
    if (lineNumberRef.current) {
      lineNumberRef.current.scrollTop = event.currentTarget.scrollTop;
    }
  }

  return (
    <div className="code-editor">
      <pre ref={lineNumberRef} className="line-numbers" aria-hidden="true">
        {numbers}
      </pre>
      <textarea
        id="resourceEditor"
        readOnly={readOnly}
        wrap="off"
        spellCheck={false}
        value={value}
        onScroll={handleScroll}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function appendEvent(current: Map<string, PanelTraceEvent[]>, event: PanelTraceEvent): Map<string, PanelTraceEvent[]> {
  const next = new Map(current);
  const events = next.get(event.runId) ?? [];
  if (!events.some((item) => item.id === event.id)) {
    next.set(event.runId, [...events, event]);
  }
  return next;
}

function capitalize(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}

function lineCount(value: string): number {
  return value.split("\n").length;
}

function cloneResourceMap(resources: ResourceMap): ResourceMap {
  return {
    prompt: resources.prompt.map((resource) => ({ ...resource })),
    skill: resources.skill.map((resource) => ({ ...resource })),
    tool: resources.tool.map((resource) => ({ ...resource })),
    workflow: resources.workflow.map((resource) => ({ ...resource })),
    archive: resources.archive.map((resource) => ({ ...resource })),
  };
}

function appendResource(resources: ResourceMap, resource: EditableResource): ResourceMap {
  const type = resource.type;
  if (!type) return resources;
  return {
    ...resources,
    [type]: [...resources[type], resource],
  };
}

function replaceResource(resources: ResourceMap, type: ResourceType, resource: EditableResource): ResourceMap {
  return {
    ...resources,
    [type]: resources[type].map((current) => (current.id === resource.id ? resource : current)),
  };
}

function removeResource(resources: ResourceMap, type: ResourceType, id: string): ResourceMap {
  return {
    ...resources,
    [type]: resources[type].filter((resource) => resource.id !== id),
  };
}

function collectSessionEvents({
  runs,
  eventsByRun,
  runSessionIds,
  selectedSessionId,
}: {
  runs: RunSummary[];
  eventsByRun: Map<string, PanelTraceEvent[]>;
  runSessionIds: Map<string, string>;
  selectedSessionId: string | null;
}): PanelTraceEvent[] {
  const sortedRunIds = new Set([...runs].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).map((run) => run.runId));
  const pendingRunIds = [...eventsByRun.keys()].filter((runId) => {
    if (sortedRunIds.has(runId)) return false;
    return !selectedSessionId || runSessionIds.get(runId) === selectedSessionId;
  });
  return [...sortedRunIds, ...pendingRunIds].flatMap((runId) => eventsByRun.get(runId) ?? []);
}

function runBelongsToSession(run: RunSummary, sessionId: string, runSessionIds: Map<string, string>): boolean {
  return run.sessionId === sessionId || runSessionIds.get(run.runId) === sessionId;
}

function includeSelectedRun(sessionRuns: RunSummary[], runs: RunSummary[], selectedRunId: string | null): RunSummary[] {
  if (!selectedRunId || sessionRuns.some((run) => run.runId === selectedRunId)) {
    return sessionRuns;
  }
  const selectedRun = runs.find((run) => run.runId === selectedRunId);
  return selectedRun ? [selectedRun, ...sessionRuns] : sessionRuns;
}

function workflowStatusText(runId: string, events: PanelTraceEvent[]): string {
  const failed = [...events].reverse().find((event) => event.type === "workflow_failed" || event.type === "workflow_step_failed");
  if (failed) {
    return `Workflow failed: ${panelEventErrorMessage(failed)}`;
  }

  const completed = [...events].reverse().find((event) => event.type === "workflow_completed");
  if (completed) {
    return `Workflow completed: ${runId}`;
  }

  return `Workflow running: ${runId}`;
}

function panelEventErrorMessage(event: PanelTraceEvent): string {
  const error = event.error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "Unknown error";
}

function mergeRunSessionIds(current: Map<string, string>, runs: RunSummary[]): Map<string, string> {
  const next = new Map(current);
  for (const run of runs) {
    if (run.sessionId) {
      next.set(run.runId, run.sessionId);
    }
  }
  return next;
}

function createDraftSession(agentType: AgentType): PanelSessionSummary {
  const now = new Date().toISOString();
  return {
    id: `${DRAFT_SESSION_PREFIX}${crypto.randomUUID()}`,
    title: AGENT_PROFILES[agentType].name,
    agentType,
    createdAt: now,
    updatedAt: now,
    active: false,
    runCount: 0,
    draft: true,
  };
}
