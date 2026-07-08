import {
  AlertCircle,
  Download,
  Pencil,
  Plus,
  RefreshCcw,
  Search,
  Server,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { ConfirmDialog } from "@/renderer/components/dialog";
import { LoadingSkeleton } from "@/renderer/components/loading";
import { SettingsSelect } from "@/renderer/pages/settings/components";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import type { RuntimeBridge } from "@/runtime";
import type {
  McpImportPreviewResponse,
  McpServerDetailResponse,
  McpServerStatus,
  McpServerSummary,
  McpTransport,
} from "@/types/protocol";

import { McpExportDialog, McpImportDialog } from "./McpImportExportDialogs";
import { McpLogsTab, McpPermissionsTab } from "./McpPolicyTabs";
import { McpServerFormDialog } from "./McpServerFormDialog";
import { McpToolsTab } from "./McpToolsTab";
import { mcpErrorMessage, mcpServerStatusLabel } from "./mcpCopy";
import styles from "./McpConsolePage.module.css";

const STATUS_FILTERS: Array<{ value: "all" | McpServerStatus; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "online", label: "在线" },
  { value: "offline", label: "离线" },
  { value: "auth_required", label: "需要认证" },
  { value: "error", label: "异常" },
  { value: "disabled", label: "已停用" },
  { value: "unknown", label: "未知" },
];

const TRANSPORT_FILTERS: Array<{ value: "all" | McpTransport; label: string }> = [
  { value: "all", label: "全部连接方式" },
  { value: "stdio", label: "本地命令" },
  { value: "streamable_http", label: "HTTP 地址" },
  { value: "sse", label: "SSE 地址" },
];

const DETAIL_TABS = [
  { id: "overview", label: "概览" },
  { id: "connection", label: "连接" },
  { id: "tools", label: "工具授权" },
  { id: "permissions", label: "权限" },
  { id: "logs", label: "日志" },
] as const;

type DetailTab = (typeof DETAIL_TABS)[number]["id"];
type ServerFormState = { mode: "create" } | { mode: "edit"; serverId: string } | null;
type LoadServersOptions = { showLoading?: boolean };
type ServerListOverride = Partial<Pick<McpServerSummary, "enabled" | "status">>;
type ServerContextMenuState = { serverId: string; left: number; top: number };
type RefreshServerOptions = { refreshDetail?: boolean; notifySuccess?: boolean };

