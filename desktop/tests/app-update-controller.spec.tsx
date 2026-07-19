import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";

import { Sider } from "@/renderer/components/layout/Sider";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { SettingsShell } from "@/renderer/pages/settings/SettingsShell";
import {
  APP_UPDATE_POLL_INTERVAL_MS,
  AppUpdateController,
  useAppUpdate,
} from "@/renderer/providers/AppUpdateController";
import { AboutSettingsPage } from "@/renderer/pages/settings/about/AboutSettingsPage";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";
import {
  canUseAppUpdater,
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  type AppUpdateProgress,
  type PendingAppUpdate,
  type RuntimeBridge,
} from "@/runtime";

vi.mock("@/runtime", () => ({
  canUseAppUpdater: vi.fn(),
  checkForAppUpdate: vi.fn(),
  downloadAndInstallAppUpdate: vi.fn(),
  getCurrentAppVersion: vi.fn().mockResolvedValue("0.1.0"),
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
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("checks silently on startup and renders nothing when there is no update", async () => {
    render(<AppUpdateController />);

    await waitFor(() => expect(checkForAppUpdateMock).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole("dialog", { name: "发现新版本" })).toBeNull();
  });

  it("skips startup checks outside the updater runtime", async () => {
    canUseAppUpdaterMock.mockReturnValue(false);

    render(<AppUpdateController />);
    await flushUpdateEffects();

    expect(checkForAppUpdateMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "发现新版本" })).toBeNull();
  });

  it("polls every five minutes and exposes a new update without opening the dialog", async () => {
    vi.useFakeTimers();
    checkForAppUpdateMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createPendingUpdate());

    const { container } = renderUpdateIndicatorHarness();
    await flushUpdateEffects();

    expect(checkForAppUpdateMock).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll("[data-app-update-indicator]")).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(APP_UPDATE_POLL_INTERVAL_MS);
    });

    expect(checkForAppUpdateMock).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll("[data-app-update-indicator]")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a detected update and its indicator unchanged when a poll fails", async () => {
    vi.useFakeTimers();
    checkForAppUpdateMock
      .mockResolvedValueOnce(createPendingUpdate())
      .mockRejectedValueOnce(new Error("GitHub is unavailable"));

    const { container } = renderUpdateIndicatorHarness();
    await flushUpdateEffects();

    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.click(screen.getByTestId("dismiss-update-dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.querySelectorAll("[data-app-update-indicator]")).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(APP_UPDATE_POLL_INTERVAL_MS);
    });

    expect(checkForAppUpdateMock).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll("[data-app-update-indicator]")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not overlap polling requests when GitHub remains slow", async () => {
    vi.useFakeTimers();
    checkForAppUpdateMock
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(() => new Promise<PendingAppUpdate | null>(() => undefined));

    render(<AppUpdateController />);
    await flushUpdateEffects();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(APP_UPDATE_POLL_INTERVAL_MS * 2);
    });

    expect(checkForAppUpdateMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
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
    expect(screen.getByText("从 0.1.0 更新到 0.1.1")).not.toBeNull();

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

  it("keeps update indicators on the app settings entry and settings about entry after dismissing", async () => {
    const user = userEvent.setup();
    checkForAppUpdateMock.mockResolvedValue(createPendingUpdate());
    const indicatorRuntime = { conversation: {} } as RuntimeBridge;

    const { container } = render(
      <ThemeProvider>
        <NotificationProvider>
          <AppUpdateController>
            <MemoryRouter>
              <LayoutStateProvider>
                <Sider conversations={[]} runtime={indicatorRuntime} />
                <SettingsShell activeSection="about">
                  <AboutSettingsPage />
                </SettingsShell>
              </LayoutStateProvider>
            </MemoryRouter>
          </AppUpdateController>
        </NotificationProvider>
      </ThemeProvider>,
    );

    expect(await screen.findByRole("dialog", { name: "发现新版本" })).not.toBeNull();
    expect(container.querySelectorAll("[data-app-update-indicator]")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "稍后" }));

    expect(screen.queryByRole("dialog", { name: "发现新版本" })).toBeNull();
    expect(container.querySelectorAll("[data-app-update-indicator]")).toHaveLength(2);

    checkForAppUpdateMock.mockResolvedValueOnce(null);
    await user.click(screen.getByRole("button", { name: "检查更新" }));

    expect(await screen.findByRole("dialog", { name: "已是最新版本" })).not.toBeNull();
    expect(container.querySelectorAll("[data-app-update-indicator]")).toHaveLength(0);
  });

  it("keeps download progress when the page using the updater unmounts", async () => {
    const user = userEvent.setup();
    checkForAppUpdateMock.mockResolvedValue(createPendingUpdate());
    downloadAndInstallAppUpdateMock.mockImplementation(
      (_pendingUpdate: PendingAppUpdate, onProgress?: (progress: AppUpdateProgress) => void) =>
        new Promise<void>(() => {
          onProgress?.({ downloadedBytes: 256, totalBytes: 1024, finished: false });
        }),
    );

    render(
      <AppUpdateController>
        <UpdatePageHarness />
      </AppUpdateController>,
    );

    expect(await screen.findByRole("dialog", { name: "发现新版本" })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "关闭" }));

    await user.click(screen.getByRole("button", { name: "页面下载更新" }));
    await user.click(screen.getByRole("button", { name: "切换页面" }));

    expect(screen.queryByRole("button", { name: "页面下载更新" })).toBeNull();
    expect(await screen.findByText(/正在下载更新 25%/)).not.toBeNull();
    expect((screen.getByRole("button", { name: "下载中" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows download progress only in the dialog when started from the about page", async () => {
    const user = userEvent.setup();
    checkForAppUpdateMock.mockResolvedValue(createPendingUpdate());
    downloadAndInstallAppUpdateMock.mockImplementation(
      (_pendingUpdate: PendingAppUpdate, onProgress?: (progress: AppUpdateProgress) => void) =>
        new Promise<void>(() => {
          onProgress?.({ downloadedBytes: 512, totalBytes: 1024, finished: false });
        }),
    );

    render(
      <AppUpdateController>
        <AboutSettingsPage />
      </AppUpdateController>,
    );

    expect(await screen.findByRole("dialog", { name: "发现新版本" })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await user.click(screen.getByRole("button", { name: "查看并更新" }));
    expect(await screen.findByRole("dialog", { name: "发现新版本" })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "下载并重启" }));

    const progressBars = await screen.findAllByRole("progressbar", { name: "更新下载进度" });
    expect(progressBars).toHaveLength(1);
    expect(progressBars[0].closest('[role="dialog"]')).not.toBeNull();
  });
});

