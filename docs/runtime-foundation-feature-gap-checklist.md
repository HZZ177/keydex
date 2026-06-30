# Keydex Runtime Foundation Gap Checklist

本文用于讨论 Keydex 下一期基础能力补齐方向。结论基于当前仓库代码与基座项目 `kt-agent-framework` 的运行时能力对照，重点是决定哪些能力符合 Keydex 的产品定位，以及建议采用什么配置方式落地。

## 1. 产品定位判断

Keydex 当前更像一个本地桌面工作台内的 workspace-first agent runtime，而不是企业多租户 Agent 平台。它需要补齐的是本地 agent 的可靠运行、可恢复、低成本旁路任务和可观察能力，而不是完整复刻基座项目里的 scene 版本、灰度、权限、监控聚合、计划任务、业务线等平台管理能力。

本期已经落地的基础层：

- 模型默认值配置：默认对话模型 `default_chat`、快速模型 `fast`。供应商配置只决定供应商/模型启用范围；对话每轮必须显式传 `provider_id + model`，不做自动降级或隐式回退。
- 扩展功能配置：自动标题、单轮工具调用上限、重复工具调用保护、上下文压缩。
- 会话自动标题：由快速模型异步生成，失败不影响主对话。
- checkpoint / fork / reverse：完成态 trace 可从 checkpoint 派生分支；reverse 在原 session 内回退到用户消息发送前的 checkpoint。
- 上下文压缩：以 checkpoint-safe 的 active session fork 方式实现，不原地裁剪原会话历史。
- 系统消息可见性：系统提示进入实时投影与历史回放，用于压缩成功/失败、Skill 激活等轻量提示。

本期明确不做：

- observer/assistant 模型。Keydex 是个人 agent 助手，不需要像 C 端产品一样为 20 秒等待额外启动观察者模型。
- 企业基座级 trace 追踪、middleware event 投影看板、业务线/灰度/权限/平台监控聚合。

## 2. Keydex 当前能力基线

| 能力 | 当前状态 | 代码依据 | 判断 |
| --- | --- | --- | --- |
| 模型供应商管理 | 已有 OpenAI-compatible provider、模型刷新、健康检查、供应商/模型启停 | `backend/app/api/model_providers.py`, `backend/app/api/settings.py`, `desktop/src/renderer/pages/settings/model/ModelSettingsPage.tsx` | 供应商配置只负责启用范围，不负责默认模型 |
| 对话模型运行选择 | 对话请求携带 `provider_id + model`，`AgentRunner` 用显式选择创建 ChatOpenAI；session 记住切换后的当前模型 | `backend/app/services/chat_service.py`, `backend/app/agent/runner.py`, `backend/app/agent/factory.py` | 主链路可用，缺参显式报错 |
| 快速模型 | 独立默认值配置 `fast` | `model_defaults` 表、`backend/app/model/defaults.py`、`backend/app/agent/side_task_model.py` | 用于标题生成、上下文压缩等 side task |
| 辅助/观察模型 | 无独立配置，无 observer/sidecar 运行链路 | 当前 runtime 仅主 agent event loop | 缺失 |
| 工具调用上限 | `AppSettings.max_tool_calls` 只影响 LangGraph `recursion_limit`；有重复同参数工具调用保护 | `backend/app/core/config.py`, `backend/app/services/chat_service.py`, `backend/app/agent/middleware.py` | 不是严格工具预算，配置也不在 UI |
| 自动标题 | 新 session 用用户消息截断成标题；支持手动重命名 | `backend/app/services/chat_service.py`, `backend/app/services/session_service.py` | 缺 LLM 标题中间件 |
| checkpoint 存储 | 已有 SQLite LangGraph checkpointer 与 `checkpoints_v2`/`checkpoint_writes_v2` | `backend/app/agent/checkpoint.py`, `backend/app/storage/db.py` | 底座已有 |
| trace 输入/输出 checkpoint | 每轮开始前写 `input_checkpoint_id`，完成/取消/失败后写 `output_checkpoint_id` 到 trace_record | `backend/app/services/chat_service.py`, `backend/app/storage/repositories.py` | fork 使用输出 checkpoint；reverse 使用输入 checkpoint |
| session 链路字段 | 表结构已有 `active_session_id`、`parent_session_id`、`child_session_id`、`source_checkpoint_id` 等 | `backend/app/storage/db.py`, `backend/app/storage/repositories.py` | 字段存在但业务语义未闭环 |
| session fork | 无对外 API/服务，无法从 turn/trace/checkpoint 派生 | `backend/app/api/sessions.py` | 缺失 |
| reverse / undo | 无 checkpoint 管理与恢复操作 | 当前 API 未暴露 checkpoint | 缺失 |
| 上下文压缩 | 无压缩中间件 | `backend/app/agent/middleware.py` | 缺失 |
| 中间件事件 | DomainEventType 有 middleware 事件，但 projection 未接入，当前中间件也基本不发事件 | `backend/app/events/event_types.py`, `backend/app/events/chat_projection.py`, `backend/app/events/persistence_projection.py` | 协议预留，闭环缺失 |

