# Debug Panel 实现方案

日期：2026-05-17

本文档总结围绕 Helixent Web 产品方向的讨论，并给出一个面向开发者专用 Debug Panel 的详细实现方案。该 Panel 用于可视化 Helixent 的 agent 运行过程。

本文档特别强调当前阶段的开发边界：当前 Helixent 侧的主要开发对象是一个 `debug-agent-service`。它在同一个服务/容器中同时提供 Debug Panel UI、agent APIs、trace APIs 和 Helixent agent runtime。完整的 consumer dashboard 不在本阶段实现范围内。Dashboard 在本文中只作为 agent 的外部调用方和接口契约消费者出现。

## 1. 讨论回顾

### 1.1 仓库与贡献流程

本地仓库最初克隆自：

```text
https://github.com/MagicCube/helixent.git
```

由于后续工作预期会以 Pull Request 的形式提交，因此仓库已 fork 到：

```text
https://github.com/Gideon-0709/helixent
```

当前本地 remote 组织方式为：

```text
origin   -> https://github.com/Gideon-0709/helixent.git
upstream -> https://github.com/MagicCube/helixent.git
```

预期开发流程是：

```text
从 upstream/main 同步
创建功能分支
本地提交
推送到 origin
向 upstream 创建 PR
```

### 1.2 原始产品方向

现有 Helixent 仓库是一个基于 Bun 和 TypeScript 的 ReAct-style agent 项目。它已经具备一些可复用的运行时层：

- `src/foundation`：model、message、tool 等基础原语。
- `src/agent`：通用 ReAct loop 和 middleware。
- `src/agent/skills`：skill 加载与 prompt 注入。
- `src/coding`：coding-specific agent 与工具。
- `src/community`：模型 provider adapter。
- `src/cli`：CLI 与 Ink TUI。

产品目标是构建一个基于 Web 的数据库分析 agent。面向用户的 dashboard 会包含一个 AI 对话入口，让用户可以通过它询问数据库相关问题。第一版必须只支持只读分析。

但是，在当前实现阶段，dashboard 不是主要开发对象。当前重点是：

```text
Debug Agent Service
  -> Developer Debug Panel
  -> Agent APIs
  -> Trace APIs
  -> Helixent Agent Runtime
```

Dashboard 只需要通过约定好的 API 调用 debug-agent-service。它可以由另一个开发者或另一个项目实现，也可以在本地联调阶段用一个极简 mock 页面替代。

原始推荐方向是：

```text
Dashboard Web
  -> Agent Server
  -> Helixent Database Agent
  -> Read-only Database Tools
  -> Database
```

但讨论过程中，我们进一步调整了开发顺序：在构建 database agent 之前，应该优先建设 debug panel 这一核心产品面。

### 1.3 为什么 Debug Panel 应该先做

Debug Panel 不是 database agent 的功能，也不是 coding agent 的功能。它是 Helixent runtime 的可观测性界面。

Panel 应该可视化通用的 agent run：

```text
run
step
model call
assistant message
tool call
tool result
token usage
error
completion
```

这意味着它可以先基于现有 coding agent 开发。之后引入 database agent 时，panel 不应该需要重新设计。领域相关的部分会通过 prompt、skills 和 tools 改变；panel 消费的是同一套 trace protocol。

最终原则是：

```text
在 Dashboard 中调用 agent。
在 Debug Panel 中观察 run。
```

## 2. 产品形态与开发边界

### 2.1 MVP：一个 Debug Agent Service

MVP 阶段推荐把 Debug Panel 和 Agent Runtime 部署在同一个服务/容器中：

```text
debug-agent-service
  -> /internal/debug          Developer Debug Panel
  -> /api/agent/*             user-facing agent APIs
  -> /api/internal/*          internal trace APIs
  -> Helixent Agent Runtime
  -> In-memory Trace Store
```

这样外部访问站点时可以打开 panel，panel 调用同一个服务内的 internal APIs；同时 dashboard 将来也可以调用同一个服务的 user-facing agent APIs。

