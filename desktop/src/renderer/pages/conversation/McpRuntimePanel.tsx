import { AlertCircle, CheckCircle2, LoaderCircle, PlugZap, RefreshCcw, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RuntimeBridge } from "@/runtime";
import type { McpRuntimeCallSummary, McpRuntimeStatusResponse, McpServerSummary, McpToolSummary } from "@/types/protocol";

import styles from "./McpRuntimePanel.module.css";

export interface McpRuntimePillProps {
  runtime: RuntimeBridge;
  sessionId: string;
  runtimeState: string;
}

export function McpRuntimePill({ runtime, sessionId, runtimeState }: McpRuntimePillProps) {
  const [status, setStatus] = useState<McpRuntimeStatusResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [workingToolId, setWorkingToolId] = useState("");
  const [cancellingCallId, setCancellingCallId] = useState("");
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

  const view = useMemo(() => runtimeView(status), [status]);
  const servers = status?.servers ?? [];
  const toolsByServer = useMemo(() => groupToolsByServer(status?.tools ?? []), [status?.tools]);

  const toggleTool = async (tool: McpToolSummary, enabled: boolean) => {
    setWorkingToolId(tool.id);
    setNotice("");
    setError("");
    try {
      const response = await runtime.mcp.setSessionToolOverride(sessionId, tool.id, {
        server_id: tool.server_id,
        enabled,
        reason: enabled ? "user_enabled_in_runtime_panel" : "user_disabled_in_runtime_panel",
      });
      const currentRun = appliesToCurrentRun(response);
      setNotice(
        enabled && currentRun === false
          ? `已启用 ${tool.raw_name}，下一轮生效`
          : enabled
            ? `已启用 ${tool.raw_name}`
            : `已在当前会话禁用 ${tool.raw_name}`,
      );
      await loadStatus();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setWorkingToolId("");
    }
  };

  const cancelCall = async (call: McpRuntimeCallSummary) => {
    setCancellingCallId(call.call_id);
    setNotice("");
    setError("");
    try {
      const response = await runtime.mcp.cancelRuntimeCall(call.call_id);
      setNotice(response.cancelled ? `已取消 ${call.raw_tool_name}` : `未能取消 ${call.raw_tool_name}`);
      await loadStatus();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setCancellingCallId("");
    }
  };

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
        aria-label="打开 MCP Runtime Panel"
        aria-expanded={open}
        data-testid="mcp-runtime-pill"
        onClick={() => setOpen(true)}
      >
        <PlugZap size={13} />
        <span>MCP</span>
        {loading && !status ? <LoaderCircle size={12} className={styles.spinning} /> : null}
        <em>{view.snapshotLabel}</em>
        <em>{view.toolsVisible} tools</em>
        {view.runningCalls > 0 ? <strong>{view.runningCalls} running</strong> : null}
      </button>
      <section
        className={styles.panel}
        role="dialog"
        aria-label="MCP Runtime Panel"
        aria-hidden={!open}
        data-open={open ? "true" : "false"}
        data-testid="mcp-runtime-panel"
      >
        <header className={styles.panelHeader}>
          <div>
            <strong>MCP Runtime</strong>
            <span>{status?.manager.runtime_status ?? "unknown"}</span>
          </div>
          <button type="button" aria-label="刷新 MCP Runtime 状态" disabled={loading} onClick={() => void loadStatus()}>
            <RefreshCcw size={13} className={loading ? styles.spinning : undefined} />
          </button>
        </header>

        {error ? (
          <div className={styles.inlineError} role="alert">
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        ) : null}
        {notice ? (
          <div className={styles.notice} role="status">
            <CheckCircle2 size={14} />
            <span>{notice}</span>
          </div>
        ) : null}

        <div className={styles.summaryGrid}>
          <RuntimeMetric label="Snapshot" value={view.snapshotLabel} />
          <RuntimeMetric label="Online" value={`${view.serversOnline}/${view.serversTotal}`} />
          <RuntimeMetric label="Visible tools" value={view.toolsVisible} />
          <RuntimeMetric label="Session disabled" value={view.disabledForSession} />
          <RuntimeMetric label="Pending approvals" value={view.pendingApprovals} />
          <RuntimeMetric label="Running" value={view.runningCalls} />
        </div>

        <div className={styles.serverList}>
          {servers.length === 0 ? <div className={styles.emptyState}>暂无 MCP runtime 状态</div> : null}
          {servers.map((server) => (
            <RuntimeServerGroup
              key={server.id}
              server={server}
              tools={toolsByServer.get(server.id) ?? []}
              workingToolId={workingToolId}
              onToggleTool={(tool, enabled) => void toggleTool(tool, enabled)}
            />
          ))}
        </div>

        {status?.running_calls.length ? (
          <div className={styles.runningList}>
            <h3>正在执行</h3>
            {status.running_calls.map((call) => (
              <div key={call.call_id} className={styles.runningRow}>
                <div>
                  <strong>{call.raw_tool_name}</strong>
                  <span>{call.call_id}</span>
                </div>
                <span>{formatElapsed(call.elapsed_ms)}</span>
                <button
                  type="button"
                  aria-label={`取消 MCP call ${call.call_id}`}
                  disabled={cancellingCallId === call.call_id}
                  onClick={() => void cancelCall(call)}
                >
                  <Square size={12} />
                  <span>{cancellingCallId === call.call_id ? "取消中" : "取消"}</span>
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </span>
  );
}

function RuntimeServerGroup({
  server,
  tools,
  workingToolId,
  onToggleTool,
}: {
  server: McpServerSummary;
  tools: McpToolSummary[];
  workingToolId: string;
  onToggleTool: (tool: McpToolSummary, enabled: boolean) => void;
}) {
  const visibleTools = runtimePanelTools(server, tools);
  return (
    <section className={styles.serverGroup}>
      <header>
        <div>
          <strong>{server.name}</strong>
          <span>{server.transport}</span>
        </div>
        <span className={styles.statusBadge} data-status={server.enabled ? server.status : "disabled"}>
          {server.enabled ? server.status : "disabled"}
        </span>
      </header>
      {server.last_error_message ? <p>{server.last_error_message}</p> : null}
      <div className={styles.toolList}>
        {visibleTools.length === 0 ? <span className={styles.emptyState}>暂无可见 tools</span> : null}
        {visibleTools.map((tool) => {
          const disabledReason = runtimeToolDisabledReason(server, tool);
          const enabled = tool.effective_state !== "disabled_for_session";
          return (
            <div key={tool.id} className={styles.toolRow}>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={disabledReason ? `MCP tool ${tool.raw_name} 不可切换` : `${enabled ? "关闭" : "启用"} MCP tool ${tool.raw_name}`}
                disabled={Boolean(disabledReason) || workingToolId === tool.id}
                data-checked={enabled ? "true" : "false"}
                onClick={() => onToggleTool(tool, !enabled)}
              >
                <span />
              </button>
              <div>
                <strong>{tool.raw_name}</strong>
                <span>{tool.description || tool.model_name}</span>
              </div>
              <span>{tool.risk_level}</span>
              <span>{tool.effective_approval_mode ?? tool.approval_mode}</span>
              <span>{disabledReason || tool.effective_state}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function runtimePanelTools(server: McpServerSummary, tools: McpToolSummary[]): McpToolSummary[] {
  if (!server.enabled || server.status === "disabled") {
    return [];
  }
  return tools;
}

function RuntimeMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={styles.metric}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function runtimeView(status: McpRuntimeStatusResponse | null) {
  const snapshot = status?.snapshot;
  const disabledForSession = status
    ? Math.max(
        status.overrides.filter((override) => override.enabled === false).length,
        status.tools.filter((tool) => tool.effective_state === "disabled_for_session").length,
      )
    : 0;
  return {
    snapshotLabel: snapshot?.id ?? snapshot?.snapshot_id ?? "no snapshot",
    serversTotal: status?.summary.servers_total ?? snapshot?.servers_total ?? status?.servers.length ?? 0,
    serversOnline: status?.summary.servers_online ?? snapshot?.servers_online ?? 0,
    toolsVisible: snapshot?.tools_visible ?? snapshot?.visible_tools_count ?? status?.summary.tools_enabled ?? 0,
    disabledForSession,
    pendingApprovals: status?.pending_approvals ?? status?.summary.pending_approvals ?? snapshot?.pending_approvals ?? 0,
    runningCalls: status?.running_calls.length ?? 0,
  };
}

function groupToolsByServer(tools: McpToolSummary[]): Map<string, McpToolSummary[]> {
  const grouped = new Map<string, McpToolSummary[]>();
  for (const tool of tools) {
    const group = grouped.get(tool.server_id) ?? [];
    group.push(tool);
    grouped.set(tool.server_id, group);
  }
  return grouped;
}

function runtimeToolDisabledReason(server: McpServerSummary, tool: McpToolSummary): string {
  if (!server.enabled || server.status === "disabled" || tool.effective_state === "disabled_by_server") {
    return "server disabled";
  }
  if (server.status === "offline" || tool.effective_state === "server_offline") {
    return "server offline";
  }
  if (server.status === "auth_required") {
    return "auth required";
  }
  if (tool.effective_state === "disabled_persistently") {
    return "global policy";
  }
  if (tool.effective_state === "removed") {
    return "removed";
  }
  return "";
}

function appliesToCurrentRun(response: unknown): boolean | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const value = (response as { applies_to_current_run?: unknown }).applies_to_current_run;
  return typeof value === "boolean" ? value : null;
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
  return "MCP Runtime 请求失败";
}
