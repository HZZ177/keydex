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
    <section className={styles.root} aria-label="Branch actions">
      <header>
        <GitBranch size={15} />
        <strong>Branches</strong>
        <span>{selected ? selected.shortName : "Select a ref"}</span>
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
        <label htmlFor="git-new-branch">New branch from {selected?.shortName ?? "HEAD"}</label>
        <div>
          <input
            id="git-new-branch"
            value={branchName}
            placeholder="feature/name"
            onChange={(event) => setBranchName(event.currentTarget.value)}
          />
          <button type="submit" disabled={!validation.valid || busy}><Plus size={13} />Create</button>
        </div>
        <small data-valid={validation.valid ? "true" : "false"}>{validation.message}</small>
      </form>
      <div className={styles.checkout}>
        <span>{selected?.current ? "Current branch" : "Switch working tree to selected ref"}</span>
        <button type="button" disabled={!selected || selected.current || busy} onClick={checkout}>Checkout</button>
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
            aria-label={`Rename ${selected.shortName}`}
            placeholder="New branch name"
            onChange={(event) => setRenameName(event.currentTarget.value)}
          />
          <button type="submit" disabled={!validateBranchName(renameName).valid || busy}>Rename</button>
        </form>
      ) : null}
      {selected?.kind === "local" ? (
        <div className={styles.upstream}>
          <span>Upstream: {selected.upstream ?? "Not configured"}</span>
          <select aria-label="Upstream branch" value={upstreamChoice} onChange={(event) => setUpstreamChoice(event.currentTarget.value)}>
            <option value="">Select remote branch</option>
            {refs.filter((ref) => ref.kind === "remote").map((ref) => (
              <option value={ref.shortName} key={ref.fullName}>{ref.shortName}</option>
            ))}
          </select>
          <button type="button" disabled={!upstreamChoice || busy} onClick={() => void onSetUpstream(selected, upstreamChoice)}>Set upstream</button>
          <button type="button" disabled={!selected.upstream || busy} onClick={() => void onSetUpstream(selected, null)}>Unset</button>
        </div>
      ) : null}
      {selected && !selected.current && selected.kind !== "tag" ? (
        <div className={styles.deleteZone} data-risk={deletionRisk}>
          <span>{selected.kind === "remote" ? `Delete remote branch ${selected.shortName}` : `Delete ${selected.shortName}`}</span>
          <button type="button" disabled={busy} onClick={() => void onDelete(selected, false)}>Delete…</button>
          {selected.kind === "local" ? (
            <button type="button" disabled={busy} onClick={() => void onDelete(selected, true)}>Force delete…</button>
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
        <strong>Create tag at {selected?.shortName ?? "HEAD"}</strong>
        <input aria-label="Tag name" value={tagName} placeholder="v1.0.0" onChange={(event) => setTagName(event.currentTarget.value)} />
        <label><input type="checkbox" checked={tagAnnotated} onChange={(event) => setTagAnnotated(event.currentTarget.checked)} />Annotated</label>
        <label><input type="checkbox" checked={tagSigned} onChange={(event) => setTagSigned(event.currentTarget.checked)} />Sign tag</label>
        {tagAnnotated || tagSigned ? (
          <input aria-label="Tag message" value={tagMessage} placeholder="Release message" onChange={(event) => setTagMessage(event.currentTarget.value)} />
        ) : null}
        <button type="submit" disabled={!validateBranchName(tagName).valid || busy}>Create tag</button>
      </form>
      {selected?.kind === "tag" ? (
        <div className={styles.tagDetails}>
          <strong>{selected.shortName}</strong>
          <span>Target {(selected.peeledObjectId ?? selected.objectId).slice(0, 12)}</span>
          <span>{selected.annotated ? selected.annotation || "Annotated tag" : "Lightweight tag"}</span>
          <button type="button" onClick={() => void onDeleteTag(selected, null)}>Delete local tag…</button>
          <label>
            Remote
            <input value={tagRemote} aria-label="Tag remote" onChange={(event) => setTagRemote(event.currentTarget.value)} />
          </label>
          <button type="button" disabled={!tagRemote.trim() || busy} onClick={() => void onPushTag(selected, tagRemote.trim())}>Push tag…</button>
          <button type="button" disabled={!tagRemote.trim()} onClick={() => void onDeleteTag(selected, tagRemote.trim())}>Delete remote tag…</button>
        </div>
      ) : null}
      {dirtyCheckout ? (
        <div className={styles.dirty} role="alert">
          <strong>Working tree has local changes</strong>
          <span>Switching to {dirtyCheckout.shortName} may overwrite them. Keydex will not stash automatically.</span>
          <div>
            <button type="button" onClick={onOpenChanges}>Commit changes</button>
            <button type="button" onClick={() => {
              const target = dirtyCheckout;
              setDirtyCheckout(null);
              void onStashAndCheckout(target);
            }}>Stash and checkout</button>
            <button type="button" onClick={() => setDirtyCheckout(null)}>Cancel</button>
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
  if (!branch) return { valid: false, message: "Enter a branch name" };
  if (branch.length > 255) return { valid: false, message: "Branch name is too long" };
  if (
    branch.startsWith("-")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.includes("..")
    || branch.includes("@{")
    || /[\s~^:?*\\]/u.test(branch)
    || branch.includes("[")
  ) return { valid: false, message: "Branch name is not valid for Git" };
  return { valid: true, message: "Branch name is valid" };
}
