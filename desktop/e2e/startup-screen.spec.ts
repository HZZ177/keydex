import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE = "http://127.0.0.1:8765";
const APP_BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_ROOT = path.resolve(__dirname, "../../.dev/test/startup-screen-launch-intent-gate");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installWebSocketMock(page);
});

test("normal startup matches the approved text-free composition and exits to the target route", async ({ page }) => {
  const health = deferred<void>();
  const requests: string[] = [];
  await mockBackend(page, { healthGate: health.promise, requests });
  await page.emulateMedia({ reducedMotion: "reduce" });

  await page.goto(`${APP_BASE}/#/guid`);

  const startup = page.getByTestId("startup-screen");
  const canvas = page.getByTestId("startup-canvas");
  await expect(startup).toBeVisible();
  await expect(startup).toHaveAttribute("data-phase", "pending");
  await expect(startup).toHaveAttribute("data-reduced-motion", "true");
  await expect(page.getByTestId("titlebar")).toContainText("Keydex");
  await expect(canvas).toHaveText("");
  await expect(canvas.locator("img[src='/keydex-startup-mark.png']")).toBeVisible();
  await expect(canvas.getByRole("progressbar")).toHaveCount(0);
  await expect(canvas.getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("home-page")).toHaveCount(0);
  expect(hasBackendRequest(requests, "/api/workspaces")).toBe(false);
  expect(hasBackendRequest(requests, "/api/models")).toBe(false);
  expect(hasBackendRequest(requests, "/api/settings")).toBe(false);
  await saveScreenshot(page, "normal-pending.png");

  health.resolve();

  await expect(startup).toHaveCount(0);
  await expect(page.getByTestId("home-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "我们应该在 keydex-e2e 中构建什么？" })).toBeVisible();
  expect(hasBackendRequest(requests, "/api/workspaces")).toBe(true);
  await saveScreenshot(page, "normal-ready.png");
});

test("external file bypasses every startup phase and keeps one local read through ready", async ({ page }) => {
  const health = deferred<void>();
  const requests: string[] = [];
  await mockBackend(page, { healthGate: health.promise, requests });
  const filePath = "D:/docs/README.md";

  await page.goto(`${APP_BASE}/#/workbench?${new URLSearchParams({ file: filePath }).toString()}`);

  await expect(page.getByTestId("startup-screen")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "README.md" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "External preview" })).toBeVisible();
  await expect(page.getByTestId("workbench-external-preview-pending-pane")).toBeVisible();
  expect(hasBackendRequest(requests, "/api/workspaces")).toBe(false);
  expect(hasBackendRequest(requests, "/api/sessions")).toBe(false);
  expect(hasBackendRequest(requests, "/api/settings")).toBe(false);
  expect(countBackendRequests(requests, "/api/local-preview/read/document")).toBe(1);
  await saveScreenshot(page, "external-pending.png");

  health.resolve();

  await expect(page.getByTestId("workspace-file-browser")).toBeVisible();
  await expect(page.getByRole("tab", { name: "README.md" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "External preview" })).toBeVisible();
  await expect(page.getByTestId("startup-screen")).toHaveCount(0);
  expect(countBackendRequests(requests, "/api/local-preview/read/document")).toBe(1);
  await saveScreenshot(page, "external-ready.png");
});

test("external backend settings use the inline gate without a full-screen startup", async ({ page }) => {
  const health = deferred<void>();
  const requests: string[] = [];
  await mockBackend(page, { healthGate: health.promise, requests });
  const query = new URLSearchParams({ file: "D:/docs/README.md" }).toString();

  await page.goto(`${APP_BASE}/#/settings/providers?${query}`);

  await expect(page.getByTestId("startup-screen")).toHaveCount(0);
  await expect(page.getByTestId("settings-shell")).toBeVisible();
  await expect(page.getByTestId("settings-runtime-gate")).toHaveAttribute("data-state", "pending");
  await expect(page.getByRole("heading", { name: "供应商配置" })).toHaveCount(0);
  expect(hasBackendRequest(requests, "/api/model-providers")).toBe(false);
  await saveScreenshot(page, "external-settings-pending.png");

  health.resolve();
  await expect(page.getByRole("heading", { name: "供应商配置" })).toBeVisible();
  expect(countBackendRequests(requests, "/api/model-providers")).toBe(1);
});

