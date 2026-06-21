type OptionalDialogApi = {
  open?: (options: { directory?: boolean; multiple?: boolean; title?: string }) => Promise<string | string[] | null>;
};

export interface DesktopPickerRuntime {
  isDirectoryPickerAvailable(): boolean;
  pickDirectory(): Promise<string | null>;
}

export interface DesktopPickerRuntimeOptions {
  dialogApi?: OptionalDialogApi | null;
  importDialogApi?: () => Promise<OptionalDialogApi | null>;
  getTauriGlobal?: () => unknown;
  isTauriRuntime?: () => boolean;
}

export function createDesktopPickerRuntime(options: DesktopPickerRuntimeOptions = {}): DesktopPickerRuntime {
  return {
    isDirectoryPickerAvailable() {
      return Boolean(
        options.dialogApi?.open ||
          resolveGlobalDialogApi(options.getTauriGlobal)?.open ||
          isLikelyTauriRuntime(options),
      );
    },
    async pickDirectory() {
      const dialogApi =
        options.dialogApi ?? resolveGlobalDialogApi(options.getTauriGlobal) ?? (await loadDialogApi(options));
      if (!dialogApi?.open) {
        return null;
      }
      const result = await dialogApi.open({
        directory: true,
        multiple: false,
        title: "选择项目文件夹",
      });
      return typeof result === "string" ? result : null;
    },
  };
}

async function loadDialogApi(options: DesktopPickerRuntimeOptions): Promise<OptionalDialogApi | null> {
  if (options.importDialogApi) {
    return options.importDialogApi();
  }
  if (!isLikelyTauriRuntime(options)) {
    return null;
  }
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<OptionalDialogApi>;
    return await dynamicImport("@tauri-apps/plugin-dialog");
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
