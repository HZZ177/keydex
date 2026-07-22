# Keydex

Keydex 是一个 Windows 本地桌面 AI Agent。它让你在自己的项目目录上和 AI 对话，AI 可以自主读取文件、搜索代码、执行命令、修改文件——所有操作都在本地完成，数据不离开你的电脑。

<!-- 截图占位：主界面截图，展示左侧会话列表 + 中间对话区 + 右侧预览面板 -->

## 为什么选择 Keydex

- **本地优先**：所有数据存储在本机，对话历史、文件操作、命令执行都不经过云端
- **真实工具执行**：AI 不只是"说"，还能"做"——读文件、搜索代码、跑命令、改代码，全程可见可控
- **工作区隔离**：每个项目独立管理，AI 只能访问你指定的工作区目录
- **命令审批**：AI 执行命令前需要你确认，避免误操作
- **OpenAI 兼容**：支持任何 OpenAI API 格式的模型供应商（OpenAI、DeepSeek、本地 Ollama 等）

<!-- 截图占位：AI 正在执行工具的对话截图，展示工具调用内联块和文件变更 -->

## 安装

### 系统要求

- Windows 10 / 11（64 位）

### 下载

从 Release 页面下载最新的 Windows 安装包，解压后运行 `Keydex.exe` 即可。

