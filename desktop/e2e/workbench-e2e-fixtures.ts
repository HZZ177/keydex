import { mkdir } from "node:fs/promises";
import * as path from "node:path";

import { expect, type Locator, type Page, type Route } from "@playwright/test";

const API_BASE = "http://127.0.0.1:8765";

export const APP_BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
export const EVIDENCE_ROOT =
  process.env.E2E_WORKBENCH_EVIDENCE_DIR ??
  path.resolve("..", ".dev", "e2e", "evidence", "2026-06-27-workbench-assistant-real-shell");
export const E2E_RUN_ID = process.env.E2E_RUN_ID ?? "latest";
export const WORKSPACE_A = "workspace-a";
export const WORKSPACE_B = "workspace-b";
export const SESSION_A = "e2e-session-a";
export const RICH_SESSION = "e2e-rich-workbench-session";

export interface MockBackendState {
  sessions: Record<string, E2ESession>;
  historyBySession: Record<string, AgentMessagePayload[]>;
  historyPagesBySession: Record<string, Record<string, AgentHistoryPage>>;
  toolDetailsByRef: Record<string, AgentToolDetails>;
  createdSessionPayloads: Array<Record<string, unknown>>;
  historyRequests: Array<{ sessionId: string; cursor: string | null; allTurns: string | null }>;
  workspaceSearchRequests: Array<{ workspaceId: string; query: string }>;
  workspaceReadRequests: Array<{ workspaceId: string; path: string }>;
  toolDetailsRequests: Array<{ sessionId: string; startEventId: string; endEventId: string }>;
  approvalDecisions: Array<{ approvalId: string; body: Record<string, unknown> }>;
  reversePreviewRequests: Array<{ sessionId: string; body: Record<string, unknown> }>;
  reverseExecuteRequests: Array<{ sessionId: string; body: Record<string, unknown> }>;
  workspaceFiles: Record<string, string>;
  workspaceTreeEntries: E2EWorkspaceTreeEntry[];
}

export interface E2EWorkspaceTreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number | null;
  modified_at: string | null;
}

export interface E2ESession {
  id: string;
  title: string;
  session_type: "chat" | "workspace";
  workspace_id: string | null;
  workspace: E2EWorkspace | null;
}

interface E2EWorkspace {
  id: string;
  name: string;
  root_path: string;
  archived_at: null;
}

type AgentMessagePayload = Record<string, unknown> & {
  role: string;
  content: string;
  id?: string;
  sessionId?: string;
  timestamp?: number;
};

export interface AgentHistoryPage {
  list: AgentMessagePayload[];
  next_cursor?: string | null;
  has_more_older?: boolean;
}

interface AgentToolDetails {
  detailRef?: Record<string, string>;
  runId?: string;
  toolCallId?: string | null;
  toolName?: string;
  toolParams?: unknown;
  toolResult?: string;
  toolDurationMs?: number;
  toolError?: string | null;
  status?: string;
  uiPayload?: Record<string, unknown> | null;
  fileChanges?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown> | null;
}

export function createWorkbenchBackend(
  options: {
    historyBySession?: Record<string, AgentMessagePayload[]>;
    historyPagesBySession?: Record<string, Record<string, AgentHistoryPage>>;
    toolDetailsByRef?: Record<string, AgentToolDetails>;
    workspaceFiles?: Record<string, string>;
    workspaceTreeEntries?: E2EWorkspaceTreeEntry[];
  } = {},
): MockBackendState {
  return {
    sessions: {
      [SESSION_A]: session(SESSION_A, "工作台 A 会话", WORKSPACE_A),
      [RICH_SESSION]: session(RICH_SESSION, "完整消息能力会话", WORKSPACE_A),
      [WORKSPACE_B]: session("e2e-session-b", "工作台 B 会话", WORKSPACE_B),
      "e2e-pure-chat": session("e2e-pure-chat", "纯对话", null),
    },
    historyBySession: {
      [SESSION_A]: defaultHistory(SESSION_A),
      [RICH_SESSION]: richWorkbenchHistory(RICH_SESSION),
      ...(options.historyBySession ?? {}),
    },
    historyPagesBySession: options.historyPagesBySession ?? {},
    toolDetailsByRef: {
      "tool-start:tool-end": {
        detailRef: { startEventId: "tool-start", endEventId: "tool-end" },
        runId: "run-tool-deferred",
        toolCallId: "call-tool-deferred",
        toolName: "search_text",
        toolParams: { query: "deferred", path: "README.md" },
        toolResult: "Deferred search result from tool details",
        toolDurationMs: 42,
        status: "completed",
      },
      ...(options.toolDetailsByRef ?? {}),
    },
    createdSessionPayloads: [],
    historyRequests: [],
    workspaceSearchRequests: [],
    workspaceReadRequests: [],
    toolDetailsRequests: [],
    approvalDecisions: [],
    reversePreviewRequests: [],
    reverseExecuteRequests: [],
    workspaceFiles: { ...(options.workspaceFiles ?? {}) },
    workspaceTreeEntries: options.workspaceTreeEntries ?? defaultWorkspaceTreeEntries(),
  };
}