## 3. 基座项目可借鉴能力

| 基座能力 | 关键做法 | Keydex 借鉴方式 |
| --- | --- | --- |
| `fast_model_config` | scene 上配置 `{model_key, temperature, max_tokens, timeout}`；标题、压缩等旁路任务使用 fast model | Keydex 不引入 scene 表，改为模型默认值 `fast`；不做对话模型/默认对话模型 fallback，缺失时按功能语义显式失败或跳过 |
| `observer_model` | 独立 observer 模型做 initial response、status update、progress fact，并把 observer 文案注入后续主链路 | Keydex 本期不做。个人 agent 助手可以接受主链路等待，不需要 C 端式快速 observer 响应 |
| `MiddlewareBlueprint` | 静态 bundle 汇总压缩、共享工具预算、快速模型、A2UI 等运行时配置 | Keydex 可做轻量版 `RuntimeAgentConfig`，由 SQLite settings + model defaults 生成 |
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

### 4.1 模型默认值

复用 `model_defaults(scope, provider_id, model)`，但 scope 语义调整为用户可理解的默认值：

| scope | 语义 | 默认策略 |
| --- | --- | --- |
| `default_chat` | 默认对话模型，只决定新建 session 时前端默认选中项 | 建议配置；对话框可随时切换。chat 请求缺少 `provider_id + model` 时后端显式报错，不读取该默认值兜底 |
| `fast` | 快速模型，用于标题生成、上下文压缩摘要等 side task | 必选于启用相关功能；缺失时不回退主模型 |

每个默认值只保存 provider/model 绑定。旁路任务参数由扩展功能配置保存：

```json
{
  "model_defaults": {
    "default_chat": { "provider_id": "...", "model": "..." },
    "fast": { "provider_id": "...", "model": "..." }
  }
}
```

建议落库：

- 模型选择继续走 `model_defaults(scope, provider_id, model)`。
- 功能开关与参数放 `settings` 表的 `agent_runtime_settings`。
- 不把这些配置塞进 `.env`。`.env/AppSettings` 只保留服务端硬默认和本地路径等启动项。

### 4.2 运行中间件配置

```json
{
  "auto_title": {
    "enabled": true,
    "only_when_default_title": true,
    "max_title_length": 40
  },
  "tool_call_limit": {
    "enabled": true,
    "max_tool_calls": 80,
    "exit_behavior": "error"
  },
  "duplicate_tool_call_guard": {
    "enabled": true,
    "max_repeats": 3
  },
  "context_compression": {
    "enabled": false,
    "context_window_tokens": 128000,
    "trigger_fraction": 0.75,
    "emergency_fraction": 0.9,
    "retain_rounds": 2
  }
}
```

配置优先级建议：

1. 单轮请求必须显式传入 `provider_id + model`，可以选择不同供应商的不同模型，但不能绕过安全/预算/压缩配置。
2. SQLite settings 是用户可见的真实配置源。
3. `.env/AppSettings` 只作为没有 settings 时的默认值。
4. 默认对话模型只影响前端新 session 初始选择，不作为后端 chat 缺参兜底。

## 5. 本期功能清单与状态

### P0: 运行可靠性与低成本旁路任务

- [x] 新增 `agent_runtime_settings` schema、API、前端设置入口。
- [x] 扩展模型设置为默认值：默认对话模型、快速模型。
- [x] 新增严格单轮工具调用预算中间件。
- [x] 将重复工具调用阈值配置化。
- [x] 工具预算/重复阻断进入实时错误和历史回放。
- [x] 新增 AutoTitle 服务/中间件：使用 fast model，异步写回 session title。
- [x] WebSocket/前端补 `session.title_updated` 事件，侧栏标题实时更新。
- [ ] LLM side task 请求分类统计可继续增强；当前 E2E fake transport 已覆盖标题/压缩 side task 的 deterministic 输出。

验收标准：

- 用户能在设置里配置默认对话模型和快速模型。
- 超过工具调用上限时，本轮明确失败，历史里能看到原因。
- 新会话首轮完成后标题可自动更新，失败不影响主回复。
- 所有新增能力无 mock fallback，配置缺失时行为明确。

### P1: Checkpoint 产品化与可恢复

