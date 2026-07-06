import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { APP_INSERT_MCP_PROMPT_DRAFT_EVENT, clearPendingMcpPromptDrafts } from "@/renderer/events/mcpPromptDraft";
import { McpConsolePage } from "@/renderer/pages/mcp/McpConsolePage";
import type {
  McpAuditListResponse,
  McpAuditRecord,
  McpExportPayload,
  McpExportResponse,
  McpImportPayload,
  McpImportPreviewResponse,
  McpPromptExposureMode,
  McpPromptListResponse,
  McpPromptSummary,
  McpServerDetailResponse,
  McpServerUpdatePayload,
  McpServerSummary,
  McpToolBulkPolicyPayload,
  McpToolListResponse,
  McpToolSummary,
  McpTrustRule,
} from "@/types/protocol";

describe("McpConsolePage", () => {
  it("renders server list and detail tabs", async () => {
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures())} />);

    expect(await screen.findByTestId("mcp-console-page")).not.toBeNull();
    const list = await screen.findByTestId("mcp-server-list");
    expect(within(list).getByText("Filesystem")).not.toBeNull();
    expect(within(list).getByText("Ticketing")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Filesystem" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Tools" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Prompts" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Resources" })).toBeNull();
    expect(within(screen.getByTestId("mcp-detail-tabs")).getByText("Resources")).not.toBeNull();
    expect(screen.getByText("supported, reserved")).not.toBeNull();
  });

  it("shows loading, empty and error states", async () => {
    const pending = createDeferred<{ list: McpServerSummary[]; total: number; limit: number; offset: number }>();
    const loadingRuntime = {
      mcp: {
        listServers: vi.fn(() => pending.promise),
      },
    } as unknown as RuntimeBridge;
    const { unmount } = render(<McpConsolePage runtime={loadingRuntime} />);

    expect(screen.getByTestId("mcp-server-loading")).not.toBeNull();
    pending.resolve({ list: [], total: 0, limit: 500, offset: 0 });
    expect(await screen.findByTestId("mcp-server-empty")).not.toBeNull();
    expect(screen.getByText("还没有 MCP 服务器，可通过添加或导入配置开始使用")).not.toBeNull();
    unmount();

    render(<McpConsolePage runtime={runtimeWithError("backend offline")} />);

    expect(await screen.findByTestId("mcp-console-error")).not.toBeNull();
    expect(screen.getByText("backend offline")).not.toBeNull();
    expect(screen.getByTestId("mcp-server-empty")).not.toBeNull();
  });

  it("renders mapped MCP error codes without exposing secrets", async () => {
    render(
      <McpConsolePage
        runtime={runtimeWithRejectedList({
          code: "auth_required",
          message: "Authorization=Bearer sk-secret token=abc",
        })}
      />,
    );

    expect(await screen.findByTestId("mcp-console-error")).not.toBeNull();
    expect(screen.getByText("MCP 服务器需要认证，请完成登录或补充凭据。")).not.toBeNull();
    expect(screen.queryByText(/sk-secret/u)).toBeNull();
    expect(screen.queryByText(/token=abc/u)).toBeNull();
  });

  it("filters servers by search, status and transport", async () => {
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures())} />);
    const list = await screen.findByTestId("mcp-server-list");
    await waitFor(() => expect(within(list).getByText("Filesystem")).not.toBeNull());

    fireEvent.change(screen.getByLabelText("搜索 MCP Server"), { target: { value: "ticket" } });

    expect(within(list).queryByText("Filesystem")).toBeNull();
    expect(within(list).getByText("Ticketing")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Ticketing" })).not.toBeNull();

    fireEvent.change(screen.getByLabelText("搜索 MCP Server"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("筛选 MCP Server 状态"), { target: { value: "online" } });

    expect(within(list).getByText("Filesystem")).not.toBeNull();
    expect(within(list).queryByText("Ticketing")).toBeNull();

    fireEvent.change(screen.getByLabelText("筛选 MCP Server 状态"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("筛选 MCP Server transport"), { target: { value: "sse" } });

    expect(within(list).queryByText("Filesystem")).toBeNull();
    expect(within(list).getByText("Ticketing")).not.toBeNull();
  });

  it("refreshes all servers and reloads the list", async () => {
    const listServers = vi.fn()
      .mockResolvedValueOnce({ list: [server("srv_1", "Filesystem")], total: 1, limit: 500, offset: 0 })
      .mockResolvedValueOnce({ list: [server("srv_2", "Ticketing")], total: 1, limit: 500, offset: 0 });
    const refreshServers = vi.fn().mockResolvedValue({ ok: true, list: [], total: 0 });
    const runtime = {
      mcp: {
        listServers,
        refreshServers,
      },
    } as unknown as RuntimeBridge;
    render(<McpConsolePage runtime={runtime} />);

    const list = await screen.findByTestId("mcp-server-list");
    await waitFor(() => expect(within(list).getByText("Filesystem")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "刷新全部 MCP Server" }));

    await waitFor(() => expect(refreshServers).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(list).getByText("Ticketing")).not.toBeNull());
    expect(listServers).toHaveBeenCalledTimes(2);
  });

  it("deletes a server after confirmation and reloads the list", async () => {
    const listServers = vi.fn()
      .mockResolvedValueOnce({ list: [server("srv_delete", "Delete Me")], total: 1, limit: 500, offset: 0 })
      .mockResolvedValueOnce({ list: [], total: 0, limit: 500, offset: 0 });
    const deleteServer = vi.fn().mockResolvedValue({ deleted: true, server_id: "srv_delete" });
    render(<McpConsolePage runtime={runtimeWithServers([], { listServers, deleteServer })} />);

    expect(await screen.findByRole("heading", { name: "Delete Me" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "删除 MCP Server" }));

    const dialog = await screen.findByRole("dialog", { name: "确认删除 MCP Server？" });
    expect(within(dialog).getByText("Delete Me / streamable_http")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(deleteServer).toHaveBeenCalledWith("srv_delete"));
    expect(await screen.findByText("MCP Server 已删除：Delete Me")).not.toBeNull();
    expect(await screen.findByTestId("mcp-server-empty")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Delete Me" })).toBeNull();
  });

  it("opens the server form and switches transport-specific fields", async () => {
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures())} />);

    fireEvent.click(await screen.findByRole("button", { name: "添加 MCP Server" }));

    expect(await screen.findByRole("dialog", { name: "添加 MCP Server" })).not.toBeNull();
    expect(screen.getByLabelText("stdio command")).not.toBeNull();
    const advancedSettings = screen.getByText("高级设置").closest("details") as HTMLDetailsElement | null;
    expect(advancedSettings?.open).toBe(false);
    expect(screen.queryByRole("radio", { name: /SSE/ })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /HTTP/ }));
    expect(screen.getByLabelText("streamable_http url")).not.toBeNull();
    expect(screen.getByLabelText("bearer token env")).not.toBeNull();

    fireEvent.click(screen.getByText("高级设置"));
    expect(advancedSettings?.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "显示 SSE transport" }));
    fireEvent.click(screen.getByRole("radio", { name: /SSE/ }));
    expect(screen.getByLabelText("sse url")).not.toBeNull();
    expect(screen.getByLabelText("sse message url")).not.toBeNull();
  });

  it("creates a stdio server with args as an array", async () => {
    const createServer = vi.fn().mockResolvedValue(serverDetail("srv_new", "Local Files", {
      command: "node",
      args: ["server.js", "--stdio"],
    }));
    const runtime = runtimeWithServers([], { createServer });
    render(<McpConsolePage runtime={runtime} />);

    fireEvent.click(await screen.findByRole("button", { name: "添加 MCP Server" }));
    fireEvent.change(await screen.findByLabelText("MCP Server 名称"), { target: { value: "Local Files" } });
    fireEvent.change(screen.getByLabelText("stdio command"), { target: { value: "node" } });
    fireEvent.change(screen.getByLabelText("stdio arg 1"), { target: { value: "server.js" } });
    fireEvent.click(screen.getByRole("button", { name: "添加 arg" }));
    fireEvent.change(screen.getByLabelText("stdio arg 2"), { target: { value: "--stdio" } });
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));

    await waitFor(() => expect(createServer).toHaveBeenCalledTimes(1));
    expect(createServer.mock.calls[0][0]).toMatchObject({
      name: "Local Files",
      transport: "stdio",
      command: "node",
      args: ["server.js", "--stdio"],
    });
  });

  it("shows capabilities from a successful connection test", async () => {
    const detail = serverDetail("srv_caps", "Capability MCP", { command: "node" });
    const createServer = vi.fn().mockResolvedValue(detail);
    const getServer = vi.fn().mockResolvedValue(detail);
    const testServer = vi.fn().mockResolvedValue({
      ok: true,
      server_id: "srv_caps",
      status: "online",
      capabilities: { tools: true, prompts: true, resources_reserved: true },
    });
    render(<McpConsolePage runtime={runtimeWithServers([], { createServer, getServer, testServer })} />);

    fireEvent.click(await screen.findByRole("button", { name: "添加 MCP Server" }));
    fireEvent.change(await screen.findByLabelText("MCP Server 名称"), { target: { value: "Capability MCP" } });
    fireEvent.change(screen.getByLabelText("stdio command"), { target: { value: "node" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并测试" }));

    await waitFor(() => expect(testServer).toHaveBeenCalledWith("srv_caps"));
    expect(await screen.findByText("连接测试通过，状态 online")).not.toBeNull();
    expect(screen.getByText("tools: yes · prompts: yes · resources: yes")).not.toBeNull();
  });

  it("validates required fields before saving", async () => {
    const createServer = vi.fn();
    render(<McpConsolePage runtime={runtimeWithServers([], { createServer })} />);

    fireEvent.click(await screen.findByRole("button", { name: "添加 MCP Server" }));
    fireEvent.click(await screen.findByRole("button", { name: /^保存$/ }));

    expect((await screen.findByRole("alert")).textContent).toContain("请填写 Server 名称");
    expect(createServer).not.toHaveBeenCalled();
  });

  it("requires confirmation for dangerous edit changes", async () => {
    const detail = serverDetail("srv_1", "Filesystem", { command: "node", args: ["server.js"] });
    const updateServer = vi.fn().mockResolvedValue({ ...detail, command: "python" });
    const runtime = runtimeWithServers([server("srv_1", "Filesystem", { transport: "stdio" })], {
      getServer: vi.fn().mockResolvedValue(detail),
      updateServer,
    });
    render(<McpConsolePage runtime={runtime} />);

    await screen.findByTestId("mcp-server-list");
    fireEvent.click(await screen.findByRole("button", { name: "编辑 MCP Server 连接" }));
    fireEvent.change(await screen.findByLabelText("stdio command"), { target: { value: "python" } });
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));

    expect(await screen.findByText("确认保存这些高影响变更")).not.toBeNull();
    expect(updateServer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));

    await waitFor(() => expect(updateServer).toHaveBeenCalledTimes(1));
    expect(updateServer.mock.calls[0][1]).toMatchObject({
      transport: "stdio",
      command: "python",
    });
  });

  it("shows configured secret refs and can clear them without exposing values", async () => {
    const detail = serverDetail("srv_1", "Secure HTTP", {
      transport: "streamable_http",
      command: null,
      url: "https://mcp.example.test/mcp",
      auth_type: "header_token",
      header_keys: ["Authorization"],
      secret_ref_keys: ["api_key"],
    });
    const updateServer = vi.fn().mockResolvedValue(detail);
    const runtime = runtimeWithServers([server("srv_1", "Secure HTTP", { transport: "streamable_http" })], {
      getServer: vi.fn().mockResolvedValue(detail),
      updateServer,
    });
    render(<McpConsolePage runtime={runtime} />);

    await screen.findByTestId("mcp-server-list");
    fireEvent.click(await screen.findByRole("button", { name: "编辑 MCP Server 连接" }));

    expect(await screen.findByText("已配置：api_key")).not.toBeNull();
    expect(screen.queryByText("secret-token-value")).toBeNull();

    fireEvent.click(screen.getByLabelText("清除"));
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
    expect(await screen.findByText("已保存的 secret refs 将被清除")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));

    await waitFor(() => expect(updateServer).toHaveBeenCalledTimes(1));
    expect(updateServer.mock.calls[0][1]).toMatchObject({
      auth_type: "header_token",
      secret_refs: {},
    });
  });

  it("validates bearer env names before saving", async () => {
    const createServer = vi.fn();
    render(<McpConsolePage runtime={runtimeWithServers([], { createServer })} />);

    fireEvent.click(await screen.findByRole("button", { name: "添加 MCP Server" }));
    fireEvent.change(await screen.findByLabelText("MCP Server 名称"), { target: { value: "HTTP MCP" } });
    fireEvent.click(screen.getByRole("radio", { name: /HTTP/ }));
    fireEvent.change(screen.getByLabelText("streamable_http url"), {
      target: { value: "https://mcp.example.test/mcp" },
    });
    fireEvent.change(screen.getByLabelText("bearer token env"), { target: { value: "123bad" } });
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));

    expect((await screen.findByRole("alert")).textContent).toContain("Bearer token env 必须是有效环境变量名");
    expect(createServer).not.toHaveBeenCalled();
  });

  it("creates an HTTP server from the simplified quick auth fields", async () => {
    const createServer = vi.fn().mockResolvedValue(serverDetail("srv_http", "Remote MCP", {
      transport: "streamable_http",
      command: null,
      url: "https://mcp.example.test/mcp",
      auth_type: "bearer_env",
      bearer_token_env_var: "MCP_BEARER_TOKEN",
    }));
    render(<McpConsolePage runtime={runtimeWithServers([], { createServer })} />);

    fireEvent.click(await screen.findByRole("button", { name: "添加 MCP Server" }));
    fireEvent.change(await screen.findByLabelText("MCP Server 名称"), { target: { value: "Remote MCP" } });
    fireEvent.click(screen.getByRole("radio", { name: /HTTP/ }));
    fireEvent.change(screen.getByLabelText("streamable_http url"), {
      target: { value: "https://mcp.example.test/mcp" },
    });
    fireEvent.change(screen.getByLabelText("bearer token env"), { target: { value: "MCP_BEARER_TOKEN" } });
    fireEvent.change(screen.getByLabelText("标头 key 1"), { target: { value: "X-Workspace" } });
    fireEvent.change(screen.getByLabelText("标头 value 1"), { target: { value: "default" } });
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));

    await waitFor(() => expect(createServer).toHaveBeenCalledTimes(1));
    expect(createServer.mock.calls[0][0]).toMatchObject({
      name: "Remote MCP",
      transport: "streamable_http",
      url: "https://mcp.example.test/mcp",
      auth_type: "bearer_env",
      bearer_token_env_var: "MCP_BEARER_TOKEN",
      headers: {
        "X-Workspace": "default",
      },
      secret_refs: null,
      oauth_config: null,
    });
  });

  it("renders OAuth status and calls login and clear flows", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const detail = serverDetail("srv_1", "OAuth MCP", {
      transport: "streamable_http",
      command: null,
      url: "https://mcp.example.test/mcp",
      auth_type: "oauth",
      oauth_configured: true,
      oauth_resource: "https://mcp.example.test",
      oauth_scopes: ["read", "write"],
    });
    const getOAuthStatus = vi.fn().mockResolvedValue({
      server_id: "srv_1",
      status: "active",
      token_configured: true,
      account_label: "dev@example.test",
      scopes: ["read", "write"],
      expires_at: "2026-07-06T12:00:00Z",
    });
    const startOAuth = vi.fn().mockResolvedValue({
      server_id: "srv_1",
      auth_url: "https://oauth.example.test/authorize",
      state: "state-1",
    });
    const clearOAuth = vi.fn().mockResolvedValue({
      server_id: "srv_1",
      status: "revoked",
      token_configured: false,
      scopes: [],
      account_label: null,
      expires_at: null,
    });
    const runtime = runtimeWithServers([server("srv_1", "OAuth MCP", { transport: "streamable_http" })], {
      getServer: vi.fn().mockResolvedValue(detail),
      getOAuthStatus,
      startOAuth,
      clearOAuth,
    });
    render(<McpConsolePage runtime={runtime} />);

    await screen.findByTestId("mcp-server-list");
    fireEvent.click(await screen.findByRole("button", { name: "编辑 MCP Server 连接" }));

    expect(await screen.findByText("dev@example.test")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新授权" }));

    await waitFor(() => expect(startOAuth).toHaveBeenCalledWith("srv_1"));
    expect(open).toHaveBeenCalledWith("https://oauth.example.test/authorize", "_blank", "noopener,noreferrer");

    fireEvent.click(screen.getByRole("button", { name: "清除凭据" }));
    expect(await screen.findByText("确认清除 OAuth 凭据？清除后该 server 会进入需要重新授权的状态。")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认清除" }));

    await waitFor(() => expect(clearOAuth).toHaveBeenCalledWith("srv_1"));
    vi.unstubAllGlobals();
  });

  it("lists, searches and filters MCP tools", async () => {
    const listTools = vi.fn((serverId: string, options: Record<string, unknown> = {}) =>
      Promise.resolve(toolListResponse(filterTools(toolFixtures(), options))),
    );
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { listTools })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Tools" }));
    const toolList = await screen.findByTestId("mcp-tool-list");

    await waitFor(() => expect(within(toolList).getByText("read_file")).not.toBeNull());
    expect(within(toolList).getByText("write_ticket")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("搜索 MCP Tool"), { target: { value: "write" } });

    await waitFor(() =>
      expect(listTools).toHaveBeenLastCalledWith("srv_1", expect.objectContaining({ search: "write", limit: 500 })),
    );
    await waitFor(() => expect(within(toolList).queryByText("read_file")).toBeNull());
    expect(within(toolList).getByText("write_ticket")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("筛选 MCP Tool 风险"), { target: { value: "high" } });

    await waitFor(() =>
      expect(listTools).toHaveBeenLastCalledWith("srv_1", expect.objectContaining({ search: "write", risk: "high" })),
    );
  });

  it("updates a single tool visibility and approval policy", async () => {
    let tools = toolFixtures();
    const updateToolPolicy = vi.fn((serverId: string, toolId: string, payload: Partial<McpToolSummary>) => {
      const updated = applyToolPolicyPatch(tools.find((tool) => tool.id === toolId)!, payload);
      tools = tools.map((tool) => (tool.id === toolId ? updated : tool));
      return Promise.resolve(updated);
    });
    const listTools = vi.fn(() => Promise.resolve(toolListResponse(tools)));
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { listTools, updateToolPolicy })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Tools" }));
    fireEvent.click(await screen.findByRole("switch", { name: "启用 tool read_file" }));

    await waitFor(() =>
      expect(updateToolPolicy).toHaveBeenCalledWith("srv_1", "tool_read", { enabled: false }),
    );
    expect(await screen.findByText("已禁用 read_file：立即阻止执行，下一轮不再暴露给 Agent")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("审批策略 read_file"), { target: { value: "prompt" } });

    await waitFor(() =>
      expect(updateToolPolicy).toHaveBeenLastCalledWith("srv_1", "tool_read", { approval_mode: "prompt" }),
    );
    expect(await screen.findByText("审批策略已更新：只影响执行前确认，不改变工具可见性")).not.toBeNull();
  });

  it("applies bulk tool policy with the selected tool ids", async () => {
    const applyToolBulkPolicy = vi.fn((serverId: string, payload: McpToolBulkPolicyPayload) =>
      Promise.resolve({
        server_id: serverId,
        action: payload.action,
        updated_count: payload.tool_ids?.length ?? 0,
        tools: toolFixtures().map((tool) =>
          payload.tool_ids?.includes(tool.id)
            ? { ...tool, enabled: false, effective_state: "disabled_persistently" as const }
            : tool,
        ),
      }),
    );
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { applyToolBulkPolicy })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Tools" }));
    fireEvent.click(await screen.findByRole("button", { name: "选择 tool read_file" }));
    fireEvent.change(screen.getByLabelText("MCP Tool 批量策略"), { target: { value: "keep_selected_only" } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    await waitFor(() =>
      expect(applyToolBulkPolicy).toHaveBeenCalledWith("srv_1", {
        action: "keep_selected_only",
        tool_ids: ["tool_read"],
      }),
    );
    expect(await screen.findByText("批量策略已应用：keep_selected_only，更新 1 个 tool")).not.toBeNull();
  });

  it("shows schema details and schema changed or removed states", async () => {
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures())} />);

    fireEvent.click(await screen.findByRole("button", { name: "Tools" }));

    expect(await screen.findByText("Schema 已变化，需检查后确认策略")).not.toBeNull();
    expect(screen.getAllByText("removed").length).toBeGreaterThan(0);
    expect(document.querySelector('[class*="toolsContent"]')?.getAttribute("data-has-schema")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "查看 schema calculate_total" }));

    const schemaPanel = await screen.findByTestId("mcp-tool-schema-panel");
    expect(document.querySelector('[class*="toolsContent"]')?.getAttribute("data-has-schema")).toBe("true");
    expect(within(schemaPanel).getByText("calculate_total")).not.toBeNull();
    expect(within(schemaPanel).getByText(/\"type\": \"object\"/)).not.toBeNull();
    expect(within(schemaPanel).getByText(/\"amount\"/)).not.toBeNull();
  });

  it("lists prompts and updates prompt exposure policy", async () => {
    let prompts = promptFixtures();
    const listPrompts = vi.fn((serverId: string, options: Record<string, unknown> = {}) =>
      Promise.resolve(promptListResponse(filterPrompts(prompts, options))),
    );
    const updatePromptPolicy = vi.fn((serverId: string, promptId: string, payload: { exposure_mode?: McpPromptExposureMode }) => {
      const updated = {
        ...prompts.find((prompt) => prompt.id === promptId)!,
        exposure_mode: payload.exposure_mode ?? "manual",
      };
      prompts = prompts.map((prompt) => (prompt.id === promptId ? updated : prompt));
      return Promise.resolve(updated);
    });
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { listPrompts, updatePromptPolicy })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Prompts" }));
    const promptList = await screen.findByTestId("mcp-prompt-list");

    await waitFor(() => expect(within(promptList).getByText("summarize_ticket")).not.toBeNull());
    expect(within(promptList).getAllByText("Filesystem").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("搜索 MCP Prompt"), { target: { value: "release" } });

    await waitFor(() =>
      expect(listPrompts).toHaveBeenLastCalledWith("srv_1", expect.objectContaining({ search: "release", limit: 500 })),
    );
    await waitFor(() => expect(within(promptList).queryByText("summarize_ticket")).toBeNull());
    expect(within(promptList).getByText("release_notes")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("暴露策略 release_notes"), { target: { value: "agent_selectable" } });

    await waitFor(() =>
      expect(updatePromptPolicy).toHaveBeenCalledWith("srv_1", "prompt_release", {
        exposure_mode: "agent_selectable",
      }),
    );
    expect(await screen.findByText("Prompt 暴露策略已更新：release_notes -> agent_selectable")).not.toBeNull();
  });

  it("materializes a prompt, copies it and emits an insert draft event", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const getPrompt = vi.fn().mockResolvedValue(materializedPrompt());
    const draftListener = vi.fn();
    const handleDraft = (event: Event) => draftListener((event as CustomEvent).detail);
    document.addEventListener(APP_INSERT_MCP_PROMPT_DRAFT_EVENT, handleDraft);
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { getPrompt })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Prompts" }));
    fireEvent.change(await screen.findByLabelText("prompt argument topic"), { target: { value: "Q3 roadmap" } });
    fireEvent.click(screen.getByRole("button", { name: "获取 Prompt" }));

    await waitFor(() => expect(getPrompt).toHaveBeenCalledWith("srv_1", "prompt_summary", { topic: "Q3 roadmap" }));
    expect(await screen.findByText(/Summarize Q3 roadmap/)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "复制" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Summarize Q3 roadmap")));
    expect(await screen.findByText("Prompt 已复制")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "插入草稿" }));

    await waitFor(() => expect(draftListener).toHaveBeenCalledTimes(1));
    expect(draftListener.mock.calls[0][0]).toMatchObject({
      serverId: "srv_1",
      promptId: "prompt_summary",
      rawName: "summarize_ticket",
      text: expect.stringContaining("Summarize Q3 roadmap"),
    });
    document.removeEventListener(APP_INSERT_MCP_PROMPT_DRAFT_EVENT, handleDraft);
    clearPendingMcpPromptDrafts();
  });

  it("shows get prompt errors", async () => {
    const getPrompt = vi.fn().mockRejectedValue(new Error("prompt server failed"));
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { getPrompt })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Prompts" }));
    fireEvent.change(await screen.findByLabelText("prompt argument topic"), { target: { value: "Q3 roadmap" } });
    fireEvent.click(screen.getByRole("button", { name: "获取 Prompt" }));

    expect((await screen.findByRole("alert")).textContent).toContain("prompt server failed");
  });

  it("updates approval settings from the trust tab", async () => {
    const detail = serverDetail("srv_1", "Filesystem", { default_tool_approval_mode: "auto", sampling_enabled: false });
    const updateServer = vi.fn((serverId: string, payload: McpServerUpdatePayload) =>
      Promise.resolve({ ...detail, ...payload } as McpServerDetailResponse),
    );
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { getServer: vi.fn().mockResolvedValue(detail), updateServer })} />);

    fireEvent.click(await screen.findByRole("button", { name: "审批与信任" }));
    fireEvent.change(await screen.findByLabelText("MCP Server 默认审批"), { target: { value: "prompt" } });

    await waitFor(() =>
      expect(updateServer).toHaveBeenCalledWith("srv_1", { default_tool_approval_mode: "prompt" }),
    );
    expect(await screen.findByText("MCP 审批策略已保存")).not.toBeNull();
  });

  it("shows sampling disabled by default with policy summary", async () => {
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures())} />);

    fireEvent.click(await screen.findByRole("button", { name: "审批与信任" }));

    const samplingSwitch = await screen.findByRole("switch", { name: "允许 Sampling" });
    expect(samplingSwitch.getAttribute("aria-checked")).toBe("false");

    const summary = await screen.findByTestId("mcp-sampling-policy-summary");
    expect(summary.textContent).toContain("Sampling 默认关闭：未启用");
    expect(summary.textContent).toContain("审批：每次请求审批");
    expect(summary.textContent).toContain("模型策略：当前默认模型");
    expect(summary.textContent).toContain("Token 上限：2048");
    expect(summary.textContent).toContain("审计：摘要审计");
  });

  it("confirms before enabling sampling", async () => {
    const detail = serverDetail("srv_1", "Filesystem", { sampling_enabled: false });
    const updateServer = vi.fn((serverId: string, payload: McpServerUpdatePayload) =>
      Promise.resolve({ ...detail, ...payload } as McpServerDetailResponse),
    );
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { getServer: vi.fn().mockResolvedValue(detail), updateServer })} />);

    fireEvent.click(await screen.findByRole("button", { name: "审批与信任" }));
    const samplingSwitch = await screen.findByRole("switch", { name: "允许 Sampling" });

    fireEvent.click(samplingSwitch);

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(updateServer).not.toHaveBeenCalled();

    fireEvent.click(samplingSwitch);

    await waitFor(() => expect(updateServer).toHaveBeenCalledWith("srv_1", { sampling_enabled: true }));
    expect(await screen.findByText("MCP 审批策略已保存")).not.toBeNull();

    confirmSpy.mockRestore();
  });

  it("lists and deletes trust rules", async () => {
    const deleteTrustRule = vi.fn().mockResolvedValue({ deleted: true, rule_id: "trust_1" });
    render(
      <McpConsolePage
        runtime={runtimeWithServers(serverFixtures(), {
          listTrustRules: vi.fn().mockResolvedValue({ list: trustRuleFixtures() }),
          deleteTrustRule,
        })}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "审批与信任" }));
    const trustList = await screen.findByTestId("mcp-trust-rule-list");

    expect(within(trustList).getByText("tool")).not.toBeNull();
    expect(within(trustList).getByText("read_file")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "删除 trust rule trust_1" }));

    await waitFor(() => expect(deleteTrustRule).toHaveBeenCalledWith("trust_1"));
    expect(await screen.findByText("Trust rule 已删除")).not.toBeNull();
  });

  it("updates runtime policy fields", async () => {
    const detail = serverDetail("srv_1", "Filesystem", { auto_refresh: true, connect_mode: "on_demand" });
    const updateServer = vi.fn((serverId: string, payload: McpServerUpdatePayload) =>
      Promise.resolve({ ...detail, ...payload } as McpServerDetailResponse),
    );
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { getServer: vi.fn().mockResolvedValue(detail), updateServer })} />);

    fireEvent.click(await screen.findByRole("button", { name: "运行策略" }));
    fireEvent.change(await screen.findByLabelText("MCP connect mode"), { target: { value: "on_startup" } });

    await waitFor(() => expect(updateServer).toHaveBeenCalledWith("srv_1", { connect_mode: "on_startup" }));
    expect(await screen.findByText("MCP 运行策略已保存")).not.toBeNull();
  });

  it("lists, filters and expands audit logs", async () => {
    const listAudit = vi.fn((options: Record<string, unknown> = {}) =>
      Promise.resolve(auditListResponse(filterAuditLogs(auditFixtures(), options))),
    );
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { listAudit })} />);

    fireEvent.click(await screen.findByRole("button", { name: "日志" }));
    const logList = (await screen.findAllByTestId("mcp-log-row"))[0];

    expect(logList.textContent).toContain("server.updated");
    fireEvent.click(logList.querySelector("button")!);
    expect(await screen.findByText(/\"field\": \"auto_refresh\"/)).not.toBeNull();

    fireEvent.change(screen.getByLabelText("筛选 MCP 日志事件"), { target: { value: "tool.failed" } });

    await waitFor(() =>
      expect(listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ server_id: "srv_1", event_type: "tool.failed" })),
    );
    expect((await screen.findAllByText("tool.failed")).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("筛选 MCP 日志状态"), { target: { value: "failed" } });

    await waitFor(() =>
      expect(listAudit).toHaveBeenLastCalledWith(
        expect.objectContaining({ server_id: "srv_1", event_type: "tool.failed", status: "failed" }),
      ),
    );
  });

  it("paginates audit logs with explicit offsets", async () => {
    const records = Array.from({ length: 12 }, (_, index) => ({
      ...auditFixtures()[0],
      id: `audit_page_${index + 1}`,
      event_type: index === 0 ? "refresh.completed" : "tool.called",
      summary: `Audit page ${index + 1}`,
      created_at: `2026-07-06T08:${String(index).padStart(2, "0")}:00Z`,
    }));
    const listAudit = vi.fn((options: Record<string, unknown> = {}) => {
      const offset = Number(options.offset ?? 0);
      const limit = Number(options.limit ?? 10);
      const filtered = filterAuditLogs(records, options);
      return Promise.resolve(auditListResponse(filtered.slice(offset, offset + limit), filtered.length, limit, offset));
    });
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { listAudit })} />);

    fireEvent.click(await screen.findByRole("button", { name: "日志" }));

    expect(await screen.findByText("1-10 / 12")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下一页 MCP 日志" }));

    await waitFor(() =>
      expect(listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ server_id: "srv_1", limit: 10, offset: 10 })),
    );
    expect(await screen.findByText("11-12 / 12")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("筛选 MCP 日志事件"), { target: { value: "refresh.completed" } });

    await waitFor(() =>
      expect(listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ event_type: "refresh.completed", offset: 0 })),
    );
    expect(await screen.findByText("1-1 / 1")).not.toBeNull();
  });

  it("shows audit log empty and stable error states", async () => {
    const listAudit = vi.fn()
      .mockResolvedValueOnce(auditListResponse([]))
      .mockRejectedValueOnce({
        code: "timeout",
        message: "Bearer raw-visible-token\nstack trace line",
      });
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { listAudit })} />);

    fireEvent.click(await screen.findByRole("button", { name: "日志" }));

    expect(await screen.findByTestId("mcp-logs-empty")).not.toBeNull();
    fireEvent.click(within(screen.getByTestId("mcp-logs-tab")).getByRole("button", { name: "刷新" }));

    expect(await screen.findByText("MCP 操作超时，请稍后重试或调大超时时间。")).not.toBeNull();
    expect(screen.queryByText(/raw-visible-token/)).toBeNull();
    expect(screen.queryByText(/stack trace line/)).toBeNull();
  });

  it("filters sampling audit events", async () => {
    const listAudit = vi.fn((options: Record<string, unknown> = {}) =>
      Promise.resolve(auditListResponse(filterAuditLogs(auditFixtures(), options))),
    );
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { listAudit })} />);

    fireEvent.click(await screen.findByRole("button", { name: "日志" }));
    fireEvent.change(await screen.findByLabelText("筛选 MCP 日志事件"), { target: { value: "sampling.requested" } });

    await waitFor(() =>
      expect(listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ server_id: "srv_1", event_type: "sampling.requested" })),
    );
    expect((await screen.findAllByText("sampling.requested")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Sampling requested")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("筛选 MCP 日志事件"), { target: { value: "sampling.completed" } });

    await waitFor(() =>
      expect(listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ server_id: "srv_1", event_type: "sampling.completed" })),
    );
    expect((await screen.findAllByText("sampling.completed")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Sampling resolved")).not.toBeNull();
  });

  it("previews import conflicts and confirms import with sanitized server output", async () => {
    const config = {
      mcpServers: {
        Duplicate: { command: "existing-mcp" },
        "New Tools": {
          command: "new-mcp",
          env: { API_KEY: "raw-secret-value-0123456789012345" },
        },
      },
    };
    const preview = importPreviewResponse();
    const applied = {
      ...preview,
      applied: true,
      created_count: 1,
      skipped_count: 1,
      created: [{ id: "srv_imported", name: "New Tools", transport: "stdio" }],
      skipped: ["Duplicate"],
    } satisfies McpImportPreviewResponse;
    const importConfig = vi.fn((payload: McpImportPayload) =>
      Promise.resolve(payload.confirm ? applied : preview),
    );
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { importConfig })} />);

    fireEvent.click(await screen.findByRole("button", { name: "导入 MCP 配置" }));
    expect(await screen.findByRole("dialog", { name: "导入 MCP 配置" })).not.toBeNull();

    fireEvent.change(screen.getByLabelText("MCP import source"), { target: { value: "claude" } });
    fireEvent.change(screen.getByLabelText("MCP import JSON"), { target: { value: JSON.stringify(config) } });
    fireEvent.click(screen.getByRole("button", { name: "预览导入" }));

    await waitFor(() =>
      expect(importConfig).toHaveBeenCalledWith({
        source_type: "claude",
        conflict_strategy: "skip",
        confirm: false,
        config,
      }),
    );
    const previewPanel = await screen.findByTestId("mcp-import-preview");
    expect(within(previewPanel).getAllByText("Duplicate").length).toBeGreaterThan(0);
    expect(within(previewPanel).getByText("skip")).not.toBeNull();
    expect(within(previewPanel).getByText("New Tools.env.API_KEY")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));

    await waitFor(() => expect(importConfig).toHaveBeenCalledTimes(2));
    expect(importConfig).toHaveBeenLastCalledWith({
      source_type: "claude",
      conflict_strategy: "skip",
      confirm: true,
      config,
    });
    expect(await screen.findByText("MCP 导入完成：创建 1 个，跳过 1 个")).not.toBeNull();
  });

  it("exports MCP config with trust-rule option and no secret plaintext", async () => {
    const exportResponse = {
      format: "keydex.mcp.v1",
      servers: [
        {
          name: "Filesystem",
          headers: { Authorization: "secret:configured" },
          secret_ref_keys: ["api_key"],
          oauth_configured: true,
        },
      ],
      tool_policies: [],
      prompt_policies: [],
      trust_rules: [{ scope: "global", rule_kind: "tool", raw_tool_name: "read_file" }],
    } satisfies McpExportResponse;
    const exportConfig = vi.fn((payload?: McpExportPayload) =>
      Promise.resolve(payload?.include_trust_rules ? exportResponse : { ...exportResponse, trust_rules: undefined }),
    );
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { exportConfig })} />);

    fireEvent.click(await screen.findByRole("button", { name: "导出 MCP 配置" }));
    expect(await screen.findByRole("dialog", { name: "导出 MCP 配置" })).not.toBeNull();
    expect(screen.getByText("导出内容不包含 secret 明文或 OAuth token。")).not.toBeNull();

    fireEvent.click(screen.getByLabelText("导出包含 trust rules"));
    fireEvent.click(screen.getByRole("button", { name: "生成导出" }));

    await waitFor(() => expect(exportConfig).toHaveBeenCalledWith({ include_trust_rules: true }));
    const preview = await screen.findByTestId("mcp-export-preview");
    expect(preview.textContent).toContain("\"trust_rules\"");
    expect(preview.textContent).toContain("secret:configured");
    expect(preview.textContent).not.toContain("raw-secret-value");
    expect(preview.textContent).not.toContain("raw-token");
  });

  it("shows import JSON errors and export API errors without leaking sensitive text", async () => {
    const importConfig = vi.fn(() => Promise.resolve(importPreviewResponse()));
    const exportConfig = vi.fn(() =>
      Promise.reject({
        code: "auth_required",
        message: "Bearer raw-export-token\nstack trace line",
      }),
    );
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { importConfig, exportConfig })} />);

    fireEvent.click(await screen.findByRole("button", { name: "导入 MCP 配置" }));
    fireEvent.change(await screen.findByLabelText("MCP import JSON"), { target: { value: "{bad json" } });
    fireEvent.click(screen.getByRole("button", { name: "预览导入" }));

    expect(await screen.findByText("导入内容不是有效 JSON")).not.toBeNull();
    expect(importConfig).not.toHaveBeenCalled();

    const importDialog = screen.getByRole("dialog", { name: "导入 MCP 配置" });
    const closeButtons = within(importDialog).getAllByRole("button", { name: "关闭" });
    fireEvent.click(closeButtons[closeButtons.length - 1]);
    fireEvent.click(await screen.findByRole("button", { name: "导出 MCP 配置" }));
    fireEvent.click(screen.getByRole("button", { name: "生成导出" }));

    expect(await screen.findByText("MCP 服务器需要认证，请完成登录或补充凭据。")).not.toBeNull();
    expect(screen.queryByText(/raw-export-token/)).toBeNull();
    expect(screen.queryByText(/stack trace line/)).toBeNull();
  });
});

