import { isRuntimeHttpError } from "./errors";
import type { HttpClient } from "./httpClient";

export type ArchiveOrigin = "manual" | "project";
export type WorkspaceRestoreMode = "project_only" | "with_project_sessions";

export interface LifecycleEventPayload {
  type:
    | "session_archived"
    | "session_restored"
    | "session_purged"
    | "workspace_archived"
    | "workspace_restored"
    | "workspace_purged"
    | "workspace_sessions_purged";
  operation_id?: string;
  request_id?: string;
  session_id?: string;
  workspace_id?: string | null;
  archived_at?: string | null;
  archive_origin?: ArchiveOrigin | null;
  mode?: WorkspaceRestoreMode;
  counts?: Record<string, number>;
  changed?: boolean;
  revision?: number;
  occurred_at?: string;
}

export interface ArchiveSessionPayload {
  requestId: string;
  stopIfActive?: boolean;
}

export interface RestoreSessionPayload {
  requestId: string;
}

export interface ArchiveWorkspacePayload {
  requestId: string;
  stopActiveSessions?: boolean;
}

export interface RestoreWorkspacePayload {
  requestId: string;
  mode: WorkspaceRestoreMode;
}

export interface SessionArchiveResult {
  operation_id: string;
  request_id: string;
  session_id: string;
  workspace_id: string | null;
  changed: boolean;
  archived_at: string | null;
  archive_origin: ArchiveOrigin | null;
  event: LifecycleEventPayload | null;
  replayed?: boolean;
}

export interface SessionRestoreResult {
  operation_id: string;
  request_id: string;
  session_id: string;
  workspace_id: string | null;
  workspace: { id: string; name: string } | null;
  changed: boolean;
  event: LifecycleEventPayload | null;
  replayed?: boolean;
}

export interface WorkspaceArchiveResult {
  operation_id: string;
  request_id: string;
  workspace_id: string;
  changed: boolean;
  archived_at: string | null;
  newly_archived: number;
  manual_preserved: number;
  project_preserved: number;
  event: LifecycleEventPayload | null;
  replayed?: boolean;
}

export interface WorkspaceRestoreResult {
  operation_id: string;
  request_id: string;
  workspace_id: string;
  mode: WorkspaceRestoreMode;
  changed: boolean;
  restored_project_sessions: number;
  remaining_manual: number;
  remaining_project: number;
  remaining_total: number;
  event: LifecycleEventPayload | null;
  replayed?: boolean;
}

export interface PurgeResult {
  operation_id: string;
  state: "completed";
  entity_type: "session" | "workspace" | "workspace_sessions";
  counts: Record<string, number>;
  replayed: boolean;
  event: LifecycleEventPayload | null;
}

export interface ArchivedWorkspaceItem {
  id: string;
  name: string;
  archived_at: string;
  session_total: number;
  manual_session_count: number;
  project_session_count: number;
  can_restore_project_only: boolean;
  can_restore_with_project_sessions: boolean;
}

export interface ArchivedSessionItem {
  id: string;
  title: string;
  archived_at: string;
  archive_origin: ArchiveOrigin;
  pinned_at: string | null;
  workspace: { id: string; name: string; archived_at: string | null } | null;
}

export interface ArchiveCatalogPage<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
  total: number | null;
  total_kind: "not_computed";
}

export interface ArchiveListOptions {
  query?: string;
  workspaceIds?: string[];
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}

export interface LifecycleRuntimeError {
  kind:
    | "archive_requires_stop_confirmation"
    | "workspace_archived"
    | "cleanup_failed"
    | "lifecycle_locked"
    | "not_found"
    | "not_archived"
    | "confirmation"
    | "request_conflict"
    | "unknown";
  code: string;
  message: string;
  details: Record<string, unknown>;
  retryable: boolean;
}

export class ArchiveCatalogContractError extends Error {
  readonly code = "archive_catalog_contract_invalid";
}

