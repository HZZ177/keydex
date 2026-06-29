import { useEffect, useState } from "react";

import { runtimeBridge, type ModelProvider, type RuntimeBridge } from "@/runtime";
import { SearchableModelDropdown, type SearchableModelDropdownOption } from "@/renderer/components/model";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import type { ModelDefaultScope, ModelDefaultsResponse } from "@/types/protocol";

import styles from "./ModelDefaultSettingsPage.module.css";

export interface ModelDefaultSettingsPageProps {
  runtime?: RuntimeBridge;
  onOpenProviderSettings?: () => void;
}

export function ModelDefaultSettingsPage({
  runtime = runtimeBridge,
  onOpenProviderSettings,
}: ModelDefaultSettingsPageProps) {
  const notifications = useNotifications();
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [draft, setDraft] = useState<DefaultDraft>(emptyDraft());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void Promise.all([runtime.models.listProviders(), runtime.settings.getModelDefaults()])
      .then(([items, nextDefaults]) => {
        if (active) {
          setProviders(items);
          setDraft(draftFromDefaults(nextDefaults));
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

  const enabledProviderCount = providers.filter((provider) => provider.enabled).length;
  const enabledModelCount = providers.reduce(
    (count, provider) =>
      count + provider.models.filter((model) => provider.model_enabled[model] !== false).length,
    0,
  );
  const modelOptions = modelOptionsFromProviders(providers);
  const canSave = Boolean(draft.default_chat.providerId && draft.default_chat.model) && !saving;

  const updateDraft = (scope: ModelDefaultScope, patch: Partial<DefaultDraftItem>) => {
    setDraft((current) => ({
      ...current,
      [scope]: { ...current[scope], ...patch },
    }));
  };

  const saveDefaults = async () => {
    if (!canSave) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const nextDefaults = await runtime.settings.saveModelDefaults({
        defaults: {
          default_chat: { provider_id: draft.default_chat.providerId, model: draft.default_chat.model },
          fast:
            draft.fast.providerId && draft.fast.model
              ? { provider_id: draft.fast.providerId, model: draft.fast.model }
              : null,
        },
      });
      setDraft(draftFromDefaults(nextDefaults));
      notifications.success("模型配置已保存");
    } catch (reason) {
      notifications.error(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className={styles.page} data-testid="model-default-settings-page">
      <header className={styles.header}>
        <div>
          <h1>模型配置</h1>
          <p>配置新会话默认模型，以及轻量辅助任务使用的快速模型</p>
        </div>
      </header>

      {loading ? <div className={styles.muted}>正在读取供应商</div> : null}

      {!loading && !error && providers.length === 0 ? (
        <section className={styles.empty}>
          <span>暂无供应商配置</span>
          <button type="button" onClick={onOpenProviderSettings}>
            配置供应商
          </button>
        </section>
      ) : null}

      {!loading && !error && providers.length > 0 ? (
        <section className={styles.settingsGroup} aria-labelledby="model-default-title">
          <div className={styles.groupHeader}>
            <h2 id="model-default-title">默认值</h2>
            <span>
              {enabledProviderCount} 个供应商 · {enabledModelCount} 个可用模型
            </span>
          </div>
          <div className={styles.defaultList}>
            <DefaultCard
              providerId={draft.default_chat.providerId}
              model={draft.default_chat.model}
              modelOptions={modelOptions}
              scope="default_chat"
              title="默认对话模型"
              description="新建 session 时默认选中，主要用于对话与主要任务"
              onOpenProviderSettings={onOpenProviderSettings}
              onModelChange={(scope, selection) =>
                updateDraft(scope, {
                  providerId: selection?.providerId ?? "",
                  model: selection?.model ?? "",
                })
              }
            />
            <DefaultCard
              providerId={draft.fast.providerId}
              model={draft.fast.model}
              modelOptions={modelOptions}
              scope="fast"
              title="快速模型"
              description="轻量辅助任务默认使用的模型"
              optional
              onOpenProviderSettings={onOpenProviderSettings}
              onModelChange={(scope, selection) =>
                updateDraft(scope, {
                  providerId: selection?.providerId ?? "",
                  model: selection?.model ?? "",
                })
              }
            />
          </div>
          <div className={styles.actions}>
            <button type="button" disabled={!canSave} onClick={() => void saveDefaults()}>
              {saving ? "保存中" : "保存"}
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function DefaultCard({
  description,
  model,
  onModelChange,
  optional = false,
  providerId,
  modelOptions,
  scope,
  title,
  onOpenProviderSettings,
}: {
  description: string;
  model: string;
  modelOptions: SearchableModelDropdownOption[];
  onModelChange: (scope: ModelDefaultScope, model: { providerId: string; model: string } | null) => void;
  onOpenProviderSettings?: () => void;
  optional?: boolean;
  providerId: string;
  scope: ModelDefaultScope;
  title: string;
}) {
  const selected = providerId && model ? { providerId, model } : null;

  return (
    <article className={styles.defaultCard}>
      <div className={styles.defaultText}>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className={styles.defaultControl}>
        <SearchableModelDropdown
          value={selected}
          options={modelOptions}
          clearable={optional && modelOptions.length > 0}
          clearLabel="不配置"
          placeholder={optional ? "不配置" : "选择模型"}
          menuLabel={title}
          searchPlaceholder="搜索供应商或模型"
          emptyActionLabel={!modelOptions.length && onOpenProviderSettings ? "供应商配置页面" : undefined}
          emptyActionSuffix={!modelOptions.length && onOpenProviderSettings ? "配置可用渠道" : undefined}
          emptyText={
            modelOptions.length
              ? "没有匹配模型"
              : onOpenProviderSettings
                ? "当前无可用模型，请先在"
                : "当前无可用模型，请先在供应商配置页面配置可用渠道"
          }
          onEmptyAction={!modelOptions.length ? onOpenProviderSettings : undefined}
          variant="field"
          onChange={(selection) => onModelChange(scope, selection)}
        />
      </div>
    </article>
  );
}

interface DefaultDraftItem {
  providerId: string;
  model: string;
}

type DefaultDraft = Record<ModelDefaultScope, DefaultDraftItem>;

function emptyDraft(): DefaultDraft {
  return {
    default_chat: { providerId: "", model: "" },
    fast: { providerId: "", model: "" },
  };
}

function draftFromDefaults(response: ModelDefaultsResponse): DefaultDraft {
  return {
    default_chat: {
      providerId: response.defaults.default_chat.provider_id ?? "",
      model: response.defaults.default_chat.model ?? "",
    },
    fast: {
      providerId: response.defaults.fast.provider_id ?? "",
      model: response.defaults.fast.model ?? "",
    },
  };
}

function enabledModels(provider: ModelProvider): string[] {
  return provider.models.filter((model) => provider.model_enabled[model] !== false);
}

function modelOptionsFromProviders(providers: ModelProvider[]): SearchableModelDropdownOption[] {
  return providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      enabledModels(provider).map((model) => ({
        providerId: provider.id,
        providerName: provider.name,
        model,
      })),
    );
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