function runtimeWithServers(
  servers: McpServerSummary[],
  overrides: Partial<RuntimeBridge["mcp"]> = {},
): RuntimeBridge {
  return {
    mcp: {
      listServers: vi.fn().mockResolvedValue({ list: servers, total: servers.length, limit: 500, offset: 0 }),
      refreshServers: vi.fn().mockResolvedValue({ ok: true, list: [], total: 0 }),
      createServer: vi.fn().mockResolvedValue(serverDetail("srv_created", "Created MCP")),
      getServer: vi.fn((serverId: string) =>
        Promise.resolve(serverDetail(serverId, servers.find((item) => item.id === serverId)?.name ?? "MCP Server")),
      ),
      updateServer: vi.fn((serverId: string) => Promise.resolve(serverDetail(serverId, "Updated MCP"))),
      deleteServer: vi.fn((serverId: string) => Promise.resolve({ deleted: true, server_id: serverId })),
      testServer: vi.fn((serverId: string) =>
        Promise.resolve({ ok: true, server_id: serverId, status: "online", capabilities: { tools: true } }),
      ),
      listTools: vi.fn(() => Promise.resolve(toolListResponse(toolFixtures()))),
      updateToolPolicy: vi.fn((serverId: string, toolId: string, payload: Partial<McpToolSummary>) =>
        Promise.resolve(applyToolPolicyPatch(toolFixtures().find((tool) => tool.id === toolId)!, payload)),
      ),
      applyToolBulkPolicy: vi.fn((serverId: string, payload: { action: string }) =>
        Promise.resolve({ server_id: serverId, action: payload.action, updated_count: 0, tools: toolFixtures() }),
      ),
      listPrompts: vi.fn(() => Promise.resolve(promptListResponse(promptFixtures()))),
      updatePromptPolicy: vi.fn((serverId: string, promptId: string, payload: { exposure_mode?: McpPromptExposureMode }) =>
        Promise.resolve({
          ...promptFixtures().find((prompt) => prompt.id === promptId)!,
          exposure_mode: payload.exposure_mode ?? "manual",
        }),
      ),
      getPrompt: vi.fn(() => Promise.resolve(materializedPrompt())),
      listTrustRules: vi.fn(() => Promise.resolve({ list: trustRuleFixtures() })),
      createTrustRule: vi.fn((payload) =>
        Promise.resolve({ ...trustRuleFixtures()[0], ...payload, id: "trust_created" }),
      ),
      deleteTrustRule: vi.fn((ruleId: string) => Promise.resolve({ deleted: true, rule_id: ruleId })),
      listAudit: vi.fn(() => Promise.resolve(auditListResponse(auditFixtures()))),
      getOAuthStatus: vi.fn((serverId: string) =>
        Promise.resolve({ server_id: serverId, status: "revoked", token_configured: false, scopes: [] }),
      ),
      startOAuth: vi.fn((serverId: string) =>
        Promise.resolve({ server_id: serverId, auth_url: "https://oauth.example.test/authorize", state: "state" }),
      ),
      clearOAuth: vi.fn((serverId: string) =>
        Promise.resolve({ server_id: serverId, status: "revoked", token_configured: false, scopes: [] }),
      ),
      importConfig: vi.fn(() => Promise.resolve(importPreviewResponse())),
      exportConfig: vi.fn(() =>
        Promise.resolve({
          format: "keydex.mcp.v1",
          servers: [],
          tool_policies: [],
          prompt_policies: [],
        }),
      ),
      ...overrides,
    },
  } as unknown as RuntimeBridge;
}

