import type { HttpClient } from "./httpClient";

export type SkillSource = "builtin" | "system" | "workspace";
export type EffectiveSkillsMode = "system_only" | "workspace_effective";

export interface KeydexDiagnostic {
  code: string;
  reason: string;
  path?: string | null;
  severity: "warning" | "error";
  details: Record<string, unknown>;
}

export interface SkillSummary {
  name: string;
  description: string;
  source: SkillSource;
  label: string;
  locator: string;
}

export interface EffectiveSkillsResponse {
  mode: EffectiveSkillsMode;
  workspace_root: string | null;
  fingerprint: string;
  loaded_at: string;
  skills: SkillSummary[];
  diagnostics: KeydexDiagnostic[];
}

export interface SkillListOptions {
  forceReload?: boolean;
  signal?: AbortSignal;
}

export interface SkillResourceReadRequest {
  skill_name: string;
  source: SkillSource;
  resource_path: string;
}

export interface SkillResourceReadOptions {
  signal?: AbortSignal;
}

export interface SkillResourceReadResponse {
  skill_name: string;
  source: SkillSource;
  resource_path: string;
  locator: string;
  content: string;
  encoding: "utf-8";
  revision: string;
  fingerprint: string;
}

export interface SkillRuntime {
  listSystem(options?: SkillListOptions): Promise<EffectiveSkillsResponse>;
  listWorkspace(
    workspaceId: string,
    options?: SkillListOptions,
  ): Promise<EffectiveSkillsResponse>;
  listSession(
    sessionId: string,
    options?: SkillListOptions,
  ): Promise<EffectiveSkillsResponse>;
  readSystemResource(
    request: SkillResourceReadRequest,
    options?: SkillResourceReadOptions,
  ): Promise<SkillResourceReadResponse>;
  readWorkspaceResource(
    workspaceId: string,
    request: SkillResourceReadRequest,
    options?: SkillResourceReadOptions,
  ): Promise<SkillResourceReadResponse>;
  readSessionResource(
    sessionId: string,
    request: SkillResourceReadRequest,
    options?: SkillResourceReadOptions,
  ): Promise<SkillResourceReadResponse>;
}

export interface KeydexRuntimeDiagnostic {
  code: string;
  reason: string;
  severity: "warning" | "error";
  details: Record<string, unknown>;
  capability_id?: string | null;
  scope?: SkillSource | null;
  logical_path?: string | null;
}

export interface KeydexLayerCapabilityOverview {
  supported: boolean;
  available: boolean;
  state: "loaded" | "empty" | "failed" | "unsupported";
  fingerprint: string;
  sources: string[];
  diagnostics: KeydexRuntimeDiagnostic[];
}

export interface KeydexLayerOverview {
  scope: SkillSource;
  fingerprint: string;
  capabilities: Record<string, KeydexLayerCapabilityOverview>;
}

export interface KeydexCapabilityOverview {
  available: boolean;
  fingerprint: string;
  sources: string[];
  diagnostics: KeydexRuntimeDiagnostic[];
  count?: number;
  document_count?: number;
  total_bytes?: number;
}

export interface RuntimeOverviewResponse {
  mode: EffectiveSkillsMode;
  fingerprint: string;
  loaded_at: string;
  layers: KeydexLayerOverview[];
  capabilities: Record<string, KeydexCapabilityOverview>;
  diagnostics: KeydexRuntimeDiagnostic[];
}

export interface KeydexRuntime {
  listSystem(options?: SkillListOptions): Promise<RuntimeOverviewResponse>;
  listWorkspace(
    workspaceId: string,
    options?: SkillListOptions,
  ): Promise<RuntimeOverviewResponse>;
  listSession(
    sessionId: string,
    options?: SkillListOptions,
  ): Promise<RuntimeOverviewResponse>;
}

export function createSkillRuntime(http: HttpClient): SkillRuntime {
  return {
    listSystem(options = {}) {
      return list(http, "/api/keydex/skills", options);
    },
    listWorkspace(workspaceId, options = {}) {
      return list(
        http,
        `/api/workspaces/${encodeURIComponent(workspaceId)}/skills`,
        options,
      );
    },
    listSession(sessionId, options = {}) {
      return list(
        http,
        `/api/sessions/${encodeURIComponent(sessionId)}/skills`,
        options,
      );
    },
    readSystemResource(request, options = {}) {
      return read(http, "/api/keydex/skills/read", request, options);
    },
    readWorkspaceResource(workspaceId, request, options = {}) {
      return read(
        http,
        `/api/workspaces/${encodeURIComponent(workspaceId)}/skills/read`,
        request,
        options,
      );
    },
    readSessionResource(sessionId, request, options = {}) {
      return read(
        http,
        `/api/sessions/${encodeURIComponent(sessionId)}/skills/read`,
        request,
        options,
      );
    },
  };
}

export function createKeydexRuntime(http: HttpClient): KeydexRuntime {
  return {
    listSystem(options = {}) {
      return listRuntime(http, "/api/keydex/runtime", options);
    },
    listWorkspace(workspaceId, options = {}) {
      return listRuntime(
        http,
        `/api/workspaces/${encodeURIComponent(workspaceId)}/keydex/runtime`,
        options,
      );
    },
    listSession(sessionId, options = {}) {
      return listRuntime(
        http,
        `/api/sessions/${encodeURIComponent(sessionId)}/keydex/runtime`,
        options,
      );
    },
  };
}

function list(
  http: HttpClient,
  path: string,
  options: SkillListOptions,
): Promise<EffectiveSkillsResponse> {
  const query = options.forceReload ? "?force_reload=true" : "";
  return http.request<EffectiveSkillsResponse>(`${path}${query}`, {
    signal: options.signal,
  });
}

function read(
  http: HttpClient,
  path: string,
  request: SkillResourceReadRequest,
  options: SkillResourceReadOptions,
): Promise<SkillResourceReadResponse> {
  return http.request<SkillResourceReadResponse>(path, {
    method: "POST",
    body: request,
    signal: options.signal,
  });
}

function listRuntime(
  http: HttpClient,
  path: string,
  options: SkillListOptions,
): Promise<RuntimeOverviewResponse> {
  const query = options.forceReload ? "?force_reload=true" : "";
  return http.request<RuntimeOverviewResponse>(`${path}${query}`, {
    signal: options.signal,
  });
}
