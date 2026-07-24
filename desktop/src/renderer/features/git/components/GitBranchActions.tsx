import { GitBranch } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { GitRef, GitStatusSnapshot } from "@/runtime/gitTypes";
import {
  GitConfirmActionDialog,
  GitDialogField,
  GitDialogOptions,
  GitDialogSummary,
  GitFormDialog,
  validateGitBranchName,
} from "@/renderer/features/git/dialogs";

import styles from "./GitBranchActions.module.css";

export interface GitBranchActionsProps {
  refs: readonly GitRef[];
  remotes?: readonly string[];
  selectedRef: string | null;
  status: GitStatusSnapshot | null;
  busy?: boolean;
  onCreate: (branchName: string, startPoint: string) => void | Promise<void>;
  onCheckout: (ref: GitRef) => void | Promise<void>;
  onRename: (ref: GitRef, newName: string) => void | Promise<void>;
  onDelete: (ref: GitRef, force: boolean) => void | Promise<void>;
  onCreateTag: (options: { name: string; target: string; annotated: boolean; message: string; sign: boolean }) => void | Promise<void>;
  onDeleteTag: (ref: GitRef, remote: string | null) => void | Promise<void>;
  onPushTag: (ref: GitRef, remote: string) => void | Promise<void>;
  onSetUpstream: (branch: GitRef, upstream: string | null) => void | Promise<void>;
}

