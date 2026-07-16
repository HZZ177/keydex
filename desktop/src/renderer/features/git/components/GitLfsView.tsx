import { CloudDownload, CloudUpload, Database, LockKeyhole } from "lucide-react";
import { useState } from "react";

import type { GitLfsSnapshot } from "@/runtime/gitTypes";

import styles from "./GitLfsView.module.css";

export type GitLfsAction = "fetch" | "pull" | "push";

export function GitLfsView({ snapshot, loading, busy, onAction }: {
  snapshot: GitLfsSnapshot | null;
  loading: boolean;
  busy: boolean;
  onAction: (action: GitLfsAction, remote: string | null, refspec: string | null) => void;
}) {
  const [remote, setRemote] = useState("origin");
  const [refspec, setRefspec] = useState("HEAD");
  const disabled = busy || !snapshot?.available;
  return (
    <section className={styles.root} aria-label="Git 大文件存储">
      <header><Database size={14} /><strong>Git 大文件存储</strong></header>
      {loading ? <p>正在读取 Git 大文件存储状态…</p> : !snapshot?.available ? (
        <div className={styles.unavailable} role="status">
          <strong>Git 大文件存储不可用</strong>
          <span>请单独安装 Git 大文件存储扩展，然后刷新此仓库。</span>
          <small>Keydex 不会自动安装此扩展。</small>
        </div>
      ) : (
        <>
          <div className={styles.summary}>
            <span>{snapshot.files.length} 个大文件</span>
            <span>{snapshot.trackedPatterns.length} 个跟踪模式</span>
            <span>{snapshot.locksAvailable ? `${snapshot.locks.length} 个锁` : "锁信息不可用"}</span>
          </div>
          <div className={styles.columns}>
            <div><strong>跟踪模式</strong>{snapshot.trackedPatterns.length ? <ul>{snapshot.trackedPatterns.map((pattern) => <li key={pattern}><code>{pattern}</code></li>)}</ul> : <p>属性配置文件中没有大文件跟踪模式。</p>}</div>
            <div><strong>文件</strong>{snapshot.files.length ? <ul>{snapshot.files.map((file) => <li key={file.path}><code>{file.path}</code><small>{lfsFileStatusLabel(file.status)}{file.size === null ? "" : ` · ${formatBytes(file.size)}`}</small></li>)}</ul> : <p>当前暂存区中没有大文件。</p>}</div>
            <div><strong><LockKeyhole size={12} />锁</strong>{snapshot.locksAvailable ? snapshot.locks.length ? <ul>{snapshot.locks.map((lock) => <li key={lock.id}><code>{lock.path}</code><small>{lock.owner ?? "未知所有者"}{lock.lockedAt ? ` · ${lock.lockedAt}` : ""}</small></li>)}</ul> : <p>没有远程锁记录。</p> : <p>请配置可访问的远程仓库后再查询锁。</p>}</div>
          </div>
        </>
      )}
      <div className={styles.controls} aria-disabled={!snapshot?.available}>
        <label>远程仓库<input aria-label="Git 大文件存储远程仓库" value={remote} disabled={disabled} onChange={(event) => setRemote(event.target.value)} /></label>
        <label>引用规范<input aria-label="Git 大文件存储引用规范" value={refspec} disabled={disabled} onChange={(event) => setRefspec(event.target.value)} /></label>
        <div>
          <button type="button" disabled={disabled} onClick={() => onAction("fetch", remote.trim() || null, refspec.trim() || null)}><CloudDownload size={12} />获取对象</button>
          <button type="button" disabled={disabled} onClick={() => onAction("pull", remote.trim() || null, null)}><CloudDownload size={12} />拉取并签出</button>
          <button type="button" disabled={disabled || !remote.trim() || !refspec.trim()} onClick={() => onAction("push", remote.trim(), refspec.trim())}><CloudUpload size={12} />推送对象</button>
        </div>
      </div>
    </section>
  );
}

function lfsFileStatusLabel(status: GitLfsSnapshot["files"][number]["status"]): string {
  return ({ tracked: "已跟踪", missing: "对象缺失", modified: "已修改", unknown: "状态未知" } as Record<GitLfsSnapshot["files"][number]["status"], string>)[status];
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
