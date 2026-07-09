import type { ConversationMessage } from "@/renderer/stores/conversationStore";

export type FileReviewOperation = "add" | "update" | "delete" | "append" | "write" | "move" | "unknown";
export type FileReviewSource = "streaming" | "final" | "unknown";

export interface FileReviewChange {
  path: string;
  additions: number;
  deletions: number;
  diff: string;
  content?: string;
  operation: FileReviewOperation;
  oldPath?: string | null;
  newPath?: string | null;
  source?: FileReviewSource;
}

export function fileReviewChangesFromMessage(message: ConversationMessage, fallbackTarget = ""): FileReviewChange[] {
  const result = asRecord(message.payload.result);
  const toolOperation = operationFromToolName(toolNameFromMessage(message));
  const forcedOperation = toolOperation !== "unknown" ? toolOperation : null;
  const fallbackOperation = forcedOperation ?? operationFromRecord(result ?? message.payload, "unknown");
  const changes = new Map<string, FileReviewChange>();

  collectFileReviewChanges(message.payload, fallbackOperation, forcedOperation, changes);
  if (result) {
    collectFileReviewChanges(result, operationFromRecord(result, fallbackOperation), forcedOperation, changes);
  }

  if (!changes.size) {
    const path = fallbackTarget || toolTarget(toolArgsFromMessage(message), message.payload);
    if (path) {
      changes.set(path, {
        path,
        additions: 0,
        deletions: 0,
        diff: "",
        operation: fallbackOperation,
        source: sourceFromPayload(message.payload),
      });
    }
  }

  return [...changes.values()];
}

export function isFileMutationToolName(name: string): boolean {
  return ["write_file", "apply_patch", "edit_file", "create_file", "delete_file", "move_file"].includes(name);
}

export function toolNameFromMessage(message: ConversationMessage): string {
  const call = asRecord(message.payload.call);
  return (
    stringValue(call?.name) ||
    stringValue(message.payload.tool) ||
    stringValue(message.payload.tool_name) ||
    stringValue(message.payload.toolName)
  );
}

export function operationFromToolName(toolName: string): FileReviewOperation {
  if (toolName === "create_file" || toolName === "write_file") {
    return "add";
  }
  if (toolName === "delete_file") {
    return "delete";
  }
  if (toolName === "move_file") {
    return "move";
  }
  return "unknown";
}

export function normalizeFileReviewChange(change: Partial<FileReviewChange> & { path?: string | null }): FileReviewChange {
  const diff = stringValue(change.diff);
  return {
    path: stringValue(change.path) || "未知文件",
    additions: numberValue(change.additions) ?? countDiff(diff, "+"),
    deletions: numberValue(change.deletions) ?? countDiff(diff, "-"),
    diff,
    content: stringValue(change.content),
    operation: normalizeOperation(change.operation) || "unknown",
    oldPath: change.oldPath ?? null,
    newPath: change.newPath ?? null,
    source: change.source ?? "unknown",
  };
}

function collectFileReviewChanges(
  payload: Record<string, unknown>,
  fallbackOperation: FileReviewOperation,
  forcedOperation: FileReviewOperation | null,
  changes: Map<string, FileReviewChange>,
) {
  const parentOperation = forcedOperation ?? operationFromRecord(payload, fallbackOperation);
  const directPath = stringValue(payload.path);
  if (directPath) {
    mergeFileReviewChange(
      changes,
      fileReviewChangeFromRecord(payload, directPath, parentOperation, forcedOperation, sourceFromPayload(payload)),
    );
  }

  fileRecordsFromPayload(payload).forEach((record, index) => {
    const path = stringValue(record?.path) || `文件 ${index + 1}`;
    mergeFileReviewChange(
      changes,
      fileReviewChangeFromRecord(record ?? {}, path, parentOperation, forcedOperation, sourceFromPayload(payload)),
    );
  });
}

function mergeFileReviewChange(changes: Map<string, FileReviewChange>, next: FileReviewChange | null) {
  if (!next) {
    return;
  }
  const existing = changes.get(next.path);
  changes.set(next.path, {
    ...existing,
    ...next,
    additions: next.additions || existing?.additions || 0,
    deletions: next.deletions || existing?.deletions || 0,
    diff: next.diff || existing?.diff || "",
    content: next.content || existing?.content || "",
    oldPath: next.oldPath ?? existing?.oldPath ?? null,
    newPath: next.newPath ?? existing?.newPath ?? null,
    source: next.source ?? existing?.source ?? "unknown",
  });
}

