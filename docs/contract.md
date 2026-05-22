# Helixent Main-System API Contract

This contract defines the `/api/v1` HTTP API used by the main system to call Helixent AI agent services.

## 1. Protocol

| Item | Value |
| --- | --- |
| Base URL | Provided by deployment, for example `http://ai-service:3002` |
| API version | `v1` |
| Request body | JSON |
| Response body | JSON |
| Time format | ISO 8601 string |
| Public endpoints | `GET /api/health`, `GET /api/v1/health` |
| Protected endpoints | All other `/api/v1/*` endpoints |

Requests with JSON bodies should include:

```http
Content-Type: application/json
```

## 2. Authentication

Protected endpoints require a bearer API key configured on the Helixent service with `HELIXENT_API_KEYS`.

```http
Authorization: Bearer <api-key>
```

Missing or invalid API key:

```http
401 Unauthorized
```

```json
{
  "error": "valid api key is required"
}
```

## 3. Common Types

### 3.1 IDs

| Field | Type | Description |
| --- | --- | --- |
| `conversationId` | string | Helixent-generated conversation id. Current format starts with `session_`. |
| `externalConversationId` | string | Main-system conversation id. Optional. The main system should treat this as unique. |
| `runId` | string | Helixent-generated run id. Current format starts with `run_`. |
| `requestId` | string | Main-system request id. Optional. Use it for idempotency and log correlation. |

### 3.2 Enums

| Name | Values |
| --- | --- |
| `agentType` | `gma`, `rm`, `sm` |
| `run.status` | `running`, `completed`, `failed`, `aborted` |
| `context.status` | `normal`, `warning`, `danger` |
| cancel response `status` | `aborting` |

### 3.3 Error

All API errors use this shape:

```json
{
  "error": "conversation not found"
}
```

Common status codes:

| Status | Meaning |
| --- | --- |
| `200` | Request accepted or completed. |
| `400` | Invalid request body or unsupported operation. |
| `401` | Missing or invalid authentication. |
| `404` | Resource not found. |

Common error messages:

| Error | Typical Cause |
| --- | --- |
| `valid api key is required` | Missing or invalid bearer token. |
| `message is required` | Message request body has no non-empty `message`. |
| `agent not found` | Unknown `agentType`. |
| `conversation not found` | Unknown `conversationId` or `externalConversationId`. |
| `agentType cannot be changed for an existing conversation` | `PATCH` attempted to switch an existing conversation to another agent. |
| `run not found` | Unknown `runId`. |
| `run input not found` | Retry target has no recorded input. |
| `run is not running` | Cancel target is not active. |

### 3.4 Pagination

List endpoints support cursor pagination.

| Query | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | number | no | Page size. Default `50`, maximum `100`. |
| `cursor` | string | no | Cursor from the previous response's `nextCursor`. Treat it as opaque. |

If more data exists, the response includes `nextCursor`. If there is no next page, `nextCursor` is omitted.

```json
{
  "nextCursor": "20"
}
```

### 3.5 Conversation

```ts
type Conversation = {
  id: string;
  title: string;
  agentType: "gma" | "rm" | "sm";
  createdAt: string;
  updatedAt: string;
  context?: Record<string, unknown>;
  externalConversationId?: string;
  metadata?: Record<string, unknown>;
  active: boolean;
  runCount: number;
};
```

| Field | Description |
| --- | --- |
| `context` | Business context stored with the conversation. Used by the main system for correlation and by Helixent as optional context. |
| `metadata` | Caller-defined metadata. Helixent stores and returns it without interpreting it. |
| `active` | Whether an agent instance has been created for this conversation in the current service process. |
| `runCount` | Number of runs started for this conversation in the current service process. |

### 3.6 Run

```ts
type Run = {
  runId: string;
  sessionId?: string;
  conversationId?: string;
  requestId?: string;
  status: "running" | "completed" | "failed" | "aborted";
  startedAt: string;
  updatedAt: string;
  inputPreview?: string;
  durationMs?: number;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  lastEventType: string;
};
```

### 3.7 Message

```ts
type Message = {
  role: "user" | "assistant";
  content: string;
  runId: string;
  requestId?: string;
  timestamp: string;
};
```

### 3.8 ContextStatus

```ts
type ContextStatus = {
  conversationId: string;
  enabled: boolean;
  maxMessagesBeforeCompact: number;
  keepRecentMessages: number;
  maxSummaryCharacters: number;
  messageCount: number;
  percent: number;
  status: "normal" | "warning" | "danger";
  summaryActive: boolean;
  summaryPreview?: string;
  compactedCount: number;
  lastCompactedAt?: string;
};
```

