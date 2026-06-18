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
    fireEvent.click(screen.getByLabelText("折叠侧边栏"));
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("delegates window buttons to injected Tauri controls", async () => {
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

    fireEvent.click(screen.getByLabelText("最小化"));
    fireEvent.click(screen.getByLabelText("最大化"));
    fireEvent.click(screen.getByLabelText("关闭"));
    fireEvent.mouseDown(screen.getByText("测试标题"), { button: 0 });

    await vi.waitFor(() => {
      expect(appWindow.minimize).toHaveBeenCalledTimes(1);
      expect(appWindow.toggleMaximize).toHaveBeenCalledTimes(1);
      expect(appWindow.close).toHaveBeenCalledTimes(1);
      expect(appWindow.startDragging).toHaveBeenCalledTimes(1);
    });
  });
});