export async function mockWorkbenchBackend(page: Page, backend: MockBackendState) {
  await page.route(`${API_BASE}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const requestPath = url.pathname;
    const method = request.method();

    if (requestPath === "/api/settings") {
      return fulfillJson(route, {
        model: {
          base_url: "https://api.example/v1",
          model: "qwen-coder",
          timeout_seconds: 60,
          api_key_set: true,
          api_key_preview: "sk-***",
        },
        command: {
          command_enabled: true,
          selected_shell: "cmd",
          shell_path: "C:/Windows/System32/cmd.exe",
          shell_label: "CMD",
          shell_edition: null,
          shell_version: null,
          shells: {
            cmd: {
              shell_path: "C:/Windows/System32/cmd.exe",
              shell_label: "CMD",
              shell_edition: null,
              shell_version: null,
            },
          },
          require_approval_for_untrusted: true,
          allow_persistent_trust: true,
          file_access_mode: "workspace_trusted",
          default_timeout_seconds: 120,
          max_timeout_seconds: 600,
          inline_output_max_chars: 12000,
          tail_max_chars: 12000,
          output_file_max_bytes: 8388608,
          progress_interval_ms: 500,
        },
      });
    }

    if (requestPath === "/api/settings/extensions") {
      return fulfillJson(route, {
        file_edit_tool_style: "claude_code",
        auto_title: {
          enabled: false,
          only_when_default_title: true,
          max_title_length: 20,
        },
        duplicate_tool_call_guard: {
          enabled: true,
          max_repeats: 3,
        },
        context_compression: {
          enabled: true,
          context_window_tokens: 256000,
          trigger_fraction: 0.8,
        },
        a2ui: {
          enabled: true,
          debug_info_enabled: false,
        },
      });
    }

    if (requestPath === "/api/models") {
      return fulfillJson(route, { models: [{ id: "qwen-coder" }, { id: "deepseek-coder" }], cached: true });
    }

    if (requestPath === "/api/model-providers" && method === "GET") {
      return fulfillJson(route, {
        providers: [
          {
            id: "provider-1",
            name: "默认模型服务",
            base_url: "https://api.example/v1",
            enabled: true,
            api_key_set: true,
            api_key_preview: "sk-***",
            models: ["qwen-coder", "deepseek-coder"],
            model_enabled: {
              "qwen-coder": true,
              "deepseek-coder": true,
            },
            health: {},
            created_at: "2026-06-27T00:00:00Z",
            updated_at: "2026-06-27T00:00:00Z",
          },
        ],
      });
    }

    if (requestPath === "/api/settings/model-defaults" && method === "GET") {
      return fulfillJson(route, {
        defaults: {
          default_chat: {
            scope: "default_chat",
            configured: true,
            provider_id: "provider-1",
            provider_name: "默认模型服务",
            model: "qwen-coder",
            provider_enabled: true,
            model_enabled: true,
            missing_reason: null,
          },
          fast: {
            scope: "fast",
            configured: false,
            provider_id: null,
            provider_name: null,
            model: null,
            provider_enabled: null,
            model_enabled: null,
            missing_reason: "not_configured",
          },
        },
      });
    }

    if (requestPath === "/api/workspaces" && method === "GET") {
      return fulfillJson(route, { list: [workspace(WORKSPACE_A, "keydex"), workspace(WORKSPACE_B, "other")], total: 2 });
    }

    if (requestPath === "/api/sessions" && method === "GET") {
      const workspaceId = url.searchParams.get("workspace_id");
      const sessionType = url.searchParams.get("session_type");
      const sessions = Object.values(backend.sessions).filter((item) => {
        if (workspaceId) {
          return item.workspace_id === workspaceId;
        }
        if (sessionType === "workspace") {
          return item.session_type === "workspace";
        }
        return true;
      });
      return fulfillJson(route, { list: sessions.map(sessionResponse), total: sessions.length, page: 1, page_size: 50 });
    }

    if (requestPath === "/api/sessions" && method === "POST") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      backend.createdSessionPayloads.push(payload);
      const created = session(
        "e2e-created-workbench-session",
        String(payload.title || "new workbench task"),
        String(payload.workspace_id || WORKSPACE_A),
      );
      backend.sessions[created.id] = created;
      backend.historyBySession[created.id] = [];
      return fulfillJson(route, { session: sessionResponse(created) });
    }

    const reversePreviewMatch = requestPath.match(/^\/api\/sessions\/([^/]+)\/reverse\/preview$/);
    if (reversePreviewMatch && method === "POST") {
      const sessionId = decodeURIComponent(reversePreviewMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      backend.reversePreviewRequests.push({ sessionId, body });
      return fulfillJson(route, reversePreviewResponse());
    }

    const reverseExecuteMatch = requestPath.match(/^\/api\/sessions\/([^/]+)\/reverse$/);
    if (reverseExecuteMatch && method === "POST") {
      const sessionId = decodeURIComponent(reverseExecuteMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      backend.reverseExecuteRequests.push({ sessionId, body });
      return fulfillJson(route, reverseResultResponse(body));
    }

    const toolDetailsMatch = requestPath.match(/^\/api\/sessions\/([^/]+)\/tool-details$/);
    if (toolDetailsMatch && method === "GET") {
      const sessionId = decodeURIComponent(toolDetailsMatch[1]);
      const startEventId = url.searchParams.get("start_event_id") ?? "";
      const endEventId = url.searchParams.get("end_event_id") ?? "";
      backend.toolDetailsRequests.push({ sessionId, startEventId, endEventId });
      const detail = backend.toolDetailsByRef[`${startEventId}:${endEventId}`];
      return fulfillJson(route, { detail: detail ?? { status: "failed", toolError: "tool detail missing" } });
    }

    const historyMatch = requestPath.match(/^\/api\/sessions\/([^/]+)\/history$/);
    if (historyMatch) {
      const sessionId = decodeURIComponent(historyMatch[1]);
      const target = backend.sessions[sessionId] ?? backend.sessions[SESSION_A];
      const cursor = url.searchParams.get("cursor");
      backend.historyRequests.push({
        sessionId,
        cursor,
        allTurns: url.searchParams.get("all_turns"),
      });
      const cursorKey = cursor ?? "__initial__";
      const page = backend.historyPagesBySession[sessionId]?.[cursorKey];
      if (page) {
        return fulfillJson(route, {
          session: sessionResponse(target),
          list: page.list,
          next_cursor: page.next_cursor ?? null,
          has_more_older: Boolean(page.has_more_older && page.next_cursor),
        });
      }
      return fulfillJson(route, {
        session: sessionResponse(target),
        list: backend.historyBySession[sessionId] ?? defaultHistory(sessionId),
        next_cursor: null,
        has_more_older: false,
      });
    }

    const sessionMatch = requestPath.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && method === "GET") {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      return fulfillJson(route, { session: sessionResponse(backend.sessions[sessionId] ?? backend.sessions[SESSION_A]) });
    }

    const sessionTasksMatch = requestPath.match(/^\/api\/sessions\/([^/]+)\/tasks$/);
    if (sessionTasksMatch && method === "GET") {
      return fulfillJson(route, { list: [] });
    }

    const sessionWorkspaceMatch = requestPath.match(/^\/api\/sessions\/([^/]+)\/workspace(\/.*)?$/);
    if (sessionWorkspaceMatch) {
      const sessionId = decodeURIComponent(sessionWorkspaceMatch[1]);
      const sessionWorkspaceId = backend.sessions[sessionId]?.workspace_id ?? WORKSPACE_A;
      const suffix = sessionWorkspaceMatch[2] ?? "";
      if (suffix === "/read/document" && method === "POST") {
        const readRequest = request.postDataJSON() as DocumentReadRequest;
        backend.workspaceReadRequests.push({ workspaceId: sessionWorkspaceId, path: readRequest.path });
        return fulfillDocumentRead(route, readRequest, workspaceFileContent(readRequest.path, backend));
      }
      if (suffix === "/tree") {
        return fulfillJson(route, {
          root: workspace(sessionWorkspaceId, sessionWorkspaceId).root_path,
          entries: backend.workspaceTreeEntries,
        });
      }
      if (suffix === "/read") {
        const filePath = url.searchParams.get("path") ?? "";
        backend.workspaceReadRequests.push({ workspaceId: sessionWorkspaceId, path: filePath });
        return fulfillJson(route, { path: filePath, content: workspaceFileContent(filePath, backend), encoding: "utf-8" });
      }
      if (suffix === "/annotations") {
        return fulfillJson(route, []);
      }
    }

    const workspaceMatch = requestPath.match(/^\/api\/workspaces\/([^/]+)(\/.*)?$/);
    if (workspaceMatch) {
      const workspaceId = decodeURIComponent(workspaceMatch[1]);
      const suffix = workspaceMatch[2] ?? "";
      if (method === "GET" && !suffix) {
        return fulfillJson(route, { workspace: workspace(workspaceId, workspaceId === WORKSPACE_A ? "keydex" : "other") });
      }
      if (suffix === "/read/document" && method === "POST") {
        const readRequest = request.postDataJSON() as DocumentReadRequest;
        backend.workspaceReadRequests.push({ workspaceId, path: readRequest.path });
        return fulfillDocumentRead(route, readRequest, workspaceFileContent(readRequest.path, backend));
      }
      if (suffix === "/tree") {
        return fulfillJson(route, {
          root: workspace(workspaceId, workspaceId).root_path,
          entries: backend.workspaceTreeEntries,
        });
      }
      if (suffix === "/read") {
        const filePath = url.searchParams.get("path") ?? "";
        backend.workspaceReadRequests.push({ workspaceId, path: filePath });
        return fulfillJson(route, { path: filePath, content: workspaceFileContent(filePath, backend), encoding: "utf-8" });
      }
      if (suffix === "/search") {
        const query = url.searchParams.get("q") ?? "";
        backend.workspaceSearchRequests.push({ workspaceId, query });
        return fulfillJson(route, [
          { name: "README.md", path: "README.md", type: "file" },
          { name: "context.md", path: "docs/context.md", type: "file" },
        ]);
      }
      if (suffix === "/skills") {
        return fulfillJson(route, {
          workspace_root: workspace(workspaceId, workspaceId).root_path,
          fingerprint: "e2e-rich",
          loaded_at: "2026-06-27T00:00:00Z",
          skills: [
            {
              name: "dev-plan",
              label: "dev-plan",
              source: "workspace",
              description: "计划拆分",
              locator: "workspace:dev-plan",
            },
          ],
          diagnostics: [],
        });
      }
      if (suffix === "/annotations") {
        return fulfillJson(route, []);
      }
    }

    const approvalMatch = requestPath.match(/^\/api\/approvals\/([^/]+)\/decision$/);
    if (approvalMatch && method === "POST") {
      const approvalId = decodeURIComponent(approvalMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      backend.approvalDecisions.push({ approvalId, body });
      return fulfillJson(route, { ...approval(approvalId), status: body.decision, decision: body.decision, trust_scope: body.trust_scope });
    }

    return fulfillJson(route, {});
  });
}

export async function installWebSocketMock(page: Page) {
  await page.addInitScript(() => {
    type MockSocket = Record<string, unknown> & {
      onopen: ((event: Event) => void) | null;
      onclose: ((event: CloseEvent) => void) | null;
      onmessage: ((event: MessageEvent) => void) | null;
      readyState: number;
    };
    const sockets: MockSocket[] = [];
    (window as Window & { __wsSentMessages?: unknown[]; __dispatchAgentEvent?: (event: unknown) => void }).__wsSentMessages = [];
    const NativeWebSocket = window.WebSocket;
    const MockWebSocket = function MockWebSocket(this: MockSocket, url: string) {
      if (!String(url).includes("/agent-base/ws/chat")) {
        return new NativeWebSocket(url);
      }
      this.url = url;
      this.readyState = MockWebSocket.CONNECTING;
      this.onopen = null;
      this.onclose = null;
      this.onerror = null;
      this.onmessage = null;
      sockets.push(this);
      window.setTimeout(() => {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }, 0);
      return this;
    } as unknown as typeof WebSocket & {
      prototype: WebSocket;
      CONNECTING: number;
      OPEN: number;
      CLOSING: number;
      CLOSED: number;
    };
    MockWebSocket.CONNECTING = 0;
    MockWebSocket.OPEN = 1;
    MockWebSocket.CLOSING = 2;
    MockWebSocket.CLOSED = 3;
    MockWebSocket.prototype.send = function send(data: string) {
      const sentMessages = (window as Window & { __wsSentMessages?: unknown[] }).__wsSentMessages ?? [];
      try {
        sentMessages.push(JSON.parse(data));
      } catch {
        sentMessages.push(data);
      }
      (window as Window & { __wsSentMessages?: unknown[] }).__wsSentMessages = sentMessages;
    };
    MockWebSocket.prototype.close = function close(this: MockSocket) {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.(new CloseEvent("close", { code: 1000 }));
    };
    (window as Window & { __dispatchAgentEvent?: (event: unknown) => void }).__dispatchAgentEvent = (event) => {
      const message = new MessageEvent("message", { data: JSON.stringify(event) });
      sockets.forEach((socket) => socket.onmessage?.(message));
    };
    Object.assign(window, { WebSocket: MockWebSocket as unknown as typeof WebSocket });
  });
}

export async function openWorkbenchComposer(page: Page): Promise<Locator> {
  const input = page.getByLabel("工作台助手输入");
  if ((await input.count()) === 0) {
    await page.getByRole("button", { name: "展开工作台输入框" }).click();
  }
  await expect(input).toBeVisible();
  return input;
}

export async function saveEvidence(page: Page, caseId: string) {
  const directory = path.join(EVIDENCE_ROOT, caseId, E2E_RUN_ID);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, "success.png"), fullPage: true });
}

export async function dispatchAgentEvent(page: Page, event: unknown) {
  await page.evaluate((payload) => {
    (window as Window & { __dispatchAgentEvent?: (event: unknown) => void }).__dispatchAgentEvent?.(payload);
  }, event);
}

export async function lastChatFrame(page: Page) {
  const handle = await page.waitForFunction(() => {
    const sentMessages = (window as Window & { __wsSentMessages?: Array<Record<string, unknown>> }).__wsSentMessages ?? [];
    return sentMessages.findLast((message) => message.action === "chat") ?? null;
  });
  return handle.jsonValue() as Promise<{ action?: string; data?: Record<string, unknown> } | null>;
}

export async function chatFrameCount(page: Page) {
  return page.evaluate(() => {
    const sentMessages = (window as Window & { __wsSentMessages?: Array<Record<string, unknown>> }).__wsSentMessages ?? [];
    return sentMessages.filter((message) => message.action === "chat").length;
  });
}

export async function selectVisibleText(page: Page, text: string) {
  await page.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      const value = current.textContent ?? "";
      const start = value.indexOf(needle);
      if (start >= 0) {
        const range = document.createRange();
        range.setStart(current, start);
        range.setEnd(current, start + needle.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }
      current = walker.nextNode();
    }
    throw new Error(`Text not found: ${needle}`);
  }, text);
}

export function approval(id: string) {
  return {
    id,
    session_id: RICH_SESSION,
    tool_name: "run_cmd",
    kind: "exec",
    title: "是否允许执行命令？",
    description: "pnpm test",
    details: {
      command: "pnpm test",
      cwd: "D:/repo/keydex",
      tool_name: "run_cmd",
      shell: "cmd",
      shell_label: "CMD",
      shell_path: "C:/Windows/System32/cmd.exe",
    },
    status: "pending",
    created_at: "2026-06-27T00:00:00Z",
  };
}

function defaultHistory(sessionId: string): AgentMessagePayload[] {
  return [
    historyMessage(sessionId, "user", "历史问题", "hist-user"),
    historyMessage(sessionId, "assistant", "历史回答", "hist-assistant"),
  ];
}

function richWorkbenchHistory(sessionId: string): AgentMessagePayload[] {
  const startedAt = 1_782_518_400_000;
  return [
    historyMessage(sessionId, "user", "", "rich-user-context", {
      timestamp: startedAt,
      contextItems: [
        {
          id: "ctx-file",
          type: "file",
          label: "README.md",
          name: "README.md",
          path: "README.md",
          fileType: "file",
          content: "File context",
        },
        {
          id: "ctx-quote",
          type: "quote",
          label: "引用片段",
          content: "Quote context preview",
        },
        {
          id: "ctx-source",
          type: "source_quote",
          label: "README.md · L3",
          path: "README.md",
          content: "Source quote context preview",
          metadata: { line_start: 3, line_end: 3 },
        },
        {
          id: "ctx-skill",
          type: "skill",
          label: "dev-plan",
          skill_name: "dev-plan",
          content: "Skill context",
          metadata: { locator: ".keydex/skills/dev-plan/SKILL.md", description: "计划拆分" },
        },
      ],
    }),
    historyMessage(sessionId, "assistant", richMarkdown(), "rich-assistant", { timestamp: startedAt + 1 }),
    historyMessage(sessionId, "reasoning", "正在分析 Workbench 复用链路", "rich-thinking", {
      timestamp: startedAt + 2,
      reasoningKind: "thinking",
      status: "completed",
    }),
    historyMessage(sessionId, "subagent", "子任务完成：检查消息组件", "rich-subagent", {
      timestamp: startedAt + 3,
      subagentName: "reviewer",
      subagentTask: "检查消息组件",
      subagentItems: [{ id: "sub-text-1", type: "text", content: "子任务摘要", timestamp: startedAt + 3 }],
    }),
    historyMessage(sessionId, "tool", "", "rich-tool-deferred", {
      timestamp: startedAt + 4,
      toolName: "search_text",
      toolParams: { query: "deferred" },
      toolResult: "",
      toolDurationMs: 12,
      toolDetailsDeferred: true,
      toolDetailRef: {
        startEventId: "tool-start",
        endEventId: "tool-end",
        runId: "run-tool-deferred",
        toolCallId: "call-tool-deferred",
      },
      runId: "run-tool-deferred",
      toolCallId: "call-tool-deferred",
      status: "completed",
    }),
    historyMessage(sessionId, "tool", "", "rich-command", {
      timestamp: startedAt + 5,
      toolName: "run_cmd",
      toolParams: { command: "pnpm test", cwd: "D:/repo/keydex" },
      toolResult: "stdout ok",
      toolDurationMs: 180,
      status: "completed",
      uiPayload: {
        kind: "command_result",
        command_id: "cmd-rich",
        tool: "run_cmd",
        shell: "cmd",
        shell_label: "CMD",
        shell_path: "C:/Windows/System32/cmd.exe",
        command: "pnpm test",
        cwd: "D:/repo/keydex",
        status: "completed",
        stdout: "stdout ok",
        stderr: "",
        exit_code: 0,
        duration_ms: 180,
      },
    }),
    historyMessage(sessionId, "tool", "README.md", "rich-file-change", {
      timestamp: startedAt + 6,
      toolName: "apply_patch",
      toolParams: { path: "README.md" },
      toolResult: "patched",
      status: "completed",
      fileChanges: [
        {
          path: "README.md",
          operation: "update",
          added_lines: 2,
          deleted_lines: 1,
          diff: "--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n-old\n+new\n+added",
        },
      ],
    }),
    historyMessage(sessionId, "tool", "", "rich-skill", {
      timestamp: startedAt + 7,
      toolName: "load_skill",
      toolParams: { skill_name: "dev-plan", resource_path: "SKILL.md" },
      toolResult: JSON.stringify({
        skill_name: "dev-plan",
        resource_path: "SKILL.md",
        skill_root: ".keydex/skills/dev-plan",
        loaded: true,
      }),
      status: "completed",
    }),
    historyMessage(sessionId, "approval", "是否允许执行命令？", "rich-approval", {
      timestamp: startedAt + 8,
      approval: { ...approval("approval-history"), status: "approved" },
      status: "approved",
    }),
    historyMessage(sessionId, "error", "Error code: 429 - {'error': {'message': 'rate limit exceeded dimension: rpm', 'code': 'rate_limit'}}", "rich-error", {
      timestamp: startedAt + 9,
      status: "error",
    }),
    historyMessage(sessionId, "assistant", visibleCodeMarkdown(), "rich-code-visible", { timestamp: startedAt + 10 }),
    historyMessage(sessionId, "tool", "", "rich-plan", {
      timestamp: startedAt + 11,
      toolName: "update_plan",
      status: "completed",
      uiPayload: {
        explanation: "Workbench E2E plan",
        entries: [
          { content: "Prepare workbench shell", status: "completed" },
          { content: "E2E plan accessory", status: "in_progress" },
        ],
      },
    }),
  ];
}

function historyMessage(
  sessionId: string,
  role: string,
  content: string,
  id: string,
  patch: Record<string, unknown> = {},
): AgentMessagePayload {
  return {
    id,
    sessionId,
    role,
    content,
    timestamp: 1_782_518_400_000,
    ...patch,
  };
}

function richMarkdown(): string {
  const sections = Array.from({ length: 90 }, (_, index) =>
    [
      `## Rich Markdown Section ${index + 1}`,
      "",
      `Virtual markdown line ${index + 1}.`,
      "",
      "| Key | Value |",
      "| --- | --- |",
      `| row-${index + 1} | value-${index + 1} |`,
    ].join("\n"),
  );
  return [
    "# Workbench Shared Markdown",
    "",
    "- 列表项 A",
    "- 列表项 B",
    "",
    "![relative image](README.md)",
    "",
    "```ts",
    "const sharedPanel = true;",
    "console.log(sharedPanel);",
    "```",
    "",
    "```json",
    "{\"name\":\"workbench\",\"enabled\":true}",
    "```",
    "",
    "```html",
    "<section><h1>HTML Preview</h1></section>",
    "```",
    "",
    "```mermaid",
    "graph TD",
    "  A[Workbench] --> B[Agent Panel]",
    "```",
    "",
    "$$x^2 + y^2 = z^2$$",
    "",
    ...sections,
  ].join("\n");
}

