import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalStatus,
  PermissionMode,
  ThreadItemStatus,
  ThreadStatus,
  TurnStatus,
} from "@/types/protocol";

const itemStatusLabels: Record<ThreadItemStatus, string> = {
  pending: "等待中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const turnStatusLabels: Record<TurnStatus, string> = {
  queued: "排队中",
  in_progress: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const threadStatusLabels: Record<ThreadStatus, string> = {
  idle: "空闲",
  running: "执行中",
  waiting_approval: "等待审批",
  failed: "失败",
};

const permissionLabels: Record<PermissionMode, string> = {
  read_only: "只读",
  workspace_write: "工作区可写",
  full_access: "完全访问",
};

const approvalKindLabels: Record<ApprovalKind, string> = {
  exec: "执行命令",
  file_change: "修改文件",
  read_external: "读取工作区外文件",
  write_external: "写入工作区外文件",
};

const approvalStatusLabels: Record<ApprovalStatus, string> = {
  pending: "待审批",
  approved: "已批准",
  rejected: "已拒绝",
  expired: "已过期",
  cancelled: "已取消",
};

const approvalDecisionLabels: Record<ApprovalDecision, string> = {
  approved: "批准",
  rejected: "拒绝",
};

export function formatItemStatus(status: ThreadItemStatus): string {
  return itemStatusLabels[status] ?? status;
}

export function formatTurnStatus(status: TurnStatus): string {
  return turnStatusLabels[status] ?? status;
}

export function formatThreadStatus(status: ThreadStatus): string {
  return threadStatusLabels[status] ?? status;
}

export function formatPermissionMode(mode: PermissionMode): string {
  return permissionLabels[mode] ?? mode;
}

export function formatApprovalKind(kind: ApprovalKind): string {
  return approvalKindLabels[kind] ?? kind;
}

export function formatApprovalStatus(status: ApprovalStatus): string {
  return approvalStatusLabels[status] ?? status;
}

export function formatApprovalDecision(decision: ApprovalDecision): string {
  return approvalDecisionLabels[decision] ?? decision;
}
