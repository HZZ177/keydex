import {
  Archive,
  Check,
  ChevronDown,
  Download,
  Folder,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  MessageCircle,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  ShieldCheck,
  SquarePen,
  Sun,
  X,
} from "lucide-react";
import { motion } from "motion/react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, SetStateAction } from "react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  createLifecycleRequestId,
  decodeLifecycleRuntimeError,
  runtimeBridge,
  type LifecycleRuntimeError,
  type RuntimeBridge,
} from "@/runtime";
import { AppDialog, ConfirmDialog, DialogButton } from "@/renderer/components/dialog";
import type { AppMode } from "@/renderer/components/layout/appMode";
import { LoadingSkeleton } from "@/renderer/components/loading";
import { SessionActionMenuItems } from "@/renderer/components/session/SessionActionMenuItems";
import { AppTooltipLayer } from "@/renderer/components/tooltip";
import {
  emitSessionCreated,
  emitSessionUpdated,
  subscribeSessionCreated,
  subscribeSessionUpdated,
  type AgentSessionUpdate,
} from "@/renderer/events/sessionEvents";
import {
  createLifecycleEventGate,
  emitLifecycleEvent,
  getLifecycleEventRevision,
  subscribeLifecycleEvents,
} from "@/renderer/events/lifecycleEvents";
import { useOptionalAgentSessionRuntime } from "@/renderer/providers/AgentSessionProvider";
import { useGitCheckoutIndicator } from "@/renderer/features/git/useGitCheckoutIndicator";
import { useOptionalAppUpdate } from "@/renderer/providers/AppUpdateController";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";
import { useTheme } from "@/renderer/providers/ThemeProvider";
import { prefersReducedMotion } from "@/renderer/utils/motionPreference";
import {
  buildSessionMarkdown,
  createSessionMarkdownFilename,
  saveSessionMarkdownFile,
} from "@/renderer/utils/sessionMarkdownExport";
import type { AgentSession } from "@/types/protocol";

import styles from "./Sider.module.css";

export interface SiderEntry {
  id: string;
  title: string;
  updatedAt?: string;
  pinnedAt?: string;
  groupTitle?: string;
  rootPath?: string;
  forked?: boolean;
}

interface SiderGroup {
  id: string;
  title: string;
  kind: "workspace" | "chat" | "pinned";
  items: SiderEntry[];
  latestUpdatedAt?: string;
  workspaceId?: string;
  rootPath?: string;
}

interface SessionIndicator {
  isStreaming: boolean;
  hasUnread: boolean;
  waitingApproval: boolean;
  waitingInteraction: boolean;
}

const EMPTY_SESSION_INDICATOR: SessionIndicator = {
  isStreaming: false,
  hasUnread: false,
  waitingApproval: false,
  waitingInteraction: false,
};

const WORKSPACE_SESSION_PREVIEW_LIMIT = 5;
const WORKSPACE_SESSION_EXPAND_STEP = 10;
const WORKSPACE_SESSION_HISTORY_PAGE_SIZE = 50;
const SESSION_ACTION_MENU_WIDTH = 112;
const SESSION_ACTION_MENU_HEIGHT = 132;
const SESSION_CONTEXT_ACTION_MENU_HEIGHT = 166;
const SESSION_ACTION_MENU_GAP = 10;
const SESSION_ACTION_MENU_EDGE = 8;
const SESSION_ACTION_MENU_CLOSE_MS = 120;
const PROJECT_ACTION_MENU_ID = "__project_actions__";
const PROJECT_CONTEXT_ACTION_MENU_HEIGHT = 108;
interface SessionHistoryCacheEntry {
  sessions: AgentSession[];
  lifecycleRevision: number;
}

interface WorkspaceSessionHistoryState {
  nextPage: number;
  total: number | null;
  exhausted: boolean;
}

const sessionHistoryCacheByRuntime = new WeakMap<RuntimeBridge, SessionHistoryCacheEntry>();

export interface SiderProps {
  collapsed?: boolean;
  appMode?: AppMode;
  projects?: SiderEntry[];
  conversations?: SiderEntry[];
  runtime?: RuntimeBridge;
  activePath?: string;
  showChatBucket?: boolean;
  newConversationPath?: string;
  archiveActiveFallbackPath?: string;
  workspaceArchiveFallbackPath?: string;
  getSessionPath?: (sessionId: string) => string;
  getWorkspaceNewConversationPath?: (workspaceId?: string) => string;
  gitActive?: boolean;
  gitEnabled?: boolean;
  onToggleSidebar?: () => void;
  onOpenGit?: () => void;
  onNavigate?: (path: string) => void;
}