function visibleCodeMarkdown(): string {
  return [
    "## Visible Code Preview Anchor",
    "",
    "```ts",
    "const visibleWorkbenchCode = true;",
    "console.log(visibleWorkbenchCode);",
    "```",
    "",
    "```html",
    "<section><h1>HTML Preview</h1></section>",
    "```",
    "",
    "```mermaid",
    "graph TD",
    "  A[Workbench] --> B[Agent Panel]",
    "```",
  ].join("\n");
}

function workspaceFileContent(filePath: string, backend?: MockBackendState): string {
  if (backend && Object.prototype.hasOwnProperty.call(backend.workspaceFiles, filePath)) {
    return backend.workspaceFiles[filePath] ?? "";
  }
  if (filePath.endsWith("SKILL.md")) {
    return "# dev-plan\n\n用于计划拆分。";
  }
  if (filePath === "docs/context.md") {
    return "# Context\n\ncontext file content";
  }
  return "# README\n\nE2E Workbench File\n\nSource quote context preview";
}

function defaultWorkspaceTreeEntries(): E2EWorkspaceTreeEntry[] {
  return [
    { name: "README.md", path: "README.md", type: "file", size: 1024, modified_at: null },
    { name: "context.md", path: "docs/context.md", type: "file", size: 512, modified_at: null },
    { name: "src", path: "src", type: "directory", size: null, modified_at: null },
  ];
}

