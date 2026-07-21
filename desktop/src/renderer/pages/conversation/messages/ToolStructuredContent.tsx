import type { ReactNode } from "react";

import type { ToolProjectionPresentation } from "./toolPresentation";
import { isRecord } from "./toolPresentation";
import styles from "./ToolStructuredContent.module.css";

export interface ToolStructuredContentProps {
  value: unknown;
  toolName: string;
  mode: "input" | "output";
  emptyText?: string;
}

const FIELD_LABELS: Record<string, string> = {
  added_lines: "新增行",
  anchor_line: "锚点行",
  artifact_complete: "原文完整",
  artifact_id: "结果引用",
  attempts: "已尝试动作",
  blocked_audit_key: "阻塞审计键",
  case_sensitive: "区分大小写",
  changed_files: "变更文件",
  changes: "变更",
  checklist: "检查清单",
  chunk: "内容",
  chunk_bytes: "本页大小",
  combined_output: "输出",
  command: "命令",
  complete: "完成",
  completed: "完成",
  content: "内容",
  content_type: "内容类型",
  context_lines: "上下文行数",
  count: "数量",
  cwd: "工作目录",
  deleted_lines: "删除行",
  depth: "目录深度",
  description: "说明",
  diff: "差异",
  diff_truncated: "差异已截断",
  encoding: "编码",
  end_line: "结束行",
  entries: "条目",
  evidence: "证据",
  exclude: "排除范围",
  exit_code: "退出码",
  files: "文件",
  first_line: "首个匹配行",
  full_diff_bytes: "完整差异大小",
  has_task: "存在任务",
  include: "包含范围",
  include_hidden: "包含隐藏项",
  is_complete: "读取完成",
  line: "行号",
  limit: "返回上限",
  match_count: "匹配数",
  matches: "匹配数",
  max_bytes: "单页上限",
  max_lines: "最大行数",
  mode: "读取模式",
  new_path: "目标路径",
  new_string: "替换为",
  next_cursor: "后续游标",
  next_offset: "后续位置",
  next_start_line: "下一起始行",
  numbered_content: "文件内容",
  offset: "起始位置",
  old_string: "原内容",
  omitted_results: "省略结果",
  operation: "操作",
  output_ref: "输出引用",
  patch: "补丁",
  path: "路径",
  plan: "计划",
  query: "查询",
  reason: "原因",
  regex: "正则模式",
  replace_all: "全部替换",
  results: "结果",
  returned_entries: "返回条目",
  returned_lines: "返回行数",
  returned_results: "返回结果",
  scanned_files: "扫描文件数",
  session_id: "会话 ID",
  size: "大小",
  snippet: "内容片段",
  start_line: "起始行",
  status: "状态",
  step: "步骤",
  structured_content: "结构化内容",
  subagent_id: "Sub-Agent ID",
  summary: "摘要",
  task: "任务",
  text: "文本",
  timeout_seconds: "超时时间",
  total_lines: "总行数",
  tool_name: "来源工具",
  total_bytes: "总大小",
  total_results: "结果总数",
  tree: "目录结构",
  truncated: "已截断",
  truncation_reason: "截断原因",
  turn_index: "轮次",
  type: "类型",
};

const CODE_LIKE_KEYS = new Set([
  "chunk",
  "combined_output",
  "content",
  "diff",
  "numbered_content",
  "output",
  "patch",
  "stderr",
  "stdout",
  "tree",
]);

export function ToolStructuredContent({
  value,
  toolName,
  mode,
  emptyText = "暂无数据",
}: ToolStructuredContentProps) {
  if (isEmptyValue(value)) {
    return <p className={styles.empty}>{emptyText}</p>;
  }
  return (
    <div className={styles.content} data-mode={mode} data-tool-family={toolFamily(toolName)}>
      <StructuredValue value={value} toolName={toolName} depth={0} />
    </div>
  );
}

export function ToolProjectionNotice({ projection }: { projection: ToolProjectionPresentation | null }) {
  if (!projection) {
    return null;
  }
  const facts: ReactNode[] = [];
  const reasonLabel = projectionReasonLabel(projection);
  if (reasonLabel) facts.push(<span key="truncated">{reasonLabel}</span>);
  if (projection.artifactComplete === false) facts.push(<span key="incomplete">上游原文不完整</span>);
  if (projection.continuation && !reasonLabel) facts.push(<span key="continuation">还有后续内容</span>);
  if (
    projection.truncated === true
    && projection.fullBytes !== undefined
    && projection.modelBytes !== undefined
    && projection.fullBytes > projection.modelBytes
  ) {
    facts.push(
      <span key="bytes">
        Agent 可见 {formatBytes(projection.modelBytes)} / 工具原始 {formatBytes(projection.fullBytes)}
      </span>,
    );
  }
  if (projection.artifactId) {
    facts.push(<code key="artifact">{projection.artifactId}</code>);
  }
  if (!facts.length) {
    return null;
  }
  return (
    <div className={styles.projectionNotice} role="note" aria-label="工具结果投影信息">
      {facts}
    </div>
  );
}


