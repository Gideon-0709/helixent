# Helixent API Contract

This document describes the lightweight main-system API layer. The debug panel still uses the existing web login and internal APIs.

## Authentication

Main-system calls use bearer API keys configured with `HELIXENT_API_KEYS`.

```http
Authorization: Bearer <api-key>
```

`GET /api/health` and `GET /api/v1/health` are public. All other `/api/v1/*` routes require a valid bearer token.

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

## Conversations

```http
POST /api/v1/conversations
```

Request:

```json
{
  "agentType": "gma",
  "title": "Store analysis",
  "externalConversationId": "main-conv-123",
  "metadata": {
    "tenantId": "tenant-1",
    "userId": "user-1",
    "storeId": "store-1"
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
    "metadata": {
      "tenantId": "tenant-1",
      "userId": "user-1",
      "storeId": "store-1"
    },
    "active": false,
    "runCount": 0
  }
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
  "message": "Analyze today's store performance.",
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

Send a message and let Helixent create the conversation if `conversationId` is omitted:

```http
POST /api/v1/agent/messages
```

Request:

```json
{
  "agentType": "gma",
  "conversationId": "session_xxx",
  "message": "Analyze today's store performance.",
  "externalConversationId": "main-conv-123",
  "metadata": {
    "tenantId": "tenant-1",
    "userId": "user-1",
    "storeId": "store-1"
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
  "status": "completed",
  "startedAt": "2026-05-22T00:00:00.000Z",
  "updatedAt": "2026-05-22T00:00:01.000Z",
  "inputPreview": "Analyze today's store performance.",
  "durationMs": 1000,
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
  "status": "completed",
  "finalAnswer": "The analysis result.",
  "lastEventType": "run_completed"
}
```

```http
GET /api/v1/runs/:runId/stream
```

Server-sent events. The stream emits user-safe events such as `final_answer`, `run_completed`, `run_failed`, and `run_aborted`.