function reversePreviewResponse() {
  const rawPatch = [
    "diff --git a/src/reverse.ts b/src/reverse.ts",
    "--- a/src/reverse.ts",
    "+++ b/src/reverse.ts",
    "@@ -1 +1 @@",
    "-current",
    "+target",
    "",
  ].join("\n");
  return {
    operation_id: "e2e-reverse-operation",
    source: { message_event_id: "e2e-reverse-event" },
    conversation_available: true,
    code_available: true,
    default_mode: "both",
    snapshot_id: "e2e-reverse-snapshot",
    preview_token: "e2e-reverse-token",
    files: [
      {
        resource_id: "workspace-a:src/reverse.ts",
        scope_kind: "workspace",
        scope_identity: WORKSPACE_A,
        scope_label: "当前项目",
        display_path: "src/reverse.ts",
        absolute_path: "D:/repo/keydex/src/reverse.ts",
        requires_full_access: false,
        path: "src/reverse.ts",
        current_state: "file",
        target_state: "file",
        classification: "ready",
        binary: false,
        truncated: false,
        insertions: 1,
        deletions: 1,
        diff: rawPatch,
        raw_patch: rawPatch,
        status: "modified",
        content_kind: "text",
        truncation_state: "complete",
        can_load_more: false,
        patch_direction: "current_to_target",
        patch_precision: "exact",
        patch_complete: true,
      },
    ],
    insertions: 1,
    deletions: 1,
    warnings: [],
    requires_external_confirmation: false,
    external_paths: [],
  };
}

