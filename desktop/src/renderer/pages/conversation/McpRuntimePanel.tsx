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

  const loadStatus = useCallback(async () => {
    if (!sessionId) {
      setStatus(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setStatus(await runtime.mcp.getRuntimeStatus(sessionId));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
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

interface RuntimePanelIssue {
  description: string;
  kind: string;
  label: string;
}

interface RuntimePanelView {
  issues: RuntimePanelIssue[];
  pillLabel: string;
  runningCalls: McpRuntimeCallSummary[];
  statusLabel: string;
  summary: string;
  title: string;
  tone: "ready" | "attention" | "muted";
}

function runtimeView(status: McpRuntimeStatusResponse | null, error: string): RuntimePanelView {
  if (error) {
    return {
      issues: [],
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
  if (pendingApprovals > 0) {
    summaryParts.push(`${pendingApprovals} 个请求等待确认`);
  }
  if (runningCalls.length > 0) {
    summaryParts.push(`${runningCalls.length} 个调用执行中`);
  }

  return {
    issues,
    pillLabel: `${serversTotal} 个 MCP 服务器 · ${toolsVisible} 个 tool`,
    runningCalls,
    statusLabel: runtimeManagerStatusLabel(status.manager.runtime_status),
    summary: summaryParts.join("，"),
    title,
    tone,
  };
}

function runtimeIssues(status: McpRuntimeStatusResponse): RuntimePanelIssue[] {
  const issues = status.servers
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
