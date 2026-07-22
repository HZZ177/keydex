import type { HttpClient } from "./httpClient";

export type RightSidebarScopeKind = "session" | "workspace" | "global";
export type RightSidebarPromotionSourceKind = "workspace" | "global";

export interface RightSidebarScopeRef {
  kind: RightSidebarScopeKind;
  id: string | null;
}

export interface RightSidebarScopeRecord<TState = unknown> {
  id: string;
  scope_kind: RightSidebarScopeKind;
  scope_id: string | null;
  schema_version: 2;
  state: TState;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface RightSidebarPromotionRequest {
  source_scope_kind: RightSidebarPromotionSourceKind;
  source_scope_id: string | null;
  source_revision: number;
  target_session_id: string;
}

export interface RightSidebarPromotionResponse<TState = unknown> {
  source_scope_kind: RightSidebarPromotionSourceKind;
  source_scope_id: string | null;
  source_revision: number;
  target_session_id: string;
  target: RightSidebarScopeRecord<TState>;
  panel_id_mapping: Record<string, string>;
  idempotent_replay: boolean;
}

export interface RightSidebarRuntime {
  get<TState = unknown>(
    scope: RightSidebarScopeRef,
    signal?: AbortSignal,
  ): Promise<RightSidebarScopeRecord<TState> | null>;
  put<TState = unknown>(
    scope: RightSidebarScopeRef,
    state: TState,
    expectedRevision: number,
  ): Promise<RightSidebarScopeRecord<TState>>;
  delete(scope: RightSidebarScopeRef): Promise<void>;
  promote<TState = unknown>(
    request: RightSidebarPromotionRequest,
  ): Promise<RightSidebarPromotionResponse<TState>>;
}

export function createRightSidebarRuntime(http: HttpClient): RightSidebarRuntime {
  return {
    get(scope, signal) {
      return http.request(rightSidebarScopePath(scope), {
        signal,
        silentStatuses: [404],
      });
    },
    put(scope, state, expectedRevision) {
      return http.request(rightSidebarScopePath(scope), {
        method: "PUT",
        headers: { "If-Match": String(expectedRevision) },
        body: {
          schema_version: 2,
          state,
          expected_revision: expectedRevision,
        },
      });
    },
    delete(scope) {
      return http.request<void>(rightSidebarScopePath(scope), { method: "DELETE" });
    },
    promote(request) {
      return http.request("/api/ui/right-sidebar/promotions", {
        method: "POST",
        body: request,
      });
    },
  };
}

export function rightSidebarScopePath(scope: RightSidebarScopeRef): string {
  if (scope.kind === "global") {
    if (scope.id !== null) throw new Error("Global right sidebar scope cannot have an id");
    return "/api/ui/right-sidebar/scopes/global";
  }
  const scopeId = scope.id?.trim();
  if (!scopeId) throw new Error("Right sidebar scope id is required");
  return `/api/ui/right-sidebar/scopes/${scope.kind}/${encodeURIComponent(scopeId)}`;
}
