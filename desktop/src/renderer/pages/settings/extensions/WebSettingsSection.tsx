import { CircleAlert, ExternalLink, Eye, EyeOff } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ConfirmDialog } from "@/renderer/components/dialog";
import { AppTooltipLayer } from "@/renderer/components/tooltip";
import { SettingsSelect, SettingsToggle } from "@/renderer/pages/settings/components";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import type { RuntimeBridge } from "@/runtime";
import { openExternalUrl } from "@/runtime/externalLinks";
import type {
  UpdateWebSettingsPayload,
  WebConnectionCheckDraft,
  WebConnectionCheckResponse,
  WebProviderConfigField,
  WebProviderSettings,
  WebSecretUpdate,
  WebSettingsResponse,
} from "@/runtime/settings";

import styles from "./WebSettingsSection.module.css";

interface SecretDraft {
  action: "keep" | "set" | "clear";
  value: string;
}

interface ProviderDraft {
  config: Record<string, string | boolean>;
  secrets: Record<string, SecretDraft>;
}

interface ClearSecretTarget {
  field: WebProviderConfigField;
  providerId: string;
}

type ConnectionState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "success"; durationMs: number | null }
  | { status: "error"; code: string; message: string; retryable: boolean };

interface WebSettingsSectionProps {
  runtime: RuntimeBridge;
}

