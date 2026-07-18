import {
  ChevronRight,
  FileDiff,
  GitCommitHorizontal,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
} from "lucide-react";
import {
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { useMaterialEntryIcon } from "@/renderer/components/workspace/materialIconTheme";
import { useOptionalAppContextMenu } from "@/renderer/providers/AppContextMenuProvider";
import type { GitCommitDetail, GitFileDiff, GitFileStatusCode } from "@/runtime/gitTypes";

import { GitCommitFileDiffDialog } from "../dialogs/GitCommitFileDiffDialog";
import styles from "./GitCommitDetailsView.module.css";

type CommitFileStatus = "added" | "modified" | "deleted";

const DEFAULT_FILES_PANE_PERCENT = 48;
const MIN_FILES_PANE_PERCENT = 24;
const MAX_FILES_PANE_PERCENT = 76;
const KEYBOARD_RESIZE_STEP = 4;

export interface GitCommitFileNode {
  name: string;
  path: string;
  kind: "directory" | "file";
  status: CommitFileStatus;
  children: readonly GitCommitFileNode[];
  fileIndex: number | null;
}

export function GitCommitDetailsView({
  detail,
  loading,
  selectedFileIndex,
  onSelectFile,
}: {
  detail: GitCommitDetail | null;
  loading: boolean;
  selectedFileIndex: number;
  onSelectFile: (index: number) => void;
}) {
  const [filesPanePercent, setFilesPanePercent] = useState(DEFAULT_FILES_PANE_PERCENT);
  const [resizing, setResizing] = useState(false);
  const [previewFileIndex, setPreviewFileIndex] = useState<number | null>(null);

  useEffect(() => {
    setPreviewFileIndex(null);
  }, [detail?.commit.objectId]);

  if (loading && !detail) return <div className={styles.empty} role="status">正在加载提交详情…</div>;
  if (!detail) return <div className={styles.empty} role="status">请选择一个提交以查看详情。</div>;

  const { commit } = detail;
  const additions = detail.files.reduce((total, file) => total + (file.additions ?? 0), 0);
  const deletions = detail.files.reduce((total, file) => total + (file.deletions ?? 0), 0);

  const resizeFromClientY = (clientY: number, separator: HTMLDivElement) => {
    const root = separator.parentElement;
    if (!root) return;
    const bounds = root.getBoundingClientRect();
    if (bounds.height <= 0) return;
    const next = ((clientY - bounds.top) / bounds.height) * 100;
    setFilesPanePercent(clampFilesPanePercent(next));
  };

  const handleSeparatorPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setResizing(true);
    resizeFromClientY(event.clientY, event.currentTarget);
  };

  const handleSeparatorPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    resizeFromClientY(event.clientY, event.currentTarget);
  };

  const handleSeparatorPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    setResizing(false);
  };

  const handleSeparatorKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowUp") next = filesPanePercent - KEYBOARD_RESIZE_STEP;
    if (event.key === "ArrowDown") next = filesPanePercent + KEYBOARD_RESIZE_STEP;
    if (event.key === "Home") next = MIN_FILES_PANE_PERCENT;
    if (event.key === "End") next = MAX_FILES_PANE_PERCENT;
    if (next === null) return;
    event.preventDefault();
    setFilesPanePercent(clampFilesPanePercent(next));
  };

  return (
    <div
      className={styles.root}
      aria-label="提交详情"
      aria-busy={loading}
      data-resizing={resizing ? "true" : undefined}
      style={{ "--git-commit-files-pane-height": `${filesPanePercent}%` } as CSSProperties}
    >
      <section className={`${styles.filesPane} keydex-scrollable`} data-testid="git-commit-files-scroll">
        <header className={styles.filesHeader}>
          <strong>变更文件</strong>
          <span>{detail.files.length} 个文件</span>
          <span className={styles.additions}>+{additions}</span>
          <span className={styles.deletions}>−{deletions}</span>
        </header>
        {detail.files.length > 0 ? (
          <GitCommitFileTree
            files={detail.files}
            selectedFileIndex={selectedFileIndex}
            onSelectFile={onSelectFile}
            onOpenFileDiff={setPreviewFileIndex}
          />
        ) : loading
          ? <div className={styles.paneEmpty} role="status">正在加载变更文件…</div>
          : <div className={styles.paneEmpty}>此提交没有文件变更。</div>}
      </section>

      <div
        className={styles.horizontalSeparator}
        role="separator"
        aria-label="调整变更文件与提交信息区域高度"
        aria-orientation="horizontal"
        aria-valuemin={MIN_FILES_PANE_PERCENT}
        aria-valuemax={MAX_FILES_PANE_PERCENT}
        aria-valuenow={Math.round(filesPanePercent)}
        data-dragging={resizing ? "true" : undefined}
        tabIndex={0}
        onKeyDown={handleSeparatorKeyDown}
        onPointerDown={handleSeparatorPointerDown}
        onPointerMove={handleSeparatorPointerMove}
        onPointerUp={handleSeparatorPointerEnd}
        onPointerCancel={handleSeparatorPointerEnd}
        onLostPointerCapture={() => setResizing(false)}
      />

      <section className={`${styles.metadataPane} keydex-scrollable`} data-testid="git-commit-metadata-scroll">
        <header className={styles.commitSummary}>
          <div className={styles.subject}>
            <GitCommitHorizontal size={16} aria-hidden="true" />
            <strong>{commit.subject}</strong>
          </div>
          {commit.body ? <p>{commit.body}</p> : null}
        </header>

        <dl className={styles.metadataList}>
          <div className={styles.primaryMetadata}>
            <dt>作者</dt>
            <dd>
              <strong>{commit.authorName}</strong>
              <span>{commit.authorEmail}</span>
            </dd>
          </div>
          <div>
            <dt>提交时间</dt>
            <dd>{formatCommitDate(commit.committedAt)}</dd>
          </div>
          <div>
            <dt>提交</dt>
            <dd className={styles.commitHash}>
              <code title={commit.objectId}>{commit.objectId}</code>
            </dd>
          </div>
          <div>
            <dt>提交者</dt>
            <dd>{commit.committerName} <span className={styles.secondaryText}>{commit.committerEmail}</span></dd>
          </div>
          <div>
            <dt>创作时间</dt>
            <dd>{formatCommitDate(commit.authoredAt)}</dd>
          </div>
          <div>
            <dt>签名</dt>
            <dd className={styles.signature}>{signatureIcon(commit.signature)}{signatureLabel(commit.signature)}</dd>
          </div>
        </dl>
      </section>
      <GitCommitFileDiffDialog
        detail={detail}
        fileIndex={previewFileIndex}
        onClose={() => setPreviewFileIndex(null)}
      />
    </div>
  );
}

