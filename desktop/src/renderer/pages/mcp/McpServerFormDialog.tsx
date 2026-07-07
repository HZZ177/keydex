import { AlertCircle, CheckCircle2, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";

import type { RuntimeBridge } from "@/runtime";
import { AppDialog, DialogButton } from "@/renderer/components/dialog";
import type {
  McpAuthType,
  McpConnectionTestResponse,
  McpOAuthStatusResponse,
  McpServerCreatePayload,
  McpServerDetailResponse,
  McpTransport,
} from "@/types/protocol";

import styles from "./McpServerFormDialog.module.css";

type FormMode = "create" | "edit";

interface McpServerFormDialogProps {
  mode: FormMode;
  runtime: RuntimeBridge;
  serverId?: string;
  onClose: () => void;
  onSaved: (server: McpServerDetailResponse) => void;
}

interface KeyValueRow {
  id: string;
  key: string;
  value: string;
}

interface FormState {
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  cwd: string;
  inheritEnvironment: boolean;
  envRows: KeyValueRow[];
  replaceEnv: boolean;
  url: string;
  sseUrl: string;
  messageUrl: string;
  headerRows: KeyValueRow[];
  replaceHeaders: boolean;
  envHeaderRows: KeyValueRow[];
  replaceEnvHeaders: boolean;
  secretRefRows: KeyValueRow[];
  replaceSecretRefs: boolean;
  clearSecretRefs: boolean;
  bearerTokenEnvVar: string;
  authType: McpAuthType;
  oauthAuthorizationUrl: string;
  oauthTokenUrl: string;
  oauthClientId: string;
  oauthRedirectUri: string;
  oauthResource: string;
  oauthScopes: string;
  replaceOAuthConfig: boolean;
}

interface PendingConfirmation {
  messages: string[];
}

const TRANSPORTS: Array<{ value: McpTransport; label: string; description: string }> = [
  { value: "stdio", label: "本地命令", description: "在本机启动一个 MCP 服务进程" },
  { value: "streamable_http", label: "HTTP 地址", description: "连接远端 MCP 服务地址" },
  { value: "sse", label: "SSE 地址", description: "连接使用 SSE 的旧版远端服务" },
];

const DEFAULT_FORM: FormState = {
  name: "",
  transport: "streamable_http",
  command: "",
  args: [],
  cwd: "",
  inheritEnvironment: true,
  envRows: [],
  replaceEnv: true,
  url: "",
  sseUrl: "",
  messageUrl: "",
  headerRows: [],
  replaceHeaders: true,
  envHeaderRows: [],
  replaceEnvHeaders: true,
  secretRefRows: [],
  replaceSecretRefs: true,
  clearSecretRefs: false,
  bearerTokenEnvVar: "",
  authType: "none",
  oauthAuthorizationUrl: "",
  oauthTokenUrl: "",
  oauthClientId: "",
  oauthRedirectUri: "",
  oauthResource: "",
  oauthScopes: "",
  replaceOAuthConfig: true,
};

export function McpServerFormDialog({
  mode,
  runtime,
  serverId,
  onClose,
  onSaved,
}: McpServerFormDialogProps) {
  const formId = useId();
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [original, setOriginal] = useState<McpServerDetailResponse | null>(null);
  const [persistedServerId, setPersistedServerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState<McpConnectionTestResponse | null>(null);
  const [oauthStatus, setOauthStatus] = useState<McpOAuthStatusResponse | null>(null);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthError, setOauthError] = useState("");
  const [oauthAuthUrl, setOauthAuthUrl] = useState("");
  const [oauthCopyState, setOauthCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [showAdvancedAuth, setShowAdvancedAuth] = useState(false);
  const [showSseTransport, setShowSseTransport] = useState(false);

  const effectiveMode: FormMode = mode === "edit" || persistedServerId ? "edit" : "create";
  const effectiveServerId = persistedServerId ?? serverId ?? "";
  const title = effectiveMode === "create" ? "添加 MCP 服务器" : "编辑 MCP 服务器";
  const busy = loading || saving || testing;
  const showAllTransports = effectiveMode === "edit" || showSseTransport || form.transport === "sse";
  const visibleTransports = showAllTransports
    ? TRANSPORTS
    : TRANSPORTS.filter((transport) => transport.value !== "sse");

  useEffect(() => {
    let alive = true;
    if (mode !== "edit" || !serverId) {
      setLoading(false);
      setForm(DEFAULT_FORM);
      setOriginal(null);
      setShowAdvancedAuth(false);
      setShowSseTransport(false);
      return () => {
        alive = false;
      };
    }
    setLoading(true);
    setError("");
    runtime.mcp.getServer(serverId)
      .then((server) => {
        if (!alive) {
          return;
        }
        setOriginal(server);
        setForm(formFromServer(server));
        setShowAdvancedAuth(server.auth_type === "oauth" || Boolean(server.secret_ref_keys?.length));
        setShowSseTransport(server.transport === "sse");
      })
      .catch((reason) => {
        if (alive) {
          setError(errorMessage(reason));
        }
      })
      .finally(() => {
        if (alive) {
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [mode, runtime, serverId]);

  const existingKeys = useMemo(
    () => ({
      env: original?.env_keys ?? [],
      headers: original?.header_keys ?? [],
      envHeaders: original?.env_header_keys ?? [],
      secretRefs: original?.secret_ref_keys ?? original?.auth?.secret_ref_keys ?? [],
    }),
    [original],
  );
  const useQuickRemoteAuth = effectiveMode === "create" && form.transport === "streamable_http" && !showAdvancedAuth;

  useEffect(() => {
    if (!effectiveServerId || form.authType !== "oauth") {
      setOauthStatus(null);
      setOauthError("");
      setOauthAuthUrl("");
      return;
    }
    void loadOAuthStatus(effectiveServerId);
  }, [effectiveServerId, form.authType]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setPendingConfirmation(null);
    setTestResult(null);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const updateQuickRemoteAuth = (
    key: "bearerTokenEnvVar" | "headerRows",
    value: string | KeyValueRow[],
  ) => {
    setPendingConfirmation(null);
    setTestResult(null);
    setForm((current) => {
      const next = { ...current, [key]: value } as FormState;
      next.authType = simpleRemoteAuthType(next);
      return next;
    });
  };

  const requestSave = () => {
    setError("");
    setTestResult(null);
    const validationError = validateForm(form, original, effectiveMode);
    if (validationError) {
      setError(validationError);
      return;
    }
    const dangerousChanges = effectiveMode === "edit" && original ? describeDangerousChanges(original, form) : [];
    if (dangerousChanges.length) {
      setPendingConfirmation({ messages: dangerousChanges });
      return;
    }
    void save();
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setPendingConfirmation(null);
    try {
      const payload = buildPayload(form, {
        mode: effectiveMode,
        includeEnv: effectiveMode === "create" || form.replaceEnv,
        includeHeaders: effectiveMode === "create" || form.replaceHeaders,
        includeEnvHeaders: effectiveMode === "create" || form.replaceEnvHeaders,
        includeSecretRefs: effectiveMode === "create" || form.replaceSecretRefs || form.clearSecretRefs,
        includeOAuthConfig: effectiveMode === "create" || form.replaceOAuthConfig,
        simpleRemoteAuth: useQuickRemoteAuth,
      });
      const saved =
        effectiveMode === "create"
          ? await runtime.mcp.createServer(payload)
          : await runtime.mcp.updateServer(effectiveServerId, payload);
      setPersistedServerId(saved.id);
      setOriginal(saved);
      setForm(formFromServer(saved));
      onSaved(saved);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setError("");
    setTestResult(null);
    setPendingConfirmation(null);
    const validationError = validateForm(form, original, effectiveMode);
    if (validationError) {
      setError(validationError);
      setTesting(false);
      return;
    }
    try {
      const payload = buildPayload(form, {
        mode: effectiveMode,
        includeEnv: effectiveMode === "create" || form.replaceEnv,
        includeHeaders: effectiveMode === "create" || form.replaceHeaders,
        includeEnvHeaders: effectiveMode === "create" || form.replaceEnvHeaders,
        includeSecretRefs: effectiveMode === "create" || form.replaceSecretRefs || form.clearSecretRefs,
        includeOAuthConfig: effectiveMode === "create" || form.replaceOAuthConfig,
        simpleRemoteAuth: useQuickRemoteAuth,
      });
      const result = await runtime.mcp.testServerConfig({
        server: payload,
        base_server_id: effectiveMode === "edit" ? effectiveServerId : null,
      });
      setTestResult(result);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setTesting(false);
    }
  };

  async function loadOAuthStatus(targetServerId = effectiveServerId) {
    if (!targetServerId) {
      return;
    }
    setOauthLoading(true);
    setOauthError("");
    try {
      const status = await runtime.mcp.getOAuthStatus(targetServerId);
      setOauthStatus(status);
    } catch (reason) {
      setOauthError(errorMessage(reason));
    } finally {
      setOauthLoading(false);
    }
  }

  async function startOAuth() {
    if (!effectiveServerId) {
      setOauthError("请先保存 OAuth 配置后再登录");
      return;
    }
    setOauthLoading(true);
    setOauthError("");
    setOauthAuthUrl("");
    setOauthCopyState("idle");
    try {
      const started = await runtime.mcp.startOAuth(effectiveServerId);
      setOauthAuthUrl(started.auth_url);
      window.open(started.auth_url, "_blank", "noopener,noreferrer");
    } catch (reason) {
      setOauthError(errorMessage(reason));
    } finally {
      setOauthLoading(false);
    }
  }

  async function clearOAuth() {
    if (!effectiveServerId) {
      setOauthError("请先保存 OAuth 配置");
      return;
    }
    setOauthLoading(true);
    setOauthError("");
    setOauthAuthUrl("");
    try {
      const status = await runtime.mcp.clearOAuth(effectiveServerId);
      setOauthStatus(status);
    } catch (reason) {
      setOauthError(errorMessage(reason));
    } finally {
      setOauthLoading(false);
    }
  }

  async function copyOAuthUrl() {
    if (!oauthAuthUrl || !navigator.clipboard?.writeText) {
      setOauthCopyState("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(oauthAuthUrl);
      setOauthCopyState("copied");
    } catch {
      setOauthCopyState("failed");
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    requestSave();
  }

  return (
    <AppDialog
      title={title}
      description="配置 MCP 服务器连接"
      placement="center"
      size="form"
      panelClassName={styles.serverFormPanel}
      bodyClassName={styles.serverFormBody}
      footerClassName={styles.serverFormFooter}
      closeLabel="关闭 MCP 服务器表单"
      closeOnOverlayClick={false}
      onClose={onClose}
      footer={(
        <>
          <DialogButton disabled={busy} type="button" onClick={onClose}>
            取消
          </DialogButton>
          <DialogButton disabled={busy} type="button" onClick={() => void testConnection()}>
            {testing ? <LoaderCircle size={13} className={styles.spinning} /> : null}
            {testing ? "测试中" : "测试连接"}
          </DialogButton>
          <DialogButton form={formId} tone="primary" disabled={busy} type="submit">
            {saving && !testing ? <LoaderCircle size={13} className={styles.spinning} /> : null}
            {saving && !testing ? "保存中" : "保存"}
          </DialogButton>
        </>
      )}
    >
      <form id={formId} className={styles.form} aria-label={title} onSubmit={submit}>
        {loading ? <div className={styles.loading}>正在加载 MCP 服务器配置</div> : null}
        {error ? <div className={styles.error} role="alert">{error}</div> : null}

        <section className={styles.section} aria-labelledby="mcp-server-basic-title">
          <h3 id="mcp-server-basic-title">基础信息</h3>
          <label className={styles.field}>
            <span>名称</span>
            <input
              aria-label="MCP 服务器名称"
              autoFocus
              disabled={busy}
              value={form.name}
              placeholder="例如 文件服务"
              onChange={(event) => update("name", event.target.value)}
            />
          </label>
        </section>

        <section className={styles.section} aria-labelledby="mcp-server-transport-title">
          <h3 id="mcp-server-transport-title">连接方式</h3>
          <div className={styles.segmented} data-columns={visibleTransports.length} role="radiogroup" aria-label="MCP 连接方式">
            {visibleTransports.map((transport) => (
              <button
                key={transport.value}
                type="button"
                role="radio"
                aria-checked={form.transport === transport.value}
                data-active={form.transport === transport.value ? "true" : "false"}
                disabled={busy}
                onClick={() => update("transport", transport.value)}
              >
                <strong>{transport.label}</strong>
                <span>{transport.description}</span>
              </button>
            ))}
          </div>

          {form.transport === "stdio" ? (
            <StdioFields form={form} busy={busy} update={update} />
          ) : null}
          {form.transport === "streamable_http" ? (
            <HttpFields
              form={form}
              busy={busy}
              update={update}
            />
          ) : null}
          {form.transport === "sse" ? (
            <SseFields
              form={form}
              busy={busy}
              update={update}
            />
          ) : null}
          {useQuickRemoteAuth ? (
            <QuickRemoteAuthFields
              form={form}
              busy={busy}
              onBearerEnvChange={(value) => updateQuickRemoteAuth("bearerTokenEnvVar", value)}
              onHeaderRowsChange={(rows) => updateQuickRemoteAuth("headerRows", rows)}
            />
          ) : null}
          {form.transport !== "stdio" ? (
            !useQuickRemoteAuth ? (
              <AuthFields
                form={form}
                busy={busy}
                existingKeys={existingKeys}
                oauthStatus={oauthStatus}
                oauthLoading={oauthLoading}
                oauthError={oauthError}
                oauthAuthUrl={oauthAuthUrl}
                oauthCopyState={oauthCopyState}
                canStartOAuth={Boolean(effectiveServerId)}
                update={update}
                onRefreshOAuth={() => void loadOAuthStatus()}
                onStartOAuth={() => void startOAuth()}
                onClearOAuth={() => void clearOAuth()}
                onCopyOAuthUrl={() => void copyOAuthUrl()}
              />
            ) : null
          ) : null}
          {testing ? <ConnectionTestProgress /> : null}
          {!testing && testResult ? <TestResult result={testResult} /> : null}
        </section>

        {!showAllTransports || useQuickRemoteAuth ? (
          <div className={styles.inlineActionRow}>
            {!showAllTransports ? (
              <button
                className={styles.inlineToolButton}
                type="button"
                disabled={busy}
                onClick={() => setShowSseTransport(true)}
              >
                显示旧版 SSE 连接
              </button>
            ) : null}
            {useQuickRemoteAuth ? (
              <button
                className={styles.inlineToolButton}
                type="button"
                disabled={busy}
                onClick={() => setShowAdvancedAuth(true)}
              >
                高级鉴权
              </button>
            ) : null}
          </div>
        ) : null}

        {pendingConfirmation ? (
          <section className={styles.confirmBox} role="alert">
            <strong>确认保存这些高影响变更</strong>
            <ul>
              {pendingConfirmation.messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
            <div>
              <button type="button" disabled={busy} onClick={() => void save()}>
                确认保存
              </button>
              <button type="button" disabled={busy} onClick={() => setPendingConfirmation(null)}>
                取消
              </button>
            </div>
          </section>
        ) : null}

      </form>
    </AppDialog>
  );
}

function StdioFields({
  form,
  busy,
  update,
}: {
  form: FormState;
  busy: boolean;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}) {
  return (
    <div className={styles.fieldStack}>
      <label className={styles.field}>
        <span>启动命令</span>
        <input
          aria-label="本地 MCP 启动命令"
          disabled={busy}
          value={form.command}
          placeholder="node"
          onChange={(event) => update("command", event.target.value)}
        />
      </label>
      <ArgsEditor
        args={form.args}
        disabled={busy}
        onChange={(args) => update("args", args)}
      />
      <label className={styles.field}>
        <span>工作目录</span>
        <input
          aria-label="本地 MCP 工作目录"
          disabled={busy}
          value={form.cwd}
          placeholder="可选，服务器工作目录"
          onChange={(event) => update("cwd", event.target.value)}
        />
      </label>
      <ToggleRow
        checked={form.inheritEnvironment}
        disabled={busy}
        label="使用系统环境变量"
        hint="关闭后只使用下方显式配置的环境变量"
        onChange={(checked) => update("inheritEnvironment", checked)}
      />
      <KeyValueEditor
        title="环境变量"
        addLabel="添加环境变量"
        rows={form.envRows}
        disabled={busy}
        keyPlaceholder="MCP_TOKEN"
        valuePlaceholder="值"
        existingKeys={[]}
        replaceExisting
        onReplaceExistingChange={() => undefined}
        onChange={(rows) => update("envRows", rows)}
      />
    </div>
  );
}

function HttpFields({
  form,
  busy,
  update,
}: {
  form: FormState;
  busy: boolean;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}) {
  return (
    <div className={styles.fieldStack}>
      <label className={styles.field}>
        <span>服务地址</span>
        <input
          aria-label="MCP HTTP 地址"
          disabled={busy}
          value={form.url}
          placeholder="https://mcp.example.com/mcp"
          onChange={(event) => update("url", event.target.value)}
        />
      </label>
    </div>
  );
}

function SseFields({
  form,
  busy,
  update,
}: {
  form: FormState;
  busy: boolean;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}) {
  return (
    <div className={styles.fieldStack}>
      <label className={styles.field}>
        <span>SSE URL</span>
        <input
          aria-label="MCP SSE 地址"
          disabled={busy}
          value={form.sseUrl}
          placeholder="https://mcp.example.com/sse"
          onChange={(event) => update("sseUrl", event.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span>消息地址</span>
        <input
          aria-label="MCP SSE 消息地址"
          disabled={busy}
          value={form.messageUrl}
          placeholder="https://mcp.example.com/messages"
          onChange={(event) => update("messageUrl", event.target.value)}
        />
      </label>
    </div>
  );
}

function QuickRemoteAuthFields({
  form,
  busy,
  onBearerEnvChange,
  onHeaderRowsChange,
}: {
  form: FormState;
  busy: boolean;
  onBearerEnvChange: (value: string) => void;
  onHeaderRowsChange: (rows: KeyValueRow[]) => void;
}) {
  return (
    <div className={styles.quickAuthPanel} aria-label="MCP HTTP 常用鉴权">
      <label className={styles.field}>
        <span>Bearer 令牌环境变量</span>
        <input
          aria-label="Bearer 令牌环境变量"
          disabled={busy}
          value={form.bearerTokenEnvVar}
          placeholder="MCP_BEARER_TOKEN"
          onChange={(event) => onBearerEnvChange(event.target.value)}
        />
      </label>
      <KeyValueEditor
        title="标头"
        addLabel="添加标头"
        rows={form.headerRows}
        disabled={busy}
        keyPlaceholder="X-Api-Key"
        valuePlaceholder="值或密钥引用"
        existingKeys={[]}
        replaceExisting
        onReplaceExistingChange={() => undefined}
        onChange={onHeaderRowsChange}
      />
    </div>
  );
}

function AuthFields({
  form,
  busy,
  existingKeys,
  oauthStatus,
  oauthLoading,
  oauthError,
  oauthAuthUrl,
  oauthCopyState,
  canStartOAuth,
  update,
  onRefreshOAuth,
  onStartOAuth,
  onClearOAuth,
  onCopyOAuthUrl,
}: {
  form: FormState;
  busy: boolean;
  existingKeys: { headers: string[]; envHeaders: string[]; secretRefs: string[] };
  oauthStatus: McpOAuthStatusResponse | null;
  oauthLoading: boolean;
  oauthError: string;
  oauthAuthUrl: string;
  oauthCopyState: "idle" | "copied" | "failed";
  canStartOAuth: boolean;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  onRefreshOAuth: () => void;
  onStartOAuth: () => void;
  onClearOAuth: () => void;
  onCopyOAuthUrl: () => void;
}) {
  const authOptions: Array<{ value: McpAuthType; label: string; description: string; disabled?: boolean }> = [
    { value: "none", label: "无鉴权", description: "连接时不附加鉴权信息" },
    { value: "header_token", label: "请求头令牌", description: "通过请求头或密钥引用传递鉴权信息" },
    {
      value: "bearer_env",
      label: "Bearer 令牌",
      description: "从环境变量读取 Bearer 令牌",
      disabled: form.transport !== "streamable_http",
    },
    { value: "oauth", label: "OAuth 授权", description: "通过授权流程保存访问凭据" },
  ];
  return (
    <section className={styles.authPanel} aria-label="MCP 鉴权">
      <h4>鉴权</h4>
      <div className={styles.segmented} role="radiogroup" aria-label="MCP 鉴权方式">
        {authOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={form.authType === option.value}
            data-active={form.authType === option.value ? "true" : "false"}
            disabled={busy || option.disabled}
            onClick={() => update("authType", option.value)}
          >
            <strong>{option.label}</strong>
            <span>{option.description}</span>
          </button>
        ))}
      </div>

      {form.authType === "none" ? (
        <p className={styles.mutedText}>保存后会清除此服务器已保存的鉴权配置引用。</p>
      ) : null}

      {form.authType === "header_token" ? (
        <div className={styles.fieldStack}>
          <KeyValueEditor
            title="固定请求头"
            addLabel="添加请求头"
            rows={form.headerRows}
            disabled={busy}
            keyPlaceholder="X-Api-Key"
            valuePlaceholder="值或密钥引用"
            existingKeys={existingKeys.headers}
            replaceExisting={form.replaceHeaders}
            onReplaceExistingChange={(checked) => update("replaceHeaders", checked)}
            onChange={(rows) => update("headerRows", rows)}
          />
          <KeyValueEditor
            title="来自环境变量的请求头"
            addLabel="添加变量请求头"
            rows={form.envHeaderRows}
            disabled={busy}
            keyPlaceholder="Authorization"
            valuePlaceholder="MCP_TOKEN_ENV"
            existingKeys={existingKeys.envHeaders}
            replaceExisting={form.replaceEnvHeaders}
            onReplaceExistingChange={(checked) => update("replaceEnvHeaders", checked)}
            onChange={(rows) => update("envHeaderRows", rows)}
          />
          <SecretRefsEditor
            rows={form.secretRefRows}
            disabled={busy}
            existingKeys={existingKeys.secretRefs}
            replaceSecretRefs={form.replaceSecretRefs}
            clearSecretRefs={form.clearSecretRefs}
            onReplaceChange={(checked) => {
              update("replaceSecretRefs", checked);
              if (checked) {
                update("clearSecretRefs", false);
              }
            }}
            onClearChange={(checked) => {
              update("clearSecretRefs", checked);
              if (checked) {
                update("replaceSecretRefs", false);
              }
            }}
            onChange={(rows) => update("secretRefRows", rows)}
          />
        </div>
      ) : null}

      {form.authType === "bearer_env" ? (
        <label className={styles.field}>
          <span>Bearer 令牌环境变量</span>
          <input
            aria-label="Bearer 令牌环境变量"
            disabled={busy}
            value={form.bearerTokenEnvVar}
            placeholder="MCP_BEARER_TOKEN"
            onChange={(event) => update("bearerTokenEnvVar", event.target.value)}
          />
        </label>
      ) : null}

      {form.authType === "oauth" ? (
        <OAuthFields
          form={form}
          busy={busy}
          oauthStatus={oauthStatus}
          oauthLoading={oauthLoading}
          oauthError={oauthError}
          oauthAuthUrl={oauthAuthUrl}
          oauthCopyState={oauthCopyState}
          canStartOAuth={canStartOAuth}
          update={update}
          onRefreshOAuth={onRefreshOAuth}
          onStartOAuth={onStartOAuth}
          onClearOAuth={onClearOAuth}
          onCopyOAuthUrl={onCopyOAuthUrl}
        />
      ) : null}
    </section>
  );
}

function SecretRefsEditor({
  rows,
  disabled,
  existingKeys,
  replaceSecretRefs,
  clearSecretRefs,
  onReplaceChange,
  onClearChange,
  onChange,
}: {
  rows: KeyValueRow[];
  disabled: boolean;
  existingKeys: string[];
  replaceSecretRefs: boolean;
  clearSecretRefs: boolean;
  onReplaceChange: (checked: boolean) => void;
  onClearChange: (checked: boolean) => void;
  onChange: (rows: KeyValueRow[]) => void;
}) {
  return (
    <div className={styles.secretBox}>
      <div className={styles.secretHeader}>
        <span>密钥引用</span>
        {existingKeys.length ? <small>已配置：{existingKeys.join(", ")}</small> : <small>未配置密钥引用</small>}
      </div>
      {existingKeys.length ? (
        <div className={styles.secretActions}>
          <label>
            <input
              type="checkbox"
              checked={replaceSecretRefs}
              disabled={disabled}
              onChange={(event) => onReplaceChange(event.target.checked)}
            />
            <span>替换</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={clearSecretRefs}
              disabled={disabled}
              onChange={(event) => onClearChange(event.target.checked)}
            />
            <span>清除</span>
          </label>
        </div>
      ) : null}
      {(replaceSecretRefs || !existingKeys.length) && !clearSecretRefs ? (
        <KeyValueEditor
          title="密钥引用"
          addLabel="添加密钥引用"
          rows={rows}
          disabled={disabled}
          keyPlaceholder="Authorization"
          valuePlaceholder="mcp/provider/token"
          existingKeys={[]}
          replaceExisting
          onReplaceExistingChange={() => undefined}
          onChange={onChange}
        />
      ) : null}
      {clearSecretRefs ? <p className={styles.mutedText}>保存后会清除已配置的密钥引用。</p> : null}
    </div>
  );
}

function OAuthFields({
  form,
  busy,
  oauthStatus,
  oauthLoading,
  oauthError,
  oauthAuthUrl,
  oauthCopyState,
  canStartOAuth,
  update,
  onRefreshOAuth,
  onStartOAuth,
  onClearOAuth,
  onCopyOAuthUrl,
}: {
  form: FormState;
  busy: boolean;
  oauthStatus: McpOAuthStatusResponse | null;
  oauthLoading: boolean;
  oauthError: string;
  oauthAuthUrl: string;
  oauthCopyState: "idle" | "copied" | "failed";
  canStartOAuth: boolean;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  onRefreshOAuth: () => void;
  onStartOAuth: () => void;
  onClearOAuth: () => void;
  onCopyOAuthUrl: () => void;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  return (
    <div className={styles.fieldStack}>
      <div className={styles.oauthStatus} data-status={oauthStatusCode(oauthStatus, canStartOAuth)}>
        <span>状态</span>
        <strong>{oauthStatusLabel(oauthStatus, canStartOAuth)}</strong>
        {oauthStatus?.account_label ? <span>{oauthStatus.account_label}</span> : null}
        {oauthStatus?.expires_at ? <span>过期时间 {oauthStatus.expires_at}</span> : null}
        {oauthStatus?.scopes?.length ? <span>授权范围 {oauthStatus.scopes.join(", ")}</span> : null}
      </div>
      {oauthError ? <div className={styles.inlineError}>{oauthError}</div> : null}
      <div className={styles.oauthButtons}>
        <button type="button" disabled={busy || oauthLoading} onClick={onStartOAuth}>
          {oauthStatus?.token_configured ? "重新授权" : "登录"}
        </button>
        <button type="button" disabled={busy || oauthLoading || !canStartOAuth} onClick={onRefreshOAuth}>
          刷新状态
        </button>
        <button
          type="button"
          disabled={busy || oauthLoading || !canStartOAuth}
          onClick={() => setConfirmClear(true)}
        >
          清除凭据
        </button>
      </div>
      {confirmClear ? (
        <div className={styles.oauthClearConfirm}>
          <span>确认清除 OAuth 凭据？清除后该服务器需要重新授权。</span>
          <button
            type="button"
            disabled={busy || oauthLoading}
            onClick={() => {
              setConfirmClear(false);
              onClearOAuth();
            }}
          >
            确认清除
          </button>
          <button type="button" disabled={busy || oauthLoading} onClick={() => setConfirmClear(false)}>
            取消
          </button>
        </div>
      ) : null}
      {!canStartOAuth ? <p className={styles.mutedText}>保存 OAuth 配置后可开始登录。</p> : null}
      {oauthAuthUrl ? (
        <div className={styles.oauthUrl}>
          <span title={oauthAuthUrl}>{oauthAuthUrl}</span>
          <button type="button" onClick={onCopyOAuthUrl}>
            {oauthCopyState === "copied" ? "已复制" : oauthCopyState === "failed" ? "复制失败" : "复制 URL"}
          </button>
        </div>
      ) : null}
      <label className={styles.replaceRow}>
        <span>已保存 OAuth 提供方配置时，默认保留原配置。</span>
        <input
          type="checkbox"
          checked={form.replaceOAuthConfig}
          disabled={busy}
          onChange={(event) => update("replaceOAuthConfig", event.target.checked)}
        />
        <strong>替换配置</strong>
      </label>
      {form.replaceOAuthConfig ? (
        <>
          <label className={styles.field}>
            <span>授权地址</span>
            <input
              aria-label="OAuth 授权地址"
              disabled={busy}
              value={form.oauthAuthorizationUrl}
              placeholder="https://provider.example.com/oauth/authorize"
              onChange={(event) => update("oauthAuthorizationUrl", event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>令牌地址</span>
            <input
              aria-label="OAuth 令牌地址"
              disabled={busy}
              value={form.oauthTokenUrl}
              placeholder="https://provider.example.com/oauth/token"
              onChange={(event) => update("oauthTokenUrl", event.target.value)}
            />
          </label>
          <div className={styles.selectGrid}>
            <label className={styles.field}>
              <span>客户端 ID</span>
              <input
                aria-label="OAuth client id"
                disabled={busy}
                value={form.oauthClientId}
                onChange={(event) => update("oauthClientId", event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span>回调地址</span>
              <input
                aria-label="OAuth redirect uri"
                disabled={busy}
                value={form.oauthRedirectUri}
                placeholder="http://127.0.0.1:8765/api/mcp/oauth/callback"
                onChange={(event) => update("oauthRedirectUri", event.target.value)}
              />
            </label>
          </div>
          <div className={styles.selectGrid}>
            <label className={styles.field}>
              <span>资源标识</span>
              <input
                aria-label="OAuth resource"
                disabled={busy}
                value={form.oauthResource}
                placeholder="可选"
                onChange={(event) => update("oauthResource", event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span>授权范围</span>
              <input
                aria-label="OAuth 授权范围"
                disabled={busy}
                value={form.oauthScopes}
                placeholder="read write"
                onChange={(event) => update("oauthScopes", event.target.value)}
              />
            </label>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ArgsEditor({
  args,
  disabled,
  onChange,
}: {
  args: string[];
  disabled: boolean;
  onChange: (args: string[]) => void;
}) {
  const rows = args.length ? args : [""];
  const updateArg = (index: number, value: string) => {
    const next = [...rows];
    next[index] = value;
    onChange(next);
  };
  const removeArg = (index: number) => {
    onChange(rows.filter((_, itemIndex) => itemIndex !== index));
  };
  return (
    <div className={styles.arrayEditor}>
      <div className={styles.editorHeader}>
        <span>参数</span>
        <button type="button" disabled={disabled} onClick={() => onChange([...args, ""])}>
          <Plus size={13} />
          添加参数
        </button>
      </div>
      {rows.map((arg, index) => (
        <div className={styles.arrayRow} key={index}>
          <input
            aria-label={`本地命令参数 ${index + 1}`}
            disabled={disabled}
            value={arg}
            placeholder={index === 0 ? "server.js" : "--flag"}
            onChange={(event) => updateArg(index, event.target.value)}
          />
          <button
            type="button"
            aria-label={`删除本地命令参数 ${index + 1}`}
            disabled={disabled || rows.length === 1}
            onClick={() => removeArg(index)}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <small>参数会逐项传给启动命令，不按整行命令解析。</small>
    </div>
  );
}

function KeyValueEditor({
  title,
  addLabel,
  rows,
  disabled,
  keyPlaceholder,
  valuePlaceholder,
  existingKeys,
  replaceExisting,
  onReplaceExistingChange,
  onChange,
}: {
  title: string;
  addLabel: string;
  rows: KeyValueRow[];
  disabled: boolean;
  keyPlaceholder: string;
  valuePlaceholder: string;
  existingKeys: string[];
  replaceExisting: boolean;
  onReplaceExistingChange: (checked: boolean) => void;
  onChange: (rows: KeyValueRow[]) => void;
}) {
  const effectiveRows = rows.length ? rows : [newRow()];
  const updateRow = (rowId: string, patch: Partial<KeyValueRow>) => {
    onChange(effectiveRows.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
  };
  const removeRow = (rowId: string) => {
    onChange(effectiveRows.filter((row) => row.id !== rowId));
  };
  return (
    <div className={styles.mapEditor}>
      <div className={styles.editorHeader}>
        <span>{title}</span>
        <button type="button" disabled={disabled} onClick={() => onChange([...rows, newRow()])}>
          <Plus size={13} />
          {addLabel}
        </button>
      </div>
      {existingKeys.length ? (
        <label className={styles.replaceRow}>
          <span>
            已保存：{existingKeys.join(", ")}
          </span>
          <input
            type="checkbox"
            checked={replaceExisting}
            disabled={disabled}
            onChange={(event) => onReplaceExistingChange(event.target.checked)}
          />
          <strong>用下方内容替换</strong>
        </label>
      ) : null}
      {effectiveRows.map((row, index) => (
        <div className={styles.mapRow} key={row.id}>
          <input
            aria-label={`${title} 键 ${index + 1}`}
            disabled={disabled || (existingKeys.length > 0 && !replaceExisting)}
            value={row.key}
            placeholder={keyPlaceholder}
            onChange={(event) => updateRow(row.id, { key: event.target.value })}
          />
          <input
            aria-label={`${title} 值 ${index + 1}`}
            disabled={disabled || (existingKeys.length > 0 && !replaceExisting)}
            value={row.value}
            placeholder={valuePlaceholder}
            onChange={(event) => updateRow(row.id, { value: event.target.value })}
          />
          <button
            type="button"
            aria-label={`删除 ${title} ${index + 1}`}
            disabled={disabled || effectiveRows.length === 1 || (existingKeys.length > 0 && !replaceExisting)}
            onClick={() => removeRow(row.id)}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function ToggleRow({
  checked,
  disabled,
  label,
  hint,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  hint: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={styles.toggleRow}>
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function ConnectionTestProgress() {
  return (
    <div className={styles.testProgress} role="status" aria-live="polite" data-testid="mcp-connection-test-progress">
      <LoaderCircle size={16} className={styles.spinning} />
      <span className={styles.testResultText}>
        <strong>正在测试连接</strong>
        <small>正在连接服务器并读取工具列表</small>
      </span>
    </div>
  );
}

function TestResult({ result }: { result: McpConnectionTestResponse }) {
  const capabilities = result.ok ? formatConnectionCapabilities(result) : "";
  const duration = typeof result.duration_ms === "number" ? `耗时 ${result.duration_ms}ms` : "";
  const detail = [capabilities, duration].filter(Boolean).join(" · ");
  return (
    <div className={styles.testResult} data-ok={result.ok ? "true" : "false"} role="status" aria-live="polite">
      {result.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
      <span className={styles.testResultText}>
        <strong>
          {result.ok
            ? `连接测试通过，状态 ${result.status}`
            : result.error?.message || `连接测试失败，状态 ${result.status}`}
        </strong>
        {detail ? <small>{detail}</small> : null}
      </span>
    </div>
  );
}

function formatConnectionCapabilities(result: McpConnectionTestResponse): string {
  const capabilities = result.capabilities;
  if (!capabilities) {
    return "";
  }
  const boolLabel = (key: string) => (capabilities[key] === true ? "支持" : "未支持");
  const toolLabel = typeof result.tools_count === "number"
    ? `工具：${result.tools_count} 个`
    : `工具：${boolLabel("tools")}`;
  return [
    toolLabel,
    `资源：${boolLabel("resources_reserved")}`,
  ].join(" · ");
}

function formFromServer(server: McpServerDetailResponse): FormState {
  return {
    ...DEFAULT_FORM,
    name: server.name ?? "",
    transport: server.transport,
    command: server.command ?? "",
    args: server.args?.length ? server.args : [],
    cwd: server.cwd ?? "",
    inheritEnvironment: server.inherit_environment ?? true,
    replaceEnv: false,
    replaceHeaders: false,
    replaceEnvHeaders: false,
    replaceSecretRefs: false,
    clearSecretRefs: false,
    url: server.url ?? "",
    sseUrl: server.sse_url ?? "",
    messageUrl: server.message_url ?? "",
    bearerTokenEnvVar: server.bearer_token_env_var ?? "",
    authType: server.auth_type ?? server.auth?.auth_type ?? "none",
    oauthResource: server.oauth_resource ?? "",
    oauthScopes: (server.oauth_scopes ?? []).join(" "),
    replaceOAuthConfig: !server.oauth_configured,
  };
}

function buildPayload(
  form: FormState,
  options: {
    mode: FormMode;
    includeEnv: boolean;
    includeHeaders: boolean;
    includeEnvHeaders: boolean;
    includeSecretRefs: boolean;
    includeOAuthConfig: boolean;
    simpleRemoteAuth: boolean;
  },
): McpServerCreatePayload {
  const payload: McpServerCreatePayload = {
    name: form.name.trim(),
    transport: form.transport,
  };

  if (form.transport === "stdio") {
    payload.command = form.command.trim();
    payload.args = cleanArray(form.args);
    payload.cwd = cleanOptional(form.cwd);
    payload.inherit_environment = form.inheritEnvironment;
    payload.url = null;
    payload.sse_url = null;
    payload.message_url = null;
    payload.headers = null;
    payload.env_headers = null;
    payload.bearer_token_env_var = null;
    payload.auth_type = "none";
    if (options.includeEnv) {
      payload.env = rowsToRecord(form.envRows);
    }
    payload.secret_refs = null;
    payload.oauth_config = null;
    payload.oauth_resource = null;
    payload.oauth_scopes = null;
    return payload;
  }

  payload.command = null;
  payload.args = [];
  payload.cwd = null;
  payload.env = null;
  payload.inherit_environment = true;

  if (form.transport === "streamable_http") {
    payload.url = form.url.trim();
    payload.sse_url = null;
    payload.message_url = null;
    payload.bearer_token_env_var = cleanOptional(form.bearerTokenEnvVar);
  } else {
    payload.url = null;
    payload.sse_url = form.sseUrl.trim();
    payload.message_url = form.messageUrl.trim();
    payload.bearer_token_env_var = null;
  }

  payload.auth_type = form.authType;

  if (options.simpleRemoteAuth) {
    const headers = rowsToRecord(form.headerRows);
    const envHeaders = rowsToRecord(form.envHeaderRows);
    payload.auth_type = simpleRemoteAuthType(form);
    payload.headers = Object.keys(headers).length ? headers : null;
    payload.env_headers = Object.keys(envHeaders).length ? envHeaders : null;
    payload.secret_refs = null;
    payload.oauth_config = null;
    payload.oauth_resource = null;
    payload.oauth_scopes = null;
    payload.bearer_token_env_var = cleanOptional(form.bearerTokenEnvVar);
    return payload;
  }

  if (form.authType === "none") {
    payload.headers = null;
    payload.env_headers = null;
    payload.secret_refs = null;
    payload.bearer_token_env_var = null;
    payload.oauth_config = null;
    payload.oauth_resource = null;
    payload.oauth_scopes = null;
    return payload;
  }

  if (form.authType === "header_token") {
    payload.bearer_token_env_var = null;
    payload.oauth_config = null;
    payload.oauth_resource = null;
    payload.oauth_scopes = null;
    if (options.includeHeaders) {
      payload.headers = rowsToRecord(form.headerRows);
    }
    if (options.includeEnvHeaders) {
      payload.env_headers = rowsToRecord(form.envHeaderRows);
    }
    if (options.includeSecretRefs) {
      payload.secret_refs = form.clearSecretRefs ? {} : rowsToRecord(form.secretRefRows);
    }
    return payload;
  }

  if (form.authType === "bearer_env") {
    payload.headers = null;
    payload.env_headers = null;
    payload.secret_refs = null;
    payload.oauth_config = null;
    payload.oauth_resource = null;
    payload.oauth_scopes = null;
    payload.bearer_token_env_var = form.bearerTokenEnvVar.trim();
    return payload;
  }

  payload.headers = null;
  payload.env_headers = null;
  payload.secret_refs = null;
  payload.bearer_token_env_var = null;
  if (options.includeOAuthConfig) {
    payload.oauth_config = {
      authorization_url: form.oauthAuthorizationUrl.trim(),
      token_url: form.oauthTokenUrl.trim(),
      client_id: form.oauthClientId.trim(),
      redirect_uri: form.oauthRedirectUri.trim(),
    };
    payload.oauth_resource = cleanOptional(form.oauthResource);
    payload.oauth_scopes = splitWords(form.oauthScopes);
  }
  return payload;
}

function validateForm(
  form: FormState,
  original: McpServerDetailResponse | null,
  mode: FormMode,
): string | null {
  if (!form.name.trim()) {
    return "请填写服务器名称";
  }
  if (form.transport === "stdio" && !form.command.trim()) {
    return "本地命令连接必须填写启动命令";
  }
  if (form.transport === "streamable_http" && !isHttpUrl(form.url)) {
    return "HTTP 连接必须填写有效的服务地址";
  }
  if (form.transport === "sse") {
    if (!isHttpUrl(form.sseUrl)) {
      return "SSE 连接必须填写有效的服务地址";
    }
    if (!isHttpUrl(form.messageUrl)) {
      return "SSE 连接必须填写有效的消息地址";
    }
  }
  if (form.authType === "bearer_env") {
    if (form.transport !== "streamable_http") {
      return "Bearer 令牌仅支持 HTTP 连接";
    }
    if (!isEnvName(form.bearerTokenEnvVar)) {
      return "Bearer 令牌环境变量名不合法";
    }
  }
  if (form.authType === "header_token") {
    const existingHeaderKeys = mode === "edit" ? original?.header_keys ?? [] : [];
    const existingEnvHeaderKeys = mode === "edit" ? original?.env_header_keys ?? [] : [];
    const existingSecretRefKeys = mode === "edit" ? original?.secret_ref_keys ?? original?.auth?.secret_ref_keys ?? [] : [];
    const hasEffectiveHeaders = form.replaceHeaders ? hasRows(form.headerRows) : existingHeaderKeys.length > 0;
    const hasEffectiveEnvHeaders = form.replaceEnvHeaders
      ? hasRows(form.envHeaderRows)
      : existingEnvHeaderKeys.length > 0;
    const hasEffectiveSecretRefs = form.clearSecretRefs
      ? false
      : form.replaceSecretRefs
        ? hasRows(form.secretRefRows)
        : existingSecretRefKeys.length > 0;
    if (!hasEffectiveHeaders && !hasEffectiveEnvHeaders && !hasEffectiveSecretRefs) {
      return "请求头令牌需要至少配置一种请求头或密钥引用";
    }
  }
  if (form.authType === "oauth") {
    const mustConfigureOAuth = mode === "create" || form.replaceOAuthConfig || !original?.oauth_configured;
    if (mustConfigureOAuth) {
      if (!isHttpUrl(form.oauthAuthorizationUrl)) {
        return "OAuth 授权地址必须是有效地址";
      }
      if (!isHttpUrl(form.oauthTokenUrl)) {
        return "OAuth 令牌地址必须是有效地址";
      }
      if (!form.oauthClientId.trim()) {
        return "OAuth 客户端 ID 不能为空";
      }
      if (!isHttpUrl(form.oauthRedirectUri)) {
        return "OAuth 回调地址必须是有效地址";
      }
    }
  }
  const rowError = validateRows(form);
  if (rowError) {
    return rowError;
  }
  return null;
}

function validateRows(form: FormState): string | null {
  const scopes: Array<[string, KeyValueRow[]]> = [];
  if (form.transport === "stdio") {
    scopes.push(["环境变量", form.envRows]);
  }
  if (form.transport === "streamable_http" || form.transport === "sse") {
    scopes.push(["固定请求头", form.headerRows], ["来自环境变量的请求头", form.envHeaderRows]);
  }
  for (const [label, rows] of scopes) {
    for (const row of rows) {
      if (!row.key.trim() && !row.value.trim()) {
        continue;
      }
      if (!row.key.trim() || !row.value.trim()) {
        return `${label} 必须同时填写键和值`;
      }
    }
  }
  return null;
}

function describeDangerousChanges(original: McpServerDetailResponse, form: FormState): string[] {
  const messages: string[] = [];
  if (original.transport !== form.transport) {
    messages.push(`连接方式将从 ${transportLabel(original.transport)} 改为 ${transportLabel(form.transport)}`);
  }
  if (form.transport === "stdio" && original.command !== form.command.trim()) {
    messages.push("启动命令发生变化，保存后下次连接会启动新的进程命令");
  }
  if (form.transport === "streamable_http" && (original.url ?? "") !== form.url.trim()) {
    messages.push("HTTP 服务地址发生变化，保存后会连接新的远端地址");
  }
  if (form.transport === "sse") {
    if ((original.sse_url ?? "") !== form.sseUrl.trim()) {
      messages.push("SSE 服务地址发生变化，保存后会连接新的事件流地址");
    }
    if ((original.message_url ?? "") !== form.messageUrl.trim()) {
      messages.push("SSE 消息地址发生变化，保存后会发送到新的消息地址");
    }
  }
  if (form.authType === "none" && (original.auth_type ?? original.auth?.auth_type) !== "none") {
    messages.push("鉴权方式将改为无鉴权，并清除已保存的鉴权配置引用");
  }
  if (form.clearSecretRefs) {
    messages.push("已保存的密钥引用将被清除");
  }
  return messages;
}

function rowsToRecord(rows: KeyValueRow[]): Record<string, string> {
  const entries = rows
    .map((row) => [row.key.trim(), row.value.trim()] as const)
    .filter(([key, value]) => key && value);
  return Object.fromEntries(entries);
}

function hasRows(rows: KeyValueRow[]): boolean {
  return rows.some((row) => row.key.trim() && row.value.trim());
}

function simpleRemoteAuthType(form: FormState): McpAuthType {
  if (form.bearerTokenEnvVar.trim()) {
    return "bearer_env";
  }
  if (hasRows(form.headerRows) || hasRows(form.envHeaderRows)) {
    return "header_token";
  }
  return "none";
}

function splitWords(value: string): string[] {
  return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function cleanArray(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function cleanOptional(value: string): string | null {
  const cleaned = value.trim();
  return cleaned ? cleaned : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isEnvName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim());
}

function oauthStatusCode(status: McpOAuthStatusResponse | null, canStartOAuth: boolean): string {
  if (!canStartOAuth) {
    return "not_saved";
  }
  if (!status) {
    return "unknown";
  }
  if (!status.token_configured && status.status === "active") {
    return "expired";
  }
  return status.status || "unknown";
}

function oauthStatusLabel(status: McpOAuthStatusResponse | null, canStartOAuth: boolean): string {
  const code = oauthStatusCode(status, canStartOAuth);
  switch (code) {
    case "active":
      return "已授权";
    case "expired":
      return "已过期";
    case "revoked":
      return "已撤销";
    case "auth_required":
      return "需要授权";
    case "not_saved":
      return "待保存";
    default:
      return "未知";
  }
}

function transportLabel(value: McpTransport): string {
  switch (value) {
    case "stdio":
      return "本地命令";
    case "streamable_http":
      return "HTTP 地址";
    case "sse":
      return "SSE 地址";
    default:
      return value;
  }
}

function newRow(): KeyValueRow {
  return {
    id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
    key: "",
    value: "",
  };
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "MCP 服务器配置保存失败";
}
