import { ChevronLeft, ChevronRight, Save } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

import type { GitConflictFile } from "@/runtime/gitTypes";

import styles from "./GitThreeWayMergeEditor.module.css";

export interface GitConflictBlock {
  start: number;
  end: number;
  ours: string;
  base: string;
  theirs: string;
}

export type GitConflictChoice = "ours" | "theirs" | "both";
export type GitConflictSaveEncoding = "utf-8" | "utf-8-bom";
export type GitConflictSaveEol = "lf" | "crlf";

export function parseConflictBlocks(content: string): readonly GitConflictBlock[] {
  const normalized = normalizeEditorText(content);
  const lines = normalized.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length;
  }
  const blocks: GitConflictBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("<<<<<<<")) continue;
    let baseDivider = -1;
    let divider = -1;
    let end = -1;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor].startsWith("|||||||")) baseDivider = cursor;
      else if (lines[cursor].startsWith("=======")) divider = cursor;
      else if (lines[cursor].startsWith(">>>>>>>")) {
        end = cursor;
        break;
      }
    }
    if (divider < 0 || end < 0) continue;
    const oursEnd = baseDivider >= 0 ? baseDivider : divider;
    blocks.push({
      start: offsets[index],
      end: offsets[end] + lines[end].length,
      ours: lines.slice(index + 1, oursEnd).join(""),
      base: baseDivider >= 0 ? lines.slice(baseDivider + 1, divider).join("") : "",
      theirs: lines.slice(divider + 1, end).join(""),
    });
    index = end;
  }
  return blocks;
}

export function applyConflictChoice(
  content: string,
  block: GitConflictBlock,
  choice: GitConflictChoice,
): string {
  const normalized = normalizeEditorText(content);
  const replacement = choice === "ours"
    ? block.ours
    : choice === "theirs"
      ? block.theirs
      : `${block.ours}${block.theirs}`;
  return `${normalized.slice(0, block.start)}${replacement}${normalized.slice(block.end)}`;
}

