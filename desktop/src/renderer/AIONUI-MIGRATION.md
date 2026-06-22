# AionUi 迁移边界

本文件记录 `keydex` 前端迁移时对 AionUi 的使用边界。AionUi 只作为成熟 React renderer 交互与组件实现参考，最终产品仍是本项目的本地个人型 Codex-like Windows 桌面 Agent。

## 来源

- 参考仓库：`D:\Pycharm Projects\AionUi`
- 许可：Apache-2.0
- 参考范围：仅限 renderer 层的 UI 结构、交互模式、状态处理经验和样式组织方式。

如果直接复制或改写 AionUi 源文件中的实质代码，目标文件头部必须保留来源说明：

```text
Derived from AionUi (Apache-2.0).
Source: <AionUi relative path>
Modified for keydex.
```

如果只是重新实现同类交互，不需要在每个文件头部加来源说明，但实现必须遵守本文件的删除边界。

## 可参考模块

| 能力 | AionUi 路径 | 使用方式 |
|------|-------------|----------|
| React 入口与 Provider | `packages/desktop/src/renderer/main.tsx` | 参考 Provider 组合方式；删除 Auth、Feedback、Sentry、PWA 和商业化入口 |
| App Layout | `packages/desktop/src/renderer/components/layout/Layout.tsx` | 参考桌面壳组织方式；最终视觉对齐 Codex 极简布局 |
| 左侧栏 | `packages/desktop/src/renderer/components/layout/Sider/index.tsx` | 参考折叠、历史列表和导航交互；只保留快速对话、搜索、项目历史、设置、主题 |
| 标题栏 | `packages/desktop/src/renderer/components/layout/Titlebar/index.tsx` | 参考窗口按钮与拖拽区域；Electron IPC 必须替换为 Tauri window API |
| 快速对话启动页 | Codex 桌面快速对话页截图与 AionUi SendBox 交互经验 | 输入区居中，标题直指任务输入；当前只呈现真实可用的模型选择，不做伪工作区、伪权限模式、不可用附件按钮或重复审批提示 |
| 对话布局 | `packages/desktop/src/renderer/pages/conversation/components/ChatLayout/index.tsx` | 参考 chat 不卸载、preview/split 状态经验；默认不做常驻三栏 |
| SendBox | `packages/desktop/src/renderer/components/chat/SendBox/index.tsx` | 参考自动高度、IME、发送/停止、slash、@ 文件菜单；删除语音、BTW、DOM snippet |
| MessageList | `packages/desktop/src/renderer/pages/conversation/Messages/MessageList.tsx` | 参考自动滚动、手动上滚检测、滚动到底按钮、hover action row，以及多段 AI 回复只在末尾显示动作行；消息正文不再额外创建内部滚动条 |
| Thinking | `packages/desktop/src/renderer/pages/conversation/Messages/components/MessageThinking.tsx` | 参考折叠、计时、running/done/failed 状态；按 runtime event 时序内联在正文流里，以幽灵面板呈现 |
| 计划卡片 | `packages/desktop/src/renderer/pages/conversation/Messages/components/MessagePlan.tsx` | 参考 To do list 展开/折叠和步骤状态；本项目通过正式 `update_plan` 工具事件驱动 |
| 工具组摘要 | `packages/desktop/src/renderer/pages/conversation/Messages/components/MessageToolGroupSummary.tsx` | 参考工具步骤列表、状态点、运行态 breathing 和详情展开；本项目从现有 runtime message payload 生成 compact summary |
| Preview 面板 | `packages/desktop/src/renderer/pages/conversation/Preview/components/PreviewPanel`、`MarkdownViewer`、`HTMLViewer`、`DiffViewer` | 参考模式切换、源码/预览分屏、工具栏、Markdown/HTML/Diff 专用渲染和轻量多标签历史；删除快照版本、编辑保存、HTML inspect 等重功能 |
| 右侧侧栏 | Codex 右侧工作区/预览面板与 AionUi PreviewPanel 经验 | 工作区和预览作为对话页右侧 in-flow side rail，不再使用窄小 fixed 弹窗 |
| 会话搜索 | Codex 会话搜索入口与 AionUi 历史列表经验 | 左侧顶部搜索打开 session 搜索弹窗；侧栏内不保留重复搜索输入 |
| 图片预览 | `packages/desktop/src/renderer/pages/conversation/Preview/components/viewers/ImageViewer.tsx` | 参考图片居中、加载/失败状态和 object-contain；本项目通过 Python workspace media API 返回 data URL |
| Markdown 图片 | `packages/desktop/src/renderer/pages/conversation/Preview/components/viewers/MarkdownViewer.tsx` | 参考相对图片解析和加载状态；本项目通过 Python workspace media API 返回 data URL |
| 选中文本工具条 | `packages/desktop/src/renderer/hooks/ui/useTextSelection.ts`、`packages/desktop/src/renderer/pages/conversation/Preview/components/renderers/SelectionToolbar.tsx` | 参考选区检测和悬浮操作；本项目落成“添加到对话”，覆盖消息正文和 Preview 正文 |
| Preview 打开事件 | `packages/desktop/src/renderer/components/Markdown/MermaidBlock.tsx` | 参考 `openPreview(...)` 交互；本项目用 `PreviewProvider` 承载消息富格式内容预览请求 |
| 模型设置 | `packages/desktop/src/renderer/components/settings/SettingsModal/contents/ModelModalContent.tsx` | 裁剪为 OpenAI-compatible Provider 管理 |
| HTTP bridge | `packages/desktop/src/renderer/common/adapter/httpBridge.ts` | 只参考 facade 思想；不得迁移 stub fallback |
| 主题样式 | `packages/desktop/src/renderer/styles/themes/base.css`、`default-color-scheme.css` | 参考语义变量和 Arco override；最终色彩以 Codex 质感和 `.dev/prototype/img.png` 为准 |

