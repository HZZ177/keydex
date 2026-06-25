# Codex 工具栈深度分析与 Keydex 工具改造报告

日期：2026-06-24  
工作区：`D:\Pycharm Projects\keydex`  
Codex 对照基线：本机安装 `codex-cli 0.115.0`，源码 tag `rust-v0.115.0`，commit `f028679abb30051cec2434e624cd99975986b41b`

> 说明：本机 `C:\Users\86364\.codex\version.json` 记录过 `latest_version=0.124.0`，但当前实际安装命令行为 `0.115.0`。本报告优先分析“当前可运行 Codex”的源码，避免拿一个未安装版本做错误对照。后续如果升级到 0.124.0，应再做一次增量 diff。

## 1. 总结结论

Keydex 现在不是“工具少一点”的问题，而是缺少 Codex 那种完整工具系统分层。

当前 Keydex 的工具主要是：

- `FunctionTool` 注册表
- 直接执行 Python handler
- LangChain `StructuredTool` 包装
- 通过 LangChain 事件把 `tool_start/tool_end/tool_progress` 映射到 UI

Codex 的工具系统是：

- 模型可见的 ToolSpec 构建层
- ToolHandler 注册和 dispatch 层
- mutating tool gate、hook、telemetry 层
- approval / sandbox / network policy / retry 运行时层
- shell session / PTY / stdin / output chunk 进程层
- patch 语法解析与预校验层
- UI event / TurnDiff / command item 渲染层
- app-server 的非模型文件系统、命令、fuzzy search、git 辅助 API

因此 Keydex 现在的使用体验差，核心原因不是单个工具描述写得不够好，而是：

1. `run_command` 没有会话、stdin、PTY、chunk、可轮询输出，复杂命令和交互流程天然难用。
2. `apply_patch` 只是模拟 Codex patch 外形，没有真正的 hunk/parser/seek 机制，稳定性差。
3. `read_file/list_directory/search_*` 输出形态偏 API JSON，不是模型友好的“行号文本 + 路径发现 + 分页”组合。
4. 缺少 `grep_files` 这种“先找文件路径，再读文件”的专用搜索工具。
5. 缺少动态工具发现、MCP resource、用户确认、权限申请等协作工具。
6. 当前 `write_file` 和 `apply_patch` 已经被 UI 流式进度协议依赖，不能简单删除或改名。

最重要的兼容要求：

- 保留 `write_file` 工具名、`path/content/append` 入参兼容、返回中的 `files` 数组。
- 保留 `apply_patch` 工具名、`patch` 入参兼容、返回中的 `changes` 和 `files` 数组。
- 文件变更对象至少继续包含 `path/operation/added_lines/deleted_lines/removed_lines/additions/deletions/diff`。
- `backend/app/agent/tool_call_progress.py` 和 `backend/app/agent/event_processor.py` 当前会解析 `write_file/apply_patch` 流式参数和结构化输出，改造时必须同步迁移。

建议路线：

1. 先复刻 Codex 的文件阅读、目录列举、路径搜索、patch parser，立刻改善模型理解和编辑稳定性。
2. 再新增 `exec_command/write_stdin`，把 `run_command` 降级为兼容 wrapper。
3. 然后重构工具运行时，引入 mutating gate、权限策略、进程 session、事件模型。
4. 最后补动态工具发现、MCP、非模型 FS RPC、fuzzy search 和 git 辅助 API。

## 2. Codex 工具栈源码结构

### 2.1 ToolSpec 构建层

Codex 的模型可见工具不是散落注册的函数，而是通过 `core/src/tools/spec.rs` 统一构建。

关键对象：

- `ToolsConfig`：根据模型家族、feature flag、approval 设置、MCP、app tools、dynamic tools 决定本 turn 暴露哪些工具。
- `build_specs_with_discoverable_tools`：构建模型可见 ToolSpec，同时生成 handler registry。
- `ResponsesApiTool`：普通 JSON function tool。
- `FreeformTool`：自定义自由格式工具，`apply_patch` 在 GPT-5 路径上使用这个形式。
- `ToolSpec` 输出 schema：部分工具显式声明 output schema，例如 `exec_command/write_stdin`。

这个设计的意义是：工具是否出现、工具描述、工具参数、工具 handler、工具 output schema 由同一处治理，而不是每个 handler 自己决定。

### 2.2 ToolHandler / Registry dispatch 层

Codex 的 `core/src/tools/registry.rs` 定义了 `ToolHandler` trait。

核心能力：

- `kind()`：区分 Function / MCP 等工具类型。
- `matches_kind()`：防止用错误 payload 类型调用工具。
- `is_mutating()`：判断工具是否可能修改用户环境。源码注释强调“有疑问就返回 true”。
- `handle()`：执行真实工具逻辑。
- `dispatch_any()`：
  - 查找 handler。
  - 统计 tool call。
  - 对 mutating tool 等待 `turn.tool_call_gate`。
  - 记录 telemetry。
  - 执行 AfterToolUse hook。
  - 将工具输出统一转换为模型响应。

Keydex 目前的 `ToolRegistry` 只是 `name -> FunctionTool`，没有 tool kind、namespace、mutating gate、hook，也没有 output 类型抽象。

### 2.3 ToolRuntime / approval / sandbox 层

Codex 的 `core/src/tools/orchestrator.rs` 明确写了职责：审批、沙箱选择、重试语义的中心。

运行时流程大致是：

