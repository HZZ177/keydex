import appPackage from "../../package.json";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

import { isTauriRuntime } from "./agentConnection";
import { normalizeReleaseMarkdown } from "./appReleaseNotes";

export interface PendingAppUpdate {
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  update: Update;
}

export interface AppUpdateProgress {
  downloadedBytes: number;
  totalBytes: number | null;
  finished: boolean;
}

export const APP_UPDATE_CHECK_TIMEOUT_MS = 15_000;

export async function getCurrentAppVersion(): Promise<string> {
  if (!isTauriRuntime()) {
    return appPackage.version;
  }
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return appPackage.version;
  }
}

export function canUseAppUpdater(): boolean {
  return isTauriRuntime();
}

export async function checkForAppUpdate(): Promise<PendingAppUpdate | null> {
  if (!canUseAppUpdater()) {
    throw new Error("当前环境不支持应用内更新");
  }
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check({ timeout: APP_UPDATE_CHECK_TIMEOUT_MS });
  if (!update) {
    return null;
  }
  return {
    currentVersion: update.currentVersion,
    version: update.version,
    date: update.date,
    body: normalizeReleaseMarkdown(update.body),
    update,
  };
}

export async function downloadAndInstallAppUpdate(
  update: PendingAppUpdate,
  onProgress?: (progress: AppUpdateProgress) => void,
): Promise<void> {
  let downloadedBytes = 0;
  let totalBytes: number | null = null;
  await update.update.download((event: DownloadEvent) => {
    if (event.event === "Started") {
      downloadedBytes = 0;
      totalBytes = event.data.contentLength ?? null;
      onProgress?.({ downloadedBytes, totalBytes, finished: false });
      return;
    }
    if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
      onProgress?.({ downloadedBytes, totalBytes, finished: false });
      return;
    }
    onProgress?.({
      downloadedBytes: totalBytes ?? downloadedBytes,
      totalBytes,
      finished: true,
    });
  });
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("prepare_app_update_install");
  try {
    await update.update.install();
  } catch (error) {
    try {
      await invoke("cancel_app_update_install");
    } catch {
      // Keep the updater error as the actionable failure. The native preparation
      // also has a bounded lease that restores normal Job Object behavior.
    }
    throw error;
  }
  await invoke("relaunch_after_app_update");
}
