# Database Agent Web Integration Discussion

Date: 2026-05-17

This document records the current discussion about extending Helixent into a web-based database analysis agent. It summarizes the product requirements, architectural decisions, feasibility analysis, and the smallest practical set of changes needed on top of the current repository.

## 1. Current Repository Context

Helixent is a Bun and TypeScript project for building agentic coding workflows. Its current structure already contains several reusable layers:

- `src/foundation`: model, message, and tool abstractions.
- `src/agent`: a reusable ReAct-style agent loop.
- `src/agent/skills`: skill discovery and prompt injection middleware.
- `src/coding`: a coding agent assembled from the generic agent loop and coding tools.
- `src/community`: model provider adapters, currently including OpenAI-compatible and Anthropic providers.
- `src/cli`: terminal CLI and Ink TUI.

The current CLI should not be treated as the integration point for the web product. The better path is to reuse the underlying agent runtime and build a new web/server integration beside the existing CLI.

## 2. Product Goal

The goal is to build a database-oriented AI agent for a web dashboard.

The dashboard is expected to be a database observability or analytics interface. Its distinguishing feature is an integrated AI agent that can inspect and analyze database data for the user.

For the first version, the agent should only support querying and analysis. It should not modify data.

The agent should eventually support:

- Reading database schema.
- Running safe read-only queries.
- Explaining query results.
- Producing analytical conclusions for dashboard users.
- Using prompt engineering and skills as the main behavior-tuning surface.
- Exposing an observability/debug interface during development.

## 3. Initial Feasibility Conclusion

The project is a suitable base for this work.

The recommended direction is not to "connect the CLI to the web." Instead, the web product should reuse the core Helixent runtime:

- `Agent`
- `Model`
- `ModelProvider`
- `Tool`
- skill middleware
- token usage reporting
- streaming agent events

The existing coding agent should remain mostly unchanged. A new database agent should be added next to it.

## 4. Recommended High-Level Architecture

The recommended MVP architecture is:

```text
Next.js Dashboard Web
   |
   | HTTP / SSE
   v
Agent Server
   |
   v
Database Agent based on Helixent
   |
   v
Read-only Database Tools
   |
   v
Database
```

The browser should not run the agent directly. The browser should only collect user input and render output. The agent should run on the server side, where model API keys, database credentials, prompt files, skills, permissions, and logs can be protected.

If a single hosted server is used, both the Next.js application and the agent backend can run on that server. The important distinction is between browser-side code and server-side code, not whether the user reaches the system through a web URL.

## 5. Next.js Integration

Next.js can be used as the dashboard and web UI layer.

For MVP, Next.js can expose a single core interface:

```text
POST /api/agent
```

or, if using a separate agent server:

```text
POST /agent/runs
```

The endpoint receives user input, calls the server-side agent, and streams back output and trace events.

The first version can use Server-Sent Events. SSE is simpler than WebSocket and is enough for one-way streaming from the agent to the UI.

Example event stream shape:

```json
{ "type": "run_started", "runId": "run_123" }
{ "type": "tool_started", "toolName": "describe_table", "input": { "table": "orders" } }
{ "type": "tool_completed", "toolName": "describe_table", "durationMs": 120 }
{ "type": "tool_started", "toolName": "query_database", "input": { "sql": "select ..." } }
{ "type": "token_usage", "promptTokens": 1800, "completionTokens": 600, "totalTokens": 2400 }
{ "type": "final_answer", "text": "..." }
{ "type": "run_completed" }
```

For a two-person team, the clean split is:

- Frontend developer: Next.js dashboard, chat UI, trace viewer, prompt and skill editing UI.
- Agent/backend developer: Helixent extension, database tools, prompt and skill behavior, safety checks, trace events, and database access.

## 6. Dashboard and Debug Panel Separation

The dashboard and debug panel can be completely separated during development.

Recommended local ports:

