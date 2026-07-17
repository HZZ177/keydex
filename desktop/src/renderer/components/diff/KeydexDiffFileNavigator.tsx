import { ChevronDown, ChevronRight, Files, Search } from "lucide-react";
import {
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type UIEvent,
} from "react";

import { useMaterialEntryIcon } from "@/renderer/components/workspace/materialIconTheme";
import type { KeydexDiffFile } from "./model";
import styles from "./KeydexDiffFileNavigator.module.css";

const ROW_HEIGHT = 34;
const VIEWPORT_ROWS = 8;
const OVERSCAN_ROWS = 4;

export interface KeydexDiffFileNavigatorProps {
  readonly files: readonly KeydexDiffFile[];
  readonly activeFileId: string | null;
  readonly expandedFileIds?: readonly string[];
  readonly defaultOpen?: boolean;
  readonly onActiveFileChange: (fileId: string) => void;
  readonly onExpandedFilesChange?: (fileIds: readonly string[]) => void;
}

export interface KeydexDiffFileWindow {
  readonly start: number;
  readonly end: number;
  readonly offset: number;
  readonly totalHeight: number;
}

export function KeydexDiffFileNavigator({
  files,
  activeFileId,
  expandedFileIds,
  defaultOpen = false,
  onActiveFileChange,
  onExpandedFilesChange,
}: KeydexDiffFileNavigatorProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const listRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(
    () => deferredQuery
      ? files.filter((file) => file.displayPath.toLocaleLowerCase().includes(deferredQuery))
      : files,
    [deferredQuery, files],
  );
  const windowed = resolveKeydexDiffFileWindow(filtered.length, scrollTop);
  const visible = filtered.slice(windowed.start, windowed.end);
  const expanded = useMemo(() => new Set(expandedFileIds), [expandedFileIds]);

  const focusRow = (index: number) => {
    const clamped = Math.max(0, Math.min(filtered.length - 1, index));
    const file = filtered[clamped];
    if (!file) return;
    onActiveFileChange(file.id);
    const nextTop = clamped * ROW_HEIGHT;
    if (listRef.current) listRef.current.scrollTop = nextTop;
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-diff-file-id="${CSS.escape(file.id)}"]`)
        ?.focus();
    });
  };

  return (
    <section
      className={styles.navigator}
      data-open={open ? "true" : "false"}
      aria-label="差异文件导航"
    >
      <button
        className={styles.summary}
        type="button"
        aria-label={`${open ? "收起" : "展开"}差异文件导航，${files.length} 个变更文件，当前 ${files.find((file) => file.id === activeFileId)?.displayPath ?? "未选择文件"}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Files size={15} aria-hidden="true" />
        <span>{files.length} 个变更文件</span>
        <span className={styles.activePath} title={files.find((file) => file.id === activeFileId)?.displayPath}>
          {files.find((file) => file.id === activeFileId)?.displayPath ?? "请选择文件"}
        </span>
        <ChevronDown className={styles.summaryChevron} size={15} aria-hidden="true" />
      </button>
      <div className={styles.collapseRegion} aria-hidden={!open}>
        <div className={styles.collapseContent}>
          <label className={styles.search}>
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">筛选变更文件</span>
            <input
              aria-label="筛选变更文件"
              value={query}
              placeholder="筛选文件"
              tabIndex={open ? 0 : -1}
              onChange={(event) => {
                setQuery(event.target.value);
                setScrollTop(0);
                if (listRef.current) listRef.current.scrollTop = 0;
              }}
            />
          </label>
          {filtered.length > 0 ? (
            <div
              ref={listRef}
              className={`${styles.list} keydex-scrollable`}
              role="listbox"
              aria-label="变更文件"
              tabIndex={-1}
              style={{ height: Math.min(VIEWPORT_ROWS, filtered.length) * ROW_HEIGHT }}
              onScroll={(event: UIEvent<HTMLDivElement>) => setScrollTop(event.currentTarget.scrollTop)}
            >
              <div className={styles.virtualTrack} style={{ height: windowed.totalHeight }}>
                <div
                  className={styles.virtualWindow}
                  style={{ transform: `translateY(${windowed.offset}px)` }}
                >
                  {visible.map((file, localIndex) => {
                    const globalIndex = windowed.start + localIndex;
                    return (
                      <DiffFileRow
                        key={file.id}
                        file={file}
                        active={file.id === activeFileId}
                        expanded={expandedFileIds ? expanded.has(file.id) : undefined}
                        tabIndex={file.id === activeFileId ? 0 : -1}
                        onSelect={() => onActiveFileChange(file.id)}
                        onToggle={onExpandedFilesChange ? () => {
                          const next = new Set(expanded);
                          if (next.has(file.id)) next.delete(file.id);
                          else next.add(file.id);
                          onExpandedFilesChange(files.filter((candidate) => next.has(candidate.id)).map((candidate) => candidate.id));
                        } : undefined}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowDown") {
                            event.preventDefault();
                            focusRow(globalIndex + 1);
                          } else if (event.key === "ArrowUp") {
                            event.preventDefault();
                            focusRow(globalIndex - 1);
                          } else if (event.key === "Home") {
                            event.preventDefault();
                            focusRow(0);
                          } else if (event.key === "End") {
                            event.preventDefault();
                            focusRow(filtered.length - 1);
                          }
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          ) : <div className={styles.empty}>没有匹配的文件</div>}
        </div>
      </div>
    </section>
  );
}

export function resolveKeydexDiffFileWindow(
  count: number,
  scrollTop: number,
  viewportRows = VIEWPORT_ROWS,
  overscanRows = OVERSCAN_ROWS,
): KeydexDiffFileWindow {
  const safeCount = Math.max(0, Math.floor(count));
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / ROW_HEIGHT));
  const start = Math.max(0, Math.min(safeCount, first - overscanRows));
  const end = Math.max(start, Math.min(safeCount, first + viewportRows + overscanRows));
  return Object.freeze({
    start,
    end,
    offset: start * ROW_HEIGHT,
    totalHeight: safeCount * ROW_HEIGHT,
  });
}

