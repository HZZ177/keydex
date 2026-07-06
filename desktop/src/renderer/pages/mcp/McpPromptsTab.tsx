import {
  AlertCircle,
  Clipboard,
  FileText,
  LoaderCircle,
  RefreshCcw,
  Search,
  SendToBack,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { RuntimeBridge } from "@/runtime";
import { emitInsertMcpPromptDraft } from "@/renderer/events/mcpPromptDraft";
import type {
  McpPromptDiscoveryStatus,
  McpPromptExposureMode,
  McpPromptMaterializeResponse,
  McpPromptSummary,
} from "@/types/protocol";

import styles from "./McpConsolePage.module.css";

const PROMPT_STATUS_OPTIONS: Array<{ value: "all" | McpPromptDiscoveryStatus; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "available", label: "available" },
  { value: "removed", label: "removed" },
  { value: "error", label: "error" },
  { value: "unknown", label: "unknown" },
];

const PROMPT_ENABLED_OPTIONS = [
  { value: "all", label: "全部启用状态" },
  { value: "enabled", label: "enabled" },
  { value: "disabled", label: "disabled" },
] as const;

const EXPOSURE_OPTIONS: Array<{ value: "all" | McpPromptExposureMode; label: string }> = [
  { value: "all", label: "全部暴露方式" },
  { value: "manual", label: "manual" },
  { value: "slash_command", label: "slash command" },
  { value: "agent_selectable", label: "agent selectable" },
  { value: "hidden", label: "hidden" },
];

type ArgumentValue = string | boolean;

interface MaterializedPrompt {
  promptId: string;
  response: McpPromptMaterializeResponse;
  text: string;
}

