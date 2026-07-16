import { Cloud, GitBranch, RefreshCw, Search, Tag } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import type { GitHistoryFilters } from "@/runtime/git";
import type { GitCommitSummary, GitObjectId } from "@/runtime/gitTypes";
import { gitGraphColor } from "@/renderer/features/git/graph/gitGraphColor";
import { computeGitGraph, type GitGraphRow } from "@/renderer/features/git/graph/gitGraph";
import { SettingsSelect } from "@/renderer/pages/settings/components";

import styles from "./GitHistoryView.module.css";

const ROW_HEIGHT = 40;
const OVERSCAN = 8;

export const EMPTY_GIT_HISTORY_FILTERS: GitHistoryFilters = {
  search: "",
  revision: "",
  author: "",
  since: "",
};

const HISTORY_DATE_OPTIONS = [
  { value: "", label: "全部日期" },
  { value: "24h", label: "过去 24 小时" },
  { value: "7d", label: "过去 7 天" },
] as const;

export interface GitHistoryRevisionOption {
  value: string;
  label: string;
}

export interface GitHistoryDecorationPresentation {
  combined: boolean;
  fullNames: readonly string[];
  kind: "current" | "local" | "remote" | "tag" | "other";
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
  authorOptions = [],
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
  authorOptions?: readonly string[];
  onApplyFilters?: (filters: GitHistoryFilters) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [draftFilters, setDraftFilters] = useState<GitHistoryFilters>({ ...filters });
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setDraftFilters({ ...filters }), [filters]);
  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);
  const graph = useMemo(() => computeGitGraph(commits), [commits]);
  const graphWidth = historyGraphWidth(graph.columnCount);
  const window = useMemo(
    () => historyVirtualWindow(commits.length, scrollTop, viewportHeight),
    [commits.length, scrollTop, viewportHeight],
  );
  const applyFilters = (next: GitHistoryFilters) => {
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
    setDraftFilters(next);
    setScrollTop(0);
    onApplyFilters?.(next);
  };
  const scheduleSearch = (search: string) => {
    setDraftFilters((current) => {
      const next = { ...current, search };
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => {
        searchTimer.current = null;
        setScrollTop(0);
        onApplyFilters?.(next);
      }, 300);
      return next;
    });
  };

  return (
    <section
      className={styles.root}
      aria-label="Git 日志"
      style={{ "--git-history-graph-width": `${graphWidth}px` } as CSSProperties}
    >
      <div className={styles.tableTop}>
        {onApplyFilters ? (
          <form
            className={styles.filters}
            aria-label="日志筛选条件"
            onSubmit={(event) => {
              event.preventDefault();
              applyFilters({ ...draftFilters });
            }}
          >
          <label className={styles.searchField}>
            <Search size={12} aria-hidden="true" />
            <span className={styles.visuallyHidden}>提交说明或哈希</span>
            <input
              value={draftFilters.search}
              placeholder="提交说明或哈希"
              onChange={(event) => scheduleSearch(event.target.value)}
              onBlur={() => {
                if (draftFilters.search !== filters.search) applyFilters({ ...draftFilters });
              }}
            />
          </label>
          <div className={styles.filterControl}>
            <span>分支</span>
            <SettingsSelect
              alignment="start"
              ariaLabel="分支筛选"
              density="compact"
              dropdownWidth="min(620px, calc(100vw - 24px))"
              options={[
                { value: "", label: "全部分支" },
                ...(draftFilters.revision && !revisionOptions.some((option) => option.value === draftFilters.revision)
                  ? [{ value: draftFilters.revision, label: draftFilters.revision }]
                  : []),
                ...revisionOptions.map((option) => ({ value: option.value, label: option.label })),
              ]}
              value={draftFilters.revision}
              onChange={(revision) => applyFilters({ ...draftFilters, revision })}
            />
          </div>
          <div className={styles.filterControl}>
            <span>用户</span>
            <SettingsSelect
              ariaLabel="用户筛选"
              density="compact"
              options={[
                { value: "", label: "全部用户" },
                ...(draftFilters.author && !authorOptions.includes(draftFilters.author)
                  ? [{ value: draftFilters.author, label: draftFilters.author }]
                  : []),
                ...authorOptions.map((author) => ({ value: author, label: author })),
              ]}
              value={draftFilters.author}
              onChange={(author) => applyFilters({ ...draftFilters, author })}
            />
          </div>
          <div className={styles.filterControl}>
            <span>日期</span>
            <SettingsSelect
              ariaLabel="日期筛选"
              density="compact"
              options={[...HISTORY_DATE_OPTIONS]}
              value={draftFilters.since}
              onChange={(since) => applyFilters({ ...draftFilters, since })}
            />
          </div>
          <button
            type="button"
            className={styles.refreshButton}
            aria-label="刷新提交日志"
            aria-busy={loading}
            data-loading={loading ? "true" : "false"}
            title="刷新提交日志"
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw className={styles.refreshIcon} size={14} />
          </button>
          </form>
        ) : null}
        <div className={styles.columnHeader} role="row" aria-label="提交日志列">
          <span role="columnheader" aria-label="提交关系" />
          <span role="columnheader">提交说明</span>
          <span role="columnheader">引用</span>
          <span role="columnheader">作者</span>
          <span role="columnheader">提交时间</span>
        </div>
      </div>
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
              const decorations = presentGitHistoryDecorations(commit.decorations);
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedObjectId === commit.objectId}
                  className={styles.row}
                  data-git-history-row="true"
                  data-has-refs={decorations.length > 0 ? "true" : "false"}
                  style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }}
                  key={commit.objectId}
                  onClick={() => onSelect(commit)}
                >
                  <GitGraphCell row={graph.rows[index]} columnCount={graph.columnCount} />
                  <span className={styles.subject} data-git-history-subject="true">{commit.subject}</span>
                  <span className={styles.refsSlot} data-git-history-ref-slot="true">
                    {decorations.length > 0 ? <GitHistoryRefs decorations={decorations} /> : null}
                  </span>
                  <span className={styles.author}>{commit.authorName}</span>
                  <time dateTime={commit.committedAt}>{formatHistoryDate(commit.committedAt)}</time>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <button type="button" className={styles.more} disabled={loading || !hasMore} onClick={onLoadMore}>
        {loading
          ? `正在加载…（已加载 ${commits.length} 个）`
          : hasMore
            ? `加载更早的提交（已加载 ${commits.length} 个）`
            : `已加载全部 ${commits.length} 个提交`}
      </button>
    </section>
  );
}

