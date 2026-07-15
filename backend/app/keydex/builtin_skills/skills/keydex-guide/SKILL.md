---
name: keydex-guide
description: Keydex 中文产品使用指南。用于回答 Keydex 的界面导航、会话与任务、工作台、项目文件、预览编辑、批注、A2UI、Skill、MCP、模型、设置、安全审批和常见故障等使用问题。适合“在哪里、怎么做、做完会怎样、为什么当前不能操作”类问题；不用于讲解源码架构、内部协议或开发实现。
---

# Keydex 产品使用指南

把本 Skill 当作面向产品用户的交互手册。先解决用户眼前的操作问题，再补充必要说明。

## 回答方式

1. 先判断用户正在使用的模式、会话或面板；只有确实影响操作时才追问。
2. 优先给出“从哪里进入 → 点击什么 → 会看到什么”的最短路径。
3. 使用界面中真实可见的名称，不发明按钮、菜单或能力。
4. 区分“当前不可用”“需要前置配置”“功能本身不支持”三种情况。
5. 操作可能中断任务、覆盖内容、删除数据或扩大权限时，提前说明影响。
6. 遇到异常时，先提供保留用户当前工作的恢复方法，再建议刷新或重试。
7. 只读取与问题直接相关的参考页；跨主题问题再组合读取。

## 导航与模式

- 初次使用、主界面与模式选择：[start-navigation-and-modes.md](references/start-navigation-and-modes.md)
- 首页、项目与模型入口：[home-project-and-model-selection.md](references/home-project-and-model-selection.md)
- 全局侧栏、面板与界面连续性：[shell-sidebars-and-state-continuity.md](references/shell-sidebars-and-state-continuity.md)

## 会话、任务与上下文

- 会话搜索、置顶、重命名、归档与删除：[session-history-and-lifecycle.md](references/session-history-and-lifecycle.md)
- 输入框、附件、粘贴与文件引用：[composer-context-and-attachments.md](references/composer-context-and-attachments.md)
- 回复进行中时的引导与排队：[running-turn-steer-and-queue.md](references/running-turn-steer-and-queue.md)
- 消息、工具过程、审批与失败提示：[messages-tools-approvals-and-errors.md](references/messages-tools-approvals-and-errors.md)
- 目标、计划与上下文整理：[goals-plans-and-context-compression.md](references/goals-plans-and-context-compression.md)
- BTW 临时对话与右侧栏：[sidecar-and-right-sidebar.md](references/sidecar-and-right-sidebar.md)
- 分叉、导出、文件审阅与回退操作：[fork-export-file-review-and-reverse.md](references/fork-export-file-review-and-reverse.md)

## 工作台与文件体系

- 工作台布局与预览标签页：[workbench-layout-and-preview-tabs.md](references/workbench-layout-and-preview-tabs.md)
- 工作台助手与胶囊面板：[workbench-assistant-capsule.md](references/workbench-assistant-capsule.md)
- 文件树筛选、展开、定位与刷新：[workspace-tree-filter-and-locate.md](references/workspace-tree-filter-and-locate.md)
- 文件和目录右键操作：[file-and-directory-context-menus.md](references/file-and-directory-context-menus.md)
- 在会话中引用文件与目录：[file-and-directory-references.md](references/file-and-directory-references.md)
- 预览格式、源码与分屏模式：[preview-formats-and-view-modes.md](references/preview-formats-and-view-modes.md)
- 源码编辑、自动保存与冲突处理：[source-editing-auto-save-and-conflicts.md](references/source-editing-auto-save-and-conflicts.md)
- 文档批注与发送到会话：[document-annotations-and-chat-handoff.md](references/document-annotations-and-chat-handoff.md)
- 大纲、图片、图表与富内容预览：[outline-images-and-rich-previews.md](references/outline-images-and-rich-previews.md)
- 外部文件与只读资源：[external-files-and-readonly-resources.md](references/external-files-and-readonly-resources.md)