function reverseResultResponse(body: Record<string, unknown>) {
  return {
    operation_id: "e2e-reverse-operation",
    status: "full",
    mode: body.mode ?? "both",
    decision: body.decision ?? "full",
    conversation_rewound: body.mode !== "code",
    restored_files: ["src/reverse.ts"],
    skipped_files: [],
    forced_files: [],
    failed_files: [],
    restored_input: "请恢复到稳定版本",
    source: { message_event_id: body.message_event_id ?? "e2e-reverse-event" },
    error_code: null,
  };
}

function workspace(id: string, name: string): E2EWorkspace {
  return {
    id,
    name,
    root_path: `D:/repo/${name}`,
    archived_at: null,
  };
}

function session(id: string, title: string, workspaceId: string | null): E2ESession {
  return {
    id,
    title,
    session_type: workspaceId ? "workspace" : "chat",
    workspace_id: workspaceId,
    workspace: workspaceId ? workspace(workspaceId, workspaceId === WORKSPACE_A ? "keydex" : "other") : null,
  };
}

function sessionResponse(item: E2ESession) {
  return {
    id: item.id,
    user_id: "local-user",
    scene_id: "desktop-agent",
    status: "active",
    title: item.title,
    session_tag: "chat",
    session_type: item.session_type,
    workspace_id: item.workspace_id,
    cwd: item.workspace?.root_path ?? null,
    workspace_roots: item.workspace ? [item.workspace.root_path] : [],
    workspace: item.workspace,
    active_session_id: null,
    parent_session_id: null,
    child_session_id: null,
    source_trace_id: null,
    created_at: "2026-06-27T00:00:00Z",
    updated_at: "2026-06-27T00:00:00Z",
    is_debug: false,
    is_scheduled: false,
    is_current: false,
  };
}

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

