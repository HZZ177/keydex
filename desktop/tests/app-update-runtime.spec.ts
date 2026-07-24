import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

  it("allows the trusted main webview to coordinate native update installation", () => {
    const permissions = readFileSync(
      resolve(process.cwd(), "src-tauri/permissions/application-commands.toml"),
      "utf8",
    );

    expect(permissions).toContain('"prepare_app_update_install"');
    expect(permissions).toContain('"cancel_app_update_install"');
    expect(permissions).toContain('"relaunch_after_app_update"');
  });

  it("prepares the supervisor after downloading and before installing", async () => {
    const download = vi.fn().mockResolvedValue(undefined);
    const install = vi.fn().mockResolvedValue(undefined);
    const update = {
      currentVersion: "0.1.0",
      version: "0.1.1",
      update: { download, install },
    } as unknown as PendingAppUpdate;

    await downloadAndInstallAppUpdate(update);

    expect(download).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls).toEqual([
      ["prepare_app_update_install"],
      ["relaunch_after_app_update"],
    ]);
    expect(download.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]);
    expect(invoke.mock.invocationCallOrder[0]).toBeLessThan(install.mock.invocationCallOrder[0]);
  });

  it("restores normal supervisor behavior when installation fails", async () => {
    const installError = new Error("installer failed");
    const update = {
      currentVersion: "0.1.0",
      version: "0.1.1",
      update: {
        download: vi.fn().mockResolvedValue(undefined),
        install: vi.fn().mockRejectedValue(installError),
      },
    } as unknown as PendingAppUpdate;

    await expect(downloadAndInstallAppUpdate(update)).rejects.toBe(installError);

    expect(invoke.mock.calls).toEqual([
      ["prepare_app_update_install"],
      ["cancel_app_update_install"],
    ]);
  });

  it("does not prepare the supervisor when downloading fails", async () => {
    const downloadError = new Error("download failed");
    const update = {
      currentVersion: "0.1.0",
      version: "0.1.1",
      update: {
        download: vi.fn().mockRejectedValue(downloadError),
        install: vi.fn(),
      },
    } as unknown as PendingAppUpdate;

    await expect(downloadAndInstallAppUpdate(update)).rejects.toBe(downloadError);

    expect(invoke).not.toHaveBeenCalled();
  });
});
