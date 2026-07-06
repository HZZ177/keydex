import {
  AlertCircle,
  CheckSquare,
  FileCode2,
  LoaderCircle,
  RefreshCcw,
  Search,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { RuntimeBridge } from "@/runtime";
import type {
  McpApprovalMode,
  McpRiskLevel,
  McpToolBulkPolicyAction,
  McpToolDiscoveryStatus,
  McpToolSummary,
} from "@/types/protocol";

import { mcpErrorMessage, mcpToolEffectiveStateLabel } from "./mcpCopy";
import styles from "./McpConsolePage.module.css";

const TOOL_STATUS_OPTIONS: Array<{ value: "all" | McpToolDiscoveryStatus; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "new", label: "new" },
  { value: "unchanged", label: "unchanged" },
  { value: "schema_changed", label: "Schema 已变化" },
  { value: "removed", label: "removed" },
];

const RISK_OPTIONS: Array<{ value: "all" | McpRiskLevel; label: string }> = [
  { value: "all", label: "全部风险" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "unknown", label: "unknown" },
];

const ENABLED_OPTIONS = [
  { value: "all", label: "全部启用状态" },
  { value: "enabled", label: "enabled" },
  { value: "disabled", label: "disabled" },
] as const;

const APPROVAL_OPTIONS: Array<{ value: "all" | McpApprovalMode; label: string }> = [
  { value: "all", label: "全部审批" },
  { value: "inherit", label: "inherit" },
  { value: "auto", label: "auto" },
  { value: "prompt", label: "prompt" },
  { value: "approve", label: "approve" },
  { value: "deny", label: "deny" },
];

const BULK_ACTION_OPTIONS: Array<{ value: McpToolBulkPolicyAction; label: string }> = [
  { value: "enable_selected", label: "启用所选" },
  { value: "disable_selected", label: "禁用所选" },
  { value: "keep_selected_only", label: "仅保留所选" },
  { value: "enable_read_only", label: "启用只读" },
  { value: "disable_write_tools", label: "禁用写入" },
  { value: "prompt_all", label: "全部每次审批" },
];

const SELECT_REQUIRED_ACTIONS = new Set<McpToolBulkPolicyAction>([
  "enable_selected",
  "disable_selected",
  "keep_selected_only",
]);

