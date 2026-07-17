import { Check, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Button as AriaButton,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
} from "react-aria-components";

import { AppDialog, DialogButton } from "@/renderer/components/dialog";
import { GitCommitFileTree } from "@/renderer/features/git/components/GitCommitDetailsView";
import type { GitCommitDetail, GitCommitSummary } from "@/runtime/gitTypes";

import styles from "./GitCommitPushDialog.module.css";

export interface GitCommitPushTarget {
  remote: string;
  source: string;
  target: string;
  upstream: string;
  setUpstream: boolean;
}

export type GitPushTagMode = "none" | "all" | "current_branch";
type GitPushTagScope = Exclude<GitPushTagMode, "none">;

export function GitCommitPushDialog({
  open,
  projectName,
  target,
  commits,
  selectedObjectId,
  detail,
  loading = false,
  busy = false,
  error = null,
  onSelectCommit,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  projectName: string;
  target: GitCommitPushTarget | null;
  commits: readonly GitCommitSummary[];
  selectedObjectId: string | null;
  detail: GitCommitDetail | null;
  loading?: boolean;
  busy?: boolean;
  error?: string | null;
  onSelectCommit: (commit: GitCommitSummary) => void;
  onCancel: () => void;
  onConfirm: (options: { tagMode: GitPushTagMode }) => void | Promise<void>;
}) {
  const [pushTags, setPushTags] = useState(false);
  const [tagScope, setTagScope] = useState<GitPushTagScope>("all");

  useEffect(() => {
    if (open) {
      setPushTags(false);
      setTagScope("all");
    }
  }, [open, target?.upstream]);

  if (!open) return null;

  const selectedCommit = commits.find((commit) => commit.objectId === selectedObjectId) ?? commits[0] ?? null;
  const canPush = Boolean(target && commits.length > 0 && !loading && !busy);
  const title = `将提交推送到 ${projectName || "当前项目"}`;

  return (
    <AppDialog
      title={title}
      size="fullscreen"
      backdrop="plain"
      closeOnOverlayClick={false}
      closeOnEscape={!busy}
      showClose
      onClose={busy ? undefined : onCancel}
      panelClassName={styles.panel}
      bodyClassName={styles.body}
      footerClassName={styles.footer}
      footer={
        <>
          <div className={styles.tagOptions}>
            <label>
              <input
                type="checkbox"
                checked={pushTags}
                disabled={busy}
                onChange={(event) => setPushTags(event.currentTarget.checked)}
              />
              推送标签
            </label>
            <GitTagScopeSelect
              value={tagScope}
              disabled={!pushTags || busy}
              onChange={setTagScope}
            />
          </div>
          <div className={styles.footerActions}>
            <DialogButton type="button" disabled={busy} onClick={onCancel}>取消</DialogButton>
            <DialogButton
              type="button"
              tone="primary"
              disabled={!canPush}
              onClick={() => void onConfirm({ tagMode: pushTags ? tagScope : "none" })}
            >
              {busy ? "正在推送…" : "推送"}
            </DialogButton>
          </div>
        </>
      }
    >
      <div className={styles.workspace} aria-busy={loading || busy}>
        <section className={styles.commitPane} aria-label="将要推送的提交">
          <header className={styles.targetHeader}>
            <strong>{target ? `${target.source} → ${target.upstream}` : "正在准备推送目标…"}</strong>
            <span>{commits.length} 个提交</span>
          </header>
          {commits.length > 0 ? (
            <ul className={styles.commitList} role="listbox" aria-label="待推送提交列表">
              {commits.map((commit) => {
                const selected = commit.objectId === selectedCommit?.objectId;
                return (
                  <li key={commit.objectId} role="option" aria-selected={selected}>
                    <button
                      type="button"
                      data-selected={selected ? "true" : undefined}
                      onClick={() => onSelectCommit(commit)}
                    >
                      <span className={styles.subject}>{commit.subject || "无提交标题"}</span>
                      <span className={styles.commitMeta}>
                        <code>{commit.objectId.slice(0, 8)}</code>
                        <span>{commit.authorName}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : loading ? (
            <div className={styles.empty} role="status">正在读取待推送提交…</div>
          ) : (
            <div className={styles.empty}>没有可推送的提交。</div>
          )}
        </section>

        <section className={styles.filePane} aria-label="所选提交的改动目录树">
          <header className={styles.fileHeader}>
            <div>
              <strong>改动文件</strong>
              {selectedCommit ? <span title={selectedCommit.subject}>{selectedCommit.subject}</span> : null}
            </div>
            <span>{detail?.files.length ?? 0} 个文件</span>
          </header>
          <div className={`${styles.fileTreeViewport} keydex-scrollable`}>
            {loading && !detail ? (
              <div className={styles.empty} role="status">正在读取提交改动…</div>
            ) : detail && detail.files.length > 0 ? (
              <GitCommitFileTree
                key={detail.commit.objectId}
                files={detail.files}
                ariaLabel="待推送提交改动文件树"
                rootLabel={projectName || "当前项目"}
              />
            ) : (
              <div className={styles.empty}>此提交没有文件改动。</div>
            )}
          </div>
        </section>
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </AppDialog>
  );
}

function GitTagScopeSelect({
  value,
  disabled,
  onChange,
}: {
  value: GitPushTagScope;
  disabled: boolean;
  onChange: (value: GitPushTagScope) => void;
}) {
  return (
    <Select
      aria-label="推送标签范围"
      selectedKey={value}
      isDisabled={disabled}
      onSelectionChange={(key) => {
        if (key === "all" || key === "current_branch") onChange(key);
      }}
    >
      <AriaButton className={styles.tagScopeTrigger}>
        <span>{value === "all" ? "所有" : "当前分支"}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </AriaButton>
      <Popover className={styles.tagScopePopover} placement="top start" offset={4}>
        <ListBox className={styles.tagScopeList}>
          <ListBoxItem id="all" textValue="所有" className={styles.tagScopeOption}>
            {({ isSelected }) => <><span>所有</span>{isSelected ? <Check size={13} aria-hidden="true" /> : null}</>}
          </ListBoxItem>
          <ListBoxItem id="current_branch" textValue="当前分支" className={styles.tagScopeOption}>
            {({ isSelected }) => <><span>当前分支</span>{isSelected ? <Check size={13} aria-hidden="true" /> : null}</>}
          </ListBoxItem>
        </ListBox>
      </Popover>
    </Select>
  );
}