interface MockBackendOptions {
  healthGate: Promise<void>;
  requests: string[];
}

async function mockBackend(page: Page, options: MockBackendOptions) {
  await page.route(`${API_BASE}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    options.requests.push(`${request.method()} ${url.pathname}${url.search}`);

    if (url.pathname === "/api/health") {
      await options.healthGate;
      return fulfillJson(route, { status: "ok", version: "0.1.0", agent_status: "ready" });
    }

    if (url.pathname === "/api/local-preview/read/document") {
      const readRequest = request.postDataJSON() as DocumentReadRequest;
      return fulfillDocument(route, readRequest, "# External preview\n\nThe backend is still starting.\n");
    }

    if (url.pathname === "/api/workspaces") {
      return fulfillJson(route, { list: [workspace()], total: 1 });
    }
    if (url.pathname === "/api/sessions") {
      return fulfillJson(route, { list: [], total: 0, page: 1, page_size: 50 });
    }
    if (/^\/api\/workspaces\/[^/]+\/tree$/u.test(url.pathname)) {
      return fulfillJson(route, { root: "", entries: [] });
    }
    if (url.pathname.endsWith("/annotations")) {
      return fulfillJson(route, []);
    }
    if (url.pathname === "/api/model-providers") {
      return fulfillJson(route, { providers: [] });
    }
    if (url.pathname === "/api/models") {
      return fulfillJson(route, { models: [{ id: "qwen-coder-e2e" }], cached: true });
    }
    if (url.pathname === "/api/settings/model-defaults") {
      return fulfillJson(route, { defaults: {} });
    }
    if (url.pathname === "/api/settings") {
      return fulfillJson(route, settingsResponse());
    }
    return fulfillJson(route, {});
  });
}

interface DocumentReadRequest {
  protocol_version: string;
  request_id: string;
  document_id: string;
  source: string;
  path: string;
}

function fulfillDocument(route: Route, request: DocumentReadRequest, content: string) {
  const revision = "sha256:e2e-external-preview";
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
    headers: { "Access-Control-Allow-Origin": "*" },
    body: messages.map((message) => JSON.stringify(message)).join("\n"),
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
        if (typeof this.onopen === "function") this.onopen(new Event("open"));
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
      if (typeof this.onclose === "function") this.onclose(new CloseEvent("close", { code: 1000 }));
    };
    Object.assign(window, { WebSocket: MockWebSocket as unknown as typeof WebSocket });
  });
}

function settingsResponse() {
  return {
    model: {
      base_url: "https://api.example/v1",
      model: "qwen-coder-e2e",
      timeout_seconds: 60,
      api_key_set: true,
      api_key_preview: "sk-***",
    },
    general: { close_window_behavior: null },
    appearance: { font_family: "system" },
    command: {},
  };
}

function workspace() {
  return {
    id: "ws-e2e-runtime",
    name: "keydex-e2e",
    root_path: "D:/repo/keydex-e2e",
    normalized_root_path: "d:/repo/keydex-e2e",
    type: "project",
    created_at: "2026-07-14T00:00:00Z",
    updated_at: "2026-07-14T00:00:00Z",
    last_opened_at: "2026-07-14T00:00:00Z",
    is_deleted: false,
  };
}

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  });
}

function hasBackendRequest(requests: string[], pathPrefix: string) {
  return requests.some((request) => request.includes(pathPrefix));
}

function countBackendRequests(requests: string[], pathPrefix: string) {
  return requests.filter((request) => request.includes(pathPrefix)).length;
}

async function saveScreenshot(page: Page, filename: string) {
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_ROOT, filename), fullPage: true });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
