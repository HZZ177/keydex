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
}

export type WorkspaceScope =
  | { workspaceId: string; sessionId?: never }
  | { sessionId: string; workspaceId?: never };

export interface WorkspaceRuntime {
  listDirectory(scope: WorkspaceScope, path?: string): Promise<WorkspaceTreeResponse>;
  readFile(scope: WorkspaceScope, path: string): Promise<WorkspaceFileResponse>;
  readMedia(scope: WorkspaceScope, path: string): Promise<WorkspaceMediaResponse>;
  search(scope: WorkspaceScope, query: string): Promise<WorkspaceSearchResult[]>;
}

export function createWorkspaceRuntime(http: HttpClient): WorkspaceRuntime {
  return {
    listDirectory(scope, path = "") {
      return http.request<WorkspaceTreeResponse>(
        `${workspaceBasePath(scope)}/tree?path=${encodeURIComponent(path)}`,
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
    search(scope, query) {
      return http.request<WorkspaceSearchResult[]>(
        `${workspaceBasePath(scope)}/search?q=${encodeURIComponent(query)}`,
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
