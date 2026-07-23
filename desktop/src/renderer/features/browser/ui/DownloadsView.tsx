import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  CheckCircle2,
  Download,
  FolderOpen,
  LoaderCircle,
  Pause,
  Play,
  Trash2,
  TriangleAlert,
  X,
  XCircle,
} from "lucide-react";

import {
  type AppContextMenuItem,
  useOptionalAppContextMenu,
} from "@/renderer/providers/AppContextMenuProvider";
import { runtimeBridge } from "@/runtime";
import {
  browserDownloadController,
  type BrowserDownloadItem,
} from "../runtime/BrowserDownloadController";

import styles from "./DownloadsView.module.css";

export interface DownloadsViewProps {
  onClose(): void;
}

interface DownloadActions {
  deleteFile(item: BrowserDownloadItem): Promise<void>;
  reveal(item: BrowserDownloadItem): Promise<void>;
}

const downloadActions: DownloadActions = {
  async deleteFile(item) {
    if (!item.filePath) throw new Error("下载文件路径不可用");
    await runtimeBridge.desktopPicker.deleteBrowserDownload(item.filePath);
  },
  async reveal(item) {
    if (!item.filePath) throw new Error("下载文件路径不可用");
    await runtimeBridge.desktopPicker.revealPath(item.filePath);
  },
};

