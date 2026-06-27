import { Check, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";

import type { ModelProvider, RuntimeBridge } from "@/runtime";

import { HealthCheckButton } from "./HealthCheckButton";
import styles from "./ModelList.module.css";

export interface ModelListProps {
  provider: ModelProvider;
  runtime: RuntimeBridge;
  onProviderChange: (provider: ModelProvider) => void;
}

export function ModelList({ provider, runtime, onProviderChange }: ModelListProps) {
  const [query, setQuery] = useState("");
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visibleModels = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return provider.models;
    }
    return provider.models.filter((model) => model.toLowerCase().includes(keyword));
  }, [provider.models, query]);

  async function refreshModels() {
    setError(null);
    setRefreshing(true);
    try {
      const updated = await runtime.models.refreshProviderModels(provider.id);
      onProviderChange(updated);
    } catch (reason) {
      setError(errorMessage(reason, "刷新模型失败"));
    } finally {
      setRefreshing(false);
    }
  }

  async function toggleModel(model: string) {
    const currentlyEnabled = provider.model_enabled[model] !== false;
    if (currentlyEnabled && provider.default_model === model) {
      setError("默认模型不能停用，请先切换默认模型");
      return;
    }
    setError(null);
    setBusyModel(model);
    try {
      const updated = await runtime.models.updateProvider(provider.id, {
        model_enabled: { ...provider.model_enabled, [model]: !currentlyEnabled },
      });
      onProviderChange(updated);
    } catch (reason) {
      setError(errorMessage(reason, "更新模型启用状态失败"));
    } finally {
      setBusyModel(null);
    }
  }

  async function setDefault(model: string) {
    if (provider.model_enabled[model] === false) {
      setError("默认模型必须来自已启用模型");
      return;
    }
    setError(null);
    setBusyModel(model);
    try {
      const updated = await runtime.models.setDefaultModel(provider.id, model);
      onProviderChange(updated);
    } catch (reason) {
      setError(errorMessage(reason, "设置默认模型失败"));
    } finally {
      setBusyModel(null);
    }
  }

  return (
    <section className={styles.root} aria-label={`${provider.name} 模型管理`}>
      <div className={styles.toolbar}>
        <label className={styles.search}>
          <Search size={14} />
          <input
            aria-label={`${provider.name} 搜索模型`}
            disabled={!provider.models.length}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索模型"
            value={query}
          />
        </label>
        <button disabled={refreshing} onClick={() => void refreshModels()} type="button">
          <RefreshCw className={refreshing ? styles.spinning : undefined} size={14} />
          <span>{refreshing ? "刷新中" : "刷新模型"}</span>
        </button>
      </div>

      {error ? <div className={styles.error} role="alert">{error}</div> : null}

      {!provider.models.length ? (
        <p className={styles.empty}>尚未刷新模型列表</p>
      ) : (
        <div className={styles.rows} aria-label={`${provider.name} 模型列表`}>
          <div className={styles.rowsHeader} aria-hidden="true">
            <span />
            <span>模型</span>
            <span>健康</span>
            <span>默认</span>
          </div>
          {visibleModels.map((model) => {
            const enabled = provider.model_enabled[model] !== false;
            const isDefault = provider.default_model === model;
            const busy = busyModel === model;
            return (
              <div className={styles.row} data-disabled={enabled ? "false" : "true"} key={model}>
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
                <span className={styles.modelName}>{model}</span>
                <span className={styles.healthCell}>
                  <HealthCheckButton
                    health={provider.health[model]}
                    model={model}
                    onProviderChange={onProviderChange}
                    providerId={provider.id}
                    runtime={runtime}
                  />
                </span>
                {isDefault ? (
                  <span className={styles.defaultBadge}>
                    <Check size={13} />
                    默认
                  </span>
                ) : (
                  <button
                    aria-label={`设为默认 ${model}`}
                    className={styles.defaultButton}
                    disabled={!enabled || busy}
                    onClick={() => void setDefault(model)}
                    type="button"
                  >
                    设为默认
                  </button>
                )}
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