```text
http://localhost:3000  -> dashboard web
http://localhost:3001  -> debug web
http://localhost:4000  -> agent server
```

Recommended logical structure:

```text
apps/
├─ dashboard-web/
├─ debug-web/
└─ agent-server/
```

Both web applications call the same agent server.

```text
Dashboard Web  ─┐
                 ├─> Agent Server -> Database Agent
Debug Web      ─┘
```

The dashboard should not be responsible for debug trace rendering. The debug web app should subscribe to agent events separately.

## 7. How the Debug Panel Works

The debug panel is a React or Next.js web application that consumes agent trace events.

It does not need the agent to be embedded in the page. Instead, it listens to the agent server:

```text
Debug Web
   |
   | GET /agent/events/live
   v
Agent Server
```

or for a specific run:

```text
GET /agent/runs/:runId/events
```

The debug panel should display:

- Run ID.
- User input.
- Current agent state.
- Loaded prompt.
- Loaded skills.
- Model calls.
- Tool calls.
- SQL queries.
- Query duration.
- Query result summaries.
- Token usage.
- Errors.
- Final answer.

In MVP, the debug panel can show the latest run. Later it can support historical run browsing and replay.

## 8. Agent Lifetime and Persistence

The agent does not have to be a permanently running in-memory process to support the debug panel.

There are two valid patterns:

### Pattern A: Temporary Agent Per Run

```text
User message
  -> create agent
  -> load prompt, skills, and context
  -> run agent
  -> save messages and trace events
  -> destroy agent instance
```

This is simpler, easier to scale, and safer for production.

### Pattern B: Long-Lived Agent Session

```text
Agent server starts
  -> create agent session
  -> wait for messages
  -> preserve in-memory messages
  -> continue conversation
```

This feels closer to CLI behavior and is convenient during debugging, but it introduces session management, restart recovery, and scaling concerns.

### Recommended Compromise

The recommended approach is:

- Agent instances may be temporary.
- Sessions, messages, runs, trace events, prompt versions, skill versions, tool calls, and token usage should be persistable.
- Active agent sessions can be cached in memory.
- If the service restarts, the agent can be reconstructed from persisted messages and configuration.

For the debug panel, the important part is not the lifetime of the agent object. The important part is that trace events are stored and streamed.

## 9. Trace Store

The trace store is the source of truth for the debug panel.

For the first version, an in-memory store is acceptable:

```text
runId -> events[]
```

This supports:

- A debug panel that stays open.
- Live display of new runs.
- Viewing completed runs until the process restarts.

For a more reliable version, trace data should be persisted in a database:

```text
agent_runs
agent_events
```

This enables:

- Refreshing the debug panel without losing history.
- Service restart recovery.
- Historical run replay.
- Comparing prompt and skill versions.
- Auditing SQL queries and model behavior.

## 10. Database Tooling

The database agent should not reuse coding tools such as `bash`, `write_file`, or `apply_patch`.

Instead, it should define read-only database tools:

- `list_tables`
- `describe_table`
- `query_database`

These are enough to support the first loop:

```text
understand schema -> generate SQL -> execute read-only query -> analyze results
```

Future tools may include:

- `list_metrics`
- `describe_metric`
- `query_metric`
- `explain_query`
- `sample_rows`
- `get_dashboard_context`
- `summarize_result`

## 11. Database Safety Requirements

The first version should be read-only.

Minimum safety requirements:

- Use a read-only database account.
- Prefer a read replica over the production primary database.
- Reject non-read SQL statements.
- Reject DDL and mutation statements.
- Set query timeout.
- Set maximum returned rows.
- Add default `LIMIT` when appropriate.
- Log SQL, duration, row count, user/session/run ID, and tool call ID.
- Mask sensitive fields when required.
- Enforce user-level data permissions server-side.

The largest product risk is not whether the web app can call the agent. The largest risks are database safety, semantic accuracy, and permission control.

## 12. Prompt and Skill Editing

