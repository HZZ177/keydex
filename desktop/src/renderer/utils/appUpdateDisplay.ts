import type { AppUpdateProgress } from "@/runtime";

export function appUpdateProgressPercent(progress: AppUpdateProgress): number {
  if (!progress.totalBytes || progress.totalBytes <= 0) {
    return progress.finished ? 100 : 0;
  }
  return Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100));
}

export function appUpdateProgressText(progress: AppUpdateProgress): string {
  if (!progress.totalBytes || progress.totalBytes <= 0) {
    return `${formatBytes(progress.downloadedBytes)} 已下载`;
  }
  return `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${formatNumber(kib)} KB`;
  }
  return `${formatNumber(kib / 1024)} MB`;
}

function formatNumber(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}
