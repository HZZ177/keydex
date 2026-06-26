import { ChevronRight, Crosshair, RefreshCw, Search } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import type {
  RuntimeBridge,
  WorkspaceEntry,
  WorkspaceScope,
  WorkspaceSearchOptions,
  WorkspaceSearchResult,
} from "@/runtime";
import { useWorkspaceFileSearch } from "@/renderer/hooks/useWorkspaceFileSearch";
import { WORKSPACE_FILE_SEARCH_BUDGET_HINT } from "@/renderer/utils/workspaceFileSearchBudget";
import { LoadingSkeleton } from "@/renderer/components/loading";

import { useMaterialEntryIcon } from "./materialIconTheme";
import styles from "./WorkspacePanel.module.css";

export interface WorkspacePanelProps {
  workspaceId?: string;
  sessionId?: string;
  label?: string;
  runtime: RuntimeBridge;
  chrome?: "default" | "panel";
  selectedPath?: string | null;
  revealSelectedPathRequestId?: number;
  onSelectFile?: (path: string) => void;
}

type EntryMap = Record<string, WorkspaceEntry[]>;
type ErrorMap = Record<string, string>;
const TREE_GROUP_TRANSITION_MS = 340;
const ENTRY_NAME_TOOLTIP_DELAY_MS = 500;

export function WorkspacePanel({
  workspaceId,
  sessionId,
  label,
  runtime,
  chrome = "default",
  selectedPath: controlledSelectedPath,
  revealSelectedPathRequestId = 0,
  onSelectFile,
}: WorkspacePanelProps) {
  const treeRef = useRef<HTMLDivElement | null>(null);
  const handledRevealSelectedPathRequestIdRef = useRef(0);
  const [entriesByPath, setEntriesByPath] = useState<EntryMap>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set([""]));
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [errorsByPath, setErrorsByPath] = useState<ErrorMap>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [locateRequest, setLocateRequest] = useState<{ id: number; path: string } | null>(null);
  const onSelectFileRef = useRef(onSelectFile);
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
        setEntriesByPath((entries) => ({ ...entries, "": sortEntries(response.entries) }));
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

  useEffect(() => {
    onSelectFileRef.current = onSelectFile;
  }, [onSelectFile]);

  const loadDirectory = useCallback(async (path: string, force = false) => {
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
  }, [entriesByPath, runtime, scope]);

  const toggleDirectory = useCallback(async (path: string) => {
    if (expandedPaths.has(path)) {
      setExpandedPaths((paths) => removeFromSet(paths, path));
      return;
    }
    if (entriesByPath[path]) {
      setExpandedPaths((paths) => addToSet(paths, path));
      return;
    }
    await loadDirectory(path);
    setExpandedPaths((paths) => addToSet(paths, path));
  }, [entriesByPath, expandedPaths, loadDirectory]);

  const selectFile = useCallback((path: string) => {
    setSelectedPath(path);
    onSelectFileRef.current?.(path);
  }, []);

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

  const revealFilePath = useCallback(async (path: string) => {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return;
    }
    const paths = directoryAncestorPaths(normalizedPath);
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
      path: normalizedPath,
    }));
  }, [loadDirectory]);

  async function openSearchFile(path: string) {
    selectFile(path);
    await revealFilePath(path);
  }

  async function locateCurrentFile() {
    const path = effectiveSelectedPath?.trim();
    if (!path) {
      return;
    }
    await revealFilePath(path);
  }

  useEffect(() => {
    const path = effectiveSelectedPath?.trim();
    if (
      !path ||
      !revealSelectedPathRequestId ||
      handledRevealSelectedPathRequestIdRef.current === revealSelectedPathRequestId
    ) {
      return;
    }
    handledRevealSelectedPathRequestIdRef.current = revealSelectedPathRequestId;
    void revealFilePath(path);
  }, [effectiveSelectedPath, revealFilePath, revealSelectedPathRequestId]);

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
    <section className={styles.panel} data-chrome={chrome} data-workspace-panel-root="true" aria-label="工作区文件树">
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
                    onSelectFile={(path) => void openSearchFile(path)}
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
  return <LoadingSkeleton className={styles.loadingState} label={label} width="compact" />;
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

interface TreeNodeProps {
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
}

const TreeNode = memo(function TreeNode({
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
}: TreeNodeProps) {
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
          <EllipsizedEntryName name={entry.name} />
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
          <EllipsizedEntryName name={entry.name} />
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
}, areTreeNodePropsEqual);

function areTreeNodePropsEqual(previous: TreeNodeProps, next: TreeNodeProps): boolean {
  if (
    previous.entry !== next.entry ||
    previous.entriesByPath !== next.entriesByPath ||
    previous.errorsByPath !== next.errorsByPath ||
    previous.expandedPaths !== next.expandedPaths ||
    previous.filterQuery !== next.filterQuery ||
    previous.loadingPaths !== next.loadingPaths ||
    previous.onSelectFile !== next.onSelectFile ||
    previous.onToggleDirectory !== next.onToggleDirectory ||
    previous.depth !== next.depth
  ) {
    return false;
  }
  if (previous.selectedPath === next.selectedPath) {
    return true;
  }
  return !treeEntryContainsPath(previous.entry, previous.selectedPath) &&
    !treeEntryContainsPath(next.entry, next.selectedPath);
}