1. 判断是否需要 approval。
2. 根据工具偏好、文件系统 sandbox、network sandbox 选择第一次执行的 sandbox。
3. 执行工具。
4. 如果因为 sandbox 或 network 被拒绝，根据策略决定是否请求升级权限。
5. 获批后无 sandbox 或升级 sandbox 重试。
6. 记录事件和工具输出。

相关抽象在 `core/src/tools/sandboxing.rs`：

- `Approvable`
- `Sandboxable`
- `ToolRuntime`
- `ExecApprovalRequirement`
- approval cache
- additional permissions

Keydex 现在只有 workspace path 限制和 shell deny list，没有统一 approval/sandbox/runtime 抽象。

### 2.4 事件与 UI 输出层

Codex 的工具输出并不只是返回字符串。它同时产生：

- 模型可读 output
- app UI 可渲染 event
- command execution item
- patch begin/end event
- TurnDiff
- approval request event
- MCP event

`core/src/tools/context.rs` 里的 `ToolOutput` 负责把各类工具结果转换为 Response API item。`ExecCommandToolOutput` 会输出稳定文本结构：

```text
Command: ...
Chunk ID: ...
Wall time: ...
Process exited with code ...
Process running with session ID ...
Original token count: ...
Output:
...
```

这个结构对模型很重要：模型能清楚判断命令是否结束、是否还要轮询、输出是否被截断。

Keydex 当前工具输出多为 JSON 字符串，UI 事件主要由 LangChain 的 `on_tool_start/on_tool_end` 推导；对 shell 长输出、运行中进程、patch diff 的表达不够完整。

## 3. Codex 模型可见工具详解

### 3.1 `exec_command`

源码位置：

- `core/src/tools/spec.rs`
- `core/src/tools/handlers/unified_exec.rs`
- `core/src/unified_exec/process_manager.rs`
- `core/src/tools/runtimes/unified_exec.rs`

模型可见描述：

> Runs a command in a PTY, returning output or a session ID for ongoing interaction.

主要参数：

| 参数 | 含义 |
| --- | --- |
| `cmd` | 要执行的 shell command，必填 |
| `workdir` | 工作目录，默认 turn cwd |
| `shell` | 指定 shell binary，默认用户 shell |
| `tty` | 是否分配 TTY / PTY |
| `yield_time_ms` | 等待输出多久后返回 |
| `max_output_tokens` | 返回给模型的最大 token 数，超出截断 |
| `login` | 是否使用 login / interactive shell 语义，按配置开放 |
| `sandbox_permissions` | 请求沙箱权限覆盖 |
| `justification` | 请求权限理由 |
| `prefix_rule` | approval 复用规则 |
| `additional_permissions` | 额外文件/网络权限，按配置开放 |

运行时设计：

- 命令执行不是简单 `subprocess.run`，而是走 `UnifiedExecProcessManager`。
- 如果命令在 `yield_time_ms` 内结束，返回 `exit_code`。
- 如果命令仍在运行，返回 `session_id`，模型后续用 `write_stdin` 继续交互或轮询。
- 支持 PTY 和普通 pipe 两种模式。
- 输出带 `chunk_id`，便于 UI 和模型追踪连续输出。
- 设置稳定环境变量，例如 `NO_COLOR=1`、`TERM=dumb`、`CODEX_CI=1`，降低模型解析噪音。
- 返回中包含 `original_token_count`，让模型知道输出被截断前规模。
- 执行前会通过 approval/sandbox/runtime。
- 如果模型试图通过 shell 调 `apply_patch`，Codex 会拦截并提示应使用 `apply_patch` 工具。

为什么好用：

- 长命令不会被一次 timeout 直接杀死。
- dev server、测试 watcher、交互 REPL 可以留 session。
- 模型能通过 `session_id` 判断下一步。
- 非 0 exit 仍可把 stdout/stderr 结构化返回给模型，而不是只抛异常。

Keydex 当前差距：

- `run_command` 一次性执行，默认 timeout，不能保留进程。
- 没有 `write_stdin`。
- 没有 PTY。
- 没有 `chunk_id/session_id/original_token_count`。
- 非 0 退出被包装为失败，容易让模型丢失有价值输出。
- deny list 用字符串片段硬拦 `curl/wget` 等，不能表达真实权限策略。

### 3.2 `write_stdin`

源码位置：

- `core/src/tools/spec.rs`
- `core/src/tools/handlers/unified_exec.rs`
- `core/src/unified_exec/process_manager.rs`

模型可见描述：

> Writes characters to an existing unified exec session and returns recent output.

主要参数：

| 参数 | 含义 |
| --- | --- |
| `session_id` | `exec_command` 返回的运行中进程 ID |
| `chars` | 写入 stdin 的字符；为空时相当于 poll |
| `yield_time_ms` | 写入后等待输出多久 |
| `max_output_tokens` | 输出 token 上限 |

运行时设计：

- 根据 `session_id` 找到运行中的进程。
- 写入 stdin 或仅轮询输出。
- 返回新 `chunk_id`、当前输出、进程是否退出、退出码。
- 对未知 session、已结束 session 给明确错误。

Keydex 必须新增这个工具，否则 shell 能力始终无法接近 Codex。

### 3.3 `apply_patch`

源码位置：

- `core/src/tools/handlers/apply_patch.rs`
- `core/src/tools/handlers/tool_apply_patch.lark`
- `apply-patch/src/parser.rs`
- `apply-patch/src/lib.rs`
- `apply-patch/src/seek_sequence.rs`
- `apply-patch/src/invocation.rs`

模型可见描述：

> Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.

Codex 的 GPT-5 路径使用 Freeform Tool，语法由 Lark grammar 约束：

```text
start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?
change_move: "*** Move to: " filename LF
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF
```

