import { expect, test, type Page, type Route } from "@playwright/test";

const API_BASE = "http://127.0.0.1:8765";
const APP_BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
const SESSION_ID = "ses-e2e-keydex-skill";

test("skill list and capsule selection", async ({ page }) => {
  const state = mockState({ skills: [demoSkill()] });
  await installWebSocketMock(page);
  await mockBackend(page, state);

  await page.goto(`${APP_BASE}/#/conversation/${SESSION_ID}`);

  const input = page.getByLabel("继续输入");
  await expect(input).toBeVisible();
  await input.click();
  await page.keyboard.type("/demo");

  await expect(page.getByTestId("slash-command-menu")).toBeVisible();
  await expect(page.getByRole("option", { name: /\/demo/ })).toBeVisible();
  await page.getByRole("option", { name: /\/demo/ }).click();

  await expect(input).toHaveText("");
  await expect(page.getByLabel("删除 Skill /demo")).toBeVisible();

  await page.getByLabel("删除 Skill /demo").click();
  await expect(page.getByLabel("删除 Skill /demo")).toHaveCount(0);
});

test("slash root search can select a concrete skill directly", async ({ page }) => {
  const state = mockState({ skills: [demoSkill(), reviewSkill()] });
  await installWebSocketMock(page);
  await mockBackend(page, state);

  await page.goto(`${APP_BASE}/#/conversation/${SESSION_ID}`);

  const input = page.getByLabel("继续输入");
  await expect(input).toBeVisible();
  await input.click();
  await page.keyboard.type("/review");

  const menu = page.getByTestId("slash-command-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId("slash-skill-section")).toContainText("Skill");
  const reviewOption = page.getByRole("option", { name: /选择 Skill \/review/ });
  await expect(reviewOption).toBeVisible();
  await expect(reviewOption).toHaveAttribute("data-active", "true");

  await page.keyboard.press("Enter");

  await expect(input).toHaveText("");
  await expect(page.getByLabel("删除 Skill /review")).toBeVisible();
});

test("skill activation payload keeps skill out of message injection", async ({ page }) => {
  const state = mockState({ skills: [demoSkill()] });
  await installWebSocketMock(page);
  await mockBackend(page, state);

  await page.goto(`${APP_BASE}/#/conversation/${SESSION_ID}`);

  const input = page.getByLabel("继续输入");
  await expect(input).toBeVisible();
  await input.click();
  await page.keyboard.type("@");
  await page.getByRole("option", { name: /README\.md/ }).click();
  await expect(page.getByRole("button", { name: "打开文件引用 README.md" })).toBeVisible();

  await input.click();
  await page.keyboard.type("拆 issues /demo");
  await page.getByRole("option", { name: /\/demo/ }).click();
  await expect(input).toHaveText("拆 issues");
  await expect(page.getByLabel("删除 Skill /demo")).toBeVisible();

  await page.getByLabel("发送").click();
  const skillFrame = await chatFrameAt(page, 0);

  expect(skillFrame.data?.message).toBe("拆 issues");
  expect(skillFrame.data?.runtime_params?.skill_activation).toEqual({
    skill_name: "demo",
    source: "workspace",
    origin: "slash",
  });
  expect(skillFrame.data?.runtime_params?.message_injection).toHaveLength(1);
  expect(skillFrame.data?.runtime_params?.message_injection?.[0]).toMatchObject({
    type: "follow",
    role: "HumanMessage",
    metadata: {
      kind: "file",
      path: "README.md",
      fileType: "file",
    },
  });
  expect(JSON.stringify(skillFrame.data?.runtime_params?.message_injection)).not.toContain("skill");

  await input.click();
  await page.keyboard.type("普通消息");
  await page.getByLabel("发送").click();
  const plainFrame = await chatFrameAt(page, 1);

  expect(plainFrame.data?.message).toBe("普通消息");
  expect(plainFrame.data?.runtime_params?.skill_activation).toBeUndefined();
});

test("skill capsule history rendering", async ({ page }) => {
  const state = mockState({
    skills: [demoSkill()],
    history: [
      {
        role: "user",
        content: "历史里继续拆 issues",
        contextItems: [
          {
            id: "skill:demo",
            type: "skill",
            label: "/demo",
            content: "Demo workspace skill",
            source: "workspace",
            skill_name: "demo",
            description: "Demo workspace skill",
          },
          {
            id: "file:README.md",
            type: "file",
            label: "README.md",
            content: "workspace file: README.md",
            role: "HumanMessage",
            source: "follow",
            path: "README.md",
            fileType: "file",
          },
          {
            id: "quote:1",
            type: "quote",
            label: "引用片段",
            content: "quoted text",
            role: "HumanMessage",
            source: "follow",
          },
        ],
      },
    ],
  });
  await installWebSocketMock(page);
  await mockBackend(page, state);

  await page.goto(`${APP_BASE}/#/conversation/${SESSION_ID}`);

  const message = page.getByTestId("message-text").first();
  await expect(message).toContainText("历史里继续拆 issues");
  await expect(message).toContainText("demo");
  await expect(message).toContainText("@README.md");
  await expect(message).toContainText("引用片段");
  await expect(page.getByRole("button", { name: "打开文件引用 /demo" })).toHaveCount(0);
  await expect(message).not.toContainText("SKILL.md");
});

test("workspace skills refreshes after change event and skill_not_found", async ({ page }) => {
  const state = mockState({ skills: [demoSkill()] });
  await installWebSocketMock(page);
  await mockBackend(page, state);

  await page.goto(`${APP_BASE}/#/conversation/${SESSION_ID}`);

  const input = page.getByLabel("继续输入");
  await expect(input).toBeVisible();
  await input.click();
  await page.keyboard.type("/demo");
  await expect(page.getByRole("option", { name: /\/demo/ })).toBeVisible();

  state.skills = [reviewSkill()];
  await dispatchAgentEvent(page, "workspaceSkillsChanged", { session_id: SESSION_ID });
  await expect.poll(() => state.skillRequestUrls.length).toBeGreaterThanOrEqual(2);
  expect(state.skillRequestUrls.at(-1)).toContain("force_reload=true");

  await clearComposer(page);
  await input.click();
  await page.keyboard.type("/review");
  await expect(page.getByRole("option", { name: /\/review/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /\/demo/ })).toHaveCount(0);
  await page.getByRole("option", { name: /\/review/ }).click();
  await expect(page.getByLabel("删除 Skill /review")).toBeVisible();

  state.skills = [];
  await dispatchAgentEvent(page, "error", {
    session_id: SESSION_ID,
    code: "skill_not_found",
    message: "Skill does not exist or has been deleted",
    details: { skill_name: "review" },
  });

  await expect.poll(() => state.skillRequestUrls.length).toBeGreaterThanOrEqual(3);
  expect(state.skillRequestUrls.at(-1)).toContain("force_reload=true");
  await expect(page.getByText("已刷新 Skill 列表")).toBeVisible();
  await expect(page.getByLabel("删除 Skill /review")).toHaveCount(0);
});

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
      __wsSentMessages: [],
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
    MockWebSocket.prototype.send = function send(this: Record<string, unknown>, message: string) {
      const frame = JSON.parse(message) as ChatFrame;
      const sentMessages = (window as Window & { __wsSentMessages?: unknown[] }).__wsSentMessages ?? [];
      sentMessages.push(frame);
      (window as Window & { __wsSentMessages?: unknown[] }).__wsSentMessages = sentMessages;
      if (frame.action === "chat") {
        const sessionId = frame.data?.session_id;
        window.setTimeout(() => {
          if (typeof this.onmessage === "function") {
            this.onmessage(
              new MessageEvent("message", {
                data: JSON.stringify({
                  action: "completed",
                  data: {
                    session_id: sessionId,
                    content: "ok",
                    final_content: "ok",
                  },
                }),
              }),
            );
          }
        }, 0);
      }
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

async function mockBackend(page: Page, state: MockBackendState) {
  await page.route(`${API_BASE}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders() });
    }
    if (url.pathname === "/api/settings") {
      return fulfillJson(route, {
        model: {
          base_url: "https://api.example/v1",
          model: "qwen-coder",
          timeout_seconds: 60,
          api_key_set: true,
          api_key_preview: "sk-***",
        },
      });
    }
    if (url.pathname === "/api/settings/model-defaults") {
      return fulfillJson(route, modelDefaultsResponse());
    }
    if (url.pathname === "/api/models") {
      return fulfillJson(route, { models: [{ id: "qwen-coder" }], cached: true });
    }
    if (url.pathname === "/api/model-providers") {
      return fulfillJson(route, modelProvidersResponse());
    }
    if (url.pathname === "/api/sessions") {
      return fulfillJson(route, {
        list: [workspaceSession()],
        total: 1,
        page: 1,
        page_size: 50,
      });
    }
    if (url.pathname === `/api/sessions/${SESSION_ID}/history`) {
      return fulfillJson(route, {
        list: state.history,
        total: state.history.length,
        page: 1,
        page_size: 50,
        session: workspaceSession(),
        event_total: state.history.length,
        turn_indexes: state.history.length ? [1] : [],
        next_cursor: null,
        prev_cursor: null,
        has_more_older: false,
      });
    }
    if (url.pathname === `/api/sessions/${SESSION_ID}/workspace/skills`) {
      state.skillRequestUrls.push(url.toString());
      return fulfillJson(route, skillsResponse(state.skills, state.skillRequestUrls.length));
    }
    if (url.pathname === `/api/sessions/${SESSION_ID}/workspace/tree`) {
      return fulfillJson(route, {
        root: "D:/repo/e2e",
        entries: [
          { name: "README.md", path: "README.md", type: "file", size: 35, modified_at: null },
          { name: "src", path: "src", type: "directory", size: null, modified_at: null },
        ],
      });
    }

    return fulfillJson(route, {});
  });
}

async function chatFrameAt(page: Page, index: number): Promise<ChatFrame> {
  const handle = await page.waitForFunction((frameIndex) => {
    const sentMessages = (window as Window & { __wsSentMessages?: ChatFrame[] }).__wsSentMessages ?? [];
    return sentMessages.filter((message) => message?.action === "chat")[frameIndex] ?? null;
  }, index);
  return (await handle.jsonValue()) as ChatFrame;
}

async function dispatchAgentEvent(page: Page, action: string, data: Record<string, unknown>) {
  await page.evaluate(
    ({ action: eventAction, data: eventData }) => {
      (window as Window & { __keydexDispatchAgentEvent: (event: unknown) => void }).__keydexDispatchAgentEvent({
        action: eventAction,
        data: eventData,
      });
    },
    { action, data },
  );
}

async function clearComposer(page: Page) {
  const input = page.getByLabel("继续输入");
  await input.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
}

function mockState({
  skills = [],
  history = [],
}: {
  skills?: WorkspaceSkillSummary[];
  history?: Array<Record<string, unknown>>;
} = {}): MockBackendState {
  return {
    skills,
    history,
    skillRequestUrls: [],
  };
}

function skillsResponse(skills: WorkspaceSkillSummary[], sequence: number) {
  return {
    workspace_root: "D:/repo/e2e",
    fingerprint: `fp-${sequence}`,
    loaded_at: "2026-06-25T00:00:00Z",
    skills,
    diagnostics: [],
  };
}

function modelDefaultsResponse() {
  return {
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
  };
}

function modelProvidersResponse() {
  return {
    providers: [
      {
        id: "provider-1",
        name: "默认模型服务",
        base_url: "https://api.example/v1",
        enabled: true,
        api_key_set: true,
        api_key_preview: "sk-***",
        models: ["qwen-coder"],
        model_enabled: { "qwen-coder": true },
        health: {},
      },
    ],
  };
}

function demoSkill(): WorkspaceSkillSummary {
  return {
    name: "demo",
    label: "/demo",
    description: "Demo workspace skill",
    source: "workspace",
    locator: ".keydex/skills/demo/SKILL.md",
  };
}

function reviewSkill(): WorkspaceSkillSummary {
  return {
    name: "review",
    label: "/review",
    description: "Review workspace skill",
    source: "workspace",
    locator: ".keydex/skills/review/SKILL.md",
  };
}

function workspaceSession() {
  return {
    id: SESSION_ID,
    title: "Skill E2E",
    user_id: "local-user",
    scene_id: "desktop-agent",
    session_type: "workspace",
    workspace_id: "ws-e2e",
    workspace: {
      id: "ws-e2e",
      name: "keydex-e2e",
      root_path: "D:/repo/e2e",
      normalized_root_path: "d:/repo/e2e",
      type: "project",
      created_at: "2026-06-25T00:00:00Z",
      updated_at: "2026-06-25T00:00:00Z",
      last_opened_at: "2026-06-25T00:00:00Z",
    },
    cwd: "D:/repo/e2e",
    workspace_roots: ["D:/repo/e2e"],
    status: "active",
    created_at: "2026-06-25T00:00:00Z",
    updated_at: "2026-06-25T00:00:00Z",
    last_active_at: "2026-06-25T00:00:00Z",
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
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}

interface MockBackendState {
  skills: WorkspaceSkillSummary[];
  history: Array<Record<string, unknown>>;
  skillRequestUrls: string[];
}

interface WorkspaceSkillSummary {
  name: string;
  label: string;
  description: string;
  source: "workspace";
  locator: string;
}

interface ChatFrame {
  action?: string;
  data?: {
    session_id?: string;
    message?: string;
    runtime_params?: {
      skill_activation?: {
        skill_name?: string;
        source?: string;
        origin?: string;
      };
      message_injection?: Array<{
        type?: string;
        role?: string;
        content?: string;
        metadata?: Record<string, unknown>;
      }>;
    };
  };
}