export function DownloadsView({ onClose }: DownloadsViewProps) {
  const popoverRef = useRef<HTMLElement | null>(null);
  const items = useSyncExternalStore(
    browserDownloadController.store.subscribe,
    () => browserDownloadController.store.getState().items,
    () => browserDownloadController.store.getState().items,
  );
  const ordered = useMemo(
    () => Object.values(items).filter(Boolean).reverse() as BrowserDownloadItem[],
    [items],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BrowserDownloadItem | null>(null);
  const [busyAction, setBusyAction] = useState<"delete" | "reveal" | "pause" | "resume" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    const overlay = popover?.closest<HTMLElement>("[data-browser-surface-overlay='true']");
    const panel = popover?.closest<HTMLElement>("[data-browser-panel='true']");
    const anchor = panel?.querySelector<HTMLElement>("[data-browser-toolbar-anchor='downloads']");
    if (!popover || !overlay || !anchor) return;
    const measure = () => {
      const overlayRect = overlay.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const inset = Math.max(0, overlayRect.right - anchorRect.right);
      popover.style.setProperty("--downloads-anchor-inset", `${Math.round(inset)}px`);
    };
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(measure);
    resizeObserver?.observe(overlay);
    resizeObserver?.observe(anchor.parentElement ?? anchor);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    if (selectedId && !items[selectedId]) setSelectedId(null);
  }, [items, selectedId]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (popoverRef.current?.contains(target)) return;
      if (target.closest("[data-browser-toolbar-anchor='downloads']")) return;
      if (target.closest("[role='menu'][aria-label='页面右键菜单']")) return;
      onClose();
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (deleteTarget) setDeleteTarget(null);
      else onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteTarget, onClose]);

  const reveal = async (item: BrowserDownloadItem) => {
    if (!item.filePath || busyAction) return;
    setSelectedId(item.id);
    setActionError(null);
    setBusyAction("reveal");
    try {
      await downloadActions.reveal(item);
    } catch (error) {
      setActionError(errorMessage(error, "无法在资源管理器中显示该文件"));
    } finally {
      setBusyAction(null);
    }
  };

  const control = async (item: BrowserDownloadItem, action: "pause" | "resume") => {
    if (busyAction) return;
    setSelectedId(item.id);
    setActionError(null);
    setBusyAction(action);
    try {
      await browserDownloadController.control(item.id, action);
    } catch (error) {
      setActionError(errorMessage(error, action === "pause" ? "无法暂停该下载" : "无法恢复该下载"));
    } finally {
      setBusyAction(null);
    }
  };

  const removeDownload = async () => {
    if (!deleteTarget || busyAction) return;
    setActionError(null);
    setBusyAction("delete");
    try {
      if (deleteTarget.state === "completed" && deleteTarget.filePath) {
        try {
          await downloadActions.deleteFile(deleteTarget);
        } catch (error) {
          if (!isMissingFileError(error)) throw error;
        }
      } else if (
        deleteTarget.state === "requested"
        || deleteTarget.state === "downloading"
        || deleteTarget.state === "paused"
      ) {
        await browserDownloadController.control(deleteTarget.id, "cancel");
      }
      browserDownloadController.remove(deleteTarget.id);
      setDeleteTarget(null);
    } catch (error) {
      setActionError(errorMessage(error, "无法删除该下载文件"));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <>
      <section
        ref={popoverRef}
        aria-label="下载"
        aria-modal="false"
        className={styles.popover}
        data-app-tooltip-owner="browser-panel"
        data-browser-chrome-tooltips="true"
        data-browser-surface-occlusion="true"
        role="dialog"
      >
        <header className={styles.header}>
          <span className={styles.headerIcon} aria-hidden="true"><Download size={15} /></span>
          <span className={styles.heading}>
            <strong>下载</strong>
            <small>文件保存在系统 Downloads 文件夹</small>
          </span>
          <button
            aria-label="关闭下载"
            className={styles.iconButton}
            data-tooltip-label="关闭"
            onClick={onClose}
            type="button"
          >
            <X size={14} />
          </button>
        </header>

        {actionError ? <div className={styles.error} role="alert">{actionError}</div> : null}

        <div aria-label="下载记录" className={styles.list} role="listbox">
          {ordered.length ? ordered.map((item) => (
            <DownloadRow
              busy={busyAction !== null}
              item={item}
              key={item.id}
              selected={selectedId === item.id}
              onDelete={() => {
                setSelectedId(item.id);
                setDeleteTarget(item);
              }}
              onPause={() => void control(item, "pause")}
              onReveal={() => void reveal(item)}
              onResume={() => void control(item, "resume")}
              onSelect={() => setSelectedId(item.id)}
            />
          )) : (
            <div className={styles.empty}>
              <Download size={20} />
              <strong>暂无下载</strong>
              <span>从网页下载的文件会显示在这里</span>
            </div>
          )}
        </div>

        {deleteTarget ? (
          <div aria-labelledby="download-remove-title" className={styles.confirmLayer} role="alertdialog">
            <div className={styles.confirmCard}>
              <strong id="download-remove-title">{removeTitle(deleteTarget)}</strong>
              <p>{removeDescription(deleteTarget)}</p>
              <code>{deleteTarget.filename}</code>
              <span className={styles.confirmActions}>
                <button
                  className={styles.secondaryButton}
                  disabled={busyAction === "delete"}
                  onClick={() => setDeleteTarget(null)}
                  type="button"
                >
                  取消
                </button>
                <button
                  className={styles.dangerButton}
                  disabled={busyAction === "delete"}
                  onClick={() => void removeDownload()}
                  type="button"
                >
                  {busyAction === "delete" ? "处理中" : removeConfirmLabel(deleteTarget)}
                </button>
              </span>
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}

function DownloadRow({
  busy,
  item,
  selected,
  onDelete,
  onPause,
  onReveal,
  onResume,
  onSelect,
}: {
  readonly busy: boolean;
  readonly item: BrowserDownloadItem;
  readonly selected: boolean;
  onDelete(): void;
  onPause(): void;
  onReveal(): void;
  onResume(): void;
  onSelect(): void;
}) {
  const contextMenu = useOptionalAppContextMenu();
  const revealAvailable = item.state === "completed" && Boolean(item.filePath);
  const menuItems = downloadContextMenuItems(item, { onDelete, onPause, onReveal, onResume });
  const openContextMenu = (
    target: HTMLElement,
    x: number,
    y: number,
  ) => {
    onSelect();
    contextMenu?.openContextMenu({ items: menuItems, target, x, y });
  };
  const handleContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (!contextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    openContextMenu(event.currentTarget, event.clientX, event.clientY);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
      return;
    }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openContextMenu(event.currentTarget, rect.left + 24, rect.bottom + 4);
    }
  };
  const status = item.state === "completed" ? "已完成"
    : item.state === "failed" ? downloadErrorLabel(item.errorCategory)
      : item.state === "cancelled" ? "已取消"
        : item.state === "paused" ? `已暂停 · ${progressLabel(item)}`
          : item.state === "requested" ? "等待确认" : progressLabel(item);
  const icon = item.state === "completed" ? <CheckCircle2 size={15} />
    : item.state === "failed" ? <TriangleAlert size={15} />
      : item.state === "cancelled" ? <XCircle size={15} />
        : item.state === "paused" ? <Pause size={15} /> : <LoaderCircle size={15} />;
  const progress = downloadProgress(item);

  return (
    <article
      aria-label={`${item.filename}，${status}`}
      aria-selected={selected}
      className={styles.item}
      data-selected={selected ? "true" : undefined}
      data-state={item.state}
      onClick={onSelect}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      role="option"
      tabIndex={0}
    >
      <span className={styles.icon} aria-hidden="true">{icon}</span>
      <span className={styles.details}>
        <strong title={item.filename}>{item.filename}</strong>
        <small>{status}</small>
        {progress !== null && (item.state === "downloading" || item.state === "paused") ? (
          <span aria-hidden="true" className={styles.progressTrack}>
            <span style={{ width: `${progress}%` }} />
          </span>
        ) : null}
      </span>
      <span className={styles.actions}>
        {item.state === "downloading" ? (
          <button
            aria-label={`暂停 ${item.filename}`}
            className={styles.iconButton}
            data-tooltip-label="暂停下载"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              onPause();
            }}
            type="button"
          >
            <Pause size={14} />
          </button>
        ) : null}
        {item.state === "paused" ? (
          <button
            aria-label={`恢复 ${item.filename}`}
            className={styles.iconButton}
            data-tooltip-label="恢复下载"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              onResume();
            }}
            type="button"
          >
            <Play size={14} />
          </button>
        ) : null}
        <button
          aria-label={`在资源管理器中显示 ${item.filename}`}
          className={styles.iconButton}
          data-tooltip-label="在资源管理器中显示"
          disabled={!revealAvailable || busy}
          onClick={(event) => {
            event.stopPropagation();
            onReveal();
          }}
          type="button"
        >
          <FolderOpen size={14} />
        </button>
        <button
          aria-label={`删除 ${item.filename}`}
          className={styles.iconButton}
          data-tone="danger"
          data-tooltip-label={removeTooltipLabel(item)}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          type="button"
        >
          <Trash2 size={14} />
        </button>
      </span>
    </article>
  );
}

