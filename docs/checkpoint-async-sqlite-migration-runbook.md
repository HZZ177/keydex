# Checkpoint Async SQLite 不可逆迁移运行手册

本文用于 Keydex 从旧 `checkpoints_v2/checkpoint_writes_v2` 全量快照存储升级到
LangGraph 官方 `AsyncSqliteSaver` 表结构。迁移采用破坏式 collapse：保留每个
`thread_id + checkpoint_ns` 的最新可继续状态，继续保留业务表中的历史消息，但不保留
迁移边界之前的 checkpoint 时间旅行能力。

## 1. 用户可见流程

触发时机是安装新版本后的第一次启动。后端在 Agent runtime 开放前检查旧 checkpoint
数据；只要真实旧表中仍有 checkpoint 或 pending write，就进入 `required` 状态。
没有旧数据的安装不会显示迁移弹窗。

检测到旧数据后，桌面端显示不可关闭、不可按 Escape 或点击遮罩绕过的阻塞弹窗：

1. 用户点击“开始迁移”。
2. 弹窗只显示一个总进度条和整数百分比，不显示会话数、checkpoint 数、文件路径、
   阶段名或内部错误详情。
3. 迁移过程中 Agent、会话写入、fork、reverse 和清理操作都保持关闭。
4. 成功状态固定显示 `100%`，此时才出现“进入 Keydex”按钮。
5. 用户点击后写入持久化确认；下次启动直接进入应用。

失败时弹窗仍不可关闭，只显示经过白名单处理的可操作提示和“重试”。重复点击开始、
重试或确认都是幂等操作，不会建立第二份迁移。

## 2. 能力边界

迁移完成后：

- 历史会话和 `message_events` 中的历史对话仍可正常查看；
- 每个旧 checkpoint namespace 生成一个官方格式的完整根 checkpoint；
- 用户可以从保留的最新状态继续对话，新轮次使用 delta + 周期性快照写入；
- 迁移边界之后创建的 checkpoint 可继续支持现有 fork、reverse 和压缩能力；
- 迁移边界之前的指定 checkpoint fork、reverse 或逐 checkpoint 回溯不再可用；
- session 上的 lineage epoch、history floor、root checkpoint 和 migration id 明确记录
  这条边界，不会把旧历史误报成仍可回溯。

这是不可逆升级。切换期间的 backup 只用于 smoke check 失败时自动恢复；成功后会立即
删除。项目不提供 official checkpoint 到 v2 全量链的反向迁移工具。确需保留原始链的
用户必须在升级前、Keydex 完全退出后自行复制整个数据目录。

## 3. Preflight 与容量门禁

开始迁移后先执行只读盘点，检查：

- 旧 checkpoint/write 总量、namespace 和 thread 数；
- orphan writes、断裂 parent、缺失 head；
- 正在运行的 trace/subagent、待审批和待输入状态；
- 业务表及列是否在当前版本支持的白名单中；
- `app.db`、WAL、page/freelist、compact 目标估算和目标盘剩余空间；
- 源数据 fingerprint，防止复制过程中源库被另一个进程改变。

可用空间必须至少覆盖 compact 目标估算再加 `64 MiB` 安全余量。容量不足不会改写源
checkpoint，也不会进入 swap。UI 只显示总百分比；内部 migration state 和日志仅记录
计数、摘要、阶段、路径及错误类型，不记录用户消息正文。

主要内部失败码及处置：

