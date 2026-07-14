import type { HttpClient } from "./httpClient";
import {
  DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES,
  createDocumentReadRequest,
  type DocumentReadResult,
} from "./documentRead";
import {
  DocumentReadCoordinator,
  readDocumentNdjsonResponse,
  type DocumentReadTransportDiagnostics,
} from "@/renderer/components/workspace/fileMarkdownAdapter/transport";
import {
  createDocumentWriteRequest,
  type DocumentWriteResult,
} from "./documentWrite";

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number | null;
  modified_at?: string | null;
}

export interface WorkspaceTreeResponse {
  root: string;
  entries: WorkspaceEntry[];
}

export interface WorkspaceSubtreeResponse {
  root: string;
  path: string;
  entries_by_path: Record<string, WorkspaceEntry[]>;
  expanded_paths: string[];
  truncated: boolean;
  truncated_reason?: "max_depth" | "max_dirs" | "max_entries" | "timeout" | null;
  visited_dirs: number;
  entry_count: number;
}

export interface WorkspaceSubtreeOptions {
  maxDepth?: number;
  maxDirs?: number;
  maxEntries?: number;
  timeoutMs?: number;
  includeFiles?: boolean;
  signal?: AbortSignal;
}

export interface WorkspaceFileResponse {
  path: string;
  content: string;
  encoding: string;
  revision: string;
}

export interface WorkspaceMediaResponse {
  path: string;
  media_type: string;
  size: number;
  data_url: string;
}

export interface WorkspaceSearchResult {
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number | null;
}

export interface WorkspaceSearchOptions {
  signal?: AbortSignal;
}

export interface WorkspaceDocumentReadOptions {
  signal?: AbortSignal;
  expectedRevision?: string | null;
  maxBytes?: number;
  consumerId?: string;
  onDiagnostics?: (diagnostics: DocumentReadTransportDiagnostics) => void;
}

export interface WorkspaceDocumentWriteOptions {
  expectedRevision: string;
  writeId: string;
  signal?: AbortSignal;
}

export interface KeydexDiagnostic {
  code: string;
  reason: string;
  path?: string | null;
  severity: "warning" | "error";
  details: Record<string, unknown>;
}

export interface WorkspaceSkillSummary {
  name: string;
  description: string;
  source: "workspace" | "system";
  label: string;
  locator: string;
}

export interface WorkspaceSkillsResponse {
  workspace_root: string;
  fingerprint: string;
  loaded_at: string;
  skills: WorkspaceSkillSummary[];
  diagnostics: KeydexDiagnostic[];
}

export interface WorkspaceSkillListOptions {
  forceReload?: boolean;
  signal?: AbortSignal;
}

export type WorkspaceScope =
  | { workspaceId: string; sessionId?: never }
  | { sessionId: string; workspaceId?: never };

export type WorkspaceSessionScope = { sessionId: string; workspaceId?: never };

export interface WorkspaceRuntime {
  listDirectory(scope: WorkspaceScope, path?: string): Promise<WorkspaceTreeResponse>;
  listDirectorySubtree(
    scope: WorkspaceScope,
    path?: string,
    options?: WorkspaceSubtreeOptions,
  ): Promise<WorkspaceSubtreeResponse>;
  readFile(scope: WorkspaceScope, path: string): Promise<WorkspaceFileResponse>;
  readDocument(
    scope: WorkspaceScope,
    path: string,
    options?: WorkspaceDocumentReadOptions,
  ): Promise<DocumentReadResult>;
  writeDocument(
    scope: WorkspaceScope,
    path: string,
    content: string,
    options: WorkspaceDocumentWriteOptions,
  ): Promise<DocumentWriteResult>;
  readMedia(scope: WorkspaceScope, path: string): Promise<WorkspaceMediaResponse>;
  search(scope: WorkspaceScope, query: string, options?: WorkspaceSearchOptions): Promise<WorkspaceSearchResult[]>;
  listSkills(scope: WorkspaceScope, options?: WorkspaceSkillListOptions): Promise<WorkspaceSkillsResponse>;
  releaseDocumentConsumer(consumerId: string): void;
}