let lifecycleRequestSequence = 0;

export function createLifecycleRequestId(prefix = "desktop"): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) {
    return `${prefix}:${randomId}`;
  }
  lifecycleRequestSequence += 1;
  return `${prefix}:${Date.now()}:${lifecycleRequestSequence}`;
}

export interface ArchiveRuntime {
  listArchivedWorkspaces(options?: ArchiveListOptions): Promise<ArchiveCatalogPage<ArchivedWorkspaceItem>>;
  listArchivedSessions(options?: ArchiveListOptions): Promise<ArchiveCatalogPage<ArchivedSessionItem>>;
  listWorkspaceArchivedSessions(
    workspaceId: string,
    options?: ArchiveListOptions,
  ): Promise<ArchiveCatalogPage<ArchivedSessionItem>>;
}

export function createArchiveRuntime(http: HttpClient): ArchiveRuntime {
  return {
    listArchivedWorkspaces(options = {}) {
      return http
        .request<ArchiveCatalogPage<ArchivedWorkspaceItem>>(
          `/api/archive/workspaces${archiveQuery(options)}`,
          { signal: options.signal },
        )
        .then((page) => validateCatalogPage(page));
    },
    listArchivedSessions(options = {}) {
      return http
        .request<ArchiveCatalogPage<ArchivedSessionItem>>(
          `/api/archive/sessions${archiveQuery(options)}`,
          { signal: options.signal },
        )
        .then((page) => validateCatalogPage(page));
    },
    listWorkspaceArchivedSessions(workspaceId, options = {}) {
      return http
        .request<ArchiveCatalogPage<ArchivedSessionItem>>(
          `/api/archive/workspaces/${encodeURIComponent(workspaceId)}/sessions${archiveQuery(options)}`,
          { signal: options.signal },
        )
        .then((page) => validateCatalogPage(page));
    },
  };
}

export function decodeLifecycleRuntimeError(error: unknown): LifecycleRuntimeError | null {
  if (!isRuntimeHttpError(error)) {
    return null;
  }
  const details = error.details ?? {};
  const retryable = details.retryable === true || error.code === "cleanup_failed" || error.code === "lifecycle_locked";
  const kind: LifecycleRuntimeError["kind"] =
    error.code === "archive_requires_stop_confirmation"
      ? "archive_requires_stop_confirmation"
      : error.code === "workspace_archived"
        ? "workspace_archived"
        : error.code === "cleanup_failed"
          ? "cleanup_failed"
          : error.code === "lifecycle_locked"
            ? "lifecycle_locked"
            : error.code === "not_found"
              ? "not_found"
              : error.code === "not_archived"
                ? "not_archived"
                : error.code === "purge_confirmation_required" || error.code === "confirmation_mismatch"
                  ? "confirmation"
                  : error.code === "request_id_conflict"
                    ? "request_conflict"
                    : "unknown";
  return { kind, code: error.code, message: error.message, details, retryable };
}

function archiveQuery(options: ArchiveListOptions): string {
  const params = new URLSearchParams();
  if (options.query !== undefined && options.query !== "") {
    params.set("query", options.query);
  }
  for (const workspaceId of options.workspaceIds ?? []) {
    if (workspaceId) params.append("workspace_id", workspaceId);
  }
  if (options.cursor) {
    params.set("cursor", options.cursor);
  }
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function validateCatalogPage<T extends { id: string }>(page: ArchiveCatalogPage<T>): ArchiveCatalogPage<T> {
  if (!page || !Array.isArray(page.items) || typeof page.has_more !== "boolean") {
    throw new ArchiveCatalogContractError("归档目录响应格式无效");
  }
  const ids = new Set<string>();
  for (const item of page.items) {
    if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id)) {
      throw new ArchiveCatalogContractError("归档目录包含无效或重复对象");
    }
    ids.add(item.id);
  }
  return page;
}
