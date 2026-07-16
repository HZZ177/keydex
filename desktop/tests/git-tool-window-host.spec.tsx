import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Layout, resetLayoutUiStateCacheForTests, syncGitToolPanelForScope } from "@/renderer/components/layout/Layout";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { ActiveProjectProvider } from "@/renderer/providers/ActiveProjectProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";

afterEach(() => {
  cleanup();
  resetLayoutUiStateCacheForTests();
});

describe("Git right sidebar tool window host", () => {
  it("carries the singleton Git panel into a new route scope and removes it globally on close", () => {
    const blank = {
      activePanelId: null,
      panelOrder: [],
      filePanelIds: [],
      filePanels: {},
      conversationPanelIds: [],
      conversationPanels: {},
      reviewPanelIds: [],
      reviewPanels: {},
      toolPanelIds: [],
      toolPanels: {},
      initialPanelIds: [],
      nextPanelSeq: 0,
    };
    const opened = syncGitToolPanelForScope(blank, true, true);
    expect(opened.activePanelId).toBe("right-sidebar:git:singleton");
    expect(opened.toolPanelIds).toEqual(["right-sidebar:git:singleton"]);

    const migrated = syncGitToolPanelForScope({ ...blank }, true, true);
    expect(migrated.toolPanels["right-sidebar:git:singleton"]).toMatchObject({ type: "git" });
    expect(syncGitToolPanelForScope(migrated, false, false).toolPanelIds).toEqual([]);
  });

  it("opens one project-scoped Git tab and reuses the singleton", () => {
    render(
      <ThemeProvider>
        <LayoutStateProvider>
          <ActiveProjectProvider
            discovery={{
              project: { workspaceId: "workspace-1", projectPath: "D:/repo", name: "repo" },
              repoRoots: [
                {
                  id: "repo-1",
                  rootPath: "D:/repo",
                  displayPath: ".",
                  kind: "workspace",
                },
              ],
            }}
          >
            <Layout contentMode="full">
              <div>content</div>
            </Layout>
          </ActiveProjectProvider>
        </LayoutStateProvider>
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    fireEvent.click(within(screen.getByTestId("right-sidebar-initial-page")).getByRole("button", { name: "Git" }));

    expect(screen.getAllByRole("tab", { name: "Git" })).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Git" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("app-shell").dataset.rightSidebarMode).toBe("maximized");
    expect(screen.getByTestId("git-tool-window").dataset.layout).toBe("maximized");

    fireEvent.click(document.querySelector<HTMLButtonElement>('button[data-icon="minimize-2"]')!);
    expect(screen.getByTestId("app-shell").dataset.rightSidebarMode).toBe("split");

    fireEvent.click(screen.getByRole("button", { name: "关闭侧边栏窗口 Git" }));
    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    fireEvent.click(within(screen.getByTestId("right-sidebar-initial-page")).getByRole("button", { name: "Git" }));
    expect(screen.getByTestId("app-shell").dataset.rightSidebarMode).toBe("split");

    fireEvent.click(screen.getByRole("button", { name: "新建侧边栏页面" }));
    fireEvent.click(within(screen.getByTestId("right-sidebar-initial-page")).getByRole("button", { name: "Git" }));

    expect(screen.getAllByRole("tab", { name: "Git" })).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Git" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps Git unavailable when no project is loaded", () => {
    render(
      <ThemeProvider>
        <LayoutStateProvider>
          <ActiveProjectProvider discovery={{ project: null }}>
            <Layout contentMode="full">
              <div>content</div>
            </Layout>
          </ActiveProjectProvider>
        </LayoutStateProvider>
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    expect(within(screen.getByTestId("right-sidebar-initial-page")).queryByRole("button", { name: "Git" })).toBeNull();
  });

  it("opens the same Git tool window from the global titlebar in workbench mode", () => {
    render(
      <ThemeProvider>
        <LayoutStateProvider>
          <ActiveProjectProvider
            discovery={{
              project: { workspaceId: "workspace-1", projectPath: "D:/repo", name: "repo" },
              repoRoots: [{ id: "repo-1", rootPath: "D:/repo", displayPath: ".", kind: "workspace" }],
            }}
          >
            <Layout appMode="workbench" contentMode="full">
              <div>content</div>
            </Layout>
          </ActiveProjectProvider>
        </LayoutStateProvider>
      </ThemeProvider>,
    );

    expect(screen.getByTestId("app-shell").dataset.rightSidebarEnabled).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Git：读取中" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "打开 Git 工具窗" }));

    expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("open");
    expect(screen.getAllByRole("tab", { name: "Git" })).toHaveLength(1);
  });
});
