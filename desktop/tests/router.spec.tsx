import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppRouter } from "@/renderer/components/layout/Router";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";

function renderRouter(initialEntries: string[]) {
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

  it("renders conversation and settings routes", () => {
    renderRouter(["/conversation/thread-1"]);

    expect(screen.getByRole("heading", { name: "对话 thread-1" })).not.toBeNull();
    expect(screen.getByTestId("titlebar").textContent).not.toContain("thread-1");
    expect(screen.getByTestId("chat-layout").parentElement?.getAttribute("data-content")).toBe("full");
    fireEvent.click(screen.getByText("设置"));
    expect(screen.getByRole("heading", { name: "模型设置" })).not.toBeNull();
    fireEvent.click(screen.getByText("返回"));
    expect(screen.getByRole("heading", { name: "对话 thread-1" })).not.toBeNull();
  });

  it("supports direct general settings route fallback back to guide", () => {
    renderRouter(["/settings/general"]);

    expect(screen.getByRole("heading", { name: "通用设置" })).not.toBeNull();
    fireEvent.click(screen.getByText("返回"));
    expect(screen.getByTestId("home-page")).not.toBeNull();
  });
});