function UpdatePageHarness() {
  const [mounted, setMounted] = useState(true);

  return (
    <>
      {mounted ? <UpdatePageActions /> : null}
      <button type="button" onClick={() => setMounted(false)}>
        切换页面
      </button>
    </>
  );
}

function renderUpdateIndicatorHarness() {
  const indicatorRuntime = { conversation: {} } as RuntimeBridge;
  return render(
    <ThemeProvider>
      <NotificationProvider>
        <AppUpdateController>
          <MemoryRouter>
            <LayoutStateProvider>
              <Sider conversations={[]} runtime={indicatorRuntime} />
              <DismissUpdateDialogButton />
            </LayoutStateProvider>
          </MemoryRouter>
        </AppUpdateController>
      </NotificationProvider>
    </ThemeProvider>,
  );
}

function DismissUpdateDialogButton() {
  const appUpdate = useAppUpdate();
  return (
    <button data-testid="dismiss-update-dialog" onClick={appUpdate.dismissDialog} type="button">
      dismiss
    </button>
  );
}

async function flushUpdateEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function UpdatePageActions() {
  const appUpdate = useAppUpdate();

  return (
    <button type="button" onClick={() => void appUpdate.installUpdate()}>
      页面下载更新
    </button>
  );
}

function createPendingUpdate(): PendingAppUpdate {
  return {
    currentVersion: "0.1.0",
    version: "0.1.1",
    date: "2026-07-07",
    body: "修复更新流程",
    update: {} as PendingAppUpdate["update"],
  };
}
