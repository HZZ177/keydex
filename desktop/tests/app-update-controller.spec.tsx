import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppUpdateController } from "@/renderer/providers/AppUpdateController";
import {
  canUseAppUpdater,
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  type AppUpdateProgress,
  type PendingAppUpdate,
} from "@/runtime";

vi.mock("@/runtime", () => ({
  canUseAppUpdater: vi.fn(),
  checkForAppUpdate: vi.fn(),
  downloadAndInstallAppUpdate: vi.fn(),
}));

const canUseAppUpdaterMock = vi.mocked(canUseAppUpdater);
const checkForAppUpdateMock = vi.mocked(checkForAppUpdate);
const downloadAndInstallAppUpdateMock = vi.mocked(downloadAndInstallAppUpdate);

describe("AppUpdateController", () => {
  beforeEach(() => {
    canUseAppUpdaterMock.mockReturnValue(true);
    checkForAppUpdateMock.mockResolvedValue(null);
    downloadAndInstallAppUpdateMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("checks silently on startup and renders nothing when there is no update", async () => {
    render(<AppUpdateController />);

    await waitFor(() => expect(checkForAppUpdateMock).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole("dialog", { name: "发现新版本" })).toBeNull();
  });

  it("skips startup checks outside the updater runtime", () => {
    canUseAppUpdaterMock.mockReturnValue(false);

    render(<AppUpdateController />);

    expect(checkForAppUpdateMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "发现新版本" })).toBeNull();
  });

  it("shows an update dialog and starts download/install from the primary action", async () => {
    const user = userEvent.setup();
    const update = createPendingUpdate();
    checkForAppUpdateMock.mockResolvedValue(update);
    downloadAndInstallAppUpdateMock.mockImplementation(
      (_pendingUpdate: PendingAppUpdate, onProgress?: (progress: AppUpdateProgress) => void) =>
        new Promise<void>(() => {
          onProgress?.({ downloadedBytes: 512, totalBytes: 1024, finished: false });
        }),
    );

    render(<AppUpdateController />);

    expect(await screen.findByRole("dialog", { name: "发现新版本" })).not.toBeNull();
    expect(screen.getByText("当前版本 0.1.0，可更新到 0.1.1")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "下载并重启" }));

    expect(downloadAndInstallAppUpdateMock).toHaveBeenCalledTimes(1);
    expect(downloadAndInstallAppUpdateMock.mock.calls[0][0]).toBe(update);
    expect(await screen.findByText(/正在下载更新 50%/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "稍后" })).toBeNull();
    expect((screen.getByRole("button", { name: "下载中" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a close button before downloading", async () => {
    const user = userEvent.setup();
    checkForAppUpdateMock.mockResolvedValue(createPendingUpdate());

    render(<AppUpdateController />);

    expect(await screen.findByRole("dialog", { name: "发现新版本" })).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "关闭" }));

    expect(screen.queryByRole("dialog", { name: "发现新版本" })).toBeNull();
  });
});

function createPendingUpdate(): PendingAppUpdate {
  return {
    currentVersion: "0.1.0",
    version: "0.1.1",
    date: "2026-07-07",
    body: "修复更新流程",
    update: {} as PendingAppUpdate["update"],
  };
}
