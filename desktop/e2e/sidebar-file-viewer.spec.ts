import { expect, test, type Page, type Route } from "@playwright/test";

const API_BASE = "http://127.0.0.1:8765";
const SESSION_ID = "ses-e2e-sidebar-file-viewer";
const APP_BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
const README_CONTENT = [
  "# E2E File",
  "",
  "This file is rendered from Playwright.",
  "",
  "**Cross alpha**",
  "",
  "Cross omega",
  "",
  "```ts",
  "const e2eCodeTarget = 7;",
  "console.log(e2eCodeTarget);",
  "```",
  "",
  "Repeated anchor first.",
  "Repeated anchor second.",
].join("\n");
const LARGE_MARKDOWN_CONTENT = makeLargeMarkdownContent("E2E Large Markdown Title");

test("right sidebar files tab opens and resizes a read-only file preview", async ({ page }) => {
  await installWebSocketMock(page);
  await mockBackend(page);

  await page.goto(`${APP_BASE}/#/conversation/${SESSION_ID}`);

  await expect(page.getByLabel("继续输入")).toBeVisible();
  await page.getByLabel("展开右侧栏").click();
  await page.getByRole("button", { name: "文件" }).click();

  await expect(page.getByTestId("workspace-file-browser")).toBeVisible();
  await expect(page.getByTestId("workspace-file-browser-tree")).toBeVisible();
  await expect(page.getByRole("tree", { name: "工作区目录" })).toBeVisible();
  await expect(page.getByRole("button", { name: "选择文件 package.json" }).locator("[data-icon-id]")).toHaveAttribute(
    "data-icon-id",
    "nodejs",
  );

  await page.getByRole("button", { name: "选择文件 huge.log" }).click();
  await expect(page.getByRole("alert")).toContainText("文件过大，暂不预览");
  await expect(page.getByRole("tree", { name: "工作区目录" })).toBeVisible();

  await page.getByRole("button", { name: "选择文件 README.md" }).click();

  await expect(page.getByRole("heading", { name: "E2E File" })).toBeVisible();
  await expect(page.getByText("This file is rendered from Playwright.")).toBeVisible();
  await expect(page.getByTestId("workspace-file-browser-tree")).toBeVisible();

  await page.getByRole("button", { name: /源码/ }).click();
  await expect(page.getByTestId("file-source-viewer")).toContainText("# E2E File");
  await expect(page.getByTestId("file-source-viewer")).toContainText("2");

  const browser = page.getByTestId("workspace-file-browser");
  const handle = page.getByRole("separator", { name: "调整文件树宽度" });
  const beforeWidth = await browser.evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--workspace-file-tree-width").trim(),
  );
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await handle.dragTo(handle, {
    sourcePosition: { x: Math.max(1, (box?.width ?? 7) / 2), y: Math.max(1, (box?.height ?? 40) / 2) },
    targetPosition: { x: 90, y: Math.max(1, (box?.height ?? 40) / 2) },
    force: true,
  });
  const afterWidth = await browser.evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--workspace-file-tree-width").trim(),
  );
  expect(afterWidth).not.toBe(beforeWidth);

  if (process.env.E2E_EVIDENCE_PATH) {
    await page.screenshot({ path: process.env.E2E_EVIDENCE_PATH, fullPage: true });
  }
});