function treeEntryContainsPath(entry: WorkspaceEntry, path: string | null): boolean {
  if (!path) {
    return false;
  }
  if (entry.path === path) {
    return true;
  }
  return entry.type === "directory" && path.startsWith(`${entry.path}/`);
}

const SearchResultNode = memo(function SearchResultNode({
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
        <EllipsizedEntryName name={entry.name} />
        <em title={entry.path}>{entry.path}</em>
      </button>
    </div>
  );
});

const EllipsizedEntryName = memo(function EllipsizedEntryName({ name }: { name: string }) {
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const [tooltip, setTooltip] = useState<{ left: number; top: number; text: string } | null>(null);

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);

  const hideTooltip = useCallback(() => {
    clearShowTimer();
    setTooltip(null);
  }, [clearShowTimer]);

  const scheduleTooltip = useCallback(() => {
    clearShowTimer();
    showTimerRef.current = window.setTimeout(() => {
      showTimerRef.current = null;
      const label = labelRef.current;
      if (!label || !isElementEllipsized(label)) {
        setTooltip(null);
        return;
      }
      const rect = label.getBoundingClientRect();
      setTooltip({
        left: rect.right + 10,
        top: rect.top + rect.height / 2,
        text: name,
      });
    }, ENTRY_NAME_TOOLTIP_DELAY_MS);
  }, [clearShowTimer, name]);

  useEffect(() => {
    if (!tooltip) {
      return;
    }
    const close = () => hideTooltip();
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [hideTooltip, tooltip]);

  useEffect(() => hideTooltip, [hideTooltip]);

  return (
    <>
      <span
        ref={labelRef}
        className={styles.nodeLabel}
        onClick={hideTooltip}
        onMouseEnter={scheduleTooltip}
        onMouseLeave={hideTooltip}
      >
        {name}
      </span>
      {tooltip
        ? createPortal(
            <div
              className={styles.nodeNameTooltip}
              role="tooltip"
              style={{ left: tooltip.left, top: tooltip.top }}
            >
              {tooltip.text}
            </div>,
            document.body,
          )
        : null}
    </>
  );
});

function AnimatedTreeGroup({ children, expanded }: { children: ReactNode; expanded: boolean }) {
  const [mounted, setMounted] = useState(expanded);
  const [open, setOpen] = useState(expanded);
  const [height, setHeight] = useState(expanded ? "auto" : "0px");
  const groupRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const frameRefs = useRef<number[]>([]);
  const expandTimerRef = useRef<number | null>(null);
  const pendingExpandAnimationRef = useRef(false);
  const initializedRef = useRef(false);

  const clearAnimationHandles = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (expandTimerRef.current !== null) {
      window.clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }
    frameRefs.current.forEach((frame) => window.cancelAnimationFrame(frame));
    frameRefs.current = [];
  };

  const scheduleFrame = (callback: () => void) => {
    const frame = window.requestAnimationFrame(() => {
      frameRefs.current = frameRefs.current.filter((item) => item !== frame);
      callback();
    });
    frameRefs.current.push(frame);
  };

  useLayoutEffect(() => {
    clearAnimationHandles();
    if (!initializedRef.current) {
      initializedRef.current = true;
      setMounted(expanded);
      setOpen(expanded);
      setHeight(expanded ? "auto" : "0px");
      return;
    }

    if (expanded) {
      pendingExpandAnimationRef.current = true;
      if (!mounted) {
        setHeight("0px");
        setOpen(false);
        setMounted(true);
      }
      return;
    }

    pendingExpandAnimationRef.current = false;
    if (!mounted) {
      setOpen(false);
      setHeight("0px");
      return;
    }

    const currentHeight = groupRef.current?.getBoundingClientRect().height ?? innerRef.current?.scrollHeight ?? 0;
    setHeight(`${currentHeight}px`);
    setOpen(false);
    scheduleFrame(() => setHeight("0px"));
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setMounted(false);
      setHeight("0px");
    }, TREE_GROUP_TRANSITION_MS);
  }, [expanded]);

  useLayoutEffect(() => {
    if (!mounted || !expanded || !pendingExpandAnimationRef.current) {
      return;
    }

    pendingExpandAnimationRef.current = false;
    const targetHeight = innerRef.current?.scrollHeight ?? 0;
    setHeight("0px");
    scheduleFrame(() => {
      scheduleFrame(() => {
        setOpen(true);
        setHeight(`${targetHeight}px`);
      });
    });
    expandTimerRef.current = window.setTimeout(() => {
      expandTimerRef.current = null;
      setHeight("auto");
    }, TREE_GROUP_TRANSITION_MS);
  }, [expanded, mounted]);

  useEffect(
    () => () => {
      clearAnimationHandles();
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
      ref={groupRef}
      role="group"
      style={{ "--tree-group-height": height } as CSSProperties}
    >
      <div className={styles.nodeGroupInner} ref={innerRef}>{children}</div>
    </div>
  );
}

const MaterialEntryIcon = memo(function MaterialEntryIcon({ path, type }: { path: string; type: WorkspaceEntry["type"] }) {
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
});

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

function isElementEllipsized(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
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
