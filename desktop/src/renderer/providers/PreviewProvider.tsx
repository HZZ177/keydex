import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PropsWithChildren } from "react";

import type { RuntimeBridge } from "@/runtime";
import type { FileReviewChange } from "@/renderer/utils/fileReview";

import { evictFileMarkdownRuntimeEntry } from "@/renderer/components/workspace/fileMarkdownRuntime";

import type { PreviewMarkdownViewDescriptor, PreviewRequest } from "./previewTypes";

const MAX_PREVIEW_ENTRIES = 8;
const GLOBAL_PREVIEW_SCOPE = "global";

export interface PreviewRenderContext {
  panelScopeKey?: string;
  workspaceId?: string;
  workspaceRootPath?: string;
  sessionId?: string;
  workspaceAvailable?: boolean;
  workspaceLabel?: string;
  runtime?: RuntimeBridge;
  onQuoteSelection?: (request: PreviewQuoteSelectionRequest) => void;
  onStartChatFromAnnotation?: (request: PreviewAnnotationChatRequest | PreviewAnnotationChatRequest[]) => void;
}

export interface PreviewQuoteSelectionRequest {
  path: string;
  selectedText: string;
  comment?: string;
  lineStart?: number | null;
  lineEnd?: number | null;
  sourceStart?: number | null;
  sourceEnd?: number | null;
}

export interface PreviewFileRevealTarget {
  annotationId?: string | null;
  selectedText?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  sourceStart?: number | null;
  sourceEnd?: number | null;
}

export interface PreviewAnnotationChatRequest {
  annotationId: string;
  body?: string;
  kind?: "document" | "text";
  path: string;
  workspaceId: string;
}

export interface PreviewEntry {
  id: string;
  scopeKey: string;
  request: PreviewRequest;
  title: string;
  sourceLabel: string;
  openedAt: number;
  renderContext: PreviewRenderContext | null;
  revealTarget: PreviewFileRevealTarget | null;
  markdownView: PreviewMarkdownViewDescriptor;
}

export interface FilePanelRequest {
  requestId: number;
  scopeKey: string;
  path: string | null;
  directoryRevealPath: string | null;
  revealTarget: PreviewFileRevealTarget | null;
  renderContext: PreviewRenderContext | null;
}

export interface OpenReviewPanelRequest {
  files?: FileReviewChange[];
  focusedPath?: string | null;
  panelKey?: string | null;
  sourceMessageId?: string | null;
  title?: string | null;
  toolCallId?: string | null;
}

export interface ReviewPanelRequest {
  requestId: number;
  scopeKey: string;
  files: FileReviewChange[];
  focusedPath: string | null;
  panelKey: string;
  sourceMessageId: string | null;
  title: string;
  toolCallId: string | null;
  renderContext: PreviewRenderContext | null;
}

export interface PreviewState {
  open: boolean;
  panelOpen: boolean;
  panelActiveEntryId: string | null;
  collapseRequestId: number;
  request: PreviewRequest | null;
  targetPath: string | null;
  entries: PreviewEntry[];
  activeEntryId: string | null;
  hostContext: PreviewRenderContext | null;
  filePanelRequest: FilePanelRequest | null;
  reviewPanelRequest: ReviewPanelRequest | null;
}

export interface PreviewContextValue extends PreviewState {
  activeEntry: PreviewEntry | null;
  activeRenderContext: PreviewRenderContext | null;
  activeScopeKey: string;
  openPreview(
    request: PreviewRequest | string,
    renderContext?: PreviewRenderContext,
    revealTarget?: PreviewFileRevealTarget | null,
  ): void;
  openFilePanel(path?: string | null, renderContext?: PreviewRenderContext, revealTarget?: PreviewFileRevealTarget | null): void;
  openDirectoryPanel(path: string, renderContext?: PreviewRenderContext): void;
  openReviewPanel(request?: OpenReviewPanelRequest, renderContext?: PreviewRenderContext): void;
  togglePreview(
    request: PreviewRequest | string,
    renderContext?: PreviewRenderContext,
    revealTarget?: PreviewFileRevealTarget | null,
  ): void;
  switchPreview(entryId: string): void;
  closePreviewEntry(entryId: string): void;
  closePreview(): void;
  setPreviewPanelOpen(open: boolean, activeEntryId?: string | null): void;
  setPreviewHostContext(context: PreviewRenderContext | null): void;
}

