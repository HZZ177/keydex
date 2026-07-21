import { Archive, Copy, Download, GitBranchPlus, Pencil, RefreshCw } from "lucide-react";

export interface SessionActionMenuItemsProps {
  itemClassName?: string;
  canExport?: boolean;
  exporting?: boolean;
  onExport?: () => void;
  canFork?: boolean;
  forking?: boolean;
  onFork?: () => void;
  canMutate?: boolean;
  onRename?: () => void;
  onCopyId?: () => void;
  archiving?: boolean;
  onArchive?: () => void;
  showRefresh?: boolean;
  onRefresh?: () => void;
  iconSize?: number;
}

export function SessionActionMenuItems({
  itemClassName,
  canExport = false,
  exporting = false,
  onExport,
  canFork = false,
  forking = false,
  onFork,
  canMutate = false,
  onRename,
  onCopyId,
  archiving = false,
  onArchive,
  showRefresh = false,
  onRefresh,
  iconSize = 13,
}: SessionActionMenuItemsProps) {
  return (
    <>
      {canExport ? (
        <button className={itemClassName} disabled={exporting} role="menuitem" type="button" onClick={onExport}>
          <Download size={iconSize} aria-hidden="true" />
          <span>{exporting ? "导出中" : "导出对话记录"}</span>
        </button>
      ) : null}
      {canFork ? (
        <button className={itemClassName} disabled={forking} role="menuitem" type="button" onClick={onFork}>
          <GitBranchPlus size={iconSize} aria-hidden="true" />
          <span>{forking ? "派生中" : "从对话派生"}</span>
        </button>
      ) : null}
      {canMutate ? (
        <button className={itemClassName} role="menuitem" type="button" onClick={onRename}>
          <Pencil size={iconSize} aria-hidden="true" />
          <span>重命名</span>
        </button>
      ) : null}
      {onCopyId ? (
        <button className={itemClassName} role="menuitem" type="button" onClick={onCopyId}>
          <Copy size={iconSize} aria-hidden="true" />
          <span>复制会话 ID</span>
        </button>
      ) : null}
      {canMutate ? (
        <button
          aria-label={archiving ? "正在归档会话" : "归档会话"}
          className={itemClassName}
          data-tone="danger"
          disabled={archiving}
          role="menuitem"
          type="button"
          onClick={onArchive}
        >
          <Archive data-testid="session-archive-icon" size={iconSize} aria-hidden="true" />
          <span>{archiving ? "归档中" : "归档"}</span>
        </button>
      ) : null}
      {showRefresh ? (
        <button className={itemClassName} role="menuitem" type="button" onClick={onRefresh}>
          <RefreshCw size={iconSize} aria-hidden="true" />
          <span>刷新</span>
        </button>
      ) : null}
    </>
  );
}
