import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { Layout } from "@/renderer/components/layout/Layout";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";

function renderLayout(ui: ReactElement) {
  return render(
    <ThemeProvider>
      <LayoutStateProvider>{ui}</LayoutStateProvider>
    </ThemeProvider>,
  );
}

describe("Layout", () => {
  it("renders the Codex-like shell without removed product entries", () => {
    renderLayout(
      <Layout title="测试会话">
        <div>内容区</div>
      </Layout>,
    );

    expect(screen.getByTestId("app-shell").dataset.sidebar).toBe("expanded");
    expect(screen.getByText("测试会话")).not.toBeNull();
    expect(screen.getByText("新对话")).not.toBeNull();
    expect(screen.queryByText("Team")).toBeNull();
    expect(screen.queryByText("Cron")).toBeNull();
    expect(screen.queryByText("自动化")).toBeNull();
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
});
