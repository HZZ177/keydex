import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsShell, type SettingsSection } from "@/renderer/pages/settings/SettingsShell";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";

function renderShell(
  activeSection: SettingsSection = "providers",
) {
  return render(
    <ThemeProvider>
      <LayoutStateProvider>
        <MemoryRouter initialEntries={[{ pathname: `/settings/${activeSection}`, state: { from: "/guid" } }]}>
          <SettingsShell activeSection={activeSection}>
            <div>设置内容</div>
          </SettingsShell>
        </MemoryRouter>
      </LayoutStateProvider>
    </ThemeProvider>,
  );
}

describe("SettingsShell", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders only supported settings menu entries", () => {
    renderShell("providers");

    expect(screen.getAllByRole("button", { name: "返回应用" })).toHaveLength(2);
    expect(screen.getByLabelText("搜索设置")).not.toBeNull();
    expect(screen.getByRole("button", { name: "常规" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "外观" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "供应商配置" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "模型配置" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "扩展功能" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "MCP服务器" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "策略配置" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "用量统计" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "项目管理" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "归档管理" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "切换主题" })).not.toBeNull();
    expect(screen.queryByText("暂未开放")).toBeNull();
  });

  it("marks project and archive management as separate accessible sections", () => {
    renderShell("archive");

    expect(screen.getByRole("button", { name: "归档管理" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "项目管理" }).getAttribute("aria-current")).toBeNull();
  });

  it("uses the same MCP icon family as the runtime capsule instead of the extensions icon", () => {
    renderShell("providers");

    expect(screen.getByRole("button", { name: "扩展功能" }).getAttribute("data-icon")).toBe("puzzle");
    expect(screen.getByRole("button", { name: "MCP服务器" }).getAttribute("data-icon")).toBe("plug-zap");
  });

  it("marks the active settings section", () => {
    renderShell("usage");

    expect(screen.getByRole("button", { name: "用量统计" }).getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("button", { name: "常规" }).getAttribute("data-active")).toBe("false");
    expect(screen.getByRole("button", { name: "外观" }).getAttribute("data-active")).toBe("false");
    expect(screen.getByRole("button", { name: "供应商配置" }).getAttribute("data-active")).toBe("false");
    expect(screen.getByRole("button", { name: "模型配置" }).getAttribute("data-active")).toBe("false");
    expect(screen.getByRole("button", { name: "扩展功能" }).getAttribute("data-active")).toBe("false");
    expect(screen.getByRole("button", { name: "MCP服务器" }).getAttribute("data-active")).toBe("false");
    expect(screen.getByRole("button", { name: "策略配置" }).getAttribute("data-active")).toBe("false");
  });

  it("marks model configuration separately from provider settings", () => {
    renderShell("modelDefaults");

    expect(screen.getByRole("button", { name: "模型配置" }).getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("button", { name: "供应商配置" }).getAttribute("data-active")).toBe("false");
  });

  it("marks extension settings separately from command configuration", () => {
    renderShell("extensions");

    expect(screen.getByRole("button", { name: "扩展功能" }).getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("button", { name: "策略配置" }).getAttribute("data-active")).toBe("false");
  });

  it("filters current settings entries through search", () => {
    renderShell("providers");

    fireEvent.change(screen.getByLabelText("搜索设置"), { target: { value: "用量" } });

    expect(screen.queryByRole("button", { name: "常规" })).toBeNull();
    expect(screen.queryByRole("button", { name: "外观" })).toBeNull();
    expect(screen.queryByRole("button", { name: "供应商配置" })).toBeNull();
    expect(screen.queryByRole("button", { name: "模型配置" })).toBeNull();
    expect(screen.queryByRole("button", { name: "扩展功能" })).toBeNull();
    expect(screen.queryByRole("button", { name: "MCP服务器" })).toBeNull();
    expect(screen.queryByRole("button", { name: "策略配置" })).toBeNull();
    expect(screen.getByRole("button", { name: "用量统计" })).not.toBeNull();
  });

  it("opens the command configuration section from the settings menu", () => {
    renderShell("config");

    expect(screen.getByRole("button", { name: "策略配置" }).getAttribute("data-active")).toBe("true");
  });

  it("keeps theme toggle in the settings footer", () => {
    renderShell("providers");

    expect(screen.getByText("深色")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "返回应用" })[1]).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "切换主题" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByText("浅色")).not.toBeNull();
  });

  it("resizes settings sidebar with the shared handle", () => {
    renderShell("providers");

    const shell = screen.getByTestId("settings-shell");
    const handle = screen.getByRole("separator", { name: "调整侧边栏宽度" });

    fireEvent.keyDown(handle, { key: "ArrowRight" });

    expect(shell.getAttribute("style")).toContain("--sidebar-width: 298px");

    fireEvent.doubleClick(handle);

    expect(shell.getAttribute("style")).toContain("--sidebar-width: 286px");
  });

  it("marks sidebar collapse transitions separately from resize", () => {
    renderShell("providers");

    const shell = screen.getByTestId("settings-shell");
    const handle = screen.getByRole("separator", { name: "调整侧边栏宽度" });

    expect(shell.dataset.sidebarMotion).toBe("false");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(shell.dataset.sidebarMotion).toBe("false");

    fireEvent.click(screen.getByLabelText("折叠侧边栏"));
    expect(shell.dataset.sidebar).toBe("collapsed");
    expect(shell.dataset.sidebarMotion).toBe("true");
    expect(screen.getByTitle("切换主题")).not.toBeNull();
  });

  it("shows custom menu labels on the right only when the settings sidebar is collapsed", () => {
    vi.useFakeTimers();
    renderShell("providers");

    const shell = screen.getByTestId("settings-shell");
    if (shell.dataset.sidebar === "collapsed") {
      fireEvent.click(screen.getByLabelText("展开侧边栏"));
    }

    const generalButton = screen.getByRole("button", { name: "常规" });
    expect(generalButton.getAttribute("data-tooltip-label")).toBeNull();

    fireEvent.click(screen.getByLabelText("折叠侧边栏"));

    const menuLabels = [
      "常规",
      "外观",
      "供应商配置",
      "模型配置",
      "扩展功能",
      "MCP服务器",
      "策略配置",
      "用量统计",
      "项目管理",
      "归档管理",
      "关于",
    ];
    for (const label of menuLabels) {
      expect(screen.getByRole("button", { name: label }).getAttribute("data-tooltip-label")).toBe(label);
    }

    fireEvent.pointerOver(generalButton);
    act(() => vi.advanceTimersByTime(420));

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toBe("常规");
    expect(tooltip.getAttribute("data-placement")).toBe("right");
  });
});
