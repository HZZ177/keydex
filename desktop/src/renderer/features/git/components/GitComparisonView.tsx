import { AlertTriangle, GitCompareArrows, RotateCcw } from "lucide-react";
import { useCallback, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { LoadingSkeleton } from "@/renderer/components/loading";
import { useRafPanelResize } from "@/renderer/components/layout/useRafPanelResize";
import type { GitToolWindowNavigationIntent } from "@/renderer/features/git/store/gitStore";
import type { GitCommitSummary, GitCompareResult } from "@/runtime/gitTypes";

import { GitCommitFileTree } from "./GitCommitDetailsView";
import styles from "./GitComparisonView.module.css";

export function GitComparisonView({
  intent,
  result,
  currentOnlyCommits,
  targetOnlyCommits,
  selectedCommitId,
  selectedFileIndex,
  loading,
  error,
  onSelectCommit,
  onSelectFile,
  onRetry,
}: {
  intent: GitToolWindowNavigationIntent;
  result: GitCompareResult | null;
  currentOnlyCommits: readonly GitCommitSummary[];
  targetOnlyCommits: readonly GitCommitSummary[];
  selectedCommitId: string | null;
  selectedFileIndex: number;
  loading: boolean;
  error: string | null;
  onSelectCommit: (commit: GitCommitSummary) => void;
  onSelectFile: (index: number) => void;
  onRetry: () => void;
}) {
  const [upperCommitPercent, setUpperCommitPercent] = useState(50);
  const comparisonRef = useRef<HTMLDivElement>(null);
  const resizeExtentRef = useRef(1);
  const clampUpperCommitPercent = useCallback((value: number) => Math.min(82, Math.max(18, value)), []);
  const previewUpperCommitPercent = useCallback((value: number) => {
    comparisonRef.current?.style.setProperty("--git-comparison-upper-height", `${value}%`);
  }, []);
  const comparisonResize = useRafPanelResize({
    axis: "y",
    disabled: intent.kind !== "compare_refs" || loading || Boolean(error),
    width: upperCommitPercent,
    getWidth: (startPercent, startY, clientY) => clampUpperCommitPercent(
      startPercent + ((clientY - startY) / resizeExtentRef.current) * 100,
    ),
    onPreview: previewUpperCommitPercent,
    onCommit: (value) => setUpperCommitPercent(clampUpperCommitPercent(value)),
  });
  const startComparisonResize = useCallback((event: Parameters<typeof comparisonResize.startDrag>[0]) => {
    const height = comparisonRef.current?.getBoundingClientRect().height ?? 1;
    resizeExtentRef.current = Math.max(1, height - 43);
    comparisonResize.startDrag(event);
  }, [comparisonResize.startDrag]);
  const handleComparisonResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowUp") next = upperCommitPercent - 2;
    if (event.key === "ArrowDown") next = upperCommitPercent + 2;
    if (event.key === "Home") next = 18;
    if (event.key === "End") next = 82;
    if (next === null) return;
    event.preventDefault();
    setUpperCommitPercent(clampUpperCommitPercent(next));
  };

  if (loading && !result) {
    return <LoadingSkeleton className={styles.loading} aria-label="正在比较 Git 修订" lineCount={9} />;
  }

  if (error) {
    return (
      <div className={styles.state} role="alert">
        <AlertTriangle size={18} aria-hidden="true" />
        <strong>无法完成比较</strong>
        <span>{error}</span>
        <button type="button" onClick={onRetry}><RotateCcw size={13} />重新加载</button>
      </div>
    );
  }

  if (intent.kind === "compare_refs") {
    return (
      <div
        ref={comparisonRef}
        className={styles.refComparison}
        aria-label={`${intent.currentRef} 与 ${intent.targetRef} 的提交比较`}
        style={{ "--git-comparison-upper-height": `${upperCommitPercent}%` } as CSSProperties}
      >
        <ComparisonSummary
          title={`比较 ${intent.currentRef} 和 ${intent.targetRef}`}
          result={result}
        />
        <CommitDirectionPanel
          title={`存在于 ${intent.currentRef} 中但不存在于 ${intent.targetRef} 中的提交`}
          commits={currentOnlyCommits}
          selectedCommitId={selectedCommitId}
          onSelectCommit={onSelectCommit}
        />
        <div
          className={styles.commitSeparator}
          role="separator"
          aria-label="调整两组提交列表高度"
          aria-orientation="horizontal"
          aria-valuemin={18}
          aria-valuemax={82}
          aria-valuenow={Math.round(upperCommitPercent)}
          tabIndex={0}
          data-dragging={comparisonResize.dragging ? "true" : "false"}
          onPointerDown={startComparisonResize}
          onDoubleClick={() => setUpperCommitPercent(50)}
          onKeyDown={handleComparisonResizeKeyDown}
        />
        <CommitDirectionPanel
          title={`存在于 ${intent.targetRef} 中但不存在于 ${intent.currentRef} 中的提交`}
          commits={targetOnlyCommits}
          selectedCommitId={selectedCommitId}
          onSelectCommit={onSelectCommit}
        />
      </div>
    );
  }

  const additions = result?.files.reduce((total, file) => total + (file.additions ?? 0), 0) ?? 0;
  const deletions = result?.files.reduce((total, file) => total + (file.deletions ?? 0), 0) ?? 0;
  return (
    <div className={styles.worktreeComparison} aria-label={`${intent.targetRef} 与当前工作树的差异`}>
      <header className={styles.worktreeHeader}>
        <div>
          <GitCompareArrows size={14} aria-hidden="true" />
          <strong>{intent.targetRef} 与当前工作树之间的更改</strong>
        </div>
        <span>{result?.files.length ?? 0} 个文件</span>
        <span className={styles.additions}>+{additions}</span>
        <span className={styles.deletions}>−{deletions}</span>
      </header>
      <div className={`${styles.fileTreeViewport} keydex-scrollable`}>
        {result && result.files.length > 0 ? (
          <GitCommitFileTree
            files={result.files}
            selectedFileIndex={selectedFileIndex}
            ariaLabel="与工作树比较的文件"
            onSelectFile={onSelectFile}
          />
        ) : (
          <div className={styles.empty}>该修订与当前工作树没有文件差异。</div>
        )}
      </div>
    </div>
  );
}