Consumer Dashboard 是产品界面。它包含 AI 对话框，只展示面向最终用户安全可见的输出。它不是本文档的主要实现范围。

Developer Debug Panel 是内部开发者界面。它展示完整的 agent trace 细节，包括 prompt、skills、tools、模型行为、tool inputs、tool outputs、token usage、errors 和 final answers。

Debug Agent Service 是 Helixent runtime 的服务化边界。它负责启动 ReAct loop、调用模型、调用工具、记录 trace，并同时提供面向 dashboard 的 user-safe API 和面向 debug panel 的 internal trace API。

未来如果出现独立扩容、权限隔离、团队边界或部署生命周期分离的需要，可以再把它拆成 `debug-web` 和 `agent-service` 两个部署对象。

### 2.2 本阶段开发范围

当前阶段的开发主要围绕同一个服务里的两个部分：

- `Debug Panel UI`：位于 `debug-agent-service` 内，通过 internal trace APIs 可视化 agent 内部事件。
- `Agent Runtime/API`：位于同一个 `debug-agent-service` 内，提供 agent run、trace store、SSE/internal APIs、instrumentation。

当前阶段不开发完整 dashboard。为了联调，可以只保留 dashboard 的最小接口契约：

- dashboard 会调用哪个 agent API
- 请求体包含什么
- 返回或 stream 什么 user-safe events
- 如何拿到 `runId`

Dashboard 不应该接收完整 trace 细节。它只应该接收适合最终用户查看的 sanitized content。

### 2.3 Dashboard 作为外部调用方

Dashboard 的逻辑流程只作为集成边界描述：

```text
用户在 dashboard 的 AI 对话框中输入问题
dashboard 调用 debug-agent-service 的 user-facing API
debug-agent-service 创建 runId 并启动 Helixent ReAct loop
dashboard 接收 user-safe stream 或 final answer
debug panel 通过 internal trace API 观察同一个 run
```

Dashboard 不需要知道 agent 内部如何运行，也不应该直接访问 trace store。

### 2.4 Debug Panel 行为

Debug Panel 的流程是：

```text
开发者打开 debug panel
panel 调用同一个 debug-agent-service 的 internal trace APIs
debug-agent-service 中产生新的 run
agent runtime 记录内部事件
panel 实时展示这次 run 的 timeline
开发者检查 prompt、skills、tools、model calls、tool calls 和 results
```

Panel 并不是直接监控 dashboard 页面。它监控的是 debug-agent-service 维护的 trace store。

## 3. 部署模型

### 3.1 推荐的 MVP 单服务模型

MVP 阶段推荐将系统理解为一个核心部署对象：

```text
debug-agent-service
  -> /internal/debug
  -> /api/agent/*
  -> /api/internal/*
  -> Helixent runtime
  -> trace store
```

本地开发时可以运行：

```text
http://localhost:3001/internal/debug -> debug panel
http://localhost:3001/api/agent/*    -> user-facing agent APIs
http://localhost:3001/api/internal/* -> internal trace APIs
```

Dashboard 如果需要联调，可以作为外部项目或 mock caller 调用：

```text
POST http://localhost:3001/api/agent/runs
```

### 3.2 同一站点下的生产路由

生产环境可以把 `debug-agent-service` 挂到一个受保护的站点下：

```text
/internal/debug     -> debug panel
/api/agent/*        -> user-facing agent APIs
/api/internal/*     -> internal trace APIs
```

如果还有独立 dashboard，它可以在同一个域名下，也可以在另一个项目或域名下：

```text
/dashboard          -> dashboard-web，本阶段不实现完整产品
```

### 3.3 Docker Compose 单容器形态

在一台服务器上使用 Docker Compose 时，MVP 可以只有一个核心容器：

```text
debug-agent-service container
  -> debug panel
  -> agent runtime
  -> trace store
  -> agent APIs
  -> trace APIs
```