| 失败码 | 含义 | 处置 |
| --- | --- | --- |
| `checkpoint_migration_insufficient_space` | 目标盘安全空间不足 | 退出 Keydex，清理同一磁盘空间后重试 |
| `checkpoint_migration_locked` | 另一个 Keydex 进程持有迁移锁 | 只保留一个进程，稍后重试 |
| `checkpoint_migration_source_changed` | 迁移期间源库 fingerprint 改变 | 关闭其他实例并重启当前版本 |
| `checkpoint_migration_orphan_writes` | pending write 找不到所属 checkpoint | 保留数据目录并交由维护人员检查 |
| `checkpoint_migration_broken_parent` | 旧链 parent 断裂 | 保留数据目录并交由维护人员检查 |
| `checkpoint_migration_unknown_business_table` | 出现当前版本未知业务表 | 确认升级路径和安装包版本 |
| `checkpoint_migration_unknown_business_column` | 出现当前版本未知业务列 | 确认升级路径和安装包版本 |
| `checkpoint_migration_target_column_unfillable` | 新表必填列无法从旧库构造 | 停止重试并保留现场 |
| `checkpoint_migration_business_copy_mismatch` | 业务表复制摘要不一致 | 停止重试并保留现场 |
| `checkpoint_migration_head_missing` | namespace 最新 checkpoint 缺失 | 停止重试并保留现场 |
| `checkpoint_migration_hydrate_failed` | 旧 checkpoint 无法反序列化或重建 | 停止重试并保留现场 |
| `checkpoint_migration_target_missing` | compact 临时库丢失 | 重启；幂等流程会重建临时库 |
| `checkpoint_migration_swap_failed` | 新库 smoke check 失败 | 自动恢复短期 backup；重启后再检查 |
| `checkpoint_migration_recovery_required` | swap 文件组合无法自动判定 | 不手工改名，保留全部文件并介入恢复 |

未列出的内部异常对用户统一显示“会话数据迁移未完成，请重试”，避免泄露数据库路径、
用户内容或内部结构。

## 4. 幂等、断点与原子切换

迁移使用固定 migration id `checkpoint-v2-collapse-to-official-v1`，数据库状态是唯一事实
源。进程级文件锁防止两个实例同时执行；namespace 状态、源 fingerprint、目标摘要和
单调 basis-points 进度防止重复完成。公开进度在完成前最高为 `99%`，只有 active target
通过 smoke check 后才变为 `100%`。

checkpoint 未 ready 前不启动耗时 ticker、MCP 自动刷新、会话恢复和文件历史清理等
数据库后台服务；用户确认进入后再幂等启动。未取得 OS 迁移锁的第二个进程只轮询锁并
保持最近一次总百分比，不在 owner 的 Windows rename 窗口内反复打开 `app.db`。

copy/collapse 阶段被关闭或崩溃后，下一次启动自动把非终态状态恢复为可重入的
`pending` 并重新生成固定临时目标，不依赖 UI 再发一次“开始”。swap 使用同目录文件和
三阶段 journal：

1. `prepared`：目标库已落盘并可切换；
2. `source_backed_up`：旧 `app.db` 已改名为短期 backup；
3. `target_active`：compact 目标已成为新的 `app.db`。

启动时先恢复 active pathname，再执行普通 schema 初始化，因此不会在旧库已改名时误建
一个空 `app.db`。随后根据 journal 继续 rename 和 smoke check。smoke check 验证 SQLite
integrity、迁移完成记录、官方表、collapse root 和降级保护壳；失败则恢复 backup。

相关文件均与 `app.db` 同目录：

- `app.db.checkpoint-collapse-v1.tmp`
- `app.db.checkpoint-collapse-v1.backup`
- `app.db.checkpoint-collapse-v1.swap.json`
- `app.db.checkpoint-collapse-v1.lock`

成功后删除 `.tmp`、`.backup`、swap journal 及其 WAL/SHM。锁文件本身不是所有权信号，
只有 OS lock 有效，可能保留一个极小的空壳文件。

## 5. 旧版本阻断

新库使用官方无版本后缀的 `checkpoints` 和 `writes`。为防止用户迁移后误用旧二进制，
新库同时带有零数据 `checkpoints_v2/checkpoint_writes_v2` 兼容保护壳以及
`checkpoint_backend_guard` 标记。旧版本的 `CREATE TABLE/INDEX IF NOT EXISTS` 可以
完成，但任何 INSERT、UPDATE 或 DELETE 都会被触发器拒绝，并返回：

> Keydex 会话数据已升级，请使用当前版本或更高版本打开

