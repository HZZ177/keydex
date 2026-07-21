import { Copy, Minus, Square, X } from "lucide-react";
import type { MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { AppMode } from "@/renderer/components/layout/appMode";
import type { WorkbenchWorkspaceSelectorProps } from "@/renderer/components/layout/workbenchWorkspaceSelector";
import { WorkspaceSelector } from "@/renderer/components/workspace";

import styles from "./Titlebar.module.css";
import { createWindowControls } from "./windowControls";
import type { WindowControls } from "./windowControls";
import { ProjectGitMenu, type ProjectGitMenuProps } from "./ProjectGitMenu";

const APP_ICON_SRC = "/favicon-32.png";
const APP_MODE_OPTIONS: Array<{ mode: AppMode; label: string }> = [
  { mode: "agent", label: "Agent" },
  { mode: "workbench", label: "工作台模式" },
  { mode: "project", label: "项目模式" },
];

export interface TitlebarProps {
  title: string;
  brandLabel?: string;
  windowControls?: WindowControls;
  onBrandClick?: () => void;
  modeSwitch?: {
    currentMode: AppMode;
    onModeChange: (mode: AppMode) => void;
  };
  workbenchWorkspaceSelector?: WorkbenchWorkspaceSelectorProps;
  projectGitMenu?: ProjectGitMenuProps;
}

export function Titlebar({
  title,
  brandLabel,
  modeSwitch,
  workbenchWorkspaceSelector,
  projectGitMenu,
  windowControls,
  onBrandClick,
}: TitlebarProps) {
  const controls = useMemo(() => windowControls ?? createWindowControls(), [windowControls]);
  const [isMaximized, setIsMaximized] = useState(false);
  const titlebarWorkspaceSelector =
    modeSwitch?.currentMode === "workbench" ? workbenchWorkspaceSelector : undefined;

  const syncMaximizedState = useCallback(async () => {
    const result = await controls.isMaximized();
    if (result.ok && typeof result.value === "boolean") {
      setIsMaximized(result.value);
    }
  }, [controls]);

  useEffect(() => {
    let disposed = false;

    void (async () => {
      const result = await controls.isMaximized();
      if (!disposed && result.ok && typeof result.value === "boolean") {
        setIsMaximized(result.value);
      }
    })();

    const subscription = controls.onMaximizedChange((maximized) => {
      if (!disposed) {
        setIsMaximized(maximized);
      }
    });

    return () => {
      disposed = true;
      void subscription.then((result) => result.unlisten?.());
    };
  }, [controls]);

  const handleDrag = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || isInteractiveTitlebarTarget(event.target) || isNativeDragRegionTarget(event.target)) {
      return;
    }
    void controls.startDragging();
  };

  const handleToggleMaximize = async () => {
    const result = await controls.toggleMaximize();
    if (result.ok) {
      await syncMaximizedState();
    }
  };

  const handleDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if (isInteractiveTitlebarTarget(event.target)) {
      return;
    }
    void handleToggleMaximize();
  };

  const maximizeLabel = isMaximized ? "还原窗口" : "最大化窗口";

  return (
    <header
      className={styles.titlebar}
      data-testid="titlebar"
      onMouseDown={handleDrag}
      onDoubleClick={handleDoubleClick}
    >
      <div className={styles.left}>
        {onBrandClick ? (
          <button
            className={styles.brandMark}
            type="button"
            aria-label="Keydex"
            title="Keydex"
            data-titlebar-interactive="true"
            onClick={onBrandClick}
          >
            <img alt="" draggable={false} src={APP_ICON_SRC} />
          </button>
        ) : (
          <div className={styles.brandMark} role="img" aria-label="Keydex">
            <img alt="" draggable={false} src={APP_ICON_SRC} />
          </div>
        )}
        {brandLabel ? <span className={styles.brandLabel}>{brandLabel}</span> : null}
        {modeSwitch ? <ModeSwitch modeSwitch={modeSwitch} /> : null}
        {projectGitMenu ? <ProjectGitMenu {...projectGitMenu} /> : null}
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
              showHoverHint={false}
            />
          </div>
        ) : null}
      </div>

      <div className={styles.dragRegion} data-tauri-drag-region>
        <div className={styles.title}>{title}</div>
      </div>

      <div className={styles.right}>
        <div
          className={styles.rightDragRegion}
          data-testid="titlebar-right-drag-region"
          data-tauri-drag-region
        />
        <div className={styles.windowControls} role="group" aria-label="窗口控制" data-titlebar-interactive="true">
          <button
            className={styles.windowControl}
            data-icon="minimize"
            type="button"
            aria-label="最小化"
            title="最小化"
            onClick={() => void controls.minimize()}
          >
            <Minus size={15} strokeWidth={1.8} />
          </button>
          <button
            className={styles.windowControl}
            data-icon={isMaximized ? "restore" : "maximize"}
            type="button"
            aria-label={maximizeLabel}
            title={maximizeLabel}
            onClick={() => void handleToggleMaximize()}
          >
            {isMaximized ? <Copy size={14} strokeWidth={1.8} /> : <Square size={14} strokeWidth={1.8} />}
          </button>
          <button
            className={`${styles.windowControl} ${styles.closeControl}`}
            data-icon="close"
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={() => void controls.close()}
          >
            <X size={15} strokeWidth={1.8} />
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
      {APP_MODE_OPTIONS.map(({ mode, label }) => {
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
            {label}
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

function isNativeDragRegionTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("[data-tauri-drag-region]"));
}
