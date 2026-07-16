import { ChevronDown, File, FileWarning, Folder, Package } from "lucide-react";
import { useMemo, useState } from "react";

import { groupGitChanges, uniqueSelectedChangePaths, type GitChangeEntry, type GitChangeGroup } from "@/renderer/features/git/changesTree";
import type { GitStatusSnapshot } from "@/runtime/gitTypes";
import { GIT_CHANGES_VIRTUALIZATION_THRESHOLD } from "@/renderer/features/git/performancePolicy";

import styles from "./GitChangesView.module.css";

export interface GitChangesViewProps {
  status: GitStatusSnapshot | null;
  showIgnored?: boolean;
  onShowIgnoredChange?: (show: boolean) => void;
  virtualizationThreshold?: number;
  viewportHeight?: number;
  onSelectionChange?: (paths: readonly string[], entries: readonly GitChangeEntry[]) => void;
  onStagePaths?: (paths: readonly string[]) => void | Promise<void>;
  staging?: boolean;
  onUnstagePaths?: (paths: readonly string[]) => void | Promise<void>;
  unstaging?: boolean;
  onDiscardPaths?: (paths: readonly string[]) => void | Promise<void>;
  onCleanPaths?: (paths: readonly string[]) => void | Promise<void>;
  onIgnorePaths?: (paths: readonly string[]) => void | Promise<void>;
  destructiveActionRunning?: boolean;
}