function projectionReasonLabel(projection: ToolProjectionPresentation): string | null {
  if (projection.truncated !== true) {
    return null;
  }
  switch (projection.reasonCode) {
    case "model_byte_budget":
    case "budget_exceeded":
      return "结果已按上下文预算精简";
    case "requested_window":
      return "文件还有后续内容";
    case "search_source_truncated":
      return "搜索结果还有后续页";
    case "search_source_and_result_compacted":
      return "搜索结果还有后续页，当前页详情已精简";
    case "search_result_compacted":
      return "搜索结果详情已精简";
    default:
      return projection.continuation ? "还有后续内容" : "结果已精简";
  }
}

export function RawToolDataDisclosure({
  label,
  source,
}: {
  label: string;
  source: string;
}) {
  if (!source) {
    return null;
  }
  return (
    <details className={styles.rawDisclosure}>
      <summary>{label}</summary>
      <div className={styles.rawViewport}>
        <pre>{source}</pre>
      </div>
    </details>
  );
}

function StructuredValue({
  value,
  toolName,
  depth,
  label,
}: {
  value: unknown;
  toolName: string;
  depth: number;
  label?: string;
}) {
  if (value === null) {
    return <span className={styles.nullValue}>null</span>;
  }
  if (typeof value === "string") {
    return <StringValue value={value} label={label} codeLike={Boolean(label && CODE_LIKE_KEYS.has(label))} />;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className={styles.primitive}>{formatPrimitive(value)}</span>;
  }
  if (Array.isArray(value)) {
    return <ArrayValue value={value} toolName={toolName} depth={depth} label={label} />;
  }
  if (isRecord(value)) {
    return <ObjectValue value={value} toolName={toolName} depth={depth} />;
  }
  return <span className={styles.primitive}>{String(value)}</span>;
}

