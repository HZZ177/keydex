import { useEffect, useMemo, useReducer } from "react";

import type { KeydexDiffDocument } from "./model";
import {
  KEYDEX_DIFF_PROFILES,
  type KeydexDiffLayout,
  type KeydexDiffProfileName,
} from "./profiles";
import {
  keydexDiffSelectionMatchesFile,
  type KeydexDiffSelectionRange,
  type KeydexDiffSelectionSide,
} from "./selectionBridge";

export interface KeydexDiffScrollTarget {
  readonly fileId: string;
  readonly line?: number;
  readonly side?: KeydexDiffSelectionSide;
  readonly align?: "start" | "center" | "end" | "nearest";
}

export interface KeydexDiffViewControllerState {
  readonly documentId: string;
  readonly sourceVersion: string;
  readonly fileIds: readonly string[];
  readonly fileCacheKeys: readonly string[];
  readonly profile: KeydexDiffProfileName;
  readonly activeFileId: string | null;
  readonly expandedFileIds: readonly string[];
  readonly layout: KeydexDiffLayout;
  readonly wrap: boolean;
  readonly syncScroll: boolean;
  readonly activeChangeId: string | null;
  readonly selection: KeydexDiffSelectionRange | null;
  readonly scrollTarget: KeydexDiffScrollTarget | null;
  readonly loadingAction: string | null;
}

export type KeydexDiffViewControllerEvent =
  | { readonly type: "sync_document"; readonly document: KeydexDiffDocument; readonly profile: KeydexDiffProfileName }
  | { readonly type: "set_active_file"; readonly fileId: string }
  | { readonly type: "toggle_file"; readonly fileId: string }
  | { readonly type: "set_expanded_files"; readonly fileIds: readonly string[] }
  | { readonly type: "set_layout"; readonly layout: KeydexDiffLayout }
  | { readonly type: "set_wrap"; readonly wrap: boolean }
  | { readonly type: "set_sync_scroll"; readonly syncScroll: boolean }
  | { readonly type: "set_active_change"; readonly changeId: string | null }
  | { readonly type: "set_selection"; readonly selection: KeydexDiffSelectionRange | null }
  | { readonly type: "set_scroll_target"; readonly target: KeydexDiffScrollTarget | null }
  | { readonly type: "set_loading_action"; readonly action: string | null }
  | { readonly type: "reset"; readonly document: KeydexDiffDocument; readonly profile: KeydexDiffProfileName };

export interface KeydexDiffViewController {
  readonly state: KeydexDiffViewControllerState;
  readonly setActiveFile: (fileId: string) => void;
  readonly toggleFile: (fileId: string) => void;
  readonly setExpandedFiles: (fileIds: readonly string[]) => void;
  readonly setLayout: (layout: KeydexDiffLayout) => void;
  readonly setWrap: (wrap: boolean) => void;
  readonly setSyncScroll: (syncScroll: boolean) => void;
  readonly setActiveChange: (changeId: string | null) => void;
  readonly setSelection: (selection: KeydexDiffSelectionRange | null) => void;
  readonly setScrollTarget: (target: KeydexDiffScrollTarget | null) => void;
  readonly setLoadingAction: (action: string | null) => void;
  readonly reset: () => void;
}

export function createKeydexDiffViewControllerState(
  document: KeydexDiffDocument,
  profile: KeydexDiffProfileName,
  initial: Partial<Pick<
    KeydexDiffViewControllerState,
    "activeFileId" | "expandedFileIds" | "layout" | "wrap" | "syncScroll" | "activeChangeId"
  >> = {},
): KeydexDiffViewControllerState {
  const contract = KEYDEX_DIFF_PROFILES[profile];
  const fileIds = new Set(document.files.map((file) => file.id));
  const activeFileId = initial.activeFileId && fileIds.has(initial.activeFileId)
    ? initial.activeFileId
    : document.files[0]?.id ?? null;
  const layout = initial.layout && contract.allowedLayouts.includes(initial.layout)
    ? initial.layout
    : contract.defaultLayout;
  return freezeState({
    documentId: document.id,
    sourceVersion: document.sourceVersion,
    fileIds: document.files.map((file) => file.id),
    fileCacheKeys: document.files.map((file) => file.cacheKey),
    profile,
    activeFileId,
    expandedFileIds: normalizeFileIds(initial.expandedFileIds ?? (activeFileId ? [activeFileId] : []), fileIds),
    layout,
    wrap: initial.wrap ?? contract.defaultWrap,
    syncScroll: contract.syncScroll
      ? initial.syncScroll ?? contract.defaultSyncScroll
      : false,
    activeChangeId: normalizeChangeId(initial.activeChangeId),
    selection: null,
    scrollTarget: null,
    loadingAction: null,
  });
}