function runtimeWithError(message: string): RuntimeBridge {
  return {
    mcp: {
      listServers: vi.fn().mockRejectedValue(new Error(message)),
      refreshServers: vi.fn(),
    },
  } as unknown as RuntimeBridge;
}

function runtimeWithRejectedList(reason: unknown): RuntimeBridge {
  return {
    mcp: {
      listServers: vi.fn().mockRejectedValue(reason),
      refreshServers: vi.fn(),
    },
  } as unknown as RuntimeBridge;
}

function serverFixtures(): McpServerSummary[] {
  return [
    server("srv_1", "Filesystem", {
      transport: "stdio",
      status: "online",
      resources_reserved: false,
      resources_reserved_count: 1,
      tools_count: 3,
      prompts_count: 1,
      last_refresh_at: "2026-07-06T08:00:00Z",
    }),
    server("srv_2", "Ticketing", {
      transport: "sse",
      status: "auth_required",
      resources_reserved: false,
      tools_count: 2,
      prompts_count: 0,
    }),
  ];
}

function server(
  id: string,
  name: string,
  patch: Partial<McpServerSummary> = {},
): McpServerSummary {
  return {
    id,
    name,
    description: null,
    enabled: true,
    required: false,
    transport: "streamable_http",
    status: "unknown",
    tools_count: 0,
    prompts_count: 0,
    resources_reserved: false,
    last_refresh_at: null,
    last_error_message: null,
    ...patch,
  };
}

