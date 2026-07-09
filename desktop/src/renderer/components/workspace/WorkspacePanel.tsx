import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Crosshair, RefreshCw, Search } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
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
import { APP_FIND_SHORTCUT_EVENT, type AppFindShortcutDetail } from "@/renderer/events/findShortcut";
import { subscribeExpandWorkspaceDirectory } from "@/renderer/events/workspaceFileContext";
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
  bottomSafeArea?: string;
  initialState?: WorkspacePanelState | null;
  onSelectFile?: (path: string) => void;
  onStateChange?: (state: WorkspacePanelState) => void;
}

type EntryMap = Record<string, WorkspaceEntry[]>;
type ErrorMap = Record<string, string>;
type KeyboardTreeEntry = Pick<WorkspaceEntry, "path" | "type">;

export interface WorkspacePanelState {
  entriesByPath: Record<string, WorkspaceEntry[]>;
  expandedPaths: string[];
  bulkExpandedSubtreePaths: string[];
  errorsByPath: Record<string, string>;
  workspaceRoot: string;
  selectedPath: string | null;
  filterQuery: string;
  keyboardActivePath: string | null;
}
const TREE_GROUP_TRANSITION_MS = 180;
const ENTRY_NAME_TOOLTIP_DELAY_MS = 500;
const SUBTREE_EXPAND_OPTIONS = {
  maxDepth: 6,
  maxDirs: 300,
  maxEntries: 1500,
  timeoutMs: 700,
};

