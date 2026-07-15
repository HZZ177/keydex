import {
  AlertCircle,
  CheckSquare,
  FileCode2,
  RefreshCcw,
  Search,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { LoadingSkeleton } from "@/renderer/components/loading";
import { SettingsSelect } from "@/renderer/pages/settings/components";
import type { RuntimeBridge } from "@/runtime";
import type {
  McpApprovalMode,
  McpToolBulkPolicyAction,
  McpToolSummary,
} from "@/types/protocol";

import { mcpErrorMessage, mcpToolEffectiveStateLabel } from "./mcpCopy";
import styles from "./McpConsolePage.module.css";

type ToolAvailabilityFilter = "all" | "direct" | "on_demand" | "disabled";
type ToolConfiguredApprovalMode = Extract<McpApprovalMode, "inherit" | "prompt" | "approve" | "deny">;
type ToolApprovalFilter = "all" | ToolConfiguredApprovalMode;

const TOOL_STATUS_OPTIONS: Array<{ value: ToolAvailabilityFilter; label: string }> = [
  { value: "all", label: "全部工具" },
  { value: "direct", label: "直接可用" },
  { value: "on_demand", label: "按需加载" },
  { value: "disabled", label: "已停用" },
];

const APPROVAL_FILTER_OPTIONS: Array<{ value: ToolApprovalFilter; label: string }> = [
  { value: "all", label: "全部确认方式" },
  { value: "inherit", label: "按服务器设置" },
  { value: "prompt", label: "每次确认" },
  { value: "approve", label: "始终允许" },
  { value: "deny", label: "始终拒绝" },
];

const TOOL_APPROVAL_OPTIONS: Array<{ value: ToolConfiguredApprovalMode; label: string }> = [
  { value: "inherit", label: "按服务器设置" },
  { value: "prompt", label: "每次确认" },
  { value: "approve", label: "始终允许" },
  { value: "deny", label: "始终拒绝" },
];

const BULK_ACTION_OPTIONS: Array<{ value: McpToolBulkPolicyAction; label: string }> = [
  { value: "enable_selected", label: "启用所选工具" },
  { value: "disable_selected", label: "停用所选工具" },
  { value: "keep_selected_only", label: "仅启用所选工具" },
  { value: "prompt_all", label: "全部改为每次确认" },
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
  const [statusFilter, setStatusFilter] = useState<ToolAvailabilityFilter>("all");
  const [approvalFilter, setApprovalFilter] = useState<ToolApprovalFilter>("all");
  const [selectedToolIds, setSelectedToolIds] = useState<Set<string>>(() => new Set());
  const [bulkAction, setBulkAction] = useState<McpToolBulkPolicyAction>("disable_selected");
  const [busyKey, setBusyKey] = useState("");
  const [schemaTool, setSchemaTool] = useState<McpToolSummary | null>(null);
  const [priorityAvailableCount, setPriorityAvailableCount] = useState(0);
  const [directToolBudget, setDirectToolBudget] = useState(0);

  const loadTools = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await runtime.mcp.listTools(serverId, {
        search: query.trim() || undefined,
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
      setPriorityAvailableCount(response.priority_available_count);
      setDirectToolBudget(response.direct_tool_budget);
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
  }, [query, runtime, serverId]);

  useEffect(() => {
    void loadTools();
  }, [loadTools]);

  const visibleTools = useMemo(() => {
    return tools.filter((tool) => {
      if (!toolMatchesAvailabilityFilter(tool, statusFilter)) {
        return false;
      }
      return approvalFilter === "all" || normalizeToolApprovalMode(tool.approval_mode) === approvalFilter;
    });
  }, [approvalFilter, statusFilter, tools]);

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
          ? `已启用 ${tool.raw_name}：下一轮智能体运行生效`
          : `已禁用 ${tool.raw_name}：立即阻止执行，下一轮不再暴露给智能体`,
      );
    } catch (reason) {
      setError(mcpErrorMessage(reason, "更新 MCP 工具策略失败"));
    } finally {
      setBusyKey("");
    }
  };

  const updateToolPriority = async (tool: McpToolSummary) => {
    setBusyKey(`priority:${tool.id}`);
    setError("");
    try {
      const priority_available = !tool.priority_available;
      const updated = await runtime.mcp.updateToolPolicy(serverId, tool.id, {
        priority_available,
      });
      replaceTool(updated);
      setPriorityAvailableCount((current) => Math.max(0, current + (priority_available ? 1 : -1)));
      onNotice(
        priority_available
          ? "已设为优先可用：始终直接提供给智能体，不占懒加载额度"
          : "已取消优先可用",
      );
    } catch (reason) {
      setError(mcpErrorMessage(reason, "更新 MCP 工具优先可用失败"));
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
      onNotice("工具确认方式已更新");
    } catch (reason) {
      setError(mcpErrorMessage(reason, "更新 MCP 工具确认方式失败"));
    } finally {
      setBusyKey("");
    }
  };

  const applyBulkPolicy = async () => {
    const selectedIds = selectedVisibleTools.map((tool) => tool.id);
    if (SELECT_REQUIRED_ACTIONS.has(bulkAction) && selectedIds.length === 0) {
      setError("请先选择要批量处理的工具");
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
      onNotice(`批量授权已应用，更新 ${response.updated_count} 个工具`);
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
            aria-label="搜索 MCP 工具"
            value={query}
            placeholder="搜索工具"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className={styles.toolFilters}>
          <SettingsSelect
            ariaLabel="筛选 MCP 工具显示范围"
            density="compact"
            options={TOOL_STATUS_OPTIONS}
            value={statusFilter}
            onChange={(value) => setStatusFilter(value)}
          />
          <SettingsSelect
            ariaLabel="筛选 MCP 工具确认方式"
            density="compact"
            options={APPROVAL_FILTER_OPTIONS}
            value={approvalFilter}
            onChange={(value) => setApprovalFilter(value)}
          />
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
        <div className={styles.priorityBudget}>
          <strong>优先可用 {priorityAvailableCount}</strong>
          <span>始终直接可用，不占 {directToolBudget} 个按需激活名额</span>
        </div>
        <button
          className={styles.selectAllButton}
          type="button"
          aria-label={allVisibleSelected ? "取消选择当前 MCP 工具" : "选择当前 MCP 工具"}
          disabled={visibleTools.length === 0}
          onClick={toggleAllVisible}
        >
          {allVisibleSelected ? <CheckSquare size={15} /> : <Square size={15} />}
          <span>{selectedVisibleTools.length}/{visibleTools.length}</span>
        </button>
        <SettingsSelect
          ariaLabel="MCP 工具批量授权"
          density="compact"
          options={BULK_ACTION_OPTIONS}
          value={bulkAction}
          onChange={(value) => setBulkAction(value)}
        />
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
          {loading ? <ToolListSkeleton /> : null}
          {!loading && visibleTools.length === 0 ? (
            <div className={styles.emptyState} data-testid="mcp-tool-empty">
              <FileCode2 size={18} />
              <span>{tools.length === 0 ? "暂无 MCP 工具" : "没有匹配的工具"}</span>
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
                  onPriorityChange={updateToolPriority}
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
                <span>参数结构</span>
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

function ToolListSkeleton() {
  return (
    <LoadingSkeleton
      aria-label="加载 MCP 工具"
      className={styles.toolListSkeleton}
      lineCount={6}
      testId="mcp-tool-loading"
      width="default"
    />
  );
}

function ToolRow({
  tool,
  busyKey,
  selected,
  onApprovalChange,
  onOpenSchema,
  onPriorityChange,
  onSelectedChange,
  onToggleEnabled,
}: {
  tool: McpToolSummary;
  busyKey: string;
  selected: boolean;
  onApprovalChange: (tool: McpToolSummary, approvalMode: McpApprovalMode) => Promise<void>;
  onOpenSchema: (tool: McpToolSummary) => void;
  onPriorityChange: (tool: McpToolSummary) => Promise<void>;
  onSelectedChange: (toolId: string) => void;
  onToggleEnabled: (tool: McpToolSummary) => Promise<void>;
}) {
  const status = tool.discovery_status ?? tool.status ?? "unknown";
  const configuredApproval = normalizeToolApprovalMode(tool.approval_mode);
  const isRemoved = status === "removed" || tool.effective_state === "removed";
  const isSchemaChanged = status === "schema_changed" || tool.effective_state === "schema_changed";

  return (
    <article className={styles.toolRow} data-testid="mcp-tool-row">
      <div className={styles.toolSelectCell}>
        <button
          aria-label={`选择工具 ${tool.raw_name}`}
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
        <p>{tool.description || "暂无说明"}</p>
        <div className={styles.toolBadgeRow}>
          <Badge
            value={toolAvailabilityLabel(tool)}
            tone={toolAvailabilityMode(tool) === "disabled" ? "muted" : "neutral"}
          />
          {tool.priority_available ? <Badge value="优先可用" tone="success" /> : null}
          <Badge value={`确认方式：${toolApprovalBadgeLabel(tool)}`} tone={approvalBadgeTone(tool)} />
          <Badge value={effectiveStateLabel(tool.effective_state)} tone={tool.enabled ? "success" : "muted"} />
        </div>
        {isSchemaChanged ? (
          <div className={styles.schemaChangedNotice}>参数结构已变化，需检查后确认授权</div>
        ) : null}
      </div>

      <div className={styles.toolStateCell}>
        <span>最后使用</span>
        <strong>{formatDate(tool.last_used_at)}</strong>
        <span>调用次数</span>
        <strong>{tool.call_count ?? 0}</strong>
      </div>

      <div className={styles.toolActionCell}>
        <div className={styles.toolSwitchControl}>
          <span>启用</span>
          <ToggleSwitch
            checked={tool.enabled}
            disabled={busyKey === `enabled:${tool.id}` || isRemoved}
            label={`启用工具 ${tool.raw_name}`}
            onChange={() => void onToggleEnabled(tool)}
          />
        </div>
        <div className={styles.toolSwitchControl}>
          <span>优先可用</span>
          <ToggleSwitch
            checked={Boolean(tool.priority_available)}
            disabled={busyKey === `priority:${tool.id}` || isRemoved}
            label={`优先可用 ${tool.raw_name}`}
            onChange={() => void onPriorityChange(tool)}
          />
        </div>
        <SettingsSelect
          ariaLabel={`确认方式 ${tool.raw_name}`}
          density="compact"
          disabled={busyKey === `approval:${tool.id}` || isRemoved}
          options={TOOL_APPROVAL_OPTIONS}
          value={configuredApproval}
          onChange={(value) => void onApprovalChange(tool, value as McpApprovalMode)}
        />
        <button
          className={styles.smallToolButton}
          type="button"
          aria-label={`查看参数结构 ${tool.raw_name}`}
          onClick={() => onOpenSchema(tool)}
        >
          <FileCode2 size={14} />
          <span>参数结构</span>
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

function normalizeApprovalMode(value: McpApprovalMode | string | undefined): McpApprovalMode {
  return value === "auto" ? "approve" : (value as McpApprovalMode) || "prompt";
}

function normalizeToolApprovalMode(value: McpApprovalMode | string | undefined): ToolConfiguredApprovalMode {
  const normalized = normalizeApprovalMode(value);
  if (normalized === "inherit" || normalized === "prompt" || normalized === "deny") {
    return normalized;
  }
  return "approve";
}

function approvalModeLabel(value: McpApprovalMode | string): string {
  switch (normalizeApprovalMode(value)) {
    case "inherit":
      return "按服务器设置";
    case "prompt":
      return "每次确认";
    case "deny":
      return "始终拒绝";
    case "approve":
    default:
      return "始终允许";
  }
}

function serverPermissionLabel(value: McpApprovalMode | string | undefined): string {
  switch (normalizeApprovalMode(value)) {
    case "approve":
      return "信任此服务";
    case "prompt":
      return "按请求审批";
    case "deny":
      return "始终拒绝";
    case "inherit":
    default:
      return "按服务器设置";
  }
}

function toolApprovalBadgeLabel(tool: McpToolSummary): string {
  const configuredApproval = normalizeToolApprovalMode(tool.approval_mode);
  if (configuredApproval === "inherit") {
    return serverPermissionLabel(tool.effective_approval_mode);
  }
  return approvalModeLabel(configuredApproval);
}

function approvalBadgeTone(tool: McpToolSummary): "neutral" | "success" | "warning" | "muted" {
  const configuredApproval = normalizeToolApprovalMode(tool.approval_mode);
  if (configuredApproval === "deny" || configuredApproval === "prompt") {
    return "warning";
  }
  if (configuredApproval === "approve") {
    return "success";
  }
  return "neutral";
}

function toolMatchesAvailabilityFilter(tool: McpToolSummary, filter: ToolAvailabilityFilter): boolean {
  if (filter === "all") {
    return true;
  }
  return toolAvailabilityMode(tool) === filter;
}

function toolAvailabilityLabel(tool: McpToolSummary): string {
  switch (toolAvailabilityMode(tool)) {
    case "direct":
      return "直接可用";
    case "on_demand":
      return "按需加载";
    case "disabled":
    default:
      return "已停用";
  }
}

function toolAvailabilityMode(tool: McpToolSummary): ToolAvailabilityFilter {
  if (!tool.enabled || tool.hidden || tool.effective_state !== "enabled" || isRemovedTool(tool)) {
    return "disabled";
  }
  if (tool.availability_mode === "direct" || tool.availability_mode === "on_demand") {
    return tool.availability_mode;
  }
  return "direct";
}

function isRemovedTool(tool: McpToolSummary): boolean {
  return tool.discovery_status === "removed" || tool.status === "removed" || tool.effective_state === "removed";
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "从未";
  }
  return value.replace("T", " ").replace("Z", "");
}

function formatJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}
