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

export interface WorkspaceRuntime {
  listDirectory(root: string, path?: string): Promise<WorkspaceTreeResponse>;
  readFile(root: string, path: string): Promise<WorkspaceFileResponse>;
  readMedia(root: string, path: string): Promise<WorkspaceMediaResponse>;
  search(root: string, query: string): Promise<WorkspaceSearchResult[]>;
}

export function createWorkspaceRuntime(http: HttpClient): WorkspaceRuntime {
  return {
    listDirectory(root, path = "") {
      return http.request<WorkspaceTreeResponse>(
        `/api/workspace/tree?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
      );
    },
    readFile(root, path) {
      return http.request<WorkspaceFileResponse>(
        `/api/workspace/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
      );
    },
    readMedia(root, path) {
      return http.request<WorkspaceMediaResponse>(
        `/api/workspace/media?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
      );
    },
    search(root, query) {
      return http.request<WorkspaceSearchResult[]>(
        `/api/workspace/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}`,
      );
    },
  };
}
