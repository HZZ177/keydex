import { createContext, useContext, useMemo, useState } from "react";
import type { PropsWithChildren } from "react";

import type { PreviewRequest } from "./previewTypes";

const MAX_PREVIEW_ENTRIES = 8;

export interface PreviewEntry {
  id: string;
  request: PreviewRequest;
  title: string;
  sourceLabel: string;
  openedAt: number;
}

export interface PreviewState {
  open: boolean;
  request: PreviewRequest | null;
  targetPath: string | null;
  entries: PreviewEntry[];
  activeEntryId: string | null;
}

export interface PreviewContextValue extends PreviewState {
  activeEntry: PreviewEntry | null;
  openPreview(request: PreviewRequest | string): void;
  switchPreview(entryId: string): void;
  closePreviewEntry(entryId: string): void;
  closePreview(): void;
}

const PreviewContext = createContext<PreviewContextValue | null>(null);

export function PreviewProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<PreviewState>({
    open: false,
    request: null,
    targetPath: null,
    entries: [],
    activeEntryId: null,
  });

  const value = useMemo<PreviewContextValue>(
    () => ({
      ...state,
      activeEntry: state.entries.find((entry) => entry.id === state.activeEntryId) ?? null,
      openPreview(request) {
        const normalizedRequest = typeof request === "string" ? { type: "file" as const, path: request } : request;
        const entry = createPreviewEntry(normalizedRequest);
        setState((current) => {
          const entries = [...current.entries.filter((item) => item.id !== entry.id), entry].slice(-MAX_PREVIEW_ENTRIES);
          return {
            open: true,
            request: normalizedRequest,
            targetPath: targetPathForRequest(normalizedRequest),
            entries,
            activeEntryId: entry.id,
          };
        });
      },
      switchPreview(entryId) {
        setState((current) => {
          const entry = current.entries.find((item) => item.id === entryId);
          if (!entry) {
            return current;
          }
          return {
            ...current,
            open: true,
            request: entry.request,
            targetPath: targetPathForRequest(entry.request),
            activeEntryId: entry.id,
          };
        });
      },
      closePreviewEntry(entryId) {
        setState((current) => {
          const closedIndex = current.entries.findIndex((entry) => entry.id === entryId);
          if (closedIndex < 0) {
            return current;
          }
          const entries = current.entries.filter((entry) => entry.id !== entryId);
          if (entries.length === 0) {
            return {
              open: false,
              request: null,
              targetPath: null,
              entries: [],
              activeEntryId: null,
            };
          }
          if (current.activeEntryId !== entryId) {
            return { ...current, entries };
          }
          const nextEntry = entries[Math.max(0, Math.min(closedIndex - 1, entries.length - 1))];
          return {
            open: true,
            request: nextEntry.request,
            targetPath: targetPathForRequest(nextEntry.request),
            entries,
            activeEntryId: nextEntry.id,
          };
        });
      },
      closePreview() {
        setState((current) => ({
          ...current,
          open: false,
          request: null,
          targetPath: null,
          activeEntryId: null,
        }));
      },
    }),
    [state],
  );

  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}

function createPreviewEntry(request: PreviewRequest): PreviewEntry {
  return {
    id: previewEntryId(request),
    request,
    title: previewTitle(request),
    sourceLabel: previewSourceLabel(request),
    openedAt: Date.now(),
  };
}

function previewEntryId(request: PreviewRequest): string {
  if (request.type === "file") {
    return `file:${request.path}`;
  }
  if (request.type === "diff") {
    return `diff:${request.path}:${hashText(request.diff)}`;
  }
  return `content:${request.contentType}:${request.title}:${hashText(request.content)}`;
}

function previewTitle(request: PreviewRequest): string {
  if (request.type === "content") {
    return request.title;
  }
  return fileName(request.path);
}

function previewSourceLabel(request: PreviewRequest): string {
  if (request.type === "content") {
    return request.sourcePath ?? "消息内容";
  }
  return request.path;
}

function targetPathForRequest(request: PreviewRequest): string | null {
  if ("path" in request) {
    return request.path;
  }
  return request.sourcePath ?? null;
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
