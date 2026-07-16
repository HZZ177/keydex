import { RefreshCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { GitHistoryFilters } from "@/runtime/git";
import type { GitCommitSummary, GitObjectId } from "@/runtime/gitTypes";
import { computeGitGraph, type GitGraphRow } from "@/renderer/features/git/graph/gitGraph";

import styles from "./GitHistoryView.module.css";

const ROW_HEIGHT = 36;
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
    <section className={styles.root} aria-label="Git history">
      <header>
        <span>{commits.length} loaded commit(s)</span>
        <button type="button" disabled={loading} onClick={onRefresh}>
          <RefreshCw size={12} />Refresh
        </button>
      </header>
      {onApplyFilters ? (
        <form
          className={styles.filters}
          aria-label="History filters"
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
            <span className={styles.visuallyHidden}>Message or commit hash</span>
            <input
              value={draftFilters.search}
              placeholder="Message or hash"
              onChange={(event) => setDraftFilters((current) => ({ ...current, search: event.target.value }))}
            />
          </label>
          <label>
            <span>Revision</span>
            <input
              aria-label="Revision"
              list="git-history-revisions"
              value={draftFilters.revision}
              placeholder="All refs / HEAD / branch / range"
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
            <span>Author</span>
            <input value={draftFilters.author} onChange={(event) => setDraftFilters((current) => ({ ...current, author: event.target.value }))} />
          </label>
          <label>
            <span>Since</span>
            <input type="date" value={draftFilters.since} onChange={(event) => setDraftFilters((current) => ({ ...current, since: event.target.value }))} />
          </label>
          <label>
            <span>Until</span>
            <input type="date" value={draftFilters.until} onChange={(event) => setDraftFilters((current) => ({ ...current, until: event.target.value }))} />
          </label>
          <label>
            <span>Path</span>
            <input value={draftFilters.path} placeholder="src/file.ts" onChange={(event) => setDraftFilters((current) => ({ ...current, path: event.target.value }))} />
          </label>
          <label className={styles.check}>
            <input type="checkbox" checked={draftFilters.firstParent} onChange={(event) => setDraftFilters((current) => ({ ...current, firstParent: event.target.checked }))} />First parent
          </label>
          <label className={styles.check}>
            <input type="checkbox" checked={draftFilters.mergesOnly} onChange={(event) => setDraftFilters((current) => ({ ...current, mergesOnly: event.target.checked }))} />Merges
          </label>
          <button type="submit" disabled={loading}><Search size={12} />Apply</button>
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
            <X size={12} />Clear
          </button>
          {revisionError ? <span className={styles.filterError} role="alert">{revisionError}</span> : null}
        </form>
      ) : null}
      {commits.length === 0 && !loading ? (
        <div className={styles.empty} role="status">No commits match the current filters.</div>
      ) : (
        <div
          className={styles.scroller}
          role="listbox"
          aria-label="Commit history"
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
          {loading ? "Loading…" : "Load older commits"}
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
    return { valid: false, message: "Enter a valid Git revision or two-revision range." };
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
      aria-label={row.isMerge ? `Merge graph with ${row.parentIds.length} parents` : "Commit graph"}
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