export function McpConsolePage({ runtime }: { runtime: RuntimeBridge }) {
  const notifications = useNotifications();
  const serverContextMenuRef = useRef<HTMLDivElement | null>(null);
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | McpServerStatus>("all");
  const [transportFilter, setTransportFilter] = useState<"all" | McpTransport>("all");
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const [detailRefreshVersion, setDetailRefreshVersion] = useState(0);
  const [serverForm, setServerForm] = useState<ServerFormState>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [refreshingServerId, setRefreshingServerId] = useState("");
  const [togglingServerId, setTogglingServerId] = useState("");
  const [deletingServerId, setDeletingServerId] = useState("");
  const [deleteConfirmServer, setDeleteConfirmServer] = useState<McpServerSummary | null>(null);
  const [serverListOverrides, setServerListOverrides] = useState<Record<string, ServerListOverride>>({});
  const [serverContextMenu, setServerContextMenu] = useState<ServerContextMenuState | null>(null);

  const notifySuccess = useCallback((message: string) => {
    notifications.success(message);
  }, [notifications]);

  const loadServers = useCallback(async (preferredServerId?: string, options: LoadServersOptions = {}) => {
    const showLoading = options.showLoading !== false;
    if (showLoading) {
      setLoading(true);
    }
    setError("");
    try {
      const response = await runtime.mcp.listServers({ limit: 500 });
      setServers(response.list);
      setSelectedServerId((current) => {
        const target = preferredServerId || current;
        if (target && response.list.some((server) => server.id === target)) {
          return target;
        }
        return "";
      });
    } catch (reason) {
      setServers([]);
      setSelectedServerId("");
      setError(mcpErrorMessage(reason, "加载 MCP 服务器失败"));
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [runtime]);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  const displayedServers = useMemo(
    () => servers.map((server) => ({ ...server, ...(serverListOverrides[server.id] ?? {}) })),
    [serverListOverrides, servers],
  );

  const filteredServers = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return displayedServers.filter((server) => {
      if (
        statusFilter !== "all"
        && (statusFilter === "disabled"
          ? server.enabled && server.status !== "disabled"
          : server.status !== statusFilter)
      ) {
        return false;
      }
      if (transportFilter !== "all" && server.transport !== transportFilter) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      return `${server.name} ${server.description ?? ""} ${server.transport} ${server.status}`
        .toLowerCase()
        .includes(keyword);
    });
  }, [displayedServers, query, statusFilter, transportFilter]);

  const selectedServer = useMemo(
    () => filteredServers.find((server) => server.id === selectedServerId) ?? null,
    [filteredServers, selectedServerId],
  );
  const selectedServerDetailKey = selectedServer ? `${selectedServer.id}:${detailRefreshVersion}` : "";
  const isServerListLoading = loading || refreshing;
  const isSelectedServerRefreshing = selectedServer ? refreshingServerId === selectedServer.id : false;
  const serverContextMenuServer = serverContextMenu
    ? displayedServers.find((server) => server.id === serverContextMenu.serverId) ?? null
    : null;
  const summary = useMemo(
    () => ({
      total: displayedServers.length,
      online: displayedServers.filter((server) => server.status === "online").length,
      auth: displayedServers.filter((server) => server.status === "auth_required").length,
      disabled: displayedServers.filter((server) => !server.enabled || server.status === "disabled").length,
    }),
    [displayedServers],
  );

  const reloadServerList = async () => {
    setRefreshing(true);
    await loadServers(undefined, { showLoading: false });
    setRefreshing(false);
  };

  const openServerDetail = useCallback((serverId: string) => {
    setSelectedServerId(serverId);
    setDetailRefreshVersion((current) => current + 1);
  }, []);

  const closeServerContextMenu = useCallback(() => {
    setServerContextMenu(null);
  }, []);

  useEffect(() => {
    if (!serverContextMenu) {
      return;
    }

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && serverContextMenuRef.current?.contains(target)) {
        return;
      }
      closeServerContextMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeServerContextMenu();
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointerDown, true);
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("resize", closeServerContextMenu);
    window.addEventListener("scroll", closeServerContextMenu, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown, true);
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("resize", closeServerContextMenu);
      window.removeEventListener("scroll", closeServerContextMenu, true);
    };
  }, [closeServerContextMenu, serverContextMenu]);

  useEffect(() => {
    if (serverContextMenu && !displayedServers.some((server) => server.id === serverContextMenu.serverId)) {
      closeServerContextMenu();
    }
  }, [closeServerContextMenu, displayedServers, serverContextMenu]);

  const refreshServerById = useCallback(async (
    serverId: string,
    serverName: string,
    options: RefreshServerOptions = {},
  ) => {
    setRefreshingServerId(serverId);
    setServerListOverrides((current) => ({
      ...current,
      [serverId]: {
        ...current[serverId],
        status: "refreshing",
      },
    }));
    setError("");
    try {
      const result = await runtime.mcp.refreshServer(serverId);
      const statusLabel = result.status ? mcpServerStatusLabel(result.status) : "未知";
      const message = result.ok
        ? `服务器刷新完成，状态 ${statusLabel}`
        : mcpErrorMessage(result.error, `服务器刷新失败，状态 ${statusLabel}`);
      if (result.ok) {
        if (options.notifySuccess !== false) {
          notifications.success(message);
        }
      } else {
        notifications.error(message);
      }
      await loadServers(serverId, { showLoading: false });
      if (options.refreshDetail || selectedServerId === serverId) {
        setDetailRefreshVersion((current) => current + 1);
      }
    } catch (reason) {
      setError(mcpErrorMessage(reason, `刷新 MCP 服务器失败：${serverName}`));
    } finally {
      setRefreshingServerId("");
      setServerListOverrides((current) => withoutServerOverride(current, serverId));
    }
  }, [loadServers, notifications, runtime, selectedServerId]);

  const handleServerSaved = useCallback((server: McpServerDetailResponse) => {
    setQuery("");
    setStatusFilter("all");
    setTransportFilter("all");
    setServers((current) => upsertServerSummary(current, serverDetailToSummary(server)));
    setSelectedServerId(server.id);
    setDetailRefreshVersion((current) => current + 1);
    notifySuccess("MCP 服务器配置已保存，正在刷新服务器");
    void refreshServerById(server.id, server.name, { refreshDetail: true, notifySuccess: false });
  }, [notifySuccess, refreshServerById]);

  const handleImportApplied = useCallback((response: McpImportPreviewResponse) => {
    const preferredServerId = response.created?.[0]?.id;
    notifySuccess(
      `MCP 导入完成：创建 ${response.created_count ?? 0} 个，跳过 ${response.skipped_count ?? 0} 个`,
    );
    void loadServers(preferredServerId);
  }, [loadServers, notifySuccess]);

  const toggleServerEnabled = async (server: McpServerSummary) => {
    const nextEnabled = !server.enabled;
    setTogglingServerId(server.id);
    setServerListOverrides((current) => ({
      ...current,
      [server.id]: {
        enabled: nextEnabled,
        status: nextEnabled ? "refreshing" : "disabled",
      },
    }));
    if (nextEnabled) {
      setRefreshingServerId(server.id);
    }
    setError("");
    try {
      const updated = await runtime.mcp.toggleServer(server.id, nextEnabled);
      if (updated.enabled) {
        setRefreshingServerId(server.id);
        const result = await runtime.mcp.refreshServer(server.id);
        const statusLabel = result.status ? mcpServerStatusLabel(result.status) : "未知";
        if (result.ok) {
          notifySuccess(`MCP 服务器已启用并刷新：${updated.name}，状态 ${statusLabel}`);
        } else {
          notifySuccess(`MCP 服务器已启用：${updated.name}`);
          notifications.error(mcpErrorMessage(result.error, `服务器刷新失败，状态 ${statusLabel}`));
        }
        if (selectedServerId === server.id) {
          setDetailRefreshVersion((current) => current + 1);
        }
      } else {
        notifySuccess(`MCP 服务器已停用：${updated.name}`);
      }
      await loadServers(undefined, { showLoading: false });
      setServerListOverrides((current) => withoutServerOverride(current, server.id));
    } catch (reason) {
      setServerListOverrides((current) => withoutServerOverride(current, server.id));
      setError(mcpErrorMessage(reason, "切换 MCP 服务器启停失败"));
    } finally {
      setTogglingServerId("");
      setRefreshingServerId((current) => current === server.id ? "" : current);
    }
  };

  const refreshServer = async (server: McpServerSummary) => {
    await refreshServerById(server.id, server.name);
  };

  const openServerContextMenu = (event: ReactMouseEvent<HTMLElement>, server: McpServerSummary) => {
    event.preventDefault();
    event.stopPropagation();
    const left = clampMenuCoordinate(event.clientX, 168, window.innerWidth || document.documentElement.clientWidth);
    const top = clampMenuCoordinate(event.clientY, 112, window.innerHeight || document.documentElement.clientHeight);
    setServerContextMenu({
      serverId: server.id,
      left,
      top,
    });
  };

  const editServerFromMenu = (server: McpServerSummary) => {
    closeServerContextMenu();
    setServerForm({ mode: "edit", serverId: server.id });
  };

  const refreshServerFromMenu = (server: McpServerSummary) => {
    closeServerContextMenu();
    void refreshServer(server);
  };

  const deleteServerFromMenu = (server: McpServerSummary) => {
    closeServerContextMenu();
    setDeleteConfirmServer(server);
  };

  const deleteSelectedServer = async () => {
    const server = deleteConfirmServer;
    if (!server) {
      return;
    }
    setDeletingServerId(server.id);
    setError("");
    try {
      await runtime.mcp.deleteServer(server.id);
      setDeleteConfirmServer(null);
      notifySuccess(`MCP 服务器已删除：${server.name}`);
      await loadServers();
    } catch (reason) {
      setError(mcpErrorMessage(reason, "删除 MCP 服务器失败"));
    } finally {
      setDeletingServerId("");
    }
  };

  return (
    <div className={styles.page} data-has-error={error ? "true" : "false"} data-testid="mcp-console-page">
      <section className={styles.toolbar} aria-label="MCP 控制台工具栏">
        <div className={styles.titleBlock}>
          <h1>MCP</h1>
          <div className={styles.summaryRow} aria-label="MCP 服务摘要">
            <span>{summary.total} 个服务器</span>
            <span>{summary.online} 个在线</span>
            <span>{summary.auth} 个需认证</span>
            <span>{summary.disabled} 个停用</span>
          </div>
        </div>
        <div className={styles.actions}>
          <button
            className={styles.iconButton}
            type="button"
            aria-label="添加 MCP 服务器"
            onClick={() => setServerForm({ mode: "create" })}
          >
            <Plus size={16} />
            <span>添加</span>
          </button>
          <button
            className={styles.iconButton}
            type="button"
            aria-label="导入 MCP 配置"
            onClick={() => setImportDialogOpen(true)}
          >
            <Upload size={16} />
            <span>导入</span>
          </button>
          <button
            className={styles.iconButton}
            type="button"
            aria-label="导出 MCP 配置"
            onClick={() => setExportDialogOpen(true)}
          >
            <Download size={16} />
            <span>导出</span>
          </button>
          <button
            className={styles.iconButton}
            type="button"
            aria-label="刷新 MCP 服务器列表"
            disabled={refreshing}
            onClick={() => void reloadServerList()}
          >
            <RefreshCcw size={16} className={refreshing ? styles.spinning : undefined} />
            <span>刷新列表</span>
          </button>
        </div>
      </section>

      {error ? (
        <div className={styles.error} role="alert" data-testid="mcp-console-error">
          <AlertCircle size={16} />
          <span>{error}</span>
          <button type="button" onClick={() => void loadServers()}>
            重试
          </button>
        </div>
      ) : null}

      <section className={styles.consoleGrid}>
        <aside className={styles.serverPane} aria-label="MCP 服务器列表">
          <div className={styles.filterStack}>
            <label className={styles.searchBox}>
              <Search size={15} />
              <input
                aria-label="搜索 MCP 服务器"
                value={query}
                placeholder="搜索服务器"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className={styles.filterRow}>
              <SettingsSelect
                ariaLabel="筛选 MCP 服务器状态"
                density="compact"
                options={STATUS_FILTERS}
                value={statusFilter}
                onChange={(value) => setStatusFilter(value)}
              />
              <SettingsSelect
                ariaLabel="筛选 MCP 服务器连接方式"
                density="compact"
                options={TRANSPORT_FILTERS}
                value={transportFilter}
                onChange={(value) => setTransportFilter(value)}
              />
            </div>
          </div>

          <div className={styles.serverList} data-testid="mcp-server-list">
            {isServerListLoading ? <ServerListSkeleton /> : null}
            {!isServerListLoading && filteredServers.length === 0 ? (
              <div className={`${styles.emptyState} ${styles.serverListEmpty}`} data-testid="mcp-server-empty">
                <Server size={18} />
                <span>
                  {servers.length === 0
                    ? "还没有 MCP 服务器，可通过添加或导入配置开始使用"
                    : "没有匹配的 MCP 服务器"}
                </span>
              </div>
            ) : null}
            {!isServerListLoading
              ? filteredServers.map((server) => (
                  <article
                    key={server.id}
                    className={styles.serverItem}
                    data-app-context-menu="local"
                    data-active={selectedServer?.id === server.id ? "true" : "false"}
                    data-menu-open={serverContextMenu?.serverId === server.id ? "true" : undefined}
                    data-testid="mcp-server-item"
                    onContextMenu={(event) => openServerContextMenu(event, server)}
                  >
                    <button
                      type="button"
                      className={styles.serverSelectButton}
                      aria-label={`查看 MCP 服务器 ${server.name}`}
                      onClick={() => openServerDetail(server.id)}
                    >
                      <span className={styles.serverItemHeader}>
                        <span className={styles.serverName}>{server.name}</span>
                        <StatusBadge status={server.status} enabled={server.enabled} />
                      </span>
                      <span className={styles.serverMeta}>
                        <span>{server.transport}</span>
                        <span>{formatRefreshTime(server.last_refresh_at)}</span>
                      </span>
                      <span className={styles.serverStats} aria-label={`${server.name} MCP 工具可用统计`}>
                        <span>直接可用 {server.direct_tools_count ?? 0}</span>
                        <span>按需加载 {server.on_demand_tools_count ?? 0}</span>
                        <span>最近使用 {server.recently_used_tools_count ?? 0}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={styles.serverToggleButton}
                      role="switch"
                      aria-checked={server.enabled}
                      aria-label={`${server.enabled ? "停用" : "启用"} MCP 服务器 ${server.name}`}
                      disabled={togglingServerId === server.id || refreshingServerId === server.id}
                      onClick={() => void toggleServerEnabled(server)}
                    >
                      <span aria-hidden="true" className={styles.toggleTrack} data-checked={server.enabled ? "true" : "false"}>
                        <span className={styles.toggleThumb} />
                      </span>
                    </button>
                  </article>
                ))
              : null}
          </div>
        </aside>

        <main className={styles.detailPane} aria-label="MCP 服务器详情">
          {selectedServer ? (
            <>
              <header className={styles.detailHeader}>
                <div className={styles.detailTitleBlock}>
                  <div className={styles.detailTitleRow}>
                    <div className={styles.detailNameBlock}>
                      <h2>{selectedServer.name}</h2>
                      <p className={styles.detailSubtitle}>
                        {authTypeLabel(selectedServer.auth_type ?? "none")}
                      </p>
                    </div>
                    <div className={styles.detailMetrics}>
                      <Metric label="直接可用" value={selectedServer.direct_tools_count ?? 0} />
                      <Metric label="按需加载" value={selectedServer.on_demand_tools_count ?? 0} />
                      <Metric label="最近使用" value={selectedServer.recently_used_tools_count ?? 0} />
                      <Metric label="资源" value={hasReservedResources(selectedServer) ? "已预留" : "-"} />
                    </div>
                  </div>
                </div>
                <div className={styles.detailActions}>
                  <button
                    type="button"
                    aria-label="编辑 MCP 服务器连接"
                    onClick={() => setServerForm({ mode: "edit", serverId: selectedServer.id })}
                  >
                    <Pencil size={14} />
                    <span>编辑连接</span>
                  </button>
                  <button
                    type="button"
                    aria-label="刷新 MCP 服务器"
                    disabled={refreshingServerId === selectedServer.id}
                    onClick={() => void refreshServer(selectedServer)}
                  >
                    <RefreshCcw size={14} className={refreshingServerId === selectedServer.id ? styles.spinning : undefined} />
                    <span>刷新服务器</span>
                  </button>
                  <button
                    type="button"
                    className={styles.dangerAction}
                    aria-label="删除 MCP 服务器"
                    disabled={deletingServerId === selectedServer.id}
                    onClick={() => setDeleteConfirmServer(selectedServer)}
                  >
                    <Trash2 size={14} />
                    <span>{deletingServerId === selectedServer.id ? "删除中" : "删除"}</span>
                  </button>
                </div>
              </header>

              <nav className={styles.tabs} aria-label="MCP 服务器详情标签">
                {DETAIL_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    data-active={activeTab === tab.id ? "true" : "false"}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>

              <section className={styles.tabPanel} data-testid="mcp-detail-tabs">
                {isSelectedServerRefreshing ? (
                  <SkeletonTab label="detail-loading" testId="mcp-detail-loading" />
                ) : activeTab === "overview" ? (
                  <OverviewTab server={selectedServer} />
                ) : activeTab === "connection" ? (
                  <McpConnectionTab
                    key={`connection:${selectedServerDetailKey}`}
                    runtime={runtime}
                    server={selectedServer}
                  />
                ) : activeTab === "tools" ? (
                  <McpToolsTab
                    key={`tools:${selectedServerDetailKey}`}
                    runtime={runtime}
                    serverId={selectedServer.id}
                    onNotice={notifySuccess}
                  />
                ) : activeTab === "permissions" ? (
                  <McpPermissionsTab
                    key={`permissions:${selectedServerDetailKey}`}
                    runtime={runtime}
                    serverId={selectedServer.id}
                    onNotice={notifySuccess}
                  />
                ) : activeTab === "logs" ? (
                  <McpLogsTab key={`logs:${selectedServerDetailKey}`} runtime={runtime} serverId={selectedServer.id} />
                ) : (
                  <SkeletonTab label={activeTab} />
                )}
              </section>
            </>
          ) : (
            <div className={styles.detailEmpty} data-testid="mcp-detail-empty">
              <Server size={20} />
              <span>选择一个 MCP 服务器</span>
            </div>
          )}
        </main>
      </section>
      {serverContextMenu && serverContextMenuServer ? (
        <div
          ref={serverContextMenuRef}
          aria-label={`MCP 服务器 ${serverContextMenuServer.name} 操作菜单`}
          className={styles.serverContextMenu}
          data-app-context-menu="local"
          role="menu"
          style={
            {
              "--mcp-server-context-left": `${serverContextMenu.left}px`,
              "--mcp-server-context-top": `${serverContextMenu.top}px`,
            } as CSSProperties
          }
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button type="button" role="menuitem" onClick={() => editServerFromMenu(serverContextMenuServer)}>
            <Pencil size={14} />
            <span>编辑服务器</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={refreshingServerId === serverContextMenuServer.id}
            onClick={() => refreshServerFromMenu(serverContextMenuServer)}
          >
            <RefreshCcw size={14} className={refreshingServerId === serverContextMenuServer.id ? styles.spinning : undefined} />
            <span>刷新服务器</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-danger="true"
            disabled={deletingServerId === serverContextMenuServer.id}
            onClick={() => deleteServerFromMenu(serverContextMenuServer)}
          >
            <Trash2 size={14} />
            <span>删除服务器</span>
          </button>
        </div>
      ) : null}
      {serverForm ? (
        <McpServerFormDialog
          mode={serverForm.mode}
          runtime={runtime}
          serverId={serverForm.mode === "edit" ? serverForm.serverId : undefined}
          onClose={() => setServerForm(null)}
          onSaved={handleServerSaved}
        />
      ) : null}
      {importDialogOpen ? (
        <McpImportDialog
          runtime={runtime}
          onClose={() => setImportDialogOpen(false)}
          onImported={handleImportApplied}
        />
      ) : null}
      {exportDialogOpen ? (
        <McpExportDialog
          runtime={runtime}
          servers={displayedServers}
          onClose={() => setExportDialogOpen(false)}
        />
      ) : null}
      {deleteConfirmServer ? (
        <ConfirmDialog
          title="确认删除 MCP 服务器？"
          description="会删除该 MCP 服务器配置、状态、工具缓存和相关授权记录，操作不可撤销。"
          preview={`${deleteConfirmServer.name} / ${transportLabel(deleteConfirmServer.transport)}`}
          confirmLabel={deletingServerId === deleteConfirmServer.id ? "删除中" : "删除"}
          confirmTone="danger"
          cancelDisabled={deletingServerId === deleteConfirmServer.id}
          confirmDisabled={deletingServerId === deleteConfirmServer.id}
          onCancel={() => setDeleteConfirmServer(null)}
          onConfirm={() => void deleteSelectedServer()}
        />
      ) : null}
    </div>
  );
}

