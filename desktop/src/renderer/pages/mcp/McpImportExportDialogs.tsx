import { AlertCircle, CheckCircle2, Clipboard, FileJson, LoaderCircle } from "lucide-react";
import { useMemo, useState } from "react";

import type { RuntimeBridge } from "@/runtime";
import { AppDialog, DialogButton } from "@/renderer/components/dialog";
import { SettingsSelect } from "@/renderer/pages/settings/components";
import type {
  McpExportResponse,
  McpImportConflictStrategy,
  McpImportPreviewResponse,
  McpImportSourceType,
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
  onClose: () => void;
}

const IMPORT_SOURCES: Array<{ value: McpImportSourceType; label: string }> = [
  { value: "keydex", label: "Keydex JSON" },
  { value: "codex", label: "Codex config" },
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
              ariaLabel="MCP import source"
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
              ariaLabel="MCP import conflict strategy"
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
            aria-label="MCP import JSON"
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

export function McpExportDialog({ runtime, onClose }: McpExportDialogProps) {
  const [includeTrustRules, setIncludeTrustRules] = useState(false);
  const [exported, setExported] = useState<McpExportResponse | null>(null);
  const [error, setError] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [busy, setBusy] = useState(false);

  const serialized = useMemo(
    () => (exported ? JSON.stringify(exported, null, 2) : ""),
    [exported],
  );

  const runExport = async () => {
    setBusy(true);
    setError("");
    setCopyState("idle");
    try {
      const response = await runtime.mcp.exportConfig({
        include_trust_rules: includeTrustRules,
      });
      setExported(response);
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

  return (
    <AppDialog
      title="导出 MCP 配置"
      description="导出 Keydex MCP JSON。"
      onClose={onClose}
      footer={(
        <>
          <DialogButton type="button" onClick={onClose}>
            关闭
          </DialogButton>
          <DialogButton tone="primary" type="button" disabled={busy} onClick={() => void runExport()}>
            {busy ? "生成中" : "生成导出"}
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
        <label className={styles.importExportToggle}>
          <span>
            <strong>包含 trust rules</strong>
            <small>导出 server、tool policies、prompt policies 时可附带信任规则。</small>
          </span>
          <input
            aria-label="导出包含 trust rules"
            type="checkbox"
            checked={includeTrustRules}
            onChange={(event) => setIncludeTrustRules(event.target.checked)}
          />
        </label>
        <div className={styles.importExportNotice} role="status">
          <FileJson size={15} />
          <span>导出内容不包含 secret 明文或 OAuth token。</span>
        </div>
        {exported ? (
          <div className={styles.exportPreview} data-testid="mcp-export-preview">
            <div className={styles.exportPreviewHeader}>
              <div>
                <strong>{exported.format}</strong>
                <span>{exported.servers.length} servers</span>
              </div>
              <button type="button" onClick={() => void copyExport()}>
                <Clipboard size={14} />
                <span>复制</span>
              </button>
            </div>
            {copyState === "copied" ? <span className={styles.exportCopyState}>已复制</span> : null}
            {copyState === "failed" ? <span className={styles.exportCopyState}>复制失败</span> : null}
            <pre>{serialized}</pre>
          </div>
        ) : null}
      </div>
    </AppDialog>
  );
}

function ImportPreview({ preview }: { preview: McpImportPreviewResponse }) {
  return (
    <div className={styles.importPreview} data-testid="mcp-import-preview">
      <div className={styles.importPreviewSummary}>
        <span>{preview.server_count} servers</span>
        <span>{preview.valid ? "valid" : "invalid"}</span>
        <span>{preview.conflicts.length} conflicts</span>
        <span>{preview.missing_secrets.length} missing secrets</span>
      </div>
      {preview.conflicts.length > 0 ? (
        <div className={styles.importPreviewWarning}>
          <strong>同名冲突</strong>
          <span>{preview.conflicts.join(", ")}</span>
        </div>
      ) : null}
      {preview.missing_secrets.length > 0 ? (
        <div className={styles.importPreviewWarning}>
          <strong>需重新配置 secret</strong>
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
              <span>{server.transport}</span>
            </div>
            <span className={styles.importActionBadge} data-action={server.action}>
              {server.action}
            </span>
            <span>{server.conflict ? "conflict" : "new"}</span>
            <span>{server.enabled ? "enabled" : "disabled"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function errorMessage(reason: unknown): string {
  return mcpErrorMessage(reason);
}
