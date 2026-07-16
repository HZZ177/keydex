import { ChevronDown, ChevronRight, GitBranch, GitPullRequest, MoreHorizontal, Tag } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import type { GitRef } from "@/runtime/gitTypes";

import styles from "./GitRefsTree.module.css";

export type GitRefAction = "checkout" | "create_branch" | "compare" | "rename" | "delete";

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
  const groups = useMemo(() => buildGitRefTree(refs), [refs]);
  const [collapsed, setCollapsed] = useState<Set<GitRef["kind"]>>(() => new Set(["tag"]));
  const [menuRef, setMenuRef] = useState<GitRef | null>(null);
  const head = refs.find((ref) => ref.current) ?? null;
  const [focusedKey, setFocusedKey] = useState(head ? "head" : `group:${groups[0]?.kind ?? "local"}`);
  const actionButtonRefs = useRef(new Map<string, HTMLButtonElement>());

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

  useEffect(() => {
    if (!menuRef) return;
    queueMicrotask(() => actionButtonRefs.current.get(menuRef.fullName)
      ?.parentElement?.querySelector<HTMLButtonElement>("[role=menu] [role=menuitem]")?.focus());
  }, [menuRef]);

  if (refs.length === 0) return <div className={styles.empty}>暂无 refs</div>;
  return (
    <div
      className={styles.root}
      role="tree"
      aria-label="Repository refs"
      onPointerDown={() => setMenuRef(null)}
      onKeyDown={(event) => moveGitTreeFocus(event)}
    >
      {head ? (
        <button
          type="button"
          role="treeitem"
          className={styles.head}
          aria-label={`HEAD ${head.shortName}`}
          aria-selected={selectedRef === head.fullName}
          data-tree-key="head"
          tabIndex={focusedKey === "head" ? 0 : -1}
          onFocus={() => setFocusedKey("head")}
          onClick={() => onSelect(head)}
        >
          <GitBranch size={13} />
          <strong>HEAD</strong>
          <span>{head.shortName}</span>
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
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <Icon size={13} />
              <span>{group.label}</span>
              <small>{group.refs.length}</small>
            </button>
            {!isCollapsed ? group.refs.map((ref) => (
              <div className={styles.refRow} key={ref.fullName}>
                <button
                  type="button"
                  role="treeitem"
                  className={styles.ref}
                  aria-selected={selectedRef === ref.fullName}
                  aria-current={ref.current ? "true" : undefined}
                  data-tree-key={`ref:${ref.fullName}`}
                  tabIndex={focusedKey === `ref:${ref.fullName}` ? 0 : -1}
                  onFocus={() => setFocusedKey(`ref:${ref.fullName}`)}
                  onClick={() => onSelect(ref)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onSelect(ref);
                    setMenuRef(ref);
                  }}
                >
                  <span className={styles.current}>{ref.current ? "●" : ""}</span>
                  <span title={ref.fullName}>{ref.shortName}</span>
                  {ref.ahead || ref.behind ? (
                    <small>{ref.ahead ? `↑${ref.ahead}` : ""}{ref.behind ? `↓${ref.behind}` : ""}</small>
                  ) : null}
                </button>
                <button
                  type="button"
                  className={styles.more}
                  aria-label={`${ref.shortName} actions`}
                  aria-haspopup="menu"
                  aria-expanded={menuRef?.fullName === ref.fullName}
                  ref={(element) => {
                    if (element) actionButtonRefs.current.set(ref.fullName, element);
                    else actionButtonRefs.current.delete(ref.fullName);
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    const opening = menuRef?.fullName !== ref.fullName;
                    setMenuRef(opening ? ref : null);
                  }}
                ><MoreHorizontal size={13} /></button>
                {menuRef?.fullName === ref.fullName ? (
                  <div
                    className={styles.contextMenu}
                    role="menu"
                    aria-label={`${ref.shortName} actions`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setMenuRef(null);
                        queueMicrotask(() => actionButtonRefs.current.get(ref.fullName)?.focus());
                        return;
                      }
                      if (movePopupMenuFocus(event)) event.preventDefault();
                    }}
                  >
                    {!ref.current ? <RefAction label="Checkout" action="checkout" refValue={ref} onAction={onAction} /> : null}
                    <RefAction label="New branch from here" action="create_branch" refValue={ref} onAction={onAction} />
                    <RefAction label="Compare with HEAD" action="compare" refValue={ref} onAction={onAction} />
                    {ref.kind === "local" ? <RefAction label="Rename" action="rename" refValue={ref} onAction={onAction} /> : null}
                    {!ref.current ? <RefAction label="Delete…" action="delete" refValue={ref} onAction={onAction} /> : null}
                  </div>
                ) : null}
              </div>
            )) : null}
          </div>
        );
      })}
    </div>
  );
}

function RefAction({ label, action, refValue, onAction }: {
  label: string;
  action: GitRefAction;
  refValue: GitRef;
  onAction?: (action: GitRefAction, ref: GitRef) => void;
}) {
  return <button type="button" role="menuitem" onClick={() => onAction?.(action, refValue)}>{label}</button>;
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
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[role=treeitem]"));
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

function movePopupMenuFocus(event: ReactKeyboardEvent<HTMLElement>): boolean {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return false;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[role=menuitem]:not(:disabled)"));
  if (items.length === 0) return false;
  const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
  const target = event.key === "Home"
    ? items[0]
    : event.key === "End"
      ? items[items.length - 1]
      : items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
  target.focus();
  return true;
}