能力点：

- `*** Add File`
- `*** Delete File`
- `*** Update File`
- `*** Move to` 重命名
- 多个 file op
- 多个 hunk
- `@@` 上下文锚点
- `*** End of File`
- 通过 `seek_sequence` 在真实文件内搜索上下文，而不是简单字符串替换
- 执行前先 parse 和 correctness verify
- 计算 affected paths，用于权限和 sandbox
- 可拦截 shell 里的 `apply_patch` 调用，引导模型使用专用工具
- 成功后产生 patch events 和 TurnDiff

为什么稳定：

- patch 是一门小语法，不是让模型自由输出 unified diff。
- hunk 定位有上下文搜索，不依赖整段 old block 逐字唯一匹配。
- rename/delete/add/update 都在同一 parser 里统一处理。
- 错误能分为 parse error、context mismatch、workspace/path error、IO error。

Keydex 当前差距：

- 当前 `backend/app/tools/patch.py` 支持 Add/Update/Delete 的外形，但 update 实际上把所有 `-` 和空格行拼成一个 `old_block`，把 `+` 和空格行拼成 `new_block`，然后 `original.replace(old_block, new_block, 1)`。
- 不支持 `*** Move to`。
- 不支持真实多 hunk 定位。
- 不支持 `*** End of File`。
- 对重复代码块、局部上下文、函数锚点的鲁棒性弱。
- 顺序应用时如果后续 op 失败，存在部分修改风险，需要 preflight 或 rollback。
- 当前测试里 add/delete 的 completed result 经过 `finalize_file_change` 后 `operation` 仍可能是 `update`，这是 UI 兼容历史，不应扩散为长期语义。

### 3.4 `read_file`

源码位置：

- `core/src/tools/spec.rs`
- `core/src/tools/handlers/read_file.rs`

模型可见描述：

> Reads a local file with 1-indexed line numbers, supporting slice and indentation-aware block modes.

主要参数：

| 参数 | 含义 |
| --- | --- |
| `file_path` | 文件绝对路径 |
| `offset` | 1-indexed 起始行 |
| `limit` | 最大行数 |
| `mode` | `slice` 或 `indentation` |
| `indentation.anchor_line` | 缩进感知读取锚点 |
| `indentation.max_levels` | 向上包含多少父缩进层级 |
| `indentation.include_siblings` | 是否包含同级块 |
| `indentation.include_header` | 是否包含注释/attribute header |
| `indentation.max_lines` | 缩进模式硬上限 |

输出形态：

```text
L10: def foo():
L11:     ...
```

关键实现：

- 行号从 1 开始。
- 每行最长显示 500 字符，避免单行爆上下文。
- `slice` 读取普通窗口。
- `indentation` 以锚点行为中心扩展到代码块，适合模型读取函数/类上下文。
- 使用 lossy UTF-8，而不是直接因编码失败崩掉。

Keydex 当前差距：

- 当前 `read_file` 返回 JSON `{content,start_line,max_lines,total_lines...}`，模型要自己数行。
- 参数是 `path/start_line/max_lines`，没有 `offset/limit/mode`。
- UTF-8 严格解码，遇到非 UTF-8 容易失败。
- 没有缩进感知读取。
- 文件大小限制 512KB 偏小，且没有按行输出的截断策略。

### 3.5 `list_dir`

源码位置：

- `core/src/tools/spec.rs`
- `core/src/tools/handlers/list_dir.rs`

模型可见描述：

> Lists entries in a local directory with 1-indexed entry numbers and simple type labels.

主要参数：

| 参数 | 含义 |
| --- | --- |
| `dir_path` | 目录绝对路径 |
| `offset` | 1-indexed 起始 entry |
| `limit` | 最大 entry 数 |
| `depth` | 最大遍历深度 |

输出形态：

```text
Absolute path: /repo
src/
  main.rs
README.md
More than 25 entries found
```

关键实现：

- 支持 depth，默认 2。
- 支持 offset/limit 分页。
- 目录加 `/`，symlink 加 `@`，特殊类型加 `?`。
- 输出是模型友好的文本树，而不是只返回 direct children JSON。

Keydex 当前差距：

- 当前 `list_directory` 只列直接子节点。
- 无 depth、offset、limit 分页。
- 输出 JSON 对 UI 友好，但对模型扫描结构不如文本树直观。

### 3.6 `grep_files`

源码位置：

- `core/src/tools/spec.rs`
- `core/src/tools/handlers/grep_files.rs`

模型可见描述：

> Finds files whose contents match the pattern and lists them by modification time.

主要参数：

| 参数 | 含义 |
| --- | --- |
| `pattern` | 正则搜索模式 |
| `include` | 可选 glob，例如 `*.rs` 或 `*.{ts,tsx}` |
| `path` | 搜索目录/文件，默认 cwd |
| `limit` | 最大返回路径数，默认 100，最大 2000 |

关键实现：

Codex 调用：

```text
rg --files-with-matches --sortr=modified --regexp <pattern> --no-messages --glob <include> -- <path>
```

特点：

- 返回“文件路径列表”，不是每一行匹配。
- 按修改时间排序，最近相关文件靠前。
- 30 秒 timeout。
- `rg` exit code 1 视为无结果，不当作失败。
- 这是路径发现工具，后续配合 `read_file` 精读。

Keydex 当前差距：

- `search_text` 返回行级 snippet，适合确认细节，但不适合第一步找文件集合。
- `search_files` 是名称/路径 substring，不是内容搜索。
- `search_text` 的 `rg --max-count` 语义容易和全局 limit 混淆；Codex 是先 files-with-matches 再截断。

