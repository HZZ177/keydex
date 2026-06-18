import { Maximize2, Minus, MoreHorizontal, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import type { MouseEvent } from "react";
import { useMemo } from "react";

import styles from "./Titlebar.module.css";
import { createWindowControls } from "./windowControls";
import type { WindowControls } from "./windowControls";

export interface TitlebarProps {
  title: string;
  sidebarCollapsed: boolean;
  onToggleSidebar(): void;
  windowControls?: WindowControls;
}

export function Titlebar({ title, sidebarCollapsed, onToggleSidebar, windowControls }: TitlebarProps) {
  const controls = useMemo(() => windowControls ?? createWindowControls(), [windowControls]);
  const ToggleIcon = sidebarCollapsed ? PanelLeftOpen : PanelLeftClose;

  const handleDrag = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }
    void controls.startDragging();
  };

  const handleDoubleClick = () => {
    void controls.toggleMaximize();
  };

  return (
    <header className={styles.titlebar} data-testid="titlebar">
      <div className={styles.left}>
        <button
          className={styles.iconButton}
          type="button"
          aria-label={sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏"}
          onClick={onToggleSidebar}
        >
          <ToggleIcon size={17} strokeWidth={2} />
        </button>
        <div className={styles.navGhost} aria-hidden="true">
          <span />
          <span />
        </div>
      </div>

      <div
        className={styles.dragRegion}
        data-tauri-drag-region
        onMouseDown={handleDrag}
        onDoubleClick={handleDoubleClick}
      >
        <div className={styles.title}>{title}</div>
      </div>

      <div className={styles.actions}>
        <button className={styles.iconButton} type="button" aria-label="更多">
          <MoreHorizontal size={17} strokeWidth={2} />
        </button>
        <button className={styles.windowButton} type="button" aria-label="最小化" onClick={() => void controls.minimize()}>
          <Minus size={15} strokeWidth={2} />
        </button>
        <button
          className={styles.windowButton}
          type="button"
          aria-label="最大化"
          onClick={() => void controls.toggleMaximize()}
        >
          <Maximize2 size={14} strokeWidth={2} />
        </button>
        <button className={styles.closeButton} type="button" aria-label="关闭" onClick={() => void controls.close()}>
          <X size={15} strokeWidth={2} />
        </button>
      </div>
    </header>
  );
}