function fileReviewChangeFromRecord(
  record: Record<string, unknown>,
  path: string,
  fallbackOperation: FileReviewOperation,
  forcedOperation: FileReviewOperation | null,
  source: FileReviewSource,
): FileReviewChange | null {
  const diff = stringValue(record.diff);
  const operation = forcedOperation ?? operationFromRecord(record, fallbackOperation);
  return {
    path,
    additions: numberValue(record.additions) ?? numberValue(record.added_lines) ?? countDiff(diff, "+"),
    deletions:
      numberValue(record.deletions) ??
      numberValue(record.deleted_lines) ??
      numberValue(record.removed_lines) ??
      countDiff(diff, "-"),
    diff,
    content: stringValue(record.new_content) || stringValue(record.newContent) || stringValue(record.content),
    operation: operationFromMovePaths(record, operation),
    oldPath: nullableString(record.old_path ?? record.oldPath),
    newPath: nullableString(record.new_path ?? record.newPath),
    source,
  };
}

function fileRecordsFromPayload(payload: Record<string, unknown>): Array<Record<string, unknown> | null> {
  const uiPayload = asRecord(payload.ui_payload) ?? asRecord(payload.uiPayload);
  return [
    ...arrayRecords(payload.files),
    ...arrayRecords(payload.changes),
    ...arrayRecords(uiPayload?.files),
    ...arrayRecords(uiPayload?.changes),
  ];
}

function operationFromRecord(
  record: Record<string, unknown> | null,
  fallbackOperation: FileReviewOperation,
): FileReviewOperation {
  if (!record) {
    return fallbackOperation;
  }
  const explicit = normalizeOperation(
    record.operation ??
      record.action ??
      record.kind ??
      record.change_type ??
      record.changeType,
  );
  if (explicit) {
    return explicit;
  }
  if (record.created === true || record.is_new === true || record.isNew === true) {
    return "add";
  }
  return fallbackOperation;
}

function normalizeOperation(value: unknown): FileReviewOperation | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["add", "create", "created", "new", "new_file", "insert"].includes(normalized)) {
    return "add";
  }
  if (["delete", "deleted", "remove", "removed"].includes(normalized)) {
    return "delete";
  }
  if (["append", "append_file"].includes(normalized)) {
    return "append";
  }
  if (["write", "write_file", "overwrite"].includes(normalized)) {
    return "add";
  }
  if (["move", "moved", "rename", "renamed"].includes(normalized)) {
    return "move";
  }
  if (["update", "edit", "modify", "modified", "patch", "apply_patch"].includes(normalized)) {
    return "update";
  }
  return null;
}

function toolArgsFromMessage(message: ConversationMessage): Record<string, unknown> | null {
  const call = asRecord(message.payload.call);
  return asRecord(call?.arguments) ?? asRecord(message.payload.arguments) ?? asRecord(message.payload.params);
}

function toolTarget(args: Record<string, unknown> | null, payload: Record<string, unknown>): string {
  return (
    stringValue(args?.new_path) ||
    stringValue(args?.newPath) ||
    stringValue(args?.path) ||
    stringValue(args?.file) ||
    patchFileTarget(stringValue(args?.patch) || stringValue(args?.diff) || stringValue(args?.content) || stringValue(payload.patch)) ||
    stringValue(payload.path)
  );
}

function operationFromMovePaths(
  record: Record<string, unknown>,
  fallback: FileReviewOperation,
): FileReviewOperation {
  if (fallback !== "unknown") {
    return fallback;
  }
  if (record.old_path || record.oldPath || record.new_path || record.newPath) {
    return "move";
  }
  return fallback;
}

function patchFileTarget(patch: string): string {
  if (!patch) {
    return "";
  }
  const explicit = patch.match(/^\s*\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+?)\s*$/m);
  if (explicit?.[1]) {
    return explicit[1].trim();
  }
  const diffHeader = patch.match(/^\s*(?:\+\+\+\s+b\/|---\s+a\/)(.+?)\s*$/m);
  return diffHeader?.[1]?.trim() ?? "";
}

function sourceFromPayload(payload: Record<string, unknown>): FileReviewSource {
  const phase = stringValue(payload.phase).toLowerCase();
  if (phase === "streaming") {
    return "streaming";
  }
  const resultStatus = stringValue(payload.status).toLowerCase();
  return resultStatus === "running" ? "streaming" : "final";
}

function countDiff(value: string, prefix: "+" | "-"): number {
  if (!value) {
    return 0;
  }
  const ignored = prefix === "+" ? "+++" : "---";
  return value.split("\n").filter((line) => line.startsWith(prefix) && !line.startsWith(ignored)).length;
}

function arrayRecords(value: unknown): Array<Record<string, unknown> | null> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
