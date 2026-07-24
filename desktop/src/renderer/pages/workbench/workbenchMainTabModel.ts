import {
  canonicalizeBrowserFileAddress,
  type BrowserTabCreateOptions,
} from "@/renderer/features/browser/domain";

import {
  createWorkbenchBrowserTabState,
  type WorkbenchBrowserTabState,
} from "./workbenchBrowserAdapter";

export interface WorkbenchFileTabIdentity {
  readonly id: string;
  readonly kind: "file";
}

export interface WorkbenchMixedTabState<TFile extends WorkbenchFileTabIdentity> {
  readonly activeTabId: string | null;
  readonly tabs: Array<TFile | WorkbenchBrowserTabState>;
}

export interface OpenWorkbenchBrowserTabInput {
  readonly id: string;
  readonly now: string;
  readonly commandId?: string;
  readonly options?: BrowserTabCreateOptions;
}

export interface OpenWorkbenchBrowserTabResult<TFile extends WorkbenchFileTabIdentity> {
  readonly state: WorkbenchMixedTabState<TFile>;
  readonly tab: WorkbenchBrowserTabState;
  readonly created: boolean;
}

export interface ReloadWorkbenchBrowserTabResult<TFile extends WorkbenchFileTabIdentity> {
  readonly state: WorkbenchMixedTabState<TFile>;
  readonly tab: WorkbenchBrowserTabState | null;
}

export function openWorkbenchBrowserTabState<TFile extends WorkbenchFileTabIdentity>(
  current: WorkbenchMixedTabState<TFile>,
  input: OpenWorkbenchBrowserTabInput,
): OpenWorkbenchBrowserTabResult<TFile> {
  const options = input.options ?? {};
  const previewFile = options.previewFilePath
    ? canonicalizeBrowserFileAddress(options.previewFilePath)
    : null;
  const existing = previewFile
    ? current.tabs.find(
        (tab): tab is WorkbenchBrowserTabState =>
          tab.kind === "browser" && tab.previewFileKey === previewFile.canonicalKey,
      ) ?? null
    : null;
  if (existing && previewFile) {
    const tab: WorkbenchBrowserTabState = {
      ...existing,
      title: fileName(previewFile.windowsPath),
      restoreUrl: previewFile.url,
      restoreUrlSanitized: false,
      lastActivatedAt: input.now,
      ...(input.commandId
        ? {
            navigationCommand: {
              id: input.commandId,
              kind: "navigate" as const,
              source: "app_preview" as const,
              url: previewFile.url,
            },
          }
        : {}),
    };
    return {
      created: false,
      tab,
      state: {
        activeTabId: options.activate === false ? current.activeTabId : tab.id,
        tabs: current.tabs.map((item) => item.id === tab.id ? tab : item),
      },
    };
  }
  const tab = createWorkbenchBrowserTabState({
    id: input.id,
    now: input.now,
    profileMode: options.profileMode,
    restoreUrl: options.restoreUrl ?? previewFile?.url,
    previewFilePath: previewFile?.windowsPath,
  });
  return {
    created: true,
    tab,
    state: {
      activeTabId: options.activate === false ? current.activeTabId : tab.id,
      tabs: [...current.tabs, tab],
    },
  };
}

export function requestWorkbenchAssociatedBrowserReloadState<TFile extends WorkbenchFileTabIdentity>(
  current: WorkbenchMixedTabState<TFile>,
  previewFilePath: string,
  commandId: string,
): ReloadWorkbenchBrowserTabResult<TFile> {
  const previewFile = canonicalizeBrowserFileAddress(previewFilePath);
  const existing = current.tabs.find(
    (tab): tab is WorkbenchBrowserTabState =>
      tab.kind === "browser" && tab.previewFileKey === previewFile.canonicalKey,
  ) ?? null;
  if (!existing) return { state: current, tab: null };
  const tab: WorkbenchBrowserTabState = {
    ...existing,
    navigationCommand: {
      id: commandId,
      kind: "reload",
      source: "file_change",
      url: previewFile.url,
    },
  };
  return {
    tab,
    state: {
      ...current,
      tabs: current.tabs.map((item) => item.id === tab.id ? tab : item),
    },
  };
}

function fileName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() || path;
}

export interface CloseWorkbenchTabResult<TFile extends WorkbenchFileTabIdentity> {
  readonly state: WorkbenchMixedTabState<TFile>;
  readonly closed: TFile | WorkbenchBrowserTabState | null;
}

export function closeWorkbenchTabState<TFile extends WorkbenchFileTabIdentity>(
  current: WorkbenchMixedTabState<TFile>,
  tabId: string,
): CloseWorkbenchTabResult<TFile> {
  const closingIndex = current.tabs.findIndex((tab) => tab.id === tabId);
  if (closingIndex < 0) return { state: current, closed: null };
  const closed = current.tabs[closingIndex] ?? null;
  const tabs = current.tabs.filter((tab) => tab.id !== tabId);
  if (!tabs.length) {
    return {
      closed,
      state: { activeTabId: null, tabs: [] },
    };
  }
  const activeTabId = current.activeTabId === tabId
    ? tabs[Math.max(0, Math.min(closingIndex - 1, tabs.length - 1))]?.id ?? null
    : current.activeTabId;
  return {
    closed,
    state: { activeTabId, tabs },
  };
}

export function disposeWorkbenchBrowserTabOnce(
  disposedRuntimePanelIds: Set<string>,
  runtimePanelId: string,
  dispose: (runtimePanelId: string) => void,
): boolean {
  if (disposedRuntimePanelIds.has(runtimePanelId)) return false;
  disposedRuntimePanelIds.add(runtimePanelId);
  dispose(runtimePanelId);
  return true;
}
