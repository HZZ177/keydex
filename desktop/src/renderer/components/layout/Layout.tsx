import type { CSSProperties, PropsWithChildren } from "react";

import { useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import { useSidebarCollapseMotion } from "@/renderer/hooks/layout/useSidebarCollapseMotion";

import { RightSidebarResizeHandle } from "./RightSidebarResizeHandle";
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
      data-right-sidebar={state.rightSidebarOpen ? "open" : "closed"}
      data-workspace={state.workspaceOpen ? "open" : "closed"}
      data-preview={state.previewOpen ? "open" : "closed"}
      style={
        {
          "--sidebar-width": `${state.sidebarWidth}px`,
          "--right-sidebar-width": `${state.rightSidebarWidth}px`,
          "--workspace-panel-width": `${state.workspaceWidth}px`,
          "--preview-panel-width": `${state.previewWidth}px`,
        } as CSSProperties
      }
    >
      <Titlebar
        title={title}
        sidebarCollapsed={collapsed}
        rightSidebarOpen={state.rightSidebarOpen}
        onToggleSidebar={toggleSidebar}
        onToggleRightSidebar={actions.toggleRightSidebar}
      />

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

        <RightSidebarResizeHandle
          disabled={!state.rightSidebarOpen}
          width={state.rightSidebarWidth}
          onResize={actions.setRightSidebarWidth}
        />
        {state.rightSidebarOpen ? <RightSidebarPanel /> : null}
      </div>
    </div>
  );
}

function RightSidebarPanel() {
  return (
    <aside className={styles.rightSidebar} aria-label="右侧栏">
      <div className={styles.rightSidebarHeader}>
        <h2>右侧栏</h2>
      </div>
      <div className={styles.rightSidebarBody}>
        <div className={styles.rightSidebarTodo}>
          <span>TODO</span>
          <p>这里将承载上下文、预览、工具和会话辅助信息。</p>
        </div>
      </div>
    </aside>
  );
}
