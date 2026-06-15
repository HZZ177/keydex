# codex-copy 项目现状说明

更新时间：2026-06-15

## 当前定位

`codex-copy` 是一个从零开始实现 Python 版 Codex-like 桌面 Agent 的新项目，不直接修改 `D:\Pycharm Projects\codex` 里的官方 Codex Rust 源码。

旧项目 `D:\Pycharm Projects\codex` 只作为架构参考来源：用于理解 Codex 的线程、回合、事件流、工具调度、审批、shell 执行、补丁应用和 app-server 协议设计。后续所有实际代码、文档和实验性实现都放在 `D:\Pycharm Projects\codex-copy`。

## 已准备文档

当前可复制到新项目的文档：

- `own-docs/python-codex-clone-development-plan.md`
- `own-docs/PROJECT-STATUS.md`

复制到新项目后，推荐路径保持为：

```text
D:\Pycharm Projects\codex-copy\own-docs\
```

## 技术栈决定

项目环境使用 Python 3.11。

后端建议：

- Python 3.11
- FastAPI
- Pydantic
- SQLModel 或 SQLAlchemy + SQLite
- httpx
- anyio
- WebSocket 或 SSE 事件流

桌面端建议：

- Tauri 2
- Vue 3
- TypeScript
- Vite
- Pinia
- TanStack Query for Vue 或 VueUse
- Xterm.js
- Monaco Editor
- Naive UI

打包建议：

- Python 后端用 PyInstaller 或 Nuitka 打包为 `agent-server.exe`
- Tauri 桌面端把 `agent-server.exe` 作为 sidecar 启动
- 最终产物是 Windows 桌面 exe 或 installer

## 为什么不是 React

React 不是这个项目的硬性依赖。这里真正关键的是：

- Tauri 2 负责桌面壳、Windows exe 打包、本地进程启动和系统能力
- Python 3.11 + FastAPI 负责 Agent runtime、工具执行、模型调用和事件流
- Vue 3 负责桌面 UI、聊天流、工具面板、终端输出、diff 预览和设置页

所以前端可以从原计划的 React 改成 Vue 3，不影响整体架构。

Vue 3 更适合当前重新开始的原因：

- 你可以按 Vue 生态推进，不需要迁就官方 Codex 的 Rust/TUI 实现
- Pinia + Composition API 足够承载线程、回合、工具调用、设置等状态
- Naive UI 适合做工作台型桌面应用
- Xterm.js 和 Monaco Editor 都能在 Vue 里正常集成

## 与官方 Codex 源码的关系

本项目不是 Rust Codex 的 fork，也不建议把 Python 实现写进 `codex-rs`。

建议复制 Codex 的产品和架构思想，而不是逐行翻译代码：

- 保留 `Thread -> Turn -> Item` 的会话模型
- 保留事件流驱动 UI 的方式
- 保留工具注册、工具调度、权限审批、输出流式回传的运行模型
- 保留 shell、文件、apply_patch、diff viewer 等核心能力
- 简化 MCP、云任务、复杂 sandbox、OAuth、多人协作等高级能力

## 当前新项目初始状态

`D:\Pycharm Projects\codex-copy` 当前已有：

- `.git/`：项目已初始化 Git
- `.idea/`：IDE 配置
- `.venv/`：本地 Python 虚拟环境
- `main.py`：初始入口文件

当前还没有正式后端、前端、协议层、数据库层或打包脚本。下一步应从最小可运行骨架开始，而不是直接实现完整 Agent。

## 推荐目录结构

建议新项目逐步整理成：

```text
codex-copy/
  backend/
    app/
      main.py
      api/
      core/
      agent/
      protocol/
      tools/
      storage/
      security/
    tests/

  desktop/
    src-tauri/
    src/
      main.ts
      App.vue
      router/
      stores/
      views/
      components/
      features/
      services/
      types/

  own-docs/
    python-codex-clone-development-plan.md
    PROJECT-STATUS.md

  pyproject.toml
  README.md
```

## 建议的重新开始顺序

1. 固定 Python 版本和项目元数据
   - 确认 `.venv` 使用 Python 3.11
   - 新增 `pyproject.toml`
   - 明确包名、格式化工具、测试工具和启动命令

2. 搭建后端最小骨架
   - `backend/app/main.py`
   - `/api/health`
   - 基础配置加载
   - 基础日志
   - 本地开发启动命令

3. 定义核心协议模型
   - `Thread`
   - `Turn`
   - `Item`
   - `Event`
   - `ToolCall`
   - `ApprovalRequest`

4. 实现最小事件流
   - 创建线程
   - 提交用户消息
   - 后端产生 mock assistant 响应
   - WebSocket 或 SSE 推送事件

5. 接入模型适配器
   - 先做 OpenAI-compatible provider
   - 支持配置 `base_url`、`api_key`、`model`
   - 支持 `GET /models`
   - 支持流式输出

6. 实现工具系统
   - shell command
   - 文件读取和搜索
   - apply_patch
   - diff preview
   - approval gate

7. 做桌面端和打包
   - Tauri 启动后端 sidecar
   - Vue UI 接事件流
   - Windows exe 打包验证

## 近期不要做的事

为了保证项目能稳步成型，近期不建议一开始就做：

- 完整 MCP 协议
- 插件市场
- 多 Agent 编排
- 云端任务
- 复杂权限矩阵
- OS 级 sandbox
- 复杂主题和 UI 装饰
- 直接复刻 Codex TUI

这些都可以等核心 Agent loop 稳定后再加。

## 下一步可执行任务

建议下一步直接创建第一个可运行版本：

- `pyproject.toml`
- `backend/app/main.py`
- `backend/app/api/health.py`
- `backend/app/core/config.py`
- `backend/app/core/logging.py`
- `tests/test_health.py`
- `README.md`

目标是运行一个本地 FastAPI 服务，并通过测试验证 `/api/health` 返回正常。

这个阶段完成后，再进入模型配置、线程协议和事件流。
