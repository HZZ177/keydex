import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { McpConsolePage } from "@/renderer/pages/mcp/McpConsolePage";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import type {
  McpAuditListResponse,
  McpAuditRecord,
  McpExportPayload,
  McpExportResponse,
  McpImportPayload,
  McpImportPreviewResponse,
  McpServerDetailResponse,
  McpServerUpdatePayload,
  McpServerSummary,
  McpToolBulkPolicyPayload,
  McpToolListResponse,
  McpToolSummary,
  McpTrustRule,
} from "@/types/protocol";

describe("McpConsolePage", () => {
  it("renders server list first and shows detail after selection", async () => {
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures())} />);

    expect(await screen.findByTestId("mcp-console-page")).not.toBeNull();
    const list = await screen.findByTestId("mcp-server-list");
    expect(within(list).getByText("Filesystem")).not.toBeNull();
    expect(within(list).getByText("Ticketing")).not.toBeNull();
    expect(screen.getByTestId("mcp-detail-empty")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Filesystem" })).toBeNull();

    await selectMcpServer("Filesystem");

    expect(await screen.findByRole("heading", { name: "Filesystem" })).not.toBeNull();
    expect(screen.getByText("无鉴权")).not.toBeNull();
    expect(screen.queryByText("鉴权方式：无鉴权")).toBeNull();
    expect(screen.getByRole("button", { name: "工具授权" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Resources" })).toBeNull();
    expect(screen.getByRole("button", { name: "权限" })).not.toBeNull();
    expect(screen.getByText("已支持，暂不开放读取")).not.toBeNull();
  });

  it("renders connection tab details instead of the skeleton placeholder", async () => {
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures())} />);

    await selectMcpServer("Filesystem");
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    const connectionTab = await screen.findByTestId("mcp-connection-tab");
    expect(within(connectionTab).getByText("启动命令")).not.toBeNull();
    expect(within(connectionTab).getByText("node")).not.toBeNull();
    expect(within(connectionTab).getByText("启动超时")).not.toBeNull();
    expect(screen.queryByTestId("mcp-tab-connection")).toBeNull();
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

    fireEvent.change(screen.getByLabelText("搜索 MCP 服务器"), { target: { value: "ticket" } });

    expect(within(list).queryByText("Filesystem")).toBeNull();
    expect(within(list).getByText("Ticketing")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Ticketing" })).toBeNull();
    expect(screen.getByTestId("mcp-detail-empty")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("搜索 MCP 服务器"), { target: { value: "" } });
    await chooseSettingsSelect("筛选 MCP 服务器状态", "在线");

    expect(within(list).getByText("Filesystem")).not.toBeNull();
    expect(within(list).queryByText("Ticketing")).toBeNull();

    await chooseSettingsSelect("筛选 MCP 服务器状态", "全部状态");
    await chooseSettingsSelect("筛选 MCP 服务器连接方式", "SSE 地址");

    expect(within(list).queryByText("Filesystem")).toBeNull();
    expect(within(list).getByText("Ticketing")).not.toBeNull();
  });

  it("opens server detail without refreshing MCP discovery and reloads active detail data", async () => {
    const refreshServer = vi.fn().mockResolvedValue({ ok: true, server_id: "srv_1", status: "online" });
    const listTools = vi.fn(() => Promise.resolve(toolListResponse(toolFixtures())));
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { refreshServer, listTools })} />);

    await screen.findByTestId("mcp-server-list");
    expect(refreshServer).not.toHaveBeenCalled();

    await selectMcpServer("Filesystem");
    expect(refreshServer).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: "工具授权" }));
    await waitFor(() => expect(listTools).toHaveBeenCalledWith("srv_1", expect.objectContaining({ limit: 500 })));
    const toolLoadsAfterFirstOpen = listTools.mock.calls.length;

    await selectMcpServer("Filesystem");

    await waitFor(() => expect(listTools.mock.calls.length).toBeGreaterThan(toolLoadsAfterFirstOpen));
    expect(refreshServer).not.toHaveBeenCalled();
  });

  it("reloads the server list without refreshing MCP discovery", async () => {
    const listServers = vi.fn()
      .mockResolvedValueOnce({ list: [server("srv_1", "Filesystem")], total: 1, limit: 500, offset: 0 })
      .mockResolvedValueOnce({ list: [server("srv_2", "Ticketing")], total: 1, limit: 500, offset: 0 })
      .mockResolvedValue({ list: [server("srv_2", "Ticketing")], total: 1, limit: 500, offset: 0 });
    const refreshServer = vi.fn().mockResolvedValue({ ok: true, server_id: "srv_1", status: "online" });
    const refreshServers = vi.fn().mockResolvedValue({ ok: true, list: [], total: 0 });
    const runtime = {
      mcp: {
        listServers,
        refreshServer,
        refreshServers,
      },
    } as unknown as RuntimeBridge;
    render(<McpConsolePage runtime={runtime} />);

    const list = await screen.findByTestId("mcp-server-list");
    await waitFor(() => expect(within(list).getByText("Filesystem")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "刷新 MCP 服务器列表" }));

    await waitFor(() => expect(listServers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(list).getByText("Ticketing")).not.toBeNull());
    expect(refreshServer).not.toHaveBeenCalled();
    expect(refreshServers).not.toHaveBeenCalled();
  });

  it("refreshes the selected MCP server only from the detail refresh action", async () => {
    const refreshServer = vi.fn().mockResolvedValue({ ok: true, server_id: "srv_1", status: "online" });
    const listTools = vi.fn(() => Promise.resolve(toolListResponse(toolFixtures())));
    renderMcpConsoleWithNotifications(runtimeWithServers(serverFixtures(), { refreshServer, listTools }));

    await selectMcpServer("Filesystem");
    fireEvent.click(await screen.findByRole("button", { name: "工具授权" }));
    await waitFor(() => expect(listTools).toHaveBeenCalledWith("srv_1", expect.objectContaining({ limit: 500 })));
    const toolLoadsBeforeRefresh = listTools.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "刷新 MCP 服务器" }));

    await waitFor(() => expect(refreshServer).toHaveBeenCalledWith("srv_1"));
    expect(await screen.findByText("服务器刷新完成，状态 在线")).not.toBeNull();
    await waitFor(() => expect(listTools.mock.calls.length).toBeGreaterThan(toolLoadsBeforeRefresh));
  });

  it("opens server card context menu for refresh and delete actions", async () => {
    const refreshServer = vi.fn().mockResolvedValue({ ok: true, server_id: "srv_1", status: "online" });
    renderMcpConsoleWithNotifications(runtimeWithServers(serverFixtures(), { refreshServer }));

    const serverButton = await screen.findByRole("button", { name: "查看 MCP 服务器 Filesystem" });
    fireEvent.contextMenu(serverButton);

    const menu = await screen.findByRole("menu", { name: "MCP 服务器 Filesystem 操作菜单" });
    expect(within(menu).getByRole("menuitem", { name: "编辑服务器" })).not.toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "刷新服务器" })).not.toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "删除服务器" })).not.toBeNull();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "刷新服务器" }));

    await waitFor(() => expect(refreshServer).toHaveBeenCalledWith("srv_1"));
    expect(await screen.findByText("服务器刷新完成，状态 在线")).not.toBeNull();

    fireEvent.contextMenu(serverButton);
    const deleteMenu = await screen.findByRole("menu", { name: "MCP 服务器 Filesystem 操作菜单" });
    fireEvent.click(within(deleteMenu).getByRole("menuitem", { name: "删除服务器" }));

    expect(await screen.findByRole("dialog", { name: "确认删除 MCP 服务器？" })).not.toBeNull();
  });

  it("opens server edit form from the server card context menu", async () => {
    const getServer = vi.fn(
      (serverId: string): Promise<McpServerDetailResponse> =>
        Promise.resolve(serverDetail(serverId, "Filesystem") as McpServerDetailResponse),
    );
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { getServer })} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "查看 MCP 服务器 Filesystem" }));
    const menu = await screen.findByRole("menu", { name: "MCP 服务器 Filesystem 操作菜单" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "编辑服务器" }));

    expect(await screen.findByRole("dialog", { name: "编辑 MCP 服务器" })).not.toBeNull();
    await waitFor(() => expect(getServer).toHaveBeenCalledWith("srv_1"));
  });

  it("deletes a server after confirmation and reloads the list", async () => {
    const listServers = vi.fn()
      .mockResolvedValueOnce({ list: [server("srv_delete", "Delete Me")], total: 1, limit: 500, offset: 0 })
      .mockResolvedValueOnce({ list: [], total: 0, limit: 500, offset: 0 });
    const deleteServer = vi.fn().mockResolvedValue({ deleted: true, server_id: "srv_delete" });
    renderMcpConsoleWithNotifications(runtimeWithServers([], { listServers, deleteServer }));

    await selectMcpServer("Delete Me");
    expect(await screen.findByRole("heading", { name: "Delete Me" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "删除 MCP 服务器" }));

    const dialog = await screen.findByRole("dialog", { name: "确认删除 MCP 服务器？" });
    expect(within(dialog).getByText("Delete Me / HTTP 地址")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(deleteServer).toHaveBeenCalledWith("srv_delete"));
    expect(await screen.findByText("MCP 服务器已删除：Delete Me")).not.toBeNull();
    expect(await screen.findByTestId("mcp-server-empty")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Delete Me" })).toBeNull();
  });

  it("toggles server enabled state from the server list without opening detail", async () => {
    const disabledServer = server("srv_disabled", "Disabled MCP", { enabled: false, status: "disabled" });
    const refresh = createDeferred<{ ok: boolean; server_id: string; status: string }>();
    const toggleServer = vi.fn().mockResolvedValue({ ...disabledServer, enabled: true, status: "unknown" });
    const refreshServer = vi.fn(() => refresh.promise);
    const listServers = vi.fn()
      .mockResolvedValueOnce({ list: [disabledServer], total: 1, limit: 500, offset: 0 })
      .mockResolvedValueOnce({
        list: [{ ...disabledServer, enabled: true, status: "online" }],
        total: 1,
        limit: 500,
        offset: 0,
      });
    renderMcpConsoleWithNotifications(runtimeWithServers([], { listServers, refreshServer, toggleServer }));

    await screen.findByRole("button", { name: "查看 MCP 服务器 Disabled MCP" });
    expect(screen.getByTestId("mcp-detail-empty")).not.toBeNull();
    const enableSwitch = await screen.findByRole("switch", { name: "启用 MCP 服务器 Disabled MCP" });
    fireEvent.click(enableSwitch);
    await waitFor(() => expect(enableSwitch.getAttribute("aria-checked")).toBe("true"));
    expect(await screen.findByText("刷新中")).not.toBeNull();

    await waitFor(() => expect(toggleServer).toHaveBeenCalledWith("srv_disabled", true));
    await waitFor(() => expect(refreshServer).toHaveBeenCalledWith("srv_disabled"));
    refresh.resolve({ ok: true, server_id: "srv_disabled", status: "online" });
    expect(await screen.findByText("MCP 服务器已启用并刷新：Disabled MCP，状态 在线")).not.toBeNull();
    expect(await screen.findByText("在线")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Disabled MCP" })).toBeNull();
  });

  it("opens the server form and switches transport-specific fields", async () => {
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures())} />);

    fireEvent.click(await screen.findByRole("button", { name: "添加 MCP 服务器" }));

    const dialog = await screen.findByRole("dialog", { name: "添加 MCP 服务器" });
    expect(dialog.getAttribute("data-size")).toBe("form");
    expect(screen.getByLabelText("MCP HTTP 地址")).not.toBeNull();
    expect(screen.getByLabelText("Bearer 令牌环境变量")).not.toBeNull();
    expect(screen.queryByText("高级设置")).toBeNull();
    expect(screen.queryByText("Timeouts 与运行策略")).toBeNull();
    expect(screen.queryByRole("radio", { name: /SSE/ })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /本地命令/ }));
    expect(screen.getByLabelText("本地 MCP 启动命令")).not.toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /HTTP 地址/ }));
    expect(screen.queryByText("来自环境变量的标头")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "显示旧版 SSE 连接" }));
    fireEvent.click(screen.getByRole("radio", { name: /SSE 地址/ }));
    expect(screen.getByLabelText("MCP SSE 地址")).not.toBeNull();
    expect(screen.getByLabelText("MCP SSE 消息地址")).not.toBeNull();
  });

  it("creates a stdio server with args as an array", async () => {
    const created = createDeferred<McpServerDetailResponse>();
    const createServer = vi.fn((_payload: unknown): Promise<McpServerDetailResponse> => created.promise);
    const savedServer = serverDetail("srv_new", "Local Files", {
      command: "node",
      args: ["server.js", "--stdio"],
    }) as McpServerDetailResponse;
    const savedSummary = server("srv_new", "Local Files", { transport: "stdio", status: "online", tools_count: 1 });
    const listServers = vi.fn()
      .mockResolvedValueOnce({ list: [], total: 0, limit: 500, offset: 0 })
      .mockResolvedValue({ list: [savedSummary], total: 1, limit: 500, offset: 0 });
    const refreshServer = vi.fn().mockResolvedValue({ ok: true, server_id: "srv_new", status: "online" });
    const runtime = runtimeWithServers([], { createServer, listServers, refreshServer });
    render(<McpConsolePage runtime={runtime} />);

    fireEvent.click(await screen.findByRole("button", { name: "添加 MCP 服务器" }));
    fireEvent.change(await screen.findByLabelText("MCP 服务器名称"), { target: { value: "Local Files" } });
    fireEvent.click(screen.getByRole("radio", { name: /本地命令/ }));
    fireEvent.change(screen.getByLabelText("本地 MCP 启动命令"), { target: { value: "node" } });
    fireEvent.change(screen.getByLabelText("本地命令参数 1"), { target: { value: "server.js" } });
    fireEvent.click(screen.getByRole("button", { name: "添加参数" }));
    fireEvent.change(screen.getByLabelText("本地命令参数 2"), { target: { value: "--stdio" } });
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));

    expect(await screen.findByRole("button", { name: "保存中" })).not.toBeNull();
    expect(screen.queryByTestId("mcp-save-progress")).toBeNull();
    created.resolve(savedServer);
    await waitFor(() => expect(createServer).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "Local Files" })).not.toBeNull();
    await waitFor(() => expect(refreshServer).toHaveBeenCalledWith("srv_new"));
    expect(createServer.mock.calls[0][0]).toMatchObject({
      name: "Local Files",
      transport: "stdio",
      command: "node",
      args: ["server.js", "--stdio"],
    });
  });

  it("shows capabilities from a successful connection test", async () => {
    const createServer = vi.fn();
    const tested = createDeferred<{
      ok: boolean;
      server_id: string;
      status: string;
      capabilities: { tools: boolean; resources_reserved: boolean };
      tools_count: number;
      duration_ms: number;
    }>();
    const testServerConfig = vi.fn(() => tested.promise);
    render(<McpConsolePage runtime={runtimeWithServers([], { createServer, testServerConfig })} />);

    fireEvent.click(await screen.findByRole("button", { name: "添加 MCP 服务器" }));
    fireEvent.change(await screen.findByLabelText("MCP 服务器名称"), { target: { value: "Capability MCP" } });
    fireEvent.click(screen.getByRole("radio", { name: /本地命令/ }));
    fireEvent.change(screen.getByLabelText("本地 MCP 启动命令"), { target: { value: "node" } });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByTestId("mcp-connection-test-progress")).not.toBeNull();
    expect(screen.getByText("正在连接服务器并读取工具列表")).not.toBeNull();
    tested.resolve({
      ok: true,
      server_id: "temporary-srv_caps",
      status: "online",
      capabilities: { tools: true, resources_reserved: true },
      tools_count: 3,
      duration_ms: 42,
    });
    await waitFor(() =>
      expect(testServerConfig).toHaveBeenCalledWith({
        server: expect.objectContaining({
          name: "Capability MCP",
          transport: "stdio",
          command: "node",
        }),
        base_server_id: null,
      }),
    );
    expect(createServer).not.toHaveBeenCalled();
    expect(await screen.findByText("连接测试通过，状态 online")).not.toBeNull();
    expect(screen.getByText("工具：3 个 · 资源：支持 · 耗时 42ms")).not.toBeNull();
  });

  it("validates required fields before saving", async () => {
    const createServer = vi.fn();
    render(<McpConsolePage runtime={runtimeWithServers([], { createServer })} />);

    fireEvent.click(await screen.findByRole("button", { name: "添加 MCP 服务器" }));
    fireEvent.click(await screen.findByRole("button", { name: /^保存$/ }));

    expect((await screen.findByRole("alert")).textContent).toContain("请填写服务器名称");
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

    await selectMcpServer("Filesystem");
    fireEvent.click(await screen.findByRole("button", { name: "编辑 MCP 服务器连接" }));
    fireEvent.change(await screen.findByLabelText("本地 MCP 启动命令"), { target: { value: "python" } });
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

    await selectMcpServer("Secure HTTP");
    fireEvent.click(await screen.findByRole("button", { name: "编辑 MCP 服务器连接" }));

    expect(await screen.findByText("已配置：api_key")).not.toBeNull();
    expect(screen.queryByText("secret-token-value")).toBeNull();

    fireEvent.click(screen.getByLabelText("清除"));
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
    expect(await screen.findByText("已保存的密钥引用将被清除")).not.toBeNull();
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

    fireEvent.click(await screen.findByRole("button", { name: "添加 MCP 服务器" }));
    fireEvent.change(await screen.findByLabelText("MCP 服务器名称"), { target: { value: "HTTP MCP" } });
    fireEvent.click(screen.getByRole("radio", { name: /HTTP 地址/ }));
    fireEvent.change(screen.getByLabelText("MCP HTTP 地址"), {
      target: { value: "https://mcp.example.test/mcp" },
    });
    fireEvent.change(screen.getByLabelText("Bearer 令牌环境变量"), { target: { value: "123bad" } });
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));

    expect((await screen.findByRole("alert")).textContent).toContain("Bearer 令牌环境变量名不合法");
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

    fireEvent.click(await screen.findByRole("button", { name: "添加 MCP 服务器" }));
    fireEvent.change(await screen.findByLabelText("MCP 服务器名称"), { target: { value: "Remote MCP" } });
    fireEvent.click(screen.getByRole("radio", { name: /HTTP 地址/ }));
    fireEvent.change(screen.getByLabelText("MCP HTTP 地址"), {
      target: { value: "https://mcp.example.test/mcp" },
    });
    fireEvent.change(screen.getByLabelText("Bearer 令牌环境变量"), { target: { value: "MCP_BEARER_TOKEN" } });
    fireEvent.change(screen.getByLabelText("标头 键 1"), { target: { value: "X-Workspace" } });
    fireEvent.change(screen.getByLabelText("标头 值 1"), { target: { value: "default" } });
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));

    await waitFor(() => expect(createServer).toHaveBeenCalledTimes(1));
    const payload = createServer.mock.calls[0][0];
    expect(payload).toMatchObject({
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
    expect(payload).not.toHaveProperty("startup_timeout_sec");
    expect(payload).not.toHaveProperty("tool_timeout_sec");
    expect(payload).not.toHaveProperty("default_tool_approval_mode");
    expect(payload).not.toHaveProperty("default_tool_exposure_mode");
    expect(payload).not.toHaveProperty("sampling_enabled");
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

    await selectMcpServer("OAuth MCP");
    fireEvent.click(await screen.findByRole("button", { name: "编辑 MCP 服务器连接" }));

    expect(await screen.findByText("dev@example.test")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新授权" }));

    await waitFor(() => expect(startOAuth).toHaveBeenCalledWith("srv_1"));
    expect(open).toHaveBeenCalledWith("https://oauth.example.test/authorize", "_blank", "noopener,noreferrer");

    fireEvent.click(screen.getByRole("button", { name: "清除凭据" }));
    expect(await screen.findByText("确认清除 OAuth 凭据？清除后该服务器需要重新授权。")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认清除" }));

    await waitFor(() => expect(clearOAuth).toHaveBeenCalledWith("srv_1"));
    vi.unstubAllGlobals();
  });

  it("lists, searches and filters MCP tools", async () => {
    const listTools = vi.fn((serverId: string, options: Record<string, unknown> = {}) =>
      Promise.resolve(toolListResponse(filterTools(toolFixtures(), options))),
    );
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { listTools })} />);

    await selectMcpServer("Filesystem");
    fireEvent.click(await screen.findByRole("button", { name: "工具授权" }));
    const currentToolList = () => within(screen.getByTestId("mcp-tool-list"));

    expect(await screen.findByRole("button", { name: "筛选 MCP 工具显示范围：未移除工具" })).not.toBeNull();
    await waitFor(() => expect(currentToolList().getByText("read_file")).not.toBeNull());
    expect(currentToolList().getByText("write_ticket")).not.toBeNull();
    expect(currentToolList().queryByText("old_tool")).toBeNull();
    expect(currentToolList().getAllByText("确认方式：按请求审批").length).toBeGreaterThan(0);

    await chooseSettingsSelect("筛选 MCP 工具确认方式", "按服务器设置");

    await waitFor(() => expect(currentToolList().getByText("read_file")).not.toBeNull());
    expect(currentToolList().queryByText("write_ticket")).toBeNull();

    await chooseSettingsSelect("筛选 MCP 工具确认方式", "每次确认");

    await waitFor(() => expect(currentToolList().queryByText("read_file")).toBeNull());
    expect(currentToolList().getByText("write_ticket")).not.toBeNull();

    await chooseSettingsSelect("筛选 MCP 工具确认方式", "全部确认方式");

    await chooseSettingsSelect("筛选 MCP 工具显示范围", "全部工具");

    expect(await screen.findByRole("button", { name: "筛选 MCP 工具显示范围：全部工具" })).not.toBeNull();
    await waitFor(() => expect(currentToolList().getByText("old_tool")).not.toBeNull());

    fireEvent.change(screen.getByLabelText("搜索 MCP 工具"), { target: { value: "write" } });

    await waitFor(() =>
      expect(listTools).toHaveBeenLastCalledWith("srv_1", expect.objectContaining({ search: "write", limit: 500 })),
    );
    await waitFor(() => expect(currentToolList().queryByText("read_file")).toBeNull());
    expect(currentToolList().getByText("write_ticket")).not.toBeNull();

  });

  it("updates a single tool visibility and approval policy", async () => {
    let tools = toolFixtures();
    const updateToolPolicy = vi.fn((serverId: string, toolId: string, payload: Partial<McpToolSummary>) => {
      const updated = applyToolPolicyPatch(tools.find((tool) => tool.id === toolId)!, payload);
      tools = tools.map((tool) => (tool.id === toolId ? updated : tool));
      return Promise.resolve(updated);
    });
    const listTools = vi.fn(() => Promise.resolve(toolListResponse(tools)));
    renderMcpConsoleWithNotifications(runtimeWithServers(serverFixtures(), { listTools, updateToolPolicy }));

    await selectMcpServer("Filesystem");
    fireEvent.click(await screen.findByRole("button", { name: "工具授权" }));
    fireEvent.click(await screen.findByRole("switch", { name: "启用工具 read_file" }));

    await waitFor(() =>
      expect(updateToolPolicy).toHaveBeenCalledWith("srv_1", "tool_read", { enabled: false }),
    );
    expect(await screen.findByText("已禁用 read_file：立即阻止执行，下一轮不再暴露给智能体")).not.toBeNull();

    await chooseSettingsSelect("确认方式 read_file", "每次确认");

    await waitFor(() =>
      expect(updateToolPolicy).toHaveBeenLastCalledWith("srv_1", "tool_read", { approval_mode: "prompt" }),
    );
    expect(await screen.findByText("工具确认方式已更新")).not.toBeNull();
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
    renderMcpConsoleWithNotifications(runtimeWithServers(serverFixtures(), { applyToolBulkPolicy }));

    await selectMcpServer("Filesystem");
    fireEvent.click(await screen.findByRole("button", { name: "工具授权" }));
    fireEvent.click(await screen.findByRole("button", { name: "选择工具 read_file" }));
    await chooseSettingsSelect("MCP 工具批量授权", "仅启用所选工具");
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    await waitFor(() =>
      expect(applyToolBulkPolicy).toHaveBeenCalledWith("srv_1", {
        action: "keep_selected_only",
        tool_ids: ["tool_read"],
      }),
    );
    expect(await screen.findByText("批量授权已应用，更新 1 个工具")).not.toBeNull();
  });

  it("shows schema details and schema changed or removed states", async () => {
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures())} />);

    await selectMcpServer("Filesystem");
    fireEvent.click(await screen.findByRole("button", { name: "工具授权" }));

    expect(await screen.findByText("参数结构已变化，需检查后确认授权")).not.toBeNull();
    expect(screen.queryByText("old_tool")).toBeNull();
    expect(document.querySelector('[class*="toolsContent"]')?.getAttribute("data-has-schema")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "查看参数结构 calculate_total" }));

    const schemaPanel = await screen.findByTestId("mcp-tool-schema-panel");
    expect(document.querySelector('[class*="toolsContent"]')?.getAttribute("data-has-schema")).toBe("true");
    expect(within(schemaPanel).getByText("calculate_total")).not.toBeNull();
    expect(within(schemaPanel).getByText(/\"type\": \"object\"/)).not.toBeNull();
    expect(within(schemaPanel).getByText(/\"amount\"/)).not.toBeNull();

    await chooseSettingsSelect("筛选 MCP 工具显示范围", "已移除工具");

    expect(await screen.findByText("old_tool")).not.toBeNull();
    expect(screen.getAllByText("已移除").length).toBeGreaterThan(0);
  });

  it("updates server permission modes from the permissions tab", async () => {
    const detail = serverDetail("srv_1", "Filesystem", { default_tool_approval_mode: "prompt" });
    const updateServer = vi.fn((serverId: string, payload: McpServerUpdatePayload) =>
      Promise.resolve({ ...detail, ...payload } as McpServerDetailResponse),
    );
    renderMcpConsoleWithNotifications(runtimeWithServers(serverFixtures(), {
      getServer: vi.fn().mockResolvedValue(detail),
      listTrustRules: vi.fn().mockResolvedValue({ list: [] }),
      updateServer,
    }));

    await selectMcpServer("Filesystem");
    fireEvent.click(await screen.findByRole("button", { name: "权限" }));
    expect(await screen.findByTestId("mcp-permissions-tab")).not.toBeNull();
    expect(screen.getByRole("button", { name: /按请求审批/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /信任此服务/ })).not.toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: /信任此服务/ }));

    await waitFor(() =>
      expect(updateServer).toHaveBeenCalledWith("srv_1", {
        default_tool_approval_mode: "approve",
        default_tool_exposure_mode: "allow_all_except_disabled",
      }),
    );
    expect(await screen.findByText("服务器权限已保存：信任此服务")).not.toBeNull();
  });

  it("lists and deletes trust rules", async () => {
    const deleteTrustRule = vi.fn().mockResolvedValue({ deleted: true, rule_id: "trust_1" });
    renderMcpConsoleWithNotifications(
      runtimeWithServers(serverFixtures(), {
        listTrustRules: vi.fn().mockResolvedValue({ list: trustRuleFixtures() }),
        deleteTrustRule,
      }),
    );

    await selectMcpServer("Filesystem");
    fireEvent.click(await screen.findByRole("button", { name: "权限" }));
    const trustList = await screen.findByTestId("mcp-trust-rule-list");

    expect(within(trustList).getByText("已信任工具")).not.toBeNull();
    expect(within(trustList).getByText("read_file")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "删除信任项 已信任工具" }));

    await waitFor(() => expect(deleteTrustRule).toHaveBeenCalledWith("trust_1"));
    expect(await screen.findByText("信任项已删除")).not.toBeNull();
  });

  it("lists, filters and expands audit logs", async () => {
    const listAudit = vi.fn((options: Record<string, unknown> = {}) =>
      Promise.resolve(auditListResponse(filterAuditLogs(auditFixtures(), options))),
    );
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { listAudit })} />);

    await selectMcpServer("Filesystem");
    fireEvent.click(await screen.findByRole("button", { name: "日志" }));
    const logList = (await screen.findAllByTestId("mcp-log-row"))[0];

    expect(logList.textContent).toContain("服务已更新");
    fireEvent.click(logList.querySelector("button")!);
    expect(await screen.findByText(/\"field\": \"auto_refresh\"/)).not.toBeNull();

    await chooseSettingsSelect("筛选 MCP 日志事件", "工具调用失败");

    await waitFor(() =>
      expect(listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ server_id: "srv_1", event_type: "tool.failed" })),
    );
    expect((await screen.findAllByText("工具调用失败")).length).toBeGreaterThan(0);

    await chooseSettingsSelect("筛选 MCP 日志状态", "失败");

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

    await selectMcpServer("Filesystem");
    fireEvent.click(await screen.findByRole("button", { name: "日志" }));

    expect(await screen.findByText("第 1 / 2 页，共 12 条")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下一页 MCP 日志" }));

    await waitFor(() =>
      expect(listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ server_id: "srv_1", limit: 10, offset: 10 })),
    );
    expect(await screen.findByText("第 2 / 2 页，共 12 条")).not.toBeNull();

    await chooseSettingsSelect("筛选 MCP 日志事件", "刷新完成");

    await waitFor(() =>
      expect(listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ event_type: "refresh.completed", offset: 0 })),
    );
    expect(await screen.findByText("第 1 / 1 页，共 1 条")).not.toBeNull();
  });

  it("shows audit log empty and stable error states", async () => {
    const listAudit = vi.fn()
      .mockResolvedValueOnce(auditListResponse([]))
      .mockRejectedValueOnce({
        code: "timeout",
        message: "Bearer raw-visible-token\nstack trace line",
      });
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { listAudit })} />);

    await selectMcpServer("Filesystem");
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

    await selectMcpServer("Filesystem");
    fireEvent.click(await screen.findByRole("button", { name: "日志" }));
    await chooseSettingsSelect("筛选 MCP 日志事件", "模型请求已接收");

    await waitFor(() =>
      expect(listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ server_id: "srv_1", event_type: "sampling.requested" })),
    );
    expect((await screen.findAllByText("模型请求已接收")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Sampling requested")).not.toBeNull();

    await chooseSettingsSelect("筛选 MCP 日志事件", "模型请求完成");

    await waitFor(() =>
      expect(listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ server_id: "srv_1", event_type: "sampling.completed" })),
    );
    expect((await screen.findAllByText("模型请求完成")).length).toBeGreaterThan(0);
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
    renderMcpConsoleWithNotifications(runtimeWithServers(serverFixtures(), { importConfig }));

    fireEvent.click(await screen.findByRole("button", { name: "导入 MCP 配置" }));
    expect(await screen.findByRole("dialog", { name: "导入 MCP 配置" })).not.toBeNull();

    await chooseSettingsSelect("MCP 导入来源", "Claude Desktop");
    fireEvent.change(screen.getByLabelText("MCP 导入 JSON"), { target: { value: JSON.stringify(config) } });
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
    expect(within(previewPanel).getByText("跳过")).not.toBeNull();
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
      trust_rules: [{ scope: "global", rule_kind: "tool", raw_tool_name: "read_file" }],
    } satisfies McpExportResponse;
    const exportConfig = vi.fn((payload?: McpExportPayload) =>
      Promise.resolve(payload?.include_trust_rules ? exportResponse : { ...exportResponse, trust_rules: undefined }),
    );
    render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { exportConfig })} />);

    fireEvent.click(await screen.findByRole("button", { name: "导出 MCP 配置" }));
    expect(await screen.findByRole("dialog", { name: "导出 MCP 配置" })).not.toBeNull();
    expect(screen.getByText("导出预览和文件都不包含密钥明文或 OAuth 令牌。")).not.toBeNull();
    expect(screen.getByLabelText("导出 MCP 服务器 Filesystem")).not.toBeNull();
    expect(screen.getByLabelText("导出 MCP 服务器 Ticketing")).not.toBeNull();

    fireEvent.click(screen.getByLabelText("导出包含信任名单"));
    fireEvent.click(screen.getByRole("button", { name: "生成预览" }));

    await waitFor(() =>
      expect(exportConfig).toHaveBeenCalledWith({
        include_trust_rules: true,
        server_ids: ["srv_1", "srv_2"],
      }),
    );
    const preview = await screen.findByTestId("mcp-export-preview");
    expect(preview.textContent).toContain("\"trust_rules\"");
    expect(preview.textContent).toContain("secret:configured");
    expect(preview.textContent).not.toContain("raw-secret-value");
    expect(preview.textContent).not.toContain("raw-token");
  });

  it("exports selected MCP servers as a JSON file", async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = vi.fn(() => "blob:mcp-export");
    const revokeObjectURL = vi.fn();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const exportConfig = vi.fn((payload?: McpExportPayload) =>
      Promise.resolve({
        format: "keydex.mcp.v1",
        servers: [{ name: "Filesystem", selected_ids: payload?.server_ids }],
        tool_policies: [],
      } satisfies McpExportResponse),
    );

    try {
      render(<McpConsolePage runtime={runtimeWithServers(serverFixtures(), { exportConfig })} />);

      fireEvent.click(await screen.findByRole("button", { name: "导出 MCP 配置" }));
      fireEvent.click(await screen.findByLabelText("导出 MCP 服务器 Ticketing"));
      fireEvent.click(screen.getByRole("button", { name: "生成预览" }));

      await waitFor(() =>
        expect(exportConfig).toHaveBeenCalledWith({
          include_trust_rules: false,
          server_ids: ["srv_1"],
        }),
      );
      expect(await screen.findByTestId("mcp-export-preview")).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "导出文件" }));

      await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mcp-export");
      expect(await screen.findByText("文件已下载")).not.toBeNull();
    } finally {
      anchorClick.mockRestore();
      restoreUrlMethod("createObjectURL", originalCreateObjectURL);
      restoreUrlMethod("revokeObjectURL", originalRevokeObjectURL);
    }
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
    fireEvent.change(await screen.findByLabelText("MCP 导入 JSON"), { target: { value: "{bad json" } });
    fireEvent.click(screen.getByRole("button", { name: "预览导入" }));

    expect(await screen.findByText("导入内容不是有效 JSON")).not.toBeNull();
    expect(importConfig).not.toHaveBeenCalled();

    const importDialog = screen.getByRole("dialog", { name: "导入 MCP 配置" });
    const closeButtons = within(importDialog).getAllByRole("button", { name: "关闭" });
    fireEvent.click(closeButtons[closeButtons.length - 1]);
    fireEvent.click(await screen.findByRole("button", { name: "导出 MCP 配置" }));
    fireEvent.click(screen.getByRole("button", { name: "生成预览" }));

    expect(await screen.findByText("MCP 服务器需要认证，请完成登录或补充凭据。")).not.toBeNull();
    expect(screen.queryByText(/raw-export-token/)).toBeNull();
    expect(screen.queryByText(/stack trace line/)).toBeNull();
  });
});

