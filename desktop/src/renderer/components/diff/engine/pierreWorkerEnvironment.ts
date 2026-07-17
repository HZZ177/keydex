export type PierreWorkerRuntime = "web" | "tauri_dev" | "tauri_packaged";

export interface PierreWorkerEnvironment {
  readonly runtime: PierreWorkerRuntime;
  readonly pageUrl: string;
  readonly workerUrl: string;
  readonly protocol: string;
  readonly sameOrigin: boolean;
}

export interface ResolvePierreWorkerEnvironmentOptions {
  readonly pageUrl?: string;
  readonly tauriRuntime?: boolean;
}

export function resolvePierreWorkerEnvironment(
  assetUrl: string,
  options: ResolvePierreWorkerEnvironmentOptions = {},
): PierreWorkerEnvironment {
  if (looksLikeWindowsPath(assetUrl)) {
    throw new PierreWorkerEnvironmentError("Diff Worker 必须使用 WebView 资源 URL，不能使用 Windows 文件路径");
  }
  const pageUrl = options.pageUrl ?? currentPageUrl();
  const page = new URL(pageUrl);
  const worker = new URL(assetUrl, page);
  if (worker.protocol === "blob:" || worker.protocol === "data:") {
    throw new PierreWorkerEnvironmentError("Diff Worker 不允许使用 blob 或 data URL");
  }
  if (!["http:", "https:", "tauri:"].includes(worker.protocol)) {
    throw new PierreWorkerEnvironmentError(`Diff Worker 不支持 ${worker.protocol} 资源协议`);
  }
  const sameOrigin = webviewOrigin(worker) === webviewOrigin(page);
  if (!sameOrigin) {
    throw new PierreWorkerEnvironmentError("Diff Worker 必须与当前 WebView 同源");
  }
  const tauriRuntime = options.tauriRuntime ?? detectTauriRuntime();
  const runtime: PierreWorkerRuntime = !tauriRuntime
    ? "web"
    : (page.protocol === "http:" || page.protocol === "https:") && isDevHost(page.hostname)
      ? "tauri_dev"
      : "tauri_packaged";
  return Object.freeze({
    runtime,
    pageUrl: page.href,
    workerUrl: worker.href,
    protocol: worker.protocol,
    sameOrigin,
  });
}

export class PierreWorkerEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PierreWorkerEnvironmentError";
  }
}

function currentPageUrl(): string {
  return typeof window === "undefined" ? "http://keydex.local/" : window.location.href;
}

function detectTauriRuntime(): boolean {
  return typeof window !== "undefined"
    && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

function isDevHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function webviewOrigin(url: URL): string {
  return url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin;
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/iu.test(value) || value.startsWith("\\\\");
}
