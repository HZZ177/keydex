# keydex

`keydex` 是一个面向 Windows 本地个人使用的 Codex-like 桌面 Agent。

当前路线：

- 后端：Python 3.11 + FastAPI + SQLite，按 `kt-agent-framework` 的核心 agentloop、事件管线、session/history/trace 语义做桌面化复刻。
- 前端：React + TypeScript + Vite + CSS Modules，保留 Codex 产品质感的本地桌面交互。
- 桌面壳：Tauri 2。打包不是日常开发默认动作，非明确要求不要执行构建或打包。

## 安装依赖

Python 依赖使用 `uv pip install`：

```powershell
uv pip install -r requirements.txt
```

前端依赖在 `desktop/` 下安装：

```powershell
cd .\desktop
npm.cmd install --cache .\.npm-cache
```

## 本地开发启动

一键启动后端和前端：

```powershell
pnpm run dev
```

这个命令会打开两个 PowerShell 窗口：

- 后端：`http://127.0.0.1:8765`
- 前端：`http://127.0.0.1:5173`

分别启动：

```powershell
pnpm run dev:backend
pnpm run dev:frontend
```

也可以直接运行后端 main：

```powershell
& .\.venv\Scripts\python.exe backend\app\main.py
```

前端如果进入 `desktop/` 目录，也可以直接运行：

```powershell
cd .\desktop
pnpm run dev
```

查看一键启动脚本说明：

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\dev-start.ps1 -Help
```

## 工作区与会话运行目录

`keydex` 的 Agent 不应该运行在应用自身仓库目录下。当前实现把“工作区”作为一等实体：

- `workspaces` 表保存用户添加的本机项目目录。
- `session_type=workspace` 的会话必须绑定 `workspace_id`，并在创建时固化自己的 `cwd` 和 `workspace_roots`。
- `session_type=chat` 是纯聊天会话，不挂载工作区，也不会注册文件、搜索、命令、补丁等项目工具。
- Agent 工具执行、文件搜索、文件预览、Markdown 相对图片读取都使用 session 绑定的工作区范围。
- 左侧历史按工作区分组；纯聊天进入“对话”分组。
- `settings.workspace_root` 只作为本地启动和旧数据迁移的默认值，不再作为 Agent 运行目录使用。

开发时添加测试工作区：

1. 打开“新对话”。
2. 点击输入框底部的工作区选择器。
3. 输入本机项目目录，例如 `D:\Pycharm Projects\my-project`，或在 exe 环境下使用浏览入口。
4. 在该工作区下发送消息后，会话历史会归入对应项目分组。

工作区被删除或路径不可访问时，历史会话仍保留，但页面会显示“工作区不可用”，并且不会回退到 `keydex` 应用目录。

## 测试

根目录统一测试入口：

```powershell
pnpm run test
```

`pnpm run verify` 当前也是测试别名，不执行 build 或打包。

该命令包含：

- `pnpm run lint:backend`
- `pnpm run test:backend`
- `pnpm run test:frontend`

单独运行：

```powershell
pnpm run lint:backend
pnpm run test:backend
pnpm run test:frontend
```

## 页面级 E2E

E2E 脚本会使用隔离端口：

- 后端：`18765`
- 前端：`15173`

脚本只启动本地开发服务，不执行 build、Tauri build 或打包。

```powershell
pnpm run test:e2e:smoke
pnpm run test:e2e:app-shell
pnpm run test:e2e:settings
pnpm run test:e2e:stream
pnpm run test:e2e:tools
pnpm run test:e2e:workspace
pnpm run test:e2e:recovery
pnpm run test:e2e:visual
pnpm run test:e2e:settings-usage
```

说明文档：`.dev/e2e/README.md`

截图和报告：`.dev/verification/`

## 当前能力

后端：

- SQLite 表和仓储：`sessions`、`message_events`、`trace_records`、`trace_event_logs`。
- 工作区表和会话运行目录：`workspaces`、`sessions.workspace_id/session_type/cwd/workspace_roots`。
- DomainEvent 事件事实层、实时投影、持久化投影、completed 聚合和历史聚合。
- OpenAI-compatible `/chat/completions` 流式对接，支持正文、reasoning、tool calls、HTTP 错误和非 JSON 错误。
- 工具注册与真实执行：文件读取、目录浏览、搜索、命令执行、补丁应用、计划更新。
- HTTP API：health、model providers、settings、sessions、workspace。
- WebSocket chat 通道：发送、取消、状态、错误、工具、reasoning、completed。

前端：

- Codex 风格浅色应用壳、左侧导航、会话列表、空态快速对话和对话页。
- 首页/对话页共用输入框，支持中文 IME、发送、停止、模型选择和必要的本地文件交互。
- 新对话支持真实工作区选择；对话页工作区只读展示；左侧历史按工作区和纯聊天分组。
- 动态流式缓冲，Markdown、代码块、图片、Mermaid、数学公式渲染。
- reasoning 思考、工具、命令、文件变更、错误、取消和 ghost footer 按真实事件时序展示。
- 模型设置页支持供应商、模型刷新、模型筛选、启停、默认模型和健康检查。
- 历史恢复保持实时消息结构一致，包含工具面板和 ghost footer。

## 计划与验收

- 开发计划：`.dev/plans/2026-06-18_04-14-21-codex-style-kt-agentloop-rewrite.md`
- Issue CSV：`.dev/issues/2026-06-18_04-14-21-codex-style-kt-agentloop-rewrite.csv`
- 工作区重构计划：`.dev/plans/2026-06-21_00-51-10-workspace-session-runtime-redesign.md`
- 工作区 E2E 合同：`.dev/e2e/workspace-session-redesign.csv`
- 视觉参考图：`.dev/prototype/img.png`
- 视觉与中文化验收：`.dev/verification/visual-localization-audit.md`

## 打包

打包不是日常开发默认动作。只有明确需要 Windows exe 时再执行：

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1
```

查看打包脚本说明，不触发打包：

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1 -Help
```

快速产物目录：

```text
artifacts/windows/
```
