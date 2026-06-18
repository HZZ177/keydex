import { Activity, AlertCircle, CheckCircle2 } from "lucide-react";
import { useMemo, useState } from "react";

import type { ModelHealth, ModelProvider, RuntimeBridge } from "@/runtime";

import styles from "./HealthCheckButton.module.css";

export interface HealthCheckButtonProps {
  health?: ModelHealth;
  model: string;
  providerId: string;
  runtime: RuntimeBridge;
  onProviderChange: (provider: ModelProvider) => void;
}

export function HealthCheckButton({
  health,
  model,
  providerId,
  runtime,
  onProviderChange,
}: HealthCheckButtonProps) {
  const [checking, setChecking] = useState(false);
  const [localHealth, setLocalHealth] = useState<ModelHealth | undefined>(health);
  const [error, setError] = useState<string | null>(null);
  const displayed = localHealth ?? health;
  const label = useMemo(() => healthLabel(displayed), [displayed]);

  async function checkHealth() {
    setChecking(true);
    setError(null);
    try {
      const response = await runtime.models.checkModelHealth(providerId, model);
      setLocalHealth(response.health);
      onProviderChange(response.provider);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className={styles.root}>
      <button
        aria-label={`检查 ${model} 健康状态`}
        className={styles.button}
        data-status={displayed?.status ?? "unknown"}
        disabled={checking}
        onClick={() => void checkHealth()}
        title={displayed?.checked_at ? `上次检查 ${formatCheckedAt(displayed.checked_at)}` : undefined}
        type="button"
      >
        {statusIcon(displayed?.status, checking)}
        <span>{checking ? "检查中" : label}</span>
      </button>
      {displayed?.status === "unhealthy" && displayed.error ? (
        <span className={styles.healthError}>{displayed.error}</span>
      ) : null}
      {error ? <span className={styles.healthError} role="alert">{error}</span> : null}
    </div>
  );
}

function statusIcon(status: ModelHealth["status"] | undefined, checking: boolean) {
  if (checking) {
    return <Activity className={styles.spinning} size={13} />;
  }
  if (status === "healthy") {
    return <CheckCircle2 size={13} />;
  }
  if (status === "unhealthy") {
    return <AlertCircle size={13} />;
  }
  return <Activity size={13} />;
}

function healthLabel(health?: ModelHealth): string {
  if (!health) {
    return "检查";
  }
  const latency = Number.isFinite(health.latency_ms) ? ` ${health.latency_ms}ms` : "";
  return health.status === "healthy" ? `健康${latency}` : `异常${latency}`;
}

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "模型健康检查失败";
}
