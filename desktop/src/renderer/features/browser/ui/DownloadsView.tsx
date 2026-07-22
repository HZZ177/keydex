import { useSyncExternalStore } from "react";
import { CheckCircle2, Download, LoaderCircle, TriangleAlert, XCircle } from "lucide-react";

import { AppDialog } from "@/renderer/components/dialog";
import { browserDownloadController, type BrowserDownloadItem } from "../runtime/BrowserDownloadController";

import styles from "./DownloadsView.module.css";

export interface DownloadsViewProps {
  onClose(): void;
}

export function DownloadsView({ onClose }: DownloadsViewProps) {
  const items = useSyncExternalStore(
    browserDownloadController.store.subscribe,
    () => browserDownloadController.store.getState().items,
    () => browserDownloadController.store.getState().items,
  );
  const ordered = Object.values(items).filter(Boolean).reverse() as BrowserDownloadItem[];
  return (
    <AppDialog title="下载" description="文件保存到系统 Downloads 文件夹" placement="right" size="drawer" onClose={onClose}>
      <div className={styles.list}>
        {ordered.length ? ordered.map((item) => <DownloadRow item={item} key={item.id} />) : (
          <div className={styles.empty}><Download size={20} /><span>暂无下载</span></div>
        )}
      </div>
    </AppDialog>
  );
}

function DownloadRow({ item }: { readonly item: BrowserDownloadItem }) {
  const status = item.state === "completed" ? "已完成"
    : item.state === "failed" ? "下载失败"
      : item.state === "cancelled" ? "已取消"
        : item.state === "requested" ? "等待确认" : progressLabel(item);
  const icon = item.state === "completed" ? <CheckCircle2 size={15} />
    : item.state === "failed" ? <TriangleAlert size={15} />
      : item.state === "cancelled" ? <XCircle size={15} /> : <LoaderCircle size={15} />;
  return (
    <article className={styles.item} data-state={item.state}>
      <span className={styles.icon} aria-hidden="true">{icon}</span>
      <span className={styles.details}>
        <strong title={item.filename}>{item.filename}</strong>
        <small>{status}</small>
      </span>
    </article>
  );
}

function progressLabel(item: BrowserDownloadItem): string {
  if (!item.totalBytes) return `${formatBytes(item.receivedBytes)} 已下载`;
  return `${Math.min(100, Math.round(item.receivedBytes / item.totalBytes * 100))}% · ${formatBytes(item.totalBytes)}`;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}
