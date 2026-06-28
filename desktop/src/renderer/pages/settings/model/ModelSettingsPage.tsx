import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";

import { runtimeBridge, type ModelProvider, type RuntimeBridge } from "@/runtime";
import { useNotifications } from "@/renderer/providers/NotificationProvider";

import styles from "./ModelSettingsPage.module.css";
import { ModelList } from "./ModelList";
import { ProviderModal, type ProviderModalMode } from "./ProviderModal";

export interface ModelSettingsPageProps {
  runtime?: RuntimeBridge;
  onCreateProvider?: () => void;
}

export function ModelSettingsPage({
  runtime = runtimeBridge,
  onCreateProvider,
}: ModelSettingsPageProps) {
  const notifications = useNotifications();
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ mode: ProviderModalMode; provider?: ModelProvider } | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void runtime.models
      .listProviders()
      .then((items) => {
        if (active) {
          setProviders(items);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          const message = errorMessage(reason);
          setError(message);
          setProviders([]);
          notifications.error(message);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [notifications, runtime]);

  return (
    <main className={styles.page} data-testid="model-settings-page">
      <header className={styles.header}>
        <div>
          <h1>供应商配置</h1>
          <p>配置本地智能体可调用的 OpenAI 兼容模型服务</p>
        </div>
        <button className={styles.primaryButton} type="button" onClick={() => openCreate(onCreateProvider, setModal)}>
          <span>新增供应商</span>
        </button>
      </header>

      {loading ? <div className={styles.muted}>正在读取供应商</div> : null}
      {!loading && !error && !providers.length ? (
        <section className={styles.empty}>
          <span>暂无供应商</span>
          <button type="button" onClick={() => openCreate(onCreateProvider, setModal)}>新增供应商</button>
        </section>
      ) : null}

      {providers.length ? (
        <section className={styles.settingsGroup} aria-labelledby="model-provider-title">
          <div className={styles.groupHeader}>
            <h2 id="model-provider-title">模型供应商</h2>
            <span>{providers.length} 个来源</span>
          </div>
          <div className={styles.providerList} aria-label="供应商列表">
            {providers.map((provider) => (
              <ProviderCard
                onEdit={(item) => setModal({ mode: "edit", provider: item })}
                onProviderChange={(item) => setProviders((items) => upsertProvider(items, item))}
                provider={provider}
                key={provider.id}
                runtime={runtime}
              />
            ))}
          </div>
        </section>
      ) : null}

      {modal ? (
        <ProviderModal
          mode={modal.mode}
          onClose={() => setModal(null)}
          onDeleted={(providerId) => {
            setProviders((items) => items.filter((item) => item.id !== providerId));
            setModal(null);
          }}
          onSaved={(provider) => {
            setProviders((items) => upsertProvider(items, provider));
            setModal(null);
          }}
          provider={modal.provider}
          runtime={runtime}
        />
      ) : null}
    </main>
  );
}

function ProviderCard({
  onEdit,
  onProviderChange,
  provider,
  runtime,
}: {
  onEdit: (provider: ModelProvider) => void;
  onProviderChange: (provider: ModelProvider) => void;
  provider: ModelProvider;
  runtime: RuntimeBridge;
}) {
  const notifications = useNotifications();
  const [expanded, setExpanded] = useState(false);
  const [updatingEnabled, setUpdatingEnabled] = useState(false);
  const enabledModels = provider.models.filter((model) => provider.model_enabled[model] !== false);

  async function toggleProviderEnabled() {
    if (updatingEnabled) {
      return;
    }
    setUpdatingEnabled(true);
    try {
      const updated = await runtime.models.updateProvider(provider.id, { enabled: !provider.enabled });
      onProviderChange(updated);
    } catch (reason) {
      notifications.error(errorMessage(reason));
    } finally {
      setUpdatingEnabled(false);
    }
  }

  return (
    <article className={styles.card} data-testid="provider-card">
      <div className={styles.providerRow}>
        <button
          aria-expanded={expanded}
          className={styles.cardHeader}
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <span className={styles.chevron} data-expanded={expanded ? "true" : "false"}>
            <ChevronDown size={15} />
          </span>
          <span className={styles.titleGroup}>
            <strong>{provider.name}</strong>
            <span>{provider.base_url}</span>
          </span>
          <span className={styles.metrics}>
            <span>{provider.models.length} 个模型</span>
            <span>{enabledModels.length} 个启用</span>
          </span>
        </button>
        <button
          aria-checked={provider.enabled}
          aria-label={`${provider.name} 启用状态`}
          className={styles.providerSwitch}
          data-updating={updatingEnabled ? "true" : "false"}
          disabled={updatingEnabled}
          onClick={() => void toggleProviderEnabled()}
          role="switch"
          type="button"
        >
          <span className={styles.switchTrack} data-checked={provider.enabled ? "true" : "false"}>
            <span />
          </span>
        </button>
        <div className={styles.rowActions} aria-label={`${provider.name} 操作`}>
          <button aria-label={`编辑 ${provider.name}`} type="button" onClick={() => onEdit(provider)}>
            编辑
          </button>
          <button aria-label={`删除 ${provider.name}`} type="button" onClick={() => onEdit(provider)}>
            删除
          </button>
        </div>
      </div>

      {expanded ? (
        <div className={styles.cardBody}>
          <dl className={styles.metaGrid}>
            <div>
              <dt>密钥</dt>
              <dd>{provider.api_key_set ? (provider.api_key_preview ?? "已保存") : "未保存"}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>{provider.enabled ? "供应商可用" : "供应商已停用"}</dd>
            </div>
          </dl>

          <ModelList onProviderChange={onProviderChange} provider={provider} runtime={runtime} />
        </div>
      ) : null}
    </article>
  );
}

function openCreate(
  onCreateProvider: (() => void) | undefined,
  setModal: (value: { mode: ProviderModalMode } | null) => void,
) {
  if (onCreateProvider) {
    onCreateProvider();
    return;
  }
  setModal({ mode: "create" });
}

function upsertProvider(items: ModelProvider[], provider: ModelProvider): ModelProvider[] {
  const existing = items.findIndex((item) => item.id === provider.id);
  if (existing === -1) {
    return [provider, ...items];
  }
  return items.map((item) => (item.id === provider.id ? provider : item));
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "读取供应商失败";
}
