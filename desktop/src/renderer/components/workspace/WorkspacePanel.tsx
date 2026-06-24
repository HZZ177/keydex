import { ChevronRight, Crosshair, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  RuntimeBridge,
  WorkspaceEntry,
  WorkspaceScope,
  WorkspaceSearchOptions,
  WorkspaceSearchResult,
} from "@/runtime";
import { useWorkspaceFileSearch } from "@/renderer/hooks/useWorkspaceFileSearch";
import { WORKSPACE_FILE_SEARCH_BUDGET_HINT } from "@/renderer/utils/workspaceFileSearchBudget";

import { useMaterialEntryIcon } from "./materialIconTheme";
import styles from "./WorkspacePanel.module.css";

export interface WorkspacePanelProps {
  workspaceId?: string;
  sessionId?: string;
  label?: string;
  runtime: RuntimeBridge;
  chrome?: "default" | "panel";
  selectedPath?: string | null;
  onSelectFile?: (path: string) => void;
}

type EntryMap = Record<string, WorkspaceEntry[]>;
type ErrorMap = Record<string, string>;
const TREE_GROUP_TRANSITION_MS = 340;

export function WorkspacePanel({
  workspaceId,
  sessionId,
  label,
  runtime,
  chrome = "default",
  selectedPath: controlledSelectedPath,
  onSelectFile,
}: WorkspacePanelProps) {
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [entriesByPath, setEntriesByPath] = useState<EntryMap>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set([""]));
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [errorsByPath, setErrorsByPath] = useState<ErrorMap>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [locateRequest, setLocateRequest] = useState<{ id: number; path: string } | null>(null);
  const scope = useMemo(() => workspaceScope({ workspaceId, sessionId }), [workspaceId, sessionId]);
  const scopeLabel = label ?? workspaceId ?? sessionId ?? "未绑定工作区";
  const searchWorkspace = useCallback(
    (query: string, options?: WorkspaceSearchOptions) => {
      if (!scope) {
        return Promise.resolve([]);
      }
      return runtime.workspace.search(scope, query, options);
    },
    [runtime, scope],
  );

  useEffect(() => {
    let active = true;
    setEntriesByPath({});
    setErrorsByPath({});
    setExpandedPaths(new Set([""]));
    setSelectedPath(null);
    setFilterQuery("");
    setLoadingPaths(new Set([""]));
    if (!scope) {
      setErrorsByPath({ "": "工作区未绑定" });
      setLoadingPaths(new Set());
      return () => {
        active = false;
      };
    }
    void runtime.workspace
      .listDirectory(scope, "")
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
  }, [runtime, scope]);

  const rootEntries = entriesByPath[""] ?? [];
  const normalizedFilter = filterQuery.trim().toLowerCase();
  const searchActive = normalizedFilter.length > 0;
  const searchState = useWorkspaceFileSearch({
    enabled: searchActive && Boolean(scope),
    query: filterQuery,
    search: searchWorkspace,
  });
  const visibleRootEntries = useMemo(
    () => filterEntries(rootEntries, entriesByPath, searchActive ? "" : normalizedFilter),
    [entriesByPath, normalizedFilter, rootEntries, searchActive],
  );
  const rootLoading = loadingPaths.has("");
  const rootError = errorsByPath[""];
  const effectiveSelectedPath = controlledSelectedPath ?? selectedPath;
  const selectedLabel = effectiveSelectedPath ?? "未选择文件";
  const canLocateCurrentFile = Boolean(effectiveSelectedPath);
  const initialLoading = !searchActive && rootLoading && !rootEntries.length;
  const searchLoading = searchActive && searchState.loading;
  const panelError = searchActive ? searchState.error : rootError;
  const emptyMessage =
    !searchActive && !rootLoading && !rootError && !rootEntries.length
      ? "工作区为空"
      : searchActive && !searchLoading && !searchState.error && !searchState.results.length
        ? "没有匹配的文件"
        : null;

  async function loadDirectory(path: string, force = false) {
    if (!force && entriesByPath[path]) {
      return;
    }
    setLoadingPaths((paths) => addToSet(paths, path));
    setErrorsByPath((errors) => removeKey(errors, path));
    try {
      if (!scope) {
        setErrorsByPath((errors) => ({ ...errors, [path]: "工作区未绑定" }));
        return;
      }
      const response = await runtime.workspace.listDirectory(scope, path);
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

  async function openSearchDirectory(path: string) {
    setFilterQuery("");
    const paths = directoryRevealPaths(path);
    setExpandedPaths((expanded) => {
      const next = new Set(expanded);
      paths.forEach((entryPath) => next.add(entryPath));
      return next;
    });
    for (const entryPath of paths) {
      await loadDirectory(entryPath);
    }
  }

  async function locateCurrentFile() {
    const path = effectiveSelectedPath?.trim();
    if (!path) {
      return;
    }
    const paths = directoryAncestorPaths(path);
    setFilterQuery("");
    setExpandedPaths((expanded) => {
      const next = new Set(expanded);
      paths.forEach((entryPath) => next.add(entryPath));
      return next;
    });
    for (const entryPath of paths) {
      await loadDirectory(entryPath);
    }
    setLocateRequest((current) => ({
      id: (current?.id ?? 0) + 1,
      path,
    }));
  }

  useEffect(() => {
    if (!locateRequest) {
      return;
    }
    const target = findTreeEntryButton(treeRef.current, locateRequest.path);
    if (!target) {
      return;
    }
    target.scrollIntoView?.({ behavior: "smooth", block: "center", inline: "nearest" });
    target.focus({ preventScroll: true });
    setLocateRequest(null);
  }, [entriesByPath, expandedPaths, locateRequest, searchActive]);

  return (
    <section className={styles.panel} data-chrome={chrome} aria-label="工作区文件树">
      {chrome === "default" ? (
        <header className={styles.header}>
          <div className={styles.rootInfo}>
            <span>当前工作区</span>
            <strong title={scopeLabel}>{scopeLabel}</strong>
          </div>
          <button disabled={rootLoading} onClick={() => void loadDirectory("", true)} type="button">
            <RefreshCw className={rootLoading ? styles.spinning : undefined} size={14} />
            <span>刷新</span>
          </button>
        </header>
      ) : null}

      {chrome === "default" ? (
        <div className={styles.pathBar} title={selectedLabel}>
          {selectedLabel}
        </div>
      ) : null}

      <div className={styles.searchRow}>
        <label className={styles.searchBox}>
          <Search size={16} />
          <input
            aria-label="筛选文件"
            placeholder="筛选文件..."
            type="search"
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
          />
        </label>
        <button
          className={styles.locateButton}
          type="button"
          aria-label="定位当前文件"
          title={canLocateCurrentFile ? "定位当前文件" : "没有打开的文件"}
          disabled={!canLocateCurrentFile}
          onClick={() => void locateCurrentFile()}
        >
          <Crosshair size={16} strokeWidth={1.8} />
        </button>
        <p className={styles.searchHint}>{WORKSPACE_FILE_SEARCH_BUDGET_HINT}</p>
      </div>

      <div className={styles.content}>
        {initialLoading || searchLoading ? (
          <WorkspacePanelLoading label={searchActive ? "正在搜索工作区" : "正在读取工作区"} />
        ) : null}
        {panelError ? <WorkspacePanelState message={panelError} role="alert" tone="danger" /> : null}
        {!initialLoading && !searchLoading && !panelError ? (
          <div
            className={styles.tree}
            data-mode={searchActive ? "search" : "tree"}
            ref={treeRef}
            role="tree"
            aria-label={searchActive ? "工作区搜索结果" : "工作区目录"}
          >
            {searchActive
              ? searchState.results.map((entry) => (
                  <SearchResultNode
                    entry={entry}
                    key={entry.path}
                    onOpenDirectory={(path) => void openSearchDirectory(path)}
                    onSelectFile={selectFile}
                    selectedPath={effectiveSelectedPath}
                  />
                ))
              : visibleRootEntries.map((entry) => (
                  <TreeNode
                    entriesByPath={entriesByPath}
                    entry={entry}
                    errorsByPath={errorsByPath}
                    expandedPaths={expandedPaths}
                    filterQuery={normalizedFilter}
                    key={entry.path}
                    loadingPaths={loadingPaths}
                    onSelectFile={selectFile}
                    onToggleDirectory={(path) => void toggleDirectory(path)}
                    selectedPath={effectiveSelectedPath}
                  />
                ))}
          </div>
        ) : null}
        {!initialLoading && !searchLoading && !panelError && emptyMessage ? (
          <WorkspacePanelState message={emptyMessage} />
        ) : null}
      </div>
    </section>
  );
}

function WorkspacePanelLoading({ label }: { label: string }) {
  return (
    <div className={styles.loadingState} role="status" aria-label={label}>
      <div className={styles.skeletonStack} aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <span>{label}</span>
    </div>
  );
}

function WorkspacePanelState({
  message,
  role,
  tone = "muted",
}: {
  message: string;
  role?: "alert" | "status";
  tone?: "danger" | "muted";
}) {
  return (
    <div className={styles.centerState} data-tone={tone} role={role}>
      {message}
    </div>
  );
}

function workspaceScope({
  workspaceId,
  sessionId,
}: {
  workspaceId?: string;
  sessionId?: string;
}): WorkspaceScope | null {
  if (sessionId) {
    return { sessionId };
  }
  if (workspaceId) {
    return { workspaceId };
  }
  return null;
}

function TreeNode({
  entriesByPath,
  entry,
  errorsByPath,
  expandedPaths,
  filterQuery,
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
  filterQuery: string;
  loadingPaths: Set<string>;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  selectedPath: string | null;
  depth?: number;
}) {
  const isDirectory = entry.type === "directory";
  const loading = loadingPaths.has(entry.path);
  const children = useMemo(
    () => filterEntries(entriesByPath[entry.path] ?? [], entriesByPath, filterQuery),
    [entriesByPath, entry.path, filterQuery],
  );
  const expanded = expandedPaths.has(entry.path) || (Boolean(filterQuery) && children.length > 0);
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
          <MaterialEntryIcon path={entry.path || entry.name} type="directory" />
          <span className={styles.nodeLabel}>{entry.name}</span>
          {loading ? <em>读取中</em> : null}
        </button>
      ) : (
        <button
          aria-label={`选择文件 ${entry.path}`}
          className={styles.nodeButton}
          data-selected={selectedPath === entry.path ? "true" : "false"}
          data-entry-path={entry.path}
          onClick={() => onSelectFile(entry.path)}
          style={{ paddingLeft }}
          type="button"
        >
          <span className={styles.fileSpacer} />
          <MaterialEntryIcon path={entry.path || entry.name} type="file" />
          <span className={styles.nodeLabel}>{entry.name}</span>
          {typeof entry.size === "number" ? <em>{formatSize(entry.size)}</em> : null}
        </button>
      )}
      {error ? <div className={styles.inlineError} role="alert">{error}</div> : null}
      {isDirectory ? (
        <AnimatedTreeGroup expanded={expanded}>
          {children.map((child) => (
            <TreeNode
              entriesByPath={entriesByPath}
              entry={child}
              errorsByPath={errorsByPath}
              expandedPaths={expandedPaths}
              filterQuery={filterQuery}
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
        </AnimatedTreeGroup>
      ) : null}
    </div>
  );
}

function SearchResultNode({
  entry,
  onOpenDirectory,
  onSelectFile,
  selectedPath,
}: {
  entry: WorkspaceSearchResult;
  onOpenDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
  selectedPath: string | null;
}) {
  const isDirectory = entry.type === "directory";

  return (
    <div className={styles.node} role="treeitem" aria-expanded={isDirectory ? false : undefined}>
      <button
        aria-label={isDirectory ? `打开目录 ${entry.path}` : `选择文件 ${entry.path}`}
        className={styles.nodeButton}
        data-selected={!isDirectory && selectedPath === entry.path ? "true" : "false"}
        data-entry-path={!isDirectory ? entry.path : undefined}
        onClick={() => (isDirectory ? onOpenDirectory(entry.path) : onSelectFile(entry.path))}
        type="button"
      >
        {isDirectory ? (
          <ChevronRight className={styles.chevron} size={14} />
        ) : (
          <span className={styles.fileSpacer} />
        )}
        <MaterialEntryIcon path={entry.path || entry.name} type={entry.type} />
        <span className={styles.nodeLabel}>{entry.name}</span>
        <em title={entry.path}>{entry.path}</em>
      </button>
    </div>
  );
}

function AnimatedTreeGroup({ children, expanded }: { children: ReactNode; expanded: boolean }) {
  const [mounted, setMounted] = useState(expanded);
  const [open, setOpen] = useState(expanded);
  const closeTimerRef = useRef<number | null>(null);
  const openFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (openFrameRef.current !== null) {
      window.cancelAnimationFrame(openFrameRef.current);
      openFrameRef.current = null;
    }

    if (expanded) {
      setMounted(true);
      openFrameRef.current = window.requestAnimationFrame(() => {
        openFrameRef.current = null;
        setOpen(true);
      });
      return;
    }

    setOpen(false);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setMounted(false);
    }, TREE_GROUP_TRANSITION_MS);
  }, [expanded]);

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
      if (openFrameRef.current !== null) {
        window.cancelAnimationFrame(openFrameRef.current);
      }
    },
    [],
  );

  if (!mounted) {
    return null;
  }

  return (
    <div
      aria-hidden={open ? undefined : true}
      className={styles.nodeGroup}
      data-open={open ? "true" : "false"}
      role="group"
    >
      <div className={styles.nodeGroupInner}>{children}</div>
    </div>
  );
}

