import type { CSSProperties, PropsWithChildren } from "react";

import { useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import { useSidebarCollapseMotion } from "@/renderer/hooks/layout/useSidebarCollapseMotion";

import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { Sider } from "./Sider";
import { Titlebar } from "./Titlebar";
import styles from "./Layout.module.css";
import type { SiderEntry } from "./Sider";

export interface LayoutProps extends PropsWithChildren {
  title?: string;
  projects?: SiderEntry[];
  conversations?: SiderEntry[];
  activePath?: string;
  contentMode?: "reading" | "full";
  onNavigate?: (path: string) => void;
}

export function Layout({
  children,
  title = "Codex",
  projects,
  conversations,
  activePath,
  contentMode = "reading",
  onNavigate,
}: LayoutProps) {
  const { state, actions } = useLayoutState();
  const collapsed = state.sidebarCollapsed;
  const { sidebarMotion, toggleSidebar } = useSidebarCollapseMotion(actions.toggleSidebar);

  return (
    <div
      className={styles.shell}
      data-testid="app-shell"
      data-sidebar={collapsed ? "collapsed" : "expanded"}
      data-sidebar-motion={sidebarMotion ? "true" : "false"}
      data-workspace={state.workspaceOpen ? "open" : "closed"}
      data-preview={state.previewOpen ? "open" : "closed"}
      style={
        {
          "--sidebar-width": `${state.sidebarWidth}px`,
          "--workspace-panel-width": `${state.workspaceWidth}px`,
          "--preview-panel-width": `${state.previewWidth}px`,
        } as CSSProperties
      }
    >
      <Titlebar title={title} sidebarCollapsed={collapsed} onToggleSidebar={toggleSidebar} />

      <div className={styles.body}>
        <Sider
          activePath={activePath}
          collapsed={collapsed}
          projects={projects}
          conversations={conversations}
          onNavigate={onNavigate}
        />
        <SidebarResizeHandle
          disabled={collapsed}
          width={state.sidebarWidth}
          onResize={actions.setSidebarWidth}
        />

        <section className={styles.content} aria-label="主内容区">
          <div className={styles.readingColumn} data-content={contentMode}>
            {children}
          </div>
        </section>
      </div>
    </div>
  );
}
