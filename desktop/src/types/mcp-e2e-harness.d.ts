declare module "*.mjs" {
  export interface McpE2EContextOptions {
    runId?: string;
    issueId?: string;
    feature?: string;
    scenario?: string;
    dataPrefix?: string;
    serverName?: string;
  }

  export interface McpE2EContext {
    runId: string;
    issueId: string;
    feature: string;
    scenario: string;
    dataPrefix: string;
    serverName: string;
  }

  export interface McpE2EEnvironmentOptions {
    backendUrl?: string;
    frontendUrl?: string;
    dataPrefix?: string;
  }

  export interface McpE2EEnvironment {
    backendUrl: string;
    frontendUrl: string;
    dataPrefix: string;
  }

  export interface McpCleanupRecord {
    id: string;
    name: string;
  }

  export const MCP_E2E_DATA_PREFIX: string;
  export const MCP_E2E_EVIDENCE_DIR: string;
  export const MCP_E2E_RESULTS_COLUMNS: string[];

  export function createMcpE2EContext(options?: McpE2EContextOptions): McpE2EContext;
  export function validateMcpE2EEnvironment(options?: McpE2EEnvironmentOptions): McpE2EEnvironment;
  export function selectMcpRecordsForCleanup(records: McpCleanupRecord[], prefix: string): McpCleanupRecord[];
}