export function buildCommitFileTree(files: readonly GitFileDiff[]): readonly GitCommitFileNode[] {
  interface MutableNode {
    name: string;
    path: string;
    kind: "directory" | "file";
    status: CommitFileStatus;
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
          status: isFile ? commitFileStatus(file.status) : "modified",
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
      return left.name.localeCompare(right.name, "zh-CN");
    })
    .map((node) => {
      const children = freeze(node.children);
      return {
        name: node.name,
        path: node.path,
        kind: node.kind,
        status: node.kind === "directory" ? aggregateDirectoryStatus(children) : node.status,
        children,
        fileIndex: node.fileIndex,
      };
    });
  return freeze(roots);
}

export function GitCommitFileTree({
  files,
  selectedFileIndex = -1,
  ariaLabel = "变更文件树",
  rootLabel,
  onSelectFile = () => undefined,
  onOpenFileDiff,
  neutral = false,
}: {
  files: readonly GitFileDiff[];
  selectedFileIndex?: number;
  ariaLabel?: string;
  rootLabel?: string;
  onSelectFile?: (index: number) => void;
  onOpenFileDiff?: (index: number) => void;
  neutral?: boolean;
}) {
  const tree = buildCommitFileTree(files);
  const nodes: readonly GitCommitFileNode[] = rootLabel
    ? [{
        name: rootLabel,
        path: `__repository_root__/${rootLabel}`,
        kind: "directory",
        status: aggregateDirectoryStatus(tree),
        children: tree,
        fileIndex: null,
      }]
    : tree;
  return (
    <ul className={styles.fileTree} role="tree" aria-label={ariaLabel}>
      {nodes.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          selectedFileIndex={selectedFileIndex}
          secondaryLabel={rootLabel && node.path.startsWith("__repository_root__/") ? `${files.length} 个文件` : undefined}
          onSelectFile={onSelectFile}
          onOpenFileDiff={onOpenFileDiff}
          neutral={neutral}
        />
      ))}
    </ul>
  );
}

