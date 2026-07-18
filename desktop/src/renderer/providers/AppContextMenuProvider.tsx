import {
  CheckSquare,
  ChevronRight,
  ChevronsUpDown,
  ClipboardPaste,
  Copy,
  File as FileIcon,
  FolderOpen,
  MessageSquarePlus,
  MessageSquareText,
  RefreshCw,
  Route,
  Scissors,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PropsWithChildren,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import {
  emitAddWorkspaceFileToChat,
  emitExpandWorkspaceDirectory,
  emitStartWorkspaceFileAnnotation,
} from "@/renderer/events/workspaceFileContext";
import { readPastedTextSelection } from "@/renderer/components/chat/SendBox/collapsiblePaste";

import styles from "./AppContextMenuProvider.module.css";

type TextControl = HTMLInputElement | HTMLTextAreaElement;
type EditableTarget = TextControl | HTMLElement;

interface MenuContext {
  documentEntry: WorkspaceEntryContext | null;
  editable: EditableTarget | null;
  kind: "custom" | "editable" | "selection" | "empty" | "workspace-document" | "workspace-file" | "workspace-directory";
  mutable: boolean;
  selectionText: string;
  workspaceEntry: WorkspaceEntryContext | null;
}

interface WorkspaceEntryContext {
  absolutePath: string;
  kind: "file" | "directory";
  name: string;
  path: string;
  sessionId: string | null;
  workspaceId: string | null;
  workspaceRoot: string | null;
}

interface MenuState {
  context: MenuContext;
  items: AppContextMenuItem[] | null;
  left: number;
  ready: boolean;
  top: number;
  x: number;
  y: number;
}

export interface AppContextMenuItem {
  action?: () => void | Promise<void>;
  children?: AppContextMenuItem[];
  disabled?: boolean;
  icon: LucideIcon;
  id: string;
  label: string;
  separatorBefore?: boolean;
}

export interface OpenAppContextMenuRequest {
  items: AppContextMenuItem[];
  target: EventTarget | null;
  x: number;
  y: number;
}

interface AppContextMenuController {
  closeContextMenu: () => void;
  openContextMenu: (request: OpenAppContextMenuRequest) => void;
}

const AppContextMenuContext = createContext<AppContextMenuController | null>(null);

export function useOptionalAppContextMenu(): AppContextMenuController | null {
  return useContext(AppContextMenuContext);
}

const MENU_MARGIN = 8;
const LOCAL_CONTEXT_MENU_SELECTOR = "[data-app-context-menu='local']";
const NATIVE_CONTEXT_MENU_SELECTOR = "[data-native-context-menu='true']";
const WORKSPACE_DOCUMENT_CONTEXT_SELECTOR = "[data-workspace-document-context='true'][data-workspace-document-path]";
const WORKSPACE_ENTRY_CONTEXT_SELECTOR = "[data-workspace-entry-kind][data-workspace-entry-path]";
const EDITABLE_SELECTOR = [
  "textarea",
  "input",
  "[contenteditable]",
  "[data-sendbox-input='true']",
  "[role='textbox']",
].join(",");
const TEXT_INPUT_TYPES = new Set([
  "email",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

export function AppContextMenuProvider({ children }: PropsWithChildren) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const closeMenu = useCallback(() => {
    setMenu(null);
  }, []);

  const openMenu = useCallback((x: number, y: number, target: EventTarget | null) => {
    const targetElement = eventTargetElement(target);
    if (!targetElement || targetElement.closest(NATIVE_CONTEXT_MENU_SELECTOR)) {
      setMenu(null);
      return;
    }

    setMenu({
      context: getMenuContext(targetElement),
      items: null,
      left: x,
      ready: false,
      top: y,
      x,
      y,
    });
  }, []);

  const openCustomMenu = useCallback((request: OpenAppContextMenuRequest) => {
    const targetElement = eventTargetElement(request.target);
    if (!targetElement || targetElement.closest(NATIVE_CONTEXT_MENU_SELECTOR)) {
      setMenu(null);
      return;
    }
    setMenu({
      context: { ...getMenuContext(targetElement), kind: "custom" },
      items: request.items,
      left: request.x,
      ready: false,
      top: request.y,
      x: request.x,
      y: request.y,
    });
  }, []);

  const controller = useMemo<AppContextMenuController>(() => ({
    closeContextMenu: closeMenu,
    openContextMenu: openCustomMenu,
  }), [closeMenu, openCustomMenu]);

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      const targetElement = eventTargetElement(event.target);
      if (targetElement && menuRef.current?.contains(targetElement)) {
        event.preventDefault();
        return;
      }
      if (targetElement?.closest(LOCAL_CONTEXT_MENU_SELECTOR)) {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (targetElement?.closest(NATIVE_CONTEXT_MENU_SELECTOR)) {
        closeMenu();
        return;
      }

      event.preventDefault();
      openMenu(event.clientX, event.clientY, event.target);
    };

    window.addEventListener("contextmenu", handleContextMenu, true);
    return () => window.removeEventListener("contextmenu", handleContextMenu, true);
  }, [closeMenu, openMenu]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
        return;
      }
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
        return;
      }

      const target = document.activeElement;
      if (!target) {
        return;
      }
      if (target instanceof Element && target.closest(LOCAL_CONTEXT_MENU_SELECTOR)) {
        return;
      }
      const rect = target.getBoundingClientRect();
      event.preventDefault();
      openMenu(rect.left + Math.min(20, rect.width), rect.top + Math.min(20, rect.height), target);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [closeMenu, openMenu]);

  useLayoutEffect(() => {
    if (!menu || menu.ready) {
      return;
    }

    const element = menuRef.current;
    if (!element) {
      return;
    }

    const rect = element.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const maxLeft = Math.max(MENU_MARGIN, viewportWidth - rect.width - MENU_MARGIN);
    const maxTop = Math.max(MENU_MARGIN, viewportHeight - rect.height - MENU_MARGIN);
    const left = clamp(menu.x, MENU_MARGIN, maxLeft);
    const top = clamp(menu.y, MENU_MARGIN, maxTop);

    setMenu((current) =>
      current
        ? {
            ...current,
            left: Math.round(left),
            ready: true,
            top: Math.round(top),
          }
        : current,
    );
  }, [menu]);

  useEffect(() => {
    if (!menu) {
      return;
    }

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const targetElement = eventTargetElement(event.target);
      if (targetElement && menuRef.current?.contains(targetElement)) {
        return;
      }
      closeMenu();
    };

    document.addEventListener("pointerdown", closeOnOutsidePointerDown, true);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown, true);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [closeMenu, menu]);

  return (
    <AppContextMenuContext.Provider value={controller}>
      {children}
      {menu ? (
        <AppContextMenu
          menu={menu}
          menuRef={menuRef}
          onClose={closeMenu}
        />
      ) : null}
    </AppContextMenuContext.Provider>
  );
}

