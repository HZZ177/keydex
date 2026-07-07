import { AlertCircle, CheckCircle2, Clipboard, Download, FileJson, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { RuntimeBridge } from "@/runtime";
import { AppDialog, DialogButton } from "@/renderer/components/dialog";
import { SettingsSelect } from "@/renderer/pages/settings/components";
import type {
  McpExportResponse,
  McpImportConflictStrategy,
  McpImportPreviewResponse,
  McpImportSourceType,
  McpServerSummary,
} from "@/types/protocol";

import styles from "./McpConsolePage.module.css";
import { mcpErrorMessage } from "./mcpCopy";

interface McpImportDialogProps {
  runtime: RuntimeBridge;
  onClose: () => void;
  onImported: (response: McpImportPreviewResponse) => void;
}

interface McpExportDialogProps {
  runtime: RuntimeBridge;
  servers: McpServerSummary[];
  onClose: () => void;
}

type ExportFileState = "idle" | "saved" | "downloaded" | "cancelled" | "failed";

const IMPORT_SOURCES: Array<{ value: McpImportSourceType; label: string }> = [
  { value: "keydex", label: "Keydex JSON" },
  { value: "codex", label: "Codex 配置" },
  { value: "claude", label: "Claude Desktop" },
];

const CONFLICT_STRATEGIES: Array<{ value: McpImportConflictStrategy; label: string }> = [
  { value: "skip", label: "跳过同名" },
  { value: "rename", label: "重命名导入" },
  { value: "error", label: "冲突时报错" },
];

export function McpImportDialog({ runtime, onClose, onImported }: McpImportDialogProps) {
  const [sourceType, setSourceType] = useState<McpImportSourceType>("keydex");
  const [conflictStrategy, setConflictStrategy] = useState<McpImportConflictStrategy>("skip");
  const [configText, setConfigText] = useState("");
  const [preview, setPreview] = useState<McpImportPreviewResponse | null>(null);
  const [applied, setApplied] = useState<McpImportPreviewResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const confirmDisabled = useMemo(() => {
    if (!preview || busy || !preview.valid || preview.server_count === 0) {
      return true;
    }
    return preview.servers.some((server) => server.action === "error");
  }, [busy, preview]);

  const resetPreview = () => {
    setPreview(null);
    setApplied(null);
  };

  const parseConfig = (): Record<string, unknown> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configText);
    } catch {
      throw new Error("导入内容不是有效 JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("导入 JSON 顶层必须是对象");
    }
    return parsed as Record<string, unknown>;
  };

  const runPreview = async () => {
    setBusy(true);
    setError("");
    setApplied(null);
    try {
      const response = await runtime.mcp.importConfig({
        source_type: sourceType,
        conflict_strategy: conflictStrategy,
        confirm: false,
        config: parseConfig(),
      });
      setPreview(response);
    } catch (reason) {
      setPreview(null);
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await runtime.mcp.importConfig({
        source_type: sourceType,
        conflict_strategy: conflictStrategy,
        confirm: true,
        config: parseConfig(),
      });
      setPreview(response);
      setApplied(response);
      onImported(response);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      title="导入 MCP 配置"
      description="选择来源并预览后再写入全局 MCP 配置。"
      onClose={onClose}
      footer={(
        <>
          <DialogButton type="button" onClick={onClose}>
            关闭
          </DialogButton>
          <DialogButton type="button" disabled={busy} onClick={() => void runPreview()}>
            {busy ? "处理中" : "预览导入"}
          </DialogButton>
          <DialogButton
            tone="primary"
            type="button"
            disabled={confirmDisabled}
            onClick={() => void confirmImport()}
          >
            确认导入
          </DialogButton>
        </>
      )}
    >
      <div className={styles.importExportForm}>
        {error ? (
          <div className={styles.inlineError} role="alert">
            <AlertCircle size={15} />
            <span>{error}</span>
          </div>
        ) : null}
        {applied ? (
          <div className={styles.importExportNotice} role="status">
            <CheckCircle2 size={15} />
            <span>
              导入完成：创建 {applied.created_count ?? 0} 个，跳过 {applied.skipped_count ?? 0} 个
            </span>
          </div>
        ) : null}

        <div className={styles.importOptionsGrid}>
          <label className={styles.importExportField}>
            <span>来源</span>
            <SettingsSelect
              ariaLabel="MCP 导入来源"
              density="compact"
              options={IMPORT_SOURCES}
              value={sourceType}
              onChange={(value) => {
                setSourceType(value);
                resetPreview();
              }}
            />
          </label>
          <label className={styles.importExportField}>
            <span>冲突策略</span>
            <SettingsSelect
              ariaLabel="MCP 导入冲突策略"
              density="compact"
              options={CONFLICT_STRATEGIES}
              value={conflictStrategy}
              onChange={(value) => {
                setConflictStrategy(value);
                resetPreview();
              }}
            />
          </label>
        </div>

        <label className={styles.importExportField}>
          <span>JSON</span>
          <textarea
            aria-label="MCP 导入 JSON"
            value={configText}
            placeholder="粘贴 MCP 配置 JSON"
            onChange={(event) => {
              setConfigText(event.target.value);
              resetPreview();
            }}
          />
        </label>

        {busy ? (
          <div className={styles.importExportNotice} role="status">
            <LoaderCircle size={15} className={styles.spinning} />
            <span>处理中</span>
          </div>
        ) : null}
        {preview ? <ImportPreview preview={preview} /> : null}
      </div>
    </AppDialog>
  );
}

