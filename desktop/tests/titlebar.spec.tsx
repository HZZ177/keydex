import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Titlebar } from "@/renderer/components/layout/Titlebar";
import { createWindowControls } from "@/renderer/components/layout/Titlebar/windowControls";

describe("Titlebar", () => {
  it("renders safely in browser mode with brand and window controls", () => {
    render(<Titlebar title="测试标题" />);

    expect(screen.getByTestId("titlebar")).not.toBeNull();
    expect(screen.getByText("测试标题")).not.toBeNull();
    expect(screen.getByLabelText("Keydex")).not.toBeNull();
    expect(screen.queryByLabelText("更多")).toBeNull();
    expect(screen.getByLabelText("最小化")).not.toBeNull();
    expect(screen.getByLabelText("最大化或还原")).not.toBeNull();
    expect(screen.getByLabelText("关闭")).not.toBeNull();
    expect(screen.queryByLabelText("折叠侧边栏")).toBeNull();
    expect(screen.queryByLabelText("展开侧边栏")).toBeNull();
    expect(screen.queryByLabelText("展开右侧栏")).toBeNull();
  });

  it("keeps the left titlebar area for brand and future top-level actions", () => {
    render(<Titlebar title="测试标题" />);

    expect(screen.getByLabelText("Keydex")).not.toBeNull();
    expect(screen.getByTestId("titlebar").querySelectorAll("[aria-hidden='true'] span")).toHaveLength(2);
  });

  it("delegates titlebar gestures to injected Tauri controls", async () => {
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
        windowControls={controls}
      />,
    );

    fireEvent.mouseDown(screen.getByLabelText("Keydex"), { button: 0 });
    fireEvent.mouseDown(screen.getByText("测试标题"), { button: 0 });
    fireEvent.doubleClick(screen.getByText("测试标题"));
    fireEvent.mouseDown(screen.getByLabelText("最小化"), { button: 0 });
    fireEvent.click(screen.getByLabelText("最小化"));
    fireEvent.click(screen.getByLabelText("最大化或还原"));
    fireEvent.click(screen.getByLabelText("关闭"));

    await vi.waitFor(() => {
      expect(appWindow.minimize).toHaveBeenCalledTimes(1);
      expect(appWindow.toggleMaximize).toHaveBeenCalledTimes(2);
      expect(appWindow.close).toHaveBeenCalledTimes(1);
      expect(appWindow.startDragging).toHaveBeenCalledTimes(2);
    });
  });
});
