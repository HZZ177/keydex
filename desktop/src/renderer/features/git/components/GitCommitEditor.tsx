import { Check, GitCommitHorizontal } from "lucide-react";

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
  outcome?: GitCommitOutcome | null;
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
  outcome = null,
}: GitCommitEditorProps) {
  const validation = validateCommitMessage(draft);
  const identityReady = identity === undefined || Boolean(identity?.name && identity.email);
  const completesMerge = status?.operation?.kind === "merge" && status.operation.state === "continuable";
  const needsSelectedFiles = selectedFileCount === 0 && !completesMerge;
  const canCommit = validation.valid && identityReady && !needsSelectedFiles && !committing;
  const readinessMessage = validation.valid && needsSelectedFiles
    ? "请至少选择一个要提交的文件"
    : validation.message;

  return (
    <section className={styles.root} aria-label="提交编辑器">
      <header>
        <GitCommitHorizontal size={14} />
        <strong>提交</strong>
        <span>{selectedFileCount} 个已选择文件</span>
      </header>
      <div className={styles.body}>
        <textarea
          value={draft}
          aria-label="提交说明"
          placeholder="提交说明（第一行建议不超过 72 个字符）"
          onChange={(event) => onDraftChange(event.currentTarget.value.replaceAll("\r\n", "\n"))}
        />
        <div className={styles.meta}>
          <span data-valid={validation.valid && !needsSelectedFiles ? "true" : "false"}>{readinessMessage}</span>
          <span>{draft.length} 字符</span>
        </div>
        {outcome ? (
          <output className={styles.outcome} aria-label="提交结果">
            <Check size={13} />
            <span>{outcome.summary}</span>
            {outcome.oid ? <code>{outcome.oid.slice(0, 12)}</code> : null}
          </output>
        ) : null}
        {identity !== undefined ? (
          <div className={styles.identity} data-ready={identityReady ? "true" : "false"}>
            <span>
              {identityLoading
                ? "正在读取 Git 提交身份…"
                : identityReady
                  ? `${identity?.name} <${identity?.email}>`
                  : "尚未配置 Git 提交身份"}
            </span>
          </div>
        ) : null}
      </div>
      <footer>
        <div className={styles.actions}>
          <button
            type="button"
            disabled={!canCommit}
            onClick={() => void onCommit({ message: draft.trim(), amend: false, sign: false })}
          >
            {committing ? "正在提交…" : <><Check size={13} />提交</>}
          </button>
          {onCommitAndPush ? (
            <button
              type="button"
              disabled={!canCommit}
              onClick={() => void onCommitAndPush({ message: draft.trim(), amend: false, sign: false })}
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
  if (normalized.includes("\u0000")) return { valid: false, message: "提交说明不能包含空字符" };
  return { valid: true, message: "提交说明有效" };
}
