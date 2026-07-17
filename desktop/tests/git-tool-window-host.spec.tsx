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
import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import type { Workspace } from "@/types/protocol";

vi.mock("@/renderer/features/git/components/GitToolWindow", () => ({
  GitToolWindow: ({ maximized, project, projectSelector }: MockGitToolWindowProps) => {
    const targetWorkspace = projectSelector?.workspaces.at(-1);
    return (
      <div data-testid="git-tool-window" data-layout={maximized ? "maximized" : "split"}>
        Git panel
        <span data-testid="git-tool-project">
          {project && project.status !== "none" ? project.workspaceId : "none"}
        </span>
        {projectSelector ? (
          <button
            type="button"
            disabled={!targetWorkspace}
            onClick={() => targetWorkspace && projectSelector.onSelectWorkspace?.(targetWorkspace)}
          >
            切换 Git 项目
          </button>
        ) : null}
      </div>
    );
  },
}));

interface MockGitToolWindowProps {
  maximized?: boolean;
  project?: { status: string; workspaceId?: string } | null;
  projectSelector?: {
    workspaces: Workspace[];
    onSelectWorkspace?: (workspace: Workspace) => void;
  };
}

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
    expect(gitEntry.querySelector("svg")).not.toBeNull();
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
    expect(screen.getByTestId("git-tool-window").closest("[hidden]")).not.toBeNull();
    expect(onNavigate).toHaveBeenCalledWith("/guid?focus=prompt");
  });

  it("navigates the routed Agent shell into the first-level Git page", () => {
    const onNavigate = vi.fn();
    renderLoadedProject(
      <Layout
        appMode="agent"
        contentMode="full"
        conversations={[]}
        routePrimarySurface="content"
        routeGitNavigation
        onNavigate={onNavigate}
      >
        <div>conversation content</div>
      </Layout>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Git" }));

    expect(onNavigate).toHaveBeenCalledWith("/git/workspace-1");
    expect(screen.getByTestId("app-shell").dataset.primarySurface).toBe("content");
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

  it("reuses the workbench workspace selection contract in the Git header", () => {
    const current = workspace("workspace-1", "repo");
    const target = workspace("workspace-2", "other-repo");
    const onSelectWorkspace = vi.fn();
    renderLoadedProject(
      <Layout
        appMode="workbench"
        contentMode="full"
        conversations={[]}
        workbenchWorkspaceSelector={{
          value: { type: "workspace", workspace: current },
          workspaces: [current, target],
          onSelectWorkspace,
        }}
      >
        <div>conversation content</div>
      </Layout>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Git" }));
    fireEvent.click(screen.getByRole("button", { name: "切换 Git 项目" }));
    expect(onSelectWorkspace).toHaveBeenCalledWith(target);
  });

  it("switches only the Agent Git project and restores the conversation project after leaving Git", async () => {
    const target = workspace("workspace-target", "target-repo");
    const runtime = {
      ...runtimeBridge,
      workspaces: {
        ...runtimeBridge.workspaces,
        list: vi.fn().mockResolvedValue({
          list: [workspace("workspace-agent", "agent-repo"), target],
          total: 2,
        }),
      },
    } as unknown as RuntimeBridge;
    render(
      <ThemeProvider>
        <LayoutStateProvider>
          <ActiveProjectCoordinatorProvider>
            <Layout
              appMode="agent"
              contentMode="full"
              conversations={[]}
              runtime={runtime}
              onNavigate={vi.fn()}
            >
              <AgentProjectPublisher onUnmount={vi.fn()} />
            </Layout>
          </ActiveProjectCoordinatorProvider>
        </LayoutStateProvider>
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Git" }));
    const switchButton = await screen.findByRole("button", { name: "切换 Git 项目" });
    await waitFor(() => expect(switchButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(switchButton);
    await waitFor(() => expect(screen.getByTestId("git-tool-project").textContent).toBe("workspace-target"));

    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    fireEvent.click(screen.getByRole("button", { name: "Git" }));
    await waitFor(() => expect(screen.getByTestId("git-tool-project").textContent).toBe("workspace-agent"));
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

function workspace(id: string, name: string): Workspace {
  return {
    id,
    name,
    root_path: `D:/work/${name}`,
    normalized_root_path: `D:/work/${name}`,
    type: "local",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    last_opened_at: null,
    archived_at: null,
  };
}