外部访问 panel：

```text
https://debug.example.com/internal/debug
```

Dashboard 或 mock caller 调用 agent API：

```text
https://debug.example.com/api/agent/runs
```

Panel 内部调用 trace API：

```text
https://debug.example.com/api/internal/events/live
```

### 3.4 未来可拆分形态

当出现以下需求时，可以再拆分成 `debug-web` 和 `agent-service`：

- Debug Panel 需要独立部署或独立扩容。
- Agent runtime 需要独立扩容、隔离或长期任务管理。
- 团队希望前端 UI 与 agent backend 采用更强的发布隔离。
- trace store 从内存迁移到独立数据库，并需要单独管理。
- dashboard、debug panel、agent service 的权限边界需要更强隔离。

拆分后的形态可以是：

```text
debug-web
  -> /internal/debug
  -> calls agent-service internal trace APIs

agent-service
  -> /api/agent/*
  -> /api/internal/*
  -> Helixent runtime
  -> trace store
```

### 3.5 推荐部署演进

推荐演进方式是：

1. 先建立清晰的 API 和 trace contract。
2. 保持配置由环境变量驱动。
3. 本地先启动单个 `debug-agent-service`。
4. Dashboard 在本阶段只使用 mock 或接口契约联调。
5. 调试稳定后，用 Docker Compose 部署单个 `debug-agent-service` 容器。
6. 未来有明确需求时，再拆成 `debug-web` 和 `agent-service`。

重要边界不是容器数量。真正重要的是 API contract 和 trace contract。

## 4. 访问与权限模型

### 4.1 Public 与 internal 界面

面向用户的 dashboard 和面向开发者的 debug panel 必须进行权限隔离：

```text
dashboard APIs      -> 普通已认证用户
internal trace APIs -> 仅 developers/admins
```

Debug Panel 可能暴露敏感信息：

- system prompt
- loaded skills
- available tools
- model messages
- tool inputs
- tool outputs
- SQL queries
- token usage
- errors
- internal metadata

因此，panel 及其 API 不能被普通 dashboard 用户访问。

### 4.2 推荐本地访问方式

本地开发时可以使用：

```text
http://localhost:3001/internal/debug -> debug panel
http://localhost:3001/api/agent/*    -> user-facing agent APIs
http://localhost:3001/api/internal/* -> internal trace APIs
```

前期开发可以只启动 `debug-agent-service`。如果需要模拟 dashboard 调用，可以用一个极简脚本、mock 页面或 API client 向 `/api/agent/runs` 发起 run，不需要先实现完整 dashboard。

### 4.3 推荐生产访问方式

生产环境可以使用基于路径的隔离：

```text
https://debug.example.com/internal/debug -> debug panel
https://debug.example.com/api/agent/*    -> user-facing agent APIs
https://debug.example.com/api/internal/* -> internal trace APIs，仅开发者
```

如果 dashboard 后续部署在同一站点或另一个站点，它只需要能调用 `/api/agent/*`：

```text
https://app.example.com/dashboard        -> dashboard-web，本阶段不实现
https://debug.example.com/api/agent/*    -> debug-agent-service
```

无论使用哪一种方式，都必须用开发者鉴权保护 debug panel 和 trace APIs。

## 5. Runtime Trace 架构

### 5.1 核心思想

Debug Panel 应该由 trace store 驱动，而不是直接访问 agent object。

Agent runtime 在运行过程中发出事件。这些事件会被追加到 trace store，并流式推送给 debug panel subscribers。

```text
Agent.stream()
  -> emits runtime events
  -> trace store appends events by runId
  -> dashboard receives sanitized stream
  -> debug panel receives full trace stream
```

### 5.2 Trace store 职责

Trace store 应该负责：

- 按 `runId` 追加事件
- 返回某个 run 的全部事件
- 向 subscribers 广播 live events
- 为 debug panel 列出最近的 runs
- 支持 in-memory MVP
- 后续可替换为 database-backed store