interface ParsedGitHistoryDecoration {
  branchName: string | null;
  current: boolean;
  fullNames: string[];
  kind: "local" | "remote" | "tag" | "other";
  label: string;
  remoteName: string | null;
}

export function presentGitHistoryDecorations(
  decorations: readonly string[],
): readonly GitHistoryDecorationPresentation[] {
  const parsed = deduplicateDecorations(
    decorations.map(parseGitHistoryDecoration).filter((item): item is ParsedGitHistoryDecoration => Boolean(item)),
  );
  const remotes = parsed.filter((item) => item.kind === "remote");
  const usedRemotes = new Set<ParsedGitHistoryDecoration>();
  const presented: GitHistoryDecorationPresentation[] = [];

  for (const item of parsed.filter((candidate) => candidate.kind === "local")) {
    const matchingRemotes = remotes.filter((remote) => remote.branchName === item.branchName);
    matchingRemotes.forEach((remote) => usedRemotes.add(remote));
    presented.push({
      combined: matchingRemotes.length > 0,
      fullNames: [item, ...matchingRemotes].flatMap((reference) => reference.fullNames),
      kind: item.current ? "current" : "local",
      label: matchingRemotes.length > 0
        ? `${matchingRemotes.map((remote) => remote.remoteName).filter(Boolean).join("、")} & ${item.label}`
        : item.label,
    });
  }

  for (const item of parsed) {
    if (item.kind === "local" || usedRemotes.has(item)) continue;
    presented.push({
      combined: false,
      fullNames: item.fullNames,
      kind: item.current ? "current" : item.kind,
      label: item.label,
    });
  }

  return presented.sort((left, right) => decorationRank(left.kind) - decorationRank(right.kind));
}

