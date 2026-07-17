import { ArrowDownToLine, Copy, ExternalLink, Route } from "lucide-react";
import { useCallback, useMemo, type MouseEvent as ReactMouseEvent } from "react";

import {
  useOptionalAppContextMenu,
  type AppContextMenuItem,
} from "@/renderer/providers/AppContextMenuProvider";
import type { KeydexDiffFile } from "./model";
import type { KeydexDiffActions } from "./profiles";

export interface KeydexDiffContextMenuInput {
  readonly file: KeydexDiffFile | null;
  readonly actions: KeydexDiffActions;
  readonly selectionText?: string;
}

export function useKeydexDiffContextMenu({
  file,
  actions,
  selectionText = "",
}: KeydexDiffContextMenuInput) {
  const controller = useOptionalAppContextMenu();
  const items = useMemo(
    () => keydexDiffContextMenuItems({ file, actions, selectionText }),
    [actions, file, selectionText],
  );
  const onContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!controller || items.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    controller.openContextMenu({
      items,
      target: event.currentTarget,
      x: event.clientX,
      y: event.clientY,
    });
  }, [controller, items]);
  return Object.freeze({
    enabled: Boolean(controller && items.length > 0),
    items,
    onContextMenu,
  });
}

export function keydexDiffContextMenuItems({
  file,
  actions,
  selectionText = "",
}: KeydexDiffContextMenuInput): AppContextMenuItem[] {
  if (!file) return [];
  const items: AppContextMenuItem[] = [];
  if (actions.copySelection && selectionText) {
    items.push({
      id: "diff-copy-selection",
      label: "复制选中代码",
      icon: Copy,
      action: () => actions.copySelection!(selectionText),
    });
  }
  if (actions.copyPatch) {
    items.push({
      id: "diff-copy-patch",
      label: "复制原始补丁",
      icon: Copy,
      action: () => actions.copyPatch!(file.patch),
    });
  }
  if (actions.copyPath) {
    items.push({
      id: "diff-copy-path",
      label: "复制文件路径",
      icon: Route,
      action: () => actions.copyPath!(file.displayPath),
    });
  }
  if (actions.openFile) {
    const path = keydexDiffOpenPath(file);
    items.push({
      id: "diff-open-file",
      label: path ? "打开文件" : file.status === "deleted"
        ? "打开文件（文件已删除）"
        : "打开文件（无工作区路径）",
      icon: ExternalLink,
      disabled: !path,
      action: path ? () => actions.openFile!(path) : undefined,
    });
  }
  if (actions.git) {
    items.push({
      id: "diff-apply-git-patch",
      label: actions.git.mode === "stage" ? "暂存选择" : "取消暂存选择",
      icon: ArrowDownToLine,
      disabled: actions.git.busy || !file.selectableForPatch,
      action: file.selectableForPatch && !actions.git.busy
        ? () => actions.git!.applyPatches([file.patch])
        : undefined,
    });
  }
  return items;
}

export function keydexDiffOpenPath(file: KeydexDiffFile): string | null {
  if (file.status === "deleted") return null;
  return file.newOperationPath ?? file.oldOperationPath;
}
