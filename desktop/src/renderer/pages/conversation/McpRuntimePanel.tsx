import { AlertCircle, CheckCircle2, ExternalLink, LoaderCircle, PlugZap, RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RuntimeBridge } from "@/runtime";
import type { McpRuntimeCallSummary, McpRuntimeStatusResponse, McpServerSummary } from "@/types/protocol";

import styles from "./McpRuntimePanel.module.css";

export interface McpRuntimePillProps {
  runtime: RuntimeBridge;
  sessionId: string;
  runtimeState: string;
  onOpenSettings?: () => void;
}

export function McpRuntimePill({ runtime, sessionId, runtimeState, onOpenSettings }: McpRuntimePillProps) {
  const [status, setStatus] = useState<McpRuntimeStatusResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const requestIdRef = useRef(0);

  const loadStatus = useCallback(async () => {
    if (!sessionId) {
      setStatus(null);
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError("");
    try {
      const nextStatus = await runtime.mcp.getRuntimeStatus(sessionId);
      if (requestIdRef.current === requestId) {
        setStatus(nextStatus);
      }
    } catch (reason) {
      if (requestIdRef.current === requestId) {
        setError(errorMessage(reason));
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [runtime, sessionId]);

  useEffect(() => {
    requestIdRef.current += 1;
    setStatus(null);
    setOpen(false);
    setLoading(false);
    setError("");
    return () => {
      requestIdRef.current += 1;
    };
  }, [runtime, sessionId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus, runtimeState]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  const view = useMemo(() => runtimeView(status, error), [error, status]);

  return (
    <span
      className={styles.wrap}
      ref={rootRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        className={styles.pill}
        type="button"
        aria-label="打开 MCP 运行状态"
        aria-expanded={open}
        data-testid="mcp-runtime-pill"
        data-tone={view.tone}
        onClick={() => setOpen(true)}
      >
        <PlugZap size={13} />
        <span>MCP</span>
        {loading && !status ? <LoaderCircle size={12} className={styles.spinning} /> : null}
        <em>{view.pillLabel}</em>
        {view.runningCalls.length > 0 ? <strong>{view.runningCalls.length} 个执行中</strong> : null}
      </button>
      <section
        className={styles.panel}
        role="dialog"
        aria-label="MCP 运行状态"
        aria-hidden={!open}
        data-open={open ? "true" : "false"}
        data-testid="mcp-runtime-panel"
      >
        <header className={styles.panelHeader}>
          <div>
            <strong>MCP 当前会话</strong>
            <span>{view.statusLabel}</span>
          </div>
          <button type="button" aria-label="刷新 MCP 运行状态" disabled={loading} onClick={() => void loadStatus()}>
            <RefreshCcw size={13} className={loading ? styles.spinning : undefined} />
          </button>
        </header>

        <div className={styles.panelBody}>
          {error ? (
            <div className={styles.inlineError} role="alert">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          ) : null}

          <section className={styles.summaryBlock} data-tone={view.tone}>
            <span className={styles.summaryIcon} aria-hidden="true">
              {view.tone === "ready" ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
            </span>
            <div>
              <strong>{view.title}</strong>
              <span>{view.summary}</span>
            </div>
          </section>

          {view.hasSnapshot ? (
            <section className={styles.section} aria-label="MCP 能力状态">
              <h3>能力状态</h3>
              <div className={styles.metricsGrid}>
                <MetricTile label="能力目录" value={`${view.capabilityServerCount} 个服务`} />
                <MetricTile label="直接可用" value={`${view.directToolCount} 个工具`} />
                <MetricTile label="按需加载" value={`${view.onDemandToolCount} 个工具`} />
              </div>
              {view.capabilityServers.length > 0 ? (
                <div className={styles.issueList}>
                  {view.capabilityServers.slice(0, 3).map((server) => (
                    <div className={styles.issueRow} key={server.id}>
                      <strong>{server.name}</strong>
                      <span>{server.description}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {view.activeTools.length > 0 ? (
                <div className={styles.runningList} aria-label="最近激活">
                  <h3>最近激活</h3>
                  {view.activeTools.slice(0, 3).map((tool) => (
                    <div key={tool.modelName} className={styles.runningRow}>
                      <strong>{tool.serverName || "未知 MCP 服务"} / {tool.rawName}</strong>
                      <span>已在当前会话直接可用</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ) : (
            <section className={styles.emptyPanelState} aria-label="MCP 能力状态">
              <strong>暂无能力数据</strong>
              <span>发送消息后会显示当前会话可用的 MCP 能力。</span>
            </section>
          )}

          {view.issues.length > 0 ? (
            <section className={styles.section} aria-label="MCP 需要处理">
              <h3>需要处理</h3>
              <div className={styles.issueList}>
                {view.issues.map((issue) => (
                  <div className={styles.issueRow} key={`${issue.kind}:${issue.label}`}>
                    <strong>{issue.label}</strong>
                    <span>{issue.description}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {view.runningCalls.length > 0 ? (
            <section className={styles.section} aria-label="MCP 正在执行">
              <h3>正在执行</h3>
              <div className={styles.runningList}>
                {view.runningCalls.slice(0, 3).map((call) => (
                  <div key={call.call_id} className={styles.runningRow}>
                    <strong>{call.server_name || "未知 MCP 服务"} / {call.raw_tool_name}</strong>
                    <span>已运行 {formatElapsed(call.elapsed_ms)}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        {onOpenSettings ? (
          <footer className={styles.panelFooter}>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              <ExternalLink size={13} />
              <span>打开 MCP 设置</span>
            </button>
          </footer>
        ) : null}
      </section>
    </span>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metricTile}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

interface RuntimePanelIssue {
  description: string;
  kind: string;
  label: string;
}

interface RuntimePanelView {
  activeTools: RuntimePanelActiveTool[];
  capabilityServerCount: number;
  capabilityServers: RuntimePanelCapabilityServer[];
  directToolCount: number;
  hasSnapshot: boolean;
  issues: RuntimePanelIssue[];
  onDemandToolCount: number;
  pillLabel: string;
  runningCalls: McpRuntimeCallSummary[];
  statusLabel: string;
  summary: string;
  title: string;
  tone: "ready" | "attention" | "muted";
}

interface RuntimePanelCapabilityServer {
  description: string;
  id: string;
  name: string;
}

interface RuntimePanelActiveTool {
  modelName: string;
  rawName: string;
  serverName: string;
}

function runtimeView(status: McpRuntimeStatusResponse | null, error: string): RuntimePanelView {
  if (error) {
    return {
      issues: [],
      activeTools: [],
      capabilityServerCount: 0,
      capabilityServers: [],
      directToolCount: 0,
      hasSnapshot: false,
      onDemandToolCount: 0,
      pillLabel: "请求失败",
      runningCalls: [],
      statusLabel: "状态读取失败",
      summary: "无法读取当前会话的 MCP 状态。",
      title: "MCP 状态不可用",
      tone: "attention",
    };
  }
  if (!status) {
    return {
      issues: [],
      activeTools: [],
      capabilityServerCount: 0,
      capabilityServers: [],
      directToolCount: 0,
      hasSnapshot: false,
      onDemandToolCount: 0,
      pillLabel: "读取中",
      runningCalls: [],
      statusLabel: "正在读取",
      summary: "正在读取当前会话的 MCP 状态。",
      title: "MCP 状态读取中",
      tone: "muted",
    };
  }
  if (!status.manager.enabled) {
    return {
      issues: [],
      activeTools: [],
      capabilityServerCount: 0,
      capabilityServers: [],
      directToolCount: 0,
      hasSnapshot: Boolean(status.snapshot),
      onDemandToolCount: 0,
      pillLabel: "已关闭",
      runningCalls: status.running_calls,
      statusLabel: runtimeManagerStatusLabel(status.manager.runtime_status),
      summary: "MCP 功能当前未启用。",
      title: "MCP 已关闭",
      tone: "muted",
    };
  }

  const issues = runtimeIssues(status);
  const toolsVisible = visibleToolCount(status);
  const directToolCount = snapshotNumber(status, "direct_available_tools");
  const onDemandToolCount = snapshotNumber(status, "on_demand_tools");
  const capabilityServers = capabilityServerSummaries(status);
  const activeTools = activeToolSummaries(status);
  const serversTotal = totalServerCount(status);
  const serversOnline = status.summary.servers_online ?? status.servers.filter((server) => server.status === "online").length;
  const pendingApprovals = status.pending_approvals ?? status.summary.pending_approvals ?? 0;
  const runningCalls = status.running_calls;
  const tone = issues.length > 0 || pendingApprovals > 0 ? "attention" : "ready";
  const title =
    runningCalls.length > 0
      ? "MCP 正在执行"
      : pendingApprovals > 0
        ? "MCP 等待确认"
        : issues.length > 0
          ? "MCP 需要处理"
          : "MCP 可用";
  const summaryParts = [`${serversOnline}/${serversTotal} 个服务在线`, `${toolsVisible} 个工具可用`];
  if (status.snapshot) {
    summaryParts.push(`直接可用 ${directToolCount} 个`);
    summaryParts.push(`按需加载 ${onDemandToolCount} 个`);
  }
  if (pendingApprovals > 0) {
    summaryParts.push(`${pendingApprovals} 个请求等待确认`);
  }
  if (runningCalls.length > 0) {
    summaryParts.push(`${runningCalls.length} 个调用执行中`);
  }

  return {
    activeTools,
    capabilityServerCount: capabilityServers.length,
    capabilityServers,
    directToolCount,
    hasSnapshot: Boolean(status.snapshot),
    issues,
    onDemandToolCount,
    pillLabel: `${serversTotal} 个 MCP 服务器 · ${toolsVisible} 个工具`,
    runningCalls,
    statusLabel: runtimeManagerStatusLabel(status.manager.runtime_status),
    summary: summaryParts.join("，"),
    title,
    tone,
  };
}

function snapshotNumber(
  status: McpRuntimeStatusResponse,
  field: "direct_available_tools" | "on_demand_tools" | "unavailable_tools",
): number {
  const value = status.snapshot?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function capabilityServerSummaries(status: McpRuntimeStatusResponse): RuntimePanelCapabilityServer[] {
  const directory = status.snapshot?.capability_directory;
  if (!Array.isArray(directory)) {
    return [];
  }
  return directory
    .map((item) => {
      const id = stringValue(item.server_id);
      const name = stringValue(item.server_name) || id || "未知 MCP 服务";
      const statusLabel = stringValue(item.status_label) || stringValue(item.status) || "未知";
      const directCount = numberValue(item.direct_tool_count);
      const onDemandCount = numberValue(item.on_demand_tool_count);
      return {
        id: id || name,
        name,
        description: `${statusLabel}，直接可用 ${directCount} 个，按需加载 ${onDemandCount} 个`,
      };
    })
    .filter((item) => item.id || item.name);
}

function activeToolSummaries(status: McpRuntimeStatusResponse): RuntimePanelActiveTool[] {
  const activeNames = new Set(arrayOfStrings(status.snapshot?.policy_summary?.active_model_names));
  const tools = status.snapshot?.visible_tools;
  if (!activeNames.size || !Array.isArray(tools)) {
    return [];
  }
  return tools
    .filter((tool) => {
      const modelName = stringValue(tool.model_name);
      return modelName && activeNames.has(modelName);
    })
    .map((tool) => ({
      modelName: stringValue(tool.model_name),
      rawName: stringValue(tool.raw_name) || "未知工具",
      serverName: stringValue(tool.server_name),
    }))
    .filter((tool) => tool.modelName);
}

function runtimeIssues(status: McpRuntimeStatusResponse): RuntimePanelIssue[] {
  const issues: RuntimePanelIssue[] = status.servers
    .filter((server) => isServerIssue(server))
    .slice(0, 3)
    .map((server) => ({
      kind: server.status,
      label: server.name,
      description: serverIssueLabel(server),
    }));
  const disabledForSession = status.overrides.filter((override) => override.enabled === false).length;
  if (disabledForSession > 0) {
    issues.push({
      kind: "session_override",
      label: "当前会话停用",
      description: `${disabledForSession} 个工具在当前会话被临时停用，可在 MCP 设置中调整。`,
    });
  }
  return issues;
}

function isServerIssue(server: McpServerSummary): boolean {
  return !server.enabled || server.status === "disabled" || server.status === "offline" || server.status === "auth_required" || server.status === "error";
}

function serverIssueLabel(server: McpServerSummary): string {
  if (!server.enabled || server.status === "disabled") {
    return "服务已停用";
  }
  if (server.status === "auth_required") {
    return "需要重新认证";
  }
  if (server.status === "offline") {
    return "服务离线";
  }
  if (server.status === "error") {
    return server.last_error_message || "服务异常";
  }
  return "状态异常";
}

function visibleToolCount(status: McpRuntimeStatusResponse): number {
  return (
    status.snapshot?.tools_visible ??
    status.snapshot?.visible_tools_count ??
    status.summary.tools_enabled ??
    status.tools.filter((tool) => tool.effective_state === "enabled").length
  );
}

function totalServerCount(status: McpRuntimeStatusResponse): number {
  return status.summary.servers_total ?? status.snapshot?.servers_total ?? status.servers.length;
}

function runtimeManagerStatusLabel(value: string | null | undefined): string {
  switch (value) {
    case "ready":
    case "running":
    case "started":
    case "enabled":
      return "运行中";
    case "starting":
      return "启动中";
    case "stopped":
      return "已停止";
    case "disabled":
      return "已关闭";
    case "error":
    case "failed":
      return "异常";
    default:
      return "未知";
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${Math.round(ms / 1000)}s`;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "MCP 运行状态请求失败";
}