MVP 阶段：

```text
runId -> events[]
```

后续阶段：

```text
agent_runs
agent_events
```

### 5.3 Agent run 生命周期

预期生命周期是：

```text
run_started
input_received
prompt_loaded
skills_loaded
tools_registered
step_started
model_started
model_completed
assistant_message
tool_started
tool_completed
tool_failed
tool_result_message
token_usage
step_completed
final_answer
run_completed
```

错误应产生：

```text
run_failed
tool_failed
model_failed
```

取消应产生：

```text
run_aborted
```

## 6. Trace Event Contract

### 6.1 基础事件结构

每个 trace event 都应该共享一组通用 metadata：

```ts
interface TraceEventBase {
  id: string;
  runId: string;
  type: string;
  timestamp: string;
  sequence: number;
}
```

`sequence` 应在同一个 run 内单调递增。这样即使多个事件的 timestamp 非常接近，panel 也能稳定排序。

### 6.2 Run events

```ts
interface RunStartedEvent extends TraceEventBase {
  type: "run_started";
  input: string;
  agentName?: string;
  sessionId?: string;
}

interface RunCompletedEvent extends TraceEventBase {
  type: "run_completed";
  durationMs: number;
}

interface RunFailedEvent extends TraceEventBase {
  type: "run_failed";
  error: {
    message: string;
    code?: string;
  };
}
```

### 6.3 Context events

```ts
interface PromptLoadedEvent extends TraceEventBase {
  type: "prompt_loaded";
  prompt: string;
  version?: string;
}

interface SkillsLoadedEvent extends TraceEventBase {
  type: "skills_loaded";
  skills: Array<{
    name: string;
    description?: string;
    path?: string;
    version?: string;
  }>;
}

interface ToolsRegisteredEvent extends TraceEventBase {
  type: "tools_registered";
  tools: Array<{
    name: string;
    description?: string;
  }>;
}
```

### 6.4 Model events

```ts
interface ModelStartedEvent extends TraceEventBase {
  type: "model_started";
  step: number;
  provider?: string;
  model?: string;
}

interface ModelCompletedEvent extends TraceEventBase {
  type: "model_completed";
  step: number;
  durationMs: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}
```

### 6.5 Message events

```ts
interface AssistantMessageEvent extends TraceEventBase {
  type: "assistant_message";
  step: number;
  message: unknown;
}

interface ToolResultMessageEvent extends TraceEventBase {
  type: "tool_result_message";
  step: number;
  message: unknown;
}

interface FinalAnswerEvent extends TraceEventBase {
  type: "final_answer";
  text: string;
}
```

Panel 初期可以把 message 渲染为结构化 JSON 加文本摘要。后续可以逐步增加更丰富的 renderer，用于展示 text、tool use、tool result、SQL、tables 和 errors。

### 6.6 Tool events

```ts
interface ToolStartedEvent extends TraceEventBase {
  type: "tool_started";
  step: number;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

interface ToolCompletedEvent extends TraceEventBase {
  type: "tool_completed";
  step: number;
  toolCallId: string;
  toolName: string;
  durationMs: number;
  result: unknown;
}

interface ToolFailedEvent extends TraceEventBase {
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
```

### 6.7 Token usage event

Token usage 可以包含在 `model_completed` 中，但单独事件也有利于聚合：

```ts
interface TokenUsageEvent extends TraceEventBase {
  type: "token_usage";
  step: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
```

## 7. API 设计

### 7.1 面向 Dashboard 的 user-facing APIs

Dashboard 虽然不在本阶段实现范围内，但 agent service 必须定义并实现 dashboard 将来会调用的 user-facing APIs：

```text
POST /api/agent/runs
GET /api/agent/runs/:runId/stream
```

`POST /api/agent/runs` 启动一次 run：

```json
{
  "message": "Why did revenue drop this week?",
  "sessionId": "session_123"
}
```

返回：

```json
{
  "runId": "run_123"
}
```