Prompt engineering and skills are expected to be the main development focus.

Recommended staged approach:

### Stage 1

- Prompts live in files or simple server-side configuration.
- Skills remain `SKILL.md` files.
- Debug panel can view prompt and skill content.
- Editing can be basic or local-file based.

### Stage 2

- Prompt and skill content can be edited from the debug web app.
- Each save creates a version.
- Each agent run records the prompt and skill version it used.

### Stage 3

- Add rollback.
- Add A/B testing.
- Add evaluation datasets.
- Add historical comparison across runs.

## 13. Minimum Changes Needed in This Repository

The smallest practical change set on top of the current Helixent repository is:

### 13.1 Keep Existing Core and CLI

Do not rewrite the current CLI.

Keep using:

- `src/foundation`
- `src/agent`
- `src/agent/skills`
- `src/community/openai`
- `src/community/anthropic`

Leave `src/cli` and `src/coding` mostly untouched.

### 13.2 Add a Database Agent

Add a new area:

```text
src/database/
├─ agents/database-agent.ts
├─ tools/list-tables.ts
├─ tools/describe-table.ts
├─ tools/query-database.ts
├─ tools/sql-safety.ts
└─ index.ts
```

This should expose:

```ts
createDatabaseAgent()
```

It should be structurally similar to `createCodingAgent()`, but with database tools and a database-specific system prompt.

### 13.3 Add an Agent Server

Add a lightweight server layer:

```text
src/server/
├─ index.ts
├─ routes/agent-runs.ts
├─ trace-store.ts
└─ sse.ts
```

Minimum endpoints:

```text
POST /agent/runs
GET /agent/runs/:runId/events
GET /agent/events/live
```

### 13.4 Extend Agent Events

Current agent streaming already emits messages and progress events. The debug panel needs more explicit events.

Minimum event additions:

- `run_started`
- `tool_started`
- `tool_completed`
- `tool_failed`
- `token_usage`
- `run_completed`

Likely files:

```text
src/agent/agent-event.ts
src/agent/agent.ts
```

The smallest implementation is to yield events before and after tool invocation inside the agent loop.

### 13.5 Add a Trace Store

Add an in-memory trace store first.

It should:

- Append events by `runId`.
- Support live subscribers.
- Support reading events for a specific run.
- Later be replaceable with a database-backed implementation.

## 14. What Should Not Be Done in MVP

The first version should not include:

- Database writes.
- Complex multi-agent collaboration.
- A full prompt/skill versioning platform.
- Marketplace-style skill management.
- A full analytics charting engine generated by the agent.
- A rewrite of Helixent CLI.
- A browser-side agent runtime.
- Using the in-memory agent object as the only durable state.

## 15. Recommended MVP Development Order

Recommended order:

1. Add `createDatabaseAgent()`.
2. Add `list_tables`, `describe_table`, and `query_database`.
3. Add SQL safety checks.
4. Add the agent server with `POST /agent/runs`.
5. Add SSE event streaming.
6. Add trace store.
7. Add debug web app that subscribes to live events.
8. Add dashboard web app that sends user questions.
9. Add prompt and skill viewing.
10. Add prompt and skill editing after the basic loop is stable.

## 16. Final Recommendation

The best path is to build a database analysis agent beside the existing coding agent.

The current Helixent runtime is useful and should be reused, but the web product should have a new server/API entry point rather than trying to adapt the current terminal CLI.

For a two-person team, the cleanest MVP split is:

- One developer owns `dashboard-web` and `debug-web`.
- One developer owns `agent-server`, `database-agent`, tools, prompt, skills, and safety.

The smallest useful system is:

```text
Next.js dashboard web
+ Next.js or React debug web
+ Helixent-based agent server
+ read-only database tools
+ SSE trace events
```

This satisfies the current requirements while leaving a clear path toward persistent traces, prompt/skill versioning, better security, and production deployment.