function DiffFileRow({
  file,
  active,
  expanded,
  tabIndex,
  onSelect,
  onToggle,
  onKeyDown,
}: {
  readonly file: KeydexDiffFile;
  readonly active: boolean;
  readonly expanded: boolean | undefined;
  readonly tabIndex: number;
  readonly onSelect: () => void;
  readonly onToggle?: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const icon = useMaterialEntryIcon(file.displayPath, "file");
  const parts = splitDisplayPath(file.displayPath);
  const style = { "--diff-file-row-height": `${ROW_HEIGHT}px` } as CSSProperties;
  return (
    <div className={styles.row} data-active={active ? "true" : undefined} style={style}>
      {onToggle ? (
        <button
          className={styles.expandButton}
          type="button"
          aria-label={expanded ? `收起 ${file.displayPath}` : `展开 ${file.displayPath}`}
          aria-expanded={expanded}
          tabIndex={-1}
          onClick={onToggle}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      ) : <span className={styles.expandSpacer} />}
      <button
        className={styles.fileButton}
        type="button"
        role="option"
        aria-selected={active}
        data-diff-file-id={file.id}
        tabIndex={tabIndex}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        <img src={icon.src} alt="" aria-hidden="true" draggable={false} />
        <span className={styles.fileName}>{parts.name}</span>
        <span className={styles.filePath}>{parts.directory}</span>
        <span className={styles.stats}>
          {file.additions === null ? null : <span data-kind="add">+{file.additions}</span>}
          {file.deletions === null ? null : <span data-kind="delete">−{file.deletions}</span>}
        </span>
      </button>
    </div>
  );
}

function splitDisplayPath(path: string): { name: string; directory: string } {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index < 0
    ? { name: path, directory: "" }
    : { name: path.slice(index + 1), directory: path.slice(0, index) };
}