interface PreviewScopeState {
  open: boolean;
  activeEntryId: string | null;
}

interface PreviewStoreState {
  entries: PreviewEntry[];
  scopes: Record<string, PreviewScopeState>;
  hostContext: PreviewRenderContext | null;
  panelOpen: boolean;
  panelActiveEntryId: string | null;
  collapseRequestId: number;
  filePanelRequest: FilePanelRequest | null;
  reviewPanelRequest: ReviewPanelRequest | null;
}

const PreviewContext = createContext<PreviewContextValue | null>(null);

export function PreviewProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<PreviewStoreState>({
    entries: [],
    scopes: {},
    hostContext: null,
    panelOpen: false,
    panelActiveEntryId: null,
    collapseRequestId: 0,
    filePanelRequest: null,
    reviewPanelRequest: null,
  });
  const retainedRuntimeEntriesRef = useRef(new Map<string, PreviewMarkdownViewDescriptor>());

  useEffect(() => {
    const next = new Map(state.entries.map((entry) => [entry.id, entry.markdownView]));
    for (const [entryId, descriptor] of retainedRuntimeEntriesRef.current) {
      if (!next.has(entryId)) evictFileMarkdownRuntimeEntry(descriptor.scopeId, descriptor.entryId);
    }
    retainedRuntimeEntriesRef.current = next;
  }, [state.entries]);

  useEffect(() => () => {
    for (const descriptor of retainedRuntimeEntriesRef.current.values()) {
      evictFileMarkdownRuntimeEntry(descriptor.scopeId, descriptor.entryId);
    }
    retainedRuntimeEntriesRef.current.clear();
  }, []);

  const openPreview = useCallback((
    request: PreviewRequest | string,
    renderContext?: PreviewRenderContext,
    revealTarget: PreviewFileRevealTarget | null = null,
  ) => {
    setState((current) => {
      return openPreviewInStore(current, request, renderContext, revealTarget);
    });
  }, []);

  const openFilePanel = useCallback((
    path: string | null = null,
    renderContext?: PreviewRenderContext,
    revealTarget: PreviewFileRevealTarget | null = null,
  ) => {
    setState((current) => {
      const context = renderContext ?? current.hostContext;
      return {
        ...current,
        hostContext: context ?? current.hostContext,
        filePanelRequest: {
          requestId: (current.filePanelRequest?.requestId ?? 0) + 1,
          scopeKey: previewScopeKey(context),
          path: path || null,
          directoryRevealPath: null,
          revealTarget,
          renderContext: context,
        },
      };
    });
  }, []);

  const openDirectoryPanel = useCallback((path: string, renderContext?: PreviewRenderContext) => {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return;
    }
    setState((current) => {
      const context = renderContext ?? current.hostContext;
      return {
        ...current,
        hostContext: context ?? current.hostContext,
        filePanelRequest: {
          requestId: (current.filePanelRequest?.requestId ?? 0) + 1,
          scopeKey: previewScopeKey(context),
          path: null,
          directoryRevealPath: normalizedPath,
          revealTarget: null,
          renderContext: context,
        },
      };
    });
  }, []);

  const openReviewPanel = useCallback((request: OpenReviewPanelRequest = {}, renderContext?: PreviewRenderContext) => {
    setState((current) => {
      const context = renderContext ?? current.hostContext;
      const files = request.files ?? [];
      const focusedPath = request.focusedPath ?? files[0]?.path ?? null;
      const panelKey = reviewPanelKey(request, files, focusedPath);
      return {
        ...current,
        hostContext: context ?? current.hostContext,
        reviewPanelRequest: {
          requestId: (current.reviewPanelRequest?.requestId ?? 0) + 1,
          scopeKey: previewScopeKey(context),
          files,
          focusedPath,
          panelKey,
          sourceMessageId: request.sourceMessageId ?? null,
          title: request.title?.trim() || "审阅",
          toolCallId: request.toolCallId ?? null,
          renderContext: context,
        },
      };
    });
  }, []);

  const togglePreview = useCallback((
    request: PreviewRequest | string,
    renderContext?: PreviewRenderContext,
    revealTarget: PreviewFileRevealTarget | null = null,
  ) => {
    setState((current) => {
      const normalizedRequest = normalizePreviewRequest(request);
      const context = renderContext ?? current.hostContext;
      const scopeKey = previewScopeKey(context);
      const entry = createPreviewEntry(normalizedRequest, context, scopeKey, revealTarget);
      const scopeState = current.scopes[scopeKey] ?? { open: false, activeEntryId: null };

      if (current.panelOpen && scopeState.open && current.panelActiveEntryId === entry.id) {
        return {
          ...current,
          collapseRequestId: current.collapseRequestId + 1,
        };
      }

      return openPreviewInStore(current, normalizedRequest, context, revealTarget);
    });
  }, []);

  const switchPreview = useCallback((entryId: string) => {
    setState((current) => {
      const entry = current.entries.find((item) => item.id === entryId);
      if (!entry) {
        return current;
      }
      return {
        ...current,
        scopes: {
          ...current.scopes,
          [entry.scopeKey]: {
            open: true,
            activeEntryId: entry.id,
          },
        },
      };
    });
  }, []);

  const closePreviewEntry = useCallback((entryId: string) => {
    setState((current) => {
      const closedEntry = current.entries.find((entry) => entry.id === entryId);
      if (!closedEntry) {
        return current;
      }
      const scopeKey = closedEntry.scopeKey;
      const scopeState = current.scopes[scopeKey] ?? { open: false, activeEntryId: null };
      const scopeEntries = current.entries.filter((entry) => entry.scopeKey === scopeKey);
      const closedIndex = scopeEntries.findIndex((entry) => entry.id === entryId);
      const entries = current.entries.filter((entry) => entry.id !== entryId);
      const remainingScopeEntries = scopeEntries.filter((entry) => entry.id !== entryId);
      if (remainingScopeEntries.length === 0) {
        return {
          ...current,
          entries,
          scopes: {
            ...current.scopes,
            [scopeKey]: {
              open: false,
              activeEntryId: null,
            },
          },
        };
      }
      if (scopeState.activeEntryId !== entryId) {
        return { ...current, entries };
      }
      const nextEntry = remainingScopeEntries[Math.max(0, Math.min(closedIndex - 1, remainingScopeEntries.length - 1))];
      return {
        ...current,
        entries,
        scopes: {
          ...current.scopes,
          [scopeKey]: {
            open: true,
            activeEntryId: nextEntry.id,
          },
        },
      };
    });
  }, []);

  const closePreview = useCallback(() => {
    setState((current) => {
      const scopeKey = previewScopeKey(current.hostContext);
      return {
        ...current,
        scopes: {
          ...current.scopes,
          [scopeKey]: {
            open: false,
            activeEntryId: null,
          },
        },
      };
    });
  }, []);

  const setPreviewPanelOpen = useCallback((open: boolean, activeEntryId: string | null = null) => {
    setState((current) => {
      const panelActiveEntryId = open ? activeEntryId : null;
      if (current.panelOpen === open && current.panelActiveEntryId === panelActiveEntryId) {
        return current;
      }
      return { ...current, panelOpen: open, panelActiveEntryId };
    });
  }, []);

  const setPreviewHostContext = useCallback((context: PreviewRenderContext | null) => {
    setState((current) => {
      if (samePreviewRenderContext(current.hostContext, context)) {
        return current;
      }
      return { ...current, hostContext: context };
    });
  }, []);

  const activeScopeKey = previewScopeKey(state.hostContext);
  const entries = useMemo(
    () => state.entries.filter((entry) => entry.scopeKey === activeScopeKey),
    [activeScopeKey, state.entries],
  );
  const scopeState = state.scopes[activeScopeKey] ?? { open: false, activeEntryId: null };
  const activeEntry = scopeState.open ? (entries.find((entry) => entry.id === scopeState.activeEntryId) ?? null) : null;
  const activeRenderContext = activeEntry?.renderContext ?? state.hostContext;
  const request = activeEntry?.request ?? null;
  const activeEntryId = activeEntry?.id ?? null;
  const targetPath = request ? targetPathForRequest(request) : null;
  const open = Boolean(activeEntry && scopeState.open);

  const value = useMemo<PreviewContextValue>(
    () => ({
      open,
      panelOpen: state.panelOpen,
      panelActiveEntryId: state.panelActiveEntryId,
      collapseRequestId: state.collapseRequestId,
      request,
      targetPath,
      entries,
      activeEntryId,
      hostContext: state.hostContext,
      filePanelRequest: state.filePanelRequest,
      reviewPanelRequest: state.reviewPanelRequest,
      activeEntry,
      activeRenderContext,
      activeScopeKey,
      openPreview,
      openFilePanel,
      openDirectoryPanel,
      openReviewPanel,
      togglePreview,
      switchPreview,
      closePreviewEntry,
      closePreview,
      setPreviewPanelOpen,
      setPreviewHostContext,
    }),
    [
      activeEntryId,
      activeEntry,
      activeRenderContext,
      activeScopeKey,
      closePreview,
      closePreviewEntry,
      entries,
      open,
      openPreview,
      openFilePanel,
      openDirectoryPanel,
      openReviewPanel,
      togglePreview,
      request,
      setPreviewPanelOpen,
      setPreviewHostContext,
      state.collapseRequestId,
      state.hostContext,
      state.filePanelRequest,
      state.reviewPanelRequest,
      state.panelActiveEntryId,
      state.panelOpen,
      switchPreview,
      targetPath,
    ],
  );

  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}

