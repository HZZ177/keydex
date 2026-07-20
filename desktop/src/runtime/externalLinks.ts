type ShellOpenApi = {
  open: (target: string, openWith?: string) => Promise<void>;
};

type BrowserOpen = (url?: string | URL, target?: string, features?: string) => Window | null;

export interface OpenExternalUrlOptions {
  shellApi?: ShellOpenApi;
  importShellApi?: () => Promise<ShellOpenApi>;
  openWindow?: BrowserOpen;
  isTauriRuntime?: () => boolean;
  allowHttp?: boolean;
}

export async function openExternalUrl(rawUrl: string, options: OpenExternalUrlOptions = {}): Promise<void> {
  const target = normalizeExternalUrl(rawUrl, options.allowHttp ?? false);
  if (isLikelyTauriRuntime(options)) {
    const shellApi = options.shellApi ?? await loadShellApi(options);
    if (typeof shellApi.open !== "function") {
      throw new Error("系统浏览器桥接不可用，请重新启动 Keydex");
    }
    await shellApi.open(target);
    return;
  }

  const openWindow = options.openWindow ?? (typeof window !== "undefined" ? window.open.bind(window) : null);
  if (!openWindow || openWindow(target, "_blank", "noopener,noreferrer") === null) {
    throw new Error("浏览器阻止了新窗口，请允许 Keydex 打开外部链接");
  }
}

function normalizeExternalUrl(rawUrl: string, allowHttp: boolean): string {
  try {
    const target = new URL(rawUrl);
    if (target.protocol !== "https:" && !(allowHttp && target.protocol === "http:")) {
      throw new Error(allowHttp ? "只允许打开 HTTP 或 HTTPS 链接" : "只允许打开 HTTPS 链接");
    }
    return target.toString();
  } catch (reason) {
    if (reason instanceof Error && reason.message.startsWith("只允许打开")) {
      throw reason;
    }
    throw new Error("外部链接格式无效");
  }
}

async function loadShellApi(options: OpenExternalUrlOptions): Promise<ShellOpenApi> {
  if (options.importShellApi) {
    return options.importShellApi();
  }
  return import("@tauri-apps/plugin-shell");
}

function isLikelyTauriRuntime(options: OpenExternalUrlOptions): boolean {
  if (options.isTauriRuntime) {
    return options.isTauriRuntime();
  }
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}
