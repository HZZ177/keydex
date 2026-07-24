import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StorageManagementPage } from "@/renderer/pages/settings/storage/StorageManagementPage";
import type { StorageRuntime, StorageStatus } from "@/runtime";

const STATUS: StorageStatus = {
  installRoot: "D:\\Keydex",
  dataRoot: "D:\\Keydex\\data",
  layoutVersion: 2,
  totalBytes: 1_610_612_736,
  legacyCleanupPending: false,
  categories: [
    { id: "database", label: "数据库", bytes: 807_403_520 },
    { id: "browser", label: "浏览器与 WebView", bytes: 629_145_600 },
    { id: "attachments", label: "附件与本地资料", bytes: 104_857_600 },
    { id: "history", label: "文件历史", bytes: 52_428_800 },
    { id: "tool-results", label: "工具结果", bytes: 8_388_608 },
    { id: "logs", label: "日志", bytes: 8_388_608 },
    { id: "other", label: "其他", bytes: 0 },
  ],
};

describe("StorageManagementPage", () => {
  it("shows the install-owned data root and opens it through the native runtime", async () => {
    const openDirectory = vi.fn(async () => undefined);
    const runtime: StorageRuntime = {
      getStatus: vi.fn(async () => STATUS),
      openDirectory,
    };

    render(<StorageManagementPage runtime={runtime} />);

    expect(await screen.findByText("D:\\Keydex\\data")).not.toBeNull();
    expect(screen.getByText("统一目录 v2")).not.toBeNull();
    expect(screen.getByText("数据库")).not.toBeNull();
    expect(screen.getByText(/数据目录固定跟随应用安装目录/)).not.toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "打开" })[1]);
    await waitFor(() => expect(openDirectory).toHaveBeenCalledWith("D:\\Keydex\\data"));
  });

  it("reports legacy cleanup that will retry on the next launch", async () => {
    const runtime: StorageRuntime = {
      getStatus: vi.fn(async () => ({ ...STATUS, legacyCleanupPending: true })),
      openDirectory: vi.fn(async () => undefined),
    };

    render(<StorageManagementPage runtime={runtime} />);

    expect(
      await screen.findByText(/旧 AppData 目录仍有被占用的文件/),
    ).not.toBeNull();
  });
});
