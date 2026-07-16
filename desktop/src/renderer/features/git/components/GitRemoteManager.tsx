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
    <section className={styles.root} aria-label="Remote manager">
      <header><RadioTower size={14} /><strong>Remotes</strong><span>{remotes.length}</span></header>
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
        <input aria-label="Remote name" value={name} placeholder="origin" onChange={(event) => setName(event.currentTarget.value)} />
        <input aria-label="Fetch URL" value={fetchUrl} placeholder="Fetch URL" onChange={(event) => setFetchUrl(event.currentTarget.value)} />
        <input aria-label="Push URL" value={pushUrl} placeholder="Push URL (optional)" onChange={(event) => setPushUrl(event.currentTarget.value)} />
        <button type="submit" disabled={!name.trim() || !fetchUrl.trim() || busy}><Plus size={12} />Add</button>
      </form>
      <div className={styles.body}>
        <div className={styles.list} role="listbox" aria-label="Git remotes">
          {remotes.map((remote) => (
            <button
              type="button"
              role="option"
              aria-selected={remote.name === selected?.name}
              key={remote.name}
              onClick={() => setSelectedName(remote.name)}
            >
              <strong>{remote.name}</strong>
              <span>{remote.fetchUrl ?? "No fetch URL"}</span>
            </button>
          ))}
        </div>
        {selected ? (
          <div className={styles.editor}>
            <label>Remote name<input aria-label="Rename remote" value={renameTo} onChange={(event) => setRenameTo(event.currentTarget.value)} /></label>
            <button type="button" disabled={!renameTo.trim() || renameTo === selected.name || busy} onClick={() => void onRename(selected.name, renameTo.trim())}>Rename</button>
            <label>Fetch URL<input aria-label="Edit fetch URL" value={editedFetchUrl} onChange={(event) => setEditedFetchUrl(event.currentTarget.value)} /></label>
            <button type="button" disabled={!editedFetchUrl.trim() || busy} onClick={() => void onSetUrl(selected.name, editedFetchUrl.trim(), false)}>Save fetch URL</button>
            <label>Push URL<input aria-label="Edit push URL" value={editedPushUrl} onChange={(event) => setEditedPushUrl(event.currentTarget.value)} /></label>
            <button type="button" disabled={!editedPushUrl.trim() || busy} onClick={() => void onSetUrl(selected.name, editedPushUrl.trim(), true)}>Save push URL</button>
            <div className={styles.removePreview}>
              <span>{selected.trackingBranches.length > 0
                ? `Removing ${selected.name} affects upstream for: ${selected.trackingBranches.join(", ")}`
                : `No local branch tracks ${selected.name}`}</span>
              <button type="button" disabled={busy} onClick={() => void onRemove(selected)}>Remove remote…</button>
            </div>
          </div>
        ) : <div className={styles.empty}>No remotes configured</div>}
      </div>
    </section>
  );
}
