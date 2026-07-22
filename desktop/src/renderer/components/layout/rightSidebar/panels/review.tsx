import { AgentReviewDiffPanel } from "@/renderer/components/review/AgentReviewDiffPanel";
import {
  createKeydexDiffDocument,
  type KeydexDiffDocument,
  type KeydexDiffDocumentInput,
} from "@/renderer/components/diff/model";
import {
  normalizeFileReviewChange,
  type FileReviewChange,
} from "@/renderer/utils/fileReview";

import layoutStyles from "../../Layout.module.css";
import type {
  JsonObject,
  PanelCreateContext,
  ReviewPanelState,
  RightSidebarPanelDefinition,
  RightSidebarPanelRenderProps,
} from "../types";

export const REVIEW_PANEL_SCHEMA_VERSION = 1 as const;

const REVIEW_PANEL_KEYS = [
  "id",
  "kind",
  "schemaVersion",
  "title",
  "files",
  "document",
  "focusedPath",
  "panelKey",
  "sourceMessageId",
  "toolCallId",
  "requestId",
  "createdAt",
  "lastActivatedAt",
] as const;

export interface ReviewPanelCreateOptions {
  readonly title?: string;
  readonly files?: readonly FileReviewChange[];
  readonly document?: KeydexDiffDocument | null;
  readonly focusedPath?: string | null;
  readonly panelKey?: string;
  readonly sourceMessageId?: string | null;
  readonly toolCallId?: string | null;
  readonly requestId?: number;
}

export const reviewPanelDefinition = Object.freeze<RightSidebarPanelDefinition<"review">>({
  kind: "review",
  schemaVersion: REVIEW_PANEL_SCHEMA_VERSION,
  label: "审阅",
  order: 30,
  multiplicity: "multiple",
  idPrefix: "right-sidebar:review:",
  initialActions: [{ id: "review", label: "审阅", icon: "review" }],
  create(context) {
    return createReviewPanelState(context);
  },
  normalize(raw) {
    return normalizeReviewPanelState(raw);
  },
  serialize(state) {
    return serializeReviewPanelState(state);
  },
  getPresentation(state) {
    return { title: state.title || "审阅", icon: "review" };
  },
  getCapabilities() {
    return { closable: true, duplicable: true, persistable: true };
  },
  render(props) {
    return <ReviewPanel {...props} />;
  },
});

export function reviewPanelCreateInput(options: ReviewPanelCreateOptions): JsonObject {
  return {
    title: options.title ?? "审阅",
    files: toJsonArray(options.files ?? []),
    document: toJsonObject(options.document ?? null),
    focusedPath: options.focusedPath ?? null,
    panelKey: options.panelKey ?? "review",
    sourceMessageId: options.sourceMessageId ?? null,
    toolCallId: options.toolCallId ?? null,
    requestId: options.requestId ?? 0,
  };
}

export function normalizeReviewPanelState(raw: unknown): ReviewPanelState | null {
  if (!isRecord(raw) || !hasExactKeys(raw, REVIEW_PANEL_KEYS)) return null;
  if (raw.kind !== "review" || raw.schemaVersion !== REVIEW_PANEL_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.title) || !isNonEmptyString(raw.panelKey)) return null;
  if (!isNonEmptyString(raw.createdAt) || !isNonEmptyString(raw.lastActivatedAt)) return null;
  if (!isNullableString(raw.focusedPath) || !isNullableString(raw.sourceMessageId) || !isNullableString(raw.toolCallId)) return null;
  if (!isNonNegativeInteger(raw.requestId) || !Array.isArray(raw.files)) return null;
  const files = normalizeReviewFiles(raw.files);
  if (!files) return null;
  const document = normalizeReviewDocument(raw.document);
  if (raw.document !== null && !document) return null;
  return {
    id: raw.id,
    kind: "review",
    schemaVersion: REVIEW_PANEL_SCHEMA_VERSION,
    title: raw.title,
    files,
    document,
    focusedPath: raw.focusedPath,
    panelKey: raw.panelKey,
    sourceMessageId: raw.sourceMessageId,
    toolCallId: raw.toolCallId,
    requestId: raw.requestId,
    createdAt: raw.createdAt,
    lastActivatedAt: raw.lastActivatedAt,
  };
}

export function serializeReviewPanelState(state: ReviewPanelState): JsonObject {
  return {
    id: state.id,
    kind: state.kind,
    schemaVersion: state.schemaVersion,
    title: state.title,
    files: toJsonArray(state.files),
    document: toJsonObject(state.document),
    focusedPath: state.focusedPath,
    panelKey: state.panelKey,
    sourceMessageId: state.sourceMessageId,
    toolCallId: state.toolCallId,
    requestId: state.requestId,
    createdAt: state.createdAt,
    lastActivatedAt: state.lastActivatedAt,
  };
}

function createReviewPanelState(context: PanelCreateContext): ReviewPanelState {
  const input = context.input ?? {};
  return normalizeReviewPanelState({
    id: context.id,
    kind: "review",
    schemaVersion: REVIEW_PANEL_SCHEMA_VERSION,
    title: input.title ?? "审阅",
    files: input.files ?? [],
    document: input.document ?? null,
    focusedPath: input.focusedPath ?? null,
    panelKey: input.panelKey ?? "review",
    sourceMessageId: input.sourceMessageId ?? null,
    toolCallId: input.toolCallId ?? null,
    requestId: input.requestId ?? 0,
    createdAt: context.now,
    lastActivatedAt: context.now,
  }) ?? invalidPanelInput();
}

function ReviewPanel({
  hostContext,
  scopeKey,
  state,
  updateState,
}: RightSidebarPanelRenderProps<"review">) {
  return (
    <div className={layoutStyles.rightSidebarBody} data-content="review">
      <AgentReviewDiffPanel
        files={state.files}
        document={state.document}
        focusedPath={state.focusedPath}
        title={state.title}
        scopeKey={`${scopeKey}:${state.id}`}
        onFocusPath={(path) => {
          const next = normalizeReviewPanelState({
            ...serializeReviewPanelState(state),
            focusedPath: path,
          });
          if (next) updateState(next);
        }}
        onOpenFile={hostContext.onOpenFile}
      />
    </div>
  );
}

function normalizeReviewFiles(value: unknown[]): FileReviewChange[] | null {
  const files: FileReviewChange[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isNonEmptyString(item.path)) return null;
    files.push(normalizeFileReviewChange(item));
  }
  return files;
}

function normalizeReviewDocument(value: unknown): KeydexDiffDocument | null {
  if (value === null) return null;
  if (!isRecord(value) || !isNonEmptyString(value.id) || !Array.isArray(value.files)) return null;
  try {
    return createKeydexDiffDocument(value as KeydexDiffDocumentInput);
  } catch {
    return null;
  }
}

function toJsonArray(value: readonly object[]): JsonObject[] {
  return JSON.parse(JSON.stringify(value)) as JsonObject[];
}

function toJsonObject(value: object | null): JsonObject | null {
  return value ? JSON.parse(JSON.stringify(value)) as JsonObject : null;
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
  throw new Error("Invalid review panel create input");
}
