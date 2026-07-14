import { describe, expect, it, vi } from "vitest";

import { downloadAndInstallAppUpdate, type PendingAppUpdate } from "@/runtime/appUpdate";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("app update runtime", () => {
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