Dashboard stream 只应返回 user-safe events：

```text
answer_delta
final_answer
run_completed
user_safe_error
```

它不应该向普通用户暴露完整 tool inputs、tool outputs、SQL details、prompt content 或 skill content。

本阶段可以用脚本、测试或极简 mock 页面调用这些 API，以验证 agent service 和 debug panel 的联动。不需要开发完整 dashboard UI。

### 7.2 Internal debug APIs

Debug Panel 调用 internal APIs：

```text
GET /api/internal/runs
GET /api/internal/runs/:runId/events
GET /api/internal/events/live
```

`GET /api/internal/events/live` 通过 SSE 流式返回完整 trace events。

`GET /api/internal/runs/:runId/events` 返回某个 run 的历史事件。

`GET /api/internal/runs` 返回最近的 runs：

```json
[
  {
    "runId": "run_123",
    "startedAt": "2026-05-17T12:00:00.000Z",
    "status": "completed",
    "inputPreview": "Why did revenue drop this week?",
    "durationMs": 3200
  }
]
```

## 8. Debug Panel UI 设计

### 8.1 主布局

Panel 应该是一个面向开发者的工作型 UI，不是营销页。

推荐布局：

```text
left sidebar: recent runs
main area: run timeline
right inspector: selected event details
top bar: environment, connection status, filters
```

### 8.2 Run list

Run list 应展示：

- run ID
- start time
- status
- duration
- input preview
- model name，如果可用
- token total，如果可用
- error indicator，如果 run failed

选择某个 run 后，加载它的 event timeline。

### 8.3 Timeline

Timeline 应按顺序展示事件：

- user input
- prompt/skills/tools loading
- model call
- assistant message
- tool call
- tool result
- token usage
- final answer
- errors

每个 timeline item 应包含：

- event type
- timestamp 或 elapsed time
- short summary
- status
- expandable details

### 8.4 Inspector

Inspector 应展示选中事件的完整内容：

- structured JSON
- formatted text preview
- copy-friendly content
- duration 和 metadata
- 相关 ID，例如 `toolCallId`、`step`、`runId`

对于 tool calls，应展示：

- tool name
- input
- result 或 error
- duration

对于 model calls，应展示：

- provider
- model
- prompt token count
- completion token count
- total token count
- duration

### 8.5 Prompt、tools 与 skills 视图

Panel 应为选中的 run 提供一个独立的 context view：

- prompt content
- loaded skills
- registered tools
- model/provider metadata
- environment label

这很重要，因为 prompt engineering 和 skills 预期会成为主要开发与调优界面。

第一版不要求编辑 prompt 和 skills，但必须支持查看它们。

## 9. 初始实现范围

### 9.1 范围内

第一版实现应包括：

- generic trace event types
- trace store
- agent service
- user-facing run API contract
- internal trace API contract
- full trace events 的 live SSE stream
- 按 run ID 获取历史事件
- developer-only debug panel UI
- run list
- event timeline
- event inspector
- prompt/tools/skills display
- 与现有 agent loop 集成
- 足够观察 coding-agent runs 的 instrumentation

### 9.2 范围外

第一版不应包括：

- 完整 consumer dashboard 实现
- dashboard 产品 UI、导航、业务页面或数据可视化
- database write tools
- database agent implementation
- full prompt editing
- full skill editing
- prompt version rollback
- A/B testing
- evaluation datasets
- production-grade trace persistence
- complex multi-agent visualization
- browser-side agent runtime

## 10. 建议仓库结构

如果放在当前仓库中，一个实用结构是：

```text
src/agent/
├─ agent-event.ts
├─ agent.ts
└─ trace/
   ├─ index.ts
   ├─ trace-event.ts
   ├─ trace-store.ts
   └─ trace-middleware.ts

src/server/
├─ index.ts
├─ routes/
│  ├─ agent-runs.ts
│  └─ internal-traces.ts
├─ sse.ts
└─ index.ts

apps/
└─ debug-agent-service/
   ├─ package.json
   ├─ src/
   │  ├─ app.tsx
   │  ├─ server.ts
   │  ├─ routes/
   │  │  ├─ agent-runs.ts
   │  │  └─ internal-traces.ts
   │  ├─ api.ts
   │  ├─ run-list.tsx
   │  ├─ timeline.tsx
   │  └─ inspector.tsx
   └─ index.html
```