function parseGitHistoryDecoration(value: string): ParsedGitHistoryDecoration | null {
  const raw = value.trim();
  if (!raw) return null;
  const arrow = raw.split(/\s*(?:->|→)\s*/, 2);
  if (arrow.length === 2) {
    const target = parseGitHistoryDecoration(arrow[1]);
    if (!target) return null;
    return {
      ...target,
      current: arrow[0] === "HEAD" || target.current,
      fullNames: [raw, ...target.fullNames],
    };
  }
  const normalized = raw.startsWith("tag: ") ? raw.slice(5).trim() : raw;
  if (normalized.startsWith("refs/heads/")) {
    const branchName = normalized.slice("refs/heads/".length);
    return { branchName, current: false, fullNames: [raw], kind: "local", label: branchName, remoteName: null };
  }
  if (normalized.startsWith("refs/remotes/")) {
    const label = normalized.slice("refs/remotes/".length);
    const separator = label.indexOf("/");
    return {
      branchName: separator >= 0 ? label.slice(separator + 1) : label,
      current: false,
      fullNames: [raw],
      kind: "remote",
      label,
      remoteName: separator >= 0 ? label.slice(0, separator) : label,
    };
  }
  if (normalized.startsWith("refs/tags/")) {
    return { branchName: null, current: false, fullNames: [raw], kind: "tag", label: normalized.slice("refs/tags/".length), remoteName: null };
  }
  if (normalized === "HEAD") {
    return { branchName: null, current: true, fullNames: [raw], kind: "other", label: "HEAD", remoteName: null };
  }
  return { branchName: null, current: false, fullNames: [raw], kind: "other", label: normalized, remoteName: null };
}

function deduplicateDecorations(items: readonly ParsedGitHistoryDecoration[]): ParsedGitHistoryDecoration[] {
  const byKey = new Map<string, ParsedGitHistoryDecoration>();
  for (const item of items) {
    const key = `${item.kind}:${item.label}`;
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, item);
      continue;
    }
    previous.current ||= item.current;
    previous.fullNames = Array.from(new Set([...previous.fullNames, ...item.fullNames]));
  }
  return [...byKey.values()];
}

function decorationRank(kind: GitHistoryDecorationPresentation["kind"]): number {
  return ({ current: 0, local: 1, remote: 2, tag: 3, other: 4 })[kind];
}

function GitHistoryRefs({ decorations }: { decorations: readonly GitHistoryDecorationPresentation[] }) {
  const visible = decorations.slice(0, 3);
  return (
    <span
      className={styles.refs}
      data-git-history-refs="true"
      aria-label={`引用：${decorations.map((item) => item.label).join("，")}`}
    >
      {visible.map((item) => (
        <span
          className={styles.refToken}
          data-kind={item.kind}
          key={`${item.kind}:${item.label}`}
          title={item.fullNames.join("\n")}
        >
          <GitHistoryRefIcon combined={item.combined} kind={item.kind} />
          <span>{item.label}</span>
        </span>
      ))}
      {decorations.length > visible.length ? (
        <span className={styles.refMore}>+{decorations.length - visible.length}</span>
      ) : null}
    </span>
  );
}

function GitHistoryRefIcon({ combined, kind }: {
  combined: boolean;
  kind: GitHistoryDecorationPresentation["kind"];
}) {
  if (combined) {
    return (
      <span className={styles.refIconStack} data-tone={kind} aria-hidden="true">
        <Cloud size={11} />
        <GitBranch size={11} />
      </span>
    );
  }
  const Icon = kind === "tag" ? Tag : kind === "remote" ? Cloud : GitBranch;
  return <Icon className={styles.refIcon} data-tone={kind} size={12} aria-hidden="true" />;
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

function GitGraphCell({ row, columnCount }: { row: GitGraphRow; columnCount: number }) {
  const laneWidth = 12;
  const width = historyGraphWidth(columnCount);
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
        return <path key={`lane-${lane.objectId}-${inputColumn}`} d={`M ${x(inputColumn)} 0 L ${x(nextColumn)} ${ROW_HEIGHT}`} stroke={gitGraphColor(lane.colorIndex)} />;
      })}
      {row.parentIds.map((parentId) => {
        const nextColumn = outputIndex(parentId);
        if (nextColumn < 0) return null;
        return <path key={`parent-${parentId}`} d={`M ${x(row.commitColumn)} ${ROW_HEIGHT / 2} L ${x(nextColumn)} ${ROW_HEIGHT}`} stroke={gitGraphColor(row.outputLanes[nextColumn].colorIndex)} />;
      })}
      {row.inputLanes.some((lane) => lane.objectId === row.objectId) ? <path d={`M ${x(row.commitColumn)} 0 L ${x(row.commitColumn)} ${ROW_HEIGHT / 2}`} stroke={gitGraphColor(row.commitColorIndex)} /> : null}
      <circle cx={x(row.commitColumn)} cy={ROW_HEIGHT / 2} r={3.75} fill={gitGraphColor(row.commitColorIndex)} />
    </svg>
  );
}

export function historyGraphWidth(columnCount: number): number {
  return Math.max(30, columnCount * 12 + 6);
}

export { gitGraphColor } from "@/renderer/features/git/graph/gitGraphColor";

function formatHistoryDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
