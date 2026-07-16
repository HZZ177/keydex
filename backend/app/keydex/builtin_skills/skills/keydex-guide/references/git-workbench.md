# Git 工作台

Keydex 的 Git 能力跟随当前加载的项目，只通过两个位置进入：顶部模式切换右侧的 Git 菜单，以及侧边栏中的 Git 工具窗。顶部菜单适合更新、提交、推送、创建或切换分支；工具窗提供本地改动、提交历史、分支与远程、Stash、冲突和高级操作。两个入口读取并修改同一份项目 Git 状态。

## 项目、仓库根与授权

- 未加载项目时，顶部 Git 菜单保持可见但不可用，侧边栏 Git 类型也不可进入。
- 当前项目不是 Git 仓库时，可以从顶部菜单或工具窗初始化仓库。
- 一个项目包含多个 Git 根时，先在工具窗顶部选择仓库。后续命令、历史、Diff 和日志都绑定该仓库，不会把多个根的命令混在一起。
- 项目目录如果位于更上层仓库中，Keydex 只显示祖先仓库候选，不会自动扩大访问范围。用户显式授权后才可把祖先仓库作为 Git 根；授权可撤销。
- Worktree 和 Submodule 会显示各自的仓库身份。Worktree 需要对实际路径单独授权，Submodule 的操作范围会标明父仓库与递归影响。

## 日常操作

### 本地改动与提交

1. 在 Git 工具窗的“本地改动”查看未跟踪、修改、删除、重命名和冲突文件。
2. 选中文件或 hunk 查看 Diff，再暂存或取消暂存。
3. 输入提交说明并提交；首次提交缺少 `user.name` 或 `user.email` 时，按提示设置项目级身份。
4. “Commit and Push”先完成提交，再进入独立的 Push 阶段。Push 失败不会把已成功的提交描述成失败或自动回滚。

丢弃改动、覆盖工作区文件、清理未跟踪文件等操作会先展示影响路径。Hook 失败会保留原始输出，并允许用户修复后重试；Keydex 不会静默绕过 Hook。

### 分支、标签和远程

- 分支树包含本地、远程和标签。可以创建、切换、重命名和删除本地分支，也可显式进入 detached HEAD。
- 删除未合并分支、覆盖同名分支或删除远程引用属于危险操作，需要确认。
- Remote 支持添加、重命名、修改 URL 和删除；删除前会展示受影响的 upstream。
- Upstream 的绑定和解除是显式动作。首次 Push 可以在确认目标 remote 和 branch 后建立 upstream。

### Fetch、Update 与 Push

- Fetch 默认不执行 prune；是否获取标签或清理远程引用由用户明确选择。
- Update Project 默认使用 `ff-only`。分支已经分叉时不会自动降级成 merge 或 rebase，必须由用户选择策略。
- 普通 Push 始终展示 source、remote、target 和 upstream 变化。
- Force Push 只使用 `--force-with-lease`，不提供裸 `--force`。受保护分支会阻止强推；执行前需要第二次确认目标与预期远端提交。

## 风险等级与确认

| 等级 | 典型动作 | 行为 |
|---|---|---|
| 只读 | Status、Diff、History、Compare、Blame、Reflog、日志 | 不修改仓库，可直接刷新或重试。 |
| 本地写入 | Stage、Commit、Checkout、Merge、Rebase、Stash | 展示仓库与目标；可能覆盖文件时增加影响预览。 |
| 远程写入 | Push、删除远程分支、LFS Push | 展示 remote、refspec 与 upstream 变化。 |
| 高风险 | Force-with-lease、Hard Reset、删除、Abort、Skip、递归操作 | 使用与当前仓库版本和操作绑定的确认 token，必要时二次确认。 |

确认只对当前预览有效。仓库版本、目标引用或冲突阶段发生变化后，旧确认失效，需要重新预览。

## 历史、比较与恢复

- 历史页支持图形化 lane、文本/作者/日期/分支/路径筛选、游标分页和提交详情。
- Compare 明确区分单提交、`A..B` 与 `A...B`，并展示实际 merge base。
- Blame 可按窗口加载，并能跳转到对应提交；未提交行会标为工作区内容。
- Reflog 是本地恢复入口。可以从历史位置创建恢复分支，Reset 前必须先查看影响预览。
- Patch 支持工作区、暂存区、提交或范围导出；导入先执行 check，失败时展示 reject 和部分结果。

## 冲突和进行中操作

仓库元数据是恢复状态的事实来源。应用重启或页面刷新后，Merge、Rebase、Cherry-pick、Revert、Stash、Bisect 等进行中状态会重新出现，不依赖浏览器临时状态。

1. 在冲突概览查看冲突类型、允许动作和 stage 1/2/3 内容。
2. 文本冲突可在三方编辑器中对照 BASE、OURS、THEIRS 并编辑 RESULT；二进制或超大文件只提供适用的文件级动作。
3. “保存结果”“标记已解决”“重新打开冲突”是三个独立动作。只有结果已保存并与当前 index 阶段一致时才能标记解决。
4. 所有冲突处理完成后再 Continue。Skip 和 Abort 会展示将丢弃或回退的路径，并要求确认。

不要在未理解影响时使用 Hard Reset、Skip 或 Abort。优先先创建恢复分支、导出 Patch，或使用 Reflog 保留回退点。

## 认证、网络与诊断

- Git 命令以非交互方式运行，不会在后台弹出凭据、SSH 或编辑器窗口。
- 凭据缺失、Credential Helper 失败、SSH host key、权限、网络、超时和非快进会使用不同错误码与帮助动作。
- 操作日志记录仓库、风险、开始/结束时间、耗时、结果和可重试性；密码、token、Authorization header 与带凭据 URL 会被清洗。
- 只有明确安全的动作提供一键重试。需要改目标、补认证或重新确认的失败不会复用旧确认。

## Git LFS

安装 Git LFS 后，工具窗可查看跟踪模式、LFS 文件和锁，并执行常用 Fetch、Pull、Push。Keydex 不自动安装 Git LFS，也不会把 LFS 不可用静默降级成普通 Git 成功；未安装或远端离线时会显示能力状态和帮助信息。

## 能力边界

Keydex 参考 PyCharm 的入口布局和常见操作组织，但不声明与 PyCharm 完全兼容。所有命令通过系统 Git 执行；Keydex 不提供自带 Git，也不会在认证失败时打开交互式终端作为隐式后备。

## LiveAgent attribution

本功能是基于 Keydex 现有 React、FastAPI 和桌面运行时重新实现的。工程实现参考了开源项目 [Stack-Cairn/LiveAgent](https://github.com/Stack-Cairn/LiveAgent) 在固定提交 `1616eb5e574274693dc29e18248650dc30911123` 下的 Git 命令语义、客户端领域词汇和历史图算法，许可证为 MIT，Copyright (c) 2026 Stack-Cairn。

LiveAgent 的 Rust/Tauri 命令和 React UI 仅用于行为分析，没有直接复制进 Keydex。唯一允许移植的是 `crates/agent-gui/src/lib/git/gitGraph.ts` 的纯历史 lane 算法；Keydex 已替换类型、渲染和分页边界，并在 `docs/git-open-source-attribution.md` 与机器可读清单中保留来源、提交和修改说明。
