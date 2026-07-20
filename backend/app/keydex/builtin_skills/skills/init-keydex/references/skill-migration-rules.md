# Skill 迁移规则

## 核心原则

Claude / Codex 的 skill 结构和 Keydex 基本同构（`SKILL.md` + `references/` + 可选 `scripts/`，frontmatter 也是 `name` + `description`）。  
**默认直接复制整个目录，不改正文。** 只做三件事：name 一致性、冲突检查、安全门禁。

## 迁移步骤

1. 把源目录整体复制到 `.keydex/skills/<name>/`
2. 确保 frontmatter `name` 与目录名一致（小写、连字符）
3. 检查与已有 skill 同名冲突 → skip 或 rename
4. 过安全门禁（见下）
5. 不删除源目录

## name 一致性

- 目录名 = frontmatter `name`
- 小写，空白/下划线转 `-`，仅保留 `a-z0-9-`
- 冲突时 rename：`<name>-migrated` / `<name>-from-claude`

## 冲突处理

| 情况 | 处理 |
|---|---|
| 目标已存在且内容实质相同 | skip |
| 目标已存在但内容不同 | rename（默认）或用户选 skip |
| 与 builtin 同名 | 项目级会覆盖内置可见项，在 notes 提示 |

冲突策略由用户在写入策略阶段确认。

## 安全门禁

以下默认不迁（report_only），除非用户在 table 中明确 include：

- 含密钥 / token
- 含破坏性命令（硬重置、强制推送、批量删库）
- 从网络下载并执行未知脚本
- 明显越权（关闭安全、导出凭据）

用户强制 include 高风险项时：在写入策略阶段再次点名风险，不自动提升 Keydex 权限。

## 什么时候才需要改写

绝大多数情况不需要。只有以下情形才动正文：

- frontmatter 有 Claude 专属字段 → 去掉或忽略
- 正文明确依赖 Claude 专属 hook/权限 → 加一句“前置条件：用户已在 Keydex 配置 …”
- 含密钥/本机绝对路径 → 剥离

## 报告格式

```text
Skills 迁移：
- .claude/skills/review → /review （created）
- .claude/skills/deploy → skipped（high risk）
- .claude/skills/test → /test-from-claude （renamed, conflict）
```
