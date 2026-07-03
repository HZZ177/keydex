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

<!-- 截图占位：扩展功能设置页面截图 -->

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
