import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SettingsShell } from "@/renderer/pages/settings/SettingsShell";
import {
  selectAgentMessages,
  selectAgentSessionState,
} from "@/renderer/stores/agentSessionStore";

import {
  MCP_FRONTEND_COVERAGE_INDEX,
  MCP_FRONTEND_VITEST_COMMANDS,
  createMcpAgentStoreState,
  createMcpRuntimeMock,
  mcpApprovalRequestedEvent,
  mcpRuntimeSnapshotEvent,
  mcpToolStartEvent,
  renderWithMcpRouter,
} from "./helpers/mcpTestHarness";

describe("MCP frontend test harness", () => {
  it("documents the per-surface frontend coverage ownership", () => {
    expect(MCP_FRONTEND_COVERAGE_INDEX.console).toMatchObject({
      issue: "MCP-077",
      e2e: "MCP-097",
      tests: ["desktop/tests/mcp-console-page.spec.tsx"],
    });
    expect(MCP_FRONTEND_COVERAGE_INDEX.runtimePanel).toMatchObject({
      issue: "MCP-076",
      e2e: "MCP-096",
      tests: ["desktop/tests/mcp-runtime-panel.spec.tsx"],
    });
    expect(MCP_FRONTEND_COVERAGE_INDEX.approvalCard).toMatchObject({
      issue: "MCP-071",
      e2e: "MCP-091",
      tests: ["desktop/tests/approval-prompt.spec.tsx"],
    });
    expect(MCP_FRONTEND_COVERAGE_INDEX.elicitation).toMatchObject({
      issue: "MCP-073",
      e2e: "MCP-093",
      tests: ["desktop/tests/mcp-elicitation-prompt.spec.tsx", "desktop/tests/agent-session-store.spec.ts"],
    });
    expect(MCP_FRONTEND_COVERAGE_INDEX.sampling).toMatchObject({
      issue: "MCP-074",
      e2e: "MCP-094",
      tests: ["desktop/tests/mcp-console-page.spec.tsx", "desktop/tests/approval-prompt.spec.tsx"],
    });
    expect(MCP_FRONTEND_COVERAGE_INDEX.logs).toMatchObject({
      issue: "MCP-078",
      e2e: "MCP-098",
      tests: ["desktop/tests/mcp-console-page.spec.tsx"],
    });
    expect(MCP_FRONTEND_VITEST_COMMANDS).toEqual(
      expect.arrayContaining([
        "pnpm --dir desktop exec vitest run desktop/tests/mcp-console-page.spec.tsx",
        "pnpm --dir desktop exec vitest run desktop/tests/mcp-runtime-panel.spec.tsx",
        "pnpm --dir desktop exec vitest run desktop/tests/approval-prompt.spec.tsx",
        "pnpm --dir desktop exec vitest run desktop/tests/mcp-elicitation-prompt.spec.tsx",
        "pnpm --dir desktop exec vitest run desktop/tests/agent-session-store.spec.ts",
      ]),
    );
  });

  it("provides success, loading, and error MCP runtime mocks", async () => {
    const success = createMcpRuntimeMock();

    await expect(success.mcp.listServers({ limit: 500 })).resolves.toMatchObject({
      total: 1,
      list: [{ id: "srv_1", name: "Filesystem MCP", status: "online" }],
    });
    await expect(success.mcp.getRuntimeStatus("sess_1")).resolves.toMatchObject({
      session_id: "sess_1",
      manager: { started: true },
      summary: { servers_total: 1, tools_enabled: 1 },
    });
    expect(success.mcp.listServers).toHaveBeenCalledWith({ limit: 500 });

    const loading = createMcpRuntimeMock({ mode: "loading" });
    let loadingSettled = false;
    const pending = loading.mcp.listServers().then(
      () => {
        loadingSettled = true;
      },
      () => {
        loadingSettled = true;
      },
    );
    await Promise.resolve();
    expect(loadingSettled).toBe(false);
    void pending;

    const error = new Error("mcp unavailable");
    const failing = createMcpRuntimeMock({ mode: "error", error });
    await expect(failing.mcp.listServers()).rejects.toThrow("mcp unavailable");
    await expect(failing.mcp.getServer("srv_1")).rejects.toThrow("mcp unavailable");
  });

  it("injects MCP tool, approval, and runtime protocol events into an agent session state", () => {
    const state = createMcpAgentStoreState([
      mcpToolStartEvent(),
      mcpApprovalRequestedEvent(),
      mcpRuntimeSnapshotEvent(),
    ]);
    const messages = selectAgentMessages(state, "sess_1");

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          runId: "run_mcp",
          toolName: "mcp__srv_1__read_file",
          metadata: expect.objectContaining({
            mcp: expect.objectContaining({
              kind: "mcp_tool",
              server_id: "srv_1",
              raw_tool_name: "read_file",
              model_tool_name: "mcp__srv_1__read_file",
            }),
          }),
        }),
        expect.objectContaining({
          role: "approval",
          approval: expect.objectContaining({
            id: "approval_mcp",
            kind: "mcp_tool_call",
            server_id: "srv_1",
            raw_tool_name: "read_file",
          }),
        }),
      ]),
    );
    expect(selectAgentSessionState(state, "sess_1")).toMatchObject({
      runtimeState: "waiting_approval",
      pendingApproval: expect.objectContaining({
        id: "approval_mcp",
        metadata: expect.objectContaining({
          mcp: expect.objectContaining({
            kind: "mcp_tool",
            approval_mode: "prompt",
          }),
        }),
      }),
    });
  });

  it("mounts MCP settings content inside the shared settings shell", () => {
    renderWithMcpRouter(
      <SettingsShell activeSection="mcp">
        <div data-testid="mcp-harness-content">MCP settings content</div>
      </SettingsShell>,
    );

    expect(screen.getByTestId("settings-shell")).not.toBeNull();
    expect(screen.getByRole("button", { name: "MCP服务器" }).getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("mcp-harness-content").textContent).toBe("MCP settings content");
  });
});
