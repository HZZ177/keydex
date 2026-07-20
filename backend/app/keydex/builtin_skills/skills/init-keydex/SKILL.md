---
name: init-keydex
description: |
  初始化当前项目的 Keydex 工作区：分析代码库，扫描并引导迁移 Claude/Codex 等既有 Agent 资产，生成或改进 `.keydex/keydex.md`，可选迁移 skills。
  在用户要求 /init-keydex、初始化项目、生成 keydex.md、从 CLAUDE.md/AGENTS.md/.claude/.agent 迁移、项目入驻、导入旧 Agent 规则时使用。
  必须通过 A2UI（choice / table / form）完成迁移范围与写入策略确认，禁止静默覆盖。
---

# Keydex 项目初始化（/init-keydex）

把本 Skill 当作**项目入驻向导**，不是“再写一份 CLAUDE.md”。

主目标：

1. 从项目事实生成高质量项目说明
2. 盘点旧 Agent 资产（Claude / Codex / Cursor 等）
3. 用 A2UI 让用户决定迁移哪些、如何合并
4. 写入 Keydex 正式入口：`.keydex/keydex.md` + 可选 `.keydex/skills/*`

正式运行时只认 `.keydex/**`。  
扫描 `.claude` / `.agent` 等只是为了**迁移**，迁完后不要并行加载旧文件。

## 硬约束

1. **仅项目会话**可写项目级文件。普通 Chat 只能提示先绑定项目，或仅做系统级说明初始化。
2. **先盘点、再确认、后写入**。未拿到用户 A2UI 确认前，不得创建/覆盖 `.keydex/keydex.md` 或 skills。
3. **默认不删除** `.claude`、`.agent`、`CLAUDE.md`、`AGENTS.md` 等源文件。
4. **配置类默认不迁**：hooks、permissions、MCP、tool allowlist、settings.json。只报告，并提示在 Keydex 设置中重配。
5. **敏感信息默认剥离**：密钥、token、私钥、密码、完整本机绝对路径、个人隐私。
6. `keydex.md` 必须短小可执行，**≤ 32 KiB**。长流程拆到 skills，不要全塞说明文件。
7. 不编造“通用最佳实践”；不枚举易发现目录树；只写跨文件才能知道的信息。
8. 已有 `.keydex/keydex.md` 时默认 **merge**，不是 overwrite。
9. skill 同名冲突默认 **skip** 或 **rename**，不静默覆盖。
10. 决策交互优先使用平台 A2UI：`choice` / `table` / `form`。不要用大段“请回复 1/2/3”代替。
11. 调用交互式 A2UI 后**必须等待用户提交**；不要猜测结果继续写文件。
12. 需要细节时再读本 Skill 的 references；不要一次读完所有资料。

## 阶段总览

```text
0. 前置检查
1. Discover（项目 + 旧资产 + 已有 .keydex）
2. Inventory 摘要（A2UI choice：模式选择）
3. 迁移决策（A2UI table：逐项动作）
4. 写入策略确认（A2UI form/choice：merge/overwrite 等）
5. 执行写入
6. 结果汇报 + 验证清单
```

详细扫描清单与字段定义见：

- [scan-and-classify.md](references/scan-and-classify.md)
- [a2ui-decision-flow.md](references/a2ui-decision-flow.md)
- [keydex-md-template.md](references/keydex-md-template.md)
- [skill-migration-rules.md](references/skill-migration-rules.md)

---

## 阶段 0：前置检查

1. 确认当前是**项目会话**，且项目根路径明确。
2. 确认可写范围覆盖项目根（至少能写 `.keydex/`）。
3. 若用户只想“看看会迁什么”，进入 dry-run：只盘点与展示，不写文件。

若不满足项目会话：

- 说明：项目级 `/init-keydex` 需要绑定项目
- 可选：询问是否只初始化系统级 `~/.keydex/keydex.md`
- 不要强行扫描无权限目录

---

## 阶段 1：Discover

可并行收集三类信号。保持克制，先顶层后深入。

### 1A. 项目本体

优先读取：

- `README*`
- 包管理/工程清单：`package.json`、`pyproject.toml`、`Cargo.toml`、`go.mod`、`pom.xml`、`build.gradle*`、`Makefile`、`CMakeLists.txt`
- 测试/质量配置线索
- 顶层目录结构（depth 1–2）
- CI 入口（如 `.github/workflows`）仅在有助于提取命令时读取

产出：

- 项目做什么 / 不做什么
- 关键目录职责
- 常用命令（build / lint / test / 单测）
- 验证方式与风险边界

### 1B. 旧 Agent 资产

至少扫描（存在才读内容）：