export function WorkspacePanel({
  workspaceId,
  sessionId,
  label,
  runtime,
  chrome = "default",
  selectedPath: controlledSelectedPath,
  revealSelectedPathRequestId = 0,
  bottomSafeArea,
  initialState = null,
  onSelectFile,
  onStateChange,
}: WorkspacePanelProps) {
  const initialStateRef = useRef(initialState);
  const panelRef = useRef<HTMLElement | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const handledRevealSelectedPathRequestIdRef = useRef(0);
  const [entriesByPath, setEntriesByPath] = useState<EntryMap>(() => initialState?.entriesByPath ?? {});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(initialState?.expandedPaths ?? [""]),
  );
  const [bulkExpandedSubtreePaths, setBulkExpandedSubtreePaths] = useState<Set<string>>(
    () => new Set(initialState?.bulkExpandedSubtreePaths ?? []),
  );
  const [subtreeBusyPaths, setSubtreeBusyPaths] = useState<Set<string>>(() => new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(
    () => new Set(initialState?.entriesByPath[""] ? [] : [""]),
  );
  const [errorsByPath, setErrorsByPath] = useState<ErrorMap>(() => initialState?.errorsByPath ?? {});
  const [workspaceRoot, setWorkspaceRoot] = useState(initialState?.workspaceRoot ?? "");
  const [selectedPath, setSelectedPath] = useState<string | null>(initialState?.selectedPath ?? null);
  const [filterQuery, setFilterQuery] = useState(initialState?.filterQuery ?? "");
  const [keyboardActivePath, setKeyboardActivePath] = useState<string | null>(
    initialState?.keyboardActivePath ?? null,
  );
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
    const restoredState = initialStateRef.current;
    const restoredRootEntries = restoredState?.entriesByPath[""];
    setEntriesByPath(restoredState?.entriesByPath ?? {});
    setErrorsByPath(restoredState?.errorsByPath ?? {});
    setExpandedPaths(new Set(restoredState?.expandedPaths ?? [""]));
    setBulkExpandedSubtreePaths(new Set(restoredState?.bulkExpandedSubtreePaths ?? []));
    setSubtreeBusyPaths(new Set());
    setWorkspaceRoot(restoredState?.workspaceRoot ?? "");
    setSelectedPath(restoredState?.selectedPath ?? null);
    setFilterQuery(restoredState?.filterQuery ?? "");
    setKeyboardActivePath(restoredState?.keyboardActivePath ?? null);
    setLoadingPaths(new Set(restoredRootEntries ? [] : [""]));
    if (!scope) {
      setErrorsByPath({ "": "工作区未绑定" });
      setLoadingPaths(new Set());
      return () => {
        active = false;
      };
    }
    if (restoredRootEntries) {
      void runtime.workspace
        .listDirectory(scope, "")
        .then((response) => {
          if (!active) {
            return;
          }
          setWorkspaceRoot(response.root);
          setEntriesByPath((entries) => ({ ...entries, "": sortEntries(response.entries) }));
        })
        .catch((reason) => {
          if (active) {
            setErrorsByPath((errors) => ({ ...errors, "": errorMessage(reason) }));
          }
        });
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
        setWorkspaceRoot(response.root);
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

  useEffect(() => {
    onStateChange?.({
      entriesByPath,
      expandedPaths: Array.from(expandedPaths),
      bulkExpandedSubtreePaths: Array.from(bulkExpandedSubtreePaths),
      errorsByPath,
      workspaceRoot,
      selectedPath,
      filterQuery,
      keyboardActivePath,
    });
  }, [
    bulkExpandedSubtreePaths,
    entriesByPath,
    errorsByPath,
    expandedPaths,
    filterQuery,
    keyboardActivePath,
    onStateChange,
    selectedPath,
    workspaceRoot,
  ]);

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
  const fullyExpandedSubtreePaths = useMemo(
    () => collectFullyExpandedDirectoryPaths(entriesByPath, expandedPaths),
    [entriesByPath, expandedPaths],
  );
  const keyboardEntries = useMemo(
    () =>
      searchActive
        ? searchState.results.map((entry) => ({ path: entry.path, type: entry.type }))
        : flattenVisibleTreeEntries(visibleRootEntries, entriesByPath, expandedPaths),
    [entriesByPath, expandedPaths, searchActive, searchState.results, visibleRootEntries],
  );

  useEffect(() => {
    onSelectFileRef.current = onSelectFile;
  }, [onSelectFile]);

  useEffect(() => {
    if (!keyboardEntries.length) {
      setKeyboardActivePath(null);
      return;
    }
    setKeyboardActivePath((current) => {
      if (current && keyboardEntries.some((entry) => entry.path === current)) {
        return current;
      }
      if (effectiveSelectedPath && keyboardEntries.some((entry) => entry.path === effectiveSelectedPath)) {
        return effectiveSelectedPath;
      }
      return keyboardEntries[0]?.path ?? null;
    });
  }, [effectiveSelectedPath, keyboardEntries]);

  const loadDirectory = useCallback(async (path: string, force = false): Promise<WorkspaceEntry[] | null> => {
    if (!force && entriesByPath[path]) {
      return entriesByPath[path];
    }
    setLoadingPaths((paths) => addToSet(paths, path));
    setErrorsByPath((errors) => removeKey(errors, path));
    try {
      if (!scope) {
        setErrorsByPath((errors) => ({ ...errors, [path]: "工作区未绑定" }));
        return null;
      }
      const response = await runtime.workspace.listDirectory(scope, path);
      const sortedEntries = sortEntries(response.entries);
      setWorkspaceRoot(response.root);
      setEntriesByPath((entries) => ({ ...entries, [path]: sortedEntries }));
      return sortedEntries;
    } catch (reason) {
      setErrorsByPath((errors) => ({ ...errors, [path]: errorMessage(reason) }));
      return null;
    } finally {
      setLoadingPaths((paths) => removeFromSet(paths, path));
    }
  }, [entriesByPath, runtime, scope]);

  const toggleDirectory = useCallback(async (path: string) => {
    if (expandedPaths.has(path)) {
      setExpandedPaths((paths) => removeFromSet(paths, path));
      setBulkExpandedSubtreePaths((paths) => removeFromSet(paths, path));
      return;
    }
    if (entriesByPath[path]) {
      setExpandedPaths((paths) => addToSet(paths, path));
      return;
    }
    await loadDirectory(path);
    setExpandedPaths((paths) => addToSet(paths, path));
  }, [entriesByPath, expandedPaths, loadDirectory]);

  const loadDirectorySubtree = useCallback(async (path: string) => {
    setSubtreeBusyPaths((paths) => addToSet(paths, path));
    setErrorsByPath((errors) => removeKey(errors, path));
    try {
      if (!scope) {
        setErrorsByPath((errors) => ({ ...errors, [path]: "工作区未绑定" }));
        return;
      }
      const response = await runtime.workspace.listDirectorySubtree(scope, path, SUBTREE_EXPAND_OPTIONS);
      setWorkspaceRoot(response.root);
      setEntriesByPath((entries) => ({
        ...entries,
        ...sortEntryMap(response.entries_by_path),
      }));
      setExpandedPaths((paths) => {
        const next = new Set(paths);
        response.expanded_paths.forEach((entryPath) => next.add(entryPath));
        return next;
      });
      setBulkExpandedSubtreePaths((paths) => addToSet(paths, path));
    } catch (reason) {
      setErrorsByPath((errors) => ({ ...errors, [path]: errorMessage(reason) }));
    } finally {
      setSubtreeBusyPaths((paths) => removeFromSet(paths, path));
    }
  }, [runtime, scope]);

  const toggleDirectorySubtree = useCallback(async (path: string, collapse: boolean) => {
    if (collapse) {
      const pathsToCollapse = loadedDirectorySubtreePaths(path, entriesByPath);
      setExpandedPaths((paths) => {
        const next = new Set(paths);
        pathsToCollapse.forEach((entryPath) => next.delete(entryPath));
        return next;
      });
      setBulkExpandedSubtreePaths((paths) => removeManyFromSet(paths, pathsToCollapse));
      return;
    }

    await loadDirectorySubtree(path);
  }, [entriesByPath, loadDirectorySubtree]);

  useEffect(() => {
    return subscribeExpandWorkspaceDirectory((detail) => {
      if (detail.sessionId && detail.sessionId !== sessionId) {
        return;
      }
      if (detail.workspaceId && detail.workspaceId !== workspaceId) {
        return;
      }
      void toggleDirectorySubtree(detail.path, false);
    });
  }, [sessionId, toggleDirectorySubtree, workspaceId]);

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

  const focusFileFilter = useCallback(() => {
    filterInputRef.current?.focus();
    filterInputRef.current?.select();
  }, []);

  const handlePanelKeyDownCapture = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!isFileFilterShortcut(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    focusFileFilter();
  }, [focusFileFilter]);

  const moveKeyboardActiveEntry = useCallback((direction: 1 | -1) => {
    if (!keyboardEntries.length) {
      return;
    }
    setKeyboardActivePath((current) => {
      const currentIndex = current ? keyboardEntries.findIndex((entry) => entry.path === current) : -1;
      const base = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : 0;
      return keyboardEntries[(base + direction + keyboardEntries.length) % keyboardEntries.length]?.path ?? null;
    });
  }, [keyboardEntries]);

  const activateKeyboardEntry = useCallback(() => {
    const activeEntry = keyboardActivePath
      ? keyboardEntries.find((entry) => entry.path === keyboardActivePath)
      : null;
    if (!activeEntry) {
      return;
    }
    if (activeEntry.type === "directory") {
      if (searchActive) {
        void openSearchDirectory(activeEntry.path);
      } else {
        void toggleDirectory(activeEntry.path);
      }
      return;
    }
    if (searchActive) {
      void openSearchFile(activeEntry.path);
      return;
    }
    selectFile(activeEntry.path);
  }, [keyboardActivePath, keyboardEntries, searchActive, selectFile, toggleDirectory]);

  const handleFilterInputKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveKeyboardActiveEntry(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveKeyboardActiveEntry(-1);
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      activateKeyboardEntry();
    }
  }, [activateKeyboardEntry, moveKeyboardActiveEntry]);

  useEffect(() => {
    const handleFindShortcut = (event: Event) => {
      const sourceTarget = (event as CustomEvent<AppFindShortcutDetail>).detail?.sourceTarget ?? null;
      if (!shouldFocusFileFilterForSource(panelRef.current, sourceTarget)) {
        return;
      }
      focusFileFilter();
    };
    document.addEventListener(APP_FIND_SHORTCUT_EVENT, handleFindShortcut);
    return () => document.removeEventListener(APP_FIND_SHORTCUT_EVENT, handleFindShortcut);
  }, [focusFileFilter]);

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

  useEffect(() => {
    if (!keyboardActivePath) {
      return;
    }
    findTreeEntryButton(treeRef.current, keyboardActivePath)?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [keyboardActivePath]);
  const panelStyle = bottomSafeArea
    ? ({ "--workspace-panel-bottom-safe-area": bottomSafeArea } as CSSProperties)
    : undefined;

  return (
    <section
      ref={panelRef}
      className={styles.panel}
      data-chrome={chrome}
      data-bottom-safe-area={bottomSafeArea ? "true" : undefined}
      data-workspace-panel-root="true"
      aria-label="工作区文件树"
      style={panelStyle}
      onKeyDownCapture={handlePanelKeyDownCapture}
    >
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
            ref={filterInputRef}
            type="search"
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
            onKeyDown={handleFilterInputKeyDown}
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
            data-bottom-safe-area={bottomSafeArea ? "true" : undefined}
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
                    keyboardActivePath={keyboardActivePath}
                    selectedPath={effectiveSelectedPath}
                    sessionId={sessionId}
                    workspaceId={workspaceId}
                    workspaceRoot={workspaceRoot}
                  />
                ))
              : visibleRootEntries.map((entry) => (
                  <TreeNode
                    entriesByPath={entriesByPath}
                    bulkExpandedSubtreePaths={bulkExpandedSubtreePaths}
                    entry={entry}
                    errorsByPath={errorsByPath}
                    expandedPaths={expandedPaths}
                    filterQuery={normalizedFilter}
                    fullyExpandedSubtreePaths={fullyExpandedSubtreePaths}
                    key={entry.path}
                    loadingPaths={loadingPaths}
                    onSelectFile={selectFile}
                    onToggleSubtree={(path, collapse) => void toggleDirectorySubtree(path, collapse)}
                    onToggleDirectory={(path) => void toggleDirectory(path)}
                    keyboardActivePath={keyboardActivePath}
                    selectedPath={effectiveSelectedPath}
                    subtreeBusyPaths={subtreeBusyPaths}
                    sessionId={sessionId}
                    workspaceId={workspaceId}
                    workspaceRoot={workspaceRoot}
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

function isFileFilterShortcut(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.defaultPrevented || event.altKey || event.shiftKey) {
    return false;
  }
  return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f";
}

function shouldFocusFileFilterForSource(panel: HTMLElement | null, sourceTarget: EventTarget | null): boolean {
  if (!panel) {
    return false;
  }
  if (sourceTarget instanceof Node) {
    return panel.contains(sourceTarget);
  }
  const activeElement = document.activeElement;
  return activeElement instanceof Node && panel.contains(activeElement);
}

function flattenVisibleTreeEntries(
  rootEntries: WorkspaceEntry[],
  entriesByPath: EntryMap,
  expandedPaths: Set<string>,
): KeyboardTreeEntry[] {
  const entries: KeyboardTreeEntry[] = [];
  const visit = (entry: WorkspaceEntry) => {
    entries.push({ path: entry.path, type: entry.type });
    if (entry.type !== "directory" || !expandedPaths.has(entry.path)) {
      return;
    }
    for (const child of entriesByPath[entry.path] ?? []) {
      visit(child);
    }
  };
  rootEntries.forEach(visit);
  return entries;
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
  bulkExpandedSubtreePaths: Set<string>;
  entry: WorkspaceEntry;
  errorsByPath: ErrorMap;
  expandedPaths: Set<string>;
  filterQuery: string;
  fullyExpandedSubtreePaths: Set<string>;
  loadingPaths: Set<string>;
  onSelectFile: (path: string) => void;
  onToggleSubtree: (path: string, collapse: boolean) => void;
  onToggleDirectory: (path: string) => void;
  keyboardActivePath: string | null;
  selectedPath: string | null;
  sessionId?: string;
  subtreeBusyPaths: Set<string>;
  workspaceId?: string;
  workspaceRoot: string;
  depth?: number;
}

const TreeNode = memo(function TreeNode({
  entriesByPath,
  bulkExpandedSubtreePaths,
  entry,
  errorsByPath,
  expandedPaths,
  filterQuery,
  fullyExpandedSubtreePaths,
  loadingPaths,
  onSelectFile,
  onToggleSubtree,
  onToggleDirectory,
  keyboardActivePath,
  selectedPath,
  sessionId,
  subtreeBusyPaths,
  workspaceId,
  workspaceRoot,
  depth = 0,
}: TreeNodeProps) {
  const isDirectory = entry.type === "directory";
  const loading = loadingPaths.has(entry.path);
  const subtreeBusy = subtreeBusyPaths.has(entry.path);
  const children = useMemo(
    () => filterEntries(entriesByPath[entry.path] ?? [], entriesByPath, filterQuery),
    [entriesByPath, entry.path, filterQuery],
  );
  const expanded = expandedPaths.has(entry.path) || (Boolean(filterQuery) && children.length > 0);
  const subtreeExpanded = bulkExpandedSubtreePaths.has(entry.path) || fullyExpandedSubtreePaths.has(entry.path);
  const error = errorsByPath[entry.path];
  const paddingLeft = 8 + depth * 14;

  return (
    <div className={styles.node} role="treeitem" aria-expanded={isDirectory ? expanded : undefined}>
      {isDirectory ? (
        <div className={styles.directoryRow}>
          <button
            aria-label={`${expanded ? "折叠" : "展开"} ${entry.name}`}
            className={styles.nodeButton}
            data-entry-path={entry.path}
            data-keyboard-active={keyboardActivePath === entry.path ? "true" : undefined}
            data-workspace-entry-absolute-path={workspaceAbsolutePath(workspaceRoot, entry.path)}
            data-workspace-entry-kind="directory"
            data-workspace-entry-name={entry.name}
            data-workspace-entry-path={entry.path}
            data-workspace-id={workspaceId}
            data-workspace-root={workspaceRoot}
            data-workspace-session-id={sessionId}
            onClick={() => onToggleDirectory(entry.path)}
            style={{ paddingLeft }}
            type="button"
          >
            <ChevronRight className={styles.chevron} data-expanded={expanded ? "true" : "false"} size={14} />
            <MaterialEntryIcon path={entry.path || entry.name} type="directory" />
            <EllipsizedEntryName name={entry.name} />
            {loading ? <em>读取中</em> : null}
          </button>
          <button
            aria-label={`${subtreeBusy ? "正在展开" : subtreeExpanded ? "收起" : "展开"} ${entry.name} 的目录树`}
            className={styles.subtreeToggleButton}
            disabled={subtreeBusy}
            onClick={() => onToggleSubtree(entry.path, subtreeExpanded)}
            title={subtreeExpanded ? "收起目录树" : "展开目录树"}
            type="button"
          >
            {subtreeExpanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
          </button>
        </div>
      ) : (
        <button
          aria-label={`选择文件 ${entry.path}`}
          className={styles.nodeButton}
          data-selected={selectedPath === entry.path ? "true" : "false"}
          data-entry-path={entry.path}
          data-keyboard-active={keyboardActivePath === entry.path ? "true" : undefined}
          data-workspace-entry-absolute-path={workspaceAbsolutePath(workspaceRoot, entry.path)}
          data-workspace-entry-kind="file"
          data-workspace-entry-name={entry.name}
          data-workspace-entry-path={entry.path}
          data-workspace-id={workspaceId}
          data-workspace-root={workspaceRoot}
          data-workspace-session-id={sessionId}
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
              bulkExpandedSubtreePaths={bulkExpandedSubtreePaths}
              entry={child}
              errorsByPath={errorsByPath}
              expandedPaths={expandedPaths}
              filterQuery={filterQuery}
              fullyExpandedSubtreePaths={fullyExpandedSubtreePaths}
              key={child.path}
              loadingPaths={loadingPaths}
              onSelectFile={onSelectFile}
              onToggleSubtree={onToggleSubtree}
              onToggleDirectory={onToggleDirectory}
              keyboardActivePath={keyboardActivePath}
              selectedPath={selectedPath}
              subtreeBusyPaths={subtreeBusyPaths}
              sessionId={sessionId}
              workspaceId={workspaceId}
              workspaceRoot={workspaceRoot}
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
    previous.bulkExpandedSubtreePaths !== next.bulkExpandedSubtreePaths ||
    previous.errorsByPath !== next.errorsByPath ||
    previous.expandedPaths !== next.expandedPaths ||
    previous.filterQuery !== next.filterQuery ||
    previous.fullyExpandedSubtreePaths !== next.fullyExpandedSubtreePaths ||
    previous.loadingPaths !== next.loadingPaths ||
    previous.onSelectFile !== next.onSelectFile ||
    previous.onToggleSubtree !== next.onToggleSubtree ||
    previous.onToggleDirectory !== next.onToggleDirectory ||
    previous.keyboardActivePath !== next.keyboardActivePath ||
    previous.sessionId !== next.sessionId ||
    previous.subtreeBusyPaths !== next.subtreeBusyPaths ||
    previous.workspaceId !== next.workspaceId ||
    previous.workspaceRoot !== next.workspaceRoot ||
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

function loadedDirectorySubtreePaths(path: string, entriesByPath: EntryMap): string[] {
  const paths = [path];
  const visit = (directoryPath: string) => {
    for (const child of entriesByPath[directoryPath] ?? []) {
      if (child.type !== "directory") {
        continue;
      }
      paths.push(child.path);
      visit(child.path);
    }
  };
  visit(path);
  return paths;
}

function collectFullyExpandedDirectoryPaths(entriesByPath: EntryMap, expandedPaths: Set<string>): Set<string> {
  const result = new Set<string>();
  const visiting = new Set<string>();
  const directoryPaths = new Set(Object.keys(entriesByPath));

  const visit = (path: string): boolean => {
    if (result.has(path)) {
      return true;
    }
    if (!directoryPaths.has(path) || !expandedPaths.has(path) || visiting.has(path)) {
      return false;
    }
    visiting.add(path);
    const childDirectories = (entriesByPath[path] ?? [])
      .filter((entry) => entry.type === "directory")
      .map((entry) => entry.path);
    const expanded = childDirectories.every((childPath) => directoryPaths.has(childPath) && visit(childPath));
    visiting.delete(path);
    if (expanded) {
      result.add(path);
    }
    return expanded;
  };

  directoryPaths.forEach((path) => {
    void visit(path);
  });
  return result;
}

const SearchResultNode = memo(function SearchResultNode({
  entry,
  onOpenDirectory,
  onSelectFile,
  keyboardActivePath,
  selectedPath,
  sessionId,
  workspaceId,
  workspaceRoot,
}: {
  entry: WorkspaceSearchResult;
  onOpenDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
  keyboardActivePath: string | null;
  selectedPath: string | null;
  sessionId?: string;
  workspaceId?: string;
  workspaceRoot: string;
}) {
  const isDirectory = entry.type === "directory";
  const sizeLabel = !isDirectory && typeof entry.size === "number" ? formatSize(entry.size) : null;

  return (
    <div className={styles.node} role="treeitem" aria-expanded={isDirectory ? false : undefined}>
      <button
        aria-label={isDirectory ? `打开目录 ${entry.path}` : `选择文件 ${entry.path}`}
        className={styles.nodeButton}
        data-selected={!isDirectory && selectedPath === entry.path ? "true" : "false"}
        data-entry-path={entry.path}
        data-keyboard-active={keyboardActivePath === entry.path ? "true" : undefined}
        data-workspace-entry-absolute-path={workspaceAbsolutePath(workspaceRoot, entry.path)}
        data-workspace-entry-kind={entry.type}
        data-workspace-entry-name={entry.name}
        data-workspace-entry-path={entry.path}
        data-workspace-id={workspaceId}
        data-workspace-root={workspaceRoot}
        data-workspace-session-id={sessionId}
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
        <em className={styles.searchResultPath} title={entry.path}>{entry.path}</em>
        {sizeLabel ? <em className={styles.searchResultSize}>{sizeLabel}</em> : null}
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

function sortEntryMap(entriesByPath: EntryMap): EntryMap {
  return Object.fromEntries(
    Object.entries(entriesByPath).map(([path, entries]) => [path, sortEntries(entries)]),
  );
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

function removeManyFromSet(values: Set<string>, items: Iterable<string>): Set<string> {
  const next = new Set(values);
  for (const item of items) {
    next.delete(item);
  }
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

function workspaceAbsolutePath(root: string, path: string): string {
  const cleanedRoot = root.trim();
  const cleanedPath = path.replace(/^[/\\]+/, "");
  if (!cleanedRoot) {
    return cleanedPath;
  }
  const separator = cleanedRoot.includes("\\") ? "\\" : "/";
  const normalizedPath =
    separator === "\\" ? cleanedPath.replace(/\//g, "\\") : cleanedPath.replace(/\\/g, "/");
  const normalizedRoot = cleanedRoot.replace(/[\\/]+$/, "");
  return normalizedPath ? `${normalizedRoot}${separator}${normalizedPath}` : normalizedRoot;
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