> 如果你需要从源码构建，请参考本文档底部的[开发者指南](#开发者指南)。

## 快速开始

### 第一步：配置模型

首次启动后，需要先配置至少一个模型供应商：

1. 点击左侧导航栏的 **设置** 图标
2. 进入 **模型设置** 页面
3. 点击 **添加供应商**，填写以下信息：
   - **名称**：给这个供应商起个名字（如"我的 OpenAI"）
   - **API 地址**：供应商的 API 端点（如 `https://api.openai.com/v1`）
   - **API Key**：你的密钥
4. 点击 **刷新模型**，获取可用模型列表
5. 启用需要的模型，并设置一个默认模型

<!-- 截图占位：模型设置页面截图，展示供应商列表和模型配置 -->

### 第二步：开始对话

**纯聊天**：直接在首页输入框中输入消息，按 Enter 发送即可开始对话。

**项目对话**：

1. 点击首页输入框底部的 **工作区选择器**
2. 输入或浏览选择你的项目目录（如 `D:\Projects\my-app`）
3. 发送消息后，AI 就可以在该目录下读取文件、搜索代码、执行命令

<!-- 截图占位：新对话页截图，展示工作区选择器和输入框 -->

### 第三步：观察 AI 工作

AI 在回复过程中，你可以实时看到：

- **思考过程**：AI 的 reasoning 推理步骤（可折叠面板）
- **工具调用**：每次读文件、搜索、执行命令都会显示为内联状态块
- **文件变更**：代码修改以 diff 形式展示
- **计划步骤**：AI 制定的任务计划卡片，可展开查看进度

<!-- 截图占位：对话页截图，展示 reasoning 面板 + 工具调用块 + 计划卡片 -->

## 核心功能

### 工作区

工作区是 Keydex 的核心概念。每个工作区绑定一个本机项目目录：

- AI 只能访问工作区范围内的文件，不会越权访问其他目录
- 左侧会话历史按工作区自动分组
- 不需要工作区的纯聊天会话归入"对话"分组
- 工作区被删除或路径不可访问时，历史会话仍保留，但会显示"工作区不可用"

<!-- 截图占位：左侧会话列表按工作区分组的截图 -->

### 会话分支

在对话过程中，你可以从任意一条消息处创建分支：

- **从这里继续**：以当前消息为起点，创建一个新的对话分支
- **回退到这里继续**：回退到某条消息，从那里重新开始

分支不会破坏原有对话历史，你可以随时在不同分支之间切换。

<!-- 截图占位：消息右键菜单截图，展示"从这里继续/回退到这里继续"选项 -->

### 上下文压缩

长对话容易超出模型的上下文窗口。Keydex 会自动检测并压缩历史消息：

- 使用快速模型生成对话摘要
- 压缩后的会话作为新分支保留，原始历史不受影响
- 压缩过程对用户可见，会显示系统提示

### 命令审批

当 AI 需要执行 Shell 命令时，会先向你展示命令内容并等待确认：

- 你可以批准或拒绝每条命令
- 审批策略可按工作区配置
- 在 Workbench 模式下，审批提示会自动展开到侧栏

<!-- 截图占位：命令审批提示截图 -->

### 预览面板

右侧预览面板支持多种文件格式的实时预览：

| 格式 | 能力 |
|------|------|
| Markdown | 渲染视图 / 源码 / 分屏对照 |
| HTML | sandbox 安全预览 |
| 图片 | 自适应缩放 |
| Diff | 彩色增删行渲染 |
| JSON | 自动格式化 |

对话中的代码块也可以一键打开到预览面板中查看。

<!-- 截图占位：右侧预览面板截图，展示 Markdown 分屏预览 -->

### 侧边栏浏览器与网页批注

Keydex 在右侧面板中提供完整的原生浏览器，可与会话、文件和审阅面板并列使用：

- 支持多标签、前进/后退/刷新、地址搜索、页内查找、缩放、上传、下载和网站权限提示
- 支持普通与无痕 Profile；无痕标签不写入工作区恢复状态
- 可选择网页文本、元素或区域，创建带结构化定位信息的批注
- 批注可以附加到会话；发送时生成不可变引用快照，后续编辑不会改写已发送消息
- 浏览器和批注默认启用，但不会向 Agent 暴露点击、输入或导航等网页自动化能力

浏览器页面由 Tauri/WebView2 原生 Surface 承载，因此需要通过 Keydex 桌面运行时使用；单独启动 Vite 的 `pnpm run dev` 只包含渲染层，不能承载任意站点。详细使用方式、隐私边界和故障处理见[侧边栏浏览器与网页批注](docs/sidebar-browser.md)。

### Workbench 模式

Workbench 模式提供了一种"边看代码边对话"的工作方式：

- 助手面板可以收起为底部胶囊、展开为侧边抽屉、或全屏覆盖
- 草稿内容、选中的模型、文件引用等状态在形态切换间保持连续
- 支持 reduced-motion 无障碍降级

<!-- 截图占位：Workbench 模式截图，展示侧边抽屉形态 -->

### 流式渲染

AI 回复实时流式输出，支持丰富的内容格式：

- Markdown（标题、列表、表格、引用、链接）
- 代码块（语法高亮、复制、折叠、diff 行样式）
- Mermaid 流程图
- KaTeX / LaTeX 数学公式
- 图片自适应渲染

输出速度自动适应，并在输入框上方实时显示当前速度。

### 会话管理

- **自动标题**：对话开始后自动生成标题
- **手动重命名**：手动修改过的标题不会被自动覆盖
- **搜索**：左侧顶部搜索弹窗，按关键词查找历史会话
- **归档删除**：不再需要的会话可以归档或删除

<!-- 截图占位：左侧会话搜索弹窗截图 -->

## 模型配置说明

### 供应商类型

Keydex 兼容所有 OpenAI API 格式的供应商：

| 供应商示例 | API 地址 |
|-----------|---------|
| OpenAI | `https://api.openai.com/v1` |
| DeepSeek | `https://api.deepseek.com/v1` |
| 本地 Ollama | `http://127.0.0.1:11434/v1` |
| 其他兼容服务 | 对应的 API 端点 |

### 主力模型与快速模型

Keydex 支持为不同任务配置不同模型：

- **主力模型**：用于对话和主要任务
- **快速模型**：用于自动标题生成、上下文压缩等辅助任务

在 **设置 → 模型配置** 页面中可以为每个角色分别选择模型。

### 扩展功能设置

在 **设置 → 扩展功能** 页面中可以调整：

- **自动标题生成**：开关、使用的模型
- **重复工具调用保护**：连续相同工具和参数超过阈值后终止本轮对话
- **上下文压缩**：开关、上下文窗口大小、压缩触发阈值
- **A2UI 交互卡片**：统一开关内置 A2UI 能力，当前支持确认、选择、表单、图表四类卡片

<!-- 截图占位：扩展功能设置页面截图 -->

### A2UI 交互卡片

A2UI 是 Keydex 内置的 agent 交互渲染能力，用于把模型工具调用过程中的结构化交互直接展示为桌面端卡片。它不是平台侧的可配置插件，也不复用 `@yongce/a2ui-pc` 或 `@yongce/a2ui-core` SDK；前端组件由 Keydex 自研并随桌面端内置。

当前支持的类型：

| 类型 | 用途 |
| --- | --- |
| 确认 | 需要用户确认或取消后继续执行 |
| 选择 | 单选/多选一组候选项，并把选择结果提交回 agent |
| 表单 | 按字段收集结构化输入，并把表单值提交回 agent |
| 图表 | 渲染柱状图、折线图、饼图、漏斗图和表格类结果 |

在 **设置 → 扩展功能 → A2UI 交互卡片** 中只有一个总开关。关闭后，新的对话运行不会注入 A2UI 工具能力；已经产生的历史卡片仍会正常回放，已经等待中的交互也会按当前会话状态完成。Keydex 不提供 render_key、schema、权限或组件注册的用户自定义入口。

第一期每个 A2UI 卡片右上角保留“查看 A2UI 调试信息”按钮，用于排查 stream、interaction、submit ack、resume、原始事件和解析状态。该按钮是开发期诊断入口，后续稳定后可以通过集中开关隐藏。

## 常见问题

**AI 不回复 / 报错连接失败？**

检查模型设置中的 API 地址和 Key 是否正确。可以在供应商列表中点击"健康检查"测试连通性。

**AI 说找不到文件？**

确保你在创建对话时选择了正确的工作区。AI 只能访问工作区目录内的文件。

**工作区显示"不可用"？**

工作区目录可能已被移动或删除。历史会话仍然保留，但 AI 无法在该目录下执行操作。请重新创建工作区指向正确的路径。

**对话太长 AI 忘记了前面的内容？**

开启设置中的"上下文压缩"功能，Keydex 会自动在对话过长时压缩历史消息。

**如何切换模型？**

在输入框底部可以快速切换当前对话使用的模型，也可以在设置中配置默认模型。

---

## 开发者指南

以下内容面向从源码构建和开发的用户。

### 技术栈

- 后端：Python 3.11 + FastAPI + SQLite
- 前端：React + TypeScript + Vite + CSS Modules
- 桌面壳：Tauri 2 (Rust)

### 环境准备

Python 依赖：

```powershell
uv pip install -r requirements.txt
```

前端依赖（在 `desktop/` 目录下）：

```powershell
cd .\desktop
npm.cmd install --cache .\.npm-cache
```

### 本地开发启动

一键启动后端和前端：

```powershell
pnpm run dev
```

分别启动：

```powershell
pnpm run dev:backend    # 后端 http://127.0.0.1:8765
pnpm run dev:frontend   # 前端 http://127.0.0.1:5173
```

也可以直接运行：

```powershell
# 后端
& .\.venv\Scripts\python.exe backend\app\main.py

# 前端
cd .\desktop
pnpm run dev
```

#### Tauri 壳连接已运行的 PyCharm 后端

需要验证原生浏览器、系统托盘等 Tauri 能力，同时复用 PyCharm 中实时运行的后端时，先确认后端监听在 `127.0.0.1:8765`，再从另一个 PowerShell 启动壳：

```powershell
cd .\desktop
$env:KEYDEX_DEV_AGENT_BASE_URL = "http://127.0.0.1:8765"
pnpm run tauri:dev
```

`KEYDEX_DEV_AGENT_BASE_URL` 由 Tauri Debug 进程在运行时读取，不是 Vite 变量。设置后，壳会跳过内置 `agent-server.exe`，只连接并等待指定后端；退出壳不会停止 PyCharm 后端。它只接受带显式端口的本机 `http://127.0.0.1` 或 `http://localhost` 地址，Release 构建始终忽略该变量。

如需同时隔离桌面壳的本地状态，先在仓库根目录的一个终端运行 `pnpm run dev:frontend`，再在另一个终端按上面方式设置变量并运行 `pnpm run tauri:dev:isolated`；隔离配置不会自行启动 Vite。要恢复壳自行启动 sidecar，可关闭当前壳后执行 `Remove-Item Env:KEYDEX_DEV_AGENT_BASE_URL`，再重新运行 Tauri。界面显示的 `0.1.0` 是桌面壳自身版本，不代表连接的后端版本；数据内容由 PyCharm 后端实际使用的 `KEYDEX_DATA_DIR`（未设置时为后端默认数据目录）决定，可在后端启动日志的 `data_dir` 字段确认。

### 测试

```powershell
# 全部测试（lint + 后端测试 + 前端测试）
pnpm run test

# 单独运行
pnpm run lint:backend
pnpm run test:backend
pnpm run test:frontend
```

页面级 E2E 测试（使用隔离端口，不执行构建）：

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
pnpm run test:e2e:runtime-foundation
```

### 工作区文件自动刷新

目录树、当前文件预览、图片预览和活跃文件搜索通过现有 `/agent-base/ws/chat`
WebSocket 接收文件变更，不需要刷新页面。Home、Workbench、Conversation 和外部
`local-file` 预览共用同一连接与引用计数订阅；断线重连会重新绑定，并以全量重读已加载目录
恢复状态。

客户端请求：

| action | data |
|---|---|
| `bindWorkspaceWatch` / `unbindWorkspaceWatch` | `{ workspace_id }` |
| `bindLocalFileWatch` | `{ watch_id, path }`，`path` 必须是已存在的绝对文件路径 |
| `unbindLocalFileWatch` | `{ watch_id }` |

服务端事件：

| action | data |
|---|---|
| `workspaceWatchBound` | `{ workspace_id, sequence, resync_required }` |
| `workspaceFilesChanged` | `{ workspace_id, sequence, resync_required, changes }` |
| `workspaceWatchUnbound` | `{ workspace_id }` |
| `localFileWatchBound` | `{ watch_id, path, sequence, resync_required }` |
| `localFileChanged` | `{ watch_id, path, sequence, resync_required, changes }` |
| `localFileWatchUnbound` | `{ watch_id }` |

`changes` 中每项为 `{ kind: "added" | "modified" | "deleted", path }`。Workspace
事件使用工作区相对 POSIX path；local-file 事件使用规范化绝对路径。每个 scope 的
`sequence` 严格递增。首次 bind ACK、sequence gap、watcher 异常或单批超过 256 个唯一路径
都会要求 `resync_required=true`；客户端此时只重读已经加载的目录，不预加载整棵目录树。

Watcher 以 200ms 窗口合并事件，并忽略 `.git`、`.hg`、`.svn`、`node_modules`、
`.venv`、`venv`、`dist`、`build`、`target`、`__pycache__`、`.pytest_cache`、
`.mypy_cache`、`.ruff_cache`、`.idea`、`.vscode` 及常见临时文件。显式 exact
local-file watch 不受 workspace ignore 影响。被忽略目录里的 workspace 内容不保证自动刷新，
请使用目录面板的“刷新工作区”；该动作会同时刷新已加载目录、当前预览和活跃搜索。

排障时先确认 WebSocket 已收到 Bound ACK，再检查同 scope 的 sequence 是否连续。如果出现
resync 或刷新失败，页面会保留旧正文并显示可恢复提示；手动刷新不依赖 watcher。实现不承诺
rename 推断、断线期间事件重放、轮询 fallback，也不会把文件事件写入 Agent 消息 store。

聚焦验证命令：

```powershell
& .\.venv\Scripts\python.exe -m pytest backend/tests/services/test_file_change_hub.py backend/tests/api/test_websocket_file_watch.py
pnpm --dir desktop exec vitest run tests/ws-client.spec.ts tests/file-change-provider.spec.tsx tests/workspace-panel-file-change.spec.tsx tests/file-preview-auto-refresh.spec.tsx tests/workspace-file-change-scope.spec.tsx
```

开发测试状态记录在 `.dev/issues/2026-07-13_22-30-38-workspace-file-change-auto-refresh.csv`；
页面级验收结果与截图记录在
`.dev/e2e/contracts/2026-07-13_22-30-38-workspace-file-change-auto-refresh.csv` 及其中的
`evidence_path`。

### 打包

打包不是日常开发默认动作。只有明确需要 Windows exe 时再执行：

```powershell
# 完整打包
powershell.exe -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1

# 快速迭代打包（跳过依赖安装、测试和 Rust 预检查）
powershell.exe -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1 -Fast

# 查看打包脚本说明（不触发打包）
powershell.exe -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1 -Help
```

产物输出目录：`artifacts/windows/`

### 项目结构

```
keydex/
├── backend/app/           # Python 后端
│   ├── agent/             # Agent 编排核心
│   ├── api/               # HTTP / WebSocket 路由
│   ├── events/            # 事件驱动架构
│   ├── keydex/            # Skill 系统
│   ├── model/             # LLM 抽象层
│   ├── services/          # 业务服务层
│   ├── storage/           # 持久化层
│   ├── tools/             # 工具系统
│   └── security/          # 工作区安全
├── desktop/src/           # React 前端
│   ├── features/          # 功能模块
│   ├── renderer/          # UI 渲染层
│   ├── runtime/           # 运行时逻辑
│   └── types/             # 类型定义
├── desktop/src-tauri/     # Tauri Rust 壳层
├── scripts/               # 开发与打包脚本
└── .dev/                  # 开发计划与测试
```
