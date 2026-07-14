import { Check, ChevronRight, Copy, ExternalLink, FileDiff, WrapText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppTooltipLayer } from "@/renderer/components/tooltip";
import { useMaterialEntryIcon } from "@/renderer/components/workspace/materialIconTheme";
import { useCopyFeedback } from "@/renderer/hooks/useCopyFeedback";
import type { FileReviewChange } from "@/renderer/utils/fileReview";
import { parseUnifiedDiffDisplayLines, type UnifiedDiffDisplayLine } from "@/renderer/utils/unifiedDiff";

import styles from "./FileReviewDiff.module.css";

export interface FileReviewCardProps {
  file: FileReviewChange;
  compact?: boolean;
  titlePrefix?: string;
}

export interface FileReviewPanelProps {
  files: FileReviewChange[];
  focusedPath?: string | null;
  title?: string;
  onFocusPath?: (path: string) => void;
  onOpenFile?: (path: string) => void;
}

export function FileReviewCard({ file, compact = true, titlePrefix = "" }: FileReviewCardProps) {
  const lines = useMemo(() => fileReviewDisplayLines(file), [file]);
  const copySource = file.diff || file.content || "";
  const { copyState, showCopyFeedback } = useCopyFeedback();
  const copied = copyState === "copied";

  const handleCopy = async () => {
    if (!copySource) {
      return;
    }
    try {
      await navigator.clipboard?.writeText(copySource);
      showCopyFeedback("copied");
    } catch {
      showCopyFeedback("failed");
    }
  };

  return (
    <section
      className={styles.card}
      data-compact={compact ? "true" : "false"}
      data-empty={lines.length ? "false" : "true"}
      data-testid="file-review-card"
      aria-label="文件变更预览"
    >
      <header className={styles.cardHeader}>
        <span className={styles.cardTitle}>
          {titlePrefix ? <span className={styles.titlePrefix}>{titlePrefix}</span> : null}
          <span className={styles.path}>{file.path}</span>
        </span>
        <LineStats additions={file.additions} deletions={file.deletions} />
        <button
          className={styles.iconButton}
          type="button"
          aria-label={copied ? "已复制 diff" : "复制 diff"}
          data-tooltip-label={copied ? "已复制 diff" : "复制 diff"}
          title={copied ? "已复制 diff" : "复制 diff"}
          disabled={!copySource}
          onClick={() => void handleCopy()}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </header>
      {lines.length ? (
        <UnifiedDiffRows className={styles.diff} lines={lines} />
      ) : (
        <div className={styles.emptyDiff}>这次文件变更没有可展示的 diff</div>
      )}
    </section>
  );
}

export function FileReviewPanel({
  files,
  focusedPath,
  title = "审阅",
  onFocusPath,
  onOpenFile,
}: FileReviewPanelProps) {
  const selectedFile =
    files.find((file) => file.path === focusedPath) ??
    files.find((file) => file.newPath === focusedPath || file.oldPath === focusedPath) ??
    files[0] ??
    null;
  const defaultExpandedPath = selectedFile?.path ?? null;
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() =>
    defaultExpandedPath ? new Set([defaultExpandedPath]) : new Set(),
  );
  const [lineWrapping, setLineWrapping] = useState(true);

  useEffect(() => {
    setExpandedPaths(defaultExpandedPath ? new Set([defaultExpandedPath]) : new Set());
  }, [defaultExpandedPath]);

  if (!files.length || !selectedFile) {
    return (
      <section
        className={styles.panel}
        data-review-tooltips="true"
        data-testid="right-sidebar-review-panel"
        aria-label="审阅"
      >
        <AppTooltipLayer scopeSelector="[data-review-tooltips='true']" defaultPlacement="top" />
        <div className={styles.panelEmpty} data-testid="review-empty-state">
          <FileDiff size={18} />
          <span>暂无可审阅的文件变更</span>
        </div>
      </section>
    );
  }

  return (
    <section
      className={styles.panel}
      data-review-tooltips="true"
      data-testid="right-sidebar-review-panel"
      aria-label="审阅"
    >
      <AppTooltipLayer scopeSelector="[data-review-tooltips='true']" defaultPlacement="top" />
      <div className={styles.panelFileList} aria-label={title || "审阅"}>
        {files.map((file) => {
          const expanded = expandedPaths.has(file.path);
          return (
            <FileReviewSection
              expanded={expanded}
              file={file}
              key={file.path}
              lineWrapping={lineWrapping}
              onOpenFile={onOpenFile}
              onToggleLineWrapping={() => setLineWrapping((wrapping) => !wrapping)}
              onToggle={() => {
                onFocusPath?.(file.path);
                setExpandedPaths((current) => {
                  const next = new Set(current);
                  if (next.has(file.path)) {
                    next.delete(file.path);
                  } else {
                    next.add(file.path);
                  }
                  return next;
                });
              }}
            />
          );
        })}
      </div>
    </section>
  );
}