export function McpPromptsTab({
  runtime,
  serverId,
  onNotice,
}: {
  runtime: RuntimeBridge;
  serverId: string;
  onNotice: (message: string) => void;
}) {
  const [prompts, setPrompts] = useState<McpPromptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | McpPromptDiscoveryStatus>("all");
  const [enabledFilter, setEnabledFilter] = useState<(typeof PROMPT_ENABLED_OPTIONS)[number]["value"]>("all");
  const [exposureFilter, setExposureFilter] = useState<"all" | McpPromptExposureMode>("all");
  const [activePromptId, setActivePromptId] = useState("");
  const [argumentValues, setArgumentValues] = useState<Record<string, Record<string, ArgumentValue>>>({});
  const [materializedPrompt, setMaterializedPrompt] = useState<MaterializedPrompt | null>(null);
  const [busyKey, setBusyKey] = useState("");

  const loadPrompts = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await runtime.mcp.listPrompts(serverId, {
        search: query.trim() || undefined,
        status: statusFilter === "all" ? undefined : statusFilter,
        enabled: enabledFilter === "all" ? undefined : enabledFilter === "enabled",
        limit: 500,
      });
      setPrompts(response.list);
      setActivePromptId((current) => {
        if (current && response.list.some((prompt) => prompt.id === current)) {
          return current;
        }
        return response.list[0]?.id ?? "";
      });
      setMaterializedPrompt((current) => {
        if (!current) {
          return null;
        }
        return response.list.some((prompt) => prompt.id === current.promptId) ? current : null;
      });
    } catch (reason) {
      setPrompts([]);
      setActivePromptId("");
      setMaterializedPrompt(null);
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [enabledFilter, query, runtime, serverId, statusFilter]);

  useEffect(() => {
    void loadPrompts();
  }, [loadPrompts]);

  const visiblePrompts = useMemo(() => {
    if (exposureFilter === "all") {
      return prompts;
    }
    return prompts.filter((prompt) => prompt.exposure_mode === exposureFilter);
  }, [exposureFilter, prompts]);
  const activePrompt = useMemo(
    () => visiblePrompts.find((prompt) => prompt.id === activePromptId) ?? visiblePrompts[0] ?? null,
    [activePromptId, visiblePrompts],
  );
  const activeArgumentDefinitions = useMemo(
    () => (activePrompt ? promptArgumentDefinitions(activePrompt.arguments_schema) : []),
    [activePrompt],
  );

  const replacePrompt = (nextPrompt: McpPromptSummary) => {
    setPrompts((current) => current.map((prompt) => (prompt.id === nextPrompt.id ? nextPrompt : prompt)));
  };

  const updatePromptExposure = async (prompt: McpPromptSummary, exposureMode: McpPromptExposureMode) => {
    setBusyKey(`policy:${prompt.id}`);
    setError("");
    try {
      const updated = await runtime.mcp.updatePromptPolicy(serverId, prompt.id, {
        exposure_mode: exposureMode,
      });
      replacePrompt(updated);
      onNotice(`Prompt 暴露策略已更新：${updated.raw_name} -> ${exposureMode}`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyKey("");
    }
  };

  const updateArgumentValue = (promptId: string, name: string, value: ArgumentValue) => {
    setArgumentValues((current) => ({
      ...current,
      [promptId]: {
        ...(current[promptId] ?? {}),
        [name]: value,
      },
    }));
  };

  const getPrompt = async (prompt: McpPromptSummary) => {
    setBusyKey(`get:${prompt.id}`);
    setError("");
    try {
      const args = buildArguments(prompt, argumentValues[prompt.id] ?? {});
      const response = await runtime.mcp.getPrompt(serverId, prompt.id, args);
      setMaterializedPrompt({
        promptId: prompt.id,
        response,
        text: promptMessagesToText(response.messages),
      });
      onNotice(`Prompt 已获取：${prompt.raw_name}`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyKey("");
    }
  };

  const copyPrompt = async () => {
    if (!materializedPrompt?.text.trim()) {
      setError("请先获取 prompt");
      return;
    }
    try {
      await copyTextToClipboard(materializedPrompt.text);
      onNotice("Prompt 已复制");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const insertPromptDraft = () => {
    if (!activePrompt || !materializedPrompt?.text.trim()) {
      setError("请先获取 prompt");
      return;
    }
    const inserted = emitInsertMcpPromptDraft({
      text: materializedPrompt.text,
      serverId,
      promptId: activePrompt.id,
      rawName: activePrompt.raw_name,
    });
    onNotice(
      inserted
        ? `Prompt 已插入当前对话草稿：${activePrompt.raw_name}`
        : `Prompt 已准备，返回当前对话后自动插入：${activePrompt.raw_name}`,
    );
  };

  return (
    <div className={styles.promptsTab} data-testid="mcp-prompts-tab">
      <div className={styles.toolsToolbar}>
        <label className={styles.searchBox}>
          <Search size={15} />
          <input
            aria-label="搜索 MCP Prompt"
            value={query}
            placeholder="搜索 prompt"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className={styles.promptFilters}>
          <select
            aria-label="筛选 MCP Prompt 状态"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as "all" | McpPromptDiscoveryStatus)}
          >
            {PROMPT_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            aria-label="筛选 MCP Prompt 启用状态"
            value={enabledFilter}
            onChange={(event) => setEnabledFilter(event.target.value as (typeof PROMPT_ENABLED_OPTIONS)[number]["value"])}
          >
            {PROMPT_ENABLED_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            aria-label="筛选 MCP Prompt 暴露方式"
            value={exposureFilter}
            onChange={(event) => setExposureFilter(event.target.value as "all" | McpPromptExposureMode)}
          >
            {EXPOSURE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <button
          className={styles.smallToolButton}
          type="button"
          disabled={loading}
          onClick={() => void loadPrompts()}
        >
          <RefreshCcw size={14} className={loading ? styles.spinning : undefined} />
          <span>刷新</span>
        </button>
      </div>

      {error ? (
        <div className={styles.inlineError} role="alert">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className={styles.promptsContent}>
        <div className={styles.promptList} data-testid="mcp-prompt-list">
          {loading ? (
            <div className={styles.loadingList} data-testid="mcp-prompt-loading">
              <LoaderCircle size={16} className={styles.spinning} />
              <span>加载 Prompts</span>
            </div>
          ) : null}
          {!loading && visiblePrompts.length === 0 ? (
            <div className={styles.emptyState} data-testid="mcp-prompt-empty">
              <FileText size={18} />
              <span>{prompts.length === 0 ? "暂无 MCP Prompts" : "没有匹配的 Prompts"}</span>
            </div>
          ) : null}
          {!loading
            ? visiblePrompts.map((prompt) => (
                <PromptRow
                  key={prompt.id}
                  prompt={prompt}
                  active={activePrompt?.id === prompt.id}
                  busyKey={busyKey}
                  onActivate={setActivePromptId}
                  onExposureChange={updatePromptExposure}
                  onGetPrompt={getPrompt}
                />
              ))
            : null}
        </div>

        <aside className={styles.promptPanel} data-testid="mcp-prompt-panel">
          {activePrompt ? (
            <>
              <div className={styles.promptPanelHeader}>
                <div>
                  <span>Prompt</span>
                  <strong>{activePrompt.raw_name}</strong>
                </div>
                <Badge value={activePrompt.exposure_mode} tone={activePrompt.exposure_mode === "hidden" ? "muted" : "neutral"} />
              </div>
              <div className={styles.promptArguments}>
                <h3>参数</h3>
                {activeArgumentDefinitions.length === 0 ? (
                  <div className={styles.promptNoArgs}>无参数</div>
                ) : (
                  activeArgumentDefinitions.map((argument) => (
                    <ArgumentField
                      key={argument.name}
                      argument={argument}
                      value={argumentValues[activePrompt.id]?.[argument.name]}
                      onChange={(value) => updateArgumentValue(activePrompt.id, argument.name, value)}
                    />
                  ))
                )}
                <button
                  className={styles.smallToolButton}
                  type="button"
                  disabled={busyKey === `get:${activePrompt.id}`}
                  onClick={() => void getPrompt(activePrompt)}
                >
                  <FileText size={14} />
                  <span>{busyKey === `get:${activePrompt.id}` ? "获取中" : "获取 Prompt"}</span>
                </button>
              </div>
              <div className={styles.promptPreview}>
                <div className={styles.promptPreviewHeader}>
                  <h3>预览</h3>
                  <div>
                    <button className={styles.smallToolButton} type="button" onClick={() => void copyPrompt()}>
                      <Clipboard size={14} />
                      <span>复制</span>
                    </button>
                    <button className={styles.smallToolButton} type="button" onClick={insertPromptDraft}>
                      <SendToBack size={14} />
                      <span>插入草稿</span>
                    </button>
                  </div>
                </div>
                <pre>{materializedPrompt?.promptId === activePrompt.id ? materializedPrompt.text : "尚未获取"}</pre>
              </div>
            </>
          ) : (
            <div className={styles.emptyState}>
              <FileText size={18} />
              <span>选择一个 MCP Prompt</span>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function PromptRow({
  prompt,
  active,
  busyKey,
  onActivate,
  onExposureChange,
  onGetPrompt,
}: {
  prompt: McpPromptSummary;
  active: boolean;
  busyKey: string;
  onActivate: (promptId: string) => void;
  onExposureChange: (prompt: McpPromptSummary, exposureMode: McpPromptExposureMode) => Promise<void>;
  onGetPrompt: (prompt: McpPromptSummary) => Promise<void>;
}) {
  const status = prompt.discovery_status ?? prompt.status ?? "unknown";
  const removed = status === "removed";
  return (
    <article className={styles.promptRow} data-active={active ? "true" : "false"} data-testid="mcp-prompt-row">
      <button type="button" className={styles.promptRowMain} onClick={() => onActivate(prompt.id)}>
        <span className={styles.promptTitleRow}>
          <strong>{prompt.raw_name}</strong>
          <span>{prompt.server_name}</span>
        </span>
        <span className={styles.promptDescription}>{prompt.description || "No description"}</span>
        <span className={styles.toolBadgeRow}>
          <Badge value={String(status)} tone={removed ? "muted" : "neutral"} />
          <Badge value={`${prompt.argument_count} args`} tone="neutral" />
          <Badge value={prompt.enabled ? "enabled" : "disabled"} tone={prompt.enabled ? "success" : "muted"} />
        </span>
      </button>
      <div className={styles.promptRowActions}>
        <select
          aria-label={`暴露策略 ${prompt.raw_name}`}
          disabled={busyKey === `policy:${prompt.id}` || removed}
          value={prompt.exposure_mode}
          onChange={(event) => void onExposureChange(prompt, event.target.value as McpPromptExposureMode)}
        >
          {EXPOSURE_OPTIONS.filter((option) => option.value !== "all").map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          className={styles.smallToolButton}
          type="button"
          disabled={busyKey === `get:${prompt.id}` || removed}
          onClick={() => void onGetPrompt(prompt)}
        >
          <FileText size={14} />
          <span>获取</span>
        </button>
      </div>
    </article>
  );
}

function ArgumentField({
  argument,
  onChange,
  value,
}: {
  argument: PromptArgumentDefinition;
  onChange: (value: ArgumentValue) => void;
  value: ArgumentValue | undefined;
}) {
  if (argument.type === "boolean") {
    return (
      <label className={styles.promptArgCheck}>
        <input
          checked={Boolean(value)}
          type="checkbox"
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span>{argumentLabel(argument)}</span>
      </label>
    );
  }
  if (argument.enumValues.length > 0) {
    return (
      <label className={styles.promptArgField}>
        <span>{argumentLabel(argument)}</span>
        <select
          aria-label={`prompt argument ${argument.name}`}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          <option value="">未选择</option>
          {argument.enumValues.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className={styles.promptArgField}>
      <span>{argumentLabel(argument)}</span>
      <input
        aria-label={`prompt argument ${argument.name}`}
        type={argument.type === "number" || argument.type === "integer" ? "number" : "text"}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function Badge({ value, tone }: { value: string; tone: "neutral" | "success" | "muted" }) {
  return (
    <span className={styles.toolBadge} data-tone={tone}>
      {value}
    </span>
  );
}

interface PromptArgumentDefinition {
  name: string;
  type: string;
  required: boolean;
  enumValues: string[];
}

function promptArgumentDefinitions(schema: Record<string, unknown> | undefined): PromptArgumentDefinition[] {
  const properties = asRecord(schema?.properties);
  const required = new Set(
    Array.isArray(schema?.required) ? schema.required.filter((item): item is string => typeof item === "string") : [],
  );
  return Object.entries(properties).map(([name, rawDefinition]) => {
    const definition = asRecord(rawDefinition);
    const enumValues = Array.isArray(definition.enum)
      ? definition.enum.filter((item): item is string => typeof item === "string")
      : [];
    return {
      name,
      type: typeof definition.type === "string" ? definition.type : "string",
      required: required.has(name),
      enumValues,
    };
  });
}

function buildArguments(prompt: McpPromptSummary, values: Record<string, ArgumentValue>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const argument of promptArgumentDefinitions(prompt.arguments_schema)) {
    const rawValue = values[argument.name];
    if (argument.required && (rawValue === undefined || rawValue === "")) {
      throw new Error(`请填写参数 ${argument.name}`);
    }
    if (rawValue === undefined || rawValue === "") {
      continue;
    }
    if (argument.type === "boolean") {
      result[argument.name] = Boolean(rawValue);
    } else if (argument.type === "number" || argument.type === "integer") {
      result[argument.name] = Number(rawValue);
    } else {
      result[argument.name] = String(rawValue);
    }
  }
  return result;
}

function promptMessagesToText(messages: Array<Record<string, unknown>>): string {
  return messages.map((message) => {
    const role = typeof message.role === "string" ? message.role : "message";
    return `${role}:\n${promptContentToText(message.content)}`;
  }).join("\n\n");
}

function promptContentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => promptContentToText(item)).join("\n");
  }
  const record = asRecord(content);
  if (typeof record.text === "string") {
    return record.text;
  }
  return JSON.stringify(content, null, 2);
}

function argumentLabel(argument: PromptArgumentDefinition): string {
  return argument.required ? `${argument.name} *` : argument.name;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("当前环境不支持剪贴板");
  }
  await navigator.clipboard.writeText(text);
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "MCP Prompt 请求失败";
}
