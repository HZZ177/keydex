import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE = "http://127.0.0.1:8765";
const APP_BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_ROOT =
  process.env.E2E_COMMAND_APPROVAL_EVIDENCE_DIR ??
  path.resolve(__dirname, "../../.dev/e2e/evidence/2026-06-24_14-41-50-command-approval-config");

test("command configuration page saves settings and manages trusted rules", async ({ page }) => {
  const backend = createMockBackend();
  await installWebSocketMock(page);
  await mockBackend(page, backend);

  await page.goto(`${APP_BASE}/#/settings/config`);

  await expect(page.getByTestId("config-settings-page")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "批准策略" })).toBeVisible();
  await expect(page.getByRole("button", { name: "批准策略：按请求" })).toBeVisible();
  await expect(page.getByText("未信任命令执行前需要确认，可在审批时保存信任规则。")).toBeVisible();
  await expect(page.getByText("pnpm test").first()).toBeVisible();
  await expect(page.getByText("已允许")).toBeVisible();
  await expect(page.getByText("第 1 / 2 页，共 31 条")).toBeVisible();

  await page.getByRole("button", { name: "下一页审批记录" }).click();
  await expect(page.getByText("npm run build")).toBeVisible();
  await expect(page.getByText("第 2 / 2 页，共 31 条")).toBeVisible();
  await page.getByRole("button", { name: "上一页审批记录" }).click();
  await expect(page.getByText("pnpm test").first()).toBeVisible();

  await page.getByRole("button", { name: "批准策略：按请求" }).click();
  await expect(page.getByRole("option", { name: /按请求/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /无条件信任/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /关闭命令行工具/ })).toBeVisible();
  await page.getByRole("option", { name: /关闭命令行工具/ }).click();

  await expect(page.getByText("批准策略已保存")).toBeVisible();
  expect(backend.lastCommandSettings).toMatchObject({
    command_enabled: false,
    require_approval_for_untrusted: true,
    allow_persistent_trust: false,
  });

  await page.getByRole("button", { name: "禁用" }).click();
  await expect(page.getByRole("button", { name: "启用" })).toBeVisible();
  expect(backend.rules[0].enabled).toBe(false);

  await page.getByRole("button", { name: "删除 pnpm test" }).click();
  await expect(page.getByText("暂无已信任命令")).toBeVisible();
  expect(backend.rules).toHaveLength(0);

  await saveEvidence(page, "e2e-001-config");
});

test("approval card submits allow once, exact trust, prefix trust and reject decisions", async ({ page }) => {
  const backend = createMockBackend();
  await installWebSocketMock(page);
  await mockBackend(page, backend);

  await page.goto(`${APP_BASE}/#/conversation/session-approval`);
  await expect(sessionRow(page)).toBeVisible();
  await waitForConversationReady(page);

  await dispatchApproval(page, approval("approval-once"));
  await expect(page.getByTestId("composer-approval-card")).toBeVisible();
  await expect(sessionRow(page).getByText("等待批准")).toBeVisible();
  await page.getByRole("button", { name: "是，仅允许本次" }).click();
  await expect(page.getByLabel("继续输入")).toBeVisible();
  expect(backend.decisions.at(-1)).toMatchObject({
    approvalId: "approval-once",
    body: { decision: "approved", trust_scope: "once" },
  });

  await dispatchApproval(page, approval("approval-exact"));
  await page.getByRole("button", { name: "是，且以后相同命令不再询问" }).click();
  await expect(page.getByLabel("继续输入")).toBeVisible();
  expect(backend.decisions.at(-1)).toMatchObject({
    approvalId: "approval-exact",
    body: { decision: "approved", trust_scope: "persistent", rule_match_type: "exact" },
  });

  await dispatchApproval(page, approval("approval-prefix"));
  await page.getByRole("button", { name: "是，且以后以该前缀开头的命令不再询问" }).click();
  await expect(page.getByLabel("继续输入")).toBeVisible();
  expect(backend.decisions.at(-1)).toMatchObject({
    approvalId: "approval-prefix",
    body: { decision: "approved", trust_scope: "persistent", rule_match_type: "prefix" },
  });

  await dispatchApproval(page, approval("approval-reject"));
  await page.getByPlaceholder("告诉 agent 如何调整").fill("请改成只读命令");
  await page.getByRole("button", { name: "否，请告知 agent 如何调整" }).click();
  await expect(page.getByLabel("继续输入")).toBeVisible();
  expect(backend.decisions.at(-1)).toMatchObject({
    approvalId: "approval-reject",
    body: { decision: "rejected", trust_scope: "once", reject_message: "请改成只读命令" },
  });

  await saveEvidence(page, "e2e-002-approval-decisions");
});

