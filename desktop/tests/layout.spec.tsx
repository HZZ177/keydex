import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Layout, resetLayoutUiStateCacheForTests } from "@/renderer/components/layout/Layout";
import { useOptionalRightSidebarConversation } from "@/renderer/components/layout/RightSidebarConversationContext";
import { createRuntimeBridge, type RuntimeBridge } from "@/runtime";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { MessageText } from "@/renderer/pages/conversation/messages";
import { useA2UIRenderSuspension } from "@/renderer/pages/conversation/messages/a2ui/A2UIRenderSuspensionContext";
import { PreviewProvider, usePreview } from "@/renderer/providers/PreviewProvider";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";
import { ActiveProjectCoordinatorProvider } from "@/renderer/providers/ActiveProjectCoordinatorProvider";
import { TerminalSessionScopeProvider } from "@/renderer/providers/TerminalSessionScopeProvider";
import { TerminalProvider } from "@/renderer/features/terminal";
import {
  browserPanelRuntime,
  browserRuntimePanelId,
} from "@/renderer/features/browser/runtime";
import type { SubagentRunSnapshot } from "@/types/subagents";

afterEach(() => {
  cleanup();
  resetLayoutUiStateCacheForTests();
});

function renderLayout(ui: ReactElement) {
  return render(
    <ThemeProvider>
      <ActiveProjectCoordinatorProvider>
        <TerminalSessionScopeProvider>
          <TerminalProvider runtimeAvailable={false}>
            <LayoutStateProvider>{ui}</LayoutStateProvider>
          </TerminalProvider>
        </TerminalSessionScopeProvider>
      </ActiveProjectCoordinatorProvider>
    </ThemeProvider>,
  );
}

function renderLayoutWithPreview(ui: ReactElement) {
  return render(
    <ThemeProvider>
      <ActiveProjectCoordinatorProvider>
        <TerminalSessionScopeProvider>
          <TerminalProvider runtimeAvailable={false}>
            <LayoutStateProvider>
              <PreviewProvider>{ui}</PreviewProvider>
            </LayoutStateProvider>
          </TerminalProvider>
        </TerminalSessionScopeProvider>
      </ActiveProjectCoordinatorProvider>
    </ThemeProvider>,
  );
}

function A2UISuspensionProbe() {
  const suspended = useA2UIRenderSuspension();
  return <div data-testid="a2ui-suspension-probe" data-suspended={suspended ? "true" : "false"} />;
}

