import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { ConversationComposerAccessory } from "@/renderer/pages/conversation/ComposerAccessory";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type {
  McpRuntimeCallSummary,
  McpRuntimeStatusResponse,
  McpServerSummary,
  McpToolSummary,
} from "@/types/protocol";

describe("MCP Runtime Panel", () => {
  it("stays manual by default and renders compact capability status without technical controls", async () => {
    const onOpenSettings = vi.fn();
    renderRuntimePanel(runtimeStatus(), { onOpenSettings });

    expect(screen.queryByTestId("mcp-runtime-pill")).toBeNull();
    expect(screen.getByTestId("typing-speed-pill")).not.toBeNull();

    const pill = await selectMcpRuntimePill();
    await waitFor(() => expect(pill.textContent).toContain("1 个 MCP 服务器 · 2 个工具"));
    expect(pill.textContent).not.toContain("snap_1");
    expect(pill.textContent).not.toMatch(/\b(runtime|snapshot|deferred|threshold|tool)\b/iu);

    fireEvent.click(pill);

    const panel = screen.getByTestId("mcp-runtime-panel");
    expect(panel.textContent).toContain("MCP 当前会话");
    expect(panel.textContent).toContain("1/1 个服务在线");
    expect(panel.textContent).toContain("2 个工具可用");
    expect(panel.textContent).toContain("能力状态");
    expect(panel.textContent).toContain("能力目录");
    expect(panel.textContent).toContain("1 个服务");
    expect(panel.textContent).toContain("直接可用");
    expect(panel.textContent).toContain("按需加载");
    expect(panel.textContent).toContain("Online MCP");
    expect(panel.textContent).toContain("在线，直接可用 1 个，按需加载 1 个");
    expect(panel.textContent).toContain("最近激活");
    expect(panel.textContent).toContain("Online MCP / read_file");
    expect(panel.textContent).toContain("已在当前会话直接可用");
    expect(panel.textContent).not.toContain("运行快照");
    expect(panel.textContent).not.toContain("snap_1");
    expect(panel.textContent).not.toContain("read_file description");
    expect(panel.textContent).not.toMatch(/\b(runtime|snapshot|deferred|threshold|tool)\b/iu);
    expect(within(panel).queryByRole("switch")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "打开 MCP 设置" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("shows an empty capability state before a runtime snapshot exists", async () => {
    renderRuntimePanel(runtimeStatus({ snapshot: null }));

    fireEvent.click(await selectMcpRuntimePill());
    const panel = screen.getByTestId("mcp-runtime-panel");

    expect(panel.textContent).toContain("暂无能力数据");
    expect(panel.textContent).toContain("发送消息后会显示当前会话可用的 MCP 能力。");
    expect(panel.textContent).not.toContain("运行快照");
    expect(panel.textContent).not.toMatch(/\b(runtime|snapshot|deferred|threshold|tool)\b/iu);
  });

  it("automatically shows MCP only for the turn that contains an MCP tool call", async () => {
    const props = {
      statusOrRuntime: runtimeStatus(),
      messages: [userMessage("turn-1"), mcpToolMessage("turn-1")],
    };
    const view = renderRuntimePanel(props.statusOrRuntime, { messages: props.messages });

    expect(await screen.findByTestId("mcp-runtime-pill")).not.toBeNull();

    view.rerender(
      runtimePanelElement(runtimeWithStatuses(runtimeStatus()).runtime, {
        messages: [...props.messages, userMessage("turn-2")],
      }),
    );

    expect(screen.queryByTestId("mcp-runtime-pill")).toBeNull();
    expect(screen.getByTestId("typing-speed-pill")).not.toBeNull();
  });

  it("summarizes issues without rendering the server tool list", async () => {
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

    fireEvent.click(await selectMcpRuntimePill());
    const panel = screen.getByTestId("mcp-runtime-panel");

    expect(panel.textContent).toContain("MCP 需要处理");
    expect(panel.textContent).toContain("Offline MCP");
    expect(panel.textContent).toContain("服务离线");
    expect(panel.textContent).not.toContain("search_docs");
    expect(within(panel).queryByRole("switch")).toBeNull();
  });

  it("shows running MCP calls as status, not cancellable controls", async () => {
    renderRuntimePanel(runtimeStatus({ running_calls: [runningCall()] }), { runtimeState: "running" });

    fireEvent.click(await selectMcpRuntimePill());
    const panel = screen.getByTestId("mcp-runtime-panel");

    expect(panel.textContent).toContain("MCP 正在执行");
    expect(panel.textContent).toContain("Online MCP / read_file");
    expect(panel.textContent).toContain("已运行 2s");
    expect(within(panel).queryByRole("button", { name: /取消 MCP 调用/ })).toBeNull();
  });
});

async function selectMcpRuntimePill() {
  fireEvent.click(screen.getByTestId("composer-accessory-switcher"));
  fireEvent.click(within(screen.getByTestId("composer-accessory-menu")).getByRole("menuitemradio", { name: /MCP/ }));
  return screen.findByTestId("mcp-runtime-pill");
}

function renderRuntimePanel(
  statusOrRuntime: McpRuntimeStatusResponse | RuntimeBridge,
  options: {
    messages?: ConversationMessage[];
    onOpenSettings?: () => void;
    runtimeState?: string;
  } = {},
) {
  const runtime = "mcp" in statusOrRuntime ? statusOrRuntime : runtimeWithStatuses(statusOrRuntime).runtime;
  return render(runtimePanelElement(runtime, options));
}

function runtimePanelElement(
  runtime: RuntimeBridge,
  {
    messages = [],
    onOpenSettings,
    runtimeState = "idle",
  }: {
    messages?: ConversationMessage[];
    onOpenSettings?: () => void;
    runtimeState?: string;
  } = {},
) {
  return (
    <ConversationComposerAccessory
      messages={messages}
      mcpRuntime={{ runtime, sessionId: "sess_1", runtimeState }}
      onOpenMcpSettings={onOpenSettings}
      showScrollToBottom={false}
      onFilePreview={vi.fn()}
      onScrollToBottom={vi.fn()}
    />
  );
}

function runtimeWithStatuses(...statuses: McpRuntimeStatusResponse[]) {
  const fallback = statuses.at(-1) ?? runtimeStatus();
  const getRuntimeStatus = vi.fn();
  for (const status of statuses) {
    getRuntimeStatus.mockResolvedValueOnce(status);
  }
  getRuntimeStatus.mockResolvedValue(fallback);
  const runtime = {
    mcp: {
      getRuntimeStatus,
    },
  } as unknown as RuntimeBridge;
  return { runtime, getRuntimeStatus };
}

function runtimeStatus(patch: Partial<McpRuntimeStatusResponse> = {}): McpRuntimeStatusResponse {
  const servers = patch.servers ?? [server("srv_1", "Online MCP")];
  const tools = patch.tools ?? [tool("tool_read", "read_file"), tool("tool_write", "write_ticket")];
  const runningCalls = patch.running_calls ?? [];
  const overrides = patch.overrides ?? [];
  const enabledTools = tools.filter((item) => item.effective_state === "enabled");
  const visibleTools = enabledTools.map((item, index) => ({
    server_id: item.server_id,
    server_name: item.server_name,
    raw_name: item.raw_name,
    model_name: item.model_name,
    description: item.description,
    exposure: index === 0 ? "direct" : "on_demand",
  }));
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
      pending_approvals: 0,
      visible_tools: visibleTools,
      capability_directory: servers.map((item) => ({
        server_id: item.id,
        server_name: item.name,
        status: item.status,
        status_label: item.status === "online" ? "在线" : item.status,
        direct_tool_count: item.id === "srv_1" ? 1 : 0,
        on_demand_tool_count: item.id === "srv_1" ? Math.max(0, enabledTools.length - 1) : 0,
      })),
      direct_available_tools: enabledTools.length > 0 ? 1 : 0,
      on_demand_tools: Math.max(0, enabledTools.length - 1),
      unavailable_tools: tools.length - enabledTools.length,
      policy_summary: {
        active_model_names: visibleTools.slice(0, 1).map((item) => item.model_name),
      },
      created_at: "2026-07-06T09:00:00Z",
    },
    servers,
    tools,
    overrides,
    running_calls: runningCalls,
    pending_approvals: 0,
    summary: {
      servers_total: servers.length,
      servers_online: servers.filter((item) => item.status === "online").length,
      tools_total: tools.length,
      tools_enabled: tools.filter((item) => item.effective_state === "enabled").length,
      running_calls: runningCalls.length,
      pending_approvals: 0,
    },
    ...patch,
  };
}

function userMessage(turnId: string): ConversationMessage {
  return {
    id: `user-${turnId}`,
    threadId: "sess_1",
    turnId,
    itemId: `item-user-${turnId}`,
    kind: "user",
    content: "run mcp",
    payload: {},
    createdAt: "2026-07-06T09:00:00Z",
    updatedAt: "2026-07-06T09:00:00Z",
  };
}

function mcpToolMessage(turnId: string): ConversationMessage {
  return {
    id: `tool-${turnId}`,
    threadId: "sess_1",
    turnId,
    itemId: `item-tool-${turnId}`,
    kind: "tool",
    status: "completed",
    content: "mcp__srv_1__read_file",
    payload: {
      call: {
        name: "mcp__srv_1__read_file",
      },
      metadata: {
        mcp: {
          kind: "mcp_tool",
          server_id: "srv_1",
          raw_tool_name: "read_file",
        },
      },
    },
    createdAt: "2026-07-06T09:00:01Z",
    updatedAt: "2026-07-06T09:00:01Z",
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
