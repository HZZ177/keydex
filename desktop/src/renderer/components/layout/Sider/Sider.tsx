import { Check, Folder, MessageCircle, Moon, Pencil, Search, Settings, Sun, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import { useTheme } from "@/renderer/providers/ThemeProvider";
import type { AgentSession } from "@/types/protocol";

import styles from "./Sider.module.css";

export interface SiderEntry {
  id: string;
  title: string;
  updatedAt?: string;
}

export interface SiderProps {
  collapsed?: boolean;
  projects?: SiderEntry[];
  conversations?: SiderEntry[];
  runtime?: RuntimeBridge;
  activePath?: string;
  onNavigate?: (path: string) => void;
}

const mainEntries = [
  { key: "quick-chat", label: "快速对话", path: "/guid", icon: MessageCircle },
  { key: "search", label: "搜索", path: "/search", icon: Search },
];

export function Sider({
  collapsed = false,
  projects = [],
  conversations,
  runtime = runtimeBridge,
  activePath = "",
  onNavigate,
}: SiderProps) {
  const { theme, toggleTheme } = useTheme();
  const ThemeIcon = theme === "dark" ? Sun : Moon;
  const [loadedConversations, setLoadedConversations] = useState<SiderEntry[]>([]);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const canMutateConversations =
    typeof runtime.conversation.updateSession === "function" && typeof runtime.conversation.deleteSession === "function";

  const controlled = conversations !== undefined;
  const historyItems = conversations ?? loadedConversations;
  const searchResults = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return historyItems;
    }
    return historyItems.filter((item) => `${item.title} ${item.id}`.toLowerCase().includes(keyword));
  }, [historyItems, query]);

  const navigateTo = (path: string) => {
    setSearchOpen(false);
    onNavigate?.(path);
  };

  useEffect(() => {
    if (controlled) {
      return;
    }
    let active = true;
    setLoadingHistory(true);
    setHistoryError(null);
    void runtime.conversation
      .listSessions({ pageSize: 50 })
      .then((response) => {
        if (active) {
          setLoadedConversations(response.list.map(sessionToEntry).sort(compareEntryUpdatedAt));
        }
      })
      .catch((reason) => {
        if (active) {
          setHistoryError(errorMessage(reason));
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
  }, [controlled, runtime]);

  async function renameConversation(id: string, title: string) {
    const cleaned = title.trim();
    if (!cleaned) {
      setHistoryError("会话标题不能为空");
      return;
    }
    setHistoryError(null);
    if (!canMutateConversations) {
      setHistoryError("当前后端不支持重命名会话");
      return;
    }
    try {
      const updated = await runtime.conversation.updateSession(id, { title: cleaned });
      setLoadedConversations((items) => upsertEntry(items, sessionToEntry(updated)));
      setEditing(null);
    } catch (reason) {
      setHistoryError(errorMessage(reason));
    }
  }

  async function deleteConversation(id: string) {
    setHistoryError(null);
    if (!canMutateConversations) {
      setHistoryError("当前后端不支持删除会话");
      return;
    }
    try {
      await runtime.conversation.deleteSession(id);
      setLoadedConversations((items) => items.filter((item) => item.id !== id));
      setConfirmDeleteId(null);
      if (isActivePath(activePath, conversationPath(id))) {
        onNavigate?.("/guid");
      }
    } catch (reason) {
      setHistoryError(errorMessage(reason));
    }
  }

  return (
    <aside className={styles.sider} aria-label="侧边栏" data-collapsed={collapsed ? "true" : "false"}>
      <nav className={styles.nav} aria-label="主导航">
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

      <div className={styles.history} aria-label="会话历史">
        <ProjectSection title="项目" items={projects} collapsed={collapsed} />
        {historyError && !collapsed ? <div className={styles.error} role="alert">{historyError}</div> : null}
        <SiderSection
          title="对话"
          items={historyItems}
          collapsed={collapsed}
          emptyText={loadingHistory ? "正在加载会话" : "暂无会话"}
          activePath={activePath}
          editing={editing}
          confirmDeleteId={confirmDeleteId}
          canMutate={canMutateConversations}
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
          onClick={() => onNavigate?.("/settings/model")}
        >
          <Settings size={17} strokeWidth={2} />
          <span>设置</span>
        </button>
      </div>

      {searchOpen ? (
        <SessionSearchDialog
          conversations={searchResults}
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
  loading,
  onClose,
  onNavigate,
  onQueryChange,
  query,
}: {
  conversations: SiderEntry[];
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
            placeholder="搜索会话或打开快速对话"
            value={query}
          />
          <button aria-label="关闭搜索" type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className={styles.searchQuickActions}>
          <button type="button" onClick={() => onNavigate("/guid")}>
            <MessageCircle size={15} />
            <span>新建快速对话</span>
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
              onClick={() => onNavigate(conversationPath(item.id))}
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

function ProjectSection({
  title,
  items,
  collapsed,
}: {
  title: string;
  items: SiderEntry[];
  collapsed: boolean;
}) {
  if (collapsed) {
    return null;
  }
  if (items.length === 0) {
    return null;
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionTitle}>{title}</div>
      {items.map((item) => (
          <div className={styles.projectItem} key={item.id} title={item.title}>
            <Folder size={16} />
            <span>{item.title}</span>
          </div>
      ))}
    </section>
  );
}

interface SiderSectionProps {
  title: string;
  items: SiderEntry[];
  collapsed: boolean;
  emptyText: string;
  activePath?: string;
  editing?: { id: string; title: string } | null;
  confirmDeleteId?: string | null;
  canMutate?: boolean;
  onDelete?: (id: string) => void;
  onCancelDelete?: () => void;
  onCancelRename?: () => void;
  onConfirmDelete?: (id: string) => void;
  onNavigate?: (path: string) => void;
  onRename?: (id: string, title: string) => void;
  onStartRename?: (item: SiderEntry) => void;
  onUpdateRename?: (title: string) => void;
}

function SiderSection({
  title,
  items,
  collapsed,
  emptyText,
  activePath = "",
  editing,
  confirmDeleteId,
  canMutate = false,
  onDelete,
  onCancelDelete,
  onCancelRename,
  onConfirmDelete,
  onNavigate,
  onRename,
  onStartRename,
  onUpdateRename,
}: SiderSectionProps) {
  if (collapsed) {
    return null;
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionTitle}>{title}</div>
      {items.length === 0 ? (
        <div className={styles.empty}>{emptyText}</div>
      ) : (
        items.map((item) => {
          const path = conversationPath(item.id);
          const active = isActivePath(activePath, path);
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
                  <button onClick={() => onDelete?.(item.id)} type="button">
                    确认
                  </button>
                  <button onClick={onCancelDelete} type="button">
                    取消
                  </button>
                </div>
              ) : (
                <>
                  <button
                    className={styles.historyItem}
                    type="button"
                    title={item.title}
                    aria-current={active ? "page" : undefined}
                    data-active={active ? "true" : "false"}
                    onClick={() => onNavigate?.(path)}
                  >
                    <span>{item.title}</span>
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
        })
      )}
    </section>
  );
}

function sessionToEntry(session: AgentSession): SiderEntry {
  return {
    id: session.id,
    title: session.title || session.id,
    updatedAt: session.updated_at,
  };
}

function conversationPath(id: string): string {
  return `/conversation/${encodeURIComponent(id)}`;
}

function upsertEntry(items: SiderEntry[], entry: SiderEntry): SiderEntry[] {
  return items.map((item) => (item.id === entry.id ? entry : item)).sort(compareEntryUpdatedAt);
}

function compareEntryUpdatedAt(left: SiderEntry, right: SiderEntry): number {
  return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
}

function formatRelativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function isActivePath(activePath: string, path: string): boolean {
  return activePath === path;
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
