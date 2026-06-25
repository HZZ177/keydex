import { Maximize2, Minus, X } from "lucide-react";
import type { MouseEvent } from "react";
import { useMemo } from "react";

import styles from "./Titlebar.module.css";
import { createWindowControls } from "./windowControls";
import type { WindowControls } from "./windowControls";

const APP_ICON_SRC = "/favicon-32.png";

export interface TitlebarProps {
  title: string;
  windowControls?: WindowControls;
}

export function Titlebar({
  title,
  windowControls,
}: TitlebarProps) {
  const controls = useMemo(() => windowControls ?? createWindowControls(), [windowControls]);

  const handleDrag = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || isInteractiveTitlebarTarget(event.target)) {
      return;
    }
    void controls.startDragging();
  };

  const handleDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if (isInteractiveTitlebarTarget(event.target)) {
      return;
    }
    void controls.toggleMaximize();
  };

  return (
    <header
      className={styles.titlebar}
      data-testid="titlebar"
      onMouseDown={handleDrag}
      onDoubleClick={handleDoubleClick}
    >
      <div className={styles.left}>
        <div className={styles.brandMark} role="img" aria-label="Keydex">
          <img alt="" draggable={false} src={APP_ICON_SRC} />
        </div>
        <div className={styles.navGhost} aria-hidden="true">
          <span />
          <span />
        </div>
      </div>

      <div className={styles.dragRegion} data-tauri-drag-region>
        <div className={styles.title}>{title}</div>
      </div>

      <div className={styles.right} data-titlebar-interactive="true">
        <div className={styles.windowControls} role="group" aria-label="窗口控制">
          <button
            className={styles.windowControl}
            data-icon="minimize"
            type="button"
            aria-label="最小化"
            title="最小化"
            onClick={() => void controls.minimize()}
          >
            <Minus size={15} strokeWidth={2.1} />
          </button>
          <button
            className={styles.windowControl}
            data-icon="maximize"
            type="button"
            aria-label="最大化或还原"
            title="最大化或还原"
            onClick={() => void controls.toggleMaximize()}
          >
            <Maximize2 size={14} strokeWidth={2.1} />
          </button>
          <button
            className={`${styles.windowControl} ${styles.closeControl}`}
            data-icon="close"
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={() => void controls.close()}
          >
            <X size={15} strokeWidth={2.1} />
          </button>
        </div>
      </div>
    </header>
  );
}

function isInteractiveTitlebarTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("button, a, input, textarea, select, [role='button'], [data-titlebar-interactive='true']"))
  );
}