function serverDetail(
  id: string,
  name: string,
  patch: Partial<ReturnType<typeof server> & {
    command: string | null;
    args: string[];
    cwd: string | null;
    url: string | null;
    sse_url: string | null;
    message_url: string | null;
    inherit_environment: boolean;
    env_keys: string[];
    header_keys: string[];
    env_header_keys: string[];
    bearer_token_env_var: string | null;
    auth_type: "none" | "header_token" | "bearer_env" | "oauth";
    secret_ref_keys: string[];
    oauth_configured: boolean;
    oauth_resource: string | null;
    oauth_scopes: string[];
    startup_timeout_sec: number;
    tool_timeout_sec: number;
    read_timeout_sec: number;
    sse_read_timeout_sec: number;
    shutdown_timeout_sec: number;
    restart_policy: "never" | "on_failure" | "always";
    connect_mode: "on_demand" | "on_startup";
    auto_refresh: boolean;
    refresh_interval_sec: number;
    default_tool_exposure_mode: "allow_all_except_disabled" | "allow_selected_only" | "read_only_auto";
    default_tool_approval_mode: "auto" | "prompt" | "approve";
    supports_parallel_tool_calls: boolean;
    elicitation_enabled: boolean;
    sampling_enabled: boolean;
    sampling_approval_mode: "prompt" | "auto" | string | null;
    sampling_model_policy: "current_default" | string | null;
    sampling_max_tokens: number | null;
    sampling_audit_detail: "summary" | "none" | "full" | string | null;
    prompt_discovery_enabled: boolean;
    resource_reserved_policy: Record<string, unknown> | null;
  }> = {},
) {
  return {
    ...server(id, name, { transport: "stdio", ...patch }),
    command: "node",
    args: [],
    cwd: null,
    url: null,
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
    prompt_discovery_enabled: true,
    resource_reserved_policy: null,
    ...patch,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function toolFixtures(): McpToolSummary[] {
  return [
    tool("tool_read", "read_file", {
      description: "Read a workspace file",
      model_name: "mcp__filesystem__read_file",
      risk_level: "low",
      approval_mode: "auto",
      effective_approval_mode: "auto",
      call_count: 4,
      last_used_at: "2026-07-06T09:15:00Z",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
      },
      annotations: { readOnlyHint: true },
    }),
    tool("tool_write", "write_ticket", {
      description: "Create or update a ticket",
      model_name: "mcp__ticketing__write_ticket",
      risk_level: "high",
      approval_mode: "prompt",
      effective_approval_mode: "prompt",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
      },
      annotations: { destructiveHint: true },
    }),
    tool("tool_calc", "calculate_total", {
      description: "Calculate an order total",
      model_name: "mcp__filesystem__calculate_total",
      risk_level: "medium",
      approval_mode: "auto",
      effective_approval_mode: "auto",
      discovery_status: "schema_changed",
      status: "schema_changed",
      effective_state: "schema_changed",
      input_schema: {
        type: "object",
        properties: {
          amount: { type: "number" },
        },
      },
    }),
    tool("tool_removed", "old_tool", {
      description: "Removed tool",
      model_name: "mcp__filesystem__old_tool",
      risk_level: "unknown",
      approval_mode: "auto",
      effective_approval_mode: "auto",
      enabled: false,
      discovery_status: "removed",
      status: "removed",
      effective_state: "removed",
      removed_at: "2026-07-06T09:00:00Z",
    }),
  ];
}

