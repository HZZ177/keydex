import { useEffect, useRef, type ReactNode } from "react";

import type { KeydexDiffDocument } from "../model";
import type {
  KeydexDiffActions,
  KeydexDiffLayout,
  KeydexGitDiffActionStatus,
  KeydexGitHunkActionTarget,
} from "../profiles";
import { KeydexDiffView } from "../KeydexDiffView";
import type { KeydexDiffSelectionRange } from "../selectionBridge";
import { keydexDiffSelectionText } from "../selectionBridge";
import { useKeydexDiffViewController } from "../diffViewController";
import { useKeydexDiffDisplayPreference } from "../diffPreferences";
import styles from "./GitDiffView.module.css";

export type GitDiffActionMode = "stage" | "unstage" | "read_only";

export interface GitDiffViewProps {
  readonly document: KeydexDiffDocument;
  readonly mode: GitDiffActionMode;
  readonly busy?: boolean;
  readonly actionStatus?: KeydexGitDiffActionStatus;
  readonly disabledReason?: string;
  readonly applyPatches?: (patches: readonly string[]) => void | Promise<void>;
  readonly applyHunk?: (target: KeydexGitHunkActionTarget) => void | Promise<void>;
  readonly applySelection?: (selection: KeydexDiffSelectionRange) => void | Promise<void>;
  readonly copyPatch?: KeydexDiffActions["copyPatch"];
  readonly copySelection?: KeydexDiffActions["copySelection"];
  readonly copyPath?: KeydexDiffActions["copyPath"];
  readonly openFile?: KeydexDiffActions["openFile"];
  readonly selectionText?: string;
  readonly preferredLayout?: KeydexDiffLayout;
  readonly wrap?: boolean;
  readonly activeFileId?: string | null;
  readonly onActiveFileChange?: (fileId: string) => void;
  readonly onSelectionChange?: (selection: KeydexDiffSelectionRange | null) => void;
  readonly scrollScopeKey?: string;
  readonly toolbarLeading?: ReactNode;
  readonly embedded?: boolean;
}

export class GitDiffViewContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitDiffViewContractError";
  }
}