describe("Layout", () => {
  it("renders the Keydex-like shell without removed product entries", () => {
    renderLayout(
      <Layout title="测试会话">
        <div>内容区</div>
      </Layout>,
    );

    expect(screen.getByTestId("app-shell").dataset.sidebar).toBe("expanded");
    expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("closed");
    expect(screen.getByText("测试会话")).not.toBeNull();
    expect(screen.getByLabelText("展开右侧栏")).not.toBeNull();
    expect(screen.getByText("新对话")).not.toBeNull();
    expect(screen.queryByText("Team")).toBeNull();
    expect(screen.queryByText("Cron")).toBeNull();
    expect(screen.queryByText("自动化")).toBeNull();
  });

  it("opens the product motion page from the brand mark and returns to the app", () => {
    renderLayout(
      <Layout title="测试会话">
        <div>内容区</div>
      </Layout>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Keydex" }));

    const overlay = screen.getByTestId("product-showcase-overlay");
    expect(overlay.getAttribute("data-phase")).toBe("open");
    expect(screen.getByRole("dialog", { name: "Keydex" })).not.toBeNull();
    expect(screen.getByRole("img", { name: "可交互的 Keydex 粒子球" })).not.toBeNull();
    expect(screen.queryByAltText("Keydex 3D 小人偶")).toBeNull();
    expect(screen.queryByText("移动聚散 · 拖动旋转 · 点击释放")).toBeNull();
    expect(screen.getByRole("button", { name: "回到应用" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "回到应用" }));

    expect(overlay.getAttribute("data-phase")).toBe("exiting");
    fireEvent.animationEnd(overlay);
    expect(screen.queryByTestId("product-showcase-overlay")).toBeNull();
    expect(screen.getByText("内容区")).not.toBeNull();
  });

  it.each(["Enter", " "])("returns from the product particle page with %j", (key) => {
    renderLayout(
      <Layout title="测试会话">
        <div>内容区</div>
      </Layout>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Keydex" }));
    const overlay = screen.getByTestId("product-showcase-overlay");

    fireEvent.keyDown(window, { key });

    expect(overlay.getAttribute("data-phase")).toBe("exiting");
    fireEvent.animationEnd(overlay);
    expect(screen.queryByTestId("product-showcase-overlay")).toBeNull();
    expect(screen.getByText("内容区")).not.toBeNull();
  });

  it("toggles sidebar collapse state", () => {
    renderLayout(
      <Layout>
        <div>内容区</div>
      </Layout>,
    );

    const shell = screen.getByTestId("app-shell");
    expect(shell.dataset.sidebarMotion).toBe("false");
    fireEvent.click(screen.getByLabelText("折叠侧边栏"));
    expect(shell.dataset.sidebar).toBe("collapsed");
    expect(shell.dataset.sidebarMotion).toBe("true");
    fireEvent.click(screen.getByLabelText("展开侧边栏"));
    expect(shell.dataset.sidebar).toBe("expanded");
    expect(shell.dataset.sidebarMotion).toBe("true");
  });

  it("resizes the shared sidebar width from the shell handle", () => {
    renderLayout(
      <Layout>
        <div>内容区</div>
      </Layout>,
    );

    const shell = screen.getByTestId("app-shell");
    const handle = screen.getByRole("separator", { name: "调整侧边栏宽度" });

    fireEvent.keyDown(handle, { key: "ArrowRight" });

    expect(shell.getAttribute("style")).toContain("--sidebar-width: 298px");
    expect(shell.dataset.sidebarMotion).toBe("false");

    fireEvent.doubleClick(handle);

    expect(shell.getAttribute("style")).toContain("--sidebar-width: 286px");
  });

  it("suspends A2UI rendering while resizing the main sidebar", async () => {
    renderLayout(
      <Layout>
        <A2UISuspensionProbe />
      </Layout>,
    );

    const probe = screen.getByTestId("a2ui-suspension-probe");
    const handle = screen.getByRole("separator", { name: "调整侧边栏宽度" });
    expect(probe.getAttribute("data-suspended")).toBe("false");

    act(() => {
      dispatchPointer(handle, "pointerdown", { button: 0, pointerId: 12, clientX: 286 });
    });

    await waitFor(() => {
      expect(probe.getAttribute("data-suspended")).toBe("true");
    });

    act(() => {
      dispatchPointer(window, "pointerup", { pointerId: 12, clientX: 286 });
    });

    await waitFor(() => {
      expect(probe.getAttribute("data-suspended")).toBe("false");
    });
  });

  it("toggles, maximizes and resizes the conversation right sidebar", () => {
    renderLayout(
      <Layout>
        <div>内容区</div>
      </Layout>,
    );

    const shell = screen.getByTestId("app-shell");
    expect(shell.dataset.rightSidebarMotion).toBe("false");

    fireEvent.click(screen.getByLabelText("展开右侧栏"));

    expect(shell.dataset.rightSidebar).toBe("open");
    expect(shell.dataset.rightSidebarMode).toBe("split");
    expect(shell.dataset.rightSidebarPlacement).toBe("right");
    expect(shell.dataset.rightSidebarMotion).toBe("true");
    expect(screen.getByRole("complementary", { name: "右侧栏" })).not.toBeNull();
    expect(screen.getByRole("tablist", { name: "侧边栏窗口" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "新建侧边栏页面" })).not.toBeNull();
    expect(screen.getByTestId("right-sidebar-initial-page")).not.toBeNull();
    expect(screen.getByRole("button", { name: "审阅" })).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "侧边栏" })).toBeNull();

    const handle = screen.getByRole("separator", { name: "调整右侧栏宽度" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(shell.getAttribute("style")).toContain("--right-sidebar-ratio: 0.46");
    expect(shell.getAttribute("style")).toContain("--right-sidebar-width: 339px");

    fireEvent.doubleClick(handle);
    expect(shell.getAttribute("style")).toContain("--right-sidebar-ratio: 0.45");
    expect(shell.getAttribute("style")).toContain("--right-sidebar-width: 332px");

    fireEvent.click(screen.getByLabelText("展开右侧栏到对话区域"));
    expect(shell.dataset.rightSidebarMode).toBe("maximized");
    expect(screen.getByRole("separator", { name: "调整右侧栏宽度" }).getAttribute("data-disabled")).toBe("true");

    fireEvent.click(screen.getByLabelText("缩小右侧栏"));
    expect(shell.dataset.rightSidebarMode).toBe("split");
    expect(screen.getByRole("separator", { name: "调整右侧栏宽度" }).getAttribute("data-disabled")).toBe("false");

    fireEvent.click(screen.getByLabelText("折叠右侧栏"));
    expect(shell.dataset.rightSidebar).toBe("closed");
    expect(shell.dataset.rightSidebarMode).toBe("split");
    expect(shell.dataset.rightSidebarMotion).toBe("true");
    expect(screen.queryByRole("complementary", { name: "右侧栏" })).toBeNull();
  });

  it("updates right sidebar geometry during window resize without rerendering content", async () => {
    const originalInnerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    let renderCount = 0;
    function RenderProbe() {
      renderCount += 1;
      return <div>内容区</div>;
    }

    try {
      setWindowInnerWidth(1024);
      renderLayout(
        <Layout>
          <RenderProbe />
        </Layout>,
      );

      const shell = screen.getByTestId("app-shell");
      fireEvent.click(screen.getByLabelText("展开右侧栏"));

      expect(shell.getAttribute("style")).toContain("--right-sidebar-width: 332px");
      const renderCountAfterOpen = renderCount;

      setWindowInnerWidth(900);
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
        await nextAnimationFrame();
      });

      expect(shell.getAttribute("style")).toContain("--right-sidebar-width: 276px");
      expect(renderCount).toBe(renderCountAfterOpen);
    } finally {
      restoreWindowInnerWidth(originalInnerWidth);
    }
  });

  it("keeps the shared right sidebar unavailable in workbench mode", () => {
    renderLayout(
      <Layout appMode="workbench" contentMode="full">
        <div>工作台内容</div>
      </Layout>,
    );

    const shell = screen.getByTestId("app-shell");
    expect(shell.dataset.rightSidebarEnabled).toBe("false");
    expect(shell.dataset.rightSidebar).toBe("closed");
    expect(screen.queryByLabelText("展开右侧栏")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "右侧栏" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "调整右侧栏宽度" })).toBeNull();
  });

  it("keeps the shared right sidebar unavailable in project mode", () => {
    renderLayout(
      <Layout appMode="project" contentMode="full">
        <div>功能开发中，敬请期待</div>
      </Layout>,
    );

    const shell = screen.getByTestId("app-shell");
    expect(shell.dataset.rightSidebarEnabled).toBe("false");
    expect(shell.dataset.rightSidebar).toBe("closed");
    expect(screen.queryByLabelText("侧边栏")).toBeNull();
    expect(screen.queryByText("新对话")).toBeNull();
    expect(screen.queryByRole("separator", { name: "调整侧边栏宽度" })).toBeNull();
    expect(screen.queryByLabelText("展开右侧栏")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "右侧栏" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "调整右侧栏宽度" })).toBeNull();
  });

  it("does not open the shared right sidebar from preview requests in workbench mode", () => {
    renderLayoutWithPreview(
      <>
        <RightSidebarPreviewHarness />
        <Layout appMode="workbench" contentMode="full">
          <div>工作台内容</div>
        </Layout>
      </>,
    );

    const shell = screen.getByTestId("app-shell");
    fireEvent.click(screen.getByRole("button", { name: "打开 HTML 窗口" }));

    expect(shell.dataset.rightSidebarEnabled).toBe("false");
    expect(shell.dataset.rightSidebar).toBe("closed");
    expect(screen.queryByRole("tablist", { name: "侧边栏窗口" })).toBeNull();
    expect(screen.queryByTestId("right-sidebar-initial-page")).toBeNull();
  });

  it("marks the right sidebar as resizing only during pointer drag", async () => {
    renderLayout(
      <Layout>
        <A2UISuspensionProbe />
      </Layout>,
    );

    const shell = screen.getByTestId("app-shell");
    const probe = screen.getByTestId("a2ui-suspension-probe");
    const openButton = document.querySelector<HTMLButtonElement>("[data-icon='panel-right-open']");
    if (!openButton) {
      throw new Error("Right sidebar open button not found");
    }
    fireEvent.click(openButton);

    const handle = screen.getAllByRole("separator").find((element) => element.getAttribute("aria-valuemax") === "80");
    if (!handle) {
      throw new Error("Right sidebar resize handle not found");
    }
    act(() => {
      dispatchPointer(handle, "pointerdown", { button: 0, pointerId: 4, clientX: 400 });
    });

    await waitFor(() => {
      expect(shell.dataset.rightSidebarResizing).toBe("true");
      expect(probe.getAttribute("data-suspended")).toBe("true");
    });

    act(() => {
      dispatchPointer(window, "pointerup", { pointerId: 4, clientX: 400 });
    });

    await waitFor(() => {
      expect(shell.dataset.rightSidebarResizing).toBeUndefined();
      expect(probe.getAttribute("data-suspended")).toBe("false");
    });
  });

  it("swaps the conversation area and side panel across the split handle", () => {
    renderLayout(
      <Layout>
        <div>内容区</div>
      </Layout>,
    );

    const shell = screen.getByTestId("app-shell");
    fireEvent.click(screen.getByLabelText("展开右侧栏"));

    expect(shell.dataset.rightSidebarPlacement).toBe("right");
    expect(screen.getByRole("complementary", { name: "右侧栏" })).not.toBeNull();

    fireEvent.click(screen.getByLabelText("交换对话区和侧边栏位置"));

    expect(shell.dataset.rightSidebarPlacement).toBe("left");
    expect(screen.getByRole("complementary", { name: "左侧栏" })).not.toBeNull();
    expect(screen.queryByRole("complementary", { name: "右侧栏" })).toBeNull();
    expect(screen.getByLabelText("展开左侧栏到对话区域")).not.toBeNull();
    expect(screen.getByLabelText("折叠左侧栏")).not.toBeNull();

    const leftHandle = screen.getByRole("separator", { name: "调整左侧栏宽度" });
    fireEvent.keyDown(leftHandle, { key: "ArrowRight" });
    expect(shell.getAttribute("style")).toContain("--right-sidebar-ratio: 0.46");

    fireEvent.keyDown(leftHandle, { key: "ArrowLeft" });
    expect(shell.getAttribute("style")).toContain("--right-sidebar-ratio: 0.45");

    fireEvent.click(screen.getByLabelText("折叠左侧栏"));
    expect(shell.dataset.rightSidebar).toBe("closed");
    expect(screen.getByLabelText("展开左侧栏")).not.toBeNull();

    fireEvent.click(screen.getByLabelText("展开左侧栏"));
    expect(shell.dataset.rightSidebar).toBe("open");
    expect(shell.dataset.rightSidebarPlacement).toBe("left");

    fireEvent.click(screen.getByLabelText("交换对话区和侧边栏位置"));

    expect(shell.dataset.rightSidebarPlacement).toBe("right");
    expect(screen.getByRole("complementary", { name: "右侧栏" })).not.toBeNull();
    expect(screen.getByRole("separator", { name: "调整右侧栏宽度" })).not.toBeNull();
  });

  it("keeps a full-width conversation inside the shell when the side panel is widened on either side", async () => {
    renderLayout(
      <Layout contentMode="full">
        <div>内容区</div>
      </Layout>,
    );

    const shell = screen.getByTestId("app-shell");
    fireEvent.click(screen.getByLabelText("展开右侧栏"));

    const rightHandle = screen.getByRole("separator", { name: "调整右侧栏宽度" });
    expect(rightHandle.getAttribute("aria-valuemax")).toBe("43");
    expect(shell.getAttribute("style")).toContain("--right-sidebar-ratio: 0.431");
    expect(shell.getAttribute("style")).toContain("--right-sidebar-width: 318px");

    act(() => {
      dispatchPointer(rightHandle, "pointerdown", { button: 0, pointerId: 8, clientX: 400 });
    });
    await waitFor(() => {
      expect(shell.dataset.rightSidebarResizing).toBe("true");
    });
    act(() => {
      dispatchPointer(window, "pointermove", { pointerId: 8, clientX: 410 });
    });
    await waitFor(() => {
      expect(shell.getAttribute("style")).toContain("--right-sidebar-ratio: 0.417");
      expect(shell.getAttribute("style")).toContain("--right-sidebar-width: 308px");
    });
    act(() => {
      dispatchPointer(window, "pointerup", { pointerId: 8, clientX: 410 });
    });
    await waitFor(() => {
      expect(shell.dataset.rightSidebarResizing).toBeUndefined();
    });

    fireEvent.keyDown(rightHandle, { key: "End" });
    expect(shell.getAttribute("style")).toContain("--right-sidebar-ratio: 0.431");
    expect(shell.getAttribute("style")).toContain("--right-sidebar-width: 318px");

    fireEvent.click(screen.getByLabelText("交换对话区和侧边栏位置"));
    const leftHandle = screen.getByRole("separator", { name: "调整左侧栏宽度" });
    expect(leftHandle.getAttribute("aria-valuemax")).toBe("43");
    expect(shell.getAttribute("style")).toContain("--right-sidebar-ratio: 0.431");
    expect(shell.getAttribute("style")).toContain("--right-sidebar-width: 318px");

    fireEvent.keyDown(leftHandle, { key: "ArrowRight" });
    expect(shell.getAttribute("style")).toContain("--right-sidebar-ratio: 0.431");
    expect(shell.getAttribute("style")).toContain("--right-sidebar-width: 318px");

    act(() => {
      dispatchPointer(leftHandle, "pointerdown", { button: 0, pointerId: 9, clientX: 400 });
    });
    await waitFor(() => {
      expect(shell.dataset.rightSidebarResizing).toBe("true");
    });
    act(() => {
      dispatchPointer(window, "pointermove", { pointerId: 9, clientX: 390 });
    });
    await waitFor(() => {
      expect(shell.getAttribute("style")).toContain("--right-sidebar-ratio: 0.417");
      expect(shell.getAttribute("style")).toContain("--right-sidebar-width: 308px");
    });
    act(() => {
      dispatchPointer(window, "pointerup", { pointerId: 9, clientX: 390 });
    });
    await waitFor(() => {
      expect(shell.dataset.rightSidebarResizing).toBeUndefined();
    });

    fireEvent.click(screen.getByLabelText("交换对话区和侧边栏位置"));
    const restoredRightHandle = screen.getByRole("separator", { name: "调整右侧栏宽度" });
    fireEvent.doubleClick(restoredRightHandle);
    expect(shell.dataset.rightSidebarPlacement).toBe("right");
    expect(shell.getAttribute("style")).toContain("--right-sidebar-ratio: 0.431");
  });

  it("collapses the right sidebar from its panel controls", () => {
    renderLayout(
      <Layout>
        <div>内容区</div>
      </Layout>,
    );

    const shell = screen.getByTestId("app-shell");
    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    expect(shell.dataset.rightSidebar).toBe("open");

    fireEvent.click(screen.getByLabelText("折叠右侧栏"));
    expect(shell.dataset.rightSidebar).toBe("closed");
  });

  it("opens an empty review panel from the right sidebar initial page", () => {
    renderLayout(
      <Layout>
        <div>内容区</div>
      </Layout>,
    );

    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    fireEvent.click(screen.getByRole("button", { name: "审阅" }));

    expect(screen.getByRole("tab", { name: "审阅" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("right-sidebar-review-panel")).not.toBeNull();
    expect(screen.getByTestId("review-empty-state").textContent).toContain("暂无可审阅的文件变更");

    fireEvent.click(screen.getByRole("button", { name: "关闭侧边栏窗口 审阅" }));
    expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("closed");
  });

  it("disposes a retained browser surface when its sidebar tab is explicitly closed", () => {
    const disposeCurrent = vi.spyOn(browserPanelRuntime, "disposeCurrent");
    try {
      renderLayout(
        <Layout>
          <div>内容区</div>
        </Layout>,
      );

      fireEvent.click(screen.getByLabelText("展开右侧栏"));
      fireEvent.click(screen.getByRole("button", { name: "浏览器" }));
      fireEvent.click(screen.getByRole("button", { name: "关闭侧边栏窗口 新标签页" }));

      expect(disposeCurrent).toHaveBeenCalledWith(
        browserRuntimePanelId("global", "right-sidebar:browser:1"),
      );
    } finally {
      disposeCurrent.mockRestore();
    }
  });

  it("collapses the right sidebar when navigating to the new conversation page", () => {
    const onNavigate = vi.fn();
    renderLayout(
      <Layout onNavigate={onNavigate}>
        <div>内容区</div>
      </Layout>,
    );

    const shell = screen.getByTestId("app-shell");
    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    expect(shell.dataset.rightSidebar).toBe("open");

    fireEvent.click(screen.getByRole("button", { name: "新对话" }));

    expect(onNavigate).toHaveBeenCalledWith("/guid?focus=prompt");
    expect(shell.dataset.rightSidebar).toBe("closed");
    expect(screen.queryByTestId("right-sidebar-initial-page")).toBeNull();
  });

  it("renders preview entries as top-level closable right sidebar tabs", async () => {
    renderLayoutWithPreview(
      <>
        <RightSidebarPreviewHarness />
        <Layout contentMode="full">
          <div>内容区</div>
        </Layout>
      </>,
    );

    const shell = screen.getByTestId("app-shell");

    fireEvent.click(screen.getByRole("button", { name: "打开 HTML 窗口" }));

    expect(shell.dataset.rightSidebar).toBe("open");
    expect(screen.getByRole("tablist", { name: "侧边栏窗口" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "HTML 窗口" }).getAttribute("aria-selected")).toBe("true");
    expect(
      (
        (await screen.findByTitle(
          "HTML 文件预览",
          undefined,
          { timeout: 5000 },
        )) as HTMLIFrameElement
      ).getAttribute("srcdoc"),
    ).toContain("HTML 窗口");

    fireEvent.click(screen.getByRole("button", { name: "打开 Markdown 窗口" }));

    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Markdown 窗口" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "HTML 窗口" }).getAttribute("title")).toBeNull();
    expect(screen.getByRole("tab", { name: "Markdown 窗口" }).getAttribute("title")).toBeNull();
    expect(screen.getByRole("button", { name: "关闭侧边栏窗口 HTML 窗口" }).getAttribute("title")).toBeNull();
    expect(screen.getByRole("button", { name: "新建侧边栏页面" }).getAttribute("title")).toBeNull();
    expect(screen.getByRole("tab", { name: "HTML 窗口" }).getAttribute("data-tooltip-label")).toBe("HTML 窗口");
    expect(screen.getByRole("button", { name: "关闭侧边栏窗口 HTML 窗口" }).getAttribute("data-tooltip-label"))
      .toBe("关闭 HTML 窗口");
    expect(screen.getByRole("button", { name: "新建侧边栏页面" }).getAttribute("data-tooltip-label"))
      .toBe("新建侧边栏页面");
    expect(await screen.findByRole("heading", { level: 1, name: "Markdown 窗口" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "新建侧边栏页面" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "新建侧边栏页面" }));

    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "HTML 窗口" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tab", { name: "Markdown 窗口" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tab", { name: "新tab" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("right-sidebar-initial-page")).not.toBeNull();
    expect(screen.getByRole("button", { name: "审阅" })).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Markdown 窗口" }));

    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "新tab" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tab", { name: "Markdown 窗口" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("heading", { level: 1, name: "Markdown 窗口" })).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "HTML 窗口" }));

    expect(screen.getByRole("tab", { name: "HTML 窗口" }).getAttribute("aria-selected")).toBe("true");
    expect(((await screen.findByTitle("HTML 文件预览")) as HTMLIFrameElement).getAttribute("srcdoc")).toContain(
      "HTML 窗口",
    );

    fireEvent.click(screen.getByRole("button", { name: "关闭侧边栏窗口 HTML 窗口" }));

    expect(screen.queryByRole("tab", { name: "HTML 窗口" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Markdown 窗口" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "关闭侧边栏窗口 Markdown 窗口" }));

    expect(shell.dataset.rightSidebar).toBe("open");
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "新tab" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("right-sidebar-initial-page")).not.toBeNull();
    expect(screen.getByRole("button", { name: "审阅" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "关闭侧边栏窗口 新tab" }));

    expect(shell.dataset.rightSidebar).toBe("closed");
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByTestId("right-sidebar-initial-page")).toBeNull();
  });

  it("does not persist workbench-only preview scopes", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(null), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const runtime = createRuntimeBridge({ baseUrl: "http://keydex", fetcher });

    renderLayoutWithPreview(
      <>
        <WorkbenchPreviewScopeHarness />
        <Layout runtime={runtime} appMode="workbench" contentMode="full">
          <div>工作台内容</div>
        </Layout>
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("workbench-preview-scope").textContent).toBe("workbench:workspace-1");
    });
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("/api/ui/right-sidebar")),
    ).toHaveLength(0);
  });

  it("shows the target session loading state before routed navigation commits", () => {
    const onNavigate = vi.fn();
    function SessionNavigationHarness() {
      const [activePath, setActivePath] = useState("/git/workspace-a");
      return (
        <>
          <button type="button" onClick={() => setActivePath("/conversation/thread-a")}>Commit route</button>
          <Layout
            activePath={activePath}
            conversations={[{ id: "thread-a", title: "Session A" }]}
            onNavigate={onNavigate}
            routePrimarySurface={activePath.startsWith("/git/") ? "git" : "content"}
          >
            <div data-testid="routed-content">Routed content</div>
          </Layout>
        </>
      );
    }
    renderLayout(<SessionNavigationHarness />);

    const shell = screen.getByTestId("app-shell");
    expect(shell.dataset.primarySurface).toBe("git");

    fireEvent.click(screen.getByRole("button", { name: "Session A" }));

    expect(onNavigate).toHaveBeenCalledWith("/conversation/thread-a");
    expect(shell.dataset.primarySurface).toBe("content");
    expect(shell.dataset.sessionNavigationPending).toBe("true");
    expect(screen.getByRole("button", { name: "Session A" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("session-navigation-loading")).not.toBeNull();
    expect(screen.queryByTestId("routed-content")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Commit route" }));

    expect(shell.dataset.sessionNavigationPending).toBe("false");
    expect(screen.queryByTestId("session-navigation-loading")).toBeNull();
    expect(screen.getByTestId("routed-content")).not.toBeNull();
  });

  it("closes right sidebar tabs to the left and right from the tab context menu", () => {
    renderLayoutWithPreview(
      <>
        <RightSidebarPreviewHarness />
        <Layout contentMode="full">
          <div>内容区</div>
        </Layout>
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "打开 HTML 窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "打开 Markdown 窗口" }));

    fireEvent.contextMenu(screen.getByRole("tab", { name: "Markdown 窗口" }), { clientX: 120, clientY: 80 });
    expect(screen.getByRole("menu", { name: "侧边栏tab菜单" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "关闭左侧tab" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "关闭右侧tab" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "关闭其他tab" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "关闭所有tab" })).not.toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: "关闭左侧tab" }));

    expect(screen.queryByRole("tab", { name: "HTML 窗口" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Markdown 窗口" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "打开 HTML 窗口" }));
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    fireEvent.contextMenu(screen.getByRole("tab", { name: "Markdown 窗口" }), { clientX: 120, clientY: 80 });
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭右侧tab" }));

    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Markdown 窗口" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: "HTML 窗口" })).toBeNull();
  });

  it("closes other and all right sidebar tabs from the tab context menu", () => {
    renderLayoutWithPreview(
      <>
        <RightSidebarPreviewHarness />
        <Layout contentMode="full">
          <div>内容区</div>
        </Layout>
      </>,
    );

    const shell = screen.getByTestId("app-shell");
    fireEvent.click(screen.getByRole("button", { name: "打开 HTML 窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "打开 Markdown 窗口" }));

    fireEvent.contextMenu(screen.getByRole("tab", { name: "Markdown 窗口" }), { clientX: 120, clientY: 80 });
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭其他tab" }));

    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Markdown 窗口" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: "HTML 窗口" })).toBeNull();
    expect(shell.dataset.rightSidebar).toBe("open");

    fireEvent.contextMenu(screen.getByRole("tab", { name: "Markdown 窗口" }), { clientX: 120, clientY: 80 });
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭所有tab" }));

    expect(shell.dataset.rightSidebar).toBe("closed");
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("keeps newly added empty right sidebar pages as duplicate display names", () => {
    renderLayout(
      <Layout contentMode="full">
        <div>内容区</div>
      </Layout>,
    );

    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    const addPageButton = screen.getByRole("button", { name: "新建侧边栏页面" });

    fireEvent.click(addPageButton);
    fireEvent.click(addPageButton);

    expect(screen.getAllByRole("tab", { name: "新tab" })).toHaveLength(2);
    expect(screen.queryByRole("tab", { name: "新tab 2" })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "关闭侧边栏窗口 新tab" })[1]);
    fireEvent.click(addPageButton);

    expect(screen.getAllByRole("tab", { name: "新tab" })).toHaveLength(2);
    expect(screen.queryByRole("tab", { name: "新tab 3" })).toBeNull();
  });

  it("routes code block side-preview clicks to existing right sidebar tabs and toggles the active panel", async () => {
    renderLayoutWithPreview(
      <>
        <RightSidebarPreviewHarness />
        <Layout contentMode="full">
          <MessageText
            message={message("assistant", "```markdown\n# Markdown 预览\n\n正文\n```", "completed")}
          />
        </Layout>
      </>,
    );

    const shell = screen.getByTestId("app-shell");
    const codePreviewButton = () => screen.getByRole("button", { name: /预览面板.*Markdown 预览$/ });

    expect(codePreviewButton().getAttribute("aria-pressed")).toBe("false");
    expect(codePreviewButton().querySelector(".lucide-panel-right-open")).not.toBeNull();
    fireEvent.click(codePreviewButton());
    await waitFor(() => {
      expect(shell.dataset.rightSidebar).toBe("open");
      expect(codePreviewButton().getAttribute("aria-pressed")).toBe("true");
      expect(codePreviewButton().querySelector(".lucide-panel-right-close")).not.toBeNull();
    });
    expect(screen.getByRole("tab", { name: "Markdown 预览" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "打开 HTML 窗口" }));
    expect(screen.getByRole("tab", { name: "HTML 窗口" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => {
      expect(codePreviewButton().getAttribute("aria-pressed")).toBe("false");
      expect(codePreviewButton().querySelector(".lucide-panel-right-open")).not.toBeNull();
    });

    fireEvent.click(codePreviewButton());
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Markdown 预览" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => {
      expect(codePreviewButton().getAttribute("aria-pressed")).toBe("true");
      expect(codePreviewButton().querySelector(".lucide-panel-right-close")).not.toBeNull();
    });

    fireEvent.click(codePreviewButton());
    await waitFor(() => {
      expect(shell.dataset.rightSidebar).toBe("closed");
      expect(codePreviewButton().getAttribute("aria-pressed")).toBe("false");
      expect(codePreviewButton().querySelector(".lucide-panel-right-open")).not.toBeNull();
    });

    fireEvent.click(codePreviewButton());
    await waitFor(() => {
      expect(shell.dataset.rightSidebar).toBe("open");
      expect(codePreviewButton().getAttribute("aria-pressed")).toBe("true");
      expect(codePreviewButton().querySelector(".lucide-panel-right-close")).not.toBeNull();
    });
    expect(screen.getByRole("tab", { name: "Markdown 预览" }).getAttribute("aria-selected")).toBe("true");
  });
  it("does not reopen a collapsed preview sidebar after the layout remounts", async () => {
    renderLayoutWithPreview(<RightSidebarRemountHarness />);

    fireEvent.click(screen.getByRole("button", { name: /HTML/ }));

    const shell = screen.getByTestId("app-shell");
    expect(shell.dataset.rightSidebar).toBe("open");

    closeRightSidebarByIcon();
    expect(shell.dataset.rightSidebar).toBe("closed");

    fireEvent.click(screen.getByRole("button", { name: "Unmount layout" }));
    expect(screen.queryByTestId("app-shell")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remount layout" }));
    const remountedShell = await screen.findByTestId("app-shell");
    await settleEffects();

    expect(remountedShell.dataset.rightSidebar).toBe("closed");

    fireEvent.click(screen.getByRole("button", { name: /Markdown/ }));
    expect(remountedShell.dataset.rightSidebar).toBe("open");
  });

  it("does not reopen a collapsed file sidebar after the layout remounts", async () => {
    renderLayoutWithPreview(<RightSidebarFilePanelRemountHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Open file panel" }));

    const shell = screen.getByTestId("app-shell");
    await waitFor(() => {
      expect(shell.dataset.rightSidebar).toBe("open");
    });

    closeRightSidebarByIcon();
    expect(shell.dataset.rightSidebar).toBe("closed");

    fireEvent.click(screen.getByRole("button", { name: "Unmount layout" }));
    expect(screen.queryByTestId("app-shell")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remount layout" }));
    const remountedShell = await screen.findByTestId("app-shell");
    await settleEffects();

    expect(remountedShell.dataset.rightSidebar).toBe("closed");

    fireEvent.click(screen.getByRole("button", { name: "Open file panel" }));
    await waitFor(() => {
      expect(remountedShell.dataset.rightSidebar).toBe("open");
    });
  });

  it("opens the Files panel and reveals a directory without previewing it", async () => {
    renderLayoutWithPreview(<RightSidebarDirectoryPanelHarness />);

    const shell = screen.getByTestId("app-shell");
    expect(shell.dataset.rightSidebar).toBe("closed");

    fireEvent.click(screen.getByRole("button", { name: "Reveal src directory" }));

    await waitFor(() => {
      expect(shell.dataset.rightSidebar).toBe("open");
    });
    expect(await screen.findByRole("button", { name: "选择文件 src/index.ts" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "折叠 src" })).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser").dataset.previewOpen).toBe("false");
  });

  it("keeps the Sub-Agent tab while nested file, preview, and review actions open sibling tabs", async () => {
    renderLayoutWithPreview(
      <Layout contentMode="full">
        <NestedSidebarActionHarness />
      </Layout>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Sub-Agent workspace" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    let subagentTab = screen.getAllByRole("tab")[0];

    fireEvent.click(screen.getByRole("button", { name: "打开文件引用 README.md" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(screen.getAllByRole("tab")[0]).toBe(subagentTab);
    expect(screen.getByTestId("nested-host-session").textContent).toBe("parent-session");

    closeRightSidebarByIcon();
    await waitFor(() => expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("closed"));
    fireEvent.click(screen.getByRole("button", { name: "Open Sub-Agent workspace" }));
    await waitFor(() => expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("open"));
    expect(screen.getByTestId("nested-host-session").textContent).toBe("parent-session");
    subagentTab = screen.getAllByRole("tab")[0];
    expect(subagentTab.textContent).toContain("子智能体");

    fireEvent.click(subagentTab);
    expect(subagentTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Open nested preview" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
    expect(screen.getAllByRole("tab")[0]).toBe(subagentTab);

    fireEvent.click(subagentTab);
    fireEvent.click(screen.getByRole("button", { name: "Open nested review" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(4));
    expect(screen.getAllByRole("tab")[0]).toBe(subagentTab);
    expect(document.querySelector('[data-content="review"]')).not.toBeNull();
  });

  it("routes a retained Sub-Agent capsule through the current scope with the sidebar expansion motion", async () => {
    renderLayoutWithPreview(<RetainedSubagentScopeHarness />);

    await screen.findByText("parent-session-a");
    const shell = screen.getByTestId("app-shell");
    fireEvent.click(screen.getByRole("button", { name: "展开右侧栏" }));
    await waitFor(() => expect(shell.dataset.rightSidebar).toBe("open"));
    fireEvent.click(screen.getByRole("button", { name: "Retain current Sub-Agent capsule callback" }));
    closeRightSidebarByIcon();
    await waitFor(() => {
      expect(shell.dataset.rightSidebar).toBe("closed");
      expect(shell.dataset.rightSidebarMotion).toBe("false");
    });

    fireEvent.click(screen.getByRole("button", { name: "Switch to parent session B" }));
    await screen.findByText("parent-session-b");

    fireEvent.click(screen.getByRole("button", { name: "Open retained Sub-Agent capsule" }));
    expect(shell.dataset.rightSidebarMotion).toBe("true");

    await waitFor(() => {
      expect(shell.dataset.rightSidebar).toBe("open");
      expect(document.querySelector('[data-content="subagent"]')).not.toBeNull();
    });
    expect(screen.getByRole("tab", { name: /子智能体/ }).getAttribute("aria-selected")).toBe("true");
  });
});

function RetainedSubagentScopeHarness() {
  const preview = usePreview();
  const { setPreviewHostContext } = preview;
  const activeParentSessionId = preview.hostContext?.sessionId ?? "";

  useEffect(() => {
    setPreviewHostContext(retainedSubagentPreviewContext("parent-session-a"));
    return () => setPreviewHostContext(null);
  }, [setPreviewHostContext]);

  if (activeParentSessionId !== "parent-session-a" && activeParentSessionId !== "parent-session-b") {
    return null;
  }

  return (
    <Layout contentMode="full">
      <RetainedSubagentCapsuleActionHarness />
    </Layout>
  );
}

function RetainedSubagentCapsuleActionHarness() {
  const preview = usePreview();
  const sidebar = useOptionalRightSidebarConversation();
  const retainedOpenSubagentPanelRef = useRef(sidebar?.openSubagentPanel);

  return (
    <div>
      <output>{preview.hostContext?.sessionId ?? ""}</output>
      <button
        type="button"
        onClick={() => preview.setPreviewHostContext(retainedSubagentPreviewContext("parent-session-b"))}
      >
        Switch to parent session B
      </button>
      <button
        type="button"
        onClick={() => {
          retainedOpenSubagentPanelRef.current = sidebar?.openSubagentPanel;
        }}
      >
        Retain current Sub-Agent capsule callback
      </button>
      <button
        type="button"
        onClick={() => retainedOpenSubagentPanelRef.current?.(retainedSubagentRun())}
      >
        Open retained Sub-Agent capsule
      </button>
    </div>
  );
}

function NestedSidebarActionHarness() {
  const preview = usePreview();
  const sidebar = useOptionalRightSidebarConversation();
  const { setPreviewHostContext } = preview;

  useEffect(() => {
    setPreviewHostContext(parentSidebarPreviewContext());
    return () => setPreviewHostContext(null);
  }, [setPreviewHostContext]);

  return (
    <div>
      <button type="button" onClick={() => sidebar?.openSubagentList(preview.hostContext?.sessionId ?? "")}>
        Open Sub-Agent workspace
      </button>
      <output data-testid="nested-host-session">{preview.hostContext?.sessionId ?? ""}</output>
      <button
        type="button"
        onClick={() => preview.openPreview(
          { type: "content", title: "Nested preview", content: "Nested preview", contentType: "markdown" },
          nestedSidebarPreviewContext("child-session"),
        )}
      >
        Open nested preview
      </button>
      <button
        type="button"
        onClick={() => preview.openReviewPanel(
          { title: "Nested review", panelKey: "nested-review", files: [] },
          nestedSidebarPreviewContext("child-session"),
        )}
      >
        Open nested review
      </button>
      <MessageText
        message={message("user", "Inspect README", "completed", {
          contextItems: [
            {
              id: "nested-readme",
              type: "file",
              label: "README.md",
              content: "workspace file: README.md",
              source: "follow",
              path: "README.md",
              fileType: "file",
            },
          ],
        })}
        workspaceRuntime={filePanelRuntime}
        workspaceScope={{ sessionId: "child-session" }}
      />
    </div>
  );
}

function RightSidebarPreviewHarness() {
  const preview = usePreview();

  return (
    <div>
      <button
        type="button"
        onClick={() =>
          preview.openPreview({
            type: "content",
            title: "HTML 窗口",
            content: "<main><h1>HTML 窗口</h1></main>",
            contentType: "html",
          })
        }
      >
        打开 HTML 窗口
      </button>
      <button
        type="button"
        onClick={() =>
          preview.openPreview({
            type: "content",
            title: "Markdown 窗口",
            content: "# Markdown 窗口",
            contentType: "markdown",
          })
        }
      >
        打开 Markdown 窗口
      </button>
    </div>
  );
}

function RightSidebarRemountHarness() {
  const preview = usePreview();
  const [mounted, setMounted] = useState(true);

  return (
    <>
      <button
        type="button"
        onClick={() =>
          preview.openPreview(
            {
              type: "content",
              title: "HTML window",
              content: "<main><h1>HTML window</h1></main>",
              contentType: "html",
            },
            sessionPreviewContext(),
          )
        }
      >
        Open scoped HTML
      </button>
      <button
        type="button"
        onClick={() =>
          preview.openPreview(
            {
              type: "content",
              title: "Markdown window",
              content: "# Markdown window",
              contentType: "markdown",
            },
            sessionPreviewContext(),
          )
        }
      >
        Open scoped Markdown
      </button>
      <button type="button" onClick={() => setMounted(false)}>
        Unmount layout
      </button>
      <button type="button" onClick={() => setMounted(true)}>
        Remount layout
      </button>
      {mounted ? (
        <ScopedConversationLayout />
      ) : null}
    </>
  );
}

function RightSidebarFilePanelRemountHarness() {
  const preview = usePreview();
  const [mounted, setMounted] = useState(true);

  return (
    <>
      <button
        type="button"
        onClick={() => preview.openFilePanel("README.md", sessionPreviewContext())}
      >
        Open file panel
      </button>
      <button type="button" onClick={() => setMounted(false)}>
        Unmount layout
      </button>
      <button type="button" onClick={() => setMounted(true)}>
        Remount layout
      </button>
      {mounted ? (
        <ScopedConversationLayout />
      ) : null}
    </>
  );
}

function WorkbenchPreviewScopeHarness() {
  const preview = usePreview();
  const { setPreviewHostContext } = preview;

  useEffect(() => {
    setPreviewHostContext({
      panelScopeKey: "workbench:workspace-1",
      workspaceId: "workspace-1",
    });
    return () => setPreviewHostContext(null);
  }, [setPreviewHostContext]);

  return <output data-testid="workbench-preview-scope">{preview.activeScopeKey}</output>;
}

function RightSidebarDirectoryPanelHarness() {
  const preview = usePreview();

  return (
    <>
      <button
        type="button"
        onClick={() => preview.openDirectoryPanel("src", sessionPreviewContext())}
      >
        Reveal src directory
      </button>
      <ScopedConversationLayout />
    </>
  );
}

function ScopedConversationLayout() {
  const { setPreviewHostContext } = usePreview();

  useEffect(() => {
    setPreviewHostContext(sessionPreviewContext());
    return () => setPreviewHostContext(null);
  }, [setPreviewHostContext]);

  return (
    <Layout contentMode="full">
      <div>Content</div>
    </Layout>
  );
}

const filePanelRuntime = {
  workspace: {
    listDirectory: (_scope: unknown, path = "") =>
      Promise.resolve({
        root: "D:/repo",
        entries: path === "src"
          ? [{ name: "index.ts", path: "src/index.ts", type: "file", size: 24, modified_at: null }]
          : [
              { name: "README.md", path: "README.md", type: "file", size: 12, modified_at: null },
              { name: "src", path: "src", type: "directory", size: null, modified_at: null },
            ],
      }),
    readFile: (_scope: unknown, path: string) => Promise.resolve({ path, content: "# README", encoding: "utf-8" }),
    readMedia: () => Promise.reject(new Error("not implemented")),
    search: () => Promise.resolve([]),
  },
} as unknown as RuntimeBridge;

function sessionPreviewContext() {
  return {
    runtime: filePanelRuntime,
    sessionId: "session-1",
    workspaceAvailable: true,
    workspaceLabel: "repo",
  };
}

function nestedSidebarPreviewContext(sessionId: string) {
  return {
    ...parentSidebarPreviewContext(),
    panelScopeKey: "session:parent-session",
    sessionId,
  };
}

function parentSidebarPreviewContext() {
  return {
    ...sessionPreviewContext(),
    sessionId: "parent-session",
  };
}

function retainedSubagentPreviewContext(sessionId: string) {
  return {
    ...sessionPreviewContext(),
    sessionId,
  };
}

function retainedSubagentRun(): SubagentRunSnapshot {
  return {
    schema_version: 1,
    run_id: "retained-run-b",
    subagent_id: "retained-subagent-b",
    child_session_id: "child-session-b",
    parent_session_id: "parent-session-b",
    parent_trace_id: null,
    parent_tool_call_id: "delegate-call-b",
    parent_timeline_sequence: 1,
    initiated_by: "main_agent",
    role: "worker",
    task: "Verify retained Sub-Agent capsule routing",
    state: "completed",
    blocked_on: null,
    version: 1,
    final_report: "completed",
    report_truncated: false,
    error_code: null,
    error_message: null,
    created_at: "2026-07-19T00:00:00.000Z",
    queued_at: "2026-07-19T00:00:00.000Z",
    started_at: "2026-07-19T00:00:01.000Z",
    finished_at: "2026-07-19T00:00:02.000Z",
    updated_at: "2026-07-19T00:00:02.000Z",
    cancel_requested_at: null,
  };
}

function closeRightSidebarByIcon() {
  const closeButton = document.querySelector<HTMLButtonElement>("[data-icon='panel-right-close']");
  expect(closeButton).not.toBeNull();
  fireEvent.click(closeButton!);
}

async function settleEffects() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
}

function setWindowInnerWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

function restoreWindowInnerWidth(descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(window, "innerWidth", descriptor);
    return;
  }
  delete (window as { innerWidth?: number }).innerWidth;
}

async function nextAnimationFrame() {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function message(
  kind: ConversationMessage["kind"],
  content: string,
  status: ConversationMessage["status"],
  payload: ConversationMessage["payload"] = {},
): ConversationMessage {
  return {
    id: "message-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    kind,
    status,
    content,
    payload,
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:01:00Z",
  };
}

function dispatchPointer(target: EventTarget, type: string, props: Record<string, number>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  target.dispatchEvent(event);
}
