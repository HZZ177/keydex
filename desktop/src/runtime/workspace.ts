import type { HttpClient } from "./httpClient";

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

export type WorkspaceFileAnnotationAnchorType = "file" | "selection";

export interface WorkspaceFileAnnotationAnchorV2 {
  version: 2;
  kind: "source-range";
  sourceStart: number;
  sourceEnd: number;
  selectedText: string;
  sourceText: string;
  contentHash: string;
  lineStart: number;
  lineEnd: number;
  columnStart: number;
  columnEnd: number;
  createdInView: "preview" | "source";
}

export interface WorkspaceFileAnnotation {
  id: string;
  scope_type: "session" | "workspace";
  scope_id: string;
  workspace_id?: string | null;
  path: string;
  anchor_type: WorkspaceFileAnnotationAnchorType;
  comment: string;
  selected_text?: string | null;
  line_start?: number | null;
  line_end?: number | null;
  column_start?: number | null;
  column_end?: number | null;
  content_hash?: string | null;
  anchor_json?: WorkspaceFileAnnotationAnchorV2 | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceFileAnnotationInput {
  path: string;
  anchor_type: WorkspaceFileAnnotationAnchorType;
  comment: string;
  selected_text?: string | null;
  line_start?: number | null;
  line_end?: number | null;
  column_start?: number | null;
  column_end?: number | null;
  content_hash?: string | null;
  anchor_json?: WorkspaceFileAnnotationAnchorV2 | null;
}

export interface WorkspaceFileAnnotationUpdate {
  anchor_type?: WorkspaceFileAnnotationAnchorType;
  comment?: string;
  selected_text?: string | null;
  line_start?: number | null;
  line_end?: number | null;
  column_start?: number | null;
  column_end?: number | null;
  content_hash?: string | null;
  anchor_json?: WorkspaceFileAnnotationAnchorV2 | null;
}

export interface WorkspaceAnnotationListOptions {
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
  readMedia(scope: WorkspaceScope, path: string): Promise<WorkspaceMediaResponse>;
  search(scope: WorkspaceScope, query: string, options?: WorkspaceSearchOptions): Promise<WorkspaceSearchResult[]>;
  listSkills(scope: WorkspaceScope, options?: WorkspaceSkillListOptions): Promise<WorkspaceSkillsResponse>;
  listAnnotations(
    scope: WorkspaceScope,
    path: string,
    options?: WorkspaceAnnotationListOptions,
  ): Promise<WorkspaceFileAnnotation[]>;
  createAnnotation(
    scope: WorkspaceScope,
    payload: WorkspaceFileAnnotationInput,
  ): Promise<WorkspaceFileAnnotation>;
  updateAnnotation(
    scope: WorkspaceScope,
    annotationId: string,
    payload: WorkspaceFileAnnotationUpdate,
  ): Promise<WorkspaceFileAnnotation>;
  deleteAnnotation(scope: WorkspaceScope, annotationId: string): Promise<void>;
}

export function createWorkspaceRuntime(http: HttpClient): WorkspaceRuntime {
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
    listAnnotations(scope, path, options = {}) {
      return http.request<WorkspaceFileAnnotation[]>(
        `${workspaceBasePath(scope)}/annotations?path=${encodeURIComponent(path)}`,
        { signal: options.signal },
      );
    },
    createAnnotation(scope, payload) {
      return http.request<WorkspaceFileAnnotation>(
        `${workspaceBasePath(scope)}/annotations`,
        {
          method: "POST",
          body: payload,
        },
      );
    },
    updateAnnotation(scope, annotationId, payload) {
      return http.request<WorkspaceFileAnnotation>(
        `${workspaceBasePath(scope)}/annotations/${encodeURIComponent(annotationId)}`,
        {
          method: "PATCH",
          body: payload,
        },
      );
    },
    deleteAnnotation(scope, annotationId) {
      return http.request<void>(
        `${workspaceBasePath(scope)}/annotations/${encodeURIComponent(annotationId)}`,
        { method: "DELETE" },
      );
    },
  };
}

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
