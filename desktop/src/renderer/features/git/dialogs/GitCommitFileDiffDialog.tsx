import { AppDialog } from "@/renderer/components/dialog";
import { GitReadOnlyDiff } from "@/renderer/features/git/components/GitReadOnlyDiff";
import type { GitCommitDetail } from "@/runtime/gitTypes";

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
    <AppDialog
      title={`差异详情 · ${path}`}
      ariaLabel={`提交文件差异：${path}`}
      size="fullscreen"
      backdrop="preview"
      closeOnOverlayClick={false}
      showClose
      onClose={onClose}
      panelClassName={styles.panel}
      bodyClassName={styles.body}
    >
      <GitReadOnlyDiff
        repositoryId={detail.repositoryId}
        repositoryVersion={detail.repositoryVersion}
        sourceKind="commit"
        files={[file]}
        scrollScopeKey={`git-history:${detail.repositoryId}:${detail.commit.objectId}:${path}`}
      />
    </AppDialog>
  );
}