function OverviewTab({ server }: { server: McpServerSummary }) {
  return (
    <div className={styles.overviewGrid}>
      <InfoRow label="状态" value={mcpServerStatusLabel(server.status, server.enabled)} />
      <InfoRow label="连接方式" value={transportLabel(server.transport)} />
      <InfoRow label="启用" value={server.enabled ? "是" : "否"} />
      <InfoRow label="必需服务" value={server.required ? "是" : "否"} />
      <InfoRow label="最近刷新" value={formatRefreshTime(server.last_refresh_at)} />
      <InfoRow
        label="最近错误"
        value={
          server.last_error_code || server.last_error_message
            ? mcpErrorMessage({ code: server.last_error_code, message: server.last_error_message })
            : "-"
        }
        wide
      />
      {hasReservedResources(server) ? (
        <InfoRow label="资源" value="已支持，暂不开放读取" wide />
      ) : null}
    </div>
  );
}

function McpConnectionTab({
  runtime,
  server,
}: {
  runtime: RuntimeBridge;
  server: McpServerSummary;
}) {
  const [detail, setDetail] = useState<McpServerDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setDetail(await runtime.mcp.getServer(server.id));
    } catch (reason) {
      setError(mcpErrorMessage(reason, "加载 MCP 连接配置失败"));
    } finally {
      setLoading(false);
    }
  }, [runtime, server.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && detail === null) {
    return <SkeletonTab label="connection" />;
  }

  if (error && detail === null) {
    return (
      <div className={styles.inlineError} role="alert" data-testid="mcp-connection-error">
        <AlertCircle size={15} />
        <span>{error}</span>
        <button className={styles.smallToolButton} type="button" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }

  const current = detail ?? server;
  const authType = detail?.auth?.auth_type ?? detail?.auth_type ?? "none";
  const commonRows = [
    { label: "连接方式", value: transportLabel(current.transport) },
    { label: "状态", value: mcpServerStatusLabel(current.status, current.enabled) },
    { label: "连接模式", value: connectModeLabel(detail?.connect_mode) },
    { label: "重启策略", value: restartPolicyLabel(detail?.restart_policy) },
    { label: "最近连接", value: formatRefreshTime(current.last_connected_at) },
    { label: "最近刷新", value: formatRefreshTime(current.last_refresh_at) },
  ];
  const transportRows =
    current.transport === "stdio"
      ? [
          { label: "启动命令", value: detail?.command || "-" },
          { label: "参数", value: formatList(detail?.args) },
          { label: "工作目录", value: detail?.cwd || "-" },
          { label: "使用系统环境变量", value: detail?.inherit_environment ? "是" : "否" },
          { label: "环境变量", value: formatList(detail?.env_keys) },
        ]
      : current.transport === "sse"
        ? [
            { label: "SSE 地址", value: detail?.sse_url || "-" },
            { label: "消息地址", value: detail?.message_url || "-" },
            { label: "鉴权方式", value: authTypeLabel(authType) },
            { label: "固定请求头", value: formatList(detail?.header_keys) },
            { label: "来自环境变量的请求头", value: formatList(detail?.env_header_keys) },
            { label: "密钥引用", value: formatList(detail?.secret_ref_keys) },
          ]
        : [
            { label: "服务地址", value: detail?.url || "-" },
            { label: "鉴权方式", value: authTypeLabel(authType) },
            { label: "Bearer 令牌环境变量", value: detail?.auth?.bearer_token_env_var ?? detail?.bearer_token_env_var ?? "-" },
            { label: "固定请求头", value: formatList(detail?.header_keys) },
            { label: "来自环境变量的请求头", value: formatList(detail?.env_header_keys) },
            { label: "密钥引用", value: formatList(detail?.secret_ref_keys) },
            { label: "OAuth", value: detail?.oauth_configured ? "已配置" : "未配置" },
          ];
  const timeoutRows = detail
    ? [
        { label: "启动超时", value: `${detail.startup_timeout_sec}s` },
        { label: "工具超时", value: `${detail.tool_timeout_sec}s` },
        { label: "读取超时", value: `${detail.read_timeout_sec}s` },
        { label: "关闭超时", value: `${detail.shutdown_timeout_sec}s` },
      ]
    : [];

  return (
    <div className={styles.overviewGrid} data-testid="mcp-connection-tab">
      {[...commonRows, ...transportRows, ...timeoutRows].map((row) => (
        <InfoRow key={row.label} label={row.label} value={row.value} />
      ))}
      <InfoRow
        label="最近错误"
        value={
          current.last_error_code || current.last_error_message
            ? mcpErrorMessage({ code: current.last_error_code, message: current.last_error_message })
            : "-"
        }
        wide
      />
    </div>
  );
}

