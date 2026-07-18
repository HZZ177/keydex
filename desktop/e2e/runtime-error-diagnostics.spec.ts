import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  APP_BASE,
  RICH_SESSION,
  createWorkbenchBackend,
  dispatchAgentEvent,
  installWebSocketMock,
  lastChatFrame,
  mockWorkbenchBackend,
} from "./workbench-e2e-fixtures";

const OTHER_SESSION = "e2e-pure-chat";
const TRACE_ID = "trace-runtime-error-e2e";
const MESSAGE_EVENT_ID = "evt-runtime-error-e2e";
const SECRET_SENTINEL = "sk-e2e-must-never-render";
const ERROR = {
  schema_version: 1 as const,
  code: "llm_bad_request",
  message: "模型请求参数无效",
  details: {
    status_code: 400,
    provider: {
      code: "content_anti_probe_blocking",
      message: "短消息命中测活探针关键词",
      request_id: "req-runtime-error-e2e",
    },
  },
  retryable: false,
  status: 400,
};

test("provider error diagnostics survive live, reload and session switching", async ({ page }) => {
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [],
      [OTHER_SESSION]: [],
    },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await installClipboardCapture(page);
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/conversation/${RICH_SESSION}`, { waitUntil: "commit" });
  await expect(page.getByLabel("继续输入")).toBeVisible({ timeout: 30_000 });

  await dispatchAgentEvent(page, {
    action: "error",
    data: {
      session_id: RICH_SESSION,
      trace_id: TRACE_ID,
      turn_index: 2,
      error: ERROR,
    },
  });

  const liveDiagnostic = await assertVisibleDiagnostic(page);
  expect(liveDiagnostic).toMatchObject({
    error: ERROR,
    context: {
      thread_id: RICH_SESSION,
      trace_id: TRACE_ID,
      turn_index: 2,
    },
  });
  expect(JSON.stringify(liveDiagnostic)).not.toContain(SECRET_SENTINEL);

  backend.historyBySession[RICH_SESSION] = [historyErrorMessage()];
  await page.reload({ waitUntil: "commit" });
  await expect(page.getByLabel("继续输入")).toBeVisible({ timeout: 30_000 });

  const reloadedDiagnostic = await assertVisibleDiagnostic(page);
  expect(reloadedDiagnostic.error).toEqual(liveDiagnostic.error);
  expect(reloadedDiagnostic.context).toMatchObject({
    thread_id: RICH_SESSION,
    trace_id: TRACE_ID,
    turn_index: 2,
    message_event_id: MESSAGE_EVENT_ID,
  });

  await page.goto(`${APP_BASE}/#/conversation/${OTHER_SESSION}`, { waitUntil: "commit" });
  await expect(page.getByLabel("继续输入")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("error-item")).toHaveCount(0);

  await page.goto(`${APP_BASE}/#/conversation/${RICH_SESSION}`, { waitUntil: "commit" });
  const composer = page.getByLabel("继续输入");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("error-item")).toContainText("模型请求参数无效");
  await composer.fill("e2e-runtime-error 后续正常发送");
  await composer.press("Enter");
  await expect.poll(async () => (await lastChatFrame(page))?.data).toMatchObject({
    session_id: RICH_SESSION,
    message: "e2e-runtime-error 后续正常发送",
  });

  const finalDiagnostic = page.getByTestId("error-item");
  await finalDiagnostic.getByRole("button", { name: "展开错误详情" }).click();
  await expect(finalDiagnostic).toContainText("req-runtime-error-e2e");
  await expect(page.locator("body")).not.toContainText(SECRET_SENTINEL);
  await saveEvidence(page);
});

async function assertVisibleDiagnostic(page: Page): Promise<{
  error: Record<string, unknown>;
  context: Record<string, unknown>;
}> {
  const diagnostic = page.getByTestId("error-item");
  await expect(diagnostic).toBeVisible();
  await expect(diagnostic).toContainText("模型请求参数无效");
  await expect(diagnostic).toContainText("llm_bad_request");
  await expect(diagnostic).toContainText("HTTP 400");
  await diagnostic.getByRole("button", { name: "展开错误详情" }).click();
  await expect(diagnostic).toContainText("content_anti_probe_blocking");
  await expect(diagnostic).toContainText("短消息命中测活探针关键词");
  await expect(diagnostic).toContainText("req-runtime-error-e2e");

  await page.evaluate(() => {
    (window as Window & { __copiedErrorDiagnostic?: string }).__copiedErrorDiagnostic = "";
  });
  await diagnostic.getByRole("button", { name: "复制错误" }).click();
  const copied = await page.waitForFunction(
    () => (window as Window & { __copiedErrorDiagnostic?: string }).__copiedErrorDiagnostic || null,
  );
  return JSON.parse(await copied.jsonValue()) as {
    error: Record<string, unknown>;
    context: Record<string, unknown>;
  };
}

function historyErrorMessage() {
  return {
    id: MESSAGE_EVENT_ID,
    sessionId: RICH_SESSION,
    role: "error",
    content: ERROR.message,
    status: "error",
    timestamp: 1_784_300_400_000,
    traceId: TRACE_ID,
    turnIndex: 2,
    messageEventId: MESSAGE_EVENT_ID,
    metadata: {
      turnError: ERROR,
      errorContext: {
        traceId: TRACE_ID,
        messageEventId: MESSAGE_EVENT_ID,
        turnIndex: 2,
      },
    },
  };
}

async function installClipboardCapture(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as Window & { __copiedErrorDiagnostic?: string }).__copiedErrorDiagnostic = value;
        },
      },
    });
  });
}

async function saveEvidence(page: Page) {
  const directory =
    process.env.E2E_RUNTIME_ERROR_EVIDENCE_DIR ??
    path.resolve(
      "..",
      ".dev",
      "e2e",
      "evidence",
      "2026-07-17_17-14-13-unified-runtime-error-contract",
      "e2e-001",
      "2026-07-18_03-40-00",
    );
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, "success.png"), fullPage: true });
}
