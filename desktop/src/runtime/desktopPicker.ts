type OptionalDialogApi = {
  open?: (options: {
    directory?: boolean;
    filters?: Array<{ name: string; extensions: string[] }>;
    multiple?: boolean;
    title?: string;
  }) => Promise<string | string[] | null>;
};

export interface DesktopFileDragDropPosition {
  x: number;
  y: number;
}

export type DesktopFileDragDropEvent =
  | { type: "enter"; paths: string[]; position: DesktopFileDragDropPosition }
  | { type: "over"; position: DesktopFileDragDropPosition }
  | { type: "drop"; paths: string[]; position: DesktopFileDragDropPosition }
  | { type: "leave" };

export type DesktopFileDragDropListener = (event: DesktopFileDragDropEvent) => void;

export interface DesktopPickerRuntime {
  isDirectoryPickerAvailable(): boolean;
  isFilePickerAvailable(): boolean;
  pickDirectory(): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  pickImageFiles(): Promise<string[]>;
  listenForFileDragDrop(listener: DesktopFileDragDropListener): Promise<() => void>;
  revealPath(path: string): Promise<void>;
  deleteBrowserDownload(path: string): Promise<void>;
}

export interface DesktopPickerRuntimeOptions {
  dialogApi?: OptionalDialogApi | null;
  importDialogApi?: () => Promise<OptionalDialogApi | null>;
  subscribeFileDragDrop?: (listener: DesktopFileDragDropListener) => Promise<() => void>;
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  getTauriGlobal?: () => unknown;
  isTauriRuntime?: () => boolean;
}

export function createDesktopPickerRuntime(options: DesktopPickerRuntimeOptions = {}): DesktopPickerRuntime {
  return {
    isDirectoryPickerAvailable() {
      return isDialogOpenAvailable(options);
    },
    isFilePickerAvailable() {
      return isDialogOpenAvailable(options);
    },
    async pickDirectory() {
      const dialogApi =
        options.dialogApi ?? resolveGlobalDialogApi(options.getTauriGlobal) ?? (await loadDialogApi(options));
      if (!dialogApi?.open) {
        if (isLikelyTauriRuntime(options)) {
          throw new Error("文件夹选择器不可用：Tauri dialog API 未加载");
        }
        return null;
      }
      const result = await dialogApi.open({
        directory: true,
        multiple: false,
        title: "选择项目文件夹",
      });
      return typeof result === "string" ? result : null;
    },
    async pickFiles() {
      const dialogApi =
        options.dialogApi ?? resolveGlobalDialogApi(options.getTauriGlobal) ?? (await loadDialogApi(options));
      if (!dialogApi?.open) {
        if (isLikelyTauriRuntime(options)) {
          throw new Error("文件选择器不可用：Tauri dialog API 未加载");
        }
        return [];
      }
      const result = await dialogApi.open({
        directory: false,
        multiple: true,
        title: "选择文件",
      });
      return normalizeFilePickerResult(result);
    },
    async pickImageFiles() {
      const dialogApi =
        options.dialogApi ?? resolveGlobalDialogApi(options.getTauriGlobal) ?? (await loadDialogApi(options));
      if (!dialogApi?.open) {
        if (isLikelyTauriRuntime(options)) {
          throw new Error("文件选择器不可用：Tauri dialog API 未加载");
        }
        return [];
      }
      const result = await dialogApi.open({
        directory: false,
        multiple: true,
        title: "选择图片",
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "webp", "gif"],
          },
        ],
      });
      return normalizeFilePickerResult(result);
    },
    async listenForFileDragDrop(listener) {
      if (options.subscribeFileDragDrop) {
        return options.subscribeFileDragDrop(listener);
      }
      if (!isLikelyTauriRuntime(options)) {
        return () => undefined;
      }
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      return getCurrentWebview().onDragDropEvent((event) => {
        listener(event.payload);
      });
    },
    async revealPath(path) {
      const cleaned = path.trim();
      if (!cleaned) {
        throw new Error("文件路径不能为空");
      }
      if (!options.invoke && !isLikelyTauriRuntime(options)) {
        throw new Error("当前环境无法打开资源管理器，请在 Keydex 桌面应用中使用");
      }
      const invoke = options.invoke ?? (await import("@tauri-apps/api/core")).invoke;
      if (typeof invoke !== "function") {
        throw new Error("资源管理器桥接不可用，请重新启动 Keydex 桌面应用");
      }
      await invoke("open_path_in_file_manager", { path: cleaned });
    },
    async deleteBrowserDownload(path) {
      const cleaned = path.trim();
      if (!cleaned) {
        throw new Error("下载文件路径不能为空");
      }
      if (!options.invoke && !isLikelyTauriRuntime(options)) {
        throw new Error("当前环境无法删除下载文件，请在 Keydex 桌面应用中使用");
      }
      const invoke = options.invoke ?? (await import("@tauri-apps/api/core")).invoke;
      if (typeof invoke !== "function") {
        throw new Error("下载文件桥接不可用，请重新启动 Keydex 桌面应用");
      }
      await invoke("delete_browser_download", { path: cleaned });
    },
  };
}

function normalizeFilePickerResult(result: string | string[] | null): string[] {
  if (Array.isArray(result)) {
    return result.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  }
  return typeof result === "string" && result.trim() ? [result] : [];
}

function isDialogOpenAvailable(options: DesktopPickerRuntimeOptions): boolean {
  return Boolean(
    options.dialogApi?.open ||
      resolveGlobalDialogApi(options.getTauriGlobal)?.open ||
      isLikelyTauriRuntime(options),
  );
}

async function loadDialogApi(options: DesktopPickerRuntimeOptions): Promise<OptionalDialogApi | null> {
  if (options.importDialogApi) {
    return options.importDialogApi();
  }
  if (!isLikelyTauriRuntime(options)) {
    return null;
  }
  try {
    return await import("@tauri-apps/plugin-dialog");
  } catch {
    return null;
  }
}

function resolveGlobalDialogApi(getTauriGlobal?: () => unknown): OptionalDialogApi | null {
  const value = getTauriGlobal?.() ?? (typeof window !== "undefined" ? (window as unknown as TauriWindow).__TAURI__ : null);
  if (!value || typeof value !== "object") {
    return null;
  }
  const dialog = (value as { dialog?: unknown }).dialog;
  return dialog && typeof dialog === "object" ? (dialog as OptionalDialogApi) : null;
}

function isLikelyTauriRuntime(options: DesktopPickerRuntimeOptions = {}): boolean {
  if (options.isTauriRuntime) {
    return options.isTauriRuntime();
  }
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

type TauriWindow = Window & {
  __TAURI__?: unknown;
};
