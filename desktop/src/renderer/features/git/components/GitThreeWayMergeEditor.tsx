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
      setSaveError("保存合并结果失败，请检查仓库状态后重试。");
    }
  };

  return (
    <section className={styles.root} aria-label={`三方合并编辑器：${file.path}`}>
      <header className={styles.header}>
        <div><strong>{file.path}</strong><span>{blocks.length} 个未解决冲突块</span></div>
        <div className={styles.toolbar}>
          <button type="button" aria-label="上一个冲突" disabled={!blocks.length} onClick={() => setActiveBlock((value) => (value - 1 + blocks.length) % blocks.length)}><ChevronLeft size={13} /></button>
          <span>{blocks.length ? `${activeBlock + 1} / ${blocks.length}` : "已解决"}</span>
          <button type="button" aria-label="下一个冲突" disabled={!blocks.length} onClick={() => setActiveBlock((value) => (value + 1) % blocks.length)}><ChevronRight size={13} /></button>
        </div>
      </header>
      <div className={styles.sources}>
        <MergeSource label="共同基础" content={stageContent(file, "base")} />
        <MergeSource label="当前分支" content={stageContent(file, "ours")} />
        <MergeSource label="传入版本" content={stageContent(file, "theirs")} />
      </div>
      <div className={styles.actions}>
        <button type="button" aria-keyshortcuts="Alt+1" disabled={!blocks.length} onClick={() => choose("ours")}>采用当前分支版本</button>
        <button type="button" aria-keyshortcuts="Alt+2" disabled={!blocks.length} onClick={() => choose("theirs")}>采用传入版本</button>
        <button type="button" aria-keyshortcuts="Alt+3" disabled={!blocks.length} onClick={() => choose("both")}>保留双方内容</button>
        <label>编码<select aria-label="结果编码" value={encoding} onChange={(event) => setEncoding(event.target.value as GitConflictSaveEncoding)}><option value="utf-8">UTF-8</option><option value="utf-8-bom">UTF-8 BOM</option></select></label>
        <label>换行符<select aria-label="结果换行符" value={eol} onChange={(event) => setEol(event.target.value as GitConflictSaveEol)}><option value="lf">LF</option><option value="crlf">CRLF</option></select></label>
      </div>
      {file.resultEol === "mixed" ? <p className={styles.notice}>检测到混合换行符，保存结果将统一使用所选换行符。</p> : null}
      <label className={styles.result}>合并结果<textarea
        aria-label="合并结果"
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
        <span role="status" aria-live="polite">{dirty ? "工作树结果尚未保存" : "工作树结果已保存"}</span>
        <button type="button" aria-keyshortcuts="Alt+S" disabled={!dirty || saving} onClick={() => void save()}><Save size={13} />{saving ? "正在保存…" : "保存结果"}</button>
      </footer>
      {saveError ? <p className={styles.error} role="alert">{saveError}</p> : null}
      <p className={styles.hint} id={hintId}>使用 Alt+1、Alt+2 或 Alt+3 选择当前分支、传入版本或双方内容；Alt+S 保存。保存只会写入工作树结果，确认无误后还需要单独将路径标记为已解决并加入暂存区。</p>
    </section>
  );
}

function MergeSource({ label, content }: { label: string; content: string }) {
  return <section><strong>{label}</strong><pre aria-label={`${label}内容`}>{content || "（不可用）"}</pre></section>;
}

function stageContent(file: GitConflictFile, label: GitConflictFile["stages"][number]["label"]): string {
  return file.stages.find((stage) => stage.label === label)?.content ?? "";
}

function normalizeEditorText(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