如果希望先不引入 `apps/`，也可以把 server 和 panel 先放在 `src/server` 下，通过一个 Bun server 提供 `/internal/debug` 静态页面和 API routes。

不过，具体 app layout 可以等到实现阶段再决定。第一步真正重要的是定义稳定的 trace event contract、debug-agent-service API，并让现有 `Agent.stream()` 可观察。

## 11. 实现阶段

### Phase 1：Runtime trace contract

定义 trace event types 和 trace store。

交付物：

- `TraceEvent` union
- `TraceStore` interface
- in-memory trace store
- trace event helpers
- 针对 append、read、subscribe、unsubscribe 行为的单元测试

### Phase 2：Agent instrumentation

为现有 agent loop 增加 instrumentation。

交付物：

- run lifecycle events
- model lifecycle events
- tool lifecycle events
- token usage events
- error events
- 与现有 CLI/TUI 行为兼容

当前 CLI 可以继续像现在一样消费 `message` events；也可以通过 compatibility layer 在新增 trace events 的同时保留现有行为。

### Phase 3：Debug Agent Service APIs 与 SSE

构建 `debug-agent-service` 的 HTTP/SSE 边界。它同时提供面向 dashboard 的 user-facing APIs，以及面向 debug panel 的 internal trace APIs。

交付物：

- `POST /api/agent/runs`
- `GET /api/agent/runs/:runId/stream`
- `GET /api/internal/events/live`
- `GET /api/internal/runs`
- `GET /api/internal/runs/:runId/events`
- SSE helper
- basic developer authorization check

### Phase 4：Debug Panel UI

构建开发者 panel。

交付物：

- run list
- live connection status
- selected run timeline
- event inspector
- prompt/tools/skills view
- 按 event type 和 status 过滤

### Phase 5：Dashboard contract verification

验证 dashboard 将来调用 debug-agent-service 的契约。这里不实现完整 dashboard 产品，只用脚本、测试或极简 mock 页面触发 agent run，确认 debug panel 能观察同一个 run。

交付物：

- run creation request example
- user-safe output stream
- run ID association
- debug panel 可通过 runId 打开对应 run
- 可选 mock caller，不包含正式 dashboard UI

### Phase 6：Database-agent follow-up

当 debug panel 已经能有效观察现有 agent 后，再添加 database agent。

交付物：

- `src/database/agents/database-agent.ts`
- `list_tables`
- `describe_table`
- `query_database`
- SQL safety checks
- read-only database account support
- SQL tool calls 的 trace events

## 12. Docker 与部署说明

Docker 不应该迫使业务代码进行大规模调整。代码只需要保持 Docker-friendly：

- 从环境变量读取端口
- 从环境变量读取 service URLs
- 从环境变量读取 API keys 和 database credentials
- 避免硬编码 `localhost`
- 避免硬编码本地绝对路径
- 日志输出到 stdout 和 stderr
- 只有在需要持久化本地文件时才使用 volumes

### 12.1 本地开发优先，后续整体迁移到 Docker

前期开发不强制使用 Docker。推荐先在本地启动一个服务：

```text
debug-agent-service
```

必要时再启动一个 mock caller 或可选的 `dashboard-web` 来触发 agent run。

本地开发时可以使用 `localhost` 配置：

```env
PUBLIC_BASE_URL=http://localhost:3001
```

因为 panel 和 agent APIs 在同一个服务中，前端可以优先使用相对路径：

```ts
fetch("/api/internal/events/live")
fetch("/api/agent/runs")
```

