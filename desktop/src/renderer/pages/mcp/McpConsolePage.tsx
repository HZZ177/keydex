import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Download,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCcw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ConfirmDialog } from "@/renderer/components/dialog";
import type { RuntimeBridge } from "@/runtime";
import type {
  McpImportPreviewResponse,
  McpServerDetailResponse,
  McpServerStatus,
  McpServerSummary,
  McpTransport,
} from "@/types/protocol";

import { McpExportDialog, McpImportDialog } from "./McpImportExportDialogs";
import { McpLogsTab, McpRuntimePolicyTab, McpTrustTab } from "./McpPolicyTabs";
import { McpServerFormDialog } from "./McpServerFormDialog";
import { McpPromptsTab } from "./McpPromptsTab";
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
  { value: "all", label: "全部传输" },
  { value: "stdio", label: "stdio" },
  { value: "streamable_http", label: "HTTP" },
  { value: "sse", label: "SSE" },
];

const DETAIL_TABS = [
  { id: "overview", label: "概览" },
  { id: "connection", label: "连接" },
  { id: "tools", label: "Tools" },
  { id: "prompts", label: "Prompts" },
  { id: "trust", label: "审批与信任" },
  { id: "runtime", label: "运行策略" },
  { id: "logs", label: "日志" },
] as const;

type DetailTab = (typeof DETAIL_TABS)[number]["id"];
type ServerFormState = { mode: "create" } | { mode: "edit"; serverId: string } | null;