| 来源 | 路径模式 |
|---|---|
| Claude 记忆 | `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md` |
| Claude skills | `.claude/skills/**/SKILL.md` |
| Claude 其他 | `.claude/commands/**`、`.claude/rules/**`、`.claude/settings*.json` |
| Codex / 通用 | `AGENTS.md`、`AGENTS.override.md`、子目录 `**/AGENTS.md`（有界） |
| Agent 变体 | `.agent/**`、`.agents/**`、`agents.md` |
| 编辑器规则 | `.cursorrules`、`.cursor/rules/**`、`.github/copilot-instructions.md` |

对每个命中项生成标准化 inventory 记录，字段见 [scan-and-classify.md](references/scan-and-classify.md)。

### 1C. 已有 Keydex 状态

检查：

- `.keydex/keydex.md` 是否存在、大小、摘要
- `.keydex/skills/*` 现有 skill 名
- 与待迁 skill 的同名冲突

---

## 阶段 2：Inventory 摘要 + 模式选择（A2UI choice）

Discover 后，用**简短结论文字**说明发现了什么，然后立刻用 `choice` 让用户选模式。

### choice 设计要求

- `title`：例如「如何初始化这个项目？」
- `presentation_mode`：优先 `gallery`；若连续多次选择可与 `notification_stack` 交替
- 单选
- 选项至少包含：

| value | label | 说明 |
|---|---|---|
| `recommended` | 推荐迁移 | 项目分析 + 迁移高置信 memory/skills（默认） |
| `memory_only` | 只处理说明文件 | 只生成/合并 `keydex.md`，不迁 skills |
| `skills_only` | 只迁移 skills | 不改 `keydex.md`（若已有） |
| `analyze_only` | 只分析项目 | 忽略旧资产，直接生成/改进 `keydex.md` |
| `review_all` | 我要逐项审核 | 进入完整 table，逐条改动作 |
| `dry_run` | 只预览不写入 | 展示计划后结束 |

- `recommended: true` 标在推荐项
- 若检测到高风险资产或已有 `keydex.md`，在 description 中点明

**等待用户提交后再继续。**

若用户取消：停止，不写文件，说明可再次 `/init-keydex`。

---

## 阶段 3：迁移决策表（A2UI table）

除 `analyze_only` 且无旧资产外，都应给出决策表。  
`recommended` / `memory_only` / `skills_only` 也要出表，但预填默认动作，用户可改。

### table 设计要求

- `title`：例如「选择要迁移的资产」
- `allow_add_rows: false`
- `allow_delete_rows: false`（或 true 仅当需要移除噪声项；默认 false）
- `submit_label`：`确认迁移计划`

#### 列定义（稳定 key）

| key | label | type | 说明 |
|---|---|---|---|
| `include` | 纳入 | boolean | 是否处理该项 |
| `source` | 来源 | text | 相对路径 |
| `ecosystem` | 生态 | select | claude / codex / cursor / keydex / project |
| `category` | 类别 | select | memory / skill / rules / config / sensitive / existing |
| `summary` | 摘要 | text | 一两句 |
| `action` | 动作 | select | 见下 |
| `target` | 目标 | text | 如 `.keydex/keydex.md` 或 skill 名 |
| `risk` | 风险 | select | low / medium / high |
| `notes` | 备注 | text | 冲突、敏感、建议原因 |

#### action 枚举

- `merge_to_keydex_md`：吸收进项目 `keydex.md`
- `merge_to_system_keydex_md`：吸收进系统级（仅跨项目偏好，慎用）
- `migrate_skill`：迁为 `.keydex/skills/<name>`
- `rename_and_migrate_skill`：改名后迁移
- `absorb_rules`：规则要点并入 `keydex.md`（不保留原结构）
- `skip`：跳过
- `manual`：仅提示用户手动处理
- `report_only`：配置/敏感项，只报告

#### 默认预填策略

| 条件 | 默认 |
|---|---|
| 项目级 `CLAUDE.md` / `AGENTS.md` | `include=true`, `merge_to_keydex_md` |
| `CLAUDE.local.md` / 用户级偏好 | `include=false` 或 `manual` |
| 低风险 skill，无同名冲突 | `include=true`, `migrate_skill` |
| skill 同名冲突 | `include=false`, `rename_and_migrate_skill` 或 `skip` |
| settings/hooks/permissions | `include=false`, `report_only` |
| 含密钥/高危命令 | `include=false`, `report_only`, `risk=high` |
| 已有 keydex skill 同内容 | `skip` |
| cursor/copilot 规则 | `absorb_rules` 或按模式决定 |

表格提交后：

1. 校验至少有一条有效动作，或用户明确选择“只分析”
2. 若全部 skip 且无项目分析写入，向用户确认是否结束
3. **不要**把 table 内容再抄成 Markdown 大表复述

---

## 阶段 4：写入策略确认（A2UI form 或 choice）