function tool(id: string, rawName: string, patch: Partial<McpToolSummary> = {}): McpToolSummary {
  return {
    id,
    server_id: "srv_1",
    server_name: "Filesystem",
    raw_name: rawName,
    model_name: `mcp__filesystem__${rawName}`,
    display_name: null,
    description: null,
    input_schema: { type: "object", properties: {} },
    enabled: true,
    hidden: false,
    status: "unchanged",
    discovery_status: "unchanged",
    effective_state: "enabled",
    risk_level: "low",
    stored_risk_level: "low",
    risk_override: null,
    approval_mode: "auto",
    effective_approval_mode: "auto",
    schema_change_action: "require_review",
    parameter_constraints: null,
    annotations: {},
    last_used_at: null,
    call_count: 0,
    failure_count: 0,
    first_seen_at: "2026-07-06T08:00:00Z",
    last_seen_at: "2026-07-06T08:00:00Z",
    removed_at: null,
    ...patch,
  };
}

function toolListResponse(tools: McpToolSummary[]): McpToolListResponse {
  return { list: tools, total: tools.length, limit: 500 };
}

function filterTools(tools: McpToolSummary[], options: Record<string, unknown>): McpToolSummary[] {
  const search = typeof options.search === "string" ? options.search.toLowerCase() : "";
  const status = typeof options.status === "string" ? options.status : "";
  const risk = typeof options.risk === "string" ? options.risk : "";
  const enabled = typeof options.enabled === "boolean" ? options.enabled : null;
  return tools.filter((item) => {
    if (search && !`${item.raw_name} ${item.model_name} ${item.description ?? ""}`.toLowerCase().includes(search)) {
      return false;
    }
    if (status && item.discovery_status !== status && item.status !== status) {
      return false;
    }
    if (risk && item.risk_level !== risk) {
      return false;
    }
    if (enabled !== null && item.enabled !== enabled) {
      return false;
    }
    return true;
  });
}

