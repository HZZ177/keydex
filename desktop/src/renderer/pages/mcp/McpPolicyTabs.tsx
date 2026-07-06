import { AlertCircle, FileText, LoaderCircle, Plus, RefreshCcw, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { RuntimeBridge } from "@/runtime";
import type {
  McpApprovalMode,
  McpAuditRecord,
  McpConnectMode,
  McpRestartPolicy,
  McpServerDetailResponse,
  McpTrustApprovalMode,
  McpTrustRule,
  McpTrustRuleKind,
  McpTrustRuleScope,
} from "@/types/protocol";

import styles from "./McpConsolePage.module.css";
import { mcpErrorMessage } from "./mcpCopy";

const SERVER_APPROVAL_OPTIONS: Array<{ value: Extract<McpApprovalMode, "auto" | "prompt" | "approve">; label: string }> = [
  { value: "auto", label: "auto" },
  { value: "prompt", label: "prompt" },
  { value: "approve", label: "approve" },
];

const TRUST_KIND_OPTIONS: Array<{ value: McpTrustRuleKind; label: string }> = [
  { value: "server_readonly", label: "server readonly" },
  { value: "tool", label: "tool" },
  { value: "tool_with_params", label: "tool with params" },
  { value: "deny_tool", label: "deny tool" },
];

const TRUST_SCOPE_OPTIONS: Array<{ value: McpTrustRuleScope; label: string }> = [
  { value: "global", label: "global" },
  { value: "session", label: "session" },
];

const TRUST_APPROVAL_OPTIONS: Array<{ value: McpTrustApprovalMode; label: string }> = [
  { value: "approve", label: "approve" },
  { value: "deny", label: "deny" },
];

const CONNECT_MODE_OPTIONS: Array<{ value: McpConnectMode; label: string }> = [
  { value: "on_demand", label: "on demand" },
  { value: "on_startup", label: "on startup" },
];

const RESTART_POLICY_OPTIONS: Array<{ value: McpRestartPolicy; label: string }> = [
  { value: "never", label: "never" },
  { value: "on_failure", label: "on failure" },
  { value: "always", label: "always" },
];

const AUDIT_EVENT_OPTIONS = [
  "server.created",
  "server.updated",
  "server.deleted",
  "server.tested",
  "server.refreshed",
  "refresh.completed",
  "refresh.failed",
  "tool.policy_updated",
  "prompt.policy_updated",
  "tool.called",
  "tool.failed",
  "tool.cancelled",
  "tool.guard_rejected",
  "prompt.get",
  "prompt.failed",
  "runtime.override_set",
  "runtime.override_cleared",
  "approval.requested",
  "approval.resolved",
  "trust.created",
  "trust.deleted",
  "trust.hit",
  "oauth.started",
  "oauth.completed",
  "oauth.failed",
  "elicitation.requested",
  "elicitation.resolved",
  "sampling.requested",
  "sampling.resolved",
  "sampling.completed",
  "sampling.denied",
  "sampling.failed",
] as const;

const AUDIT_PAGE_SIZE = 10;

export function McpTrustTab({
  runtime,
  serverId,
  onNotice,
}: {
  runtime: RuntimeBridge;
  serverId: string;
  onNotice: (message: string) => void;
}) {
  const [detail, setDetail] = useState<McpServerDetailResponse | null>(null);
  const [trustRules, setTrustRules] = useState<McpTrustRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [ruleKind, setRuleKind] = useState<McpTrustRuleKind>("server_readonly");
  const [ruleScope, setRuleScope] = useState<McpTrustRuleScope>("global");
  const [ruleApproval, setRuleApproval] = useState<McpTrustApprovalMode>("approve");
  const [rawToolName, setRawToolName] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [conditionJson, setConditionJson] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [serverDetail, rules] = await Promise.all([
        runtime.mcp.getServer(serverId),
        runtime.mcp.listTrustRules({ server_id: serverId, limit: 500 }),
      ]);
      setDetail(serverDetail);
      setTrustRules(rules.list);
    } catch (reason) {
      setDetail(null);
      setTrustRules([]);
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [runtime, serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateApprovalSettings = async (payload: Partial<McpServerDetailResponse>) => {
    setBusyKey("approval");
    setError("");
    try {
      const updated = await runtime.mcp.updateServer(serverId, payload);
      setDetail(updated);
      onNotice("MCP 审批策略已保存");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyKey("");
    }
  };

  const updateSamplingEnabled = async (checked: boolean) => {
    if (checked && detail && !detail.sampling_enabled) {
      const confirmed = window.confirm(
        "启用 Sampling 后，MCP server 可以请求 Keydex 使用当前默认模型生成内容。请求仍受审批、模型策略、token 上限和审计约束。是否继续？",
      );
      if (!confirmed) {
        return;
      }
    }
    await updateApprovalSettings({ sampling_enabled: checked });
  };

  const createRule = async () => {
    setBusyKey("create-rule");
    setError("");
    try {
      const condition = conditionJson.trim() ? JSON.parse(conditionJson) as Record<string, unknown> : null;
      const created = await runtime.mcp.createTrustRule({
        rule_kind: ruleKind,
        scope: ruleScope,
        approval_mode: ruleApproval,
        server_id: serverId,
        raw_tool_name: rawToolName.trim() || null,
        session_id: ruleScope === "session" ? sessionId.trim() || null : null,
        condition,
      });
      setTrustRules((current) => [created, ...current]);
      setRawToolName("");
      setSessionId("");
      setConditionJson("");
      onNotice(`Trust rule 已创建：${created.rule_kind}`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyKey("");
    }
  };

  const deleteRule = async (rule: McpTrustRule) => {
    setBusyKey(`delete:${rule.id}`);
    setError("");
    try {
      await runtime.mcp.deleteTrustRule(rule.id);
      setTrustRules((current) => current.filter((item) => item.id !== rule.id));
      onNotice("Trust rule 已删除");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyKey("");
    }
  };

  if (loading) {
    return <LoadingBlock label="加载审批与信任" testId="mcp-trust-loading" />;
  }

  return (
    <div className={styles.policyTab} data-testid="mcp-trust-tab">
      {error ? <InlineError message={error} /> : null}
      {detail ? (
        <section className={styles.policySection}>
          <div className={styles.policySectionHeader}>
            <h3>审批策略</h3>
            <button className={styles.smallToolButton} disabled={busyKey === "approval"} type="button" onClick={() => void load()}>
              <RefreshCcw size={14} />
              <span>刷新</span>
            </button>
          </div>
          <div className={styles.policyGrid}>
            <label className={styles.policyField}>
              <span>默认审批</span>
              <select
                aria-label="MCP Server 默认审批"
                value={detail.default_tool_approval_mode}
                onChange={(event) =>
                  void updateApprovalSettings({
                    default_tool_approval_mode: event.currentTarget.value as Extract<McpApprovalMode, "auto" | "prompt" | "approve">,
                  })
                }
              >
                {SERVER_APPROVAL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <PolicyToggle
              checked={detail.elicitation_enabled}
              disabled={busyKey === "approval"}
              label="允许 Elicitation"
              onChange={(checked) => void updateApprovalSettings({ elicitation_enabled: checked })}
            />
            <PolicyToggle
              checked={detail.sampling_enabled}
              disabled={busyKey === "approval"}
              label="允许 Sampling"
              onChange={(checked) => void updateSamplingEnabled(checked)}
            />
          </div>
          <SamplingPolicySummary detail={detail} />
        </section>
      ) : null}

      <section className={styles.policySection}>
        <div className={styles.policySectionHeader}>
          <h3>Trust rules</h3>
          <button
            className={styles.smallToolButton}
            disabled={busyKey === "create-rule"}
            type="button"
            onClick={() => void createRule()}
          >
            <Plus size={14} />
            <span>创建</span>
          </button>
        </div>
        <div className={styles.trustCreateGrid}>
          <label className={styles.policyField}>
            <span>规则</span>
            <select aria-label="Trust rule kind" value={ruleKind} onChange={(event) => setRuleKind(event.currentTarget.value as McpTrustRuleKind)}>
              {TRUST_KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.policyField}>
            <span>Scope</span>
            <select aria-label="Trust rule scope" value={ruleScope} onChange={(event) => setRuleScope(event.currentTarget.value as McpTrustRuleScope)}>
              {TRUST_SCOPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.policyField}>
            <span>决策</span>
            <select aria-label="Trust rule approval" value={ruleApproval} onChange={(event) => setRuleApproval(event.currentTarget.value as McpTrustApprovalMode)}>
              {TRUST_APPROVAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.policyField}>
            <span>Tool</span>
            <input aria-label="Trust rule raw tool name" value={rawToolName} onChange={(event) => setRawToolName(event.currentTarget.value)} />
          </label>
          {ruleScope === "session" ? (
            <label className={styles.policyField}>
              <span>Session</span>
              <input aria-label="Trust rule session id" value={sessionId} onChange={(event) => setSessionId(event.currentTarget.value)} />
            </label>
          ) : null}
          <label className={styles.policyField} data-wide="true">
            <span>Condition JSON</span>
            <input aria-label="Trust rule condition JSON" value={conditionJson} onChange={(event) => setConditionJson(event.currentTarget.value)} />
          </label>
        </div>
        <TrustRuleList busyKey={busyKey} rules={trustRules} onDelete={deleteRule} />
      </section>
    </div>
  );
}

export function McpRuntimePolicyTab({
  runtime,
  serverId,
  onNotice,
}: {
  runtime: RuntimeBridge;
  serverId: string;
  onNotice: (message: string) => void;
}) {
  const [detail, setDetail] = useState<McpServerDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setDetail(await runtime.mcp.getServer(serverId));
    } catch (reason) {
      setDetail(null);
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [runtime, serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateRuntimePolicy = async (payload: Partial<McpServerDetailResponse>) => {
    setBusy(true);
    setError("");
    try {
      const updated = await runtime.mcp.updateServer(serverId, payload);
      setDetail(updated);
      onNotice("MCP 运行策略已保存");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <LoadingBlock label="加载运行策略" testId="mcp-runtime-policy-loading" />;
  }

  return (
    <div className={styles.policyTab} data-testid="mcp-runtime-policy-tab">
      {error ? <InlineError message={error} /> : null}
      {detail ? (
        <section className={styles.policySection}>
          <div className={styles.policySectionHeader}>
            <h3>运行策略</h3>
            <button className={styles.smallToolButton} disabled={busy} type="button" onClick={() => void load()}>
              <RefreshCcw size={14} />
              <span>刷新</span>
            </button>
          </div>
          <div className={styles.policyGrid}>
            <PolicyToggle
              checked={detail.auto_refresh}
              disabled={busy}
              label="自动刷新"
              onChange={(checked) => void updateRuntimePolicy({ auto_refresh: checked })}
            />
            <label className={styles.policyField}>
              <span>刷新间隔</span>
              <input
                aria-label="MCP 自动刷新间隔"
                min={60}
                type="number"
                value={detail.refresh_interval_sec}
                onChange={(event) => void updateRuntimePolicy({ refresh_interval_sec: Number(event.currentTarget.value) })}
              />
            </label>
            <label className={styles.policyField}>
              <span>连接模式</span>
              <select
                aria-label="MCP connect mode"
                value={detail.connect_mode ?? "on_demand"}
                onChange={(event) => void updateRuntimePolicy({ connect_mode: event.currentTarget.value as McpConnectMode })}
              >
                {CONNECT_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.policyField}>
              <span>Restart</span>
              <select
                aria-label="MCP restart policy"
                value={detail.restart_policy ?? "on_failure"}
                onChange={(event) => void updateRuntimePolicy({ restart_policy: event.currentTarget.value as McpRestartPolicy })}
              >
                {RESTART_POLICY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <PolicyToggle
              checked={Boolean(detail.supports_parallel_tool_calls)}
              disabled={busy}
              label="并行工具调用"
              onChange={(checked) => void updateRuntimePolicy({ supports_parallel_tool_calls: checked })}
            />
            <div className={styles.policyReadonly}>
              <span>Cancel policy</span>
              <strong>per running call</strong>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function McpLogsTab({ runtime, serverId }: { runtime: RuntimeBridge; serverId: string }) {
  const [logs, setLogs] = useState<McpAuditRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(AUDIT_PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [eventType, setEventType] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expandedId, setExpandedId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await runtime.mcp.listAudit({
        server_id: serverId,
        event_type: eventType === "all" ? undefined : eventType,
        status: statusFilter === "all" ? undefined : statusFilter,
        limit: AUDIT_PAGE_SIZE,
        offset,
      });
      setLogs(response.list);
      setTotal(response.total);
      setLimit(response.limit);
      setOffset(response.offset);
    } catch (reason) {
      setLogs([]);
      setTotal(0);
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [eventType, offset, runtime, serverId, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + limit, total);
  const canGoPrevious = offset > 0;
  const canGoNext = offset + limit < total;

  const updateEventType = (value: string) => {
    setOffset(0);
    setEventType(value);
  };

  const updateStatusFilter = (value: string) => {
    setOffset(0);
    setStatusFilter(value);
  };

  return (
    <div className={styles.logsTab} data-testid="mcp-logs-tab">
      <div className={styles.logFilters}>
        <select aria-label="筛选 MCP 日志事件" value={eventType} onChange={(event) => updateEventType(event.currentTarget.value)}>
          <option value="all">全部事件</option>
          {AUDIT_EVENT_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <select aria-label="筛选 MCP 日志状态" value={statusFilter} onChange={(event) => updateStatusFilter(event.currentTarget.value)}>
          <option value="all">全部状态</option>
          <option value="ok">ok</option>
          <option value="completed">completed</option>
          <option value="success">success</option>
          <option value="error">error</option>
          <option value="failed">failed</option>
          <option value="approved">approved</option>
          <option value="denied">denied</option>
          <option value="rejected">rejected</option>
          <option value="cancelled">cancelled</option>
          <option value="pending">pending</option>
        </select>
        <button className={styles.smallToolButton} type="button" disabled={loading} onClick={() => void load()}>
          <RefreshCcw size={14} />
          <span>刷新</span>
        </button>
      </div>
      <div className={styles.logPager} data-testid="mcp-log-pager">
        <span>{pageStart}-{pageEnd} / {total}</span>
        <button
          className={styles.smallToolButton}
          type="button"
          aria-label="上一页 MCP 日志"
          disabled={loading || !canGoPrevious}
          onClick={() => setOffset(Math.max(0, offset - limit))}
        >
          上一页
        </button>
        <button
          className={styles.smallToolButton}
          type="button"
          aria-label="下一页 MCP 日志"
          disabled={loading || !canGoNext}
          onClick={() => setOffset(offset + limit)}
        >
          下一页
        </button>
      </div>
      {error ? <InlineError message={error} /> : null}
      {loading ? <LoadingBlock label="加载日志" testId="mcp-logs-loading" /> : null}
      {!loading && logs.length === 0 ? (
        <div className={styles.emptyState} data-testid="mcp-logs-empty">
          <FileText size={18} />
          <span>暂无 MCP 日志</span>
        </div>
      ) : null}
      {!loading && logs.length > 0 ? (
        <div className={styles.logList}>
          {logs.map((log) => (
            <article key={log.id} className={styles.logRow} data-testid="mcp-log-row">
              <button type="button" onClick={() => setExpandedId((current) => current === log.id ? "" : log.id)}>
                <span>{log.created_at.replace("T", " ").replace("Z", "")}</span>
                <strong>{log.event_type}</strong>
                <span>{log.status ?? "-"}</span>
                <span>{log.duration_ms == null ? "-" : `${log.duration_ms}ms`}</span>
                <em>{log.summary ?? "-"}</em>
              </button>
              {expandedId === log.id ? <pre>{formatJson(log.detail ?? {})}</pre> : null}
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TrustRuleList({
  busyKey,
  onDelete,
  rules,
}: {
  busyKey: string;
  onDelete: (rule: McpTrustRule) => Promise<void>;
  rules: McpTrustRule[];
}) {
  if (rules.length === 0) {
    return (
      <div className={styles.emptyState} data-testid="mcp-trust-empty">
        <ShieldCheck size={18} />
        <span>暂无 Trust rules</span>
      </div>
    );
  }
  return (
    <div className={styles.trustRuleList} data-testid="mcp-trust-rule-list">
      {rules.map((rule) => (
        <article key={rule.id} className={styles.trustRuleRow}>
          <div>
            <strong>{rule.rule_kind}</strong>
            <span>{rule.scope} / {rule.approval_mode}</span>
            <span>{rule.raw_tool_name || "-"}</span>
          </div>
          <div>
            <span>hits {rule.hit_count}</span>
            <span>{rule.created_at.replace("T", " ").replace("Z", "")}</span>
          </div>
          <pre>{formatJson(rule.condition ?? {})}</pre>
          <button
            className={styles.smallToolButton}
            disabled={busyKey === `delete:${rule.id}`}
            type="button"
            aria-label={`删除 trust rule ${rule.id}`}
            onClick={() => void onDelete(rule)}
          >
            <Trash2 size={14} />
            <span>删除</span>
          </button>
        </article>
      ))}
    </div>
  );
}

function SamplingPolicySummary({ detail }: { detail: McpServerDetailResponse }) {
  const approvalMode = samplingApprovalLabel(detail.sampling_approval_mode || "prompt");
  const modelPolicy = samplingModelPolicyLabel(detail.sampling_model_policy || "current_default");
  const maxTokens = detail.sampling_max_tokens ?? 2048;
  const auditDetail = samplingAuditDetailLabel(detail.sampling_audit_detail || "summary");
  return (
    <div className={styles.policySummary} data-testid="mcp-sampling-policy-summary">
      <span>Sampling 默认关闭：{detail.sampling_enabled ? "已启用" : "未启用"}</span>
      <span>审批：{approvalMode}</span>
      <span>模型策略：{modelPolicy}</span>
      <span>Token 上限：{maxTokens}</span>
      <span>审计：{auditDetail}</span>
    </div>
  );
}

function samplingApprovalLabel(value: string): string {
  switch (value) {
    case "prompt":
      return "每次请求审批";
    case "auto":
      return "自动允许";
    default:
      return value;
  }
}

function samplingModelPolicyLabel(value: string): string {
  if (value === "current_default") {
    return "当前默认模型";
  }
  return value;
}

function samplingAuditDetailLabel(value: string): string {
  switch (value) {
    case "summary":
      return "摘要审计";
    case "none":
      return "不记录详情";
    case "full":
      return "完整详情";
    default:
      return value;
  }
}

function PolicyToggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className={styles.policyToggleRow}>
      <span>{label}</span>
      <button
        aria-checked={checked}
        aria-label={label}
        className={styles.toggle}
        disabled={disabled}
        role="switch"
        type="button"
        onClick={() => onChange(!checked)}
      >
        <span aria-hidden="true" className={styles.toggleTrack} data-checked={checked ? "true" : "false"}>
          <span className={styles.toggleThumb} />
        </span>
      </button>
    </div>
  );
}

function LoadingBlock({ label, testId }: { label: string; testId: string }) {
  return (
    <div className={styles.loadingList} data-testid={testId}>
      <LoaderCircle size={16} className={styles.spinning} />
      <span>{label}</span>
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div className={styles.inlineError} role="alert">
      <AlertCircle size={15} />
      <span>{message}</span>
    </div>
  );
}

function formatJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

function errorMessage(reason: unknown): string {
  return mcpErrorMessage(reason);
}
