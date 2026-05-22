# Helixent API Contract

This document describes the lightweight main-system API layer. The debug panel still uses the existing web login and internal APIs.

## Authentication

Main-system calls use bearer API keys configured with `HELIXENT_API_KEYS`.

```http
Authorization: Bearer <api-key>
```

`GET /api/health` and `GET /api/v1/health` are public. All other `/api/v1/*` routes require a valid bearer token.

## Status

```http
GET /api/v1/status
```

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

## Pagination

List endpoints use lightweight cursor pagination. `cursor` is an opaque value returned by the previous response.

Supported query parameters:

- `limit`: optional page size. Defaults to `50`, maximum `100`.
- `cursor`: optional cursor returned as `nextCursor` from the previous page.

Example:

```http
GET /api/v1/conversations?limit=20
GET /api/v1/conversations?limit=20&cursor=20
```

If more data is available, the response includes `nextCursor`. If there is no next page, `nextCursor` is omitted.

## Conversation Context

Helixent keeps conversation history inside the AI agent service. The main system sends the current message and optional business context; it does not need to resend the full transcript on every request.

Long conversations are compacted automatically using a rolling summary buffer, following the same lightweight pattern used by projects such as [LangChain `ConversationSummaryBufferMemory`](https://api.python.langchain.com/en/latest/_modules/langchain/memory/summary_buffer.html) and [LlamaIndex `ChatSummaryMemoryBuffer`](https://developers.llamaindex.ai/python/examples/agent/memory/summary_memory_buffer/): older transcript messages become one durable summary, while the newest messages remain in full detail.

Default server policy:

```json
{
  "mode": "summary_buffer",
  "maxMessagesBeforeCompact": 24,
  "keepRecentMessages": 8,
  "maxSummaryCharacters": 4000
}
```

Deployment can override this with:

```env
HELIXENT_CONTEXT_COMPACTION=on
HELIXENT_CONTEXT_MAX_MESSAGES=24
HELIXENT_CONTEXT_KEEP_RECENT_MESSAGES=8
HELIXENT_CONTEXT_MAX_SUMMARY_CHARS=4000
```

## Agents

```http
GET /api/v1/agents
```

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

Supported `agentType` values are `gma`, `rm`, and `sm`.

Get one supported agent profile:

```http
GET /api/v1/agents/:agentType
```

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

Unknown `agentType` returns `404`.

## Conversations

List conversations currently known to Helixent:

```http
GET /api/v1/conversations
```

Supported filters:

- `limit`
- `cursor`
- `agentType`: `gma`, `rm`, or `sm`
- `externalConversationId`
- `createdAfter`: ISO timestamp
- `createdBefore`: ISO timestamp

Example:

```http
GET /api/v1/conversations?agentType=rm&externalConversationId=main-conv-123&limit=20
```

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

Create a conversation:

```http
POST /api/v1/conversations
```

Request:

```json
{
  "agentType": "gma",
  "title": "Store analysis",
  "externalConversationId": "main-conv-123",
  "context": {
    "tenantId": "tenant-1",
    "userId": "user-1",
    "role": "manager",
    "storeId": "store-1",
    "regionId": "region-1",
    "timezone": "Asia/Shanghai",
    "locale": "zh-CN"
  },
  "metadata": {
    "channel": "main-system"
  }
}
```

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
      "tenantId": "tenant-1",
      "userId": "user-1",
      "role": "manager",
      "storeId": "store-1",
      "regionId": "region-1",
      "timezone": "Asia/Shanghai",
      "locale": "zh-CN"
    },
    "metadata": {
      "channel": "main-system"
    },
    "active": false,
    "runCount": 0
  }
}
```

Get conversation details:

```http
GET /api/v1/conversations/:conversationId
```

Response:

```json
{
  "conversation": {
    "id": "session_xxx",
    "title": "Store analysis",
    "agentType": "gma",
    "createdAt": "2026-05-22T00:00:00.000Z",
    "updatedAt": "2026-05-22T00:00:00.000Z",
    "context": {
      "tenantId": "tenant-1",
      "storeId": "store-1"
    },
    "metadata": {
      "channel": "main-system"
    },
    "active": true,
    "runCount": 1
  }
}
```

Get conversation details by main-system id:

```http
GET /api/v1/conversations/by-external/:externalConversationId
```

Response:

```json
{
  "conversation": {
    "id": "session_xxx",
    "title": "Store analysis",
    "agentType": "gma",
    "externalConversationId": "main-conv-123",
    "createdAt": "2026-05-22T00:00:00.000Z",
    "updatedAt": "2026-05-22T00:00:00.000Z",
    "active": true,
    "runCount": 1
  }
}
```

Unknown `externalConversationId` returns `404`.

Update conversation metadata:

```http
PATCH /api/v1/conversations/:conversationId
```

Request:

```json
{
  "title": "Updated store analysis",
  "externalConversationId": "main-conv-456",
  "context": {
    "tenantId": "tenant-1",
    "regionId": "region-1"
  },
  "metadata": {
    "channel": "main-system",
    "priority": "normal"
  }
}
```

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
      "tenantId": "tenant-1",
      "regionId": "region-1"
    },
    "metadata": {
      "channel": "main-system",
      "priority": "normal"
    },
    "active": true,
    "runCount": 1
  }
}
```

