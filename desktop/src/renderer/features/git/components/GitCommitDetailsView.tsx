import { ChevronRight, Copy, File, Folder, GitCommitHorizontal, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";

import type { GitCommitDetail, GitFileDiff, GitObjectId } from "@/runtime/gitTypes";

import styles from "./GitCommitDetailsView.module.css";

export interface GitCommitFileNode {
  name: string;
  path: string;
  kind: "directory" | "file";
  children: readonly GitCommitFileNode[];
  fileIndex: number | null;
}

export function GitCommitDetailsView({
  detail,
  loading,
  selectedFileIndex,
  onSelectFile,
  onSelectParent,
  onCopyHash,
  onSelectDecoration,
}: {
  detail: GitCommitDetail | null;
  loading: boolean;
  selectedFileIndex: number;
  onSelectFile: (index: number) => void;
  onSelectParent: (parentId: GitObjectId) => void;
  onCopyHash: (objectId: GitObjectId) => void | Promise<void>;
  onSelectDecoration: (decoration: string) => void;
}) {
  if (loading && !detail) return <div className={styles.empty} role="status">正在加载提交详情…</div>;
  if (!detail) return <div className={styles.empty} role="status">请选择一个提交以查看详情。</div>;

  const { commit } = detail;
  const additions = detail.files.reduce((total, file) => total + (file.additions ?? 0), 0);
  const deletions = detail.files.reduce((total, file) => total + (file.deletions ?? 0), 0);
  const tree = buildCommitFileTree(detail.files);
  return (
    <div className={styles.root} aria-label="提交详情" aria-busy={loading}>
      <section className={styles.metadata}>
        <div className={styles.subject}><GitCommitHorizontal size={14} /><strong>{commit.subject}</strong></div>
        {commit.body ? <p>{commit.body}</p> : null}
        <dl>
          <div><dt>提交</dt><dd className={styles.commitHash}><code>{commit.objectId}</code><button type="button" aria-label="复制提交哈希" onClick={() => void onCopyHash(commit.objectId)}><Copy size={11} /></button></dd></div>
          <div><dt>作者</dt><dd>{commit.authorName} &lt;{commit.authorEmail}&gt;</dd></div>
          <div><dt>创作时间</dt><dd>{formatCommitDate(commit.authoredAt)}</dd></div>
          <div><dt>提交者</dt><dd>{commit.committerName} &lt;{commit.committerEmail}&gt;</dd></div>
          <div><dt>提交时间</dt><dd>{formatCommitDate(commit.committedAt)}</dd></div>
          <div><dt>签名</dt><dd className={styles.signature}>{signatureIcon(commit.signature)}{signatureLabel(commit.signature)}</dd></div>
        </dl>
        {commit.decorations.length > 0 ? <div className={styles.decorations}>{commit.decorations.map((item) => <button type="button" key={item} onClick={() => onSelectDecoration(item)}>{item}</button>)}</div> : null}
      </section>
      {commit.parentIds.length > 0 ? (
        <section className={styles.parents} aria-label="与父提交比较">
          <span>与父提交比较</span>
          <div>
            {commit.parentIds.map((parentId, index) => (
              <button
                type="button"
                key={parentId}
                aria-pressed={detail.selectedParentId === parentId}
                onClick={() => onSelectParent(parentId)}
              >
                P{index + 1} · {parentId.slice(0, 8)}
              </button>
            ))}
          </div>
        </section>
      ) : <div className={styles.rootCommit}>根提交将与空目录树比较</div>}
      <section className={styles.files}>
        <header><strong>{detail.files.length} 个变更文件</strong><span className={styles.additions}>+{additions}</span><span className={styles.deletions}>−{deletions}</span></header>
        {tree.length > 0 ? (
          <ul role="tree" aria-label="提交文件">{tree.map((node) => (
            <FileTreeNode key={node.path} node={node} selectedFileIndex={selectedFileIndex} onSelectFile={onSelectFile} />
          ))}</ul>
        ) : <div className={styles.empty}>相对此父提交没有文件变更。</div>}
      </section>
    </div>
  );
}

export function buildCommitFileTree(files: readonly GitFileDiff[]): readonly GitCommitFileNode[] {
  interface MutableNode {
    name: string;
    path: string;
    kind: "directory" | "file";
    children: Map<string, MutableNode>;
    fileIndex: number | null;
  }
  const roots = new Map<string, MutableNode>();
  files.forEach((file, fileIndex) => {
    const path = file.newPath ?? file.oldPath;
    if (!path) return;
    const parts = path.split("/").filter(Boolean);
    let siblings = roots;
    parts.forEach((part, index) => {
      const nodePath = parts.slice(0, index + 1).join("/");
      const isFile = index === parts.length - 1;
      let node = siblings.get(part);
      if (!node) {
        node = {
          name: part,
          path: nodePath,
          kind: isFile ? "file" : "directory",
          children: new Map(),
          fileIndex: isFile ? fileIndex : null,
        };
        siblings.set(part, node);
      }
      siblings = node.children;
    });
  });

  const freeze = (nodes: Map<string, MutableNode>): GitCommitFileNode[] => [...nodes.values()]
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
    .map((node) => ({
      name: node.name,
      path: node.path,
      kind: node.kind,
      children: freeze(node.children),
      fileIndex: node.fileIndex,
    }));
  return freeze(roots);
}

function FileTreeNode({
  node,
  selectedFileIndex,
  onSelectFile,
}: {
  node: GitCommitFileNode;
  selectedFileIndex: number;
  onSelectFile: (index: number) => void;
}) {
  if (node.kind === "directory") {
    return (
      <li role="treeitem" aria-expanded="true">
        <span className={styles.directory}><ChevronRight size={11} /><Folder size={12} />{node.name}</span>
        <ul role="group">{node.children.map((child) => (
          <FileTreeNode key={child.path} node={child} selectedFileIndex={selectedFileIndex} onSelectFile={onSelectFile} />
        ))}</ul>
      </li>
    );
  }
  return (
    <li role="treeitem" aria-selected={node.fileIndex === selectedFileIndex}>
      <button type="button" title={node.path} onClick={() => node.fileIndex !== null && onSelectFile(node.fileIndex)}>
        <File size={12} />{node.name}
      </button>
    </li>
  );
}

function signatureIcon(signature: GitCommitDetail["commit"]["signature"]) {
  if (signature === "valid") return <ShieldCheck size={12} aria-hidden="true" />;
  if (signature === "invalid") return <ShieldX size={12} aria-hidden="true" />;
  return <ShieldQuestion size={12} aria-hidden="true" />;
}

function signatureLabel(signature: GitCommitDetail["commit"]["signature"]): string {
  return ({ valid: "有效", invalid: "无效", unknown: "未知", unsigned: "未签名" })[signature];
}

function formatCommitDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
