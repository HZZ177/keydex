import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Layout, resetLayoutUiStateCacheForTests } from "@/renderer/components/layout/Layout";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { ActiveProjectProvider } from "@/renderer/providers/ActiveProjectProvider";
import {
  ActiveProjectCoordinatorProvider,
  usePublishActiveProjectDiscovery,
} from "@/renderer/providers/ActiveProjectCoordinatorProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";

vi.mock("@/renderer/features/git/components/GitToolWindow", () => ({
  GitToolWindow: ({ maximized }: { maximized?: boolean }) => (
    <div data-testid="git-tool-window" data-layout={maximized ? "maximized" : "split"}>Git panel</div>
  ),
}));

afterEach(() => {
  cleanup();
  resetLayoutUiStateCacheForTests();
});

describe("Git primary content host", () => {
  it("places Git directly after Search and opens it as the exclusive primary surface", () => {
    const onNavigate = vi.fn();
    const onContentUnmount = vi.fn();
    renderLoadedProject(
      <Layout contentMode="full" conversations={[]} onNavigate={onNavigate}>
        <ContentLifecycleSentinel onUnmount={onContentUnmount} />
      </Layout>,
    );

    const navigation = screen.getByRole("navigation", { name: "主导航" });
    const buttons = within(navigation).getAllByRole("button");
    const searchIndex = buttons.findIndex((button) => button.textContent === "搜索");
    const gitIndex = buttons.findIndex((button) => button.textContent === "Git");
    expect(gitIndex).toBe(searchIndex + 1);

    const gitEntry = within(navigation).getByRole("button", { name: "Git" });
    expect(gitEntry.hasAttribute("disabled")).toBe(false);
    expect(gitEntry.querySelectorAll("circle")).toHaveLength(3);
    fireEvent.click(gitEntry);

    const shell = screen.getByTestId("app-shell");
    expect(shell.dataset.primarySurface).toBe("git");
    expect(shell.dataset.rightSidebar).toBe("closed");
    expect(shell.dataset.rightSidebarEnabled).toBe("false");
    expect(gitEntry.getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("git-tool-window").dataset.layout).toBe("maximized");
    expect(screen.getByText("conversation content").closest("[hidden]")).not.toBeNull();
    expect(onContentUnmount).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab", { name: "Git" })).toBeNull();

    fireEvent.click(within(navigation).getByRole("button", { name: "新对话" }));
    expect(shell.dataset.primarySurface).toBe("content");
    expect(screen.getByText("conversation content")).not.toBeNull();
    expect(screen.getByText("conversation content").closest("[hidden]")).toBeNull();
    expect(onContentUnmount).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith("/guid?focus=prompt");
  });

  it("keeps the system Git entry visible but disabled without a loaded project", () => {
    render(
      <ThemeProvider>
        <LayoutStateProvider>
          <ActiveProjectProvider discovery={{ project: null }}>
            <Layout contentMode="full" conversations={[]}>
              <div>conversation content</div>
            </Layout>
          </ActiveProjectProvider>
        </LayoutStateProvider>
      </ThemeProvider>,
    );

    const gitEntry = screen.getByRole("button", { name: "Git" });
    expect(gitEntry.hasAttribute("disabled")).toBe(true);
    fireEvent.click(gitEntry);
    expect(screen.getByTestId("app-shell").dataset.primarySurface).toBe("content");
    expect(screen.getByText("conversation content")).not.toBeNull();
  });

  it("keeps the Agent project publisher mounted while Git owns the visible content area", async () => {
    const onContentUnmount = vi.fn();
    render(
      <ThemeProvider>
        <LayoutStateProvider>
          <ActiveProjectCoordinatorProvider>
            <Layout appMode="agent" contentMode="full" conversations={[]}>
              <AgentProjectPublisher onUnmount={onContentUnmount} />
            </Layout>
          </ActiveProjectCoordinatorProvider>
        </LayoutStateProvider>
      </ThemeProvider>,
    );

    const gitEntry = screen.getByRole("button", { name: "Git" });
    await waitFor(() => expect(gitEntry.hasAttribute("disabled")).toBe(false));
    fireEvent.click(gitEntry);

    await waitFor(() => expect(screen.getByTestId("app-shell").dataset.primarySurface).toBe("git"));
    expect(screen.getByText("agent project publisher").closest("[hidden]")).not.toBeNull();
    expect(onContentUnmount).not.toHaveBeenCalled();
  });

  it("routes the titlebar shortcut to the same primary Git surface", () => {
    renderLoadedProject(
      <Layout appMode="workbench" contentMode="full" conversations={[]}>
        <div>conversation content</div>
      </Layout>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Git：读取中" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "打开 Git 面板" }));

    expect(screen.getByTestId("app-shell").dataset.primarySurface).toBe("git");
    expect(screen.getByTestId("git-tool-window")).not.toBeNull();
    expect(screen.queryByRole("tab", { name: "Git" })).toBeNull();
  });
});

function renderLoadedProject(ui: React.ReactElement) {
  return render(
    <ThemeProvider>
      <LayoutStateProvider>
        <ActiveProjectProvider
          discovery={{
            project: { workspaceId: "workspace-1", projectPath: "D:/repo", name: "repo" },
            repoRoots: [{ id: "repo-1", rootPath: "D:/repo", displayPath: ".", kind: "workspace" }],
          }}
        >
          {ui}
        </ActiveProjectProvider>
      </LayoutStateProvider>
    </ThemeProvider>,
  );
}

function ContentLifecycleSentinel({ onUnmount }: { onUnmount: () => void }) {
  useEffect(() => onUnmount, [onUnmount]);
  return <div>conversation content</div>;
}

const AGENT_PROJECT_DISCOVERY = {
  project: { workspaceId: "workspace-agent", projectPath: "D:/agent-repo", name: "agent-repo" },
  repoRoots: [{ id: "repo-agent", rootPath: "D:/agent-repo", displayPath: ".", kind: "workspace" as const }],
};

function AgentProjectPublisher({ onUnmount }: { onUnmount: () => void }) {
  usePublishActiveProjectDiscovery("agent-test", AGENT_PROJECT_DISCOVERY);
  useEffect(() => onUnmount, [onUnmount]);
  return <div>agent project publisher</div>;
}