function openPreviewInStore(
  current: PreviewStoreState,
  request: PreviewRequest | string,
  renderContext: PreviewRenderContext | null | undefined,
  revealTarget: PreviewFileRevealTarget | null = null,
): PreviewStoreState {
  const normalizedRequest = normalizePreviewRequest(request);
  const context = renderContext ?? current.hostContext;
  const scopeKey = previewScopeKey(context);
  const entry = createPreviewEntry(normalizedRequest, context, scopeKey, revealTarget);
  const existingEntry = current.entries.find((item) => item.id === entry.id);

  if (existingEntry) {
    const reusedEntry: PreviewEntry = {
      ...entry,
      openedAt: Math.max(entry.openedAt, existingEntry.openedAt + 1),
      markdownView: existingEntry.markdownView,
      request: entry.request.type === "skill-resource" ? entry.request : existingEntry.request,
    };
    return {
      ...current,
      hostContext: context ?? current.hostContext,
      entries: current.entries.map((item) => (item.id === entry.id ? reusedEntry : item)),
      scopes: {
        ...current.scopes,
        [scopeKey]: {
          open: true,
          activeEntryId: reusedEntry.id,
        },
      },
    };
  }

  const retainedEntries = current.entries.filter((item) => item.id !== entry.id);
  const scopeEntries = [...retainedEntries.filter((item) => item.scopeKey === scopeKey), entry].slice(
    -MAX_PREVIEW_ENTRIES,
  );
  const entries = [...retainedEntries.filter((item) => item.scopeKey !== scopeKey), ...scopeEntries];

  return {
    ...current,
    hostContext: context ?? current.hostContext,
    entries,
    scopes: {
      ...current.scopes,
      [scopeKey]: {
        open: true,
        activeEntryId: entry.id,
      },
    },
  };
}

