import { useMemo } from "react";

import { fileReviewDocumentFromChanges } from "@/renderer/components/diff/adapters/fileReviewDocument";
import { CompactDiffView } from "@/renderer/components/diff/wrappers/CompactDiffView";
import type { FileReviewChange } from "@/renderer/utils/fileReview";

import styles from "./FileReviewDiff.module.css";

export interface FileReviewCardProps {
  file: FileReviewChange;
  compact?: boolean;
  titlePrefix?: string;
}

export function FileReviewCard({ file, compact = true, titlePrefix = "" }: FileReviewCardProps) {
  const document = useMemo(
    () => fileReviewDocumentFromChanges([file]),
    [file],
  );
  const copySource = file.diff || file.content || "";

  return (
    <section
      className={styles.migratedCard}
      data-compact={compact ? "true" : "false"}
      data-empty={document.files.length ? "false" : "true"}
      data-diff-engine="keydex-pierre"
      data-testid="file-review-card"
      aria-label="文件变更预览"
    >
      {titlePrefix ? <span className={styles.migratedPrefix}>{titlePrefix}</span> : null}
      <CompactDiffView
        document={document}
        defaultExpanded
        actions={copySource ? {
          copyPatch: async () => {
            if (!navigator.clipboard?.writeText) throw new Error("剪贴板不可用");
            await navigator.clipboard.writeText(copySource);
          },
        } : {}}
      />
    </section>
  );
}
