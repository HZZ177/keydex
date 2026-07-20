# A2UI 决策流（/init-keydex）

本页定义 `/init-keydex` 如何用 Keydex A2UI 完成迁移决策。  
原则：**能点选就不打字；能表格批审就不用长对话。**

## 为什么必须用 A2UI

纯文本迁移确认有三个问题：

1. 资产一多，用户难以勾选/改动作
2. 默认值与风险提示容易被淹没
3. “回复 yes/no”无法表达逐项策略

因此：

| 决策类型 | A2UI | 原因 |
|---|---|---|
| 初始化模式 | `choice` | 少量互斥选项 |
| 资产逐项迁移 | `table` | 多行批审、改动作 |
| 写入策略/冲突策略 | `form` 或 `choice` | 少量高影响参数 |

## 总时序

```text
Discover 完成
  → 简短文字摘要（来源数量/冲突/风险）
  → choice: 选择模式
  → table: 逐项动作（可按模式预填）
  → choice/form: 写入策略
  → 执行
  → 文字报告（不再重复整表）
```

任一交互取消：停止写入，保留可重入。

## 阶段 A：模式选择 `choice`

### 文案建议

- title: `如何初始化这个项目？`
- description: 用 1–2 句写清发现结果  
  例：`发现 Claude 记忆 1 份、skills 3 个；已有 .keydex/keydex.md。推荐合并说明并迁移低风险 skills。`

### 选项

| value | label | badge | recommended |
|---|---|---|---|
| `recommended` | 推荐迁移 | 推荐 | true |
| `memory_only` | 只处理说明文件 | 保守 | false |
| `skills_only` | 只迁移 Skills | 快速 | false |
| `analyze_only` | 只分析项目 | 干净 | false |
| `review_all` | 逐项审核 | 精细 | false |
| `dry_run` | 只预览不写入 | 安全 | false |

### 呈现

- 首次：`presentation_mode: gallery`
- 后续若还有 choice：可改用 `notification_stack`
- 单选：`multiple: false`
- `default_values: ["recommended"]`（若无高风险/覆盖冲突）
- 若已有 `keydex.md` 且内容较长：推荐项 description 强调“合并而非覆盖”

### Agent 行为

1. 调用 `choice` 后停止
2. 根据提交值过滤后续 table 默认行
3. 用户取消 → 结束

## 阶段 B：资产决策 `table`

### 何时必须出表

- 发现任意旧资产，或
- 用户选了 `review_all` / `recommended` / `memory_only` / `skills_only`

### 何时可省略

- `analyze_only` 且无旧资产、无已有 keydex 冲突
- `dry_run` 可出只读倾向表，但 submit 后仍不写文件

### 列（稳定 key，勿改名）

```text
include:boolean
source:text
ecosystem:select(claude|codex|cursor|keydex|project|other)
category:select(memory|skill|rules|config|sensitive|existing)
summary:text
action:select(
  merge_to_keydex_md|
  merge_to_system_keydex_md|
  migrate_skill|
  rename_and_migrate_skill|
  absorb_rules|
  skip|
  manual|
  report_only
)
target:text
risk:select(low|medium|high)
notes:text
```

### 行 id

稳定且唯一，建议：

- `mem:CLAUDE.md`
- `skill:claude:code-review`
- `cfg:claude:settings`
- `exist:keydex.md`

不要用变化的数组下标当 id。

### 预填规则（按模式）

| 模式 | include 预填 |
|---|---|
| `recommended` | 高置信 memory + 低风险无冲突 skill = true；config/sensitive/local = false |
| `memory_only` | 仅 memory/rules 可 true；skill 全 false |
| `skills_only` | 仅 skill 可 true；memory 默认 false（除非无 keydex.md 且用户后续确认） |
| `review_all` | 全部列出，尽量不替用户过度 skip，但高风险仍默认 false |
| `dry_run` | 与 recommended 相同预填，仅预览 |

### table 参数建议

- `allow_add_rows: false`
- `allow_delete_rows: false`
- `submit_label: 确认迁移计划`
- description 写清：`取消不会写入任何文件；排序仅影响查看`

### 提交后校验

1. 若所有 `include=false` 且模式需要写 `keydex.md`：可继续纯项目分析，或再确认一次
2. `action=overwrite` 不在 table 里出现；覆盖策略放到下一阶段
3. `migrate_skill` 但 target 空：自动填规范化 name
4. `risk=high` 且 include=true：进入下一阶段前用文字点名风险（仍不重复整表）

## 阶段 C：写入策略 `choice` / `form`

### C1. 已有 `keydex.md` 时用 `choice`

title: `如何处理现有的 .keydex/keydex.md？`

| value | label | badge |
|---|---|---|
| `merge` | 合并改进（推荐） | 推荐 |
| `overwrite` | 覆盖重写 | 高风险 |
| `skip_md` | 不改说明文件 | 保守 |
| `cancel` | 取消写入 | |

`overwrite` 的 description 必须包含：

- 会替换现有项目说明
- 不会自动备份（除非实现了备份；MVP 默认不承诺）
- 源 Claude/AGENTS 文件不会因此删除

### C2. 补充参数用 `form`（字段少）

title: `确认写入选项`

字段：

| name | type | 默认 | 说明 |
|---|---|---|---|
| `create_skills` | boolean | true/按模式 | 是否迁移 skills |
| `skill_conflict_policy` | select(`skip`/`rename`) | `rename` 或 `skip` | 同名冲突 |
| `prefer_commands_from` | select | `auto` | 命令来源偏好 |
| `detail_report` | boolean | true | 是否输出详细来源列表 |

不要超过 4–5 个字段。

### 组合策略

- 无已有 `keydex.md`：可跳过 C1，直接 form 或默认 merge 语义的 create
- 有 skills 迁移：必须能拿到 conflict policy
- 用户在 table 已把所有 skill include=false：form 里 `create_skills` 默认 false

## 交互文案规范

1. 标题说清**正在决定什么**，不要写“请选择”
2. 风险写在选项 description / 表格 risk 列，不要事后补刀
3. 不要说“如下所示组件”
4. 提交成功后用 3–6 行摘要承接，再执行
5. 执行完成后不要再贴一份同等决策表

## 取消、纠正与重入

| 用户行为 | Agent 行为 |
|---|---|
| choice/table/form 取消 | 停止，不写文件 |
| 提交后改主意 | 允许再说“重新 init / 修改计划”；未写前可重开 A2UI |
| 已写入后改主意 | 说明可再次 `/init-keydex` 做 merge；不自动回滚除非用户明确要求并确认 |
| dry_run 后再正式执行 | 可复用上次 inventory，但建议快速重扫避免过期 |

## 反模式

1. 用 Markdown 列表让用户回复编号
2. 一次抛 20 个 yes/no 问题
3. 未确认就写 `.keydex`
4. table 与 Markdown 表重复展示
5. 把 hooks/settings 默认勾选为迁移
6. 在 A2UI 里模拟权限审批（权限仍走系统审批）

## 最小可行交互（MVP）

若实现资源有限，至少保留：

1. `choice`：recommended / review_all / dry_run
2. `table`：include + action + risk
3. 已有文件时 `choice`：merge / overwrite / cancel

有这三步，迁移体验已显著优于纯文本。
