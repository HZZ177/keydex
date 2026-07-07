import { describe, expect, it, vi } from "vitest";

import { createRuntimeBridge } from "@/runtime/bridge";
import { createMcpRuntime } from "@/runtime/mcp";
import type { HttpClient } from "@/runtime/httpClient";

describe("McpRuntime", () => {
  it("is exposed on RuntimeBridge", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const runtime = createRuntimeBridge({ baseUrl: "http://127.0.0.1:8765", fetcher });

    await runtime.mcp.getServer("srv 1");

    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:8765/api/mcp/servers/srv%201", {
      method: "GET",
      headers: {},
      body: undefined,
    });
  });

  it("routes server, tool and runtime calls through MCP API paths", async () => {
    const request = vi.fn(async () => ({}));
    const runtime = createMcpRuntime({ request } as unknown as HttpClient);

    await runtime.listServers({ enabled: true, transport: "stdio", limit: 20, offset: 5 });
    await runtime.createServer({ name: "filesystem", transport: "stdio", command: "node" });
    await runtime.updateServer("srv 1", { enabled: false });
    await runtime.deleteServer("srv 1");
    await runtime.testServer("srv 1");
    await runtime.testServerConfig({
      server: { name: "draft", transport: "streamable_http", url: "https://mcp.example.test/mcp" },
      base_server_id: null,
    });
    await runtime.refreshServer("srv 1");
    await runtime.refreshServers();
    await runtime.listTools("srv 1", { enabled: false, search: "write" });
    await runtime.updateToolPolicy("srv 1", "tool/a", { enabled: false, approval_mode: "prompt" });
    await runtime.applyToolBulkPolicy("srv 1", {
      action: "disable_selected",
      raw_tool_names: ["write_file"],
    });
    await runtime.getRuntimeStatus("session 1");
    await runtime.setSessionToolOverride("session 1", "tool/a", {
      enabled: false,
      server_id: "srv 1",
      reason: "paused",
    });
    await runtime.clearSessionToolOverride("session 1", "tool/a", "srv 1");
    await runtime.cancelRuntimeCall("call 1");

    expect(request).toHaveBeenNthCalledWith(
      1,
      "/api/mcp/servers?enabled=true&transport=stdio&limit=20&offset=5",
    );
    expect(request).toHaveBeenNthCalledWith(2, "/api/mcp/servers", {
      method: "POST",
      body: { name: "filesystem", transport: "stdio", command: "node" },
    });
    expect(request).toHaveBeenNthCalledWith(3, "/api/mcp/servers/srv%201", {
      method: "PATCH",
      body: { enabled: false },
    });
    expect(request).toHaveBeenNthCalledWith(4, "/api/mcp/servers/srv%201", {
      method: "DELETE",
    });
    expect(request).toHaveBeenNthCalledWith(5, "/api/mcp/servers/srv%201/test", {
      method: "POST",
    });
    expect(request).toHaveBeenNthCalledWith(6, "/api/mcp/servers/test", {
      method: "POST",
      body: {
        server: { name: "draft", transport: "streamable_http", url: "https://mcp.example.test/mcp" },
        base_server_id: null,
      },
    });
    expect(request).toHaveBeenNthCalledWith(7, "/api/mcp/servers/srv%201/refresh", {
      method: "POST",
    });
    expect(request).toHaveBeenNthCalledWith(8, "/api/mcp/servers/refresh", {
      method: "POST",
    });
    expect(request).toHaveBeenNthCalledWith(
      9,
      "/api/mcp/servers/srv%201/tools?enabled=false&search=write",
    );
    expect(request).toHaveBeenNthCalledWith(10, "/api/mcp/servers/srv%201/tools/tool%2Fa/policy", {
      method: "PATCH",
      body: { enabled: false, approval_mode: "prompt" },
    });
    expect(request).toHaveBeenNthCalledWith(11, "/api/mcp/servers/srv%201/tools/bulk-policy", {
      method: "POST",
      body: { action: "disable_selected", raw_tool_names: ["write_file"] },
    });
    expect(request).toHaveBeenNthCalledWith(12, "/api/mcp/runtime/status?session_id=session+1");
    expect(request).toHaveBeenNthCalledWith(
      13,
      "/api/mcp/runtime/sessions/session%201/tools/tool%2Fa/override",
      {
        method: "PUT",
        body: { enabled: false, server_id: "srv 1", reason: "paused" },
      },
    );
    expect(request).toHaveBeenNthCalledWith(
      14,
      "/api/mcp/runtime/sessions/session%201/tools/tool%2Fa/override?server_id=srv+1",
      { method: "DELETE" },
    );
    expect(request).toHaveBeenNthCalledWith(15, "/api/mcp/runtime/calls/call%201/cancel", {
      method: "POST",
    });
  });

  it("routes import, export, approval, oauth, trust and audit calls", async () => {
    const request = vi.fn(async () => ({}));
    const runtime = createMcpRuntime({ request } as unknown as HttpClient);

    await runtime.importConfig({
      source_type: "codex",
      config: { mcp_servers: {} },
      conflict_strategy: "rename",
    });
    await runtime.exportConfig({ include_trust_rules: true });
    await runtime.resolveApproval("approval 1", {
      decision: "approved",
      trust_scope: "persistent_tool",
      user_id: "user-a",
    });
    await runtime.startOAuth("srv 1", { redirect_uri: "http://localhost/callback" });
    await runtime.completeOAuth("srv 1", { state: "state-a", code: "code-a" });
    await runtime.getOAuthStatus("srv 1");
    await runtime.clearOAuth("srv 1");
    await runtime.listAudit({ server_id: "srv 1", event_type: "refresh.completed", status: "ok" });
    await runtime.listTrustRules({ server_id: "srv 1", scope: "global" });
    await runtime.createTrustRule({
      rule_kind: "tool",
      scope: "global",
      approval_mode: "approve",
      server_id: "srv 1",
      raw_tool_name: "search",
    });
    await runtime.deleteTrustRule("trust 1");

    expect(request).toHaveBeenNthCalledWith(1, "/api/mcp/import", {
      method: "POST",
      body: { source_type: "codex", config: { mcp_servers: {} }, conflict_strategy: "rename" },
    });
    expect(request).toHaveBeenNthCalledWith(2, "/api/mcp/export", {
      method: "POST",
      body: { include_trust_rules: true },
    });
    expect(request).toHaveBeenNthCalledWith(3, "/api/mcp/approvals/approval%201/decision", {
      method: "POST",
      body: { decision: "approved", trust_scope: "persistent_tool", user_id: "user-a" },
    });
    expect(request).toHaveBeenNthCalledWith(4, "/api/mcp/servers/srv%201/oauth/start", {
      method: "POST",
      body: { redirect_uri: "http://localhost/callback" },
    });
    expect(request).toHaveBeenNthCalledWith(5, "/api/mcp/servers/srv%201/oauth/callback", {
      method: "POST",
      body: { state: "state-a", code: "code-a" },
    });
    expect(request).toHaveBeenNthCalledWith(6, "/api/mcp/servers/srv%201/oauth/status");
    expect(request).toHaveBeenNthCalledWith(7, "/api/mcp/servers/srv%201/oauth", {
      method: "DELETE",
    });
    expect(request).toHaveBeenNthCalledWith(
      8,
      "/api/mcp/audit?server_id=srv+1&event_type=refresh.completed&status=ok",
    );
    expect(request).toHaveBeenNthCalledWith(9, "/api/mcp/trust-rules?server_id=srv+1&scope=global");
    expect(request).toHaveBeenNthCalledWith(10, "/api/mcp/trust-rules", {
      method: "POST",
      body: {
        rule_kind: "tool",
        scope: "global",
        approval_mode: "approve",
        server_id: "srv 1",
        raw_tool_name: "search",
      },
    });
    expect(request).toHaveBeenNthCalledWith(11, "/api/mcp/trust-rules/trust%201", {
      method: "DELETE",
    });
  });
});
