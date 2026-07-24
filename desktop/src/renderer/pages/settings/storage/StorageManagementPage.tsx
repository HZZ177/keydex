import { FolderOpen, HardDrive, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  storageRuntime,
  type StorageRuntime,
  type StorageStatus,
} from "@/runtime";

import styles from "./StorageManagementPage.module.css";

export interface StorageManagementPageProps {
  runtime?: StorageRuntime;
}

export function StorageManagementPage({
  runtime = storageRuntime,
}: StorageManagementPageProps) {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    void runtime
      .getStatus()
      .then(setStatus)
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => setLoading(false));
  }, [runtime]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openDirectory = (path: string) => {
    setError(null);
    void runtime.openDirectory(path).catch((reason) => setError(errorMessage(reason)));
  };

  return (
    <main className={styles.page} data-settings-page data-testid="storage-management-page">
      <header className={styles.header} data-settings-header>
        <div>
          <h1>存储管理</h1>
          <p>Keydex 的数据库、日志、附件和浏览器资料统一存放在安装目录内。</p>
        </div>
        <button
          aria-label="刷新存储占用"
          className={styles.refreshButton}
          disabled={loading}
          onClick={refresh}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={15} />
          刷新
        </button>
      </header>

      <section className={styles.summaryGrid} aria-label="存储概览">
        <article className={styles.summaryCard}>
          <span className={styles.cardIcon} aria-hidden="true">
            <HardDrive size={18} />
          </span>
          <div>
            <span>数据占用</span>
            <strong>{status ? formatBytes(status.totalBytes) : loading ? "统计中…" : "—"}</strong>
          </div>
        </article>
        <article className={styles.summaryCard}>
          <span className={styles.cardIcon} aria-hidden="true">
            <ShieldCheck size={18} />
          </span>
          <div>
            <span>存储布局</span>
            <strong>{status ? `统一目录 v${status.layoutVersion}` : "—"}</strong>
          </div>
        </article>
      </section>

      <section className={styles.section} aria-labelledby="storage-location-title">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="storage-location-title">存储位置</h2>
            <p>数据目录固定跟随应用安装目录，不再使用用户 AppData 作为主存储。</p>
          </div>
        </div>
        <div className={styles.pathPanel}>
          <PathRow
            label="安装目录"
            loading={loading}
            path={status?.installRoot ?? ""}
            onOpen={() => status && openDirectory(status.installRoot)}
          />
          <PathRow
            label="数据目录"
            loading={loading}
            path={status?.dataRoot ?? ""}
            onOpen={() => status && openDirectory(status.dataRoot)}
          />
        </div>
        <p className={styles.locationHint}>
          要迁移到其他磁盘，请把 Keydex 安装到目标目录。升级到统一存储版本后，首次启动会在应用和本地服务启动前自动迁移旧数据。
        </p>
      </section>

      <section className={styles.section} aria-labelledby="storage-usage-title">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="storage-usage-title">空间占用</h2>
            <p>按 Keydex 管理的数据类型统计。</p>
          </div>
        </div>
        <div className={styles.usagePanel}>
          {status?.categories.map((category) => {
            const ratio = status.totalBytes > 0 ? category.bytes / status.totalBytes : 0;
            return (
              <div className={styles.usageRow} key={category.id}>
                <div className={styles.usageLabel}>
                  <span>{category.label}</span>
                  <strong>{formatBytes(category.bytes)}</strong>
                </div>
                <div className={styles.usageTrack} aria-hidden="true">
                  <span style={{ width: `${Math.max(ratio * 100, category.bytes ? 1.5 : 0)}%` }} />
                </div>
              </div>
            );
          })}
          {!status && loading ? <p className={styles.empty}>正在统计存储占用…</p> : null}
        </div>
      </section>

      {status?.legacyCleanupPending ? (
        <p className={styles.warning} role="status">
          迁移已完成，但旧 AppData 目录仍有被占用的文件。Keydex 会在下次启动继续清理。
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </main>
  );
}

function PathRow({
  label,
  loading,
  path,
  onOpen,
}: {
  label: string;
  loading: boolean;
  path: string;
  onOpen: () => void;
}) {
  return (
    <div className={styles.pathRow}>
      <div>
        <span>{label}</span>
        <code title={path}>{path || (loading ? "正在读取…" : "不可用")}</code>
      </div>
      <button disabled={!path} onClick={onOpen} type="button">
        <FolderOpen aria-hidden="true" size={15} />
        打开
      </button>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.trim()) {
    return reason;
  }
  return "无法读取存储信息";
}