### 3.7 `update_plan`

源码位置：

- `core/src/tools/handlers/plan.rs`

模型可见描述：

> Updates the task plan. Provide an optional explanation and a list of plan items, each with a step and status. At most one step can be in_progress at a time.

设计要点：

- 输入对客户端 UI 有用，输出只需要“Plan updated”。
- 约束最多一个 `in_progress`。
- 在 Codex 的部分模式中禁用。
- 这是协作/UI 工具，不是业务逻辑工具。

Keydex 当前 `update_plan` 接近可用，甚至已经返回 `ui_payload/summary`。主要问题不是工具本身，而是整体工具体系未形成。

### 3.8 `tool_search`

源码位置：

- `core/src/tools/handlers/tool_search.rs`
- `core/templates/search_tool/tool_description.md`

模型可见描述要点：

- 对 app / connector tool metadata 做 BM25 搜索。
- 暴露匹配工具给下一次模型调用。
- 对 Apps/connectors 的工具发现，应使用 `tool_search`，而不是直接扫 MCP resources。

设计目的：

- 不把所有 app/connector/MCP 工具一次性塞进模型上下文。
- 按 query 延迟加载。
- 搜索内容包括 tool 描述、schema properties、namespace。

Keydex 当前没有动态工具发现。如果未来会有插件、MCP、业务工具市场，这个必须复刻；否则模型上下文会被工具描述撑爆，工具选择也会变差。

### 3.9 MCP resource tools

源码位置：

- `core/src/tools/handlers/mcp_resource.rs`
- `core/src/tools/handlers/mcp.rs`

工具：

- `list_mcp_resources`
- `list_mcp_resource_templates`
- `read_mcp_resource`
- 以及泛化 MCP tool call handler

设计要点：

- resource list 支持 `server` 和 `cursor`。
- 不指定 server 时汇总所有 server；此时不允许 cursor。
- read resource 需要明确 `server` 和 `uri`。
- 输出 JSON 序列化 payload。
- 事件层有 MCP tool begin/end。

Keydex 如果短期没有 MCP，可先不实现；如果目标是 Codex-like agent，MCP resource 是必须规划的工具族。

### 3.10 `request_user_input` 和权限工具

源码位置：

- `core/src/tools/handlers/request_user_input.rs`
- `core/src/tools/handlers/request_permissions.rs`

`request_user_input`：

- 只在允许的 collaboration mode 可用。
- 让模型提出 1-3 个短问题并等待用户响应。
- 每个问题必须有非空 options。
- 客户端会自动加 free-form Other。
- 支持 auto-resolution。

权限工具：

- 请求文件系统/网络等权限。
- 正规化路径。
- 授权结果影响当前 turn/session 后续工具运行。

Keydex 当前没有这类协作工具，所以模型遇到高风险操作只能硬执行、硬失败或口头问用户，无法进入工具级状态机。

## 4. Codex 非模型 app-server 工具能力

这些不是都直接暴露给模型，但对“像 Codex 一样操作文件/空间/分析/搜索”很关键。

### 4.1 FS API

源码位置：

- `app-server/src/fs_api.rs`
- `app-server/src/message_processor.rs`
- `app-server-protocol/src/protocol/v2.rs`

能力：

- `fs/readFile`：base64 返回文件 bytes。
- `fs/writeFile`：base64 写入 bytes。
- `fs/createDirectory`
- `fs/getMetadata`
- `fs/readDirectory`
- `fs/remove`
- `fs/copy`

特点：

- base64 让文件读写 binary-safe。
- copy 支持文件、目录、symlink，并防止目录复制到自身/子孙路径。
- remove/copy 是客户端 RPC 能力，不等同于模型可随意调用的工具。

Keydex 当前模型工具 `write_file/read_file` 只覆盖 UTF-8 文本，不等于完整 workspace FS API。建议把“模型工具”和“前端文件管理 RPC”分开设计。

### 4.2 Fuzzy file search

源码位置：

- `app-server/src/fuzzy_file_search.rs`
- `app-server/src/codex_message_processor.rs`

能力：

- 一次性 fuzzy file search。
- search session start/update/stop。
- 支持 cancellation。
- limit 默认 50。
- 按 score desc、path asc 排序。

用途：

- 主要服务 UI 文件跳转和交互式搜索。
- 对模型可提供一个简化 `find_files` 工具，但不要和 `grep_files` 混淆。

Keydex 当前 `search_files` 是递归 substring，既不像 Codex fuzzy，也不像 Codex grep。

### 4.3 App command exec

源码位置：

- `app-server/src/command_exec.rs`
- `app-server-protocol/src/protocol/v2.rs`

能力：

- `command/exec`
- `command/exec/write`
- `command/exec/terminate`
- `command/exec/resize`
- stdout/stderr delta base64 streaming
- PTY resize
- 连接关闭时清理进程

这和模型工具 `exec_command/write_stdin` 是两套相邻能力：

- 模型工具面向 agent reasoning。
- app command exec 面向 UI/用户手动终端。

Keydex 如果要做桌面端或 web workbench，建议也分开两套，不要把模型工具直接当用户终端 API。

## 5. Keydex 当前工具现状

### 5.1 当前注册工具

注册入口：`backend/app/tools/factory.py`

当前工具：

- `read_file`
- `write_file`
- `list_directory`
- `search_text`
- `search_files`
- `run_command`
- `apply_patch`
- `update_plan`

核心框架文件：

- `backend/app/tools/base.py`
- `backend/app/tools/registry.py`
- `backend/app/tools/orchestrator.py`
- `backend/app/agent/langchain_tools.py`
- `backend/app/agent/tool_call_progress.py`
- `backend/app/agent/event_processor.py`

