import appPackage from "../../package.json";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

import { isTauriRuntime } from "./agentConnection";

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
  const update = await check();
  if (!update) {
    return null;
  }
  return {
    currentVersion: update.currentVersion,
    version: update.version,
    date: update.date,
    body: update.body,
    update,
  };
}

export async function downloadAndInstallAppUpdate(
  update: PendingAppUpdate,
  onProgress?: (progress: AppUpdateProgress) => void,
): Promise<void> {
  let downloadedBytes = 0;
  let totalBytes: number | null = null;
  await update.update.downloadAndInstall((event: DownloadEvent) => {
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
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