## 必须重写或替换

| AionUi 能力 | 本项目处理方式 |
|-------------|----------------|
| Electron main / preload / IPC | 不迁移；全部替换为 Tauri 2 + FastAPI runtime adapter |
| 多 CLI agent 接入 | 不迁移；后端只接本项目 Python Agent Runtime |
| 模型服务后端 | 不迁移；使用本项目 OpenAI-compatible Provider API |
| 文件系统访问 | 不迁移 Electron 直读；走 Python 后端 workspace API |
| 命令执行 | 不迁移 Electron/Node 执行链路；只渲染后端事件 |
| 工具注册 | 使用本项目 Python `default_tool_registry()` 和 `ToolOrchestrator`，由后端正式向模型发送 OpenAI-compatible tools schema |
| 数据库与账号体系 | 不迁移；使用本项目 SQLite/JSONL 和本地设置 |
| 反馈、Sentry、深链、更新器 | 不迁移 |

## 明确删除

- Team
- Cron / Scheduled
- 自动化
- Agent Hub
- WebUI / remote
- 桌宠
- 多渠道机器人
- 商业账号、订阅、反馈系统
- PWA / 移动端优先适配
- 语音输入
- BTW side question
- DOM snippet
- 对话导出命令
- mock fallback / stub fallback

## 本项目保留目标

- Codex-like 轻量桌面壳。
- 左侧项目和会话历史。
- 文档式对话主画布。
- 底部悬浮 SendBox。
- 真实模型流式输出。
- 正式 tools schema 注入与真实工具执行事件；不把模型输出的 `<tool_call>` 文本伪装成已执行工具。
- thinking / reasoning 折叠行。
- `update_plan` 工具驱动的计划步骤卡片，支持完成/进行中/待处理状态和展开折叠。
- 工具、命令、diff、审批的低噪音内联块；连续工具/文件组在折叠态也显示 compact step summary。
- 消息复制/时间行默认低噪音隐藏，hover/focus 时显现；多段 AI 回复只在一轮末尾显示一次。
- OpenAI-compatible Provider 设置、刷新、搜索选择和健康检查。
- 打字机使用内部基础速度 + backlog 目标清空动态加速：基础速度为 120 字符/秒；运行时 backlog 超过舒适区后按约 1.4 秒清空目标提速，运行时速度最高 640 字符/秒，不再提供手动速度设置。
- 输入框上方的打字机胶囊显示运行时真实输出速率与当前缓冲区待输出字符数：空闲为 0 字符/秒 / 待输出 0 字，消息动画输出期间按当前 backlog 算出的有效速率与剩余 backlog 实时更新。
- 按需 workspace 文件树、搜索和 AionUi 类轻量 Preview 面板。
- 消息内富格式代码块打开到右侧 Preview 面板的事件通道。
- 消息区和 Preview 正文支持选中文本后添加到对话输入区。
- 工作区图片文件可直接在 Preview 面板中按图片查看，不走文本读取链路。
- Preview 面板保留最近预览历史标签，支持切换和关闭；不迁移 AionUi 文件快照版本管理。
- Preview 面板对 Markdown、HTML、Mermaid 保留源码/预览同屏查看，Diff 继续使用专用彩色渲染。

## 旧前端清理状态

- 旧 Vue SFC、Pinia store 和旧 Vue 单测已从 `desktop/src` 运行时代码中移除。
- 当前前端入口固定为 `desktop/src/main.tsx` + `desktop/src/App.tsx`。
- 后续前端测试以 `desktop/tests/*.spec.ts(x)` 的 React/Vitest 测试为准。
- `desktop/src/api` 中未参与 React 入口的旧 API 适配文件暂不作为 UI 运行时代码使用；若后续确认无参考价值，再单独清理。

## 实施规则

1. 每个迁移 issue 开始前先确认本文件对应边界。
2. UI 组件可以参考 AionUi 结构，但默认优先重写为本项目语义。
3. 任何后端、IPC、数据库、账号、商业化、远程服务代码都不得复制。
4. 后端能力缺失时补正式 Python API，不允许前端伪造数据通过。
5. 视觉最终以 `.dev/prototype/img.png` 和 Codex 桌面端质感为准，AionUi 不作为最终外观目标。
