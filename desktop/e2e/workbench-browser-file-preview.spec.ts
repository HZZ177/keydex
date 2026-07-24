import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  APP_BASE,
  RICH_SESSION,
  SESSION_A,
  WORKSPACE_A,
  WORKSPACE_B,
  createWorkbenchBackend,
  installWebSocketMock,
  mockWorkbenchBackend,
  openWorkbenchComposer,
  saveEvidence,
  type E2EWorkspaceTreeEntry,
  type MockBackendState,
} from "./workbench-e2e-fixtures";

const HTML_A = "<!doctype html><html><body><h1>E2E_HTML_A</h1></body></html>";
const HTML_B = "<!doctype html><html><body><h1>E2E_HTML_B</h1></body></html>";
const HTML_CONFLICT = "<!doctype html><html><body><h1>E2E_HTML_CONFLICT</h1></body></html>";

const FILES: Record<string, string> = {
  "README.md": "# README\n\nE2E Workbench File",
  "demo.html": HTML_A,
  "second.html": HTML_B,
  "conflict.html": HTML_CONFLICT,
  "notes.md": "# Notes\n\nMixed tab fixture",
};

const TREE: E2EWorkspaceTreeEntry[] = Object.entries(FILES).map(([filePath, content]) => ({
  name: filePath,
  path: filePath,
  type: "file",
  size: new TextEncoder().encode(content).byteLength,
  modified_at: null,
}));

