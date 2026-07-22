import { lazy, Suspense } from "react";

import { LoadingSkeleton } from "@/renderer/components/loading";
import {
  SubagentInvocationDetail,
  SubagentPanelHeader,
  SubagentRunList,
} from "@/renderer/pages/conversation/subagents/SubagentSidebarPanel";
import { normalizeSubagentRunSnapshot, type SubagentRunSnapshot } from "@/types/subagents";

import layoutStyles from "../../Layout.module.css";
import type { SubagentInvocationPanelDetails } from "../../RightSidebarConversationContext";
import type {
  ConversationPanelQuoteRequest,
  ConversationPanelState,
  JsonObject,
  PanelCreateContext,
  RightSidebarPanelDefinition,
  RightSidebarPanelRenderProps,
} from "../types";

export const CONVERSATION_PANEL_SCHEMA_VERSION = 1 as const;

const CONVERSATION_PANEL_KEYS = [
  "id",
  "kind",
  "schemaVersion",
  "conversationKind",
  "status",
  "sessionId",
  "title",
  "sourceSessionId",
  "parentSessionId",
  "quoteRequest",
  "loadedHistoryTurnCount",
  "subagentRun",
  "subagentInvocation",
  "createdAt",
  "lastActivatedAt",
] as const;

const LazyConversationSessionSurface = lazy(() =>
  import("@/renderer/pages/conversation/ConversationSessionSurface").then((module) => ({
    default: module.ConversationSessionSurface,
  })),
);

export interface ConversationPanelCreateOptions {
  readonly conversationKind?: "conversation" | "subagent";
  readonly status?: "opening" | "ready";
  readonly sessionId?: string;
  readonly title?: string;
  readonly sourceSessionId?: string | null;
  readonly parentSessionId?: string | null;
  readonly quoteRequest?: ConversationPanelQuoteRequest | null;
  readonly loadedHistoryTurnCount?: number | null;
  readonly subagentRun?: SubagentRunSnapshot | null;
  readonly subagentInvocation?: SubagentInvocationPanelDetails | null;
}

export const conversationPanelDefinition = Object.freeze<RightSidebarPanelDefinition<"conversation">>({
  kind: "conversation",
  schemaVersion: CONVERSATION_PANEL_SCHEMA_VERSION,
  label: "旁路对话",
  order: 10,
  multiplicity: "multiple",
  idPrefix: "right-sidebar:conversation:",
  initialActions: [
    { id: "conversation", label: "旁路对话", icon: "message" },
    { id: "subagents", label: "子智能体", icon: "bot" },
  ],
  create(context) {
    return createConversationPanelState(context);
  },
  normalize(raw) {
    return normalizeConversationPanelState(raw);
  },
  serialize(state) {
    return serializeConversationPanelState(state);
  },
  getPresentation(state) {
    return {
      title: state.title || "旁路对话",
      icon: state.conversationKind === "subagent" ? "bot" : "message",
    };
  },
  getCapabilities() {
    return { closable: true, duplicable: false, persistable: true };
  },
  render(props) {
    return <ConversationPanel {...props} />;
  },
});

export function conversationPanelCreateInput(
  options: ConversationPanelCreateOptions,
): JsonObject {
  return {
    conversationKind: options.conversationKind ?? "conversation",
    status: options.status ?? "ready",
    sessionId: options.sessionId ?? "",
    title: options.title ?? "旁路对话",
    sourceSessionId: options.sourceSessionId ?? null,
    parentSessionId: options.parentSessionId ?? null,
    quoteRequest: serializeConversationQuoteRequest(options.quoteRequest ?? null),
    loadedHistoryTurnCount: options.loadedHistoryTurnCount ?? null,
    subagentRun: toJsonObject(options.subagentRun ?? null),
    subagentInvocation: serializeSubagentInvocation(options.subagentInvocation ?? null),
  };
}

