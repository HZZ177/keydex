import {
  ChevronRight,
  GitBranch,
  GitCompareArrows,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Star,
  Tag,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { isConventionalMainBranch } from "@/renderer/features/git/refPresentation";
import {
  type AppContextMenuItem,
  useOptionalAppContextMenu,
} from "@/renderer/providers/AppContextMenuProvider";
import type { GitRef } from "@/runtime/gitTypes";

import { GitDivergenceIndicator } from "./GitDivergenceIndicator";
import styles from "./GitRefsTree.module.css";

export type GitRefAction =
  | "checkout"
  | "checkout_rebase"
  | "create_branch"
  | "compare_refs"
  | "compare_worktree"
  | "rebase_current"
  | "merge_current"
  | "update"
  | "push"
  | "rename"
  | "delete";

export interface GitRefGroupModel {
  kind: GitRef["kind"];
  label: string;
  refs: readonly GitRef[];
}

export interface GitRefsTreeProps {
  refs: readonly GitRef[];
  selectedRef: string | null;
  onSelect: (ref: GitRef) => void;
  onAction?: (action: GitRefAction, ref: GitRef) => void;
}

const GROUPS: readonly { kind: GitRef["kind"]; label: string; icon: typeof GitBranch }[] = [
  { kind: "local", label: "本地", icon: GitBranch },
  { kind: "remote", label: "远程", icon: GitPullRequest },
  { kind: "tag", label: "标签", icon: Tag },
];

export function GitRefsTree({ refs, selectedRef, onSelect, onAction }: GitRefsTreeProps) {
  const [query, setQuery] = useState("");
  const visibleRefs = useMemo(() => filterGitRefs(refs, query), [query, refs]);
  const groups = useMemo(() => buildGitRefTree(visibleRefs), [visibleRefs]);
  const [collapsed, setCollapsed] = useState<Set<GitRef["kind"]>>(() => new Set(["tag"]));
  const currentRef = refs.find((ref) => ref.current) ?? null;
  const head = visibleRefs.find((ref) => ref.current) ?? null;
  const currentUpstream = currentRef?.upstream ?? null;
  const [focusedKey, setFocusedKey] = useState(head ? "head" : `group:${groups[0]?.kind ?? "local"}`);
  const appContextMenu = useOptionalAppContextMenu();

  useEffect(() => {
    const available = new Set([
      ...(head ? ["head"] : []),
      ...groups.flatMap((group) => [
        `group:${group.kind}`,
        ...(!collapsed.has(group.kind) ? group.refs.map((ref) => `ref:${ref.fullName}`) : []),
      ]),
    ]);
    if (!available.has(focusedKey)) setFocusedKey(available.values().next().value ?? "");
  }, [collapsed, focusedKey, groups, head]);

  const openRefContextMenu = (ref: GitRef, target: HTMLButtonElement, x: number, y: number) => {
    onSelect(ref);
    appContextMenu?.openContextMenu({
      items: buildGitRefContextMenuItems(ref, currentRef, onAction),
      target,
      x,
      y,
    });
  };

  const openKeyboardContextMenu = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    ref: GitRef,
  ) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    openRefContextMenu(ref, event.currentTarget, bounds.left + 18, bounds.bottom + 4);
  };

  return (
    <div className={styles.root}>
      <label className={styles.searchField}>
        <Search size={13} aria-hidden="true" />
        <input
          aria-label="筛选分支"
          placeholder="筛选分支"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <div className={styles.scroller}>
        {visibleRefs.length === 0 ? (
          <div className={styles.empty}>{refs.length === 0 ? "暂无引用" : "没有匹配的分支"}</div>
        ) : (
          <div
            className={styles.tree}
            role="tree"
            aria-label="仓库引用"
            onKeyDown={(event) => {
              if (moveGitTreeFocus(event)) event.preventDefault();
            }}
          >
            {head ? (
              <button
                type="button"
                role="treeitem"
                className={styles.head}
                aria-label={`当前分支 ${head.shortName}`}
                aria-selected={selectedRef === head.fullName}
                aria-haspopup="menu"
                data-app-context-menu="local"
                data-tree-key="head"
                tabIndex={focusedKey === "head" ? 0 : -1}
                onFocus={() => setFocusedKey("head")}
                onClick={() => onSelect(head)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openRefContextMenu(head, event.currentTarget, event.clientX, event.clientY);
                }}
                onKeyDown={(event) => openKeyboardContextMenu(event, head)}
              >
                <GitRefIcon refValue={head} currentUpstream={currentUpstream} />
                <strong>当前</strong>
                <span className={styles.headName}>{head.shortName}</span>
              </button>
            ) : null}
            {groups.map((group) => {
              const definition = GROUPS.find((candidate) => candidate.kind === group.kind)!;
              const Icon = definition.icon;
              const isCollapsed = collapsed.has(group.kind);
              return (
                <div className={styles.group} role="group" aria-label={group.label} key={group.kind}>
                  <button
                    type="button"
                    role="treeitem"
                    className={styles.groupHeader}
                    aria-expanded={!isCollapsed}
                    data-tree-key={`group:${group.kind}`}
                    tabIndex={focusedKey === `group:${group.kind}` ? 0 : -1}
                    onFocus={() => setFocusedKey(`group:${group.kind}`)}
                    onClick={() => setCollapsed((current) => toggle(current, group.kind))}
                  >
                    <ChevronRight
                      className={styles.groupChevron}
                      data-expanded={!isCollapsed ? "true" : "false"}
                      size={12}
                    />
                    <Icon size={13} />
                    <span>{group.label}</span>
                    <small>{group.refs.length}</small>
                  </button>
                  <div
                    className={styles.refItems}
                    data-ref-items={group.kind}
                    data-expanded={!isCollapsed ? "true" : "false"}
                    aria-hidden={isCollapsed ? "true" : undefined}
                  >
                    <div className={styles.refItemsInner}>
                      {group.refs.map((ref) => (
                        <div className={styles.refRow} key={ref.fullName}>
                          <button
                            type="button"
                            role="treeitem"
                            className={styles.ref}
                            aria-label={ref.shortName}
                            aria-selected={selectedRef === ref.fullName}
                            aria-current={ref.current ? "true" : undefined}
                            aria-haspopup="menu"
                            data-app-context-menu="local"
                            data-tree-key={`ref:${ref.fullName}`}
                            tabIndex={!isCollapsed && focusedKey === `ref:${ref.fullName}` ? 0 : -1}
                            onFocus={() => setFocusedKey(`ref:${ref.fullName}`)}
                            onClick={() => onSelect(ref)}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              openRefContextMenu(ref, event.currentTarget, event.clientX, event.clientY);
                            }}
                            onKeyDown={(event) => openKeyboardContextMenu(event, ref)}
                          >
                            <GitRefIcon refValue={ref} currentUpstream={currentUpstream} />
                            <span className={styles.refName} title={ref.fullName}>{ref.shortName}</span>
                            <GitDivergenceIndicator ahead={ref.ahead} behind={ref.behind} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function filterGitRefs(refs: readonly GitRef[], query: string): readonly GitRef[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return refs;
  return refs.filter((ref) =>
    ref.shortName.toLocaleLowerCase().includes(normalized)
    || ref.fullName.toLocaleLowerCase().includes(normalized));
}

function GitRefIcon({ refValue, currentUpstream }: { refValue: GitRef; currentUpstream: string | null }) {
  if (isConventionalMainBranch(refValue)) {
    return <span className={styles.refIcon} data-tone="mainline" aria-hidden="true"><Star size={14} fill="currentColor" /></span>;
  }
  if (refValue.current) {
    return <span className={styles.refIcon} data-tone="current" aria-hidden="true"><Tag size={14} /></span>;
  }
  if (refValue.kind === "remote" && currentUpstream === refValue.shortName) {
    return <span className={styles.refIcon} data-tone="upstream" aria-hidden="true"><Star size={14} fill="currentColor" /></span>;
  }
  if (refValue.kind === "tag") {
    return <span className={styles.refIcon} data-tone="tag" aria-hidden="true"><Tag size={14} /></span>;
  }
  return <span className={styles.refIcon} data-tone={refValue.kind} aria-hidden="true"><GitBranch size={14} /></span>;
}

export function buildGitRefContextMenuItems(
  ref: GitRef,
  currentRef: GitRef | null,
  onAction?: (action: GitRefAction, ref: GitRef) => void,
): AppContextMenuItem[] {
  const item = (
    action: GitRefAction,
    label: string,
    icon: AppContextMenuItem["icon"],
    options: Pick<AppContextMenuItem, "disabled" | "separatorBefore"> = {},
  ): AppContextMenuItem => ({
    action: () => onAction?.(action, ref),
    icon,
    id: `git-ref-${action}-${ref.fullName}`,
    label,
    ...options,
  });

  const currentName = currentRef?.shortName ?? "当前分支";
  const local = ref.kind === "local";
  return [
    ...(!ref.current ? [item("checkout", "签出", GitBranch)] : []),
    item("create_branch", `从 '${ref.shortName}' 新建分支…`, Plus),
    ...(!ref.current && local ? [item("checkout_rebase", `签出并变基到 '${currentName}'`, GitPullRequestArrow)] : []),
    ...(!ref.current ? [item("compare_refs", `与 '${currentName}' 比较`, GitCompareArrows, { separatorBefore: true })] : []),
    item("compare_worktree", "显示与工作树的差异", GitCompareArrows, { separatorBefore: ref.current }),
    ...(!ref.current && local ? [
      item("rebase_current", `将 '${currentName}' 变基到 '${ref.shortName}'`, GitPullRequestArrow, { separatorBefore: true }),
      item("merge_current", `将 '${ref.shortName}' 合并到 '${currentName}' 中`, GitMerge),
    ] : []),
    ...(local ? [
      item("update", "更新", RefreshCw, { separatorBefore: true }),
      item("push", "推送…", Upload),
      item("rename", "重命名…", Pencil, { separatorBefore: true }),
    ] : []),
    ...(!ref.current && ref.kind !== "tag" ? [item("delete", "删除", Trash2)] : []),
  ];
}

export function buildGitRefTree(refs: readonly GitRef[]): readonly GitRefGroupModel[] {
  return GROUPS.map(({ kind, label }) => ({
    kind,
    label,
    refs: refs
      .filter((ref) => ref.kind === kind)
      .sort((left, right) => Number(right.current) - Number(left.current)
        || left.shortName.localeCompare(right.shortName)),
  })).filter((group) => group.refs.length > 0);
}

function toggle(current: ReadonlySet<GitRef["kind"]>, kind: GitRef["kind"]): Set<GitRef["kind"]> {
  const next = new Set(current);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  return next;
}

function moveGitTreeFocus(event: ReactKeyboardEvent<HTMLDivElement>): boolean {
  const active = event.target instanceof HTMLButtonElement && event.target.getAttribute("role") === "treeitem"
    ? event.target
    : null;
  if (!active) return false;
  if (event.key === "ArrowRight" && active.getAttribute("aria-expanded") === "false") {
    active.click();
    return true;
  }
  if (event.key === "ArrowLeft" && active.getAttribute("aria-expanded") === "true") {
    active.click();
    return true;
  }
  if (event.key === "ArrowLeft") {
    const group = active.closest<HTMLElement>("[role=group]");
    const header = group?.querySelector<HTMLButtonElement>("button[role=treeitem]");
    if (header && header !== active) {
      header.focus();
      return true;
    }
  }
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[role=treeitem]"))
    .filter((item) => !item.closest('[aria-hidden="true"]'));
  const current = items.indexOf(active);
  if (current < 0) return false;
  const target = event.key === "Home"
    ? items[0]
    : event.key === "End"
      ? items[items.length - 1]
      : event.key === "ArrowDown"
        ? items[(current + 1) % items.length]
        : event.key === "ArrowUp"
          ? items[(current - 1 + items.length) % items.length]
          : event.key === "ArrowRight" && active.getAttribute("aria-expanded") === "true"
            ? items[current + 1]
            : null;
  target?.focus();
  return Boolean(target);
}