function applyToolPolicyPatch(tool: McpToolSummary, payload: Partial<McpToolSummary>): McpToolSummary {
  const enabled = typeof payload.enabled === "boolean" ? payload.enabled : tool.enabled;
  const approvalMode = payload.approval_mode ?? tool.approval_mode;
  return {
    ...tool,
    enabled,
    approval_mode: approvalMode,
    effective_approval_mode: approvalMode,
    effective_state: enabled ? "enabled" : "disabled_persistently",
  };
}

function promptFixtures(): McpPromptSummary[] {
  return [
    prompt("prompt_summary", "summarize_ticket", {
      description: "Summarize a ticket or topic",
      argument_count: 1,
      arguments_schema: {
        type: "object",
        required: ["topic"],
        properties: {
          topic: { type: "string" },
        },
      },
    }),
    prompt("prompt_release", "release_notes", {
      description: "Draft release notes",
      exposure_mode: "slash_command",
      argument_count: 1,
      arguments_schema: {
        type: "object",
        properties: {
          version: { type: "string" },
        },
      },
    }),
    prompt("prompt_removed", "old_prompt", {
      description: "Removed prompt",
      enabled: false,
      exposure_mode: "hidden",
      status: "removed",
      discovery_status: "removed",
      removed_at: "2026-07-06T09:00:00Z",
    }),
  ];
}

