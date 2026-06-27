import { Minus, Square, X } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import type { AppMode } from "@/renderer/components/layout/appMode";
import type { WorkbenchWorkspaceSelectorProps } from "@/renderer/components/layout/workbenchWorkspaceSelector";
import { WorkspaceSelector } from "@/renderer/components/workspace";

import styles from "./Titlebar.module.css";
import { createWindowControls } from "./windowControls";
import type { WindowControls } from "./windowControls";

const APP_ICON_SRC = "/favicon-32.png";

export interface TitlebarProps {
  title: string;
  windowControls?: WindowControls;
  modeSwitch?: {
    currentMode: AppMode;
    onModeChange: (mode: AppMode) => void;
  };
  workbenchWorkspaceSelector?: WorkbenchWorkspaceSelectorProps;
}

export function Titlebar({
  title,
  modeSwitch,
  workbenchWorkspaceSelector,
  windowControls,
}: TitlebarProps) {
  const controls = useMemo(() => windowControls ?? createWindowControls(), [windowControls]);
  const titlebarWorkspaceSelector =
    modeSwitch?.currentMode === "workbench" ? workbenchWorkspaceSelector : undefined;

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
        {modeSwitch ? <ModeSwitch modeSwitch={modeSwitch} /> : null}
        {titlebarWorkspaceSelector ? (
          <div
            className={styles.workbenchWorkspaceSelector}
            data-testid="workbench-titlebar-workspace-selector"
            data-titlebar-interactive="true"
          >
            <WorkspaceSelector
              {...titlebarWorkspaceSelector}
              allowProjectFreeChat={false}
              placement="bottom"
              variant="titlebar"
            />
          </div>
        ) : null}
      </div>

      <div className={styles.dragRegion} data-tauri-drag-region>
        <div className={styles.title}>{title}</div>
      </div>

      <div className={styles.right} data-testid="titlebar-right-drag-region">
        <div className={styles.windowControls} role="group" aria-label="窗口控制" data-titlebar-interactive="true">
          <button
            className={styles.windowControl}
            data-icon="minimize"
            type="button"
            aria-label="最小化"
            title="最小化"
            onClick={() => void controls.minimize()}
          >
            <Minus size={13} strokeWidth={1.8} />
          </button>
          <button
            className={styles.windowControl}
            data-icon="maximize"
            type="button"
            aria-label="最大化或还原"
            title="最大化或还原"
            onClick={() => void controls.toggleMaximize()}
          >
            <Square size={12} strokeWidth={1.8} />
          </button>
          <button
            className={`${styles.windowControl} ${styles.closeControl}`}
            data-icon="close"
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={() => void controls.close()}
          >
            <X size={13} strokeWidth={1.8} />
          </button>
        </div>
      </div>
    </header>
  );
}

function ModeSwitch({ modeSwitch }: { modeSwitch: NonNullable<TitlebarProps["modeSwitch"]> }) {
  const [visualMode, setVisualMode] = useState<AppMode>(modeSwitch.currentMode);

  useEffect(() => {
    setVisualMode(modeSwitch.currentMode);
  }, [modeSwitch.currentMode]);

  const switchMode = (mode: AppMode) => {
    if (mode === visualMode) {
      return;
    }
    setVisualMode(mode);
    modeSwitch.onModeChange(mode);
  };

  return (
    <div
      className={styles.modeSwitch}
      role="group"
      aria-label="应用模式"
      data-mode={visualMode}
      data-titlebar-interactive="true"
      data-testid="app-mode-switch"
    >
      {(["agent", "workbench"] as const).map((mode) => {
        const active = visualMode === mode;
        return (
          <button
            className={styles.modeButton}
            type="button"
            aria-pressed={active}
            data-active={active ? "true" : "false"}
            key={mode}
            onClick={() => switchMode(mode)}
          >
            {mode === "agent" ? "Agent" : "工作台模式"}
          </button>
        );
      })}
    </div>
  );
}

function isInteractiveTitlebarTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(target.closest("button, a, input, textarea, select, [role='button'], [data-titlebar-interactive='true']"))
  );
}
