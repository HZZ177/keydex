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

test("file preview annotations can be created edited deleted and used as structured chat context", async ({ page }) => {
  const annotations: E2EAnnotation[] = [];
  await installWebSocketMock(page);
  await mockBackend(page, annotations);

  await page.goto(`${APP_BASE}/#/conversation/${SESSION_ID}`);

  const input = page.getByLabel("继续输入");
  await expect(input).toBeVisible();
  await page.getByLabel("展开右侧栏").click();
  await page.getByRole("button", { name: "文件" }).click();
  await page.getByRole("button", { name: "选择文件 README.md" }).click();
  await page.getByRole("button", { name: /文件批注/ }).click();

  const panel = page.getByRole("complementary", { name: "文件批注" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("暂无批注");

  await page.getByRole("button", { name: "添加文件批注" }).click();
  await page.getByRole("textbox", { name: "添加文件级批注" }).fill("File-level E2E note");
  await page.getByRole("button", { name: "添加文件批注" }).click();
  await expect(panel).toContainText("File-level E2E note");

  const fileAnnotation = panel.locator("article").filter({ hasText: "File-level E2E note" });
  await fileAnnotation.getByRole("button", { name: "编辑批注" }).click();
  await fileAnnotation.getByRole("textbox", { name: "编辑批注" }).fill("Updated file-level E2E note");
  await fileAnnotation.getByRole("button", { name: "保存" }).click();
  await expect(panel).toContainText("Updated file-level E2E note");

  await selectVisibleText(page, "This file is rendered");
  await page.getByRole("button", { name: "为选中文本添加批注" }).click();
  await page.getByRole("textbox", { name: "添加选区批注" }).fill("Selected E2E note");
  await page.getByRole("button", { name: "保存批注" }).click();
  await page.getByRole("button", { name: /文件批注/ }).click();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Selected E2E note");
  await expect(panel).toContainText("This file is rendered");

  const selectionAnnotation = panel.locator("article").filter({ hasText: "Selected E2E note" });
  await selectionAnnotation.getByRole("button", { name: "基于此批注发起对话" }).click();
  const quoteChip = page.locator("[data-quote-index='0'][data-source-quote='true']");
  await expect(quoteChip).toBeVisible();
  await expect(quoteChip).toContainText("README.md · L3");
  await expect(input).toHaveText("");

  const chatCount = await page.evaluate(() => {
    const sentMessages = (window as Window & { __wsSentMessages?: Array<{ action?: string }> }).__wsSentMessages ?? [];
    return sentMessages.filter((message) => message?.action === "chat").length;
  });
  expect(chatCount).toBe(0);

  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: /文件批注/ }).click();
  const reopenedPanel = page.getByRole("complementary", { name: "文件批注" });
  await expect(reopenedPanel).toBeVisible();
  const updatedFileAnnotation = reopenedPanel.locator("article").filter({ hasText: "Updated file-level E2E note" });
  await updatedFileAnnotation.getByRole("button", { name: "删除批注" }).click();
  await expect(reopenedPanel).not.toContainText("Updated file-level E2E note");

  if (process.env.E2E_ANNOTATION_EVIDENCE_PATH) {
    await page.screenshot({ path: process.env.E2E_ANNOTATION_EVIDENCE_PATH, fullPage: true });
  }
});

