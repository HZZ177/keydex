import { RadioTower } from "lucide-react";
import { useEffect, useState } from "react";

import { GitConfirmActionDialog, GitDialogField, GitDialogSummary, GitFormDialog } from "@/renderer/features/git/dialogs";
import type { GitRemoteInfo } from "@/runtime/git";

import styles from "./GitRemoteManager.module.css";

export interface GitRemoteManagerProps {
  repositoryId?: string | null;
  remotes: readonly GitRemoteInfo[];
  busy?: boolean;
  error?: string | null;
  onAdd: (name: string, fetchUrl: string, pushUrl: string | null) => void | boolean | Promise<void | boolean>;
  onRename: (oldName: string, newName: string) => void | boolean | Promise<void | boolean>;
  onSetUrl: (name: string, url: string, push: boolean) => void | boolean | Promise<void | boolean>;
  onRemove: (remote: GitRemoteInfo) => void | boolean | Promise<void | boolean>;
}

type RemoteDialog = "add" | "rename" | "fetch_url" | "push_url";

export function GitRemoteManager({
  repositoryId = null,
  remotes,
  busy = false,
  error = null,
  onAdd,
  onRename,
  onSetUrl,
  onRemove,
}: GitRemoteManagerProps) {
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selected = remotes.find((remote) => remote.name === selectedName) ?? remotes[0] ?? null;
  const [dialog, setDialog] = useState<RemoteDialog | null>(null);
  const [removeRequest, setRemoveRequest] = useState<GitRemoteInfo | null>(null);
  const [name, setName] = useState("");
  const [fetchUrl, setFetchUrl] = useState("");
  const [pushUrl, setPushUrl] = useState("");
  const [value, setValue] = useState("");
  const normalizedName = name.trim();
  const nameConflict = remotes.some((remote) => remote.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase());

  useEffect(() => {
    setDialog(null);
    setRemoveRequest(null);
    setSelectedName(null);
  }, [repositoryId]);

  useEffect(() => {
    if (selectedName && !remotes.some((remote) => remote.name === selectedName)) setSelectedName(remotes[0]?.name ?? null);
  }, [remotes, selectedName]);

  const closeDialog = () => setDialog(null);
  const openSelectedDialog = (kind: Exclude<RemoteDialog, "add">) => {
    if (!selected) return;
    setValue(kind === "rename" ? selected.name : kind === "fetch_url" ? selected.fetchUrl ?? "" : selected.pushUrl ?? selected.fetchUrl ?? "");
    setDialog(kind);
  };

  return (
    <section className={styles.root} aria-label="远程仓库管理">
      <header><RadioTower size={14} /><strong>远程仓库</strong><span>{remotes.length}</span></header>
      <div className={styles.toolbar}>
        <span>远程仓库列表和地址</span>
        <button type="button" disabled={busy} onClick={() => { setName(""); setFetchUrl(""); setPushUrl(""); setDialog("add"); }}>添加远程仓库…</button>
      </div>
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
            <div className={styles.readonlyField}><span>名称</span><strong>{selected.name}</strong></div>
            <div className={styles.readonlyField}><span>获取地址</span><code>{selected.fetchUrl ?? "未配置"}</code></div>
            <div className={styles.readonlyField}><span>推送地址</span><code>{selected.pushUrl ?? selected.fetchUrl ?? "未配置"}</code></div>
            <div className={styles.actions}>
              <button type="button" disabled={busy} onClick={() => openSelectedDialog("rename")}>重命名…</button>
              <button type="button" disabled={busy} onClick={() => openSelectedDialog("fetch_url")}>编辑获取地址…</button>
              <button type="button" disabled={busy} onClick={() => openSelectedDialog("push_url")}>编辑推送地址…</button>
            </div>
            <div className={styles.removePreview}>
              <span>{selected.trackingBranches.length > 0
                ? `删除 ${selected.name} 会影响以下分支的上游设置：${selected.trackingBranches.join(", ")}`
                : `没有本地分支跟踪 ${selected.name}`}</span>
              <button type="button" disabled={busy} onClick={() => setRemoveRequest(selected)}>删除远程仓库…</button>
            </div>
          </div>
        ) : <div className={styles.empty}>尚未配置远程仓库</div>}
      </div>

      {dialog === "add" ? (
        <GitFormDialog
          title="添加远程仓库"
          description="配置远程仓库名称和地址；不会探测凭据或连接。"
          confirmLabel={busy ? "正在添加…" : "添加"}
          busy={busy}
          valid={Boolean(normalizedName && fetchUrl.trim() && !nameConflict)}
          error={error}
          onCancel={closeDialog}
          onSubmit={async () => {
            const succeeded = await onAdd(normalizedName, fetchUrl.trim(), pushUrl.trim() || null);
            if (succeeded !== false) {
              setSelectedName(normalizedName);
              closeDialog();
            }
          }}
        >
          <GitDialogField label="远程仓库名称" error={nameConflict ? "该远程仓库名称已存在" : undefined}>
            <input autoFocus aria-label="远程仓库名称" value={name} placeholder="例如：origin" onChange={(event) => setName(event.currentTarget.value)} />
          </GitDialogField>
          <GitDialogField label="获取地址" error={fetchUrl && !fetchUrl.trim() ? "请输入获取地址" : undefined}>
            <input aria-label="获取地址" value={fetchUrl} onChange={(event) => setFetchUrl(event.currentTarget.value)} />
          </GitDialogField>
          <GitDialogField label="推送地址" hint="可选；留空时沿用获取地址。">
            <input aria-label="推送地址" value={pushUrl} onChange={(event) => setPushUrl(event.currentTarget.value)} />
          </GitDialogField>
        </GitFormDialog>
      ) : null}

      {dialog && dialog !== "add" && selected ? (
        <GitFormDialog
          title={dialog === "rename" ? `重命名远程仓库 ${selected.name}` : dialog === "fetch_url" ? `编辑 ${selected.name} 的获取地址` : `编辑 ${selected.name} 的推送地址`}
          description={dialog === "rename" ? "远程跟踪引用会随远程仓库名称一起更新。" : "仅修改所选地址，其他配置保持不变。"}
          confirmLabel={busy ? "正在保存…" : dialog === "rename" ? "重命名" : "保存"}
          busy={busy}
          valid={Boolean(value.trim()) && (dialog !== "rename" || (
            value.trim() !== selected.name
            && !remotes.some((remote) => remote.name.toLocaleLowerCase() === value.trim().toLocaleLowerCase())
          ))}
          error={error}
          onCancel={closeDialog}
          onSubmit={async () => {
            const next = value.trim();
            const succeeded = dialog === "rename"
              ? await onRename(selected.name, next)
              : await onSetUrl(selected.name, next, dialog === "push_url");
            if (succeeded !== false) {
              if (dialog === "rename") setSelectedName(next);
              closeDialog();
            }
          }}
        >
          <GitDialogSummary>{selected.name}</GitDialogSummary>
          <GitDialogField
            label={dialog === "rename" ? "新名称" : dialog === "fetch_url" ? "获取地址" : "推送地址"}
            error={dialog === "rename" && remotes.some((remote) => remote.name !== selected.name && remote.name.toLocaleLowerCase() === value.trim().toLocaleLowerCase())
              ? "该远程仓库名称已存在"
              : undefined}
          >
            <input autoFocus aria-label={dialog === "rename" ? "重命名远程仓库" : dialog === "fetch_url" ? "编辑获取地址" : "编辑推送地址"} value={value} onChange={(event) => setValue(event.currentTarget.value)} />
          </GitDialogField>
        </GitFormDialog>
      ) : null}
      {removeRequest ? (
        <GitConfirmActionDialog
          title="删除远程仓库"
          description="删除远程仓库配置不会删除远程服务器上的数据，但对应远程跟踪引用和上游关系会失效。"
          target={removeRequest.name}
          details={removeRequest.trackingBranches.length > 0
            ? [`以下本地分支将失去上游：${removeRequest.trackingBranches.join("、")}`]
            : ["没有本地分支跟踪此远程仓库"]}
          confirmLabel={busy ? "正在删除…" : "删除远程仓库"}
          busy={busy}
          onCancel={() => setRemoveRequest(null)}
          onConfirm={() => {
            const remote = removeRequest;
            setRemoveRequest(null);
            void onRemove(remote);
          }}
        />
      ) : null}
    </section>
  );
}