function normalizePreviewRequest(request: PreviewRequest | string): PreviewRequest {
  return typeof request === "string" ? { type: "file", path: request } : request;
}

function createPreviewEntry(
  request: PreviewRequest,
  renderContext: PreviewRenderContext | null,
  scopeKey: string,
  revealTarget: PreviewFileRevealTarget | null,
): PreviewEntry {
  const id = `${scopeKey}:${previewEntryId(request)}`;
  return {
    id,
    scopeKey,
    request,
    title: previewTitle(request),
    sourceLabel: previewSourceLabel(request),
    openedAt: Date.now(),
    renderContext,
    revealTarget,
    markdownView: Object.freeze({
      scopeId: scopeKey,
      entryId: id,
      viewId: "file-preview",
      kind: "preview",
    }),
  };
}

function previewScopeKey(context: PreviewRenderContext | null | undefined): string {
  if (context?.panelScopeKey) {
    return context.panelScopeKey;
  }
  if (context?.sessionId) {
    return `session:${context.sessionId}`;
  }
  if (context?.workspaceId) {
    return `workspace:${context.workspaceId}`;
  }
  return GLOBAL_PREVIEW_SCOPE;
}

function samePreviewRenderContext(left: PreviewRenderContext | null, right: PreviewRenderContext | null): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left?.workspaceId === right?.workspaceId &&
    left?.sessionId === right?.sessionId &&
    left?.panelScopeKey === right?.panelScopeKey &&
    left?.workspaceAvailable === right?.workspaceAvailable &&
    left?.workspaceLabel === right?.workspaceLabel &&
    left?.runtime === right?.runtime &&
    left?.onQuoteSelection === right?.onQuoteSelection &&
    left?.onStartChatFromAnnotation === right?.onStartChatFromAnnotation
  );
}