function prompt(id: string, rawName: string, patch: Partial<McpPromptSummary> = {}): McpPromptSummary {
  return {
    id,
    server_id: "srv_1",
    server_name: "Filesystem",
    raw_name: rawName,
    display_name: null,
    description: null,
    arguments_schema: { type: "object", properties: {} },
    enabled: true,
    exposure_mode: "manual",
    argument_count: 0,
    status: "available",
    discovery_status: "available",
    first_seen_at: "2026-07-06T08:00:00Z",
    last_seen_at: "2026-07-06T08:00:00Z",
    removed_at: null,
    ...patch,
  };
}

function promptListResponse(prompts: McpPromptSummary[]): McpPromptListResponse {
  return { list: prompts, total: prompts.length, limit: 500 };
}

function filterPrompts(prompts: McpPromptSummary[], options: Record<string, unknown>): McpPromptSummary[] {
  const search = typeof options.search === "string" ? options.search.toLowerCase() : "";
  const status = typeof options.status === "string" ? options.status : "";
  const enabled = typeof options.enabled === "boolean" ? options.enabled : null;
  return prompts.filter((item) => {
    if (search && !`${item.raw_name} ${item.description ?? ""}`.toLowerCase().includes(search)) {
      return false;
    }
    if (status && item.discovery_status !== status && item.status !== status) {
      return false;
    }
    if (enabled !== null && item.enabled !== enabled) {
      return false;
    }
    return true;
  });
}