function hasReservedResources(server: McpServerSummary): boolean {
  return server.resources_reserved || (server.resources_reserved_count ?? 0) > 0;
}

function SkeletonTab({ label, testId }: { label: string; testId?: string }) {
  return (
    <LoadingSkeleton
      aria-label="加载 MCP 详情"
      className={styles.detailSkeleton}
      lineCount={5}
      testId={testId ?? `mcp-tab-${label}`}
      width="default"
    />
  );
}

function ServerListSkeleton() {
  return (
    <LoadingSkeleton
      aria-label="加载 MCP 服务器列表"
      className={styles.serverListSkeleton}
      lineCount={6}
      testId="mcp-server-loading"
      width="compact"
    />
  );
}

function StatusBadge({ status, enabled }: { status: McpServerStatus; enabled: boolean }) {
  return (
    <span className={styles.statusBadge} data-status={enabled ? status : "disabled"}>
      {mcpServerStatusLabel(status, enabled)}
    </span>
  );
}

function withoutServerOverride(
  overrides: Record<string, ServerListOverride>,
  serverId: string,
): Record<string, ServerListOverride> {
  if (!(serverId in overrides)) {
    return overrides;
  }
  const next = { ...overrides };
  delete next[serverId];
  return next;
}

function serverDetailToSummary(server: McpServerDetailResponse): McpServerSummary {
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    enabled: server.enabled,
    required: server.required,
    transport: server.transport,
    status: server.status,
    tools_count: server.tools_count,
    resources_reserved: server.resources_reserved,
    resources_reserved_count: server.resources_reserved_count,
    last_connected_at: server.last_connected_at,
    last_refresh_at: server.last_refresh_at,
    last_error_code: server.last_error_code,
    last_error_message: server.last_error_message,
    last_error_detail: server.last_error_detail,
    auth_type: server.auth_type ?? server.auth?.auth_type,
    created_at: server.created_at,
    updated_at: server.updated_at,
  };
}

