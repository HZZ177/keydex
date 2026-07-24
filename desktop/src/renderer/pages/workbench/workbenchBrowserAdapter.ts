import type {
  BrowserTabCreateOptions,
  BrowserTabHostAdapter,
  BrowserTabState,
} from "@/renderer/features/browser/domain";
import {
  canonicalizeBrowserFileAddress,
  sanitizeBrowserRestoreUrl,
} from "@/renderer/features/browser/domain";
import { composerNewWorkspaceDraftScope } from "@/renderer/features/composer";

export interface WorkbenchBrowserTabState extends BrowserTabState {
  readonly kind: "browser";
  readonly previewFilePath?: string;
  readonly previewFileKey?: string;
}

export interface WorkbenchBrowserAdapterInput {
  readonly workspaceId: string;
  readonly selectedSessionId?: string;
  readonly active: boolean;
  readonly state: WorkbenchBrowserTabState;
  updateState(state: WorkbenchBrowserTabState): void;
  createTab(options?: BrowserTabCreateOptions): void;
  activateTab(tabId: string): void;
  closeTab(tabId: string): void;
}

export function createWorkbenchBrowserAdapter(
  input: WorkbenchBrowserAdapterInput,
): BrowserTabHostAdapter<WorkbenchBrowserTabState> {
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) {
    throw new Error("Workbench browser adapter requires a workspace");
  }
  const selectedSessionId = input.selectedSessionId?.trim();
  return {
    kind: "workbench",
    scopeKey: `workspace:${workspaceId}`,
    composerScopeKey: selectedSessionId
      ? `session:${selectedSessionId}`
      : composerNewWorkspaceDraftScope(workspaceId),
    active: input.active,
    state: input.state,
    updateState: input.updateState,
    createTab: input.createTab,
    activateTab: input.activateTab,
    closeTab: input.closeTab,
  };
}

export function createWorkbenchBrowserTabState(input: {
  readonly id: string;
  readonly now: string;
  readonly profileMode?: "persistent" | "incognito";
  readonly restoreUrl?: string;
  readonly previewFilePath?: string;
}): WorkbenchBrowserTabState {
  const previewFile = input.previewFilePath
    ? canonicalizeBrowserFileAddress(input.previewFilePath)
    : null;
  const requestedRestoreUrl = input.restoreUrl ?? previewFile?.url ?? "";
  const restore = sanitizeBrowserRestoreUrl(requestedRestoreUrl);
  return {
    id: input.id,
    kind: "browser",
    title: previewFile
      ? fileName(previewFile.windowsPath)
      : "新标签页",
    restoreUrl: restore.restoreUrl ?? "",
    restoreUrlSanitized: restore.sanitized,
    profileMode: input.profileMode === "incognito" ? "incognito" : "persistent",
    zoomFactor: 1,
    createdAt: input.now,
    lastActivatedAt: input.now,
    ...(previewFile
      ? {
          previewFilePath: previewFile.windowsPath,
          previewFileKey: previewFile.canonicalKey,
        }
      : {}),
  };
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}