test("file preview annotations project source ranges across preview source and split locate", async ({ page }) => {
  const annotations: E2EAnnotation[] = [];
  await installWebSocketMock(page);
  await mockBackend(page, annotations);

  await page.goto(`${APP_BASE}/#/conversation/${SESSION_ID}`);

  await expect(page.getByLabel("继续输入")).toBeVisible();
  await page.getByLabel("展开右侧栏").click();
  await page.getByRole("button", { name: "文件" }).click();
  await page.getByRole("button", { name: "选择文件 README.md" }).click();
  await page.getByRole("button", { name: "收起文件树" }).click();

  await selectVisibleTextRange(page, "Cross alpha", "Cross omega");
  await page.getByRole("button", { name: "为选中文本添加批注" }).click();
  await page.getByRole("textbox", { name: "添加选区批注" }).fill("Cross-block E2E note");
  await page.getByRole("button", { name: "保存批注" }).click();
  await expect.poll(() => annotations.length).toBe(1);
  const crossBlockAnnotation = annotations.find((annotation) => annotation.comment === "Cross-block E2E note");
  expect(crossBlockAnnotation?.anchor_json).toMatchObject({
    version: 2,
    kind: "source-range",
    createdInView: "preview",
  });
  await expect(page.locator(`[data-preview-annotation-id="${crossBlockAnnotation?.id}"]`).first()).toBeVisible();

  await page.getByRole("button", { name: /源码/ }).click();
  await expect(page.getByTestId("file-source-viewer")).toBeVisible();
  await expect(page.locator(`[data-file-annotation-id="${crossBlockAnnotation?.id}"]`).first()).toBeVisible();

  await dragSelectSourceLine(page, "const e2eCodeTarget = 7;");
  await page.getByRole("button", { name: "为选中文本添加批注" }).click();
  await page.getByRole("textbox", { name: "添加选区批注" }).fill("Code block E2E note");
  await page.getByRole("button", { name: "保存批注" }).click();
  await expect.poll(() => annotations.length).toBe(2);
  const codeAnnotation = annotations.find((annotation) => annotation.comment === "Code block E2E note");
  expect(codeAnnotation?.anchor_json).toMatchObject({
    version: 2,
    kind: "source-range",
    createdInView: "source",
  });

  await page.getByRole("button", { name: "预览", exact: true }).click();
  await expect(
    page.locator(`[data-preview-annotation-id="${codeAnnotation?.id}"]`).filter({ hasText: "const e2eCodeTarget" }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: /分屏/ }).click();
  await expect(page.getByTestId("preview-split-pane")).toBeVisible();
  await page.getByRole("button", { name: /文件批注/ }).click();
  const panel = page.getByRole("complementary", { name: "文件批注" });
  const codeAnnotationRow = panel.locator("article").filter({ hasText: "Code block E2E note" });
  await codeAnnotationRow.getByRole("button", { name: "定位批注片段" }).click();
  await expect(page.locator(`[data-preview-annotation-id="${codeAnnotation?.id}"][data-flash="true"]`).first()).toBeVisible();
  await expect(page.locator(`[data-file-annotation-id="${codeAnnotation?.id}"][data-flash="true"]`).first()).toBeVisible();

  if (process.env.E2E_ANNOTATION_PROJECTION_EVIDENCE_PATH) {
    await page.screenshot({ path: process.env.E2E_ANNOTATION_PROJECTION_EVIDENCE_PATH, fullPage: true });
  }
});

