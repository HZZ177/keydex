import { Archive, FileDiff } from "lucide-react";
import { useEffect, useState } from "react";

import { GitConfirmActionDialog, GitDialogField, GitDialogOptions, GitDialogSummary, GitFormDialog, validateGitBranchName } from "@/renderer/features/git/dialogs";
import type { GitStashDetail, GitStashEntry } from "@/runtime/git";

import styles from "./GitStashView.module.css";

type StashDialog = "create" | "apply" | "pop" | "branch";

export function GitStashView({
  repositoryId = null,
  entries,
  selected,
  detail,
  selectedFileIndex,
  loading,
  hasMore,
  onSelect,
  onSelectFile,
  onLoadMore,
  busy,
  error = null,
  onCreate,
  onApply,
  onPop,
  onBranch,
  onDrop,
  onClear,
}: {
  repositoryId?: string | null;
  entries: readonly GitStashEntry[];
  selected: GitStashEntry | null;
  detail: GitStashDetail | null;
  selectedFileIndex: number;
  loading: boolean;
  hasMore: boolean;
  onSelect: (entry: GitStashEntry) => void;
  onSelectFile: (index: number) => void;
  onLoadMore: () => void;
  busy: boolean;
  error?: string | null;
  onCreate: (options: { message: string; staged: boolean; includeUntracked: boolean }) => void | boolean | Promise<void | boolean>;
  onApply: (entry: GitStashEntry, reinstateIndex: boolean) => void | boolean | Promise<void | boolean>;
  onPop: (entry: GitStashEntry, reinstateIndex: boolean) => void | boolean | Promise<void | boolean>;
  onBranch: (entry: GitStashEntry, branchName: string) => void | boolean | Promise<void | boolean>;
  onDrop: (entry: GitStashEntry) => void;
  onClear: () => void;
}) {
  const [dialog, setDialog] = useState<StashDialog | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<{ kind: "drop"; entry: GitStashEntry } | { kind: "clear" } | null>(null);
  const [message, setMessage] = useState("");
  const [staged, setStaged] = useState(false);
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [reinstateIndex, setReinstateIndex] = useState(false);
  const [branchName, setBranchName] = useState("");

  useEffect(() => {
    setDialog(null);
    setDeleteRequest(null);
    setReinstateIndex(false);
    setBranchName("");
  }, [repositoryId, selected?.objectId]);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <button type="button" disabled={busy} onClick={() => { setMessage(""); setStaged(false); setIncludeUntracked(false); setDialog("create"); }}>创建储藏…</button>
        <button type="button" className={styles.danger} disabled={busy || entries.length === 0} onClick={() => setDeleteRequest({ kind: "clear" })}>清空全部…</button>
      </div>
      {!loading && entries.length === 0 ? (
        <div className={styles.empty} role="status"><Archive size={20} /><strong>没有储藏记录</strong><span>创建储藏可以临时保存本地改动。</span></div>
      ) : <>
      <div className={styles.list} role="listbox" aria-label="Git 储藏记录" aria-busy={loading}>
        {entries.map((entry) => (
          <button
            type="button"
            role="option"
            aria-selected={selected?.objectId === entry.objectId}
            key={`${entry.selector}:${entry.objectId}`}
            onClick={() => onSelect(entry)}
          >
            <Archive size={13} />
            <span><strong>{entry.selector}</strong><small>{entry.message}</small></span>
            <time dateTime={entry.createdAt}>{formatStashDate(entry.createdAt)}</time>
          </button>
        ))}
        {hasMore ? <button type="button" className={styles.more} disabled={loading} onClick={onLoadMore}>{loading ? "正在读取…" : "读取更多"}</button> : null}
      </div>
      <section className={styles.detail} aria-label="储藏详情">
        {detail ? (
          <>
            <header>
              <div><strong>{detail.entry.message}</strong><span>{detail.entry.authorName} · 基础提交 {detail.entry.baseObjectId?.slice(0, 8) ?? "未知"}</span></div>
              <code>{detail.entry.objectId.slice(0, 8)}</code>
            </header>
            <div className={styles.actions}>
              <button type="button" disabled={busy || !selected} onClick={() => selected && void onApply(selected, false)}>应用</button>
              <button type="button" disabled={busy || !selected} onClick={() => { setReinstateIndex(false); setDialog("apply"); }}>应用选项…</button>
              <button type="button" disabled={busy || !selected} onClick={() => { setReinstateIndex(false); setDialog("pop"); }}>应用并删除…</button>
              <button type="button" disabled={busy || !selected} onClick={() => { setBranchName(""); setDialog("branch"); }}>从储藏创建分支…</button>
              <button type="button" className={styles.danger} disabled={busy || !selected} onClick={() => selected && setDeleteRequest({ kind: "drop", entry: selected })}>删除储藏…</button>
            </div>
            <div className={styles.files} role="listbox" aria-label="储藏文件">
              {detail.files.map((file, index) => (
                <button type="button" role="option" aria-selected={index === selectedFileIndex} key={`${file.oldPath}:${file.newPath}:${index}`} onClick={() => onSelectFile(index)}>
                  <FileDiff size={12} /><span>{file.newPath ?? file.oldPath}</span><small>{file.additions === null ? "二进制" : `+${file.additions ?? 0} −${file.deletions ?? 0}`}</small>
                </button>
              ))}
            </div>
          </>
        ) : <div className={styles.prompt}>{loading ? "正在读取储藏详情…" : "选择一条储藏记录以查看文件和差异。"}</div>}
      </section>
      </>}

      {dialog === "create" ? (
        <GitFormDialog
          title="创建储藏"
          description="临时保存当前工作树改动。已暂存模式与包含未跟踪文件不能同时使用。"
          confirmLabel={busy ? "正在创建…" : "创建储藏"}
          busy={busy}
          error={error}
          onCancel={() => setDialog(null)}
          onSubmit={async () => {
            const succeeded = await onCreate({ message: message.trim(), staged, includeUntracked });
            if (succeeded !== false) setDialog(null);
          }}
        >
          <GitDialogField label="储藏说明" hint="可选">
            <input autoFocus aria-label="储藏说明" value={message} onChange={(event) => setMessage(event.currentTarget.value)} />
          </GitDialogField>
          <GitDialogOptions>
            <label><input type="checkbox" checked={staged} disabled={busy || includeUntracked} onChange={(event) => { setStaged(event.currentTarget.checked); if (event.currentTarget.checked) setIncludeUntracked(false); }} />仅储藏已暂存改动</label>
            <label><input type="checkbox" checked={includeUntracked} disabled={busy || staged} onChange={(event) => { setIncludeUntracked(event.currentTarget.checked); if (event.currentTarget.checked) setStaged(false); }} />包含未跟踪文件</label>
          </GitDialogOptions>
        </GitFormDialog>
      ) : null}

      {(dialog === "apply" || dialog === "pop") && selected ? (
        <GitFormDialog
          title={dialog === "apply" ? `应用 ${selected.selector}` : `应用并删除 ${selected.selector}`}
          description={dialog === "pop" ? "仅在改动成功应用后删除这条储藏记录；冲突或失败时记录会保留。" : "把所选储藏中的改动应用到当前工作树。"}
          confirmLabel={busy ? "正在应用…" : dialog === "apply" ? "应用" : "应用并删除"}
          busy={busy}
          error={error}
          onCancel={() => setDialog(null)}
          onSubmit={async () => {
            const succeeded = dialog === "apply"
              ? await onApply(selected, reinstateIndex)
              : await onPop(selected, reinstateIndex);
            if (succeeded !== false) setDialog(null);
          }}
        >
          <GitDialogSummary tone={dialog === "pop" ? "warning" : "default"}>
            <strong>{selected.selector}</strong>
            <span>{selected.message}</span>
            <span>{selected.objectId.slice(0, 12)}</span>
          </GitDialogSummary>
          <GitDialogOptions>
            <label><input type="checkbox" checked={reinstateIndex} disabled={busy} onChange={(event) => setReinstateIndex(event.currentTarget.checked)} />恢复暂存状态</label>
          </GitDialogOptions>
        </GitFormDialog>
      ) : null}

      {dialog === "branch" && selected ? (
        <GitFormDialog
          title={`从 ${selected.selector} 创建分支`}
          description="基于储藏的基础提交创建分支，并把储藏改动应用到新分支。"
          confirmLabel={busy ? "正在创建…" : "创建分支"}
          busy={busy}
          valid={validateGitBranchName(branchName).valid}
          error={error}
          onCancel={() => setDialog(null)}
          onSubmit={async () => {
            const succeeded = await onBranch(selected, branchName.trim());
            if (succeeded !== false) setDialog(null);
          }}
        >
          <GitDialogSummary>{selected.selector} · {selected.objectId.slice(0, 12)}</GitDialogSummary>
          <GitDialogField label="分支名称" error={branchName && !validateGitBranchName(branchName).valid ? validateGitBranchName(branchName).message : undefined}>
            <input autoFocus aria-label="储藏分支名称" value={branchName} placeholder="feature/from-stash" onChange={(event) => setBranchName(event.currentTarget.value)} />
          </GitDialogField>
        </GitFormDialog>
      ) : null}
      {deleteRequest ? (
        <GitConfirmActionDialog
          title={deleteRequest.kind === "clear" ? "清空全部储藏" : "删除储藏"}
          description={deleteRequest.kind === "clear"
            ? "所有储藏记录都会被永久删除，无法从储藏列表恢复。"
            : "这条储藏记录会被永久删除；其中尚未应用的改动无法从储藏列表恢复。"}
          target={deleteRequest.kind === "clear" ? `${entries.length} 条储藏记录` : `${deleteRequest.entry.selector} · ${deleteRequest.entry.objectId.slice(0, 12)}`}
          details={deleteRequest.kind === "drop" ? [deleteRequest.entry.message] : entries.slice(0, 3).map((entry) => `${entry.selector} ${entry.message}`)}
          confirmLabel={busy ? "正在删除…" : deleteRequest.kind === "clear" ? `清空 ${entries.length} 条记录` : "删除储藏"}
          busy={busy}
          onCancel={() => setDeleteRequest(null)}
          onConfirm={() => {
            const request = deleteRequest;
            setDeleteRequest(null);
            if (request.kind === "clear") onClear();
            else onDrop(request.entry);
          }}
        />
      ) : null}
    </div>
  );
}

export function formatStashDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
