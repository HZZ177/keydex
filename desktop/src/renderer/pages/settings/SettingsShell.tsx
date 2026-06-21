import { ArrowLeft, BarChart3, Moon, Search, Settings2, Sun, type LucideIcon } from "lucide-react";
import type { CSSProperties, PropsWithChildren } from "react";
import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { SidebarResizeHandle } from "@/renderer/components/layout/SidebarResizeHandle";
import { Titlebar } from "@/renderer/components/layout/Titlebar";
import { useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import { useSidebarCollapseMotion } from "@/renderer/hooks/layout/useSidebarCollapseMotion";
import { useTheme } from "@/renderer/providers/ThemeProvider";

import styles from "./SettingsShell.module.css";

export type SettingsSection = "model" | "usage";

const settingsItems = [
  { id: "model", label: "模型配置", path: "/settings/model", icon: Settings2 },
  { id: "usage", label: "用量统计", path: "/settings/usage", icon: BarChart3 },
] satisfies Array<{ id: SettingsSection; label: string; path: string; icon: LucideIcon }>;

export function SettingsShell({
  activeSection,
  children,
}: PropsWithChildren<{ activeSection: SettingsSection }>) {
  const navigate = useNavigate();
  const location = useLocation();
  const { state, actions } = useLayoutState();
  const { theme, toggleTheme } = useTheme();
  const ThemeIcon = theme === "dark" ? Sun : Moon;
  const routeState = location.state as { from?: string } | null;
  const from = routeState?.from && !routeState.from.startsWith("/settings") ? routeState.from : "/guid";
  const [query, setQuery] = useState("");
  const visibleItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return settingsItems;
    }
    return settingsItems.filter((item) => item.label.toLowerCase().includes(keyword));
  }, [query]);
  const { sidebarMotion, toggleSidebar } = useSidebarCollapseMotion(actions.toggleSidebar);

  const navigateSettings = (path: string) => {
    void navigate(path, { state: { from } });
  };

  return (
    <div
      className={styles.shell}
      data-testid="settings-shell"
      data-sidebar={state.sidebarCollapsed ? "collapsed" : "expanded"}
      data-sidebar-motion={sidebarMotion ? "true" : "false"}
      style={{ "--sidebar-width": `${state.sidebarWidth}px` } as CSSProperties}
    >
      <Titlebar title="" sidebarCollapsed={state.sidebarCollapsed} onToggleSidebar={toggleSidebar} />
      <main className={styles.body}>
        <aside className={styles.sidebar} aria-label="设置菜单" data-testid="settings-sidebar">
          <button className={styles.backButton} type="button" onClick={() => void navigate(from)}>
            <ArrowLeft size={17} strokeWidth={2} />
            <span>返回应用</span>
          </button>

          <label className={styles.searchBox}>
            <Search size={17} strokeWidth={2} />
            <input
              aria-label="搜索设置"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索设置..."
              value={query}
            />
          </label>

          <nav className={styles.menu} aria-label="设置导航">
            <section className={styles.menuGroup}>
              <div className={styles.groupLabel}>个人</div>
              {visibleItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    className={styles.menuItem}
                    data-active={activeSection === item.id ? "true" : "false"}
                    key={item.id}
                    onClick={() => navigateSettings(item.path)}
                    type="button"
                  >
                    <Icon size={17} strokeWidth={2} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
              {visibleItems.length === 0 ? <div className={styles.empty}>没有匹配设置</div> : null}
            </section>
          </nav>

          <div className={styles.footer}>
            <button
              aria-label="切换主题"
              className={styles.themeButton}
              title={state.sidebarCollapsed ? "切换主题" : ""}
              type="button"
              onClick={toggleTheme}
            >
              <ThemeIcon size={17} strokeWidth={2} />
              <span>{theme === "dark" ? "浅色" : "深色"}</span>
            </button>
          </div>
        </aside>
        <SidebarResizeHandle
          disabled={state.sidebarCollapsed}
          width={state.sidebarWidth}
          onResize={actions.setSidebarWidth}
        />

        <section className={styles.content} aria-label="设置内容">
          {children}
        </section>
      </main>
    </div>
  );
}
