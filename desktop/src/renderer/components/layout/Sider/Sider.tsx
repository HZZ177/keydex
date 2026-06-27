import {
  Check,
  ChevronDown,
  Folder,
  FolderOpen,
  LoaderCircle,
  MessageCircle,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Search,
  Settings,
  ShieldCheck,
  SquarePen,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import type { AppMode } from "@/renderer/components/layout/appMode";
import { subscribeSessionCreated } from "@/renderer/events/sessionEvents";
import { useOptionalAgentSessionRuntime } from "@/renderer/providers/AgentSessionProvider";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";
import { useTheme } from "@/renderer/providers/ThemeProvider";
import type { AgentSession } from "@/types/protocol";

import styles from "./Sider.module.css";

export interface SiderEntry {
  id: string;
  title: string;
  updatedAt?: string;
  groupTitle?: string;
}

interface SiderGroup {
  id: string;
  title: string;
  kind: "workspace" | "chat";
  items: SiderEntry[];
  latestUpdatedAt?: string;
  workspaceId?: string;
}

interface SessionIndicator {
  isStreaming: boolean;
  hasUnread: boolean;
  waitingApproval: boolean;
}

const EMPTY_SESSION_INDICATOR: SessionIndicator = {
  isStreaming: false,
  hasUnread: false,
  waitingApproval: false,
};

const WORKSPACE_SESSION_PREVIEW_LIMIT = 5;
const WORKSPACE_SESSION_HISTORY_PAGE_SIZE = 100;

export interface SiderProps {
  collapsed?: boolean;
  appMode?: AppMode;
  projects?: SiderEntry[];
  conversations?: SiderEntry[];
  runtime?: RuntimeBridge;
  activePath?: string;
  showChatBucket?: boolean;
  newConversationPath?: string;
  deleteActiveFallbackPath?: string;
  getSessionPath?: (sessionId: string) => string;
  getWorkspaceNewConversationPath?: (workspaceId?: string) => string;
  onToggleSidebar?: () => void;
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
  deleteActiveFallbackPath = "/guid",
  getSessionPath = conversationPath,
  getWorkspaceNewConversationPath = newWorkspaceConversationPath,
  onToggleSidebar,
  onNavigate,
}: SiderProps) {
  const { theme, toggleTheme } = useTheme();
  const notifications = useNotifications();
  const optionalAgentRuntime = useOptionalAgentSessionRuntime();
  const runtimeConnection = useOptionalRuntimeConnection();
  const backendReady = runtimeConnection?.ready ?? true;
  const backendError = runtimeConnection?.status === "error";
  const sharedSessionState =
    optionalAgentRuntime?.runtime === runtime ? optionalAgentRuntime.state.sessionStateById : {};
  const ThemeIcon = theme === "dark" ? Sun : Moon;
  const [loadedSessions, setLoadedSessions] = useState<AgentSession[]>([]);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadingWorkspaceHistoryIds, setLoadingWorkspaceHistoryIds] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const loadedWorkspaceHistoryIdsRef = useRef<Set<string>>(new Set());
  const [showFooterFeather, setShowFooterFeather] = useState(false);
  const canMutateConversations =
    typeof runtime.conversation.updateSession === "function" && typeof runtime.conversation.deleteSession === "function";

  const controlled = conversations !== undefined;
  const loadedGroups = useMemo(() => buildSessionGroups(loadedSessions), [loadedSessions]);
  const historyGroups = useMemo(
    () => (conversations ? buildControlledGroups(projects, conversations) : loadedGroups),
    [conversations, loadedGroups, projects],
  );
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
  const workspaceGroups = useMemo(() => historyGroups.filter((group) => group.kind === "workspace"), [historyGroups]);
  const chatGroup = useMemo(() => historyGroups.find((group) => group.kind === "chat") ?? null, [historyGroups]);
  const chatItems = chatGroup?.items ?? [];
  const firstWorkspaceId = workspaceGroups.find((group) => group.workspaceId)?.workspaceId ?? projects[0]?.id;
  const workbenchGroup = workspaceGroups[0] ?? {
    id: "workbench:empty",
    title: projects[0]?.title ?? "工作台会话",
    kind: "workspace" as const,
    items: [],
    workspaceId: projects[0]?.id,
  };
  const historyItems = useMemo(() => historyGroups.flatMap((group) => group.items), [historyGroups]);
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
        const waitingApproval = state.runtimeState === "waiting_approval" || Boolean(state.pendingApproval);
        const isStreaming =
          !waitingApproval && (state.runtimeState === "running" || state.runtimeState === "cancelling" || state.isStreaming);
        return [
          sessionId,
          {
            isStreaming,
            waitingApproval,
            hasUnread: state.hasUnread && !isStreaming && !waitingApproval && !isActivePath(activePath, getSessionPath(sessionId)),
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
  }, [collapsed, confirmDeleteId, editing, historyGroups, loadingHistory, updateFooterFeather]);

  useEffect(() => {
    if (controlled) {
      return;
    }
    if (!backendReady) {
      setLoadingHistory(false);
      return;
    }
    let active = true;
    setLoadingHistory(true);
    void runtime.conversation
      .listSessions({ pageSize: 50 })
      .then((response) => {
        if (active) {
          setLoadedSessions(response.list);
        }
      })
      .catch((reason) => {
        if (active) {
          notifications.error(errorMessage(reason));
        }
      })
      .finally(() => {
        if (active) {
          setLoadingHistory(false);
        }
      });
    return () => {
      active = false;
    };
  }, [backendReady, controlled, notifications, runtime]);

  useEffect(() => {
    if (controlled) {
      return;
    }
    return subscribeSessionCreated((session) => {
      setLoadedSessions((items) => upsertSession(items, session));
    });
  }, [controlled]);

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
      setLoadedSessions((items) => upsertSession(items, updated));
      setEditing(null);
      notifications.success("已重命名会话");
    } catch (reason) {
      notifications.error(errorMessage(reason));
    }
  }

  async function deleteConversation(id: string) {
    if (!canMutateConversations) {
      notifications.warning("当前后端不支持删除会话");
      return;
    }
    try {
      await runtime.conversation.deleteSession(id);
      setLoadedSessions((items) => items.filter((item) => item.id !== id));
      setConfirmDeleteId(null);
      notifications.success("已删除会话");
      if (isActivePath(activePath, getSessionPath(id))) {
        onNavigate?.(deleteActiveFallbackPath);
      }
    } catch (reason) {
      notifications.error(errorMessage(reason));
    }
  }

  const loadWorkspaceSessions = useCallback(
    async (workspaceId: string) => {
      if (controlled || loadedWorkspaceHistoryIdsRef.current.has(workspaceId) || loadingWorkspaceHistoryIds.has(workspaceId)) {
        return;
      }
      setLoadingWorkspaceHistoryIds((current) => {
        const next = new Set(current);
        next.add(workspaceId);
        return next;
      });
      try {
        const sessions: AgentSession[] = [];
        let page = 1;
        while (true) {
          const response = await runtime.conversation.listSessions({
            sessionType: "workspace",
            workspaceId,
            page,
            pageSize: WORKSPACE_SESSION_HISTORY_PAGE_SIZE,
          });
          sessions.push(...response.list);
          if (response.list.length === 0 || sessions.length >= response.total) {
            break;
          }
          page += 1;
        }
        setLoadedSessions((items) => mergeSessions(items, sessions));
        loadedWorkspaceHistoryIdsRef.current.add(workspaceId);
      } catch (reason) {
        notifications.error(errorMessage(reason));
      } finally {
        setLoadingWorkspaceHistoryIds((current) => {
          const next = new Set(current);
          next.delete(workspaceId);
          return next;
        });
      }
    },
    [controlled, loadingWorkspaceHistoryIds, notifications, runtime],
  );

  return (
    <aside
      className={styles.sider}
      aria-label="侧边栏"
      data-layout-sidebar="true"
      data-collapsed={collapsed ? "true" : "false"}
      data-footer-feather={showFooterFeather ? "true" : "false"}
    >
      <nav className={styles.nav} aria-label="主导航">
        {onToggleSidebar ? (
          <button
            className={styles.navItem}
            data-state={collapsed ? "collapsed" : "expanded"}
            data-icon={collapsed ? "panel-left-open" : "panel-left-close"}
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
              data-active={isActivePath(activePath, item.path) ? "true" : "false"}
              onClick={() => (item.key === "search" ? setSearchOpen(true) : navigateTo(item.path))}
            >
              <Icon size={17} strokeWidth={2} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {appMode === "workbench" ? (
        <div className={styles.workbenchHistory} aria-label="工作台会话历史">
          <div
            className={styles.history}
            aria-label="会话历史"
            ref={historyRef}
            onScroll={updateFooterFeather}
            onTransitionEnd={updateFooterFeather}
          >
            <SiderSection
              title={workbenchGroup.title}
              kind="workspace"
              items={workbenchGroup.items}
              collapsed={collapsed}
              emptyText={historyEmptyText}
              emptyLoading={historyEmptyLoading}
              activePath={activePath}
              editing={editing}
              confirmDeleteId={confirmDeleteId}
              canMutate={canMutateConversations}
              sessionIndicators={sessionIndicators}
              workspaceId={workbenchGroup.workspaceId}
              disableSectionToggle
              flat
              hideTitle
              getSessionPath={getSessionPath}
              onDelete={(id) => void deleteConversation(id)}
              onCancelDelete={() => setConfirmDeleteId(null)}
              onCancelRename={() => setEditing(null)}
              onConfirmDelete={setConfirmDeleteId}
              onRename={(id, title) => void renameConversation(id, title)}
              onStartRename={(item) => setEditing({ id: item.id, title: item.title })}
              onUpdateRename={(title) => setEditing((value) => (value ? { ...value, title } : value))}
              onNavigate={navigateTo}
            />
          </div>
        </div>
      ) : (
        <div
          className={styles.history}
          aria-label="会话历史"
          ref={historyRef}
          onScroll={updateFooterFeather}
          onTransitionEnd={updateFooterFeather}
        >
          {collapsed ? (
            <>
              {historyGroups.length === 0 ? (
                <SiderSection
                  title="对话"
                  items={[]}
                  collapsed={collapsed}
                  emptyText={historyEmptyText}
                  emptyLoading={historyEmptyLoading}
                />
              ) : null}
              {historyGroups.map((group) => (
                <SiderSection
                  title={group.title}
                  kind={group.kind}
                  items={group.items}
                  collapsed={collapsed}
                  emptyText={historyEmptyText}
                  emptyLoading={historyEmptyLoading}
                  activePath={activePath}
                  editing={editing}
                  confirmDeleteId={confirmDeleteId}
                  canMutate={canMutateConversations}
                  sessionIndicators={sessionIndicators}
                  workspaceId={group.workspaceId}
                  getSessionPath={getSessionPath}
                  getWorkspaceNewConversationPath={getWorkspaceNewConversationPath}
                  historyExpansionLoading={Boolean(group.workspaceId && loadingWorkspaceHistoryIds.has(group.workspaceId))}
                  historyPreviewLimit={WORKSPACE_SESSION_PREVIEW_LIMIT}
                  key={group.id}
                  onDelete={(id) => void deleteConversation(id)}
                  onLoadHistoryExpansion={
                    group.workspaceId && !controlled ? () => loadWorkspaceSessions(group.workspaceId as string) : undefined
                  }
                  onCancelDelete={() => setConfirmDeleteId(null)}
                  onCancelRename={() => setEditing(null)}
                  onConfirmDelete={setConfirmDeleteId}
                  onRename={(id, title) => void renameConversation(id, title)}
                  onStartRename={(item) => setEditing({ id: item.id, title: item.title })}
                  onUpdateRename={(title) => setEditing((value) => (value ? { ...value, title } : value))}
                  onNavigate={navigateTo}
                />
              ))}
            </>
          ) : (
            <>
              <HistoryBucket
                title="项目"
                kind="workspace"
                newConversationPath={getWorkspaceNewConversationPath(firstWorkspaceId)}
                onNavigate={navigateTo}
              >
                {workspaceGroups.map((group) => (
                  <SiderSection
                    title={group.title}
                    kind={group.kind}
                    items={group.items}
                    collapsed={collapsed}
                    emptyText={historyEmptyText}
                    emptyLoading={false}
                    activePath={activePath}
                    editing={editing}
                    confirmDeleteId={confirmDeleteId}
                    canMutate={canMutateConversations}
                    sessionIndicators={sessionIndicators}
                    workspaceId={group.workspaceId}
                    getSessionPath={getSessionPath}
                    getWorkspaceNewConversationPath={getWorkspaceNewConversationPath}
                    historyExpansionLoading={Boolean(
                      group.workspaceId && loadingWorkspaceHistoryIds.has(group.workspaceId),
                    )}
                    historyPreviewLimit={WORKSPACE_SESSION_PREVIEW_LIMIT}
                    key={group.id}
                    onDelete={(id) => void deleteConversation(id)}
                    onLoadHistoryExpansion={
                      group.workspaceId && !controlled
                        ? () => loadWorkspaceSessions(group.workspaceId as string)
                        : undefined
                    }
                    onCancelDelete={() => setConfirmDeleteId(null)}
                    onCancelRename={() => setEditing(null)}
                    onConfirmDelete={setConfirmDeleteId}
                    onRename={(id, title) => void renameConversation(id, title)}
                    onStartRename={(item) => setEditing({ id: item.id, title: item.title })}
                    onUpdateRename={(title) => setEditing((value) => (value ? { ...value, title } : value))}
                    onNavigate={navigateTo}
                  />
                ))}
              </HistoryBucket>
              {showChatBucket ? (
                <HistoryBucket
                  title="对话"
                  kind="chat"
                  newConversationPath={newChatConversationPath()}
                  onNavigate={navigateTo}
                >
                  <SiderSection
                    title="对话"
                    kind="chat"
                    items={chatItems}
                    collapsed={collapsed}
                    emptyText={historyEmptyText}
                    emptyLoading={historyEmptyLoading}
                    activePath={activePath}
                    editing={editing}
                    confirmDeleteId={confirmDeleteId}
                    canMutate={canMutateConversations}
                    sessionIndicators={sessionIndicators}
                    hideTitle
                    getSessionPath={getSessionPath}
                    onDelete={(id) => void deleteConversation(id)}
                    onCancelDelete={() => setConfirmDeleteId(null)}
                    onCancelRename={() => setEditing(null)}
                    onConfirmDelete={setConfirmDeleteId}
                    onRename={(id, title) => void renameConversation(id, title)}
                    onStartRename={(item) => setEditing({ id: item.id, title: item.title })}
                    onUpdateRename={(title) => setEditing((value) => (value ? { ...value, title } : value))}
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
          onClick={toggleTheme}
        >
          <ThemeIcon size={17} strokeWidth={2} />
          <span>{theme === "dark" ? "浅色" : "深色"}</span>
        </button>
        <button
          className={styles.navItem}
          type="button"
          title={collapsed ? "设置" : ""}
          data-active={activePath.startsWith("/settings") ? "true" : "false"}
          onClick={() => onNavigate?.("/settings/general")}
        >
          <Settings size={17} strokeWidth={2} />
          <span>设置</span>
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
    </aside>
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
    <div className={styles.searchOverlay} role="presentation" onMouseDown={onClose}>
      <section
        className={styles.searchDialog}
        role="dialog"
        aria-modal="true"
        aria-label="搜索会话"
        onMouseDown={(event) => event.stopPropagation()}
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
              <MessageCircle size={15} />
              <span>{item.title}</span>
              {item.updatedAt ? <time>{formatRelativeTime(item.updatedAt)}</time> : null}
            </button>
          ))}
        </section>
      </section>
    </div>
  );
}

interface SiderSectionProps {
  title: string;
  kind?: "workspace" | "chat";
  items: SiderEntry[];
  collapsed: boolean;
  emptyText: string;
  emptyLoading?: boolean;
  hideTitle?: boolean;
  disableSectionToggle?: boolean;
  flat?: boolean;
  activePath?: string;
  editing?: { id: string; title: string } | null;
  confirmDeleteId?: string | null;
  canMutate?: boolean;
  sessionIndicators?: Record<string, SessionIndicator>;
  workspaceId?: string;
  historyExpansionLoading?: boolean;
  historyPreviewLimit?: number;
  getSessionPath?: (sessionId: string) => string;
  getWorkspaceNewConversationPath?: (workspaceId?: string) => string;
  onDelete?: (id: string) => void;
  onCancelDelete?: () => void;
  onCancelRename?: () => void;
  onConfirmDelete?: (id: string) => void;
  onLoadHistoryExpansion?: () => Promise<void> | void;
  onNavigate?: (path: string) => void;
  onRename?: (id: string, title: string) => void;
  onStartRename?: (item: SiderEntry) => void;
  onUpdateRename?: (title: string) => void;
}

function HistoryBucket({
  title,
  kind,
  newConversationPath,
  onNavigate,
  children,
}: {
  title: string;
  kind: "workspace" | "chat";
  newConversationPath: string;
  onNavigate: (path: string) => void;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const bucketItemsId = useId();
  const newLabel = kind === "workspace" ? "新建项目对话" : "新建无项目对话";

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
  editing,
  confirmDeleteId,
  canMutate = false,
  sessionIndicators = {},
  workspaceId,
  historyExpansionLoading = false,
  historyPreviewLimit,
  getSessionPath = conversationPath,
  getWorkspaceNewConversationPath = newWorkspaceConversationPath,
  onDelete,
  onCancelDelete,
  onCancelRename,
  onConfirmDelete,
  onLoadHistoryExpansion,
  onNavigate,
  onRename,
  onStartRename,
  onUpdateRename,
}: SiderSectionProps) {
  const [hoveredSession, setHoveredSession] = useState<CollapsedSessionCard | null>(null);
  const [hoveredProject, setHoveredProject] = useState<CollapsedProjectCard | null>(null);
  const [sectionExpanded, setSectionExpanded] = useState(true);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [localHistoryExpansionLoading, setLocalHistoryExpansionLoading] = useState(false);
  const sectionItemsId = useId();
  const previousActivePathRef = useRef(activePath);
  const canToggleSection = kind === "workspace" && !disableSectionToggle;
  const normalizedHistoryLimit = Math.max(0, historyPreviewLimit ?? 0);
  const canPreviewWorkspaceHistory = !collapsed && kind === "workspace" && !hideTitle && normalizedHistoryLimit > 0;
  const shouldLimitHistory = canPreviewWorkspaceHistory && items.length > normalizedHistoryLimit;
  const previewItems = shouldLimitHistory ? items.slice(0, normalizedHistoryLimit) : items;
  const extraItems = shouldLimitHistory ? items.slice(normalizedHistoryLimit) : [];
  const historyToggleLoading = historyExpansionLoading || localHistoryExpansionLoading;

  useEffect(() => {
    const activePathChanged = previousActivePathRef.current !== activePath;
    previousActivePathRef.current = activePath;
    if (!canToggleSection || !activePathChanged) {
      return;
    }
    if (items.some((item) => isActivePath(activePath, getSessionPath(item.id)))) {
      setSectionExpanded(true);
    }
  }, [activePath, canToggleSection, getSessionPath, items]);

  useEffect(() => {
    if (!shouldLimitHistory && historyExpanded) {
      setHistoryExpanded(false);
    }
  }, [historyExpanded, shouldLimitHistory]);

  async function toggleHistoryExpansion() {
    if (historyExpanded) {
      setHistoryExpanded(false);
      return;
    }
    setHistoryExpanded(true);
    if (!onLoadHistoryExpansion) {
      return;
    }
    setLocalHistoryExpansionLoading(true);
    try {
      await onLoadHistoryExpansion();
    } finally {
      setLocalHistoryExpansionLoading(false);
    }
  }

  const showCollapsedCard = (item: SiderEntry, active: boolean, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    setHoveredProject(null);
    setHoveredSession({
      id: item.id,
      title: item.title,
      updatedAt: item.updatedAt,
      groupTitle: item.groupTitle,
      active,
      top: Math.round(rect.top + rect.height / 2),
    });
  };

  const showCollapsedProjectCard = (active: boolean, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    setHoveredSession(null);
    setHoveredProject({
      title,
      active,
      expanded: sectionExpanded,
      top: Math.round(rect.top + rect.height / 2),
    });
  };

  const renderHistoryRow = (item: SiderEntry) => {
    const path = getSessionPath(item.id);
    const active = isActivePath(activePath, path);
    const indicator = sessionIndicators[item.id] ?? EMPTY_SESSION_INDICATOR;
    const showUpdatedTime = Boolean(
      item.updatedAt && !indicator.isStreaming && !indicator.hasUnread && !indicator.waitingApproval,
    );
    const hasMeta = Boolean(showUpdatedTime || indicator.isStreaming || indicator.hasUnread || indicator.waitingApproval);
    return (
      <div className={styles.historyRow} key={item.id}>
        {editing?.id === item.id ? (
          <form
            className={styles.renameForm}
            onSubmit={(event) => {
              event.preventDefault();
              onRename?.(item.id, editing.title);
            }}
          >
            <input
              aria-label={`重命名 ${item.title}`}
              onChange={(event) => onUpdateRename?.(event.target.value)}
              value={editing.title}
            />
            <button aria-label="保存重命名" type="submit">
              <Check size={13} />
            </button>
            <button aria-label="取消重命名" onClick={onCancelRename} type="button">
              <X size={13} />
            </button>
          </form>
        ) : confirmDeleteId === item.id ? (
          <div className={styles.confirmRow}>
            <span>确认删除？</span>
            <button onClick={onCancelDelete} type="button">
              取消
            </button>
            <button onClick={() => onDelete?.(item.id)} type="button">
              确认
            </button>
          </div>
        ) : (
          <>
            <button
              className={styles.historyItem}
              type="button"
              aria-label={item.title}
              aria-current={active ? "page" : undefined}
              data-active={active ? "true" : "false"}
              onClick={() => onNavigate?.(path)}
            >
              <span className={styles.historyTitle}>{item.title}</span>
              {hasMeta ? (
                <span className={styles.historyMeta}>
                  {showUpdatedTime && item.updatedAt ? (
                    <time dateTime={item.updatedAt}>{formatRelativeTime(item.updatedAt)}</time>
                  ) : null}
                  <SessionStatusIndicators indicator={indicator} />
                </span>
              ) : null}
            </button>
            {canMutate ? (
              <div className={styles.historyActions}>
                <button aria-label={`重命名 ${item.title}`} onClick={() => onStartRename?.(item)} type="button">
                  <Pencil size={13} />
                </button>
                <button aria-label={`删除 ${item.title}`} onClick={() => onConfirmDelete?.(item.id)} type="button">
                  <Trash2 size={13} />
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    );
  };

  if (collapsed) {
    const collapsedProjectActive =
      canToggleSection && items.some((item) => isActivePath(activePath, getSessionPath(item.id)));
    return (
      <section className={styles.collapsedSection} aria-label={title} data-kind={kind}>
        {canToggleSection ? (
          <button
            className={styles.collapsedProjectButton}
            type="button"
            aria-controls={sectionItemsId}
            aria-expanded={sectionExpanded}
            aria-label={`${sectionExpanded ? "收起" : "展开"}项目 ${title}`}
            data-active={collapsedProjectActive ? "true" : "false"}
            onBlur={() => setHoveredProject(null)}
            onClick={() => setSectionExpanded((expanded) => !expanded)}
            onFocus={(event) => showCollapsedProjectCard(collapsedProjectActive, event.currentTarget)}
            onMouseEnter={(event) => showCollapsedProjectCard(collapsedProjectActive, event.currentTarget)}
            onMouseLeave={() => setHoveredProject(null)}
          >
            {sectionExpanded ? (
              <FolderOpen className={styles.collapsedProjectFolder} size={16} strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <Folder className={styles.collapsedProjectFolder} size={16} strokeWidth={1.8} aria-hidden="true" />
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
              const active = isActivePath(activePath, path);
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
                  onFocus={(event) => showCollapsedCard(item, active, event.currentTarget)}
                  onMouseEnter={(event) => showCollapsedCard(item, active, event.currentTarget)}
                  onMouseLeave={() => setHoveredSession(null)}
                  type="button"
                >
                  {indicator.isStreaming && !indicator.waitingApproval ? (
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
        {hoveredProject ? <CollapsedProjectCardView project={hoveredProject} /> : null}
        {hoveredSession ? <CollapsedSessionCardView session={hoveredSession} /> : null}
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
        <div className={styles.sectionTitleRow} data-kind={kind}>
          <button
            className={`${styles.sectionTitle} ${styles.projectSectionTitle}`}
            type="button"
            aria-controls={sectionItemsId}
            aria-expanded={sectionExpanded}
            aria-label={`${sectionExpanded ? "收起" : "展开"}项目 ${title}`}
            data-kind={kind}
            onClick={() => setSectionExpanded((expanded) => !expanded)}
          >
            {sectionExpanded ? (
              <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Folder size={15} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>{title}</span>
            <ChevronDown className={styles.sectionChevron} size={14} strokeWidth={1.9} aria-hidden="true" />
          </button>
          {workspaceId ? (
            <button
              className={styles.sectionNewButton}
              type="button"
              aria-label={`在项目 ${title} 中新建对话`}
              title={`在项目 ${title} 中新建对话`}
              onClick={() => onNavigate?.(getWorkspaceNewConversationPath(workspaceId))}
            >
              <SquarePen size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
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
                    aria-hidden={!historyExpanded}
                    data-history-extra-items="true"
                    data-expanded={historyExpanded ? "true" : "false"}
                  >
                    <div className={styles.historyExtraItemsInner}>{extraItems.map(renderHistoryRow)}</div>
                  </div>
                  <button
                    aria-expanded={historyExpanded}
                    aria-label={`${historyExpanded ? "折叠" : "展开"} ${title} 会话历史`}
                    className={styles.historyToggleButton}
                    disabled={historyToggleLoading}
                    onClick={() => void toggleHistoryExpansion()}
                    type="button"
                  >
                    {historyToggleLoading ? <LoaderCircle size={12} strokeWidth={2} aria-hidden="true" /> : null}
                    <span>{historyToggleLoading ? "加载中" : historyExpanded ? "折叠会话" : "展开会话"}</span>
                  </button>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
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
  if (!indicator.isStreaming && !indicator.hasUnread && !indicator.waitingApproval) {
    return null;
  }
  return (
    <span
      className={styles.historyIndicators}
      data-collapsed={collapsed ? "true" : "false"}
      data-session-indicators="true"
      data-streaming={indicator.isStreaming ? "true" : "false"}
      data-unread={indicator.hasUnread ? "true" : "false"}
      data-waiting-approval={indicator.waitingApproval ? "true" : "false"}
      aria-hidden={collapsed ? "true" : undefined}
    >
      {indicator.waitingApproval ? (
        collapsed ? (
          <span className={styles.historyApprovalDot} title="等待批准" />
        ) : (
          <span className={styles.historyApprovalBadge}>
            <ShieldCheck size={12} />
            <span>等待批准</span>
          </span>
        )
      ) : null}
      {indicator.isStreaming && !indicator.waitingApproval ? <span className={styles.historyStreamingSpinner} /> : null}
      {indicator.hasUnread ? <span className={styles.historyUnreadDot} /> : null}
    </span>
  );
}

interface CollapsedSessionCard {
  id: string;
  title: string;
  updatedAt?: string;
  groupTitle?: string;
  active: boolean;
  top: number;
}

interface CollapsedProjectCard {
  title: string;
  active: boolean;
  expanded: boolean;
  top: number;
}

function CollapsedProjectCardView({ project }: { project: CollapsedProjectCard }) {
  return (
    <div
      className={styles.collapsedSessionCard}
      role="tooltip"
      style={{ "--session-card-top": `${project.top}px` } as CSSProperties}
    >
      <div className={styles.collapsedSessionCardTitle}>{project.title}</div>
      <div className={styles.collapsedSessionCardMeta}>
        <span>{project.active ? "当前项目" : "项目"}</span>
        <span aria-hidden="true">·</span>
        <span>{project.expanded ? "已展开" : "已收起"}</span>
      </div>
    </div>
  );
}

function CollapsedSessionCardView({ session }: { session: CollapsedSessionCard }) {
  return (
    <div
      className={styles.collapsedSessionCard}
      role="tooltip"
      style={{ "--session-card-top": `${session.top}px` } as CSSProperties}
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

function sessionToEntry(session: AgentSession, groupTitle: string): SiderEntry {
  return {
    id: session.id,
    title: session.title || session.id,
    updatedAt: session.updated_at,
    groupTitle,
  };
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
        };
      group.title = meta.title;
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
    },
  ];
}

function sessionGroupMeta(session: AgentSession): Pick<SiderGroup, "id" | "title" | "kind" | "workspaceId"> {
  if (session.session_type === "workspace") {
    if (session.workspace) {
      return {
        id: `workspace:${session.workspace.id}`,
        title: session.workspace.name || session.workspace.root_path,
        kind: "workspace",
        workspaceId: session.workspace.id,
      };
    }
    return {
      id: `workspace:${session.workspace_id ?? "missing"}`,
      title: "工作区不可用",
      kind: "workspace",
    };
  }
  return {
    id: "chat",
    title: "对话",
    kind: "chat",
  };
}

function upsertSession(sessions: AgentSession[], session: AgentSession): AgentSession[] {
  return mergeSessions(sessions, [session]);
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

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "读取会话历史失败";
}