export function normalizeConversationPanelState(raw: unknown): ConversationPanelState | null {
  if (!isRecord(raw) || !hasExactKeys(raw, CONVERSATION_PANEL_KEYS)) return null;
  if (raw.kind !== "conversation" || raw.schemaVersion !== CONVERSATION_PANEL_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.title)) return null;
  if (!isNonEmptyString(raw.createdAt) || !isNonEmptyString(raw.lastActivatedAt)) return null;
  if (raw.conversationKind !== "conversation" && raw.conversationKind !== "subagent") return null;
  if (raw.status !== "opening" && raw.status !== "ready") return null;
  if (typeof raw.sessionId !== "string") return null;
  if (!isNullableString(raw.sourceSessionId) || !isNullableString(raw.parentSessionId)) return null;
  if (raw.loadedHistoryTurnCount !== null && !isNonNegativeInteger(raw.loadedHistoryTurnCount)) return null;
  const quoteRequest = normalizeConversationQuoteRequest(raw.quoteRequest);
  if (raw.quoteRequest !== null && !quoteRequest) return null;
  const subagentRun = normalizeSubagentRun(raw.subagentRun);
  if (raw.subagentRun !== null && !subagentRun) return null;
  const subagentInvocation = normalizeSubagentInvocation(raw.subagentInvocation);
  if (raw.subagentInvocation !== null && !subagentInvocation) return null;
  return {
    id: raw.id,
    kind: "conversation",
    schemaVersion: CONVERSATION_PANEL_SCHEMA_VERSION,
    conversationKind: raw.conversationKind,
    status: raw.status,
    sessionId: raw.sessionId,
    title: raw.title,
    sourceSessionId: raw.sourceSessionId,
    parentSessionId: raw.parentSessionId,
    quoteRequest,
    loadedHistoryTurnCount: raw.loadedHistoryTurnCount,
    subagentRun,
    subagentInvocation,
    createdAt: raw.createdAt,
    lastActivatedAt: raw.lastActivatedAt,
  };
}

export function serializeConversationPanelState(state: ConversationPanelState): JsonObject {
  return {
    id: state.id,
    kind: state.kind,
    schemaVersion: state.schemaVersion,
    conversationKind: state.conversationKind,
    status: state.status,
    sessionId: state.sessionId,
    title: state.title,
    sourceSessionId: state.sourceSessionId,
    parentSessionId: state.parentSessionId,
    quoteRequest: serializeConversationQuoteRequest(state.quoteRequest),
    loadedHistoryTurnCount: state.loadedHistoryTurnCount,
    subagentRun: toJsonObject(state.subagentRun),
    subagentInvocation: serializeSubagentInvocation(state.subagentInvocation),
    createdAt: state.createdAt,
    lastActivatedAt: state.lastActivatedAt,
  };
}

function createConversationPanelState(context: PanelCreateContext): ConversationPanelState {
  const input = context.input ?? {};
  return normalizeConversationPanelState({
    id: context.id,
    kind: "conversation",
    schemaVersion: CONVERSATION_PANEL_SCHEMA_VERSION,
    conversationKind: input.conversationKind ?? "conversation",
    status: input.status ?? "ready",
    sessionId: input.sessionId ?? "",
    title: input.title ?? "旁路对话",
    sourceSessionId: input.sourceSessionId ?? null,
    parentSessionId: input.parentSessionId ?? null,
    quoteRequest: input.quoteRequest ?? null,
    loadedHistoryTurnCount: input.loadedHistoryTurnCount ?? null,
    subagentRun: input.subagentRun ?? null,
    subagentInvocation: input.subagentInvocation ?? null,
    createdAt: context.now,
    lastActivatedAt: context.now,
  }) ?? invalidPanelInput();
}

function ConversationPanel({
  active,
  hostContext,
  scopeKey,
  state,
}: RightSidebarPanelRenderProps<"conversation">) {
  return (
    <div
      className={layoutStyles.rightSidebarBody}
      data-content={state.conversationKind === "subagent" ? "subagent" : "conversation"}
      hidden={!active}
    >
      {state.status === "opening" ? (
        <PanelLoading label="正在打开旁路对话" />
      ) : state.conversationKind === "subagent" ? (
        state.subagentRun ? (
          <div className={layoutStyles.subagentPanel}>
            <SubagentPanelHeader
              role={state.subagentRun.role}
              onBack={() => hostContext.onOpenSubagentList(
                state.parentSessionId ?? state.subagentRun?.parent_session_id ?? "",
              )}
            />
            <div className={layoutStyles.subagentConversation}>
              <Suspense fallback={<PanelLoading label="正在加载 Sub-Agent 对话" />}>
                <LazyConversationSessionSurface
                  threadId={state.subagentRun.child_session_id}
                  runtime={hostContext.runtime}
                  mode="sidecar"
                  previewPanelScopeKey={scopeKey}
                  sidecarQuoteRequest={null}
                  sidecarLoadedHistoryTurnCount={null}
                  subagentRun={state.subagentRun}
                  a2uiRenderSuspended={hostContext.a2uiRenderSuspended}
                  onNavigateToConversation={hostContext.onNavigateToConversation}
                  onOpenModelSettings={hostContext.onOpenModelSettings}
                />
              </Suspense>
            </div>
          </div>
        ) : state.subagentInvocation ? (
          <SubagentInvocationDetail
            details={state.subagentInvocation}
            onBack={() => hostContext.onOpenSubagentList(
              state.parentSessionId ?? state.subagentInvocation?.parentSessionId ?? "",
            )}
          />
        ) : (
          <SubagentRunList parentSessionId={state.parentSessionId ?? ""} />
        )
      ) : (
        <Suspense fallback={<PanelLoading label="正在加载旁路对话" />}>
          <LazyConversationSessionSurface
            threadId={state.sessionId}
            runtime={hostContext.runtime}
            mode="sidecar"
            previewPanelScopeKey={scopeKey}
            sidecarQuoteRequest={state.quoteRequest}
            sidecarLoadedHistoryTurnCount={state.loadedHistoryTurnCount}
            subagentRun={state.subagentRun}
            a2uiRenderSuspended={hostContext.a2uiRenderSuspended}
            onSidecarQuoteRequestHandled={(requestId) =>
              hostContext.onQuoteRequestHandled(state.id, requestId)
            }
            onNavigateToConversation={hostContext.onNavigateToConversation}
            onOpenModelSettings={hostContext.onOpenModelSettings}
          />
        </Suspense>
      )}
    </div>
  );
}

