import { AlertTriangle, ChevronDown, FileClock, GitBranch, GitCommitHorizontal, GitPullRequest, History, ListChecks, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import type { ActiveProjectState, GitRepositoryRoot } from "@/renderer/features/git/activeProject";
import type { GitProjectStoreState, GitStoreState } from "@/renderer/features/git/store/gitStore";
import { useOptionalGitController, useOptionalGitRuntime, useOptionalGitStoreSelector } from "@/renderer/providers/GitProvider";
import { useOptionalGitStore } from "@/renderer/providers/GitProvider";
import type { GitBisectSnapshot, GitBlamePage, GitCommandResult, GitCommitDetail, GitCommitSummary, GitConflictFile, GitConflictsSnapshot, GitLfsSnapshot, GitMergePreview, GitMergeStrategy, GitObjectId, GitRebasePreview, GitRebaseTodoItem, GitReflogPage, GitRepositoryDescriptor, GitRepositoryId, GitResetMode, GitResetPreview, GitStatusSnapshot, GitSubmodulesSnapshot, GitWorktree, GitWorktreesSnapshot } from "@/runtime/gitTypes";
import type { GitCommitCommand, GitConflictActionCommand, GitConflictFileAction, GitHistoryFilters, GitIdentity, GitPatchExport, GitPatchExportMode, GitPushCommand, GitRemoteInfo, GitStashDetail, GitStashEntry, GitStashEntryCommand } from "@/runtime/git";
import { GIT_HISTORY_PAGE_SIZE } from "@/renderer/features/git/performancePolicy";
import { gitOperationErrorMessage, gitUiErrorMessage } from "@/renderer/features/git/errorPresentation";
import { WorkspaceSelector, type WorkspaceSelectorProps } from "@/renderer/components/workspace";

import styles from "./GitToolWindow.module.css";
import { GitChangesView } from "./GitChangesView";
import { GitDiffViewer } from "./GitDiffViewer";
import { GitCommitEditor, type GitCommitOptions, type GitCommitOutcome } from "./GitCommitEditor";
import { GitRefsTree, type GitRefAction } from "./GitRefsTree";
import { GitBranchActions, branchDeletionRisk } from "./GitBranchActions";
import { GitRemoteManager } from "./GitRemoteManager";
import { GitSyncActions, type GitFetchOptions, type GitPushOptions, type GitUpdateStrategy } from "./GitSyncActions";
import { GitStashView } from "./GitStashView";
import { EMPTY_GIT_HISTORY_FILTERS, GitHistoryView, mergeHistoryPages } from "./GitHistoryView";
import { GitCommitDetailsView } from "./GitCommitDetailsView";
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
import { confirmWorktreeRemoval, GitWorktreeView, type GitWorktreeAddOptions } from "./GitWorktreeView";
import { GitLfsView, type GitLfsAction } from "./GitLfsView";
import { GitRepositoryList } from "./GitRepositoryList";
import { GitOperationLog } from "./GitOperationLog";
import { commitSelectionFromEntries, type GitChangeEntry } from "../changesTree";

export type GitToolWindowView = "changes" | "history" | "blame" | "reflog" | "branches" | "stash" | "operations";

const COMMIT_PANE_MIN_PERCENT = 18;
const COMMIT_PANE_MAX_PERCENT = 80;

const PRIMARY_VIEWS: readonly { id: GitToolWindowView; label: string; icon: typeof GitBranch }[] = [
  { id: "changes", label: "提交", icon: GitPullRequest },
  { id: "history", label: "Git 日志", icon: History },
  { id: "branches", label: "分支", icon: GitBranch },
];

const MORE_VIEWS: readonly { id: GitToolWindowView; label: string; description: string; icon: typeof GitBranch }[] = [
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
};

export interface GitToolWindowProps {
  project: ActiveProjectState | null;
  maximized: boolean;
  initialView?: GitToolWindowView;
  projectSelector?: GitProjectSelectorProps;
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
  initialView = "changes",
  projectSelector,
}: GitToolWindowProps) {
  const storeSnapshot = useOptionalGitStoreSelector(selectToolWindowSnapshot);
  const resolvedProject = resolveGitToolWindowProject(project, storeSnapshot);
  const controller = useOptionalGitController();
  const runtime = useOptionalGitRuntime();
  const gitStore = useOptionalGitStore();
  const projectKey = resolvedProject && resolvedProject.status !== "none" ? resolvedProject.workspaceId : "none";
  const [view, setView] = useState<GitToolWindowView>(initialView);
  const [moreOpen, setMoreOpen] = useState(false);
  const [projectAction, setProjectAction] = useState<"init" | "grant" | "retry" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<GitIdentity | null>(null);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [commitOutcome, setCommitOutcome] = useState<GitCommitOutcome | null>(null);
  const [selectedCommitPaths, setSelectedCommitPaths] = useState<readonly string[]>([]);
  const [selectedUntrackedCommitPaths, setSelectedUntrackedCommitPaths] = useState<readonly string[]>([]);
  const [selectedCommitFileCount, setSelectedCommitFileCount] = useState(0);
  const [changeSelectionResetKey, setChangeSelectionResetKey] = useState(0);
  const [changesRefreshing, setChangesRefreshing] = useState(false);
  const [selectedChangePatchAction, setSelectedChangePatchAction] = useState<"stage" | "unstage">("stage");
  const [remotes, setRemotes] = useState<readonly GitRemoteInfo[]>([]);
  const [syncProgress, setSyncProgress] = useState<readonly string[]>([]);
  const [updateOutcome, setUpdateOutcome] = useState<"up_to_date" | "updated" | "conflict" | null>(null);
  const [pushOutcome, setPushOutcome] = useState<"pushed" | "rejected" | null>(null);
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
  const [selectedHistoryObjectId, setSelectedHistoryObjectId] = useState<GitObjectId | null>(null);
  const [navigationPanePercent, setNavigationPanePercent] = useState(19);
  const [detailPanePercent, setDetailPanePercent] = useState(28);
  const [commitPanePercent, setCommitPanePercent] = useState(28);
  const [commitEditorPercent, setCommitEditorPercent] = useState(34);
  const [draggingSplitter, setDraggingSplitter] = useState<"navigation" | "details" | "commit" | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFilters, setHistoryFilters] = useState<GitHistoryFilters>({ ...EMPTY_GIT_HISTORY_FILTERS });
  const [historyDetail, setHistoryDetail] = useState<GitCommitDetail | null>(null);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
  const [historyFileIndex, setHistoryFileIndex] = useState(0);
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
  const [resetOutcome, setResetOutcome] = useState<GitCommandResult | null>(null);
  const [restoreOutcome, setRestoreOutcome] = useState<GitCommandResult | null>(null);
  const [patchExport, setPatchExport] = useState<GitPatchExport | null>(null);
  const [patchDryRunSignature, setPatchDryRunSignature] = useState<string | null>(null);
  const [patchOutcome, setPatchOutcome] = useState<GitCommandResult | null>(null);
  const [conflicts, setConflicts] = useState<GitConflictsSnapshot | null>(null);
  const [conflictsLoading, setConflictsLoading] = useState(false);
  const [selectedConflictPath, setSelectedConflictPath] = useState<string | null>(null);
  const [mergeEditorDirty, setMergeEditorDirty] = useState(false);
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
  const historyDetailCacheRef = useRef(new Map<string, GitCommitDetail>());

  useEffect(() => () => changeDiffAbortRef.current?.abort(), []);

  const activateView = (nextView: GitToolWindowView): boolean => {
    if (nextView === view) return true;
    if (mergeEditorDirty && !window.confirm("合并结果存在未保存的改动。确定不保存并离开吗？")) return false;
    setMergeEditorDirty(false);
    setView(nextView);
    if (storeSnapshot?.project) {
      gitStore?.getState().updateProjectUi(storeSnapshot.project.workspaceId, { activeTab: nextView });
    }
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
    if (update.historyFilters) setHistoryFilters(update.historyFilters);
    gitStore?.getState().updateProjectUi(storeSnapshot.project.workspaceId, update);
  };

  const applyHistoryFilters = (next: GitHistoryFilters) => {
    setHistoryFilters(next);
    if (!storeSnapshot?.project) return;
    const selectedRef = selectedRefForHistoryRevision(next.revision, storeSnapshot.refs ?? []);
    gitStore?.getState().updateProjectUi(storeSnapshot.project.workspaceId, {
      historyFilters: next,
      ...(selectedRef !== undefined ? { selectedRef } : {}),
    });
  };

  const updatePanePercent = (pane: "navigation" | "details", requestedPercent: number) => {
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
  };

  const handleSplitterPointerDown = (
    pane: "navigation" | "details",
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const splitter = event.currentTarget;
    const pointerId = event.pointerId;
    splitter.setPointerCapture?.(pointerId);
    setDraggingSplitter(pane);
    const updateFromClientX = (clientX: number) => {
      const bounds = workspaceRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0) return;
      const percent = pane === "navigation" || (pane === "details" && view === "changes")
        ? ((clientX - bounds.left) / bounds.width) * 100
        : ((bounds.right - clientX) / bounds.width) * 100;
      updatePanePercent(pane, percent);
    };
    const handleMove = (moveEvent: PointerEvent) => updateFromClientX(moveEvent.clientX);
    const handleEnd = () => {
      if (splitter.hasPointerCapture?.(pointerId)) splitter.releasePointerCapture(pointerId);
      setDraggingSplitter(null);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
    };
    updateFromClientX(event.clientX);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleEnd);
  };

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
    setCommitEditorPercent(Math.min(65, Math.max(22, requestedPercent)));
  };

  const handleCommitSplitterPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const splitter = event.currentTarget;
    const pointerId = event.pointerId;
    splitter.setPointerCapture?.(pointerId);
    setDraggingSplitter("commit");
    const updateFromClientY = (clientY: number) => {
      const bounds = changesWorkspaceRef.current?.getBoundingClientRect();
      if (!bounds || bounds.height <= 0) return;
      updateCommitEditorPercent(((bounds.bottom - clientY) / bounds.height) * 100);
    };
    const handleMove = (moveEvent: PointerEvent) => updateFromClientY(moveEvent.clientY);
    const handleEnd = () => {
      if (splitter.hasPointerCapture?.(pointerId)) splitter.releasePointerCapture(pointerId);
      setDraggingSplitter(null);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
    };
    updateFromClientY(event.clientY);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleEnd);
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
      await controller.retryOperation(operationId);
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    }
  };
  const cancelLoggedOperation = async (operationId: string) => {
    if (!controller) return;
    try {
      await controller.cancelOperation(operationId);
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    }
  };

  useEffect(() => {
    setView(storeSnapshot?.ui?.activeTab ?? initialView);
    setHistoryFilters(storeSnapshot?.ui?.historyFilters ?? { ...EMPTY_GIT_HISTORY_FILTERS });
    setHistoryAuthors([]);
    setSelectedHistoryObjectId((storeSnapshot?.ui?.selectedHistoryObjectId as GitObjectId | null | undefined) ?? null);
    setNavigationPanePercent(storeSnapshot?.ui?.navigationPanePercent ?? 19);
    setDetailPanePercent(storeSnapshot?.ui?.detailPanePercent ?? 28);
    setCommitPanePercent(28);
  }, [initialView, projectKey]);

  useEffect(() => {
    setSelectedCommitPaths([]);
    setSelectedUntrackedCommitPaths([]);
    setSelectedCommitFileCount(0);
    setChangeSelectionResetKey((current) => current + 1);
  }, [projectKey, storeSnapshot?.project?.selectedRepositoryId]);

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
    if (view !== "history" || !runtime || !project?.selectedRepositoryId) return;
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
  }, [gitStore, historyFilters, runtime, storeSnapshot?.project?.projectRoot, storeSnapshot?.project?.selectedRepositoryId, storeSnapshot?.project?.workspaceId, view]);

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
  const activeViewLabel = VIEW_LABELS[view];
  const selectRepository = (repositoryId: GitRepositoryId) => {
    if (!storeSnapshot?.project || storeSnapshot.project.selectedRepositoryId === repositoryId) return;
    if (mergeEditorDirty && !window.confirm("合并结果存在未保存的改动。确定切换仓库并丢弃编辑草稿吗？")) return;
    setMergeEditorDirty(false);
    setActionError(null);
    setCommitOutcome(null);
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
  const loadChangeDiff = async (entry: GitChangeEntry) => {
    const selectedPath = entry.path;
    if (!runtime || !gitStore || !storeSnapshot?.project?.selectedRepositoryId) return;
    gitStore.getState().updateProjectUi(storeSnapshot.project.workspaceId, { selectedPath });
    const file = storeSnapshot.status?.files.find((candidate) => candidate.path === selectedPath || candidate.originalPath === selectedPath);
    changeDiffAbortRef.current?.abort();
    const abortController = new AbortController();
    changeDiffAbortRef.current = abortController;
    try {
      const cached = Boolean(entry.indexStatus && !entry.worktreeStatus)
        || Boolean(file?.indexStatus && !file.worktreeStatus);
      setSelectedChangePatchAction(cached ? "unstage" : "stage");
      const diff = await runtime.diff({
        workspaceId: storeSnapshot.project.workspaceId,
        projectRoot: storeSnapshot.project.projectRoot,
        repositoryId: storeSnapshot.project.selectedRepositoryId,
      }, { cached, path: selectedPath, signal: abortController.signal });
      if (abortController.signal.aborted) return;
      const selected = diff.files.find((candidate) => candidate.newPath === selectedPath || candidate.oldPath === selectedPath);
      gitStore.getState().setDiff(selected ? { ...diff, files: [selected] } : diff);
    } catch (error) {
      if (!isAbortError(error)) setActionError(gitUiErrorMessage(error));
    } finally {
      if (changeDiffAbortRef.current === abortController) changeDiffAbortRef.current = null;
    }
  };
  const runStagePatches = async (patches: readonly string[]) => {
    if (!controller || !runtime || !storeSnapshot?.project || !storeSnapshot.project.selectedRepositoryId || patches.length === 0) return;
    setMutation("patch");
    setActionError(null);
    try {
      for (const [index, patch] of patches.entries()) {
        await controller.runCommand(() => runtime.applyPatch({
          workspaceId: storeSnapshot.project!.workspaceId,
          projectRoot: storeSnapshot.project!.projectRoot,
          repositoryId: storeSnapshot.project!.selectedRepositoryId!,
          idempotencyKey: `tool-window-patch-${Date.now()}-${index}`,
          patch,
          cached: true,
          reverse: selectedChangePatchAction === "unstage",
        }));
      }
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runCommit = async (options: GitCommitOptions, pushAfter = false) => {
    if (!controller || !runtime || !storeSnapshot?.project || !storeSnapshot.project.selectedRepositoryId) return;
    setMutation(pushAfter ? "push" : "commit");
    setActionError(null);
    setCommitOutcome(null);
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
      setCommitOutcome({
          oid: typeof result.result.oid === "string" ? result.result.oid : null,
          summary: "提交成功",
          status: typeof result.result.status === "string" ? result.result.status : result.state,
        });
        setSelectedCommitPaths([]);
        setSelectedUntrackedCommitPaths([]);
        setSelectedCommitFileCount(0);
        setChangeSelectionResetKey((current) => current + 1);
        gitStore?.getState().updateProjectUi(storeSnapshot.project.workspaceId, { commitDraft: "" });
        if (pushAfter) {
          const target = pushTargetFromStatus(storeSnapshot.status ?? null);
          if (!target) {
            setCommitOutcome({
              oid: typeof result.result.oid === "string" ? result.result.oid : null,
              summary: "提交成功，但推送需要先设置上游",
              status: "commit_succeeded_push_blocked",
            });
            setActionError("提交已成功，但当前分支没有上游。请先在分支视图明确设置上游后再推送。");
            return;
          }
          const pushed = await controller.runCommand(() => runtime.push({
            workspaceId: storeSnapshot.project!.workspaceId,
            projectRoot: storeSnapshot.project!.projectRoot,
            repositoryId: storeSnapshot.project!.selectedRepositoryId!,
            idempotencyKey: `tool-window-push-${Date.now()}`,
            remote: target.remote,
            source: target.branch,
            target: target.target,
          }));
          if (pushed.state === "succeeded") {
            setCommitOutcome({
              oid: typeof result.result.oid === "string" ? result.result.oid : null,
              summary: `已提交并推送到 ${target.upstream}`,
              status: "committed_and_pushed",
            });
          } else {
            setCommitOutcome({
              oid: typeof result.result.oid === "string" ? result.result.oid : null,
              summary: "提交成功，但推送失败",
              status: "commit_succeeded_push_failed",
            });
            setActionError(`提交已成功，但推送失败：${gitOperationFailureMessage(pushed)}`);
          }
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
    if (action === "compare") {
      activateView("history");
      return;
    }
    if (action === "create_branch" || action === "rename" || action === "delete") {
      activateView("branches");
      return;
    }
    if (storeSnapshot.status?.files.length) {
      activateView("branches");
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
    const risk = branchDeletionRisk(ref, storeSnapshot.status ?? null);
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
    const preview = remote ? `${remote}/${branchName}` : branchName;
    if (!window.confirm(`即将删除 ${preview}。此操作不会删除工作区文件，是否继续？`)) return;
    if ((force || risk === "protected") && !window.confirm(`这是${risk === "protected" ? "受保护" : "未合并"}分支操作。请再次确认删除 ${preview}。`)) return;
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
    const target = remote ? `${remote}/${ref.shortName}` : ref.shortName;
    if (!window.confirm(`即将删除标签 ${target}。远程标签删除不会自动恢复，是否继续？`)) return;
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
      setPushOutcome("pushed");
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
  const runAddRemote = async (name: string, fetchUrl: string, pushUrl: string | null) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
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
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runRenameRemote = async (oldName: string, newName: string) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
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
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runSetRemoteUrl = async (name: string, url: string, push: boolean) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
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
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runRemoveRemote = async (remote: GitRemoteInfo) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    const impact = remote.trackingBranches.length
      ? `以下本地分支将失去上游：${remote.trackingBranches.join("、")}。`
      : "没有本地分支跟踪此远程仓库。";
    if (!window.confirm(`删除远程仓库 ${remote.name}？${impact}`)) return;
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
    setSyncProgress([]);
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
      const lines = Array.isArray(result.result.progress_lines) ? result.result.progress_lines.map(String) : [];
      setSyncProgress(lines.length > 0 ? lines : ["远程数据获取完成"]);
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
  const runUpdate = async () => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    const upstream = storeSnapshot.status?.branch.upstream;
    if (!upstream) {
      setActionError("当前分支没有上游，请先明确设置后再更新。");
      return;
    }
    const separator = upstream.indexOf("/");
    if (separator <= 0 || separator === upstream.length - 1) {
      setActionError(`无法解析上游：${upstream}`);
      return;
    }
    setMutation("update");
    setActionError(null);
    setUpdateOutcome(null);
    try {
      const result = await controller.runCommand(() => runtime.update({
        workspaceId: storeSnapshot.project!.workspaceId,
        projectRoot: storeSnapshot.project!.projectRoot,
        repositoryId: storeSnapshot.project!.selectedRepositoryId!,
        idempotencyKey: `tool-window-update-${Date.now()}`,
        expectedRepositoryVersion: storeSnapshot.status?.repositoryVersion ?? null,
        remote: upstream.slice(0, separator),
        refspec: upstream.slice(separator + 1),
        strategy: updateStrategy,
      }));
      if (result.state !== "succeeded") {
        const message = gitOperationFailureMessage(result);
        setUpdateOutcome(/conflict/i.test(message) ? "conflict" : null);
        throw new Error(message);
      }
      const status = result.result.status === "up_to_date" ? "up_to_date" : "updated";
      setUpdateOutcome(status);
    } catch (error) {
      const message = gitUiErrorMessage(error);
      if (/conflict/i.test(message)) setUpdateOutcome("conflict");
      setActionError(message);
    } finally {
      setMutation(null);
    }
  };
  const runPush = async (options: GitPushOptions) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    if (options.forceWithLease) {
      const remoteLoss = storeSnapshot.status?.branch.behind ?? 0;
      if (!window.confirm(`带租约强制推送将改写 ${options.remote}/${options.target}，最多替换 ${remoteLoss} 个远程提交。是否继续？`)) return;
      if (!window.confirm("请再次确认：仅在你已检查远端提交且确定要改写远端历史时继续。")) return;
    }
    setMutation("push");
    setActionError(null);
    setPushOutcome(null);
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
          setPushOutcome("rejected");
          throw new Error(`${message}。请先获取或更新，确认远程提交后再重试。`);
        }
        throw new Error(message);
      }
      setPushOutcome("pushed");
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
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
  const runCreateStash = async (options: { message: string; staged: boolean; includeUntracked: boolean }) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
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
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
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
  const runStashEntryAction = async (action: "apply" | "pop" | "drop", entry: GitStashEntry, reinstateIndex = false) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
    if (action === "drop") {
      if (!window.confirm(`要删除储藏 ${entry.selector}（${entry.objectId.slice(0, 8)}）吗？`)) return;
      if (!window.confirm("此储藏记录删除后无法从储藏列表恢复，请再次确认删除。")) return;
    }
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
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runStashBranch = async (entry: GitStashEntry, branchName: string) => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId) return;
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
    } catch (error) {
      setActionError(gitUiErrorMessage(error));
    } finally {
      setMutation(null);
    }
  };
  const runClearStashes = async () => {
    if (!controller || !runtime || !storeSnapshot?.project?.selectedRepositoryId || stashEntries.length === 0) return;
    if (!window.confirm(`要清空全部 ${stashEntries.length} 条储藏记录吗？`)) return;
    if (!window.confirm("此操作会删除所有储藏记录，请再次确认清空。")) return;
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
    if (!window.confirm(operationControlWarning("merge", "abort", storeSnapshot.status ?? null))) return;
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
    setResetOutcome(null);
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
    if (action === "reset" && !window.confirm("要结束二分定位并恢复原始分支或指针吗？")) return;
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
    if (highRisk && !window.confirm(`${action === "deinit" ? "要取消初始化" : "要递归处理"} ${paths.join(", ")} 吗？${recursive ? "此操作包含嵌套子模块仓库。" : "已签出的子仓库文件将被移除，但 Git 元数据仍可恢复。"}`)) return;
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
    if (!window.confirm(`要为所选父仓库授权这个外部工作树精确路径吗？\n${path}`)) return;
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
    if (!window.confirm(`要撤销 Keydex 对此外部工作树的访问权限吗？\n${path}`)) return;
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
    if (action === "remove" && !confirmWorktreeRemoval({ path: path ?? "", dirty: options.dirty ?? null })) return;
    if (action === "prune" && !window.confirm("要清理失效的工作树元数据吗？只会影响 Git 判定为可清理的登记信息。")) return;
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
    if (!window.confirm(`要执行${resetModeLabel(mode)}，将 ${resetPreview.headObjectId?.slice(0, 12) ?? "尚无提交"} 重置到 ${resetPreview.targetObjectId.slice(0, 12)} 吗？之前的分支端点仍可通过引用记录恢复。`)) return;
    if (mode === "hard" && resetPreview.untrackedOverwrites.length > 0 && !window.confirm(`确认丢失以下未跟踪数据：${resetPreview.untrackedOverwrites.join(", ")}`)) return;
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
      setResetOutcome(result);
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
    setRestoreOutcome(null);
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
      setRestoreOutcome(result);
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
    setPatchOutcome(null);
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
      setPatchOutcome(result);
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
        setPatchOutcome(recheck);
        setPatchDryRunSignature(null);
        setActionError(gitOperationFailureMessage(recheck));
        return;
      }
      const result = await controller.runCommand(() => runtime.applyPatch({ ...base, idempotencyKey: `tool-window-patch-apply-${Date.now()}`, checkOnly: false, reject: options.reject }));
      setPatchOutcome(result);
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

  return (
    <section className={styles.root} data-layout={maximized ? "maximized" : "split"} data-testid="git-tool-window">
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
        data-navigation={view === "changes" ? "hidden" : "visible"}
        data-view={view}
        data-testid="git-workspace"
        ref={workspaceRef}
        style={{
          "--git-navigation-pane-width": `${navigationPanePercent}%`,
          "--git-detail-pane-width": `${view === "changes" ? commitPanePercent : detailPanePercent}%`,
        } as CSSProperties}
      >
        {view !== "changes" ? (
          <>
            <aside className={styles.navigation} aria-label="Git 仓库导航">
              <div className={styles.repositorySection}>
                <span className={styles.paneTitle}>仓库</span>
                <GitRepositoryList
                  items={storeSnapshot?.repositoryItems ?? []}
                  selectedRepositoryId={storeSnapshot?.project?.selectedRepositoryId ?? null}
                  onSelect={selectRepository}
                />
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
              data-dragging={draggingSplitter === "navigation" ? "true" : undefined}
              tabIndex={0}
              onKeyDown={(event) => handleSplitterKeyDown("navigation", event)}
              onPointerDown={(event) => handleSplitterPointerDown("navigation", event)}
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
          {view !== "history" && view !== "changes" ? (
            <div className={styles.paneHeader} data-testid="git-pane-header">
              <strong>{activeViewLabel}</strong>
            </div>
          ) : null}
          {actionError ? <div className={styles.actionError} role="alert">{actionError}</div> : null}
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
                onRefresh={() => void refreshChanges()}
                refreshing={changesRefreshing}
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
                data-dragging={draggingSplitter === "commit" ? "true" : undefined}
                tabIndex={0}
                onKeyDown={handleCommitSplitterKeyDown}
                onPointerDown={handleCommitSplitterPointerDown}
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
                outcome={commitOutcome}
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
              progress={syncProgress}
              status={storeSnapshot?.status ?? null}
              updateStrategy={updateStrategy}
              updateBusy={mutation === "update"}
              updateOutcome={updateOutcome}
              pushBusy={mutation === "push"}
              pushOutcome={pushOutcome}
              outgoingCommits={outgoingCommits}
              replacedCommits={replacedCommits}
              onFetch={runFetch}
              onUpdateStrategyChange={setUpdateStrategy}
              onUpdate={runUpdate}
              onPush={runPush}
            />
            <GitBranchActions
              refs={storeSnapshot?.refs ?? []}
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
              remotes={remotes}
              busy={mutation === "branch"}
              onAdd={runAddRemote}
              onRename={runRenameRemote}
              onSetUrl={runSetRemoteUrl}
              onRemove={runRemoveRemote}
            />
            </div>
          ) : view === "stash" ? (
            <GitStashView
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
              onCreate={(options) => void runCreateStash(options)}
              onApply={(entry, reinstateIndex) => void runStashEntryAction("apply", entry, reinstateIndex)}
              onPop={(entry, reinstateIndex) => void runStashEntryAction("pop", entry, reinstateIndex)}
              onBranch={(entry, branchName) => void runStashBranch(entry, branchName)}
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
                outcome={patchOutcome}
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
                resetOutcome={resetOutcome}
                restoreOutcome={restoreOutcome}
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
          data-dragging={draggingSplitter === "details" ? "true" : undefined}
          tabIndex={0}
          onKeyDown={(event) => handleSplitterKeyDown("details", event)}
          onPointerDown={(event) => handleSplitterPointerDown("details", event)}
        />
        <aside className={styles.details} data-view={view} aria-label="Git 详情">
          {view === "history" ? null : <span className={styles.paneTitle}>详情</span>}
          {view === "changes" ? (
            <>
              <GitConflictOverview
                snapshot={conflicts}
                loading={conflictsLoading}
                selectedPath={selectedConflictPath}
                onSelect={(file) => {
                  if (file.path === selectedConflictPath) return;
                  if (mergeEditorDirty && !window.confirm("合并结果存在未保存的改动。确定不保存并切换文件吗？")) return;
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
              {selectedConflict?.editable ? (
                <GitThreeWayMergeEditor
                  file={selectedConflict}
                  saving={mutation === "conflict_save"}
                  onDirtyChange={setMergeEditorDirty}
                  onSave={saveConflictResult}
                />
              ) : null}
              <GitDiffViewer
                diff={storeSnapshot?.diff?.files[0] ?? null}
                staging={mutation === "patch"}
                onStagePatches={runStagePatches}
                patchAction={selectedChangePatchAction}
              />
            </>
          ) : view === "stash" ? (
            <GitDiffViewer diff={stashDetail?.files[stashFileIndex] ?? null} />
          ) : view === "history" ? (
            <GitCommitDetailsView
              detail={historyDetail}
              loading={historyDetailLoading}
              selectedFileIndex={historyFileIndex}
              onSelectFile={setHistoryFileIndex}
              onCopyHash={(objectId) => navigator.clipboard.writeText(objectId).catch((error) => {
                setActionError(gitUiErrorMessage(error));
              })}
            />
          ) : (
            <div className={styles.placeholder}>选择条目查看详情</div>
          )}
        </aside>
      </div>
    </section>
  );
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
    operations: project
      ? state.operationIds
          .map((operationId) => state.operations[operationId])
          .filter((operation): operation is GitCommandResult =>
            Boolean(operation) && project.repositoryIds.includes(operation.repositoryId),
          )
      : [],
  };
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

function resetModeLabel(mode: GitResetMode): string {
  return ({ soft: "软重置", mixed: "混合重置", hard: "硬重置" } as Record<GitResetMode, string>)[mode];
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
