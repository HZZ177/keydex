import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { ConversationComposerAccessory } from "@/renderer/pages/conversation/ComposerAccessory";
import type {
  McpRuntimeCallSummary,
  McpRuntimeStatusResponse,
  McpServerSummary,
  McpToolSummary,
} from "@/types/protocol";

describe("MCP Runtime Panel", () => {
  it("shows snapshot summary and server groups", async () => {
    renderRuntimePanel(runtimeStatus());

    const pill = await screen.findByTestId("mcp-runtime-pill");
    await waitFor(() => expect(pill.textContent).toContain("snap_1"));
    expect(pill.textContent).toContain("2 个工具");

    fireEvent.click(pill);

    const panel = screen.getByTestId("mcp-runtime-panel");
    expect(panel.textContent).toContain("Online MCP");
    expect(panel.textContent).toContain("可用工具");
    expect(panel.textContent).toContain("等待确认");
    expect(panel.textContent).toContain("read_file description");
    expect(panel.textContent).toContain("始终允许");
    expect(panel.textContent).toContain("已启用");
  });

  it("keeps the panel open when a real click follows hover", async () => {
    renderRuntimePanel(runtimeStatus());

    const pill = await screen.findByTestId("mcp-runtime-pill");
    fireEvent.mouseEnter(pill);
    fireEvent.click(pill);

    expect(screen.getByTestId("mcp-runtime-panel").getAttribute("data-open")).toBe("true");
  });

  it("disables a tool for the current session without changing global policy", async () => {
    const disabledStatus = runtimeStatus({
      tools: [tool("tool_read", "read_file", { effective_state: "disabled_for_session" })],
      overrides: [
        {
          id: "override_1",
          session_id: "sess_1",
          server_id: "srv_1",
          raw_tool_name: "read_file",
          enabled: false,
          reason: "user_disabled",
          created_at: "2026-07-06T09:00:00Z",
        },
      ],
    });
    const { runtime, setSessionToolOverride } = runtimeWithStatuses(runtimeStatus(), disabledStatus);
    renderRuntimePanel(runtime);

    fireEvent.click(await screen.findByTestId("mcp-runtime-pill"));
    fireEvent.click(await screen.findByRole("switch", { name: "关闭 MCP 工具 read_file" }));

    await waitFor(() =>
      expect(setSessionToolOverride).toHaveBeenCalledWith("sess_1", "tool_read", {
        server_id: "srv_1",
        enabled: false,
        reason: "user_disabled_in_runtime_panel",
      }),
    );
    expect(await screen.findByText("已在当前会话禁用 read_file")).not.toBeNull();
    const panel = screen.getByTestId("mcp-runtime-panel");
    await waitFor(() => expect(panel.textContent).toContain("当前会话停用"));
    expect(panel.textContent).toMatch(/本会话停用\s*1/);
  });

  it("shows next-turn timing when enabling during a running turn", async () => {
    const disabledStatus = runtimeStatus({
      tools: [tool("tool_read", "read_file", { effective_state: "disabled_for_session" })],
      running_calls: [runningCall()],
    });
    const { runtime, setSessionToolOverride } = runtimeWithStatuses(disabledStatus);
    setSessionToolOverride.mockResolvedValue({
      applies_to_current_run: false,
      apply_timing: { scope: "next_turn" },
    });
    renderRuntimePanel(runtime, "running");

    fireEvent.click(await screen.findByTestId("mcp-runtime-pill"));
    fireEvent.click(await screen.findByRole("switch", { name: "启用 MCP 工具 read_file" }));

    await waitFor(() =>
      expect(setSessionToolOverride).toHaveBeenCalledWith("sess_1", "tool_read", {
        server_id: "srv_1",
        enabled: true,
        reason: "user_enabled_in_runtime_panel",
      }),
    );
    expect(await screen.findByText("已启用 read_file，下一轮生效")).not.toBeNull();
  });

  it("disables switches for offline servers", async () => {
    renderRuntimePanel(
      runtimeStatus({
        servers: [server("srv_2", "Offline MCP", { status: "offline" })],
        tools: [
          tool("tool_search", "search_docs", {
            server_id: "srv_2",
            server_name: "Offline MCP",
            effective_state: "server_offline",
          }),
        ],
      }),
    );

    fireEvent.click(await screen.findByTestId("mcp-runtime-pill"));
    const offlineSwitch = await screen.findByRole("switch", { name: "MCP 工具 search_docs 不可切换" });

    expect((offlineSwitch as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("mcp-runtime-panel").textContent).toContain("服务离线");
  });

  it("hides tools for disabled servers", async () => {
    renderRuntimePanel(
      runtimeStatus({
        servers: [server("srv_1", "Disabled MCP", { enabled: false, status: "disabled", tools_count: 0 })],
        tools: [
          tool("tool_read", "read_file", {
            server_name: "Disabled MCP",
            effective_state: "disabled_by_server",
          }),
        ],
        summary: {
          servers_total: 1,
          servers_online: 0,
          tools_total: 1,
          tools_enabled: 0,
          running_calls: 0,
          pending_approvals: 0,
        },
      }),
    );

    fireEvent.click(await screen.findByTestId("mcp-runtime-pill"));
    const panel = screen.getByTestId("mcp-runtime-panel");

    expect(panel.textContent).toContain("Disabled MCP");
    expect(panel.textContent).toContain("已停用");
    expect(panel.textContent).toContain("暂无可见工具");
    expect(panel.textContent).not.toContain("read_file");
    expect(panel.textContent).not.toContain("read_file description");
  });

  it("cancels a running MCP call", async () => {
    const before = runtimeStatus({ running_calls: [runningCall()] });
    const after = runtimeStatus({ running_calls: [] });
    const { runtime, cancelRuntimeCall } = runtimeWithStatuses(before, after);
    renderRuntimePanel(runtime, "running");

    fireEvent.click(await screen.findByTestId("mcp-runtime-pill"));
    fireEvent.click(await screen.findByRole("button", { name: "取消 MCP 调用 call_1" }));

    await waitFor(() => expect(cancelRuntimeCall).toHaveBeenCalledWith("call_1"));
    expect(await screen.findByText("已取消 read_file")).not.toBeNull();
  });
});

function renderRuntimePanel(statusOrRuntime: McpRuntimeStatusResponse | RuntimeBridge, runtimeState = "idle") {
  const runtime = "mcp" in statusOrRuntime ? statusOrRuntime : runtimeWithStatuses(statusOrRuntime).runtime;
  return render(
    <ConversationComposerAccessory
      messages={[]}
      mcpRuntime={{ runtime, sessionId: "sess_1", runtimeState }}
      showScrollToBottom={false}
      onFilePreview={vi.fn()}
      onScrollToBottom={vi.fn()}
    />,
  );
}

function runtimeWithStatuses(...statuses: McpRuntimeStatusResponse[]) {
  const fallback = statuses.at(-1) ?? runtimeStatus();
  const getRuntimeStatus = vi.fn();
  for (const status of statuses) {
    getRuntimeStatus.mockResolvedValueOnce(status);
  }
  getRuntimeStatus.mockResolvedValue(fallback);
  const setSessionToolOverride = vi.fn().mockResolvedValue({ applies_to_current_run: true });
  const cancelRuntimeCall = vi.fn().mockResolvedValue({ call_id: "call_1", cancelled: true });
  const runtime = {
    mcp: {
      getRuntimeStatus,
      setSessionToolOverride,
      cancelRuntimeCall,
    },
  } as unknown as RuntimeBridge;
  return { runtime, getRuntimeStatus, setSessionToolOverride, cancelRuntimeCall };
}

function runtimeStatus(patch: Partial<McpRuntimeStatusResponse> = {}): McpRuntimeStatusResponse {
  const servers = patch.servers ?? [server("srv_1", "Online MCP")];
  const tools = patch.tools ?? [tool("tool_read", "read_file"), tool("tool_write", "write_ticket")];
  const runningCalls = patch.running_calls ?? [];
  const overrides = patch.overrides ?? [];
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
      servers_online: servers.filter((item) => item.status === "online").length,
      tools_visible: tools.filter((item) => item.effective_state === "enabled").length,
      tools_disabled_for_session: tools.filter((item) => item.effective_state === "disabled_for_session").length,
      pending_approvals: 1,
      created_at: "2026-07-06T09:00:00Z",
    },
    servers,
    tools,
    overrides,
    running_calls: runningCalls,
    pending_approvals: 1,
    summary: {
      servers_total: servers.length,
      servers_online: servers.filter((item) => item.status === "online").length,
      tools_total: tools.length,
      tools_enabled: tools.filter((item) => item.effective_state === "enabled").length,
      running_calls: runningCalls.length,
      pending_approvals: 1,
    },
    ...patch,
  };
}

