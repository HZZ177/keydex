import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  MousePointerClick,
  Rows3,
  XCircle,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type {
  A2UIDebugBlockState,
  A2UIDebugLifecycleStatus,
  A2UIInteractionState,
  A2UIObject,
  A2UIRenderKey,
} from "@/types/protocol";

import styles from "./A2UIBlock.module.css";
import { A2ChartBlock } from "./A2ChartBlock";
import { A2ChoiceBlock } from "./A2ChoiceBlock";
import { A2ConfirmBlock } from "./A2ConfirmBlock";
import { A2UIDebugInfoButton } from "./A2UIDebugInfoButton";
import { A2UIDebugPanel } from "./A2UIDebugPanel";
import { A2FormBlock } from "./A2FormBlock";
import { type A2UIStreamPlayerState, useA2UIStreamPlayer } from "./useA2UIStreamPlayer";

export const A2UI_DEBUG_INFO_DEFAULT_VISIBLE = true;

export type A2UISubmitHandler = (
  interactionId: string,
  submitResult: Record<string, unknown>,
  sessionId?: string,
) => Promise<void> | void;

export type A2UICancelHandler = (
  interactionId: string,
  cancelReason?: string | null,
  sessionId?: string,
) => Promise<void> | void;

export interface A2UIBlockProps {
  message: ConversationMessage;
  onSubmit?: A2UISubmitHandler;
  onCancel?: A2UICancelHandler;
  debugInfoEnabled?: boolean;
  children?: ReactNode;
}

export interface ParsedA2UIMessage {
  a2ui: A2UIObject | null;
  debug: A2UIDebugBlockState | null;
  payload: Record<string, unknown>;
  streamPlayer?: A2UIStreamPlayerState;
  interaction: Partial<A2UIInteractionState> | null;
  renderKey: A2UIRenderKey | string;
  mode: string;
  status: A2UIDebugLifecycleStatus | string;
  interactionId: string;
  streamText: string;
  parseError: string;
  historyHydrated: boolean;
}