function ObjectValue({
  value,
  toolName,
  depth,
}: {
  value: Record<string, unknown>;
  toolName: string;
  depth: number;
}) {
  const entries = Object.entries(value).filter(([key, item]) => (
    key !== "_keydex_projection" && item !== undefined && item !== null
  ));
  if (!entries.length) {
    return <p className={styles.empty}>无数据</p>;
  }
  const scalarEntries = entries.filter(([, item]) => isScalarForFact(item));
  const textEntries = entries.filter(([key, item]) => (
    typeof item === "string"
    && !scalarEntries.some(([scalarKey]) => scalarKey === key)
  ));
  const collectionEntries = entries.filter(([key, item]) => (
    !scalarEntries.some(([scalarKey]) => scalarKey === key)
    && !textEntries.some(([textKey]) => textKey === key)
    && (Array.isArray(item) || isRecord(item))
  ));
  const otherEntries = entries.filter(([key]) => (
    !scalarEntries.some(([scalarKey]) => scalarKey === key)
    && !textEntries.some(([textKey]) => textKey === key)
    && !collectionEntries.some(([collectionKey]) => collectionKey === key)
  ));

  return (
    <div className={styles.objectValue}>
      {scalarEntries.length ? (
        <dl className={styles.factGrid}>
          {scalarEntries.map(([key, item]) => (
            <div className={styles.fact} key={key}>
              <dt>{fieldLabel(key)}</dt>
              <dd data-mono={isMonoField(key) ? "true" : "false"}>
                <StructuredValue value={item} toolName={toolName} depth={depth + 1} label={key} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {textEntries.map(([key, item]) => (
        <section className={styles.valueSection} key={key}>
          <h4>{fieldLabel(key)}</h4>
          <StructuredValue value={item} toolName={toolName} depth={depth + 1} label={key} />
        </section>
      ))}

      {collectionEntries.map(([key, item]) => (
        <section className={styles.valueSection} key={key}>
          <h4>{fieldLabel(key)}</h4>
          <StructuredValue value={item} toolName={toolName} depth={depth + 1} label={key} />
        </section>
      ))}

      {otherEntries.map(([key, item]) => (
        <section className={styles.valueSection} key={key}>
          <h4>{fieldLabel(key)}</h4>
          <StructuredValue value={item} toolName={toolName} depth={depth + 1} label={key} />
        </section>
      ))}
    </div>
  );
}

function ArrayValue({
  value,
  toolName,
  depth,
  label,
}: {
  value: unknown[];
  toolName: string;
  depth: number;
  label?: string;
}) {
  if (!value.length) {
    return <p className={styles.empty}>无数据</p>;
  }
  if (label === "results" && isSearchTool(toolName) && value.every(isRecord)) {
    return <SearchResultList results={value} toolName={toolName} depth={depth} />;
  }
  if (value.every(isRecord) && canRenderTable(value)) {
    return <RecordTable rows={value} />;
  }
  return (
    <ol className={styles.valueList}>
      {value.map((item, index) => (
        <li key={stableItemKey(item, index)}>
          <StructuredValue value={item} toolName={toolName} depth={depth + 1} />
        </li>
      ))}
    </ol>
  );
}

function SearchResultList({
  results,
  toolName,
  depth,
}: {
  results: Record<string, unknown>[];
  toolName: string;
  depth: number;
}) {
  return (
    <ol className={styles.searchResults} aria-label="搜索结果">
      {results.map((result, index) => {
        const path = typeof result.path === "string" ? result.path : "";
        const hasLine = typeof result.line === "number";
        const hasFirstLine = typeof result.first_line === "number";
        const line = hasLine ? result.line as number : hasFirstLine ? result.first_line as number : null;
        const snippet = typeof result.snippet === "string" ? result.snippet : "";
        const consumed = new Set<string>();
        if (path) consumed.add("path");
        if (hasLine) consumed.add("line");
        else if (hasFirstLine) consumed.add("first_line");
        if (snippet) consumed.add("snippet");
        const remaining = Object.fromEntries(Object.entries(result).filter(([key]) => !consumed.has(key)));
        return (
          <li key={`${path}:${line ?? ""}:${index}`}>
            {(path || line !== null) ? (
              <div className={styles.searchIdentity}>
                {path ? <code>{path}</code> : null}
                {line !== null ? <span>第 {line} 行</span> : null}
              </div>
            ) : null}
            {snippet ? <pre className={styles.snippet}>{snippet}</pre> : null}
            {Object.keys(remaining).length ? (
              <StructuredValue value={remaining} toolName={toolName} depth={depth + 1} />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function RecordTable({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  return (
    <div className={styles.tableViewport}>
      <table>
        <thead>
          <tr>{columns.map((column) => <th key={column}>{fieldLabel(column)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={stableItemKey(row, rowIndex)}>
              {columns.map((column) => (
                <td key={column} data-mono={isMonoField(column) ? "true" : "false"}>
                  {column in row ? formatTableValue(row[column]) : ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StringValue({ value, label, codeLike }: { value: string; label?: string; codeLike: boolean }) {
  if (!value) {
    return <span className={styles.emptyInline}>空字符串</span>;
  }
  if (codeLike || value.includes("\n")) {
    return <pre className={styles.textBlock} data-code={codeLike ? "true" : "false"}>{value}</pre>;
  }
  return <span className={styles.stringValue} data-mono={label && isMonoField(label) ? "true" : "false"}>{value}</span>;
}

function canRenderTable(rows: Record<string, unknown>[]): boolean {
  return rows.every((row) => Object.values(row).every((value) => (
    value === null || ["string", "number", "boolean"].includes(typeof value)
  )));
}

function isScalarForFact(value: unknown): boolean {
  return value === null
    || typeof value === "number"
    || typeof value === "boolean"
    || (typeof value === "string" && !value.includes("\n") && value.length <= 240);
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === "" || (isRecord(value) && Object.keys(value).length === 0);
}

function isSearchTool(name: string): boolean {
  return ["search_text", "grep_files", "search_files", "search", "grep", "discover_mcp_tools"].includes(name);
}

function toolFamily(name: string): string {
  if (["read_file", "read_text_file", "open_file"].includes(name)) return "read";
  if (["list_dir", "list_directory", "read_directory"].includes(name)) return "directory";
  if (isSearchTool(name)) return "search";
  if (name === "read_tool_result") return "artifact";
  if (name.startsWith("mcp__")) return "mcp";
  return "generic";
}

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

function isMonoField(key: string): boolean {
  return [
    "artifact_id",
    "command",
    "content_type",
    "cwd",
    "next_cursor",
    "new_path",
    "output_ref",
    "path",
    "query",
    "tool_name",
    "url",
  ].includes(key) || key.endsWith("_id") || key.endsWith("_path");
}

function formatPrimitive(value: number | boolean): string {
  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }
  return String(value);
}

function formatTableValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value ?? "");
}

function stableItemKey(item: unknown, index: number): string {
  if (isRecord(item)) {
    const identity = [item.id, item.path, item.name, item.url].find((value) => typeof value === "string" && value);
    if (identity) return `${identity}:${index}`;
  }
  return String(index);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const kilobytes = value / 1024;
  return `${kilobytes >= 10 ? kilobytes.toFixed(0) : kilobytes.toFixed(1)} KB`;
}
