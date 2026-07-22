import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BrowserClearDataDialog } from "../src/renderer/features/browser/ui/BrowserClearDataDialog";
import { NotificationProvider } from "../src/renderer/providers/NotificationProvider";

describe("BrowserClearDataDialog", () => {
  it("requires explicit confirmation and sends profile, categories, and time range", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, requestId: "request-1" });
    const onCancel = vi.fn();
    render(
      <NotificationProvider>
        <BrowserClearDataDialog
          client={{ send } as never}
          profileMode="persistent"
          onCancel={onCancel}
        />
      </NotificationProvider>,
    );
    fireEvent.change(screen.getByLabelText("时间范围"), { target: { value: "last_day" } });
    fireEvent.click(screen.getByLabelText("缓存文件"));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "清除数据" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("browser_clear_profile_data", {
      profileMode: "persistent",
      kinds: ["cookies", "storage"],
      timeRange: "last_day",
    }));
    expect(await screen.findByText("浏览数据已清除")).not.toBeNull();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("disables the destructive action when no category is selected", () => {
    render(
      <NotificationProvider>
        <BrowserClearDataDialog
          client={{ send: vi.fn() } as never}
          profileMode="incognito"
          onCancel={vi.fn()}
        />
      </NotificationProvider>,
    );
    fireEvent.click(screen.getByLabelText("Cookie 与登录状态"));
    fireEvent.click(screen.getByLabelText("缓存文件"));
    fireEvent.click(screen.getByLabelText("网站存储"));
    expect(screen.getByRole("button", { name: "清除数据" }).hasAttribute("disabled")).toBe(true);
  });
});