export function GitDiffView({
  document,
  mode,
  busy = false,
  actionStatus,
  disabledReason,
  applyPatches,
  applyHunk,
  applySelection,
  copyPatch,
  copySelection,
  copyPath,
  openFile,
  selectionText,
  preferredLayout,
  wrap,
  activeFileId,
  onActiveFileChange,
  onSelectionChange,
  scrollScopeKey = "git",
  toolbarLeading,
  embedded = true,
}: GitDiffViewProps) {
  assertGitDiffViewContract(document, mode, applyPatches);
  const displayPreference = useKeydexDiffDisplayPreference("git", scrollScopeKey);
  const documentLayoutScope = document.files
    .map((file) => `${file.oldPath ?? ""}\u0000${file.newPath ?? ""}\u0000${file.status}`)
    .join("\u0001");
  const documentDefaultLayout = preferredLayout
    ?? (document.files.length > 0 && document.files.every((file) => file.status === "added")
      ? "stacked"
      : displayPreference.preference.layout);
  const previousDocumentLayoutScopeRef = useRef(documentLayoutScope);
  const controller = useKeydexDiffViewController(document, "git", {
    activeFileId,
    layout: documentDefaultLayout,
    wrap: wrap ?? displayPreference.preference.wrap,
    syncScroll: displayPreference.preference.syncScroll,
  });
  const actions: KeydexDiffActions = {
    ...(copyPatch ? { copyPatch } : {}),
    ...(copySelection ? { copySelection } : {}),
    ...(copyPath ? { copyPath } : {}),
    ...(openFile ? { openFile } : {}),
    ...(mode !== "read_only" && applyPatches ? {
      git: {
        mode,
        busy,
        ...(actionStatus ? { status: actionStatus } : {}),
        ...(disabledReason ? { disabledReason } : {}),
        applyPatches,
        ...(applyHunk ? { applyHunk } : {}),
        ...(applySelection ? { applySelection } : {}),
      },
    } : {}),
  };

  useEffect(() => {
    if (activeFileId && activeFileId !== controller.state.activeFileId) {
      controller.setActiveFile(activeFileId);
    }
  }, [activeFileId, controller]);

  useEffect(() => {
    if (previousDocumentLayoutScopeRef.current === documentLayoutScope) return;
    previousDocumentLayoutScopeRef.current = documentLayoutScope;
    controller.setLayout(documentDefaultLayout);
  }, [controller, documentDefaultLayout, documentLayoutScope]);

  const setActiveFile = (fileId: string) => {
    controller.setActiveFile(fileId);
    onActiveFileChange?.(fileId);
  };
  const setSelection = (selection: KeydexDiffSelectionRange | null) => {
    controller.setSelection(selection);
    onSelectionChange?.(selection);
  };
  const setLayout = (layout: KeydexDiffLayout) => {
    controller.setLayout(layout);
    displayPreference.update({ layout });
  };
  const setWrap = (nextWrap: boolean) => {
    controller.setWrap(nextWrap);
    displayPreference.update({ wrap: nextWrap });
  };
  const setSyncScroll = (syncScroll: boolean) => {
    controller.setSyncScroll(syncScroll);
    displayPreference.update({ syncScroll });
  };
  const activeDocumentFile = document.files.find((file) => file.id === controller.state.activeFileId)
    ?? document.files[0];
  const resolvedSelectionText = selectionText ?? (
    activeDocumentFile ? keydexDiffSelectionText(activeDocumentFile, controller.state.selection) : ""
  );

  return (
    <section
      className={styles.wrapper}
      data-keydex-diff-wrapper="git"
      data-git-action-mode={mode}
      data-read-only={mode === "read_only" ? "true" : "false"}
      aria-label={mode === "read_only" ? "只读 Git 差异" : "Git 变更差异"}
    >
      <KeydexDiffView
        document={document}
        profile="git"
        embedded={embedded}
        actions={actions}
        state={{
          layout: controller.state.layout,
          wrap: controller.state.wrap,
          syncScroll: controller.state.syncScroll,
          activeChangeId: controller.state.activeChangeId,
          activeFileId: controller.state.activeFileId,
          expandedFileIds: controller.state.expandedFileIds,
          selection: controller.state.selection,
        }}
        selectionText={resolvedSelectionText}
        scrollScopeKey={`${scrollScopeKey}:${document.id}`}
        loadingAction={controller.state.loadingAction as never}
        onLoadingActionChange={controller.setLoadingAction}
        onSelectionChange={setSelection}
        onActiveFileChange={setActiveFile}
        onExpandedFilesChange={controller.setExpandedFiles}
        onLayoutChange={setLayout}
        onWrapChange={setWrap}
        onSyncScrollChange={setSyncScroll}
        onActiveChangeChange={controller.setActiveChange}
        showFileNavigator={false}
        hiddenToolbarActions={[
          "previous_file",
          "next_file",
          "copy_selection",
          "copy_patch",
          "open_file",
        ]}
        toolbarLeading={toolbarLeading}
      />
    </section>
  );
}

export function assertGitDiffViewContract(
  document: KeydexDiffDocument,
  mode: GitDiffActionMode,
  applyPatches?: (patches: readonly string[]) => void | Promise<void>,
): void {
  if (document.source !== "git") {
    throw new GitDiffViewContractError("Git 写操作只接受 Git 精确差异文档");
  }
  if (mode === "read_only" && applyPatches) {
    throw new GitDiffViewContractError("只读 Git 差异不能接收补丁写回调");
  }
  if (mode !== "read_only" && !applyPatches) {
    throw new GitDiffViewContractError("可写 Git 差异必须由宿主提供补丁写回调");
  }
}