export function downloadContextMenuItems(
  item: BrowserDownloadItem,
  actions: { onDelete(): void; onPause(): void; onReveal(): void; onResume(): void },
): AppContextMenuItem[] {
  const revealAvailable = item.state === "completed" && Boolean(item.filePath);
  const items: AppContextMenuItem[] = [];
  if (item.state === "downloading") {
    items.push({
      id: `download-pause-${item.id}`,
      label: "暂停下载",
      icon: Pause,
      action: actions.onPause,
    });
  } else if (item.state === "paused") {
    items.push({
      id: `download-resume-${item.id}`,
      label: "恢复下载",
      icon: Play,
      action: actions.onResume,
    });
  }
  items.push(
    {
      id: `download-reveal-${item.id}`,
      label: "在资源管理器中显示",
      icon: FolderOpen,
      disabled: !revealAvailable,
      separatorBefore: items.length > 0,
      action: revealAvailable ? actions.onReveal : undefined,
    },
    {
      id: `download-delete-${item.id}`,
      label: removeTooltipLabel(item),
      icon: Trash2,
      separatorBefore: true,
      action: actions.onDelete,
    },
  );
  return items;
}

function progressLabel(item: BrowserDownloadItem): string {
  if (item.receivedBytes === 0) return "正在连接…";
  if (!item.totalBytes) return `${formatBytes(item.receivedBytes)} 已下载`;
  return `${downloadProgress(item)}% · ${formatBytes(item.totalBytes)}`;
}

function downloadProgress(item: BrowserDownloadItem): number | null {
  if (!item.totalBytes) return null;
  return Math.min(100, Math.round(item.receivedBytes / item.totalBytes * 100));
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = String(error.message).trim();
    if (message) return message;
  }
  return fallback;
}

function isMissingFileError(error: unknown): boolean {
  const message = errorMessage(error, "").toLocaleLowerCase();
  return message.includes("不存在")
    || message.includes("找不到")
    || message.includes("not found")
    || message.includes("cannot find");
}

function downloadErrorLabel(category: string | null): string {
  switch (category) {
    case "no_progress": return "长时间未收到下载数据";
    case "policy_or_access": return "目标文件不可写";
    case "no_space": return "磁盘空间不足";
    case "too_large": return "文件过大";
    case "security": return "下载被安全策略阻止";
    case "network": return "网络连接中断";
    case "authentication": return "下载需要身份验证";
    case "tls_certificate": return "网站证书异常";
    case "process_failed": return "浏览器下载进程异常";
    case "host_rejected": return "浏览器未能启动下载";
    default: return "下载失败";
  }
}

function removeTooltipLabel(item: BrowserDownloadItem): string {
  return item.state === "requested" || item.state === "downloading" || item.state === "paused"
    ? "取消并移除"
    : item.state === "completed" && item.filePath
      ? "删除文件"
      : "移除记录";
}

function removeTitle(item: BrowserDownloadItem): string {
  return item.state === "requested" || item.state === "downloading" || item.state === "paused"
    ? "取消下载并移除记录？"
    : item.state === "completed" && item.filePath
      ? "删除下载文件？"
      : "移除下载记录？";
}

function removeDescription(item: BrowserDownloadItem): string {
  if (item.state === "requested" || item.state === "downloading" || item.state === "paused") {
    return "下载将被取消，未完成的临时文件会由浏览器清理。";
  }
  if (item.state === "completed" && item.filePath) {
    return "文件将从系统 Downloads 文件夹中永久删除，此操作不可撤销。";
  }
  return "只会从下载列表中移除这条记录。";
}

function removeConfirmLabel(item: BrowserDownloadItem): string {
  return item.state === "requested" || item.state === "downloading" || item.state === "paused"
    ? "取消并移除"
    : item.state === "completed" && item.filePath
      ? "删除文件"
      : "移除记录";
}