export function A2UIBlock({ message, onSubmit, onCancel, debugInfoEnabled, children }: A2UIBlockProps) {
  const [debugOpen, setDebugOpen] = useState(false);
  const rawParsed = useMemo(() => parseA2UIMessage(message), [message]);
  const streamPlayer = useA2UIStreamPlayer(rawParsed);
  const parsed = useMemo(
    () => ({
      ...rawParsed,
      payload: streamPlayer.payload,
      streamPlayer,
    }),
    [rawParsed, streamPlayer],
  );
  const title = a2uiTitle(parsed);
  const description = a2uiDescription(parsed);
  const facts = a2uiFacts(parsed);
  const interactiveReady = isInteractionActionable(parsed) && Boolean(onSubmit && onCancel);
  const status = statusView(parsed.status, parsed.interaction);
  const icon = renderKeyIcon(parsed.renderKey, status.tone);
  const content = children ?? renderBuiltInContent(message, parsed, onSubmit, onCancel);
  const showDebugInfo = debugInfoEnabled ?? A2UI_DEBUG_INFO_DEFAULT_VISIBLE;

  return (
    <article
      {...streamPlayer.rootProps}
      className={styles.block}
      data-testid="a2ui-block"
      data-render-key={parsed.renderKey}
      data-mode={parsed.mode}
      data-status={parsed.status}
      data-resume-status={resumeStatus(parsed) || undefined}
      data-interactive-ready={interactiveReady ? "true" : "false"}
      aria-label={`${renderKeyLabel(parsed.renderKey)} A2UI：${title}`}
    >
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
        <div className={styles.titleGroup}>
          <div className={styles.title} title={title}>
            {title}
          </div>
          <div className={styles.meta}>
            <span>{renderKeyLabel(parsed.renderKey)}</span>
            <span>{modeLabel(parsed.mode)}</span>
            {parsed.interactionId ? <span>{parsed.interactionId}</span> : null}
          </div>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.status} data-tone={status.tone} data-testid="a2ui-status">
            {status.showSpinner ? <Loader2 className={styles.spinner} size={12} aria-hidden="true" /> : null}
            {status.label}
          </span>
          {showDebugInfo ? (
            <A2UIDebugInfoButton expanded={debugOpen} onClick={() => setDebugOpen((current) => !current)} />
          ) : null}
        </div>
      </header>

      <div className={styles.body}>
        {content ?? (
          <>
            {description ? <p className={styles.description}>{description}</p> : null}
            {facts.length ? (
              <dl className={styles.factGrid} data-testid="a2ui-payload-summary">
                {facts.map((fact) => (
                  <div className={styles.factItem} key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd title={fact.value}>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {parsed.streamText ? (
              <pre className={styles.streamPreview} data-testid="a2ui-stream-preview">
                {parsed.streamText}
              </pre>
            ) : null}
            {!description && !facts.length && !parsed.streamText ? (
              <div className={styles.empty}>等待 A2UI 数据</div>
            ) : null}
            {parsed.parseError ? <div className={styles.empty}>{parsed.parseError}</div> : null}
          </>
        )}
      </div>
      {showDebugInfo && debugOpen ? (
        <A2UIDebugPanel message={message} parsed={parsed} onClose={() => setDebugOpen(false)} />
      ) : null}
    </article>
  );
}

function renderBuiltInContent(
  message: ConversationMessage,
  parsed: ParsedA2UIMessage,
  onSubmit?: A2UISubmitHandler,
  onCancel?: A2UICancelHandler,
): ReactNode {
  if (parsed.renderKey === "chart") {
    if (parsed.status === "failed") {
      return <A2UIErrorLine message={parsed.parseError} />;
    }
    return <A2ChartBlock parsed={parsed} />;
  }
  if (!parsed.a2ui) {
    if (parsed.status === "failed") {
      return <A2UIErrorLine message={parsed.parseError} />;
    }
    return null;
  }
  if (parsed.status === "failed") {
    return <A2UIErrorLine message={parsed.parseError} />;
  }
  if (parsed.renderKey === "confirm") {
    return <A2ConfirmBlock message={message} parsed={parsed} onSubmit={onSubmit} onCancel={onCancel} />;
  }
  if (parsed.renderKey === "choice") {
    return <A2ChoiceBlock message={message} parsed={parsed} onSubmit={onSubmit} onCancel={onCancel} />;
  }
  if (parsed.renderKey === "form") {
    return <A2FormBlock message={message} parsed={parsed} onSubmit={onSubmit} onCancel={onCancel} />;
  }
  return null;
}

export function parseA2UIMessage(message: ConversationMessage): ParsedA2UIMessage {
  const a2ui = asA2UIObject(message.payload.a2ui) ?? asA2UIObject(asRecord(message.payload.a2uiDebug)?.a2ui);
  const debug = asA2UIDebug(message.payload.a2uiDebug);
  const finalPayload = asRecord(a2ui?.payload) ?? asRecord(debug?.payload) ?? {};
  const interaction =
    asInteraction(a2ui?.interaction) ??
    asInteraction(debug?.interaction) ??
    asInteraction(message.payload.interaction);
  const renderKey =
    a2ui?.render_key ??
    stringValue(debug?.renderKey) ??
    stringValue(message.payload.renderKey) ??
    stringValue(message.payload.render_key) ??
    "unknown";
  const mode = a2ui?.mode ?? stringValue(debug?.mode) ?? "render";
  const status = resolvedA2UIStatus(a2ui, interaction, debug?.status, message.status);
  const streamPayload = asRecord(debug?.parsedArgs);
  const payload = shouldUseStreamPayload(a2ui, status, streamPayload) ? streamPayload : finalPayload;
  const streamText = stringValue(debug?.argsBuffer).trim();
  return {
    a2ui,
    debug,
    payload,
    interaction,
    renderKey,
    mode,
    status,
    interactionId:
      stringValue(interaction?.interaction_id) ||
      stringValue(debug?.interactionId) ||
      stringValue(message.payload.interactionId) ||
      stringValue(message.payload.interaction_id),
    streamText,
    parseError: stringValue(debug?.error) || stringValue(debug?.parseError),
    historyHydrated: message.payload.historyHydrated === true,
  };
}

function A2UIErrorLine({ message }: { message: string }) {
  const text = message ? `A2UI 渲染失败，等待重新生成：${message}` : "A2UI 渲染失败，等待重新生成";
  return (
    <div className={styles.errorLine} data-testid="a2ui-error-line" title={message || undefined}>
      <AlertTriangle size={14} aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

function a2uiTitle(parsed: ParsedA2UIMessage): string {
  return (
    scalarText(parsed.payload.title) ||
    scalarText(parsed.payload.name) ||
    scalarText(parsed.payload.label) ||
    scalarText(parsed.payload.question) ||
    renderKeyLabel(parsed.renderKey)
  );
}

function a2uiDescription(parsed: ParsedA2UIMessage): string {
  return (
    scalarText(parsed.payload.description) ||
    scalarText(parsed.payload.message) ||
    scalarText(parsed.payload.prompt) ||
    scalarText(parsed.payload.subtitle)
  );
}

function a2uiFacts(parsed: ParsedA2UIMessage): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = [];
  addFact(facts, "stream", parsed.a2ui?.stream_id ?? parsed.debug?.streamId);
  addFact(facts, "tool", parsed.a2ui?.tool_call_id ?? parsed.debug?.toolCallId);
  addFact(facts, "trace", parsed.a2ui?.trace_id ?? parsed.debug?.traceId);
  addFact(facts, "turn", parsed.a2ui?.turn_index ?? parsed.debug?.turnIndex);

  for (const [key, value] of Object.entries(parsed.payload)) {
    if (facts.length >= 6) {
      break;
    }
    if (["title", "name", "label", "question", "description", "message", "prompt", "subtitle"].includes(key)) {
      continue;
    }
    addFact(facts, key, value);
  }
  return facts;
}

function addFact(facts: Array<{ label: string; value: string }>, label: string, value: unknown): void {
  const text = previewText(value);
  if (!text) {
    return;
  }
  facts.push({ label, value: text });
}

function statusView(
  status: string,
  interaction: Partial<A2UIInteractionState> | null,
): { label: string; tone: "running" | "pending" | "failed" | "done" | "default"; showSpinner: boolean } {
  const normalized = statusFromInteraction(interaction?.status) || status.toLowerCase();
  const resume = resumeStatusFromInteraction(interaction?.resume_status);
  if (resume === "started" || resume === "deferred") {
    return { label: "继续执行中", tone: "running", showSpinner: true };
  }
  if (resume === "failed") {
    return { label: "失败", tone: "failed", showSpinner: false };
  }
  switch (normalized) {
    case "started":
    case "streaming":
    case "finished":
      return { label: "生成中", tone: "running", showSpinner: true };
    case "waiting_input":
      return { label: "等待输入", tone: "pending", showSpinner: false };
    case "submitted":
      return { label: "已提交", tone: "done", showSpinner: false };
    case "cancelled":
      return { label: "已取消", tone: "default", showSpinner: false };
    case "failed":
    case "missing":
      return { label: "失败", tone: "failed", showSpinner: false };
    case "created":
      return { label: "已生成", tone: "done", showSpinner: false };
    default:
      return { label: "就绪", tone: "default", showSpinner: false };
  }
}

function isInteractionActionable(parsed: ParsedA2UIMessage): boolean {
  return (
    parsed.status === "waiting_input" &&
    Boolean(parsed.interactionId) &&
    parsed.interaction?.can_submit !== false
  );
}

function statusFromInteraction(status: unknown): string {
  const normalized = stringValue(status).toLowerCase();
  if (normalized === "waiting_user_input") {
    return "waiting_input";
  }
  return normalized;
}

function resolvedA2UIStatus(
  a2ui: A2UIObject | null,
  interaction: Partial<A2UIInteractionState> | null,
  debugStatus: unknown,
  messageStatus: unknown,
): string {
  const interactionStatus = statusFromInteraction(interaction?.status);
  if (interactionStatus) {
    return interactionStatus;
  }

  const normalizedDebugStatus = statusFromInteraction(debugStatus);
  if (
    a2ui &&
    (!normalizedDebugStatus ||
      normalizedDebugStatus === "created" ||
      normalizedDebugStatus === "started" ||
      normalizedDebugStatus === "streaming" ||
      normalizedDebugStatus === "finished")
  ) {
    return "created";
  }

  return normalizedDebugStatus || stringValue(messageStatus).toLowerCase() || "created";
}

function shouldUseStreamPayload(
  a2ui: A2UIObject | null,
  status: string,
  streamPayload: Record<string, unknown> | null,
): streamPayload is Record<string, unknown> {
  if (a2ui || !streamPayload) {
    return false;
  }
  const normalized = status.toLowerCase();
  return normalized === "started" || normalized === "streaming" || normalized === "finished";
}

function resumeStatus(parsed: ParsedA2UIMessage): string {
  return resumeStatusFromInteraction(parsed.interaction?.resume_status);
}

function resumeStatusFromInteraction(status: unknown): string {
  return stringValue(status).toLowerCase();
}

function renderKeyIcon(renderKey: string, tone: string) {
  if (tone === "failed") {
    return <AlertTriangle size={15} />;
  }
  if (tone === "done") {
    return <CheckCircle2 size={15} />;
  }
  switch (renderKey) {
    case "chart":
      return <BarChart3 size={15} />;
    case "confirm":
      return <ClipboardCheck size={15} />;
    case "choice":
      return <MousePointerClick size={15} />;
    case "form":
      return <Rows3 size={15} />;
    default:
      return tone === "default" ? <XCircle size={15} /> : <Loader2 size={15} />;
  }
}

function renderKeyLabel(renderKey: string): string {
  switch (renderKey) {
    case "chart":
      return "图表";
    case "confirm":
      return "确认";
    case "choice":
      return "选择";
    case "form":
      return "表单";
    case "unknown":
      return "A2UI";
    default:
      return renderKey;
  }
}

function modeLabel(mode: string): string {
  if (mode === "interactive") {
    return "交互";
  }
  if (mode === "render") {
    return "展示";
  }
  return mode || "展示";
}

function asA2UIObject(value: unknown): A2UIObject | null {
  const record = asRecord(value);
  if (!record || typeof record.render_key !== "string" || typeof record.mode !== "string") {
    return null;
  }
  return record as unknown as A2UIObject;
}

function asA2UIDebug(value: unknown): A2UIDebugBlockState | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return record as unknown as A2UIDebugBlockState;
}

function asInteraction(value: unknown): Partial<A2UIInteractionState> | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return record as Partial<A2UIInteractionState>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function scalarText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }
  return "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function previewText(value: unknown): string {
  const scalar = scalarText(value);
  if (scalar) {
    return scalar.length > 96 ? `${scalar.slice(0, 93)}...` : scalar;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    const text = JSON.stringify(value);
    return text.length > 96 ? `${text.slice(0, 93)}...` : text;
  } catch {
    return String(value);
  }
}
