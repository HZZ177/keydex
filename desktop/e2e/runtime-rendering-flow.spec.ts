import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE = "http://127.0.0.1:8765";
const APP_BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_ROOT =
  process.env.E2E_RUNTIME_FLOW_EVIDENCE_DIR ??
  path.resolve(__dirname, "../../.dev/e2e/evidence/2026-06-24_12-45-13-desktop-runtime-rendering-flow");

test("desktop shell renders immediately while backend health is pending", async ({ page }) => {
  const requests: string[] = [];
  await installWebSocketMock(page);
  await mockBackend(page, { healthDelayMs: 6_000, requests });

  await page.goto(`${APP_BASE}/#/`);

  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("home-page")).toBeVisible();
  await expect(page.getByTestId("connection-status")).toContainText("正在启动本地服务");
  await expect(page.getByRole("button", { name: "选择工作区" })).toBeDisabled();
  await expect(page.getByLabel("选择模型")).toBeDisabled();
  await expect(page.getByLabel("输入需求")).toHaveAttribute("aria-disabled", "true");

  await page.getByLabel("展开右侧栏").click();
  await expect(page.getByRole("complementary", { name: "右侧栏" })).toBeVisible();
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-right-sidebar", "open");
  expect(requests.some((url) => url.includes("/api/workspaces"))).toBe(false);
  expect(requests.some((url) => url.includes("/api/models"))).toBe(false);
  expect(requests.some((url) => url.includes("/api/settings"))).toBe(false);

  await saveEvidence(page, "e2e-001");
});

test("backend dependent controls unlock after runtime becomes ready", async ({ page }) => {
  const requests: string[] = [];
  await installWebSocketMock(page);
  await mockBackend(page, { requests });

  await page.goto(`${APP_BASE}/#/`);

  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByRole("heading", { name: "我们应该在 keydex-e2e 中构建什么？" })).toBeVisible();
  await expect(page.getByRole("button", { name: "选择工作区" })).toContainText("keydex-e2e");
  await expect(page.getByLabel("选择模型")).toContainText("qwen-coder-e2e");
  await expect(page.getByTestId("connection-status")).toHaveCount(0);

  await page.getByRole("button", { name: "选择工作区" }).click();
  await expect(page.getByRole("dialog", { name: "工作区选择" })).toBeVisible();
  await expect(page.getByRole("option", { name: /keydex-e2e/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByLabel("选择模型").click();
  await expect(page.getByRole("listbox", { name: "模型" })).toBeVisible();
  await expect(page.getByRole("option", { name: "qwen-coder-e2e" })).toBeVisible();

  expect(requests.some((url) => url.includes("/api/health"))).toBe(true);
  expect(requests.some((url) => url.includes("/api/workspaces"))).toBe(true);
  expect(requests.some((url) => url.includes("/api/models"))).toBe(true);
  expect(requests.some((url) => url.includes("/api/settings"))).toBe(true);

  await saveEvidence(page, "e2e-002");
});

interface MockBackendOptions {
  healthDelayMs?: number;
  requests: string[];
}

async function mockBackend(page: Page, options: MockBackendOptions) {
  await page.route(`${API_BASE}/api/**`, async (route) => {
    const url = new URL(route.request().url());
    options.requests.push(`${route.request().method()} ${url.pathname}${url.search}`);

    if (url.pathname === "/api/health") {
      if (options.healthDelayMs) {
        await delay(options.healthDelayMs);
      }
      return fulfillJson(route, {
        status: "ok",
        version: "0.1.0",
      });
    }

    if (url.pathname === "/api/settings") {
      return fulfillJson(route, {
        model: {
          base_url: "https://api.example/v1",
          model: "qwen-coder-e2e",
          timeout_seconds: 60,
          api_key_set: true,
          api_key_preview: "sk-***",
        },
        appearance: {
          font_family: "system",
        },
        command: {
          command_enabled: true,
          require_approval_for_untrusted: true,
          allow_persistent_trust: true,
          default_timeout_seconds: 120,
          max_timeout_seconds: 600,
          max_output_chars: 65536,
        },
      });
    }

    if (url.pathname === "/api/models") {
      return fulfillJson(route, {
        models: [{ id: "qwen-coder-e2e" }],
        cached: true,
      });
    }

    if (url.pathname === "/api/workspaces") {
      return fulfillJson(route, {
        list: [workspace()],
        total: 1,
      });
    }

    if (url.pathname === "/api/sessions") {
      return fulfillJson(route, {
        list: [],
        total: 0,
        page: 1,
        page_size: 50,
      });
    }

    return fulfillJson(route, {});
  });
}

async function installWebSocketMock(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
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
    MockWebSocket.prototype.send = function send() {};
    MockWebSocket.prototype.close = function close(this: Record<string, unknown>) {
      this.readyState = MockWebSocket.CLOSED;
      if (typeof this.onclose === "function") {
        this.onclose(new CloseEvent("close", { code: 1000 }));
      }
    };

    Object.assign(window, { WebSocket: MockWebSocket as unknown as typeof WebSocket });
  });
}

function workspace() {
  return {
    id: "ws-e2e-runtime",
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

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  });
}

async function saveEvidence(page: Page, caseId: string) {
  const directory = path.join(EVIDENCE_ROOT, caseId);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, "latest.png"), fullPage: true });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