- [x] 新增 `CheckpointService`：resolve/list/clone/reverse 所需的 checkpoint 操作。
- [x] 新增 session fork API：从指定 trace/turn 派生新 session。
- [x] fork 时复制 checkpoint，并复制 fork 点之前的 message_events。
- [x] 新增 UI 操作：“从这里继续”。
- [x] 新增 reverse 语义：从用户消息所在轮次的 input checkpoint 回退，并删除该轮及之后的事件/trace。
- [x] 会话详情保留 branch 来源字段：source trace、source checkpoint、parent/child。

验收标准：

- 任意完成 turn 后可以从该 turn 派生新会话继续问。
- 原会话历史不被破坏。
- fork 后续聊使用 fork 点 checkpoint，而不是重新拼历史。
- reverse 后当前 session 历史截断到目标轮之前，并可继续在同一 session 对话。

### P1: 上下文压缩

- [x] 基于 fast model 实现压缩 side task。
- [x] 补手动 `context_window_tokens` 配置。
- [x] 压缩策略采用 `active_session_fork`，不原地覆盖原 session checkpoint。
- [x] 使用 ChatService after-turn 压缩；下一轮请求通过 source `active_session_id` 自动进入压缩分支。
- [x] 保留最近 N 轮原始消息，旧消息替换为压缩摘要。
- [x] 压缩结果与 active session 切换写入系统提示和历史回放。

验收标准：

- 长对话达到阈值后自动生成压缩结果。
- 下一轮请求使用压缩后的 checkpoint。
- parent/child 链路可回溯，reverse/fork 不受压缩破坏。

### P2: 辅助/观察模型（本期不做）

- [ ] 定义辅助模型的产品边界：只做过程提示，不替代主回复。
- [ ] 初始响应：主 agent 启动前给用户短反馈。
- [ ] 状态更新：长时间无输出时说明仍在处理。
- [ ] 进展事实：工具有结果但主回复未形成时，归纳已确认事实。
- [ ] 将辅助模型输出注入后续主 agent 上下文，避免主回复与已展示过程信息冲突。

验收标准：

- 长工具调用期间用户能看到有意义的过程反馈。
- 辅助模型失败不影响主对话。
- 主回复不会机械重复辅助提示，也不会与已展示事实冲突。

## 6. 实际开发顺序

1. 配置骨架：`agent_runtime_settings` + `main/fast` model role scopes。
2. 扩展功能：工具预算、重复工具保护、AutoTitle。
3. CheckpointService + fork/reverse API 与前端操作。
4. active-session context compression。
5. E2E fake transport、runtime foundation 脚本集合与旧配置隔离回归。

## 7. 已确认决策

- 快速模型未配置时不回退主模型。标题生成缺失 fast 时跳过或失败记录，不影响主对话；压缩缺失 fast 时显示压缩失败并继续使用当前上下文。
- reverse 的用户语义采用“回退到用户消息发送前”，在当前 session 内删除该轮及之后的消息/trace，不创建分支。
- 上下文压缩已引入手动 `context_window_tokens`，本期不做 provider 自动上下文窗口探测。
- 辅助/观察模型不进入本期 scope。Keydex 不需要对标企业基座和 C 端 observer 响应链路。
- 系统提示采用轻量实时 `system_message` + 历史回放，不做企业级 middleware trace 看板。

## 8. 当前实现与验证入口

本期实现范围：

- 供应商配置与模型配置拆分；模型配置页管理 `main`/`fast` role。
- 扩展功能页管理自动标题、单轮工具调用上限、重复工具调用保护、上下文压缩。
- 自动标题和上下文压缩使用快速模型 side task。
- 工具调用上限在单轮内严格阻断，阻断后本轮失败可见。
- Session fork 基于完成态 trace/checkpoint 创建新分支；reverse 基于 input checkpoint 在当前 session 内真实回退。
- 上下文压缩基于 active session fork：源会话记录压缩成功/失败提示，压缩分支写入摘要并保留最近轮次。
- E2E fake model transport 在 `KEYDEX_E2E_MODEL_TRANSPORT=true` 时启用，覆盖主链路流式输出和快速模型非流式 side task。

主要验证入口：

```powershell
.venv\Scripts\python.exe -m pytest backend/tests/model backend/tests/agent/test_side_task_model.py backend/tests/services/test_session_title_service.py backend/tests/services/test_context_compression_service.py
pnpm --dir desktop exec vitest run tests/model-settings-page.spec.tsx tests/runtime-model-selector.spec.tsx tests/extension-settings-page.spec.tsx tests/agent-session-store.spec.ts
pnpm run test:e2e:runtime-foundation
```

`pnpm run test:e2e:runtime-foundation` 不是默认 verify 的一部分，按需执行，避免日常验证成本过高。