在真正写文件前，再确认一次高影响策略。

### 若目标 `keydex.md` 已存在：用 choice

选项：

- `merge`（推荐）：保留现有有效内容，吸收新事实与勾选迁移项
- `overwrite`：仅在用户明确要求时可用；description 必须提示不可自动撤销
- `skip_md`：不改 `keydex.md`，只处理 skills
- `cancel`：取消本次写入

### 附加选项可用 form（字段宜少）

- `create_skills`（boolean）：是否执行 skill 迁移
- `skill_conflict_policy`（select）：`skip` / `rename`
- `open_report_detail`（boolean）：结果是否输出详细来源列表
- `prefer_commands_from`（select，可选）：`package_scripts` / `makefile` / `readme` / `auto`

涉及 overwrite 时，description 必须写清风险。  
**等待提交。**

---

## 阶段 5：执行写入

只执行用户确认的动作。

### 5A. 生成/合并 `.keydex/keydex.md`

1. 使用 [keydex-md-template.md](references/keydex-md-template.md) 结构
2. 合并优先级（高 → 低）：
   1. 用户本轮确认
   2. 现有 `.keydex/keydex.md`
   3. 项目级 CLAUDE/AGENTS 中仍有效的共享规则
   4. README / 工程清单中的事实
   5. 代码分析推断（可追溯）
   6. 禁止通用套话
3. 从迁移源吸收时做清洗：
   - 去掉工具专属权限/hook 语法
   - 去掉密钥与本机绝对路径
   - 把长流程改写为“见 skill: xxx”而不是全文粘贴
4. 控制体积 ≤ 32 KiB
5. 写入 `.keydex/keydex.md`（必要时先创建 `.keydex/`）

### 5B. 迁移 skills

按 [skill-migration-rules.md](references/skill-migration-rules.md)：

1. 仅处理 `action=migrate_skill|rename_and_migrate_skill` 且 `include=true`
2. 把源目录整体复制到 `.keydex/skills/<name>/`，默认不改正文
3. 确保 frontmatter `name` 与目录名一致（小写、连字符）
4. 冲突按用户策略 skip/rename
5. 过安全门禁（密钥/破坏性命令默认 report_only）
6. 不删除源 skill
7. 迁移后列出调用映射：`原路径/原名` → `/新名`

### 5C. 明确不做的事

- 不写 `CLAUDE.md` 兼容层加载器
- 不自动改 Keydex 权限/MCP 设置
- 不删除旧生态目录
- 不提交 git

---

## 阶段 6：结果汇报

用简洁中文汇报，不重复整份文件。

必须包含：

1. **写了什么**
   - `.keydex/keydex.md`：created / merged / skipped
   - skills：迁入列表
2. **跳过了什么 + 原因**
3. **需手动处理**
   - hooks / permissions / MCP 等
4. **验证清单**
   - 新开一轮项目会话，确认说明已生效
   - 如有 skill，用 `/skill-name` 试触发
   - 与用户本轮要求冲突时以本轮为准
5. **源文件仍保留**（提醒用户）

若用户选择 dry-run：只输出将要执行的计划，明确“未写入”。

---

## A2UI 使用原则（强制）

1. 需要用户做选择/勾选/填策略时，**优先 A2UI**，不要纯文本菜单。
2. 多行资产审核用 `table`；少选项模式用 `choice`；少量参数用 `form`。
3. 调用后等待提交；取消即停。
4. 不要在正文再说“下面是表格/选项组件”。
5. 不要用 Markdown 表格重复渲染同一决策数据。
6. 高风险动作（overwrite、迁高风险 skill）必须在 UI 文案中可见。
7. 连续多次 `choice` 时，可在 `gallery` 与 `notification_stack` 间交替，避免界面单调。

---

## 失败与回退

| 情况 | 处理 |
|---|---|
| 无项目绑定 | 停止项目写入，说明如何绑定项目 |
| 无读权限 | 报告缺口，基于已有信息继续或请求扩大范围 |
| 扫描为空 | 仍可纯项目分析生成 `keydex.md` |
| 用户取消 A2UI | 不写文件，保留可重入 |
| 写入失败 | 报告失败路径与原因；已成功项与未成功项分开列 |
| `keydex.md` 将超 32KiB | 压缩或拆 skill 后再写，不硬塞 |
| skill 转换失败 | 跳过该项并记录，不影响其他项 |

---

## 完成标准

满足以下条件才算完成本次 `/init-keydex`：

1. 完成盘点（或明确无旧资产）
2. 关键写入策略已经用户 A2UI 确认（除非 dry-run）
3. 按确认结果写入或明确跳过
4. 给出迁移报告与验证建议
5. 未静默删除旧资产，未静默覆盖未确认文件
