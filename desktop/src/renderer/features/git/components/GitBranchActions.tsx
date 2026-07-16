import { GitBranch, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import type { GitRef, GitStatusSnapshot } from "@/runtime/gitTypes";

import styles from "./GitBranchActions.module.css";

export interface GitBranchActionsProps {
  refs: readonly GitRef[];
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
  onOpenChanges: () => void;
  onStashAndCheckout: (ref: GitRef) => void | Promise<void>;
}

export function GitBranchActions({
  refs,
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
  onOpenChanges,
  onStashAndCheckout,
}: GitBranchActionsProps) {
  const selected = useMemo(
    () => refs.find((ref) => ref.fullName === selectedRef) ?? refs.find((ref) => ref.current) ?? null,
    [refs, selectedRef],
  );
  const [branchName, setBranchName] = useState("");
  const [renameName, setRenameName] = useState("");
  const [dirtyCheckout, setDirtyCheckout] = useState<GitRef | null>(null);
  const [tagName, setTagName] = useState("");
  const [tagMessage, setTagMessage] = useState("");
  const [tagAnnotated, setTagAnnotated] = useState(false);
  const [tagSigned, setTagSigned] = useState(false);
  const [tagRemote, setTagRemote] = useState("origin");
  const [upstreamChoice, setUpstreamChoice] = useState("");
  const validation = validateBranchName(branchName);
  const dirty = Boolean(status?.files.length);
  const deletionRisk = branchDeletionRisk(selected, status);

  const checkout = () => {
    if (!selected || selected.current) return;
    if (dirty) {
      setDirtyCheckout(selected);
      return;
    }
    void onCheckout(selected);
  };

  return (
    <section className={styles.root} aria-label="分支操作">
      <header>
        <GitBranch size={15} />
        <strong>分支</strong>
        <span>{selected ? selected.shortName : "请选择引用"}</span>
      </header>
      <form
        className={styles.create}
        onSubmit={(event) => {
          event.preventDefault();
          if (!validation.valid || busy) return;
          void onCreate(branchName.trim(), selected?.shortName ?? "HEAD");
          setBranchName("");
        }}
      >
        <label htmlFor="git-new-branch">从 {selected?.shortName ?? "当前指针"} 新建分支</label>
        <div>
          <input
            id="git-new-branch"
            value={branchName}
            placeholder="feature/name"
            onChange={(event) => setBranchName(event.currentTarget.value)}
          />
          <button type="submit" disabled={!validation.valid || busy}><Plus size={13} />创建</button>
        </div>
        <small data-valid={validation.valid ? "true" : "false"}>{validation.message}</small>
      </form>
      <div className={styles.checkout}>
        <span>{selected?.current ? "当前分支" : "将工作树切换到所选引用"}</span>
        <button type="button" disabled={!selected || selected.current || busy} onClick={checkout}>签出</button>
      </div>
      {selected?.kind === "local" ? (
        <form
          className={styles.manage}
          onSubmit={(event) => {
            event.preventDefault();
            if (!validateBranchName(renameName).valid || busy) return;
            void onRename(selected, renameName.trim());
            setRenameName("");
          }}
        >
          <input
            value={renameName}
            aria-label={`重命名 ${selected.shortName}`}
            placeholder="新分支名称"
            onChange={(event) => setRenameName(event.currentTarget.value)}
          />
          <button type="submit" disabled={!validateBranchName(renameName).valid || busy}>重命名</button>
        </form>
      ) : null}
      {selected?.kind === "local" ? (
        <div className={styles.upstream}>
          <span>上游分支：{selected.upstream ?? "未配置"}</span>
          <select aria-label="上游分支" value={upstreamChoice} onChange={(event) => setUpstreamChoice(event.currentTarget.value)}>
            <option value="">选择远程分支</option>
            {refs.filter((ref) => ref.kind === "remote").map((ref) => (
              <option value={ref.shortName} key={ref.fullName}>{ref.shortName}</option>
            ))}
          </select>
          <button type="button" disabled={!upstreamChoice || busy} onClick={() => void onSetUpstream(selected, upstreamChoice)}>设置上游</button>
          <button type="button" disabled={!selected.upstream || busy} onClick={() => void onSetUpstream(selected, null)}>取消设置</button>
        </div>
      ) : null}
      {selected && !selected.current && selected.kind !== "tag" ? (
        <div className={styles.deleteZone} data-risk={deletionRisk}>
          <span>{selected.kind === "remote" ? `删除远程分支 ${selected.shortName}` : `删除 ${selected.shortName}`}</span>
          <button type="button" disabled={busy} onClick={() => void onDelete(selected, false)}>删除…</button>
          {selected.kind === "local" ? (
            <button type="button" disabled={busy} onClick={() => void onDelete(selected, true)}>强制删除…</button>
          ) : null}
        </div>
      ) : null}
      <form
        className={styles.tagForm}
        onSubmit={(event) => {
          event.preventDefault();
          if (!validateBranchName(tagName).valid || busy) return;
          void onCreateTag({
            name: tagName.trim(),
            target: selected?.shortName ?? "HEAD",
            annotated: tagAnnotated || tagSigned,
            message: tagMessage.trim(),
            sign: tagSigned,
          });
          setTagName("");
          setTagMessage("");
        }}
      >
        <strong>在 {selected?.shortName ?? "当前指针"} 创建标签</strong>
        <input aria-label="标签名称" value={tagName} placeholder="v1.0.0" onChange={(event) => setTagName(event.currentTarget.value)} />
        <label><input type="checkbox" checked={tagAnnotated} onChange={(event) => setTagAnnotated(event.currentTarget.checked)} />附注标签</label>
        <label><input type="checkbox" checked={tagSigned} onChange={(event) => setTagSigned(event.currentTarget.checked)} />签名标签</label>
        {tagAnnotated || tagSigned ? (
          <input aria-label="标签说明" value={tagMessage} placeholder="版本说明" onChange={(event) => setTagMessage(event.currentTarget.value)} />
        ) : null}
        <button type="submit" disabled={!validateBranchName(tagName).valid || busy}>创建标签</button>
      </form>
      {selected?.kind === "tag" ? (
        <div className={styles.tagDetails}>
          <strong>{selected.shortName}</strong>
          <span>目标 {(selected.peeledObjectId ?? selected.objectId).slice(0, 12)}</span>
          <span>{selected.annotated ? selected.annotation || "附注标签" : "轻量标签"}</span>
          <button type="button" onClick={() => void onDeleteTag(selected, null)}>删除本地标签…</button>
          <label>
            远程仓库
            <input value={tagRemote} aria-label="标签远程仓库" onChange={(event) => setTagRemote(event.currentTarget.value)} />
          </label>
          <button type="button" disabled={!tagRemote.trim() || busy} onClick={() => void onPushTag(selected, tagRemote.trim())}>推送标签…</button>
          <button type="button" disabled={!tagRemote.trim()} onClick={() => void onDeleteTag(selected, tagRemote.trim())}>删除远程标签…</button>
        </div>
      ) : null}
      {dirtyCheckout ? (
        <div className={styles.dirty} role="alert">
          <strong>工作树存在本地改动</strong>
          <span>切换到 {dirtyCheckout.shortName} 可能覆盖这些改动。Keydex 不会自动储藏。</span>
          <div>
            <button type="button" onClick={onOpenChanges}>提交改动</button>
            <button type="button" onClick={() => {
              const target = dirtyCheckout;
              setDirtyCheckout(null);
              void onStashAndCheckout(target);
            }}>储藏并签出</button>
            <button type="button" onClick={() => setDirtyCheckout(null)}>取消</button>
          </div>
        </div>
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
  const branch = value.trim();
  if (!branch) return { valid: false, message: "请输入分支名称" };
  if (branch.length > 255) return { valid: false, message: "分支名称过长" };
  if (
    branch.startsWith("-")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.includes("..")
    || branch.includes("@{")
    || /[\s~^:?*\\]/u.test(branch)
    || branch.includes("[")
  ) return { valid: false, message: "分支名称不符合 Git 规则" };
  return { valid: true, message: "分支名称有效" };
}