export function McpToolsTab({
  runtime,
  serverId,
  onNotice,
}: {
  runtime: RuntimeBridge;
  serverId: string;
  onNotice: (message: string) => void;
}) {
  const [tools, setTools] = useState<McpToolSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | McpToolDiscoveryStatus>("all");
  const [riskFilter, setRiskFilter] = useState<"all" | McpRiskLevel>("all");
  const [enabledFilter, setEnabledFilter] = useState<(typeof ENABLED_OPTIONS)[number]["value"]>("all");
  const [approvalFilter, setApprovalFilter] = useState<"all" | McpApprovalMode>("all");
  const [selectedToolIds, setSelectedToolIds] = useState<Set<string>>(() => new Set());
  const [bulkAction, setBulkAction] = useState<McpToolBulkPolicyAction>("disable_selected");
  const [busyKey, setBusyKey] = useState("");
  const [schemaTool, setSchemaTool] = useState<McpToolSummary | null>(null);

  const loadTools = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await runtime.mcp.listTools(serverId, {
        search: query.trim() || undefined,
        status: statusFilter === "all" ? undefined : statusFilter,
        risk: riskFilter === "all" ? undefined : riskFilter,
        enabled: enabledFilter === "all" ? undefined : enabledFilter === "enabled",
        limit: 500,
      });
      setTools(response.list);
      setSelectedToolIds((current) => {
        const next = new Set<string>();
        const availableIds = new Set(response.list.map((tool) => tool.id));
        for (const toolId of current) {
          if (availableIds.has(toolId)) {
            next.add(toolId);
          }
        }
        return next;
      });
      setSchemaTool((current) => {
        if (!current) {
          return null;
        }
        return response.list.find((tool) => tool.id === current.id) ?? null;
      });
    } catch (reason) {
      setTools([]);
      setSelectedToolIds(new Set());
      setSchemaTool(null);
      setError(mcpErrorMessage(reason, "加载 MCP 工具失败"));
    } finally {
      setLoading(false);
    }
  }, [enabledFilter, query, riskFilter, runtime, serverId, statusFilter]);

  useEffect(() => {
    void loadTools();
  }, [loadTools]);

  const visibleTools = useMemo(() => {
    if (approvalFilter === "all") {
      return tools;
    }
    return tools.filter((tool) => (tool.effective_approval_mode ?? tool.approval_mode) === approvalFilter);
  }, [approvalFilter, tools]);

  const selectedVisibleTools = useMemo(
    () => visibleTools.filter((tool) => selectedToolIds.has(tool.id)),
    [selectedToolIds, visibleTools],
  );
  const allVisibleSelected = visibleTools.length > 0 && selectedVisibleTools.length === visibleTools.length;

  const replaceTool = (nextTool: McpToolSummary) => {
    setTools((current) => current.map((tool) => (tool.id === nextTool.id ? nextTool : tool)));
    setSchemaTool((current) => (current?.id === nextTool.id ? nextTool : current));
  };

  const toggleSelected = (toolId: string) => {
    setSelectedToolIds((current) => {
      const next = new Set(current);
      if (next.has(toolId)) {
        next.delete(toolId);
      } else {
        next.add(toolId);
      }
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedToolIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const tool of visibleTools) {
          next.delete(tool.id);
        }
      } else {
        for (const tool of visibleTools) {
          next.add(tool.id);
        }
      }
      return next;
    });
  };

  const updateToolEnabled = async (tool: McpToolSummary) => {
    setBusyKey(`enabled:${tool.id}`);
    setError("");
    try {
      const enabled = !tool.enabled;
      const updated = await runtime.mcp.updateToolPolicy(serverId, tool.id, { enabled });
      replaceTool(updated);
      onNotice(
        enabled
          ? `已启用 ${tool.raw_name}：下一轮 Agent 运行生效`
          : `已禁用 ${tool.raw_name}：立即阻止执行，下一轮不再暴露给 Agent`,
      );
    } catch (reason) {
      setError(mcpErrorMessage(reason, "更新 MCP 工具策略失败"));
    } finally {
      setBusyKey("");
    }
  };

  const updateToolApproval = async (tool: McpToolSummary, approvalMode: McpApprovalMode) => {
    setBusyKey(`approval:${tool.id}`);
    setError("");
    try {
      const updated = await runtime.mcp.updateToolPolicy(serverId, tool.id, {
        approval_mode: approvalMode,
      });
      replaceTool(updated);
      onNotice("审批策略已更新：只影响执行前确认，不改变工具可见性");
    } catch (reason) {
      setError(mcpErrorMessage(reason, "更新 MCP 工具审批策略失败"));
    } finally {
      setBusyKey("");
    }
  };

  const applyBulkPolicy = async () => {
    const selectedIds = selectedVisibleTools.map((tool) => tool.id);
    if (SELECT_REQUIRED_ACTIONS.has(bulkAction) && selectedIds.length === 0) {
      setError("请先选择要批量处理的 tool");
      return;
    }
    setBusyKey("bulk");
    setError("");
    try {
      const response = await runtime.mcp.applyToolBulkPolicy(serverId, {
        action: bulkAction,
        tool_ids: SELECT_REQUIRED_ACTIONS.has(bulkAction) ? selectedIds : [],
      });
      setTools(response.tools);
      setSelectedToolIds(new Set());
      setSchemaTool((current) => {
        if (!current) {
          return null;
        }
        return response.tools.find((tool) => tool.id === current.id) ?? null;
      });
      onNotice(`批量策略已应用：${bulkAction}，更新 ${response.updated_count} 个 tool`);
    } catch (reason) {
      setError(mcpErrorMessage(reason, "批量更新 MCP 工具策略失败"));
    } finally {
      setBusyKey("");
    }
  };

  return (
    <div className={styles.toolsTab} data-testid="mcp-tools-tab">
      <div className={styles.toolsToolbar}>
        <label className={styles.searchBox}>
          <Search size={15} />
          <input
            aria-label="搜索 MCP Tool"
            value={query}
            placeholder="搜索 tool"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className={styles.toolFilters}>
          <select
            aria-label="筛选 MCP Tool 状态"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as "all" | McpToolDiscoveryStatus)}
          >
            {TOOL_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            aria-label="筛选 MCP Tool 风险"
            value={riskFilter}
            onChange={(event) => setRiskFilter(event.target.value as "all" | McpRiskLevel)}
          >
            {RISK_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            aria-label="筛选 MCP Tool 启用状态"
            value={enabledFilter}
            onChange={(event) => setEnabledFilter(event.target.value as (typeof ENABLED_OPTIONS)[number]["value"])}
          >
            {ENABLED_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            aria-label="筛选 MCP Tool 审批"
            value={approvalFilter}
            onChange={(event) => setApprovalFilter(event.target.value as "all" | McpApprovalMode)}
          >
            {APPROVAL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <button
          className={styles.smallToolButton}
          type="button"
          disabled={loading}
          onClick={() => void loadTools()}
        >
          <RefreshCcw size={14} className={loading ? styles.spinning : undefined} />
          <span>刷新</span>
        </button>
      </div>

      <div className={styles.bulkBar}>
        <button
          className={styles.selectAllButton}
          type="button"
          aria-label={allVisibleSelected ? "取消选择当前 MCP Tools" : "选择当前 MCP Tools"}
          disabled={visibleTools.length === 0}
          onClick={toggleAllVisible}
        >
          {allVisibleSelected ? <CheckSquare size={15} /> : <Square size={15} />}
          <span>{selectedVisibleTools.length}/{visibleTools.length}</span>
        </button>
        <select
          aria-label="MCP Tool 批量策略"
          value={bulkAction}
          onChange={(event) => setBulkAction(event.target.value as McpToolBulkPolicyAction)}
        >
          {BULK_ACTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          className={styles.smallToolButton}
          type="button"
          disabled={busyKey === "bulk"}
          onClick={() => void applyBulkPolicy()}
        >
          <CheckSquare size={14} />
          <span>应用</span>
        </button>
      </div>

      {error ? (
        <div className={styles.inlineError} role="alert">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className={styles.toolsContent} data-has-schema={schemaTool ? "true" : "false"}>
        <div className={styles.toolList} data-testid="mcp-tool-list">
          {loading ? (
            <div className={styles.loadingList} data-testid="mcp-tool-loading">
              <LoaderCircle size={16} className={styles.spinning} />
              <span>加载 Tools</span>
            </div>
          ) : null}
          {!loading && visibleTools.length === 0 ? (
            <div className={styles.emptyState} data-testid="mcp-tool-empty">
              <FileCode2 size={18} />
              <span>{tools.length === 0 ? "暂无 MCP Tools" : "没有匹配的 Tools"}</span>
            </div>
          ) : null}
          {!loading
            ? visibleTools.map((tool) => (
                <ToolRow
                  key={tool.id}
                  tool={tool}
                  busyKey={busyKey}
                  selected={selectedToolIds.has(tool.id)}
                  onApprovalChange={updateToolApproval}
                  onOpenSchema={setSchemaTool}
                  onSelectedChange={toggleSelected}
                  onToggleEnabled={updateToolEnabled}
                />
              ))
            : null}
        </div>

        {schemaTool ? (
          <aside className={styles.schemaPanel} data-testid="mcp-tool-schema-panel">
            <div className={styles.schemaPanelHeader}>
              <div>
                <span>Schema</span>
                <strong>{schemaTool.raw_name}</strong>
              </div>
              <button type="button" onClick={() => setSchemaTool(null)}>
                关闭
              </button>
            </div>
            <pre>{formatJson(schemaTool.input_schema ?? {})}</pre>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function ToolRow({
  tool,
  busyKey,
  selected,
  onApprovalChange,
  onOpenSchema,
  onSelectedChange,
  onToggleEnabled,
}: {
  tool: McpToolSummary;
  busyKey: string;
  selected: boolean;
  onApprovalChange: (tool: McpToolSummary, approvalMode: McpApprovalMode) => Promise<void>;
  onOpenSchema: (tool: McpToolSummary) => void;
  onSelectedChange: (toolId: string) => void;
  onToggleEnabled: (tool: McpToolSummary) => Promise<void>;
}) {
  const status = tool.discovery_status ?? tool.status ?? "unknown";
  const approval = tool.effective_approval_mode ?? tool.approval_mode;
  const isRemoved = status === "removed" || tool.effective_state === "removed";
  const isSchemaChanged = status === "schema_changed" || tool.effective_state === "schema_changed";

  return (
    <article className={styles.toolRow} data-testid="mcp-tool-row">
      <div className={styles.toolSelectCell}>
        <button
          aria-label={`选择 tool ${tool.raw_name}`}
          className={styles.rowCheckButton}
          type="button"
          onClick={() => onSelectedChange(tool.id)}
        >
          {selected ? <CheckSquare size={15} /> : <Square size={15} />}
        </button>
      </div>

      <div className={styles.toolMainCell}>
        <div className={styles.toolTitleRow}>
          <strong>{tool.raw_name}</strong>
          <span className={styles.toolModelName}>{tool.model_name}</span>
        </div>
        <p>{tool.description || "No description"}</p>
        <div className={styles.toolBadgeRow}>
          <Badge value={String(status)} tone={isSchemaChanged ? "warning" : isRemoved ? "muted" : "neutral"} />
          <Badge value={`risk ${tool.risk_level}`} tone={tool.risk_level === "high" ? "warning" : "neutral"} />
          <Badge value={`approval ${approval}`} tone={approval === "prompt" || approval === "deny" ? "warning" : "neutral"} />
          <Badge value={effectiveStateLabel(tool.effective_state)} tone={tool.enabled ? "success" : "muted"} />
        </div>
        {isSchemaChanged ? (
          <div className={styles.schemaChangedNotice}>Schema 已变化，需检查后确认策略</div>
        ) : null}
      </div>

      <div className={styles.toolStateCell}>
        <span>last used</span>
        <strong>{formatDate(tool.last_used_at)}</strong>
        <span>calls</span>
        <strong>{tool.call_count ?? 0}</strong>
      </div>

      <div className={styles.toolActionCell}>
        <ToggleSwitch
          checked={tool.enabled}
          disabled={busyKey === `enabled:${tool.id}` || isRemoved}
          label={`启用 tool ${tool.raw_name}`}
          onChange={() => void onToggleEnabled(tool)}
        />
        <select
          aria-label={`审批策略 ${tool.raw_name}`}
          disabled={busyKey === `approval:${tool.id}` || isRemoved}
          value={tool.approval_mode}
          onChange={(event) => void onApprovalChange(tool, event.target.value as McpApprovalMode)}
        >
          {APPROVAL_OPTIONS.filter((option) => option.value !== "all").map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          className={styles.smallToolButton}
          type="button"
          aria-label={`查看 schema ${tool.raw_name}`}
          onClick={() => onOpenSchema(tool)}
        >
          <FileCode2 size={14} />
          <span>Schema</span>
        </button>
      </div>
    </article>
  );
}

function ToggleSwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={styles.toggle}
      disabled={disabled}
      onClick={onChange}
      role="switch"
      type="button"
    >
      <span aria-hidden="true" className={styles.toggleTrack} data-checked={checked ? "true" : "false"}>
        <span className={styles.toggleThumb} />
      </span>
    </button>
  );
}

function Badge({ value, tone }: { value: string; tone: "neutral" | "success" | "warning" | "muted" }) {
  return (
    <span className={styles.toolBadge} data-tone={tone}>
      {value}
    </span>
  );
}

function effectiveStateLabel(value: string): string {
  return mcpToolEffectiveStateLabel(value);
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "never";
  }
  return value.replace("T", " ").replace("Z", "");
}

function formatJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}
