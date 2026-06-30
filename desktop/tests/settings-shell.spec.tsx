import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { SettingsShell } from "@/renderer/pages/settings/SettingsShell";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";

function renderShell(
  activeSection: "general" | "appearance" | "providers" | "modelDefaults" | "extensions" | "usage" | "config" = "providers",
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
  it("renders only supported settings menu entries", () => {
    renderShell("providers");

    expect(screen.getByRole("button", { name: "返回应用" })).not.toBeNull();
    expect(screen.getByLabelText("搜索设置")).not.toBeNull();
    expect(screen.getByRole("button", { name: "常规" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "外观" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "供应商配置" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "模型配置" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "扩展功能" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "策略配置" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "用量统计" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "切换主题" })).not.toBeNull();
    expect(screen.queryByText("暂未开放")).toBeNull();
    expect(screen.queryByText("MCP 服务器")).toBeNull();
  });

  it("marks the active settings section", () => {
    renderShell("usage");

    expect(screen.getByRole("button", { name: "用量统计" }).getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("button", { name: "常规" }).getAttribute("data-active")).toBe("false");
    expect(screen.getByRole("button", { name: "外观" }).getAttribute("data-active")).toBe("false");
    expect(screen.getByRole("button", { name: "供应商配置" }).getAttribute("data-active")).toBe("false");
    expect(screen.getByRole("button", { name: "模型配置" }).getAttribute("data-active")).toBe("false");
    expect(screen.getByRole("button", { name: "扩展功能" }).getAttribute("data-active")).toBe("false");
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
});