当前版本通过 guard 标记识别这些零数据表，不会把它们当作待迁移旧库。真实旧库没有
guard 标记，仍会正常触发一次性迁移。不要尝试删除 guard、触发器或把成功迁移后的
`app.db` 交给旧版本写入。

## 6. 运维演练与验收

### 6.1 升级前 dry run

1. 完全退出所有 Keydex/agent-server 进程。
2. 复制整个数据目录到独立磁盘位置，不只复制 `app.db`。
3. 在副本上启动待发布包，确认弹窗无法关闭且只显示总百分比。
4. 点击开始，在 copy、collapse 和 swap 阶段各做一次强制结束进程演练。
5. 每次重启确认自动恢复、百分比不倒退，最终到 `100%` 后必须点击“进入 Keydex”。
6. 打开多个旧会话核对历史消息，再各继续一轮对话。
7. 核对迁移前 checkpoint 的 reverse/指定历史 fork 被 lineage floor 阻断。

### 6.2 物理空间与残留文件

在 Keydex 退出后执行以下 PowerShell，只把 `$KeydexDataDir` 替换为实际数据目录：

```powershell
$KeydexDataDir = "D:\path\to\keydex-data"
Get-ChildItem -LiteralPath $KeydexDataDir -Force |
  Where-Object Name -Like "app.db*" |
  Select-Object Name, Length, LastWriteTime
```

验收结果必须包含 active `app.db`，且不包含 `.tmp`、`.backup`、
`.swap.json` 及这些文件的 `-wal/-shm`。再启动并正常退出一次，确认 `app.db-wal` 已
checkpoint 到稳定大小。不要在 Keydex 运行时手工删除或改名这些文件。

### 6.3 数据库只读核验

使用与发布包相同依赖环境执行：

```powershell
.\.venv\Scripts\python.exe -c "import sqlite3; p=r'D:\path\to\keydex-data\app.db'; c=sqlite3.connect(f'file:{p}?mode=ro', uri=True); print(c.execute('pragma integrity_check').fetchone()[0]); print(c.execute(\"select status,progress_basis_points from checkpoint_migration_state where migration_id='checkpoint-v2-collapse-to-official-v1'\").fetchone()); print(c.execute('select count(*) from checkpoints_v2').fetchone()[0], c.execute('select count(*) from checkpoint_writes_v2').fetchone()[0])"
```

预期依次为 `ok`、`('completed', 10000)` 和两个 `0`。最后两个表是旧版本保护壳，
不能用“表存在”判断旧数据是否还在。

## 7. 发布 checklist

- [ ] CPK-028 包级 E2E 全部通过：首次阻塞、未确认重启、确认后续聊、7 个强杀阶段、
      双进程幂等、backup/tmp/journal 清理。
- [ ] CPK-029 发布门禁通过：
      `.dev/test/2026-07-24_18-47-57-checkpoint-async-sqlite-migration/checkpoint-release-gate.json`。
- [ ] 100/500 轮存储报告通过：
      `.dev/test/2026-07-24_18-47-57-checkpoint-async-sqlite-migration/checkpoint-storage-growth.json`。
- [ ] old-version guard 测试覆盖旧 DDL、两张表写阻断、官方 runtime 和真实旧 fixture。
- [ ] swap recovery 覆盖 `prepared/source_backed_up/target_active` 和 smoke 失败恢复。
- [ ] release note 使用 `.github/release-notes/v<version>.md`，Windows Release 能读取。
- [ ] sidecar fingerprint 包含所有 checkpoint migration Python 模块，PyInstaller 收集
      `backend.app.agent` 子模块。
- [ ] 在发布候选安装包上人工完成一次真实可见弹窗与会话续聊验收。

CPK-029 的固定基准中，100 条旧全量链从 `22,806,528` bytes 压缩到
`1,396,736` bytes；500 轮 delta 逻辑数据为 `971,951` bytes，而同等旧全量链为
`84,237,249` bytes。数字仅作为本机回归基线，发布门禁看趋势和上限，不承诺所有用户
得到完全相同的文件大小。