function server(id: string, name: string, patch: Partial<McpServerSummary> = {}): McpServerSummary {
  return {
    id,
    name,
    description: null,
    enabled: true,
    required: false,
    transport: "streamable_http",
    status: "online",
    tools_count: 2,
    resources_reserved: false,
    last_refresh_at: "2026-07-06T09:00:00Z",
    last_error_message: null,
    ...patch,
  };
}

function tool(id: string, rawName: string, patch: Partial<McpToolSummary> = {}): McpToolSummary {
  return {
    id,
    server_id: "srv_1",
    server_name: "Online MCP",
    raw_name: rawName,
    model_name: `mcp__srv_1__${rawName}`,
    display_name: null,
    description: `${rawName} description`,
    input_schema: { type: "object" },
    enabled: true,
    hidden: false,
    status: "unchanged",
    discovery_status: "unchanged",
    effective_state: "enabled",
    approval_mode: "auto",
    effective_approval_mode: "auto",
    schema_change_action: "require_review",
    parameter_constraints: null,
    annotations: {},
    last_used_at: null,
    call_count: 0,
    failure_count: 0,
    first_seen_at: "2026-07-06T08:00:00Z",
    last_seen_at: "2026-07-06T09:00:00Z",
    removed_at: null,
    ...patch,
  };
}

function runningCall(): McpRuntimeCallSummary {
  return {
    call_id: "call_1",
    session_id: "sess_1",
    snapshot_id: "snap_1",
    server_id: "srv_1",
    server_name: "Online MCP",
    raw_tool_name: "read_file",
    model_name: "mcp__srv_1__read_file",
    approval_mode: "auto",
    started_at: "2026-07-06T09:00:00Z",
    elapsed_ms: 1500,
  };
}