export function Sider({
  collapsed = false,
  appMode = "agent",
  projects = [],
  conversations,
  runtime = runtimeBridge,
  activePath = "",
  showChatBucket = true,
  newConversationPath = newPromptConversationPath(),
  archiveActiveFallbackPath = "/guid",
  workspaceArchiveFallbackPath = archiveActiveFallbackPath,
  getSessionPath = conversationPath,
  getWorkspaceNewConversationPath = newWorkspaceConversationPath,
  gitActive = false,
  gitEnabled = false,
  onToggleSidebar,
  onOpenGit,
  onNavigate,
}: SiderProps) {
  const { theme, toggleTheme } = useTheme();
  const notifications = useNotifications();
  const appUpdate = useOptionalAppUpdate();
  const gitCheckoutPhase = useGitCheckoutIndicator();
  const optionalAgentRuntime = useOptionalAgentSessionRuntime();
  const runtimeConnection = useOptionalRuntimeConnection();
  const backendReady = runtimeConnection?.ready ?? true;
  const backendError = runtimeConnection?.status === "error";
  const sharedSessionState =
    optionalAgentRuntime?.runtime === runtime ? optionalAgentRuntime.state.sessionStateById : {};
  const ThemeIcon = theme === "dark" ? Sun : Moon;
  const controlled = conversations !== undefined;
  const cachedSessions = controlled ? null : readSessionHistoryCache(runtime);
  const [loadedSessions, setLoadedSessions] = useState<AgentSession[]>(() => cachedSessions ?? []);
  const loadedSessionsRef = useRef(loadedSessions);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(
    () => !controlled && cachedSessions === null && backendReady && !backendError,
  );
  const [loadingWorkspaceHistoryIds, setLoadingWorkspaceHistoryIds] = useState<Set<string>>(() => new Set());
  const [exhaustedWorkspaceHistoryIds, setExhaustedWorkspaceHistoryIds] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [editingWorkspace, setEditingWorkspace] = useState<{ id: string; title: string } | null>(null);
  const [archivingSessionId, setArchivingSessionId] = useState<string | null>(null);
  const [archiveConfirmation, setArchiveConfirmation] = useState<{
    item: SiderEntry;
    error: LifecycleRuntimeError;
  } | null>(null);
  const [forkingSessionId, setForkingSessionId] = useState<string | null>(null);
  const [exportingSessionId, setExportingSessionId] = useState<string | null>(null);
  const [archivingWorkspaceId, setArchivingWorkspaceId] = useState<string | null>(null);
  const [workspaceArchiveTarget, setWorkspaceArchiveTarget] = useState<{ id: string; title: string } | null>(null);
  const [workspaceArchiveBlocker, setWorkspaceArchiveBlocker] = useState<LifecycleRuntimeError | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const lifecycleEventGateRef = useRef(createLifecycleEventGate());
  const lifecycleEntityStateRef = useRef(new Map<string, string>());
  const workspaceSessionHistoryByIdRef = useRef<Map<string, WorkspaceSessionHistoryState>>(new Map());
  const [showFooterFeather, setShowFooterFeather] = useState(false);
  const canMutateConversations =
    typeof runtime.conversation.updateSession === "function" && typeof runtime.conversation.archiveSession === "function";
  const canForkConversations =
    typeof runtime.conversation.loadHistory === "function" && typeof runtime.conversation.forkSession === "function";
  const canExportConversations = typeof runtime.conversation.loadHistory === "function";
  const canManageWorkspaces = appMode === "agent"
    && typeof runtime.workspaces?.update === "function"
    && typeof runtime.workspaces?.archive === "function";

  const loadedGroups = useMemo(() => buildSessionGroups(loadedSessions), [loadedSessions]);
  const loadedPinnedItems = useMemo(() => buildPinnedEntries(loadedSessions), [loadedSessions]);
  const historyGroups = useMemo(
    () => (conversations ? buildControlledGroups(projects, conversations) : loadedGroups),
    [conversations, loadedGroups, projects],
  );
  const pinnedItems = useMemo(
    () => (conversations ? buildControlledPinnedEntries(projects, conversations) : loadedPinnedItems),
    [conversations, loadedPinnedItems, projects],
  );
  const displayHistoryGroups = useMemo(() => withoutPinnedItems(historyGroups), [historyGroups]);
  const historyEmptyText = useMemo(() => {
    if (controlled) {
      return "暂无会话";
    }
    if (backendError) {
      return "本地服务连接失败";
    }
    if (!backendReady || loadingHistory) {
      return "";
    }
    return "暂无会话";
  }, [backendError, backendReady, controlled, loadingHistory]);
  const historyEmptyLoading = !controlled && !backendError && (!backendReady || loadingHistory);
  const workspaceGroups = useMemo(
    () => displayHistoryGroups.filter((group) => group.kind === "workspace"),
    [displayHistoryGroups],
  );
  const chatGroup = useMemo(
    () => displayHistoryGroups.find((group) => group.kind === "chat") ?? null,
    [displayHistoryGroups],
  );
  const chatItems = chatGroup?.items ?? [];
  const firstWorkspaceId = workspaceGroups.find((group) => group.workspaceId)?.workspaceId ?? projects[0]?.id;
  const workbenchGroup = workspaceGroups[0] ?? {
    id: "workbench:empty",
    title: projects[0]?.title ?? "工作台会话",
    kind: "workspace" as const,
    items: [],
    workspaceId: projects[0]?.id,
  };
  const historyItems = useMemo(
    () => [...pinnedItems, ...displayHistoryGroups.flatMap((group) => group.items)],
    [displayHistoryGroups, pinnedItems],
  );
  const showInitialHistorySkeleton = historyEmptyLoading && !collapsed && historyItems.length === 0;
  const searchResults = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return historyItems;
    }
    return historyItems.filter((item) => `${item.title} ${item.id}`.toLowerCase().includes(keyword));
  }, [historyItems, query]);
  const sessionIndicators = useMemo<Record<string, SessionIndicator>>(() => {
    return Object.fromEntries(
      Object.entries(sharedSessionState).map(([sessionId, state]) => {
        const waitingApproval =
          state.runtimeState === "waiting_approval"
          || Boolean(state.pendingApproval);
        const waitingInteraction = !waitingApproval && state.runtimeState === "waiting_input";
        const isStreaming =
          !waitingApproval
          && !waitingInteraction
          && (state.runtimeState === "running" || state.runtimeState === "cancelling" || state.isStreaming);
        return [
          sessionId,
          {
            isStreaming,
            waitingApproval,
            waitingInteraction,
            hasUnread:
              state.hasUnread
              && !isStreaming
              && !waitingApproval
              && !waitingInteraction
              && !isActivePath(activePath, getSessionPath(sessionId)),
          },
        ];
      }),
    );
  }, [activePath, getSessionPath, sharedSessionState]);

  const mainEntries = useMemo(
    () => [
      { key: "quick-chat", label: "新对话", path: newConversationPath, icon: SquarePen },
      { key: "search", label: "搜索", path: "/search", icon: Search },
    ],
    [newConversationPath],
  );

  const navigateTo = (path: string) => {
    setSearchOpen(false);
    onNavigate?.(path);
  };

  const setLoadedSessionsAndCache = useCallback(
    (nextValue: SetStateAction<AgentSession[]>) => {
      setLoadedSessions((current) => {
        const next =
          typeof nextValue === "function" ? (nextValue as (items: AgentSession[]) => AgentSession[])(current) : nextValue;
        loadedSessionsRef.current = next;
        writeSessionHistoryCache(runtime, next);
        return next;
      });
    },
    [runtime],
  );

  useEffect(() => {
    loadedSessionsRef.current = loadedSessions;
  }, [loadedSessions]);

  useEffect(() => {
    if (controlled) {
      return;
    }
    const cached = readSessionHistoryCache(runtime);
    if (cached !== null) {
      setLoadedSessions(cached);
      setLoadingHistory(false);
      return;
    }
    setLoadedSessions([]);
  }, [controlled, runtime]);

  const updateFooterFeather = useCallback(() => {
    const history = historyRef.current;
    if (!history) {
      setShowFooterFeather(false);
      return;
    }
    const hasContentBelow = history.scrollHeight - history.scrollTop - history.clientHeight > 2;
    setShowFooterFeather((current) => (current === hasContentBelow ? current : hasContentBelow));
  }, []);

  useLayoutEffect(() => {
    updateFooterFeather();
    const history = historyRef.current;
    if (!history) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(updateFooterFeather);
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(updateFooterFeather);
      resizeObserver.observe(history);
      Array.from(history.children).forEach((child) => resizeObserver?.observe(child));
    }

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
    };
  }, [archivingSessionId, collapsed, editing, historyGroups, loadingHistory, updateFooterFeather]);

  const reloadSessions = useCallback(
    async (isActive: () => boolean = () => true, options: { force?: boolean } = {}) => {
      if (controlled) {
        window.location.reload();
        return;
      }
      const cachedAtStart = readSessionHistoryCache(runtime);
      const cacheWasCurrentAtStart = isSessionHistoryCacheCurrent(runtime);
      if (!options.force && cachedAtStart !== null && cacheWasCurrentAtStart) {
        setLoadingHistory(false);
        return;
      }
      if (!backendReady) {
        setLoadingHistory(false);
        return;
      }
      setLoadingHistory(true);
      try {
        const response = await runtime.conversation.listSessions({ pageSize: 50 });
        if (isActive()) {
          if (options.force || !cacheWasCurrentAtStart) {
            workspaceSessionHistoryByIdRef.current.clear();
            setExhaustedWorkspaceHistoryIds(new Set());
          }
          const sessionsCreatedDuringLoad = options.force || (cachedAtStart !== null && !cacheWasCurrentAtStart)
            ? null
            : readSessionHistoryCache(runtime);
          setLoadedSessionsAndCache(
            sessionsCreatedDuringLoad === null ? response.list : mergeSessions(response.list, sessionsCreatedDuringLoad),
          );
        }
      } catch (reason) {
        if (isActive()) {
          notifications.error(errorMessage(reason));
        }
      } finally {
        if (isActive()) {
          setLoadingHistory(false);
        }
      }
    },
    [backendReady, controlled, notifications, runtime, setLoadedSessionsAndCache],
  );

  useEffect(() => {
    if (controlled) {
      return;
    }
    let active = true;
    void reloadSessions(() => active);
    return () => {
      active = false;
    };
  }, [reloadSessions]);

  const refreshSessionList = useCallback(() => {
    void reloadSessions(undefined, { force: true });
  }, [reloadSessions]);

  useEffect(() => {
    if (controlled) {
      return;
    }
    return subscribeSessionCreated((session) => {
      setLoadedSessionsAndCache((items) => upsertSession(items, session));
    });
  }, [controlled, setLoadedSessionsAndCache]);

  useEffect(() => {
    if (controlled) {
      return;
    }
    return subscribeLifecycleEvents((event) => {
      if (!lifecycleEventGateRef.current(event)) {
        return;
      }
      const entityId = event.session_id ?? event.workspace_id;
      const entityKey = entityId ? `${event.session_id ? "session" : "workspace"}:${entityId}` : null;
      const eventToken = `${event.operation_id ?? ""}:${event.revision ?? 0}:${event.occurred_at ?? ""}:${event.type}`;
      if (entityKey) lifecycleEntityStateRef.current.set(entityKey, eventToken);
      if ((event.type === "session_archived" || event.type === "session_purged") && event.session_id) {
        const archived = loadedSessions.find((item) => item.id === event.session_id);
        if (isActivePath(activePath, getSessionPath(event.session_id))) {
          const fallback = loadedSessions.find(
            (item) => item.id !== event.session_id && item.workspace_id === archived?.workspace_id,
          );
          onNavigate?.(fallback ? getSessionPath(fallback.id) : archiveActiveFallbackPath);
        }
        setLoadedSessionsAndCache((items) => items.filter((item) => item.id !== event.session_id));
        return;
      }
      if ((event.type === "workspace_archived" || event.type === "workspace_purged") && event.workspace_id) {
        const activeSession = loadedSessions.find(
          (item) => item.workspace_id === event.workspace_id && isActivePath(activePath, getSessionPath(item.id)),
        );
        if (activeSession) {
          onNavigate?.(workspaceArchiveFallbackPath);
        }
        setLoadedSessionsAndCache((items) => items.filter((item) => item.workspace_id !== event.workspace_id));
        return;
      }
      if (event.type === "session_restored" && event.session_id) {
        const restoredEntityKey = entityKey;
        void runtime.conversation.getSession(event.session_id).then(
          (session) => {
            if (restoredEntityKey && lifecycleEntityStateRef.current.get(restoredEntityKey) === eventToken) {
              setLoadedSessionsAndCache((items) => upsertSession(items, session));
            }
          },
          () => undefined,
        );
        return;
      }
      if (event.type === "workspace_restored" && event.workspace_id) {
        void reloadSessions(undefined, { force: true });
      }
    });
  }, [
    activePath,
    archiveActiveFallbackPath,
    controlled,
    getSessionPath,
    loadedSessions,
    onNavigate,
    runtime,
    reloadSessions,
    setLoadedSessionsAndCache,
    workspaceArchiveFallbackPath,
  ]);

  useEffect(() => {
    if (controlled) {
      return;
    }
    return subscribeSessionUpdated((session) => {
      setLoadedSessionsAndCache((items) => mergeSessionUpdate(items, session));
    });
  }, [controlled, setLoadedSessionsAndCache]);

  async function renameConversation(id: string, title: string) {
    const cleaned = title.trim();
    if (!cleaned) {
      notifications.warning("会话标题不能为空");
      return;
    }
    if (!canMutateConversations) {
      notifications.warning("当前后端不支持重命名会话");
      return;
    }
    try {
      const updated = await runtime.conversation.updateSession(id, { title: cleaned });
      setLoadedSessionsAndCache((items) => upsertSession(items, updated));
      emitSessionUpdated(updated);
      setEditing(null);
      notifications.success("已重命名会话");
    } catch (reason) {
      notifications.error(errorMessage(reason));
    }
  }

  function startRenameConversation(item: SiderEntry) {
    setSearchOpen(false);
    setArchiveConfirmation(null);
    setEditing({ id: item.id, title: item.title });
  }

  async function renameWorkspace(id: string, title: string) {
    const cleaned = title.trim();
    if (!cleaned) {
      notifications.warning("项目名称不能为空");
      return;
    }
    if (!canManageWorkspaces) {
      notifications.warning("当前环境不支持管理项目");
      return;
    }
    try {
      const updated = await runtime.workspaces.update(id, { name: cleaned });
      setLoadedSessionsAndCache((items) => items.map((session) => {
        if (session.workspace_id !== id || !session.workspace) return session;
        return { ...session, workspace: { ...session.workspace, name: updated.name } };
      }));
      setEditingWorkspace(null);
      notifications.success("项目已重命名");
    } catch (reason) {
      notifications.error(errorMessage(reason));
    }
  }

  function startRenameWorkspace(id: string, title: string) {
    setSearchOpen(false);
    setEditing(null);
    setEditingWorkspace({ id, title });
  }

  async function revealWorkspace(rootPath?: string) {
    if (!rootPath) {
      notifications.warning("当前项目没有可用的本地目录");
      return;
    }
    try {
      await runtime.desktopPicker.revealPath(rootPath);
    } catch (reason) {
      notifications.error(errorMessage(reason));
    }
  }

  async function archiveWorkspace(stopActiveSessions: boolean) {
    if (!workspaceArchiveTarget || archivingWorkspaceId || !canManageWorkspaces) return;
    setArchivingWorkspaceId(workspaceArchiveTarget.id);
    try {
      const result = await runtime.workspaces.archive(workspaceArchiveTarget.id, {
        requestId: createLifecycleRequestId("workspace-archive"),
        stopActiveSessions,
      });
      if (result.event) emitLifecycleEvent(result.event);
      const archivedWorkspaceId = workspaceArchiveTarget.id;
      const activeWorkspaceSession = loadedSessions.some(
        (session) => session.workspace_id === archivedWorkspaceId && isActivePath(activePath, getSessionPath(session.id)),
      );
      setLoadedSessionsAndCache((items) => items.filter((session) => session.workspace_id !== archivedWorkspaceId));
      if (activeWorkspaceSession) onNavigate?.(workspaceArchiveFallbackPath);
      setWorkspaceArchiveTarget(null);
      setWorkspaceArchiveBlocker(null);
      notifications.success(`项目已归档，随项目归档 ${result.newly_archived} 个会话`, {
        actionLabel: "查看归档",
        onAction: () => onNavigate?.("/settings/archive"),
      });
    } catch (reason) {
      const decoded = decodeLifecycleRuntimeError(reason);
      if (decoded?.kind === "archive_requires_stop_confirmation") setWorkspaceArchiveBlocker(decoded);
      else notifications.error(errorMessage(reason));
    } finally {
      setArchivingWorkspaceId(null);
    }
  }

  const restoreArchivedConversation = useCallback(async (item: SiderEntry) => {
    try {
      const result = await runtime.conversation.restoreSession(item.id, {
        requestId: createLifecycleRequestId("session-undo"),
      });
      if (result.event) {
        emitLifecycleEvent(result.event);
      }
      const restored = await runtime.conversation.getSession(item.id);
      setLoadedSessionsAndCache((items) => upsertSession(items, restored));
      notifications.success("已恢复会话");
    } catch (reason) {
      const decoded = decodeLifecycleRuntimeError(reason);
      notifications.error(
        decoded?.kind === "workspace_archived" ? "当前所属项目已归档，请先恢复项目" : errorMessage(reason),
        decoded?.kind === "workspace_archived"
          ? { actionLabel: "打开归档管理", onAction: () => onNavigate?.("/settings/archive") }
          : undefined,
      );
    }
  }, [notifications, onNavigate, runtime, setLoadedSessionsAndCache]);

  const archiveConversation = useCallback(async (item: SiderEntry, stopIfActive = false) => {
    if (!canMutateConversations || archivingSessionId) {
      return;
    }
    const snapshot = loadedSessions.find((session) => session.id === item.id) ?? null;
    const sameGroupFallback = historyItems.find(
      (candidate) => candidate.id !== item.id && candidate.groupTitle === item.groupTitle,
    );
    setSearchOpen(false);
    setEditing(null);
    setArchiveConfirmation(null);
    setArchivingSessionId(item.id);
    setLoadedSessionsAndCache((items) => items.filter((session) => session.id !== item.id));
    try {
      const result = await runtime.conversation.archiveSession(item.id, {
        requestId: createLifecycleRequestId("session-archive"),
        stopIfActive,
      });
      if (result.event) {
        emitLifecycleEvent(result.event);
      }
      if (isActivePath(activePath, getSessionPath(item.id))) {
        onNavigate?.(sameGroupFallback ? getSessionPath(sameGroupFallback.id) : archiveActiveFallbackPath);
      }
      notifications.success("已归档", {
        durationMs: 6000,
        actionLabel: "撤销",
        onAction: () => restoreArchivedConversation(item),
      });
    } catch (reason) {
      if (snapshot) {
        setLoadedSessionsAndCache((items) => upsertSession(items, snapshot));
      }
      const decoded = decodeLifecycleRuntimeError(reason);
      if (decoded?.kind === "archive_requires_stop_confirmation") {
        setArchiveConfirmation({ item, error: decoded });
      } else {
        notifications.error(errorMessage(reason));
      }
    } finally {
      setArchivingSessionId(null);
    }
  }, [
    activePath,
    archiveActiveFallbackPath,
    archivingSessionId,
    canMutateConversations,
    getSessionPath,
    historyItems,
    loadedSessions,
    notifications,
    onNavigate,
    restoreArchivedConversation,
    runtime,
    setLoadedSessionsAndCache,
  ]);

  async function togglePinnedConversation(item: SiderEntry, pinned: boolean) {
    if (!canMutateConversations) {
      notifications.warning("当前后端不支持置顶会话");
      return;
    }
    try {
      const updated = await runtime.conversation.updateSession(item.id, { pinned });
      setLoadedSessionsAndCache((items) => upsertSession(items, updated));
      emitSessionUpdated(updated);
      notifications.success(pinned ? "已置顶会话" : "已取消置顶");
    } catch (reason) {
      notifications.error(errorMessage(reason));
    }
  }

  async function forkConversationFromLatestCheckpoint(item: SiderEntry) {
    if (!canForkConversations) {
      notifications.warning("当前后端不支持派生会话");
      return;
    }
    if (forkingSessionId) {
      return;
    }
    setSearchOpen(false);
    setEditing(null);
    setArchiveConfirmation(null);
    setForkingSessionId(item.id);
    try {
      const response = await runtime.conversation.forkSession(item.id, {});
      setLoadedSessionsAndCache((items) => upsertSession(items, response.session));
      emitSessionCreated(response.session);
      notifications.success("已创建派生会话");
      onNavigate?.(getSessionPath(response.session.id));
    } catch (reason) {
      notifications.error(`派生失败：${errorMessage(reason)}`);
    } finally {
      setForkingSessionId(null);
    }
  }

  async function exportConversation(item: SiderEntry) {
    if (!canExportConversations) {
      notifications.warning("当前后端不支持导出会话记录");
      return;
    }
    if (exportingSessionId) {
      return;
    }
    setExportingSessionId(item.id);
    try {
      const history = await runtime.conversation.loadHistory(item.id, {
        allTurns: true,
        direction: "older",
      });
      const markdown = buildSessionMarkdown(item.title, history.list);
      if (!markdown) {
        notifications.warning("当前会话没有可导出的对话正文");
        return;
      }
      const result = await saveSessionMarkdownFile(
        markdown,
        createSessionMarkdownFilename(item.title),
      );
      if (result !== "cancelled") {
        notifications.success("会话记录已导出");
      }
    } catch (reason) {
      notifications.error(`导出失败：${errorMessage(reason)}`);
    } finally {
      setExportingSessionId(null);
    }
  }

  const loadWorkspaceSessions = useCallback(
    async (workspaceId: string, minimumItemCount: number) => {
      const existingState = workspaceSessionHistoryByIdRef.current.get(workspaceId);
      if (controlled || existingState?.exhausted || loadingWorkspaceHistoryIds.has(workspaceId)) {
        return;
      }
      setLoadingWorkspaceHistoryIds((current) => {
        const next = new Set(current);
        next.add(workspaceId);
        return next;
      });
      const fetchedSessions: AgentSession[] = [];
      let mergedSessions = loadedSessionsRef.current;
      let historyState = existingState ?? { nextPage: 1, total: null, exhausted: false };
      try {
        while (countWorkspaceSessions(mergedSessions, workspaceId) < minimumItemCount && !historyState.exhausted) {
          const page = historyState.nextPage;
          const response = await runtime.conversation.listSessions({
            sessionType: "workspace",
            workspaceId,
            page,
            pageSize: WORKSPACE_SESSION_HISTORY_PAGE_SIZE,
          });
          fetchedSessions.push(...response.list);
          mergedSessions = mergeSessions(mergedSessions, response.list);
          historyState = {
            nextPage: page + 1,
            total: response.total,
            exhausted:
              response.list.length === 0
              || page * response.page_size >= response.total,
          };
          workspaceSessionHistoryByIdRef.current.set(workspaceId, historyState);
        }
      } catch (reason) {
        notifications.error(errorMessage(reason));
      } finally {
        if (fetchedSessions.length > 0) {
          setLoadedSessionsAndCache((items) => mergeSessions(items, fetchedSessions));
        }
        setExhaustedWorkspaceHistoryIds((current) => {
          const next = new Set(current);
          if (historyState.exhausted) {
            next.add(workspaceId);
          } else {
            next.delete(workspaceId);
          }
          return next;
        });
        setLoadingWorkspaceHistoryIds((current) => {
          const next = new Set(current);
          next.delete(workspaceId);
          return next;
        });
      }
    },
    [controlled, loadingWorkspaceHistoryIds, notifications, runtime, setLoadedSessionsAndCache],
  );

  return (
    <aside
      className={styles.sider}
      aria-label="侧边栏"
      data-layout-sidebar="true"
      data-collapsed={collapsed ? "true" : "false"}
      data-footer-feather={showFooterFeather ? "true" : "false"}
    >
      <AppTooltipLayer
        scopeSelector="[data-layout-sidebar='true']"
        defaultPlacement={collapsed ? "right" : "top"}
      />
      <nav className={styles.nav} aria-label="主导航">
        {onToggleSidebar ? (
          <button
            className={styles.navItem}
            data-state={collapsed ? "collapsed" : "expanded"}
            data-icon={collapsed ? "panel-left-open" : "panel-left-close"}
            data-tooltip-label={collapsed ? "展开侧边栏" : undefined}
            type="button"
            aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
            title={collapsed ? "展开侧边栏" : ""}
            onClick={onToggleSidebar}
          >
            {collapsed ? (
              <PanelLeftOpen size={17} strokeWidth={2.1} />
            ) : (
              <PanelLeftClose size={17} strokeWidth={2.1} />
            )}
            <span>{collapsed ? "展开侧边栏" : "折叠侧边栏"}</span>
          </button>
        ) : null}
        {mainEntries.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={styles.navItem}
              type="button"
              key={item.key}
              title={collapsed ? item.label : ""}
              data-tooltip-label={collapsed ? item.label : undefined}
              data-active={!gitActive && isActivePath(activePath, item.path) ? "true" : "false"}
              onClick={() => (item.key === "search" ? setSearchOpen(true) : navigateTo(item.path))}
            >
              <Icon size={17} strokeWidth={2} />
              <span>{item.label}</span>
            </button>
          );
        })}
        <button
          className={styles.navItem}
          type="button"
          title={collapsed ? "Git" : ""}
          data-tooltip-label={collapsed ? "Git" : undefined}
          data-active={gitActive ? "true" : "false"}
          data-system-entry="git"
          aria-pressed={gitActive}
          aria-busy={gitCheckoutPhase === "busy" || undefined}
          disabled={!gitEnabled}
          onClick={onOpenGit}
        >
          {gitCheckoutPhase === "busy" ? (
            <LoaderCircle className={styles.gitLoadingIcon} size={17} aria-hidden="true" />
          ) : gitCheckoutPhase === "success" ? (
            <Check className={styles.gitSuccessIcon} size={17} aria-hidden="true" />
          ) : (
            <GitBranch size={17} />
          )}
          <span>Git</span>
        </button>
      </nav>

      {appMode === "workbench" ? (
        <div className={styles.workbenchHistory} aria-label="工作台会话历史">
          <div
            className={styles.history}
            aria-label="会话历史"
            data-loading={showInitialHistorySkeleton ? "true" : "false"}
            ref={historyRef}
            onScroll={updateFooterFeather}
            onTransitionEnd={updateFooterFeather}
          >
            {showInitialHistorySkeleton ? (
              <div className={styles.historyLoadingState} data-testid="sidebar-session-skeleton-shell">
                <SessionHistorySkeleton />
              </div>
            ) : (
              <>
                <SiderSection
                  title="置顶"
                  kind="pinned"
                  items={pinnedItems}
                  collapsed={collapsed}
                  routeSelectionEnabled={!gitActive}
                  emptyText="暂无置顶"
                  emptyLoading={false}
                  activePath={activePath}
                  editing={editing}
                  archivingSessionId={archivingSessionId}
                  canMutate={canMutateConversations}
                  canFork={canForkConversations}
                  canExport={canExportConversations}
                  forkingSessionId={forkingSessionId}
                  exportingSessionId={exportingSessionId}
                  sessionIndicators={sessionIndicators}
                  historyPreviewLimit={WORKSPACE_SESSION_PREVIEW_LIMIT}
                  getSessionPath={getSessionPath}
                  onArchive={(item) => void archiveConversation(item)}
                  onExportSession={(item) => void exportConversation(item)}
                  onForkSession={(item) => void forkConversationFromLatestCheckpoint(item)}
                  onStartRename={startRenameConversation}
                  onTogglePinned={(item, pinned) => void togglePinnedConversation(item, pinned)}
                  onRefresh={refreshSessionList}
                  onNavigate={navigateTo}
                />
                <SiderSection
                  title={workbenchGroup.title}
                  kind="workspace"
                  items={workbenchGroup.items}
                  collapsed={collapsed}
                  routeSelectionEnabled={!gitActive}
                  emptyText={historyEmptyText}
                  emptyLoading={historyEmptyLoading}
                  activePath={activePath}
                  editing={editing}
                  archivingSessionId={archivingSessionId}
                  canMutate={canMutateConversations}
                  canFork={canForkConversations}
                  canExport={canExportConversations}
                  forkingSessionId={forkingSessionId}
                  exportingSessionId={exportingSessionId}
                  sessionIndicators={sessionIndicators}
                  workspaceId={workbenchGroup.workspaceId}
                  disableSectionToggle
                  flat
                  hideTitle
                  getSessionPath={getSessionPath}
                  onArchive={(item) => void archiveConversation(item)}
                  onExportSession={(item) => void exportConversation(item)}
                  onForkSession={(item) => void forkConversationFromLatestCheckpoint(item)}
                  onStartRename={startRenameConversation}
                  onTogglePinned={(item, pinned) => void togglePinnedConversation(item, pinned)}
                  onRefresh={refreshSessionList}
                  onNavigate={navigateTo}
                />
              </>
            )}
          </div>
        </div>
      ) : (
        <div
          className={styles.history}
          aria-label="会话历史"
          data-loading={showInitialHistorySkeleton ? "true" : "false"}
          ref={historyRef}
          onScroll={updateFooterFeather}
          onTransitionEnd={updateFooterFeather}
        >
          {showInitialHistorySkeleton ? (
            <div className={styles.historyLoadingState} data-testid="sidebar-session-skeleton-shell">
              <SessionHistorySkeleton />
            </div>
          ) : collapsed ? (
            <>
              <SiderSection
                title="置顶"
                kind="pinned"
                items={pinnedItems}
                collapsed={collapsed}
                routeSelectionEnabled={!gitActive}
                emptyText="暂无置顶"
                emptyLoading={false}
                activePath={activePath}
                editing={editing}
                archivingSessionId={archivingSessionId}
                canMutate={canMutateConversations}
                canFork={canForkConversations}
                canExport={canExportConversations}
                forkingSessionId={forkingSessionId}
                exportingSessionId={exportingSessionId}
                sessionIndicators={sessionIndicators}
                getSessionPath={getSessionPath}
                onArchive={(item) => void archiveConversation(item)}
                onExportSession={(item) => void exportConversation(item)}
                onForkSession={(item) => void forkConversationFromLatestCheckpoint(item)}
                onStartRename={startRenameConversation}
                onTogglePinned={(item, pinned) => void togglePinnedConversation(item, pinned)}
                onRefresh={refreshSessionList}
                onNavigate={navigateTo}
              />
              {displayHistoryGroups.length === 0 && pinnedItems.length === 0 ? (
                <SiderSection
                  title="对话"
                  items={[]}
                  collapsed={collapsed}
                  routeSelectionEnabled={!gitActive}
                  emptyText={historyEmptyText}
                  emptyLoading={historyEmptyLoading}
                />
              ) : null}
              {displayHistoryGroups.map((group) => (
                <SiderSection
                  title={group.title}
                  kind={group.kind}
                  items={group.items}
                  collapsed={collapsed}
                  routeSelectionEnabled={!gitActive}
                  emptyText={historyEmptyText}
                  emptyLoading={historyEmptyLoading}
                  activePath={activePath}
                  editing={editing}
                  archivingSessionId={archivingSessionId}
                  canMutate={canMutateConversations}
                  canFork={canForkConversations}
                  canExport={canExportConversations}
                  forkingSessionId={forkingSessionId}
                  exportingSessionId={exportingSessionId}
                  sessionIndicators={sessionIndicators}
                  workspaceId={group.workspaceId}
                  getSessionPath={getSessionPath}
                  getWorkspaceNewConversationPath={getWorkspaceNewConversationPath}
                  historyExpansionLoading={Boolean(group.workspaceId && loadingWorkspaceHistoryIds.has(group.workspaceId))}
                  historyHasMore={Boolean(
                    group.workspaceId && !exhaustedWorkspaceHistoryIds.has(group.workspaceId),
                  )}
                  historyPreviewLimit={WORKSPACE_SESSION_PREVIEW_LIMIT}
                  key={group.id}
                  onLoadHistoryExpansion={
                    group.workspaceId && !controlled
                      ? (minimumItemCount) => loadWorkspaceSessions(group.workspaceId as string, minimumItemCount)
                      : undefined
                  }
                  onArchive={(item) => void archiveConversation(item)}
                  onExportSession={(item) => void exportConversation(item)}
                  onForkSession={(item) => void forkConversationFromLatestCheckpoint(item)}
                  onStartRename={startRenameConversation}
                  onTogglePinned={(item, pinned) => void togglePinnedConversation(item, pinned)}
                  onRefresh={refreshSessionList}
                  onNavigate={navigateTo}
                />
              ))}
            </>
          ) : (
            <>
              <SiderSection
                title="置顶"
                kind="pinned"
                items={pinnedItems}
                collapsed={collapsed}
                routeSelectionEnabled={!gitActive}
                emptyText="暂无置顶"
                emptyLoading={false}
                activePath={activePath}
                editing={editing}
                archivingSessionId={archivingSessionId}
                canMutate={canMutateConversations}
                canFork={canForkConversations}
                canExport={canExportConversations}
                forkingSessionId={forkingSessionId}
                exportingSessionId={exportingSessionId}
                sessionIndicators={sessionIndicators}
                historyPreviewLimit={WORKSPACE_SESSION_PREVIEW_LIMIT}
                getSessionPath={getSessionPath}
                onArchive={(item) => void archiveConversation(item)}
                onExportSession={(item) => void exportConversation(item)}
                onForkSession={(item) => void forkConversationFromLatestCheckpoint(item)}
                onStartRename={startRenameConversation}
                onTogglePinned={(item, pinned) => void togglePinnedConversation(item, pinned)}
                onRefresh={refreshSessionList}
                onNavigate={navigateTo}
              />
              <HistoryBucket
                title="项目"
                kind="workspace"
                active={workspaceGroups.some((group) =>
                  group.items.some((item) => isActivePath(activePath, getSessionPath(item.id))),
                )}
                activePath={activePath}
                newConversationPath={getWorkspaceNewConversationPath(firstWorkspaceId)}
                onNavigate={navigateTo}
              >
                {workspaceGroups.map((group) => (
                  <SiderSection
                    title={group.title}
                    kind={group.kind}
                    items={group.items}
                    collapsed={collapsed}
                    routeSelectionEnabled={!gitActive}
                    emptyText={historyEmptyText}
                    emptyLoading={false}
                    activePath={activePath}
                    editing={editing}
                    archivingSessionId={archivingSessionId}
                    canMutate={canMutateConversations}
                    canFork={canForkConversations}
                    canExport={canExportConversations}
                    forkingSessionId={forkingSessionId}
                    exportingSessionId={exportingSessionId}
                    sessionIndicators={sessionIndicators}
                    workspaceId={group.workspaceId}
                    workspaceRootPath={group.rootPath}
                    canManageWorkspace={canManageWorkspaces}
                    getSessionPath={getSessionPath}
                    getWorkspaceNewConversationPath={getWorkspaceNewConversationPath}
                    historyExpansionLoading={Boolean(
                      group.workspaceId && loadingWorkspaceHistoryIds.has(group.workspaceId),
                    )}
                    historyHasMore={Boolean(
                      group.workspaceId && !exhaustedWorkspaceHistoryIds.has(group.workspaceId),
                    )}
                    historyPreviewLimit={WORKSPACE_SESSION_PREVIEW_LIMIT}
                    key={group.id}
                    onLoadHistoryExpansion={
                      group.workspaceId && !controlled
                        ? (minimumItemCount) => loadWorkspaceSessions(group.workspaceId as string, minimumItemCount)
                        : undefined
                    }
                    onArchive={(item) => void archiveConversation(item)}
                    onExportSession={(item) => void exportConversation(item)}
                    onForkSession={(item) => void forkConversationFromLatestCheckpoint(item)}
                    onStartRename={startRenameConversation}
                    onStartWorkspaceRename={(workspaceId, title) => startRenameWorkspace(workspaceId, title)}
                    onRevealWorkspace={(rootPath) => void revealWorkspace(rootPath)}
                    onArchiveWorkspace={(workspaceId, title) => {
                      setWorkspaceArchiveTarget({ id: workspaceId, title });
                      setWorkspaceArchiveBlocker(null);
                    }}
                    onTogglePinned={(item, pinned) => void togglePinnedConversation(item, pinned)}
                    onRefresh={refreshSessionList}
                    onNavigate={navigateTo}
                  />
                ))}
              </HistoryBucket>
              {showChatBucket ? (
                <HistoryBucket
                  title="对话"
                  kind="chat"
                  active={chatItems.some((item) => isActivePath(activePath, getSessionPath(item.id)))}
                  activePath={activePath}
                  newConversationPath={newChatConversationPath()}
                  onNavigate={navigateTo}
                >
                  <SiderSection
                    title="对话"
                    kind="chat"
                    items={chatItems}
                    collapsed={collapsed}
                    routeSelectionEnabled={!gitActive}
                    emptyText={historyEmptyText}
                    emptyLoading={historyEmptyLoading}
                    activePath={activePath}
                    editing={editing}
                    archivingSessionId={archivingSessionId}
                    canMutate={canMutateConversations}
                    canFork={canForkConversations}
                    canExport={canExportConversations}
                    forkingSessionId={forkingSessionId}
                    exportingSessionId={exportingSessionId}
                    sessionIndicators={sessionIndicators}
                    hideTitle
                    getSessionPath={getSessionPath}
                    onArchive={(item) => void archiveConversation(item)}
                    onExportSession={(item) => void exportConversation(item)}
                    onForkSession={(item) => void forkConversationFromLatestCheckpoint(item)}
                    onStartRename={startRenameConversation}
                    onTogglePinned={(item, pinned) => void togglePinnedConversation(item, pinned)}
                    onRefresh={refreshSessionList}
                    onNavigate={navigateTo}
                  />
                </HistoryBucket>
              ) : null}
            </>
          )}
        </div>
      )}

      <div className={styles.footer}>
        <button
          className={styles.navItem}
          type="button"
          title={collapsed ? "切换主题" : ""}
          aria-label="切换主题"
          data-tooltip-label={collapsed ? "切换主题" : undefined}
          onClick={toggleTheme}
        >
          <ThemeIcon size={17} strokeWidth={2} />
          <span>{theme === "dark" ? "浅色" : "深色"}</span>
        </button>
        <button
          className={styles.navItem}
          type="button"
          title={collapsed ? "设置" : ""}
          aria-label="设置"
          data-tooltip-label={collapsed ? "设置" : undefined}
          data-active={!gitActive && activePath.startsWith("/settings") ? "true" : "false"}
          onClick={() => onNavigate?.("/settings/general")}
        >
          <Settings size={17} strokeWidth={2} />
          <span>设置</span>
          {appUpdate?.pendingUpdate ? (
            <span
              aria-hidden="true"
              className={styles.updateBadge}
              data-app-update-indicator="settings"
            >
              <Download size={10} strokeWidth={2.5} />
            </span>
          ) : null}
        </button>
      </div>

      {searchOpen ? (
        <SessionSearchDialog
          conversations={searchResults}
          getSessionPath={getSessionPath}
          loading={loadingHistory}
          onClose={() => setSearchOpen(false)}
          onNavigate={navigateTo}
          onQueryChange={setQuery}
          query={query}
        />
      ) : null}
      {editing ? (
        <SessionRenameDialog
          editing={editing}
          onCancel={() => setEditing(null)}
          onChange={(title) => setEditing((value) => (value ? { ...value, title } : value))}
          onSubmit={(id, title) => void renameConversation(id, title)}
        />
      ) : null}
      {editingWorkspace ? (
        <WorkspaceRenameDialog
          editing={editingWorkspace}
          onCancel={() => setEditingWorkspace(null)}
          onChange={(title) => setEditingWorkspace((value) => (value ? { ...value, title } : value))}
          onSubmit={(id, title) => void renameWorkspace(id, title)}
        />
      ) : null}
      {archiveConfirmation ? (
        <SessionArchiveConfirmationDialog
          blockerCount={archiveBlockerCount(archiveConfirmation.error)}
          busy={archivingSessionId === archiveConfirmation.item.id}
          title={archiveConfirmation.item.title}
          onCancel={() => setArchiveConfirmation(null)}
          onConfirm={() => void archiveConversation(archiveConfirmation.item, true)}
        />
      ) : null}
      {workspaceArchiveTarget ? (
        <ConfirmDialog
          title={workspaceArchiveBlocker ? "停止会话并归档项目？" : "归档项目？"}
          description={workspaceArchiveBlocker ? "项目中仍有运行、等待、审批、排队输入或任务。确认后会先停止这些活动，再归档项目及其中的会话。" : "项目及其中的会话将移至归档管理。本地目录及文件不会被删除。"}
          preview={workspaceArchiveBlocker ? `${workspaceArchiveTarget.title} · 受影响活动 ${archiveBlockerCount(workspaceArchiveBlocker)} 项` : workspaceArchiveTarget.title}
          confirmLabel={workspaceArchiveBlocker ? "停止会话并归档项目" : "归档项目"}
          cancelDisabled={archivingWorkspaceId === workspaceArchiveTarget.id}
          confirmDisabled={archivingWorkspaceId === workspaceArchiveTarget.id}
          onCancel={() => { setWorkspaceArchiveTarget(null); setWorkspaceArchiveBlocker(null); }}
          onConfirm={() => void archiveWorkspace(Boolean(workspaceArchiveBlocker))}
        />
      ) : null}
    </aside>
  );
}

