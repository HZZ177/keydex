import { useCallback, useEffect, useMemo, useState } from "react";

import type { GitFileDiff, GitRepositoryId, GitRepositoryVersion } from "@/runtime/gitTypes";
import {
  gitDocumentFromFiles,
  type GitDiffSourceKind,
} from "@/renderer/components/diff/adapters/gitDocument";
import { GitDiffView } from "@/renderer/components/diff/wrappers/GitDiffView";
import { gitDiffOpenCapability, gitOriginalPatchForFile } from "@/renderer/features/git/gitDiffFileActions";

import styles from "./GitDiffSurface.module.css";

export interface GitReadOnlyDiffProps {
  readonly repositoryId: GitRepositoryId | string;
  readonly repositoryVersion: GitRepositoryVersion | string;
  readonly sourceKind: Exclude<GitDiffSourceKind, "working_tree" | "index">;
  readonly files: readonly GitFileDiff[];
  readonly emptyMessage?: string;
  readonly scrollScopeKey: string;
  readonly onCopyText?: (text: string) => void | Promise<void>;
  readonly onOpenFile?: (repositoryPath: string) => void | Promise<void>;
  readonly worktreeAvailablePaths?: readonly string[];
}

export function GitReadOnlyDiff({
  repositoryId,
  repositoryVersion,
  sourceKind,
  files,
  emptyMessage = "选择文件查看差异",
  scrollScopeKey,
  onCopyText,
  onOpenFile,
  worktreeAvailablePaths = [],
}: GitReadOnlyDiffProps) {
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const document = useMemo(() => files.length > 0
    ? gitDocumentFromFiles({ repositoryId, repositoryVersion, sourceKind, files })
    : null, [files, repositoryId, repositoryVersion, sourceKind]);
  useEffect(() => {
    setActiveFileId(document?.files[0]?.id ?? null);
  }, [document?.id]);
  const copyText = useCallback(async (text: string) => {
    if (onCopyText) return onCopyText(text);
    if (!navigator.clipboard?.writeText) throw new Error("剪贴板不可用");
    await navigator.clipboard.writeText(text);
  }, [onCopyText]);
  const copyPatch = useCallback(async () => {
    if (!document) throw new Error("Git 差异已变化，请刷新后重试");
    await copyText(gitOriginalPatchForFile(document, files, activeFileId));
  }, [activeFileId, copyText, document, files]);
  const activeFile = document?.files.find((file) => file.id === activeFileId) ?? document?.files[0];
  const openCapability = activeFile
    ? gitDiffOpenCapability(activeFile, sourceKind, worktreeAvailablePaths)
    : { path: null, reason: "此变更没有可打开的工作区路径" };

  if (!document) {
    return <div className={styles.state}>{emptyMessage}</div>;
  }

  return (
    <GitDiffView
      document={document}
      mode="read_only"
      copyPatch={copyPatch}
      copySelection={copyText}
      copyPath={copyText}
      {...(onOpenFile && openCapability.path ? { openFile: onOpenFile } : {})}
      activeFileId={activeFileId}
      onActiveFileChange={setActiveFileId}
      scrollScopeKey={scrollScopeKey}
      toolbarLeading={<span className={styles.toolbarTitle}>详情</span>}
    />
  );
}
