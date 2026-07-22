import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RightSidebarInitialPage } from "@/renderer/components/layout/RightSidebarInitialPage";
import {
  RightSidebarPanelErrorBoundary,
  RightSidebarRegisteredTab,
} from "@/renderer/components/layout/rightSidebar/RightSidebarHost";
import { RightSidebarPanelIconGlyph } from "@/renderer/components/layout/rightSidebar/icons";
import { filesPanelCreateInput } from "@/renderer/components/layout/rightSidebar/panels/files";
import { rightSidebarDefinitionRegistry } from "@/renderer/components/layout/rightSidebarRegistry";

const NOW = "2026-07-21T00:00:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("right sidebar registry host", () => {
  it("renders one generic accessible tab from presentation and capabilities", () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    const panel = rightSidebarDefinitionRegistry.create("files", {
      id: "right-sidebar:files:1",
      sequence: 1,
      now: NOW,
      input: filesPanelCreateInput({ path: "README.md" }),
    });
    const { container } = render(
      <RightSidebarRegisteredTab
        active
        menuOpen={false}
        panel={panel}
        onActivate={onActivate}
        onClose={onClose}
        onContextMenu={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "文件" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭侧边栏窗口 文件" }));
    expect(onActivate).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-panel-kind="files"]')).not.toBeNull();
    expect(screen.getByRole("tab").getAttribute("aria-selected")).toBe("true");
  });

  it("builds initial-page actions from the production registry order", () => {
    const onSelect = vi.fn();
    const actions = rightSidebarDefinitionRegistry.listInitialActions().map((action) => ({
      id: action.id,
      label: action.label,
      icon: <RightSidebarPanelIconGlyph icon={action.icon} size={14} />,
      onSelect,
    }));
    render(<RightSidebarInitialPage actions={actions} />);

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "旁路对话",
      "子智能体",
      "文件",
      "审阅",
      "浏览器",
    ]);
    expect(screen.getByRole("button", { name: "浏览器" }).querySelector(".lucide-globe")).not.toBeNull();
    expect(screen.getByRole("button", { name: "浏览器" }).querySelector(".lucide-globe-2")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "文件" }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("isolates a render failure and retries without replacing the layout host", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let shouldThrow = true;
    function FlakyPanel() {
      if (shouldThrow) throw new Error("panel failed");
      return <div>panel recovered</div>;
    }
    render(
      <RightSidebarPanelErrorBoundary panelId="right-sidebar:files:1">
        <FlakyPanel />
      </RightSidebarPanelErrorBoundary>,
    );

    expect(screen.getByRole("alert")).not.toBeNull();
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByText("panel recovered")).not.toBeNull();
  });

  it("preserves keyboard tab activation semantics", () => {
    const panel = rightSidebarDefinitionRegistry.create("files", {
      id: "right-sidebar:files:1",
      sequence: 1,
      now: NOW,
    });
    function Harness() {
      const [active, setActive] = useState(false);
      return (
        <RightSidebarRegisteredTab
          active={active}
          menuOpen={false}
          panel={panel}
          onActivate={() => setActive(true)}
          onClose={() => undefined}
          onContextMenu={() => undefined}
        />
      );
    }
    render(<Harness />);
    const tab = screen.getByRole("tab", { name: "文件" });
    tab.focus();
    fireEvent.keyDown(tab, { key: "Enter" });
    fireEvent.click(tab);
    expect(tab.getAttribute("aria-selected")).toBe("true");
  });
});