只要业务代码不硬编码端口、本机路径或 `localhost`，迁移到 Docker 时主要新增或调整：

```text
Dockerfile
docker-compose.yml
.dockerignore
.env.example
```

不应该因为 Docker 化而重写 panel、agent runtime 或 trace 逻辑。

### 12.2 Docker Compose 形态

MVP 阶段预期 Docker Compose 形态是：

```yaml
services:
  debug-agent-service:
    build: ./apps/debug-agent-service
    ports:
      - "3001:3001"
    environment:
      PORT: 3001
      MODEL_API_KEY: ${MODEL_API_KEY}
      DATABASE_URL: ${DATABASE_URL}
```

如果后续 dashboard 也用 Docker Compose 部署，可以让 dashboard 调用同一个服务：

```text
http://debug-agent-service:3001/api/agent/runs
```

当需要验证 dashboard 调用链路时，用 mock caller 或 dashboard-web 容器触发 `POST /api/agent/runs` 即可。

## 13. 云服务商说明

如果部署面向中国境内，并计划使用 DeepSeek、Qwen、豆包、混元或文心等国内模型 API，中国境内云服务器可能会降低延迟，并简化访问国内模型服务商的链路。

早期实用选择：

- 阿里云 ECS 或轻量应用服务器
- 腾讯云 Lighthouse 或 CVM
- 华为云 Flexus/ECS，适合更偏企业级的部署
- 火山引擎，如果项目更倾向豆包或火山方舟

MVP 阶段，一台简单服务器就足够：

```text
2 vCPU
4 GB RAM
Ubuntu
Docker Compose
```

Debug agent service 可以对外提供受保护的 `/internal/debug` 入口，同时提供 `/api/agent/*` 给 dashboard 或 mock caller 调用。`/api/internal/*` 必须受开发者权限保护，不能被普通 dashboard 用户访问。

如果站点使用中国大陆服务器并通过域名公开访问，可能需要 ICP 备案。

## 14. 待确认问题

实现前需要确认以下决策：

1. `debug-agent-service` 内的 panel 使用什么前端框架和构建方式？
2. `debug-agent-service` 的 server 使用 Bun 原生 HTTP、轻量框架，还是现有项目内模式？
3. dashboard 在本仓库中是否只保留 mock caller，还是完全由外部项目维护？
4. 用什么鉴权机制保护 `/internal/debug` 和 `/api/internal/*`？
5. MVP 阶段 trace events 只存内存，还是立即引入一个简单持久化存储？
6. 第一次真实部署使用哪种模型 provider：DeepSeek 官方 API、阿里云百炼、火山方舟、腾讯云，还是其他 OpenAI-compatible endpoint？

## 15. 当前建议

推荐第一版实现方向是：

```text
先构建一个通用的 Helixent runtime trace viewer。
用现有 coding agent 驱动它。
保持 panel 与 coding/database 概念解耦。
把 Debug Panel UI、agent APIs、trace APIs 和 Helixent runtime 放在同一个 debug-agent-service 中。
dashboard 只作为外部调用方和契约消费者。
只通过 internal APIs 暴露 full trace。
后续 database agent 复用同一套 trace protocol。
```

第一版稳定产品形态应该是：

```text
Dashboard Web
  -> user-facing agent API
  -> sanitized stream/final answer
  -> 本阶段不实现完整产品

Debug Agent Service
  -> /internal/debug panel UI
  -> /api/agent/* user-facing agent API
  -> /api/internal/* internal trace API
  -> full live and historical trace
  -> ReAct loop
  -> model calls
  -> tool calls
  -> trace store
  -> 本阶段重点实现
```

这样可以先为团队建立一个可复用的 agent 可观测性基础，再投入 database-specific tools。只要 `debug-agent-service` 能准确展示现有 agent 的行为，后续 database agent 就可以通过替换 prompt、skills 和 tools 接入，同时保留同一个 debug surface。Dashboard 侧只需要遵守 user-facing API contract，不需要参与 debug panel 的实现。
