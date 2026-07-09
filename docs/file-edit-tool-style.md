# 文件编辑工具风格

## 背景

Keydex 支持两套模型可见的文件编辑工具风格，通过运行时配置
`file_edit_tool_style` 控制。配置只影响后续新一轮 Agent 运行时暴露给模型的工具集和文件编辑提示词，不回写历史消息。

可选值：

- `claude_code`：默认值，暴露 `create_file`、`edit_file`、`delete_file`、`move_file`。
- `codex`：暴露单一 `apply_patch`，并支持 `*** Add File`、`*** Update File`、`*** Delete File`、`*** Move to`。

## Claude Code 源码参考

本轮设计参考本地 Claude Code 源码 `D:\cc2.1.88-破解`：

- `src\tools\FileEditTool\types.ts`：`Edit` 入参是 `file_path`、`old_string`、`new_string`、`replace_all`。
- `src\tools\FileEditTool\FileEditTool.ts`：编辑前要求读文件；`old_string === new_string` 会失败；读取后文件变更会失败；多匹配时除非 `replace_all` 否则失败。
- `src\tools\FileEditTool\utils.ts`：替换逻辑按 `replace` 或 `replaceAll` 执行。
- `src\tools\FileWriteTool\FileWriteTool.ts`：写文件同样有读后写和 mtime 防并发修改语义。

Keydex 没有直接复刻 Claude Code 的大小写工具名，而是使用既有 snake_case 工具名。Keydex 也没有让 `edit_file(old_string="")` 创建文件，创建文件仍由 `create_file` 承担，以降低误覆盖风险。

## 后端实现边界

主要入口：

- `backend/app/agent/runtime_settings.py`：定义 `file_edit_tool_style`。
- `backend/app/tools/factory.py`：注册全量工具，并按风格过滤模型可见工具。
- `backend/app/agent/runner.py`：根据运行时配置装配工具和动态文件编辑提示词。
- `backend/app/agent/system_prompt.py`：生成 Claude Code 风格或 Codex 风格的文件编辑提示词。
- `backend/app/tools/edit_ops.py`：实现 `edit_file`、`delete_file`、`move_file`。
- `backend/app/tools/file_snapshots.py`：维护 read snapshot，用于读后写和 stale file 检测。
- `backend/app/tools/patch.py`：实现 Codex 风格 `apply_patch`，包括 `*** Add File`。

Claude Code 风格要求：

- 修改、删除、移动已有文件前，必须先完整 `read_file`。
- `edit_file` 的 `old_string` 必须非空，且默认只能匹配一次。
- 多处匹配必须设置 `replace_all=true`。
- 读后文件发生变化时拒绝写入，要求重新读取。

Codex 风格要求：

- 所有文件新增、修改、删除、移动都通过 `apply_patch(patch)`。
- 新增文件使用 `*** Add File: <path>`，正文每行以 `+` 开头。
- 更新文件使用 `*** Update File: <path>` 和 `@@` hunk。
- 删除文件使用 `*** Delete File: <path>`。
- 移动文件在 `*** Update File` 后紧跟 `*** Move to: <new-path>`。

## 前端与事件兼容

主要入口：

- `desktop/src/types/protocol.ts`：前端协议类型包含 `file_edit_tool_style`。
- `desktop/src/renderer/pages/settings/config/ConfigSettingsPage.tsx`：策略配置页展示文件编辑工具风格。
- `desktop/src/renderer/pages/settings/extensions/ExtensionSettingsPage.tsx`：扩展设置整包保存时保留隐藏的 `file_edit_tool_style`。
- `desktop/src/renderer/utils/fileReview.ts`：统一识别 add/update/delete/move 文件变更。
- `desktop/src/renderer/pages/conversation/messages/ToolCallBlock.tsx`：工具调用摘要和文件 review 入口。
- `desktop/src/renderer/pages/conversation/messages/FileChangeBlock.tsx`：单条文件变更展示。
- `desktop/src/renderer/pages/conversation/messages/MessageGroupBlock.tsx`：文件变更分组聚合。

历史兼容：

- 历史消息里的 `edit_file(patch=...)` 仍按旧 patch 参数展示为文件变更。
- 新的 Claude Code 风格 `edit_file(path, old_string, new_string)` 不接受 `patch` 参数。
- `apply_patch` 的 Add File 会在 UI 中显示为创建文件，而不是编辑文件。
- `delete_file` 和 `move_file` 会进入文件 review 流程，而不是普通工具 JSON 展示。

## 验证命令

后端聚焦测试：

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests\tools\test_patch.py backend\tests\tools\test_filesystem.py backend\tests\tools\test_edit_ops.py backend\tests\tools\test_file_edit_snapshots.py backend\tests\tools\test_registry.py backend\tests\agent\test_tool_call_progress.py backend\tests\agent\test_agent_runner.py backend\tests\agent\test_system_prompt.py backend\tests\agent\test_system_prompt_file_links.py backend\tests\settings\test_agent_runtime_settings.py backend\tests\api\test_extension_settings_api.py
```

前端聚焦测试：

```powershell
npm --prefix desktop run test -- agent-protocol-types.spec.ts config-settings-page.spec.tsx extension-settings-page.spec.tsx file-change-block.spec.tsx message-list.spec.tsx tool-call-block.spec.tsx agent-session-store.spec.ts conversation-message-adapter.spec.ts conversation-panel-model.spec.tsx conversation-layout.spec.tsx conversation-page-goal.spec.tsx conversation-page-skill.spec.tsx conversation-skill-errors.spec.tsx
```

E2E 聚焦测试需要先启动 Vite。若本机 Playwright bundled chromium 缺失，可以通过 `PLAYWRIGHT_EXECUTABLE_PATH` 指向系统 Chrome：

```powershell
npm --prefix desktop run dev
$env:E2E_BASE_URL='http://127.0.0.1:5174'
$env:PLAYWRIGHT_EXECUTABLE_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
Push-Location desktop
npm exec playwright test -- file-review.spec.ts command-approval-config.spec.ts -g "file edit tool style|add-file|move_file|legacy edit_file|recoverable error" --workers=1
Pop-Location
```
