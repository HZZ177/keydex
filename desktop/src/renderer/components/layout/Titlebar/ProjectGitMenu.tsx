import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  CircleHelp,
  LoaderCircle,
  Plus,
  Search,
  Star,
  Tag,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { useOptionalActiveProjectState } from "@/renderer/providers/ActiveProjectProvider";
import {
  useOptionalGitController,
  useOptionalGitRuntime,
  useOptionalGitStoreSelector,
} from "@/renderer/providers/GitProvider";
import type { GitProjectStoreState, GitStoreState } from "@/renderer/features/git/store/gitStore";
import type { GitRef, GitRepositoryDescriptor, GitStatusSnapshot } from "@/runtime/gitTypes";
import { isConventionalMainBranch } from "@/renderer/features/git/refPresentation";
import {
  isEditableGitShortcutTarget,
  matchesGitShortcut,
  resolveGitShortcuts,
  type GitShortcutCommand,
} from "@/renderer/features/git/gitShortcuts";
import { gitOperationErrorMessage, gitUiErrorMessage } from "@/renderer/features/git/errorPresentation";

import styles from "./ProjectGitMenu.module.css";
import { GitHelpDialog } from "./GitHelpDialog";

export interface ProjectGitMenuProps {
  onOpenToolWindow: () => void;
  shortcuts?: Parameters<typeof resolveGitShortcuts>[0];
}

export interface ProjectGitMenuModel {
  enabled: boolean;
  unavailable: boolean;
  loading: boolean;
  repositoryLabel: string;
  branchLabel: string;
  dirtyCount: number;
  ahead: number;
  behind: number;
  nonRepository: boolean;
  error: string | null;
}

type GitCommandForm =
  | { kind: "branch"; startPoint: string }
  | { kind: "checkout" }
  | { kind: "rename"; ref: GitRef };

type GitRefMenuAction = "checkout" | "create_branch" | "compare" | "update" | "push" | "rename" | "manage";

interface GitRefMenuState {
  ref: GitRef;
  top: number;
  side: "left" | "right";
}

