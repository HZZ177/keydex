import { describe, expect, it, vi } from "vitest";

import { createDesktopPickerRuntime } from "@/runtime";

describe("DesktopPickerRuntime", () => {
  it("uses an available Tauri dialog API to pick a directory", async () => {
    const open = vi.fn().mockResolvedValue("D:\\repo");
    const runtime = createDesktopPickerRuntime({
      getTauriGlobal: () => ({ dialog: { open } }),
    });

    expect(runtime.isDirectoryPickerAvailable()).toBe(true);
    await expect(runtime.pickDirectory()).resolves.toBe("D:\\repo");
    expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "选择项目文件夹",
    });
  });

  it("falls back to manual path input when no Tauri dialog API exists", async () => {
    const runtime = createDesktopPickerRuntime({
      getTauriGlobal: () => ({}),
      importDialogApi: async () => null,
    });

    expect(runtime.isDirectoryPickerAvailable()).toBe(false);
    await expect(runtime.pickDirectory()).resolves.toBeNull();
  });

  it("treats a Tauri runtime as picker-capable before the dialog module is loaded", async () => {
    const open = vi.fn().mockResolvedValue("D:\\lazy-repo");
    const runtime = createDesktopPickerRuntime({
      getTauriGlobal: () => ({}),
      isTauriRuntime: () => true,
      importDialogApi: async () => ({ open }),
    });

    expect(runtime.isDirectoryPickerAvailable()).toBe(true);
    await expect(runtime.pickDirectory()).resolves.toBe("D:\\lazy-repo");
  });
});