export function createWorkspaceRuntime(http: HttpClient): WorkspaceRuntime {
  const coordinator = new DocumentReadCoordinator();
  return {
    listDirectory(scope, path = "") {
      return http.request<WorkspaceTreeResponse>(
        `${workspaceBasePath(scope)}/tree?path=${encodeURIComponent(path)}`,
      );
    },
    listDirectorySubtree(scope, path = "", options = {}) {
      return http.request<WorkspaceSubtreeResponse>(
        `${workspaceBasePath(scope)}/tree/subtree${workspaceSubtreeQuery(path, options)}`,
        { signal: options.signal },
      );
    },
    readFile(scope, path) {
      return http.request<WorkspaceFileResponse>(
        `${workspaceBasePath(scope)}/read?path=${encodeURIComponent(path)}`,
      );
    },
    readDocument(scope, path, options = {}) {
      const scopeKey = workspaceScopeKey(scope);
      const consumerId = options.consumerId ?? `workspace-document-call-${nextDocumentConsumerId++}`;
      return coordinator.read({
        consumerId,
        documentKey: `workspace:${scopeKey}:${path}`,
        signal: options.signal,
        load: async (signal) => {
          const request = createDocumentReadRequest({
            request_id: `workspace-document-${nextDocumentRequestId++}`,
            document_id: `workspace:${scopeKey}:${path}`,
            source: "workspace",
            path,
            expected_revision: options.expectedRevision,
            preferred_transport: "auto",
            max_bytes: options.maxBytes ?? DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES,
          });
          const response = await http.requestRaw(`${workspaceBasePath(scope)}/read/document`, {
            method: "POST",
            body: request,
            signal,
          });
          return readDocumentNdjsonResponse(response, request, {
            signal,
            onDiagnostics: options.onDiagnostics,
          });
        },
      });
    },
    writeDocument(scope, path, content, options) {
      return http.request<DocumentWriteResult>(
        `${workspaceBasePath(scope)}/write/document`,
        {
          method: "POST",
          body: createDocumentWriteRequest(path, content, options.expectedRevision, options.writeId),
          signal: options.signal,
          silentStatuses: [409],
        },
      );
    },
    readMedia(scope, path) {
      return http.request<WorkspaceMediaResponse>(
        `${workspaceBasePath(scope)}/media?path=${encodeURIComponent(path)}`,
      );
    },
    search(scope, query, options = {}) {
      return http.request<WorkspaceSearchResult[]>(
        `${workspaceBasePath(scope)}/search?q=${encodeURIComponent(query)}`,
        { signal: options.signal },
      );
    },
    listSkills(scope, options = {}) {
      return http.request<WorkspaceSkillsResponse>(
        `${workspaceBasePath(scope)}/skills${workspaceSkillsQuery(options)}`,
        { signal: options.signal },
      );
    },
    releaseDocumentConsumer(consumerId) {
      coordinator.release(consumerId);
    },
  };
}

function workspaceScopeKey(scope: WorkspaceScope): string {
  if ("sessionId" in scope && scope.sessionId) return `session:${scope.sessionId}`;
  if ("workspaceId" in scope && scope.workspaceId) return `workspace:${scope.workspaceId}`;
  throw new Error("workspace scope requires sessionId or workspaceId");
}

let nextDocumentRequestId = 1;
let nextDocumentConsumerId = 1;

function workspaceBasePath(scope: WorkspaceScope): string {
  if ("sessionId" in scope && scope.sessionId) {
    return `/api/sessions/${encodeURIComponent(scope.sessionId)}/workspace`;
  }
  if ("workspaceId" in scope && scope.workspaceId) {
    return `/api/workspaces/${encodeURIComponent(scope.workspaceId)}`;
  }
  throw new Error("workspace scope requires sessionId or workspaceId");
}

function workspaceSkillsQuery(options: WorkspaceSkillListOptions): string {
  return options.forceReload ? "?force_reload=true" : "";
}

function workspaceSubtreeQuery(path: string, options: WorkspaceSubtreeOptions): string {
  const params = new URLSearchParams();
  params.set("path", path);
  if (typeof options.maxDepth === "number") {
    params.set("max_depth", String(options.maxDepth));
  }
  if (typeof options.maxDirs === "number") {
    params.set("max_dirs", String(options.maxDirs));
  }
  if (typeof options.maxEntries === "number") {
    params.set("max_entries", String(options.maxEntries));
  }
  if (typeof options.timeoutMs === "number") {
    params.set("timeout_ms", String(options.timeoutMs));
  }
  if (typeof options.includeFiles === "boolean") {
    params.set("include_files", String(options.includeFiles));
  }
  return `?${params.toString()}`;
}
