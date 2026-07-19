import { AppDialog } from "@/renderer/components/dialog";
import { LoadingSkeleton } from "@/renderer/components/loading";
import type { GitDiffSourceKind } from "@/renderer/components/diff/adapters/gitDocument";
import { GitReadOnlyDiff } from "@/renderer/features/git/components/GitReadOnlyDiff";
import type {
  GitCommitDetail,
  GitFileDiff,
  GitRepositoryId,
  GitRepositoryVersion,
} from "@/runtime/gitTypes";

import styles from "./GitCommitFileDiffDialog.module.css";

export function GitCommitFileDiffDialog({
  detail,
  fileIndex,
  onClose,
}: {
  detail: GitCommitDetail;
  fileIndex: number | null;
  onClose: () => void;
}) {
  const file = fileIndex === null ? null : detail.files[fileIndex] ?? null;
  if (!file) return null;

  const path = file.newPath ?? file.oldPath ?? "未知文件";

  return (
    <GitFileDiffDialog
      open
      path={path}
      ariaLabel={`提交文件差异：${path}`}
      repositoryId={detail.repositoryId}
      repositoryVersion={detail.repositoryVersion}
      sourceKind="commit"
      files={[file]}
      scrollScopeKey={`git-history:${detail.repositoryId}:${detail.commit.objectId}:${path}`}
      onClose={onClose}
    />
  );
}

export function GitFileDiffDialog({
  open,
  path,
  ariaLabel = `文件差异：${path}`,
  repositoryId,
  repositoryVersion,
  sourceKind,
  files,
  loading = false,
  scrollScopeKey,
  onClose,
}: {
  open: boolean;
  path: string;
  ariaLabel?: string;
  repositoryId: GitRepositoryId | string;
  repositoryVersion: GitRepositoryVersion | string;
  sourceKind: GitDiffSourceKind;
  files: readonly GitFileDiff[];
  loading?: boolean;
  scrollScopeKey: string;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <AppDialog
      title={`差异详情 · ${path}`}
      ariaLabel={ariaLabel}
      size="fullscreen"
      backdrop="preview"
      closeOnOverlayClick={false}
      showClose
      onClose={onClose}
      panelClassName={styles.panel}
      bodyClassName={styles.body}
    >
      {loading ? (
        <LoadingSkeleton aria-label="正在加载文件差异" />
      ) : files.length > 0 ? (
        <GitReadOnlyDiff
          repositoryId={repositoryId}
          repositoryVersion={repositoryVersion}
          sourceKind={sourceKind}
          files={files}
          scrollScopeKey={scrollScopeKey}
        />
      ) : (
        <div role="status">此文件当前没有可显示的差异。</div>
      )}
    </AppDialog>
  );
}
