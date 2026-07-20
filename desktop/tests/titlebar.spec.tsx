import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Titlebar } from "@/renderer/components/layout/Titlebar";
import { createWindowControls } from "@/renderer/components/layout/Titlebar/windowControls";
import type { Workspace } from "@/types/protocol";

describe("Titlebar", () => {
  it("renders safely in browser mode with brand and window controls", () => {
    render(<Titlebar title="测试标题" />);

    expect(screen.getByTestId("titlebar")).not.toBeNull();
    expect(screen.getByText("测试标题")).not.toBeNull();
    expect(screen.getByLabelText("Keydex")).not.toBeNull();
    expect(screen.queryByLabelText("更多")).toBeNull();
    expect(screen.getByLabelText("最小化")).not.toBeNull();
    expect(screen.getByLabelText("最大化窗口")).not.toBeNull();
    expect(screen.getByLabelText("关闭")).not.toBeNull();
    expect(screen.queryByLabelText("折叠侧边栏")).toBeNull();
    expect(screen.queryByLabelText("展开侧边栏")).toBeNull();
    expect(screen.queryByLabelText("展开右侧栏")).toBeNull();
    expect(screen.queryByLabelText("打开终端")).toBeNull();
  });

  it("keeps the left titlebar area for brand and future top-level actions", () => {
    const onModeChange = vi.fn();

    render(<Titlebar title="测试标题" modeSwitch={{ currentMode: "agent", onModeChange }} />);

    expect(screen.getByLabelText("Keydex")).not.toBeNull();
    const modeSwitch = screen.getByRole("group", { name: "应用模式" });
    expect(modeSwitch).not.toBeNull();
    expect(modeSwitch.getAttribute("data-mode")).toBe("agent");
    expect(screen.getByRole("button", { name: "Agent" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "工作台模式" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "项目模式" }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "工作台模式" }));
    expect(modeSwitch.getAttribute("data-mode")).toBe("workbench");
    expect(screen.getByRole("button", { name: "Agent" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "工作台模式" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "项目模式" }).getAttribute("aria-pressed")).toBe("false");
    expect(onModeChange).toHaveBeenCalledWith("workbench");

    fireEvent.click(screen.getByRole("button", { name: "项目模式" }));
    expect(modeSwitch.getAttribute("data-mode")).toBe("project");
    expect(screen.getByRole("button", { name: "工作台模式" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "项目模式" }).getAttribute("aria-pressed")).toBe("true");
    expect(onModeChange).toHaveBeenCalledWith("project");
  });

  it("turns the brand mark into a titlebar-safe action when a click handler is provided", async () => {
    const onBrandClick = vi.fn();
    const appWindow = makeAppWindow();
    const controls = createWindowControls(async () => appWindow);

    render(<Titlebar title="测试标题" windowControls={controls} onBrandClick={onBrandClick} />);

    const brandButton = screen.getByRole("button", { name: "Keydex" });
    fireEvent.mouseDown(brandButton, { button: 0 });
    fireEvent.doubleClick(brandButton);
    fireEvent.click(brandButton);

    expect(onBrandClick).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(appWindow.startDragging).not.toHaveBeenCalled();
      expect(appWindow.toggleMaximize).not.toHaveBeenCalled();
    });
  });

  it("shows the workbench workspace selector next to the mode switch only in workbench mode", () => {
    const workspace = makeWorkspace("ws-1", "keydex");
    const onSelectWorkspace = vi.fn();
    const { rerender } = render(
      <Titlebar
        title="测试标题"
        modeSwitch={{ currentMode: "workbench", onModeChange: vi.fn() }}
        workbenchWorkspaceSelector={{
          value: { type: "workspace", workspace },
          workspaces: [workspace, makeWorkspace("ws-2", "kt-agent-framework")],
          loading: false,
          allowProjectFreeChat: false,
          onSelectWorkspace,
        }}
      />,
    );

    expect(screen.getByTestId("workbench-titlebar-workspace-selector")).not.toBeNull();
    expect(screen.getByLabelText("选择工作区").textContent).toContain("keydex");

    fireEvent.click(screen.getByLabelText("选择工作区"));
    fireEvent.click(screen.getByRole("option", { name: /kt-agent-framework/ }));
    expect(onSelectWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: "ws-2" }));

    rerender(
      <Titlebar
        title="测试标题"
        modeSwitch={{ currentMode: "agent", onModeChange: vi.fn() }}
        workbenchWorkspaceSelector={{
          value: { type: "workspace", workspace },
          workspaces: [workspace],
          loading: false,
          allowProjectFreeChat: false,
        }}
      />,
    );

    expect(screen.queryByTestId("workbench-titlebar-workspace-selector")).toBeNull();
    expect(screen.queryByLabelText("选择工作区")).toBeNull();

    rerender(
      <Titlebar
        title="测试标题"
        modeSwitch={{ currentMode: "project", onModeChange: vi.fn() }}
        workbenchWorkspaceSelector={{
          value: { type: "workspace", workspace },
          workspaces: [workspace],
          loading: false,
          allowProjectFreeChat: false,
        }}
      />,
    );

    expect(screen.queryByTestId("workbench-titlebar-workspace-selector")).toBeNull();
    expect(screen.queryByLabelText("选择工作区")).toBeNull();
  });

  it("delegates titlebar gestures to injected Tauri controls", async () => {
    const appWindow = makeAppWindow();
    const controls = createWindowControls(async () => appWindow);

    render(
      <Titlebar
        title="测试标题"
        modeSwitch={{ currentMode: "agent", onModeChange: vi.fn() }}
        windowControls={controls}
      />,
    );

    expect(screen.getByText("测试标题").closest("[data-tauri-drag-region]")).not.toBeNull();
    expect(screen.getByTestId("titlebar-right-drag-region").getAttribute("data-tauri-drag-region")).toBe("true");

    fireEvent.mouseDown(screen.getByTestId("titlebar"), { button: 0 });
    fireEvent.doubleClick(screen.getByText("测试标题"));

    const minimizeIcon = screen.getByLabelText("最小化").querySelector("svg");
    expect(minimizeIcon).not.toBeNull();
    fireEvent.mouseDown(screen.getByRole("button", { name: "工作台模式" }), { button: 0 });
    fireEvent.mouseDown(minimizeIcon as SVGElement, { button: 0 });
    fireEvent.click(minimizeIcon as SVGElement);
    fireEvent.click(screen.getByLabelText("最大化窗口"));
    fireEvent.click(screen.getByLabelText("关闭"));

    await vi.waitFor(() => {
      expect(appWindow.minimize).toHaveBeenCalledTimes(1);
      expect(appWindow.toggleMaximize).toHaveBeenCalledTimes(2);
      expect(appWindow.close).toHaveBeenCalledTimes(1);
      expect(appWindow.startDragging).toHaveBeenCalledTimes(1);
    });
  });

  it("switches the maximize control between maximize and restore states", async () => {
    let maximized = false;
    let emitResize: (() => void) | null = null;
    const appWindow = makeAppWindow({
      isMaximized: vi.fn(async () => maximized),
      onResized: vi.fn((handler: (event: unknown) => void) => {
        emitResize = () => handler({ payload: { width: 1280, height: 820 } });
        return Promise.resolve(vi.fn());
      }),
    });
    const triggerResize = () => {
      const currentEmitResize = emitResize as (() => void) | null;
      currentEmitResize?.();
    };
    const controls = createWindowControls(async () => appWindow);

    render(<Titlebar title="测试标题" windowControls={controls} />);

    await vi.waitFor(() => {
      expect(screen.getByLabelText("最大化窗口").getAttribute("data-icon")).toBe("maximize");
    });

    maximized = true;
    await act(async () => {
      triggerResize();
    });

    await vi.waitFor(() => {
      expect(screen.getByLabelText("还原窗口").getAttribute("data-icon")).toBe("restore");
    });

    maximized = false;
    await act(async () => {
      fireEvent.click(screen.getByLabelText("还原窗口"));
    });

    await vi.waitFor(() => {
      expect(screen.getByLabelText("最大化窗口").getAttribute("data-icon")).toBe("maximize");
    });
    expect(appWindow.toggleMaximize).toHaveBeenCalledTimes(1);
  });
});

function makeWorkspace(id: string, name: string): Workspace {
  return {
    id,
    name,
    root_path: `D:/repo/${name}`,
    normalized_root_path: `d:/repo/${name}`,
    type: "project",
    created_at: "2026-06-25T10:00:00Z",
    updated_at: "2026-06-25T10:00:00Z",
    last_opened_at: null,
    archived_at: null,
  };
}

function makeAppWindow(overrides: Record<string, unknown> = {}) {
  return {
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    startDragging: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(vi.fn()),
    ...overrides,
  };
}
