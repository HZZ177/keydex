import { LoaderCircle } from "lucide-react";
import { useMemo, useState } from "react";

import type { ModelProvider, RuntimeBridge } from "@/runtime";
import { useNotifications } from "@/renderer/providers/NotificationProvider";

import { HealthCheckButton } from "./HealthCheckButton";
import styles from "./ModelList.module.css";

export interface ModelListProps {
  provider: ModelProvider;
  runtime: RuntimeBridge;
  onProviderChange: (provider: ModelProvider) => void;
}

export function ModelList({ provider, runtime, onProviderChange }: ModelListProps) {
  const notifications = useNotifications();
  const [query, setQuery] = useState("");
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const visibleModels = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return provider.models;
    }
    return provider.models.filter((model) => model.toLowerCase().includes(keyword));
  }, [provider.models, query]);

  async function refreshModels() {
    setRefreshing(true);
    try {
      const updated = await runtime.models.refreshProviderModels(provider.id);
      onProviderChange(updated);
    } catch (reason) {
      notifications.error(errorMessage(reason, "刷新模型失败"));
    } finally {
      setRefreshing(false);
    }
  }

  async function toggleModel(model: string) {
    const currentlyEnabled = provider.model_enabled[model] !== false;
    setBusyModel(model);
    try {
      const updated = await runtime.models.updateProvider(provider.id, {
        model_enabled: { ...provider.model_enabled, [model]: !currentlyEnabled },
      });
      onProviderChange(updated);
    } catch (reason) {
      notifications.error(errorMessage(reason, "更新模型启用状态失败"));
    } finally {
      setBusyModel(null);
    }
  }

  return (
    <section className={styles.root} aria-label={`${provider.name} 模型管理`}>
      <div className={styles.toolbar}>
        <label className={styles.search}>
          <input
            aria-label={`${provider.name} 搜索模型`}
            disabled={!provider.models.length}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索模型"
            value={query}
          />
        </label>
        <button disabled={refreshing} onClick={() => void refreshModels()} type="button">
          <span>{refreshing ? "刷新中" : "刷新模型"}</span>
        </button>
      </div>

      {refreshing ? (
        <div className={styles.loading} role="status" aria-label="正在刷新模型列表">
          <LoaderCircle size={14} aria-hidden="true" />
          <span>正在刷新模型列表</span>
        </div>
      ) : !provider.models.length ? (
        <p className={styles.empty}>尚未刷新模型列表</p>
      ) : (
        <div className={styles.rows} aria-label={`${provider.name} 模型列表`}>
          {visibleModels.map((model) => {
            const enabled = provider.model_enabled[model] !== false;
            const busy = busyModel === model;
            return (
              <div className={styles.row} data-disabled={enabled ? "false" : "true"} key={model}>
                <span className={styles.modelName}>{model}</span>
                <button
                  aria-label={enabled ? `停用 ${model}` : `启用 ${model}`}
                  aria-pressed={enabled}
                  className={styles.switchButton}
                  disabled={busy}
                  onClick={() => void toggleModel(model)}
                  type="button"
                >
                  <span />
                </button>
                <span className={styles.healthCell}>
                  <HealthCheckButton
                    health={provider.health[model]}
                    model={model}
                    onProviderChange={onProviderChange}
                    providerId={provider.id}
                    runtime={runtime}
                  />
                </span>
              </div>
            );
          })}
          {!visibleModels.length ? <p className={styles.empty}>没有匹配的模型</p> : null}
        </div>
      )}
    </section>
  );
}

function errorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return fallback;
}
