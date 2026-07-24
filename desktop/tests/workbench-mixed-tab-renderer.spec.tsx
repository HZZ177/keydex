import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { createWorkbenchBrowserTabState } from "@/renderer/pages/workbench/workbenchBrowserAdapter";

const browserProbe = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock("@/renderer/features/browser/ui/BrowserTabSurface", async () => {
  const React = await import("react");
  return {
    BrowserTabSurface: ({ host }: {
      host: {
        kind: string;
        active: boolean;
        composerScopeKey: string | null;
        state: { id: string };
      };
    }) => {
      React.useEffect(() => {
        browserProbe.mounts += 1;
        return () => {
          browserProbe.unmounts += 1;
        };
      }, []);
      return (
        <div
          data-active={host.active ? "true" : "false"}
          data-composer-scope={host.composerScopeKey ?? ""}
          data-host-kind={host.kind}
          data-state-id={host.state.id}
          data-testid="mock-browser-surface"
        />
      );
    },
  };
});

vi.mock("@/renderer/components/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/renderer/components/workspace")>();
  return {
    ...actual,
    FilePreview: ({ request }: { request: { path?: string } }) => (
      <div data-path={request.path ?? ""} data-testid="mock-file-preview" />
    ),
  };
});

vi.mock("@/renderer/features/terminal", () => ({
  TerminalDockAction: () => <button type="button">终端</button>,
}));

import { WorkbenchMainPreviewTabs } from "@/renderer/pages/workbench/WorkbenchModePage";

const fileTab = {
  kind: "file" as const,
  id: "file:readme",
  request: { type: "file" as const, path: "README.md" },
  requestId: 1,
  refreshRequestId: 0,
  revealTarget: null,
  renderContext: null,
  sourceEntryId: null,
  sourceLabel: "README.md",
  title: "README.md",
  markdownView: {
    scopeId: "scope:file",
    entryId: "entry:file",
    viewId: "view:file",
    kind: "workbench" as const,
  },
};

const browserTab = createWorkbenchBrowserTabState({
  id: "browser:index",
  now: "2026-07-23T12:00:00.000Z",
  previewFilePath: "D:\\demo\\index.html",
});

function Harness({
  browserState = browserTab,
  initialActiveTabId = fileTab.id,
  onCloseTab = vi.fn(),
  selectedSessionId = "session-a",
}: {
  browserState?: typeof browserTab;
  initialActiveTabId?: string;
  onCloseTab?: (tabId: string) => void;
  selectedSessionId?: string;
}) {
  const tabs = [fileTab, browserState];
  const [activeTabId, setActiveTabId] = useState(initialActiveTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? fileTab;
  return (
    <>
      <div data-testid="fixed-tree-sentinel" />
      <WorkbenchMainPreviewTabs
        activeTab={activeTab}
        context={null}
        fallbackRuntime={{} as RuntimeBridge}
        fallbackWorkspaceId="workspace-a"
        selectedSessionId={selectedSessionId}
        tabs={tabs}
        onCloseActive={vi.fn()}
        onCloseTab={onCloseTab}
        onCreateBrowserTab={vi.fn()}
        onSelectTab={setActiveTabId}
        onUpdateBrowserTab={vi.fn()}
      />
    </>
  );
}

describe("workbench mixed tab renderer", () => {
  it("switches exactly one active content branch while retaining the outer rail and tree", () => {
    browserProbe.mounts = 0;
    browserProbe.unmounts = 0;
    render(<Harness />);
    const tree = screen.getByTestId("fixed-tree-sentinel");
    const rail = screen.getByTestId("workbench-preview-tab-rail");

    expect(screen.getByTestId("mock-file-preview").getAttribute("data-path")).toBe("README.md");
    expect(screen.queryByTestId("mock-browser-surface")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "index.html" }));

    expect(screen.queryByTestId("mock-file-preview")).toBeNull();
    expect(screen.getByTestId("mock-browser-surface")).toMatchObject({
      dataset: expect.objectContaining({
        active: "true",
        hostKind: "workbench",
        stateId: browserTab.id,
      }),
    });
    expect(screen.getByTestId("fixed-tree-sentinel")).toBe(tree);
    expect(screen.getByTestId("workbench-preview-tab-rail")).toBe(rail);
    expect(screen.getByTestId("workbench-main-browser-preview").getAttribute("data-active-tab-kind")).toBe("browser");
  });

  it("passes browser association labels into the mixed rail", () => {
    render(<Harness />);

    const browserButton = screen.getByRole("tab", { name: "index.html" });
    expect(browserButton.getAttribute("title")).toBe("D:\\demo\\index.html");
    expect(browserButton.getAttribute("data-tab-kind")).toBe("browser");
    expect(screen.getByRole("tab", { name: "README.md" }).getAttribute("data-tab-kind")).toBe("file");
  });

  it("retargets the composer on session switch without remounting the workspace browser tab", () => {
    browserProbe.mounts = 0;
    browserProbe.unmounts = 0;
    const view = render(
      <Harness initialActiveTabId={browserTab.id} selectedSessionId="session-a" />,
    );

    expect(screen.getByTestId("mock-browser-surface").getAttribute("data-composer-scope")).toBe(
      "session:session-a",
    );
    view.rerender(
      <Harness initialActiveTabId={browserTab.id} selectedSessionId="session-b" />,
    );
    expect(screen.getByTestId("mock-browser-surface").getAttribute("data-composer-scope")).toBe(
      "session:session-b",
    );
    expect(browserProbe.mounts).toBe(1);
    expect(browserProbe.unmounts).toBe(0);

    view.unmount();
    expect(browserProbe.unmounts).toBe(1);
  });

  it("updates the browser rail title and keeps a safe local-file icon", () => {
    const view = render(<Harness initialActiveTabId={browserTab.id} />);
    expect(screen.getByRole("tab", { name: "index.html" })).not.toBeNull();
    expect(screen.getByTestId(`workbench-browser-tab-icon-${browserTab.id}`).querySelector("svg")).not.toBeNull();

    view.rerender(
      <Harness
        browserState={{ ...browserTab, title: "Local demo" }}
        initialActiveTabId={browserTab.id}
      />,
    );
    expect(screen.getByRole("tab", { name: "Local demo" })).not.toBeNull();
  });

  it("applies the shared context-menu close-right action to a browser tab", () => {
    const onCloseTab = vi.fn();
    render(<Harness onCloseTab={onCloseTab} />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: "README.md" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭右侧tab" }));

    expect(onCloseTab).toHaveBeenCalledTimes(1);
    expect(onCloseTab).toHaveBeenCalledWith(browserTab.id);
  });

  it("keeps terminal as the rail end action when mixed tabs overflow", () => {
    render(<Harness />);
    const rail = screen.getByTestId("workbench-preview-tab-rail");
    const strip = screen.getByTestId("workbench-preview-tab-strip");
    const terminal = screen.getByRole("button", { name: "终端" });
    Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 500 });
    Object.defineProperty(strip, "clientWidth", { configurable: true, value: 120 });
    Object.defineProperty(strip, "scrollLeft", { configurable: true, writable: true, value: 0 });
    fireEvent.scroll(strip);

    expect(screen.getByTestId("workbench-preview-tab-scroll-right")).not.toBeNull();
    expect(rail.lastElementChild).toBe(terminal);
  });
});
