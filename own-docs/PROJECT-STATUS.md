# codex-copy 项目现状说明

更新时间：2026-06-18

## 当前定位

`codex-copy` 是本地个人型 Codex-like Windows 桌面 Agent，不是官方 Codex Rust 仓库的 fork。官方 Codex 与 AionUi 只作为架构、交互和组件成熟度参考，最终后端保留 Python Agent Runtime，前端保留本项目的 React/Tauri 桌面实现。

## 当前技术栈

后端：

- Python 3.11
- FastAPI
- Pydantic
- SQLite + JSONL rollout
- httpx
- WebSocket runtime event stream

前端：

- React + TypeScript
- Vite
- Arco/CSS Modules
- lucide-react
- React Router
- Vitest + Testing Library

桌面与打包：

- Tauri 2
- Python sidecar
- Windows 桌面端优先

## 当前已完成能力

- React 入口、主题变量、Codex-like AppShell、标题栏、侧边栏和最小路由。
- 快速对话页已按 Codex-like 启动页重构：输入区居中、标题聚焦任务输入，只保留真实可用的模型选择、当前工作区展示和权限模式；未实现的附件按钮、伪工作区选择和重复审批提示不再暴露。
- 首页和对话页共用 SendBox，支持 IME、发送/停止、slash 命令、`@` workspace 搜索、文件 chip、拖拽和粘贴。
- HTTP/WebSocket Runtime Bridge，对接真实 Python 后端。
- Conversation Store、Runtime Event reducer、MessageList 自动滚动和消息分组；历史会话 `thread/detail` 中的已存 items 会重新投影为消息，左侧进入历史会话不再显示空态占位。
- Markdown、thinking、工具、命令、文件 diff、审批和错误组件；thinking/reasoning 按运行时事件顺序内联到正文流里，使用低噪音可展开幽灵面板，不再固定堆到末尾。
- AionUi 类计划卡片：后端已提供正式 `update_plan` 工具，前端把真实工具事件渲染为可折叠计划步骤卡片。
- 已参考 AionUi 补强流式事件缓冲、assistant 文本平滑输出节奏控制、消息自动滚动跟随、消息区单滚动容器、消息 hover/focus 复制时间行、流式 Markdown 未闭合代码块/display math 修复、代码块语法高亮/复制/折叠/diff 行样式、JSON 自动格式化、HTML fenced code sandbox 预览、KaTeX 数学公式渲染、LaTeX delimiter 转换、fenced latex 块渲染、Mermaid fenced code 按需预览、Markdown 表格横向滚动容器、Markdown 图片自适应渲染、选中文本浮动引用工具条，以及 assistant `<think>` 标签过滤。
- 打字机速度改为固定速率，不按积压动态加速；设置页提供滑块，默认 10 字符/秒，偏好存储在本地浏览器存储。
- 工具、命令、文件变更内联块已加入 AionUi 类似的轻量状态点和运行态 breathing 效果；连续工具/文件组折叠态会展示每个步骤的名称、状态点和一行摘要，展开后保留完整详情块。
- 后端 `create_app()` 已注册默认工具编排器，运行时会向 OpenAI-compatible Provider 发送正式 tools schema，并在模型返回 `tool_calls` 后执行真实工具、发出正式 `tool_call` item 事件。
- 模型若忽略 tools schema 并输出 `<tool_call>/<tool_result>` 文本协议，后端会立即失败并停止透出原始标签；前端对历史污染文本只显示协议泄漏提示，不伪装为真实工具执行。
- 模型 Provider 后端存储/API、前端设置页、Provider Modal、模型刷新、搜索、启停、默认模型和健康检查。
- Workspace 后端 API、文件树、文本预览、受 workspace 限制的图片 media data URL 读取和 diff 预览。
- 右侧 Preview 面板已升级为 AionUi 类轻量预览壳，支持 Markdown 渲染/源码切换/源码预览分屏、HTML sandbox 预览/源码预览分屏、图片文件预览、Diff 彩色渲染、JSON 格式化、复制和选区引用；消息内 HTML/Mermaid/Markdown/Diff/JSON 代码块可通过 PreviewProvider 打开到右侧侧栏，预览历史支持最近标签切换和关闭。
- 对话页顶部工作区/预览按钮改为打开右侧 in-flow 侧栏，不再使用窄小 fixed 弹窗；消息区域为底部输入框预留高度，正文不再钻到输入框背后。
- 左侧会话历史加载、本地搜索、恢复、重命名和归档删除。
- 左侧顶部搜索改为 Codex-like 会话搜索弹窗；侧栏内部不再保留重复搜索输入框。
- 页面入口 `lang` 与标题已改为中文；弹窗、输入菜单、选区工具条、右侧预览内部分屏使用统一短时长动效并支持 reduced-motion。
- 旧 Vue SFC、Pinia store 和旧 Vue 测试已从运行时代码中清理。

## 开发原则

- 日常以本地开发和测试为主，非明确要求不做生产构建或打包。
- Python 依赖使用 `uv pip install`。
- 产品路径不允许 mock fallback；缺配置或后端失败要暴露真实错误。
- 测试中允许使用测试替身模拟外部 Provider 或 runtime 调用，但不得进入产品运行时。

## 本地启动

后端：

```powershell
& .\.venv\Scripts\python.exe backend\app\main.py
```

前端：

```powershell
cd .\desktop
pnpm run dev
```

默认地址：

```text
前端：http://127.0.0.1:5173
后端：http://127.0.0.1:8765
```

## 验证命令

后端：

```powershell
& .\.venv\Scripts\python.exe -m ruff check backend\app backend\tests
& .\.venv\Scripts\python.exe -m pytest backend\tests
```

前端：

```powershell
cd .\desktop
npm.cmd run test
```

最近一次前端完整验证：

```text
2026-06-18：npm.cmd run test，44 files / 186 tests passed
2026-06-18：ruff check backend\app backend\tests，passed
2026-06-18：pytest backend\tests，137 passed / 1 warning
```

## 当前计划状态

当前执行计划：

```text
.dev/plans/2026-06-17_18-47-37-aionui-frontend-clone.md
```

Issue 状态源：

```text
.dev/issues/2026-06-17_18-47-37-aionui-frontend-clone.csv
```

视觉参考：

```text
.dev/prototype/img.png
```

最终验收报告落盘：

```text
.dev/test/reports/
```

最近一次 AionUi 流式与 Markdown 复刻记录：

```text
.dev/test/reports/2026-06-18-aionui-streaming-rendering.md
```