interface DocumentReadRequest {
  protocol_version: "document-read/v1";
  request_id: string;
  document_id: string;
  source: string;
  path: string;
}

function fulfillDocumentRead(route: Route, request: DocumentReadRequest, content: string) {
  const revision = `sha256:e2e-${request.path.replaceAll(/[^a-z0-9]/giu, "-")}-${content.length}`;
  const totalBytes = new TextEncoder().encode(content).byteLength;
  const messages = [
    {
      protocol_version: "document-read/v1",
      type: "start",
      request_id: request.request_id,
      document_id: request.document_id,
      source: request.source,
      path: request.path,
      revision,
      encoding: "utf-8",
      transport: "whole",
      total_bytes: totalBytes,
      chunk_size_bytes: Math.max(1, totalBytes),
      chunk_count: 1,
    },
    {
      protocol_version: "document-read/v1",
      type: "chunk",
      request_id: request.request_id,
      document_id: request.document_id,
      revision,
      chunk_index: 0,
      offset_bytes: 0,
      byte_length: totalBytes,
      content,
    },
    {
      protocol_version: "document-read/v1",
      type: "complete",
      request_id: request.request_id,
      document_id: request.document_id,
      revision,
      total_bytes: totalBytes,
      chunk_count: 1,
    },
  ];
  return route.fulfill({
    status: 200,
    contentType: "application/x-ndjson",
    body: messages.map((message) => JSON.stringify(message)).join("\n"),
  });
}
