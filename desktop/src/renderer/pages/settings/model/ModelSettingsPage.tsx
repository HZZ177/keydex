import { ChevronDown, Plus, Settings2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { runtimeBridge, type ModelProvider, type RuntimeBridge } from "@/runtime";

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
          setError(errorMessage(reason));
          setProviders([]);
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
  }, [runtime]);

  return (
    <main className={styles.page} data-testid="model-settings-page">
      <header className={styles.header}>
        <div>
          <h1>供应商</h1>
          <p>配置本地智能体可调用的 OpenAI 兼容模型服务</p>
        </div>
        <button className={styles.primaryButton} type="button" onClick={() => openCreate(onCreateProvider, setModal)}>
          <Plus size={15} />
          <span>新增供应商</span>
        </button>
      </header>

      {loading ? <div className={styles.muted}>正在读取供应商</div> : null}
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      {!loading && !error && !providers.length ? (
        <section className={styles.empty}>
          <Settings2 size={18} />
          <span>暂无供应商</span>
          <button type="button" onClick={() => openCreate(onCreateProvider, setModal)}>新增供应商</button>
        </section>
      ) : null}

      <section className={styles.providerList} aria-label="供应商列表">
        {providers.map((provider) => (
          <ProviderCard
            onEdit={(item) => setModal({ mode: "edit", provider: item })}
            onProviderChange={(item) => setProviders((items) => upsertProvider(items, item))}
            provider={provider}
            key={provider.id}
            runtime={runtime}
          />
        ))}
      </section>

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
  const [expanded, setExpanded] = useState(true);
  const enabledModels = provider.models.filter((model) => provider.model_enabled[model] !== false);

  return (
    <article className={styles.card} data-testid="provider-card">
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
        <span className={styles.switchTrack} aria-label={`${provider.name} 启用状态`} data-checked={provider.enabled ? "true" : "false"}>
          <span />
        </span>
      </button>

      {expanded ? (
        <div className={styles.cardBody}>
          <div className={styles.metaGrid}>
            <span>{provider.api_key_set ? `密钥 ${provider.api_key_preview ?? "已保存"}` : "未保存密钥"}</span>
            <span>{provider.default_model ? `默认 ${provider.default_model}` : "未设置默认模型"}</span>
            <span>{provider.enabled ? "供应商可用" : "供应商已停用"}</span>
          </div>

          <ModelList onProviderChange={onProviderChange} provider={provider} runtime={runtime} />

          <footer className={styles.actions}>
            <button type="button" onClick={() => onEdit(provider)}>
              <Settings2 size={14} />
              <span>编辑</span>
            </button>
            <button type="button" onClick={() => onEdit(provider)}>
              <Trash2 size={14} />
              <span>删除</span>
            </button>
          </footer>
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