test("file preview annotations expose invalid anchor state without fallback locate", async ({ page }) => {
  const annotations: E2EAnnotation[] = [
    makeAnnotation({
      id: "ann-legacy-selection",
      anchor_type: "selection",
      comment: "Legacy selection E2E note",
      selected_text: "This file is rendered",
      line_start: 3,
      line_end: 3,
      column_start: 1,
      column_end: 22,
      content_hash: null,
      anchor_json: null,
    }),
  ];
  await installWebSocketMock(page);
  await mockBackend(page, annotations);

  await page.goto(`${APP_BASE}/#/conversation/${SESSION_ID}`);

  await expect(page.getByLabel("继续输入")).toBeVisible();
  await page.getByLabel("展开右侧栏").click();
  await page.getByRole("button", { name: "文件" }).click();
  await page.getByRole("button", { name: "选择文件 README.md" }).click();
  await page.getByRole("button", { name: /文件批注/ }).click();

  const panel = page.getByRole("complementary", { name: "文件批注" });
  const legacyRow = panel.locator("article").filter({ hasText: "Legacy selection E2E note" });
  await expect(legacyRow).toContainText("无法定位");
  await legacyRow.getByRole("button", { name: "定位批注片段" }).click();
  await expect(page.getByRole("alert")).toContainText("当前视图无法定位该批注片段。");
  await expect(page.getByTestId("file-source-viewer")).toHaveCount(0);

  if (process.env.E2E_ANNOTATION_INVALID_EVIDENCE_PATH) {
    await page.screenshot({ path: process.env.E2E_ANNOTATION_INVALID_EVIDENCE_PATH, fullPage: true });
  }
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

async function mockBackend(page: Page, annotations: E2EAnnotation[] = []) {
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
  await page.route(`${API_BASE}/api/sessions/${SESSION_ID}/workspace/annotations**`, async (route) =>
    fulfillAnnotationRoute(route, annotations),
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

function makeAnnotation(overrides: Partial<E2EAnnotation> & { id: string; comment: string }): E2EAnnotation {
  const now = "2026-06-24T00:00:00Z";
  return {
    id: overrides.id,
    scope_type: "session",
    scope_id: SESSION_ID,
    workspace_id: "ws-e2e",
    path: overrides.path ?? "README.md",
    anchor_type: overrides.anchor_type ?? "file",
    comment: overrides.comment,
    selected_text: overrides.selected_text ?? null,
    line_start: overrides.line_start ?? null,
    line_end: overrides.line_end ?? null,
    column_start: overrides.column_start ?? null,
    column_end: overrides.column_end ?? null,
    content_hash: overrides.content_hash ?? null,
    anchor_json: overrides.anchor_json ?? null,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}

interface E2EAnnotation {
  id: string;
  scope_type: "session";
  scope_id: string;
  workspace_id: string;
  path: string;
  anchor_type: "file" | "selection";
  comment: string;
  selected_text?: string | null;
  line_start?: number | null;
  line_end?: number | null;
  column_start?: number | null;
  column_end?: number | null;
  content_hash?: string | null;
  anchor_json?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

async function fulfillAnnotationRoute(route: Route, annotations: E2EAnnotation[]) {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  const now = "2026-06-24T00:00:00Z";

  if (method === "GET") {
    const path = url.searchParams.get("path");
    return fulfillJson(route, annotations.filter((annotation) => annotation.path === path));
  }

  if (method === "POST") {
    const payload = request.postDataJSON() as Partial<E2EAnnotation> & { path: string; comment: string };
    const annotation: E2EAnnotation = {
      id: `ann-${annotations.length + 1}`,
      scope_type: "session",
      scope_id: SESSION_ID,
      workspace_id: "ws-e2e",
      path: payload.path,
      anchor_type: payload.anchor_type ?? "file",
      comment: payload.comment,
      selected_text: payload.selected_text ?? null,
      line_start: payload.line_start ?? null,
      line_end: payload.line_end ?? null,
      column_start: payload.column_start ?? null,
      column_end: payload.column_end ?? null,
      content_hash: payload.content_hash ?? null,
      anchor_json: payload.anchor_json ?? null,
      created_at: now,
      updated_at: now,
    };
    annotations.push(annotation);
    return fulfillJson(route, annotation, 201);
  }

  const annotationId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  const annotation = annotations.find((item) => item.id === annotationId);
  if (!annotation) {
    return fulfillWorkspaceError(route, 404, "workspace_annotation_not_found", "批注不存在");
  }

  if (method === "PATCH") {
    const payload = request.postDataJSON() as Partial<E2EAnnotation>;
    Object.assign(annotation, payload, { updated_at: now });
    return fulfillJson(route, annotation);
  }

  if (method === "DELETE") {
    annotations.splice(annotations.indexOf(annotation), 1);
    return route.fulfill({
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  return fulfillWorkspaceError(route, 405, "method_not_allowed", "不支持的批注请求");
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

async function selectVisibleTextRange(page: Page, startNeedle: string, endNeedle: string) {
  await page.evaluate(
    ({ startNeedle: startValue, endNeedle: endValue }) => {
      const startMatch = findTextNode(startValue);
      const endMatch = findTextNode(endValue);
      if (!startMatch || !endMatch) {
        throw new Error(`Text range not found: ${startValue} -> ${endValue}`);
      }
      const range = document.createRange();
      range.setStart(startMatch.node, startMatch.offset);
      range.setEnd(endMatch.node, endMatch.offset + endValue.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      function findTextNode(needle: string): { node: Text; offset: number } | null {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let current = walker.nextNode();
        while (current) {
          const value = current.textContent ?? "";
          const offset = value.indexOf(needle);
          if (offset >= 0) {
            return { node: current as Text, offset };
          }
          current = walker.nextNode();
        }
        return null;
      }
    },
    { startNeedle, endNeedle },
  );
}

async function dragSelectSourceLine(page: Page, text: string) {
  const points = await page.evaluate((needle) => {
    const sourceViewer = document.querySelector<HTMLElement>("[data-testid='file-source-viewer']");
    if (!sourceViewer) {
      throw new Error("Source viewer not found");
    }
    const line = Array.from(sourceViewer.querySelectorAll<HTMLElement>(".cm-line")).find((element) =>
      (element.textContent ?? "").includes(needle),
    );
    if (!line) {
      throw new Error(`Source line not found: ${needle}`);
    }
    const rect = line.getBoundingClientRect();
    return {
      startX: rect.left + 4,
      startY: rect.top + rect.height / 2,
      endX: rect.right - 4,
      endY: rect.top + rect.height / 2,
    };
  }, text);
  await page.mouse.move(points.startX, points.startY);
  await page.mouse.down();
  await page.mouse.move(points.endX, points.endY, { steps: 12 });
  await page.mouse.up();
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