export function WebSettingsSection({ runtime }: WebSettingsSectionProps) {
  const notifications = useNotifications();
  const [settings, setSettings] = useState<WebSettingsResponse | null>(null);
  const [activeProviderId, setActiveProviderId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [connections, setConnections] = useState<Record<string, ConnectionState>>({});
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [enableAfterSave, setEnableAfterSave] = useState(false);
  const [clearTarget, setClearTarget] = useState<ClearSecretTarget | null>(null);
  const requestSequenceRef = useRef<Record<string, number>>({});
  const activeProviderIdRef = useRef("");
  const draftRevisionRef = useRef(0);
  const getWebSettings = runtime.settings.getWebSettings;
  const revealWebProviderSecret = runtime.settings.revealWebProviderSecret;

  useEffect(() => {
    activeProviderIdRef.current = activeProviderId;
  }, [activeProviderId]);

  useEffect(() => {
    if (typeof getWebSettings !== "function") {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    void getWebSettings.call(runtime.settings)
      .then((response) => {
        if (!active) {
          return;
        }
        setSettings(response);
        setActiveProviderId(responseActiveProviderId(response));
        setDrafts(draftsFromResponse(response));
        setDetailsExpanded(response.enabled);
        draftRevisionRef.current += 1;
      })
      .catch((reason: unknown) => {
        if (active) {
          notifications.error(errorMessage(reason, "读取网络搜索配置失败"));
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
  }, [getWebSettings, notifications, runtime.settings]);

  const activeProvider = settings?.providers.find((provider) => provider.provider_id === activeProviderId) ?? null;
  const activeDraft = activeProvider ? drafts[activeProvider.provider_id] ?? null : null;
  const persistedActiveProvider = settings?.providers.find(
    (provider) => provider.provider_id === settings.active_provider_id,
  ) ?? null;
  const missingFields = useMemo(
    () => (activeProvider && activeDraft ? requiredMissingFields(activeProvider, activeDraft) : []),
    [activeDraft, activeProvider],
  );
  const hasPendingChanges = Boolean(
    settings &&
      activeProvider &&
      activeDraft &&
      (settings.active_provider_id !== activeProviderId || providerDraftHasChanges(activeProvider, activeDraft)),
  );

  const updateProviderDraft = (providerId: string, updater: (draft: ProviderDraft) => ProviderDraft) => {
    setConnections((current) => ({ ...current, [providerId]: { status: "idle" } }));
    setDrafts((current) => {
      const draft = current[providerId];
      if (!draft) {
        return current;
      }
      return { ...current, [providerId]: updater(draft) };
    });
    draftRevisionRef.current += 1;
  };

  const chooseActiveProvider = (providerId: string) => {
    setActiveProviderId(providerId);
    activeProviderIdRef.current = providerId;
    draftRevisionRef.current += 1;
  };

  const revealSecret = useCallback(
    async (providerId: string, fieldKey: string) => {
      if (typeof revealWebProviderSecret !== "function") {
        const error = new Error("当前版本不支持读取已保存密钥");
        notifications.error(error.message);
        throw error;
      }
      try {
        const revealed = await revealWebProviderSecret.call(runtime.settings, providerId, fieldKey);
        if (
          revealed.provider_id !== providerId ||
          revealed.field_key !== fieldKey ||
          !revealed.value
        ) {
          throw new Error("读取到的密钥响应无效");
        }
        return revealed.value;
      } catch (reason) {
        notifications.error(errorMessage(reason, "读取已保存密钥失败"));
        throw reason;
      }
    },
    [notifications, revealWebProviderSecret, runtime.settings],
  );

  const verifyProvider = async (
    provider: WebProviderSettings,
    draft: ProviderDraft,
    notifySuccess: boolean,
  ): Promise<boolean> => {
    const providerId = provider.provider_id;
    const sequence = (requestSequenceRef.current[providerId] ?? 0) + 1;
    requestSequenceRef.current[providerId] = sequence;
    setConnections((current) => ({ ...current, [providerId]: { status: "checking" } }));
    try {
      const response = await runtime.settings.checkWebProvider(
        providerId,
        buildConnectionDraft(draft),
      );
      if (requestSequenceRef.current[providerId] !== sequence) {
        return false;
      }
      const nextConnection = connectionStateFromResponse(response);
      setConnections((current) => ({ ...current, [providerId]: nextConnection }));
      if (activeProviderIdRef.current !== providerId) {
        return false;
      }
      if (nextConnection.status === "success") {
        if (notifySuccess) {
          notifications.success(
            `连接正常${nextConnection.durationMs !== null ? ` · ${nextConnection.durationMs} ms` : ""}`,
          );
        }
        return true;
      }
      if (nextConnection.status === "error") {
        notifications.error(
          `${friendlyConnectionError(nextConnection.code, nextConnection.message)}${
            nextConnection.retryable ? "，可以稍后重试" : ""
          }`,
        );
      }
      return false;
    } catch (reason) {
      if (requestSequenceRef.current[providerId] !== sequence) {
        return false;
      }
      const code = errorCode(reason);
      const message = errorMessage(reason, "暂时无法连接搜索引擎");
      setConnections((current) => ({
        ...current,
        [providerId]: {
          status: "error",
          code,
          message,
          retryable: false,
        },
      }));
      if (activeProviderIdRef.current === providerId) {
        notifications.error(friendlyConnectionError(code, message));
      }
      return false;
    }
  };

  const saveDraft = async (nextEnabled: boolean, successMessage: string): Promise<boolean> => {
    if (!activeProvider || !activeDraft) {
      return false;
    }
    if (nextEnabled && missingFields.length > 0) {
      notifications.error(`请先填写 ${missingFields.join("、")} 后再启用网络搜索`);
      return false;
    }
    const revision = draftRevisionRef.current;
    setApplying(true);
    try {
      const response = await runtime.settings.saveWebSettings(
        buildProviderUpdatePayload(nextEnabled, activeProviderId, activeProvider.provider_id, activeDraft),
      );
      if (draftRevisionRef.current !== revision) {
        setSettings(response);
        notifications.error("保存期间配置已变化，请重新验证当前草稿");
        return false;
      }
      setSettings(response);
      setActiveProviderId(responseActiveProviderId(response));
      setDrafts((current) => ({
        ...current,
        ...draftForProviderFromResponse(response, activeProvider.provider_id),
      }));
      draftRevisionRef.current += 1;
      notifications.success(successMessage);
      return true;
    } catch (reason) {
      notifications.error(errorMessage(reason, "保存网络搜索配置失败"));
      return false;
    } finally {
      setApplying(false);
    }
  };

  const toggleEnabled = async (nextEnabled: boolean) => {
    if (!settings || nextEnabled === settings.enabled) {
      return;
    }
    if (nextEnabled) {
      if (!persistedActiveProvider?.configured || hasPendingChanges) {
        setDetailsExpanded(true);
        setEnableAfterSave(true);
        return;
      }
    }
    setApplying(true);
    try {
      const response = await runtime.settings.saveWebSettings({
        enabled: nextEnabled,
        active_provider_id: settings.active_provider_id,
        providers: {},
      });
      setSettings(response);
      setDetailsExpanded(nextEnabled);
      setEnableAfterSave(false);
      notifications.success(nextEnabled ? "网络搜索已启用" : "网络搜索已关闭");
    } catch (reason) {
      notifications.error(errorMessage(reason, nextEnabled ? "启用网络搜索失败" : "关闭网络搜索失败"));
    } finally {
      setApplying(false);
    }
  };

  const clearSavedSecret = async () => {
    if (!settings || !clearTarget) {
      return;
    }
    const provider = settings.providers.find((item) => item.provider_id === clearTarget.providerId);
    if (!provider) {
      setClearTarget(null);
      return;
    }
    const disablesSearch = Boolean(
      settings.enabled &&
        settings.active_provider_id === provider.provider_id &&
        clearTarget.field.required,
    );
    setApplying(true);
    try {
      const response = await runtime.settings.saveWebSettings(
        buildClearSecretPayload(settings, provider, clearTarget.field.key, disablesSearch),
      );
      setSettings(response);
      setDrafts((current) => {
        const draft = current[provider.provider_id];
        if (!draft) {
          return current;
        }
        return {
          ...current,
          [provider.provider_id]: {
            ...draft,
            secrets: {
              ...draft.secrets,
              [clearTarget.field.key]: { action: "keep", value: "" },
            },
          },
        };
      });
      draftRevisionRef.current += 1;
      setClearTarget(null);
      if (!response.enabled) {
        setDetailsExpanded(false);
        setEnableAfterSave(false);
      }
      notifications.success(disablesSearch ? "密钥已清除，网络搜索已关闭" : "密钥已清除");
    } catch (reason) {
      notifications.error(errorMessage(reason, "清除网络搜索密钥失败"));
    } finally {
      setApplying(false);
    }
  };

  if (typeof getWebSettings !== "function") {
    return null;
  }

  const checkConnection = async () => {
    if (!activeProvider || !activeDraft || missingFields.length > 0) {
      return;
    }
    await verifyProvider(activeProvider, activeDraft, true);
  };

  const connection = activeProvider
    ? connections[activeProvider.provider_id] ?? { status: "idle" as const }
    : { status: "idle" as const };
  const connectionFieldKey = activeProvider?.config_fields.find((field) => field.field_type === "secret")?.key;
  const credentialSetup = activeProvider?.credential_setup ?? null;
  const openCredentialSetup = useCallback((url: string) => {
    void openExternalUrl(url).catch((reason: unknown) => {
      notifications.error(errorMessage(reason, "无法打开系统浏览器"));
    });
  }, [notifications]);
  const clearProvider = clearTarget && settings
    ? settings.providers.find((provider) => provider.provider_id === clearTarget.providerId) ?? null
    : null;
  const clearDisablesSearch = Boolean(
    clearTarget?.field.required &&
      clearProvider &&
      settings?.enabled &&
      settings.active_provider_id === clearProvider.provider_id,
  );

  return (
    <section
      className={styles.group}
      aria-labelledby="web-settings-title"
      data-testid="web-settings-section"
      data-web-settings-tooltips="true"
    >
      <AppTooltipLayer scopeSelector="[data-web-settings-tooltips='true']" delayMs={180} />
      <div className={styles.panel} data-testid="web-settings-panel">
        <div className={styles.headingRow}>
          <div>
            <h2 id="web-settings-title">网络搜索</h2>
            <p>让 Keydex 在需要时查找公开网络信息并读取网页内容</p>
          </div>
          {!loading && settings ? (
            <div className={styles.headingActions}>
              {!settings.enabled ? (
                <button
                  aria-expanded={detailsExpanded}
                  className={styles.configureButton}
                  disabled={applying}
                  onClick={() => {
                    setDetailsExpanded((current) => !current);
                    setEnableAfterSave(false);
                  }}
                  type="button"
                >
                  {detailsExpanded ? "收起配置" : "配置"}
                </button>
              ) : null}
              <SettingsToggle
                checked={settings.enabled}
                disabled={applying}
                label="启用网络搜索"
                onChange={(nextEnabled) => void toggleEnabled(nextEnabled)}
              />
            </div>
          ) : null}
        </div>

        {loading ? <p className={styles.loading}>正在读取网络搜索配置</p> : null}

        {!loading && settings && activeProvider && activeDraft && (settings.enabled || detailsExpanded) ? (
          <>
            <div className={styles.providerRow}>
              <div className={styles.providerCopy}>
                <strong>搜索引擎</strong>
                <span>配置会按搜索引擎分别保存，连接测试可选</span>
              </div>
              <SettingsSelect
                ariaLabel="搜索引擎"
                density="compact"
                disabled={applying}
                onChange={chooseActiveProvider}
                options={settings.providers.map((provider) => ({
                  value: provider.provider_id,
                  label: provider.display_name,
                  description: capabilityLabel(provider),
                }))}
                value={activeProviderId}
              />
            </div>

            <div className={styles.providerSummary}>
              <div>
                <strong>{activeProvider.display_name}</strong>
                <p>{activeProvider.description}</p>
              </div>
              <div className={styles.providerSummaryActions}>
                <div className={styles.capabilities} aria-label="支持的网络能力">
                  {activeProvider.capabilities.includes("search") ? <span>网络搜索</span> : null}
                  {activeProvider.capabilities.includes("fetch") ? <span>网页读取</span> : null}
                </div>
                {credentialSetup ? (
                  <div className={styles.providerSetup}>
                    <button
                      className={styles.providerSetupButton}
                      onClick={() => openCredentialSetup(credentialSetup.url)}
                      type="button"
                    >
                      {credentialSetup.label}
                      <ExternalLink aria-hidden="true" size={12} strokeWidth={1.8} />
                    </button>
                    {credentialSetup.help_text ? (
                      <button
                        aria-label={`${credentialSetup.label}额度说明`}
                        className={styles.providerSetupInfo}
                        data-tooltip-label={credentialSetup.help_text}
                        data-tooltip-multiline="true"
                        type="button"
                      >
                        <CircleAlert aria-hidden="true" size={14} strokeWidth={1.8} />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            <div className={styles.fields}>
              {activeProvider.config_fields.map((field) => (
                <ProviderField
                  connectionAction={
                    field.key === connectionFieldKey ? (
                      <button
                        aria-busy={connection.status === "checking"}
                        className={styles.secondaryButton}
                        disabled={applying || connection.status === "checking" || missingFields.length > 0}
                        onClick={() => void checkConnection()}
                        type="button"
                      >
                        {connection.status === "checking" ? (
                          <span aria-hidden="true" className={styles.loadingSpinner} />
                        ) : null}
                        测试连接
                      </button>
                    ) : null
                  }
                  disabled={applying}
                  draft={activeDraft}
                  field={field}
                  key={`${activeProvider.provider_id}:${field.key}`}
                  onChange={(nextDraft) => updateProviderDraft(activeProvider.provider_id, () => nextDraft)}
                  onDiscardSecretEdit={(fieldKey) => {
                    updateProviderDraft(activeProvider.provider_id, (draft) => ({
                      ...draft,
                      secrets: {
                        ...draft.secrets,
                        [fieldKey]: { action: "keep", value: "" },
                      },
                    }));
                  }}
                  onRequestClear={(targetField) => {
                    setClearTarget({ providerId: activeProvider.provider_id, field: targetField });
                  }}
                  onRevealSecret={revealSecret}
                  provider={activeProvider}
                />
              ))}
            </div>

            <div className={styles.applyRow}>
              <p>
                {hasPendingChanges
                  ? enableAfterSave
                    ? "填写完成后保存配置，随后启用网络搜索。"
                    : settings.enabled && settings.active_provider_id !== activeProviderId && persistedActiveProvider
                    ? `当前仍在使用 ${persistedActiveProvider.display_name}，保存后才会切换。`
                    : "更改尚未应用，保存后生效。"
                  : enableAfterSave
                    ? `请先填写 ${missingFields.join("、")}，配置完整后即可保存并启用。`
                    : "修改密钥或搜索引擎配置后保存即可生效。"}
              </p>
              <button
                className={styles.primaryButton}
                disabled={applying || !hasPendingChanges || (enableAfterSave && missingFields.length > 0)}
                onClick={() => {
                  const nextEnabled = enableAfterSave || settings.enabled;
                  void saveDraft(
                    nextEnabled,
                    nextEnabled && !settings.enabled ? "网络搜索已启用" : "网络搜索配置已保存",
                  ).then((saved) => {
                    if (saved && enableAfterSave) {
                      setEnableAfterSave(false);
                      setDetailsExpanded(true);
                    }
                  });
                }}
                type="button"
              >
                {applying ? <span aria-hidden="true" className={styles.loadingSpinner} /> : null}
                {enableAfterSave ? "保存并启用" : "保存"}
              </button>
            </div>
          </>
        ) : null}
      </div>

      {clearTarget && clearProvider ? (
        <ConfirmDialog
          title={`清除${clearTarget.field.label}？`}
          description={
            clearDisablesSearch
              ? "该密钥正在用于网络搜索。清除密钥时会同时关闭网络搜索，此操作立即生效。"
              : "清除后，再次使用该搜索引擎前需要重新填写并验证密钥。此操作立即生效。"
          }
          preview={clearProvider.display_name}
          confirmLabel="清除密钥"
          confirmTone="danger"
          cancelDisabled={applying}
          confirmDisabled={applying}
          onCancel={() => setClearTarget(null)}
          onConfirm={() => void clearSavedSecret()}
        />
      ) : null}
    </section>
  );
}

function ProviderField({
  connectionAction,
  disabled,
  draft,
  field,
  onChange,
  onDiscardSecretEdit,
  onRequestClear,
  onRevealSecret,
  provider,
}: {
  connectionAction?: ReactNode;
  disabled: boolean;
  draft: ProviderDraft;
  field: WebProviderConfigField;
  onChange: (draft: ProviderDraft) => void;
  onDiscardSecretEdit: (fieldKey: string) => void;
  onRequestClear: (field: WebProviderConfigField) => void;
  onRevealSecret: (providerId: string, fieldKey: string) => Promise<string>;
  provider: WebProviderSettings;
}) {
  if (field.field_type === "secret") {
    return (
      <SecretProviderField
        connectionAction={connectionAction}
        disabled={disabled}
        draft={draft}
        field={field}
        onChange={onChange}
        onDiscardEdit={() => onDiscardSecretEdit(field.key)}
        onRequestClear={() => onRequestClear(field)}
        onRevealSecret={onRevealSecret}
        provider={provider}
      />
    );
  }

  if (field.field_type === "select") {
    const value = String(draft.config[field.key] ?? field.default ?? "");
    return (
      <div className={styles.field}>
        <FieldLabel field={field} />
        <SettingsSelect
          ariaLabel={field.label}
          density="compact"
          disabled={disabled}
          onChange={(nextValue) => onChange({ ...draft, config: { ...draft.config, [field.key]: nextValue } })}
          options={field.options}
          value={value || null}
        />
        <FieldHelp field={field} />
      </div>
    );
  }

  if (field.field_type === "boolean") {
    return (
      <div className={styles.fieldBoolean}>
        <div>
          <FieldLabel field={field} />
          <FieldHelp field={field} />
        </div>
        <SettingsToggle
          checked={Boolean(draft.config[field.key] ?? field.default ?? false)}
          disabled={disabled}
          label={field.label}
          onChange={(checked) => onChange({ ...draft, config: { ...draft.config, [field.key]: checked } })}
        />
      </div>
    );
  }

  return (
    <div className={styles.field}>
      <FieldLabel field={field} />
      <input
        aria-label={field.label}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, config: { ...draft.config, [field.key]: event.target.value } })}
        placeholder={field.placeholder ?? undefined}
        type="text"
        value={String(draft.config[field.key] ?? field.default ?? "")}
      />
      <FieldHelp field={field} />
    </div>
  );
}

function SecretProviderField({
  connectionAction,
  disabled,
  draft,
  field,
  onChange,
  onDiscardEdit,
  onRequestClear,
  onRevealSecret,
  provider,
}: {
  connectionAction?: ReactNode;
  disabled: boolean;
  draft: ProviderDraft;
  field: WebProviderConfigField;
  onChange: (draft: ProviderDraft) => void;
  onDiscardEdit: () => void;
  onRequestClear: () => void;
  onRevealSecret: (providerId: string, fieldKey: string) => Promise<string>;
  provider: WebProviderSettings;
}) {
  const [visible, setVisible] = useState(false);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const secret = draft.secrets[field.key] ?? { action: "keep" as const, value: "" };
  const saved = provider.secrets[field.key];
  const previousSecretActionRef = useRef(secret.action);
  const previousSavedConfiguredRef = useRef(saved?.configured);
  const revealRequestRef = useRef(0);

  useEffect(() => {
    if (
      previousSecretActionRef.current !== secret.action ||
      previousSavedConfiguredRef.current !== saved?.configured
    ) {
      revealRequestRef.current += 1;
      if (secret.action !== "set" || !saved?.configured) {
        setVisible(false);
        setRevealedValue(null);
        setRevealing(false);
      }
    }
    previousSecretActionRef.current = secret.action;
    previousSavedConfiguredRef.current = saved?.configured;
  }, [saved?.configured, secret.action]);

  useEffect(
    () => () => {
      revealRequestRef.current += 1;
    },
    [],
  );

  const visibilityLabel = `${visible ? "隐藏" : "显示"}${field.label}`;

  const resetSecretView = () => {
    revealRequestRef.current += 1;
    setRevealing(false);
    setVisible(false);
    setRevealedValue(null);
  };

  const toggleVisibility = async () => {
    if (visible) {
      revealRequestRef.current += 1;
      setVisible(false);
      if (secret.action === "keep") {
        setRevealedValue(null);
      }
      return;
    }
    if (secret.action === "set" || !saved?.configured) {
      setVisible(true);
      return;
    }
    const requestId = revealRequestRef.current + 1;
    revealRequestRef.current = requestId;
    setRevealing(true);
    try {
      const value = await onRevealSecret(provider.provider_id, field.key);
      if (revealRequestRef.current !== requestId) {
        return;
      }
      setRevealedValue(value);
      setVisible(true);
    } catch {
      if (revealRequestRef.current === requestId) {
        setRevealedValue(null);
      }
    } finally {
      if (revealRequestRef.current === requestId) {
        setRevealing(false);
      }
    }
  };

  return (
    <div className={styles.field}>
      <FieldLabel field={field} />
      <div className={styles.secretControl}>
        <div className={styles.secretInputShell}>
          <input
            aria-label={field.label}
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => {
              revealRequestRef.current += 1;
              setRevealing(false);
              setRevealedValue(event.target.value);
              onChange({
                ...draft,
                secrets: {
                  ...draft.secrets,
                  [field.key]: {
                    action: event.target.value ? "set" : saved?.configured ? "keep" : "set",
                    value: event.target.value,
                  },
                },
              });
            }}
            placeholder={saved?.configured ? saved.preview ?? "已保存" : field.placeholder ?? "请输入密钥"}
            type={visible ? "text" : "password"}
            value={secret.action === "set" ? secret.value : visible ? revealedValue ?? "" : ""}
          />
          <button
            aria-busy={revealing}
            aria-label={visibilityLabel}
            aria-pressed={visible}
            className={styles.visibilityButton}
            disabled={disabled || revealing}
            onClick={() => void toggleVisibility()}
            title={visibilityLabel}
            type="button"
          >
            {revealing ? (
              <span aria-hidden="true" className={styles.loadingSpinner} />
            ) : visible ? (
              <EyeOff aria-hidden="true" size={15} />
            ) : (
              <Eye aria-hidden="true" size={15} />
            )}
          </button>
        </div>
        <div className={styles.secretActions}>
          {saved?.configured ? (
            <button
              aria-label={secret.action === "set" ? `撤销修改${field.label}` : `清除${field.label}`}
              disabled={disabled}
              onClick={() => {
                resetSecretView();
                if (secret.action === "set") {
                  onDiscardEdit();
                } else {
                  onRequestClear();
                }
              }}
              type="button"
            >
              {secret.action === "set" ? "撤销修改" : "清除"}
            </button>
          ) : null}
          {connectionAction}
        </div>
      </div>
    </div>
  );
}

function FieldLabel({ field }: { field: WebProviderConfigField }) {
  return (
    <span className={styles.fieldLabel}>
      {field.label}
      {field.required ? <em>必填</em> : null}
    </span>
  );
}

function FieldHelp({ field }: { field: WebProviderConfigField }) {
  return field.help_text ? <span className={styles.helpText}>{field.help_text}</span> : null;
}

function draftsFromResponse(response: WebSettingsResponse): Record<string, ProviderDraft> {
  return Object.fromEntries(
    response.providers.map((provider) => [provider.provider_id, draftFromProvider(provider)]),
  );
}

function draftFromProvider(provider: WebProviderSettings): ProviderDraft {
  return {
    config: { ...provider.config },
    secrets: Object.fromEntries(
      provider.config_fields
        .filter((field) => field.field_type === "secret")
        .map((field) => [field.key, { action: "keep", value: "" } satisfies SecretDraft]),
    ),
  };
}

function draftForProviderFromResponse(
  response: WebSettingsResponse,
  providerId: string,
): Record<string, ProviderDraft> {
  const provider = response.providers.find((item) => item.provider_id === providerId);
  return provider ? { [providerId]: draftFromProvider(provider) } : {};
}

function responseActiveProviderId(response: WebSettingsResponse): string {
  return response.providers.some((provider) => provider.provider_id === response.active_provider_id)
    ? response.active_provider_id
    : response.providers[0]?.provider_id ?? "";
}

function providerDraftHasChanges(provider: WebProviderSettings, draft: ProviderDraft): boolean {
  const configKeys = new Set([...Object.keys(provider.config), ...Object.keys(draft.config)]);
  for (const key of configKeys) {
    if (!Object.is(provider.config[key], draft.config[key])) {
      return true;
    }
  }
  return Object.values(draft.secrets).some((secret) => secret.action !== "keep");
}

function requiredMissingFields(provider: WebProviderSettings, draft: ProviderDraft): string[] {
  return provider.config_fields.flatMap((field) => {
    if (!field.required) {
      return [];
    }
    if (field.field_type === "secret") {
      const secret = draft.secrets[field.key];
      const configured = provider.secrets[field.key]?.configured ?? false;
      const available = secret?.action === "set" ? Boolean(secret.value.trim()) : secret?.action === "clear" ? false : configured;
      return available ? [] : [field.label];
    }
    const value = draft.config[field.key] ?? field.default;
    return typeof value === "string" && !value.trim() ? [field.label] : value == null ? [field.label] : [];
  });
}

function buildProviderUpdatePayload(
  enabled: boolean,
  activeProviderId: string,
  providerId: string,
  draft: ProviderDraft,
): UpdateWebSettingsPayload {
  return {
    enabled,
    active_provider_id: activeProviderId,
    providers: {
      [providerId]: {
        config: draft.config,
        secrets: Object.fromEntries(
          Object.entries(draft.secrets).map(([key, secret]) => [key, secretUpdate(secret)]),
        ),
      },
    },
  };
}

function buildClearSecretPayload(
  settings: WebSettingsResponse,
  provider: WebProviderSettings,
  fieldKey: string,
  disablesSearch: boolean,
): UpdateWebSettingsPayload {
  return {
    enabled: disablesSearch ? false : settings.enabled,
    active_provider_id: settings.active_provider_id,
    providers: {
      [provider.provider_id]: {
        config: provider.config,
        secrets: Object.fromEntries(
          provider.config_fields
            .filter((field) => field.field_type === "secret")
            .map((field) => [field.key, { action: field.key === fieldKey ? "clear" : "keep" }]),
        ),
      },
    },
  };
}

function secretUpdate(secret: SecretDraft): WebSecretUpdate {
  return secret.action === "set"
    ? { action: "set", value: secret.value }
    : { action: secret.action };
}

function buildConnectionDraft(draft: ProviderDraft): WebConnectionCheckDraft {
  return {
    config: draft.config,
    secrets: Object.fromEntries(
      Object.entries(draft.secrets).map(([key, secret]) => [key, secretUpdate(secret)]),
    ),
  };
}

function connectionStateFromResponse(response: WebConnectionCheckResponse): ConnectionState {
  if (response.ok) {
    return { status: "success", durationMs: response.duration_ms };
  }
  return {
    status: "error",
    code: response.error?.code ?? "provider_unavailable",
    message: response.error?.message ?? "暂时无法连接搜索引擎",
    retryable: response.error?.retryable ?? false,
  };
}

function capabilityLabel(provider: WebProviderSettings): string {
  return provider.capabilities.includes("fetch") ? "搜索与网页读取" : "网络搜索";
}

function friendlyConnectionError(code: string, fallback: string): string {
  const messages: Record<string, string> = {
    authentication_failed: "密钥无效，请检查后重试",
    provider_not_configured: "请先完成必填配置",
    quota_exhausted: "当前额度已用完",
    rate_limited: "请求过于频繁",
    network_unavailable: "当前网络不可用",
    request_timeout: "连接超时",
    provider_unavailable: "搜索引擎暂时不可用",
  };
  return messages[code] ?? fallback;
}

function errorCode(reason: unknown): string {
  return reason && typeof reason === "object" && typeof (reason as { code?: unknown }).code === "string"
    ? (reason as { code: string }).code
    : "provider_unavailable";
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message
    ? reason.message
    : reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string"
      ? (reason as { message: string }).message
      : fallback;
}
