import { Check, RotateCcw, ShieldAlert } from "lucide-react";

import type { GitConflictFileAction } from "@/runtime/git";
import type { GitConflictFile } from "@/runtime/gitTypes";

import styles from "./GitConflictActions.module.css";

export interface GitConflictActionOption {
  action: GitConflictFileAction;
  label: string;
  warning: string;
}

export function conflictActionOptions(file: GitConflictFile): readonly GitConflictActionOption[] {
  const allowed = new Set(file.allowedActions);
  const options: GitConflictActionOption[] = [];
  if (allowed.has("accept_ours") && file.stages.some((stage) => stage.stage === 2)) {
    options.push({ action: "accept_ours", label: "Accept ours", warning: "Replace the worktree result with OURS? Uncommitted conflict edits for this path will be lost." });
  }
  if (allowed.has("accept_theirs") && file.stages.some((stage) => stage.stage === 3)) {
    options.push({ action: "accept_theirs", label: "Accept theirs", warning: "Replace the worktree result with THEIRS? Uncommitted conflict edits for this path will be lost." });
  }
  if (allowed.has("keep_modified")) {
    options.push({ action: "keep_modified", label: "Keep modified file", warning: "Use the surviving modified side and replace the current worktree result?" });
  }
  if (allowed.has("accept_delete")) {
    options.push({ action: "accept_delete", label: "Accept deletion", warning: `Delete ${file.path} and stage that deletion as the conflict resolution?` });
  } else if (allowed.has("delete")) {
    options.push({ action: "delete", label: "Delete path", warning: `Delete ${file.path} and stage that deletion as the conflict resolution?` });
  }
  return options;
}

export function GitConflictActions({
  file,
  dirty,
  unresolvedBlocks,
  busy,
  recentlyResolvedPath,
  onAction,
  onReopen,
}: {
  file: GitConflictFile | null;
  dirty: boolean;
  unresolvedBlocks: number;
  busy: boolean;
  recentlyResolvedPath?: string | null;
  onAction: (action: GitConflictFileAction) => void;
  onReopen?: () => void;
}) {
  if (!file && !recentlyResolvedPath) return null;
  return (
    <section className={styles.root} aria-label="Conflict resolution actions">
      {file ? (
        <>
          <header><ShieldAlert size={13} /><strong>Resolve {file.path}</strong></header>
          <div className={styles.actions}>{conflictActionOptions(file).map((option) => (
            <button
              type="button"
              key={option.action}
              disabled={busy}
              onClick={() => { if (window.confirm(option.warning)) onAction(option.action); }}
            >{option.label}</button>
          ))}</div>
          <button
            type="button"
            className={styles.resolve}
            disabled={busy || dirty || unresolvedBlocks > 0}
            title={dirty ? "Save the result before marking resolved" : unresolvedBlocks ? "Resolve all marker blocks first" : "Add this result to the index"}
            onClick={() => onAction("mark_resolved")}
          ><Check size={13} />Mark resolved and stage</button>
          {dirty || unresolvedBlocks > 0 ? <p>{dirty ? "Save the worktree result before staging it." : `${unresolvedBlocks} marker block(s) still unresolved.`}</p> : null}
        </>
      ) : null}
      {recentlyResolvedPath && onReopen ? (
        <button type="button" className={styles.reopen} disabled={busy} onClick={onReopen}><RotateCcw size={13} />Reopen {recentlyResolvedPath}</button>
      ) : null}
    </section>
  );
}
