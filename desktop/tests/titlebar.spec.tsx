import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Titlebar } from "@/renderer/components/layout/Titlebar";
import { createWindowControls } from "@/renderer/components/layout/Titlebar/windowControls";

describe("Titlebar", () => {
  it("renders safely in browser mode and toggles the sidebar", () => {
    const onToggleSidebar = vi.fn();

    render(<Titlebar title="测试标题" sidebarCollapsed={false} onToggleSidebar={onToggleSidebar} />);

    expect(screen.getByTestId("titlebar")).not.toBeNull();
    expect(screen.getByText("测试标题")).not.toBeNull();
    expect(screen.queryByLabelText("更多")).toBeNull();
    expect(screen.queryByLabelText("最小化")).toBeNull();
    expect(screen.queryByLabelText("最大化")).toBeNull();
    expect(screen.queryByLabelText("关闭")).toBeNull();
    expect(screen.getByLabelText("展开右侧栏")).not.toBeNull();
    const toggle = screen.getByLabelText("折叠侧边栏");
    expect(toggle.getAttribute("data-state")).toBe("expanded");
    expect(toggle.getAttribute("data-icon")).toBe("panel-left-close");
    fireEvent.click(toggle);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("switches the left sidebar icon by collapse state", () => {
    const { rerender } = render(
      <Titlebar title="测试标题" sidebarCollapsed={false} onToggleSidebar={() => undefined} />,
    );

    expect(screen.getByLabelText("折叠侧边栏").getAttribute("data-icon")).toBe("panel-left-close");

    rerender(<Titlebar title="测试标题" sidebarCollapsed onToggleSidebar={() => undefined} />);

    expect(screen.getByLabelText("展开侧边栏").getAttribute("data-icon")).toBe("panel-left-open");
  });

  it("toggles the right sidebar button state", () => {
    const onToggleRightSidebar = vi.fn();

    const { rerender } = render(
      <Titlebar
        title="测试标题"
        sidebarCollapsed={false}
        rightSidebarOpen={false}
        onToggleSidebar={() => undefined}
        onToggleRightSidebar={onToggleRightSidebar}
      />,
    );

    const openButton = screen.getByLabelText("展开右侧栏");
    expect(openButton.getAttribute("aria-pressed")).toBe("false");
    expect(openButton.getAttribute("data-icon")).toBe("panel-right-open");
    fireEvent.click(openButton);
    expect(onToggleRightSidebar).toHaveBeenCalledTimes(1);

    rerender(
      <Titlebar
        title="测试标题"
        sidebarCollapsed={false}
        rightSidebarOpen
        onToggleSidebar={() => undefined}
        onToggleRightSidebar={onToggleRightSidebar}
      />,
    );

    const closeButton = screen.getByLabelText("折叠右侧栏");
    expect(closeButton.getAttribute("aria-pressed")).toBe("true");
    expect(closeButton.getAttribute("data-icon")).toBe("panel-right-close");
  });

  it("delegates title drag gestures to injected Tauri controls", async () => {
    const appWindow = {
      minimize: vi.fn().mockResolvedValue(undefined),
      toggleMaximize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      startDragging: vi.fn().mockResolvedValue(undefined),
    };
    const controls = createWindowControls(async () => appWindow);

    render(
      <Titlebar
        title="测试标题"
        sidebarCollapsed={false}
        onToggleSidebar={() => undefined}
        windowControls={controls}
      />,
    );

    fireEvent.mouseDown(screen.getByText("测试标题"), { button: 0 });
    fireEvent.doubleClick(screen.getByText("测试标题"));

    await vi.waitFor(() => {
      expect(appWindow.minimize).not.toHaveBeenCalled();
      expect(appWindow.toggleMaximize).toHaveBeenCalledTimes(1);
      expect(appWindow.close).not.toHaveBeenCalled();
      expect(appWindow.startDragging).toHaveBeenCalledTimes(1);
    });
  });
});
