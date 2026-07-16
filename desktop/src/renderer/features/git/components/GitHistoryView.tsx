import { RefreshCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { GitHistoryFilters } from "@/runtime/git";
import type { GitCommitSummary, GitObjectId } from "@/runtime/gitTypes";
import { computeGitGraph, type GitGraphRow } from "@/renderer/features/git/graph/gitGraph";

import styles from "./GitHistoryView.module.css";

const ROW_HEIGHT = 40;
const OVERSCAN = 8;

export const EMPTY_GIT_HISTORY_FILTERS: GitHistoryFilters = {
  search: "",
  revision: "",
  author: "",
  since: "",
  until: "",
  path: "",
  firstParent: false,
  mergesOnly: false,
};

export interface GitHistoryRevisionOption {
  value: string;
  label: string;
}

export function GitHistoryView({
  commits,
  selectedObjectId,
  loading,
  hasMore,
  viewportHeight = 520,
  onSelect,
  onLoadMore,
  onRefresh,
  filters = EMPTY_GIT_HISTORY_FILTERS,
  revisionOptions = [],
  onApplyFilters,
}: {
  commits: readonly GitCommitSummary[];
  selectedObjectId: GitObjectId | null;
  loading: boolean;
  hasMore: boolean;
  viewportHeight?: number;
  onSelect: (commit: GitCommitSummary) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  filters?: GitHistoryFilters;
  revisionOptions?: readonly GitHistoryRevisionOption[];
  onApplyFilters?: (filters: GitHistoryFilters) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [draftFilters, setDraftFilters] = useState<GitHistoryFilters>({ ...filters });
  const [revisionError, setRevisionError] = useState<string | null>(null);
  useEffect(() => setDraftFilters({ ...filters }), [filters]);
  const graph = useMemo(() => computeGitGraph(commits), [commits]);
  const window = useMemo(
    () => historyVirtualWindow(commits.length, scrollTop, viewportHeight),
    [commits.length, scrollTop, viewportHeight],
  );

  return (
    <section className={styles.root} aria-label="Git 日志">
      <header>
        <span>已加载 {commits.length} 个提交</span>
        <button type="button" disabled={loading} onClick={onRefresh}>
          <RefreshCw size={12} />刷新
        </button>
      </header>
      {onApplyFilters ? (
        <form
          className={styles.filters}
          aria-label="日志筛选条件"
          onSubmit={(event) => {
            event.preventDefault();
            const validation = validateHistoryRevision(draftFilters.revision);
            if (!validation.valid) {
              setRevisionError(validation.message);
              return;
            }
            setRevisionError(null);
            setScrollTop(0);
            onApplyFilters({ ...draftFilters });
          }}
        >
          <label className={styles.searchField}>
            <Search size={12} aria-hidden="true" />
            <span className={styles.visuallyHidden}>提交说明或哈希</span>
            <input
              value={draftFilters.search}
              placeholder="提交说明或哈希"
              onChange={(event) => setDraftFilters((current) => ({ ...current, search: event.target.value }))}
            />
          </label>
          <label>
            <span>修订</span>
            <input
              aria-label="修订"
              list="git-history-revisions"
              value={draftFilters.revision}
              placeholder="全部引用、当前指针、分支或范围"
              onChange={(event) => {
                setRevisionError(null);
                setDraftFilters((current) => ({ ...current, revision: event.target.value }));
              }}
            />
            <datalist id="git-history-revisions">
              {revisionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </datalist>
          </label>
          <label>
            <span>作者</span>
            <input value={draftFilters.author} onChange={(event) => setDraftFilters((current) => ({ ...current, author: event.target.value }))} />
          </label>
          <label>
            <span>开始日期</span>
            <input type="date" value={draftFilters.since} onChange={(event) => setDraftFilters((current) => ({ ...current, since: event.target.value }))} />
          </label>
          <label>
            <span>结束日期</span>
            <input type="date" value={draftFilters.until} onChange={(event) => setDraftFilters((current) => ({ ...current, until: event.target.value }))} />
          </label>
          <label>
            <span>路径</span>
            <input value={draftFilters.path} placeholder="源码/文件.ts" onChange={(event) => setDraftFilters((current) => ({ ...current, path: event.target.value }))} />
          </label>
          <label className={styles.check}>
            <input type="checkbox" checked={draftFilters.firstParent} onChange={(event) => setDraftFilters((current) => ({ ...current, firstParent: event.target.checked }))} />仅第一父提交
          </label>
          <label className={styles.check}>
            <input type="checkbox" checked={draftFilters.mergesOnly} onChange={(event) => setDraftFilters((current) => ({ ...current, mergesOnly: event.target.checked }))} />仅合并提交
          </label>
          <button type="submit" disabled={loading}><Search size={12} />应用</button>
          <button
            type="button"
            disabled={loading || isEmptyHistoryFilters(draftFilters)}
            onClick={() => {
              const empty = { ...EMPTY_GIT_HISTORY_FILTERS };
              setDraftFilters(empty);
              setScrollTop(0);
              onApplyFilters(empty);
            }}
          >
            <X size={12} />清除
          </button>
          {revisionError ? <span className={styles.filterError} role="alert">{revisionError}</span> : null}
        </form>
      ) : null}
      {commits.length === 0 && !loading ? (
        <div className={styles.empty} role="status">没有符合当前筛选条件的提交。</div>
      ) : (
        <div
          className={styles.scroller}
          role="listbox"
          aria-label="提交日志"
          aria-busy={loading}
          data-virtualized={commits.length > window.renderedCount ? "true" : "false"}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div className={styles.canvas} style={{ height: commits.length * ROW_HEIGHT }}>
            {commits.slice(window.start, window.end).map((commit, offset) => {
              const index = window.start + offset;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedObjectId === commit.objectId}
                  className={styles.row}
                  data-git-history-row="true"
                  style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }}
                  key={commit.objectId}
                  onClick={() => onSelect(commit)}
                >
                  <GitGraphCell row={graph.rows[index]} columnCount={graph.columnCount} />
                  <span className={styles.subject}>{commit.subject}</span>
                  <span className={styles.refs}>{commit.decorations.slice(0, 3).join(" · ")}</span>
                  <span className={styles.author}>{commit.authorName}</span>
                  <time dateTime={commit.committedAt}>{formatHistoryDate(commit.committedAt)}</time>
                  <code>{commit.objectId.slice(0, 8)}</code>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {hasMore ? (
        <button type="button" className={styles.more} disabled={loading} onClick={onLoadMore}>
          {loading ? "正在加载…" : "加载更早的提交"}
        </button>
      ) : null}
    </section>
  );
}

export function isEmptyHistoryFilters(filters: GitHistoryFilters): boolean {
  return !filters.search.trim()
    && !filters.revision.trim()
    && !filters.author.trim()
    && !filters.since.trim()
    && !filters.until.trim()
    && !filters.path.trim()
    && !filters.firstParent
    && !filters.mergesOnly;
}

export function historyVirtualWindow(total: number, scrollTop: number, viewportHeight: number) {
  const visible = Math.max(1, Math.ceil(Math.max(1, viewportHeight) / ROW_HEIGHT));
  const start = Math.max(0, Math.floor(Math.max(0, scrollTop) / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(total, start + visible + OVERSCAN * 2);
  return { start, end, renderedCount: Math.max(0, end - start), rowHeight: ROW_HEIGHT };
}

export function mergeHistoryPages(
  current: readonly GitCommitSummary[],
  incoming: readonly GitCommitSummary[],
  direction: "append" | "prepend",
): readonly GitCommitSummary[] {
  const ordered = direction === "prepend" ? [...incoming, ...current] : [...current, ...incoming];
  const seen = new Set<string>();
  return ordered.filter((commit) => {
    if (seen.has(commit.objectId)) return false;
    seen.add(commit.objectId);
    return true;
  });
}

export function validateHistoryRevision(value: string): { valid: boolean; message: string } {
  const revision = value.trim();
  if (!revision) return { valid: true, message: "" };
  const separator = revision.includes("...") ? "..." : revision.includes("..") ? ".." : null;
  const parts = separator ? revision.split(separator) : [revision];
  if ((separator && parts.length !== 2) || parts.some((part) => !isSafeRevisionAtom(part))) {
    return { valid: false, message: "请输入有效的 Git 修订或双修订范围。" };
  }
  return { valid: true, message: "" };
}

function isSafeRevisionAtom(value: string): boolean {
  const revision = value.trim();
  if (!revision || revision.startsWith("-") || /[\u0000-\u0020:?*\\]/u.test(revision)) return false;
  if (revision === "HEAD" || /^[0-9a-f]{4,64}$/iu.test(revision)) return true;
  const ancestry = revision.match(/^(.+?)(?:(?:[~^][0-9]*)|(?:@\{[0-9]+\}))+$/u);
  if (!ancestry && /[~^]/u.test(revision)) return false;
  const base = ancestry?.[1] ?? revision;
  return !base.startsWith(".")
    && !base.startsWith("/")
    && !base.endsWith("/")
    && !base.endsWith(".")
    && !base.endsWith(".lock")
    && !base.includes("..")
    && !base.includes("@{")
    && !base.includes("//");
}

function GitGraphCell({ row, columnCount }: { row: GitGraphRow; columnCount: number }) {
  const laneWidth = 12;
  const width = Math.max(18, columnCount * laneWidth + 6);
  const x = (column: number) => 6 + column * laneWidth;
  const outputIndex = (objectId: string) => row.outputLanes.findIndex((lane) => lane.objectId === objectId);
  return (
    <svg
      className={styles.graph}
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      role="img"
      aria-label={row.isMerge ? `包含 ${row.parentIds.length} 个父提交的合并图` : "提交关系图"}
      data-commit-column={row.commitColumn}
    >
      {row.inputLanes.map((lane, inputColumn) => {
        if (lane.objectId === row.objectId) return null;
        const nextColumn = outputIndex(lane.objectId);
        if (nextColumn < 0) return null;
        return <path key={`lane-${lane.objectId}-${inputColumn}`} d={`M ${x(inputColumn)} 0 L ${x(nextColumn)} ${ROW_HEIGHT}`} stroke={graphColor(lane.colorIndex)} />;
      })}
      {row.parentIds.map((parentId) => {
        const nextColumn = outputIndex(parentId);
        if (nextColumn < 0) return null;
        return <path key={`parent-${parentId}`} d={`M ${x(row.commitColumn)} ${ROW_HEIGHT / 2} L ${x(nextColumn)} ${ROW_HEIGHT}`} stroke={graphColor(row.outputLanes[nextColumn].colorIndex)} />;
      })}
      {row.inputLanes.some((lane) => lane.objectId === row.objectId) ? <path d={`M ${x(row.commitColumn)} 0 L ${x(row.commitColumn)} ${ROW_HEIGHT / 2}`} stroke={graphColor(row.commitColorIndex)} /> : null}
      <circle cx={x(row.commitColumn)} cy={ROW_HEIGHT / 2} r={4} fill="var(--surface-1)" stroke={graphColor(row.commitColorIndex)} />
    </svg>
  );
}

function graphColor(index: number): string {
  const palette = ["#6f8cff", "#46a36b", "#d28a36", "#b070d4", "#3b9fb3", "#d05f72"];
  return palette[index % palette.length];
}

function formatHistoryDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