### 5.2 `read_file`

现状：

- 参数：`path/start_line/max_lines`
- UTF-8 读取。
- 文件大小上限 512KB。
- 返回 JSON：`content/encoding/size/start_line/max_lines/total_lines/truncated/next_start_line`

问题：

- 没有 `L<n>:` 行号，模型编辑时必须自己数行。
- 没有 indentation-aware 代码块读取。
- 大文件策略粗糙。
- 对非 UTF-8 文本不友好。
- 参数名和 Codex 不一致，但这不是最大问题；最大问题是输出不适合模型做精确修改。

建议：

- 保留 `read_file` 名称。
- 增加 `offset/limit` alias，兼容旧 `start_line/max_lines`。
- 输出新增 `numbered_content` 或直接将结果主体改成行号文本。
- 支持 `mode=slice|indentation`。
- 支持 lossy UTF-8。

### 5.3 `write_file`

现状：

- 参数：`path/content/append`
- 创建父目录。
- UTF-8 写入。
- 当前已有特殊逻辑：
  - 读取 original。
  - 写入后构建 diff。
  - 通过 `build_text_diff/normalize_file_change/count_text_lines` 返回文件变更对象。
  - 返回 `files: [change]`。
- `backend/app/agent/tool_call_progress.py` 会在流式参数阶段解析 `write_file` 的 `path/content` 并生成进度 diff。

问题：

- `write_file` 同时承担 create、overwrite、append，模型容易误用为“编辑文件”。
- 没有 overwrite guard，例如 `expected_exists` / `mode`。
- append/overwrite 的 `operation` 当前为了 UI 或历史测试常表现成 `add`，长期语义不准确。
- 只能 UTF-8 文本。
- 大文件全量覆写风险高。

兼容要求：

- 不能删除。
- 不能改名。
- 不能移除 `append`。
- 不能移除 `files`。
- 不要突然改变 `files[*].diff/additions/deletions`。

建议：

- 保留 `write_file` 作为“创建文件、全量覆写、小文件生成、追加”的工具。
- 在 description 中明确：修改已有文件优先用 `apply_patch`。
- 新增可选 `mode`：`create|overwrite|append`。
- 旧参数映射：
  - `append=true` -> `mode=append`
  - `append=false` 且文件不存在 -> `mode=create`
  - `append=false` 且文件存在 -> `mode=overwrite`
- 新增可选 `if_exists` / `if_missing` guard，但保持默认兼容。
- 返回中新增 `change_type` 或 `file_status` 表达真实语义，先不破坏旧 `operation` 字段。

### 5.4 `list_directory`

现状：

- 只列直接子节点。
- 返回 JSON entries。
- 无 depth/paging。

问题：

- 模型探索仓库结构需要多次调用。
- 大目录缺少分页。
- 不如 Codex `list_dir` 文本树易读。

建议：

- 新增 `list_dir`，按 Codex 语义实现。
- 保留 `list_directory` 作为兼容 alias，内部调用 `list_dir(depth=1)`。
- 输出可同时包含：
  - `text`：模型读的树状文本
  - `entries`：UI 用结构化列表

### 5.5 `search_text`

现状：

- 优先使用 `rg`，否则 Python fallback。
- 返回匹配行：`path/line/snippet`。
- 支持 regex、case_sensitive、limit、path。
- 有固定 ignored dirs。

问题：

- 适合查一段文本，但不适合作为第一步找相关文件集合。
- `rg --max-count` 是每文件限制，不是全局路径发现语义。
- 没有 include/exclude glob。
- 没有 context before/after。
- 没有按 mtime 排序。

建议：

- 保留 `search_text`，定位具体行。
- 增加 `include/exclude/context_before/context_after`。
- 结果中加入 `text` 渲染，便于模型阅读。
- 另新增 `grep_files` 承担 Codex 路径发现职责。

### 5.6 `search_files`

现状：

- `os.walk` 递归查文件名/路径 substring。
- 返回路径、名称、类型、size。

问题：

- 名称像“搜索文件”，但能力既不是 fuzzy，也不是 grep。
- 对模型选择工具有误导：想搜内容时可能误调用它。

建议：

- 短期保留兼容。
- 中期改名或新增：
  - `find_files`：fuzzy/path/name 搜索。
  - `grep_files`：内容匹配文件路径搜索。
- `search_files` 标记 deprecated，description 明确“只搜路径/文件名，不搜内容”。

### 5.7 `run_command`

现状：

- 参数：`command/cwd/timeout_seconds`
- `asyncio.create_subprocess_shell`
- capture stdout/stderr。
- timeout 后 kill。
- 输出截断到 64KB。
- 非 0 exit 抛 `ToolExecutionError`。
- 硬编码 deny list 包含 `curl/wget/...` 等。

问题：

- 没有 session。
- 没有 stdin。
- 没有 PTY。
- 没有 chunk。
- 没有稳定环境变量。
- 没有 output token 预算。
- 非 0 exit 被视为工具失败，模型反而拿不到“命令正常执行但测试失败”的结构化语义。
- deny list 太粗，`curl` 有时是读取文档/调试网络的正常需求；应该由权限策略控制。
- `create_subprocess_shell` 让 quoting/平台行为不稳定，也不利于 approval key 归一化。

建议：

- 新增 `exec_command/write_stdin`。
- `run_command` 保留一段时间作为 wrapper：
  - 调 `exec_command(cmd=command, workdir=cwd, yield_time_ms=timeout)`
  - 如果完成，返回兼容 JSON。
  - 如果未完成，返回 `session_id` 并提示使用 `write_stdin`。
