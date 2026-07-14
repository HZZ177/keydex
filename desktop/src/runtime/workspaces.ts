import type { Workspace } from "@/types/protocol";

import type { HttpClient } from "./httpClient";
import {
  ArchiveCatalogContractError,
  type ArchiveWorkspacePayload,
  type PurgeResult,
  type RestoreWorkspacePayload,
  type WorkspaceArchiveResult,
  type WorkspaceRestoreResult,
} from "./archive";

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
  archive(workspaceId: string, payload: ArchiveWorkspacePayload): Promise<WorkspaceArchiveResult>;
  restore(workspaceId: string, payload: RestoreWorkspacePayload): Promise<WorkspaceRestoreResult>;
  purgeArchived(workspaceId: string, requestId: string, confirmationName: string): Promise<PurgeResult>;
  purgeArchivedSessions(workspaceId: string, requestId: string, confirmationName: string): Promise<PurgeResult>;
}

export function createWorkspacesRuntime(http: HttpClient): WorkspacesRuntime {
  return {
    list() {
      return http.request<WorkspaceListResponse>("/api/workspaces").then((response) => {
        if (response.list.some((workspace) => workspace.archived_at !== null)) {
          throw new ArchiveCatalogContractError("活动项目列表意外包含已归档项目");
        }
        return response;
      });
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
    archive(workspaceId, payload) {
      return http.request<WorkspaceArchiveResult>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/archive`,
        {
          method: "POST",
          body: {
            request_id: payload.requestId,
            stop_active_sessions: payload.stopActiveSessions ?? false,
          },
        },
      );
    },
    restore(workspaceId, payload) {
      return http.request<WorkspaceRestoreResult>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/restore`,
        {
          method: "POST",
          body: { request_id: payload.requestId, mode: payload.mode },
        },
      );
    },
    purgeArchived(workspaceId, requestId, confirmationName) {
      return http.request<PurgeResult>(
        `/api/archive/workspaces/${encodeURIComponent(workspaceId)}/purge`,
        {
          method: "POST",
          body: { request_id: requestId, confirmation_name: confirmationName },
        },
      );
    },
    purgeArchivedSessions(workspaceId, requestId, confirmationName) {
      return http.request<PurgeResult>(
        `/api/archive/workspaces/${encodeURIComponent(workspaceId)}/sessions/purge`,
        {
          method: "POST",
          body: { request_id: requestId, confirmation_name: confirmationName },
        },
      );
    },
  };
}
