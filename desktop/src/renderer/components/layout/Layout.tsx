import type { CSSProperties, PropsWithChildren } from "react";

import { useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";

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

  return (
    <div
      className={styles.shell}
      data-testid="app-shell"
      data-sidebar={collapsed ? "collapsed" : "expanded"}
      data-workspace={state.workspaceOpen ? "open" : "closed"}
      data-preview={state.previewOpen ? "open" : "closed"}
      style={
        {
          "--workspace-panel-width": `${state.workspaceWidth}px`,
          "--preview-panel-width": `${state.previewWidth}px`,
        } as CSSProperties
      }
    >
      <Titlebar title={title} sidebarCollapsed={collapsed} onToggleSidebar={actions.toggleSidebar} />

      <div className={styles.body}>
        <Sider
          activePath={activePath}
          collapsed={collapsed}
          projects={projects}
          conversations={conversations}
          onNavigate={onNavigate}
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
