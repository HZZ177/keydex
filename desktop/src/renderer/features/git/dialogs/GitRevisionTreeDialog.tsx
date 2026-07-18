import { FolderTree, X } from "lucide-react";
import { useMemo, useState } from "react";

import { LoadingSkeleton } from "@/renderer/components/loading";
import { GitCommitFileTree } from "@/renderer/features/git/components/GitCommitDetailsView";
import type { GitFileDiff, GitRevisionTree } from "@/runtime/gitTypes";

import styles from "./GitRevisionTreeDialog.module.css";

export function GitRevisionTreeDialog({ open, tree, loading, error, onClose }: {
  open: boolean;
  tree: GitRevisionTree | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const files = useMemo<readonly GitFileDiff[]>(() => (tree?.entries ?? []).map((entry) => ({
    oldPath: entry.path,
    newPath: entry.path,
    status: "modified",
    binary: false,
    oldMode: entry.mode,
    newMode: entry.mode,
    additions: null,
    deletions: null,
    hunks: [],
    rawPatch: "",
    truncated: false,
  })), [tree]);
  if (!open) return null;
  const selected = tree?.entries[selectedIndex] ?? null;
  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-label="修订版仓库">
        <header className={styles.header}>
          <FolderTree size={16} aria-hidden="true" />
          <div>
            <strong>在修订版中显示仓库</strong>
            <span>{tree ? `${tree.revision} · ${tree.entries.length} 个文件` : "正在读取仓库目录…"}</span>
          </div>
          <button type="button" aria-label="关闭修订版仓库" onClick={onClose}><X size={15} /></button>
        </header>
        <div className={styles.body}>
          {loading && !tree ? <LoadingSkeleton className={styles.loading} lineCount={10} /> : error ? (
            <div className={styles.state} role="alert">{error}</div>
          ) : files.length ? (
            <GitCommitFileTree files={files} selectedFileIndex={selectedIndex} ariaLabel="修订版仓库文件" onSelectFile={setSelectedIndex} neutral />
          ) : <div className={styles.state}>该修订版没有文件。</div>}
        </div>
        <footer className={styles.footer}>
          <span>{selected ? `${selected.kind === "submodule" ? "子模块" : "文件"} · ${selected.mode}${selected.size === null ? "" : ` · ${formatBytes(selected.size)}`}` : "选择文件查看对象信息"}</span>
          <code>{selected?.objectId.slice(0, 12) ?? tree?.objectId.slice(0, 12) ?? ""}</code>
          <button type="button" onClick={onClose}>关闭</button>
        </footer>
      </section>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
