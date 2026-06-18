import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppRouter } from "@/renderer/components/layout/Router";
import { EventReplayHarness } from "@/renderer/devtools/EventReplayHarness";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";

describe("EventReplayHarness", () => {
  it("renders a full replay fixture through the real message reducer and message list", () => {
    render(
      <ThemeProvider>
        <EventReplayHarness />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("event-replay-harness")).not.toBeNull();
    expect(screen.getByText("请分析项目并修改代码")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /已完成思考/ }));
    expect(screen.getByText("正在检查代码结构。")).not.toBeNull();
    expect(screen.getByText("允许执行测试命令")).not.toBeNull();
    expect(screen.getByText("模型网关返回错误示例")).not.toBeNull();
    expect(screen.getByText("2 个工具步骤")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "2 个工具步骤详情" }));
    expect(screen.getByTestId("tool-call-block")).not.toBeNull();
    expect(screen.getByTestId("command-execution-block")).not.toBeNull();
  });

  it("is reachable through a hidden direct route", () => {
    render(
      <ThemeProvider>
        <LayoutStateProvider>
          <MemoryRouter initialEntries={["/__dev/event-replay"]}>
            <AppRouter />
          </MemoryRouter>
        </LayoutStateProvider>
      </ThemeProvider>,
    );

    expect(screen.getByRole("heading", { name: "事件回放" })).not.toBeNull();
    expect(screen.getByTestId("event-replay-harness")).not.toBeNull();
  });
});