### 3.9 UserSafeRunEvent

`GET /api/v1/runs/:runId/events` and SSE streams expose user-safe events, not raw internal trace events.

Common fields:

```ts
type UserSafeRunEvent = {
  id: string;
  runId: string;
  type: string;
  timestamp: string;
  sequence: number;
};
```

Supported event types in v1:

| Event Type | Extra Fields |
| --- | --- |
| `run_started` | `input`, `agentName?`, `sessionId?` |
| `final_answer` | `text` |
| `context_compacted` | `previousMessageCount`, `currentMessageCount`, `compactedMessageCount`, `keptMessageCount`, `summaryPreview?` |
| `run_completed` | `durationMs` |
| `run_failed` | `error.message` |
| `run_aborted` | `reason?` |

## 4. Endpoint Reference

### 4.1 Health and Status

#### `GET /api/v1/health`

Public health check.

Response:

```json
{
  "ok": true,
  "service": "helixent-debug-agent",
  "version": "v1"
}
```

#### `GET /api/v1/status`

Returns service runtime status.

Response:

```json
{
  "ok": true,
  "service": "helixent-debug-agent",
  "version": "v1",
  "model": {
    "configured": true,
    "name": "deepseek-v4-pro",
    "provider": "openai",
    "baseURL": "https://api.deepseek.com"
  },
  "agents": {
    "available": 3,
    "types": ["gma", "rm", "sm"]
  },
  "conversations": {
    "total": 1,
    "active": 1
  },
  "runs": {
    "total": 3,
    "running": 0,
    "active": 0
  }
}
```

### 4.2 Agents

#### `GET /api/v1/agents`

Lists supported built-in agents.

Response:

```json
{
  "agents": [
    {
      "type": "gma",
      "name": "GMA",
      "role": "general_manager_assistant",
      "description": "A general manager assistant agent"
    }
  ]
}
```

#### `GET /api/v1/agents/:agentType`

Path params:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `agentType` | enum | yes | One of `gma`, `rm`, `sm`. |

Response:

```json
{
  "agent": {
    "type": "rm",
    "name": "RM",
    "role": "regional_manager",
    "description": "A regional manager agent"
  }
}
```

### 4.3 Conversations

#### `GET /api/v1/conversations`

Query params:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | number | no | Page size. |
| `cursor` | string | no | Cursor from previous page. |
| `agentType` | enum | no | Filter by agent type. |
| `externalConversationId` | string | no | Filter by main-system conversation id. |
| `createdAfter` | string | no | ISO timestamp. Returns conversations created after this time. |
| `createdBefore` | string | no | ISO timestamp. Returns conversations created before this time. |

Response:

```json
{
  "conversations": [
    {
      "id": "session_xxx",
      "title": "Store analysis",
      "agentType": "gma",
      "createdAt": "2026-05-22T00:00:00.000Z",
      "updatedAt": "2026-05-22T00:00:01.000Z",
      "externalConversationId": "main-conv-123",
      "context": {
        "tenantId": "tenant-1"
      },
      "metadata": {
        "channel": "main-system"
      },
      "active": true,
      "runCount": 1
    }
  ],
  "nextCursor": "20"
}
```

#### `POST /api/v1/conversations`

Creates a conversation.

Request body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `agentType` | enum | no | Defaults to `gma`. |
| `title` | string | no | Defaults to the agent display name. |
| `externalConversationId` | string | no | Main-system conversation id. |
| `context` | object | no | Business context. |
| `metadata` | object | no | Caller-defined metadata. |

Response:

```json
{
  "conversationId": "session_xxx",
  "conversation": {
    "id": "session_xxx",
    "title": "Store analysis",
    "agentType": "gma",
    "createdAt": "2026-05-22T00:00:00.000Z",
    "updatedAt": "2026-05-22T00:00:00.000Z",
    "externalConversationId": "main-conv-123",
    "context": {
      "tenantId": "tenant-1"
    },
    "metadata": {
      "channel": "main-system"
    },
    "active": false,
    "runCount": 0
  }
}
```

#### `GET /api/v1/conversations/:conversationId`

Returns one conversation.

#### `GET /api/v1/conversations/by-external/:externalConversationId`

Returns one conversation by main-system id.

#### `PATCH /api/v1/conversations/:conversationId`

Updates editable conversation fields.

