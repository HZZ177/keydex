import { describe, expect, it } from "vitest";

const harness = await import("../../.dev/e2e/mcp-e2e-harness.mjs");

describe("MCP E2E harness contracts", () => {
  it("creates prefixed MCP test context without real user data names", () => {
    const context = harness.createMcpE2EContext({
      runId: "contract",
      issueId: "MCP-080",
      feature: "F20",
      scenario: "mcp-harness-contract",
    });

    expect(context.dataPrefix).toBe("E2E_MCP_contract_");
    expect(context.serverName).toBe("E2E_MCP_contract_Mock Server");
    expect(context.issueId).toBe("MCP-080");
    expect(context.feature).toBe("F20");
  });

  it("validates backend and frontend URLs as HTTP endpoints", () => {
    expect(
      harness.validateMcpE2EEnvironment({
        backendUrl: "http://127.0.0.1:8765",
        frontendUrl: "http://127.0.0.1:5173",
        dataPrefix: "E2E_MCP_contract_",
      }),
    ).toEqual({
      backendUrl: "http://127.0.0.1:8765",
      frontendUrl: "http://127.0.0.1:5173",
      dataPrefix: "E2E_MCP_contract_",
    });

    expect(() =>
      harness.validateMcpE2EEnvironment({
        backendUrl: "file:///tmp/keydex",
        frontendUrl: "http://127.0.0.1:5173",
        dataPrefix: "E2E_MCP_contract_",
      }),
    ).toThrow("E2E backend url must be HTTP(S)");
  });

  it("selects only E2E-prefixed MCP records for cleanup", () => {
    const selected = harness.selectMcpRecordsForCleanup(
      [
        { id: "srv_user", name: "User MCP Server" },
        { id: "srv_this_run", name: "E2E_MCP_contract_Server" },
        { id: "srv_other_run", name: "E2E_MCP_other_Server" },
      ],
      "E2E_MCP_contract_",
    );

    expect(selected).toEqual([
      { id: "srv_this_run", name: "E2E_MCP_contract_Server" },
    ]);
    expect(() =>
      harness.selectMcpRecordsForCleanup(
        [{ id: "srv_user", name: "User MCP Server" }],
        "User",
      ),
    ).toThrow("Unsafe MCP E2E cleanup prefix");
  });

  it("defines the stable MCP E2E CSV result columns", () => {
    expect(harness.MCP_E2E_RESULTS_COLUMNS).toEqual([
      "issue_id",
      "feature",
      "scenario",
      "status",
      "started_at",
      "completed_at",
      "evidence_report",
      "primary_screenshot",
      "failure_screenshot",
      "notes",
    ]);
  });
});