function FileReviewSection({
  expanded,
  file,
  lineWrapping,
  onOpenFile,
  onToggleLineWrapping,
  onToggle,
}: {
  expanded: boolean;
  file: FileReviewChange;
  lineWrapping: boolean;
  onOpenFile?: (path: string) => void;
  onToggleLineWrapping: () => void;
  onToggle: () => void;
}) {
  const icon = useMaterialEntryIcon(file.path, "file");

  return (
    <section className={styles.reviewFileSection} data-expanded={expanded ? "true" : "false"}>
      <div className={styles.reviewFileHeader} data-has-open={onOpenFile ? "true" : "false"}>
        <button
          className={styles.reviewFileToggle}
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? `收起 ${file.path} diff` : `展开 ${file.path} diff`}
          onClick={onToggle}
        >
          <ChevronRight className={styles.reviewFileChevron} size={15} aria-hidden="true" />
          <img className={styles.reviewFileIcon} src={icon.src} alt="" aria-hidden="true" draggable={false} />
          <PathLabel path={file.path} />
          <LineStats additions={file.additions} deletions={file.deletions} />
        </button>
        <button
          className={styles.reviewFileActionButton}
          type="button"
          aria-label={lineWrapping ? "关闭自动换行" : "开启自动换行"}
          aria-pressed={lineWrapping}
          data-tooltip-label={lineWrapping ? "取消换行" : "自动换行"}
          onClick={onToggleLineWrapping}
        >
          <WrapText size={14} strokeWidth={1.9} />
        </button>
        {onOpenFile ? (
          <button
            className={styles.reviewFileActionButton}
            type="button"
            aria-label={`打开文件 ${file.path}`}
            data-tooltip-label="打开文件"
            onClick={() => onOpenFile(file.path)}
          >
            <ExternalLink size={14} strokeWidth={1.9} />
          </button>
        ) : null}
      </div>
      {expanded ? <FileReviewFullDiff file={file} lineWrapping={lineWrapping} /> : null}
    </section>
  );
}

function FileReviewFullDiff({ file, lineWrapping }: { file: FileReviewChange; lineWrapping: boolean }) {
  const lines = useMemo(() => fileReviewDisplayLines(file), [file]);
  return lines.length ? (
    <UnifiedDiffRows className={styles.panelDiff} lines={lines} wrap={lineWrapping} />
  ) : (
    <div className={styles.panelEmptyDiff}>这次文件变更没有可展示的 diff</div>
  );
}

function PathLabel({ path }: { path: string }) {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (lastSlash < 0) {
    return <span className={styles.reviewPathBase}>{path}</span>;
  }
  return (
    <span className={styles.reviewPath}>
      <span className={styles.reviewPathDir}>{path.slice(0, lastSlash + 1)}</span>
      <span className={styles.reviewPathBase}>{path.slice(lastSlash + 1)}</span>
    </span>
  );
}

export function UnifiedDiffRows({
  className,
  lines,
  wrap = false,
}: {
  className?: string;
  lines: UnifiedDiffDisplayLine[];
  wrap?: boolean;
}) {
  return (
    <div
      className={className ?? styles.diff}
      data-testid="file-review-diff"
      data-wrap={wrap ? "true" : "false"}
      aria-label="文件 diff"
    >
      {lines.map((line) => (
        <div className={styles.diffRow} data-kind={line.kind} key={line.key}>
          <span className={styles.diffGutter} aria-hidden={line.kind === "separator" ? "true" : undefined}>
            <span className={styles.diffLineNo}>{line.lineNumber ?? ""}</span>
            <span className={styles.diffSign}>{line.sign}</span>
          </span>
          <code>{line.content || " "}</code>
        </div>
      ))}
    </div>
  );
}

function LineStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className={styles.lineStats} aria-label={`新增 ${additions} 行，删除 ${deletions} 行`}>
      <span data-kind="added">+{additions}</span>
      <span data-kind="removed">-{deletions}</span>
    </span>
  );
}

export function fileReviewDisplayLines(file: FileReviewChange): UnifiedDiffDisplayLine[] {
  const diffLines = parseRenderableDiffLines(file.diff);
  if (diffLines.length) {
    return diffLines;
  }
  if (file.operation === "add" && file.content) {
    return contentAsAddedLines(file.content);
  }
  return [];
}

function parseRenderableDiffLines(diff: string): UnifiedDiffDisplayLine[] {
  if (!diff.trim()) {
    return [];
  }
  const lines = parseUnifiedDiffDisplayLines(diff);
  return lines.length === 1 && lines[0]?.key === "empty" ? [] : lines;
}

function contentAsAddedLines(content: string): UnifiedDiffDisplayLine[] {
  const normalizedLineEndings = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const normalized = normalizedLineEndings.endsWith("\n")
    ? normalizedLineEndings.slice(0, -1)
    : normalizedLineEndings;
  if (!normalized) {
    return [];
  }
  return normalized.split("\n").map((line, index) => ({
    key: `content:add:${index + 1}`,
    kind: "add",
    lineNumber: index + 1,
    sign: "+",
    content: line,
  }));
}