test("right sidebar markdown preview stays virtualized and deduplicates split find matches", async ({ page }) => {
  await installWebSocketMock(page);
  await mockBackend(page);

  await page.goto(`${APP_BASE}/#/conversation/${SESSION_ID}`);

  await expect(page.getByLabel("继续输入")).toBeVisible();
  await page.getByLabel("展开右侧栏").click();
  await page.getByRole("button", { name: "文件" }).click();
  await page.getByRole("button", { name: "选择文件 e2e-large-markdown.md" }).click();

  await expect(page.getByRole("heading", { name: "E2E Large Markdown Title" })).toBeVisible();
  const virtualPreview = page.locator("[data-markdown-virtual-preview='true']");
  await expect(virtualPreview).toBeAttached();
  const initialMetrics = await virtualPreview.evaluate((element) => ({
    mountedBlocks: Number(element.getAttribute("data-markdown-mounted-block-count") ?? 0),
    totalBlocks: Number(element.getAttribute("data-markdown-block-count") ?? 0),
  }));
  expect(initialMetrics.totalBlocks).toBeGreaterThan(200);
  expect(initialMetrics.mountedBlocks).toBeGreaterThan(0);
  expect(initialMetrics.mountedBlocks).toBeLessThan(initialMetrics.totalBlocks);

  await page.getByRole("button", { name: "搜索文件内容" }).click();
  const search = page.getByRole("search", { name: "文件内容搜索" });
  await expect(search).toBeVisible();
  await search.getByLabel("搜索文件内容").fill("tail-search-target");
  await expect(search).toContainText("1/1");
  await expect(page.getByText("tail-search-target")).toBeVisible();
  const tailMetrics = await virtualPreview.evaluate((element) => ({
    mountedBlocks: Number(element.getAttribute("data-markdown-mounted-block-count") ?? 0),
    totalBlocks: Number(element.getAttribute("data-markdown-block-count") ?? 0),
  }));
  expect(tailMetrics.mountedBlocks).toBeLessThan(tailMetrics.totalBlocks);

  await page.getByRole("button", { name: "分屏" }).click();
  await expect(page.getByTestId("preview-split-pane")).toBeVisible();
  await search.getByLabel("搜索文件内容").fill("split-shared-target");
  await expect(search).toContainText("1/1");
  await expect(page.locator("[data-file-preview-find-match='true']")).toHaveCount(1);
  await expect(page.locator("[data-file-preview-source-find-match='true']")).toHaveCount(1);
  await expect(page.locator("[data-file-preview-find-match='true'][data-active='true']")).toHaveCount(1);
  await expect(page.locator("[data-file-preview-source-find-match='true'][data-active='true']")).toHaveCount(1);
});

test("selected at-file reference sends as a hidden follow injection", async ({ page }) => {
  await installWebSocketMock(page);
  await mockBackend(page);

  await page.goto(`${APP_BASE}/#/conversation/${SESSION_ID}`);

  const input = page.getByLabel("继续输入");
  await expect(input).toBeVisible();
  await input.click();
  await page.keyboard.type("@");

  await expect(page.getByTestId("at-file-menu")).toBeVisible();
  await page.getByRole("option", { name: /README\.md/ }).click();
  await expect(input).toHaveText("");
  await expect(page.getByRole("button", { name: "打开文件引用 README.md" })).toBeVisible();

  await page.getByLabel("发送").click();

  const chatHandle = await page.waitForFunction(() => {
    const sentMessages = (window as Window & { __wsSentMessages?: unknown[] }).__wsSentMessages ?? [];
    return sentMessages.find((message) => {
      return Boolean(message && typeof message === "object" && (message as { action?: unknown }).action === "chat");
    }) ?? null;
  });
  const chatFrame = (await chatHandle.jsonValue()) as {
    data?: {
      message?: string;
      runtime_params?: {
        message_injection?: Array<{
          type?: string;
          role?: string;
          content?: string;
          metadata?: Record<string, unknown>;
        }>;
      };
    };
  };
  const injection = chatFrame.data?.runtime_params?.message_injection?.[0];
  expect(chatFrame.data?.message).toBe("");
  expect(injection).toMatchObject({
    type: "follow",
    role: "HumanMessage",
    metadata: {
      kind: "file",
      path: "README.md",
      fileType: "file",
    },
  });
  expect(injection?.content).toContain("README.md");
  await expect(page.getByTestId("message-text").first()).toContainText("@README.md");
});