## A2UI 交互内容

- A2UI 的使用流程、继续与调试入口：[a2ui-lifecycle-and-debug.md](references/a2ui-lifecycle-and-debug.md)
- 图表内容：[a2ui-chart.md](references/a2ui-chart.md)
- 选择内容：[a2ui-choice.md](references/a2ui-choice.md)
- 表单内容：[a2ui-form.md](references/a2ui-form.md)
- 可编辑表格：[a2ui-table.md](references/a2ui-table.md)

## Skill 与 `.keydex`

- Skill 选择、显示与激活：[skill-selection-and-activation.md](references/skill-selection-and-activation.md)
- 内置、系统级、项目级的范围与优先级：[keydex-scope-priority-and-config.md](references/keydex-scope-priority-and-config.md)
- Skill 内容、资源与创建方式：[skill-structure-resources-and-authoring.md](references/skill-structure-resources-and-authoring.md)
- Skill 安全、诊断与更新规则：[skill-security-diagnostics-and-updates.md](references/skill-security-diagnostics-and-updates.md)

## MCP

- MCP 能做什么与会话中的管理入口：[mcp-overview-and-session-runtime.md](references/mcp-overview-and-session-runtime.md)
- 服务、连接方式与登录认证：[mcp-servers-transports-and-auth.md](references/mcp-servers-transports-and-auth.md)
- 工具展示方式与使用策略：[mcp-tools-exposure-and-policies.md](references/mcp-tools-exposure-and-policies.md)
- 审批、信任与高级交互：[mcp-approvals-trust-and-advanced-interactions.md](references/mcp-approvals-trust-and-advanced-interactions.md)
- 导入导出、审计与故障排查：[mcp-import-export-audit-and-troubleshooting.md](references/mcp-import-export-audit-and-troubleshooting.md)

## 模型、联网、设置与安全

- 模型服务、默认模型与会话切换：[providers-models-and-runtime-selection.md](references/providers-models-and-runtime-selection.md)
- 联网搜索与回答来源：[web-search-and-answer-sources.md](references/web-search-and-answer-sources.md)
- 命令环境、审批与信任：[command-shell-approvals-and-trust.md](references/command-shell-approvals-and-trust.md)
- 文件访问范围与编辑方式：[file-access-and-edit-tool-style.md](references/file-access-and-edit-tool-style.md)
- 扩展功能设置：[extension-settings.md](references/extension-settings.md)
- 用量、项目与归档管理：[usage-project-and-archive-management.md](references/usage-project-and-archive-management.md)
- 通用、外观与应用更新：[general-appearance-and-app-updates.md](references/general-appearance-and-app-updates.md)
- 常见问题与版本边界：[troubleshooting-and-version-boundaries.md](references/troubleshooting-and-version-boundaries.md)

## 必须遵守的产品口径

- 普通 Chat 是不绑定项目的会话，不是独立于 Agent 的第四种顶层模式；它仍可使用最终生效的系统级或内置 Skill，但没有项目文件和项目级 Skill。
- Skill 同名时只向用户展示最终生效的一项：项目级高于系统级，系统级高于内置。不要描述成让用户从三份重复项中选择。
- 内置 Skill 由应用管理，用户不应直接修改；系统级 Skill 属于当前用户；项目级 Skill 随项目保存。
- 工作台主预览、Agent 右侧栏和工作台助手抽屉是不同位置，给路径时明确说清所在区域。
- A2UI 是会话中的图表、选择、表单和表格交互，不替代命令、文件访问或 MCP 的安全审批。
- 文件树目前不提供新建、重命名、移动或删除入口时，不要暗示右键菜单中存在这些操作。
- 项目模式中的预览能力若仍处于预览阶段，应明确提醒用户界面和能力可能继续变化。

## 内容边界

不要主动讲解事件、缓存、协议字段、数据库、内部状态名、源码目录或实现算法。用户明确询问开发实现时，应改为检查当前代码，而不是用本产品指南推断。