function previewEntryId(request: PreviewRequest): string {
  if (request.type === "file" || request.type === "local-file") {
    return `file:${request.path}`;
  }
  if (request.type === "diff") {
    return `diff:${request.path}:${hashText(request.diff)}`;
  }
  if (request.type === "skill-resource") {
    return `skill-resource:${request.skillSource}:${request.skillName}:${request.resourcePath}`;
  }
  return `content:${request.contentType}:${request.title}:${hashText(request.content)}`;
}

function previewTitle(request: PreviewRequest): string {
  if (request.type === "content" || request.type === "skill-resource") {
    return request.title;
  }
  return fileName(request.path);
}

function previewSourceLabel(request: PreviewRequest): string {
  if (request.type === "skill-resource") {
    return `Skill · ${request.skillName}/${request.resourcePath}`;
  }
  if (request.type === "content") {
    return request.sourcePath ?? "消息内容";
  }
  return request.path;
}

function targetPathForRequest(request: PreviewRequest): string | null {
  if ("path" in request) {
    return request.path;
  }
  return request.type === "content" ? request.sourcePath ?? null : null;
}

function reviewPanelKey(
  request: OpenReviewPanelRequest,
  files: FileReviewChange[],
  focusedPath: string | null,
): string {
  const explicit = request.panelKey?.trim();
  if (explicit) {
    return explicit;
  }
  const source = request.sourceMessageId?.trim() || request.toolCallId?.trim();
  if (source) {
    return source;
  }
  const paths = files.map((file) => file.path).filter(Boolean).join("|");
  return paths || focusedPath || "manual";
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

export function usePreview() {
  const value = useContext(PreviewContext);
  if (!value) {
    throw new Error("usePreview 必须在 PreviewProvider 内使用");
  }
  return value;
}

export function useOptionalPreview() {
  return useContext(PreviewContext);
}

export type { PreviewContentKind, PreviewRequest } from "./previewTypes";
