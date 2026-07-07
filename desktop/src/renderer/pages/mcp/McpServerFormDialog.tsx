import { AlertCircle, CheckCircle2, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

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
type SaveAction = "save" | "save_test";

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
  action: SaveAction;
  messages: string[];
}

const TRANSPORTS: Array<{ value: McpTransport; label: string; description: string }> = [
  { value: "stdio", label: "stdio", description: "本地进程，通过 command + args 启动" },
  { value: "streamable_http", label: "HTTP", description: "远端 Streamable HTTP MCP endpoint" },
  { value: "sse", label: "SSE", description: "SSE 事件流 + message endpoint" },
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
  const title = effectiveMode === "create" ? "添加 MCP Server" : "编辑 MCP Server";
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

  const requestSave = (action: SaveAction) => {
    setError("");
    setTestResult(null);
    const validationError = validateForm(form, original, effectiveMode);
    if (validationError) {
      setError(validationError);
      return;
    }
    const dangerousChanges = effectiveMode === "edit" && original ? describeDangerousChanges(original, form) : [];
    if (dangerousChanges.length) {
      setPendingConfirmation({ action, messages: dangerousChanges });
      return;
    }
    void save(action);
  };

  const save = async (action: SaveAction) => {
    setSaving(true);
    setTesting(action === "save_test");
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

      if (action === "save_test") {
        const result = await runtime.mcp.testServer(saved.id);
        setTestResult(result);
        try {
          const latest = await runtime.mcp.getServer(saved.id);
          setOriginal(latest);
          setForm(formFromServer(latest));
          onSaved(latest);
        } catch {
          onSaved(saved);
        }
        return;
      }

      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
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
    requestSave("save");
  }

  return (
    <AppDialog
      title={title}
      description="配置 MCP Server 连接"
      placement="right"
      size="drawer"
      backdrop="panel"
      inset="below-titlebar"
      closeLabel="关闭 MCP Server 表单"
      closeOnOverlayClick={false}
      onClose={onClose}
    >
      <form className={styles.form} aria-label={title} onSubmit={submit}>
        {loading ? <div className={styles.loading}>正在加载 MCP Server 配置</div> : null}
        {error ? <div className={styles.error} role="alert">{error}</div> : null}
        {testResult ? <TestResult result={testResult} /> : null}

        <section className={styles.section} aria-labelledby="mcp-server-basic-title">
          <h3 id="mcp-server-basic-title">基础信息</h3>
          <label className={styles.field}>
            <span>名称</span>
            <input
              aria-label="MCP Server 名称"
              autoFocus
              disabled={busy}
              value={form.name}
              placeholder="例如 Filesystem MCP"
              onChange={(event) => update("name", event.target.value)}
            />
          </label>
        </section>

        <section className={styles.section} aria-labelledby="mcp-server-transport-title">
          <h3 id="mcp-server-transport-title">Transport</h3>
          <div className={styles.segmented} data-columns={visibleTransports.length} role="radiogroup" aria-label="MCP transport">
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
                显示 SSE
              </button>
            ) : null}
            {useQuickRemoteAuth ? (
              <button
                className={styles.inlineToolButton}
                type="button"
                disabled={busy}
                onClick={() => setShowAdvancedAuth(true)}
              >
                OAuth / Secret refs
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
              <button type="button" disabled={busy} onClick={() => void save(pendingConfirmation.action)}>
                确认保存
              </button>
              <button type="button" disabled={busy} onClick={() => setPendingConfirmation(null)}>
                取消
              </button>
            </div>
          </section>
        ) : null}

        <footer className={styles.footer}>
          <DialogButton disabled={busy} type="button" onClick={onClose}>
            取消
          </DialogButton>
          <DialogButton disabled={busy} type="button" onClick={() => requestSave("save_test")}>
            {testing ? "测试中" : "保存并测试"}
          </DialogButton>
          <DialogButton tone="primary" disabled={busy} type="submit">
            {saving && !testing ? "保存中" : "保存"}
          </DialogButton>
        </footer>
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
        <span>Command</span>
        <input
          aria-label="stdio command"
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
        <span>CWD</span>
        <input
          aria-label="stdio cwd"
          disabled={busy}
          value={form.cwd}
          placeholder="可选，server 工作目录"
          onChange={(event) => update("cwd", event.target.value)}
        />
      </label>
      <ToggleRow
        checked={form.inheritEnvironment}
        disabled={busy}
        label="继承系统环境变量"
        hint="关闭后只使用下方显式配置的 env"
        onChange={(checked) => update("inheritEnvironment", checked)}
      />
      <KeyValueEditor
        title="Env"
        addLabel="添加 env"
        rows={form.envRows}
        disabled={busy}
        keyPlaceholder="MCP_TOKEN"
        valuePlaceholder="value"
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
        <span>URL</span>
        <input
          aria-label="streamable_http url"
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
          aria-label="sse url"
          disabled={busy}
          value={form.sseUrl}
          placeholder="https://mcp.example.com/sse"
          onChange={(event) => update("sseUrl", event.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span>Message URL</span>
        <input
          aria-label="sse message url"
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
          aria-label="bearer token env"
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
        valuePlaceholder="value 或 secret:ref"
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
    { value: "none", label: "无", description: "不附加鉴权 header" },
    { value: "header_token", label: "Header Token", description: "通过 header/env header/secret ref 注入" },
    {
      value: "bearer_env",
      label: "Bearer Env",
      description: "从环境变量读取 Bearer token",
      disabled: form.transport !== "streamable_http",
    },
    { value: "oauth", label: "OAuth", description: "通过授权流程保存 OAuth token" },
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
        <p className={styles.mutedText}>保存后会清除本 server 的 header token、Bearer Env 和 OAuth 配置引用。</p>
      ) : null}

      {form.authType === "header_token" ? (
        <div className={styles.fieldStack}>
          <KeyValueEditor
            title="Headers"
            addLabel="添加 header"
            rows={form.headerRows}
            disabled={busy}
            keyPlaceholder="X-Api-Key"
            valuePlaceholder="value 或 secret:ref"
            existingKeys={existingKeys.headers}
            replaceExisting={form.replaceHeaders}
            onReplaceExistingChange={(checked) => update("replaceHeaders", checked)}
            onChange={(rows) => update("headerRows", rows)}
          />
          <KeyValueEditor
            title="Env headers"
            addLabel="添加 env header"
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
          <span>Bearer token env</span>
          <input
            aria-label="bearer token env"
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
        <span>Secret refs</span>
        {existingKeys.length ? <small>已配置：{existingKeys.join(", ")}</small> : <small>未配置 secret ref</small>}
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
          title="Secret refs"
          addLabel="添加 secret ref"
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
      {clearSecretRefs ? <p className={styles.mutedText}>保存后会清除已配置 secret refs。</p> : null}
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
      <div className={styles.oauthStatus} data-status={oauthDisplayStatus(oauthStatus, canStartOAuth)}>
        <span>状态</span>
        <strong>{oauthDisplayStatus(oauthStatus, canStartOAuth)}</strong>
        {oauthStatus?.account_label ? <span>{oauthStatus.account_label}</span> : null}
        {oauthStatus?.expires_at ? <span>expires {oauthStatus.expires_at}</span> : null}
        {oauthStatus?.scopes?.length ? <span>scopes {oauthStatus.scopes.join(", ")}</span> : null}
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
          <span>确认清除 OAuth 凭据？清除后该 server 会进入需要重新授权的状态。</span>
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
        <span>已保存 OAuth provider config 时，默认保留原配置。</span>
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
            <span>Authorization URL</span>
            <input
              aria-label="OAuth authorization url"
              disabled={busy}
              value={form.oauthAuthorizationUrl}
              placeholder="https://provider.example.com/oauth/authorize"
              onChange={(event) => update("oauthAuthorizationUrl", event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>Token URL</span>
            <input
              aria-label="OAuth token url"
              disabled={busy}
              value={form.oauthTokenUrl}
              placeholder="https://provider.example.com/oauth/token"
              onChange={(event) => update("oauthTokenUrl", event.target.value)}
            />
          </label>
          <div className={styles.selectGrid}>
            <label className={styles.field}>
              <span>Client ID</span>
              <input
                aria-label="OAuth client id"
                disabled={busy}
                value={form.oauthClientId}
                onChange={(event) => update("oauthClientId", event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span>Redirect URI</span>
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
              <span>Resource</span>
              <input
                aria-label="OAuth resource"
                disabled={busy}
                value={form.oauthResource}
                placeholder="可选"
                onChange={(event) => update("oauthResource", event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span>Scopes</span>
              <input
                aria-label="OAuth scopes"
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
        <span>Args</span>
        <button type="button" disabled={disabled} onClick={() => onChange([...args, ""])}>
          <Plus size={13} />
          添加 arg
        </button>
      </div>
      {rows.map((arg, index) => (
        <div className={styles.arrayRow} key={index}>
          <input
            aria-label={`stdio arg ${index + 1}`}
            disabled={disabled}
            value={arg}
            placeholder={index === 0 ? "server.js" : "--flag"}
            onChange={(event) => updateArg(index, event.target.value)}
          />
          <button
            type="button"
            aria-label={`删除 arg ${index + 1}`}
            disabled={disabled || rows.length === 1}
            onClick={() => removeArg(index)}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <small>Args 会作为数组保存，不按整行 shell 字符串解析。</small>
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
            aria-label={`${title} key ${index + 1}`}
            disabled={disabled || (existingKeys.length > 0 && !replaceExisting)}
            value={row.key}
            placeholder={keyPlaceholder}
            onChange={(event) => updateRow(row.id, { key: event.target.value })}
          />
          <input
            aria-label={`${title} value ${index + 1}`}
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

function TestResult({ result }: { result: McpConnectionTestResponse }) {
  const capabilities = result.ok ? formatConnectionCapabilities(result.capabilities) : "";
  return (
    <div className={styles.testResult} data-ok={result.ok ? "true" : "false"} role="status">
      {result.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
      <span className={styles.testResultText}>
        <strong>
          {result.ok
            ? `连接测试通过，状态 ${result.status}`
            : result.error?.message || `连接测试失败，状态 ${result.status}`}
        </strong>
        {capabilities ? <small>{capabilities}</small> : null}
      </span>
    </div>
  );
}

function formatConnectionCapabilities(capabilities: Record<string, unknown> | undefined): string {
  if (!capabilities) {
    return "";
  }
  const boolLabel = (key: string) => (capabilities[key] === true ? "yes" : "no");
  return [
    `tools: ${boolLabel("tools")}`,
    `resources: ${boolLabel("resources_reserved")}`,
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
    return "请填写 Server 名称";
  }
  if (form.transport === "stdio" && !form.command.trim()) {
    return "stdio transport 必须填写 command";
  }
  if (form.transport === "streamable_http" && !isHttpUrl(form.url)) {
    return "streamable_http transport 必须填写有效的 http(s) URL";
  }
  if (form.transport === "sse") {
    if (!isHttpUrl(form.sseUrl)) {
      return "sse transport 必须填写有效的 SSE URL";
    }
    if (!isHttpUrl(form.messageUrl)) {
      return "sse transport 必须填写有效的 Message URL";
    }
  }
  if (form.authType === "bearer_env") {
    if (form.transport !== "streamable_http") {
      return "Bearer Env 仅支持 streamable_http transport";
    }
    if (!isEnvName(form.bearerTokenEnvVar)) {
      return "Bearer token env 必须是有效环境变量名";
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
      return "Header Token 需要至少配置 headers、env headers 或 secret refs";
    }
  }
  if (form.authType === "oauth") {
    const mustConfigureOAuth = mode === "create" || form.replaceOAuthConfig || !original?.oauth_configured;
    if (mustConfigureOAuth) {
      if (!isHttpUrl(form.oauthAuthorizationUrl)) {
        return "OAuth Authorization URL 必须是有效的 http(s) URL";
      }
      if (!isHttpUrl(form.oauthTokenUrl)) {
        return "OAuth Token URL 必须是有效的 http(s) URL";
      }
      if (!form.oauthClientId.trim()) {
        return "OAuth Client ID 不能为空";
      }
      if (!isHttpUrl(form.oauthRedirectUri)) {
        return "OAuth Redirect URI 必须是有效的 http(s) URL";
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
    scopes.push(["Env", form.envRows]);
  }
  if (form.transport === "streamable_http" || form.transport === "sse") {
    scopes.push(["Headers", form.headerRows], ["Env headers", form.envHeaderRows]);
  }
  for (const [label, rows] of scopes) {
    for (const row of rows) {
      if (!row.key.trim() && !row.value.trim()) {
        continue;
      }
      if (!row.key.trim() || !row.value.trim()) {
        return `${label} 必须同时填写 key 和 value`;
      }
    }
  }
  return null;
}

function describeDangerousChanges(original: McpServerDetailResponse, form: FormState): string[] {
  const messages: string[] = [];
  if (original.transport !== form.transport) {
    messages.push(`Transport 将从 ${original.transport} 改为 ${form.transport}`);
  }
  if (form.transport === "stdio" && original.command !== form.command.trim()) {
    messages.push("stdio command 发生变化，保存后下次连接会启动新的进程命令");
  }
  if (form.transport === "streamable_http" && (original.url ?? "") !== form.url.trim()) {
    messages.push("HTTP URL 发生变化，保存后会连接新的远端 endpoint");
  }
  if (form.transport === "sse") {
    if ((original.sse_url ?? "") !== form.sseUrl.trim()) {
      messages.push("SSE URL 发生变化，保存后会连接新的事件流 endpoint");
    }
    if ((original.message_url ?? "") !== form.messageUrl.trim()) {
      messages.push("Message URL 发生变化，保存后会发送到新的消息 endpoint");
    }
  }
  if (form.authType === "none" && (original.auth_type ?? original.auth?.auth_type) !== "none") {
    messages.push("鉴权方式将改为无鉴权，并清除已保存的 auth 配置引用");
  }
  if (form.clearSecretRefs) {
    messages.push("已保存的 secret refs 将被清除");
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

function oauthDisplayStatus(status: McpOAuthStatusResponse | null, canStartOAuth: boolean): string {
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
  return "MCP Server 配置保存失败";
}
