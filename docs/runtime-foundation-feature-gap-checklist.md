# Keydex Runtime Foundation Gap Checklist

本文用于讨论 Keydex 下一期基础能力补齐方向。结论基于当前仓库代码与基座项目 `kt-agent-framework` 的运行时能力对照，重点是决定哪些能力符合 Keydex 的产品定位，以及建议采用什么配置方式落地。

## 1. 产品定位判断

Keydex 当前更像一个本地桌面工作台内的 workspace-first agent runtime，而不是企业多租户 Agent 平台。它需要补齐的是本地 agent 的可靠运行、可恢复、低成本旁路任务和可观察能力，而不是完整复刻基座项目里的 scene 版本、灰度、权限、监控聚合、计划任务、业务线等平台管理能力。

下一期应优先补以下基础层：

- 模型角色配置：主执行模型、快速任务模型、辅助/观察模型。
- 运行约束中间件：单轮工具调用上限、重复工具调用保护配置化、后续 subagent 共享预算预留。
- 会话自动标题：由快速任务模型异步生成，失败不影响主对话。
- checkpoint / fork / reverse：把已经存在的 checkpoint 与 session 链路字段真正产品化。
- 上下文压缩：以 checkpoint-safe 的 active session fork 方式实现，而不是原地裁剪历史。
- 中间件事件可见性：中间件动作需要进入实时事件与历史回放，否则用户只能看到结果变化。

## 2. Keydex 当前能力基线

| 能力 | 当前状态 | 代码依据 | 判断 |
| --- | --- | --- | --- |
| 模型供应商管理 | 已有 OpenAI-compatible provider、模型刷新、健康检查、全局默认模型 | `backend/app/api/model_providers.py`, `backend/app/api/settings.py`, `desktop/src/renderer/pages/settings/model/ModelSettingsPage.tsx` | 已可用，但只有全局默认/运行时选择，没有 role-based 模型 |
| 主模型运行选择 | 对话请求携带 `model`，`AgentRunner` 用该模型创建 ChatOpenAI | `backend/app/services/chat_service.py`, `backend/app/agent/runner.py`, `backend/app/agent/factory.py` | 主链路可用 |
| 快速模型 | 无独立配置 | `model_defaults` 目前只实际用于 global default | 缺失 |
| 辅助/观察模型 | 无独立配置，无 observer/sidecar 运行链路 | 当前 runtime 仅主 agent event loop | 缺失 |
| 工具调用上限 | `AppSettings.max_tool_calls` 只影响 LangGraph `recursion_limit`；有重复同参数工具调用保护 | `backend/app/core/config.py`, `backend/app/services/chat_service.py`, `backend/app/agent/middleware.py` | 不是严格工具预算，配置也不在 UI |
| 自动标题 | 新 session 用用户消息截断成标题；支持手动重命名 | `backend/app/services/chat_service.py`, `backend/app/services/session_service.py` | 缺 LLM 标题中间件 |
| checkpoint 存储 | 已有 SQLite LangGraph checkpointer 与 `checkpoints_v2`/`checkpoint_writes_v2` | `backend/app/agent/checkpoint.py`, `backend/app/storage/db.py` | 底座已有 |
| trace 输出 checkpoint | 每轮完成/取消/失败会写 `output_checkpoint_id` 到 trace_record | `backend/app/services/chat_service.py`, `backend/app/storage/repositories.py` | fork/reverse 的数据条件已具备 |
| session 链路字段 | 表结构已有 `active_session_id`、`parent_session_id`、`child_session_id`、`source_checkpoint_id` 等 | `backend/app/storage/db.py`, `backend/app/storage/repositories.py` | 字段存在但业务语义未闭环 |
| session fork | 无对外 API/服务，无法从 turn/trace/checkpoint 派生 | `backend/app/api/sessions.py` | 缺失 |
| reverse / undo | 无 checkpoint 管理与恢复操作 | 当前 API 未暴露 checkpoint | 缺失 |
| 上下文压缩 | 无压缩中间件 | `backend/app/agent/middleware.py` | 缺失 |
| 中间件事件 | DomainEventType 有 middleware 事件，但 projection 未接入，当前中间件也基本不发事件 | `backend/app/events/event_types.py`, `backend/app/events/chat_projection.py`, `backend/app/events/persistence_projection.py` | 协议预留，闭环缺失 |

## 3. 基座项目可借鉴能力