async function prepareWorkbench(
  page: Page,
  options: {
    conflicts?: string[];
    history?: Array<Record<string, unknown>>;
  } = {},
): Promise<{ backend: MockBackendState; pageErrors: string[] }> {
  const backend = createWorkbenchBackend({
    historyBySession: options.history ? { [SESSION_A]: options.history } : undefined,
    workspaceFiles: FILES,
    workspaceTreeEntries: TREE,
    workspaceWriteConflicts: options.conflicts,
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);
  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`);
  await expect(page.getByTestId("workbench-workspace-shell")).toBeVisible();
  return { backend, pageErrors };
}

function localWebAnnotationSnapshot() {
  const target = {
    type: "text",
    quote: { exact: "Rendered heading", prefix: "", suffix: "" },
    context: { headingPath: ["Rendered index"] },
    rects: [{ x: 12, y: 24, width: 160, height: 22 }],
    frame: { url: "file:///D:/repo/keydex/demo.html", indexPath: [] },
  };
  return {
    schemaVersion: 2,
    type: "web_annotation",
    reference: {
      annotationId: "e2e-wbf-local-page",
      revision: 1,
      anchorId: "wa_e2ewbflocalpage1",
      createdAt: "2026-07-24T00:00:00Z",
      assembledAt: "2026-07-24T00:00:00Z",
    },
    trust: {
      userComment: "user_instruction",
      pageEvidence: "untrusted_reference",
      hostObservation: "trusted_application_observation",
    },
    comment: {
      bodyMarkdown: "Review rendered output",
      tags: ["e2e-wbf"],
      properties: [],
    },
    page: {
      sourceKind: "local_file",
      displayAddress: "D:\\repo\\keydex\\demo.html",
      title: "Rendered index",
      documentUrl: "file:///D:/repo/keydex/demo.html",
      canonicalUrl: null,
      urlKey: "e2e-wbf-local-file-key",
      origin: "file://",
      frame: target.frame,
    },
    anchor: {
      kind: "text",
      display: { label: "Rendered heading", quote: "Rendered heading" },
      semantic: { stableAttributes: [] },
      content: { exactText: "Rendered heading", prefix: "", suffix: "" },
      structure: {
        locators: [{ kind: "text_quote", stability: "medium", value: "Rendered heading" }],
        headingPath: ["Rendered index"],
      },
      geometry: { rects: target.rects },
      machineTarget: target,
    },
    observation: {
      status: "resolved",
      freshness: "current",
      observedAt: "2026-07-24T00:00:00Z",
      match: { strategy: "exact_quote", confidence: 1, candidateCount: 1 },
      currentQuote: "Rendered heading",
      currentTarget: target,
      changes: {
        kinds: [],
        materialKinds: [],
        signals: [],
        material: false,
      },
    },
    integrity: {
      canonicalization: "keydex-json-c14n/v1",
      digest: `sha256:${"e".repeat(64)}`,
    },
  };
}

async function openFile(page: Page, filePath: string) {
  await page.getByRole("button", { name: `选择文件 ${filePath}` }).click();
  await expect(fileTab(page, filePath)).toHaveAttribute("aria-selected", "true");
}

async function openHtmlBrowser(page: Page, filePath: string) {
  await openFile(page, filePath);
  await expect(page.getByTestId("file-source-viewer")).toBeVisible();
  await page.getByTestId("html-browser-preview-action").click();
  await expect(browserTab(page, filePath)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("workbench-browser-tab-content")).toBeVisible();
}

function fileTab(page: Page, filePath: string): Locator {
  return page.locator(`[role="tab"][data-tab-kind="file"]`).filter({ hasText: filePath });
}

function browserTab(page: Page, filePath: string): Locator {
  return page.locator(
    `[role="tab"][data-tab-kind="browser"][title$="${filePath.replaceAll('"', '\\"')}"]`,
  );
}

async function closeTab(page: Page, tab: Locator) {
  await tab.locator("..").getByRole("button", { name: /^关闭预览 / }).click();
}

async function editActiveSource(page: Page, content: string) {
  const editor = page.getByTestId("file-source-viewer").locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(content);
}

test("e2e-001 HTML files open as source with an explicit browser preview action", async ({ page }) => {
  const { pageErrors } = await prepareWorkbench(page);
  await openFile(page, "demo.html");

  await expect(page.getByTestId("file-source-viewer")).toContainText("E2E_HTML_A");
  await expect(page.getByTestId("html-browser-preview-action")).toBeVisible();
  await expect(page.getByTestId("preview-split-pane")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  await saveEvidence(page, "e2e-001");
});

test("e2e-002 non-Tauri fallback keeps the tree, assistant, tab switch and close usable", async ({ page }) => {
  const { pageErrors } = await prepareWorkbench(page);
  await openHtmlBrowser(page, "demo.html");

  await expect(page.getByRole("alert")).toHaveAttribute(
    "data-browser-error",
    "desktop_runtime_required",
  );
  await expect(page.getByText("需要 Keydex 桌面运行时")).toBeVisible();
  await expect(page.getByText(/继续使用文件树和助手/)).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByTestId("workspace-file-browser")).toBeVisible();
  await openWorkbenchComposer(page);
  await openFile(page, "README.md");
  await expect(page.getByRole("heading", { name: "README" })).toBeVisible();
  await closeTab(page, browserTab(page, "demo.html"));
  await expect(browserTab(page, "demo.html")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  await saveEvidence(page, "e2e-002");
});

test("e2e-003/004/005 mixed tabs keep one tree, dedupe one HTML and isolate two HTML files", async ({ page }) => {
  const { pageErrors } = await prepareWorkbench(page);
  await openFile(page, "README.md");
  await openHtmlBrowser(page, "demo.html");
  await fileTab(page, "demo.html").click();
  await page.getByTestId("html-browser-preview-action").click();

  await expect(browserTab(page, "demo.html")).toHaveCount(1);
  await saveEvidence(page, "e2e-004");

  await openHtmlBrowser(page, "second.html");
  await expect(browserTab(page, "demo.html")).toHaveCount(1);
  await expect(browserTab(page, "second.html")).toHaveCount(1);
  await expect(fileTab(page, "demo.html")).toHaveCount(1);
  await expect(fileTab(page, "second.html")).toHaveCount(1);
  await saveEvidence(page, "e2e-005");

  for (const tab of [
    fileTab(page, "README.md"),
    fileTab(page, "demo.html"),
    browserTab(page, "demo.html"),
    fileTab(page, "second.html"),
    browserTab(page, "second.html"),
  ]) {
    await tab.click();
    await expect(page.getByTestId("workspace-file-browser")).toBeVisible();
    await expect(page.getByTestId("workspace-file-browser")).toHaveCount(1);
  }
  expect(pageErrors).toEqual([]);
  await saveEvidence(page, "e2e-003");
});

test("e2e-006 browser tabs participate in close-right, close-other and close-all menus", async ({ page }) => {
  const { pageErrors } = await prepareWorkbench(page);
  await openFile(page, "README.md");
  await openHtmlBrowser(page, "demo.html");
  await openHtmlBrowser(page, "second.html");

  await browserTab(page, "demo.html").click({ button: "right" });
  await page.getByRole("menuitem", { name: "关闭右侧tab" }).click();
  await expect(fileTab(page, "second.html")).toHaveCount(0);
  await expect(browserTab(page, "second.html")).toHaveCount(0);
  await expect(browserTab(page, "demo.html")).toHaveCount(1);

  await browserTab(page, "demo.html").click({ button: "right" });
  await page.getByRole("menuitem", { name: "关闭其他tab" }).click();
  await expect(page.locator(`[role="tab"]`)).toHaveCount(1);
  await expect(browserTab(page, "demo.html")).toHaveCount(1);

  await browserTab(page, "demo.html").click({ button: "right" });
  await page.getByRole("menuitem", { name: "关闭所有tab" }).click();
  await expect(page.locator(`[role="tab"]`)).toHaveCount(0);
  await expect(page.getByTestId("workspace-file-browser")).toBeVisible();
  expect(pageErrors).toEqual([]);
  await saveEvidence(page, "e2e-006");
});

test("e2e-008 browser tabs are isolated and restored per workspace", async ({ page }) => {
  const { pageErrors } = await prepareWorkbench(page);
  await openHtmlBrowser(page, "demo.html");
  await expect(browserTab(page, "demo.html")).toHaveAttribute("title", "D:\\repo\\keydex\\demo.html");

  const selector = page.getByTestId("workbench-titlebar-workspace-selector");
  await selector.getByRole("button", { name: "选择工作区" }).click();
  await page.getByRole("option", { name: /other/ }).click();
  await expect(page).toHaveURL(new RegExp(`/workbench/${WORKSPACE_B}$`));
  await expect(browserTab(page, "demo.html")).toHaveCount(0);
  await openHtmlBrowser(page, "demo.html");
  await expect(browserTab(page, "demo.html")).toHaveAttribute("title", "D:\\repo\\other\\demo.html");

  await selector.getByRole("button", { name: "选择工作区" }).click();
  await page.getByRole("option", { name: /keydex/ }).click();
  await expect(page).toHaveURL(new RegExp(`/workbench/${WORKSPACE_A}$`));
  await expect(browserTab(page, "demo.html")).toHaveAttribute("title", "D:\\repo\\keydex\\demo.html");
  expect(pageErrors).toEqual([]);
  await saveEvidence(page, "e2e-008");
});

test("e2e-009 same-workspace session changes preserve the browser tab and retarget the composer", async ({ page }) => {
  const { pageErrors } = await prepareWorkbench(page);
  await openHtmlBrowser(page, "demo.html");
  const originalTabTitle = await browserTab(page, "demo.html").getAttribute("title");

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${RICH_SESSION}`);
  await expect(browserTab(page, "demo.html")).toHaveAttribute("title", originalTabTitle ?? "");
  const input = await openWorkbenchComposer(page);
  await input.click();
  await page.keyboard.insertText("session-b composer");
  await expect(input).toHaveText("session-b composer");
  await expect(page.getByTestId("workbench-mode-page")).toHaveAttribute(
    "data-selected-session-id",
    RICH_SESSION,
  );
  expect(pageErrors).toEqual([]);
  await saveEvidence(page, "e2e-009");
});

