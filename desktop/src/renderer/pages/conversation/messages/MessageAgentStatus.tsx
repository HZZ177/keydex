import { CircleStop, LoaderCircle, ShieldQuestion, TriangleAlert } from "lucide-react";

import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";

import styles from "./MessageAgentStatus.module.css";

export interface MessageAgentStatusProps {
  state: ConversationRuntimeState;
  detail?: string | null;
}

export function AgentLoadingIcon({ size = 15, className = "" }: { size?: number; className?: string }) {
  return (
    <LoaderCircle
      aria-hidden="true"
      className={className ? `${styles.loadingIcon} ${className}` : styles.loadingIcon}
      size={size}
    />
  );
}

export function MessageAgentStatus({ state, detail }: MessageAgentStatusProps) {
  if (state === "idle") {
    return null;
  }

  const view = statusView(state, detail);
  return (
    <div className={styles.status} data-state={state} data-testid="message-agent-status" role="status">
      <span className={styles.icon} aria-hidden="true">
        {view.icon}
      </span>
      <span className={styles.text}>{view.text}</span>
      {view.detail ? <span className={styles.detail}>{view.detail}</span> : null}
    </div>
  );
}

function statusView(state: ConversationRuntimeState, detail?: string | null) {
  switch (state) {
    case "starting":
      return {
        icon: <AgentLoadingIcon size={15} />,
        text: "正在连接智能体",
        detail: detail ?? "准备发起这轮对话",
      };
    case "running":
      return {
        icon: <AgentLoadingIcon size={15} />,
        text: "智能体正在处理",
        detail: detail ?? "可能正在思考、读取上下文或执行工具",
      };
    case "waiting_approval":
      return {
        icon: <ShieldQuestion size={15} />,
        text: "等待权限确认",
        detail: detail ?? "需要你允许或拒绝后才能继续",
      };
    case "cancelling":
      return {
        icon: <CircleStop size={15} />,
        text: "正在停止",
        detail: detail ?? "正在中断当前轮次",
      };
    case "failed":
      return {
        icon: <TriangleAlert size={15} />,
        text: "运行失败",
        detail: detail ?? "请查看上方错误消息",
      };
    case "idle":
      return {
        icon: null,
        text: "",
        detail: null,
      };
  }
}