function FileTreeNode({
  node,
  selectedFileIndex,
  secondaryLabel,
  onSelectFile,
  onOpenFileDiff,
  neutral,
}: {
  node: GitCommitFileNode;
  selectedFileIndex: number;
  secondaryLabel?: string;
  onSelectFile: (index: number) => void;
  onOpenFileDiff?: (index: number) => void;
  neutral: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const icon = useMaterialEntryIcon(node.path, node.kind);
  const appContextMenu = useOptionalAppContextMenu();
  const selected = node.kind === "file" && node.fileIndex === selectedFileIndex;
  const canOpenDiff = node.kind === "file" && node.fileIndex !== null && Boolean(onOpenFileDiff);

  const openFileDiffMenu = (
    target: HTMLButtonElement,
    x: number,
    y: number,
  ) => {
    if (!canOpenDiff || node.fileIndex === null || !onOpenFileDiff || !appContextMenu) return;
    const fileIndex = node.fileIndex;
    onSelectFile(fileIndex);
    appContextMenu.openContextMenu({
      items: [{
        id: `git-commit-file-diff-${node.path}`,
        label: "查看 Diff 详情",
        icon: FileDiff,
        action: () => onOpenFileDiff(fileIndex),
      }],
      target,
      x,
      y,
    });
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!canOpenDiff || !appContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    openFileDiffMenu(event.currentTarget, event.clientX, event.clientY);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    if (!canOpenDiff || !appContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    openFileDiffMenu(event.currentTarget, bounds.left + 20, bounds.bottom + 4);
  };

  return (
    <li
      className={styles.treeItem}
      role="treeitem"
      aria-expanded={node.kind === "directory" ? expanded : undefined}
      aria-selected={node.kind === "file" ? selected : undefined}
    >
      <button
        className={styles.treeRow}
        type="button"
        data-kind={node.kind}
        data-status={neutral ? undefined : node.status}
        data-selected={selected ? "true" : undefined}
        onContextMenu={handleContextMenu}
        onDoubleClick={() => {
          if (canOpenDiff && node.fileIndex !== null) onOpenFileDiff?.(node.fileIndex);
        }}
        onKeyDown={handleKeyDown}
        onClick={() => {
          if (node.kind === "directory") {
            setExpanded((current) => !current);
          } else if (node.fileIndex !== null) {
            onSelectFile(node.fileIndex);
          }
        }}
      >
        {node.kind === "directory"
          ? <ChevronRight className={styles.chevron} size={14} data-expanded={expanded ? "true" : undefined} />
          : <span className={styles.fileSpacer} />}
        <img
          className={styles.materialIcon}
          src={icon.src}
          alt=""
          aria-hidden="true"
          draggable={false}
          data-icon-id={icon.id}
        />
        <span className={styles.nodeLabel}>
          <span className={styles.nodeName}>{node.name}</span>
          {secondaryLabel ? <span className={styles.nodeMeta}>{secondaryLabel}</span> : null}
        </span>
      </button>
      {node.kind === "directory" ? (
        <div className={styles.treeGroup} data-expanded={expanded ? "true" : undefined}>
          <ul role="group">{node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              selectedFileIndex={selectedFileIndex}
              onSelectFile={onSelectFile}
              onOpenFileDiff={onOpenFileDiff}
              neutral={neutral}
            />
          ))}</ul>
        </div>
      ) : null}
    </li>
  );
}

function commitFileStatus(status: GitFileStatusCode): CommitFileStatus {
  if (status === "added" || status === "untracked") return "added";
  if (status === "deleted") return "deleted";
  return "modified";
}

function aggregateDirectoryStatus(children: readonly GitCommitFileNode[]): CommitFileStatus {
  if (children.length > 0 && children.every((child) => child.status === "added")) return "added";
  if (children.length > 0 && children.every((child) => child.status === "deleted")) return "deleted";
  return "modified";
}

function clampFilesPanePercent(value: number): number {
  return Math.min(MAX_FILES_PANE_PERCENT, Math.max(MIN_FILES_PANE_PERCENT, value));
}

function signatureIcon(signature: GitCommitDetail["commit"]["signature"]) {
  if (signature === "valid") return <ShieldCheck size={13} aria-hidden="true" />;
  if (signature === "invalid") return <ShieldX size={13} aria-hidden="true" />;
  return <ShieldQuestion size={13} aria-hidden="true" />;
}

function signatureLabel(signature: GitCommitDetail["commit"]["signature"]): string {
  return ({ valid: "有效", invalid: "无效", unknown: "未知", unsigned: "未签名" })[signature];
}

function formatCommitDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
