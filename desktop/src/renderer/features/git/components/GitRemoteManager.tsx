import { Plus, RadioTower } from "lucide-react";
import { useEffect, useState } from "react";

import type { GitRemoteInfo } from "@/runtime/git";

import styles from "./GitRemoteManager.module.css";

export interface GitRemoteManagerProps {
  remotes: readonly GitRemoteInfo[];
  busy?: boolean;
  onAdd: (name: string, fetchUrl: string, pushUrl: string | null) => void | Promise<void>;
  onRename: (oldName: string, newName: string) => void | Promise<void>;
  onSetUrl: (name: string, url: string, push: boolean) => void | Promise<void>;
  onRemove: (remote: GitRemoteInfo) => void | Promise<void>;
}

export function GitRemoteManager({ remotes, busy = false, onAdd, onRename, onSetUrl, onRemove }: GitRemoteManagerProps) {
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selected = remotes.find((remote) => remote.name === selectedName) ?? remotes[0] ?? null;
  const [name, setName] = useState("");
  const [fetchUrl, setFetchUrl] = useState("");
  const [pushUrl, setPushUrl] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [editedFetchUrl, setEditedFetchUrl] = useState("");
  const [editedPushUrl, setEditedPushUrl] = useState("");

  useEffect(() => {
    setRenameTo(selected?.name ?? "");
    setEditedFetchUrl(selected?.fetchUrl ?? "");
    setEditedPushUrl(selected?.pushUrl ?? "");
  }, [selected?.fetchUrl, selected?.name, selected?.pushUrl]);

  return (
    <section className={styles.root} aria-label="远程仓库管理">
      <header><RadioTower size={14} /><strong>远程仓库</strong><span>{remotes.length}</span></header>
      <form
        className={styles.add}
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || !fetchUrl.trim() || busy) return;
          void onAdd(name.trim(), fetchUrl.trim(), pushUrl.trim() || null);
          setName("");
          setFetchUrl("");
          setPushUrl("");
        }}
      >
        <input aria-label="远程仓库名称" value={name} placeholder="例如：origin" onChange={(event) => setName(event.currentTarget.value)} />
        <input aria-label="获取地址" value={fetchUrl} placeholder="获取地址" onChange={(event) => setFetchUrl(event.currentTarget.value)} />
        <input aria-label="推送地址" value={pushUrl} placeholder="推送地址（可选）" onChange={(event) => setPushUrl(event.currentTarget.value)} />
        <button type="submit" disabled={!name.trim() || !fetchUrl.trim() || busy}><Plus size={12} />添加</button>
      </form>
      <div className={styles.body}>
        <div className={styles.list} role="listbox" aria-label="Git 远程仓库">
          {remotes.map((remote) => (
            <button
              type="button"
              role="option"
              aria-selected={remote.name === selected?.name}
              key={remote.name}
              onClick={() => setSelectedName(remote.name)}
            >
              <strong>{remote.name}</strong>
              <span>{remote.fetchUrl ?? "未配置获取地址"}</span>
            </button>
          ))}
        </div>
        {selected ? (
          <div className={styles.editor}>
            <label>远程仓库名称<input aria-label="重命名远程仓库" value={renameTo} onChange={(event) => setRenameTo(event.currentTarget.value)} /></label>
            <button type="button" disabled={!renameTo.trim() || renameTo === selected.name || busy} onClick={() => void onRename(selected.name, renameTo.trim())}>重命名</button>
            <label>获取地址<input aria-label="编辑获取地址" value={editedFetchUrl} onChange={(event) => setEditedFetchUrl(event.currentTarget.value)} /></label>
            <button type="button" disabled={!editedFetchUrl.trim() || busy} onClick={() => void onSetUrl(selected.name, editedFetchUrl.trim(), false)}>保存获取地址</button>
            <label>推送地址<input aria-label="编辑推送地址" value={editedPushUrl} onChange={(event) => setEditedPushUrl(event.currentTarget.value)} /></label>
            <button type="button" disabled={!editedPushUrl.trim() || busy} onClick={() => void onSetUrl(selected.name, editedPushUrl.trim(), true)}>保存推送地址</button>
            <div className={styles.removePreview}>
              <span>{selected.trackingBranches.length > 0
                ? `删除 ${selected.name} 会影响以下分支的上游设置：${selected.trackingBranches.join(", ")}`
                : `没有本地分支跟踪 ${selected.name}`}</span>
              <button type="button" disabled={busy} onClick={() => void onRemove(selected)}>删除远程仓库…</button>
            </div>
          </div>
        ) : <div className={styles.empty}>尚未配置远程仓库</div>}
      </div>
    </section>
  );
}