Request body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | string | no | New title. Empty strings are ignored. |
| `externalConversationId` | string | no | Replaces the external id. Empty string clears it. |
| `context` | object | no | Replaces stored context. Empty object clears it. |
| `metadata` | object | no | Replaces stored metadata. Empty object clears it. |
| `agentType` | enum | no | Must match the existing value if provided. It cannot be changed. |

Response:

```json
{
  "conversation": {
    "id": "session_xxx",
    "title": "Updated store analysis",
    "agentType": "gma",
    "updatedAt": "2026-05-22T00:00:02.000Z",
    "externalConversationId": "main-conv-456",
    "context": {
      "tenantId": "tenant-1"
    },
    "metadata": {
      "channel": "main-system"
    },
    "active": true,
    "runCount": 1
  }
}
```

#### `DELETE /api/v1/conversations/:conversationId`

Deletes the conversation from current Helixent runtime memory and removes its trace runs. If the conversation has an active run, Helixent aborts it.

Response:

```json
{
  "conversationId": "session_xxx",
  "deletedRunCount": 3
}
```

### 4.4 Conversation Context

#### `GET /api/v1/conversations/:conversationId/context`

Returns context usage and compaction status.

Response:

```json
{
  "context": {
    "conversationId": "session_xxx",
    "enabled": true,
    "maxMessagesBeforeCompact": 24,
    "keepRecentMessages": 8,
    "maxSummaryCharacters": 4000,
    "messageCount": 12,
    "percent": 50,
    "status": "normal",
    "summaryActive": false,
    "compactedCount": 0
  }
}
```

#### `GET /api/v1/conversations/:conversationId/context/summary`

Returns the current context summary state.

Response:

```json
{
  "summary": {
    "active": true,
    "preview": "Manual context summary: 2 older messages were compacted. Recent context is preserved.",
    "compactedCount": 1,
    "lastCompactedAt": "2026-05-22T00:00:01.000Z"
  }
}
```

#### `POST /api/v1/conversations/:conversationId/context/compact`

Manually compacts the conversation context. This affects future model input and does not delete historical run records.

Response:

```json
{
  "compacted": true,
  "context": {
    "conversationId": "session_xxx",
    "messageCount": 9,
    "summaryActive": true,
    "compactedCount": 1
  }
}
```

#### `POST /api/v1/conversations/:conversationId/context/reset`

Clears the agent's current conversation context. This affects future model input and does not delete historical run records.

Response:

```json
{
  "reset": true,
  "context": {
    "conversationId": "session_xxx",
    "messageCount": 0,
    "summaryActive": false
  }
}
```

### 4.5 Messages

#### `POST /api/v1/conversations/:conversationId/messages`

Starts an async run in an existing conversation.

Request body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `message` | string | yes | User input. Must be non-empty. |
| `requestId` | string | no | Main-system request id. |
| `callbackUrl` | string | no | Webhook URL called when the run finishes. |
| `context` | object | no | Per-run business context. |
| `metadata` | object | no | Per-run caller metadata. |

Response:

```json
{
  "runId": "run_xxx",
  "conversationId": "session_xxx",
  "status": "running"
}
```

#### `POST /api/v1/conversations/:conversationId/messages:run`

Starts a run and waits until it finishes.

Request body: same as `POST /api/v1/conversations/:conversationId/messages`.

Response:

```json
{
  "runId": "run_xxx",
  "sessionId": "session_xxx",
  "conversationId": "session_xxx",
  "requestId": "main-request-123",
  "status": "completed",
  "startedAt": "2026-05-22T00:00:00.000Z",
  "updatedAt": "2026-05-22T00:00:01.000Z",
  "inputPreview": "Analyze today's store performance.",
  "durationMs": 1000,
  "context": {
    "storeId": "store-1"
  },
  "metadata": {
    "source": "main-system"
  },
  "finalAnswer": "The analysis result.",
  "lastEventType": "run_completed"
}
```

If the run fails after being accepted, the response is still `200` and contains `status: "failed"` plus an `error` object.

#### `POST /api/v1/agent/messages`

Starts an async run and creates a conversation if `conversationId` is omitted.

Request body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `message` | string | yes | User input. Must be non-empty. |
| `conversationId` | string | no | Existing Helixent conversation id. |
| `agentType` | enum | no | Used only when creating a new conversation. Defaults to `gma`. |
| `title` | string | no | Used only when creating a new conversation. |
| `externalConversationId` | string | no | Used only when creating a new conversation. |
| `requestId` | string | no | Main-system request id. |
| `callbackUrl` | string | no | Webhook URL called when the run finishes. |
| `context` | object | no | Conversation context for new conversations and per-run context. |
| `metadata` | object | no | Conversation metadata for new conversations and per-run metadata. |

