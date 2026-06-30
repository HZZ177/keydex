import type { CloseWindowBehavior } from "@/types/protocol";

export const WINDOW_CLOSE_REQUESTED_EVENT = "keydex://window-close-requested";

declare global {
  interface Window {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }
}

export interface WindowLifecycleRuntime {
  listenForCloseRequest(handler: () => void): Promise<() => void>;
  hideWindowToTray(): Promise<void>;
  exitApplication(): Promise<void>;
}

export const windowLifecycleRuntime: WindowLifecycleRuntime = {
  async listenForCloseRequest(handler) {
    if (!isTauriRuntime()) {
      return () => undefined;
    }
    const { listen } = await import("@tauri-apps/api/event");
    return listen(WINDOW_CLOSE_REQUESTED_EVENT, handler);
  },
  async hideWindowToTray() {
    if (!isTauriRuntime()) {
      return;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("hide_main_window");
  },
  async exitApplication() {
    if (!isTauriRuntime()) {
      return;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("request_app_exit");
  },
};

export function isCloseWindowBehavior(value: unknown): value is CloseWindowBehavior {
  return value === "exit" || value === "minimize_to_tray";
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);
}
