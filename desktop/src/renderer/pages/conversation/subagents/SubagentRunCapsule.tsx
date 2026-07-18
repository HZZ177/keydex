import { useEffect, useState } from "react";

import { useOptionalRightSidebarConversation } from "@/renderer/components/layout/RightSidebarConversationContext";
import { formatConversationDuration } from "@/renderer/pages/conversation/messages/duration";
import { useOptionalAgentSessionRuntime } from "@/renderer/providers/AgentSessionProvider";
import type { SubagentRunSnapshot } from "@/types/subagents";

import styles from "./SubagentRunCapsule.module.css";
import { SubagentRoleIcon, subagentRoleLabel } from "./SubagentRoleIcon";

export function SubagentRunCapsule({ run }: { run: SubagentRunSnapshot }) {
  const sidebar = useOptionalRightSidebarConversation();
  const agentRuntime = useOptionalAgentSessionRuntime();
  const unread = Boolean(agentRuntime?.subagentState.unreadRunIds[run.run_id]);
  const stateLabel = runStateLabel(run);
  const durationMs = useSubagentRunDuration(run);
  const visibleState = durationMs === null
    ? stateLabel
    : `${stateLabel} · 已处理 ${formatConversationDuration(durationMs)}`;
  const label = `${subagentRoleLabel(run.role)}，${visibleState}，任务：${run.task}`;

  return (
    <span
      className={styles.capsuleRow}
      data-state={run.state}
      data-blocked={run.blocked_on ?? undefined}
      data-unread={unread ? "true" : undefined}
    >
      <button
        type="button"
        className={styles.capsule}
        data-state={run.state}
        data-testid={`subagent-run-capsule:${run.run_id}`}
        aria-label={`${label}，打开详情`}
        title={label}
        onClick={() => {
          agentRuntime?.markSubagentRunRead(run.run_id);
          sidebar?.openSubagentPanel(run);
        }}
        disabled={!sidebar}
      >
        <span className={styles.roleIcon} data-role={run.role} aria-hidden="true">
          <SubagentRoleIcon role={run.role} size={17} />
        </span>
        <span className={styles.role}>{subagentRoleLabel(run.role)}</span>
      </button>
      <span className={styles.runState} role="status" aria-live="polite">
        {visibleState}
      </span>
    </span>
  );
}

function useSubagentRunDuration(run: SubagentRunSnapshot): number | null {
  const startedAtMs = timestampMs(run.started_at);
  const live = run.state === "running" && startedAtMs !== null;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return undefined;
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [live, run.run_id, startedAtMs]);

  if (startedAtMs === null) return null;
  const endedAtMs = live ? nowMs : timestampMs(run.finished_at);
  return endedAtMs === null ? null : Math.max(0, endedAtMs - startedAtMs);
}

function timestampMs(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function runStateLabel(run: SubagentRunSnapshot): string {
  if (run.state === "queued") return "正在启动";
  if (run.state === "running") {
    return run.blocked_on ? blockedLabel(run.blocked_on) ?? "等待中" : "正在工作";
  }
  if (run.state === "completed") return "已完成";
  if (run.state === "failed") return "运行失败";
  if (run.state === "cancelled") return "已取消";
  return "已中断";
}

function blockedLabel(blockedOn: SubagentRunSnapshot["blocked_on"]): string | null {
  if (blockedOn === "approval") return "等待审批";
  if (blockedOn === "user_input") return "等待用户输入";
  if (blockedOn === "external_tool") return "等待外部工具";
  return null;
}