async function installWebSocketMock(page: Page) {
  await page.addInitScript(() => {
    (window as Window & { __wsSentMessages?: unknown[] }).__wsSentMessages = [];
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
    MockWebSocket.prototype.send = function send(data: string) {
      const sentMessages = (window as Window & { __wsSentMessages?: unknown[] }).__wsSentMessages ?? [];
      try {
        sentMessages.push(JSON.parse(data));
      } catch {
        sentMessages.push(data);
      }
      (window as Window & { __wsSentMessages?: unknown[] }).__wsSentMessages = sentMessages;
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

async function mockBackend(page: Page) {
  await page.route(`${API_BASE}/api/**`, (route) => fulfillJson(route, {}));
  await page.route(`${API_BASE}/api/settings`, (route) =>
    fulfillJson(route, {
      model: {
        base_url: "https://api.example/v1",
        model: "qwen-coder",
        timeout_seconds: 60,
        api_key_set: true,
        api_key_preview: "sk-***",
      },
    }),
  );
  await page.route(`${API_BASE}/api/models`, (route) =>
    fulfillJson(route, { models: [{ id: "qwen-coder" }], cached: true }),
  );
  await page.route(`${API_BASE}/api/sessions**`, (route) =>
    fulfillJson(route, {
      list: [workspaceSession()],
      total: 1,
      page: 1,
      page_size: 50,
    }),
  );
  await page.route(`${API_BASE}/api/sessions/${SESSION_ID}/history**`, (route) =>
    fulfillJson(route, {
      list: [],
      total: 0,
      page: 1,
      page_size: 5,
      session: workspaceSession(),
      event_total: 0,
      turn_indexes: [],
      next_cursor: null,
      prev_cursor: null,
      has_more_older: false,
    }),
  );
  await page.route(`${API_BASE}/api/sessions/${SESSION_ID}/workspace/tree?path=`, (route) =>
    fulfillJson(route, {
      root: "D:/repo/e2e",
      entries: [
        { name: "README.md", path: "README.md", type: "file", size: 35, modified_at: null },
        { name: "e2e-large-markdown.md", path: "e2e-large-markdown.md", type: "file", size: LARGE_MARKDOWN_CONTENT.length, modified_at: null },
        { name: "package.json", path: "package.json", type: "file", size: 80, modified_at: null },
        { name: "huge.log", path: "huge.log", type: "file", size: 800000, modified_at: null },
      ],
    }),
  );
  await page.route(`${API_BASE}/api/sessions/${SESSION_ID}/workspace/read?path=huge.log`, (route) =>
    fulfillWorkspaceError(route, 413, "workspace_file_too_large", "文件过大，暂不预览"),
  );
  await page.route(`${API_BASE}/api/sessions/${SESSION_ID}/workspace/read?path=README.md`, (route) =>
    fulfillJson(route, {
      path: "README.md",
      content: README_CONTENT,
      encoding: "utf-8",
    }),
  );
  await page.route(`${API_BASE}/api/sessions/${SESSION_ID}/workspace/read?path=e2e-large-markdown.md`, (route) =>
    fulfillJson(route, {
      path: "e2e-large-markdown.md",
      content: LARGE_MARKDOWN_CONTENT,
      encoding: "utf-8",
    }),
  );
}

function makeLargeMarkdownContent(title: string): string {
  const sections = Array.from({ length: 260 }, (_, index) =>
    [
      `## Virtual Section ${index + 1}`,
      "",
      `This virtualized section ${index + 1} keeps the markdown preview heavy enough for E2E.`,
      "",
      "| Key | Value |",
      "| --- | --- |",
      `| Row ${index + 1} | split filler ${index + 1} |`,
    ].join("\n"),
  );
  return [
    `# ${title}`,
    "",
    "The first viewport should render quickly without mounting every block.",
    "",
    ...sections,
    "",
    "## E2E Tail Section",
    "",
    "tail-search-target",
    "",
    "split-shared-target",
  ].join("\n");
}

async function selectVisibleText(page: Page, text: string) {
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

function workspaceSession() {
  return {
    id: SESSION_ID,
    user_id: "default",
    scene_id: "default",
    status: "active",
    title: "E2E sidebar file viewer",
    session_tag: "default",
    session_type: "workspace",
    workspace_id: "ws-e2e",
    cwd: "D:/repo/e2e",
    workspace_roots: ["D:/repo/e2e"],
    workspace: {
      id: "ws-e2e",
      name: "e2e",
      root_path: "D:/repo/e2e",
      normalized_root_path: "d:/repo/e2e",
      workspace_type: "project",
      created_at: "2026-06-22T00:00:00Z",
      updated_at: "2026-06-22T00:00:00Z",
      deleted_at: null,
    },
    active_session_id: null,
    parent_session_id: null,
    child_session_id: null,
    source_trace_id: null,
    created_at: "2026-06-22T00:00:00Z",
    updated_at: "2026-06-22T00:00:00Z",
    is_debug: false,
    is_scheduled: false,
    is_current: true,
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

function fulfillWorkspaceError(route: Route, status: number, code: string, message: string) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({
      detail: {
        code,
        message,
      },
    }),
  });
}
