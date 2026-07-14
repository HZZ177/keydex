import { LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import type { PropsWithChildren } from "react";

import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";

import styles from "./SettingsRuntimeGate.module.css";

export function SettingsRuntimeGate({ children }: PropsWithChildren) {
  const runtimeConnection = useOptionalRuntimeConnection();

  if (!runtimeConnection || runtimeConnection.ready) {
    return children;
  }

  const failed = runtimeConnection.status === "error";
  return (
    <div
      className={styles.gate}
      data-state={failed ? "error" : "pending"}
      data-testid="settings-runtime-gate"
      role="status"
      aria-live="polite"
    >
      <div className={styles.icon} aria-hidden="true">
        {failed ? <TriangleAlert size={18} strokeWidth={1.9} /> : <LoaderCircle size={18} strokeWidth={1.9} />}
      </div>
      <div className={styles.copy}>
        <strong>{failed ? "本地服务连接失败" : "本地服务正在启动"}</strong>
        <span>{failed ? runtimeConnection.error?.message ?? "请重试连接" : "设置将在服务就绪后自动载入"}</span>
      </div>
      {failed ? (
        <button className={styles.retry} type="button" onClick={runtimeConnection.retry}>
          <RefreshCw size={14} strokeWidth={2} />
          <span>重试</span>
        </button>
      ) : null}
    </div>
  );
}
