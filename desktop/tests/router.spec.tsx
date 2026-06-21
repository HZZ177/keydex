import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppRouter } from "@/renderer/components/layout/Router";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";

function renderRouter(initialEntries: Array<string | { pathname: string; state?: unknown }>) {
  return render(
    <ThemeProvider>
      <LayoutStateProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <AppRouter />
        </MemoryRouter>
      </LayoutStateProvider>
    </ThemeProvider>,
  );
}

describe("AppRouter", () => {
  it("redirects root to the guide page", () => {
    renderRouter(["/"]);

    expect(screen.getByTestId("home-page")).not.toBeNull();
    expect(screen.getByLabelText("输入需求")).not.toBeNull();
  });

  it("opens settings in an isolated settings workspace and returns to the source route", () => {
    renderRouter(["/conversation/thread-1"]);

    expect(screen.getByRole("heading", { name: "对话 thread-1" })).not.toBeNull();
    expect(screen.getByTestId("titlebar").textContent).not.toContain("thread-1");
    expect(screen.getByTestId("chat-layout").parentElement?.getAttribute("data-content")).toBe("full");
    fireEvent.click(screen.getByText("设置"));
    expect(screen.getByTestId("settings-shell")).not.toBeNull();
    expect(screen.getByTestId("settings-sidebar")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "模型配置" })).not.toBeNull();
    expect(screen.queryByLabelText("侧边栏")).toBeNull();
    expect(screen.queryByText("新对话")).toBeNull();

    fireEvent.click(screen.getByText("返回应用"));
    expect(screen.getByRole("heading", { name: "对话 thread-1" })).not.toBeNull();
  });

  it("supports direct settings route fallback back to guide", () => {
    renderRouter(["/settings/usage"]);

    expect(screen.getByTestId("settings-shell")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "用量统计" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "模型配置" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "用量统计" })).not.toBeNull();
    fireEvent.click(screen.getByText("返回应用"));
    expect(screen.getByTestId("home-page")).not.toBeNull();
  });

  it("redirects legacy general settings route to model settings", () => {
    renderRouter(["/settings/general"]);

    expect(screen.getByRole("heading", { name: "模型配置" })).not.toBeNull();
    fireEvent.click(screen.getByText("返回应用"));
    expect(screen.getByTestId("home-page")).not.toBeNull();
  });
});