- 移除硬 deny list，改成权限策略。

### 5.8 `apply_patch`

现状：

- 参数：`patch`
- description 已经明显参考 Codex，并加入中文错误提示。
- 支持 Add/Update/Delete 文件头。
- 返回 `changes` 和 `files`。
- 当前 UI 流式进度 parser 依赖 patch 文本。

问题：

- Parser 不是 Codex parser。
- Update 不是真实 hunk apply。
- 不支持 Move To。
- 不支持 EOF marker。
- 多 hunk/重复上下文不可靠。
- 没有完整 preflight/rollback。
- completed result 中 operation 语义有历史兼容问题。

建议：

- 保留工具名和入参。
- 替换内部 parser/apply 算法。
- 以 Codex `apply-patch` crate 为蓝本移植：
  - `parser.rs` -> Python parser
  - `seek_sequence.rs` -> Python hunk 定位
  - `lib.rs compute_replacements/apply_patch` -> Python apply/preflight
  - `invocation.rs` 的 shell 拦截可等到 exec_command 阶段再做
- 增加 Move To、EOF、多 hunk 测试。
- 保留 `changes/files` 输出，并补充真实 `change_type`。

### 5.9 `update_plan`

现状：

- 已支持 plan items、状态校验、最多一个 in_progress。
- 返回 UI payload。

问题：

- 暂无核心问题。

建议：

- 保持现状。
- 未来与 collaboration mode 结合，按模式决定是否暴露。

## 6. 需要复刻、修改、新增、删除的工具清单

### 6.1 必须复刻

| 优先级 | Codex 工具/能力 | Keydex 落地方式 | 原因 |
| --- | --- | --- | --- |
| P0 | Codex `apply_patch` parser | 替换 `backend/app/tools/patch.py` 内核，保留外部协议 | 当前编辑稳定性最大短板 |
| P0 | `read_file` 行号输出 | 增强现有 `read_file` | 精确读代码和做 patch 的基础 |
| P0 | `list_dir` depth/paging | 新增 `list_dir`，`list_directory` 做 alias | 仓库探索基础能力 |
| P0 | `grep_files` | 新增内容路径搜索工具 | 比 `search_text` 更适合第一步定位文件 |
| P1 | `exec_command` | 新增统一命令执行工具 | 替代一次性 `run_command` |
| P1 | `write_stdin` | 新增进程交互/轮询工具 | 支持长进程、dev server、交互输入 |
| P1 | exec output schema | shell 输出统一成 chunk/session/exit/output | 让模型能稳定理解命令状态 |
| P2 | mutating tool gate | 重构 ToolHandler/Orchestrator | 文件修改和命令执行要有串行 gate |
| P2 | permission/approval runtime | 新增权限策略层 | 替代硬 deny list |
| P2 | request_user_input | 新增协作工具和前端等待状态 | 高风险/不确定操作需要工具化提问 |
| P3 | tool_search | 动态工具/MCP 前再实现 | 避免工具上下文爆炸 |
| P3 | MCP resources | MCP 接入时实现 | Codex-like connector 能力 |

### 6.2 必须修改

| 当前工具 | 修改方向 | 兼容策略 |
| --- | --- | --- |
| `write_file` | 增加 `mode/create/overwrite/append` 语义，description 明确不是首选编辑工具 | 保留 `append` 和 `files` |
| `apply_patch` | 替换 parser 和 apply 算法 | 保留 `patch` 入参、`changes/files` 返回 |
| `read_file` | 输出行号文本，支持 indentation | 保留 `path/start_line/max_lines` alias |
| `list_directory` | 改成 `list_dir(depth=1)` alias | 保留原工具名 |
| `search_text` | 加 include/exclude/context，修正 limit 语义 | 保留原参数 |
| `search_files` | 明确只搜路径/名称，或迁移为 fuzzy | 保留一段时间并标 deprecated |
| `run_command` | 改成 `exec_command` wrapper | 保留一段时间，description 引导新工具 |
| `ToolOrchestrator` | 加 mutating 判断、权限 gate、事件细分 | 保持现有 event payload 字段 |
| `ToolCallChunkPipeline` | 支持 Move To 和真实 operation | 不移除旧字段 |
| `system_prompt.py` | 更新工具使用规则，强调 read/search/patch/exec 组合 | 保留中文风格 |

### 6.3 应该新增

| 新工具/API | 类型 | 说明 |
| --- | --- | --- |
| `exec_command` | 模型工具 | Codex unified exec 主工具 |
| `write_stdin` | 模型工具 | 对运行中命令写 stdin 或 poll |
| `list_dir` | 模型工具 | Codex 风格目录树 |
| `grep_files` | 模型工具 | 内容匹配文件路径搜索 |
| `find_files` | 模型工具或 UI API | fuzzy/path/name 文件搜索 |
| `view_image` | 模型工具 | 需要视觉/截图/图片检查时使用 |
| `request_user_input` | 模型工具 | 工具化用户澄清 |
| `request_permissions` | 模型工具 | 工具化权限申请 |
| `fs/readFile` 等 | app-server API | binary-safe 文件管理，不直接等于模型工具 |
| `git_status/git_diff` | 模型工具或 UI API | Codex 常通过 shell 做，但产品上单独 API 更稳定 |

### 6.4 应该删除或降级

这里的“删除”建议按 deprecate 处理，不要一次性破坏工具调用历史。