export function GitChangesView({
  status,
  showIgnored = false,
  onShowIgnoredChange,
  virtualizationThreshold = GIT_CHANGES_VIRTUALIZATION_THRESHOLD,
  viewportHeight = 520,
  onSelectionChange,
  onStagePaths,
  staging = false,
  onUnstagePaths,
  unstaging = false,
  onDiscardPaths,
  onCleanPaths,
  onIgnorePaths,
  destructiveActionRunning = false,
}: GitChangesViewProps) {
  const visibleFiles = useMemo(
    () => (status?.files ?? []).filter((file) => showIgnored || file.worktreeStatus !== "ignored"),
    [showIgnored, status?.files],
  );
  const groups = useMemo(() => groupGitChanges(visibleFiles), [visibleFiles]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingDestructive, setPendingDestructive] = useState<{ kind: "discard" | "clean"; paths: string[] } | null>(null);
  const [strongConfirmation, setStrongConfirmation] = useState("");
  const totalEntries = groups.reduce((total, group) => total + group.entries.length, 0);
  const virtualized = totalEntries > virtualizationThreshold;
  const selectedPaths = uniqueSelectedChangePaths(groups, selectedIds);
  const stageableIds = new Set(
    groups.filter((group) => group.id !== "staged").flatMap((group) => group.entries.map((entry) => entry.id)),
  );
  const stageablePaths = uniqueSelectedChangePaths(
    groups,
    new Set(Array.from(selectedIds).filter((id) => stageableIds.has(id))),
  );
  const stagedIds = new Set(
    groups.filter((group) => group.id === "staged").flatMap((group) => group.entries.map((entry) => entry.id)),
  );
  const unstageablePaths = uniqueSelectedChangePaths(
    groups,
    new Set(Array.from(selectedIds).filter((id) => stagedIds.has(id))),
  );
  const discardableIds = new Set(
    groups.filter((group) => group.id === "unstaged").flatMap((group) => group.entries.map((entry) => entry.id)),
  );
  const discardablePaths = uniqueSelectedChangePaths(
    groups,
    new Set(Array.from(selectedIds).filter((id) => discardableIds.has(id))),
  );
  const untrackedIds = new Set(
    groups.filter((group) => group.id === "untracked").flatMap((group) => group.entries.map((entry) => entry.id)),
  );
  const cleanablePaths = uniqueSelectedChangePaths(
    groups,
    new Set(Array.from(selectedIds).filter((id) => untrackedIds.has(id))),
  );
  const ignorablePaths = Array.from(new Set([...discardablePaths, ...cleanablePaths])).sort();

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
        <span>{totalEntries} 个改动</span>
        <span>{selectedPaths.length} 个文件已选择</span>
        {onShowIgnoredChange ? (
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={showIgnored}
              onChange={(event) => onShowIgnoredChange(event.currentTarget.checked)}
            />
            显示已忽略文件
          </label>
        ) : null}
        {onStagePaths ? (
          <button
            type="button"
            className={styles.action}
            disabled={stageablePaths.length === 0 || staging}
            onClick={() => void onStagePaths(stageablePaths)}
          >
            {staging ? "正在暂存…" : "暂存"}
          </button>
        ) : null}
        {onUnstagePaths ? (
          <button
            type="button"
            className={styles.action}
            disabled={unstageablePaths.length === 0 || unstaging}
            onClick={() => void onUnstagePaths(unstageablePaths)}
          >
            {unstaging ? "正在取消暂存…" : "取消暂存"}
          </button>
        ) : null}
        {onDiscardPaths ? (
          <button
            type="button"
            className={styles.action}
            disabled={discardablePaths.length === 0 || destructiveActionRunning}
            onClick={() => setPendingDestructive({ kind: "discard", paths: discardablePaths })}
          >
            丢弃改动
          </button>
        ) : null}
        {onCleanPaths ? (
          <button
            type="button"
            className={styles.action}
            disabled={cleanablePaths.length === 0 || destructiveActionRunning}
            onClick={() => {
              setStrongConfirmation("");
              setPendingDestructive({ kind: "clean", paths: cleanablePaths });
            }}
          >
            删除未跟踪文件
          </button>
        ) : null}
        {onIgnorePaths ? (
          <button
            type="button"
            className={styles.action}
            disabled={ignorablePaths.length === 0 || destructiveActionRunning}
            onClick={() => void onIgnorePaths(ignorablePaths)}
          >
            忽略
          </button>
        ) : null}
      </div>
      {pendingDestructive ? (
        <div className={styles.confirmation} role="alertdialog" aria-label={pendingDestructive.kind === "clean" ? "确认删除未跟踪文件" : "确认丢弃改动"}>
          <strong>{pendingDestructive.kind === "clean" ? "永久删除未跟踪文件" : "丢弃未暂存改动"}</strong>
          <span>{pendingDestructive.paths.join("、")}</span>
          {pendingDestructive.kind === "clean" ? (
            <input
              value={strongConfirmation}
              aria-label="输入 DELETE 确认"
              placeholder="DELETE"
              onChange={(event) => setStrongConfirmation(event.currentTarget.value)}
            />
          ) : null}
          <div>
            <button
              type="button"
              disabled={destructiveActionRunning || (pendingDestructive.kind === "clean" && strongConfirmation !== "DELETE")}
              onClick={() => {
                const pending = pendingDestructive;
                setPendingDestructive(null);
                if (pending.kind === "clean") void onCleanPaths?.(pending.paths);
                else void onDiscardPaths?.(pending.paths);
              }}
            >
              确认
            </button>
            <button type="button" onClick={() => setPendingDestructive(null)}>取消</button>
          </div>
        </div>
      ) : null}
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
  const Icon = entry.submodule ? Package : entry.binary ? FileWarning : File;
  return (
    <label className={styles.row} role="treeitem" aria-label={`${entry.displayPath} ${entry.status}`}>
      <input type="checkbox" checked={selected} onChange={(event) => onSelect(event.currentTarget.checked)} />
      {entry.directory ? <Folder size={13} aria-hidden="true" /> : null}
      <Icon size={13} aria-hidden="true" />
      <span className={styles.path}>{entry.displayPath}</span>
      {entry.binary ? <small>binary</small> : null}
      {entry.submodule ? <small>submodule</small> : null}
      <span className={styles.status} data-status={entry.status}>{statusLabel(entry.status)}</span>
    </label>
  );
}

const VIRTUAL_CHANGE_ROW_HEIGHT = 29;
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
      <span className={styles.visuallyHidden} role="status">Virtualized {items.length} Git change rows</span>
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
    ignored: "I",
    conflicted: "!",
    type_changed: "T",
  })[status];
}