| 基座能力 | 关键做法 | Keydex 借鉴方式 |
| --- | --- | --- |
| `fast_model_config` | scene 上配置 `{model_key, temperature, max_tokens, timeout}`；标题、压缩等旁路任务使用 fast model，可回退主模型 | Keydex 不引入 scene 表，改为模型角色 `fast`；是否回退主模型要显式配置 |
| `observer_model` | 独立 observer 模型做 initial response、status update、progress fact，并把 observer 文案注入后续主链路 | Keydex 可以作为 P1/P2 辅助体验，不应先阻塞 P0 稳定性能力 |
| `MiddlewareBlueprint` | 静态 bundle 汇总压缩、共享工具预算、快速模型、A2UI 等运行时配置 | Keydex 可做轻量版 `RuntimeAgentConfig`，由 SQLite settings + model role defaults 生成 |
| ToolCallLimit | 在 `aafter_model` 检查模型输出工具调用，超过预算直接阻断 | Keydex 应补严格单轮工具预算，不再只靠 recursion_limit |
| SharedToolCallLimit | 主 agent、subagent、dynamic subagent 共享同一 trace 预算 | Keydex 当前无 subagent，先按单 agent 实现，但配置字段预留 shared 语义 |
| AutoTitleMiddleware | 主回复完成后异步生成标题并发 session title update 事件 | Keydex 适合优先实现，收益高、风险低 |
| ContextCompressionMiddleware | `abefore_model` 应用 staging/紧急压缩，`aafter_agent` 后台压缩；压缩后创建新 active session 并切换链路 | Keydex 应采用 checkpoint-safe fork 方案，避免原地改写 checkpoint 导致无法 reverse |
| Trace fork | 从完成态 trace 的 output checkpoint 派生 debug session，复制 checkpoint 与 message_events | Keydex 可以简化成“从此处分支”，不需要 debug scene 语义 |
| Checkpoint clone | 复制指定 checkpoint 到新 thread，失败清理目标 thread | Keydex 需要在 SQLiteCheckpointSaver 上补 clone/list API |

不建议下一期照搬的能力：

- scene 多版本、灰度路由、企业权限、业务线、平台级监控聚合。
- 大型 sandbox/k8s executor 管理。
- 完整 scheduled task 管理台。
- 基座的多后端事件总线。Keydex 当前本地 SQLite + WebSocket 投影足够。

## 4. 推荐配置模型

### 4.1 模型角色

复用现有 `model_defaults.scope`，新增 role scope：

| scope | 语义 | 默认策略 |
| --- | --- | --- |
| `global` | 主执行模型，保持兼容现状 | 必选 |
| `fast` | 快速任务模型，用于标题、压缩摘要、轻量分类 | 可选；未配置时按功能级 fallback 策略处理 |
| `assistant` | 辅助/观察模型，用于初始响应、状态更新、进展归纳 | 可选；未配置则辅助能力关闭 |

每个 role 除 provider/model 外还需要 role-level 参数：

```json
{
  "model_roles": {
    "global": { "provider_id": "...", "model": "...", "temperature": 0.2, "timeout_seconds": 60 },
    "fast": {
      "provider_id": "...",
      "model": "...",
      "temperature": 0.3,
      "max_tokens": 512,
      "timeout_seconds": 30,
      "fallback_to_global": true
    },
    "assistant": {
      "provider_id": "...",
      "model": "...",
      "temperature": 0.5,
      "max_tokens": 768,
      "timeout_seconds": 30,
      "enabled": false
    }
  }
}
```

建议落库：

- 模型选择继续走 `model_defaults(scope, provider_id, model)`。
- role 参数与功能开关放 `settings` 表的新 key：`agent_runtime_settings`。
- 不把这些配置塞进 `.env`。`.env/AppSettings` 只保留服务端硬默认和本地路径等启动项。

### 4.2 运行中间件配置

```json
{
  "runtime_limits": {
    "max_tool_calls_per_turn": 80,
    "shared_tool_call_limit": 80,
    "duplicate_tool_repeat_limit": 3,
    "tool_timeout_seconds": 120,
    "recursion_limit_multiplier": 2
  },
  "auto_title": {
    "enabled": true,
    "model_role": "fast",
    "only_when_title_is_default": true,
    "max_title_chars": 20
  },
  "context_compression": {
    "enabled": false,
    "model_role": "fast",
    "retain_turns": 2,
    "trigger_fraction": 0.75,
    "emergency_fraction": 0.9,
    "mode": "active_session_fork"
  },
  "assistant_observer": {
    "enabled": false,
    "model_role": "assistant",
    "initial_response": true,
    "status_update": true,
    "progress_fact": true,
    "idle_window_ms": 8000
  }
}
```

配置优先级建议：

1. 单轮请求可选择主模型，但不能绕过安全/预算/压缩配置。
2. SQLite settings 是用户可见的真实配置源。
3. `.env/AppSettings` 只作为没有 settings 时的默认值。