export function GitBranchActions({
  refs,
  remotes = [],
  selectedRef,
  status,
  busy = false,
  onCreate,
  onCheckout,
  onRename,
  onDelete,
  onCreateTag,
  onDeleteTag,
  onPushTag,
  onSetUpstream,
}: GitBranchActionsProps) {
  const selected = useMemo(
    () => refs.find((ref) => ref.fullName === selectedRef) ?? refs.find((ref) => ref.current) ?? null,
    [refs, selectedRef],
  );
  const [branchName, setBranchName] = useState("");
  const [renameName, setRenameName] = useState("");
  const [dialog, setDialog] = useState<"create" | "rename" | "upstream" | "create_tag" | "push_tag" | "delete_remote_tag" | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<
    | { kind: "branch"; ref: GitRef; force: boolean }
    | { kind: "tag"; ref: GitRef }
    | null
  >(null);
  const [tagName, setTagName] = useState("");
  const [tagMessage, setTagMessage] = useState("");
  const [tagAnnotated, setTagAnnotated] = useState(false);
  const [tagSigned, setTagSigned] = useState(false);
  const [tagRemote, setTagRemote] = useState(remotes[0] ?? "");
  const [upstreamChoice, setUpstreamChoice] = useState("");
  const validation = validateBranchName(branchName);
  const deletionRisk = branchDeletionRisk(selected, status);
  const availableRemotes = useMemo(() => Array.from(new Set([
    ...remotes,
    ...refs.filter((ref) => ref.kind === "remote").map((ref) => ref.shortName.split("/", 1)[0]).filter(Boolean),
  ])), [refs, remotes]);

  useEffect(() => {
    setDialog(null);
    setDeleteRequest(null);
    setBranchName("");
    setRenameName("");
    setTagName("");
    setTagMessage("");
    setUpstreamChoice("");
  }, [selectedRef]);

  useEffect(() => {
    if (!availableRemotes.includes(tagRemote)) setTagRemote(availableRemotes[0] ?? "");
  }, [availableRemotes, tagRemote]);

  const checkout = () => {
    if (!selected || selected.current) return;
    void onCheckout(selected);
  };

  return (
    <section className={styles.root} aria-label="分支操作">
      <header>
        <GitBranch size={15} />
        <strong>分支</strong>
        <span>{selected ? selected.shortName : "请选择引用"}</span>
      </header>
      <div className={styles.actionGrid}>
        <button type="button" disabled={busy} onClick={() => setDialog("create")}>新建分支…</button>
        <button type="button" disabled={!selected || selected.current || busy} onClick={checkout}>签出…</button>
        {selected?.kind === "local" ? <button type="button" disabled={busy} onClick={() => { setRenameName(selected.shortName); setDialog("rename"); }}>重命名…</button> : null}
        {selected?.kind === "local" ? <button type="button" disabled={busy} onClick={() => {
          setUpstreamChoice(selected.upstream ?? refs.find((ref) => ref.kind === "remote")?.shortName ?? "");
          setDialog("upstream");
        }}>设置上游…</button> : null}
        <button type="button" disabled={busy} onClick={() => setDialog("create_tag")}>创建标签…</button>
      </div>
      {selected?.kind === "local" ? (
        <div className={styles.upstreamSummary}>
          <span>上游分支：{selected.upstream ?? "未配置"}</span>
          <button type="button" disabled={!selected.upstream || busy} onClick={() => void onSetUpstream(selected, null)}>取消设置</button>
        </div>
      ) : null}
      {selected && !selected.current && selected.kind !== "tag" ? (
        <div className={styles.deleteZone} data-risk={deletionRisk}>
          <span>{selected.kind === "remote" ? `删除远程分支 ${selected.shortName}` : `删除 ${selected.shortName}`}</span>
          <button type="button" disabled={busy} onClick={() => setDeleteRequest({ kind: "branch", ref: selected, force: false })}>删除…</button>
          {selected.kind === "local" ? (
            <button type="button" disabled={busy} onClick={() => setDeleteRequest({ kind: "branch", ref: selected, force: true })}>强制删除…</button>
          ) : null}
        </div>
      ) : null}
      {selected?.kind === "tag" ? (
        <div className={styles.tagDetails}>
          <strong>{selected.shortName}</strong>
          <span>目标 {(selected.peeledObjectId ?? selected.objectId).slice(0, 12)}</span>
          <span>{selected.annotated ? selected.annotation || "附注标签" : "轻量标签"}</span>
          <button type="button" disabled={busy} onClick={() => setDeleteRequest({ kind: "tag", ref: selected })}>删除本地标签…</button>
          <button type="button" disabled={busy} onClick={() => setDialog("push_tag")}>推送标签…</button>
          <button type="button" disabled={busy} onClick={() => setDialog("delete_remote_tag")}>删除远程标签…</button>
        </div>
      ) : null}
      {dialog === "create" ? (
        <GitFormDialog
          title="创建新分支"
          description={`基于 ${selected?.shortName ?? "HEAD"} 创建本地分支。`}
          confirmLabel={busy ? "正在创建…" : "创建"}
          busy={busy}
          valid={validation.valid}
          onCancel={() => setDialog(null)}
          onSubmit={async () => {
            await onCreate(branchName.trim(), selected?.shortName ?? "HEAD");
            setBranchName("");
            setDialog(null);
          }}
        >
          <GitDialogSummary>起点：{selected?.shortName ?? "HEAD"}</GitDialogSummary>
          <GitDialogField label="分支名称" error={branchName && !validation.valid ? validation.message : undefined}>
            <input autoFocus aria-label="新分支名称" value={branchName} placeholder="feature/name" onChange={(event) => setBranchName(event.currentTarget.value)} />
          </GitDialogField>
        </GitFormDialog>
      ) : null}
      {dialog === "rename" && selected?.kind === "local" ? (
        <GitFormDialog
          title={`重命名分支 ${selected.shortName}`}
          description="输入新的本地分支名称。"
          confirmLabel={busy ? "正在重命名…" : "重命名"}
          busy={busy}
          valid={validateBranchName(renameName).valid && renameName.trim() !== selected.shortName}
          onCancel={() => setDialog(null)}
          onSubmit={async () => {
            await onRename(selected, renameName.trim());
            setDialog(null);
          }}
        >
          <GitDialogSummary>原名称：{selected.shortName}</GitDialogSummary>
          <GitDialogField label="新分支名称" error={renameName && !validateBranchName(renameName).valid ? validateBranchName(renameName).message : undefined}>
            <input autoFocus aria-label="重命名分支" value={renameName} onChange={(event) => setRenameName(event.currentTarget.value)} />
          </GitDialogField>
        </GitFormDialog>
      ) : null}
      {dialog === "upstream" && selected?.kind === "local" ? (
        <GitFormDialog
          title={`设置 ${selected.shortName} 的上游`}
          description="仅可选择明确存在的远程跟踪分支。"
          confirmLabel={busy ? "正在设置…" : "设置上游"}
          busy={busy}
          valid={Boolean(upstreamChoice)}
          onCancel={() => setDialog(null)}
          onSubmit={async () => {
            await onSetUpstream(selected, upstreamChoice);
            setDialog(null);
          }}
        >
          <GitDialogSummary>当前上游：{selected.upstream ?? "未配置"}</GitDialogSummary>
          <GitDialogField label="远程分支" error={!refs.some((ref) => ref.kind === "remote") ? "没有可选择的远程分支" : undefined}>
            <select autoFocus aria-label="上游分支" value={upstreamChoice} onChange={(event) => setUpstreamChoice(event.currentTarget.value)}>
              <option value="">选择远程分支</option>
              {refs.filter((ref) => ref.kind === "remote").map((ref) => <option value={ref.shortName} key={ref.fullName}>{ref.shortName}</option>)}
            </select>
          </GitDialogField>
        </GitFormDialog>
      ) : null}
      {dialog === "create_tag" ? (
        <GitFormDialog
          title="创建标签"
          description={`在 ${selected?.shortName ?? "HEAD"} 创建标签。`}
          confirmLabel={busy ? "正在创建…" : "创建标签"}
          busy={busy}
          valid={validateBranchName(tagName).valid}
          onCancel={() => setDialog(null)}
          onSubmit={async () => {
            await onCreateTag({
              name: tagName.trim(),
              target: selected?.shortName ?? "HEAD",
              annotated: tagAnnotated || tagSigned,
              message: tagMessage.trim(),
              sign: tagSigned,
            });
            setTagName("");
            setTagMessage("");
            setDialog(null);
          }}
        >
          <GitDialogSummary>目标：{selected?.shortName ?? "HEAD"}</GitDialogSummary>
          <GitDialogField label="标签名称" error={tagName && !validateBranchName(tagName).valid ? validateBranchName(tagName).message : undefined}>
            <input autoFocus aria-label="标签名称" value={tagName} placeholder="v1.0.0" onChange={(event) => setTagName(event.currentTarget.value)} />
          </GitDialogField>
          <GitDialogOptions>
            <label><input type="checkbox" checked={tagAnnotated} onChange={(event) => setTagAnnotated(event.currentTarget.checked)} />附注标签</label>
            <label><input type="checkbox" checked={tagSigned} onChange={(event) => setTagSigned(event.currentTarget.checked)} />签名标签</label>
          </GitDialogOptions>
          {tagAnnotated || tagSigned ? (
            <GitDialogField label="标签说明">
              <textarea aria-label="标签说明" value={tagMessage} placeholder="版本说明" onChange={(event) => setTagMessage(event.currentTarget.value)} />
            </GitDialogField>
          ) : null}
        </GitFormDialog>
      ) : null}
      {(dialog === "push_tag" || dialog === "delete_remote_tag") && selected?.kind === "tag" ? (
        <GitFormDialog
          title={dialog === "push_tag" ? `推送标签 ${selected.shortName}` : `删除远程标签 ${selected.shortName}`}
          description={dialog === "push_tag" ? "选择要接收该标签的远程仓库。" : "仅删除所选远程仓库中的标签，本地标签会保留。"}
          confirmLabel={busy ? "正在处理…" : dialog === "push_tag" ? "推送标签" : "删除远程标签"}
          confirmTone={dialog === "delete_remote_tag" ? "danger" : "default"}
          busy={busy}
          valid={Boolean(tagRemote)}
          onCancel={() => setDialog(null)}
          onSubmit={async () => {
            if (dialog === "push_tag") await onPushTag(selected, tagRemote);
            else await onDeleteTag(selected, tagRemote);
            setDialog(null);
          }}
        >
          <GitDialogSummary tone={dialog === "delete_remote_tag" ? "danger" : "default"}>标签：{selected.shortName}</GitDialogSummary>
          <GitDialogField label="远程仓库" error={!availableRemotes.length ? "当前仓库没有远程仓库" : undefined}>
            <select autoFocus aria-label="标签远程仓库" value={tagRemote} disabled={!availableRemotes.length} onChange={(event) => setTagRemote(event.currentTarget.value)}>
              {availableRemotes.map((remote) => <option value={remote} key={remote}>{remote}</option>)}
            </select>
          </GitDialogField>
        </GitFormDialog>
      ) : null}
      {deleteRequest ? (
        <GitConfirmActionDialog
          title={deleteRequest.kind === "tag" ? "删除本地标签" : deleteRequest.force ? "强制删除分支" : deleteRequest.ref.kind === "remote" ? "删除远程分支" : "删除分支"}
          description={deleteRequest.kind === "tag"
            ? "删除标签不会删除其指向的提交，但标签名称需要手动重建。"
            : "删除分支不会删除工作区文件；未被其他引用保留的提交之后只能通过引用记录恢复。"}
          target={deleteRequest.ref.shortName}
          details={deleteRequest.kind === "branch" ? [
            deleteRequest.ref.kind === "remote" ? "将删除远程仓库中的分支" : "仅删除本地分支引用",
            deleteRequest.force ? "允许删除尚未合并的分支" : "仅在 Git 判定已合并时删除",
            branchDeletionRisk(deleteRequest.ref, status) === "protected" ? "这是受保护或上游关联分支" : "不会自动切换当前分支",
          ] : []}
          confirmLabel={busy ? "正在删除…" : "删除"}
          busy={busy}
          onCancel={() => setDeleteRequest(null)}
          onConfirm={() => {
            const request = deleteRequest;
            setDeleteRequest(null);
            if (request.kind === "tag") void onDeleteTag(request.ref, null);
            else void onDelete(request.ref, request.force);
          }}
        />
      ) : null}
    </section>
  );
}

export type GitBranchDeletionRisk = "current" | "protected" | "remote" | "normal";

export function branchDeletionRisk(
  ref: GitRef | null,
  status: GitStatusSnapshot | null,
): GitBranchDeletionRisk {
  if (!ref || ref.current) return "current";
  if (ref.kind === "remote") return "remote";
  const protectedNames = new Set(["main", "master"]);
  const upstreamBranch = status?.branch.upstream?.split("/", 2)[1] ?? null;
  if (protectedNames.has(ref.shortName) || upstreamBranch === ref.shortName) return "protected";
  return "normal";
}

export function validateBranchName(value: string): { valid: boolean; message: string } {
  return validateGitBranchName(value);
}
