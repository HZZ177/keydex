import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { MouseEvent } from "react";
import { useMemo } from "react";

import styles from "./Titlebar.module.css";
import { createWindowControls } from "./windowControls";
import type { WindowControls } from "./windowControls";

export interface TitlebarProps {
  title: string;
  sidebarCollapsed: boolean;
  rightSidebarOpen?: boolean;
  onToggleSidebar(): void;
  onToggleRightSidebar?: () => void;
  windowControls?: WindowControls;
}

export function Titlebar({
  title,
  sidebarCollapsed,
  rightSidebarOpen = false,
  onToggleSidebar,
  onToggleRightSidebar,
  windowControls,
}: TitlebarProps) {
  const controls = useMemo(() => windowControls ?? createWindowControls(), [windowControls]);

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
          className={`${styles.iconButton} ${styles.sidebarToggle}`}
          data-state={sidebarCollapsed ? "collapsed" : "expanded"}
          data-icon={sidebarCollapsed ? "panel-left-open" : "panel-left-close"}
          type="button"
          aria-label={sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏"}
          onClick={onToggleSidebar}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen size={17} strokeWidth={2.1} />
          ) : (
            <PanelLeftClose size={17} strokeWidth={2.1} />
          )}
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

      <div className={styles.right}>
        <button
          className={`${styles.iconButton} ${styles.sidebarToggle}`}
          data-state={rightSidebarOpen ? "expanded" : "collapsed"}
          data-icon={rightSidebarOpen ? "panel-right-close" : "panel-right-open"}
          type="button"
          aria-label={rightSidebarOpen ? "折叠右侧栏" : "展开右侧栏"}
          aria-pressed={rightSidebarOpen}
          onClick={onToggleRightSidebar}
        >
          {rightSidebarOpen ? (
            <PanelRightClose size={17} strokeWidth={2.1} />
          ) : (
            <PanelRightOpen size={17} strokeWidth={2.1} />
          )}
        </button>
      </div>
    </header>
  );
}
