import { Globe } from "lucide-react";
import type { ReactNode } from "react";

import { AppTooltipLayer } from "@/renderer/components/tooltip";

import type { BrowserProfileMode, BrowserSurfaceRef } from "../domain";
import type { BrowserNavigationFailure } from "../runtime/BrowserPolicyCoordinator";
import { BrowserErrorView } from "./BrowserErrorView";
import { BrowserSurfacePlaceholder } from "./BrowserSurfacePlaceholder";
import { BrowserSurfaceOverlay } from "./BrowserSurfaceOverlay";
import { BrowserToolbar, type BrowserToolbarProps } from "./BrowserToolbar";

import styles from "./BrowserPanel.module.css";

export interface BrowserPanelProps extends Omit<BrowserToolbarProps, "profileMode"> {
  readonly active: boolean;
  readonly empty?: boolean;
  readonly error?: BrowserNavigationFailure | null;
  readonly profileMode: BrowserProfileMode;
  readonly surfaceReady: boolean;
  readonly surface: BrowserSurfaceRef | null;
  readonly title: string;
  readonly toolbarAccessory?: ReactNode;
  readonly resourceState?: React.ComponentProps<typeof BrowserSurfacePlaceholder>["resourceState"];
  readonly surfaceOverlay?: ReactNode;
  onRetry(): void;
}

export function BrowserPanel({
  active,
  empty = false,
  error = null,
  profileMode,
  surfaceReady,
  surface,
  title,
  toolbarAccessory,
  resourceState,
  surfaceOverlay,
  onRetry,
  ...toolbarProps
}: BrowserPanelProps) {
  return (
    <section
      aria-label={title || "浏览器"}
      className={styles.panel}
      data-browser-panel="true"
      data-profile={profileMode}
    >
      <AppTooltipLayer
        defaultPlacement="top"
        delayMs={260}
        ownerId="browser-panel"
        scopeSelector="[data-browser-chrome-tooltips='true']"
      />
      <BrowserToolbar {...toolbarProps} profileMode={profileMode} />
      <div className={styles.toolbarAccessory}>{toolbarAccessory}</div>
      <div className={styles.stage} data-ready={surfaceReady ? "true" : "false"}>
        {toolbarProps.loading ? <div aria-hidden="true" className={styles.loadingTrack}><span /></div> : null}
        <BrowserSurfacePlaceholder
          active={active && surfaceReady && !error && !empty}
          surface={surface}
          resourceState={resourceState}
          className={styles.surface}
        />
        {surfaceOverlay ? (
          <BrowserSurfaceOverlay surface={surface}>{surfaceOverlay}</BrowserSurfaceOverlay>
        ) : null}
        {error ? <BrowserErrorView {...error} onRetry={onRetry} /> : null}
        {surfaceReady && empty && !error ? (
          <div className={styles.emptyState} role="status">
            <Globe aria-hidden="true" size={24} strokeWidth={1.6} />
            <strong>开始浏览</strong>
            <span>在顶部输入 URL 或搜索内容</span>
          </div>
        ) : null}
        {!surfaceReady && !error ? (
          <div className={styles.startingState} role="status">
            <Globe aria-hidden="true" size={20} />
            <span>正在启动浏览器…</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
