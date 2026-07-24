import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

import { AppDialog } from "@/renderer/components/dialog/AppDialog";
import { DialogButton } from "@/renderer/components/dialog/DialogButton";
import type {
  CheckpointMigrationStatus,
  RuntimeBridge,
} from "@/runtime";

import { useRuntimeConnection } from "./RuntimeConnectionProvider";
import styles from "./MandatoryCheckpointMigrationGate.module.css";

const POLL_INTERVAL_MS = 750;

export interface MandatoryCheckpointMigrationGateProps
  extends PropsWithChildren {
  runtime: RuntimeBridge;
}

export function MandatoryCheckpointMigrationGate({
  children,
  runtime,
}: MandatoryCheckpointMigrationGateProps) {
  const { ready } = useRuntimeConnection();
  const [status, setStatus] = useState<CheckpointMigrationStatus | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!ready) {
      return;
    }
    try {
      const next = await runtime.checkpointMigration.status();
      if (mountedRef.current) {
        setStatus(next);
      }
    } catch {
      // RuntimeConnectionProvider owns connection errors. If migration was
      // already discovered, retain the blocking snapshot until polling recovers.
    }
  }, [ready, runtime]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) {
      setStatus(null);
      return;
    }
    void refresh();
  }, [ready, refresh]);

  const blocking = Boolean(
    status &&
      (status.state === "required" ||
        status.state === "running" ||
        status.state === "failed" ||
        status.state === "completed"),
  );

  useEffect(() => {
    if (!ready || !blocking) {
      return;
    }
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [blocking, ready, refresh]);

  const runAction = useCallback(
    async (
      action: "start" | "retry" | "acknowledge",
    ) => {
      if (actionPending) {
        return;
      }
      setActionPending(true);
      try {
        const next = await runtime.checkpointMigration[action]();
        if (mountedRef.current) {
          setStatus(next);
        }
      } catch {
        // Keep the gate closed. Polling is the recovery path and the backend
        // remains the source of truth for retry/acknowledgement capability.
      } finally {
        if (mountedRef.current) {
          setActionPending(false);
        }
      }
    },
    [actionPending, runtime],
  );

  return (
    <>
      {children}
      {blocking && status ? (
        <MandatoryCheckpointMigrationDialog
          actionPending={actionPending}
          status={status}
          onStart={() => void runAction("start")}
          onRetry={() => void runAction("retry")}
          onAcknowledge={() => void runAction("acknowledge")}
        />
      ) : null}
    </>
  );
}

export interface MandatoryCheckpointMigrationDialogProps {
  status: CheckpointMigrationStatus;
  actionPending: boolean;
  onStart: () => void;
  onRetry: () => void;
  onAcknowledge: () => void;
}

export function MandatoryCheckpointMigrationDialog({
  status,
  actionPending,
  onStart,
  onRetry,
  onAcknowledge,
}: MandatoryCheckpointMigrationDialogProps) {
  const percent = Math.max(0, Math.min(100, Math.trunc(status.percent)));
  const completed = status.state === "completed";
  const failed = status.state === "failed";
  const required = status.state === "required";
  const title = completed
    ? "会话数据迁移完成"
    : failed
      ? "会话数据迁移未完成"
      : required
        ? "需要迁移会话数据"
        : "正在迁移会话数据";
  const description = required
    ? "Keydex 将切换到新的会话存储策略，以显著降低长期使用产生的本地存储占用。"
    : "为继续使用 Keydex，需要先完成一次会话数据迁移。";

  return (
    <AppDialog
      ariaLabel={title}
      backdrop="plain"
      closeOnEscape={false}
      closeOnOverlayClick={false}
      description={description}
      modal
      showClose={false}
      size="confirm"
      title={title}
      footer={
        completed && status.can_acknowledge ? (
          <DialogButton
            autoFocus
            disabled={actionPending}
            onClick={onAcknowledge}
            tone="primary"
            type="button"
          >
            进入 Keydex
          </DialogButton>
        ) : failed && status.can_retry ? (
          <DialogButton
            autoFocus
            disabled={actionPending}
            onClick={onRetry}
            tone="primary"
            type="button"
          >
            重试
          </DialogButton>
        ) : required && status.can_start ? (
          <DialogButton
            autoFocus
            disabled={actionPending}
            onClick={onStart}
            tone="primary"
            type="button"
          >
            开始迁移
          </DialogButton>
        ) : undefined
      }
    >
      <div className={styles.content}>
        <div
          aria-label={`迁移进度 ${percent}%`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent}
          className={styles.progressTrack}
          role="progressbar"
        >
          <span
            className={styles.progressValue}
            style={{ width: `${percent}%` }}
          />
        </div>
        <strong className={styles.percent}>{percent}%</strong>
        {failed ? (
          <p className={styles.message}>
            {status.error?.message ?? "会话数据迁移未完成，请重试"}
          </p>
        ) : completed ? (
          <p className={styles.message}>迁移已完成，可以进入 Keydex。</p>
        ) : required ? (
          <div className={styles.requiredMessage}>
            <p>迁移会保留历史会话和消息，完成后仍可继续对话。</p>
            <p>
              出于兼容性策略，迁移前已有的历史消息将无法回溯，也无法从这些历史位置创建分支。
            </p>
            <p>
              迁移完成后新产生的消息（包括在历史会话中继续对话产生的消息）以及新建会话不受影响，回溯和分支功能可正常使用。
            </p>
            <p>迁移期间 Keydex 将暂时不可使用。</p>
          </div>
        ) : (
          <p className={styles.message}>请保持 Keydex 打开。</p>
        )}
      </div>
    </AppDialog>
  );
}
