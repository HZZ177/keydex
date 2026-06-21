import { AlertCircle, Check, ChevronDown, ChevronRight, Folder, FolderPlus, Keyboard, MessageCircle, Search } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import type { Workspace } from "@/types/protocol";

import styles from "./WorkspaceSelector.module.css";

export type WorkspaceSelection =
  | { type: "chat" }
  | { type: "workspace"; workspace: Workspace };

export interface WorkspaceSelectorProps {
  value: WorkspaceSelection;
  workspaces: Workspace[];
  disabled?: boolean;
  readOnly?: boolean;
  loading?: boolean;
  placement?: "top" | "bottom";
  onSelectChat?: () => void;
  onSelectWorkspace?: (workspace: Workspace) => void;
  onAddWorkspace?: (path: string) => Promise<void> | void;
  onPickWorkspacePath?: () => Promise<string | null>;
}

export function WorkspaceSelector({
  value,
  workspaces,
  disabled = false,
  readOnly = false,
  loading = false,
  placement = "bottom",
  onSelectChat,
  onSelectWorkspace,
  onAddWorkspace,
  onPickWorkspacePath,
}: WorkspaceSelectorProps) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const addMenuCloseTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [manualPathOpen, setManualPathOpen] = useState(false);
  const [manualPath, setManualPath] = useState("");
  const [query, setQuery] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const canOpen = !disabled && !readOnly;
  const selectedWorkspaceId = value.type === "workspace" ? value.workspace.id : null;
  const displayText = value.type === "workspace" ? value.workspace.name : "无项目聊天";
  const displayHint = value.type === "workspace" ? value.workspace.root_path : "不挂载工作区，不启用项目工具";
  const filteredWorkspaces = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return workspaces;
    }
    return workspaces.filter((workspace) =>
      `${workspace.name}\n${workspace.root_path}`.toLowerCase().includes(keyword),
    );
  }, [query, workspaces]);

  const clearAddMenuCloseTimer = () => {
    if (addMenuCloseTimerRef.current !== null) {
      window.clearTimeout(addMenuCloseTimerRef.current);
      addMenuCloseTimerRef.current = null;
    }
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

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
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
      setOpen(false);
    }
  }, [canOpen]);

  useEffect(() => () => clearAddMenuCloseTimer(), []);

  const toggleOpen = () => {
    if (!canOpen) {
      return;
    }
    setOpen((current) => {
      const next = !current;
      if (next) {
        setQuery("");
        setAddError(null);
        setAddMenuOpen(false);
        setManualPathOpen(false);
        setManualPath("");
      }
      return next;
    });
  };

  const chooseChat = () => {
    onSelectChat?.();
    closeAddMenu();
    setOpen(false);
  };

  const chooseWorkspace = (workspace: Workspace) => {
    onSelectWorkspace?.(workspace);
    closeAddMenu();
    setOpen(false);
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
      closeAddMenu();
      setOpen(false);
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
      closeAddMenu();
      setOpen(false);
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

  return (
    <div className={styles.root} ref={rootRef} data-readonly={readOnly ? "true" : "false"}>
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
        {value.type === "workspace" ? (
          <Folder size={15} strokeWidth={1.8} aria-hidden="true" />
        ) : (
          <MessageCircle size={15} strokeWidth={1.8} aria-hidden="true" />
        )}
        <span className={styles.triggerText}>{displayText}</span>
        {!readOnly ? <ChevronDown size={14} strokeWidth={1.9} aria-hidden="true" /> : null}
      </button>

      {open ? (
        <div className={styles.menu} data-placement={placement} id={menuId} role="dialog" aria-label="工作区选择">
          <div className={styles.menuLabel}>工作区</div>
          <label className={styles.searchBox}>
            <Search size={13} strokeWidth={1.9} aria-hidden="true" />
            <input
              aria-label="筛选工作区"
              autoFocus
              placeholder="搜索项目"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <div className={styles.section}>
            <button
              className={styles.option}
              type="button"
              aria-selected={value.type === "chat" ? "true" : "false"}
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

          <div className={styles.section} role="listbox" aria-label="最近工作区">
            {loading ? <div className={styles.empty}>正在读取工作区</div> : null}
            {!loading && filteredWorkspaces.length
              ? filteredWorkspaces.map((workspace) => {
                  const selected = workspace.id === selectedWorkspaceId;
                  return (
                    <button
                      className={styles.option}
                      type="button"
                      role="option"
                      aria-selected={selected ? "true" : "false"}
                      key={workspace.id}
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
                onClick={() => {
                  if (addMenuOpen) {
                    closeAddMenu();
                  } else {
                    openAddMenu();
                  }
                }}
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
                    <span>{picking ? "正在选择文件夹" : adding ? "正在添加" : "使用现有文件夹"}</span>
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
        </div>
      ) : null}
    </div>
  );
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