function upsertServerSummary(
  servers: McpServerSummary[],
  server: McpServerSummary,
): McpServerSummary[] {
  const index = servers.findIndex((item) => item.id === server.id);
  if (index < 0) {
    return [server, ...servers];
  }
  const next = [...servers];
  next[index] = server;
  return next;
}

function clampMenuCoordinate(value: number, menuSize: number, viewportSize: number): number {
  const margin = 8;
  const max = Math.max(margin, viewportSize - menuSize - margin);
  return Math.round(Math.min(Math.max(value, margin), max));
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={styles.metric}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InfoRow({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div className={styles.infoRow} data-wide={wide ? "true" : "false"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatRefreshTime(value: string | null | undefined): string {
  if (!value) {
    return "从未";
  }
  return value.replace("T", " ").replace("Z", "");
}

function formatList(values: string[] | null | undefined): string {
  if (!values || values.length === 0) {
    return "-";
  }
  return values.join(", ");
}

function transportLabel(value: McpTransport): string {
  switch (value) {
    case "stdio":
      return "本地命令";
    case "streamable_http":
      return "HTTP 地址";
    case "sse":
      return "SSE 地址";
    default:
      return value;
  }
}

function connectModeLabel(value: string | null | undefined): string {
  switch (value) {
    case "startup":
      return "启动时连接";
    case "on_demand":
      return "按需连接";
    case "manual":
      return "手动连接";
    default:
      return "-";
  }
}

function restartPolicyLabel(value: string | null | undefined): string {
  switch (value) {
    case "never":
      return "不自动重启";
    case "on_failure":
      return "失败后重启";
    case "always":
      return "总是重启";
    default:
      return "-";
  }
}

function authTypeLabel(value: string | null | undefined): string {
  switch (value) {
    case "none":
      return "无鉴权";
    case "header_token":
      return "请求头令牌";
    case "bearer_env":
      return "Bearer 令牌";
    case "oauth":
      return "OAuth 授权";
    default:
      return "-";
  }
}
