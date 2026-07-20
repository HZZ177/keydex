import { AlertTriangle, ChevronDown, ChevronRight, FileClock, GitBranch, GitCommitHorizontal, GitPullRequest, History, ListChecks, MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";

import type { ActiveProjectState, GitRepositoryRoot } from "@/renderer/features/git/activeProject";
import type { GitProjectStoreState, GitStoreState, GitToolWindowNavigationIntent, GitToolWindowNavigationRequest } from "@/renderer/features/git/store/gitStore";
import { useOptionalGitController, useOptionalGitRuntime, useOptionalGitStoreSelector } from "@/renderer/providers/GitProvider";
import { useOptionalGitStore } from "@/renderer/providers/GitProvider";
import { useOptionalPreview, type PreviewRenderContext } from "@/renderer/providers/PreviewProvider";
import type { GitBisectSnapshot, GitBlamePage, GitCommandResult, GitCommitDetail, GitCommitSummary, GitCompareResult, GitConflictFile, GitConflictsSnapshot, GitDiffSnapshot, GitLfsSnapshot, GitMergePreview, GitMergeStrategy, GitObjectId, GitRebasePreview, GitRebaseTodoItem, GitReflogPage, GitRepositoryDescriptor, GitRepositoryId, GitResetMode, GitResetPreview, GitRevisionTree, GitStatusSnapshot, GitSubmodulesSnapshot, GitWorktree, GitWorktreesSnapshot } from "@/runtime/gitTypes";
import type { GitCommitCommand, GitConflictActionCommand, GitConflictFileAction, GitHistoryFilters, GitIdentity, GitPatchExport, GitPatchExportMode, GitPushCommand, GitRemoteInfo, GitStashDetail, GitStashEntry, GitStashEntryCommand } from "@/runtime/git";
import { GIT_HISTORY_PAGE_SIZE } from "@/renderer/features/git/performancePolicy";
import { gitOperationErrorMessage, gitUiErrorMessage } from "@/renderer/features/git/errorPresentation";
import { useGitErrorNotificationState } from "@/renderer/features/git/GitNotifications";
import { WorkspaceSelector, type WorkspaceSelectorProps } from "@/renderer/components/workspace";
import { useRafPanelResize } from "@/renderer/components/layout/useRafPanelResize";
import { LoadingSkeleton } from "@/renderer/components/loading";
import {
  GitCommitPushDialog,
  GitConfirmActionDialog,
  GitDialogField,
  GitDialogSummary,
  GitFileDiffDialog,
  GitFormDialog,
  GitRevisionTreeDialog,
  type GitCommitPushTarget,
  type GitPushTagMode,
} from "../dialogs";

import styles from "./GitToolWindow.module.css";
import { GitChangesView } from "./GitChangesView";
import { GitSelectedChangeDiff } from "./GitSelectedChangeDiff";
import { GitReadOnlyDiff } from "./GitReadOnlyDiff";
import { GitCommitEditor, type GitCommitOptions } from "./GitCommitEditor";
import { GitRefsTree, type GitRefAction } from "./GitRefsTree";
import { GitBranchActions } from "./GitBranchActions";
import { GitRemoteManager } from "./GitRemoteManager";
import { GitSyncActions, type GitFetchOptions, type GitPushOptions, type GitUpdateStrategy } from "./GitSyncActions";
import { GitStashView } from "./GitStashView";
import { EMPTY_GIT_HISTORY_FILTERS, GitHistoryView, mergeHistoryPages, type GitHistoryContextAction } from "./GitHistoryView";
import { GitCommitDetailsView } from "./GitCommitDetailsView";
import { GitComparisonView } from "./GitComparisonView";
import { GitBlameView, type GitBlameRequest } from "./GitBlameView";
import { GitReflogView } from "./GitReflogView";
import { GitMergeView } from "./GitMergeView";
import { GitRebaseView } from "./GitRebaseView";
import { GitCherryPickView } from "./GitCherryPickView";
import { GitRevertView } from "./GitRevertView";
import { GitResetRestoreView } from "./GitResetRestoreView";
import { GitPatchExchangeView, patchImportSignature, type GitPatchImportOptions } from "./GitPatchExchangeView";
import { GitOperationRecoveryBanner, type GitRecoveryAction } from "./GitOperationRecoveryBanner";
import { GitConflictOverview } from "./GitConflictOverview";
import { GitThreeWayMergeEditor, parseConflictBlocks, type GitConflictSaveEncoding, type GitConflictSaveEol } from "./GitThreeWayMergeEditor";
import { GitConflictActions } from "./GitConflictActions";
import { GitBisectView } from "./GitBisectView";
import { GitSubmoduleView, type GitSubmoduleAction } from "./GitSubmoduleView";
import { GitWorktreeView, type GitWorktreeAddOptions } from "./GitWorktreeView";
import { GitLfsView, type GitLfsAction } from "./GitLfsView";
import { GitRepositoryList } from "./GitRepositoryList";
import { GitOperationLog } from "./GitOperationLog";
import { commitSelectionFromEntries, gitChangeRollbackPaths, type GitChangeEntry } from "../changesTree";
import { gitDocumentFromFiles } from "@/renderer/components/diff/adapters/gitDocument";
import type { KeydexGitDiffActionStatus } from "@/renderer/components/diff/profiles";
import {
  validateGitPatchActionIdentity,
  resolveGitPatchRefreshTarget,
  type GitPatchActionIdentity,
} from "../diffPatchActions";
import { gitWorkspacePreviewPath } from "../gitDiffFileActions";
import { validateGitBranchName } from "../dialogs";

export type GitToolWindowView = "changes" | "history" | "blame" | "reflog" | "branches" | "stash" | "operations" | "compare";

type PendingMergeDraftDiscard =
  | { kind: "view"; view: GitToolWindowView }
  | { kind: "repository"; repositoryId: GitRepositoryId }
  | { kind: "conflict"; path: string };

type PendingHistoryAction = {
  kind: "cherry_pick" | "revert_commit" | "undo_commit";
  commit: GitCommitSummary;
};

type BranchContextDialog = {
  kind: "create" | "rename" | "delete";
  ref: GitRefsSnapshotRef;
};

type PendingBranchOperation = {
  kind: "merge" | "rebase";
  ref: GitRefsSnapshotRef;
};

const COMMIT_PANE_MIN_PERCENT = 18;
const COMMIT_PANE_MAX_PERCENT = 80;

const PRIMARY_VIEWS: readonly { id: GitToolWindowView; label: string; icon: typeof GitBranch }[] = [
  { id: "changes", label: "提交", icon: GitPullRequest },
  { id: "history", label: "Git 日志", icon: History },
];

const MORE_VIEWS: readonly { id: GitToolWindowView; label: string; description: string; icon: typeof GitBranch }[] = [
  { id: "branches", label: "分支", description: "管理分支、标签与远程仓库", icon: GitBranch },
  { id: "stash", label: "暂存的改动", description: "保存、应用或清理储藏", icon: GitCommitHorizontal },
  { id: "reflog", label: "恢复提交", description: "通过本地引用记录找回历史", icon: FileClock },
  { id: "operations", label: "高级 Git 工具", description: "仓库维护、历史修改与诊断", icon: ListChecks },
];

const VIEW_LABELS: Readonly<Record<GitToolWindowView, string>> = {
  changes: "提交",
  history: "Git 日志",
  blame: "逐行历史",
  reflog: "恢复提交",
  branches: "分支",
  stash: "暂存的改动",
  operations: "高级 Git 工具",
  compare: "比较",
};

export interface GitToolWindowProps {
  project: ActiveProjectState | null;
  maximized: boolean;
  active?: boolean;
  initialView?: GitToolWindowView;
  projectSelector?: GitProjectSelectorProps;
}

export type GitChangesDetailSurface = "merge_editor" | "conflict_diff" | "change_diff";

export function gitChangesDetailSurface(file: GitConflictFile | null): GitChangesDetailSurface {
  if (!file) return "change_diff";
  return file.editable ? "merge_editor" : "conflict_diff";
}

export type GitProjectSelectorProps = Pick<
  WorkspaceSelectorProps,
  | "value"
  | "workspaces"
  | "loading"
  | "onSelectWorkspace"
  | "onAddWorkspace"
  | "onPickWorkspacePath"
>;

export function GitToolWindow({
  project,
  maximized,
  active = true,
  initialView,
  projectSelector,
}: GitToolWindowProps) {
  const toolWindowSnapshotSelector = useMemo(createToolWindowSnapshotSelector, []);
  const storeSnapshot = useOptionalGitStoreSelector(
    active ? toolWindowSnapshotSelector : selectHiddenToolWindowSnapshot,
  );
  const resolvedProject = resolveGitToolWindowProject(project, storeSnapshot);
  const controller = useOptionalGitController();
  const runtime = useOptionalGitRuntime();
  const gitStore = useOptionalGitStore();
  const previewContext = useOptionalPreview();
  const projectKey = resolvedProject && resolvedProject.status !== "none" ? resolvedProject.workspaceId : "none";
  const [view, setView] = useState<GitToolWindowView>(() => initialView ?? storeSnapshot?.ui?.activeTab ?? "changes");
  const [entryViewReady, setEntryViewReady] = useState(initialView !== undefined);
  const [historyDefaultsReady, setHistoryDefaultsReady] = useState(false);
  const [repositoryExpanded, setRepositoryExpanded] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [projectAction, setProjectAction] = useState<"init" | "grant" | "retry" | null>(null);
  const [actionError, setActionError] = useGitErrorNotificationState();
  const [identity, setIdentity] = useState<GitIdentity | null>(null);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [commitPushOpen, setCommitPushOpen] = useState(false);
  const [commitPushTarget, setCommitPushTarget] = useState<GitCommitPushTarget | null>(null);
  const [commitPushCommits, setCommitPushCommits] = useState<readonly GitCommitSummary[]>([]);
  const [selectedCommitPushObjectId, setSelectedCommitPushObjectId] = useState<GitObjectId | null>(null);
  const [commitPushDetail, setCommitPushDetail] = useState<GitCommitDetail | null>(null);
  const [commitPushLoading, setCommitPushLoading] = useState(false);
  const [selectedCommitPaths, setSelectedCommitPaths] = useState<readonly string[]>([]);
  const [selectedUntrackedCommitPaths, setSelectedUntrackedCommitPaths] = useState<readonly string[]>([]);
  const [selectedCommitFileCount, setSelectedCommitFileCount] = useState(0);
  const [changeSelectionResetKey, setChangeSelectionResetKey] = useState(0);
  const [changesRefreshing, setChangesRefreshing] = useState(false);
  const [selectedChangeDiff, setSelectedChangeDiff] = useState<GitDiffSnapshot | null>(null);
  const [selectedChangeDiffLoading, setSelectedChangeDiffLoading] = useState(false);
  const [selectedChangePatchAction, setSelectedChangePatchAction] = useState<"stage" | "unstage">("stage");
  const [changeDiffDialogEntry, setChangeDiffDialogEntry] = useState<GitChangeEntry | null>(null);
  const [pendingChangeRollback, setPendingChangeRollback] = useState<readonly GitChangeEntry[] | null>(null);
  const [patchActionStatus, setPatchActionStatus] = useState<KeydexGitDiffActionStatus>("idle");
  const [remotes, setRemotes] = useState<readonly GitRemoteInfo[]>([]);
  const [outgoingCommits, setOutgoingCommits] = useState<readonly GitCommitSummary[]>([]);
  const [replacedCommits, setReplacedCommits] = useState<readonly GitCommitSummary[]>([]);
  const [stashEntries, setStashEntries] = useState<readonly GitStashEntry[]>([]);
  const [stashCursor, setStashCursor] = useState<string | null>(null);
  const [selectedStash, setSelectedStash] = useState<GitStashEntry | null>(null);
  const [stashDetail, setStashDetail] = useState<GitStashDetail | null>(null);
  const [stashFileIndex, setStashFileIndex] = useState(0);
  const [stashLoading, setStashLoading] = useState(false);
  const [historyCommits, setHistoryCommits] = useState<readonly GitCommitSummary[]>([]);
  const [historyAuthors, setHistoryAuthors] = useState<readonly string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [selectedHistoryObjectId, setSelectedHistoryObjectId] = useState<GitObjectId | null>(
    () => (storeSnapshot?.ui?.selectedHistoryObjectId as GitObjectId | null | undefined) ?? null,
  );
  const [navigationPanePercent, setNavigationPanePercent] = useState(() => storeSnapshot?.ui?.navigationPanePercent ?? 19);
  const [detailPanePercent, setDetailPanePercent] = useState(() => storeSnapshot?.ui?.detailPanePercent ?? 28);
  const [commitPanePercent, setCommitPanePercent] = useState(28);
  const [commitEditorPercent, setCommitEditorPercent] = useState(34);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFilters, setHistoryFilters] = useState<GitHistoryFilters>(() => storeSnapshot?.ui?.historyFilters ?? { ...EMPTY_GIT_HISTORY_FILTERS });
  const [historyDetail, setHistoryDetail] = useState<GitCommitDetail | null>(null);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
  const [historyFileIndex, setHistoryFileIndex] = useState(0);
  const [comparisonIntent, setComparisonIntent] = useState<GitToolWindowNavigationIntent | null>(null);
  const [comparisonResult, setComparisonResult] = useState<GitCompareResult | null>(null);
  const [comparisonCurrentOnly, setComparisonCurrentOnly] = useState<readonly GitCommitSummary[]>([]);
  const [comparisonTargetOnly, setComparisonTargetOnly] = useState<readonly GitCommitSummary[]>([]);
  const [comparisonSelectedCommitId, setComparisonSelectedCommitId] = useState<GitObjectId | null>(null);
  const [comparisonCommitDetail, setComparisonCommitDetail] = useState<GitCommitDetail | null>(null);
  const [comparisonCommitDetailLoading, setComparisonCommitDetailLoading] = useState(false);
  const [comparisonFileIndex, setComparisonFileIndex] = useState(0);
  const [comparisonFileResult, setComparisonFileResult] = useState<GitCompareResult | null>(null);
  const [comparisonFileLoading, setComparisonFileLoading] = useState(false);
  const [comparisonFileError, setComparisonFileError] = useState<string | null>(null);
  const [comparisonFileReloadKey, setComparisonFileReloadKey] = useState(0);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [comparisonReloadKey, setComparisonReloadKey] = useState(0);
  const [blamePage, setBlamePage] = useState<GitBlamePage | null>(null);
  const [blameLoading, setBlameLoading] = useState(false);
  const [reflogPage, setReflogPage] = useState<GitReflogPage | null>(null);
  const [reflogLoading, setReflogLoading] = useState(false);
  const [bisectSnapshot, setBisectSnapshot] = useState<GitBisectSnapshot | null>(null);
  const [bisectLoading, setBisectLoading] = useState(false);
  const [submodulesSnapshot, setSubmodulesSnapshot] = useState<GitSubmodulesSnapshot | null>(null);
  const [submodulesLoading, setSubmodulesLoading] = useState(false);
  const [worktreesSnapshot, setWorktreesSnapshot] = useState<GitWorktreesSnapshot | null>(null);
  const [worktreesLoading, setWorktreesLoading] = useState(false);
  const [lfsSnapshot, setLfsSnapshot] = useState<GitLfsSnapshot | null>(null);
  const [lfsLoading, setLfsLoading] = useState(false);
  const [mergePreview, setMergePreview] = useState<GitMergePreview | null>(null);
  const [rebasePreview, setRebasePreview] = useState<GitRebasePreview | null>(null);
  const [cherryPickCommits, setCherryPickCommits] = useState<readonly string[]>([]);
  const [skippedCherryPickCommits, setSkippedCherryPickCommits] = useState<readonly string[]>([]);
  const [cherryPickOutcome, setCherryPickOutcome] = useState<GitCommandResult | null>(null);
  const [revertCommits, setRevertCommits] = useState<readonly string[]>([]);
  const [revertOutcome, setRevertOutcome] = useState<GitCommandResult | null>(null);
  const [resetPreview, setResetPreview] = useState<GitResetPreview | null>(null);
  const [resetTargetSeed, setResetTargetSeed] = useState("");
  const [patchExport, setPatchExport] = useState<GitPatchExport | null>(null);
  const [pendingHistoryAction, setPendingHistoryAction] = useState<PendingHistoryAction | null>(null);
  const [historyRevertMainline, setHistoryRevertMainline] = useState("1");
  const [revisionTreeOpen, setRevisionTreeOpen] = useState(false);
  const [revisionTree, setRevisionTree] = useState<GitRevisionTree | null>(null);
  const [revisionTreeLoading, setRevisionTreeLoading] = useState(false);
  const [revisionTreeError, setRevisionTreeError] = useState<string | null>(null);
  const [branchContextDialog, setBranchContextDialog] = useState<BranchContextDialog | null>(null);
  const [branchContextName, setBranchContextName] = useState("");
  const [pendingBranchOperation, setPendingBranchOperation] = useState<PendingBranchOperation | null>(null);
  const [patchDryRunSignature, setPatchDryRunSignature] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<GitConflictsSnapshot | null>(null);
  const [conflictsLoading, setConflictsLoading] = useState(false);
  const [selectedConflictPath, setSelectedConflictPath] = useState<string | null>(null);
  const [mergeEditorDirty, setMergeEditorDirty] = useState(false);
  const [pendingMergeDraftDiscard, setPendingMergeDraftDiscard] = useState<PendingMergeDraftDiscard | null>(null);

  useEffect(() => {
    controller?.setForegroundActive(active);
    return () => {
      if (active) controller?.setForegroundActive(false);
    };
  }, [active, controller]);
  const [recentlyResolvedConflict, setRecentlyResolvedConflict] = useState<{
    file: GitConflictFile;
    resolvedIndexEntry: string;
  } | null>(null);
  const [mutation, setMutation] = useState<"patch" | "commit" | "push" | "checkout" | "branch" | "fetch" | "update" | "stash" | "merge" | "rebase" | "cherry_pick" | "revert" | "reset" | "restore" | "conflict_save" | "conflict_action" | "bisect" | "submodule" | "worktree" | "lfs" | null>(null);
  const tabRefs = useRef(new Map<GitToolWindowView, HTMLButtonElement>());
  const moreRootRef = useRef<HTMLDivElement | null>(null);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const changesWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const changeDiffAbortRef = useRef<AbortController | null>(null);
  const selectedChangeDiffRef = useRef<GitDiffSnapshot | null>(null);
  const commitPushPreviewAbortRef = useRef<AbortController | null>(null);
  const commitPushDetailAbortRef = useRef<AbortController | null>(null);
  const comparisonAbortRef = useRef<AbortController | null>(null);
  const comparisonDetailAbortRef = useRef<AbortController | null>(null);
  const comparisonFileAbortRef = useRef<AbortController | null>(null);
  const patchActionInFlightRef = useRef(false);
  const patchActionFeedbackTimerRef = useRef<number | null>(null);
  const historyDetailCacheRef = useRef(new Map<string, GitCommitDetail>());
  const initializedProjectKeyRef = useRef(projectKey);

  useEffect(() => () => {
    changeDiffAbortRef.current?.abort();
    commitPushPreviewAbortRef.current?.abort();
    commitPushDetailAbortRef.current?.abort();
    comparisonAbortRef.current?.abort();
    comparisonDetailAbortRef.current?.abort();
    comparisonFileAbortRef.current?.abort();
    if (patchActionFeedbackTimerRef.current !== null) {
      window.clearTimeout(patchActionFeedbackTimerRef.current);
    }
  }, []);

  const applyView = (nextView: GitToolWindowView) => {
    setMergeEditorDirty(false);
    setView(nextView);
    if (storeSnapshot?.project && nextView !== "compare") {
      gitStore?.getState().updateProjectUi(storeSnapshot.project.workspaceId, { activeTab: nextView });
    }
  };
  const activateView = (nextView: GitToolWindowView): boolean => {
    if (nextView === view) return true;
    if (mergeEditorDirty) {
      setPendingMergeDraftDiscard({ kind: "view", view: nextView });
      return false;
    }
    applyView(nextView);
    return true;
  };

  useEffect(() => {
    if (!moreOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !moreRootRef.current?.contains(event.target)) setMoreOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMoreOpen(false);
      moreTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [moreOpen]);

  const selectHistoryObjectId = (objectId: GitObjectId | null) => {
    setSelectedHistoryObjectId(objectId);
    if (storeSnapshot?.project) {
      gitStore?.getState().updateProjectUi(storeSnapshot.project.workspaceId, {
        selectedHistoryObjectId: objectId,
      });
    }
  };

  const selectRepositoryRef = (ref: GitRefsSnapshotRef) => {
    if (!storeSnapshot?.project) return;
    const update = gitUiUpdateForRefSelection(view, historyFilters, ref);
    if (update.historyFilters) {
      setHistoryDefaultsReady(true);
      setHistoryFilters(update.historyFilters);
    }
    gitStore?.getState().updateProjectUi(storeSnapshot.project.workspaceId, update);
  };

  const applyHistoryFilters = (next: GitHistoryFilters) => {
    setHistoryDefaultsReady(true);
    setHistoryFilters(next);
    if (!storeSnapshot?.project) return;
    const selectedRef = selectedRefForHistoryRevision(next.revision, storeSnapshot.refs ?? []);
    gitStore?.getState().updateProjectUi(storeSnapshot.project.workspaceId, {
      historyFilters: next,
      ...(selectedRef !== undefined ? { selectedRef } : {}),
    });
  };

  const updatePanePercent = useCallback((pane: "navigation" | "details", requestedPercent: number) => {
    if (pane === "details" && view === "changes") {
      setCommitPanePercent(Math.min(COMMIT_PANE_MAX_PERCENT, Math.max(COMMIT_PANE_MIN_PERCENT, requestedPercent)));
      return;
    }
    const detailPaneMaximum = 72 - navigationPanePercent;
    const next = pane === "navigation"
      ? Math.min(35, Math.max(12, Math.min(requestedPercent, 72 - detailPanePercent)))
      : Math.min(detailPaneMaximum, Math.max(18, requestedPercent));
    if (pane === "navigation") setNavigationPanePercent(next);
    else setDetailPanePercent(next);
    if (storeSnapshot?.project) {
      gitStore?.getState().updateProjectUi(storeSnapshot.project.workspaceId, pane === "navigation"
        ? { navigationPanePercent: next }
        : { detailPanePercent: next });
    }
  }, [detailPanePercent, gitStore, navigationPanePercent, storeSnapshot?.project, view]);

  const workspaceResizeExtentRef = useRef(1);
  const changesResizeExtentRef = useRef(1);
  const previewWorkspacePercent = useCallback((property: string, value: number) => {
    workspaceRef.current?.style.setProperty(property, `${value}%`);
  }, []);
  const previewCommitEditorPercent = useCallback((value: number) => {
    changesWorkspaceRef.current?.style.setProperty("--git-commit-editor-height", `${value}%`);
  }, []);
  const clampNavigationPanePercent = useCallback((requestedPercent: number) => (
    Math.min(35, Math.max(12, Math.min(requestedPercent, 72 - detailPanePercent)))
  ), [detailPanePercent]);
  const clampDetailPanePercent = useCallback((requestedPercent: number) => {
    if (view === "changes") {
      return Math.min(COMMIT_PANE_MAX_PERCENT, Math.max(COMMIT_PANE_MIN_PERCENT, requestedPercent));
    }
    return Math.min(72 - navigationPanePercent, Math.max(18, requestedPercent));
  }, [navigationPanePercent, view]);
  const clampCommitEditorPercent = useCallback((requestedPercent: number) => (
    Math.min(65, Math.max(22, requestedPercent))
  ), []);

  const navigationResize = useRafPanelResize({
    disabled: view === "changes",
    width: navigationPanePercent,
    getWidth: (startPercent, startX, clientX) => clampNavigationPanePercent(
      startPercent + ((clientX - startX) / workspaceResizeExtentRef.current) * 100,
    ),
    onPreview: (value) => previewWorkspacePercent("--git-navigation-pane-width", value),
    onCommit: (value) => updatePanePercent("navigation", value),
  });
  const detailResize = useRafPanelResize({
    disabled: !maximized,
    width: view === "changes" ? commitPanePercent : detailPanePercent,
    getWidth: (startPercent, startX, clientX) => {
      const direction = view === "changes" ? 1 : -1;
      return clampDetailPanePercent(
        startPercent + direction * ((clientX - startX) / workspaceResizeExtentRef.current) * 100,
      );
    },
    onPreview: (value) => previewWorkspacePercent("--git-detail-pane-width", value),
    onCommit: (value) => updatePanePercent("details", value),
  });
  const commitEditorResize = useRafPanelResize({
    axis: "y",
    disabled: view !== "changes",
    width: commitEditorPercent,
    getWidth: (startPercent, startY, clientY) => clampCommitEditorPercent(
      startPercent - ((clientY - startY) / changesResizeExtentRef.current) * 100,
    ),
    onPreview: previewCommitEditorPercent,
    onCommit: (value) => setCommitEditorPercent(clampCommitEditorPercent(value)),
  });
  const startNavigationResize = useCallback((event: Parameters<typeof navigationResize.startDrag>[0]) => {
    workspaceResizeExtentRef.current = Math.max(1, workspaceRef.current?.getBoundingClientRect().width ?? 1);
    navigationResize.startDrag(event);
  }, [navigationResize.startDrag]);
  const startDetailResize = useCallback((event: Parameters<typeof detailResize.startDrag>[0]) => {
    workspaceResizeExtentRef.current = Math.max(1, workspaceRef.current?.getBoundingClientRect().width ?? 1);
    detailResize.startDrag(event);
  }, [detailResize.startDrag]);
  const startCommitEditorResize = useCallback((event: Parameters<typeof commitEditorResize.startDrag>[0]) => {
    changesResizeExtentRef.current = Math.max(1, changesWorkspaceRef.current?.getBoundingClientRect().height ?? 1);
    commitEditorResize.startDrag(event);
  }, [commitEditorResize.startDrag]);

  const handleSplitterKeyDown = (
    pane: "navigation" | "details",
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const current = pane === "navigation"
      ? navigationPanePercent
      : view === "changes"
        ? commitPanePercent
        : detailPanePercent;
    const direction = pane === "details" && view !== "changes" ? -1 : 1;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = current - (2 * direction);
    if (event.key === "ArrowRight") next = current + (2 * direction);
    if (event.key === "Home") next = pane === "navigation" ? 12 : COMMIT_PANE_MIN_PERCENT;
    if (event.key === "End") {
      next = pane === "navigation"
        ? 35
        : view === "changes"
          ? COMMIT_PANE_MAX_PERCENT
          : 72 - navigationPanePercent;
    }
    if (next === null) return;
    event.preventDefault();
    updatePanePercent(pane, next);
  };

  const updateCommitEditorPercent = (requestedPercent: number) => {
    setCommitEditorPercent(clampCommitEditorPercent(requestedPercent));
  };

  const handleCommitSplitterKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowUp") next = commitEditorPercent + 2;
    if (event.key === "ArrowDown") next = commitEditorPercent - 2;
    if (event.key === "Home") next = 22;
    if (event.key === "End") next = 65;
    if (next === null) return;
    event.preventDefault();
    updateCommitEditorPercent(next);
  };

  const retryLoggedOperation = async (operationId: string) => {
    if (!controller) return;
    try {
      const result = await controller.retryOperation(operationId);
      if (result.state === "failed") setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    }
  };
  const cancelLoggedOperation = async (operationId: string) => {
    if (!controller) return;
    try {
      const result = await controller.cancelOperation(operationId);
      if (result.state === "failed") setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    }
  };

  useEffect(() => {
    if (initializedProjectKeyRef.current === projectKey) return;
    initializedProjectKeyRef.current = projectKey;
    setView(initialView ?? storeSnapshot?.ui?.activeTab ?? "changes");
    setEntryViewReady(initialView !== undefined);
    setHistoryDefaultsReady(false);
    setRepositoryExpanded(false);
    setHistoryFilters(storeSnapshot?.ui?.historyFilters ?? { ...EMPTY_GIT_HISTORY_FILTERS });
    setHistoryAuthors([]);
    setSelectedHistoryObjectId((storeSnapshot?.ui?.selectedHistoryObjectId as GitObjectId | null | undefined) ?? null);
    setNavigationPanePercent(storeSnapshot?.ui?.navigationPanePercent ?? 19);
    setDetailPanePercent(storeSnapshot?.ui?.detailPanePercent ?? 28);
    setCommitPanePercent(28);
  }, [initialView, projectKey]);

  useEffect(() => {
    if (active) return;
    if (initialView === undefined) setEntryViewReady(false);
    setHistoryDefaultsReady(false);
  }, [active, initialView]);

  useEffect(() => {
    const status = storeSnapshot?.status;
    if (!active || initialView !== undefined || entryViewReady || !status) return;
    const nextView = defaultGitToolWindowView(status);
    setMergeEditorDirty(false);
    setView(nextView);
    if (storeSnapshot?.project) {
      gitStore?.getState().updateProjectUi(storeSnapshot.project.workspaceId, { activeTab: nextView });
    }
    setEntryViewReady(true);
  }, [active, entryViewReady, gitStore, initialView, storeSnapshot?.project, storeSnapshot?.status]);

  useEffect(() => {
    const status = storeSnapshot?.status;
    if (!active || view !== "history" || historyDefaultsReady || !status) return;
    const currentRevision = currentGitBranchRevision(status, storeSnapshot?.refs ?? []);
    const shouldSelectCurrent = historyFilters.revision.length === 0 && currentRevision !== null;
    const nextFilters = shouldSelectCurrent
      ? { ...historyFilters, revision: currentRevision }
      : historyFilters;
    if (shouldSelectCurrent) setHistoryFilters(nextFilters);
    if (storeSnapshot?.project) {
      gitStore?.getState().updateProjectUi(storeSnapshot.project.workspaceId, {
        historyFilters: nextFilters,
        ...(shouldSelectCurrent ? { selectedRef: currentRevision } : {}),
      });
    }
    setHistoryDefaultsReady(true);
  }, [
    active,
    gitStore,
    historyDefaultsReady,
    historyFilters,
    storeSnapshot?.project,
    storeSnapshot?.refs,
    storeSnapshot?.status,
    view,
  ]);

  useEffect(() => {
    changeDiffAbortRef.current?.abort();
    commitPushPreviewAbortRef.current?.abort();
    commitPushDetailAbortRef.current?.abort();
    if (patchActionFeedbackTimerRef.current !== null) {
      window.clearTimeout(patchActionFeedbackTimerRef.current);
      patchActionFeedbackTimerRef.current = null;
    }
    setPatchActionStatus("idle");
    setCommitPushOpen(false);
    setCommitPushTarget(null);
    setCommitPushCommits([]);
    setSelectedCommitPushObjectId(null);
    setCommitPushDetail(null);
    setCommitPushLoading(false);
    setSelectedCommitPaths([]);
    setSelectedUntrackedCommitPaths([]);
    setSelectedCommitFileCount(0);
    setChangeSelectionResetKey((current) => current + 1);
    setChangeDiffDialogEntry(null);
    setPendingChangeRollback(null);
    selectedChangeDiffRef.current = null;
    setSelectedChangeDiff(null);
    setSelectedChangeDiffLoading(false);
    setPendingHistoryAction(null);
    setHistoryDefaultsReady(false);
    setRevisionTreeOpen(false);
    setRevisionTree(null);
    setRevisionTreeError(null);
    setBranchContextDialog(null);
    setPendingBranchOperation(null);
    comparisonAbortRef.current?.abort();
    comparisonDetailAbortRef.current?.abort();
    comparisonFileAbortRef.current?.abort();
    setComparisonIntent(null);
    setComparisonResult(null);
    setComparisonCurrentOnly([]);
    setComparisonTargetOnly([]);
    setComparisonSelectedCommitId(null);
    setComparisonCommitDetail(null);
    setComparisonFileIndex(0);
    setComparisonFileResult(null);
    setComparisonFileLoading(false);
    setComparisonFileError(null);
    setComparisonFileReloadKey(0);
    setComparisonLoading(false);
    setComparisonError(null);
  }, [projectKey, storeSnapshot?.project?.selectedRepositoryId]);

  useEffect(() => {
    const request = storeSnapshot?.navigationRequest;
    const projectState = storeSnapshot?.project;
    if (!request || !projectState) return;
    setComparisonIntent(request);
    setComparisonReloadKey(0);
    if (mergeEditorDirty) setPendingMergeDraftDiscard({ kind: "view", view: "compare" });
    else setView("compare");
    gitStore?.getState().consumeToolWindowNavigation(projectState.workspaceId, request.requestId);
  }, [gitStore, mergeEditorDirty, storeSnapshot?.navigationRequest, storeSnapshot?.project]);

  useEffect(() => {
    const projectState = storeSnapshot?.project;
    const repositoryId = projectState?.selectedRepositoryId;
    if (!comparisonIntent || !runtime || !projectState || !repositoryId) return;
    const abortController = new AbortController();
    comparisonAbortRef.current?.abort();
    comparisonAbortRef.current = abortController;
    const scope = {
      workspaceId: projectState.workspaceId,
      projectRoot: projectState.projectRoot,
      repositoryId,
    };
    setComparisonLoading(true);
    setComparisonError(null);
    setComparisonResult(null);
    setComparisonCurrentOnly([]);
    setComparisonTargetOnly([]);
    setComparisonSelectedCommitId(null);
    setComparisonCommitDetail(null);
    setComparisonFileIndex(0);
    setComparisonFileResult(null);
    setComparisonFileLoading(false);
    setComparisonFileError(null);

    const request = comparisonIntent.kind === "compare_refs"
      ? Promise.all([
          runtime.compare(scope, {
            mode: "two_dot",
            left: comparisonIntent.targetRef,
            right: comparisonIntent.currentRef,
            signal: abortController.signal,
          }),
          runtime.history(scope, {
            revision: `${comparisonIntent.targetRef}..${comparisonIntent.currentRef}`,
            limit: 200,
            signal: abortController.signal,
          }),
          runtime.history(scope, {
            revision: `${comparisonIntent.currentRef}..${comparisonIntent.targetRef}`,
            limit: 200,
            signal: abortController.signal,
          }),
        ]).then(([result, currentOnly, targetOnly]) => {
          if (abortController.signal.aborted) return;
          setComparisonResult(result);
          setComparisonCurrentOnly(currentOnly.commits);
          setComparisonTargetOnly(targetOnly.commits);
          setComparisonSelectedCommitId((currentOnly.commits[0] ?? targetOnly.commits[0])?.objectId ?? null);
        })
      : runtime.compare(scope, {
          mode: "working_tree",
          left: comparisonIntent.targetRef,
          signal: abortController.signal,
        }).then((result) => {
          if (!abortController.signal.aborted) setComparisonResult(result);
        });

    void request.catch((error) => {
      if (!abortController.signal.aborted) setComparisonError(gitUiErrorMessage(error));
    }).finally(() => {
      if (comparisonAbortRef.current === abortController) {
        comparisonAbortRef.current = null;
        setComparisonLoading(false);
      }
    });
    return () => abortController.abort();
  }, [comparisonIntent, comparisonReloadKey, runtime, storeSnapshot?.project]);

  useEffect(() => {
    const projectState = storeSnapshot?.project;
    const repositoryId = projectState?.selectedRepositoryId;
    const selectedFile = comparisonResult?.files[comparisonFileIndex] ?? null;
    const path = selectedFile?.newPath ?? selectedFile?.oldPath ?? null;
    if (comparisonIntent?.kind !== "compare_worktree" || !runtime || !projectState || !repositoryId || !path) {
      comparisonFileAbortRef.current?.abort();
      setComparisonFileResult(null);
      setComparisonFileLoading(false);
      setComparisonFileError(null);
      return;
    }
    const abortController = new AbortController();
    comparisonFileAbortRef.current?.abort();
    comparisonFileAbortRef.current = abortController;
    setComparisonFileResult(null);
    setComparisonFileLoading(true);
    setComparisonFileError(null);
    void runtime.compare({
      workspaceId: projectState.workspaceId,
      projectRoot: projectState.projectRoot,
      repositoryId,
    }, {
      mode: "working_tree",
      left: comparisonIntent.targetRef,
      path,
      signal: abortController.signal,
    }).then((result) => {
      if (!abortController.signal.aborted) setComparisonFileResult(result);
    }).catch((error) => {
      if (!abortController.signal.aborted) setComparisonFileError(gitUiErrorMessage(error));
    }).finally(() => {
      if (comparisonFileAbortRef.current === abortController) {
        comparisonFileAbortRef.current = null;
        setComparisonFileLoading(false);
      }
    });
    return () => abortController.abort();
  }, [
    comparisonFileIndex,
    comparisonFileReloadKey,
    comparisonIntent,
    comparisonResult,
    runtime,
    storeSnapshot?.project,
  ]);

  useEffect(() => {
    const projectState = storeSnapshot?.project;
    const repositoryId = projectState?.selectedRepositoryId;
    if (comparisonIntent?.kind !== "compare_refs" || !comparisonSelectedCommitId || !runtime || !projectState || !repositoryId) {
      setComparisonCommitDetail(null);
      setComparisonCommitDetailLoading(false);
      return;
    }
    const abortController = new AbortController();
    comparisonDetailAbortRef.current?.abort();
    comparisonDetailAbortRef.current = abortController;
    const cacheKey = `${repositoryId}:${comparisonSelectedCommitId}`;
    const cached = historyDetailCacheRef.current.get(cacheKey) ?? null;
    const summary = [...comparisonCurrentOnly, ...comparisonTargetOnly]
      .find((commit) => commit.objectId === comparisonSelectedCommitId) ?? null;
    const preview = summary && (comparisonResult || storeSnapshot.status)
      ? {
          repositoryId,
          repositoryVersion: (comparisonResult ?? storeSnapshot.status)!.repositoryVersion,
          commit: summary,
          selectedParentId: summary.parentIds[0] ?? null,
          files: [],
        } satisfies GitCommitDetail
      : null;
    setComparisonCommitDetail(cached ?? preview);
    setComparisonFileIndex(0);
    if (cached) {
      setComparisonCommitDetailLoading(false);
      return () => abortController.abort();
    }
    setComparisonCommitDetailLoading(true);
    void runtime.commit({
      workspaceId: projectState.workspaceId,
      projectRoot: projectState.projectRoot,
      repositoryId,
    }, comparisonSelectedCommitId, { signal: abortController.signal }).then((detail) => {
      historyDetailCacheRef.current.set(cacheKey, detail);
      trimMap(historyDetailCacheRef.current, 100);
      if (!abortController.signal.aborted) setComparisonCommitDetail(detail);
    }).catch((error) => {
      if (!abortController.signal.aborted) setComparisonError(gitUiErrorMessage(error));
    }).finally(() => {
      if (comparisonDetailAbortRef.current === abortController) {
        comparisonDetailAbortRef.current = null;
        setComparisonCommitDetailLoading(false);
      }
    });
    return () => abortController.abort();
  }, [
    comparisonCurrentOnly,
    comparisonIntent,
    comparisonResult,
    comparisonSelectedCommitId,
    comparisonTargetOnly,
    runtime,
    storeSnapshot?.project,
    storeSnapshot?.status,
  ]);

  useEffect(() => {
    const projectState = storeSnapshot?.project;
    const repositoryId = projectState?.selectedRepositoryId;
    const hasConflicts = storeSnapshot?.status?.operation?.state === "conflicted"
      || storeSnapshot?.status?.files.some((file) => file.conflicted);
    if (!runtime || !projectState || !repositoryId || !hasConflicts) {
      setConflicts(null);
      setSelectedConflictPath(null);
      setMergeEditorDirty(false);
      return;
    }
    let active = true;
    setConflictsLoading(true);
    void runtime.conflicts({
      workspaceId: projectState.workspaceId,
      projectRoot: projectState.projectRoot,
      repositoryId,
    }).then((snapshot) => {
      if (!active) return;
      setConflicts(snapshot);
      setSelectedConflictPath((current) => snapshot.files.some((file) => file.path === current) ? current : snapshot.files[0]?.path ?? null);
    }).catch((error) => {
      if (active) setActionError(gitUiErrorMessage(error));
    }).finally(() => {
      if (active) setConflictsLoading(false);
    });
    return () => { active = false; };
  }, [runtime, storeSnapshot?.project, storeSnapshot?.status?.repositoryVersion]);

  useEffect(() => {
    const selectedRepositoryId = storeSnapshot?.project?.selectedRepositoryId;
    if (!runtime || !storeSnapshot?.project || !selectedRepositoryId || typeof runtime.identity !== "function") {
      setIdentity(null);
      return;
    }
    let disposed = false;
    setIdentityLoading(true);
    void runtime.identity({
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: selectedRepositoryId,
    }).then((value) => {
      if (!disposed) setIdentity(value);
    }).catch(() => {
      if (!disposed) setIdentity(null);
    }).finally(() => {
      if (!disposed) setIdentityLoading(false);
    });
    return () => { disposed = true; };
  }, [runtime, storeSnapshot?.project]);

  useEffect(() => {
    if (view !== "branches" || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    let disposed = false;
    void runtime.remotes({
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    }).then((values) => {
      if (!disposed) setRemotes(values);
    }).catch((error) => {
      if (!disposed) setActionError(gitUiErrorMessage(error));
    });
    return () => { disposed = true; };
  }, [runtime, storeSnapshot?.project, view]);

  useEffect(() => {
    const upstream = storeSnapshot?.status?.branch.upstream;
    if (view !== "branches" || !runtime || !storeSnapshot?.project?.selectedRepositoryId || !upstream) {
      setOutgoingCommits([]);
      setReplacedCommits([]);
      return;
    }
    let disposed = false;
    const scope = {
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    };
    void Promise.all([
      runtime.history(scope, { revision: `${upstream}..HEAD`, limit: 100 }),
      runtime.history(scope, { revision: `HEAD..${upstream}`, limit: 100 }),
    ]).then(([outgoing, replaced]) => {
      if (disposed) return;
      setOutgoingCommits(outgoing.commits);
      setReplacedCommits(replaced.commits);
    }).catch((error) => {
      if (!disposed) setActionError(gitUiErrorMessage(error));
    });
    return () => { disposed = true; };
  }, [runtime, storeSnapshot?.project, storeSnapshot?.status?.branch.upstream, storeSnapshot?.status?.repositoryVersion, view]);

  useEffect(() => {
    if (view !== "operations" || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    let disposed = false;
    setBisectLoading(true);
    void runtime.bisect({
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    }).then((snapshot) => {
      if (!disposed) setBisectSnapshot(snapshot);
    }).catch((error) => {
      if (!disposed) setActionError(gitUiErrorMessage(error));
    }).finally(() => {
      if (!disposed) setBisectLoading(false);
    });
    return () => { disposed = true; };
  }, [
    runtime,
    storeSnapshot?.project?.workspaceId,
    storeSnapshot?.project?.projectRoot,
    storeSnapshot?.project?.selectedRepositoryId,
    view,
  ]);

  useEffect(() => {
    if (view !== "operations" || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    let disposed = false;
    setWorktreesLoading(true);
    void runtime.worktrees({
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    }).then((snapshot) => {
      if (!disposed) setWorktreesSnapshot(snapshot);
    }).catch((error) => {
      if (!disposed) setActionError(gitUiErrorMessage(error));
    }).finally(() => {
      if (!disposed) setWorktreesLoading(false);
    });
    return () => { disposed = true; };
  }, [
    runtime,
    storeSnapshot?.project?.workspaceId,
    storeSnapshot?.project?.projectRoot,
    storeSnapshot?.project?.selectedRepositoryId,
    view,
  ]);

  useEffect(() => {
    if (view !== "operations" || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    let disposed = false;
    setLfsLoading(true);
    void runtime.lfs({
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    }).then((snapshot) => {
      if (!disposed) setLfsSnapshot(snapshot);
    }).catch((error) => {
      if (!disposed) setActionError(gitUiErrorMessage(error));
    }).finally(() => {
      if (!disposed) setLfsLoading(false);
    });
    return () => { disposed = true; };
  }, [
    runtime,
    storeSnapshot?.project?.workspaceId,
    storeSnapshot?.project?.projectRoot,
    storeSnapshot?.project?.selectedRepositoryId,
    view,
  ]);

  useEffect(() => {
    if (view !== "operations" || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    let disposed = false;
    setSubmodulesLoading(true);
    void runtime.submodules({
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    }).then((snapshot) => {
      if (!disposed) setSubmodulesSnapshot(snapshot);
    }).catch((error) => {
      if (!disposed) setActionError(gitUiErrorMessage(error));
    }).finally(() => {
      if (!disposed) setSubmodulesLoading(false);
    });
    return () => { disposed = true; };
  }, [
    runtime,
    storeSnapshot?.project?.workspaceId,
    storeSnapshot?.project?.projectRoot,
    storeSnapshot?.project?.selectedRepositoryId,
    view,
  ]);

  useEffect(() => {
    const project = storeSnapshot?.project;
    if (view !== "history" || !historyDefaultsReady || !runtime || !project?.selectedRepositoryId) return;
    const abortController = new AbortController();
    setHistoryLoading(true);
    void runtime.history({
      workspaceId: project.workspaceId,
      projectRoot: project.projectRoot,
      repositoryId: project.selectedRepositoryId,
    }, { limit: GIT_HISTORY_PAGE_SIZE, ...historyFilters, signal: abortController.signal }).then((page) => {
      if (abortController.signal.aborted) return;
      setHistoryCommits(page.commits);
      setHistoryAuthors((current) => mergeHistoryAuthors(current, page.commits));
      setHistoryCursor(page.nextCursor);
      const selected = gitStore?.getState().uiByProject[project.workspaceId]?.selectedHistoryObjectId as GitObjectId | null | undefined;
      const next = page.commits.some((commit) => commit.objectId === selected)
        ? selected ?? null
        : page.commits[0]?.objectId ?? null;
      setSelectedHistoryObjectId(next);
      gitStore?.getState().updateProjectUi(project.workspaceId, { selectedHistoryObjectId: next });
    }).catch((error) => {
      if (!isAbortError(error)) setActionError(gitUiErrorMessage(error));
    }).finally(() => {
      if (!abortController.signal.aborted) setHistoryLoading(false);
    });
    return () => abortController.abort();
  }, [gitStore, historyDefaultsReady, historyFilters, runtime, storeSnapshot?.project?.projectRoot, storeSnapshot?.project?.selectedRepositoryId, storeSnapshot?.project?.workspaceId, view]);

  useEffect(() => {
    if (view !== "stash" || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    let disposed = false;
    const scope = {
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    };
    setStashLoading(true);
    setActionError(null);
    void runtime.stashList(scope, { limit: 50 }).then(async (page) => {
      if (disposed) return;
      setStashEntries(page.entries);
      setStashCursor(page.nextCursor);
      const first = page.entries[0] ?? null;
      setSelectedStash(first);
      setStashFileIndex(0);
      if (first) {
        const detail = await runtime.stashDetail(scope, first.selector, first.objectId);
        if (!disposed) setStashDetail(detail);
      } else {
        setStashDetail(null);
      }
    }).catch((error) => {
      if (!disposed) setActionError(gitUiErrorMessage(error));
    }).finally(() => {
      if (!disposed) setStashLoading(false);
    });
    return () => { disposed = true; };
  }, [runtime, storeSnapshot?.project, view]);

  useEffect(() => {
    if (
      view !== "history"
      || !runtime
      || !selectedHistoryObjectId
      || !storeSnapshot?.project?.selectedRepositoryId
    ) {
      setHistoryDetail(null);
      return;
    }
    const abortController = new AbortController();
    const repositoryId = storeSnapshot.project.selectedRepositoryId;
    const cacheKey = `${repositoryId}:${selectedHistoryObjectId}`;
    const cachedDetail = historyDetailCacheRef.current.get(cacheKey) ?? null;
    const summary = historyCommits.find((commit) => commit.objectId === selectedHistoryObjectId) ?? null;
    const previewDetail = summary && storeSnapshot.status
      ? {
          repositoryId,
          repositoryVersion: storeSnapshot.status.repositoryVersion,
          commit: summary,
          selectedParentId: summary.parentIds[0] ?? null,
          files: [],
        } satisfies GitCommitDetail
      : null;
    setHistoryDetail(cachedDetail ?? previewDetail);
    if (cachedDetail) {
      setHistoryDetailLoading(false);
      return () => abortController.abort();
    }
    setHistoryDetailLoading(true);
    setHistoryFileIndex(0);
    void runtime.commit({
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    }, selectedHistoryObjectId, { signal: abortController.signal }).then((detail) => {
      historyDetailCacheRef.current.set(cacheKey, detail);
      trimMap(historyDetailCacheRef.current, 100);
      if (!abortController.signal.aborted) setHistoryDetail(detail);
    }).catch((error) => {
      if (!isAbortError(error)) setActionError(gitUiErrorMessage(error));
    }).finally(() => {
      if (!abortController.signal.aborted) setHistoryDetailLoading(false);
    });
    return () => abortController.abort();
  }, [historyCommits, runtime, selectedHistoryObjectId, storeSnapshot?.project, storeSnapshot?.status, view]);

  const runProjectAction = async (action: "init" | "grant" | "retry") => {
    if (!resolvedProject || resolvedProject.status === "none" || !runtime || !controller) return;
    const scope = { workspaceId: resolvedProject.workspaceId, projectRoot: resolvedProject.projectPath };
    setProjectAction(action);
    setActionError(null);
    try {
      if (action === "init") await runtime.initialize(scope);
      if (action === "grant" && resolvedProject.status === "ancestor_pending") {
        await runtime.authorizeAncestor({
          ...scope,
          repositoryId: resolvedProject.ancestorCandidate.id as GitRepositoryId,
          repositoryRoot: resolvedProject.ancestorCandidate.rootPath,
        });
      }
      await controller.activateProject(scope);
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setProjectAction(null);
    }
  };

  // Keep the lightweight controller state and request caches mounted across
  // first-level page switches, but release the expensive Git DOM while hidden.
  if (!active) return null;

  if (!resolvedProject || resolvedProject.status === "none") {
    return <GitToolWindowState kind="empty" title="未加载项目" detail="加载项目后即可使用 Git 面板。" />;
  }
  if (resolvedProject.status === "loading") {
    return <GitToolWindowState kind="loading" title="正在读取 Git 仓库" detail={resolvedProject.projectPath} />;
  }
  if (resolvedProject.status === "error") {
    return (
      <GitToolWindowState
        kind="error"
        title={resolvedProject.errorCode === "git_unavailable" ? "Git 不可用" : "Git 仓库加载失败"}
        detail={actionError ?? resolvedProject.message}
        actionLabel={projectAction === "retry" ? "正在重试…" : "重试"}
        actionDisabled={Boolean(projectAction)}
        onAction={() => void runProjectAction("retry")}
      />
    );
  }
  if (resolvedProject.status === "denied") {
    return (
      <GitToolWindowState
        kind="error"
        title="仓库访问未授权"
        detail={actionError ?? "该 Git 仓库位于项目目录之外，需要明确授权后才能访问。"}
        actionLabel={projectAction === "retry" ? "正在重试…" : "重新检测"}
        actionDisabled={Boolean(projectAction)}
        onAction={() => void runProjectAction("retry")}
      />
    );
  }
  if (resolvedProject.status === "ancestor_pending") {
    return (
      <GitToolWindowState
        kind="empty"
        title="发现上级 Git 仓库"
        detail={actionError ?? "确认授权后，Keydex 才会读取项目目录之外的仓库元数据。授权仅适用于 Git，不会扩大文件或终端权限。"}
        actionLabel={projectAction === "grant" ? "正在授权…" : "授权此 Git 仓库"}
        actionDisabled={Boolean(projectAction)}
        onAction={() => void runProjectAction("grant")}
      />
    );
  }
  if (resolvedProject.status === "non_repo") {
    return (
      <GitToolWindowState
        kind="empty"
        title="当前项目不是 Git 仓库"
        detail={actionError ?? "初始化后会在当前项目根目录创建 .git，不会改动现有文件。"}
        actionLabel={projectAction === "init" ? "正在初始化…" : "初始化 Git 仓库"}
        actionDisabled={Boolean(projectAction)}
        onAction={() => void runProjectAction("init")}
      />
    );
  }

  const selectedRepository = resolvedProject.repoRoots.find((repository) => repository.id === resolvedProject.selectedRepoId);
  const copyGitDiffText = async (text: string) => {
    if (!navigator.clipboard?.writeText) throw new Error("剪贴板不可用");
    await navigator.clipboard.writeText(text);
  };
  const openGitDiffFile = (repositoryPath: string) => {
    const workspaceId = storeSnapshot?.project?.workspaceId;
    const projectRoot = storeSnapshot?.project?.projectRoot;
    const previewPath = projectRoot && selectedRepository
      ? gitWorkspacePreviewPath(projectRoot, selectedRepository.rootPath, repositoryPath)
      : null;
    if (!workspaceId || !projectRoot || !previewPath) {
      throw new Error("此 Git 文件不在当前工作区内，无法打开");
    }
    if (!previewContext) throw new Error("文件预览当前不可用");
    const renderContext: PreviewRenderContext = {
      panelScopeKey: `git:${workspaceId}`,
      workspaceId,
      workspaceRootPath: projectRoot,
      workspaceAvailable: true,
      workspaceLabel: resolvedProject.name,
    };
    previewContext.openFilePanel(previewPath, renderContext);
  };
  const activeViewLabel = VIEW_LABELS[view];
  const applyRepositorySelection = (repositoryId: GitRepositoryId) => {
    if (!storeSnapshot?.project) return;
    setMergeEditorDirty(false);
    setActionError(null);
    setMergePreview(null);
    setRebasePreview(null);
    setResetPreview(null);
    selectHistoryObjectId(null);
    setHistoryDetail(null);
    setBlamePage(null);
    setReflogPage(null);
    setSelectedCommitPaths([]);
    setSelectedUntrackedCommitPaths([]);
    setSelectedCommitFileCount(0);
    setChangeSelectionResetKey((current) => current + 1);
    gitStore?.getState().selectRepository(storeSnapshot.project.workspaceId, repositoryId);
    void controller?.refreshRepository({
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId,
    }, ["status", "refs"]);
  };
  const selectRepository = (repositoryId: GitRepositoryId) => {
    if (!storeSnapshot?.project || storeSnapshot.project.selectedRepositoryId === repositoryId) return;
    if (mergeEditorDirty) {
      setPendingMergeDraftDiscard({ kind: "repository", repositoryId });
      return;
    }
    applyRepositorySelection(repositoryId);
  };
  const updateCommitSelection = (
    _paths: readonly string[],
    entries: readonly GitChangeEntry[] = [],
  ) => {
    const commitSelection = commitSelectionFromEntries(entries);
    setSelectedCommitPaths(commitSelection.paths);
    setSelectedUntrackedCommitPaths(commitSelection.untrackedPaths);
    setSelectedCommitFileCount(commitSelection.fileCount);
  };
  const refreshChanges = async () => {
    if (!controller || !storeSnapshot?.project?.selectedRepositoryId || changesRefreshing) return;
    setChangesRefreshing(true);
    try {
      await controller.refreshRepository({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      }, ["status"]);
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setChangesRefreshing(false);
    }
  };
  const loadChangeDiff = async (entry: GitChangeEntry | null) => {
    if (!gitStore || !storeSnapshot?.project?.selectedRepositoryId) return;
    const workspaceId = storeSnapshot.project.workspaceId;
    if (!entry) {
      changeDiffAbortRef.current?.abort();
      changeDiffAbortRef.current = null;
      gitStore.getState().updateProjectUi(workspaceId, { selectedPath: null });
      selectedChangeDiffRef.current = null;
      setSelectedChangeDiff(null);
      setSelectedChangeDiffLoading(false);
      return;
    }
    if (!runtime) return;
    const selectedPath = entry.path;
    const repositoryId = storeSnapshot.project.selectedRepositoryId;
    const projectRoot = storeSnapshot.project.projectRoot;
    if (patchActionFeedbackTimerRef.current !== null) {
      window.clearTimeout(patchActionFeedbackTimerRef.current);
      patchActionFeedbackTimerRef.current = null;
    }
    setPatchActionStatus("idle");
    gitStore.getState().updateProjectUi(workspaceId, { selectedPath });
    selectedChangeDiffRef.current = null;
    setSelectedChangeDiff(null);
    setSelectedChangeDiffLoading(true);
    const file = storeSnapshot.status?.files.find((candidate) => candidate.path === selectedPath || candidate.originalPath === selectedPath);
    changeDiffAbortRef.current?.abort();
    const abortController = new AbortController();
    changeDiffAbortRef.current = abortController;
    try {
      const cached = Boolean(entry.indexStatus && !entry.worktreeStatus)
        || Boolean(file?.indexStatus && !file.worktreeStatus);
      const untracked = entry.group === "untracked";
      setSelectedChangePatchAction(cached ? "unstage" : "stage");
      const diff = await runtime.diff({
        workspaceId,
        projectRoot,
        repositoryId,
      }, { cached, untracked, path: selectedPath, signal: abortController.signal });
      if (abortController.signal.aborted || changeDiffAbortRef.current !== abortController) return;
      const currentState = gitStore.getState();
      if (currentState.projects[workspaceId]?.selectedRepositoryId !== repositoryId) return;
      const selected = diff.files.find((candidate) => candidate.newPath === selectedPath || candidate.oldPath === selectedPath)
        ?? (diff.files.length === 1 ? diff.files[0] : undefined);
      const selectedDiff = selected ? { ...diff, files: [selected] } : { ...diff, files: [] };
      selectedChangeDiffRef.current = selectedDiff;
      setSelectedChangeDiff(selectedDiff);
    } catch (error) {
      if (!isAbortError(error)) setActionError(gitUiErrorMessage(error));
    } finally {
      if (changeDiffAbortRef.current === abortController) {
        changeDiffAbortRef.current = null;
        setSelectedChangeDiffLoading(false);
      }
    }
  };
  const focusCommitEditorForFile = () => {
    window.requestAnimationFrame(() => {
      changesWorkspaceRef.current
        ?.querySelector<HTMLTextAreaElement>('textarea[aria-label="提交说明"]')
        ?.focus();
    });
  };
  const openChangeDiffDialog = (entry: GitChangeEntry) => {
    setChangeDiffDialogEntry(entry);
  };
  const runRollbackChanges = async (entries: readonly GitChangeEntry[]) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId || mutation) return;
    const repositoryId = storeSnapshot.project.selectedRepositoryId;
    const scope = {
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId,
    };
    const { trackedPaths, untrackedPaths } = gitChangeRollbackPaths(entries);
    setMutation("restore");
    setActionError(null);
    try {
      if (trackedPaths.length > 0) {
        const command = {
          ...scope,
          paths: trackedPaths,
          idempotencyKey: `tool-window-restore-changes-${Date.now()}`,
          source: "HEAD",
          staged: true,
          worktree: true,
        };
        const confirmation = await runtime.confirmation("restore", command);
        const result = await controller.runCommand(() => runtime.restore({
          ...command,
          confirmationToken: confirmation.token,
        }));
        if (result.state !== "succeeded") {
          setActionError(gitOperationFailureMessage(result));
          return;
        }
      }
      if (untrackedPaths.length > 0) {
        const command = {
          ...scope,
          paths: [...untrackedPaths],
          idempotencyKey: `tool-window-clean-changes-${Date.now()}`,
        };
        const confirmation = await runtime.confirmation("clean", command);
        const result = await controller.runCommand(() => runtime.clean({
          ...command,
          confirmationToken: confirmation.token,
        }));
        if (result.state !== "succeeded") {
          setActionError(gitOperationFailureMessage(result));
          return;
        }
      }
      setPendingChangeRollback(null);
      const rolledBackIds = new Set(entries.map((entry) => entry.id));
      setChangeDiffDialogEntry((current) => current && rolledBackIds.has(current.id) ? null : current);
      setSelectedChangeDiff(null);
      selectedChangeDiffRef.current = null;
      setChangeSelectionResetKey((current) => current + 1);
      await controller.refreshRepository(scope, ["status"]);
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const refreshStalePatchSource = async (identity: GitPatchActionIdentity) => {
    if (!controller || !runtime || !gitStore || storeSnapshot?.project?.workspaceId !== identity.workspaceId) return;
    const projectRoot = storeSnapshot.project.projectRoot;
    const repositoryId = identity.repositoryId as GitRepositoryId;
    const scope = {
      workspaceId: identity.workspaceId,
      projectRoot,
      repositoryId,
    };
    await controller.refreshRepository(scope, ["status"]);
    const state = gitStore.getState();
    const project = state.projects[identity.workspaceId];
    if (project?.projectRoot !== projectRoot || project.selectedRepositoryId !== repositoryId) return;
    const status = state.statusByRepository[repositoryId];
    const target = resolveGitPatchRefreshTarget(
      status,
      state.uiByProject[identity.workspaceId]?.selectedPath,
      identity.sourcePaths,
    );
    if (!status || !target) {
      state.updateProjectUi(identity.workspaceId, { selectedPath: null });
      const emptyDiff: GitDiffSnapshot = {
        repositoryId,
        repositoryVersion: (status?.repositoryVersion ?? identity.repositoryVersion) as GitStatusSnapshot["repositoryVersion"],
        files: [],
      };
      selectedChangeDiffRef.current = emptyDiff;
      setSelectedChangeDiff(emptyDiff);
      return;
    }
    state.updateProjectUi(identity.workspaceId, { selectedPath: target.path });
    const diff = await runtime.diff(scope, {
      cached: target.sourceKind === "index",
      path: target.path,
    });
    const current = gitStore.getState();
    if (current.projects[identity.workspaceId]?.selectedRepositoryId !== repositoryId
        || current.uiByProject[identity.workspaceId]?.selectedPath !== target.path) return;
    const selected = diff.files.find((file) => file.newPath === target.path || file.oldPath === target.path);
    setSelectedChangePatchAction(target.action);
    const selectedDiff = selected ? { ...diff, files: [selected] } : { ...diff, files: [] };
    selectedChangeDiffRef.current = selectedDiff;
    setSelectedChangeDiff(selectedDiff);
  };
  const showPatchActionFeedback = (status: KeydexGitDiffActionStatus) => {
    if (patchActionFeedbackTimerRef.current !== null) {
      window.clearTimeout(patchActionFeedbackTimerRef.current);
      patchActionFeedbackTimerRef.current = null;
    }
    setPatchActionStatus(status);
    if (status === "success" || status === "error") {
      patchActionFeedbackTimerRef.current = window.setTimeout(() => {
        setPatchActionStatus("idle");
        patchActionFeedbackTimerRef.current = null;
      }, 1_000);
    }
  };
  const runStagePatches = async (
    patches: readonly string[],
    identity: GitPatchActionIdentity,
  ) => {
    if (!controller || !runtime || !storeSnapshot?.project || !storeSnapshot.project.selectedRepositoryId || patches.length === 0) return;
    if (patchActionInFlightRef.current) return;
    patchActionInFlightRef.current = true;
    const actionIsCurrent = () => {
      const state = gitStore?.getState();
      return state?.projects[identity.workspaceId]?.selectedRepositoryId === identity.repositoryId;
    };
    const latestState = gitStore?.getState();
    const latestProject = latestState?.projects[identity.workspaceId] ?? null;
    const latestRepositoryId = latestProject?.selectedRepositoryId ?? null;
    const latestSelectedDiff = selectedChangeDiffRef.current;
    const latestDiff = latestRepositoryId && latestSelectedDiff?.repositoryId === latestRepositoryId
      ? latestSelectedDiff
      : null;
    const latestSourceKind = selectedChangePatchAction === "unstage" ? "index" : "working_tree";
    const latestDocument = latestDiff && latestDiff.files.length > 0
      ? gitDocumentFromFiles({
          repositoryId: latestDiff.repositoryId,
          repositoryVersion: latestDiff.repositoryVersion,
          sourceKind: latestSourceKind,
          files: latestDiff.files,
        })
      : null;
    const identityResult = validateGitPatchActionIdentity(identity, {
      workspaceId: latestProject?.workspaceId ?? null,
      repositoryId: latestRepositoryId ? String(latestRepositoryId) : null,
      repositoryVersion: latestRepositoryId
        ? String(latestState?.statusByRepository[latestRepositoryId]?.repositoryVersion
          ?? latestDiff?.repositoryVersion
          ?? "") || null
        : null,
      sourceVersion: latestDocument?.sourceVersion ?? null,
      sourceKind: latestSourceKind,
    });
    if (!identityResult.ok) {
      setActionError(identityResult.message);
      showPatchActionFeedback("error");
      try {
        await refreshStalePatchSource(identity);
      } finally {
        patchActionInFlightRef.current = false;
      }
      return;
    }
    setMutation("patch");
    showPatchActionFeedback("queued");
    setActionError(null);
    let conflictRefreshed = false;
    try {
      for (const [index, patch] of patches.entries()) {
        const result = await controller.runCommand(() => runtime.applyPatch({
          workspaceId: identity.workspaceId,
          projectRoot: storeSnapshot.project!.projectRoot,
          repositoryId: identity.repositoryId as GitRepositoryId,
          idempotencyKey: `tool-window-patch-${Date.now()}-${index}`,
          expectedRepositoryVersion: identity.repositoryVersion,
          expectedSourceVersion: identity.sourceVersion,
          expectedSourcePatch: identity.sourcePatch,
          sourceKind: identity.sourceKind,
          sourcePaths: identity.sourcePaths,
          patch,
          cached: true,
          reverse: selectedChangePatchAction === "unstage",
        }), (operation) => {
          if (actionIsCurrent() && (operation.state === "queued" || operation.state === "running")) {
            showPatchActionFeedback(operation.state);
          }
        });
        if (result.state !== "succeeded") {
          const message = gitOperationFailureMessage(result);
          if (actionIsCurrent()) {
            setActionError(message);
            showPatchActionFeedback("error");
          }
          if (result.result.error_code === "git_operation_conflict") {
            await refreshStalePatchSource(identity);
            conflictRefreshed = true;
          }
          return;
        }
      }
      await refreshStalePatchSource(identity);
      if (actionIsCurrent()) showPatchActionFeedback("success");
    } catch (error) {
      if (actionIsCurrent()) {
        setActionError(gitUiErrorMessage(error));
        showPatchActionFeedback("error");
      }
      if (!conflictRefreshed && isGitOperationConflict(error)) {
        await refreshStalePatchSource(identity);
      }
    } finally {
      patchActionInFlightRef.current = false;
      setMutation(null);
    }
  };
  const closeCommitPushDialog = () => {
    commitPushPreviewAbortRef.current?.abort();
    commitPushDetailAbortRef.current?.abort();
    commitPushPreviewAbortRef.current = null;
    commitPushDetailAbortRef.current = null;
    setCommitPushOpen(false);
    setCommitPushTarget(null);
    setCommitPushCommits([]);
    setSelectedCommitPushObjectId(null);
    setCommitPushDetail(null);
    setCommitPushLoading(false);
    setActionError(null);
  };

  const selectCommitForPush = async (commit: GitCommitSummary) => {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    commitPushDetailAbortRef.current?.abort();
    const abortController = new AbortController();
    commitPushDetailAbortRef.current = abortController;
    const repositoryId = storeSnapshot.project.selectedRepositoryId;
    const cacheKey = `${repositoryId}:${commit.objectId}`;
    const cachedDetail = historyDetailCacheRef.current.get(cacheKey) ?? null;
    setSelectedCommitPushObjectId(commit.objectId);
    setCommitPushDetail(cachedDetail);
    if (cachedDetail) {
      setCommitPushLoading(false);
      return;
    }
    setCommitPushLoading(true);
    try {
      const detail = await runtime.commit({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId,
      }, commit.objectId, { signal: abortController.signal });
      if (abortController.signal.aborted) return;
      historyDetailCacheRef.current.set(cacheKey, detail);
      trimMap(historyDetailCacheRef.current, 100);
      setCommitPushDetail(detail);
    } catch (error) {
      if (!isAbortError(error)) setActionError(gitUiErrorMessage(error));
    } finally {
      if (commitPushDetailAbortRef.current === abortController) {
        commitPushDetailAbortRef.current = null;
        setCommitPushLoading(false);
      }
    }
  };

  const prepareCommitPushPreview = async (branchRef: GitRefsSnapshotRef | null = null) => {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    commitPushPreviewAbortRef.current?.abort();
    const abortController = new AbortController();
    commitPushPreviewAbortRef.current = abortController;
    const scope = {
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    };
    const upstreamTarget = pushTargetFromStatus(storeSnapshot.status ?? null);
    setCommitPushOpen(true);
    setCommitPushTarget(null);
    setCommitPushCommits([]);
    setSelectedCommitPushObjectId(null);
    setCommitPushDetail(null);
    setCommitPushLoading(true);
    setActionError(null);
    try {
      let target: GitCommitPushTarget;
      let revision: string;
      if (branchRef) {
        if (branchRef.kind !== "local") throw new Error("只能推送本地分支。");
        const source = branchRef.shortName;
        const upstream = branchRef.upstream;
        const separator = upstream?.indexOf("/") ?? -1;
        if (upstream && separator > 0 && separator < upstream.length - 1) {
          target = {
            remote: upstream.slice(0, separator),
            source,
            target: upstream.slice(separator + 1),
            upstream,
            setUpstream: false,
          };
          revision = `${upstream}..${source}`;
        } else {
          const availableRemotes = await runtime.remotes(scope, { signal: abortController.signal });
          const remote = availableRemotes[0]?.name;
          if (!remote) throw new Error("当前仓库没有可用的远程仓库。");
          target = {
            remote,
            source,
            target: source,
            upstream: `${remote}/${source}`,
            setUpstream: true,
          };
          const hasRemoteTrackingRef = (storeSnapshot.refs ?? []).some((candidate) =>
            candidate.kind === "remote"
            && (candidate.shortName === target.upstream || candidate.fullName === `refs/remotes/${target.upstream}`),
          );
          revision = hasRemoteTrackingRef ? `${target.upstream}..${source}` : source;
        }
      } else if (upstreamTarget) {
        target = {
          remote: upstreamTarget.remote,
          source: upstreamTarget.branch,
          target: upstreamTarget.target,
          upstream: upstreamTarget.upstream,
          setUpstream: false,
        };
        revision = `${upstreamTarget.upstream}..HEAD`;
      } else {
        const source = storeSnapshot.status?.branch.head;
        if (!source || storeSnapshot.status?.branch.detachedAt) {
          throw new Error("提交已成功，但当前处于分离指针状态，无法推送分支。");
        }
        const availableRemotes = await runtime.remotes(scope, { signal: abortController.signal });
        const remote = availableRemotes[0]?.name;
        if (!remote) throw new Error("提交已成功，但当前仓库没有可用的远程仓库。");
        target = {
          remote,
          source,
          target: source,
          upstream: `${remote}/${source}`,
          setUpstream: true,
        };
        const hasRemoteTrackingRef = (storeSnapshot.refs ?? []).some((ref) =>
          ref.kind === "remote"
          && (ref.shortName === target.upstream || ref.fullName === `refs/remotes/${target.upstream}`),
        );
        revision = hasRemoteTrackingRef ? `${target.upstream}..HEAD` : "HEAD";
      }
      if (abortController.signal.aborted) return;
      setCommitPushTarget(target);

      const commits: GitCommitSummary[] = [];
      let cursor: string | null = null;
      do {
        const page = await runtime.history(scope, {
          revision,
          cursor,
          limit: 200,
          signal: abortController.signal,
        });
        commits.push(...page.commits);
        cursor = page.nextCursor;
      } while (cursor && !abortController.signal.aborted);
      if (abortController.signal.aborted) return;
      setCommitPushCommits(commits);
      setCommitPushLoading(false);
      if (commits[0]) void selectCommitForPush(commits[0]);
    } catch (error) {
      if (!isAbortError(error)) setActionError(gitUiErrorMessage(error));
      setCommitPushLoading(false);
    } finally {
      if (commitPushPreviewAbortRef.current === abortController) {
        commitPushPreviewAbortRef.current = null;
      }
    }
  };

  const confirmCommitPush = async ({ tagMode }: { tagMode: GitPushTagMode }) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId || !commitPushTarget) return;
    setMutation("push");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.push({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-commit-push-${Date.now()}`,
        expectedRepositoryVersion: null,
        remote: commitPushTarget.remote,
        source: commitPushTarget.source,
        target: commitPushTarget.target,
        setUpstream: commitPushTarget.setUpstream,
        tags: tagMode === "all",
        followTags: tagMode === "current_branch",
      }));
      if (result.state !== "succeeded") {
        setActionError(`推送失败：${gitOperationFailureMessage(result)}`);
        return;
      }
      closeCommitPushDialog();
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };

  const runCommit = async (options: GitCommitOptions, pushAfter = false) => {
    if (!controller || !runtime || !storeSnapshot?.project || !storeSnapshot.project.selectedRepositoryId) return;
    setMutation("commit");
    setActionError(null);
    try {
      const command: GitCommitCommand = {
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-commit-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        paths: [...selectedCommitPaths],
        untrackedPaths: [...selectedUntrackedCommitPaths],
        ...options,
      };
      if (options.amend) {
        const confirmation = await runtime.confirmation("commit", command);
        command.confirmationToken = confirmation.token;
      }
      const result = await controller.runCommand(() => runtime.createCommit(command));
      if (result.state !== "succeeded") {
        throw new Error(gitOperationFailureMessage(result));
      }
      setSelectedCommitPaths([]);
      setSelectedUntrackedCommitPaths([]);
      setSelectedCommitFileCount(0);
      setChangeSelectionResetKey((current) => current + 1);
      gitStore?.getState().updateProjectUi(storeSnapshot.project.workspaceId, { commitDraft: "" });
      if (pushAfter) {
        await prepareCommitPushPreview();
      }
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runRefAction = async (action: GitRefAction, ref: GitRefsSnapshotRef) => {
    if (!storeSnapshot?.project) return;
    gitStore?.getState().updateProjectUi(storeSnapshot.project.workspaceId, { selectedRef: ref.fullName });
    if (action === "compare_refs" || action === "compare_worktree") {
      const currentRef = storeSnapshot.status?.branch.head ?? "HEAD";
      gitStore?.getState().requestToolWindowNavigation(
        storeSnapshot.project.workspaceId,
        action === "compare_refs"
          ? { kind: "compare_refs", currentRef, targetRef: ref.shortName }
          : { kind: "compare_worktree", targetRef: ref.shortName },
      );
      return;
    }
    if (action === "push") {
      await prepareCommitPushPreview(ref);
      return;
    }
    if (action === "create_branch" || action === "rename" || action === "delete") {
      setBranchContextName(action === "rename" ? ref.shortName : "");
      setBranchContextDialog({ kind: action === "create_branch" ? "create" : action, ref });
      return;
    }
    if (action === "merge_current" || action === "rebase_current") {
      setPendingBranchOperation({ kind: action === "merge_current" ? "merge" : "rebase", ref });
      if (action === "merge_current") await previewMerge(ref.shortName);
      else await previewRebase(ref.shortName, null);
      return;
    }
    if (action === "update") {
      await runContextBranchUpdate(ref);
      return;
    }
    if (action === "checkout_rebase") {
      await runCheckoutAndRebase(ref);
      return;
    }
    if (storeSnapshot.status?.files.length) {
      setActionError("工作区存在本地改动，请先选择提交、储藏或取消；Keydex 不会自动储藏。");
      return;
    }
    if (!controller || !runtime || !storeSnapshot.project.selectedRepositoryId) return;
    setMutation("checkout");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.checkout({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-checkout-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        ref: ref.shortName,
        detach: ref.kind !== "local",
      }));
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  async function runCheckoutAndRebase(ref: GitRefsSnapshotRef) {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId || ref.current) return;
    const currentBranch = storeSnapshot.status?.branch.head;
    if (!currentBranch) {
      setActionError("当前处于分离指针状态，无法确定变基目标。");
      return;
    }
    if (storeSnapshot.status?.files.length) {
      setActionError("签出并变基要求工作树干净，请先提交或储藏本地改动。");
      return;
    }
    const scope = {
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    };
    setMutation("checkout");
    setActionError(null);
    try {
      const checkout = await controller.runCommand(() => runtime.checkout({
        ...scope,
        idempotencyKey: `tool-window-checkout-rebase-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        ref: ref.shortName,
        detach: false,
      }));
      if (checkout.state !== "succeeded") throw new Error(gitOperationFailureMessage(checkout));
      setMutation("rebase");
      const preview = await runtime.rebasePreview(scope, currentBranch, null);
      if (preview.commits.length === 0) return;
      const command = {
        ...scope,
        idempotencyKey: `tool-window-checkout-rebase-apply-${Date.now()}`,
        expectedRepositoryVersion: preview.repositoryVersion,
        upstream: currentBranch,
        onto: null,
        interactive: false,
        todo: [],
      };
      const confirmation = await runtime.confirmation("rebase", command);
      const result = await controller.runCommand(() => runtime.rebase({ ...command, confirmationToken: confirmation.token }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  }
  async function runContextBranchUpdate(ref: GitRefsSnapshotRef) {
    if (ref.current) {
      await runUpdate(updateStrategy);
      return;
    }
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    const upstream = ref.upstream;
    const separator = upstream?.indexOf("/") ?? -1;
    if (!upstream || separator <= 0 || separator === upstream.length - 1) {
      setActionError(`${ref.shortName} 没有可用于更新的上游分支。`);
      return;
    }
    const remote = upstream.slice(0, separator);
    const remoteBranch = upstream.slice(separator + 1);
    setMutation("update");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.fetch({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-update-branch-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        remote,
        refspec: `refs/heads/${remoteBranch}:refs/heads/${ref.shortName}`,
        allRemotes: false,
        prune: false,
        tags: false,
      }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  }
  async function runHistoryContextAction(action: GitHistoryContextAction, commit: GitCommitSummary) {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    const scope = {
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    };
    if (action === "copy_revision") {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("剪贴板不可用。");
        await navigator.clipboard.writeText(commit.objectId);
      } catch (error) {
        setActionError(gitUiErrorMessage(error));
      }
      return;
    }
    if (action === "compare_worktree") {
      gitStore?.getState().requestToolWindowNavigation(scope.workspaceId, { kind: "compare_worktree", targetRef: commit.objectId });
      return;
    }
    if (action === "reset_branch") {
      setResetTargetSeed(commit.objectId);
      setResetPreview(null);
      activateView("operations");
      return;
    }
    if (action === "create_patch") {
      setMutation("patch");
      setActionError(null);
      try {
        setPatchExport(await runtime.exportPatch(scope, "commit", { left: commit.objectId, right: null, paths: [] }));
        activateView("operations");
      } catch (error) {
        setActionError(gitUiErrorMessage(error));
      } finally {
        setMutation(null);
      }
      return;
    }
    if (action === "show_repository") {
      setRevisionTreeOpen(true);
      setRevisionTree(null);
      setRevisionTreeError(null);
      setRevisionTreeLoading(true);
      try {
        setRevisionTree(await runtime.revisionTree(scope, commit.objectId));
      } catch (error) {
        setRevisionTreeError(gitUiErrorMessage(error));
      } finally {
        setRevisionTreeLoading(false);
      }
      return;
    }
    if (action === "checkout_revision") {
      if (!controller) return;
      if (storeSnapshot.status?.files.length) {
        setActionError("签出修订要求工作树干净，请先提交或储藏本地改动。");
        return;
      }
      setMutation("checkout");
      setActionError(null);
      try {
        const result = await controller.runCommand(() => runtime.checkout({
          ...scope,
          idempotencyKey: `tool-window-checkout-revision-${Date.now()}`,
          expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
          ref: commit.objectId,
          detach: true,
        }));
        if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
      } catch (error) {
        setActionError(gitUiErrorMessage(error));
      } finally {
        setMutation(null);
      }
      return;
    }
    setHistoryRevertMainline("1");
    setPendingHistoryAction({ kind: action, commit });
  }
  async function runUndoHeadCommit(commit: GitCommitSummary) {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId || !commit.parentIds[0]) return;
    const scope = {
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    };
    setMutation("reset");
    setActionError(null);
    try {
      const preview = await runtime.resetPreview(scope, commit.parentIds[0], "soft");
      const command = {
        ...scope,
        idempotencyKey: `tool-window-undo-commit-${Date.now()}`,
        expectedRepositoryVersion: preview.repositoryVersion,
        target: commit.parentIds[0],
        mode: "soft" as const,
      };
      const confirmation = await runtime.confirmation("reset", command);
      const result = await controller.runCommand(() => runtime.reset({ ...command, confirmationToken: confirmation.token }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  }
  const runCreateBranch = async (branchName: string, startPoint: string) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("branch");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.createBranch({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-create-branch-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        branchName,
        startPoint,
      }));
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runRenameBranch = async (ref: GitRefsSnapshotRef, newName: string) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("branch");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.renameBranch({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-rename-branch-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        oldName: ref.shortName,
        newName,
      }));
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runDeleteBranch = async (ref: GitRefsSnapshotRef, force: boolean) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    const remoteFullName = ref.fullName.startsWith("refs/remotes/")
      ? ref.fullName.slice("refs/remotes/".length)
      : null;
    const remoteSeparator = remoteFullName?.indexOf("/") ?? -1;
    const remote = remoteFullName && remoteSeparator > 0 ? remoteFullName.slice(0, remoteSeparator) : null;
    const branchName = remote
      ? remoteFullName!.slice(remoteSeparator + 1)
      : ref.fullName.startsWith("refs/heads/")
        ? ref.fullName.slice("refs/heads/".length)
        : ref.shortName;
    setMutation("branch");
    setActionError(null);
    try {
      const command = {
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        idempotencyKey: `tool-window-delete-branch-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        branchName,
        force,
        remote,
      };
      const confirmation = await runtime.confirmation("delete_branch", command);
      const result = await controller.runCommand(() => runtime.deleteBranch({
        ...command,
        confirmationToken: confirmation.token,
      }));
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runCreateTag = async (options: { name: string; target: string; annotated: boolean; message: string; sign: boolean }) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("branch");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.createTag({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-create-tag-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        tagName: options.name,
        target: options.target,
        annotated: options.annotated,
        message: options.message || null,
        sign: options.sign,
      }));
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runDeleteTag = async (ref: GitRefsSnapshotRef, remote: string | null) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("branch");
    setActionError(null);
    try {
      const command = {
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        idempotencyKey: `tool-window-delete-tag-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        tagName: ref.shortName,
        remote,
      };
      const confirmation = await runtime.confirmation("delete_tag", command);
      const result = await controller.runCommand(() => runtime.deleteTag({
        ...command,
        confirmationToken: confirmation.token,
      }));
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runPushTag = async (ref: GitRefsSnapshotRef, remote: string) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("push");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.push({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-push-tag-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        remote,
        source: "HEAD",
        target: storeSnapshot.status?.branch.head ?? "HEAD",
        tagName: ref.shortName,
      }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const reloadRemotes = async () => {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setRemotes(await runtime.remotes({
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    }));
  };
  const runAddRemote = async (name: string, fetchUrl: string, pushUrl: string | null): Promise<boolean> => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return false;
    setMutation("branch");
    setActionError(null);
    const scope = {
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    };
    try {
      const added = await controller.runCommand(() => runtime.addRemote({
        ...scope,
        idempotencyKey: `tool-window-add-remote-${Date.now()}`,
        remoteName: name,
        url: fetchUrl,
      }));
      if (added.state !== "succeeded") throw new Error(gitOperationFailureMessage(added));
      if (pushUrl && pushUrl !== fetchUrl) {
        const updated = await controller.runCommand(() => runtime.setRemoteUrl({
          ...scope,
          idempotencyKey: `tool-window-push-url-${Date.now()}`,
          remoteName: name,
          url: pushUrl,
          push: true,
        }));
        if (updated.state !== "succeeded") throw new Error(gitOperationFailureMessage(updated));
      }
      await reloadRemotes();
      return true;
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
      return false;
    } finally {
      setMutation(null);
    }
  };
  const runRenameRemote = async (oldName: string, newName: string): Promise<boolean> => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return false;
    setMutation("branch");
    try {
      const result = await controller.runCommand(() => runtime.renameRemote({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-rename-remote-${Date.now()}`,
        oldName,
        newName,
      }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
      await reloadRemotes();
      return true;
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
      return false;
    } finally {
      setMutation(null);
    }
  };
  const runSetRemoteUrl = async (name: string, url: string, push: boolean): Promise<boolean> => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return false;
    setMutation("branch");
    try {
      const result = await controller.runCommand(() => runtime.setRemoteUrl({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-set-remote-url-${Date.now()}`,
        remoteName: name,
        url,
        push,
      }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
      await reloadRemotes();
      return true;
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
      return false;
    } finally {
      setMutation(null);
    }
  };
  const runRemoveRemote = async (remote: GitRemoteInfo) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("branch");
    try {
      const command = {
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        idempotencyKey: `tool-window-remove-remote-${Date.now()}`,
        remoteName: remote.name,
      };
      const confirmation = await runtime.confirmation("remove_remote", command);
      const result = await controller.runCommand(() => runtime.removeRemote({ ...command, confirmationToken: confirmation.token }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
      await reloadRemotes();
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runSetUpstream = async (branch: GitRefsSnapshotRef, upstream: string | null) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("branch");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.setUpstream({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-upstream-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        branchName: branch.shortName,
        upstream,
      }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runFetch = async (options: GitFetchOptions) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("fetch");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.fetch({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-fetch-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        ...options,
      }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const updateStrategy: GitUpdateStrategy = storeSnapshot?.project?.selectedRepositoryId
    ? storeSnapshot.ui?.updateStrategyByRepository[storeSnapshot.project.selectedRepositoryId] ?? "ff_only"
    : "ff_only";
  const setUpdateStrategy = (strategy: GitUpdateStrategy) => {
    if (!storeSnapshot?.project?.selectedRepositoryId) return;
    gitStore?.getState().updateProjectUi(storeSnapshot.project.workspaceId, {
      updateStrategyByRepository: {
        ...(storeSnapshot.ui?.updateStrategyByRepository ?? {}),
        [storeSnapshot.project.selectedRepositoryId]: strategy,
      },
    });
  };
  const runUpdate = async (strategy: GitUpdateStrategy): Promise<boolean> => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return false;
    const upstream = storeSnapshot.status?.branch.upstream;
    if (!upstream) {
      setActionError("当前分支没有上游，请先明确设置后再更新。");
      return false;
    }
    const separator = upstream.indexOf("/");
    if (separator <= 0 || separator === upstream.length - 1) {
      setActionError(`无法解析上游：${upstream}`);
      return false;
    }
    setMutation("update");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.update({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-update-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        remote: upstream.slice(0, separator),
        refspec: upstream.slice(separator + 1),
        strategy,
      }));
      if (result.state !== "succeeded") {
        const message = gitOperationFailureMessage(result);
        throw new Error(message);
      }
      return true;
    } catch (error) {
      const message = gitUiErrorMessage(error);
      setActionError(message);
      return false;
    } finally {
      setMutation(null);
    }
  };
  const runPush = async (options: GitPushOptions): Promise<boolean> => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return false;
    setMutation("push");
    setActionError(null);
    try {
      const command: GitPushCommand = {
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-push-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        ...options,
      };
      if (options.forceWithLease) {
        const confirmation = await runtime.confirmation("push", command);
        command.confirmationToken = confirmation.token;
      }
      const result = await controller.runCommand(() => runtime.push(command));
      if (result.state !== "succeeded") {
        const message = gitOperationFailureMessage(result);
        if (/non-fast-forward|rejected|fetch first/i.test(message)) {
          throw new Error(`${message}。请先获取或更新，确认远程提交后再重试。`);
        }
        throw new Error(message);
      }
      return true;
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
      return false;
    } finally {
      setMutation(null);
    }
  };
  const selectStash = async (entry: GitStashEntry) => {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setSelectedStash(entry);
    setStashDetail(null);
    setStashFileIndex(0);
    setStashLoading(true);
    setActionError(null);
    try {
      setStashDetail(await runtime.stashDetail({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      }, entry.selector, entry.objectId));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setStashLoading(false);
    }
  };
  const loadMoreStashes = async () => {
    if (!runtime || !stashCursor || !storeSnapshot?.project?.selectedRepositoryId) return;
    setStashLoading(true);
    try {
      const page = await runtime.stashList({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      }, { cursor: stashCursor, limit: 50 });
      setStashEntries((current) => [...current, ...page.entries.filter((entry) => !current.some((item) => item.objectId === entry.objectId))]);
      setStashCursor(page.nextCursor);
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setStashLoading(false);
    }
  };
  const reloadStashes = async () => {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    const scope = {
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    };
    const page = await runtime.stashList(scope, { limit: 50 });
    setStashEntries(page.entries);
    setStashCursor(page.nextCursor);
    const nextSelected = page.entries.find((entry) => entry.objectId === selectedStash?.objectId) ?? page.entries[0] ?? null;
    setSelectedStash(nextSelected);
    setStashFileIndex(0);
    setStashDetail(nextSelected ? await runtime.stashDetail(scope, nextSelected.selector, nextSelected.objectId) : null);
  };
  const runCreateStash = async (options: { message: string; staged: boolean; includeUntracked: boolean }): Promise<boolean> => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return false;
    setMutation("stash");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.createStash({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-stash-create-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        message: options.message.trim() || null,
        staged: options.staged,
        includeUntracked: options.includeUntracked,
      }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
      await reloadStashes();
      return true;
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
      return false;
    } finally {
      setMutation(null);
    }
  };
  const runStashAndCheckout = async (ref: GitRefsSnapshotRef) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("checkout");
    setActionError(null);
    try {
      const scope = {
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      };
      const stashed = await controller.runCommand(() => runtime.createStash({
        ...scope,
        idempotencyKey: `tool-window-stash-before-checkout-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        message: `Keydex：切换到 ${ref.shortName} 前的自动储藏`,
        staged: false,
        includeUntracked: true,
      }));
      if (stashed.state !== "succeeded") throw new Error(gitOperationFailureMessage(stashed));
      const checkoutRef = ref.fullName.startsWith("refs/heads/")
        ? ref.fullName.slice("refs/heads/".length)
        : ref.shortName;
      const checkedOut = await controller.runCommand(() => runtime.checkout({
        ...scope,
        idempotencyKey: `tool-window-checkout-after-stash-${Date.now()}`,
        expectedRepositoryVersion: null,
        ref: checkoutRef,
        detach: ref.kind !== "local",
      }));
      if (checkedOut.state !== "succeeded") throw new Error(gitOperationFailureMessage(checkedOut));
      await reloadStashes();
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runStashEntryAction = async (action: "apply" | "pop" | "drop", entry: GitStashEntry, reinstateIndex = false): Promise<boolean> => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return false;
    setMutation("stash");
    setActionError(null);
    try {
      const command: GitStashEntryCommand = {
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        idempotencyKey: `tool-window-stash-${action}-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        selector: entry.selector,
        objectId: entry.objectId,
        reinstateIndex,
      };
      if (action === "drop") {
        const confirmation = await runtime.confirmation("stash_drop", command);
        command.confirmationToken = confirmation.token;
      }
      const result = await controller.runCommand(() => action === "apply"
        ? runtime.applyStash(command)
        : action === "pop"
          ? runtime.popStash(command)
          : runtime.dropStash(command));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
      await reloadStashes();
      return true;
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
      return false;
    } finally {
      setMutation(null);
    }
  };
  const runStashBranch = async (entry: GitStashEntry, branchName: string): Promise<boolean> => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return false;
    setMutation("stash");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.branchFromStash({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-stash-branch-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        selector: entry.selector,
        objectId: entry.objectId,
        branchName,
      }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
      await reloadStashes();
      return true;
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
      return false;
    } finally {
      setMutation(null);
    }
  };
  const runClearStashes = async () => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId || stashEntries.length === 0) return;
    setMutation("stash");
    setActionError(null);
    try {
      const command = {
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        idempotencyKey: `tool-window-stash-clear-${Date.now()}`,
      };
      const confirmation = await runtime.confirmation("stash_clear", command);
      const result = await controller.runCommand(() => runtime.clearStashes({ ...command, confirmationToken: confirmation.token }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
      await reloadStashes();
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const loadMoreHistory = async () => {
    if (!runtime || !historyCursor || !storeSnapshot?.project?.selectedRepositoryId || historyLoading) return;
    setHistoryLoading(true);
    try {
      const page = await runtime.history({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      }, { cursor: historyCursor, limit: GIT_HISTORY_PAGE_SIZE, ...historyFilters });
      setHistoryCommits((current) => mergeHistoryPages(current, page.commits, "append"));
      setHistoryAuthors((current) => mergeHistoryAuthors(current, page.commits));
      setHistoryCursor(page.nextCursor);
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setHistoryLoading(false);
    }
  };
  const refreshHistory = async () => {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId || historyLoading) return;
    setHistoryLoading(true);
    try {
      const page = await runtime.history({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      }, { limit: GIT_HISTORY_PAGE_SIZE, ...historyFilters });
      const merged = mergeHistoryPages(historyCommits, page.commits, "prepend");
      setHistoryCommits(merged);
      setHistoryAuthors((current) => mergeHistoryAuthors(current, page.commits));
      setHistoryCursor(page.nextCursor);
      selectHistoryObjectId(selectedHistoryObjectId && merged.some((commit) => commit.objectId === selectedHistoryObjectId)
        ? selectedHistoryObjectId
        : page.commits[0]?.objectId ?? null);
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setHistoryLoading(false);
    }
  };
  const runBlame = async (request: GitBlameRequest) => {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setBlameLoading(true);
    setActionError(null);
    try {
      setBlamePage(await runtime.blame({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      }, {
        path: request.path,
        revision: request.revision || null,
        lineCount: 250,
        ignoreRevsFile: request.ignoreRevsFile,
      }));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setBlameLoading(false);
    }
  };
  const loadMoreBlame = async () => {
    if (!runtime || !blamePage?.nextStartLine || !storeSnapshot?.project?.selectedRepositoryId) return;
    setBlameLoading(true);
    setActionError(null);
    try {
      const next = await runtime.blame({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      }, {
        path: blamePage.path,
        revision: blamePage.revision,
        startLine: blamePage.nextStartLine,
        lineCount: 250,
        ignoreRevsFile: blamePage.ignoreRevsFile,
      });
      setBlamePage({
        ...next,
        startLine: blamePage.startLine,
        lines: [...blamePage.lines, ...next.lines],
      });
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setBlameLoading(false);
    }
  };
  const loadReflog = async (ref: string) => {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setReflogLoading(true);
    setActionError(null);
    try {
      setReflogPage(await runtime.reflog({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      }, { ref, limit: 100 }));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setReflogLoading(false);
    }
  };
  const loadMoreReflog = async () => {
    if (!runtime || !reflogPage?.nextCursor || !storeSnapshot?.project?.selectedRepositoryId) return;
    setReflogLoading(true);
    setActionError(null);
    try {
      const next = await runtime.reflog({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      }, { ref: reflogPage.ref, cursor: reflogPage.nextCursor, limit: 100 });
      const seen = new Set(reflogPage.entries.map((entry) => `${entry.selector}:${entry.objectId}`));
      setReflogPage({
        ...next,
        entries: [
          ...reflogPage.entries,
          ...next.entries.filter((entry) => !seen.has(`${entry.selector}:${entry.objectId}`)),
        ],
      });
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setReflogLoading(false);
    }
  };
  const previewMerge = async (source: string) => {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("merge");
    setActionError(null);
    try {
      setMergePreview(await runtime.mergePreview({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      }, source));
    } catch (error) {
      setMergePreview(null);
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runMerge = async (source: string, strategy: GitMergeStrategy, message: string) => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("merge");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.merge({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-merge-${Date.now()}`,
        expectedRepositoryVersion: mergePreview?.repositoryVersion ?? storeSnapshot.status?.repositoryVersion ?? null,
        source,
        strategy,
        message: message.trim() || null,
      }));
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
      else setMergePreview(null);
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const abortMerge = async () => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("merge");
    setActionError(null);
    try {
      const command = {
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        idempotencyKey: `tool-window-merge-abort-${Date.now()}`,
      };
      const confirmation = await runtime.confirmation("merge_abort", command);
      const result = await controller.runCommand(() => runtime.abortMerge({
        ...command,
        confirmationToken: confirmation.token,
      }));
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const previewRebase = async (upstream: string, onto: string | null) => {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("rebase");
    setActionError(null);
    try {
      setRebasePreview(await runtime.rebasePreview({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      }, upstream, onto));
    } catch (error) {
      setRebasePreview(null);
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runRebase = async (
    upstream: string,
    onto: string | null,
    interactive: boolean,
    todo: readonly GitRebaseTodoItem[],
  ) => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("rebase");
    setActionError(null);
    try {
      const command = {
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        idempotencyKey: `tool-window-rebase-${Date.now()}`,
        expectedRepositoryVersion: rebasePreview?.repositoryVersion ?? storeSnapshot.status?.repositoryVersion ?? null,
        upstream,
        onto,
        interactive,
        todo,
      };
      const confirmation = await runtime.confirmation("rebase", command);
      const result = await controller.runCommand(() => runtime.rebase({
        ...command,
        confirmationToken: confirmation.token,
      }));
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
      else setRebasePreview(null);
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const controlRebase = async (action: "continue" | "skip" | "abort") => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("rebase");
    setActionError(null);
    try {
      const command = {
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        idempotencyKey: `tool-window-rebase-${action}-${Date.now()}`,
        action,
      };
      const confirmationToken = action === "continue"
        ? null
        : (await runtime.confirmation("rebase_control", command)).token;
      const result = await controller.runCommand(() => runtime.controlRebase({
        ...command,
        confirmationToken,
      }));
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runCherryPick = async (commits: readonly string[], recordOrigin: boolean) => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId) return;
    setCherryPickCommits([...commits]);
    setSkippedCherryPickCommits([]);
    setCherryPickOutcome(null);
    setMutation("cherry_pick");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.cherryPick({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-cherry-pick-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        commits,
        recordOrigin,
      }));
      setCherryPickOutcome(result);
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const controlCherryPick = async (action: "continue" | "skip" | "abort") => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("cherry_pick");
    setActionError(null);
    try {
      const command = {
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        idempotencyKey: `tool-window-cherry-pick-${action}-${Date.now()}`,
        action,
      };
      const confirmationToken = action === "continue"
        ? null
        : (await runtime.confirmation("cherry_pick_control", command)).token;
      const skippedObjectId = action === "skip"
        ? storeSnapshot.status?.operation?.currentObjectId ?? null
        : null;
      const result = await controller.runCommand(() => runtime.controlCherryPick({
        ...command,
        confirmationToken,
      }));
      setCherryPickOutcome(result);
      if (result.state === "succeeded" && skippedObjectId) {
        setSkippedCherryPickCommits((current) => current.includes(skippedObjectId)
          ? current
          : [...current, skippedObjectId]);
      }
      if (result.state === "succeeded" && action === "abort") setSkippedCherryPickCommits([]);
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runRevert = async (commits: readonly string[], mainline: number | null) => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId) return;
    setRevertCommits([...commits]);
    setRevertOutcome(null);
    setMutation("revert");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.revert({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-revert-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        commits,
        mainline,
      }));
      setRevertOutcome(result);
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const controlRevert = async (action: "continue" | "skip" | "abort") => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("revert");
    setActionError(null);
    try {
      const command = {
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        idempotencyKey: `tool-window-revert-${action}-${Date.now()}`,
        action,
      };
      const confirmationToken = action === "continue"
        ? null
        : (await runtime.confirmation("revert_control", command)).token;
      const result = await controller.runCommand(() => runtime.controlRevert({
        ...command,
        confirmationToken,
      }));
      setRevertOutcome(result);
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const previewReset = async (target: string, mode: GitResetMode) => {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("reset");
    setActionError(null);
    try {
      setResetPreview(await runtime.resetPreview({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      }, target, mode));
    } catch (error) {
      setResetPreview(null);
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const refreshBisect = async () => {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setBisectSnapshot(await runtime.bisect({
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    }));
  };
  const startBisect = async (goodRevision: string, badRevision: string) => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId) return;
    if (storeSnapshot.status?.files.length) {
      setActionError("二分定位要求工作树和暂存区没有改动。请先提交、储藏或丢弃本地改动。");
      return;
    }
    setMutation("bisect");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.startBisect({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-bisect-start-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        goodRevision,
        badRevision,
      }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
      await refreshBisect();
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const controlBisect = async (action: "good" | "bad" | "skip" | "reset") => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("bisect");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.controlBisect({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-bisect-${action}-${Date.now()}`,
        action,
      }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
      await refreshBisect();
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runSubmoduleAction = async (
    action: GitSubmoduleAction,
    paths: readonly string[],
    recursive: boolean,
    force: boolean,
  ) => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId) return;
    const highRisk = action === "deinit" || recursive;
    setMutation("submodule");
    setActionError(null);
    try {
      const command = {
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        idempotencyKey: `tool-window-submodule-${action}-${Date.now()}`,
        expectedRepositoryVersion: submodulesSnapshot?.repositoryVersion ?? null,
        action,
        paths,
        recursive,
        force,
      };
      const confirmationToken = highRisk
        ? (await runtime.confirmation("submodule_action", command)).token
        : null;
      const result = await controller.runCommand(() => runtime.submoduleAction({
        ...command,
        confirmationToken,
      }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
      setSubmodulesSnapshot(await runtime.submodules({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      }));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const refreshWorktrees = async () => {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setWorktreesSnapshot(await runtime.worktrees({
      workspaceId: storeSnapshot.project.workspaceId,
      projectRoot: storeSnapshot.project.projectRoot,
      repositoryId: storeSnapshot.project.selectedRepositoryId,
    }));
  };
  const authorizeWorktree = async (path: string) => {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId || !path) return;
    setMutation("worktree");
    setActionError(null);
    try {
      await runtime.authorizeWorktree({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        worktreePath: path,
      });
      await refreshWorktrees();
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const revokeWorktree = async (path: string) => {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("worktree");
    setActionError(null);
    try {
      await runtime.revokeWorktree({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        worktreePath: path,
      });
      await refreshWorktrees();
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runWorktreeAction = async (
    action: "add" | "remove" | "prune" | "lock" | "unlock",
    options: Partial<GitWorktreeAddOptions> & {
      path?: string | null;
      dirty?: boolean | null;
      lockReason?: string | null;
    } = {},
  ) => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId) return;
    const path = options.path ?? null;
    setMutation("worktree");
    setActionError(null);
    try {
      const command = {
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        idempotencyKey: `tool-window-worktree-${action}-${Date.now()}`,
        expectedRepositoryVersion: worktreesSnapshot?.repositoryVersion ?? null,
        action,
        worktreePath: path,
        revision: options.revision ?? "HEAD",
        newBranch: options.newBranch ?? null,
        detach: options.detach ?? false,
        force: action === "remove" && options.dirty === true,
        lockReason: options.lockReason ?? null,
        dirtyConfirmed: action === "remove" && options.dirty === true,
      } as const;
      const confirmationToken = action === "remove" || action === "prune"
        ? (await runtime.confirmation("worktree_action", command)).token
        : null;
      const result = await controller.runCommand(() => runtime.worktreeAction({
        ...command,
        confirmationToken,
      }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
      await refreshWorktrees();
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runLfsAction = async (action: GitLfsAction, remote: string | null, refspec: string | null) => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId || !lfsSnapshot?.available) return;
    setMutation("lfs");
    setActionError(null);
    try {
      const result = await controller.runCommand(() => runtime.lfsAction({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-lfs-${action}-${Date.now()}`,
        expectedRepositoryVersion: lfsSnapshot.repositoryVersion,
        action,
        remote,
        refspec,
      }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
      setLfsSnapshot(await runtime.lfs({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      }));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runReset = async (target: string, mode: GitResetMode) => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId || !resetPreview) return;
    setMutation("reset");
    setActionError(null);
    try {
      const command = {
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        idempotencyKey: `tool-window-reset-${Date.now()}`,
        expectedRepositoryVersion: resetPreview.repositoryVersion,
        target,
        mode,
      };
      const confirmation = await runtime.confirmation("reset", command);
      const result = await controller.runCommand(() => runtime.reset({ ...command, confirmationToken: confirmation.token }));
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
      else setResetPreview(null);
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runRestore = async (paths: readonly string[], source: string | null, staged: boolean, worktree: boolean) => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("restore");
    setActionError(null);
    try {
      const command = {
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        idempotencyKey: `tool-window-restore-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        paths,
        source,
        staged,
        worktree,
      };
      const confirmationToken = worktree ? (await runtime.confirmation("restore", command)).token : null;
      const result = await controller.runCommand(() => runtime.restore({ ...command, confirmationToken }));
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const exportPatch = async (mode: GitPatchExportMode, left: string | null, right: string | null, paths: readonly string[]) => {
    if (!runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("patch");
    setActionError(null);
    try {
      setPatchExport(await runtime.exportPatch({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      }, mode, { left, right, paths }));
    } catch (error) {
      setPatchExport(null);
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const checkImportedPatch = async (patch: string, options: GitPatchImportOptions) => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId) return;
    setMutation("patch");
    setActionError(null);
    setPatchDryRunSignature(null);
    try {
      const result = await controller.runCommand(() => runtime.applyPatch({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-patch-check-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        patch,
        cached: options.cached,
        reverse: options.reverse,
        checkOnly: true,
        reject: false,
      }));
      if (result.state === "succeeded") setPatchDryRunSignature(patchImportSignature(patch, options));
      else setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const applyImportedPatch = async (patch: string, options: GitPatchImportOptions) => {
    if (!runtime || !controller || !storeSnapshot?.project?.selectedRepositoryId) return;
    if (patchDryRunSignature !== patchImportSignature(patch, options)) return;
    setMutation("patch");
    setActionError(null);
    try {
      const base = {
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        patch,
        cached: options.cached,
        reverse: options.reverse,
      };
      const recheck = await controller.runCommand(() => runtime.applyPatch({ ...base, idempotencyKey: `tool-window-patch-recheck-${Date.now()}`, checkOnly: true, reject: false }));
      if (recheck.state !== "succeeded") {
        setPatchDryRunSignature(null);
        setActionError(gitOperationFailureMessage(recheck));
        return;
      }
      const result = await controller.runCommand(() => runtime.applyPatch({ ...base, idempotencyKey: `tool-window-patch-apply-${Date.now()}`, checkOnly: false, reject: options.reject }));
      setPatchDryRunSignature(null);
      if (result.state !== "succeeded") setActionError(gitOperationFailureMessage(result));
    } catch (error) {
      setPatchDryRunSignature(null);
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runRecoveredOperationAction = (action: GitRecoveryAction) => {
    const kind = storeSnapshot?.status?.operation?.kind;
    if (action === "resolve" || action === "complete") {
      activateView("changes");
      return;
    }
    if (kind === "merge" && action === "abort") void abortMerge();
    else if (kind === "rebase") void controlRebase(action as "continue" | "skip" | "abort");
    else if (kind === "cherry_pick") void controlCherryPick(action as "continue" | "skip" | "abort");
    else if (kind === "revert") void controlRevert(action as "continue" | "skip" | "abort");
  };
  const saveConflictResult = async (
    content: string,
    encoding: GitConflictSaveEncoding,
    eol: GitConflictSaveEol,
  ) => {
    const projectState = storeSnapshot?.project;
    const selected = conflicts?.files.find((file) => file.path === selectedConflictPath);
    if (!runtime || !projectState?.selectedRepositoryId || !selected) return;
    setMutation("conflict_save");
    setActionError(null);
    try {
      const result = await runtime.saveConflictResult({
        workspaceId: projectState.workspaceId,
        projectRoot: projectState.projectRoot,
        repositoryId: projectState.selectedRepositoryId,
        path: selected.path,
        content,
        encoding,
        eol,
        expectedResultRevision: selected.resultRevision,
        expectedStages: selected.stages.map((stage) => ({
          stage: stage.stage,
          objectId: stage.objectId,
        })),
      });
      setConflicts((current) => current ? {
        ...current,
        repositoryVersion: result.repositoryVersion,
        files: current.files.map((file) => file.path === selected.path ? {
          ...file,
          resultContent: content,
          resultEncoding: encoding,
          resultEol: eol,
          resultRevision: result.resultRevision,
        } : file),
      } : current);
      setMergeEditorDirty(false);
    } catch (error) {
      const message = gitUiErrorMessage(error);
      setActionError(message);
      throw error;
    } finally {
      setMutation(null);
    }
  };
  const selectedConflict = conflicts?.files.find((file) => file.path === selectedConflictPath) ?? null;
  const runConflictAction = async (action: GitConflictFileAction) => {
    const projectState = storeSnapshot?.project;
    const source = action === "reopen" ? recentlyResolvedConflict?.file : selectedConflict;
    if (!runtime || !controller || !projectState?.selectedRepositoryId || !source) return;
    setMutation("conflict_action");
    setActionError(null);
    try {
      const command: GitConflictActionCommand = {
        workspaceId: projectState.workspaceId,
        projectRoot: projectState.projectRoot,
        repositoryId: projectState.selectedRepositoryId,
        idempotencyKey: `tool-window-conflict-${action}-${Date.now()}`,
        action,
        path: source.path,
        expectedStages: source.stages.map((stage) => ({
          stage: stage.stage,
          objectId: stage.objectId,
          mode: stage.mode,
        })),
        resolvedIndexEntry: action === "reopen"
          ? recentlyResolvedConflict?.resolvedIndexEntry ?? null
          : null,
      };
      const destructive = !["mark_resolved", "reopen"].includes(action);
      const confirmationToken = destructive
        ? (await runtime.confirmation("conflict_action", command)).token
        : null;
      const result = await controller.runCommand(() => runtime.conflictAction({
        ...command,
        confirmationToken,
      }));
      if (result.state !== "succeeded") throw new Error(gitOperationFailureMessage(result));
      if (action === "mark_resolved") {
        const resolvedIndexEntry = String(result.result.resolved_index ?? "");
        if (!resolvedIndexEntry) throw new Error("Git 没有返回已解决的暂存区条目");
        setRecentlyResolvedConflict({ file: source, resolvedIndexEntry });
      } else if (action === "reopen") {
        setRecentlyResolvedConflict(null);
      }
      const next = await runtime.conflicts({
        workspaceId: projectState.workspaceId,
        projectRoot: projectState.projectRoot,
        repositoryId: projectState.selectedRepositoryId,
      });
      setConflicts(next);
      setSelectedConflictPath(
        next.files.some((file) => file.path === source.path)
          ? source.path
          : next.files[0]?.path ?? null,
      );
      setMergeEditorDirty(false);
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const unresolvedConflictBlocks = selectedConflict
    ? parseConflictBlocks(selectedConflict.resultContent ?? "").length
    : 0;
  const changesDetailSurface = gitChangesDetailSurface(selectedConflict);
  const selectedConflictDiffFiles = selectedConflict
    ? (storeSnapshot?.diff?.files ?? []).filter((file) =>
        file.newPath === selectedConflict.path || file.oldPath === selectedConflict.path)
    : [];
  const comparisonSelectedFiles = comparisonIntent?.kind === "compare_worktree"
    ? comparisonFileResult?.files ?? []
    : [];
  const comparisonNavigationHidden = view === "changes" || view === "compare";

  return (
    <section
      className={styles.root}
      data-layout={maximized ? "maximized" : "split"}
      data-resizing={navigationResize.dragging || detailResize.dragging || commitEditorResize.dragging ? "true" : undefined}
      data-testid="git-tool-window"
    >
      <div className={styles.tabs} data-testid="git-tool-tabs">
        {projectSelector ? (
          <div className={styles.projectSelector} data-testid="git-project-name">
            <WorkspaceSelector
              {...projectSelector}
              allowProjectFreeChat={false}
              placement="bottom"
              variant="titlebar"
            />
          </div>
        ) : (
          <strong className={styles.projectName} data-testid="git-project-name" title={resolvedProject.name}>
            {resolvedProject.name}
          </strong>
        )}
        <div className={styles.tabCenter}>
          <nav className={styles.primaryTabs} role="tablist" aria-label="Git 面板视图">
            {PRIMARY_VIEWS.map((candidate) => {
              const Icon = candidate.icon;
              return (
                <button
                  key={candidate.id}
                  type="button"
                  role="tab"
                  id={`git-tool-tab-${candidate.id}`}
                  aria-controls="git-tool-panel"
                  aria-selected={view === candidate.id}
                  tabIndex={view === candidate.id ? 0 : -1}
                  ref={(element) => {
                    if (element) tabRefs.current.set(candidate.id, element);
                    else tabRefs.current.delete(candidate.id);
                  }}
                  className={styles.tab}
                  data-active={view === candidate.id ? "true" : "false"}
                  onClick={() => activateView(candidate.id)}
                  onKeyDown={(event) => {
                    const target = adjacentGitToolView(candidate.id, event.key);
                    if (!target) return;
                    event.preventDefault();
                    if (activateView(target)) tabRefs.current.get(target)?.focus();
                  }}
                >
                  <Icon size={14} />
                  <span>{candidate.label}</span>
                </button>
              );
            })}
          </nav>
          <div className={styles.moreRoot} ref={moreRootRef}>
          <button
            type="button"
            ref={moreTriggerRef}
            className={styles.tab}
            data-active={MORE_VIEWS.some((candidate) => candidate.id === view) ? "true" : "false"}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-label="更多 Git 视图"
            onClick={() => setMoreOpen((current) => !current)}
            onKeyDown={(event) => {
              if (!['ArrowDown', 'Enter', ' '].includes(event.key)) return;
              event.preventDefault();
              setMoreOpen(true);
              queueMicrotask(() => moreRootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
            }}
          >
            <MoreHorizontal size={14} />
            <span>更多</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {moreOpen ? (
            <div className={styles.moreMenu} role="menu" aria-label="更多 Git 视图">
              {MORE_VIEWS.map((candidate) => {
                const Icon = candidate.icon;
                return (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.moreMenuItem}
                    data-active={view === candidate.id ? "true" : "false"}
                    key={candidate.id}
                    onClick={() => {
                      if (activateView(candidate.id)) setMoreOpen(false);
                    }}
                  >
                    <Icon size={15} />
                    <span><strong>{candidate.label}</strong><small>{candidate.description}</small></span>
                  </button>
                );
              })}
            </div>
          ) : null}
          </div>
        </div>
        <span className={styles.tabsBalance} aria-hidden="true" />
      </div>

      <div
        className={styles.workspace}
        data-navigation={comparisonNavigationHidden ? "hidden" : "visible"}
        data-view={view}
        data-testid="git-workspace"
        ref={workspaceRef}
        style={{
          "--git-navigation-pane-width": `${navigationPanePercent}%`,
          "--git-detail-pane-width": `${view === "changes" ? commitPanePercent : detailPanePercent}%`,
        } as CSSProperties}
      >
        {!comparisonNavigationHidden ? (
          <>
            <aside className={styles.navigation} aria-label="Git 仓库导航">
              <div className={styles.repositorySection} data-expanded={repositoryExpanded ? "true" : "false"}>
                <button
                  type="button"
                  className={styles.repositoryToggle}
                  aria-expanded={repositoryExpanded}
                  onClick={() => setRepositoryExpanded((current) => !current)}
                >
                  <ChevronRight
                    className={styles.repositoryChevron}
                    data-expanded={repositoryExpanded ? "true" : "false"}
                    size={12}
                    aria-hidden="true"
                  />
                  <span className={styles.paneTitle}>仓库</span>
                </button>
                {repositoryExpanded ? (
                  <GitRepositoryList
                    items={storeSnapshot?.repositoryItems ?? []}
                    selectedRepositoryId={storeSnapshot?.project?.selectedRepositoryId ?? null}
                    onSelect={selectRepository}
                  />
                ) : null}
              </div>
              <div className={styles.refsPane}>
                <GitRefsTree
                  refs={storeSnapshot?.refs ?? []}
                  selectedRef={storeSnapshot?.ui?.selectedRef ?? null}
                  onSelect={selectRepositoryRef}
                  onAction={(action, ref) => void runRefAction(action, ref)}
                />
              </div>
            </aside>
            <div
              className={styles.separator}
              role="separator"
              aria-label="调整 Git 仓库导航宽度"
              aria-orientation="vertical"
              aria-valuemin={12}
              aria-valuemax={35}
              aria-valuenow={Math.round(navigationPanePercent)}
              data-dragging={navigationResize.dragging ? "true" : undefined}
              tabIndex={0}
              onKeyDown={(event) => handleSplitterKeyDown("navigation", event)}
              onPointerDown={startNavigationResize}
            />
          </>
        ) : null}
        <main
          className={styles.primary}
          data-view={view}
          role="tabpanel"
          id="git-tool-panel"
          aria-label={activeViewLabel}
          tabIndex={0}
        >
          {view !== "history" && view !== "changes" && view !== "compare" ? (
            <div className={styles.paneHeader} data-testid="git-pane-header">
              <strong>{activeViewLabel}</strong>
            </div>
          ) : null}
          {view === "changes" ? (
            <div
              className={styles.changesWorkspace}
              data-testid="git-changes-workspace"
              ref={changesWorkspaceRef}
              style={{ "--git-commit-editor-height": `${commitEditorPercent}%` } as CSSProperties}
            >
              <GitChangesView
                status={storeSnapshot?.status ?? null}
                onSelectionChange={updateCommitSelection}
                onPreviewChange={(entry) => void loadChangeDiff(entry)}
                onCommitFiles={focusCommitEditorForFile}
                onRollbackFiles={setPendingChangeRollback}
                onShowDiff={openChangeDiffDialog}
                onRefresh={() => void refreshChanges()}
                refreshing={changesRefreshing}
                actionBusy={mutation !== null}
                selectionResetKey={changeSelectionResetKey}
              />
              <div
                className={styles.commitSeparator}
                role="separator"
                aria-label="调整提交说明区域高度"
                aria-orientation="horizontal"
                aria-valuemin={22}
                aria-valuemax={65}
                aria-valuenow={Math.round(commitEditorPercent)}
                data-dragging={commitEditorResize.dragging ? "true" : undefined}
                tabIndex={0}
                onKeyDown={handleCommitSplitterKeyDown}
                onPointerDown={startCommitEditorResize}
              />
              <GitCommitEditor
                status={storeSnapshot?.status ?? null}
                selectedFileCount={selectedCommitFileCount}
                draft={storeSnapshot?.ui?.commitDraft ?? ""}
                committing={mutation === "commit" || mutation === "push"}
                onDraftChange={(commitDraft) => {
                  if (storeSnapshot?.project) gitStore?.getState().updateProjectUi(storeSnapshot.project.workspaceId, { commitDraft });
                }}
                onCommit={(options) => runCommit(options)}
                onCommitAndPush={(options) => runCommit(options, true)}
                identity={identity}
                identityLoading={identityLoading}
              />
            </div>
          ) : view === "history" ? (
            <GitHistoryView
              commits={historyCommits}
              selectedObjectId={selectedHistoryObjectId}
              loading={historyLoading}
              hasMore={Boolean(historyCursor)}
              onSelect={(commit) => selectHistoryObjectId(commit.objectId)}
              onLoadMore={() => void loadMoreHistory()}
              onRefresh={() => void refreshHistory()}
              filters={historyFilters}
              revisionOptions={(storeSnapshot?.refs ?? [])
                .filter((ref) => ref.kind === "local" || ref.kind === "remote")
                .map((ref) => ({ value: ref.fullName, label: ref.shortName }))}
              authorOptions={historyAuthors}
              onApplyFilters={(filters) => applyHistoryFilters({ ...filters })}
              onContextAction={(action, commit) => void runHistoryContextAction(action, commit)}
            />
          ) : view === "compare" && comparisonIntent ? (
            <GitComparisonView
              intent={comparisonIntent}
              result={comparisonResult}
              currentOnlyCommits={comparisonCurrentOnly}
              targetOnlyCommits={comparisonTargetOnly}
              selectedCommitId={comparisonSelectedCommitId}
              selectedFileIndex={comparisonFileIndex}
              loading={comparisonLoading}
              error={comparisonError}
              onSelectCommit={(commit) => setComparisonSelectedCommitId(commit.objectId)}
              onSelectFile={setComparisonFileIndex}
              onRetry={() => setComparisonReloadKey((current) => current + 1)}
            />
          ) : view === "blame" ? (
            <GitBlameView
              page={blamePage}
              loading={blameLoading}
              defaultPath={storeSnapshot?.status?.files[0]?.path ?? ""}
              onLoad={(request) => void runBlame(request)}
              onLoadMore={() => void loadMoreBlame()}
              onOpenCommit={(objectId) => {
                selectHistoryObjectId(objectId);
                setHistoryFilters({ ...EMPTY_GIT_HISTORY_FILTERS, search: objectId });
                activateView("history");
              }}
            />
          ) : view === "reflog" ? (
            <GitReflogView
              page={reflogPage}
              loading={reflogLoading}
              refOptions={(storeSnapshot?.refs ?? [])
                .filter((ref) => ref.kind === "local")
                .map((ref) => ref.shortName)}
              onLoad={(ref) => void loadReflog(ref)}
              onLoadMore={() => void loadMoreReflog()}
              onCreateBranch={(name, objectId) => void runCreateBranch(name, objectId)}
              onCopy={(objectId) => {
                void navigator.clipboard.writeText(objectId).catch((error) => {
                  setActionError(gitUiErrorMessage(error));
                });
              }}
              onReset={(objectId) => {
                setResetTargetSeed(objectId);
                activateView("operations");
              }}
            />
          ) : view === "branches" ? (
            <div className={styles.branchWorkspace}>
            <GitSyncActions
              remotes={remotes}
              busy={mutation === "fetch"}
              status={storeSnapshot?.status ?? null}
              updateStrategy={updateStrategy}
              updateBusy={mutation === "update"}
              updateError={mutation === "update" ? null : actionError}
              pushBusy={mutation === "push"}
              pushError={mutation === "push" ? null : actionError}
              outgoingCommits={outgoingCommits}
              replacedCommits={replacedCommits}
              onFetch={runFetch}
              onUpdateStrategyChange={setUpdateStrategy}
              onUpdate={runUpdate}
              onPush={runPush}
            />
            <GitBranchActions
              refs={storeSnapshot?.refs ?? []}
              remotes={remotes.map((remote) => remote.name)}
              selectedRef={storeSnapshot?.ui?.selectedRef ?? null}
              status={storeSnapshot?.status ?? null}
              busy={mutation === "branch" || mutation === "checkout"}
              onCreate={runCreateBranch}
              onCheckout={(ref) => runRefAction("checkout", ref)}
              onRename={runRenameBranch}
              onDelete={runDeleteBranch}
              onCreateTag={runCreateTag}
              onDeleteTag={runDeleteTag}
              onPushTag={runPushTag}
              onSetUpstream={runSetUpstream}
              onOpenChanges={() => activateView("changes")}
              onStashAndCheckout={runStashAndCheckout}
            />
            <GitRemoteManager
              repositoryId={storeSnapshot?.project?.selectedRepositoryId ?? null}
              remotes={remotes}
              busy={mutation === "branch"}
              error={mutation === "branch" ? null : actionError}
              onAdd={runAddRemote}
              onRename={runRenameRemote}
              onSetUrl={runSetRemoteUrl}
              onRemove={runRemoveRemote}
            />
            </div>
          ) : view === "stash" ? (
            <GitStashView
              repositoryId={storeSnapshot?.project?.selectedRepositoryId ?? null}
              entries={stashEntries}
              selected={selectedStash}
              detail={stashDetail}
              selectedFileIndex={stashFileIndex}
              loading={stashLoading}
              hasMore={Boolean(stashCursor)}
              onSelect={(entry) => void selectStash(entry)}
              onSelectFile={setStashFileIndex}
              onLoadMore={() => void loadMoreStashes()}
              busy={mutation === "stash"}
              error={mutation === "stash" ? null : actionError}
              onCreate={runCreateStash}
              onApply={(entry, reinstateIndex) => runStashEntryAction("apply", entry, reinstateIndex)}
              onPop={(entry, reinstateIndex) => runStashEntryAction("pop", entry, reinstateIndex)}
              onBranch={runStashBranch}
              onDrop={(entry) => void runStashEntryAction("drop", entry)}
              onClear={() => void runClearStashes()}
            />
          ) : view === "operations" ? (
            <div className={styles.branchWorkspace}>
              <GitOperationRecoveryBanner
                operation={storeSnapshot?.status?.operation ?? null}
                busy={mutation !== null}
                onAction={runRecoveredOperationAction}
              />
              <GitOperationLog
                operations={storeSnapshot?.operations ?? []}
                repositoryLabels={Object.fromEntries(
                  (storeSnapshot?.repositories ?? []).map((repository) => [
                    repository.id,
                    repository.displayPath || repository.rootPath,
                  ]),
                )}
                canRetry={(operationId) => controller?.canRetryOperation(operationId) ?? false}
                onRetry={(operationId) => void retryLoggedOperation(operationId)}
                canCancel={(operationId) => controller?.canCancelOperation(operationId) ?? false}
                onCancel={(operationId) => void cancelLoggedOperation(operationId)}
              />
              <GitBisectView
                snapshot={bisectSnapshot}
                loading={bisectLoading}
                busy={mutation === "bisect"}
                revisions={["HEAD", ...(storeSnapshot?.refs ?? []).map((ref) => ref.shortName)]}
                onStart={(good, bad) => void startBisect(good, bad)}
                onControl={(action) => void controlBisect(action)}
                onOpenHistory={(objectId) => {
                  selectHistoryObjectId(objectId);
                  setHistoryFilters({ ...EMPTY_GIT_HISTORY_FILTERS, search: objectId });
                  activateView("history");
                }}
              />
              <GitSubmoduleView
                snapshot={submodulesSnapshot}
                loading={submodulesLoading}
                busy={mutation === "submodule"}
                onAction={(action, paths, recursive, force) => void runSubmoduleAction(action, paths, recursive, force)}
              />
              <GitWorktreeView
                snapshot={worktreesSnapshot}
                parentRepositoryId={storeSnapshot?.project?.selectedRepositoryId ?? null}
                loading={worktreesLoading}
                busy={mutation === "worktree"}
                onAuthorize={(path) => void authorizeWorktree(path)}
                onRevoke={(path) => void revokeWorktree(path)}
                onAdd={(options) => void runWorktreeAction("add", options)}
                onRemove={(worktree: GitWorktree) => void runWorktreeAction("remove", { path: worktree.path, dirty: worktree.dirty })}
                onPrune={() => void runWorktreeAction("prune")}
                onLock={(worktree, lockReason) => void runWorktreeAction("lock", { path: worktree.path, lockReason })}
                onUnlock={(worktree) => void runWorktreeAction("unlock", { path: worktree.path })}
              />
              <GitLfsView
                snapshot={lfsSnapshot}
                loading={lfsLoading}
                busy={mutation === "lfs"}
                onAction={(action, remote, refspec) => void runLfsAction(action, remote, refspec)}
              />
              <GitPatchExchangeView
                exported={patchExport}
                busy={mutation === "patch"}
                dryRunSignature={patchDryRunSignature}
                rejectFiles={(storeSnapshot?.status?.files ?? []).map((file) => file.path).filter((path) => path.endsWith(".rej"))}
                onExport={(mode, left, right, paths) => void exportPatch(mode, left, right, paths)}
                onCheck={(patch, options) => void checkImportedPatch(patch, options)}
                onApply={(patch, options) => void applyImportedPatch(patch, options)}
              />
              <GitResetRestoreView
                status={storeSnapshot?.status ?? null}
                preview={resetPreview}
                initialResetTarget={resetTargetSeed}
                busy={mutation === "reset" || mutation === "restore"}
                onPreview={(target, mode) => void previewReset(target, mode)}
                onReset={(target, mode) => void runReset(target, mode)}
                onRestore={(paths, source, staged, worktree) => void runRestore(paths, source, staged, worktree)}
              />
              <GitMergeView
                refs={storeSnapshot?.refs ?? []}
                status={storeSnapshot?.status ?? null}
                preview={mergePreview}
                busy={mutation === "merge"}
                onPreview={(source) => void previewMerge(source)}
                onMerge={(source, strategy, message) => void runMerge(source, strategy, message)}
                onAbort={() => void abortMerge()}
              />
              <GitRebaseView
                refs={storeSnapshot?.refs ?? []}
                status={storeSnapshot?.status ?? null}
                preview={rebasePreview}
                busy={mutation === "rebase"}
                onPreview={(upstream, onto) => void previewRebase(upstream, onto)}
                onRebase={(upstream, onto, interactive, todo) => void runRebase(upstream, onto, interactive, todo)}
                onControl={(action) => void controlRebase(action)}
              />
              <GitCherryPickView
                refs={storeSnapshot?.refs ?? []}
                status={storeSnapshot?.status ?? null}
                busy={mutation === "cherry_pick"}
                requestedCommits={cherryPickCommits}
                skippedCommits={skippedCherryPickCommits}
                outcome={cherryPickOutcome}
                onCherryPick={(commits, recordOrigin) => void runCherryPick(commits, recordOrigin)}
                onControl={(action) => void controlCherryPick(action)}
              />
              <GitRevertView
                refs={storeSnapshot?.refs ?? []}
                status={storeSnapshot?.status ?? null}
                busy={mutation === "revert"}
                requestedCommits={revertCommits}
                outcome={revertOutcome}
                onRevert={(commits, mainline) => void runRevert(commits, mainline)}
                onControl={(action) => void controlRevert(action)}
              />
            </div>
          ) : (
            <div className={styles.placeholder}>暂无可显示内容</div>
          )}
        </main>
        <div
          className={styles.separator}
          role="separator"
          aria-label={view === "changes" ? "调整提交面板宽度" : "调整 Git 详情宽度"}
          aria-orientation="vertical"
          aria-valuemin={COMMIT_PANE_MIN_PERCENT}
          aria-valuemax={view === "changes" ? COMMIT_PANE_MAX_PERCENT : Math.round(72 - navigationPanePercent)}
          aria-valuenow={Math.round(view === "changes" ? commitPanePercent : detailPanePercent)}
          data-dragging={detailResize.dragging ? "true" : undefined}
          tabIndex={0}
          onKeyDown={(event) => handleSplitterKeyDown("details", event)}
          onPointerDown={startDetailResize}
        />
        <aside
          className={styles.details}
          data-detail-surface={view === "changes" ? changesDetailSurface : undefined}
          data-view={view}
          aria-label="Git 详情"
        >
          {view === "changes" ? (
            <>
              <GitConflictOverview
                snapshot={conflicts}
                loading={conflictsLoading}
                selectedPath={selectedConflictPath}
                onSelect={(file) => {
                  if (file.path === selectedConflictPath) return;
                  if (mergeEditorDirty) {
                    setPendingMergeDraftDiscard({ kind: "conflict", path: file.path });
                    return;
                  }
                  setMergeEditorDirty(false);
                  setSelectedConflictPath(file.path);
                }}
              />
              <GitConflictActions
                file={selectedConflict}
                dirty={mergeEditorDirty}
                unresolvedBlocks={unresolvedConflictBlocks}
                busy={mutation === "conflict_action"}
                recentlyResolvedPath={recentlyResolvedConflict?.file.path ?? null}
                onAction={(action) => void runConflictAction(action)}
                onReopen={() => void runConflictAction("reopen")}
              />
              {changesDetailSurface === "merge_editor" && selectedConflict ? (
                <GitThreeWayMergeEditor
                  file={selectedConflict}
                  saving={mutation === "conflict_save"}
                  onDirtyChange={setMergeEditorDirty}
                  onSave={saveConflictResult}
                />
              ) : null}
              {changesDetailSurface === "conflict_diff" && selectedConflict && conflicts ? (
                <GitReadOnlyDiff
                  repositoryId={conflicts.repositoryId}
                  repositoryVersion={conflicts.repositoryVersion}
                  sourceKind="compare"
                  files={selectedConflictDiffFiles}
                  emptyMessage="当前冲突文件没有可显示的文本差异"
                  scrollScopeKey={`git-conflict:${conflicts.repositoryId}:${selectedConflict.path}:${selectedConflict.resultRevision}`}
                  onCopyText={copyGitDiffText}
                  onOpenFile={openGitDiffFile}
                />
              ) : null}
              {changesDetailSurface === "change_diff" ? (
                <GitSelectedChangeDiff
                  workspaceId={storeSnapshot?.project?.workspaceId ?? ""}
                  snapshot={selectedChangeDiff}
                  loading={selectedChangeDiffLoading}
                  busy={mutation === "patch"}
                  actionStatus={patchActionStatus}
                  disabledReason={
                    patchActionStatus === "queued"
                      ? "Git 操作已进入队列"
                      : patchActionStatus === "running"
                        ? "Git 操作正在进行"
                        : undefined
                  }
                  onApplyPatches={runStagePatches}
                  onCopyText={copyGitDiffText}
                  onOpenFile={openGitDiffFile}
                  action={selectedChangePatchAction}
                />
              ) : null}
            </>
          ) : view === "compare" ? (
            comparisonIntent?.kind === "compare_worktree" && comparisonResult ? (
              comparisonFileLoading ? (
                <LoadingSkeleton
                  className={styles.comparisonDetailLoading}
                  aria-label="正在加载文件差异"
                  lineCount={12}
                />
              ) : comparisonFileError ? (
                <div className={styles.state} role="alert">
                  <AlertTriangle size={18} aria-hidden="true" />
                  <strong>无法加载文件差异</strong>
                  <span>{comparisonFileError}</span>
                  <button type="button" onClick={() => setComparisonFileReloadKey((current) => current + 1)}>
                    重新加载
                  </button>
                </div>
              ) : (
              <GitReadOnlyDiff
                repositoryId={comparisonFileResult?.repositoryId ?? comparisonResult.repositoryId}
                repositoryVersion={comparisonFileResult?.repositoryVersion ?? comparisonResult.repositoryVersion}
                sourceKind="compare"
                files={comparisonSelectedFiles}
                emptyMessage="选择文件查看差异"
                scrollScopeKey={`git-compare-worktree:${comparisonResult.repositoryId}:${comparisonIntent.targetRef}:${comparisonFileIndex}`}
                onCopyText={copyGitDiffText}
                onOpenFile={openGitDiffFile}
              />
              )
            ) : comparisonIntent?.kind === "compare_refs" ? (
              <GitCommitDetailsView
                detail={comparisonCommitDetail}
                loading={comparisonCommitDetailLoading}
                selectedFileIndex={comparisonFileIndex}
                onSelectFile={setComparisonFileIndex}
              />
            ) : (
              <div className={styles.placeholder}>请选择比较内容</div>
            )
          ) : view === "stash" ? (
            stashDetail ? (
              <GitReadOnlyDiff
                repositoryId={stashDetail.repositoryId}
                repositoryVersion={stashDetail.repositoryVersion}
                sourceKind="stash"
                files={stashDetail.files[stashFileIndex] ? [stashDetail.files[stashFileIndex]] : []}
                emptyMessage="选择储藏文件查看差异"
                scrollScopeKey={`git-stash:${stashDetail.repositoryId}:${stashDetail.entry.objectId}:${stashFileIndex}`}
              />
            ) : <div className={styles.placeholder}>选择储藏文件查看差异</div>
          ) : view === "history" ? (
            <GitCommitDetailsView
              detail={historyDetail}
              loading={historyDetailLoading}
              selectedFileIndex={historyFileIndex}
              onSelectFile={setHistoryFileIndex}
            />
          ) : (
            <div className={styles.placeholder}>选择条目查看详情</div>
          )}
        </aside>
      </div>
      <GitCommitPushDialog
        open={commitPushOpen}
        projectName={resolvedProject.name}
        target={commitPushTarget}
        commits={commitPushCommits}
        selectedObjectId={selectedCommitPushObjectId}
        detail={commitPushDetail}
        loading={commitPushLoading}
        busy={mutation === "push"}
        error={commitPushOpen ? actionError : null}
        onSelectCommit={(commit) => void selectCommitForPush(commit)}
        onCancel={closeCommitPushDialog}
        onConfirm={confirmCommitPush}
      />
      <GitRevisionTreeDialog
        open={revisionTreeOpen}
        tree={revisionTree}
        loading={revisionTreeLoading}
        error={revisionTreeError}
        onClose={() => setRevisionTreeOpen(false)}
      />
      <GitFileDiffDialog
        open={changeDiffDialogEntry !== null}
        path={changeDiffDialogEntry?.displayPath ?? "未知文件"}
        ariaLabel={`本地文件差异：${changeDiffDialogEntry?.displayPath ?? "未知文件"}`}
        repositoryId={selectedChangeDiff?.repositoryId ?? storeSnapshot?.project?.selectedRepositoryId ?? "unknown"}
        repositoryVersion={selectedChangeDiff?.repositoryVersion ?? storeSnapshot?.status?.repositoryVersion ?? "unknown"}
        sourceKind={selectedChangePatchAction === "unstage" ? "index" : "working_tree"}
        files={selectedChangeDiff?.files ?? []}
        loading={selectedChangeDiffLoading}
        scrollScopeKey={`git-changes-dialog:${storeSnapshot?.project?.selectedRepositoryId ?? "unknown"}:${changeDiffDialogEntry?.id ?? "none"}`}
        onClose={() => setChangeDiffDialogEntry(null)}
      />
      {pendingChangeRollback && pendingChangeRollback.length > 0 ? (
        <GitConfirmActionDialog
          title={pendingChangeRollback.length === 1 ? "回滚文件改动" : `回滚 ${pendingChangeRollback.length} 个文件的改动`}
          description="所选文件在索引和工作树中的本地改动将被永久丢弃，未跟踪文件将被删除。"
          target={pendingChangeRollback.length === 1
            ? pendingChangeRollback[0]!.displayPath
            : `${pendingChangeRollback.length} 个文件`}
          details={pendingChangeRollback.slice(0, 5).map((entry) => entry.displayPath)}
          confirmLabel={mutation === "restore" ? "正在回滚…" : "回滚"}
          busy={mutation === "restore"}
          onCancel={() => setPendingChangeRollback(null)}
          onConfirm={() => void runRollbackChanges(pendingChangeRollback)}
        />
      ) : null}
      {branchContextDialog?.kind === "create" ? (
        <GitFormDialog
          title="创建新分支"
          description={`基于 ${branchContextDialog.ref.shortName} 创建本地分支。`}
          confirmLabel={mutation === "branch" ? "正在创建…" : "创建"}
          busy={mutation === "branch"}
          valid={validateGitBranchName(branchContextName).valid}
          onCancel={() => setBranchContextDialog(null)}
          onSubmit={async () => {
            await runCreateBranch(branchContextName.trim(), branchContextDialog.ref.shortName);
            setBranchContextDialog(null);
          }}
        >
          <GitDialogSummary>起点：{branchContextDialog.ref.shortName}</GitDialogSummary>
          <GitDialogField label="分支名称" error={branchContextName && !validateGitBranchName(branchContextName).valid ? validateGitBranchName(branchContextName).message : undefined}>
            <input autoFocus aria-label="新分支名称" value={branchContextName} onChange={(event) => setBranchContextName(event.currentTarget.value)} />
          </GitDialogField>
        </GitFormDialog>
      ) : null}
      {branchContextDialog?.kind === "rename" ? (
        <GitFormDialog
          title={`重命名分支 ${branchContextDialog.ref.shortName}`}
          description="输入新的本地分支名称。"
          confirmLabel={mutation === "branch" ? "正在重命名…" : "重命名"}
          busy={mutation === "branch"}
          valid={validateGitBranchName(branchContextName).valid && branchContextName.trim() !== branchContextDialog.ref.shortName}
          onCancel={() => setBranchContextDialog(null)}
          onSubmit={async () => {
            await runRenameBranch(branchContextDialog.ref, branchContextName.trim());
            setBranchContextDialog(null);
          }}
        >
          <GitDialogField label="分支名称" error={branchContextName && !validateGitBranchName(branchContextName).valid ? validateGitBranchName(branchContextName).message : undefined}>
            <input autoFocus aria-label="重命名分支" value={branchContextName} onChange={(event) => setBranchContextName(event.currentTarget.value)} />
          </GitDialogField>
        </GitFormDialog>
      ) : null}
      {branchContextDialog?.kind === "delete" ? (
        <GitConfirmActionDialog
          title="删除分支"
          description="仅删除所选分支引用；未被其他引用保留的提交之后只能通过恢复提交找回。"
          target={branchContextDialog.ref.shortName}
          details={["使用安全删除；尚未合并的分支会被 Git 拒绝", "不会切换或修改当前工作树"]}
          confirmLabel="删除"
          busy={mutation === "branch"}
          onCancel={() => setBranchContextDialog(null)}
          onConfirm={() => {
            const ref = branchContextDialog.ref;
            setBranchContextDialog(null);
            void runDeleteBranch(ref, false);
          }}
        />
      ) : null}
      {pendingBranchOperation?.kind === "merge" && mergePreview?.source === pendingBranchOperation.ref.shortName ? (
        <GitConfirmActionDialog
          title="合并分支"
          description="将所选分支合并到当前分支。"
          target={`${pendingBranchOperation.ref.shortName} → ${storeSnapshot?.status?.branch.head ?? "当前分支"}`}
          details={[`进入提交：${mergePreview.incomingCommits} 个`, mergePreview.fastForward ? "可以快进" : "将创建合并提交"]}
          confirmLabel="合并"
          busy={mutation === "merge"}
          onCancel={() => setPendingBranchOperation(null)}
          onConfirm={() => {
            const source = pendingBranchOperation.ref.shortName;
            setPendingBranchOperation(null);
            void runMerge(source, "ff", "");
          }}
        />
      ) : null}
      {pendingBranchOperation?.kind === "rebase" && rebasePreview?.upstream === pendingBranchOperation.ref.shortName ? (
        <GitConfirmActionDialog
          title="变基当前分支"
          description="当前分支的本地提交将重新应用到所选分支之上，并获得新的提交标识。"
          target={`${storeSnapshot?.status?.branch.head ?? "当前分支"} → ${pendingBranchOperation.ref.shortName}`}
          details={[`需要重放：${rebasePreview.commits.length} 个提交`, rebasePreview.dirty ? "工作树存在本地改动，Git 将拒绝执行" : "工作树干净"]}
          confirmLabel="变基"
          busy={mutation === "rebase"}
          onCancel={() => setPendingBranchOperation(null)}
          onConfirm={() => {
            const upstream = pendingBranchOperation.ref.shortName;
            setPendingBranchOperation(null);
            void runRebase(upstream, null, false, []);
          }}
        />
      ) : null}
      {pendingHistoryAction?.kind === "revert_commit" && pendingHistoryAction.commit.parentIds.length > 1 ? (
        <GitFormDialog
          title="还原合并提交"
          description="合并提交需要明确选择要保留其历史的主线父提交。"
          confirmLabel="还原提交"
          busy={mutation === "revert"}
          valid={Number.isInteger(Number(historyRevertMainline)) && Number(historyRevertMainline) >= 1 && Number(historyRevertMainline) <= pendingHistoryAction.commit.parentIds.length}
          onCancel={() => setPendingHistoryAction(null)}
          onSubmit={() => {
            const commit = pendingHistoryAction.commit;
            const mainline = Number(historyRevertMainline);
            setPendingHistoryAction(null);
            void runRevert([commit.objectId], mainline);
          }}
        >
          <GitDialogSummary>{pendingHistoryAction.commit.subject}</GitDialogSummary>
          <GitDialogField label="主线父提交">
            <select autoFocus aria-label="还原主线父提交" value={historyRevertMainline} onChange={(event) => setHistoryRevertMainline(event.currentTarget.value)}>
              {pendingHistoryAction.commit.parentIds.map((parent, index) => <option value={String(index + 1)} key={parent}>{index + 1} · {parent.slice(0, 12)}</option>)}
            </select>
          </GitDialogField>
        </GitFormDialog>
      ) : null}
      {pendingHistoryAction && !(pendingHistoryAction.kind === "revert_commit" && pendingHistoryAction.commit.parentIds.length > 1) ? (
        <GitConfirmActionDialog
          title={pendingHistoryAction.kind === "cherry_pick" ? "优选提交" : pendingHistoryAction.kind === "undo_commit" ? "撤销最后一次提交" : "还原提交"}
          description={pendingHistoryAction.kind === "cherry_pick"
            ? "将所选提交应用到当前分支，并创建新的提交。"
            : pendingHistoryAction.kind === "undo_commit"
              ? "当前分支将软重置到父提交，提交内容会保留在暂存区。"
              : "将创建一个新提交来反向应用所选提交，不会改写已有历史。"}
          target={`${pendingHistoryAction.commit.objectId.slice(0, 12)} · ${pendingHistoryAction.commit.subject}`}
          confirmLabel={pendingHistoryAction.kind === "cherry_pick" ? "优选" : pendingHistoryAction.kind === "undo_commit" ? "撤销提交" : "还原提交"}
          busy={mutation === "cherry_pick" || mutation === "revert" || mutation === "reset"}
          onCancel={() => setPendingHistoryAction(null)}
          onConfirm={() => {
            const pending = pendingHistoryAction;
            setPendingHistoryAction(null);
            if (pending.kind === "cherry_pick") void runCherryPick([pending.commit.objectId], false);
            else if (pending.kind === "undo_commit") void runUndoHeadCommit(pending.commit);
            else void runRevert([pending.commit.objectId], null);
          }}
        />
      ) : null}
      {pendingMergeDraftDiscard ? (
        <GitConfirmActionDialog
          title="丢弃未保存的合并结果？"
          description="当前合并编辑器中的草稿尚未保存到工作树。继续后无法从编辑器恢复这些改动。"
          target={pendingMergeDraftTarget(pendingMergeDraftDiscard)}
          confirmLabel="丢弃并继续"
          busy={false}
          onCancel={() => setPendingMergeDraftDiscard(null)}
          onConfirm={() => {
            const pending = pendingMergeDraftDiscard;
            setPendingMergeDraftDiscard(null);
            setMergeEditorDirty(false);
            if (pending.kind === "view") applyView(pending.view);
            else if (pending.kind === "repository") applyRepositorySelection(pending.repositoryId);
            else setSelectedConflictPath(pending.path);
          }}
        />
      ) : null}
    </section>
  );
}

function pendingMergeDraftTarget(pending: PendingMergeDraftDiscard): string {
  if (pending.kind === "view") return `切换到：${VIEW_LABELS[pending.view]}`;
  if (pending.kind === "repository") return `切换仓库：${pending.repositoryId}`;
  return `切换冲突文件：${pending.path}`;
}

function GitToolWindowState({
  kind,
  title,
  detail,
  actionLabel,
  actionDisabled,
  onAction,
}: {
  kind: "loading" | "empty" | "error";
  title: string;
  detail: string;
  actionLabel?: string;
  actionDisabled?: boolean;
  onAction?: () => void;
}) {
  return (
    <div className={styles.state} data-state={kind} role={kind === "error" ? "alert" : "status"}>
      {kind === "error" ? <AlertTriangle size={22} /> : <GitBranch size={22} />}
      <strong>{title}</strong>
      <span>{detail}</span>
      {actionLabel && onAction ? (
        <button type="button" className={styles.stateAction} disabled={actionDisabled} onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
      {kind === "loading" ? <div className={styles.loadingBar} aria-hidden="true" /> : null}
    </div>
  );
}

interface GitToolWindowStoreSnapshot {
  project: GitProjectStoreState | null;
  repositories: readonly GitRepositoryDescriptor[];
  repositoryItems: readonly {
    repository: GitRepositoryDescriptor;
    status: GitStatusSnapshot | null;
  }[];
  status: GitStoreState["statusByRepository"][string] | null;
  diff: GitStoreState["diffByRepository"][string] | null;
  refs: GitStoreState["refsByRepository"][string];
  ui: GitStoreState["uiByProject"][string] | null;
  operations: readonly GitCommandResult[];
  navigationRequest: GitToolWindowNavigationRequest | null;
}

const HIDDEN_TOOL_WINDOW_SNAPSHOT: GitToolWindowStoreSnapshot = {
  project: null,
  repositories: [],
  repositoryItems: [],
  status: null,
  diff: null,
  refs: [],
  ui: null,
  operations: [],
  navigationRequest: null,
};

function selectHiddenToolWindowSnapshot(): GitToolWindowStoreSnapshot {
  return HIDDEN_TOOL_WINDOW_SNAPSHOT;
}

function createToolWindowSnapshotSelector(): (state: GitStoreState) => GitToolWindowStoreSnapshot {
  let previous: GitToolWindowStoreSnapshot | null = null;
  return (state) => {
    const next = selectToolWindowSnapshot(state);
    if (previous && sameToolWindowSnapshot(previous, next)) return previous;
    previous = next;
    return next;
  };
}

function selectToolWindowSnapshot(state: GitStoreState): GitToolWindowStoreSnapshot {
  const project = state.activeWorkspaceId ? state.projects[state.activeWorkspaceId] ?? null : null;
  const selectedRepositoryId = project?.selectedRepositoryId ?? null;
  const repositories = project
    ? Array.from(new Set([
        ...project.repositoryIds,
        ...(project.ancestorCandidateId ? [project.ancestorCandidateId] : []),
      ])).map((id) => state.repositories[id]).filter(Boolean)
    : [];
  return {
    project,
    repositories,
    repositoryItems: repositories.map((repository) => ({
      repository,
      status: state.statusByRepository[repository.id] ?? null,
    })),
    status: selectedRepositoryId ? state.statusByRepository[selectedRepositoryId] ?? null : null,
    diff: selectedRepositoryId ? state.diffByRepository[selectedRepositoryId] ?? null : null,
    refs: selectedRepositoryId ? state.refsByRepository[selectedRepositoryId] ?? [] : [],
    ui: project ? state.uiByProject[project.workspaceId] ?? null : null,
    navigationRequest: project ? state.navigationRequestsByProject[project.workspaceId] ?? null : null,
    operations: project
      ? state.operationIds
          .map((operationId) => state.operations[operationId])
          .filter((operation): operation is GitCommandResult =>
            Boolean(operation) && project.repositoryIds.includes(operation.repositoryId),
          )
      : [],
  };
}

function sameToolWindowSnapshot(
  left: GitToolWindowStoreSnapshot,
  right: GitToolWindowStoreSnapshot,
): boolean {
  return left.project === right.project
    && left.status === right.status
    && left.diff === right.diff
    && left.refs === right.refs
    && left.ui === right.ui
    && left.navigationRequest === right.navigationRequest
    && sameReferenceList(left.repositories, right.repositories)
    && sameRepositoryItems(left.repositoryItems, right.repositoryItems)
    && sameReferenceList(left.operations, right.operations);
}

function sameReferenceList<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameRepositoryItems(
  left: GitToolWindowStoreSnapshot["repositoryItems"],
  right: GitToolWindowStoreSnapshot["repositoryItems"],
): boolean {
  return left.length === right.length && left.every((item, index) => (
    item.repository === right[index]?.repository && item.status === right[index]?.status
  ));
}

export function adjacentGitToolView(
  current: GitToolWindowView,
  key: string,
): GitToolWindowView | null {
  const currentIndex = PRIMARY_VIEWS.findIndex((view) => view.id === current);
  if (currentIndex < 0) return null;
  if (key === "Home") return PRIMARY_VIEWS[0].id;
  if (key === "End") return PRIMARY_VIEWS[PRIMARY_VIEWS.length - 1].id;
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return null;
  const direction = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
  return PRIMARY_VIEWS[(currentIndex + direction + PRIMARY_VIEWS.length) % PRIMARY_VIEWS.length].id;
}

type GitRefsSnapshotRef = NonNullable<GitToolWindowStoreSnapshot["refs"]>[number];

export function defaultGitToolWindowView(status: Pick<GitStatusSnapshot, "files">): "changes" | "history" {
  return status.files.length > 0 ? "changes" : "history";
}

export function currentGitBranchRevision(
  status: Pick<GitStatusSnapshot, "branch">,
  refs: readonly Pick<GitRefsSnapshotRef, "current" | "fullName" | "kind">[],
): string | null {
  const currentRef = refs.find((ref) => ref.current && ref.kind === "local");
  if (currentRef) return currentRef.fullName;
  return status.branch.head ? `refs/heads/${status.branch.head}` : null;
}

export function gitUiUpdateForRefSelection(
  view: GitToolWindowView,
  historyFilters: GitHistoryFilters,
  ref: Pick<GitRefsSnapshotRef, "fullName" | "kind">,
): { selectedRef: string; historyFilters?: GitHistoryFilters } {
  if (view !== "history" || (ref.kind !== "local" && ref.kind !== "remote")) {
    return { selectedRef: ref.fullName };
  }
  return {
    selectedRef: ref.fullName,
    historyFilters: { ...historyFilters, revision: ref.fullName },
  };
}

export function selectedRefForHistoryRevision(
  revision: string,
  refs: readonly Pick<GitRefsSnapshotRef, "fullName" | "kind">[],
): string | null | undefined {
  if (!revision) return null;
  return refs.find((ref) =>
    (ref.kind === "local" || ref.kind === "remote") && ref.fullName === revision
  )?.fullName;
}

export function resolveGitToolWindowProject(
  active: ActiveProjectState | null,
  snapshot: GitToolWindowStoreSnapshot | null,
): ActiveProjectState | null {
  if (!active || active.status === "none" || !snapshot?.project) return active;
  const project = snapshot.project;
  const base = {
    workspaceId: project.workspaceId,
    projectPath: project.projectRoot,
    name: active.name,
  };
  if (project.loading) return { ...base, status: "loading", selectedRepoId: null };
  if (project.error) {
    return { ...base, status: "error", selectedRepoId: null, errorCode: project.error.code, message: gitUiErrorMessage(project.error) };
  }
  if (project.capability && !project.capability.available) {
    return {
      ...base,
      status: "error",
      selectedRepoId: null,
      errorCode: "git_unavailable",
      message: "未找到可用的 Git 命令行程序。",
    };
  }
  if (project.repositoryIds.length === 0 && project.ancestorCandidateId) {
    const candidate = snapshot.repositories.find((repository) => repository.id === project.ancestorCandidateId);
    if (candidate) {
      return { ...base, status: "ancestor_pending", selectedRepoId: null, ancestorCandidate: descriptorRoot(candidate) };
    }
  }
  if (snapshot.repositories.length === 0) return { ...base, status: "non_repo", selectedRepoId: null };
  const roots = snapshot.repositories.map(descriptorRoot);
  const selectedRepoId = project.selectedRepositoryId ?? roots[0].id;
  if (roots.length === 1) return { ...base, status: "ready", repoRoots: [roots[0]], selectedRepoId };
  return {
    ...base,
    status: "multi_repo",
    repoRoots: roots as [GitRepositoryRoot, GitRepositoryRoot, ...GitRepositoryRoot[]],
    selectedRepoId,
  };
}

function descriptorRoot(repository: GitRepositoryDescriptor): GitRepositoryRoot {
  return {
    id: repository.id,
    rootPath: repository.rootPath,
    displayPath: repository.displayPath,
    kind: repository.kind,
    parentRepoId: repository.parentRepoId ?? undefined,
  };
}

function mergeHistoryAuthors(
  current: readonly string[],
  commits: readonly GitCommitSummary[],
): readonly string[] {
  return Array.from(new Set([
    ...current,
    ...commits.map((commit) => commit.authorName.trim()).filter(Boolean),
  ])).sort((left, right) => left.localeCompare(right));
}

function trimMap<Key, Value>(map: Map<Key, Value>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value as Key | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function isGitOperationConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: unknown;
    detail?: { code?: unknown };
    details?: { code?: unknown };
  };
  return value.code === "git_operation_conflict"
    || value.detail?.code === "git_operation_conflict"
    || value.details?.code === "git_operation_conflict";
}

export function gitOperationFailureMessage(result: { summary: string; result: Record<string, unknown> }): string {
  return gitOperationErrorMessage(result);
}

export function operationControlWarning(
  kind: string,
  action: "skip" | "abort",
  status: GitStatusSnapshot | null,
): string {
  const paths = status?.files.map((file) => file.path) ?? [];
  const visible = paths.slice(0, 5).join(", ");
  const remainder = paths.length > 5 ? `，另有 ${paths.length - 5} 个路径` : "";
  const impact = paths.length
    ? `受影响的工作树或暂存区路径：${visible}${remainder}。`
    : "当前没有报告发生改动的路径。";
  const kindLabel = ({ merge: "合并", rebase: "变基", cherry_pick: "摘取提交", revert: "反向提交" } as Record<string, string>)[kind] ?? "Git";
  if (action === "skip") {
    const current = status?.operation?.currentObjectId?.slice(0, 12);
    return `要跳过当前${kindLabel}步骤${current ? ` ${current}` : ""}吗？该步骤的改动不会被应用。${impact}`;
  }
  return `要中止正在进行的${kindLabel}吗？Git 将恢复操作前状态，并丢弃冲突解决编辑。${impact}`;
}

export function pushTargetFromStatus(
  status: GitStatusSnapshot | null,
): { remote: string; branch: string; target: string; upstream: string } | null {
  const upstream = status?.branch.upstream;
  const branch = status?.branch.head;
  if (!upstream || !branch || status?.branch.detachedAt) return null;
  const separator = upstream.indexOf("/");
  if (separator <= 0 || separator === upstream.length - 1) return null;
  return { remote: upstream.slice(0, separator), branch, target: upstream.slice(separator + 1), upstream };
}