function materializedPrompt() {
  return {
    id: "prompt_summary",
    server_id: "srv_1",
    server_name: "Filesystem",
    raw_name: "summarize_ticket",
    arguments: { topic: "Q3 roadmap" },
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Summarize Q3 roadmap" }],
      },
    ],
  };
}

function trustRuleFixtures(): McpTrustRule[] {
  return [
    {
      id: "trust_1",
      rule_kind: "tool",
      scope: "global",
      approval_mode: "approve",
      hit_count: 3,
      created_at: "2026-07-06T08:10:00Z",
      updated_at: "2026-07-06T08:20:00Z",
      server_id: "srv_1",
      raw_tool_name: "read_file",
      session_id: null,
      condition: { path_prefix: "/docs" },
      created_from_approval_id: null,
      expires_at: null,
      last_hit_at: "2026-07-06T08:30:00Z",
    },
  ];
}

function auditFixtures(): McpAuditRecord[] {
  return [
    {
      id: "audit_1",
      event_type: "server.updated",
      server_id: "srv_1",
      raw_tool_name: null,
      prompt_name: null,
      session_id: null,
      turn_id: null,
      call_id: null,
      approval_id: null,
      actor: "user",
      status: "ok",
      duration_ms: 12,
      summary: "Server config updated",
      detail: { field: "auto_refresh" },
      created_at: "2026-07-06T08:00:00Z",
    },
    {
      id: "audit_2",
      event_type: "tool.failed",
      server_id: "srv_1",
      raw_tool_name: "write_ticket",
      prompt_name: null,
      session_id: "session_1",
      turn_id: null,
      call_id: "call_1",
      approval_id: null,
      actor: "agent",
      status: "failed",
      duration_ms: 80,
      summary: "Tool failed",
      detail: { code: "timeout" },
      created_at: "2026-07-06T08:05:00Z",
    },
    {
      id: "audit_3",
      event_type: "sampling.requested",
      server_id: "srv_1",
      raw_tool_name: null,
      prompt_name: null,
      session_id: "session_1",
      turn_id: "turn_sampling",
      call_id: "sampling_1",
      approval_id: "approval_sampling",
      actor: "mcp_server",
      status: "pending",
      duration_ms: null,
      summary: "Sampling requested",
      detail: { model_policy: "current_default", max_tokens: 2048 },
      created_at: "2026-07-06T08:10:00Z",
    },
    {
      id: "audit_4",
      event_type: "sampling.completed",
      server_id: "srv_1",
      raw_tool_name: null,
      prompt_name: null,
      session_id: "session_1",
      turn_id: "turn_sampling",
      call_id: "sampling_1",
      approval_id: "approval_sampling",
      actor: "model_provider",
      status: "ok",
      duration_ms: 140,
      summary: "Sampling resolved",
      detail: { model: "current_default", output_tokens: 128 },
      created_at: "2026-07-06T08:11:00Z",
    },
  ];
}

function auditListResponse(
  records: McpAuditRecord[],
  total = records.length,
  limit = 100,
  offset = 0,
): McpAuditListResponse {
  return { list: records, total, limit, offset };
}

function filterAuditLogs(records: McpAuditRecord[], options: Record<string, unknown>): McpAuditRecord[] {
  const eventType = typeof options.event_type === "string" ? options.event_type : "";
  const status = typeof options.status === "string" ? options.status : "";
  return records.filter((record) => {
    if (eventType && record.event_type !== eventType) {
      return false;
    }
    if (status && record.status !== status) {
      return false;
    }
    return true;
  });
}

function importPreviewResponse(): McpImportPreviewResponse {
  return {
    source_type: "claude",
    conflict_strategy: "skip",
    server_count: 2,
    servers: [
      {
        name: "Duplicate",
        transport: "stdio",
        enabled: true,
        conflict: true,
        action: "skip",
        missing_secrets: [],
        unknown_fields: [],
      },
      {
        name: "New Tools",
        transport: "stdio",
        enabled: true,
        conflict: false,
        action: "create",
        missing_secrets: ["env.API_KEY"],
        unknown_fields: [],
      },
    ],
    conflicts: ["Duplicate"],
    missing_secrets: ["New Tools.env.API_KEY"],
    unknown_fields: [],
    valid: true,
  };
}