function ComparisonSummary({ title, result }: { title: string; result: GitCompareResult | null }) {
  return (
    <header className={styles.summary}>
      <div><GitCompareArrows size={14} aria-hidden="true" /><strong>{title}</strong></div>
      {result ? <span>{result.files.length} 个差异文件</span> : null}
    </header>
  );
}

function CommitDirectionPanel({
  title,
  commits,
  selectedCommitId,
  onSelectCommit,
}: {
  title: string;
  commits: readonly GitCommitSummary[];
  selectedCommitId: string | null;
  onSelectCommit: (commit: GitCommitSummary) => void;
}) {
  return (
    <section className={styles.commitPanel}>
      <header className={styles.directionHeader}>
        <AlertTriangle size={13} aria-hidden="true" />
        <strong>{title}</strong>
        <span>{commits.length} 个提交</span>
      </header>
      {commits.length > 0 ? (
        <ul className={`${styles.commitList} keydex-scrollable`} role="listbox" aria-label={title}>
          {commits.map((commit) => (
            <li key={commit.objectId} role="option" aria-selected={commit.objectId === selectedCommitId}>
              <button
                type="button"
                data-selected={commit.objectId === selectedCommitId ? "true" : undefined}
                onClick={() => onSelectCommit(commit)}
              >
                <span className={styles.graphDot} aria-hidden="true" />
                <span className={styles.commitSubject}>{commit.subject || "无提交标题"}</span>
                <span className={styles.commitAuthor}>{commit.authorName}</span>
                <time dateTime={commit.committedAt}>{formatCompactDate(commit.committedAt)}</time>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.empty}>这一侧没有独有提交。</div>
      )}
    </section>
  );
}

function formatCompactDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