test("command configuration page previews and saves unconditional trust policy", async ({ page }) => {
  const backend = createMockBackend();
  await installWebSocketMock(page);
  await mockBackend(page, backend);

  await page.goto(`${APP_BASE}/#/settings/config`);
  await expect(page.getByTestId("config-settings-page")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "批准策略：按请求" }).click();
  await expect(page.getByRole("option", { name: /无条件信任/ })).toBeVisible();
  await expect(page.getByText("命令行工具直接执行，不弹出审批。")).toBeVisible();
  await page.getByRole("option", { name: /无条件信任/ }).click();

  await expect(page.getByText("批准策略已保存")).toBeVisible();
  await expect(page.getByRole("button", { name: "批准策略：无条件信任" })).toBeVisible();
  await expect(page.getByText("智能体调用命令行工具时会直接执行命令。当前没有沙盒隔离，只适合你完全信任当前任务时使用。")).toBeVisible();
  expect(backend.lastCommandSettings).toMatchObject({
    command_enabled: true,
    require_approval_for_untrusted: false,
    allow_persistent_trust: false,
  });

  await saveEvidence(page, "e2e-003-config-effect");
});

function sessionRow(page: Page) {
  return page.getByRole("button", { name: "待审批会话", exact: true });
}

async function waitForConversationReady(page: Page) {
  await expect(page.getByLabel("继续输入")).toBeVisible();
}

interface MockBackendState {
  commandSettings: Record<string, unknown>;
  lastCommandSettings: Record<string, unknown> | null;
  rules: Array<Record<string, unknown>>;
  decisions: Array<{ approvalId: string; body: Record<string, unknown> }>;
}

function createMockBackend(): MockBackendState {
  return {
    commandSettings: {
      command_enabled: true,
      require_approval_for_untrusted: true,
      allow_persistent_trust: true,
      default_timeout_seconds: 120,
      max_timeout_seconds: 600,
      max_output_chars: 65536,
    },
    lastCommandSettings: null,
    rules: [trustedRule()],
    decisions: [],
  };
}

