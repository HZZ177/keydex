import type { Workspace } from "@/types/protocol";

import type { HttpClient } from "./httpClient";

export interface WorkspaceListResponse {
  list: Workspace[];
  total: number;
}

export interface WorkspaceResponse {
  workspace: Workspace;
}

export interface CreateWorkspacePayload {
  rootPath: string;
  name?: string | null;
}

export interface UpdateWorkspacePayload {
  name?: string | null;
  touch?: boolean;
}

export interface WorkspacesRuntime {
  list(): Promise<WorkspaceListResponse>;
  create(payload: CreateWorkspacePayload): Promise<Workspace>;
  get(workspaceId: string): Promise<Workspace>;
  update(workspaceId: string, payload: UpdateWorkspacePayload): Promise<Workspace>;
  delete(workspaceId: string): Promise<void>;
}

export function createWorkspacesRuntime(http: HttpClient): WorkspacesRuntime {
  return {
    list() {
      return http.request<WorkspaceListResponse>("/api/workspaces");
    },
    create(payload) {
      return http
        .request<WorkspaceResponse>("/api/workspaces", {
          method: "POST",
          body: {
            root_path: payload.rootPath,
            ...(payload.name !== undefined ? { name: payload.name } : {}),
          },
        })
        .then((response) => response.workspace);
    },
    get(workspaceId) {
      return http
        .request<WorkspaceResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}`)
        .then((response) => response.workspace);
    },
    update(workspaceId, payload) {
      return http
        .request<WorkspaceResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
          method: "PATCH",
          body: {
            ...(payload.name !== undefined ? { name: payload.name } : {}),
            ...(payload.touch !== undefined ? { touch: payload.touch } : {}),
          },
        })
        .then((response) => response.workspace);
    },
    delete(workspaceId) {
      return http.request<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: "DELETE",
      });
    },
  };
}
