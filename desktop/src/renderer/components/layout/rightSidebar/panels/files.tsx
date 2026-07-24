import { lazy, Suspense } from "react";

import { LoadingSkeleton } from "@/renderer/components/loading";
import type {
  PreviewFileRevealTarget,
  PreviewRenderContext,
} from "@/renderer/providers/PreviewProvider";

import layoutStyles from "../../Layout.module.css";
import type {
  FilesPanelState,
  JsonObject,
  PanelCreateContext,
  RightSidebarPanelDefinition,
  RightSidebarPanelRenderProps,
} from "../types";

export const FILES_PANEL_SCHEMA_VERSION = 1 as const;

const FILES_PANEL_KEYS = [
  "id",
  "kind",
  "schemaVersion",
  "filePreviewPath",
  "filePreviewRequestId",
  "filePreviewRevealTarget",
  "directoryRevealPath",
  "directoryRevealRequestId",
  "createdAt",
  "lastActivatedAt",
] as const;

const LazyWorkspaceFileBrowser = lazy(() =>
  import("@/renderer/components/workspace/WorkspaceFileBrowser").then((module) => ({
    default: module.WorkspaceFileBrowser,
  })),
);

export interface FilesPanelCreateOptions {
  readonly path?: string | null;
  readonly requestId?: number;
  readonly revealTarget?: PreviewFileRevealTarget | null;
  readonly directoryRevealPath?: string | null;
}

export const filesPanelDefinition = Object.freeze<RightSidebarPanelDefinition<"files">>({
  kind: "files",
  schemaVersion: FILES_PANEL_SCHEMA_VERSION,
  label: "文件",
  order: 20,
  multiplicity: "multiple",
  idPrefix: "right-sidebar:files:",
  initialActions: [{ id: "files", label: "文件", icon: "folder" }],
  create(context) {
    return createFilesPanelState(context);
  },
  normalize(raw) {
    return normalizeFilesPanelState(raw);
  },
  serialize(state) {
    return serializeFilesPanelState(state);
  },
  getPresentation() {
    return { title: "文件", icon: "folder" };
  },
  getCapabilities() {
    return { closable: true, duplicable: true, persistable: true };
  },
  render(props) {
    return <FilesPanel {...props} />;
  },
});

export function filesPanelCreateInput(options: FilesPanelCreateOptions = {}): JsonObject {
  const hasPath = Object.prototype.hasOwnProperty.call(options, "path");
  const requestId = validRequestId(options.requestId) ? options.requestId : 0;
  return {
    filePreviewPath: hasPath ? options.path ?? null : null,
    filePreviewRequestId: hasPath ? requestId : 0,
    filePreviewRevealTarget: serializeRevealTarget(options.revealTarget ?? null),
    directoryRevealPath: options.directoryRevealPath ?? null,
    directoryRevealRequestId: options.directoryRevealPath ? requestId : 0,
  };
}

export function normalizeFilesPanelState(raw: unknown): FilesPanelState | null {
  if (!isRecord(raw) || !hasExactKeys(raw, FILES_PANEL_KEYS)) return null;
  if (raw.kind !== "files" || raw.schemaVersion !== FILES_PANEL_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.createdAt) || !isNonEmptyString(raw.lastActivatedAt)) {
    return null;
  }
  if (!isNullableString(raw.filePreviewPath) || !isNullableString(raw.directoryRevealPath)) return null;
  if (!isNonNegativeInteger(raw.filePreviewRequestId) || !isNonNegativeInteger(raw.directoryRevealRequestId)) {
    return null;
  }
  const revealTarget = normalizeRevealTarget(raw.filePreviewRevealTarget);
  if (raw.filePreviewRevealTarget !== null && !revealTarget) return null;
  return {
    id: raw.id,
    kind: "files",
    schemaVersion: FILES_PANEL_SCHEMA_VERSION,
    filePreviewPath: raw.filePreviewPath,
    filePreviewRequestId: raw.filePreviewRequestId,
    filePreviewRevealTarget: revealTarget,
    directoryRevealPath: raw.directoryRevealPath,
    directoryRevealRequestId: raw.directoryRevealRequestId,
    createdAt: raw.createdAt,
    lastActivatedAt: raw.lastActivatedAt,
  };
}

export function serializeFilesPanelState(state: FilesPanelState): JsonObject {
  return {
    id: state.id,
    kind: state.kind,
    schemaVersion: state.schemaVersion,
    filePreviewPath: state.filePreviewPath,
    filePreviewRequestId: state.filePreviewRequestId,
    filePreviewRevealTarget: serializeRevealTarget(state.filePreviewRevealTarget),
    directoryRevealPath: state.directoryRevealPath,
    directoryRevealRequestId: state.directoryRevealRequestId,
    createdAt: state.createdAt,
    lastActivatedAt: state.lastActivatedAt,
  };
}

