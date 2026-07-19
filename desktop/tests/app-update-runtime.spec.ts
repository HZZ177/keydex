import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APP_UPDATE_CHECK_TIMEOUT_MS,
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  type PendingAppUpdate,
} from "@/runtime/appUpdate";

const { check, invoke } = vi.hoisted(() => ({ check: vi.fn(), invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));

describe("app update runtime", () => {
  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.clearAllMocks();
  });

  it("bounds GitHub update checks with a short timeout", async () => {
    const tauriWindow = window as Window & { __TAURI_INTERNALS__?: unknown };
    tauriWindow.__TAURI_INTERNALS__ = {};
    check.mockResolvedValueOnce(null);

    await expect(checkForAppUpdate()).resolves.toBeNull();

    expect(check).toHaveBeenCalledWith({ timeout: APP_UPDATE_CHECK_TIMEOUT_MS });
  });

  it("uses the update-specific relaunch command after installing", async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    const update = {
      currentVersion: "0.1.0",
      version: "0.1.1",
      update: { downloadAndInstall },
    } as unknown as PendingAppUpdate;

    await downloadAndInstallAppUpdate(update);

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("relaunch_after_app_update");
  });
});
