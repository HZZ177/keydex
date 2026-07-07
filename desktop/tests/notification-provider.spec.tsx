import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationProvider, useNotifications } from "@/renderer/providers/NotificationProvider";

describe("NotificationProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a top error capsule and dismisses it automatically", async () => {
    vi.useFakeTimers();

    render(
      <NotificationProvider>
        <NotificationHarness />
      </NotificationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "show error" }));

    expect(screen.getByRole("alert").textContent).toContain("加载失败");

    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(screen.getByRole("alert").getAttribute("data-exiting")).toBe("true");

    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("allows manually closing a notification", async () => {
    vi.useFakeTimers();

    render(
      <NotificationProvider>
        <NotificationHarness />
      </NotificationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "show success" }));
    expect(screen.getByRole("status").textContent).toContain("保存成功");

    fireEvent.click(screen.getByRole("button", { name: "关闭通知" }));

    expect(screen.getByRole("status").getAttribute("data-exiting")).toBe("true");

    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("uses 3 seconds as the default auto dismiss duration", () => {
    vi.useFakeTimers();

    render(
      <NotificationProvider>
        <NotificationHarness />
      </NotificationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "show default info" }));
    expect(screen.getByRole("status").textContent).toContain("默认消息");

    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(screen.getByRole("status")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("status").getAttribute("data-exiting")).toBe("true");

    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps a notification visible while hovered and resumes after mouse leave", () => {
    vi.useFakeTimers();

    render(
      <NotificationProvider>
        <NotificationHarness />
      </NotificationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "show error" }));
    const toast = screen.getByRole("alert");

    fireEvent.mouseEnter(toast);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByRole("alert")).not.toBeNull();

    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(49);
    });
    expect(screen.getByRole("alert")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("alert").getAttribute("data-exiting")).toBe("true");

    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an expand control only when content overflows", () => {
    vi.useFakeTimers();

    render(
      <NotificationProvider>
        <NotificationHarness />
      </NotificationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "show success" }));
    expect(screen.queryByRole("button", { name: "展开通知内容" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "show long warning" }));
    const message = screen.getByText(LONG_NOTIFICATION_MESSAGE);
    Object.defineProperty(message, "clientWidth", { configurable: true, value: 120 });
    Object.defineProperty(message, "scrollWidth", { configurable: true, value: 420 });

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    const expandButton = screen.getByRole("button", { name: "展开通知内容" });
    expect(screen.getAllByTestId("notification-item").at(-1)?.getAttribute("data-overflowing")).toBe("true");

    fireEvent.click(expandButton);

    const expandedToast = screen.getAllByTestId("notification-item").at(-1);
    expect(expandedToast?.getAttribute("data-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "收起通知内容" })).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getAllByTestId("notification-item").at(-1)?.getAttribute("data-expanded")).toBe("true");
  });
});

const LONG_NOTIFICATION_MESSAGE =
  "更新检查失败：GitHub Releases 返回了很长的错误信息，需要展开后才能看到完整的状态码、接口路径和响应内容。";

function NotificationHarness() {
  const notifications = useNotifications();
  return (
    <>
      <button type="button" onClick={() => notifications.error("加载失败", { durationMs: 50 })}>
        show error
      </button>
      <button type="button" onClick={() => notifications.success("保存成功", { durationMs: 0 })}>
        show success
      </button>
      <button type="button" onClick={() => notifications.info("默认消息")}>
        show default info
      </button>
      <button type="button" onClick={() => notifications.warning(LONG_NOTIFICATION_MESSAGE, { durationMs: 50 })}>
        show long warning
      </button>
    </>
  );
}