| 对象 | 处理 |
| --- | --- |
| `run_command` 作为主命令工具 | 降级为兼容 wrapper，最终从模型首选工具里隐藏 |
| shell 硬 deny list | 删除，替换为 permission/network policy |
| `search_files` 当前语义 | 改名/降级，避免和内容搜索混淆 |
| 单独暴露高危 `delete_file/remove` 给模型 | 不建议新增；删除用 `apply_patch Delete File` 或受权限保护 FS API |
| 只返回 JSON 的目录/读取输出 | 不直接删除，但补模型友好 text 输出 |

## 7. 具体怎么抄

### 7.1 Patch parser 移植方案

推荐路线：移植 Codex Rust `apply-patch` crate 的核心算法到 Python，而不是继续修补现有字符串 replace。

建议新增模块：

```text
backend/app/tools/patch_parser.py
backend/app/tools/patch_apply.py
backend/app/tools/patch_models.py
```

需要抄的核心概念：

- `Hunk`
  - `AddFile(path, contents)`
  - `DeleteFile(path)`
  - `UpdateFile(path, move_path, chunks)`
- `UpdateFileChunk`
  - `change_context`
  - `lines`
  - `is_end_of_file`
- `ApplyPatchFileChange`
  - `Add`
  - `Delete`
  - `Update(move_path, unified_diff, new_content)`
- `seek_sequence(lines, pattern, start, is_end_of_file)`
- `compute_replacements`
- `apply_patch`

执行流程应改为：

1. parse patch。
2. 解析所有路径并用 `resolve_workspace_path` 校验 workspace。
3. 读取所有相关文件。
4. 对所有 update 计算 replacements。
5. 生成所有目标文件的新内容。
6. preflight 成功后再统一写入/删除/rename。
7. 每个文件生成兼容 `files` change object。
8. 返回 `{"changes": changes, "files": changes}`。

必须新增测试：

- Add File 多行。
- Delete File。
- Update File 单 hunk。
- Update File 多 hunk。
- `@@ function_name` 上下文。
- 重复代码块定位。
- `*** Move to` rename。
- rename + update。
- `*** End of File`。
- context mismatch 不改文件。
- 多文件 patch 中一个失败时不产生部分修改。
- workspace escape。
- streaming parser 对 Move To 的 progress。

### 7.2 Unified exec 移植方案

推荐新增：

```text
backend/app/tools/exec.py
backend/app/tools/exec_sessions.py
backend/app/tools/exec_output.py
```

第一阶段可用 asyncio pipe 实现，PTY 作为第二阶段：

- `CommandSessionManager`
  - `allocate_session_id()`
  - `start(cmd, workdir, shell, tty, yield_time_ms, max_output_tokens)`
  - `write_stdin(session_id, chars, yield_time_ms, max_output_tokens)`
  - `poll(session_id, yield_time_ms, max_output_tokens)`
  - `terminate(session_id)`
  - `cleanup_exited/max_sessions`
- 输出对象：
  - `chunk_id`
  - `wall_time_seconds`
  - `exit_code`
  - `session_id`
  - `original_token_count`
  - `output`
  - `truncated`

工具行为：

- `exec_command`：
  - 如果进程结束，返回 `exit_code`。
  - 如果仍运行，返回 `session_id`。
  - 永远把 stdout/stderr 合并或分别返回，同时生成模型友好 `response_text`。
- `write_stdin`：
  - `chars` 为空时 poll。
  - 进程结束时返回 `exit_code`，不再保留 session。

Windows 注意点：

- 先使用 PowerShell/cmd pipe 已能解决 80% 问题。
- 真 PTY 需要 `pywinpty` 或 ConPTY 封装，作为第二阶段。
- 输出默认禁色：`NO_COLOR=1`、`TERM=dumb`。
- PowerShell 输出编码要固定 UTF-8。

### 7.3 read/list/search 移植方案

`read_file`：

- 兼容旧入参。
- 新增 Codex 入参 alias。
- 返回：

```json
{
  "path": "...",
  "content": "...",
  "numbered_content": "L1: ...\nL2: ...",
  "start_line": 1,
  "limit": 200,
  "total_lines": 1000,
  "truncated": true,
  "next_start_line": 201
}
```

模型最终看到的字符串建议优先用 `numbered_content`。

`list_dir`：

- 新工具名。
- 参数 `dir_path/path, offset, limit, depth`。
- 返回 `text + entries + next_offset`。

`grep_files`：

- 参数 `pattern/include/path/limit`。
- 优先 `rg --files-with-matches --sortr=modified`。
- fallback 可用 Python walk + regex，但要说明 fallback 不支持 mtime 排序或性能较差。

### 7.4 工具描述怎么写

Keydex 工具描述不应只写“读取文件”“执行命令”，要告诉模型：

- 什么时候用。
- 什么时候不要用。
- 参数边界。
- 输出如何继续下一步。

建议风格：

`read_file`：

> Reads a workspace file and returns 1-indexed line-numbered text. Use this before editing existing files so patches can reference precise context. For large files, read a small window with `offset` and `limit`; use `mode=indentation` to expand around a function or class block.

`grep_files`：

> Finds workspace files whose contents match a regex and returns matching file paths sorted by modification time. Use this to discover likely files before calling `read_file`; use `search_text` when you need exact matching lines.

`apply_patch`：

> Applies a Codex-style patch inside the workspace. Use this for edits to existing files. The patch must start with `*** Begin Patch`, contain `*** Add File`, `*** Update File`, or `*** Delete File` sections, and end with `*** End Patch`. Use `*** Move to` for rename. Do not send unified diff headers such as `---` or `+++`.

`write_file`：

