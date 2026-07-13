import { AlertCircle, Check, ChevronDown, ChevronRight, Folder, FolderPlus, Keyboard, MessageCircle, Search } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Workspace } from "@/types/protocol";

import styles from "./WorkspaceSelector.module.css";

export type WorkspaceSelection =
  | { type: "chat" }
  | { type: "workspace"; workspace: Workspace }
  | { type: "pending"; rootPath: string; name: string };

export interface WorkspaceSelectorProps {
  value: WorkspaceSelection;
  workspaces: Workspace[];
  disabled?: boolean;
  readOnly?: boolean;
  loading?: boolean;
  placement?: "top" | "bottom";
  variant?: "default" | "sidebar" | "titlebar";
  allowProjectFreeChat?: boolean;
  onSelectChat?: () => void;
  onSelectWorkspace?: (workspace: Workspace) => void;
  onAddWorkspace?: (path: string) => Promise<void> | void;
  onPickWorkspacePath?: () => Promise<string | null>;
}

type WorkspaceMenuOption = { type: "workspace"; key: string; workspace: Workspace } | { type: "chat"; key: string };

const chatOptionKey = "chat";
const MENU_EXIT_ANIMATION_MS = 120;
const MENU_OFFSET_PX = 8;
const VIEWPORT_EDGE_GAP_PX = 12;

