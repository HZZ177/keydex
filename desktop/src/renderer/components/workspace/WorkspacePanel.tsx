import { ChevronRight, FileText, Folder, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { RuntimeBridge, WorkspaceEntry } from "@/runtime";

import styles from "./WorkspacePanel.module.css";

export interface WorkspacePanelProps {
  root: string;
  runtime: RuntimeBridge;
  onSelectFile?: (path: string) => void;
}

type EntryMap = Record<string, WorkspaceEntry[]>;
type ErrorMap = Record<string, string>;

export function WorkspacePanel({ root, runtime, onSelectFile }: WorkspacePanelProps) {
  const [entriesByPath, setEntriesByPath] = useState<EntryMap>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set([""]));
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [errorsByPath, setErrorsByPath] = useState<ErrorMap>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setEntriesByPath({});
    setErrorsByPath({});
    setExpandedPaths(new Set([""]));
    setSelectedPath(null);
    setLoadingPaths(new Set([""]));
    void runtime.workspace
      .listDirectory(root, "")
      .then((response) => {
        if (!active) {
          return;
        }
        setEntriesByPath({ "": sortEntries(response.entries) });
      })
      .catch((reason) => {
        if (active) {
          setErrorsByPath({ "": errorMessage(reason) });
        }
      })
      .finally(() => {
        if (active) {
          setLoadingPaths(new Set());
        }
      });
    return () => {
      active = false;
    };
  }, [root, runtime]);

  const rootEntries = entriesByPath[""] ?? [];
  const rootLoading = loadingPaths.has("");
  const rootError = errorsByPath[""];
  const selectedLabel = selectedPath ?? "未选择文件";

  async function loadDirectory(path: string, force = false) {
    if (!force && entriesByPath[path]) {
      return;
    }
    setLoadingPaths((paths) => addToSet(paths, path));
    setErrorsByPath((errors) => removeKey(errors, path));
    try {
      const response = await runtime.workspace.listDirectory(root, path);
      setEntriesByPath((entries) => ({ ...entries, [path]: sortEntries(response.entries) }));
    } catch (reason) {
      setErrorsByPath((errors) => ({ ...errors, [path]: errorMessage(reason) }));
    } finally {
      setLoadingPaths((paths) => removeFromSet(paths, path));
    }
  }

  async function toggleDirectory(path: string) {
    if (expandedPaths.has(path)) {
      setExpandedPaths((paths) => removeFromSet(paths, path));
      return;
    }
    setExpandedPaths((paths) => addToSet(paths, path));
    await loadDirectory(path);
  }

  function selectFile(path: string) {
    setSelectedPath(path);
    onSelectFile?.(path);
  }

  return (
    <section className={styles.panel} aria-label="工作区文件树">
      <header className={styles.header}>
        <div className={styles.rootInfo}>
          <span>当前工作区</span>
          <strong title={root}>{root}</strong>
        </div>
        <button disabled={rootLoading} onClick={() => void loadDirectory("", true)} type="button">
          <RefreshCw className={rootLoading ? styles.spinning : undefined} size={14} />
          <span>刷新</span>
        </button>
      </header>

      <div className={styles.pathBar} title={selectedLabel}>
        {selectedLabel}
      </div>

      {rootError ? <div className={styles.error} role="alert">{rootError}</div> : null}
      {rootLoading && !rootEntries.length ? <p className={styles.muted}>正在读取工作区</p> : null}

      <div className={styles.tree} role="tree" aria-label="工作区目录">
        {rootEntries.map((entry) => (
          <TreeNode
            entriesByPath={entriesByPath}
            entry={entry}
            errorsByPath={errorsByPath}
            expandedPaths={expandedPaths}
            key={entry.path}
            loadingPaths={loadingPaths}
            onSelectFile={selectFile}
            onToggleDirectory={(path) => void toggleDirectory(path)}
            selectedPath={selectedPath}
          />
        ))}
      </div>

      {!rootLoading && !rootError && !rootEntries.length ? <p className={styles.muted}>工作区为空</p> : null}
    </section>
  );
}

function TreeNode({
  entriesByPath,
  entry,
  errorsByPath,
  expandedPaths,
  loadingPaths,
  onSelectFile,
  onToggleDirectory,
  selectedPath,
  depth = 0,
}: {
  entriesByPath: EntryMap;
  entry: WorkspaceEntry;
  errorsByPath: ErrorMap;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  selectedPath: string | null;
  depth?: number;
}) {
  const isDirectory = entry.type === "directory";
  const expanded = expandedPaths.has(entry.path);
  const loading = loadingPaths.has(entry.path);
  const children = useMemo(() => entriesByPath[entry.path] ?? [], [entriesByPath, entry.path]);
  const error = errorsByPath[entry.path];
  const paddingLeft = 8 + depth * 14;

  return (
    <div className={styles.node} role="treeitem" aria-expanded={isDirectory ? expanded : undefined}>
      {isDirectory ? (
        <button
          aria-label={`${expanded ? "折叠" : "展开"} ${entry.name}`}
          className={styles.nodeButton}
          onClick={() => onToggleDirectory(entry.path)}
          style={{ paddingLeft }}
          type="button"
        >
          <ChevronRight className={styles.chevron} data-expanded={expanded ? "true" : "false"} size={14} />
          <Folder size={14} />
          <span>{entry.name}</span>
          {loading ? <em>读取中</em> : null}
        </button>
      ) : (
        <button
          aria-label={`选择文件 ${entry.path}`}
          className={styles.nodeButton}
          data-selected={selectedPath === entry.path ? "true" : "false"}
          onClick={() => onSelectFile(entry.path)}
          style={{ paddingLeft }}
          type="button"
        >
          <span className={styles.fileSpacer} />
          <FileText size={14} />
          <span>{entry.name}</span>
          {typeof entry.size === "number" ? <em>{formatSize(entry.size)}</em> : null}
        </button>
      )}
      {error ? <div className={styles.inlineError} role="alert">{error}</div> : null}
      {isDirectory && expanded ? (
        <div role="group">
          {children.map((child) => (
            <TreeNode
              entriesByPath={entriesByPath}
              entry={child}
              errorsByPath={errorsByPath}
              expandedPaths={expandedPaths}
              key={child.path}
              loadingPaths={loadingPaths}
              onSelectFile={onSelectFile}
              onToggleDirectory={onToggleDirectory}
              selectedPath={selectedPath}
              depth={depth + 1}
            />
          ))}
          {!loading && !error && entriesByPath[entry.path] && !children.length ? (
            <p className={styles.emptyDir} style={{ paddingLeft: paddingLeft + 28 }}>空目录</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function sortEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name, "zh-CN");
  });
}

function addToSet(values: Set<string>, value: string): Set<string> {
  const next = new Set(values);
  next.add(value);
  return next;
}

function removeFromSet(values: Set<string>, value: string): Set<string> {
  const next = new Set(values);
  next.delete(value);
  return next;
}

function removeKey(values: ErrorMap, key: string): ErrorMap {
  const next = { ...values };
  delete next[key];
  return next;
}

function formatSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "读取工作区失败";
}
