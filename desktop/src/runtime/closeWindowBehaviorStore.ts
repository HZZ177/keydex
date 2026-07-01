import type { CloseWindowBehavior } from "@/types/protocol";

import { isCloseWindowBehavior } from "./windowLifecycle";

export const CLOSE_WINDOW_BEHAVIOR_STORAGE_KEY = "keydex:close-window-behavior";

export interface CloseWindowBehaviorStore {
  read(): CloseWindowBehavior | null;
  write(behavior: CloseWindowBehavior): void;
  clear(): void;
}

export const closeWindowBehaviorStore = createCloseWindowBehaviorStore();

export function createCloseWindowBehaviorStore(
  resolveStorage: () => Storage | null = resolveBrowserStorage,
): CloseWindowBehaviorStore {
  return {
    read() {
      const storage = resolveStorage();
      if (!storage) {
        return null;
      }
      const value = storage.getItem(CLOSE_WINDOW_BEHAVIOR_STORAGE_KEY);
      return isCloseWindowBehavior(value) ? value : null;
    },
    write(behavior) {
      const storage = resolveStorage();
      if (!storage) {
        return;
      }
      storage.setItem(CLOSE_WINDOW_BEHAVIOR_STORAGE_KEY, behavior);
    },
    clear() {
      const storage = resolveStorage();
      if (!storage) {
        return;
      }
      storage.removeItem(CLOSE_WINDOW_BEHAVIOR_STORAGE_KEY);
    },
  };
}

function resolveBrowserStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