function SessionHistorySkeleton() {
  return (
    <LoadingSkeleton
      aria-label="正在加载会话"
      className={styles.sessionHistorySkeleton}
      lineCount={8}
      testId="sidebar-session-skeleton"
      width="compact"
    />
  );
}

function SessionSearchDialog({
  conversations,
  getSessionPath,
  loading,
  onClose,
  onNavigate,
  onQueryChange,
  query,
}: {
  conversations: SiderEntry[];
  getSessionPath: (sessionId: string) => string;
  loading: boolean;
  onClose: () => void;
  onNavigate: (path: string) => void;
  onQueryChange: (query: string) => void;
  query: string;
}) {
  const hasQuery = query.trim().length > 0;
  return (
    <AppDialog
      ariaLabel="搜索会话"
      size="search"
      placement="top"
      backdrop="page"
      inset="below-titlebar"
      showClose={false}
      onClose={onClose}
    >
      <header className={styles.searchHeader}>
        <Search size={17} />
        <input
          autoFocus
          aria-label="搜索会话"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索会话或打开新对话"
          value={query}
        />
        <button aria-label="关闭搜索" type="button" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <div className={styles.searchQuickActions}>
        <button type="button" onClick={() => onNavigate(newPromptConversationPath())}>
          <SquarePen size={15} />
          <span>新建对话</span>
        </button>
      </div>

      <section className={styles.searchSection}>
        <div className={styles.sectionTitle}>{hasQuery ? "匹配会话" : "最近会话"}</div>
        {loading ? <div className={styles.empty}>正在加载会话</div> : null}
        {!loading && conversations.length === 0 ? <div className={styles.empty}>没有匹配会话</div> : null}
        {conversations.map((item) => (
          <button
            className={styles.searchResult}
            key={item.id}
            type="button"
            onClick={() => onNavigate(getSessionPath(item.id))}
          >
            {item.forked ? <GitBranch size={15} /> : <MessageCircle size={15} />}
            <span>{item.title}</span>
            {item.updatedAt ? <time>{formatRelativeTime(item.updatedAt)}</time> : null}
          </button>
        ))}
      </section>
    </AppDialog>
  );
}