export function McpExportDialog({ runtime, servers, onClose }: McpExportDialogProps) {
  const [includeTrustRules, setIncludeTrustRules] = useState(false);
  const [selectedServerIds, setSelectedServerIds] = useState<string[]>(() => servers.map((server) => server.id));
  const [exported, setExported] = useState<McpExportResponse | null>(null);
  const [exportFilename, setExportFilename] = useState(() => createMcpExportFilename());
  const [error, setError] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [fileState, setFileState] = useState<ExportFileState>("idle");
  const [busy, setBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);

  const serialized = useMemo(
    () => (exported ? JSON.stringify(exported, null, 2) : ""),
    [exported],
  );
  const selectedServerIdSet = useMemo(() => new Set(selectedServerIds), [selectedServerIds]);
  const allServersSelected = servers.length > 0 && selectedServerIds.length === servers.length;
  const canGeneratePreview = servers.length > 0 && selectedServerIds.length > 0 && !busy;

  useEffect(() => {
    setSelectedServerIds((current) => {
      const availableIds = new Set(servers.map((server) => server.id));
      const retained = current.filter((serverId) => availableIds.has(serverId));
      return retained.length > 0 ? retained : servers.map((server) => server.id);
    });
  }, [servers]);

  const resetPreview = () => {
    setExported(null);
    setCopyState("idle");
    setFileState("idle");
  };

  const toggleServer = (serverId: string) => {
    resetPreview();
    setError("");
    setSelectedServerIds((current) => {
      const next = new Set(current);
      if (next.has(serverId)) {
        next.delete(serverId);
      } else {
        next.add(serverId);
      }
      return servers.filter((server) => next.has(server.id)).map((server) => server.id);
    });
  };

  const toggleAllServers = () => {
    resetPreview();
    setError("");
    setSelectedServerIds(allServersSelected ? [] : servers.map((server) => server.id));
  };

  const runExport = async () => {
    if (selectedServerIds.length === 0) {
      setError("请选择至少一个 MCP 服务器");
      return;
    }
    setBusy(true);
    setError("");
    setCopyState("idle");
    setFileState("idle");
    try {
      const response = await runtime.mcp.exportConfig({
        include_trust_rules: includeTrustRules,
        server_ids: selectedServerIds,
      });
      setExported(response);
      setExportFilename(createMcpExportFilename());
    } catch (reason) {
      setExported(null);
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const copyExport = async () => {
    if (!serialized) {
      return;
    }
    try {
      await navigator.clipboard.writeText(serialized);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const exportFile = async () => {
    if (!serialized) {
      return;
    }
    setFileBusy(true);
    setError("");
    setFileState("idle");
    try {
      const result = await saveMcpExportFile(serialized, exportFilename);
      setFileState(result);
    } catch {
      setFileState("failed");
      setError("导出文件失败");
    } finally {
      setFileBusy(false);
    }
  };

  return (
    <AppDialog
      title="导出 MCP 配置"
      description="选择服务器，生成预览后导出 Keydex MCP JSON。"
      onClose={onClose}
      footer={(
        <>
          <DialogButton type="button" onClick={onClose}>
            关闭
          </DialogButton>
          <DialogButton type="button" disabled={!canGeneratePreview} onClick={() => void runExport()}>
            {busy ? "生成中" : exported ? "重新生成预览" : "生成预览"}
          </DialogButton>
          <DialogButton
            tone="primary"
            type="button"
            disabled={!exported || fileBusy}
            onClick={() => void exportFile()}
          >
            {fileBusy ? "导出中" : "导出文件"}
          </DialogButton>
        </>
      )}
    >
      <div className={styles.importExportForm}>
        {error ? (
          <div className={styles.inlineError} role="alert">
            <AlertCircle size={15} />
            <span>{error}</span>
          </div>
        ) : null}
        <div className={styles.exportStep}>
          <div className={styles.exportStepHeader}>
            <div>
              <strong>选择 MCP 服务器</strong>
              <span>{selectedServerIds.length} / {servers.length} 个服务器</span>
            </div>
            <button type="button" disabled={servers.length === 0} onClick={toggleAllServers}>
              {allServersSelected ? "取消全选" : "全选"}
            </button>
          </div>
          {servers.length === 0 ? (
            <div className={styles.importExportNotice} role="status">
              <FileJson size={15} />
              <span>暂无可导出的 MCP 服务器。</span>
            </div>
          ) : (
            <div className={styles.exportServerList} role="group" aria-label="导出 MCP 服务器">
              {servers.map((server) => (
                <label key={server.id} className={styles.exportServerOption}>
                  <input
                    aria-label={`导出 MCP 服务器 ${server.name}`}
                    type="checkbox"
                    checked={selectedServerIdSet.has(server.id)}
                    onChange={() => toggleServer(server.id)}
                  />
                  <span>
                    <strong>{server.name}</strong>
                    <small>{transportLabel(server.transport)} · {server.enabled ? "已启用" : "已停用"}</small>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
        <label className={styles.importExportToggle}>
          <span>
            <strong>包含信任名单</strong>
            <small>导出服务器与工具授权配置时可附带信任名单。</small>
          </span>
          <input
            aria-label="导出包含信任名单"
            type="checkbox"
            checked={includeTrustRules}
            onChange={(event) => {
              setIncludeTrustRules(event.target.checked);
              resetPreview();
            }}
          />
        </label>
        <div className={styles.importExportNotice} role="status">
          <FileJson size={15} />
          <span>导出预览和文件都不包含密钥明文或 OAuth 令牌。</span>
        </div>
        {exported ? (
          <div className={styles.exportPreview} data-testid="mcp-export-preview">
            <div className={styles.exportPreviewHeader}>
              <div>
                <strong>导出预览</strong>
                <span>{exported.format} · {exported.servers.length} 个服务器</span>
              </div>
              <button type="button" onClick={() => void copyExport()}>
                <Clipboard size={14} />
                <span>复制 JSON</span>
              </button>
            </div>
            {copyState === "copied" ? <span className={styles.exportCopyState}>已复制</span> : null}
            {copyState === "failed" ? <span className={styles.exportCopyState}>复制失败</span> : null}
            {fileState === "saved" ? <span className={styles.exportCopyState}>文件已保存</span> : null}
            {fileState === "downloaded" ? <span className={styles.exportCopyState}>文件已下载</span> : null}
            {fileState === "cancelled" ? <span className={styles.exportCopyState}>已取消导出</span> : null}
            {fileState === "failed" ? <span className={styles.exportCopyState}>导出失败</span> : null}
            <pre>{serialized}</pre>
          </div>
        ) : null}
      </div>
    </AppDialog>
  );
}

async function saveMcpExportFile(contents: string, filename: string): Promise<ExportFileState> {
  const nativeResult = await saveTextWithNativeDialog(contents, filename);
  if (nativeResult !== "unavailable") {
    return nativeResult;
  }
  downloadTextFile(contents, filename);
  return "downloaded";
}

async function saveTextWithNativeDialog(
  contents: string,
  filename: string,
): Promise<"saved" | "cancelled" | "unavailable"> {
  if (!hasTauriInternals()) {
    return "unavailable";
  }
  try {
    const [{ save }, { invoke }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/api/core"),
    ]);
    const path = await save({
      defaultPath: filename,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) {
      return "cancelled";
    }
    await invoke("write_text_file", { path, contents });
    return "saved";
  } catch {
    return "unavailable";
  }
}

function hasTauriInternals(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function downloadTextFile(contents: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function createMcpExportFilename(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `keydex-mcp-${timestamp}.json`;
}

function ImportPreview({ preview }: { preview: McpImportPreviewResponse }) {
  return (
    <div className={styles.importPreview} data-testid="mcp-import-preview">
      <div className={styles.importPreviewSummary}>
        <span>{preview.server_count} 个服务器</span>
        <span>{preview.valid ? "校验通过" : "校验失败"}</span>
        <span>{preview.conflicts.length} 个冲突</span>
        <span>{preview.missing_secrets.length} 个待补密钥</span>
      </div>
      {preview.conflicts.length > 0 ? (
        <div className={styles.importPreviewWarning}>
          <strong>同名冲突</strong>
          <span>{preview.conflicts.join(", ")}</span>
        </div>
      ) : null}
      {preview.missing_secrets.length > 0 ? (
        <div className={styles.importPreviewWarning}>
          <strong>需重新配置密钥</strong>
          <span>{preview.missing_secrets.join(", ")}</span>
        </div>
      ) : null}
      {preview.unknown_fields.length > 0 ? (
        <div className={styles.importPreviewWarning} data-invalid="true">
          <strong>未知字段</strong>
          <span>{preview.unknown_fields.join(", ")}</span>
        </div>
      ) : null}
      <div className={styles.importPreviewList}>
        {preview.servers.map((server) => (
          <div key={`${server.name}-${server.action}`} className={styles.importPreviewRow}>
            <div>
              <strong>{server.name}</strong>
              <span>{transportLabel(server.transport)}</span>
            </div>
            <span className={styles.importActionBadge} data-action={server.action}>
              {importActionLabel(server.action)}
            </span>
            <span>{server.conflict ? "存在冲突" : "新建"}</span>
            <span>{server.enabled ? "已启用" : "已停用"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function transportLabel(value: string): string {
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

function importActionLabel(value: string): string {
  switch (value) {
    case "create":
      return "创建";
    case "skip":
      return "跳过";
    case "rename":
      return "重命名";
    case "error":
      return "错误";
    default:
      return value;
  }
}

function errorMessage(reason: unknown): string {
  return mcpErrorMessage(reason);
}
