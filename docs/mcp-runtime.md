# MCP Runtime

本文档说明 Keydex MCP runtime 的产品边界、运行边界和维护约束。

## 范围

- MCP 配置是全局配置，不绑定单个项目。
- MCP Server 在设置页的 `MCP服务器` 中维护，入口属于设置页内部。
- Agent 每次运行前按当前全局配置、server 状态、tool/prompt 策略和会话级 override 生成运行快照。
- Agent 只接收快照中可见且启用的 MCP tools；停用的 tool 不应进入模型可见工具列表。
- 运行中的一次 Agent turn 使用创建时的快照，不在同一轮中静默替换工具集合。

## Server 与 Tool 生命周期

1. 用户添加或导入 MCP Server。
2. 后端保存连接配置和 secret reference，接口返回时不回显 secret 明文。
3. Runtime 按需连接或刷新 server，发现 tools 和 prompts。
4. 发现结果写入本地存储，schema 变化会标记为 `schema_changed`，需要按策略处理。
5. Agent turn 启动时创建 MCP runtime snapshot。
6. Tool 调用按策略执行：自动允许、需要审批、策略拒绝或会话禁用。
7. 调用结果、失败、审批、trust 命中和策略变化写入 MCP audit。

## 失败语义

- 连接失败、认证失败、协议错误、超时、server 停用、审批拒绝、schema changed 都必须有用户可读文案。
- 失败不做静默降级，不把失败 server 的 tool 注入给当前 Agent。
- API 返回给前端的错误 detail 必须脱敏，不能包含 token、secret、api key、password、Authorization 等敏感值。
- 用户可操作的失败应在页面提供重试、重新认证、编辑连接或策略调整入口。

## Resources Reserved

MCP Resources 在本期只保留数据结构和状态展示，不开放读取能力。

- Server 或协议发现到 resources capability 时，可以展示为 reserved。
- Agent 不应获得 resource read tool。
- 任何 resource read 请求都应返回 `resource_reserved`。
- 页面文案应明确这是预留能力，不提示用户配置无法生效的资源读取流程。

## E2E 约束

- MCP E2E 测试数据名称使用 `E2E_MCP_` 前缀。
- E2E cleanup guard 只能删除此前缀命中的 MCP Server。
- MCP mock server 使用本地 Python venv 中的 MCP SDK `FastMCP`，通过 `streamable-http` 暴露 `/mcp`。
- E2E 证据 CSV 固定列：
  `issue_id,feature,scenario,status,started_at,completed_at,evidence_report,primary_screenshot,failure_screenshot,notes`。