function SessionRenameDialog({
  editing,
  onCancel,
  onChange,
  onSubmit,
}: {
  editing: { id: string; title: string };
  onCancel: () => void;
  onChange: (title: string) => void;
  onSubmit: (id: string, title: string) => void;
}) {
  const inputId = useId();
  return (
    <AppDialog
      title="重命名会话"
      description="修改后会同步到会话历史。"
      size="form"
      closeLabel="取消重命名"
      closeOnOverlayClick={false}
      onClose={onCancel}
    >
      <form
        className={styles.renameDialogForm}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(editing.id, editing.title);
        }}
      >
        <label className={styles.renameDialogField} htmlFor={inputId}>
          <span>会话名称</span>
          <input
            id={inputId}
            autoFocus
            aria-label="会话名称"
            onChange={(event) => onChange(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            value={editing.title}
          />
        </label>
        <footer className={styles.renameDialogActions}>
          <DialogButton type="button" aria-label="取消重命名" onClick={onCancel}>
            取消
          </DialogButton>
          <DialogButton tone="primary" type="submit" aria-label="保存重命名">
            保存
          </DialogButton>
        </footer>
      </form>
    </AppDialog>
  );
}

function WorkspaceRenameDialog({
  editing,
  onCancel,
  onChange,
  onSubmit,
}: {
  editing: { id: string; title: string };
  onCancel: () => void;
  onChange: (title: string) => void;
  onSubmit: (id: string, title: string) => void;
}) {
  const inputId = useId();
  return (
    <AppDialog
      title="重命名项目"
      description="仅修改 Keydex 中显示的名称，不会重命名本地目录。"
      size="form"
      closeLabel="取消重命名项目"
      closeOnOverlayClick={false}
      onClose={onCancel}
    >
      <form className={styles.renameDialogForm} onSubmit={(event) => { event.preventDefault(); onSubmit(editing.id, editing.title); }}>
        <label className={styles.renameDialogField} htmlFor={inputId}>
          <span>项目名称</span>
          <input id={inputId} autoFocus aria-label="项目名称" onChange={(event) => onChange(event.target.value)} onFocus={(event) => event.currentTarget.select()} value={editing.title} />
        </label>
        <footer className={styles.renameDialogActions}>
          <DialogButton type="button" aria-label="取消重命名项目" onClick={onCancel}>取消</DialogButton>
          <DialogButton tone="primary" type="submit" aria-label="保存项目名称">保存</DialogButton>
        </footer>
      </form>
    </AppDialog>
  );
}

