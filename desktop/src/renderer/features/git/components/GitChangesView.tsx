import { ChevronDown, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

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
  onPreviewChange?: (entry: GitChangeEntry | null) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  selectionResetKey?: number;
}

export function GitChangesView({
  status,
  virtualizationThreshold = GIT_CHANGES_VIRTUALIZATION_THRESHOLD,
  viewportHeight = 520,
  onSelectionChange,
  onPreviewChange,
  onRefresh,
  refreshing = false,
  selectionResetKey = 0,
}: GitChangesViewProps) {
  const groups = useMemo(() => groupGitChanges(status?.files ?? []), [status?.files]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(new Set());
  const [previewedId, setPreviewedId] = useState<string | null>(null);
  const totalEntries = groups.reduce((total, group) => total + group.entries.length, 0);
  const virtualized = totalEntries > virtualizationThreshold;
  const selectedPaths = uniqueSelectedChangePaths(groups, selectedIds);

  useEffect(() => {
    setSelectedIds(new Set());
    setPreviewedId(null);
  }, [selectionResetKey]);

  useEffect(() => {
    const entries = groups.flatMap((group) => group.entries);
    if (entries.length === 0) {
      if (previewedId !== null) {
        setPreviewedId(null);
        onPreviewChange?.(null);
      }
      return;
    }
    if (previewedId && entries.some((entry) => entry.id === previewedId)) return;
    const firstEntry = entries[0]!;
    setPreviewedId(firstEntry.id);
    onPreviewChange?.(firstEntry);
  }, [groups, onPreviewChange, previewedId]);

  const updateSelection = (next: Set<string>) => {
    setSelectedIds(next);
    onSelectionChange?.(
      uniqueSelectedChangePaths(groups, next),
      groups.flatMap((group) => group.entries.filter((entry) => next.has(entry.id))),
    );
  };

  const toggleGroup = (groupId: string) => {
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const previewEntry = (entry: GitChangeEntry) => {
    setPreviewedId(entry.id);
    onPreviewChange?.(entry);
  };

  if (!status) return <div className={styles.state} role="status">正在读取本地改动…</div>;

  return (
    <div className={styles.root} data-virtualized={virtualized ? "true" : "false"}>
      <div className={styles.summary}>
        <span>{totalEntries} 个文件</span>
        <span>{selectedPaths.length} 个已选择</span>
        {onRefresh ? (
          <button
            type="button"
            className={styles.refreshButton}
            aria-label={refreshing ? "正在刷新本地改动" : "刷新本地改动"}
            title={refreshing ? "正在刷新本地改动" : "刷新本地改动"}
            data-loading={refreshing ? "true" : "false"}
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw className={styles.refreshIcon} size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className={styles.groups} role="tree" aria-label="本地改动" data-virtualized={virtualized ? "true" : "false"}>
        {groups.length === 0 ? (
          <div className={styles.state} role="status">工作区干净</div>
        ) : virtualized ? (
          <VirtualizedChangesTree
            groups={groups}
            selectedIds={selectedIds}
            collapsedGroupIds={collapsedGroupIds}
            previewedId={previewedId}
            viewportHeight={viewportHeight}
            onSelectionChange={updateSelection}
            onToggleGroup={toggleGroup}
            onPreview={previewEntry}
          />
        ) : groups.map((group) => {
          const collapsed = collapsedGroupIds.has(group.id);
          return (
            <section className={styles.group} data-collapsed={collapsed ? "true" : "false"} key={group.id} role="group" aria-label={group.label}>
              <div className={styles.groupHeader}>
                <button
                  type="button"
                  className={styles.groupToggle}
                  aria-label={`${collapsed ? "展开" : "折叠"}${group.label}`}
                  aria-expanded={!collapsed}
                  onClick={() => toggleGroup(group.id)}
                >
                  <ChevronDown className={styles.groupChevron} data-collapsed={collapsed ? "true" : "false"} size={15} aria-hidden="true" />
                </button>
                <GroupSelectionCheckbox
                  group={group}
                  selectedIds={selectedIds}
                  onSelectionChange={updateSelection}
                />
                <strong>{group.label}</strong>
                <span>{group.entries.length} 个文件</span>
              </div>
              <div className={styles.groupEntries} data-collapsed={collapsed ? "true" : "false"}>
                <div className={styles.groupEntriesInner}>
                  {group.entries.map((entry) => (
                    <GitChangeRow
                      entry={entry}
                      selected={selectedIds.has(entry.id)}
                      previewed={previewedId === entry.id}
                      key={entry.id}
                      onPreview={() => previewEntry(entry)}
                      onSelect={(selected) => {
                        const next = new Set(selectedIds);
                        if (selected) next.add(entry.id);
                        else next.delete(entry.id);
                        updateSelection(next);
                      }}
                    />
                  ))}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function GroupSelectionCheckbox({
  group,
  selectedIds,
  onSelectionChange,
}: {
  group: GitChangeGroup;
  selectedIds: ReadonlySet<string>;
  onSelectionChange: (selectedIds: Set<string>) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectedCount = group.entries.reduce(
    (count, entry) => count + (selectedIds.has(entry.id) ? 1 : 0),
    0,
  );
  const checked = group.entries.length > 0 && selectedCount === group.entries.length;
  const mixed = selectedCount > 0 && !checked;

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = mixed;
  }, [mixed]);

  return (
    <input
      ref={inputRef}
      type="checkbox"
      aria-label={`选择${group.label}`}
      aria-checked={mixed ? "mixed" : checked}
      checked={checked}
      data-selection-state={mixed ? "mixed" : checked ? "all" : "none"}
      onChange={(event) => {
        const next = new Set(selectedIds);
        group.entries.forEach((entry) => event.currentTarget.checked ? next.add(entry.id) : next.delete(entry.id));
        onSelectionChange(next);
      }}
    />
  );
}

function GitChangeRow({
  entry,
  selected,
  previewed,
  onPreview,
  onSelect,
}: {
  entry: GitChangeEntry;
  selected: boolean;
  previewed: boolean;
  onPreview: () => void;
  onSelect: (selected: boolean) => void;
}) {
  const icon = useMaterialEntryIcon(entry.path, "file");
  return (
    <div
      className={styles.row}
      data-status={entry.status}
      data-previewed={previewed ? "true" : "false"}
      role="treeitem"
      aria-label={`${entry.displayPath} ${entry.status}`}
      tabIndex={0}
      onClick={onPreview}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onPreview();
      }}
    >
      <input
        type="checkbox"
        aria-label={`${entry.displayPath} ${entry.status}`}
        checked={selected}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onSelect(event.currentTarget.checked)}
      />
      <img
        alt=""
        aria-hidden="true"
        className={styles.materialIcon}
        data-icon-id={icon.id}
        draggable={false}
        src={icon.src}
      />
      <span className={styles.fileText} title={entry.path}>
        <span className={styles.name} title={entry.name}>{entry.name}</span>
        {entry.directory ? <span className={styles.directory} title={entry.directory}>{entry.directory}</span> : null}
      </span>
      {entry.binary ? <small>二进制</small> : null}
      {entry.submodule ? <small>子模块</small> : null}
      <span className={styles.status} aria-hidden="true">{statusLabel(entry.status)}</span>
    </div>
  );
}

const VIRTUAL_CHANGE_ROW_HEIGHT = 31;
const VIRTUAL_CHANGE_OVERSCAN = 8;

function VirtualizedChangesTree({
  groups,
  selectedIds,
  collapsedGroupIds,
  previewedId,
  viewportHeight,
  onSelectionChange,
  onToggleGroup,
  onPreview,
}: {
  groups: readonly GitChangeGroup[];
  selectedIds: ReadonlySet<string>;
  collapsedGroupIds: ReadonlySet<string>;
  previewedId: string | null;
  viewportHeight: number;
  onSelectionChange: (selectedIds: Set<string>) => void;
  onToggleGroup: (groupId: string) => void;
  onPreview: (entry: GitChangeEntry) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const items = useMemo(
    () => groups.flatMap((group) => {
      const header = { key: `group:${group.id}`, group, entry: null };
      return collapsedGroupIds.has(group.id)
        ? [header]
        : [header, ...group.entries.map((entry) => ({ key: entry.id, group, entry }))];
    }),
    [collapsedGroupIds, groups],
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
            const collapsed = collapsedGroupIds.has(item.group.id);
            return (
              <div
                className={`${styles.groupHeader} ${styles.virtualItem}`}
                style={position}
                key={item.key}
                role="treeitem"
                aria-level={1}
                aria-expanded={!collapsed}
              >
                <button
                  type="button"
                  className={styles.groupToggle}
                  aria-label={`${collapsed ? "展开" : "折叠"}${item.group.label}`}
                  aria-expanded={!collapsed}
                  onClick={() => onToggleGroup(item.group.id)}
                >
                  <ChevronDown className={styles.groupChevron} data-collapsed={collapsed ? "true" : "false"} size={15} aria-hidden="true" />
                </button>
                <GroupSelectionCheckbox
                  group={item.group}
                  selectedIds={selectedIds}
                  onSelectionChange={onSelectionChange}
                />
                <strong>{item.group.label}</strong>
                <span>{item.group.entries.length} 个文件</span>
              </div>
            );
          }
          return (
            <div className={styles.virtualItem} style={position} key={item.key}>
              <GitChangeRow
                entry={item.entry}
                selected={selectedIds.has(item.entry.id)}
                previewed={previewedId === item.entry.id}
                onPreview={() => onPreview(item.entry!)}
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
    conflicted: "!",
    type_changed: "T",
  })[status];
}