export function GitThreeWayMergeEditor({
  file,
  saving,
  onSave,
  onDirtyChange,
}: {
  file: GitConflictFile;
  saving: boolean;
  onSave: (content: string, encoding: GitConflictSaveEncoding, eol: GitConflictSaveEol) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const initialContent = normalizeEditorText(file.resultContent ?? stageContent(file, "ours"));
  const initialEncoding: GitConflictSaveEncoding = file.resultEncoding === "utf-8-bom" ? "utf-8-bom" : "utf-8";
  const initialEol: GitConflictSaveEol = file.resultEol === "crlf" ? "crlf" : "lf";
  const [draft, setDraft] = useState(initialContent);
  const [baseline, setBaseline] = useState(initialContent);
  const [encoding, setEncoding] = useState<GitConflictSaveEncoding>(initialEncoding);
  const [baselineEncoding, setBaselineEncoding] = useState(initialEncoding);
  const [eol, setEol] = useState<GitConflictSaveEol>(initialEol);
  const [baselineEol, setBaselineEol] = useState(initialEol);
  const [activeBlock, setActiveBlock] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const hintId = useId();
  const blocks = useMemo(() => parseConflictBlocks(draft), [draft]);
  const dirty = draft !== baseline || encoding !== baselineEncoding || eol !== baselineEol;

  useEffect(() => {
    const nextContent = normalizeEditorText(file.resultContent ?? stageContent(file, "ours"));
    const nextEncoding = file.resultEncoding === "utf-8-bom" ? "utf-8-bom" : "utf-8";
    const nextEol = file.resultEol === "crlf" ? "crlf" : "lf";
    setDraft(nextContent);
    setBaseline(nextContent);
    setEncoding(nextEncoding);
    setBaselineEncoding(nextEncoding);
    setEol(nextEol);
    setBaselineEol(nextEol);
    setActiveBlock(0);
    setSaveError(null);
  }, [file.path, file.resultRevision]);

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (activeBlock >= blocks.length) setActiveBlock(Math.max(0, blocks.length - 1));
  }, [activeBlock, blocks.length]);

  const choose = (choice: GitConflictChoice) => {
    const current = blocks[activeBlock];
    if (!current) return;
    setDraft(applyConflictChoice(draft, current, choice));
  };
  const save = async () => {
    setSaveError(null);
    try {
      await onSave(draft, encoding, eol);
      setBaseline(draft);
      setBaselineEncoding(encoding);
      setBaselineEol(eol);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className={styles.root} aria-label={`Three-way merge editor: ${file.path}`}>
      <header className={styles.header}>
        <div><strong>{file.path}</strong><span>{blocks.length} unresolved block(s)</span></div>
        <div className={styles.toolbar}>
          <button type="button" aria-label="Previous conflict" disabled={!blocks.length} onClick={() => setActiveBlock((value) => (value - 1 + blocks.length) % blocks.length)}><ChevronLeft size={13} /></button>
          <span>{blocks.length ? `${activeBlock + 1} / ${blocks.length}` : "Resolved"}</span>
          <button type="button" aria-label="Next conflict" disabled={!blocks.length} onClick={() => setActiveBlock((value) => (value + 1) % blocks.length)}><ChevronRight size={13} /></button>
        </div>
      </header>
      <div className={styles.sources}>
        <MergeSource label="BASE" content={stageContent(file, "base")} />
        <MergeSource label="OURS" content={stageContent(file, "ours")} />
        <MergeSource label="THEIRS" content={stageContent(file, "theirs")} />
      </div>
      <div className={styles.actions}>
        <button type="button" aria-keyshortcuts="Alt+1" disabled={!blocks.length} onClick={() => choose("ours")}>Take ours</button>
        <button type="button" aria-keyshortcuts="Alt+2" disabled={!blocks.length} onClick={() => choose("theirs")}>Take theirs</button>
        <button type="button" aria-keyshortcuts="Alt+3" disabled={!blocks.length} onClick={() => choose("both")}>Take both</button>
        <label>Encoding<select aria-label="Result encoding" value={encoding} onChange={(event) => setEncoding(event.target.value as GitConflictSaveEncoding)}><option value="utf-8">UTF-8</option><option value="utf-8-bom">UTF-8 BOM</option></select></label>
        <label>Line endings<select aria-label="Result line endings" value={eol} onChange={(event) => setEol(event.target.value as GitConflictSaveEol)}><option value="lf">LF</option><option value="crlf">CRLF</option></select></label>
      </div>
      {file.resultEol === "mixed" ? <p className={styles.notice}>Mixed line endings detected. The saved result will use the selected line ending.</p> : null}
      <label className={styles.result}>RESULT<textarea
        aria-label="Merge result"
        aria-describedby={hintId}
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (!event.altKey) return;
          const choice = event.key === "1" ? "ours" : event.key === "2" ? "theirs" : event.key === "3" ? "both" : null;
          if (choice) {
            event.preventDefault();
            choose(choice);
          } else if (event.key.toLowerCase() === "s" && dirty && !saving) {
            event.preventDefault();
            void save();
          }
        }}
      /></label>
      <footer>
        <span role="status" aria-live="polite">{dirty ? "Unsaved worktree result" : "Worktree result saved"}</span>
        <button type="button" aria-keyshortcuts="Alt+S" disabled={!dirty || saving} onClick={() => void save()}><Save size={13} />{saving ? "Saving…" : "Save result"}</button>
      </footer>
      {saveError ? <p className={styles.error} role="alert">{saveError}</p> : null}
      <p className={styles.hint} id={hintId}>Use Alt+1, Alt+2, or Alt+3 to take ours, theirs, or both. Alt+S saves. Saving only writes the worktree result; mark the path resolved separately when it is ready for the index.</p>
    </section>
  );
}

function MergeSource({ label, content }: { label: string; content: string }) {
  return <section><strong>{label}</strong><pre aria-label={`${label} content`}>{content || "(not available)"}</pre></section>;
}

function stageContent(file: GitConflictFile, label: GitConflictFile["stages"][number]["label"]): string {
  return file.stages.find((stage) => stage.label === label)?.content ?? "";
}

function normalizeEditorText(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