function SessionArchiveConfirmationDialog({
  blockerCount,
  busy,
  title,
  onCancel,
  onConfirm,
}: {
  blockerCount: number;
  busy: boolean;
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const summary = title.trim() || "该会话";
  return (
    <ConfirmDialog
      title="停止并归档会话？"
      description="该会话仍有运行、等待、审批、排队输入或任务。确认后会先安全停止这些活动，再归档会话。"
      preview={summary}
      confirmLabel={busy ? "正在停止并归档" : `停止并归档（${blockerCount} 项）`}
      cancelDisabled={busy}
      confirmDisabled={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

interface SiderSectionProps {
  title: string;
  kind?: SiderGroup["kind"];
  items: SiderEntry[];
  collapsed: boolean;
  emptyText: string;
  emptyLoading?: boolean;
  hideTitle?: boolean;
  disableSectionToggle?: boolean;
  flat?: boolean;
  activePath?: string;
  routeSelectionEnabled?: boolean;
  editing?: { id: string; title: string } | null;
  archivingSessionId?: string | null;
  canMutate?: boolean;
  canFork?: boolean;
  canExport?: boolean;
  forkingSessionId?: string | null;
  exportingSessionId?: string | null;
  sessionIndicators?: Record<string, SessionIndicator>;
  workspaceId?: string;
  workspaceRootPath?: string;
  canManageWorkspace?: boolean;
  historyExpansionLoading?: boolean;
  historyHasMore?: boolean;
  historyPreviewLimit?: number;
  getSessionPath?: (sessionId: string) => string;
  getWorkspaceNewConversationPath?: (workspaceId?: string) => string;
  onArchive?: (item: SiderEntry) => void;
  onExportSession?: (item: SiderEntry) => void;
  onForkSession?: (item: SiderEntry) => void;
  onLoadHistoryExpansion?: (minimumItemCount: number) => Promise<void> | void;
  onNavigate?: (path: string) => void;
  onRefresh?: () => Promise<void> | void;
  onStartRename?: (item: SiderEntry) => void;
  onStartWorkspaceRename?: (workspaceId: string, title: string) => void;
  onRevealWorkspace?: (rootPath?: string) => void;
  onArchiveWorkspace?: (workspaceId: string, title: string) => void;
  onTogglePinned?: (item: SiderEntry, pinned: boolean) => void;
}

function HistoryBucket({
  title,
  kind,
  active = false,
  activePath = "",
  newConversationPath,
  onNavigate,
  children,
}: {
  title: string;
  kind: "workspace" | "chat";
  active?: boolean;
  activePath?: string;
  newConversationPath: string;
  onNavigate: (path: string) => void;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const bucketItemsId = useId();
  const previousActivePathRef = useRef(activePath);
  const newLabel = kind === "workspace" ? "新建项目对话" : "新建无项目对话";

  useEffect(() => {
    const activePathChanged = previousActivePathRef.current !== activePath;
    previousActivePathRef.current = activePath;
    if (active && activePathChanged) {
      setExpanded(true);
    }
  }, [active, activePath]);

  return (
    <section className={styles.historyBucket} data-kind={kind} aria-label={title}>
      <div className={styles.historyBucketHeader}>
        <button
          className={styles.historyBucketTitle}
          type="button"
          aria-controls={bucketItemsId}
          aria-expanded={expanded}
          aria-label={`${expanded ? "收起" : "展开"}${title}区域`}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{title}</span>
          <ChevronDown className={styles.historyBucketChevron} size={14} strokeWidth={1.9} aria-hidden="true" />
        </button>
        <button
          className={styles.historyBucketNewButton}
          type="button"
          aria-label={newLabel}
          data-tooltip-label={newLabel}
          title={newLabel}
          onClick={() => onNavigate(newConversationPath)}
        >
          <SquarePen size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
      <div
        className={styles.historyBucketItems}
        aria-hidden={!expanded}
        data-expanded={expanded ? "true" : "false"}
        id={bucketItemsId}
      >
        <div className={styles.historyBucketBody}>{children}</div>
      </div>
    </section>
  );
}

function SiderSection({
  title,
  kind = "chat",
  items,
  collapsed,
  emptyText,
  emptyLoading = false,
  hideTitle = false,
  disableSectionToggle = false,
  flat = false,
  activePath = "",
  routeSelectionEnabled = true,
  editing,
  archivingSessionId,
  canMutate = false,
  canFork = false,
  canExport = false,
  forkingSessionId = null,
  exportingSessionId = null,
  sessionIndicators = {},
  workspaceId,
  workspaceRootPath,
  canManageWorkspace = false,
  historyExpansionLoading = false,
  historyHasMore = false,
  historyPreviewLimit,
  getSessionPath = conversationPath,
  getWorkspaceNewConversationPath = newWorkspaceConversationPath,
  onArchive,
  onExportSession,
  onForkSession,
  onLoadHistoryExpansion,
  onNavigate,
  onRefresh,
  onStartRename,
  onStartWorkspaceRename,
  onRevealWorkspace,
  onArchiveWorkspace,
  onTogglePinned,
}: SiderSectionProps) {
  const [hoveredSession, setHoveredSession] = useState<SessionHoverCard | null>(null);
  const [hoveredProject, setHoveredProject] = useState<ProjectHoverCard | null>(null);
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);
  const [actionMenuSource, setActionMenuSource] = useState<"button" | "context">("button");
  const [closingActionMenuId, setClosingActionMenuId] = useState<string | null>(null);
  const [actionMenuPosition, setActionMenuPosition] = useState<CSSProperties | null>(null);
  const [sectionExpanded, setSectionExpanded] = useState(true);
  const [requestedHistoryExpansionCount, setRequestedHistoryExpansionCount] = useState(0);
  const [localHistoryExpansionLoading, setLocalHistoryExpansionLoading] = useState(false);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const actionTriggerRef = useRef<HTMLDivElement | null>(null);
  const actionMenuCloseTimerRef = useRef<number | null>(null);
  const sectionItemsId = useId();
  const sessionLayoutScopeId = useId();
  const reduceSessionMotion = prefersReducedMotion();
  const previousActivePathRef = useRef(activePath);
  const canToggleSection = (kind === "workspace" || kind === "pinned") && !disableSectionToggle;
  const sectionToggleLabel = kind === "pinned" ? "置顶区域" : `项目 ${title}`;
  const normalizedHistoryLimit = Math.max(0, historyPreviewLimit ?? 0);
  const canPreviewWorkspaceHistory =
    !collapsed && (kind === "workspace" || kind === "pinned") && !hideTitle && normalizedHistoryLimit > 0;
  const shouldLimitHistory =
    canPreviewWorkspaceHistory && (items.length > normalizedHistoryLimit || historyHasMore);
  const previewItems = shouldLimitHistory ? items.slice(0, normalizedHistoryLimit) : items;
  const extraItems = shouldLimitHistory ? items.slice(normalizedHistoryLimit) : [];
  const visibleExtraItemCount = shouldLimitHistory
    ? Math.min(requestedHistoryExpansionCount, extraItems.length)
    : 0;
  const visibleExtraItems = shouldLimitHistory ? extraItems.slice(0, visibleExtraItemCount) : [];
  const hasExpandedHistory = visibleExtraItemCount > 0;
  const canExpandHistory =
    shouldLimitHistory && (visibleExtraItemCount < extraItems.length || historyHasMore);
  const historyToggleLoading = historyExpansionLoading || localHistoryExpansionLoading;
  const canOpenSessionActionMenu = canMutate || canFork || canExport;
  const canOpenProjectActionMenu = Boolean(
    kind === "workspace"
    && workspaceId
    && canManageWorkspace
    && onStartWorkspaceRename
    && onRevealWorkspace
    && onArchiveWorkspace,
  );
  const projectMenuOpen = actionMenuId === PROJECT_ACTION_MENU_ID;
  const projectMenuVisible = projectMenuOpen || closingActionMenuId === PROJECT_ACTION_MENU_ID;

  useEffect(() => {
    const activePathChanged = previousActivePathRef.current !== activePath;
    previousActivePathRef.current = activePath;
    if (!canToggleSection || !activePathChanged) {
      return;
    }
    if (items.some((item) => isActivePath(activePath, getSessionPath(item.id)))) {
      setSectionExpanded(true);
    }
    if (shouldLimitHistory) {
      const activeExtraIndex = extraItems.findIndex((item) =>
        isActivePath(activePath, getSessionPath(item.id)),
      );
      if (activeExtraIndex >= 0) {
        const requiredExpansionCount =
          Math.ceil((activeExtraIndex + 1) / WORKSPACE_SESSION_EXPAND_STEP) *
          WORKSPACE_SESSION_EXPAND_STEP;
        setRequestedHistoryExpansionCount((current) => Math.max(current, requiredExpansionCount));
      }
    }
  }, [activePath, canToggleSection, extraItems, getSessionPath, items, shouldLimitHistory]);

  useEffect(() => {
    if (!shouldLimitHistory && requestedHistoryExpansionCount > 0) {
      setRequestedHistoryExpansionCount(0);
    }
  }, [requestedHistoryExpansionCount, shouldLimitHistory]);

  useEffect(() => {
    return () => {
      if (actionMenuCloseTimerRef.current) {
        window.clearTimeout(actionMenuCloseTimerRef.current);
      }
    };
  }, []);

  const closeActionMenu = useCallback(() => {
    if (!actionMenuId) {
      return;
    }
    if (actionMenuCloseTimerRef.current) {
      window.clearTimeout(actionMenuCloseTimerRef.current);
    }
    setClosingActionMenuId(actionMenuId);
    setActionMenuId(null);
    actionMenuCloseTimerRef.current = window.setTimeout(() => {
      setClosingActionMenuId((current) => (current === actionMenuId ? null : current));
      setActionMenuPosition(null);
      actionMenuCloseTimerRef.current = null;
    }, SESSION_ACTION_MENU_CLOSE_MS);
  }, [actionMenuId]);

  const getActionMenuPosition = useCallback((target: HTMLElement): CSSProperties => {
    const rect = target.getBoundingClientRect();
    const left = Math.min(
      rect.right + SESSION_ACTION_MENU_GAP,
      window.innerWidth - SESSION_ACTION_MENU_WIDTH - SESSION_ACTION_MENU_EDGE,
    );
    const top = Math.min(
      Math.max(rect.top - 4, SESSION_ACTION_MENU_EDGE),
      window.innerHeight - SESSION_ACTION_MENU_HEIGHT - SESSION_ACTION_MENU_EDGE,
    );
    return {
      left: Math.round(left),
      top: Math.round(top),
    };
  }, []);

  const getActionMenuPositionFromPoint = useCallback((clientX: number, clientY: number, menuHeight: number): CSSProperties => {
    const maxLeft = Math.max(
      SESSION_ACTION_MENU_EDGE,
      window.innerWidth - SESSION_ACTION_MENU_WIDTH - SESSION_ACTION_MENU_EDGE,
    );
    const maxTop = Math.max(
      SESSION_ACTION_MENU_EDGE,
      window.innerHeight - menuHeight - SESSION_ACTION_MENU_EDGE,
    );
    return {
      left: Math.round(clamp(clientX, SESSION_ACTION_MENU_EDGE, maxLeft)),
      top: Math.round(clamp(clientY, SESSION_ACTION_MENU_EDGE, maxTop)),
    };
  }, []);

  const openActionMenu = useCallback((id: string, position: CSSProperties, source: "button" | "context" = "button") => {
    if (actionMenuCloseTimerRef.current) {
      window.clearTimeout(actionMenuCloseTimerRef.current);
      actionMenuCloseTimerRef.current = null;
    }
    setClosingActionMenuId(null);
    setActionMenuPosition(position);
    setActionMenuSource(source);
    setActionMenuId(id);
  }, []);

  useEffect(() => {
    if (!actionMenuId) {
      return;
    }
    const closeFromPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (actionMenuRef.current?.contains(target) || actionTriggerRef.current?.contains(target))
      ) {
        return;
      }
      closeActionMenu();
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeActionMenu();
      }
    };
    document.addEventListener("pointerdown", closeFromPointer, true);
    document.addEventListener("keydown", closeFromEscape, true);
    document.addEventListener("scroll", closeActionMenu, true);
    window.addEventListener("resize", closeActionMenu);
    return () => {
      document.removeEventListener("pointerdown", closeFromPointer, true);
      document.removeEventListener("keydown", closeFromEscape, true);
      document.removeEventListener("scroll", closeActionMenu, true);
      window.removeEventListener("resize", closeActionMenu);
    };
  }, [actionMenuId, closeActionMenu]);

  async function expandHistory() {
    if (historyToggleLoading || !canExpandHistory) {
      return;
    }
    const nextRequestedCount = requestedHistoryExpansionCount + WORKSPACE_SESSION_EXPAND_STEP;
    setRequestedHistoryExpansionCount(nextRequestedCount);
    const minimumItemCount = normalizedHistoryLimit + nextRequestedCount;
    if (!historyHasMore || items.length >= minimumItemCount || !onLoadHistoryExpansion) {
      return;
    }
    setLocalHistoryExpansionLoading(true);
    try {
      await onLoadHistoryExpansion(minimumItemCount);
    } finally {
      setLocalHistoryExpansionLoading(false);
    }
  }

  function collapseHistory() {
    setRequestedHistoryExpansionCount(0);
  }

  const showSessionCard = (item: SiderEntry, active: boolean, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    setHoveredProject(null);
    setHoveredSession({
      id: item.id,
      title: item.title,
      updatedAt: item.updatedAt,
      groupTitle: item.groupTitle,
      active,
      top: Math.round(rect.top + rect.height / 2),
      left: collapsed ? undefined : Math.round(rect.right + 10),
    });
  };

  const showProjectCard = (active: boolean, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    setHoveredSession(null);
    setHoveredProject({
      title,
      kind,
      active,
      expanded: sectionExpanded,
      top: Math.round(rect.top + rect.height / 2),
    });
  };

  const renderHistoryRow = (item: SiderEntry) => {
    const path = getSessionPath(item.id);
    const active = routeSelectionEnabled && isActivePath(activePath, path);
    const indicator = sessionIndicators[item.id] ?? EMPTY_SESSION_INDICATOR;
    const showUpdatedTime = Boolean(
      item.updatedAt
      && !indicator.isStreaming
      && !indicator.hasUnread
      && !indicator.waitingApproval
      && !indicator.waitingInteraction,
    );
    const hasMeta = Boolean(
      showUpdatedTime
      || indicator.isStreaming
      || indicator.hasUnread
      || indicator.waitingApproval
      || indicator.waitingInteraction,
    );
    const menuOpen = actionMenuId === item.id;
    const menuVisible = menuOpen || closingActionMenuId === item.id;
    const canShowHoverCard = editing?.id !== item.id && archivingSessionId !== item.id && !menuVisible;
    const isForking = forkingSessionId === item.id;
    const isExporting = exportingSessionId === item.id;
    const isArchiving = archivingSessionId === item.id;
    const showContextRefresh = menuVisible && actionMenuSource === "context" && Boolean(onRefresh);
    const openContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
      if (!canOpenSessionActionMenu) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setHoveredSession(null);
      openActionMenu(
        item.id,
        getActionMenuPositionFromPoint(event.clientX, event.clientY, SESSION_CONTEXT_ACTION_MENU_HEIGHT),
        "context",
      );
    };
    return (
      <motion.div
        className={styles.historyRow}
        key={item.id}
        layout={reduceSessionMotion ? false : "position"}
        layoutId={reduceSessionMotion ? undefined : `${sessionLayoutScopeId}-${item.id}`}
        transition={{ layout: { duration: 0.24, ease: [0.22, 1, 0.36, 1] } }}
        data-app-context-menu={canOpenSessionActionMenu ? "local" : undefined}
        data-active={active ? "true" : "false"}
        data-can-actions={canOpenSessionActionMenu ? "true" : "false"}
        data-can-mutate={canMutate ? "true" : "false"}
        data-menu-open={menuVisible ? "true" : "false"}
        onContextMenu={canOpenSessionActionMenu ? openContextMenu : undefined}
        onBlurCapture={
          canShowHoverCard
            ? (event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  return;
                }
                setHoveredSession(null);
              }
            : undefined
        }
        onFocusCapture={
          canShowHoverCard ? (event) => showSessionCard(item, active, event.currentTarget) : undefined
        }
        onMouseEnter={
          canShowHoverCard ? (event) => showSessionCard(item, active, event.currentTarget) : undefined
        }
        onMouseLeave={canShowHoverCard ? () => setHoveredSession(null) : undefined}
      >
        <button
          className={styles.historyItem}
          type="button"
          aria-label={item.title}
          aria-current={active ? "page" : undefined}
          data-active={active ? "true" : "false"}
          data-tooltip-disabled="true"
          onClick={() => onNavigate?.(path)}
        >
          <span className={styles.historyTitle}>
            {item.forked ? <GitBranch className={styles.historyForkIcon} size={12} aria-hidden="true" /> : null}
            <span>{item.title}</span>
          </span>
        </button>
        {hasMeta || canOpenSessionActionMenu ? (
          <div className={styles.historyTrailing}>
            {hasMeta ? (
              <span className={styles.historyMeta}>
                {showUpdatedTime && item.updatedAt ? (
                  <time dateTime={item.updatedAt}>{formatRelativeTime(item.updatedAt)}</time>
                ) : null}
                <SessionStatusIndicators indicator={indicator} />
              </span>
            ) : null}
            {canOpenSessionActionMenu ? (
              <div
                className={styles.historyActions}
                data-menu-open={menuOpen ? "true" : "false"}
                ref={menuOpen ? actionTriggerRef : null}
              >
                {canMutate ? (
                  <button
                    aria-label={`${item.pinnedAt ? "取消置顶" : "置顶"} ${item.title}`}
                    data-tooltip-label={item.pinnedAt ? "取消置顶" : "置顶"}
                    data-pinned={item.pinnedAt ? "true" : "false"}
                    onClick={() => {
                      setHoveredSession(null);
                      closeActionMenu();
                      onTogglePinned?.(item, !item.pinnedAt);
                    }}
                    type="button"
                  >
                    {item.pinnedAt ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}
                  </button>
                ) : null}
                <button
                  aria-label={`更多操作 ${item.title}`}
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  data-tooltip-label="更多操作"
                  onClick={(event) => {
                    event.stopPropagation();
                    setHoveredSession(null);
                    if (menuOpen) {
                      closeActionMenu();
                      return;
                    }
                    openActionMenu(item.id, getActionMenuPosition(event.currentTarget), "button");
                  }}
                  type="button"
                >
                  <MoreHorizontal size={14} aria-hidden="true" />
                </button>
                {menuVisible && actionMenuPosition
                  ? createPortal(
                      <div
                        className={styles.historyActionMenu}
                        data-state={menuOpen ? "open" : "closing"}
                        ref={actionMenuRef}
                        role="menu"
                        aria-label={`会话操作 ${item.title}`}
                        style={actionMenuPosition}
                      >
                        <SessionActionMenuItems
                          canExport={canExport}
                          exporting={isExporting}
                          onExport={() => {
                            setHoveredSession(null);
                            closeActionMenu();
                            onExportSession?.(item);
                          }}
                          canFork={canFork}
                          forking={isForking}
                          onFork={() => {
                            setHoveredSession(null);
                            closeActionMenu();
                            onForkSession?.(item);
                          }}
                          canMutate={canMutate}
                          onRename={() => {
                            setHoveredSession(null);
                            closeActionMenu();
                            onStartRename?.(item);
                          }}
                          archiving={isArchiving}
                          onArchive={() => {
                            setHoveredSession(null);
                            closeActionMenu();
                            onArchive?.(item);
                          }}
                          showRefresh={showContextRefresh}
                          onRefresh={() => {
                            setHoveredSession(null);
                            closeActionMenu();
                            void onRefresh?.();
                          }}
                        />
                      </div>,
                      document.body,
                    )
                  : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </motion.div>
    );
  };

  const openProjectContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (!canOpenProjectActionMenu) return;
    event.preventDefault();
    event.stopPropagation();
    setHoveredProject(null);
    openActionMenu(
      PROJECT_ACTION_MENU_ID,
      getActionMenuPositionFromPoint(event.clientX, event.clientY, PROJECT_CONTEXT_ACTION_MENU_HEIGHT),
      "context",
    );
  };

  if (collapsed) {
    const collapsedProjectActive =
      routeSelectionEnabled
      && canToggleSection
      && items.some((item) => isActivePath(activePath, getSessionPath(item.id)));
    const CollapsedSectionIcon = sectionExpanded ? FolderOpen : Folder;
    return (
      <section className={styles.collapsedSection} aria-label={title} data-kind={kind}>
        {canToggleSection ? (
          <button
            className={styles.collapsedProjectButton}
            type="button"
            aria-controls={sectionItemsId}
            aria-expanded={sectionExpanded}
            aria-label={`${sectionExpanded ? "收起" : "展开"}${sectionToggleLabel}`}
            data-active={collapsedProjectActive ? "true" : "false"}
            onBlur={() => setHoveredProject(null)}
            onClick={() => setSectionExpanded((expanded) => !expanded)}
            onFocus={(event) => showProjectCard(collapsedProjectActive, event.currentTarget)}
            onMouseEnter={(event) => showProjectCard(collapsedProjectActive, event.currentTarget)}
            onMouseLeave={() => setHoveredProject(null)}
          >
            {kind === "pinned" ? (
              <span className={styles.collapsedPinnedMarker}>置</span>
            ) : (
              <CollapsedSectionIcon className={styles.collapsedProjectFolder} size={16} strokeWidth={1.8} aria-hidden="true" />
            )}
            <ChevronDown className={styles.collapsedProjectChevron} size={10} strokeWidth={2.15} aria-hidden="true" />
          </button>
        ) : null}
        <div
          className={styles.collapsedSectionItems}
          aria-hidden={canToggleSection && !sectionExpanded}
          data-expanded={!canToggleSection || sectionExpanded ? "true" : "false"}
          id={sectionItemsId}
        >
          <div className={styles.collapsedSectionItemsInner}>
            {items.map((item) => {
              const path = getSessionPath(item.id);
              const active = routeSelectionEnabled && isActivePath(activePath, path);
              const indicator = sessionIndicators[item.id] ?? EMPTY_SESSION_INDICATOR;
              return (
                <button
                  aria-current={active ? "page" : undefined}
                  aria-label={`打开会话 ${item.title}`}
                  className={styles.collapsedSessionButton}
                  data-active={active ? "true" : "false"}
                  key={item.id}
                  onBlur={() => setHoveredSession(null)}
                  onClick={() => onNavigate?.(path)}
                  onFocus={(event) => showSessionCard(item, active, event.currentTarget)}
                  onMouseEnter={(event) => showSessionCard(item, active, event.currentTarget)}
                  onMouseLeave={() => setHoveredSession(null)}
                  type="button"
                >
                  {indicator.isStreaming && !indicator.waitingApproval && !indicator.waitingInteraction ? (
                    <span
                      className={styles.collapsedSessionLoading}
                      data-collapsed-loading="true"
                      aria-hidden="true"
                    >
                      <span className={styles.historyStreamingSpinner} />
                    </span>
                  ) : (
                    <>
                      <span className={styles.collapsedSessionInitial}>{sessionInitial(item.title)}</span>
                      <SessionStatusIndicators indicator={indicator} collapsed />
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        {hoveredProject ? <ProjectHoverCardView project={hoveredProject} /> : null}
        {hoveredSession ? <SessionHoverCardView session={hoveredSession} /> : null}
      </section>
    );
  }

  return (
    <section
      className={styles.section}
      aria-label={hideTitle ? `${title}列表` : title}
      data-kind={kind}
      data-flat={flat ? "true" : "false"}
    >
      {hideTitle ? null : canToggleSection ? (
        <div
          className={styles.sectionTitleRow}
          data-app-context-menu={canOpenProjectActionMenu ? "local" : undefined}
          data-kind={kind}
          data-menu-open={projectMenuVisible ? "true" : undefined}
          onContextMenu={canOpenProjectActionMenu ? openProjectContextMenu : undefined}
        >
          <button
            className={`${styles.sectionTitle} ${styles.projectSectionTitle}`}
            type="button"
            aria-controls={sectionItemsId}
            aria-expanded={sectionExpanded}
            aria-label={`${sectionExpanded ? "收起" : "展开"}${sectionToggleLabel}`}
            data-kind={kind}
            onClick={() => setSectionExpanded((expanded) => !expanded)}
          >
            {kind === "pinned" ? null : sectionExpanded ? (
              <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Folder size={15} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>{title}</span>
            {kind === "pinned" ? (
              <ChevronDown className={styles.sectionChevron} size={14} strokeWidth={1.9} aria-hidden="true" />
            ) : null}
          </button>
          {workspaceId ? (
            <div className={styles.sectionHeaderActions} ref={projectMenuOpen ? actionTriggerRef : null}>
              <button
                className={styles.sectionNewButton}
                type="button"
                aria-label={`在项目 ${title} 中新建对话`}
                data-tooltip-label="新建对话"
                title={`在项目 ${title} 中新建对话`}
                onClick={() => onNavigate?.(getWorkspaceNewConversationPath(workspaceId))}
              >
                <SquarePen size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
              {canOpenProjectActionMenu ? (
                <button
                  className={styles.sectionNewButton}
                  type="button"
                  aria-label={`更多项目操作 ${title}`}
                  aria-expanded={projectMenuOpen}
                  aria-haspopup="menu"
                  data-tooltip-label="更多操作"
                  onClick={(event) => {
                    event.stopPropagation();
                    setHoveredProject(null);
                    if (projectMenuOpen) {
                      closeActionMenu();
                      return;
                    }
                    openActionMenu(PROJECT_ACTION_MENU_ID, getActionMenuPosition(event.currentTarget), "button");
                  }}
                >
                  <MoreHorizontal size={14} aria-hidden="true" />
                </button>
              ) : null}
              {projectMenuVisible && actionMenuPosition ? createPortal(
                <div
                  className={styles.historyActionMenu}
                  data-state={projectMenuOpen ? "open" : "closing"}
                  ref={actionMenuRef}
                  role="menu"
                  aria-label={`项目操作 ${title}`}
                  style={actionMenuPosition}
                >
                  <button type="button" role="menuitem" onClick={() => { closeActionMenu(); onStartWorkspaceRename?.(workspaceId, title); }}><Pencil size={14} /><span>重命名</span></button>
                  <button type="button" role="menuitem" disabled={!workspaceRootPath} onClick={() => { closeActionMenu(); onRevealWorkspace?.(workspaceRootPath); }}><FolderOpen size={14} /><span>资源管理器</span></button>
                  <button type="button" role="menuitem" data-tone="danger" onClick={() => { closeActionMenu(); onArchiveWorkspace?.(workspaceId, title); }}><Archive size={14} /><span>归档</span></button>
                </div>,
                document.body,
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className={styles.sectionTitle} data-kind={kind}>
          <span>{title}</span>
        </div>
      )}
      <div
        className={styles.sectionItems}
        aria-hidden={!sectionExpanded}
        data-expanded={sectionExpanded ? "true" : "false"}
        id={sectionItemsId}
      >
        <div className={styles.sectionItemsInner}>
          {items.length === 0 ? (
            emptyLoading ? (
              <div className={styles.emptyLoading} aria-label="正在加载会话" role="status">
                <LoaderCircle size={14} />
              </div>
            ) : (
              <div className={styles.empty}>{emptyText}</div>
            )
          ) : (
            <>
              {previewItems.map(renderHistoryRow)}
              {shouldLimitHistory ? (
                <>
                  <div
                    className={styles.historyExtraItems}
                    aria-hidden={!hasExpandedHistory}
                    data-history-extra-items="true"
                    data-expanded={hasExpandedHistory ? "true" : "false"}
                  >
                    <div className={styles.historyExtraItemsInner}>{visibleExtraItems.map(renderHistoryRow)}</div>
                  </div>
                  <div className={styles.historyToggleActions}>
                    {canExpandHistory ? (
                      <button
                        aria-expanded={hasExpandedHistory}
                        aria-label={`展开 ${title} 会话历史`}
                        className={styles.historyToggleButton}
                        disabled={historyToggleLoading}
                        onClick={() => void expandHistory()}
                        type="button"
                      >
                        {historyToggleLoading ? <LoaderCircle size={12} strokeWidth={2} aria-hidden="true" /> : null}
                        <span>{historyToggleLoading ? "加载中" : "展开会话"}</span>
                      </button>
                    ) : null}
                    {hasExpandedHistory ? (
                      <button
                        aria-expanded="true"
                        aria-label={`折叠 ${title} 会话历史`}
                        className={styles.historyToggleButton}
                        onClick={collapseHistory}
                        type="button"
                      >
                        <span>折叠会话</span>
                      </button>
                    ) : null}
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
      {hoveredSession ? <SessionHoverCardView session={hoveredSession} /> : null}
    </section>
  );
}

function SessionStatusIndicators({
  indicator,
  collapsed = false,
}: {
  indicator: SessionIndicator;
  collapsed?: boolean;
}) {
  if (!indicator.isStreaming && !indicator.hasUnread && !indicator.waitingApproval && !indicator.waitingInteraction) {
    return null;
  }
  const waitingTitle = indicator.waitingApproval ? "等待批准" : "等待交互";
  return (
    <span
      className={styles.historyIndicators}
      data-collapsed={collapsed ? "true" : "false"}
      data-session-indicators="true"
      data-streaming={indicator.isStreaming ? "true" : "false"}
      data-unread={indicator.hasUnread ? "true" : "false"}
      data-waiting-approval={indicator.waitingApproval ? "true" : "false"}
      data-waiting-interaction={indicator.waitingInteraction ? "true" : "false"}
      aria-hidden={collapsed ? "true" : undefined}
    >
      {indicator.waitingApproval || indicator.waitingInteraction ? (
        collapsed ? (
          <span className={styles.historyApprovalDot} title={waitingTitle} />
        ) : (
          <span className={styles.historyApprovalBadge}>
            {indicator.waitingApproval ? <ShieldCheck size={12} /> : <MessageCircle size={12} />}
            <span>{waitingTitle}</span>
          </span>
        )
      ) : null}
      {indicator.isStreaming && !indicator.waitingApproval && !indicator.waitingInteraction ? (
        <span className={styles.historyStreamingSpinner} />
      ) : null}
      {indicator.hasUnread ? <span className={styles.historyUnreadDot} /> : null}
    </span>
  );
}

interface SessionHoverCard {
  id: string;
  title: string;
  updatedAt?: string;
  groupTitle?: string;
  active: boolean;
  top: number;
  left?: number;
}

interface ProjectHoverCard {
  title: string;
  kind: SiderGroup["kind"];
  active: boolean;
  expanded: boolean;
  top: number;
}

function ProjectHoverCardView({ project }: { project: ProjectHoverCard }) {
  const typeLabel = project.kind === "pinned" ? "置顶" : project.active ? "当前项目" : "项目";
  return (
    <div
      className={styles.collapsedSessionCard}
      role="tooltip"
      style={hoverCardStyle(project.top)}
    >
      <div className={styles.collapsedSessionCardTitle}>{project.title}</div>
      <div className={styles.collapsedSessionCardMeta}>
        <span>{typeLabel}</span>
        <span aria-hidden="true">·</span>
        <span>{project.expanded ? "已展开" : "已收起"}</span>
      </div>
    </div>
  );
}

function SessionHoverCardView({ session }: { session: SessionHoverCard }) {
  return (
    <div
      className={styles.collapsedSessionCard}
      role="tooltip"
      style={hoverCardStyle(session.top, session.left)}
    >
      <div className={styles.collapsedSessionCardTitle}>{session.title}</div>
      <div className={styles.collapsedSessionCardMeta}>
        <span>{session.active ? "当前会话" : "会话"}</span>
        {session.groupTitle ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{session.groupTitle}</span>
          </>
        ) : null}
        {session.updatedAt ? (
          <>
            <span aria-hidden="true">·</span>
            <time dateTime={session.updatedAt}>{formatRelativeTime(session.updatedAt)}</time>
          </>
        ) : null}
      </div>
    </div>
  );
}

function hoverCardStyle(top: number, left?: number): CSSProperties {
  return {
    "--session-card-top": `${top}px`,
    ...(left === undefined ? {} : { "--session-card-left": `${left}px` }),
  } as CSSProperties;
}

function sessionToEntry(session: AgentSession, groupTitle: string): SiderEntry {
  const pinnedAt = session.pinned_at ?? (session.pinned ? session.updated_at : undefined);
  return {
    id: session.id,
    title: session.title || session.id,
    updatedAt: session.updated_at,
    pinnedAt,
    groupTitle,
    forked: Boolean(session.fork_source),
  };
}

function buildPinnedEntries(sessions: AgentSession[]): SiderEntry[] {
  return sessions
    .filter((session) => session.pinned || session.pinned_at)
    .slice()
    .sort(comparePinnedSessions)
    .map((session) => {
      const meta = sessionGroupMeta(session);
      return sessionToEntry(session, meta.title);
    });
}

function buildSessionGroups(sessions: AgentSession[]): SiderGroup[] {
  const groups = new Map<string, SiderGroup>();
  sessions
    .slice()
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .forEach((session) => {
      const meta = sessionGroupMeta(session);
      const group =
        groups.get(meta.id) ??
        {
          id: meta.id,
          title: meta.title,
          kind: meta.kind,
          items: [],
          latestUpdatedAt: session.updated_at,
          workspaceId: meta.workspaceId,
          rootPath: meta.rootPath,
        };
      group.title = meta.title;
      group.rootPath = meta.rootPath ?? group.rootPath;
      group.latestUpdatedAt = maxTime(group.latestUpdatedAt, session.updated_at);
      group.items.push(sessionToEntry(session, group.title));
      groups.set(group.id, group);
    });

  const workspaceGroups = [...groups.values()]
    .filter((group) => group.kind === "workspace")
    .sort(compareGroupUpdatedAt);
  const chatGroup = groups.get("chat");
  return chatGroup ? [...workspaceGroups, chatGroup] : workspaceGroups;
}

function buildControlledGroups(projects: SiderEntry[], conversations: SiderEntry[]): SiderGroup[] {
  if (!conversations.length) {
    return projects.map((project) => ({
      id: `project:${project.id}`,
      title: project.title,
      kind: "workspace" as const,
      items: [],
      latestUpdatedAt: project.updatedAt,
      workspaceId: project.id,
      rootPath: project.rootPath,
    }));
  }
  const title = projects[0]?.title ?? "对话";
  return [
    {
      id: projects[0] ? `project:${projects[0].id}` : "chat",
      title,
      kind: projects[0] ? "workspace" : "chat",
      items: conversations.map((item) => ({ ...item, groupTitle: title })),
      latestUpdatedAt: conversations[0]?.updatedAt,
      workspaceId: projects[0]?.id,
      rootPath: projects[0]?.rootPath,
    },
  ];
}

function buildControlledPinnedEntries(projects: SiderEntry[], conversations: SiderEntry[]): SiderEntry[] {
  const title = projects[0]?.title ?? "对话";
  return conversations
    .filter((item) => item.pinnedAt)
    .map((item) => ({ ...item, groupTitle: item.groupTitle ?? title }))
    .sort(comparePinnedEntries);
}

function withoutPinnedItems(groups: SiderGroup[]): SiderGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.pinnedAt),
    }))
    .filter((group) => group.kind === "workspace" || group.items.length > 0);
}

function sessionGroupMeta(session: AgentSession): Pick<SiderGroup, "id" | "title" | "kind" | "workspaceId" | "rootPath"> {
  if (session.session_type === "workspace") {
    if (session.workspace) {
      return {
        id: `workspace:${session.workspace.id}`,
        title: session.workspace.name || session.workspace.root_path,
        kind: "workspace",
        workspaceId: session.workspace.id,
        rootPath: session.workspace.root_path,
      };
    }
    return {
      id: `workspace:${session.workspace_id ?? "missing"}`,
      title: "工作区不可用",
      kind: "workspace",
      rootPath: undefined,
    };
  }
  return {
    id: "chat",
    title: "对话",
    kind: "chat",
    rootPath: undefined,
  };
}

function readSessionHistoryCache(runtime: RuntimeBridge): AgentSession[] | null {
  const cached = sessionHistoryCacheByRuntime.get(runtime);
  return cached ? [...cached.sessions] : null;
}

function isSessionHistoryCacheCurrent(runtime: RuntimeBridge): boolean {
  const cached = sessionHistoryCacheByRuntime.get(runtime);
  return cached !== undefined && cached.lifecycleRevision === getLifecycleEventRevision();
}

function writeSessionHistoryCache(runtime: RuntimeBridge, sessions: AgentSession[]) {
  sessionHistoryCacheByRuntime.set(runtime, {
    sessions: [...sessions],
    lifecycleRevision: getLifecycleEventRevision(),
  });
}

function upsertSession(sessions: AgentSession[], session: AgentSession): AgentSession[] {
  return mergeSessions(sessions, [session]);
}

function countWorkspaceSessions(sessions: AgentSession[], workspaceId: string): number {
  return sessions.reduce(
    (count, session) => count + Number(
      session.session_type === "workspace"
      && session.workspace_id === workspaceId
      && !session.pinned
      && !session.pinned_at,
    ),
    0,
  );
}

function mergeSessionUpdate(sessions: AgentSession[], update: AgentSessionUpdate): AgentSession[] {
  const existing = sessions.find((session) => session.id === update.id);
  if (!existing) {
    return sessions;
  }
  return mergeSessions(sessions, [{ ...existing, ...definedSessionUpdate(update) }]);
}

function definedSessionUpdate(update: AgentSessionUpdate): AgentSessionUpdate {
  return Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)) as AgentSessionUpdate;
}

function mergeSessions(sessions: AgentSession[], incoming: AgentSession[]): AgentSession[] {
  const byId = new Map<string, AgentSession>();
  for (const session of sessions) {
    byId.set(session.id, session);
  }
  for (const session of incoming) {
    byId.set(session.id, session);
  }
  return [...byId.values()].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

function compareGroupUpdatedAt(left: SiderGroup, right: SiderGroup): number {
  return (right.latestUpdatedAt ?? "").localeCompare(left.latestUpdatedAt ?? "");
}

function comparePinnedSessions(left: AgentSession, right: AgentSession): number {
  return compareTimeDesc(
    left.pinned_at ?? (left.pinned ? left.updated_at : undefined),
    right.pinned_at ?? (right.pinned ? right.updated_at : undefined),
  );
}

function comparePinnedEntries(left: SiderEntry, right: SiderEntry): number {
  return compareTimeDesc(left.pinnedAt, right.pinnedAt);
}

function compareTimeDesc(left: string | undefined, right: string | undefined): number {
  return (right ?? "").localeCompare(left ?? "");
}

function maxTime(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left.localeCompare(right) >= 0 ? left : right;
}

function conversationPath(id: string): string {
  return `/conversation/${encodeURIComponent(id)}`;
}

function newWorkspaceConversationPath(workspaceId?: string): string {
  if (!workspaceId) {
    return newPromptConversationPath({ sessionType: "workspace" });
  }
  return newPromptConversationPath({ workspaceId });
}

function newChatConversationPath(): string {
  return newPromptConversationPath({ sessionType: "chat" });
}

function newPromptConversationPath(params: { sessionType?: string; workspaceId?: string } = {}): string {
  const query = new URLSearchParams();
  if (params.sessionType) {
    query.set("sessionType", params.sessionType);
  }
  if (params.workspaceId) {
    query.set("workspaceId", params.workspaceId);
  }
  query.set("focus", "prompt");
  return `/guid?${query.toString()}`;
}

function formatRelativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) {
    return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  }
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (diffMs < minute) {
    return "刚刚";
  }
  if (diffMs < hour) {
    return `${Math.max(1, Math.floor(diffMs / minute))} 分`;
  }
  if (diffMs < day) {
    return `${Math.floor(diffMs / hour)} 小时`;
  }
  if (diffMs < week) {
    return `${Math.floor(diffMs / day)} 天`;
  }
  if (diffMs < 6 * week) {
    return `${Math.floor(diffMs / week)} 周`;
  }
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function sessionInitial(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    return "会";
  }
  return Array.from(trimmed)[0]?.toUpperCase() ?? "会";
}

function isActivePath(activePath: string, path: string): boolean {
  return stripQuery(activePath) === stripQuery(path);
}

function stripQuery(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? path;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "读取会话历史失败";
}

function archiveBlockerCount(error: LifecycleRuntimeError): number {
  const count = error.details.blocker_count;
  return typeof count === "number" && Number.isFinite(count) ? count : 1;
}
