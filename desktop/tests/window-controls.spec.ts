import { describe, expect, it, vi } from "vitest";

import { createWindowControls } from "@/renderer/components/layout/Titlebar/windowControls";

describe("window controls", () => {
  it("returns unavailable outside Tauri runtime", async () => {
    const controls = createWindowControls(async () => null);

    await expect(controls.minimize()).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("wraps Tauri window API errors", async () => {
    const error = new Error("native failure");
    const controls = createWindowControls(async () => ({
      minimize: vi.fn().mockRejectedValue(error),
      toggleMaximize: vi.fn(),
      close: vi.fn(),
      startDragging: vi.fn(),
    }));

    const result = await controls.minimize();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("error");
    expect(result.error).toBe(error);
  });
});
