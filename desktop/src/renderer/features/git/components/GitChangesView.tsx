import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useMaterialEntryIcon } from "@/renderer/components/workspace/materialIconTheme";
import { groupGitChanges, uniqueSelectedChangePaths, type GitChangeEntry, type GitChangeGroup } from "@/renderer/features/git/changesTree";
import { GIT_CHANGES_VIRTUALIZATION_THRESHOLD } from "@/renderer/features/git/performancePolicy";
import type { GitStatusSnapshot } from "@/runtime/gitTypes";

import styles from "./GitChangesView.module.css";

export interface GitChangesViewProps {
  status: GitStatusSnapshot | null;
  virtualizationThreshold?: number;
  viewportHeight?: number;
  onSelectionChange?: (paths: readonly string[], entries: readonly GitChangeEntry[]) => void;
  selectionResetKey?: number;
}

export function GitChangesView({
  status,
  virtualizationThreshold = GIT_CHANGES_VIRTUALIZATION_THRESHOLD,
  viewportHeight = 520,
  onSelectionChange,
  selectionResetKey = 0,
}: GitChangesViewProps) {
  const groups = useMemo(() => groupGitChanges(status?.files ?? []), [status?.files]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const totalEntries = groups.reduce((total, group) => total + group.entries.length, 0);
  const virtualized = totalEntries > virtualizationThreshold;
  const selectedPaths = uniqueSelectedChangePaths(groups, selectedIds);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [selectionResetKey]);

  const updateSelection = (next: Set<string>) => {
    setSelectedIds(next);
    onSelectionChange?.(
      uniqueSelectedChangePaths(groups, next),
      groups.flatMap((group) => group.entries.filter((entry) => next.has(entry.id))),
    );
  };

  if (!status) return <div className={styles.state} role="status">正在读取本地改动…</div>;

  return (
    <div className={styles.root} data-virtualized={virtualized ? "true" : "false"}>
      <div className={styles.summary}>
        <span>{totalEntries} 个文件</span>
        <span>{selectedPaths.length} 个已选择</span>
      </div>
      <div className={styles.groups} role="tree" aria-label="本地改动" data-virtualized={virtualized ? "true" : "false"}>
        {groups.length === 0 ? (
          <div className={styles.state} role="status">工作区干净</div>
        ) : virtualized ? (
          <VirtualizedChangesTree
            groups={groups}
            selectedIds={selectedIds}
            viewportHeight={viewportHeight}
            onSelectionChange={updateSelection}
          />
        ) : groups.map((group) => {
          const groupSelected = group.entries.every((entry) => selectedIds.has(entry.id));
          return (
            <section className={styles.group} key={group.id} role="group" aria-label={group.label}>
              <div className={styles.groupHeader}>
                <ChevronDown size={13} aria-hidden="true" />
                <input
                  type="checkbox"
                  aria-label={`选择${group.label}`}
                  checked={groupSelected}
                  onChange={(event) => {
                    const next = new Set(selectedIds);
                    group.entries.forEach((entry) => event.currentTarget.checked ? next.add(entry.id) : next.delete(entry.id));
                    updateSelection(next);
                  }}
                />
                <strong>{group.label}</strong>
                <span>{group.entries.length}</span>
              </div>
              {group.entries.map((entry) => (
                <GitChangeRow
                  entry={entry}
                  selected={selectedIds.has(entry.id)}
                  key={entry.id}
                  onSelect={(selected) => {
                    const next = new Set(selectedIds);
                    if (selected) next.add(entry.id);
                    else next.delete(entry.id);
                    updateSelection(next);
                  }}
                />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function GitChangeRow({
  entry,
  selected,
  onSelect,
}: {
  entry: GitChangeEntry;
  selected: boolean;
  onSelect: (selected: boolean) => void;
}) {
  const icon = useMaterialEntryIcon(entry.path, "file");
  return (
    <label
      className={styles.row}
      data-status={entry.status}
      role="treeitem"
      aria-label={`${entry.displayPath} ${entry.status}`}
    >
      <input type="checkbox" checked={selected} onChange={(event) => onSelect(event.currentTarget.checked)} />
      <img
        alt=""
        aria-hidden="true"
        className={styles.materialIcon}
        data-icon-id={icon.id}
        draggable={false}
        src={icon.src}
      />
      <span className={styles.fileText}>
        <span className={styles.name}>{entry.name}</span>
        {entry.directory ? <span className={styles.directory}>{entry.directory}</span> : null}
      </span>
      {entry.binary ? <small>二进制</small> : null}
      {entry.submodule ? <small>子模块</small> : null}
      <span className={styles.status} aria-hidden="true">{statusLabel(entry.status)}</span>
    </label>
  );
}

const VIRTUAL_CHANGE_ROW_HEIGHT = 31;
const VIRTUAL_CHANGE_OVERSCAN = 8;

function VirtualizedChangesTree({
  groups,
  selectedIds,
  viewportHeight,
  onSelectionChange,
}: {
  groups: readonly GitChangeGroup[];
  selectedIds: ReadonlySet<string>;
  viewportHeight: number;
  onSelectionChange: (selectedIds: Set<string>) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const items = useMemo(
    () => groups.flatMap((group) => [
      { key: `group:${group.id}`, group, entry: null },
      ...group.entries.map((entry) => ({ key: entry.id, group, entry })),
    ]),
    [groups],
  );
  const window = changesVirtualWindow(items.length, scrollTop, viewportHeight);
  return (
    <div
      className={styles.virtualScroller}
      data-virtualized="true"
      data-rendered-count={window.renderedCount}
      style={{ height: Math.max(VIRTUAL_CHANGE_ROW_HEIGHT, viewportHeight) }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className={styles.virtualCanvas} style={{ height: items.length * VIRTUAL_CHANGE_ROW_HEIGHT }}>
        {items.slice(window.start, window.end).map((item, offset) => {
          const index = window.start + offset;
          const position = { transform: `translateY(${index * VIRTUAL_CHANGE_ROW_HEIGHT}px)` };
          if (!item.entry) {
            const groupSelected = item.group.entries.every((entry) => selectedIds.has(entry.id));
            return (
              <div
                className={`${styles.groupHeader} ${styles.virtualItem}`}
                style={position}
                key={item.key}
                role="treeitem"
                aria-level={1}
                aria-expanded="true"
              >
                <ChevronDown size={13} aria-hidden="true" />
                <input
                  type="checkbox"
                  aria-label={`选择${item.group.label}`}
                  checked={groupSelected}
                  onChange={(event) => {
                    const next = new Set(selectedIds);
                    item.group.entries.forEach((entry) => event.currentTarget.checked ? next.add(entry.id) : next.delete(entry.id));
                    onSelectionChange(next);
                  }}
                />
                <strong>{item.group.label}</strong>
                <span>{item.group.entries.length}</span>
              </div>
            );
          }
          return (
            <div className={styles.virtualItem} style={position} key={item.key}>
              <GitChangeRow
                entry={item.entry}
                selected={selectedIds.has(item.entry.id)}
                onSelect={(selected) => {
                  const next = new Set(selectedIds);
                  if (selected) next.add(item.entry!.id);
                  else next.delete(item.entry!.id);
                  onSelectionChange(next);
                }}
              />
            </div>
          );
        })}
      </div>
      <span className={styles.visuallyHidden} role="status">已优化展示 {items.length} 行 Git 改动</span>
    </div>
  );
}

export function changesVirtualWindow(total: number, scrollTop: number, viewportHeight: number) {
  const visible = Math.max(1, Math.ceil(Math.max(1, viewportHeight) / VIRTUAL_CHANGE_ROW_HEIGHT));
  const start = Math.max(0, Math.floor(Math.max(0, scrollTop) / VIRTUAL_CHANGE_ROW_HEIGHT) - VIRTUAL_CHANGE_OVERSCAN);
  const end = Math.min(total, start + visible + VIRTUAL_CHANGE_OVERSCAN * 2);
  return { start, end, renderedCount: Math.max(0, end - start), rowHeight: VIRTUAL_CHANGE_ROW_HEIGHT };
}

function statusLabel(status: GitChangeEntry["status"]): string {
  return ({
    added: "A",
    modified: "M",
    deleted: "D",
    renamed: "R",
    copied: "C",
    untracked: "?",
    ignored: "",
    conflicted: "!",
    type_changed: "T",
  })[status];
}
