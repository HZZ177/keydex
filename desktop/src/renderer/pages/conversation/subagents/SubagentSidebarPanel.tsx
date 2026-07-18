import { ArrowLeft, CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { useEffect, useMemo } from "react";

import type { SubagentInvocationPanelDetails } from "@/renderer/components/layout/RightSidebarConversationContext";
import { useOptionalRightSidebarConversation } from "@/renderer/components/layout/RightSidebarConversationContext";
import { useOptionalAgentSessionRuntime } from "@/renderer/providers/AgentSessionProvider";
import { selectParentSubagentRuns } from "@/renderer/stores/subagentRunStore";
import type { SubagentRole, SubagentRunSnapshot } from "@/types/subagents";

import styles from "./SubagentSidebarPanel.module.css";
import { SubagentRoleIcon, subagentRoleLabel } from "./SubagentRoleIcon";

export type SubagentRunGroup = "active" | "completed" | "unsuccessful";

export interface SubagentListItem {
  createdAt: string;
  latestRun: SubagentRunSnapshot;
}

export function SubagentRunList({ parentSessionId }: { parentSessionId: string }) {
  const agentRuntime = useOptionalAgentSessionRuntime();
  const sidebar = useOptionalRightSidebarConversation();
  const requestSubagentRuns = agentRuntime?.requestSubagentRuns;
  const runs = agentRuntime
    ? selectParentSubagentRuns(agentRuntime.subagentState, parentSessionId)
    : [];
  const groups = useMemo(() => groupSubagentRunsForList(runs), [runs]);

  useEffect(() => {
    requestSubagentRuns?.(parentSessionId);
  }, [parentSessionId, requestSubagentRuns]);

  if (!runs.length) {
    return (
      <div className={styles.empty} data-testid="subagent-sidebar-empty">
        当前会话还没有 Sub-Agent
      </div>
    );
  }

  return (
    <div className={styles.list} data-testid="subagent-sidebar-list">
      {GROUP_ORDER.map((group) => {
        const items = groups[group];
        if (!items.length) return null;
        return (
          <section className={styles.group} data-group={group} key={group}>
            <h3 className={styles.groupTitle}>{groupLabel(group)} · {items.length}</h3>
            <div className={styles.groupItems}>
              {items.map(({ latestRun, createdAt }) => {
                return (
                  <button
                    type="button"
                    className={styles.item}
                    data-state={latestRun.state}
                    data-testid={`subagent-sidebar-item:${latestRun.subagent_id}`}
                    key={latestRun.subagent_id}
                    onClick={() => sidebar?.openSubagentPanel(latestRun)}
                  >
                    <span className={styles.itemIcon} data-role={latestRun.role} aria-hidden="true">
                      <SubagentRoleIcon role={latestRun.role} size={19} />
                    </span>
                    <span className={styles.itemBody}>
                      <span className={styles.itemHeading}>
                        <span className={styles.itemName}>{subagentRoleLabel(latestRun.role)}</span>
                        <span className={styles.itemAge}>{relativeAge(createdAt)}</span>
                      </span>
                      <span className={styles.itemSummary}>{runSummary(latestRun)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function SubagentPanelHeader({
  role,
  onBack,
}: {
  role: SubagentRole;
  onBack: () => void;
}) {
  return (
    <header className={styles.detailHeader}>
      <button type="button" className={styles.back} aria-label="返回 Sub-Agent 列表" onClick={onBack}>
        <ArrowLeft size={15} />
      </button>
      <span className={styles.detailIcon} data-role={role} aria-hidden="true">
        <SubagentRoleIcon role={role} size={19} />
      </span>
      <strong>{subagentRoleLabel(role)}</strong>
    </header>
  );
}

export function SubagentInvocationDetail({
  details,
  onBack,
}: {
  details: SubagentInvocationPanelDetails;
  onBack: () => void;
}) {
  const StatusIcon = details.state === "failed"
    ? CircleAlert
    : details.state === "completed"
      ? CircleCheck
      : LoaderCircle;
  return (
    <div className={styles.detail} data-state={details.state} data-testid="subagent-invocation-detail-panel">
      <SubagentPanelHeader role={details.role} onBack={onBack} />
      <div className={styles.detailBody}>
        <div className={styles.statusLine} role="status">
          <StatusIcon size={14} />
          <span>{invocationStateLabel(details.state)}</span>
        </div>
        <section className={styles.detailSection}>
          <h3>任务</h3>
          <p>{details.task}</p>
        </section>
        {details.errorMessage ? (
          <section className={styles.errorSection}>
            <h3>错误</h3>
            <p>{details.errorMessage}</p>
            {details.errorCode ? <code>{details.errorCode}</code> : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

const GROUP_ORDER: SubagentRunGroup[] = ["active", "completed", "unsuccessful"];

export function groupSubagentRunsForList(
  runs: SubagentRunSnapshot[],
): Record<SubagentRunGroup, SubagentListItem[]> {
  const bySubagent = new Map<string, SubagentRunSnapshot[]>();
  for (const run of runs) {
    const group = bySubagent.get(run.subagent_id) ?? [];
    group.push(run);
    bySubagent.set(run.subagent_id, group);
  }
  const result: Record<SubagentRunGroup, SubagentListItem[]> = {
    active: [],
    completed: [],
    unsuccessful: [],
  };
  for (const history of bySubagent.values()) {
    const firstRun = history[0];
    if (!firstRun) continue;
    const latestRun = [...history].sort(compareRunRecency)[0] ?? firstRun;
    const createdAt = history.reduce(
      (earliest, run) => Date.parse(run.created_at) < Date.parse(earliest) ? run.created_at : earliest,
      firstRun.created_at,
    );
    result[runGroup(latestRun)].push({ createdAt, latestRun });
  }
  for (const group of GROUP_ORDER) {
    result[group].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }
  return result;
}

function compareRunRecency(left: SubagentRunSnapshot, right: SubagentRunSnapshot): number {
  return (
    right.parent_timeline_sequence - left.parent_timeline_sequence ||
    Date.parse(right.created_at) - Date.parse(left.created_at) ||
    right.run_id.localeCompare(left.run_id)
  );
}

function runGroup(run: SubagentRunSnapshot): SubagentRunGroup {
  if (run.state === "queued" || run.state === "running") return "active";
  return run.state === "completed" ? "completed" : "unsuccessful";
}

function groupLabel(group: SubagentRunGroup): string {
  if (group === "active") return "进行中";
  if (group === "completed") return "已完成";
  return "未完成";
}

function runSummary(run: SubagentRunSnapshot): string {
  if (run.state === "failed" && run.error_message) return run.error_message;
  if (run.state === "completed" && run.final_report) return run.final_report;
  return run.task;
}

function invocationStateLabel(state: SubagentInvocationPanelDetails["state"]): string {
  if (state === "failed") return "启动失败";
  if (state === "completed") return "已结束";
  return "正在创建 Sub-Agent";
}

function relativeAge(value: string): string {
  const created = Date.parse(value);
  if (!Number.isFinite(created)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - created) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}