function createFilesPanelState(context: PanelCreateContext): FilesPanelState {
  const input = context.input ?? {};
  const revealTarget = normalizeRevealTarget(input.filePreviewRevealTarget);
  return {
    id: context.id,
    kind: "files",
    schemaVersion: FILES_PANEL_SCHEMA_VERSION,
    filePreviewPath: readNullableString(input.filePreviewPath),
    filePreviewRequestId: readNonNegativeInteger(input.filePreviewRequestId),
    filePreviewRevealTarget: revealTarget,
    directoryRevealPath: readNullableString(input.directoryRevealPath),
    directoryRevealRequestId: readNonNegativeInteger(input.directoryRevealRequestId),
    createdAt: context.now,
    lastActivatedAt: context.now,
  };
}

function FilesPanel({
  hostContext,
  scopeKey,
  state,
  updateState,
}: RightSidebarPanelRenderProps<"files">) {
  const renderContext = hostContext.renderContext;
  const runtime = renderContext.runtime;
  if (!runtime || (!renderContext.sessionId && !renderContext.workspaceId)) {
    return null;
  }
  const onQuoteSelection = renderContext.onQuoteSelection
    ? (request: Parameters<NonNullable<PreviewRenderContext["onQuoteSelection"]>>[0]) => {
        renderContext.onQuoteSelection?.(request);
        if (hostContext.maximized) hostContext.onRestore();
      }
    : undefined;
  return (
    <div className={layoutStyles.rightSidebarBody} data-content="files">
      <Suspense
        fallback={<LoadingSkeleton className={layoutStyles.rightSidebarLoading} label="正在加载文件" />}
      >
        <LazyWorkspaceFileBrowser
          key={`${scopeKey}:${state.id}`}
          label={renderContext.workspaceLabel}
          runtime={runtime}
          workspaceId={renderContext.workspaceId}
          workspaceRootPath={renderContext.workspaceRootPath}
          sessionId={renderContext.sessionId}
          previewPath={state.filePreviewPath}
          previewRequestId={state.filePreviewRequestId}
          previewRevealTarget={state.filePreviewRevealTarget}
          directoryRevealPath={state.directoryRevealPath}
          directoryRevealRequestId={state.directoryRevealRequestId}
          onQuoteSelection={onQuoteSelection}
          onStartChatFromAnnotation={renderContext.onStartChatFromAnnotation}
          onOpenHtmlBrowserPreview={hostContext.onOpenHtmlBrowserPreview}
          onPreviewPathChange={(path) => {
            const next = normalizeFilesPanelState({
              ...serializeFilesPanelState(state),
              filePreviewPath: path,
              filePreviewRequestId: state.filePreviewRequestId + 1,
              filePreviewRevealTarget: null,
            });
            if (next) updateState(next);
          }}
        />
      </Suspense>
    </div>
  );
}

function normalizeRevealTarget(value: unknown): PreviewFileRevealTarget | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  const allowed = new Set([
    "annotationId",
    "selectedText",
    "lineStart",
    "lineEnd",
    "sourceStart",
    "sourceEnd",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (!isOptionalNullableString(value.annotationId) || !isOptionalNullableString(value.selectedText)) return null;
  if (!isOptionalNullableInteger(value.lineStart) || !isOptionalNullableInteger(value.lineEnd)) return null;
  if (!isOptionalNullableInteger(value.sourceStart) || !isOptionalNullableInteger(value.sourceEnd)) return null;
  return {
    annotationId: value.annotationId ?? null,
    selectedText: value.selectedText ?? null,
    lineStart: value.lineStart ?? null,
    lineEnd: value.lineEnd ?? null,
    sourceStart: value.sourceStart ?? null,
    sourceEnd: value.sourceEnd ?? null,
  };
}

function serializeRevealTarget(value: PreviewFileRevealTarget | null): JsonObject | null {
  if (!value) return null;
  return {
    annotationId: value.annotationId ?? null,
    selectedText: value.selectedText ?? null,
    lineStart: value.lineStart ?? null,
    lineEnd: value.lineEnd ?? null,
    sourceStart: value.sourceStart ?? null,
    sourceEnd: value.sourceEnd ?? null,
  };
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

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || isNullableString(value);
}

function isOptionalNullableInteger(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || Number.isInteger(value);
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNonNegativeInteger(value: unknown): number {
  return isNonNegativeInteger(value) ? value : 0;
}

function validRequestId(value: number | undefined): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}