> Creates, overwrites, or appends a text file inside the workspace and returns a file diff. Prefer `apply_patch` for editing existing files; use this for new files, generated artifacts, or full-file rewrites.

`exec_command`：

> Runs a shell command in the workspace and returns output. If the command is still running, the result includes `session_id`; use `write_stdin` with that `session_id` to send input or poll for more output.

## 8. 兼容两个特殊工具

用户特别指出当前有两个工具已有特殊逻辑：创建文件和编辑文件。对应到当前代码就是：

- 创建/写文件：`write_file`
- 编辑文件：`apply_patch`

兼容原则：

1. 不改工具名。
2. 不移除旧参数。
3. 不移除 `files` 字段。
4. 不移除 `changes` 字段。
5. 文件变更对象只增字段，不删字段。
6. 流式进度 parser 与 completed output parser 同步支持新语法。
7. 前端迁移前，不突然改变 `operation` 的历史表现。

建议新增字段：

```json
{
  "path": "src/app.py",
  "operation": "update",
  "change_type": "modify",
  "source_tool": "apply_patch",
  "old_path": null,
  "new_path": "src/app.py",
  "renamed": false,
  "added_lines": 1,
  "deleted_lines": 1,
  "additions": 1,
  "deletions": 1,
  "diff": "..."
}
```

对 rename：

```json
{
  "path": "src/main.py",
  "old_path": "src/app.py",
  "new_path": "src/main.py",
  "operation": "update",
  "change_type": "rename",
  "renamed": true,
  "diff": "..."
}
```

这样既能保留 UI 旧字段，又能给新 UI 正确语义。

## 9. 推荐实施路线

### Phase 0：锁定协议

目标：先防止改造破坏 UI。

- 写一份 `files` change object schema。
- 给 `write_file/apply_patch` 的 started/progress/finished event 增加契约测试。
- 明确 `operation` 历史兼容和 `change_type` 新语义。

### Phase 1：先改文件探索和编辑

目标：让 agent 能稳定读代码、找代码、改代码。

- 增强 `read_file` 行号输出。
- 新增 `list_dir`，旧 `list_directory` alias。
- 新增 `grep_files`。
- 替换 `apply_patch` parser/apply 内核。
- 更新 `system_prompt.py` 工具使用规则。

这是最影响日常体验的一步。

### Phase 2：统一 shell runtime

目标：替代难用的 `run_command`。

- 新增 `exec_command`。
- 新增 `write_stdin`。
- 实现 session manager。
- 输出 Codex 风格 chunk/session/exit 结构。
- `run_command` wrapper 化。
- 非 0 exit 不再默认等同工具异常；由结果里的 `exit_code` 表达。

### Phase 3：工具运行时分层

目标：从函数集合升级为工具系统。

- `LocalTool` 增加 `kind/is_mutating/output_schema`。
- `ToolRegistry` 支持 namespace。
- `ToolOrchestrator` 增加 mutating gate。
- 增加 approval/permission policy 抽象。
- 命令和 patch 都走统一 runtime。

### Phase 4：Workspace / UI API

目标：补齐 Codex workbench 体验。

- 新增 binary-safe FS RPC。
- 新增 fuzzy file search session。
- 新增 git status/diff API。
- 命令输出支持 UI delta streaming。

### Phase 5：动态工具和 MCP

目标：接近 Codex 插件/connector 能力。

- 新增 `tool_search`。
- 新增 MCP resource 工具。
- 动态工具延迟加载。
- 工具 schema 搜索索引。

## 10. 最小落地版本建议

如果只做一轮，不建议一上来重构全部 runtime。最小可落地版本是：

1. `apply_patch` 真 parser。
2. `read_file` 行号输出。
3. `list_dir` depth/paging。
4. `grep_files`。
5. `exec_command/write_stdin` 的 pipe 版 session manager。

这五项完成后，agent 的“操作文件/空间/分析/搜索”体验会立刻接近 Codex 的核心工作流：

```text
list_dir -> grep_files/search_text -> read_file -> apply_patch/write_file -> exec_command -> write_stdin/poll -> read_file/git diff
```

后续再补 permission/sandbox/MCP/fuzzy，不会阻塞基础可用性。

## 11. 风险点

1. 直接改 `operation` 会破坏前端和测试。应新增 `change_type`，延迟迁移。
2. `apply_patch` 如果没有 preflight，仍可能部分修改文件。必须先算完所有 change 再写。
3. Windows shell 和编码需要单独处理，不能完全照搬 Unix 假设。
4. `exec_command` session 如果不限制数量和生命周期，会留下后台进程。
5. 工具描述变长会增加上下文成本，长期应配合 `tool_search` 或按模式暴露工具。
6. `write_file` 继续允许默认 overwrite，有误删风险；但为了兼容不能立即改默认行为，只能加 guard 和提示。

## 12. 结论

Keydex 当前工具 MVP 已经有正确方向：workspace path 限制、文件 diff 返回、流式文件进度、plan 工具都值得保留。但要达到 Codex 体验，需要从“几个工具函数”升级成“工具运行时 + 稳定编辑语法 + 会话命令 + 模型友好读搜输出”。

最该优先抄的不是 Codex 的工具数量，而是四个设计：

- `apply_patch` 是语法和算法，不是字符串 replace。
- shell 是 session runtime，不是一次性 command。
- read/list/grep 是模型阅读协议，不只是后端 API。
- mutating/approval/sandbox 是运行时属性，不应该散落在每个工具里硬编码。

保留 `write_file` 与 `apply_patch` 的兼容协议，在内部逐步替换实现，是风险最低的改造路径。
