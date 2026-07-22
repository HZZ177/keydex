import { MonitorX, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";

import type { BrowserNavigationFailure } from "../runtime/BrowserPolicyCoordinator";

import styles from "./BrowserErrorView.module.css";

export interface BrowserErrorViewProps extends BrowserNavigationFailure {
  onRetry(): void;
}

const ERROR_COPY: Readonly<Record<string, { readonly title: string; readonly description: string }>> = {
  authentication: { title: "网站拒绝了连接", description: "该页面需要重新验证身份。" },
  dns: { title: "找不到此网站", description: "请检查网址或网络连接后重试。" },
  network: { title: "无法连接到网站", description: "网络连接已中断或网站暂时不可用。" },
  redirect: { title: "页面重定向失败", description: "网站进行了无法完成的跳转。" },
  timeout: { title: "网站响应超时", description: "网站等待时间过长，请稍后重试。" },
  desktop_runtime_required: {
    title: "需要 Keydex 桌面运行时",
    description: "当前是普通 Web 开发页，无法承载原生 WebView2 浏览器表面。保留 pnpm run dev 后，请另行启动桌面开发壳。",
  },
  tls_certificate: {
    title: "此连接不安全",
    description: "网站证书无效。Keydex 已阻止继续访问，且不提供绕过入口。",
  },
};

export function BrowserErrorView({ category, url, onRetry }: BrowserErrorViewProps) {
  const copy = ERROR_COPY[category] ?? {
    title: "无法打开此页面",
    description: "浏览器未能完成导航，请检查地址后重试。",
  };
  const secureFailure = category === "tls_certificate";
  const desktopRuntimeRequired = category === "desktop_runtime_required";

  return (
    <div className={styles.root} data-browser-error={category} role="alert">
      <span className={styles.icon} data-danger={secureFailure ? "true" : "false"} aria-hidden="true">
        {desktopRuntimeRequired
          ? <MonitorX size={22} />
          : secureFailure
            ? <ShieldAlert size={22} />
            : <WifiOff size={22} />}
      </span>
      <h3>{copy.title}</h3>
      <p>{copy.description}</p>
      <code title={desktopRuntimeRequired ? "pnpm run tauri:dev:isolated" : url}>
        {desktopRuntimeRequired ? "pnpm run tauri:dev:isolated" : url}
      </code>
      {!desktopRuntimeRequired ? (
        <button type="button" onClick={onRetry}>
          <RefreshCw aria-hidden="true" size={13} />
          重试
        </button>
      ) : null}
    </div>
  );
}