function renderMcpConsoleWithNotifications(runtime: RuntimeBridge) {
  return render(
    <NotificationProvider>
      <McpConsolePage runtime={runtime} />
    </NotificationProvider>,
  );
}

async function chooseSettingsSelect(ariaLabel: string, optionName: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${escapeRegExp(ariaLabel)}：`) }));
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

async function selectMcpServer(name: string) {
  const list = await screen.findByTestId("mcp-server-list");
  fireEvent.click(within(list).getByRole("button", { name: `查看 MCP 服务器 ${name}` }));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function restoreUrlMethod(name: "createObjectURL" | "revokeObjectURL", value: unknown) {
  if (typeof value === "function") {
    Object.defineProperty(URL, name, { configurable: true, value });
    return;
  }
  delete (URL as unknown as Record<string, unknown>)[name];
}

function runtimeWithServers(
  servers: McpServerSummary[],
  overrides: Partial<RuntimeBridge["mcp"]> = {},
): RuntimeBridge {
  return {
    mcp: {
      listServers: vi.fn().mockResolvedValue({ list: servers, total: servers.length, limit: 500, offset: 0 }),
      refreshServer: vi.fn((serverId: string) => Promise.resolve({ ok: true, server_id: serverId, status: "online" })),
      refreshServers: vi.fn().mockResolvedValue({ ok: true, list: [], total: 0 }),
      createServer: vi.fn().mockResolvedValue(serverDetail("srv_created", "Created MCP")),
      getServer: vi.fn((serverId: string) =>
        Promise.resolve(serverDetail(serverId, servers.find((item) => item.id === serverId)?.name ?? "MCP 服务器")),
      ),
      updateServer: vi.fn((serverId: string) => Promise.resolve(serverDetail(serverId, "Updated MCP"))),
      deleteServer: vi.fn((serverId: string) => Promise.resolve({ deleted: true, server_id: serverId })),
      testServer: vi.fn((serverId: string) =>
        Promise.resolve({ ok: true, server_id: serverId, status: "online", capabilities: { tools: true } }),
      ),
      testServerConfig: vi.fn((_payload) =>
        Promise.resolve({
          ok: true,
          server_id: "temporary-test",
          status: "online",
          capabilities: { tools: true, resources_reserved: true },
          tools_count: 1,
        }),
      ),
      listTools: vi.fn(() => Promise.resolve(toolListResponse(toolFixtures()))),
      updateToolPolicy: vi.fn((serverId: string, toolId: string, payload: Partial<McpToolSummary>) =>
        Promise.resolve(applyToolPolicyPatch(toolFixtures().find((tool) => tool.id === toolId)!, payload)),
      ),
      applyToolBulkPolicy: vi.fn((serverId: string, payload: { action: string }) =>
        Promise.resolve({ server_id: serverId, action: payload.action, updated_count: 0, tools: toolFixtures() }),
      ),
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
      last_refresh_at: "2026-07-06T08:00:00Z",
    }),
    server("srv_2", "Ticketing", {
      transport: "sse",
      status: "auth_required",
      resources_reserved: false,
      tools_count: 2,
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
    auth_type: "none",
    status: "unknown",
    tools_count: 0,
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
    default_tool_exposure_mode: "allow_all_except_disabled" | "allow_selected_only";
    default_tool_approval_mode: "auto" | "prompt" | "approve";
    supports_parallel_tool_calls: boolean;
    elicitation_enabled: boolean;
    sampling_enabled: boolean;
    sampling_approval_mode: "prompt" | "auto" | string | null;
    sampling_model_policy: "current_default" | string | null;
    sampling_max_tokens: number | null;
    sampling_audit_detail: "summary" | "none" | "full" | string | null;
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
    default_tool_approval_mode: "prompt",
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
      approval_mode: "inherit",
      effective_approval_mode: "prompt",
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
      approval_mode: "inherit",
      effective_approval_mode: "prompt",
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
      approval_mode: "inherit",
      effective_approval_mode: "prompt",
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
    status: "active",
    discovery_status: "active",
    effective_state: "enabled",
    approval_mode: "inherit",
    effective_approval_mode: "prompt",
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
  const enabled = typeof options.enabled === "boolean" ? options.enabled : null;
  return tools.filter((item) => {
    if (search && !`${item.raw_name} ${item.model_name} ${item.description ?? ""}`.toLowerCase().includes(search)) {
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

function applyToolPolicyPatch(tool: McpToolSummary, payload: Partial<McpToolSummary>): McpToolSummary {
  const enabled = typeof payload.enabled === "boolean" ? payload.enabled : tool.enabled;
  const approvalMode = payload.approval_mode ?? tool.approval_mode;
  return {
    ...tool,
    enabled,
    approval_mode: approvalMode,
    effective_approval_mode: approvalMode === "inherit" ? "prompt" : approvalMode,
    effective_state: enabled ? "enabled" : "disabled_persistently",
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