test("e2e-010 Agent/Workbench round trip restores tabs without enabling the global right sidebar", async ({ page }) => {
  const { pageErrors } = await prepareWorkbench(page);
  await openHtmlBrowser(page, "demo.html");

  await page.getByRole("button", { name: "Agent" }).click();
  await expect(page).toHaveURL(new RegExp(`/conversation/${SESSION_A}$`));
  await expect(page.getByTestId("workbench-mode-page")).toHaveCount(0);

  await page.getByRole("button", { name: "工作台模式" }).click();
  await expect(page.getByTestId("workbench-mode-page")).toBeVisible();
  await expect(browserTab(page, "demo.html")).toHaveCount(1);
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-right-sidebar-enabled", "false");
  await expect(page.getByLabel("展开右侧栏")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  await saveEvidence(page, "e2e-010");
});

test("e2e-061 Agent HTML preview opens a top browser tab instead of embedding in Files", async ({ page }) => {
  const { pageErrors } = await prepareWorkbench(page);

  await page.getByRole("button", { name: "Agent" }).click();
  await expect(page).toHaveURL(new RegExp(`/conversation/${SESSION_A}$`));
  await expect(page.getByLabel("继续输入")).toBeVisible();
  await page.getByLabel("展开右侧栏").click();
  await page.getByRole("button", { name: "文件" }).click();
  await page.getByRole("button", { name: "选择文件 demo.html" }).click();

  const previewPane = page.getByTestId("workspace-file-browser-preview");
  await expect(previewPane.getByTestId("html-browser-preview-action")).toBeVisible();
  await expect(previewPane.locator("[data-browser-adapter]")).toHaveCount(0);
  await previewPane.getByTestId("html-browser-preview-action").click();

  const browserTab = page.locator("[data-panel-kind='browser']").getByRole("tab");
  await expect(browserTab).toBeVisible();
  await expect(browserTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-browser-adapter='agent']")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "地址或搜索" })).toHaveValue(
    "file:///D:/repo/keydex/demo.html",
  );
  await expect(page.getByTestId("workbench-browser-tab-content")).toHaveCount(0);

  await page.getByRole("tab", { name: "文件" }).click();
  await expect(previewPane.getByTestId("html-browser-preview-action")).toBeVisible();
  await expect(previewPane.locator("[data-browser-adapter]")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  await saveEvidence(page, "e2e-061");
});

test("e2e-011 persisted HTML edits enqueue exactly one associated browser reload", async ({ page }) => {
  const { backend, pageErrors } = await prepareWorkbench(page);
  await openHtmlBrowser(page, "demo.html");
  await fileTab(page, "demo.html").click();
  const updated = "<!doctype html><html><body><h1>E2E_HTML_A_VERSION_2</h1></body></html>";
  await editActiveSource(page, updated);

  await expect(page.getByRole("region", { name: "文件预览", exact: true })).toHaveAttribute(
    "data-file-preview-auto-save-state",
    "saved",
  );
  expect(backend.workspaceWriteRequests).toHaveLength(1);
  expect(backend.workspaceWriteRequests[0]).toMatchObject({
    workspaceId: WORKSPACE_A,
    path: "demo.html",
    content: updated,
  });
  await expect(browserTab(page, "demo.html")).toHaveAttribute("data-navigation-command-kind", "reload");
  await expect(browserTab(page, "demo.html")).toHaveAttribute(
    "data-navigation-command-source",
    "file_change",
  );
  expect(pageErrors).toEqual([]);
  await saveEvidence(page, "e2e-011");
});

test("e2e-012 dirty and revision-conflict HTML never enqueue a browser reload", async ({ page }) => {
  const { backend, pageErrors } = await prepareWorkbench(page, { conflicts: ["conflict.html"] });
  await openHtmlBrowser(page, "conflict.html");
  await fileTab(page, "conflict.html").click();
  await editActiveSource(
    page,
    "<!doctype html><html><body><h1>E2E_HTML_CONFLICT_DIRTY</h1></body></html>",
  );

  await expect(page.getByRole("dialog", { name: "文件保存冲突" })).toBeVisible();
  expect(backend.workspaceWriteRequests.length).toBeGreaterThanOrEqual(1);
  expect(backend.workspaceWriteRequests.every(
    (request) => request.path === "conflict.html",
  )).toBe(true);
  await expect(browserTab(page, "conflict.html")).not.toHaveAttribute(
    "data-navigation-command-kind",
    "reload",
  );
  expect(pageErrors).toEqual([]);
  await saveEvidence(page, "e2e-012");
});

test("e2e-013 history keeps HTML source and local rendered-page annotation labels distinct", async ({ page }) => {
  const snapshot = localWebAnnotationSnapshot();
  const { pageErrors } = await prepareWorkbench(page, {
    history: [{
      id: "e2e-wbf-dual-annotation-message",
      sessionId: SESSION_A,
      role: "user",
      content: "对照源码和页面",
      timestamp: 1_783_680_000_000,
      contextItems: [
        {
          id: "annotation:workspace-a:e2e-wbf-source-html",
          type: "annotation",
          label: "HTML 源码批注 · 选区",
          content: "<h1>E2E_HTML_A</h1>",
          path: "demo.html",
          metadata: {
            annotation_id: "e2e-wbf-source-html",
            annotation_source_kind: "html_source",
          },
        },
        {
          id: `web-annotation:${snapshot.reference.annotationId}:${snapshot.integrity.digest}`,
          type: "web_annotation",
          label: "本地页面批注 · Rendered index",
          content: "Review rendered output",
          metadata: {
            annotation_id: snapshot.reference.annotationId,
            snapshot_digest: snapshot.integrity.digest,
            snapshot,
          },
        },
      ],
    }],
  });
  await openWorkbenchComposer(page);
  await page.getByRole("button", { name: "展开工作台消息层" }).click();

  await expect(page.getByText("HTML 源码批注 · 选区")).toBeVisible();
  await expect(page.getByText("本地页面批注 · Rendered index")).toBeVisible();
  expect(pageErrors).toEqual([]);
  await saveEvidence(page, "e2e-013");
});

test("e2e-014 assistant capsule, expanded layer and drawer remain usable above a browser tab", async ({ page }) => {
  const { pageErrors } = await prepareWorkbench(page);
  await openHtmlBrowser(page, "demo.html");
  await openWorkbenchComposer(page);

  await page.getByRole("button", { name: "展开工作台消息层" }).click();
  await expect(page.getByTestId("workbench-expanded-layer")).toBeVisible();
  await expect(browserTab(page, "demo.html")).toHaveCount(1);
  await page.getByRole("button", { name: "收起工作台消息层" }).click();

  await openWorkbenchComposer(page);
  await page.getByRole("button", { name: "将工作台助手展开到右侧" }).click();
  await expect(page.getByTestId("workbench-assistant-drawer")).toBeVisible();
  await expect(page.getByTestId("workspace-file-browser")).toBeVisible();
  await expect(browserTab(page, "demo.html")).toHaveCount(1);
  await page.getByRole("button", { name: "收回工作台助手为胶囊" }).click();
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute(
    "data-surface-mode",
    "capsule",
  );
  expect(pageErrors).toEqual([]);
  await saveEvidence(page, "e2e-014");
});