Response:

```json
{
  "runId": "run_xxx",
  "conversationId": "session_xxx",
  "status": "running"
}
```

### 4.6 Conversation Messages and Runs

#### `GET /api/v1/conversations/:conversationId/messages`

Lists conversation messages derived from completed run events.

Query params: `limit`, `cursor`.

Response:

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Analyze today's store performance.",
      "runId": "run_xxx",
      "requestId": "main-request-123",
      "timestamp": "2026-05-22T00:00:00.000Z"
    }
  ],
  "nextCursor": "20"
}
```

#### `GET /api/v1/conversations/:conversationId/runs`

Lists runs in a conversation.

Query params: `limit`, `cursor`.

Response:

```json
{
  "runs": [
    {
      "runId": "run_xxx",
      "conversationId": "session_xxx",
      "requestId": "main-request-123",
      "status": "completed",
      "startedAt": "2026-05-22T00:00:00.000Z",
      "updatedAt": "2026-05-22T00:00:01.000Z",
      "inputPreview": "Analyze today's store performance.",
      "durationMs": 1000,
      "lastEventType": "run_completed"
    }
  ],
  "nextCursor": "20"
}
```

### 4.7 Runs

#### `GET /api/v1/runs/:runId`

Returns run metadata.

#### `GET /api/v1/runs/:runId/result`

Returns run metadata plus final result or error.

Response:

```json
{
  "runId": "run_xxx",
  "conversationId": "session_xxx",
  "requestId": "main-request-123",
  "status": "completed",
  "finalAnswer": "The analysis result.",
  "lastEventType": "run_completed"
}
```

#### `GET /api/v1/runs/:runId/events`

Lists user-safe run events.

Query params: `limit`, `cursor`.

Response:

```json
{
  "events": [
    {
      "id": "event_xxx",
      "runId": "run_xxx",
      "type": "run_started",
      "timestamp": "2026-05-22T00:00:00.000Z",
      "sequence": 1,
      "input": "Analyze today's store performance.",
      "sessionId": "session_xxx"
    },
    {
      "id": "event_xxx",
      "runId": "run_xxx",
      "type": "final_answer",
      "timestamp": "2026-05-22T00:00:01.000Z",
      "sequence": 10,
      "text": "The analysis result."
    }
  ],
  "nextCursor": "20"
}
```

#### `POST /api/v1/runs/:runId/retry`

Retries a run using the original user input. Optional request fields override original run metadata.

Request body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `requestId` | string | no | New request id. Defaults to original request id. |
| `callbackUrl` | string | no | New callback URL. Defaults to original callback URL. |
| `context` | object | no | New context. Defaults to original context. |
| `metadata` | object | no | New metadata. Defaults to original metadata. |

Response:

```json
{
  "runId": "run_retry_xxx",
  "retryOfRunId": "run_xxx",
  "conversationId": "session_xxx",
  "status": "running"
}
```

#### `POST /api/v1/runs/:runId/cancel`

Attempts to abort a running run.

Response:

```json
{
  "runId": "run_xxx",
  "status": "aborting"
}
```

#### `GET /api/v1/runs/:runId/stream`

Server-sent events stream for user-safe run events.

SSE payload example:

```text
data: {"type":"final_answer","runId":"run_xxx","text":"The analysis result.","timestamp":"2026-05-22T00:00:01.000Z","sequence":10}
```

## 5. Webhook Callback

If `callbackUrl` is provided on an async message request or retry request, Helixent sends a best-effort `POST` when the run finishes.

Callback request:

```http
POST <callbackUrl>
Content-Type: application/json
```

Callback body:

```json
{
  "runId": "run_xxx",
  "sessionId": "session_xxx",
  "conversationId": "session_xxx",
  "requestId": "main-request-123",
  "status": "completed",
  "finalAnswer": "The analysis result.",
  "lastEventType": "run_completed"
}
```

Webhook delivery rules:

| Rule | Contract |
| --- | --- |
| Delivery | Best-effort. |
| Retry | No retry in v1. |
| Authentication/signature | No callback signature in v1. |
| Idempotency | Main system should use `runId` or `requestId`. |
| Compensation | Main system can call `GET /api/v1/runs/:runId/result`. |

## 6. Runtime Data Lifecycle

Conversation, run, message, and trace data are held by the Helixent service runtime in v1. They are not a durable source of record. The main system should store its own business records, including `externalConversationId`, `conversationId`, `requestId`, and `runId` where needed.
