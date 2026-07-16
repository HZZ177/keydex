import { Check, GitCommitHorizontal } from "lucide-react";
import { useEffect, useState } from "react";

import type { GitStatusSnapshot } from "@/runtime/gitTypes";
import type { GitIdentity } from "@/runtime/git";

import styles from "./GitCommitEditor.module.css";

export interface GitCommitOptions {
  message: string;
  amend: boolean;
  sign: boolean;
}

export interface GitCommitOutcome {
  oid: string | null;
  summary: string;
  status: string;
}

export interface GitCommitEditorProps {
  status: GitStatusSnapshot | null;
  selectedFileCount?: number;
  draft: string;
  committing?: boolean;
  onDraftChange: (draft: string) => void;
  onCommit: (options: GitCommitOptions) => void | Promise<void>;
  onCommitAndPush?: (options: GitCommitOptions) => void | Promise<void>;
  identity?: GitIdentity | null;
  identityLoading?: boolean;
  onConfigureIdentity?: (identity: { name: string; email: string; signByDefault: boolean }) => void | Promise<void>;
  outcome?: GitCommitOutcome | null;
  amendTarget?: { objectId: string; subject?: string | null; published: boolean } | null;
}

export function GitCommitEditor({
  status,
  selectedFileCount = 0,
  draft,
  committing = false,
  onDraftChange,
  onCommit,
  onCommitAndPush,
  identity,
  identityLoading = false,
  onConfigureIdentity,
  outcome = null,
  amendTarget = null,
}: GitCommitEditorProps) {
  const [amend, setAmend] = useState(false);
  const [sign, setSign] = useState(false);
  const [identityFormOpen, setIdentityFormOpen] = useState(false);
  const [identityName, setIdentityName] = useState("");
  const [identityEmail, setIdentityEmail] = useState("");
  const [amendConfirmed, setAmendConfirmed] = useState(false);
  const validation = validateCommitMessage(draft);
  const identityReady = identity === undefined || Boolean(identity?.name && identity.email);
  const completesMerge = status?.operation?.kind === "merge" && status.operation.state === "continuable";
  const amendReady = !amend || !amendTarget?.published || amendConfirmed;
  const needsSelectedFiles = selectedFileCount === 0 && !amend && !completesMerge;
  const canCommit = validation.valid && identityReady && amendReady && !needsSelectedFiles && !committing;
  const readinessMessage = validation.valid && needsSelectedFiles
    ? "请至少选择一个要提交的文件"
    : validation.message;

  useEffect(() => {
    if (identity?.signByDefault) setSign(true);
  }, [identity?.signByDefault]);

  return (
    <section className={styles.root} aria-label="Commit 编辑器">
      <header>
        <GitCommitHorizontal size={14} />
        <strong>Commit</strong>
        <span>{selectedFileCount} 个已选择文件</span>
      </header>
      <div className={styles.body}>
        <textarea
          value={draft}
          aria-label="Commit message"
          placeholder="提交说明（第一行建议不超过 72 个字符）"
          onChange={(event) => onDraftChange(event.currentTarget.value.replaceAll("\r\n", "\n"))}
        />
        <div className={styles.meta}>
          <span data-valid={validation.valid && !needsSelectedFiles ? "true" : "false"}>{readinessMessage}</span>
          <span>{draft.length} 字符</span>
        </div>
        {outcome ? (
          <output className={styles.outcome} aria-label="Commit result">
            <Check size={13} />
            <span>{outcome.summary}</span>
            {outcome.oid ? <code>{outcome.oid.slice(0, 12)}</code> : null}
          </output>
        ) : null}
        {amend ? (
          <div className={styles.amendPreview} role="status" aria-label="Amend rewrite preview">
            <strong>将重写提交 {amendTarget?.objectId.slice(0, 12) ?? "HEAD"}</strong>
            {amendTarget?.subject ? <span>{amendTarget.subject}</span> : null}
            <small>提交数量不会增加；原提交 OID 会被新的 OID 替代。</small>
            {amendTarget?.published ? (
              <label>
                <input
                  type="checkbox"
                  checked={amendConfirmed}
                  aria-label="确认重写已发布提交"
                  onChange={(event) => setAmendConfirmed(event.currentTarget.checked)}
                />
                我确认这会重写已发布历史
              </label>
            ) : null}
          </div>
        ) : null}
        {identity !== undefined ? (
          <div className={styles.identity} data-ready={identityReady ? "true" : "false"}>
            <span>
              {identityLoading
                ? "正在读取 Git identity…"
                : identityReady
                  ? `${identity?.name} <${identity?.email}>`
                  : "尚未配置 Git identity"}
            </span>
            {onConfigureIdentity ? (
              <button type="button" onClick={() => {
                setIdentityName(identity?.name ?? "");
                setIdentityEmail(identity?.email ?? "");
                setIdentityFormOpen((current) => !current);
              }}>
                {identityReady ? "修改" : "配置"}
              </button>
            ) : null}
          </div>
        ) : null}
        {identityFormOpen && onConfigureIdentity ? (
          <form
            className={styles.identityForm}
            onSubmit={(event) => {
              event.preventDefault();
              void onConfigureIdentity({ name: identityName.trim(), email: identityEmail.trim(), signByDefault: sign });
              setIdentityFormOpen(false);
            }}
          >
            <input value={identityName} aria-label="Git 用户名" placeholder="Name" onChange={(event) => setIdentityName(event.currentTarget.value)} />
            <input value={identityEmail} aria-label="Git 邮箱" placeholder="name@example.com" onChange={(event) => setIdentityEmail(event.currentTarget.value)} />
            <button type="submit" disabled={!identityName.trim() || !identityEmail.trim()}>保存到当前仓库</button>
          </form>
        ) : null}
      </div>
      <footer>
        <div className={styles.options}>
          <label><input type="checkbox" checked={amend} onChange={(event) => {
            setAmend(event.currentTarget.checked);
            setAmendConfirmed(false);
          }} />修订上次提交</label>
          <label><input type="checkbox" checked={sign} onChange={(event) => setSign(event.currentTarget.checked)} />GPG 签名</label>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            disabled={!canCommit}
            onClick={() => void onCommit({ message: draft.trim(), amend, sign })}
          >
            {committing ? "正在提交…" : <><Check size={13} />提交</>}
          </button>
          {onCommitAndPush ? (
            <button
              type="button"
              disabled={!canCommit}
              onClick={() => void onCommitAndPush({ message: draft.trim(), amend, sign })}
            >
              提交并推送
            </button>
          ) : null}
        </div>
      </footer>
    </section>
  );
}

export function validateCommitMessage(message: string): { valid: boolean; message: string } {
  const normalized = message.replaceAll("\r\n", "\n");
  if (!normalized.trim()) return { valid: false, message: "请输入提交说明" };
  const subject = normalized.split("\n", 1)[0].trim();
  if (subject.length > 100) return { valid: false, message: "标题不能超过 100 个字符" };
  if (subject.length > 72) return { valid: true, message: "标题超过建议的 72 个字符" };
  if (normalized.includes("\u0000")) return { valid: false, message: "提交说明不能包含 NUL 字符" };
  return { valid: true, message: "提交说明有效" };
}
