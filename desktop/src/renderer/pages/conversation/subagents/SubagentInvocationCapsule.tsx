import { useOptionalRightSidebarConversation } from "@/renderer/components/layout/RightSidebarConversationContext";
import { useOptionalAgentSessionRuntime } from "@/renderer/providers/AgentSessionProvider";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import styles from "./SubagentRunCapsule.module.css";
import { SubagentRoleIcon, subagentRoleLabel } from "./SubagentRoleIcon";

type InvocationRole = "explorer" | "worker";
type InvocationState = "queued" | "running" | "completed" | "failed";

interface InvocationViewModel {
  invocationId: string;
  role: InvocationRole;
  state: InvocationState;
  task: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export function SubagentInvocationCapsule({ message }: { message: ConversationMessage }) {
  const sidebar = useOptionalRightSidebarConversation();
  const agentRuntime = useOptionalAgentSessionRuntime();
  const model = invocationViewModel(message, (subagentId) => {
    if (!subagentId || !agentRuntime) return null;
    return Object.values(agentRuntime.subagentState.runsById)
      .find((run) => run.subagent_id === subagentId)?.role ?? null;
  });
  const stateLabel =
    model.state === "failed"
      ? "启动失败"
      : model.state === "completed"
        ? "已结束"
        : model.state === "running"
          ? "正在工作"
          : "正在启动";

  return (
    <span
      className={styles.capsuleRow}
      data-state={model.state}
    >
      <button
        type="button"
        className={styles.capsule}
        data-state={model.state}
        data-testid="subagent-invocation-capsule"
        aria-label={`${subagentRoleLabel(model.role)}，${stateLabel}，任务：${model.task}，打开详情`}
        title={`${stateLabel}：${model.task}`}
        onClick={() => sidebar?.openSubagentInvocationPanel({
          invocationId: model.invocationId,
          parentSessionId: message.threadId,
          role: model.role,
          task: model.task,
          state: model.state,
          errorCode: model.errorCode,
          errorMessage: model.errorMessage,
        })}
        disabled={!sidebar}
      >
        <span className={styles.roleIcon} data-role={model.role} aria-hidden="true">
          <SubagentRoleIcon role={model.role} size={17} />
        </span>
        <span className={styles.role}>{subagentRoleLabel(model.role)}</span>
      </button>
      <span className={styles.runState} role="status" aria-live="polite">
        {stateLabel}
      </span>
    </span>
  );
}

function invocationViewModel(
  message: ConversationMessage,
  resolveExistingRole: (subagentId: string) => InvocationRole | null,
): InvocationViewModel {
  const call = record(message.payload.call);
  const args =
    record(call?.arguments) ??
    parseRecord(text(call?.arguments)) ??
    record(call?.args) ??
    record(message.payload.arguments) ??
    {};
  const result = record(message.payload.result);
  const resultPayload = parseRecord(text(result?.model_content)) ?? result;
  const nestedError = record(resultPayload?.error) ?? record(result?.error);
  const resultStatus = text(result?.status);
  const failed =
    message.status === "failed" ||
    resultStatus === "error" ||
    resultStatus === "failed" ||
    Boolean(nestedError);
  const queued = message.status === "pending";
  const running =
    message.status === "running" ||
    message.status === "in_progress" ||
    resultStatus === "running";
  const continuedRole = resolveExistingRole(text(args.subagent_id));
  const role = continuedRole ?? (text(args.type) === "explorer" ? "explorer" : "worker");
  const task = text(args.task) || "正在准备 Sub-Agent 任务";
  const errorMessage =
    text(nestedError?.message) ||
    text(result?.error) ||
    (failed ? "Sub-Agent 会话未能启动" : "");
  return {
    invocationId: text(call?.id) || message.itemId || message.id,
    role,
    state: failed ? "failed" : running ? "running" : queued ? "queued" : "completed",
    task,
    errorCode: text(nestedError?.code) || null,
    errorMessage: errorMessage || null,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRecord(value: string): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