## 5. 下一期功能清单

### P0: 运行可靠性与低成本旁路任务

- [ ] 新增 `agent_runtime_settings` schema、API、前端设置入口。
- [ ] 扩展模型设置为 role-based：主模型、快速模型、辅助模型。
- [ ] 新增严格单轮工具调用预算中间件。
- [ ] 将重复工具调用阈值配置化。
- [ ] 工具预算/重复阻断需要发 middleware 事件，并进入历史回放。
- [ ] 新增 AutoTitle 服务/中间件：使用 fast model，异步写回 session title。
- [ ] WebSocket/前端补 `session.title_updated` 事件，侧栏标题实时更新。
- [ ] LLM side task 计入 `llm_request_logs`，区分 `main/title/compression/assistant` request kind。

验收标准：

- 用户能在设置里配置主模型和快速模型。
- 超过工具调用上限时，本轮明确失败，历史里能看到原因。
- 新会话首轮完成后标题可自动更新，失败不影响主回复。
- 所有新增能力无 mock fallback，配置缺失时行为明确。

### P1: Checkpoint 产品化与可恢复

- [ ] 新增 `CheckpointService`：list latest/list by session/get metadata/clone to session。
- [ ] 新增 session fork API：从最新 checkpoint、指定 trace、指定 turn 派生新 session。
- [ ] fork 时复制 checkpoint，并复制 fork 点之前的 message_events。
- [ ] 新增 UI 操作：“从这里分支”。
- [ ] 新增 reverse 语义：默认不做破坏性删除，而是从目标 checkpoint 创建新的 active branch。
- [ ] session 列表/详情展示 branch 来源：source trace、source checkpoint、parent/child。

验收标准：

- 任意完成 turn 后可以从该 turn 派生新会话继续问。
- 原会话历史不被破坏。
- fork 后续聊使用 fork 点 checkpoint，而不是重新拼历史。
- reverse 后仍可回到原分支或查看原分支。

### P1: 上下文压缩

- [ ] 基于 fast model 实现压缩 side task。
- [ ] 补 model context window 配置；至少支持手动配置 context window tokens。
- [ ] 压缩策略采用 `active_session_fork`，不原地覆盖原 session checkpoint。
- [ ] `aafter_agent` 后台压缩，下一轮 `abefore_model` 应用压缩结果。
- [ ] 保留最近 N 轮原始消息，旧消息替换为压缩摘要。
- [ ] 压缩结果与 active session 切换写入中间件事件。

验收标准：

- 长对话达到阈值后自动生成压缩结果。
- 下一轮请求使用压缩后的 checkpoint。
- parent/child 链路可回溯，reverse/fork 不受压缩破坏。

### P2: 辅助/观察模型

- [ ] 定义辅助模型的产品边界：只做过程提示，不替代主回复。
- [ ] 初始响应：主 agent 启动前给用户短反馈。
- [ ] 状态更新：长时间无输出时说明仍在处理。
- [ ] 进展事实：工具有结果但主回复未形成时，归纳已确认事实。
- [ ] 将辅助模型输出注入后续主 agent 上下文，避免主回复与已展示过程信息冲突。

验收标准：

- 长工具调用期间用户能看到有意义的过程反馈。
- 辅助模型失败不影响主对话。
- 主回复不会机械重复辅助提示，也不会与已展示事实冲突。

## 6. 建议开发顺序

1. 先做配置骨架：`agent_runtime_settings` + model role scopes。
2. 再做工具预算中间件和 middleware event projection。
3. 然后做 AutoTitle，因为它最能验证 fast model、side task、title update、LLM log 这条旁路链。
4. 接着做 CheckpointService + fork API，这是 reverse 和 compression 的共同前置。
5. 在 fork 能力稳定后做 active-session compression。
6. 最后做 assistant observer，因为它体验价值高，但会增加 prompt 注入、流式事件、cache 稳定性和 UI 解释成本。

## 7. 需要继续讨论的决策点

- 快速模型未配置时，标题/压缩是否允许回退主模型？建议标题可以显式回退，压缩默认不回退，避免昂贵主模型被后台任务消耗。
- reverse 的用户语义是“撤销当前会话到某一轮”，还是“从某一轮创建新分支并切过去”？建议默认采用后者，避免破坏历史。
- 是否现在就引入 context window 模型元数据？如果要做压缩，至少需要最小版本。
- 辅助模型是否进入下一期首批 scope？建议先完成 P0/P1 的可恢复链路，再做 observer。
- 中间件事件在 UI 中展示为独立块，还是并入状态/ghost footer？建议工具预算和压缩需要独立块，标题生成只需要侧栏事件。