interface AppContextMenuProps {
  menu: MenuState;
  menuRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

function AppContextMenu({ menu, menuRef, onClose }: AppContextMenuProps) {
  const defaultItems = useMenuItems(menu.context);
  const items = menu.items ?? defaultItems;

  const runAction = useCallback(
    async (item: AppContextMenuItem) => {
      if (item.disabled || !item.action) {
        return;
      }
      try {
        await item.action();
      } catch (reason) {
        console.error("Context menu action failed", reason);
      } finally {
        onClose();
      }
    },
    [onClose],
  );

  return createPortal(
    <div
      ref={menuRef}
      aria-label="页面右键菜单"
      className={styles.menu}
      data-context-kind={menu.context.kind}
      data-context-mutable={menu.context.mutable ? "true" : "false"}
      data-context-selection={menu.context.selectionText ? "true" : "false"}
      data-ready={menu.ready ? "true" : "false"}
      role="menu"
      style={
        {
          "--context-menu-left": `${menu.left}px`,
          "--context-menu-top": `${menu.top}px`,
        } as CSSProperties
      }
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {items.map((item, index) => {
        return (
          <ContextMenuItemView
            item={item}
            key={item.id}
            tabIndex={index === 0 ? 0 : -1}
            onRunAction={runAction}
          />
        );
      })}
    </div>,
    document.body,
  );
}

function ContextMenuItemView({
  item,
  onRunAction,
  tabIndex,
}: {
  item: AppContextMenuItem;
  onRunAction: (item: AppContextMenuItem) => void | Promise<void>;
  tabIndex: number;
}) {
  const Icon = item.icon;

  if (item.children?.length) {
    return (
      <div className={styles.submenuRoot} role="none">
        <button
          aria-disabled={item.disabled ? "true" : undefined}
          aria-haspopup="menu"
          className={styles.item}
          data-has-submenu="true"
          data-separator-before={item.separatorBefore ? "true" : undefined}
          data-menu-item="true"
          disabled={item.disabled}
          role="menuitem"
          tabIndex={tabIndex}
          type="button"
        >
          <Icon size={14} strokeWidth={2.1} />
          <span className={styles.label}>{item.label}</span>
          <ChevronRight size={13} strokeWidth={2.1} aria-hidden="true" />
        </button>
        <div className={styles.submenu} role="menu" aria-label={item.label}>
          {item.children.map((child, index) => (
            <ContextMenuItemView
              item={child}
              key={child.id}
              tabIndex={index === 0 ? 0 : -1}
              onRunAction={onRunAction}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <button
      aria-disabled={item.disabled ? "true" : undefined}
      className={styles.item}
      data-menu-item="true"
      data-separator-before={item.separatorBefore ? "true" : undefined}
      disabled={item.disabled}
      role="menuitem"
      tabIndex={tabIndex}
      type="button"
      onClick={() => {
        void onRunAction(item);
      }}
    >
      <Icon size={14} strokeWidth={2.1} />
      <span className={styles.label}>{item.label}</span>
    </button>
  );
}

function useMenuItems(context: MenuContext): AppContextMenuItem[] {
  return useMemo(() => {
    const hasSelection = context.selectionText.length > 0;
    const withDocumentActions = (items: AppContextMenuItem[]) => addDocumentActions(items, context.documentEntry);
    const workspaceEntry = context.workspaceEntry;

    if (workspaceEntry?.kind === "directory") {
      return withRefresh([
        {
          action: () => expandWorkspaceDirectory(workspaceEntry),
          icon: ChevronsUpDown,
          id: "expand-workspace-directory",
          label: "展开所有下级菜单",
        },
        {
          action: () => addWorkspaceEntryToChat(workspaceEntry),
          icon: MessageSquarePlus,
          id: "add-workspace-directory-to-chat",
          label: "添加该目录到会话",
        },
      ]);
    }

    if (workspaceEntry?.kind === "file") {
      return withRefresh([
        {
          action: () => copyWorkspaceFile(workspaceEntry),
          icon: FileIcon,
          id: "copy-workspace-file",
          label: "复制文件",
        },
        {
          children: [
            {
              action: () => openWorkspaceFileInFileManager(workspaceEntry),
              icon: FolderOpen,
              id: "open-workspace-file-explorer",
              label: "资源管理器",
            },
          ],
          icon: FolderOpen,
          id: "open-workspace-file-in",
          label: "打开于",
        },
        {
          action: () => writeClipboardText(workspaceEntry.absolutePath),
          icon: Copy,
          id: "copy-workspace-absolute-path",
          label: "复制绝对路径",
        },
        {
          action: () => writeClipboardText(workspaceEntry.path),
          icon: Route,
          id: "copy-workspace-relative-path",
          label: "复制工作区相对路径",
        },
        {
          action: () => addWorkspaceEntryToChat(workspaceEntry),
          icon: MessageSquarePlus,
          id: "add-workspace-file-to-chat",
          label: "添加到聊天",
        },
      ]);
    }

    if (context.editable) {
      return withRefresh(withDocumentActions([
        {
          action: () => cutSelection(context),
          disabled: !context.mutable || !hasSelection,
          icon: Scissors,
          id: "cut",
          label: "剪切",
        },
        {
          action: () => copySelection(context),
          disabled: !hasSelection,
          icon: Copy,
          id: "copy",
          label: "复制",
        },
        {
          action: () => pasteIntoEditable(context),
          disabled: !context.mutable,
          icon: ClipboardPaste,
          id: "paste",
          label: "粘贴",
        },
        {
          action: () => selectAllEditable(context.editable),
          icon: CheckSquare,
          id: "select-all",
          label: "全选",
        },
      ]));
    }

    if (hasSelection) {
      return withRefresh(withDocumentActions([
        {
          action: () => copySelection(context),
          icon: Copy,
          id: "copy-selection",
          label: "复制",
        },
      ]));
    }

    return withRefresh(withDocumentActions([]));
  }, [context]);
}

function addDocumentActions(items: AppContextMenuItem[], documentEntry: WorkspaceEntryContext | null): AppContextMenuItem[] {
  if (!documentEntry) {
    return items;
  }
  return [
    ...items,
    {
      action: () => addWorkspaceEntryToChat(documentEntry),
      icon: MessageSquarePlus,
      id: "chat-with-workspace-document",
      label: "添加该文件到对话",
    },
    {
      action: () => startWorkspaceFileAnnotation(documentEntry),
      icon: MessageSquareText,
      id: "annotate-workspace-document",
      label: "对该文档新增批注",
    },
  ];
}

function withRefresh(items: AppContextMenuItem[]): AppContextMenuItem[] {
  return [
    ...items,
    {
      action: refreshPage,
      icon: RefreshCw,
      id: "refresh-page",
      label: "刷新",
    },
  ];
}

async function copySelection(context: MenuContext) {
  const text = getLiveSelectionText(context);
  if (!text) {
    return;
  }
  await writeClipboardText(text);
}

async function cutSelection(context: MenuContext) {
  if (!context.editable || !context.mutable) {
    return;
  }

  const text = getLiveSelectionText(context);
  if (!text) {
    return;
  }

  await writeClipboardText(text);
  deleteEditableSelection(context.editable);
}

async function pasteIntoEditable(context: MenuContext) {
  if (!context.editable || !context.mutable) {
    return;
  }

  focusEditable(context.editable);

  const text = await readClipboardText();
  if (text !== null) {
    insertEditableText(context.editable, text);
    return;
  }

  if (typeof document.execCommand === "function") {
    document.execCommand("paste");
  }
}

async function copyWorkspaceFile(context: WorkspaceEntryContext) {
  if (!context.absolutePath) {
    throw new Error("workspace file absolute path is missing");
  }
  await invokeDesktopCommand("copy_file_to_clipboard", { path: context.absolutePath });
}

async function openWorkspaceFileInFileManager(context: WorkspaceEntryContext) {
  if (!context.absolutePath) {
    throw new Error("workspace file absolute path is missing");
  }
  await invokeDesktopCommand("open_path_in_file_manager", { path: context.absolutePath });
}

function addWorkspaceEntryToChat(context: WorkspaceEntryContext) {
  emitAddWorkspaceFileToChat({
    absolutePath: context.absolutePath,
    file: {
      path: context.path,
      name: context.name || fileName(context.path),
      type: context.kind,
      source: "workspace",
    },
    sessionId: context.sessionId,
    workspaceId: context.workspaceId,
    workspaceRoot: context.workspaceRoot,
  });
}

function expandWorkspaceDirectory(context: WorkspaceEntryContext) {
  emitExpandWorkspaceDirectory({
    path: context.path,
    sessionId: context.sessionId,
    workspaceId: context.workspaceId,
    workspaceRoot: context.workspaceRoot,
  });
}

function startWorkspaceFileAnnotation(context: WorkspaceEntryContext) {
  emitStartWorkspaceFileAnnotation({
    path: context.path,
    sessionId: context.sessionId,
    workspaceId: context.workspaceId,
    workspaceRoot: context.workspaceRoot,
  });
}

function refreshPage() {
  window.location.reload();
}

async function invokeDesktopCommand(command: string, args: Record<string, unknown>) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke(command, args);
}

function selectAllEditable(editable: EditableTarget | null) {
  if (!editable) {
    return;
  }

  focusEditable(editable);

  if (isTextControl(editable)) {
    editable.select();
    return;
  }

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editable);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document.execCommand === "function") {
    document.execCommand("copy");
  }
}

async function readClipboardText(): Promise<string | null> {
  if (!navigator.clipboard?.readText) {
    return null;
  }

  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

function getMenuContext(target: Element): MenuContext {
  const workspaceEntry = getWorkspaceEntryContext(target);
  if (workspaceEntry) {
    return {
      documentEntry: null,
      editable: null,
      kind: workspaceEntry.kind === "file" ? "workspace-file" : "workspace-directory",
      mutable: false,
      selectionText: "",
      workspaceEntry,
    };
  }

  const documentEntry = getWorkspaceDocumentContext(target);
  const editable = getEditableTarget(target);
  const selectionText = editable ? getEditableSelectionText(editable) : window.getSelection()?.toString() ?? "";
  const mutable = editable ? isEditableMutable(editable) : false;
  return {
    documentEntry,
    editable,
    kind: editable ? "editable" : selectionText ? "selection" : documentEntry ? "workspace-document" : "empty",
    mutable,
    selectionText,
    workspaceEntry: null,
  };
}

function getWorkspaceDocumentContext(target: Element): WorkspaceEntryContext | null {
  const candidate = target.closest(WORKSPACE_DOCUMENT_CONTEXT_SELECTOR);
  if (!(candidate instanceof HTMLElement)) {
    return null;
  }
  const path = candidate.dataset.workspaceDocumentPath?.trim() ?? "";
  if (!path) {
    return null;
  }
  const workspaceRoot = candidate.dataset.workspaceRoot?.trim() || null;
  const absolutePath =
    candidate.dataset.workspaceDocumentAbsolutePath?.trim() ||
    workspaceAbsolutePath(workspaceRoot ?? "", path);
  return {
    absolutePath,
    kind: "file",
    name: candidate.dataset.workspaceDocumentName?.trim() || fileName(path),
    path,
    sessionId: candidate.dataset.workspaceSessionId?.trim() || null,
    workspaceId: candidate.dataset.workspaceId?.trim() || null,
    workspaceRoot,
  };
}

function getWorkspaceEntryContext(target: Element): WorkspaceEntryContext | null {
  const candidate = target.closest(WORKSPACE_ENTRY_CONTEXT_SELECTOR);
  if (!(candidate instanceof HTMLElement)) {
    return null;
  }
  const kind = candidate.dataset.workspaceEntryKind === "directory" ? "directory" : "file";
  const path = candidate.dataset.workspaceEntryPath?.trim() ?? "";
  if (!path && kind !== "directory") {
    return null;
  }
  const workspaceRoot = candidate.dataset.workspaceRoot?.trim() || null;
  const absolutePath =
    candidate.dataset.workspaceEntryAbsolutePath?.trim() ||
    workspaceAbsolutePath(workspaceRoot ?? "", path);
  return {
    absolutePath,
    kind,
    name: candidate.dataset.workspaceEntryName?.trim() || fileName(path),
    path,
    sessionId: candidate.dataset.workspaceSessionId?.trim() || null,
    workspaceId: candidate.dataset.workspaceId?.trim() || null,
    workspaceRoot,
  };
}

function getEditableTarget(target: Element): EditableTarget | null {
  const candidate = target.closest(EDITABLE_SELECTOR);
  if (!(candidate instanceof HTMLElement)) {
    return null;
  }

  if (candidate instanceof HTMLTextAreaElement) {
    return candidate;
  }

  if (candidate instanceof HTMLInputElement) {
    return isTextInput(candidate) ? candidate : null;
  }

  if (isEditableElement(candidate)) {
    return candidate;
  }
  const sendBoxInput = target.closest<HTMLElement>("[data-sendbox-input='true']");
  return sendBoxInput && isEditableElement(sendBoxInput) ? sendBoxInput : null;
}

function getEditableSelectionText(editable: EditableTarget) {
  if (isTextControl(editable)) {
    const start = editable.selectionStart;
    const end = editable.selectionEnd;
    if (start === null || end === null || end <= start) {
      return "";
    }
    return editable.value.slice(start, end);
  }

  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) {
    return "";
  }

  if (!containsNode(editable, selection.anchorNode) || !containsNode(editable, selection.focusNode)) {
    return "";
  }

  const logicalText = readPastedTextSelection(selection.getRangeAt(0));
  if (logicalText !== null) {
    return logicalText;
  }
  return selection.toString();
}

function getLiveSelectionText(context: MenuContext) {
  if (context.editable) {
    return getEditableSelectionText(context.editable);
  }
  return window.getSelection()?.toString() ?? context.selectionText;
}

function deleteEditableSelection(editable: EditableTarget) {
  focusEditable(editable);

  if (isTextControl(editable)) {
    const start = editable.selectionStart;
    const end = editable.selectionEnd;
    if (start === null || end === null || end <= start) {
      return;
    }
    editable.setRangeText("", start, end, "start");
    dispatchEditableInput(editable, "deleteContentBackward");
    return;
  }

  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !containsNode(editable, selection.anchorNode)) {
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  selection.removeAllRanges();
  selection.addRange(range);
  dispatchEditableInput(editable, "deleteContentBackward");
}

function insertEditableText(editable: EditableTarget, text: string) {
  focusEditable(editable);

  if (isTextControl(editable)) {
    const start = editable.selectionStart ?? editable.value.length;
    const end = editable.selectionEnd ?? start;
    editable.setRangeText(text, start, end, "end");
    dispatchEditableInput(editable, "insertText", text);
    return;
  }

  if (typeof document.execCommand === "function" && document.execCommand("insertText", false, text)) {
    dispatchEditableInput(editable, "insertText", text);
    return;
  }

  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) {
    editable.append(document.createTextNode(text));
    dispatchEditableInput(editable, "insertText", text);
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.setEndAfter(textNode);
  selection.removeAllRanges();
  selection.addRange(range);
  dispatchEditableInput(editable, "insertText", text);
}

function dispatchEditableInput(editable: EditableTarget, inputType: string, data: string | null = null) {
  const event =
    typeof InputEvent === "function"
      ? new InputEvent("input", {
          bubbles: true,
          data,
          inputType,
        })
      : new Event("input", { bubbles: true });
  editable.dispatchEvent(event);
}

function focusEditable(editable: EditableTarget) {
  if (document.activeElement !== editable) {
    editable.focus({ preventScroll: true });
  }
}

function isEditableMutable(editable: EditableTarget) {
  if (isTextControl(editable)) {
    return !editable.disabled && !editable.readOnly;
  }
  if (editable.getAttribute("aria-disabled") === "true") {
    return false;
  }
  return isEditableElement(editable) && editable.getAttribute("contenteditable") !== "false";
}

function isTextControl(element: EditableTarget): element is TextControl {
  return element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement;
}

function isTextInput(element: HTMLInputElement) {
  return TEXT_INPUT_TYPES.has(element.type || "text");
}

function isEditableElement(element: HTMLElement) {
  const contentEditable = element.getAttribute("contenteditable");
  return (
    element.isContentEditable ||
    contentEditable === "true" ||
    contentEditable === "plaintext-only" ||
    element.dataset.sendboxInput === "true"
  );
}

function containsNode(element: HTMLElement, node: Node | null) {
  return Boolean(node && (node === element || element.contains(node)));
}

function eventTargetElement(target: EventTarget | null) {
  if (target instanceof Element) {
    return target;
  }
  if (target instanceof Node) {
    return target.parentElement;
  }
  return null;
}

function workspaceAbsolutePath(root: string, path: string): string {
  const cleanedRoot = root.trim();
  const cleanedPath = path.replace(/^[/\\]+/, "");
  if (!cleanedRoot) {
    return cleanedPath;
  }
  const separator = cleanedRoot.includes("\\") ? "\\" : "/";
  const normalizedPath =
    separator === "\\" ? cleanedPath.replace(/\//g, "\\") : cleanedPath.replace(/\\/g, "/");
  const normalizedRoot = cleanedRoot.replace(/[\\/]+$/, "");
  return normalizedPath ? `${normalizedRoot}${separator}${normalizedPath}` : normalizedRoot;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
