import { AlertCircle, ChevronDown, FileText, RefreshCcw, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { LoadingSkeleton } from "@/renderer/components/loading";
import { SettingsSelect } from "@/renderer/pages/settings/components";
import type { RuntimeBridge } from "@/runtime";
import type {
  McpAuditRecord,
  McpServerDetailResponse,
  McpTrustRule,
} from "@/types/protocol";

import styles from "./McpConsolePage.module.css";
import { mcpErrorMessage } from "./mcpCopy";

type ServerPermissionMode = "confirm_all" | "trusted";

const SERVER_PERMISSION_OPTIONS: Array<{
  description: string;
  label: string;
  value: ServerPermissionMode;
}> = [
  {
    value: "confirm_all",
    label: "按请求审批",
    description: "命中信任名单的请求会自动放行；未信任的请求需要你确认。",
  },
  {
    value: "trusted",
    label: "信任此服务",
    description: "此服务的工具调用不再反复确认。",
  },
];

const AUDIT_EVENT_OPTIONS = [
  { value: "server.created", label: "服务已添加" },
  { value: "server.updated", label: "服务已更新" },
  { value: "server.deleted", label: "服务已删除" },
  { value: "server.tested", label: "连接测试" },
  { value: "server.refreshed", label: "服务刷新" },
  { value: "refresh.completed", label: "刷新完成" },
  { value: "refresh.failed", label: "刷新失败" },
  { value: "tool.policy_updated", label: "工具授权已更新" },
  { value: "tool.called", label: "工具调用完成" },
  { value: "tool.failed", label: "工具调用失败" },
  { value: "tool.cancelled", label: "工具调用取消" },
  { value: "tool.guard_rejected", label: "工具调用被拦截" },
  { value: "runtime.override_set", label: "本会话工具设置已更新" },
  { value: "runtime.override_cleared", label: "本会话工具设置已清除" },
  { value: "approval.requested", label: "请求用户确认" },
  { value: "approval.resolved", label: "用户确认完成" },
  { value: "trust.created", label: "信任项已添加" },
  { value: "trust.deleted", label: "信任项已删除" },
  { value: "trust.hit", label: "命中信任项" },
  { value: "oauth.started", label: "开始登录授权" },
  { value: "oauth.completed", label: "登录授权完成" },
  { value: "oauth.failed", label: "登录授权失败" },
  { value: "elicitation.requested", label: "请求补充信息" },
  { value: "elicitation.resolved", label: "补充信息完成" },
  { value: "sampling.requested", label: "模型请求已接收" },
  { value: "sampling.resolved", label: "模型请求已确认" },
  { value: "sampling.completed", label: "模型请求完成" },
  { value: "sampling.denied", label: "模型请求被拒绝" },
  { value: "sampling.failed", label: "模型请求失败" },
] as const;

const AUDIT_STATUS_OPTIONS = [
  { value: "ok", label: "正常" },
  { value: "completed", label: "已完成" },
  { value: "success", label: "成功" },
  { value: "error", label: "异常" },
  { value: "failed", label: "失败" },
  { value: "approved", label: "已允许" },
  { value: "denied", label: "已拒绝" },
  { value: "rejected", label: "已拒绝" },
  { value: "cancelled", label: "已取消" },
  { value: "pending", label: "等待确认" },
] as const;

const AUDIT_PAGE_SIZE = 10;

export function McpPermissionsTab({
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

  const permissionMode = useMemo(
    () => resolvePermissionMode(detail, trustRules),
    [detail, trustRules],
  );

  const setPermissionMode = async (mode: ServerPermissionMode) => {
    setBusyKey(`permission:${mode}`);
    setError("");
    try {
      if (mode === "confirm_all") {
        await runtime.mcp.updateServer(serverId, {
          default_tool_approval_mode: "prompt",
          default_tool_exposure_mode: "allow_all_except_disabled",
        });
      } else {
        await runtime.mcp.updateServer(serverId, {
          default_tool_approval_mode: "approve",
          default_tool_exposure_mode: "allow_all_except_disabled",
        });
      }
      await load();
      onNotice(`服务器权限已保存：${permissionModeLabel(mode)}`);
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
      onNotice("信任项已删除");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyKey("");
    }
  };

  if (loading) {
    return <LoadingBlock label="加载权限设置" testId="mcp-permissions-loading" />;
  }

  return (
    <div className={styles.policyTab} data-testid="mcp-permissions-tab">
      {error ? <InlineError message={error} /> : null}
      {detail ? (
        <section className={styles.policySection}>
          <div className={styles.policySectionHeader}>
            <h3>服务器权限</h3>
            <button className={styles.smallToolButton} disabled={Boolean(busyKey)} type="button" onClick={() => void load()}>
              <RefreshCcw size={14} />
              <span>刷新</span>
            </button>
          </div>
          <div className={styles.permissionChoiceGrid}>
            {SERVER_PERMISSION_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={styles.permissionChoice}
                data-active={permissionMode === option.value ? "true" : "false"}
                disabled={busyKey === `permission:${option.value}`}
                type="button"
                onClick={() => void setPermissionMode(option.value)}
              >
                <strong>{option.label}</strong>
                <span>{option.description}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className={styles.policySection}>
        <div className={styles.policySectionHeader}>
          <h3>信任名单</h3>
          <button className={styles.smallToolButton} disabled={Boolean(busyKey)} type="button" onClick={() => void load()}>
            <RefreshCcw size={14} />
            <span>刷新</span>
          </button>
        </div>
        <TrustRuleList busyKey={busyKey} rules={trustRules} onDelete={deleteRule} />
      </section>
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

  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));
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
        <SettingsSelect
          ariaLabel="筛选 MCP 日志事件"
          density="compact"
          options={[
            { value: "all", label: "全部事件" },
            ...AUDIT_EVENT_OPTIONS,
          ]}
          value={eventType}
          onChange={updateEventType}
        />
        <SettingsSelect
          ariaLabel="筛选 MCP 日志状态"
          density="compact"
          options={[
            { value: "all", label: "全部状态" },
            ...AUDIT_STATUS_OPTIONS,
          ]}
          value={statusFilter}
          onChange={updateStatusFilter}
        />
        <button className={styles.smallToolButton} type="button" disabled={loading} onClick={() => void load()}>
          <RefreshCcw size={14} />
          <span>刷新</span>
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
            <article
              key={log.id}
              className={styles.logRow}
              data-expanded={expandedId === log.id ? "true" : "false"}
              data-testid="mcp-log-row"
            >
              <button
                type="button"
                aria-expanded={expandedId === log.id}
                onClick={() => setExpandedId((current) => current === log.id ? "" : log.id)}
              >
                <ChevronDown className={styles.logChevron} size={14} />
                <span>{formatDate(log.created_at)}</span>
                <strong>{auditEventLabel(log.event_type)}</strong>
                <span>{auditStatusLabel(log.status)}</span>
                <span>{log.duration_ms == null ? "-" : `${log.duration_ms}ms`}</span>
                <em>{log.summary ?? "-"}</em>
              </button>
              <div className={styles.logDetailShell} data-open={expandedId === log.id ? "true" : "false"} aria-hidden={expandedId !== log.id}>
                <pre>{formatJson(log.detail ?? {})}</pre>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {total > 0 ? (
        <footer className={styles.logPager} data-testid="mcp-log-pager" aria-label="MCP 日志分页">
          <span>
            第 {currentPage} / {totalPages} 页，共 {total} 条
          </span>
          <div>
            <button
              type="button"
              aria-label="上一页 MCP 日志"
              disabled={loading || !canGoPrevious}
              onClick={() => setOffset(Math.max(0, offset - limit))}
            >
              上一页
            </button>
            <button
              type="button"
              aria-label="下一页 MCP 日志"
              disabled={loading || !canGoNext}
              onClick={() => setOffset(offset + limit)}
            >
              下一页
            </button>
          </div>
        </footer>
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
        <span>暂无信任项</span>
      </div>
    );
  }
  return (
    <div className={styles.trustRuleList} data-testid="mcp-trust-rule-list">
      {rules.map((rule) => (
        <article key={rule.id} className={styles.trustRuleRow}>
          <div>
            <strong>{trustRuleTitle(rule)}</strong>
            <span>{trustRuleTarget(rule)}</span>
          </div>
          <div>
            <span>{trustRuleScopeLabel(rule)}</span>
            <span>使用 {rule.hit_count} 次</span>
          </div>
          <div>
            <span>添加时间 {formatDate(rule.created_at)}</span>
            <span>最近使用 {formatDate(rule.last_hit_at)}</span>
          </div>
          <button
            className={styles.smallToolButton}
            disabled={busyKey === `delete:${rule.id}`}
            type="button"
            aria-label={`删除信任项 ${trustRuleTitle(rule)}`}
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

function LoadingBlock({ label, testId }: { label: string; testId: string }) {
  return (
    <LoadingSkeleton
      aria-label={label}
      className={styles.detailSkeleton}
      lineCount={5}
      testId={testId}
      width="default"
    />
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

function resolvePermissionMode(
  detail: McpServerDetailResponse | null,
  _rules: McpTrustRule[],
): ServerPermissionMode {
  if (!detail) {
    return "confirm_all";
  }
  if (detail.default_tool_approval_mode === "approve" || detail.default_tool_approval_mode === "auto") {
    return "trusted";
  }
  return "confirm_all";
}

function permissionModeLabel(value: ServerPermissionMode): string {
  return SERVER_PERMISSION_OPTIONS.find((option) => option.value === value)?.label ?? "按请求审批";
}

function trustRuleTitle(rule: McpTrustRule): string {
  if (rule.approval_mode === "deny" || rule.rule_kind === "deny_tool") {
    return "已拒绝工具";
  }
  if (rule.rule_kind === "tool_with_params") {
    return "已保存请求授权";
  }
  if (rule.scope === "session") {
    return "本会话已信任";
  }
  return "已信任工具";
}

function trustRuleTarget(rule: McpTrustRule): string {
  return rule.raw_tool_name || "未指定工具";
}

function trustRuleScopeLabel(rule: McpTrustRule): string {
  return rule.scope === "session" ? "仅当前会话" : "全局生效";
}

function auditEventLabel(value: string): string {
  return AUDIT_EVENT_OPTIONS.find((option) => option.value === value)?.label ?? "未知事件";
}

function auditStatusLabel(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return AUDIT_STATUS_OPTIONS.find((option) => option.value === value)?.label ?? "未知状态";
}

function errorMessage(reason: unknown): string {
  return mcpErrorMessage(reason);
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return value.replace("T", " ").replace("Z", "");
}

function formatJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}