export function WorkspaceSelector({
  value,
  workspaces,
  disabled = false,
  readOnly = false,
  loading = false,
  placement = "bottom",
  variant = "default",
  allowProjectFreeChat = true,
  onSelectChat,
  onSelectWorkspace,
  onAddWorkspace,
  onPickWorkspacePath,
}: WorkspaceSelectorProps) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const addMenuCloseTimerRef = useRef<number | null>(null);
  const menuCloseTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [menuClosing, setMenuClosing] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [manualPathOpen, setManualPathOpen] = useState(false);
  const [manualPath, setManualPath] = useState("");
  const [query, setQuery] = useState("");
  const [activeOptionIndex, setActiveOptionIndex] = useState(-1);
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | null>(null);
  const canOpen = !disabled && !readOnly;
  const selectedWorkspaceId = value.type === "workspace" ? value.workspace.id : null;
  const displayText =
    value.type === "workspace"
      ? value.workspace.name
      : value.type === "pending"
        ? value.name
        : allowProjectFreeChat
          ? "无项目聊天"
          : "选择工作区";
  const displayHint =
    value.type === "workspace"
      ? value.workspace.root_path
      : value.type === "pending"
        ? `${value.rootPath} - 本地服务启动后启用项目工具`
        : allowProjectFreeChat
          ? "不挂载工作区，不启用项目工具"
          : "工作台模式需要先选择工作区";
  const filteredWorkspaces = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return workspaces;
    }
    return workspaces.filter((workspace) =>
      `${workspace.name}\n${workspace.root_path}`.toLowerCase().includes(keyword),
    );
  }, [query, workspaces]);
  const selectableOptions = useMemo<WorkspaceMenuOption[]>(() => {
    const workspaceOptions = filteredWorkspaces.map((workspace) => ({
      type: "workspace" as const,
      key: workspaceOptionKey(workspace),
      workspace,
    }));
    if (!allowProjectFreeChat) {
      return workspaceOptions;
    }
    return [...workspaceOptions, { type: "chat", key: chatOptionKey }];
  }, [allowProjectFreeChat, filteredWorkspaces]);

  const clearAddMenuCloseTimer = () => {
    if (addMenuCloseTimerRef.current !== null) {
      window.clearTimeout(addMenuCloseTimerRef.current);
      addMenuCloseTimerRef.current = null;
    }
  };

  const clearMenuCloseTimer = () => {
    if (menuCloseTimerRef.current !== null) {
      window.clearTimeout(menuCloseTimerRef.current);
      menuCloseTimerRef.current = null;
    }
  };

  const openMenu = () => {
    clearMenuCloseTimer();
    setMenuClosing(false);
    setQuery("");
    setAddError(null);
    setAddMenuOpen(false);
    setManualPathOpen(false);
    setManualPath("");
    setOpen(true);
  };

  const closeMenu = () => {
    clearAddMenuCloseTimer();
    setAddMenuOpen(false);
    setManualPathOpen(false);
    if (!open && !menuClosing) {
      return;
    }
    clearMenuCloseTimer();
    setOpen(false);
    if (prefersReducedMotion()) {
      setMenuClosing(false);
      return;
    }
    setMenuClosing(true);
    menuCloseTimerRef.current = window.setTimeout(() => {
      setMenuClosing(false);
      menuCloseTimerRef.current = null;
    }, MENU_EXIT_ANIMATION_MS);
  };

  const openAddMenu = () => {
    clearAddMenuCloseTimer();
    setAddMenuOpen(true);
  };

  const closeAddMenu = () => {
    clearAddMenuCloseTimer();
    setAddMenuOpen(false);
    setManualPathOpen(false);
  };

  const scheduleAddMenuClose = () => {
    clearAddMenuCloseTimer();
    if (adding || picking) {
      return;
    }
    addMenuCloseTimerRef.current = window.setTimeout(() => {
      setAddMenuOpen(false);
      setManualPathOpen(false);
      addMenuCloseTimerRef.current = null;
    }, 140);
  };

  const handleAddProjectClick = () => {
    setAddError(null);
    setManualPathOpen(false);
    openAddMenu();
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        closeMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!canOpen) {
      closeMenu();
      setActiveOptionIndex(-1);
    }
  }, [canOpen]);

  useEffect(() => {
    if (!open) {
      setActiveOptionIndex(-1);
      return;
    }
    setActiveOptionIndex((current) => {
      if (!selectableOptions.length) {
        return -1;
      }
      if (current >= 0 && current < selectableOptions.length) {
        return current;
      }
      const selectedIndex = query.trim()
        ? -1
        : selectableOptions.findIndex((option) =>
            isWorkspaceMenuOptionSelected(option, selectedWorkspaceId, value.type),
          );
      return selectedIndex >= 0 ? selectedIndex : 0;
    });
  }, [open, query, selectableOptions, selectedWorkspaceId, value.type]);

  useEffect(() => {
    if (!open || activeOptionIndex < 0) {
      return;
    }
    const activeOption = selectableOptions[activeOptionIndex];
    if (!activeOption) {
      return;
    }
    optionRefs.current.get(activeOption.key)?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionIndex, open, selectableOptions]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const updateMenuMaxHeight = () => {
      const root = rootRef.current;
      if (!root) {
        return;
      }
      const rootRect = root.getBoundingClientRect();
      const availableHeight =
        placement === "top"
          ? rootRect.top - MENU_OFFSET_PX - VIEWPORT_EDGE_GAP_PX
          : window.innerHeight - rootRect.bottom - MENU_OFFSET_PX - VIEWPORT_EDGE_GAP_PX;
      setMenuMaxHeight(Math.max(0, Math.floor(availableHeight)));
    };

    updateMenuMaxHeight();
    window.addEventListener("resize", updateMenuMaxHeight);
    return () => window.removeEventListener("resize", updateMenuMaxHeight);
  }, [open, placement]);

  useEffect(
    () => () => {
      clearAddMenuCloseTimer();
      clearMenuCloseTimer();
    },
    [],
  );

  const toggleOpen = () => {
    if (!canOpen) {
      return;
    }
    if (open) {
      closeMenu();
      return;
    }
    openMenu();
  };

  const chooseChat = () => {
    onSelectChat?.();
    closeMenu();
  };

  const chooseWorkspace = (workspace: Workspace) => {
    onSelectWorkspace?.(workspace);
    closeMenu();
  };

  const chooseActiveOption = () => {
    const activeOption = activeOptionIndex >= 0 ? selectableOptions[activeOptionIndex] : null;
    if (!activeOption) {
      return;
    }
    if (activeOption.type === "workspace") {
      chooseWorkspace(activeOption.workspace);
      return;
    }
    chooseChat();
  };

  const moveActiveOption = (direction: 1 | -1) => {
    if (!selectableOptions.length) {
      return;
    }
    setActiveOptionIndex((current) => {
      const base = current >= 0 ? current : direction > 0 ? -1 : 0;
      return (base + direction + selectableOptions.length) % selectableOptions.length;
    });
  };

  const addPickedWorkspace = async () => {
    if (!onAddWorkspace || !onPickWorkspacePath || adding || picking) {
      return;
    }
    setPicking(true);
    setAdding(false);
    setAddError(null);
    let selectedPath: string | null = null;
    try {
      selectedPath = await onPickWorkspacePath();
    } catch (reason) {
      setAddError(errorMessage(reason));
      setPicking(false);
      return;
    }
    setPicking(false);
    if (!selectedPath) {
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await onAddWorkspace(selectedPath);
      setQuery("");
      closeMenu();
    } catch (reason) {
      setAddError(errorMessage(reason));
    } finally {
      setAdding(false);
    }
  };

  const addManualWorkspace = async () => {
    if (!onAddWorkspace || adding) {
      return;
    }
    const trimmed = manualPath.trim();
    if (!trimmed) {
      setAddError("请输入项目路径");
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await onAddWorkspace(trimmed);
      setManualPath("");
      closeMenu();
    } catch (reason) {
      setAddError(errorMessage(reason));
    } finally {
      setAdding(false);
    }
  };

  const handleManualPathKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void addManualWorkspace();
    }
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActiveOption(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveOption(-1);
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      if (activeOptionIndex >= 0) {
        event.preventDefault();
        chooseActiveOption();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    }
  };

  const activeOptionId =
    open && activeOptionIndex >= 0 && selectableOptions[activeOptionIndex]
      ? `${menuId}-option-${activeOptionIndex}`
      : undefined;
  const chatSelectableIndex = selectableOptions.findIndex((option) => option.key === chatOptionKey);
  const menuVisible = open || menuClosing;

  return (
    <div className={styles.root} ref={rootRef} data-readonly={readOnly ? "true" : "false"} data-variant={variant}>
      <button
        className={styles.trigger}
        type="button"
        aria-label="选择工作区"
        aria-haspopup="dialog"
        aria-expanded={open ? "true" : "false"}
        aria-controls={open ? menuId : undefined}
        title={displayHint}
        disabled={!canOpen}
        onClick={toggleOpen}
      >
        {value.type === "workspace" || value.type === "pending" || !allowProjectFreeChat ? (
          <Folder size={15} strokeWidth={1.8} aria-hidden="true" />
        ) : (
          <MessageCircle size={15} strokeWidth={1.8} aria-hidden="true" />
        )}
        <span className={styles.triggerText}>{displayText}</span>
        {!readOnly ? <ChevronDown size={14} strokeWidth={1.9} aria-hidden="true" /> : null}
      </button>

      {menuVisible ? (
        <div
          className={styles.menu}
          data-placement={placement}
          data-state={menuClosing ? "closing" : "open"}
          id={menuId}
          role="dialog"
          aria-label="工作区选择"
          aria-hidden={menuClosing ? "true" : undefined}
          style={menuMaxHeight === null ? undefined : { maxHeight: `${menuMaxHeight}px` }}
        >
          <div className={styles.menuLabel}>工作区</div>
          <label className={styles.searchBox}>
            <Search size={13} strokeWidth={1.9} aria-hidden="true" />
            <input
              aria-label="筛选工作区"
              aria-activedescendant={activeOptionId}
              aria-controls={menuId}
              autoFocus
              placeholder="搜索项目"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
          </label>

          {value.type === "pending" ? (
            <div className={styles.section}>
              <div className={`${styles.option} ${styles.pendingOption}`} role="option" aria-selected="true">
                <Folder size={15} strokeWidth={1.8} aria-hidden="true" />
                <span className={styles.optionText}>
                  <span>{value.name}</span>
                  <small>{value.rootPath}</small>
                </span>
                <Check size={14} strokeWidth={1.9} aria-hidden="true" />
              </div>
            </div>
          ) : null}

          <div className={`${styles.section} ${styles.workspaceSection}`} role="listbox" aria-label="最近工作区">
            {loading ? <div className={styles.empty}>正在读取工作区</div> : null}
            {!loading && filteredWorkspaces.length
              ? filteredWorkspaces.map((workspace) => {
                  const selected = workspace.id === selectedWorkspaceId;
                  const optionKey = workspaceOptionKey(workspace);
                  const optionIndex = selectableOptions.findIndex((option) => option.key === optionKey);
                  const active = optionIndex === activeOptionIndex;
                  return (
                    <button
                      className={styles.option}
                      type="button"
                      role="option"
                      id={optionIndex >= 0 ? `${menuId}-option-${optionIndex}` : undefined}
                      aria-selected={selected ? "true" : "false"}
                      data-active={active ? "true" : undefined}
                      key={workspace.id}
                      ref={(element) => {
                        if (element) {
                          optionRefs.current.set(optionKey, element);
                        } else {
                          optionRefs.current.delete(optionKey);
                        }
                      }}
                      onClick={() => chooseWorkspace(workspace)}
                    >
                      <Folder size={15} strokeWidth={1.8} aria-hidden="true" />
                      <span className={styles.optionText}>
                        <span>{workspace.name}</span>
                        <small>{workspace.root_path}</small>
                      </span>
                      {selected ? <Check size={14} strokeWidth={1.9} aria-hidden="true" /> : null}
                    </button>
                  );
                })
              : null}
            {!loading && !filteredWorkspaces.length ? <div className={styles.empty}>没有匹配项目</div> : null}
          </div>

          {onAddWorkspace ? (
            <div className={styles.addSection} onMouseEnter={openAddMenu} onMouseLeave={scheduleAddMenuClose}>
              <button
                className={styles.addProjectButton}
                type="button"
                aria-haspopup="menu"
                aria-expanded={addMenuOpen ? "true" : "false"}
                disabled={adding || picking}
                onClick={handleAddProjectClick}
                onFocus={openAddMenu}
              >
                <FolderPlus size={15} strokeWidth={1.9} aria-hidden="true" />
                <span>{adding ? "正在添加项目" : picking ? "选择项目文件夹" : "添加新项目"}</span>
                <ChevronRight size={15} strokeWidth={1.9} aria-hidden="true" />
              </button>
              {addMenuOpen ? (
                <div
                  className={styles.addSubmenu}
                  role="menu"
                  aria-label="添加新项目"
                  onMouseEnter={openAddMenu}
                  onMouseLeave={scheduleAddMenuClose}
                >
                  <button
                    className={styles.addSubmenuItem}
                    type="button"
                    role="menuitem"
                    disabled={!onPickWorkspacePath || adding || picking}
                    onClick={() => void addPickedWorkspace()}
                  >
                    <Folder size={15} strokeWidth={1.9} aria-hidden="true" />
                    <span>{picking ? "正在选择文件夹" : adding ? "正在添加" : "选择文件夹"}</span>
                  </button>
                  <button
                    className={styles.addSubmenuItem}
                    type="button"
                    role="menuitem"
                    disabled={adding || picking}
                    onClick={() => {
                      setAddError(null);
                      setManualPathOpen((current) => !current);
                    }}
                  >
                    <Keyboard size={15} strokeWidth={1.9} aria-hidden="true" />
                    <span>输入本机路径</span>
                  </button>
                  {manualPathOpen ? (
                    <div className={styles.manualPathBox}>
                      <input
                        aria-label="项目路径"
                        placeholder="D:\\Pycharm Projects\\my-project"
                        value={manualPath}
                        disabled={adding}
                        onChange={(event) => setManualPath(event.target.value)}
                        onKeyDown={handleManualPathKeyDown}
                      />
                      <button type="button" disabled={adding} onClick={() => void addManualWorkspace()}>
                        {adding ? "添加中" : "添加"}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {addError ? (
                <div className={styles.error} role="alert">
                  <AlertCircle size={13} strokeWidth={1.9} aria-hidden="true" />
                  <span>{addError}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {allowProjectFreeChat ? (
            <div className={`${styles.section} ${styles.chatSection}`}>
              <button
                className={styles.option}
                type="button"
                id={chatSelectableIndex >= 0 ? `${menuId}-option-${chatSelectableIndex}` : undefined}
                aria-selected={value.type === "chat" ? "true" : "false"}
                data-active={chatSelectableIndex === activeOptionIndex ? "true" : undefined}
                ref={(element) => {
                  if (element) {
                    optionRefs.current.set(chatOptionKey, element);
                  } else {
                    optionRefs.current.delete(chatOptionKey);
                  }
                }}
                onClick={chooseChat}
              >
                <MessageCircle size={15} strokeWidth={1.8} aria-hidden="true" />
                <span className={styles.optionText}>
                  <span>无项目聊天</span>
                  <small>只对话，不启用项目工具</small>
                </span>
                {value.type === "chat" ? <Check size={14} strokeWidth={1.9} aria-hidden="true" /> : null}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function workspaceOptionKey(workspace: Workspace): string {
  return `workspace:${workspace.id}`;
}

function isWorkspaceMenuOptionSelected(
  option: WorkspaceMenuOption,
  selectedWorkspaceId: string | null,
  selectionType: WorkspaceSelection["type"],
): boolean {
  if (option.type === "workspace") {
    return option.workspace.id === selectedWorkspaceId;
  }
  return selectionType === "chat";
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "添加工作区失败";
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