async function mockBackend(page: Page, state: MockBackendState) {
  await page.route(`${API_BASE}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/api/health") {
      return fulfillJson(route, { status: "ok", version: "0.1.0" });
    }

    if (url.pathname === "/api/settings" && method === "GET") {
      return fulfillJson(route, settingsResponse(state.commandSettings));
    }

    if (url.pathname === "/api/settings" && method === "PUT") {
      const body = request.postDataJSON() as { command?: Record<string, unknown> };
      if (body.command) {
        state.commandSettings = { ...state.commandSettings, ...body.command };
        state.lastCommandSettings = state.commandSettings;
      }
      return fulfillJson(route, settingsResponse(state.commandSettings));
    }

    if (url.pathname === "/api/settings/command/trusted-rules" && method === "GET") {
      return fulfillJson(route, { list: state.rules, total: state.rules.length });
    }

    if (url.pathname.startsWith("/api/settings/command/trusted-rules/") && method === "PATCH") {
      const ruleId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const body = request.postDataJSON() as { enabled?: boolean };
      state.rules = state.rules.map((rule) => (rule.id === ruleId ? { ...rule, enabled: Boolean(body.enabled) } : rule));
      return fulfillJson(route, state.rules.find((rule) => rule.id === ruleId) ?? {});
    }

    if (url.pathname.startsWith("/api/settings/command/trusted-rules/") && method === "DELETE") {
      const ruleId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      state.rules = state.rules.filter((rule) => rule.id !== ruleId);
      return fulfillJson(route, { deleted: true });
    }

    if (url.pathname === "/api/settings/command/approval-history") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const pageSize = Number(url.searchParams.get("page_size") ?? "30");
      return fulfillJson(route, {
        list: [approvalHistory(page)],
        total: 31,
        page,
        page_size: pageSize,
      });
    }

    if (url.pathname.startsWith("/api/approvals/") && url.pathname.endsWith("/decision") && method === "POST") {
      const parts = url.pathname.split("/");
      const approvalId = decodeURIComponent(parts[3] ?? "");
      const body = request.postDataJSON() as Record<string, unknown>;
      state.decisions.push({ approvalId, body });
      return fulfillJson(route, {
        ...approval(approvalId),
        status: body.decision === "rejected" ? "rejected" : "approved",
        decision: body.decision,
        trust_scope: body.trust_scope,
        rule_match_type: body.rule_match_type ?? null,
        reject_message: body.reject_message ?? null,
        resolved_at: "2026-06-24T10:02:00Z",
      });
    }

    if (url.pathname === "/api/models") {
      return fulfillJson(route, { models: [{ id: "qwen-coder-e2e" }], cached: true });
    }

    if (url.pathname === "/api/workspaces") {
      return fulfillJson(route, { list: [workspace()], total: 1 });
    }

    if (url.pathname === "/api/sessions") {
      return fulfillJson(route, {
        list: [session()],
        total: 1,
        page: 1,
        page_size: 50,
      });
    }

    if (url.pathname === "/api/sessions/session-approval") {
      return fulfillJson(route, { session: session() });
    }

    if (url.pathname === "/api/sessions/session-approval/history") {
      return fulfillJson(route, {
        list: [],
        total: 0,
        page: 1,
        page_size: 50,
        session: session(),
        event_total: 0,
        turn_indexes: [],
      });
    }

    return fulfillJson(route, {});
  });
}

async function installWebSocketMock(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const sockets: Array<Record<string, unknown>> = [];
    Object.assign(window, {
      __keydexDispatchAgentEvent: (event: unknown) => {
        const socket = sockets.at(-1);
        if (socket && typeof socket.onmessage === "function") {
          socket.onmessage(new MessageEvent("message", { data: JSON.stringify(event) }));
        }
      },
      __keydexSentWsFrames: [],
    });

    const MockWebSocket = function MockWebSocket(this: Record<string, unknown>, url: string) {
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
        if (typeof this.onopen === "function") {
          this.onopen(new Event("open"));
        }
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
    MockWebSocket.prototype.send = function send(message: string) {
      (window as unknown as { __keydexSentWsFrames: unknown[] }).__keydexSentWsFrames.push(JSON.parse(message));
    };
    MockWebSocket.prototype.close = function close(this: Record<string, unknown>) {
      this.readyState = MockWebSocket.CLOSED;
      if (typeof this.onclose === "function") {
        this.onclose(new CloseEvent("close", { code: 1000 }));
      }
    };

    Object.assign(window, { WebSocket: MockWebSocket as unknown as typeof WebSocket });
  });
}

async function dispatchApproval(page: Page, approvalPayload: Record<string, unknown>) {
  await page.evaluate((payload) => {
    (window as unknown as { __keydexDispatchAgentEvent: (event: unknown) => void }).__keydexDispatchAgentEvent({
      action: "approval_requested",
      data: {
        session_id: "session-approval",
        approval: payload,
      },
    });
  }, approvalPayload);
}

function settingsResponse(command: Record<string, unknown>) {
  return {
    model: {
      base_url: "https://api.example/v1",
      model: "qwen-coder-e2e",
      timeout_seconds: 60,
      api_key_set: true,
      api_key_preview: "sk-***",
    },
    appearance: { font_family: "system" },
    command,
  };
}

function workspace() {
  return {
    id: "workspace-command-approval",
    name: "keydex-e2e",
    root_path: "D:/repo/keydex-e2e",
    normalized_root_path: "d:/repo/keydex-e2e",
    type: "project",
    created_at: "2026-06-24T00:00:00Z",
    updated_at: "2026-06-24T00:00:00Z",
    last_opened_at: "2026-06-24T00:00:00Z",
    is_deleted: false,
  };
}

function session() {
  return {
    id: "session-approval",
    user_id: "local-user",
    scene_id: "desktop-agent",
    status: "active",
    title: "待审批会话",
    session_tag: "chat",
    session_type: "chat",
    workspace_id: null,
    cwd: "D:/repo",
    workspace_roots: ["D:/repo"],
    workspace: null,
    active_session_id: null,
    parent_session_id: null,
    child_session_id: null,
    source_trace_id: null,
    created_at: "2026-06-24T10:00:00Z",
    updated_at: "2026-06-24T10:00:00Z",
    is_debug: false,
    is_scheduled: false,
    is_current: true,
  };
}

function approval(id: string) {
  return {
    id,
    session_id: "session-approval",
    thread_id: "session-approval",
    turn_id: "turn-1",
    item_id: "item-command",
    call_id: "call-command",
    run_id: "run-command",
    tool_name: "run_command",
    kind: "exec",
    title: "是否允许执行命令？",
    description: "请求执行命令。",
    details: {
      command: "pnpm test",
      cwd: "D:/repo",
      suggested_exact_rule: "pnpm test",
      suggested_prefix_rule: "pnpm --dir desktop",
    },
    status: "pending",
    created_at: "2026-06-24T10:01:00Z",
    resolved_at: null,
  };
}

function trustedRule() {
  return {
    id: "rule-1",
    command_pattern: "pnpm test",
    normalized_command: "pnpm test",
    match_type: "exact",
    shell: "powershell",
    workspace_root: "D:/repo",
    cwd_pattern: "D:/repo",
    enabled: true,
    created_from_approval_id: "approval-1",
    created_at: "2026-06-24T10:00:00Z",
    updated_at: "2026-06-24T10:00:00Z",
    last_used_at: null,
  };
}

function approvalHistory(page = 1) {
  return {
    id: `audit-${page}`,
    approval_id: `approval-${page}`,
    session_id: "session-approval",
    command: page === 2 ? "npm run build" : "pnpm test",
    cwd: page === 2 ? "D:/repo/web" : "D:/repo",
    decision: page === 2 ? "rejected" : "approved",
    trust_scope: "persistent",
    rule_match_type: "exact",
    trusted_rule_id: "rule-1",
    reject_message: page === 2 ? "需要先补测试" : null,
    metadata: {},
    created_at: page === 2 ? "2026-06-24T10:02:00Z" : "2026-06-24T10:01:00Z",
  };
}

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: corsHeaders(),
    body: JSON.stringify(body),
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  };
}

async function saveEvidence(page: Page, caseId: string) {
  const directory = path.join(EVIDENCE_ROOT, caseId);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, "latest.png"), fullPage: true });
}