export function reduceKeydexDiffViewController(
  state: KeydexDiffViewControllerState,
  event: KeydexDiffViewControllerEvent,
): KeydexDiffViewControllerState {
  if (event.type === "reset") {
    return createKeydexDiffViewControllerState(event.document, event.profile);
  }
  if (event.type === "sync_document") {
    return syncDocument(state, event.document, event.profile);
  }
  const fileIds = new Set(stateFileIds(state));
  if (event.type === "set_active_file") {
    if (!fileIds.has(event.fileId) || event.fileId === state.activeFileId) return state;
    return freezeState({
      ...state,
      activeFileId: event.fileId,
      selection: selectionForFile(state.selection, event.fileId),
      scrollTarget: { fileId: event.fileId, align: "start" },
    });
  }
  if (event.type === "toggle_file") {
    if (!fileIds.has(event.fileId)) return state;
    const expanded = new Set(state.expandedFileIds);
    if (expanded.has(event.fileId)) expanded.delete(event.fileId);
    else expanded.add(event.fileId);
    return freezeState({ ...state, expandedFileIds: Array.from(expanded) });
  }
  if (event.type === "set_expanded_files") {
    return freezeState({
      ...state,
      expandedFileIds: normalizeFileIds(event.fileIds, fileIds),
    });
  }
  if (event.type === "set_layout") {
    if (!KEYDEX_DIFF_PROFILES[state.profile].allowedLayouts.includes(event.layout)) return state;
    return event.layout === state.layout ? state : freezeState({ ...state, layout: event.layout });
  }
  if (event.type === "set_wrap") {
    return event.wrap === state.wrap ? state : freezeState({ ...state, wrap: event.wrap });
  }
  if (event.type === "set_sync_scroll") {
    if (!KEYDEX_DIFF_PROFILES[state.profile].syncScroll) return state;
    return event.syncScroll === state.syncScroll
      ? state
      : freezeState({ ...state, syncScroll: event.syncScroll });
  }
  if (event.type === "set_active_change") {
    const activeChangeId = normalizeChangeId(event.changeId);
    return activeChangeId === state.activeChangeId
      ? state
      : freezeState({ ...state, activeChangeId });
  }
  if (event.type === "set_selection") {
    const selection = validSelection(event.selection, state) ? event.selection : null;
    return freezeState({ ...state, selection: freezeSelection(selection) });
  }
  if (event.type === "set_scroll_target") {
    const target = event.target && fileIds.has(event.target.fileId)
      ? freezeScrollTarget(event.target)
      : null;
    return freezeState({ ...state, scrollTarget: target });
  }
  return freezeState({
    ...state,
    loadingAction: event.action?.trim() || null,
  });
}

export function useKeydexDiffViewController(
  document: KeydexDiffDocument,
  profile: KeydexDiffProfileName,
  initial?: Parameters<typeof createKeydexDiffViewControllerState>[2],
): KeydexDiffViewController {
  const [state, dispatch] = useReducer(
    reduceKeydexDiffViewController,
    undefined,
    () => createKeydexDiffViewControllerState(document, profile, initial),
  );
  useEffect(() => {
    dispatch({ type: "sync_document", document, profile });
  }, [document, profile]);
  return useMemo(() => ({
    state,
    setActiveFile: (fileId: string) => dispatch({ type: "set_active_file", fileId }),
    toggleFile: (fileId: string) => dispatch({ type: "toggle_file", fileId }),
    setExpandedFiles: (fileIds: readonly string[]) => dispatch({ type: "set_expanded_files", fileIds }),
    setLayout: (layout: KeydexDiffLayout) => dispatch({ type: "set_layout", layout }),
    setWrap: (wrap: boolean) => dispatch({ type: "set_wrap", wrap }),
    setSyncScroll: (syncScroll: boolean) => dispatch({ type: "set_sync_scroll", syncScroll }),
    setActiveChange: (changeId: string | null) => dispatch({ type: "set_active_change", changeId }),
    setSelection: (selection: KeydexDiffSelectionRange | null) => dispatch({ type: "set_selection", selection }),
    setScrollTarget: (target: KeydexDiffScrollTarget | null) => dispatch({ type: "set_scroll_target", target }),
    setLoadingAction: (action: string | null) => dispatch({ type: "set_loading_action", action }),
    reset: () => dispatch({ type: "reset", document, profile }),
  }), [document, profile, state]);
}