`agentType` cannot be changed for an existing conversation. A request that tries to switch it returns `400`.

Delete conversation:

```http
DELETE /api/v1/conversations/:conversationId
```

Response:

```json
{
  "conversationId": "session_xxx",
  "deletedRunCount": 3
}
```

Deleting a conversation marks it closed in memory, removes its trace runs, and aborts its active run if one is streaming.

Get conversation context status:

```http
GET /api/v1/conversations/:conversationId/context
```

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

Get current context summary:

```http
GET /api/v1/conversations/:conversationId/context/summary
```

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

Manually compact conversation context:

```http
POST /api/v1/conversations/:conversationId/context/compact
```

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

Reset conversation context:

```http
POST /api/v1/conversations/:conversationId/context/reset
```

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

List conversation runs:

```http
GET /api/v1/conversations/:conversationId/runs
```

Supports `limit` and `cursor`.

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

List conversation messages:

```http
GET /api/v1/conversations/:conversationId/messages
```

Supports `limit` and `cursor`.

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
    },
    {
      "role": "assistant",
      "content": "The analysis result.",
      "runId": "run_xxx",
      "requestId": "main-request-123",
      "timestamp": "2026-05-22T00:00:01.000Z"
    }
  ],
  "nextCursor": "20"
}
```

## Messages

Send a message to an existing conversation:

```http
POST /api/v1/conversations/:conversationId/messages
```

Request:

```json
{
  "requestId": "main-request-123",
  "message": "Analyze today's store performance.",
  "callbackUrl": "https://main-system.example/ai/callback",
  "context": {
    "storeId": "store-1"
  },
  "metadata": {
    "source": "main-system"
  }
}
```

Response:

```json
{
  "runId": "run_xxx",
  "conversationId": "session_xxx",
  "status": "running"
}
```

Send a message synchronously and wait for the final result:

```http
POST /api/v1/conversations/:conversationId/messages:run
```

Request:

```json
{
  "requestId": "main-request-123",
  "message": "Analyze today's store performance.",
  "callbackUrl": "https://main-system.example/ai/callback",
  "context": {
    "storeId": "store-1"
  },
  "metadata": {
    "source": "main-system"
  }
}
```

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

If the run fails, the response still uses `200` when the request was accepted, with `status: "failed"` and an `error` object in the body.

Send a message and let Helixent create the conversation if `conversationId` is omitted:

```http
POST /api/v1/agent/messages
```

Request:

```json
{
  "agentType": "gma",
  "conversationId": "session_xxx",
  "requestId": "main-request-123",
  "message": "Analyze today's store performance.",
  "callbackUrl": "https://main-system.example/ai/callback",
  "externalConversationId": "main-conv-123",
  "context": {
    "tenantId": "tenant-1",
    "userId": "user-1",
    "role": "manager",
    "storeId": "store-1",
    "regionId": "region-1",
    "timezone": "Asia/Shanghai",
    "locale": "zh-CN"
  },
  "metadata": {
    "source": "main-system"
  }
}
```

Response:

```json
{
  "runId": "run_xxx",
  "conversationId": "session_xxx",
  "status": "running"
}
```

If `callbackUrl` is provided on an async message request, Helixent sends a best-effort `POST` callback after the run finishes. Callback delivery failure does not change run status.

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

## Runs

```http
GET /api/v1/runs/:runId
```

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
  "lastEventType": "run_completed"
}
```

```http
GET /api/v1/runs/:runId/result
```

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

List user-safe run events:

```http
GET /api/v1/runs/:runId/events
```

Supports `limit` and `cursor`.

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

Retry a run:

```http
POST /api/v1/runs/:runId/retry
```

Request:

```json
{
  "requestId": "main-request-124",
  "callbackUrl": "https://main-system.example/ai/callback",
  "context": {
    "storeId": "store-1"
  },
  "metadata": {
    "source": "main-system"
  }
}
```

Response:

```json
{
  "runId": "run_retry_xxx",
  "retryOfRunId": "run_xxx",
  "conversationId": "session_xxx",
  "status": "running"
}
```

Cancel a running run:

```http
POST /api/v1/runs/:runId/cancel
```

Response:

```json
{
  "runId": "run_xxx",
  "status": "aborting"
}
```

```http
GET /api/v1/runs/:runId/stream
```

Server-sent events. The stream emits user-safe events such as `run_started`, `final_answer`, `context_compacted`, `run_completed`, `run_failed`, and `run_aborted`.
