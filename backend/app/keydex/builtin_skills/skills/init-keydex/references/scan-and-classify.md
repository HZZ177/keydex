# 扫描与分类规则

## 目标

把仓库中的“项目事实”和“旧 Agent 资产”变成统一 inventory，供 A2UI 决策表使用。

## 扫描预算（避免过度探索）

1. 先顶层，后按需深入
2. 目录列举优先 depth=1–2
3. 子目录 `AGENTS.md` 最多扫描有界集合（如 top-level 子项目），不要全盘递归无限制
4. 二进制、依赖目录默认跳过：`node_modules`、`.git`、`dist`、`build`、`.venv` 等
5. 单个说明文件过大时：读标题/目录/前后各一段，做摘要，不必全文灌入最终 `keydex.md`

## Inventory 记录结构

每条资产一条：

```json
{
  "id": "skill:claude:review",
  "source": ".claude/skills/review/SKILL.md",
  "ecosystem": "claude",
  "category": "skill",
  "title": "review",
  "summary": "PR 审查流程，含检查清单",
  "signals": ["has_frontmatter", "has_steps"],
  "risk": "low",
  "default_action": "migrate_skill",
  "default_include": true,
  "target": "review",
  "conflict_with": null,
  "notes": ""
}
```

## 路径 → 生态/类别映射

| 路径模式 | ecosystem | category | 默认 action |
|---|---|---|---|
| `CLAUDE.md` | claude | memory | merge_to_keydex_md |
| `.claude/CLAUDE.md` | claude | memory | merge_to_keydex_md |
| `CLAUDE.local.md` | claude | memory | manual / skip |
| `.claude/skills/**/SKILL.md` | claude | skill | migrate_skill |
| `.claude/commands/**` | claude | rules | absorb_rules 或 migrate_skill（若已是完整流程） |
| `.claude/rules/**` | claude | rules | absorb_rules |
| `.claude/settings*.json` | claude | config | report_only |
| `AGENTS.md` | codex | memory | merge_to_keydex_md |
| `AGENTS.override.md` | codex | memory | merge_to_keydex_md（注意覆盖语义） |
| `**/AGENTS.md`（子目录） | codex | memory | 合并“仍全局有效”部分，否则 skip/manual |
| `.agent/**`、`.agents/**` | other | 按内容 | 见内容识别 |
| `.cursorrules`、`.cursor/rules/**` | cursor | rules | absorb_rules |
| `.github/copilot-instructions.md` | other | rules | absorb_rules |
| `.keydex/keydex.md` | keydex | existing | merge（作为目标基底） |
| `.keydex/skills/**` | keydex | existing | 冲突检测源 |

## `.agent` / `.agents` 内容识别

这些目录没有单一标准，按内容归类：

1. 存在 `SKILL.md` / `*.md` 且像流程说明 → skill 或 rules
2. 存在 agent 定义（工具列表、persona）→ report_only 或 absorb 适用约定
3. 存在配置 JSON/YAML（权限、MCP）→ config / report_only
4. 无法判断 → category=rules 或 other，默认 skip，notes 标明需人工看

## 风险分级

| risk | 条件 |
|---|---|
| low | 纯说明/清单，无密钥，无破坏性命令 |
| medium | 含环境相关路径、较强流程约束、可能过时 |
| high | 疑似密钥/token、删库/强制 push、下载执行脚本、权限放宽 |

高风险默认 `default_include=false`，`default_action=report_only`。

## 敏感信息检测（启发式）

命中则标 high / sensitive，并在吸收时剥离：

- `api_key`、`secret`、`token`、`password`、`BEGIN PRIVATE KEY`
- 长随机串赋值
- 明确的本机用户目录绝对路径（可保留相对路径语义）

## 项目本体信号（非旧资产）

这些通常不进入迁移表，而进入 `keydex.md` 草稿：

- README 项目目的
- package scripts / pyproject scripts / Makefile targets
- 测试命令
- monorepo 子项目边界
- 贡献/验证约定

若与 CLAUDE/AGENTS 冲突：以更近、更可验证的工程文件为准，并在 notes 记录。

## 去重

1. 同一文件多路径（罕见）→ 保留一
2. `CLAUDE.md` 与 `.claude/CLAUDE.md` 同时存在 → 两条都列，但建议只 merge 一份主内容，另一份 notes 写“可能重复”
3. skill 与 commands 同名同内容 → 优先 skill 形态迁移

## 分类结果如何服务 A2UI

- `category=memory|rules` → 影响 `keydex.md`
- `category=skill` → 影响 `.keydex/skills`
- `category=config|sensitive` → 默认不迁，只报告
- `category=existing` → 决定 merge/overwrite，不作为“外部导入源”删除

## 输出给决策表前的精简

如果资产 > 30 条：

1. 先聚合 config 为单行摘要（如“3 个 Claude settings/hooks”）
2. skills 保持逐条
3. memory 文件保持逐条
4. 在 choice description 中说明“已聚合 N 项配置”