function syncDocument(
  state: KeydexDiffViewControllerState,
  document: KeydexDiffDocument,
  profile: KeydexDiffProfileName,
): KeydexDiffViewControllerState {
  const nextFileIds = new Set(document.files.map((file) => file.id));
  const sameContent = state.documentId === document.id
    && state.sourceVersion === document.sourceVersion
    && sameStrings(state.fileCacheKeys, document.files.map((file) => file.cacheKey));
  if (sameContent && state.profile === profile) return state;
  const contract = KEYDEX_DIFF_PROFILES[profile];
  const preserveDisplay = state.profile === profile && contract.persistDisplayPreferences;
  const activeFileId = state.activeFileId && nextFileIds.has(state.activeFileId)
    ? state.activeFileId
    : document.files[0]?.id ?? null;
  const selectionFile = document.files.find((file) => (
    state.selection ? keydexDiffSelectionMatchesFile(state.selection, file) : false
  ));
  const contentChanged = !sameContent;
  return freezeState({
    documentId: document.id,
    sourceVersion: document.sourceVersion,
    fileIds: document.files.map((file) => file.id),
    fileCacheKeys: document.files.map((file) => file.cacheKey),
    profile,
    activeFileId,
    expandedFileIds: normalizeFileIds(state.expandedFileIds, nextFileIds),
    layout: preserveDisplay && contract.allowedLayouts.includes(state.layout)
      ? state.layout
      : contract.defaultLayout,
    wrap: preserveDisplay ? state.wrap : contract.defaultWrap,
    syncScroll: contract.syncScroll
      ? preserveDisplay ? state.syncScroll : contract.defaultSyncScroll
      : false,
    activeChangeId: contentChanged ? null : state.activeChangeId,
    selection: contentChanged ? null : selectionFile ? state.selection : null,
    scrollTarget: contentChanged ? null : validScrollTarget(state.scrollTarget, nextFileIds),
    loadingAction: null,
  });
}

function stateFileIds(state: KeydexDiffViewControllerState): string[] {
  return [...state.fileIds];
}

function validSelection(
  selection: KeydexDiffSelectionRange | null,
  state: KeydexDiffViewControllerState,
): boolean {
  if (!selection) return true;
  const index = state.fileCacheKeys.indexOf(selection.anchor.fileCacheKey);
  return index >= 0
    && state.fileIds[index] === selection.anchor.fileId
    && selection.anchor.fileId === selection.focus.fileId
    && selection.anchor.fileCacheKey === selection.focus.fileCacheKey;
}

function selectionForFile(
  selection: KeydexDiffSelectionRange | null,
  fileId: string,
): KeydexDiffSelectionRange | null {
  return selection?.anchor.fileId === fileId ? selection : null;
}

function validScrollTarget(
  target: KeydexDiffScrollTarget | null,
  fileIds: ReadonlySet<string>,
): KeydexDiffScrollTarget | null {
  return target && fileIds.has(target.fileId) ? target : null;
}

function freezeState(state: KeydexDiffViewControllerState): KeydexDiffViewControllerState {
  return Object.freeze({
    ...state,
    fileIds: Object.freeze([...state.fileIds]),
    fileCacheKeys: Object.freeze([...state.fileCacheKeys]),
    expandedFileIds: Object.freeze([...state.expandedFileIds]),
    selection: freezeSelection(state.selection),
    scrollTarget: state.scrollTarget ? freezeScrollTarget(state.scrollTarget) : null,
  });
}

function freezeSelection(
  selection: KeydexDiffSelectionRange | null,
): KeydexDiffSelectionRange | null {
  return selection ? Object.freeze({
    anchor: Object.freeze({ ...selection.anchor }),
    focus: Object.freeze({ ...selection.focus }),
  }) : null;
}

function freezeScrollTarget(target: KeydexDiffScrollTarget): KeydexDiffScrollTarget {
  return Object.freeze({ ...target });
}

function normalizeFileIds(fileIds: readonly string[], available: ReadonlySet<string>): string[] {
  return Array.from(new Set(fileIds.filter((fileId) => available.has(fileId))));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeChangeId(changeId: string | null | undefined): string | null {
  const normalized = changeId?.trim();
  return normalized || null;
}