export function McpConsolePage({ runtime }: { runtime: RuntimeBridge }) {
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | McpServerStatus>("all");
  const [transportFilter, setTransportFilter] = useState<"all" | McpTransport>("all");
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const [serverForm, setServerForm] = useState<ServerFormState>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [testingServerId, setTestingServerId] = useState("");
  const [deletingServerId, setDeletingServerId] = useState("");
  const [deleteConfirmServer, setDeleteConfirmServer] = useState<McpServerSummary | null>(null);
  const [operationMessage, setOperationMessage] = useState("");

  const loadServers = useCallback(async (preferredServerId?: string) => {
    setLoading(true);
    setError("");
    try {
      const response = await runtime.mcp.listServers({ limit: 500 });
      setServers(response.list);
      setSelectedServerId((current) => {
        const target = preferredServerId || current;
        if (target && response.list.some((server) => server.id === target)) {
          return target;
        }
        return response.list[0]?.id ?? "";
      });
    } catch (reason) {
      setServers([]);
      setSelectedServerId("");
      setError(mcpErrorMessage(reason, "加载 MCP 服务器失败"));
    } finally {
      setLoading(false);
    }
  }, [runtime]);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  const filteredServers = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return servers.filter((server) => {
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
  }, [query, servers, statusFilter, transportFilter]);

  const selectedServer = useMemo(
    () => filteredServers.find((server) => server.id === selectedServerId) ?? filteredServers[0] ?? null,
    [filteredServers, selectedServerId],
  );
  const summary = useMemo(
    () => ({
      total: servers.length,
      online: servers.filter((server) => server.status === "online").length,
      auth: servers.filter((server) => server.status === "auth_required").length,
      disabled: servers.filter((server) => !server.enabled || server.status === "disabled").length,
    }),
    [servers],
  );

  const refreshAll = async () => {
    setRefreshing(true);
    setError("");
    setOperationMessage("");
    try {
      await runtime.mcp.refreshServers();
      await loadServers();
    } catch (reason) {
      setError(mcpErrorMessage(reason, "刷新 MCP 服务器失败"));
    } finally {
      setRefreshing(false);
    }
  };

  const handleServerSaved = useCallback((server: McpServerDetailResponse) => {
    setSelectedServerId(server.id);
    setOperationMessage("MCP Server 配置已保存");
    void loadServers(server.id);
  }, [loadServers]);

  const handleImportApplied = useCallback((response: McpImportPreviewResponse) => {
    const preferredServerId = response.created?.[0]?.id;
    setOperationMessage(
      `MCP 导入完成：创建 ${response.created_count ?? 0} 个，跳过 ${response.skipped_count ?? 0} 个`,
    );
    void loadServers(preferredServerId);
  }, [loadServers]);

  const testSelectedServer = async (server: McpServerSummary) => {
    setTestingServerId(server.id);
    setOperationMessage("");
    setError("");
    try {
      const result = await runtime.mcp.testServer(server.id);
      setOperationMessage(
        result.ok
          ? `连接测试通过，状态 ${result.status}`
          : result.error?.message || `连接测试失败，状态 ${result.status}`,
      );
      await loadServers(server.id);
    } catch (reason) {
      setError(mcpErrorMessage(reason, "测试 MCP 服务器连接失败"));
    } finally {
      setTestingServerId("");
    }
  };

  const deleteSelectedServer = async () => {
    const server = deleteConfirmServer;
    if (!server) {
      return;
    }
    setDeletingServerId(server.id);
    setOperationMessage("");
    setError("");
    try {
      await runtime.mcp.deleteServer(server.id);
      setDeleteConfirmServer(null);
      setOperationMessage(`MCP Server 已删除：${server.name}`);
      await loadServers();
    } catch (reason) {
      setError(mcpErrorMessage(reason, "删除 MCP 服务器失败"));
    } finally {
      setDeletingServerId("");
    }
  };

  return (
    <div className={styles.page} data-testid="mcp-console-page">
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
            aria-label="添加 MCP Server"
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
            aria-label="刷新全部 MCP Server"
            disabled={refreshing}
            onClick={() => void refreshAll()}
          >
            <RefreshCcw size={16} className={refreshing ? styles.spinning : undefined} />
            <span>刷新</span>
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
      {operationMessage ? (
        <div className={styles.notice} role="status">
          <ShieldCheck size={16} />
          <span>{operationMessage}</span>
        </div>
      ) : null}

      <section className={styles.consoleGrid}>
        <aside className={styles.serverPane} aria-label="MCP Server 列表">
          <div className={styles.filterStack}>
            <label className={styles.searchBox}>
              <Search size={15} />
              <input
                aria-label="搜索 MCP Server"
                value={query}
                placeholder="搜索 server"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className={styles.filterRow}>
              <select
                aria-label="筛选 MCP Server 状态"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as "all" | McpServerStatus)}
              >
                {STATUS_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="筛选 MCP Server transport"
                value={transportFilter}
                onChange={(event) => setTransportFilter(event.target.value as "all" | McpTransport)}
              >
                {TRANSPORT_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className={styles.serverList} data-testid="mcp-server-list">
            {loading ? <ServerListSkeleton /> : null}
            {!loading && filteredServers.length === 0 ? (
              <div className={styles.emptyState} data-testid="mcp-server-empty">
                <Server size={18} />
                <span>
                  {servers.length === 0
                    ? "还没有 MCP 服务器，可通过添加或导入配置开始使用"
                    : "没有匹配的 MCP 服务器"}
                </span>
              </div>
            ) : null}
            {!loading
              ? filteredServers.map((server) => (
                  <button
                    key={server.id}
                    type="button"
                    className={styles.serverItem}
                    data-active={selectedServer?.id === server.id ? "true" : "false"}
                    data-testid="mcp-server-item"
                    onClick={() => setSelectedServerId(server.id)}
                  >
                    <span className={styles.serverItemHeader}>
                      <span className={styles.serverName}>{server.name}</span>
                      <StatusBadge status={server.status} enabled={server.enabled} />
                    </span>
                    <span className={styles.serverMeta}>
                      <span>{server.transport}</span>
                      <span>{server.enabled ? "已启用" : "已停用"}</span>
                      <span>{formatRefreshTime(server.last_refresh_at)}</span>
                    </span>
                  </button>
                ))
              : null}
          </div>
        </aside>

        <main className={styles.detailPane} aria-label="MCP Server 详情">
          {selectedServer ? (
            <>
              <header className={styles.detailHeader}>
                <div>
                  <div className={styles.detailKicker}>
                    <StatusIcon status={selectedServer.status} enabled={selectedServer.enabled} />
                    <span>{selectedServer.transport}</span>
                  </div>
                  <h2>{selectedServer.name}</h2>
                </div>
                <div className={styles.detailHeaderSide}>
                  <div className={styles.detailActions}>
                    <button
                      type="button"
                      aria-label="编辑 MCP Server 连接"
                      onClick={() => setServerForm({ mode: "edit", serverId: selectedServer.id })}
                    >
                      <Pencil size={14} />
                      <span>编辑连接</span>
                    </button>
                    <button
                      type="button"
                      aria-label="测试 MCP Server 连接"
                      disabled={testingServerId === selectedServer.id}
                      onClick={() => void testSelectedServer(selectedServer)}
                    >
                      <RefreshCcw size={14} className={testingServerId === selectedServer.id ? styles.spinning : undefined} />
                      <span>{testingServerId === selectedServer.id ? "测试中" : "测试连接"}</span>
                    </button>
                    <button
                      type="button"
                      className={styles.dangerAction}
                      aria-label="删除 MCP Server"
                      disabled={deletingServerId === selectedServer.id}
                      onClick={() => setDeleteConfirmServer(selectedServer)}
                    >
                      <Trash2 size={14} />
                      <span>{deletingServerId === selectedServer.id ? "删除中" : "删除"}</span>
                    </button>
                  </div>
                  <div className={styles.detailMetrics}>
                    <Metric label="Tools" value={selectedServer.tools_count} />
                    <Metric label="Prompts" value={selectedServer.prompts_count} />
                    <Metric label="Resources" value={hasReservedResources(selectedServer) ? "reserved" : "-"} />
                  </div>
                </div>
              </header>

              <nav className={styles.tabs} aria-label="MCP Server 详情标签">
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
                {activeTab === "overview" ? (
                  <OverviewTab server={selectedServer} />
                ) : activeTab === "tools" ? (
                  <McpToolsTab
                    runtime={runtime}
                    serverId={selectedServer.id}
                    onNotice={setOperationMessage}
                  />
                ) : activeTab === "prompts" ? (
                  <McpPromptsTab
                    runtime={runtime}
                    serverId={selectedServer.id}
                    onNotice={setOperationMessage}
                  />
                ) : activeTab === "trust" ? (
                  <McpTrustTab
                    runtime={runtime}
                    serverId={selectedServer.id}
                    onNotice={setOperationMessage}
                  />
                ) : activeTab === "runtime" ? (
                  <McpRuntimePolicyTab
                    runtime={runtime}
                    serverId={selectedServer.id}
                    onNotice={setOperationMessage}
                  />
                ) : activeTab === "logs" ? (
                  <McpLogsTab runtime={runtime} serverId={selectedServer.id} />
                ) : (
                  <SkeletonTab label={activeTab} />
                )}
              </section>
            </>
          ) : (
            <div className={styles.detailEmpty} data-testid="mcp-detail-empty">
              <Server size={20} />
              <span>选择一个 MCP Server</span>
            </div>
          )}
        </main>
      </section>
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
          onClose={() => setExportDialogOpen(false)}
        />
      ) : null}
      {deleteConfirmServer ? (
        <ConfirmDialog
          title="确认删除 MCP Server？"
          description="会删除该 MCP Server 配置、状态、工具缓存和相关策略记录，操作不可撤销。"
          preview={`${deleteConfirmServer.name} / ${deleteConfirmServer.transport}`}
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
      <InfoRow label="Transport" value={server.transport} />
      <InfoRow label="启用" value={server.enabled ? "是" : "否"} />
      <InfoRow label="Required" value={server.required ? "是" : "否"} />
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
        <InfoRow label="Resources" value="supported, reserved" wide />
      ) : null}
    </div>
  );
}

function hasReservedResources(server: McpServerSummary): boolean {
  return server.resources_reserved || (server.resources_reserved_count ?? 0) > 0;
}

function SkeletonTab({ label }: { label: string }) {
  return (
    <div className={styles.skeletonTab} data-testid={`mcp-tab-${label}`}>
      <div />
      <div />
      <div />
    </div>
  );
}

function ServerListSkeleton() {
  return (
    <div className={styles.loadingList} data-testid="mcp-server-loading">
      <LoaderCircle size={16} className={styles.spinning} />
      <span>加载中</span>
    </div>
  );
}

function StatusBadge({ status, enabled }: { status: McpServerStatus; enabled: boolean }) {
  return (
    <span className={styles.statusBadge} data-status={enabled ? status : "disabled"}>
      {mcpServerStatusLabel(status, enabled)}
    </span>
  );
}

function StatusIcon({ status, enabled }: { status: McpServerStatus; enabled: boolean }) {
  if (!enabled || status === "disabled") {
    return <Clock3 size={14} />;
  }
  if (status === "online") {
    return <CheckCircle2 size={14} />;
  }
  return <AlertCircle size={14} />;
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
    return "never";
  }
  return value.replace("T", " ").replace("Z", "");
}
