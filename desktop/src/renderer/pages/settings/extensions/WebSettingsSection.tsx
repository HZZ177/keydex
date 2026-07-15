import { CircleAlert, ExternalLink, Eye, EyeOff } from "lucide-react";
import {
  type ForwardedRef,
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { SettingsSelect, SettingsToggle } from "@/renderer/pages/settings/components";
import { AppTooltipLayer } from "@/renderer/components/tooltip";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import { openExternalUrl } from "@/runtime/externalLinks";
import type { RuntimeBridge } from "@/runtime";
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

type ConnectionState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "success"; durationMs: number | null }
  | { status: "error"; code: string; message: string; retryable: boolean };

export interface WebSettingsSectionHandle {
  save: () => Promise<void>;
  validationMessage: () => string | null;
}

interface WebSettingsSectionProps {
  onReadyChange?: (ready: boolean) => void;
  runtime: RuntimeBridge;
}

export const WebSettingsSection = forwardRef<WebSettingsSectionHandle, WebSettingsSectionProps>(
  WebSettingsSectionImpl,
);

function WebSettingsSectionImpl(
  { onReadyChange, runtime }: WebSettingsSectionProps,
  ref: ForwardedRef<WebSettingsSectionHandle>,
) {
  const notifications = useNotifications();
  const [settings, setSettings] = useState<WebSettingsResponse | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [activeProviderId, setActiveProviderId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [connections, setConnections] = useState<Record<string, ConnectionState>>({});
  const [loading, setLoading] = useState(true);
  const requestSequenceRef = useRef<Record<string, number>>({});
  const activeProviderIdRef = useRef("");
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
        applyResponse(response, setSettings, setEnabled, setActiveProviderId, setDrafts);
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
  const missingFields = useMemo(
    () => (activeProvider && activeDraft ? requiredMissingFields(activeProvider, activeDraft) : []),
    [activeDraft, activeProvider],
  );
  const saveBlocked = !settings || !activeProvider || (enabled && missingFields.length > 0);

  const updateProviderDraft = (providerId: string, updater: (draft: ProviderDraft) => ProviderDraft) => {
    setDrafts((current) => {
      const draft = current[providerId];
      return draft ? { ...current, [providerId]: updater(draft) } : current;
    });
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

  const save = useCallback(async () => {
    if (typeof getWebSettings !== "function") {
      return;
    }
    if (saveBlocked || !settings || !activeProvider) {
      throw new Error("网络搜索配置尚未完成");
    }
    const response = await runtime.settings.saveWebSettings(
      buildUpdatePayload(enabled, activeProviderId, drafts),
    );
    applyResponse(response, setSettings, setEnabled, setActiveProviderId, setDrafts);
    setConnections({});
  }, [activeProvider, activeProviderId, drafts, enabled, getWebSettings, runtime.settings, saveBlocked, settings]);

  const validationMessage = useCallback(() => {
    if (!enabled || missingFields.length === 0) {
      return null;
    }
    return `请先填写 ${missingFields.join("、")} 后再保存`;
  }, [enabled, missingFields]);

  useImperativeHandle(ref, () => ({ save, validationMessage }), [save, validationMessage]);

  useEffect(() => {
    onReadyChange?.(typeof getWebSettings !== "function" || (!loading && Boolean(settings)));
  }, [getWebSettings, loading, onReadyChange, settings]);

  if (typeof getWebSettings !== "function") {
    return null;
  }

  const checkConnection = async () => {
    if (!activeProvider || !activeDraft || missingFields.length > 0) {
      return;
    }
    const providerId = activeProvider.provider_id;
    const sequence = (requestSequenceRef.current[providerId] ?? 0) + 1;
    requestSequenceRef.current[providerId] = sequence;
    setConnections((current) => ({ ...current, [providerId]: { status: "checking" } }));
    try {
      const response = await runtime.settings.checkWebProvider(
        providerId,
        buildConnectionDraft(activeDraft),
      );
      if (requestSequenceRef.current[providerId] !== sequence) {
        return;
      }
      const nextConnection = connectionStateFromResponse(response);
      setConnections((current) => ({
        ...current,
        [providerId]: nextConnection,
      }));
      if (activeProviderIdRef.current !== providerId) {
        return;
      }
      if (nextConnection.status === "success") {
        notifications.success(
          `连接正常${nextConnection.durationMs !== null ? ` · ${nextConnection.durationMs} ms` : ""}`,
        );
      } else if (nextConnection.status === "error") {
        notifications.error(
          `${friendlyConnectionError(nextConnection.code, nextConnection.message)}${
            nextConnection.retryable ? "，可以稍后重试" : ""
          }`,
        );
      }
    } catch (reason) {
      if (requestSequenceRef.current[providerId] !== sequence) {
        return;
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
    }
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
            <SettingsToggle checked={enabled} label="启用网络搜索" onChange={setEnabled} />
          ) : null}
        </div>

        {loading ? <p className={styles.loading}>正在读取网络搜索配置</p> : null}

        {!loading && settings && activeProvider && activeDraft ? (
          <>
            <div className={styles.providerRow}>
              <div className={styles.providerCopy}>
                <strong>搜索引擎</strong>
                <span>配置会按搜索引擎分别保存</span>
              </div>
              <SettingsSelect
                ariaLabel="搜索引擎"
                density="compact"
                onChange={setActiveProviderId}
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
                        disabled={connection.status === "checking" || missingFields.length > 0}
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
                  draft={activeDraft}
                  field={field}
                  key={`${activeProvider.provider_id}:${field.key}`}
                  onChange={(nextDraft) => updateProviderDraft(activeProvider.provider_id, () => nextDraft)}
                  onRevealSecret={revealSecret}
                  provider={activeProvider}
                />
              ))}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

function ProviderField({
  connectionAction,
  draft,
  field,
  onChange,
  onRevealSecret,
  provider,
}: {
  connectionAction?: ReactNode;
  draft: ProviderDraft;
  field: WebProviderConfigField;
  onChange: (draft: ProviderDraft) => void;
  onRevealSecret: (providerId: string, fieldKey: string) => Promise<string>;
  provider: WebProviderSettings;
}) {
  if (field.field_type === "secret") {
    return (
      <SecretProviderField
        connectionAction={connectionAction}
        draft={draft}
        field={field}
        onChange={onChange}
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
  draft,
  field,
  onChange,
  onRevealSecret,
  provider,
}: {
  connectionAction?: ReactNode;
  draft: ProviderDraft;
  field: WebProviderConfigField;
  onChange: (draft: ProviderDraft) => void;
  onRevealSecret: (providerId: string, fieldKey: string) => Promise<string>;
  provider: WebProviderSettings;
}) {
  const [visible, setVisible] = useState(false);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const secret = draft.secrets[field.key] ?? { action: "keep" as const, value: "" };
  const saved = provider.secrets[field.key];
  const previousSecretActionRef = useRef(secret.action);
  const revealRequestRef = useRef(0);

  useEffect(() => {
    if (previousSecretActionRef.current !== secret.action) {
      revealRequestRef.current += 1;
      if (secret.action !== "set") {
        setVisible(false);
        setRevealedValue(null);
        setRevealing(false);
      }
    }
    previousSecretActionRef.current = secret.action;
  }, [secret.action]);

  useEffect(
    () => () => {
      revealRequestRef.current += 1;
    },
    [],
  );

  const visibilityLabel = `${visible ? "隐藏" : "显示"}${field.label}`;

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
            placeholder={
              secret.action === "clear"
                ? "保存后清除"
                : saved?.configured
                  ? saved.preview ?? "已保存"
                  : field.placeholder ?? "请输入密钥"
            }
            type={visible ? "text" : "password"}
            value={secret.action === "set" ? secret.value : visible ? revealedValue ?? "" : ""}
          />
          <button
            aria-busy={revealing}
            aria-label={visibilityLabel}
            aria-pressed={visible}
            className={styles.visibilityButton}
            disabled={revealing || secret.action === "clear"}
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
          {saved?.configured || secret.action === "clear" ? (
            <button
              aria-label={secret.action === "clear" ? `撤销清除${field.label}` : `清除${field.label}`}
              onClick={() => {
                revealRequestRef.current += 1;
                setRevealing(false);
                setVisible(false);
                setRevealedValue(null);
                onChange({
                  ...draft,
                  secrets: {
                    ...draft.secrets,
                    [field.key]: {
                      action: secret.action === "clear" ? "keep" : "clear",
                      value: "",
                    },
                  },
                });
              }}
              type="button"
            >
              {secret.action === "clear" ? "撤销" : "清除"}
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
    response.providers.map((provider) => [
      provider.provider_id,
      {
        config: { ...provider.config },
        secrets: Object.fromEntries(
          provider.config_fields
            .filter((field) => field.field_type === "secret")
            .map((field) => [field.key, { action: "keep", value: "" } satisfies SecretDraft]),
        ),
      },
    ]),
  );
}

function applyResponse(
  response: WebSettingsResponse,
  setSettings: (value: WebSettingsResponse) => void,
  setEnabled: (value: boolean) => void,
  setActiveProviderId: (value: string) => void,
  setDrafts: (value: Record<string, ProviderDraft>) => void,
) {
  setSettings(response);
  setEnabled(response.enabled);
  setActiveProviderId(
    response.providers.some((provider) => provider.provider_id === response.active_provider_id)
      ? response.active_provider_id
      : response.providers[0]?.provider_id ?? "",
  );
  setDrafts(draftsFromResponse(response));
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

function buildUpdatePayload(
  enabled: boolean,
  activeProviderId: string,
  drafts: Record<string, ProviderDraft>,
): UpdateWebSettingsPayload {
  return {
    enabled,
    active_provider_id: activeProviderId,
    providers: Object.fromEntries(
      Object.entries(drafts).map(([providerId, draft]) => [
        providerId,
        {
          config: draft.config,
          secrets: Object.fromEntries(
            Object.entries(draft.secrets).map(([key, secret]) => [key, secretUpdate(secret)]),
          ),
        },
      ]),
    ),
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