function MaterialEntryIcon({ path, type }: { path: string; type: WorkspaceEntry["type"] }) {
  const icon = useMaterialEntryIcon(path, type === "directory" ? "directory" : "file");
  return (
    <img
      alt=""
      aria-hidden="true"
      className={styles.materialIcon}
      data-icon-id={icon.id}
      draggable={false}
      src={icon.src}
    />
  );
}

function filterEntries(entries: WorkspaceEntry[], entriesByPath: EntryMap, query: string): WorkspaceEntry[] {
  if (!query) {
    return entries;
  }
  return entries.filter((entry) => entryMatches(entry, entriesByPath, query));
}

function entryMatches(entry: WorkspaceEntry, entriesByPath: EntryMap, query: string): boolean {
  if (entry.name.toLowerCase().includes(query) || entry.path.toLowerCase().includes(query)) {
    return true;
  }
  if (entry.type !== "directory") {
    return false;
  }
  return (entriesByPath[entry.path] ?? []).some((child) => entryMatches(child, entriesByPath, query));
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

function directoryRevealPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function directoryAncestorPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

function findTreeEntryButton(root: HTMLElement | null, path: string): HTMLElement | null {
  if (!root) {
    return null;
  }
  return (
    Array.from(root.querySelectorAll<HTMLElement>("[data-entry-path]")).find(
      (element) => element.dataset.entryPath === path,
    ) ?? null
  );
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
