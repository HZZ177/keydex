import { render, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";
import {
  createInitialAgentConversationState,
  reduceAgentWsEvent,
  type AgentConversationState,
} from "@/renderer/stores/agentSessionStore";
import type {
  AgentActionEnvelope,
  CommandApprovalRequest,
  McpAuditListResponse,
  McpConnectionTestResponse,
  McpImportPreviewResponse,
  McpRefreshAllResponse,
  McpRefreshResult,
  McpRuntimeStatusResponse,
  McpServerDetailResponse,
  McpServerListResponse,
  McpServerSummary,
  McpToolListResponse,
  McpToolSummary,
} from "@/types/protocol";

export type McpRuntimeMockMode = "success" | "loading" | "error";

export interface McpRuntimeMockOptions {
  mode?: McpRuntimeMockMode;
  error?: Error;
  servers?: McpServerSummary[];
  detail?: McpServerDetailResponse;
  tools?: McpToolSummary[];
  runtimeStatus?: McpRuntimeStatusResponse;
}

export interface McpRuntimeMock {
  runtime: RuntimeBridge;
  mcp: RuntimeBridge["mcp"];
}

export const MCP_FRONTEND_VITEST_COMMANDS = [
  "pnpm --dir desktop exec vitest run desktop/tests/mcp-console-page.spec.tsx",
  "pnpm --dir desktop exec vitest run desktop/tests/mcp-runtime-panel.spec.tsx",
  "pnpm --dir desktop exec vitest run desktop/tests/approval-prompt.spec.tsx",
  "pnpm --dir desktop exec vitest run desktop/tests/mcp-elicitation-prompt.spec.tsx",
  "pnpm --dir desktop exec vitest run desktop/tests/agent-session-store.spec.ts",
] as const;

export const MCP_FRONTEND_COVERAGE_INDEX = {
  console: {
    issue: "MCP-077",
    e2e: "MCP-097",
    tests: ["desktop/tests/mcp-console-page.spec.tsx"],
  },
  runtimePanel: {
    issue: "MCP-076",
    e2e: "MCP-096",
    tests: ["desktop/tests/mcp-runtime-panel.spec.tsx"],
  },
  approvalCard: {
    issue: "MCP-071",
    e2e: "MCP-091",
    tests: ["desktop/tests/approval-prompt.spec.tsx"],
  },
  elicitation: {
    issue: "MCP-073",
    e2e: "MCP-093",
    tests: ["desktop/tests/mcp-elicitation-prompt.spec.tsx", "desktop/tests/agent-session-store.spec.ts"],
  },
  sampling: {
    issue: "MCP-074",
    e2e: "MCP-094",
    tests: ["desktop/tests/mcp-console-page.spec.tsx", "desktop/tests/approval-prompt.spec.tsx"],
  },
  logs: {
    issue: "MCP-078",
    e2e: "MCP-098",
    tests: ["desktop/tests/mcp-console-page.spec.tsx"],
  },
} as const;

export function createMcpRuntimeMock(options: McpRuntimeMockOptions = {}): McpRuntimeMock {
  const mode = options.mode ?? "success";
  const servers = options.servers ?? [mcpServerSummary()];
  const detail = options.detail ?? mcpServerDetail(servers[0]);
  const tools = options.tools ?? [mcpToolSummary()];
  const runtimeStatus = options.runtimeStatus ?? mcpRuntimeStatus({ tools });
  const resolve = <T,>(value: T): Promise<T> => {
    if (mode === "loading") {
      return new Promise<T>(() => undefined);
    }
    if (mode === "error") {
      return Promise.reject(options.error ?? new Error("MCP mock failure"));
    }
    return Promise.resolve(value);
  };
  const mcp = {
    listServers: vi.fn(() => resolve<McpServerListResponse>({ list: servers, total: servers.length, limit: 500, offset: 0 })),
    createServer: vi.fn(() => resolve(detail)),
    getServer: vi.fn(() => resolve(detail)),
    updateServer: vi.fn((_serverId: string, payload: Partial<McpServerDetailResponse>) => resolve({ ...detail, ...payload })),
    deleteServer: vi.fn((serverId: string) => resolve({ deleted: true, server_id: serverId })),
    toggleServer: vi.fn((serverId: string, enabled: boolean) => resolve({ ...servers[0], id: serverId, enabled })),
    testServer: vi.fn((serverId: string) => resolve<McpConnectionTestResponse>({
      ok: true,
      server_id: serverId,
      status: "online",
      capabilities: { tools: true },
    })),
    refreshServer: vi.fn((serverId: string) => resolve<McpRefreshResult>({
      ok: true,
      server_id: serverId,
      status: "online",
      tools_count: tools.length,
      resources_reserved_count: 0,
    })),
    refreshServers: vi.fn(() => resolve<McpRefreshAllResponse>({ ok: true, list: [], total: 0 })),
    listTools: vi.fn(() => resolve<McpToolListResponse>({ list: tools, total: tools.length, limit: 500 })),
    updateToolPolicy: vi.fn((_serverId: string, _toolId: string, payload: Partial<McpToolSummary>) => resolve({ ...tools[0], ...payload })),
    applyToolBulkPolicy: vi.fn((_serverId: string, payload: { action: string }) => resolve({
      server_id: detail.id,
      action: payload.action,
      updated_count: tools.length,
      tools,
    })),
    getRuntimeStatus: vi.fn(() => resolve(runtimeStatus)),
    setSessionToolOverride: vi.fn(() => resolve({ applies_to_current_run: true })),
    clearSessionToolOverride: vi.fn(() => resolve({ deleted: true })),
    cancelRuntimeCall: vi.fn((callId: string) => resolve({ call_id: callId, cancelled: true })),
    importConfig: vi.fn(() => resolve<McpImportPreviewResponse>({
      source_type: "keydex",
      conflict_strategy: "skip",
      server_count: 0,
      servers: [],
      conflicts: [],
      missing_secrets: [],
      unknown_fields: [],
      valid: true,
      applied: false,
      created_count: 0,
      skipped_count: 0,
      created: [],
      skipped: [],
    })),
    exportConfig: vi.fn(() => resolve({ format: "keydex.mcp.v1", servers: [], tool_policies: [] })),
    resolveApproval: vi.fn((approvalId: string) => resolve({
      id: approvalId,
      session_id: "sess_1",
      command: "",
      cwd: null,
      reason: null,
      status: "approved",
      decision: "approved",
      created_at: "2026-07-06T09:00:00Z",
      resolved_at: "2026-07-06T09:00:01Z",
      details: {},
    })),
    startOAuth: vi.fn((serverId: string) => resolve({
      server_id: serverId,
      auth_url: "https://mcp.example.test/oauth/authorize",
      state: "state",
    })),
    completeOAuth: vi.fn((serverId: string) => resolve({
      server_id: serverId,
      status: "active",
      token_configured: true,
      scopes: ["tools:read"],
    })),
    getOAuthStatus: vi.fn((serverId: string) => resolve({
      server_id: serverId,
      status: "revoked",
      token_configured: false,
      scopes: [],
    })),
    clearOAuth: vi.fn((serverId: string) => resolve({
      server_id: serverId,
      status: "revoked",
      token_configured: false,
      scopes: [],
    })),
    listAudit: vi.fn(() => resolve<McpAuditListResponse>({ list: [], total: 0, limit: 100, offset: 0 })),
    listTrustRules: vi.fn(() => resolve({ list: [] })),
    createTrustRule: vi.fn((payload: Record<string, unknown>) => resolve({
      id: "trust_1",
      rule_kind: String(payload.rule_kind ?? "tool"),
      scope: String(payload.scope ?? "global"),
      approval_mode: String(payload.approval_mode ?? "approve"),
      server_id: String(payload.server_id ?? detail.id),
      raw_tool_name: typeof payload.raw_tool_name === "string" ? payload.raw_tool_name : null,
      session_id: typeof payload.session_id === "string" ? payload.session_id : null,
      condition: null,
      hit_count: 0,
      created_from_approval_id: null,
      created_at: "2026-07-06T09:00:00Z",
      expires_at: null,
      last_hit_at: null,
    })),
    deleteTrustRule: vi.fn((ruleId: string) => resolve({ deleted: true, rule_id: ruleId })),
  } as unknown as RuntimeBridge["mcp"];
  return { runtime: { mcp } as RuntimeBridge, mcp };
}

export function renderWithMcpRouter(ui: React.ReactElement, route = "/settings/mcp"): RenderResult {
  return render(
    <ThemeProvider>
      <LayoutStateProvider>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </LayoutStateProvider>
    </ThemeProvider>,
  );
}

export function createMcpAgentStoreState(
  events: AgentActionEnvelope[] = [mcpToolStartEvent()],
): AgentConversationState {
  return events.reduce(
    (state, event) => reduceAgentWsEvent(state, event),
    createInitialAgentConversationState(),
  );
}

export function mcpToolStartEvent(patch: Record<string, unknown> = {}): AgentActionEnvelope {
  return {
    action: "tool_start",
    data: {
      session_id: "sess_1",
      run_id: "run_mcp",
      tool_name: "mcp__srv_1__read_file",
      kind: "mcp_tool",
      snapshot_id: "snap_1",
      server_id: "srv_1",
      server_name: "Filesystem MCP",
      raw_tool_name: "read_file",
      model_tool_name: "mcp__srv_1__read_file",
      metadata: { mcp: { approval_mode: "auto" } },
      ...patch,
    },
  };
}

export function mcpApprovalRequestedEvent(patch: Partial<CommandApprovalRequest> = {}): AgentActionEnvelope {
  const approval: CommandApprovalRequest = {
    id: "approval_mcp",
    session_id: "sess_1",
    thread_id: "sess_1",
    turn_id: "turn_mcp",
    item_id: "item_mcp",
    call_id: "call_mcp",
    run_id: "run_mcp",
    tool_name: "mcp__srv_1__read_file",
    kind: "mcp_tool_call",
    title: "是否允许调用 MCP 工具？",
    description: "请求调用 Filesystem MCP 的 read_file 工具。",
    details: { approval_kind: "mcp_tool_call" },
    status: "pending",
    decision: null,
    trust_scope: null,
    server_id: "srv_1",
    server_name: "Filesystem MCP",
    raw_tool_name: "read_file",
    model_tool_name: "mcp__srv_1__read_file",
    snapshot_id: "snap_1",
    metadata: { mcp: { approval_mode: "prompt" } },
    created_at: "2026-07-06T09:00:00Z",
    resolved_at: null,
    ...patch,
  };
  return {
    action: "approval_requested",
    data: {
      session_id: "sess_1",
      approval,
    },
  };
}

export function mcpRuntimeSnapshotEvent(patch: Record<string, unknown> = {}): AgentActionEnvelope {
  return {
    action: "mcp_runtime_snapshot_created",
    data: {
      session_id: "sess_1",
      snapshot_id: "snap_1",
      servers_total: 1,
      servers_online: 1,
      tools_visible: 1,
      pending_approvals: 0,
      ...patch,
    },
  };
}

export function mcpServerSummary(patch: Partial<McpServerSummary> = {}): McpServerSummary {
  return {
    id: "srv_1",
    name: "Filesystem MCP",
    description: null,
    enabled: true,
    required: false,
    transport: "streamable_http",
    status: "online",
    tools_count: 1,
    resources_reserved: true,
    last_refresh_at: "2026-07-06T09:00:00Z",
    last_error_message: null,
    ...patch,
  };
}

export function mcpServerDetail(
  summary: McpServerSummary = mcpServerSummary(),
  patch: Partial<McpServerDetailResponse> = {},
): McpServerDetailResponse {
  return {
    ...summary,
    command: null,
    args: [],
    cwd: null,
    url: "https://mcp.example.test/mcp",
    sse_url: null,
    message_url: null,
    inherit_environment: true,
    env_keys: [],
    header_keys: [],
    env_header_keys: [],
    bearer_token_env_var: null,
    auth_type: "none",
    secret_ref_keys: [],
    oauth_configured: false,
    oauth_resource: null,
    oauth_scopes: [],
    startup_timeout_sec: 30,
    tool_timeout_sec: 60,
    read_timeout_sec: 60,
    sse_read_timeout_sec: 300,
    shutdown_timeout_sec: 10,
    restart_policy: "on_failure",
    connect_mode: "on_demand",
    auto_refresh: true,
    refresh_interval_sec: 1800,
    default_tool_exposure_mode: "allow_all_except_disabled",
    default_tool_approval_mode: "auto",
    supports_parallel_tool_calls: false,
    elicitation_enabled: true,
    sampling_enabled: false,
    sampling_approval_mode: "prompt",
    sampling_model_policy: "current_default",
    sampling_max_tokens: 2048,
    sampling_audit_detail: "summary",
    resource_reserved_policy: null,
    ...patch,
  };
}

export function mcpToolSummary(patch: Partial<McpToolSummary> = {}): McpToolSummary {
  return {
    id: "tool_1",
    server_id: "srv_1",
    server_name: "Filesystem MCP",
    raw_name: "read_file",
    model_name: "mcp__srv_1__read_file",
    display_name: null,
    description: "Read a workspace file",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
    enabled: true,
    hidden: false,
    status: "unchanged",
    discovery_status: "unchanged",
    effective_state: "enabled",
    approval_mode: "auto",
    effective_approval_mode: "auto",
    schema_change_action: "require_review",
    parameter_constraints: null,
    annotations: { readOnlyHint: true },
    last_used_at: null,
    call_count: 0,
    failure_count: 0,
    first_seen_at: "2026-07-06T08:00:00Z",
    last_seen_at: "2026-07-06T09:00:00Z",
    removed_at: null,
    ...patch,
  };
}

export function mcpRuntimeStatus(
  patch: Partial<McpRuntimeStatusResponse> = {},
): McpRuntimeStatusResponse {
  const servers = patch.servers ?? [mcpServerSummary()];
  const tools = patch.tools ?? [mcpToolSummary()];
  return {
    session_id: "sess_1",
    manager: {
      enabled: true,
      runtime_status: "started",
      started: true,
      active_client_count: 1,
    },
    snapshot: {
      id: "snap_1",
      snapshot_id: "snap_1",
      session_id: "sess_1",
      servers_total: servers.length,
      servers_online: servers.filter((server) => server.status === "online").length,
      tools_visible: tools.filter((tool) => tool.effective_state === "enabled").length,
      tools_disabled_for_session: tools.filter((tool) => tool.effective_state === "disabled_for_session").length,
      pending_approvals: 0,
      created_at: "2026-07-06T09:00:00Z",
    },
    servers,
    tools,
    overrides: [],
    running_calls: [],
    pending_approvals: 0,
    summary: {
      servers_total: servers.length,
      servers_online: servers.filter((server) => server.status === "online").length,
      tools_total: tools.length,
      tools_enabled: tools.filter((tool) => tool.effective_state === "enabled").length,
      running_calls: 0,
      pending_approvals: 0,
    },
    ...patch,
  };
}
