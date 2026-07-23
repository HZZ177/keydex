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

  it("picks multiple files without image filtering", async () => {
    const open = vi.fn().mockResolvedValue(["D:\\tmp\\a.png", "D:\\tmp\\notes.txt"]);
    const runtime = createDesktopPickerRuntime({
      getTauriGlobal: () => ({ dialog: { open } }),
    });

    await expect(runtime.pickFiles()).resolves.toEqual(["D:\\tmp\\a.png", "D:\\tmp\\notes.txt"]);
    expect(open).toHaveBeenCalledWith({
      directory: false,
      multiple: true,
      title: "选择文件",
    });
  });

  it("forwards native Tauri file drag-drop paths and exposes cleanup", async () => {
    const unlisten = vi.fn();
    const subscribeFileDragDrop = vi.fn(async (listener) => {
      listener({
        type: "drop",
        paths: ["D:\\outside\\notes.txt"],
        position: { x: 120, y: 80 },
      });
      return unlisten;
    });
    const runtime = createDesktopPickerRuntime({ subscribeFileDragDrop });
    const listener = vi.fn();

    const cleanup = await runtime.listenForFileDragDrop(listener);

    expect(listener).toHaveBeenCalledWith({
      type: "drop",
      paths: ["D:\\outside\\notes.txt"],
      position: { x: 120, y: 80 },
    });
    cleanup();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("uses a no-op file drag-drop listener outside Tauri", async () => {
    const runtime = createDesktopPickerRuntime({
      getTauriGlobal: () => ({}),
      isTauriRuntime: () => false,
    });

    const cleanup = await runtime.listenForFileDragDrop(vi.fn());

    expect(cleanup()).toBeUndefined();
  });

  it("reports a broken Tauri dialog API instead of silently doing nothing", async () => {
    const runtime = createDesktopPickerRuntime({
      getTauriGlobal: () => ({}),
      isTauriRuntime: () => true,
      importDialogApi: async () => null,
    });

    expect(runtime.isDirectoryPickerAvailable()).toBe(true);
    await expect(runtime.pickDirectory()).rejects.toThrow("文件夹选择器不可用");
  });

  it("uses the desktop invoke bridge to reveal a path in the resource manager", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const runtime = createDesktopPickerRuntime({
      invoke,
      isTauriRuntime: () => true,
    });

    await expect(runtime.revealPath(" D:\\repo ")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("open_path_in_file_manager", { path: "D:\\repo" });
  });

  it("uses the restricted desktop command to delete a browser download", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const runtime = createDesktopPickerRuntime({
      invoke,
      isTauriRuntime: () => true,
    });

    await expect(runtime.deleteBrowserDownload(" D:\\Downloads\\report.pdf ")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("delete_browser_download", {
      path: "D:\\Downloads\\report.pdf",
    });
  });

  it("reports a clear capability error instead of calling Tauri invoke in a browser", async () => {
    const runtime = createDesktopPickerRuntime({
      getTauriGlobal: () => ({}),
      isTauriRuntime: () => false,
    });

    await expect(runtime.revealPath("D:\\repo")).rejects.toThrow("当前环境无法打开资源管理器");
  });
});
