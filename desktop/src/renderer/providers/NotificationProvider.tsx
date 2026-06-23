import { CheckCircle2, Info, TriangleAlert, X, XCircle } from "lucide-react";
import {
  createContext,
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import styles from "./NotificationProvider.module.css";

export type NotificationType = "success" | "error" | "warning" | "info";

export interface NotificationInput {
  type?: NotificationType;
  title?: string;
  message: string;
  durationMs?: number;
}

export interface NotificationContextValue {
  notify(input: NotificationInput): string;
  dismiss(id: string): void;
  success(message: string, options?: NotificationOptions): string;
  error(message: string, options?: NotificationOptions): string;
  warning(message: string, options?: NotificationOptions): string;
  info(message: string, options?: NotificationOptions): string;
}

type NotificationOptions = Omit<NotificationInput, "message" | "type">;

interface NotificationItem extends Required<Pick<NotificationInput, "type" | "message" | "durationMs">> {
  id: string;
  title?: string;
  exiting?: boolean;
}

const DEFAULT_DURATION_MS = 3000;
const EXIT_DURATION_MS = 180;

const MAX_VISIBLE_NOTIFICATIONS = 3;

let notificationSeq = 0;

const noopContext: NotificationContextValue = {
  notify() {
    return "";
  },
  dismiss() {
    return undefined;
  },
  success() {
    return "";
  },
  error() {
    return "";
  },
  warning() {
    return "";
  },
  info() {
    return "";
  },
};

const NotificationContext = createContext<NotificationContextValue>(noopContext);

export function NotificationProvider({ children }: PropsWithChildren) {
  const [items, setItems] = useState<NotificationItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((current) =>
      current.map((item) => (item.id === id && !item.exiting ? { ...item, exiting: true } : item)),
    );
  }, []);

  const remove = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback((input: NotificationInput) => {
    const type = input.type ?? "info";
    const id = `notification:${Date.now()}:${notificationSeq++}`;
    const item: NotificationItem = {
      id,
      type,
      title: input.title,
      message: input.message,
      durationMs: input.durationMs ?? DEFAULT_DURATION_MS,
    };
    setItems((current) => [...current, item].slice(-MAX_VISIBLE_NOTIFICATIONS));
    return id;
  }, []);

  const value = useMemo<NotificationContextValue>(
    () => ({
      notify,
      dismiss,
      success(message, options) {
        return notify({ ...options, type: "success", message });
      },
      error(message, options) {
        return notify({ ...options, type: "error", message });
      },
      warning(message, options) {
        return notify({ ...options, type: "warning", message });
      },
      info(message, options) {
        return notify({ ...options, type: "info", message });
      },
    }),
    [dismiss, notify],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <div className={styles.viewport} data-testid="notification-viewport">
        {items.map((item) => (
          <NotificationToast item={item} onDismiss={dismiss} onExited={remove} key={item.id} />
        ))}
      </div>
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  return useContext(NotificationContext);
}

function NotificationToast({
  item,
  onDismiss,
  onExited,
}: {
  item: NotificationItem;
  onDismiss: (id: string) => void;
  onExited: (id: string) => void;
}) {
  const timerRef = useRef<number | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const remainingMsRef = useRef(item.durationMs);

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) {
      return;
    }
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const clearExitTimer = useCallback(() => {
    if (exitTimerRef.current === null) {
      return;
    }
    window.clearTimeout(exitTimerRef.current);
    exitTimerRef.current = null;
  }, []);

  const dismissCurrent = useCallback(() => {
    clearTimer();
    onDismiss(item.id);
  }, [clearTimer, item.id, onDismiss]);

  const startTimer = useCallback(() => {
    clearTimer();
    if (item.exiting || item.durationMs <= 0) {
      return;
    }
    if (remainingMsRef.current <= 0) {
      dismissCurrent();
      return;
    }
    startedAtRef.current = Date.now();
    timerRef.current = window.setTimeout(dismissCurrent, remainingMsRef.current);
  }, [clearTimer, dismissCurrent, item.durationMs, item.exiting]);

  const pauseTimer = useCallback(() => {
    if (item.exiting || item.durationMs <= 0 || timerRef.current === null) {
      return;
    }
    const elapsed = Date.now() - startedAtRef.current;
    remainingMsRef.current = Math.max(0, remainingMsRef.current - elapsed);
    clearTimer();
  }, [clearTimer, item.durationMs, item.exiting]);

  useEffect(() => {
    if (item.exiting) {
      clearTimer();
      return undefined;
    }
    remainingMsRef.current = item.durationMs;
    startTimer();
    return clearTimer;
  }, [clearTimer, item.durationMs, item.exiting, startTimer]);

  useEffect(() => {
    if (!item.exiting) {
      return clearExitTimer;
    }
    clearTimer();
    clearExitTimer();
    exitTimerRef.current = window.setTimeout(() => onExited(item.id), EXIT_DURATION_MS);
    return clearExitTimer;
  }, [clearExitTimer, clearTimer, item.exiting, item.id, onExited]);

  return (
    <section
      className={styles.toast}
      data-exiting={item.exiting ? "true" : "false"}
      data-testid="notification-item"
      data-type={item.type}
      role={item.type === "error" ? "alert" : "status"}
      onBlur={startTimer}
      onFocus={pauseTimer}
      onMouseEnter={pauseTimer}
      onMouseLeave={startTimer}
    >
      <span className={styles.icon} aria-hidden="true">
        {notificationIcon(item.type)}
      </span>
      <span className={styles.content}>
        {item.title ? <span className={styles.title}>{item.title}</span> : null}
        <span className={styles.message}>{item.message}</span>
      </span>
      <button
        className={styles.closeButton}
        type="button"
        aria-label="关闭通知"
        onClick={() => onDismiss(item.id)}
      >
        <X size={13} strokeWidth={2} />
      </button>
    </section>
  );
}

function notificationIcon(type: NotificationType): ReactNode {
  switch (type) {
    case "success":
      return <CheckCircle2 size={16} strokeWidth={2} />;
    case "warning":
      return <TriangleAlert size={16} strokeWidth={2} />;
    case "error":
      return <XCircle size={16} strokeWidth={2} />;
    case "info":
      return <Info size={16} strokeWidth={2} />;
  }
}
