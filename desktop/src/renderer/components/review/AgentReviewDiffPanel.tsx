import { useMemo, useState } from "react";

import { fileReviewDocumentFromChanges } from "@/renderer/components/diff/adapters/fileReviewDocument";
import type { KeydexDiffDocument } from "@/renderer/components/diff/model";
import { ReviewDiffView } from "@/renderer/components/diff/wrappers/ReviewDiffView";
import type { FileReviewChange } from "@/renderer/utils/fileReview";

import styles from "./FileReviewDiff.module.css";

export interface AgentReviewDiffPanelProps {
  readonly files: readonly FileReviewChange[];
  readonly document?: KeydexDiffDocument | null;
  readonly focusedPath?: string | null;
  readonly title?: string;
  readonly scopeKey: string;
  readonly onFocusPath?: (path: string) => void;
  readonly onOpenFile?: (path: string) => void;
}

export function AgentReviewDiffPanel({
  files,
  document: providedDocument,
  focusedPath,
  title = "审阅",
  scopeKey,
  onFocusPath,
  onOpenFile,
}: AgentReviewDiffPanelProps) {
  const generatedDocument = useMemo(
    () => fileReviewDocumentFromChanges(files, {
      sessionId: scopeKey,
      requestId: title,
    }),
    [files, scopeKey, title],
  );
  const document = providedDocument ?? generatedDocument;
  const [wrap, setWrap] = useState(false);

  if (!document.files.length) {
    return (
      <section
        className={styles.panel}
        data-testid="right-sidebar-review-panel"
        aria-label="审阅"
      >
        <div className={styles.panelEmpty} data-testid="review-empty-state">
          <span>暂无可审阅的文件变更</span>
        </div>
      </section>
    );
  }

  return (
    <section
      className={styles.panel}
      data-testid="right-sidebar-review-panel"
      aria-label="审阅"
    >
      <ReviewDiffView
        document={document}
        focusedPath={focusedPath}
        onFocusPath={onFocusPath}
        scrollScopeKey={`agent-review:${scopeKey}`}
        wrap={wrap}
        onWrapChange={setWrap}
        actions={{
          copyPatch: async (patch) => {
            if (!navigator.clipboard?.writeText) throw new Error("剪贴板不可用");
            await navigator.clipboard.writeText(patch);
          },
          ...(onOpenFile ? { openFile: onOpenFile } : {}),
        }}
      />
    </section>
  );
}
