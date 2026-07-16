import { Columns2, Rows3, WrapText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { GitDiffHunk, GitFileDiff } from "@/runtime/gitTypes";

import styles from "./GitDiffViewer.module.css";

export type GitDiffViewMode = "unified" | "split";

export interface GitDiffViewerProps {
  diff: GitFileDiff | null;
  initialMode?: GitDiffViewMode;
  maxBytes?: number;
  maxLines?: number;
  onStagePatches?: (patches: readonly string[]) => void | Promise<void>;
  patchAction?: "stage" | "unstage";
  staging?: boolean;
}

export interface GitDiffDisplayRow {
  key: string;
  kind: "context" | "add" | "delete";
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export function GitDiffViewer({
  diff,
  initialMode = "unified",
  maxBytes = 1_000_000,
  maxLines = 20_000,
  onStagePatches,
  patchAction = "stage",
  staging = false,
}: GitDiffViewerProps) {
  const [mode, setMode] = useState<GitDiffViewMode>(initialMode);
  const [wrap, setWrap] = useState(false);
  const [largeFileAccepted, setLargeFileAccepted] = useState(false);
  const [selectedLines, setSelectedLines] = useState<Set<string>>(new Set());
  const rows = useMemo(() => diff ? gitDiffDisplayRows(diff.hunks) : [], [diff]);
  useEffect(() => setSelectedLines(new Set()), [diff?.newPath, diff?.oldPath, diff?.rawPatch]);

  if (!diff) return <div className={styles.state}>选择文件查看 Diff</div>;
  if (diff.binary) return <div className={styles.state}>二进制文件不提供文本 Diff</div>;
  const tooLarge = diff.truncated || diff.rawPatch.length > maxBytes || rows.length > maxLines;
  if (tooLarge && !largeFileAccepted) {
    return (
      <div className={styles.state}>
        <strong>Diff 过大</strong>
        <span>为避免界面卡顿，已暂停渲染完整内容。</span>
        {!diff.truncated ? <button type="button" onClick={() => setLargeFileAccepted(true)}>仍然查看</button> : null}
      </div>
    );
  }

  const path = diff.newPath ?? diff.oldPath ?? "Diff";
  return (
    <section className={styles.root} data-mode={mode} data-wrap={wrap ? "true" : "false"}>
      <header className={styles.header}>
        <strong>{path}</strong>
        <span className={styles.stat}>+{diff.additions ?? 0} −{diff.deletions ?? 0}</span>
        {diff.oldMode && diff.newMode && diff.oldMode !== diff.newMode ? (
          <span className={styles.stat} aria-label="Mode change">{diff.oldMode} → {diff.newMode}</span>
        ) : null}
        <div className={styles.controls} role="group" aria-label="Diff 显示方式">
          <button type="button" aria-pressed={mode === "unified"} aria-label="统一 Diff" onClick={() => setMode("unified")}><Rows3 size={13} /></button>
          <button type="button" aria-pressed={mode === "split"} aria-label="并排 Diff" onClick={() => setMode("split")}><Columns2 size={13} /></button>
          <button type="button" aria-pressed={wrap} aria-label="自动换行" onClick={() => setWrap((current) => !current)}><WrapText size={13} /></button>
        </div>
      </header>
      {onStagePatches ? (
        <div className={styles.stageBar}>
          {diff.hunks.map((hunk, index) => (
            <button
              type="button"
              key={`${hunk.header}:${index}`}
              disabled={staging}
              onClick={() => void onStagePatches([buildGitHunkPatch(diff, index)])}
            >
              {patchAction === "unstage" ? "取消暂存" : "暂存"} Hunk {index + 1}
            </button>
          ))}
          <button
            type="button"
            disabled={selectedLines.size === 0 || staging}
            onClick={() => void onStagePatches(Array.from(selectedLines).map((key) => {
              const [hunkIndex, lineIndex] = key.split(":").map(Number);
              return buildGitLinePatch(diff, hunkIndex, lineIndex);
            }))}
          >
            {staging
              ? patchAction === "unstage" ? "正在取消暂存…" : "正在暂存…"
              : `${patchAction === "unstage" ? "取消暂存" : "暂存"}所选行${selectedLines.size ? ` (${selectedLines.size})` : ""}`}
          </button>
        </div>
      ) : null}
      {mode === "unified" ? (
        <UnifiedRows
          rows={rows}
          selectable={Boolean(onStagePatches)}
          selectedLines={selectedLines}
          onToggleLine={(key, selected) => setSelectedLines((current) => {
            const next = new Set(current);
            if (selected) next.add(key);
            else next.delete(key);
            return next;
          })}
        />
      ) : <SplitRows rows={rows} />}
    </section>
  );
}

function UnifiedRows({
  rows,
  selectable,
  selectedLines,
  onToggleLine,
}: {
  rows: readonly GitDiffDisplayRow[];
  selectable: boolean;
  selectedLines: ReadonlySet<string>;
  onToggleLine: (key: string, selected: boolean) => void;
}) {
  return (
    <div className={styles.lines} role="table" aria-label="统一 Diff 内容">
      {rows.map((row) => (
        <div className={styles.line} data-kind={row.kind} role="row" aria-label={`${row.kind} line ${row.newLine ?? row.oldLine ?? ""}`} key={row.key}>
          <span className={styles.number} role="cell" aria-label="Old line number">{row.oldLine ?? ""}</span>
          <span className={styles.number} role="cell" aria-label="New line number">{row.newLine ?? ""}</span>
          <span className={styles.sign} role="cell" aria-label={row.kind}>
            {selectable && row.kind !== "context" ? (
              <input
                type="checkbox"
                checked={selectedLines.has(row.key)}
                aria-label={`选择 ${row.kind === "add" ? "新增" : "删除"}行 ${row.newLine ?? row.oldLine}`}
                onChange={(event) => onToggleLine(row.key, event.currentTarget.checked)}
              />
            ) : row.kind === "add" ? "+" : row.kind === "delete" ? "−" : ""}
          </span>
          <code role="cell">{row.content}</code>
        </div>
      ))}
    </div>
  );
}

function SplitRows({ rows }: { rows: readonly GitDiffDisplayRow[] }) {
  return (
    <div className={styles.splitLines} role="table" aria-label="并排 Diff 内容">
      {rows.map((row) => (
        <div className={styles.splitLine} data-kind={row.kind} role="row" aria-label={`${row.kind} line ${row.newLine ?? row.oldLine ?? ""}`} key={row.key}>
          <span className={styles.number} role="cell" aria-label="Old line number">{row.oldLine ?? ""}</span>
          <code role="cell">{row.kind === "add" ? "" : row.content}</code>
          <span className={styles.number} role="cell" aria-label="New line number">{row.newLine ?? ""}</span>
          <code role="cell">{row.kind === "delete" ? "" : row.content}</code>
        </div>
      ))}
    </div>
  );
}

export function gitDiffDisplayRows(hunks: readonly GitDiffHunk[]): GitDiffDisplayRow[] {
  const rows: GitDiffDisplayRow[] = [];
  hunks.forEach((hunk, hunkIndex) => {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    hunk.lines.forEach((line, lineIndex) => {
      if (line.startsWith("\\ No newline")) return;
      const sign = line[0];
      const kind = sign === "+" ? "add" : sign === "-" ? "delete" : "context";
      rows.push({
        key: `${hunkIndex}:${lineIndex}`,
        kind,
        oldLine: kind === "add" ? null : oldLine,
        newLine: kind === "delete" ? null : newLine,
        content: sign === "+" || sign === "-" || sign === " " ? line.slice(1) : line,
      });
      if (kind !== "add") oldLine += 1;
      if (kind !== "delete") newLine += 1;
    });
  });
  return rows;
}

export function buildGitHunkPatch(diff: GitFileDiff, hunkIndex: number): string {
  const hunk = diff.hunks[hunkIndex];
  if (!hunk) throw new Error("Git diff hunk was not found");
  return patchEnvelope(diff, `${hunk.header}\n${hunk.lines.join("\n")}\n`);
}

export function buildGitLinePatch(diff: GitFileDiff, hunkIndex: number, lineIndex: number): string {
  const hunk = diff.hunks[hunkIndex];
  const line = hunk?.lines[lineIndex];
  if (!hunk || !line || (line[0] !== "+" && line[0] !== "-")) {
    throw new Error("Only added or deleted Git diff lines can be staged individually");
  }
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (let index = 0; index < lineIndex; index += 1) {
    const sign = hunk.lines[index]?.[0];
    if (sign !== "+") oldLine += 1;
    if (sign !== "-") newLine += 1;
  }
  const header = line[0] === "+"
    ? `@@ -${oldLine},0 +${newLine},1 @@`
    : `@@ -${oldLine},1 +${newLine},0 @@`;
  return patchEnvelope(diff, `${header}\n${line}\n`);
}

function patchEnvelope(diff: GitFileDiff, body: string): string {
  const oldPath = diff.oldPath ?? diff.newPath;
  const newPath = diff.newPath ?? diff.oldPath;
  if (!oldPath || !newPath) throw new Error("Git diff paths are missing");
  return [
    `diff --git a/${oldPath} b/${newPath}`,
    `--- a/${oldPath}`,
    `+++ b/${newPath}`,
    body.trimEnd(),
    "",
  ].join("\n");
}
