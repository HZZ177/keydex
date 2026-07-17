import { useCallback, useEffect, useMemo, useState } from "react";

import type { GitDiffSnapshot } from "@/runtime/gitTypes";
import { gitDocumentFromFiles } from "@/renderer/components/diff/adapters/gitDocument";
import { LoadingSkeleton } from "@/renderer/components/loading";
import { GitDiffView } from "@/renderer/components/diff/wrappers/GitDiffView";
import type { KeydexGitDiffActionStatus } from "@/renderer/components/diff/profiles";
import type { GitPatchActionIdentity } from "@/renderer/features/git/diffPatchActions";
import { gitOriginalPatchForFile } from "@/renderer/features/git/gitDiffFileActions";

import styles from "./GitDiffSurface.module.css";

export interface GitSelectedChangeDiffProps {
  readonly workspaceId: string;
  readonly snapshot: GitDiffSnapshot | null;
  readonly loading?: boolean;
  readonly action: "stage" | "unstage";
  readonly busy?: boolean;
  readonly actionStatus?: KeydexGitDiffActionStatus;
  readonly disabledReason?: string;
  readonly onApplyPatches: (
    patches: readonly string[],
    identity: GitPatchActionIdentity,
  ) => void | Promise<void>;
  readonly onCopyText?: (text: string) => void | Promise<void>;
  readonly onOpenFile?: (repositoryPath: string) => void | Promise<void>;
}

export function GitSelectedChangeDiff({
  workspaceId,
  snapshot,
  loading = false,
  action,
  busy = false,
  actionStatus,
  disabledReason,
  onApplyPatches,
  onCopyText,
  onOpenFile,
}: GitSelectedChangeDiffProps) {
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const sourceKind = action === "stage" ? "working_tree" : "index";
  const document = useMemo(() => snapshot && snapshot.files.length > 0
    ? gitDocumentFromFiles({
        repositoryId: snapshot.repositoryId,
        repositoryVersion: snapshot.repositoryVersion,
        sourceKind,
        files: snapshot.files,
      })
    : null, [snapshot, sourceKind]);
  const actionIdentity = useMemo<GitPatchActionIdentity | null>(() => {
    if (!snapshot || !document) return null;
    return Object.freeze({
      workspaceId,
      repositoryId: String(snapshot.repositoryId),
      repositoryVersion: String(snapshot.repositoryVersion),
      sourceVersion: document.sourceVersion,
      sourceKind,
      sourcePatch: snapshot.files.map((file) => file.rawPatch).join(""),
      sourcePaths: Object.freeze(Array.from(new Set(snapshot.files.flatMap((file) =>
        [file.oldPath, file.newPath].filter((path): path is string => Boolean(path)),
      )))),
    });
  }, [document, snapshot, sourceKind, workspaceId]);
  const applyPatches = useCallback((patches: readonly string[]) => {
    if (!actionIdentity) throw new Error("Git 差异已变化，请刷新后重试");
    return onApplyPatches(patches, actionIdentity);
  }, [actionIdentity, onApplyPatches]);
  useEffect(() => {
    setActiveFileId(document?.files[0]?.id ?? null);
  }, [document?.id]);
  const copyPatch = useCallback(async () => {
    if (!document || !snapshot || !onCopyText) throw new Error("剪贴板不可用");
    await onCopyText(gitOriginalPatchForFile(document, snapshot.files, activeFileId));
  }, [activeFileId, document, onCopyText, snapshot]);

  if (loading) {
    return (
      <LoadingSkeleton
        aria-label="正在加载文件差异"
        className={styles.loadingState}
      />
    );
  }

  if (!document) {
    return <div className={styles.state}>选择文件查看差异</div>;
  }

  return (
    <GitDiffView
      document={document}
      mode={action}
      busy={busy}
      actionStatus={actionStatus}
      disabledReason={disabledReason}
      applyPatches={applyPatches}
      {...(onCopyText ? {
        copyPatch,
        copySelection: onCopyText,
        copyPath: onCopyText,
      } : {})}
      {...(onOpenFile ? { openFile: onOpenFile } : {})}
      activeFileId={activeFileId}
      onActiveFileChange={setActiveFileId}
      scrollScopeKey={`git-changes:${snapshot!.repositoryId}:${sourceKind}`}
      toolbarLeading={<span className={styles.toolbarTitle}>详情</span>}
    />
  );
}