export function ProjectGitMenu({ onOpenToolWindow, shortcuts }: ProjectGitMenuProps) {
  const activeProject = useOptionalActiveProjectState();
  const snapshot = useOptionalGitStoreSelector(selectMenuSnapshot);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<GitRef["kind"]>>(() => new Set(["tag"]));
  const [commandForm, setCommandForm] = useState<GitCommandForm | null>(null);
  const [commandValue, setCommandValue] = useState("");
  const [busyAction, setBusyAction] = useState<GitQuickActionId | "checkout" | "rename" | "init" | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [refMenu, setRefMenu] = useState<GitRefMenuState | null>(null);
  const [successfulAction, setSuccessfulAction] = useState<"update" | null>(null);
  const [menuClosing, setMenuClosing] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const successHoldTimerRef = useRef<number | null>(null);
  const menuCloseTimerRef = useRef<number | null>(null);
  const controller = useOptionalGitController();
  const runtime = useOptionalGitRuntime();
  const model = useMemo(
    () => deriveProjectGitMenuModel(activeProject, snapshot),
    [activeProject, snapshot],
  );
  const resolvedShortcuts = useMemo(() => resolveGitShortcuts(shortcuts), [shortcuts]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setRefMenu(null);
    queueMicrotask(() => searchRef.current?.focus());
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);

  useEffect(() => {
    if (!model.enabled) setOpen(false);
  }, [model.enabled]);

  useEffect(() => {
    if (open) return;
    if (successHoldTimerRef.current !== null) window.clearTimeout(successHoldTimerRef.current);
    if (menuCloseTimerRef.current !== null) window.clearTimeout(menuCloseTimerRef.current);
    successHoldTimerRef.current = null;
    menuCloseTimerRef.current = null;
    setSuccessfulAction(null);
    setMenuClosing(false);
  }, [open]);

  useEffect(() => () => {
    if (successHoldTimerRef.current !== null) window.clearTimeout(successHoldTimerRef.current);
    if (menuCloseTimerRef.current !== null) window.clearTimeout(menuCloseTimerRef.current);
  }, []);

  const stateLabel = model.nonRepository
    ? "非仓库"
    : model.loading
      ? "读取中"
      : model.error
        ? "不可用"
      : model.branchLabel;
  const disabledLabel = model.unavailable
    ? "Git：系统 Git 不可用"
    : "Git：加载项目后可用";
  const visibleActions = filterGitQuickActions(projectGitQuickActions(model, resolvedShortcuts.bindings), query);

  const closeMenu = () => {
    if (successHoldTimerRef.current !== null) window.clearTimeout(successHoldTimerRef.current);
    if (menuCloseTimerRef.current !== null) window.clearTimeout(menuCloseTimerRef.current);
    successHoldTimerRef.current = null;
    menuCloseTimerRef.current = null;
    setOpen(false);
    setRefMenu(null);
    setCommandForm(null);
    setCommandValue("");
    setCommandError(null);
    setSuccessfulAction(null);
    setMenuClosing(false);
  };

  const showSuccessfulUpdateAndClose = () => {
    setSuccessfulAction("update");
    successHoldTimerRef.current = window.setTimeout(() => {
      setMenuClosing(true);
      menuCloseTimerRef.current = window.setTimeout(closeMenu, 150);
    }, 1_000);
  };

  const runRemoteAction = async (action: "update" | "push") => {
    const commandScope = commandScopeFromSnapshot(snapshot);
    if (!controller || !runtime || !commandScope || !snapshot) return;
    setBusyAction(action);
    setCommandError(null);
    try {
      const upstream = snapshot?.status?.branch.upstream ?? null;
      const separator = upstream?.indexOf("/") ?? -1;
      if (!upstream || separator <= 0 || separator === upstream.length - 1) {
        throw new Error(`当前分支没有可用的上游，请先在 Git 面板设置后再${action === "update" ? "更新" : "推送"}。`);
      }
      const remote = upstream.slice(0, separator);
      const branch = upstream.slice(separator + 1);
      const base = {
        ...commandScope,
        idempotencyKey: createGitIdempotencyKey(action),
        expectedRepositoryVersion: snapshot?.status?.repositoryVersion ?? null,
        remote,
      };
      const operation = await controller.runCommand(() => action === "update"
        ? runtime.update({
            ...base,
            refspec: branch,
            strategy: snapshot.ui?.updateStrategyByRepository[commandScope.repositoryId] ?? "ff_only",
          })
        : runtime.push({
            ...base,
            source: snapshot.status?.branch.head ?? branch,
            target: branch,
          }));
      if (operation.state === "failed") {
        throw new Error(gitOperationErrorMessage(operation));
      }
      if (action === "update") showSuccessfulUpdateAndClose();
      else closeMenu();
    } catch (error) {
      setCommandError(gitUiErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  const initializeRepository = async () => {
    if (!activeProject || activeProject.status === "none" || !runtime || !controller) return;
    const scope = { workspaceId: activeProject.workspaceId, projectRoot: activeProject.projectPath };
    setBusyAction("init");
    setCommandError(null);
    try {
      await runtime.initialize(scope);
      await controller.activateProject(scope);
      closeMenu();
    } catch (error) {
      setCommandError(gitUiErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  const runRefCheckout = async (ref: string, detach = false) => {
    const commandScope = commandScopeFromSnapshot(snapshot);
    if (!controller || !runtime || !commandScope || !ref.trim()) return;
    setBusyAction("checkout");
    setCommandError(null);
    try {
      const operation = await controller.runCommand(() => runtime.checkout({
        ...commandScope,
        idempotencyKey: createGitIdempotencyKey("checkout"),
        expectedRepositoryVersion: snapshot?.status?.repositoryVersion ?? null,
        ref: ref.trim(),
        detach,
      }));
      if (operation.state === "failed") throw new Error(gitOperationErrorMessage(operation));
      closeMenu();
    } catch (error) {
      setCommandError(gitUiErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  const runCreateBranch = async (startPoint = "HEAD") => {
    const commandScope = commandScopeFromSnapshot(snapshot);
    if (!controller || !runtime || !commandScope || !commandValue.trim()) return;
    setBusyAction("create_branch");
    setCommandError(null);
    try {
      const operation = await controller.runCommand(() => runtime.createBranch({
        ...commandScope,
        idempotencyKey: createGitIdempotencyKey("create-branch"),
        expectedRepositoryVersion: snapshot?.status?.repositoryVersion ?? null,
        branchName: commandValue.trim(),
        startPoint,
      }));
      if (operation.state === "failed") throw new Error(gitOperationErrorMessage(operation));
      closeMenu();
    } catch (error) {
      setCommandError(gitUiErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  const runRenameBranch = async (ref: GitRef) => {
    const commandScope = commandScopeFromSnapshot(snapshot);
    if (!controller || !runtime || !commandScope || !commandValue.trim() || ref.kind !== "local") return;
    setBusyAction("rename");
    setCommandError(null);
    try {
      const operation = await controller.runCommand(() => runtime.renameBranch({
        ...commandScope,
        idempotencyKey: createGitIdempotencyKey("rename-branch"),
        expectedRepositoryVersion: snapshot?.status?.repositoryVersion ?? null,
        oldName: ref.shortName,
        newName: commandValue.trim(),
      }));
      if (operation.state === "failed") throw new Error(gitOperationErrorMessage(operation));
      closeMenu();
    } catch (error) {
      setCommandError(gitUiErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  const openRefMenu = (ref: GitRef, event: ReactMouseEvent<HTMLButtonElement>) => {
    const menu = rootRef.current?.querySelector<HTMLElement>(`.${styles.menu}`);
    if (!menu) return;
    const menuBounds = menu.getBoundingClientRect();
    const rowBounds = event.currentTarget.getBoundingClientRect();
    const submenuHeight = 236;
    const top = Math.max(6, Math.min(rowBounds.top - menuBounds.top, window.innerHeight - menuBounds.top - submenuHeight - 8));
    const side = menuBounds.right + 264 <= window.innerWidth - 8 ? "right" : "left";
    setRefMenu((current) => current?.ref.fullName === ref.fullName ? null : { ref, top, side });
  };

  const activateRefMenuAction = (action: GitRefMenuAction, ref: GitRef) => {
    setRefMenu(null);
    if (action === "checkout") {
      void runRefCheckout(ref.shortName, ref.kind !== "local");
      return;
    }
    if (action === "create_branch") {
      setCommandForm({ kind: "branch", startPoint: ref.shortName });
      setCommandValue("");
      setCommandError(null);
      return;
    }
    if (action === "rename" && ref.kind === "local") {
      setCommandForm({ kind: "rename", ref });
      setCommandValue(ref.shortName);
      setCommandError(null);
      return;
    }
    if (action === "update" || action === "push") {
      void runRemoteAction(action);
      return;
    }
    closeMenu();
    onOpenToolWindow();
  };

  const activateQuickAction = (action: GitQuickAction) => {
    if (!action.enabled || busyAction) return;
    if (action.id === "open" || action.id === "commit") {
      closeMenu();
      onOpenToolWindow();
      return;
    }
    if (action.id === "help") {
      closeMenu();
      setHelpOpen(true);
      return;
    }
    if (action.id === "create_branch" || action.id === "checkout") {
      setOpen(true);
      setCommandForm(action.id === "create_branch" ? { kind: "branch", startPoint: "HEAD" } : { kind: "checkout" });
      setCommandValue("");
      setCommandError(null);
      return;
    }
    void runRemoteAction(action.id);
  };

  useEffect(() => {
    if (!model.enabled) return;
    const conflictingCommands = new Set(resolvedShortcuts.conflicts.flatMap((conflict) => conflict.commands));
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableGitShortcutTarget(event.target)) return;
      const command = (Object.keys(resolvedShortcuts.bindings) as GitShortcutCommand[]).find((candidate) =>
        !conflictingCommands.has(candidate) && matchesGitShortcut(event, resolvedShortcuts.bindings[candidate]),
      );
      if (!command) return;
      const action = projectGitQuickActions(model, resolvedShortcuts.bindings).find((candidate) => candidate.id === command);
      if (!action?.enabled) return;
      event.preventDefault();
      activateQuickAction(action);
    };
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [busyAction, model, resolvedShortcuts, runtime]);

  return (
    <div className={styles.root} ref={rootRef} data-titlebar-interactive="true">
      <button
        type="button"
        ref={triggerRef}
        className={styles.trigger}
        disabled={!model.enabled}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={model.enabled ? `Git：${stateLabel}` : disabledLabel}
        onClick={() => {
          if (open) closeMenu();
          else setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
          queueMicrotask(() => searchRef.current?.focus());
        }}
      >
        <GitBranch size={14} />
        <span className={styles.branch}>{stateLabel}</span>
        {model.ahead > 0 || model.behind > 0 ? (
          <span className={styles.sync} aria-label={`领先 ${model.ahead}，落后 ${model.behind}`}>
            {model.ahead > 0 ? `↑${model.ahead}` : ""}{model.behind > 0 ? `↓${model.behind}` : ""}
          </span>
        ) : null}
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {open ? (
        <div
          className={styles.menu}
          data-state={menuClosing ? "closing" : successfulAction ? "success" : "open"}
          role="menu"
          aria-label="项目 Git 菜单"
          onKeyDown={(event) => {
            if (moveMenuFocus(event.currentTarget, event.key)) event.preventDefault();
          }}
        >
          <label className={styles.search}>
            <Search size={13} aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              aria-label="搜索 Git 分支和操作"
              placeholder="搜索分支和操作"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          {model.nonRepository ? (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              disabled={Boolean(busyAction)}
              onClick={() => void initializeRepository()}
            >
              <GitCommitHorizontal size={14} />
              <span>{busyAction === "init" ? "正在初始化…" : "初始化 Git 仓库…"}</span>
            </button>
          ) : null}
          <div className={styles.actions} role="group" aria-label="Git 快捷操作">
            {visibleActions.map((action) => {
              const Icon = action.icon;
              const isBusy = busyAction === action.id;
              const isSuccessful = successfulAction === action.id;
              return (
                <button
                  type="button"
                  role="menuitem"
                  className={styles.item}
                  data-risk={action.risk}
                  aria-busy={isBusy || undefined}
                  disabled={!action.enabled || Boolean(busyAction) || Boolean(successfulAction) || menuClosing}
                  key={action.id}
                  onClick={() => activateQuickAction(action)}
                >
                  {isSuccessful ? (
                    <Check className={styles.successIcon} size={14} aria-hidden="true" />
                  ) : isBusy ? (
                    <LoaderCircle className={styles.busyIcon} size={14} aria-hidden="true" />
                  ) : (
                    <Icon size={14} />
                  )}
                  <span>{action.label}</span>
                  {action.shortcut ? <kbd>{action.shortcut}</kbd> : null}
                </button>
              );
            })}
          </div>
          {commandForm ? (
            <form
              className={styles.commandForm}
              onSubmit={(event) => {
                event.preventDefault();
                if (commandForm.kind === "branch") void runCreateBranch(commandForm.startPoint);
                else if (commandForm.kind === "rename") void runRenameBranch(commandForm.ref);
                else void runRefCheckout(commandValue);
              }}
            >
              <input
                value={commandValue}
                aria-label={commandForm.kind === "branch" ? "新分支名称" : commandForm.kind === "rename" ? "重命名分支" : "标记或修订"}
                placeholder={commandForm.kind === "branch" ? "功能/名称" : commandForm.kind === "rename" ? "新分支名称" : "标签、分支或提交"}
                onChange={(event) => setCommandValue(event.currentTarget.value)}
                autoFocus
              />
              <button type="submit" disabled={!commandValue.trim() || Boolean(busyAction)}>确定</button>
              <button type="button" onClick={() => setCommandForm(null)}>取消</button>
            </form>
          ) : null}
          {commandError ? <div className={styles.commandError} role="alert">{commandError}</div> : null}
          {resolvedShortcuts.conflicts.length > 0 ? (
            <div className={styles.shortcutConflict} role="status">
              快捷键冲突：{resolvedShortcuts.conflicts.map((conflict) => conflict.commands.join(" / ")).join("；")}
            </div>
          ) : null}
          {!model.nonRepository ? (
            <GitRefTree
              refs={filterGitMenuRefs(snapshot?.refs ?? [], query)}
              collapsed={collapsedGroups}
              currentUpstream={snapshot?.status?.branch.upstream ?? null}
              activeMenuRef={refMenu?.ref.fullName ?? null}
              onToggle={(kind) => setCollapsedGroups((current) => toggleCollapsedGroup(current, kind))}
              onOpenMenu={openRefMenu}
            />
          ) : null}
          {refMenu ? (
            <GitRefActionsMenu
              refValue={refMenu.ref}
              currentBranch={snapshot?.status?.branch.head ?? null}
              side={refMenu.side}
              top={refMenu.top}
              onAction={activateRefMenuAction}
            />
          ) : null}
          {!model.nonRepository && !model.loading && !model.error ? (
            <div className={styles.metrics}>
              <GitPullRequest size={13} />
              <span>{model.dirtyCount > 0 ? `${model.dirtyCount} 个本地改动` : "工作区干净"}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      {helpOpen ? <GitHelpDialog onClose={() => setHelpOpen(false)} /> : null}
    </div>
  );
}

interface MenuSnapshot {
  project: GitProjectStoreState | null;
  repository: GitRepositoryDescriptor | null;
  status: GitStatusSnapshot | null;
  refs: readonly GitRef[];
  ui: GitStoreState["uiByProject"][string] | null;
}

export type GitQuickActionId = "update" | "commit" | "push" | "create_branch" | "checkout" | "open" | "help";

export interface GitQuickAction {
  id: GitQuickActionId;
  label: string;
  shortcut: string | null;
  risk: "read" | "write" | "remote";
  enabled: boolean;
  icon: typeof GitBranch;
}

export function projectGitQuickActions(
  model: ProjectGitMenuModel,
  shortcuts = resolveGitShortcuts().bindings,
): readonly GitQuickAction[] {
  const repositoryReady = model.enabled && !model.loading && !model.nonRepository && !model.error;
  return [
    { id: "update", label: "更新项目…", shortcut: shortcuts.update.label, risk: "remote", enabled: repositoryReady, icon: ArrowDownLeft },
    { id: "commit", label: "提交…", shortcut: shortcuts.commit.label, risk: "write", enabled: repositoryReady && model.dirtyCount > 0, icon: GitCommitHorizontal },
    { id: "push", label: "推送…", shortcut: shortcuts.push.label, risk: "remote", enabled: repositoryReady, icon: ArrowUpRight },
    { id: "create_branch", label: "新建分支…", shortcut: shortcuts.create_branch.label, risk: "write", enabled: repositoryReady, icon: Plus },
    { id: "checkout", label: "签出标记或修订…", shortcut: null, risk: "write", enabled: repositoryReady, icon: GitBranch },
    { id: "open", label: "打开 Git 面板", shortcut: null, risk: "read", enabled: model.enabled, icon: Wrench },
    { id: "help", label: "Git 帮助与风险说明", shortcut: null, risk: "read", enabled: model.enabled, icon: CircleHelp },
  ];
}

export function filterGitQuickActions(actions: readonly GitQuickAction[], query: string): readonly GitQuickAction[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return actions;
  return actions.filter((action) => action.label.toLocaleLowerCase().includes(normalized));
}

function selectMenuSnapshot(state: GitStoreState): MenuSnapshot {
  const project = state.activeWorkspaceId ? state.projects[state.activeWorkspaceId] ?? null : null;
  const repository = project?.selectedRepositoryId ? state.repositories[project.selectedRepositoryId] ?? null : null;
  const status = repository ? state.statusByRepository[repository.id] ?? null : null;
  const refs = repository ? state.refsByRepository[repository.id] ?? [] : [];
  const ui = project ? state.uiByProject[project.workspaceId] ?? null : null;
  return { project, repository, status, refs, ui };
}

const REF_GROUPS: readonly { kind: GitRef["kind"]; label: string; icon: typeof GitBranch }[] = [
  { kind: "local", label: "本地", icon: GitBranch },
  { kind: "remote", label: "远程", icon: GitPullRequest },
  { kind: "tag", label: "标签", icon: Tag },
];

function GitRefTree({
  refs,
  collapsed,
  currentUpstream,
  activeMenuRef,
  onToggle,
  onOpenMenu,
}: {
  refs: readonly GitRef[];
  collapsed: ReadonlySet<GitRef["kind"]>;
  currentUpstream: string | null;
  activeMenuRef: string | null;
  onToggle: (kind: GitRef["kind"]) => void;
  onOpenMenu: (ref: GitRef, event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  if (refs.length === 0) return null;
  return (
    <div className={styles.refTree} role="tree" aria-label="Git 引用">
      {REF_GROUPS.map(({ kind, label, icon: Icon }) => {
        const groupRefs = refs
          .filter((ref) => ref.kind === kind)
          .sort((left, right) => Number(right.current) - Number(left.current)
            || left.shortName.localeCompare(right.shortName));
        if (groupRefs.length === 0) return null;
        const isCollapsed = collapsed.has(kind);
        return (
          <div className={styles.refGroup} key={kind} role="group" aria-label={label}>
            <button
              type="button"
              role="treeitem"
              aria-expanded={!isCollapsed}
              className={styles.groupHeader}
              onClick={() => onToggle(kind)}
            >
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <Icon size={13} />
              <span>{label}</span>
              <span className={styles.groupCount}>{groupRefs.length}</span>
            </button>
            {!isCollapsed ? (
              <div className={styles.refItems}>
                {groupRefs.map((ref) => (
                  <button
                    type="button"
                    role="treeitem"
                    aria-current={ref.current ? "true" : undefined}
                    aria-label={`${ref.shortName}（${label}）`}
                    aria-haspopup="menu"
                    aria-expanded={activeMenuRef === ref.fullName}
                    className={styles.refItem}
                    key={ref.fullName}
                    data-ref-kind={ref.kind}
                    data-ref-state={ref.current ? "current" : currentUpstream === ref.shortName ? "upstream" : "normal"}
                    onClick={(event) => onOpenMenu(ref, event)}
                  >
                    <GitRefIcon refValue={ref} currentUpstream={currentUpstream} />
                    <span className={styles.refName}>{ref.shortName}</span>
                    {ref.kind === "local" && ref.upstream ? (
                      <span className={styles.refUpstream}>{ref.upstream}</span>
                    ) : null}
                    {ref.ahead || ref.behind ? (
                      <small>{ref.ahead ? `↗ ${ref.ahead}` : ""}{ref.behind ? `↙ ${ref.behind}` : ""}</small>
                    ) : null}
                    <ChevronRight className={styles.refChevron} size={12} aria-hidden="true" />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function GitRefIcon({ refValue, currentUpstream }: { refValue: GitRef; currentUpstream: string | null }) {
  if (isConventionalMainBranch(refValue)) {
    return (
      <span className={styles.refIcon} data-tone="mainline" aria-hidden="true">
        <Star size={14} fill="currentColor" />
      </span>
    );
  }
  if (refValue.current) {
    return (
      <span className={styles.refIcon} data-tone="current" aria-hidden="true">
        <Tag size={14} />
      </span>
    );
  }
  if (refValue.kind === "remote" && currentUpstream === refValue.shortName) {
    return (
      <span className={styles.refIcon} data-tone="upstream" aria-hidden="true">
        <Star size={14} fill="currentColor" />
      </span>
    );
  }
  if (refValue.kind === "tag") {
    return (
      <span className={styles.refIcon} data-tone="tag" aria-hidden="true">
        <Tag size={14} />
      </span>
    );
  }
  return (
    <span className={styles.refIcon} data-tone={refValue.kind} aria-hidden="true">
      <GitBranch size={14} />
    </span>
  );
}

function GitRefActionsMenu({
  refValue,
  currentBranch,
  side,
  top,
  onAction,
}: {
  refValue: GitRef;
  currentBranch: string | null;
  side: "left" | "right";
  top: number;
  onAction: (action: GitRefMenuAction, ref: GitRef) => void;
}) {
  const name = refValue.shortName;
  const isCurrent = refValue.kind === "local" && refValue.current;
  const checkoutLabel = refValue.kind === "local"
    ? `签出 '${name}'`
    : refValue.kind === "remote"
      ? `签出 '${name}'（分离当前指针）`
      : `签出标记 '${name}'（分离当前指针）`;
  const compareLabel = currentBranch
    ? `与 '${currentBranch}' 比较`
    : "与当前指针比较";

  return (
    <div
      className={styles.refSubmenu}
      data-side={side}
      role="menu"
      aria-label={`${name} 引用操作`}
      style={{ top }}
    >
      {!isCurrent ? (
        <RefSubmenuItem label={checkoutLabel} action="checkout" refValue={refValue} onAction={onAction} />
      ) : null}
      <RefSubmenuItem label={`从 '${name}' 新建分支…`} action="create_branch" refValue={refValue} onAction={onAction} />
      <div className={styles.submenuSeparator} role="separator" />
      {!isCurrent ? (
        <RefSubmenuItem label={compareLabel} action="compare" refValue={refValue} onAction={onAction} />
      ) : null}
      <RefSubmenuItem label="显示与工作树的差异" action="compare" refValue={refValue} onAction={onAction} />
      {isCurrent ? (
        <>
          <div className={styles.submenuSeparator} role="separator" />
          <RefSubmenuItem label="更新" action="update" refValue={refValue} onAction={onAction} />
          <RefSubmenuItem label="推送…" action="push" refValue={refValue} onAction={onAction} />
          <div className={styles.submenuSeparator} role="separator" />
          <RefSubmenuItem label="重命名…" action="rename" refValue={refValue} onAction={onAction} />
        </>
      ) : (
        <>
          <div className={styles.submenuSeparator} role="separator" />
          <RefSubmenuItem
            label={refValue.kind === "tag" ? "在 Git 面板中管理标签…" : "在 Git 面板中合并或变基…"}
            action="manage"
            refValue={refValue}
            onAction={onAction}
          />
          {refValue.kind === "local" ? (
            <RefSubmenuItem label="重命名…" action="rename" refValue={refValue} onAction={onAction} />
          ) : null}
        </>
      )}
    </div>
  );
}

function RefSubmenuItem({
  label,
  action,
  refValue,
  onAction,
}: {
  label: string;
  action: GitRefMenuAction;
  refValue: GitRef;
  onAction: (action: GitRefMenuAction, ref: GitRef) => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={styles.refSubmenuItem}
      onClick={() => onAction(action, refValue)}
    >
      {label}
    </button>
  );
}

function commandScopeFromSnapshot(snapshot: MenuSnapshot | null) {
  if (!snapshot?.project || !snapshot.repository) return null;
  return {
    workspaceId: snapshot.project.workspaceId,
    projectRoot: snapshot.project.projectRoot,
    repositoryId: snapshot.repository.id,
  };
}

let idempotencySequence = 0;
function createGitIdempotencyKey(action: string): string {
  idempotencySequence += 1;
  return `titlebar-${action}-${Date.now()}-${idempotencySequence}`;
}

export function filterGitMenuRefs(refs: readonly GitRef[], query: string): readonly GitRef[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return refs;
  return refs
    .filter((ref) => `${ref.shortName}\n${ref.fullName}`.toLocaleLowerCase().includes(normalized))
    .sort((left, right) => refSearchRank(left, normalized) - refSearchRank(right, normalized)
      || left.shortName.localeCompare(right.shortName));
}

function refSearchRank(ref: GitRef, query: string): number {
  const shortName = ref.shortName.toLocaleLowerCase();
  if (shortName === query) return 0;
  if (shortName.startsWith(query)) return 1;
  return 2;
}

function toggleCollapsedGroup(
  current: ReadonlySet<GitRef["kind"]>,
  kind: GitRef["kind"],
): Set<GitRef["kind"]> {
  const next = new Set(current);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  return next;
}

function moveMenuFocus(menu: HTMLElement, key: string): boolean {
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return false;
  const items = Array.from(menu.querySelectorAll<HTMLElement>("input, button:not(:disabled)"));
  if (items.length === 0) return false;
  const current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
  const target = key === "Home"
    ? 0
    : key === "End"
      ? items.length - 1
      : (current + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[target]?.focus();
  return true;
}

export function deriveProjectGitMenuModel(
  activeProject: ReturnType<typeof useOptionalActiveProjectState>,
  snapshot: MenuSnapshot | null,
): ProjectGitMenuModel {
  if (!activeProject || activeProject.status === "none") {
    return {
      enabled: false,
      unavailable: false,
      loading: false,
      repositoryLabel: "Git",
      branchLabel: "Git",
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
      nonRepository: false,
      error: null,
    };
  }
  const project = snapshot?.project;
  const status = snapshot?.status;
  const repositoryLabel = snapshot?.repository?.displayPath || activeProject.name;
  const error = project?.error?.message ?? (activeProject.status === "error" ? activeProject.message : null);
  const loading = Boolean(project?.loading || activeProject.status === "loading" || (!project && !error));
  const unavailable = project?.capability?.available === false;
  const nonRepository = Boolean(project && !project.loading && !project.error && project.repositoryIds.length === 0);
  const branchLabel = status?.branch.head
    ?? (status?.branch.detachedAt ? `分离@${status.branch.detachedAt.slice(0, 7)}` : "Git");
  return {
    enabled: !unavailable,
    unavailable,
    loading,
    repositoryLabel,
    branchLabel,
    dirtyCount: status?.files.length ?? 0,
    ahead: status?.branch.ahead ?? 0,
    behind: status?.branch.behind ?? 0,
    nonRepository,
    error,
  };
}
