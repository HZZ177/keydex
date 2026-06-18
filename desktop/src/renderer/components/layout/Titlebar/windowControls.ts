import type { Window as TauriWindow } from "@tauri-apps/api/window";

export type WindowAction = "minimize" | "toggleMaximize" | "close" | "startDragging";

export interface WindowActionResult {
  ok: boolean;
  reason?: "unavailable" | "error";
  error?: unknown;
}

export type TauriWindowProvider = () => Promise<Pick<
  TauriWindow,
  "minimize" | "toggleMaximize" | "close" | "startDragging"
> | null>;

declare global {
  interface Window {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauriRuntime() {
  return typeof window !== "undefined" && Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);
}

export const getCurrentTauriWindow: TauriWindowProvider = async () => {
  if (!isTauriRuntime()) {
    return null;
  }

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
};

export function createWindowControls(provider: TauriWindowProvider = getCurrentTauriWindow) {
  async function run(action: WindowAction): Promise<WindowActionResult> {
    const appWindow = await provider();
    if (!appWindow) {
      return { ok: false, reason: "unavailable" };
    }

    try {
      await appWindow[action]();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: "error", error };
    }
  }

  return {
    minimize: () => run("minimize"),
    toggleMaximize: () => run("toggleMaximize"),
    close: () => run("close"),
    startDragging: () => run("startDragging"),
  };
}

export type WindowControls = ReturnType<typeof createWindowControls>;
