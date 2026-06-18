import { ChevronDown, FileDiff, LoaderCircle, XCircle } from "lucide-react";
import { useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import styles from "./FileChangeBlock.module.css";
import { useDeferredUnmount } from "./useDeferredUnmount";

export interface FileChangeBlockProps {
  message: ConversationMessage;
  onPreviewFile?: (file: FileChangePreview) => void;
}

export interface FileChangePreview {
  path: string;
  diff: string;
}

export function FileChangeBlock({ message, onPreviewFile }: FileChangeBlockProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const change = useMemo(() => parseFileChange(message), [message]);
  const failed = message.status === "failed" || change.status === "failed";
  const expandedFile = change.files.find((file) => file.path === expandedPath) ?? null;
  const statusKind = failed ? "failed" : change.status === "running" ? "running" : "done";
  const title = change.files.length ? `编辑了 ${change.files.length} 个文件` : "文件变更";
  const detailsMotion = useDeferredUnmount<HTMLDivElement>(detailsOpen);

  return (
    <article className={styles.block} data-status={failed ? "failed" : change.status} data-testid="file-change-block">
      <button
        className={styles.header}
        type="button"
        aria-expanded={detailsOpen}
        aria-label={detailsOpen ? "收起文件变更详情" : "展开文件变更详情"}
        onClick={() => setDetailsOpen((open) => !open)}
      >
        <span className={styles.icon} aria-hidden="true">
          {failed ? <XCircle size={16} /> : change.status === "running" ? <LoaderCircle size={16} /> : <FileDiff size={16} />}
        </span>
        <div className={styles.titleGroup}>
          <div className={styles.meta}>
            <span className={styles.statusMeta}>
              <span className={styles.statusDot} data-state={statusKind} />
              <span>{statusLabel(change.status)}</span>
            </span>
            <span>+{change.additions}</span>
            <span>-{change.deletions}</span>
          </div>
          <div className={styles.title}>{title}</div>
        </div>
        <ChevronDown className={styles.chevron} size={14} />
      </button>

      {detailsMotion.shouldRender ? (
        <div
          className={styles.details}
          data-motion={detailsMotion.phase}
          ref={detailsMotion.ref}
          style={detailsMotion.style}
          aria-hidden={!detailsOpen}
        >
          <div className={styles.detailsInner}>
            <ul className={styles.fileList} aria-label="变更文件">
              {change.files.map((file) => {
                const open = expandedPath === file.path;
                return (
                  <li key={file.path} className={styles.fileItem}>
                    <button
                      className={styles.fileButton}
                      type="button"
                      aria-expanded={open}
                      onClick={() => setExpandedPath(open ? null : file.path)}
                    >
                      <ChevronDown size={14} data-expanded={open ? "true" : "false"} />
                      <span className={styles.path}>{file.path}</span>
                      <span className={styles.fileStats}>+{file.additions} -{file.deletions}</span>
                    </button>
                    <button className={styles.previewButton} type="button" onClick={() => onPreviewFile?.({ path: file.path, diff: file.diff })}>
                      预览
                    </button>
                  </li>
                );
              })}
            </ul>

            {expandedFile ? <DiffView diff={expandedFile.diff} /> : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

interface ParsedFileChange {
  files: FileChangeFile[];
  additions: number;
  deletions: number;
  status: "pending" | "running" | "applied" | "rejected" | "failed";
}

interface FileChangeFile {
  path: string;
  additions: number;
  deletions: number;
  diff: string;
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff ? diff.split("\n") : ["暂无 diff"];
  return (
    <pre className={styles.diff} aria-label="文件 diff">
      {lines.map((line, index) => (
        <span className={diffLineClass(line)} key={`${index}:${line}`}>
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

function parseFileChange(message: ConversationMessage): ParsedFileChange {
  const result = asRecord(message.payload.result);
  const source = result?.files ?? message.payload.files;
  const files = parseFiles(source, message.payload);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return {
    files,
    additions,
    deletions,
    status: changeStatus(message, result),
  };
}

function parseFiles(source: unknown, payload: Record<string, unknown>): FileChangeFile[] {
  if (Array.isArray(source)) {
    return source.map((item, index) => fileFromRecord(asRecord(item), index)).filter(isDefined);
  }
  const single = fileFromRecord(payload, 0);
  return single ? [single] : [];
}

function fileFromRecord(record: Record<string, unknown> | null, index: number): FileChangeFile | null {
  if (!record) {
    return null;
  }
  const path = stringValue(record.path) || `文件 ${index + 1}`;
  return {
    path,
    additions: numberValue(record.additions) ?? countDiff(record.diff, "+"),
    deletions: numberValue(record.deletions) ?? countDiff(record.diff, "-"),
    diff: stringValue(record.diff),
  };
}

function changeStatus(message: ConversationMessage, result: Record<string, unknown> | null): ParsedFileChange["status"] {
  if (message.status === "failed") {
    return "failed";
  }
  const applied = result?.applied ?? message.payload.applied;
  const rejected = result?.rejected ?? message.payload.rejected;
  if (rejected === true) {
    return "rejected";
  }
  if (applied === true) {
    return "applied";
  }
  if (message.status === "running" || message.status === "pending") {
    return "running";
  }
  return "pending";
}

function statusLabel(status: ParsedFileChange["status"]): string {
  switch (status) {
    case "applied":
      return "已应用";
    case "rejected":
      return "已拒绝";
    case "failed":
      return "变更失败";
    case "running":
      return "等待应用";
    case "pending":
      return "待确认";
  }
}

function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return styles.added;
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return styles.removed;
  }
  if (line.startsWith("@@")) {
    return styles.hunk;
  }
  return styles.context;
}

function countDiff(value: unknown, prefix: "+" | "-"): number {
  const ignored = prefix === "+" ? "+++" : "---";
  return stringValue(value)
    .split("\n")
    .filter((line) => line.startsWith(prefix) && !line.startsWith(ignored)).length;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