function PanelLoading({ label }: { label: string }) {
  return <LoadingSkeleton className={layoutStyles.rightSidebarLoading} label={label} />;
}

function normalizeConversationQuoteRequest(value: unknown): ConversationPanelQuoteRequest | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["requestId", "quote"])) return null;
  if (!isNonNegativeInteger(value.requestId) || !isRecord(value.quote)) return null;
  const quote = value.quote;
  if (!hasExactKeys(quote, ["id", "text", "preview", "source", "comment", "file"])) return null;
  if (!isNonEmptyString(quote.id) || typeof quote.text !== "string" || typeof quote.preview !== "string") return null;
  if (quote.source !== "selection" || !isNullableString(quote.comment)) return null;
  const file = normalizeQuoteFile(quote.file);
  if (quote.file !== null && !file) return null;
  return {
    requestId: value.requestId,
    quote: {
      id: quote.id,
      text: quote.text,
      preview: quote.preview,
      source: "selection",
      ...(quote.comment ? { comment: quote.comment } : {}),
      file,
    },
  };
}

function serializeConversationQuoteRequest(value: ConversationPanelQuoteRequest | null): JsonObject | null {
  if (!value) return null;
  const file = value.quote.file;
  return {
    requestId: value.requestId,
    quote: {
      id: value.quote.id,
      text: value.quote.text,
      preview: value.quote.preview,
      source: "selection",
      comment: value.quote.comment ?? null,
      file: file ? {
        path: file.path,
        name: file.name ?? null,
        lineStart: file.lineStart ?? null,
        lineEnd: file.lineEnd ?? null,
        sourceStart: file.sourceStart ?? null,
        sourceEnd: file.sourceEnd ?? null,
      } : null,
    },
  };
}

function normalizeQuoteFile(value: unknown) {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["path", "name", "lineStart", "lineEnd", "sourceStart", "sourceEnd"])) return null;
  if (!isNonEmptyString(value.path) || !isNullableString(value.name)) return null;
  for (const key of ["lineStart", "lineEnd", "sourceStart", "sourceEnd"] as const) {
    if (value[key] !== null && !isNonNegativeInteger(value[key])) return null;
  }
  return {
    path: value.path,
    name: value.name,
    lineStart: value.lineStart as number | null,
    lineEnd: value.lineEnd as number | null,
    sourceStart: value.sourceStart as number | null,
    sourceEnd: value.sourceEnd as number | null,
  };
}

function normalizeSubagentRun(value: unknown): SubagentRunSnapshot | null {
  if (value === null) return null;
  try {
    return normalizeSubagentRunSnapshot(value);
  } catch {
    return null;
  }
}

function normalizeSubagentInvocation(value: unknown): SubagentInvocationPanelDetails | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, [
    "invocationId", "parentSessionId", "role", "task", "state", "errorCode", "errorMessage",
  ])) return null;
  if (!isNonEmptyString(value.invocationId) || !isNonEmptyString(value.parentSessionId)) return null;
  if (value.role !== "explorer" && value.role !== "worker") return null;
  if (!["queued", "running", "completed", "failed"].includes(String(value.state))) return null;
  if (typeof value.task !== "string" || !isNullableString(value.errorCode) || !isNullableString(value.errorMessage)) return null;
  return {
    invocationId: value.invocationId,
    parentSessionId: value.parentSessionId,
    role: value.role,
    task: value.task,
    state: value.state as SubagentInvocationPanelDetails["state"],
    errorCode: value.errorCode,
    errorMessage: value.errorMessage,
  };
}

function serializeSubagentInvocation(value: SubagentInvocationPanelDetails | null): JsonObject | null {
  return value ? {
    invocationId: value.invocationId,
    parentSessionId: value.parentSessionId,
    role: value.role,
    task: value.task,
    state: value.state,
    errorCode: value.errorCode,
    errorMessage: value.errorMessage,
  } : null;
}

function toJsonObject(value: object | null): JsonObject | null {
  if (!value) return null;
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function invalidPanelInput(): never {
  throw new Error("Invalid conversation panel create input");
}
