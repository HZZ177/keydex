import { expect, test, type Page, type Route } from "@playwright/test";

import {
  APP_BASE,
  RICH_SESSION,
  createWorkbenchBackend,
  dispatchAgentEvent,
  installWebSocketMock,
  mockWorkbenchBackend,
} from "./workbench-e2e-fixtures";

const API_BASE = "http://127.0.0.1:8765";

test("interactive A2UI form and choice restore as independent page components", async ({ page }) => {
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [
        {
          id: "a2ui-user-request",
          sessionId: RICH_SESSION,
          role: "user",
          content: "同时展示一个表单和一个选择组件",
          timestamp: 1_782_518_400_000,
        },
        a2uiHistoryMessage({
          id: "a2ui-form-history",
          renderKey: "form",
          interactionId: "interaction-form-history",
          title: "项目配置表单",
          payload: {
            title: "项目配置表单",
            description: "填写项目基本信息。",
            submit_label: "提交表单",
            fields: [
              { name: "project", label: "项目名称", type: "text", required: true, placeholder: "例如：Keydex" },
              { name: "stack", label: "技术栈", type: "select", required: true, options: [
                { label: "React", value: "react" },
                { label: "Vue", value: "vue" },
              ] },
            ],
          },
        }),
        a2uiHistoryMessage({
          id: "a2ui-choice-history",
          renderKey: "choice",
          interactionId: "interaction-choice-history",
          title: "选择开发方向",
          payload: {
            title: "选择开发方向",
            description: "选择一个后续推进方向。",
            presentation_mode: "gallery",
            options: [
              { label: "写文档", value: "docs", description: "整理 README 和设计说明" },
              { label: "写代码", value: "code", description: "开发或修复关键功能" },
              { label: "做测试", value: "test", description: "补充单测和页面级验证" },
            ],
          },
        }),
      ],
    },
  });

  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);
  await page.route(`${API_BASE}/api/health`, fulfillOk);
  await page.route(`${API_BASE}/api/sessions/${RICH_SESSION}/tasks`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ list: [] }),
    }),
  );

  await page.goto(`${APP_BASE}/#/conversation/${RICH_SESSION}`, { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "项目配置表单" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "选择开发方向" })).toBeVisible();
  await expect(page.getByLabel("项目名称")).toBeVisible();
  await expect(page.getByText("写代码")).toBeVisible();
  await expect(page.getByTestId("a2ui-block")).toHaveCount(2);
});

test("interleaved live A2UI streams stay mounted during unrelated transcript churn", async ({ page }) => {
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [
        {
          id: "a2ui-live-user",
          sessionId: RICH_SESSION,
          role: "user",
          content: "Render form and choice concurrently",
          timestamp: 1_782_518_400_000,
        },
      ],
    },
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);
  await page.route(`${API_BASE}/api/health`, fulfillOk);
  await page.route(`${API_BASE}/api/sessions/${RICH_SESSION}/tasks`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ list: [] }),
    }),
  );
  await page.goto(`${APP_BASE}/#/conversation/${RICH_SESSION}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const frames = (window as Window & { __wsSentMessages?: Array<Record<string, unknown>> }).__wsSentMessages ?? [];
    return frames.some((frame) => frame.action === "bind_session");
  });

  const formPayload = {
    title: "Live project form",
    description: "Concurrent form stream",
    fields: [
      { name: "project", label: "Project", type: "text", required: true },
      { name: "budget", label: "Budget", type: "number" },
      { name: "owner", label: "Owner", type: "text" },
    ],
  };
  const choicePayload = {
    title: "Live plan choice",
    description: "Concurrent choice stream",
    presentation_mode: "gallery",
    options: [
      { label: "Plan A", value: "a", description: "First plan" },
      { label: "Plan B", value: "b", description: "Second plan" },
      { label: "Plan C", value: "c", description: "Third plan" },
    ],
  };
  const chartPayload = {
    title: "Live request trend",
    charts: [
      {
        type: "trend",
        title: "Requests",
        series: [
          {
            name: "Requests",
            items: Array.from({ length: 8 }, (_, index) => ({ name: `T${index + 1}`, value: (index + 1) * 10 })),
          },
        ],
      },
    ],
  };

  await dispatchAgentEvent(page, a2uiStreamStart("form", "form-live-stream", "form-live-tool"));
  await dispatchAgentEvent(page, a2uiStreamChunk("form", "form-live-stream", "form-live-tool", 1, {
    ...formPayload,
    fields: formPayload.fields.slice(0, 1),
  }));
  const projectInput = page.getByRole("textbox", { name: /Project/ });
  await expect(projectInput).toBeVisible();

  await dispatchAgentEvent(page, a2uiStreamStart("chart", "chart-live-stream", "chart-live-tool"));
  await dispatchAgentEvent(page, a2uiStreamChunk("chart", "chart-live-stream", "chart-live-tool", 1, {
    ...chartPayload,
    charts: [{
      ...chartPayload.charts[0],
      series: [{ ...chartPayload.charts[0].series[0], items: chartPayload.charts[0].series[0].items.slice(0, 2) }],
    }],
  }));
  await expect(page.getByTestId("a2ui-chart")).toBeVisible();

  await dispatchAgentEvent(page, a2uiStreamStart("choice", "choice-live-stream", "choice-live-tool"));
  await dispatchAgentEvent(page, a2uiStreamChunk("choice", "choice-live-stream", "choice-live-tool", 1, {
    ...choicePayload,
    options: choicePayload.options.slice(0, 1),
  }));
  await expect(page.getByText("Plan A", { exact: true })).toBeVisible();

  await dispatchAgentEvent(page, a2uiStreamChunk("form", "form-live-stream", "form-live-tool", 2, formPayload));
  await dispatchAgentEvent(page, a2uiStreamChunk("choice", "choice-live-stream", "choice-live-tool", 2, choicePayload));
  await dispatchAgentEvent(page, a2uiStreamChunk("chart", "chart-live-stream", "chart-live-tool", 2, chartPayload));
  await projectInput.evaluate((element) => element.setAttribute("data-e2e-node", "project-stable"));

  for (let index = 0; index < 60; index += 1) {
    await dispatchAgentEvent(page, {
      action: "stream",
      data: {
        session_id: RICH_SESSION,
        id: "unrelated-assistant-stream",
        content: ` unrelated-${index}`,
      },
    });
  }

  await expect(page.getByTestId("a2ui-form")).toBeVisible();
  await expect(page.getByTestId("a2ui-choice")).toBeVisible();
  await expect(page.getByTestId("a2ui-chart")).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: /Budget/ })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("Plan B", { exact: true })).toBeVisible({ timeout: 5_000 });

  await dispatchAgentEvent(page, a2uiCreated("form", "form-live-stream", "form-live-tool", "form-live-interaction", formPayload));
  await dispatchAgentEvent(page, a2uiCreated("choice", "choice-live-stream", "choice-live-tool", "choice-live-interaction", choicePayload));
  await dispatchAgentEvent(page, a2uiRenderCreated("chart", "chart-live-stream", "chart-live-tool", chartPayload));

  await expect(page.getByRole("textbox", { name: /Owner/ })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("Plan C", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(projectInput).toHaveAttribute("data-e2e-node", "project-stable");
  expect(pageErrors).toEqual([]);
});

test("failed chart stream becomes one error line before a clean retry stream", async ({ page }) => {
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [
        {
          id: "a2ui-chart-retry-user",
          sessionId: RICH_SESSION,
          role: "user",
          content: "Render a chart and retry invalid tool arguments",
          timestamp: 1_782_518_400_000,
        },
      ],
    },
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);
  await page.route(`${API_BASE}/api/health`, fulfillOk);
  await page.route(`${API_BASE}/api/sessions/${RICH_SESSION}/tasks`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ list: [] }),
    }),
  );
  await page.goto(`${APP_BASE}/#/conversation/${RICH_SESSION}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const frames = (window as Window & { __wsSentMessages?: Array<Record<string, unknown>> }).__wsSentMessages ?? [];
    return frames.some((frame) => frame.action === "bind_session");
  });

  const failedStreamId = "chart-invalid-stream";
  const failedToolCallId = "chart-invalid-tool";
  const failedPayload = {
    title: "Invalid trend",
    charts: [
      {
        type: "trend",
        title: "Three series",
        series: [
          { name: "A", items: [{ name: "T1", value: 10 }, { name: "T2", value: 20 }] },
          { name: "B", items: [{ name: "T1", value: 20 }, { name: "T2", value: 30 }] },
          { items: [{ name: "T1", value: 30 }, { name: "T2", value: 40 }] },
        ],
      },
    ],
  };
  const errorText = "$.charts[0].series[2].name: required field is missing";

  await dispatchAgentEvent(page, a2uiStreamStart("chart", failedStreamId, failedToolCallId));
  await dispatchAgentEvent(page, a2uiStreamChunk("chart", failedStreamId, failedToolCallId, 1, failedPayload));
  await expect(page.getByTestId("a2ui-echarts-surface")).toBeVisible();

  await dispatchAgentEvent(page, a2uiStreamFinish(
    failedStreamId,
    failedToolCallId,
    failedPayload,
    "finish",
    "tool_args_completed",
  ));
  await dispatchAgentEvent(page, a2uiStreamFinish(
    failedStreamId,
    failedToolCallId,
    failedPayload,
    "failed",
    "tool_error",
    errorText,
  ));

  await expect(page.getByTestId("a2ui-block")).toHaveCount(1);
  await expect(page.getByTestId("a2ui-error-line")).toContainText(errorText);
  await expect(page.getByTestId("a2ui-echarts-surface")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-chart-skeleton")).toHaveCount(0);

  const retryStreamId = "chart-retry-stream";
  const retryToolCallId = "chart-retry-tool";
  const retryPayload = {
    ...failedPayload,
    title: "Valid retry trend",
    charts: [
      {
        ...failedPayload.charts[0],
        series: [
          ...failedPayload.charts[0].series.slice(0, 2),
          { name: "C", items: [{ name: "T1", value: 30 }, { name: "T2", value: 40 }] },
        ],
      },
    ],
  };
  await dispatchAgentEvent(page, a2uiStreamStart("chart", retryStreamId, retryToolCallId));
  await dispatchAgentEvent(page, a2uiStreamChunk("chart", retryStreamId, retryToolCallId, 1, retryPayload));

  await expect(page.getByTestId("a2ui-block")).toHaveCount(2);
  await expect(page.getByTestId("a2ui-error-line")).toHaveCount(1);
  await expect(page.getByTestId("a2ui-echarts-surface")).toHaveCount(1);
  await expect(page.getByTestId("a2ui-chart-skeleton")).toHaveCount(0);

  await dispatchAgentEvent(page, a2uiRenderCreated("chart", retryStreamId, retryToolCallId, retryPayload));
  await expect(page.getByTestId("a2ui-block")).toHaveCount(2);
  await expect(page.getByTestId("a2ui-error-line")).toHaveCount(1);
  await expect(page.getByTestId("a2ui-echarts-surface")).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test("fragmented 200-point chart stream stays responsive and completes without remounting", async ({ page }) => {
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [
        {
          id: "a2ui-large-chart-user",
          sessionId: RICH_SESSION,
          role: "user",
          content: "Render a large trend chart",
          timestamp: 1_782_518_400_000,
        },
      ],
    },
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);
  await page.route(`${API_BASE}/api/health`, fulfillOk);
  await page.route(`${API_BASE}/api/sessions/${RICH_SESSION}/tasks`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ list: [] }),
    }),
  );
  await page.goto(`${APP_BASE}/#/conversation/${RICH_SESSION}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const frames = (window as Window & { __wsSentMessages?: Array<Record<string, unknown>> }).__wsSentMessages ?? [];
    return frames.some((frame) => frame.action === "bind_session");
  });

  const streamId = "chart-fragmented-large-stream";
  const toolCallId = "chart-fragmented-large-tool";
  const chartPayload = {
    title: "Large request trend",
    charts: [
      {
        type: "trend",
        title: "Requests",
        series: [
          {
            name: "Requests",
            items: Array.from({ length: 200 }, (_, index) => ({
              name: `T${index + 1}`,
              value: index + 1,
            })),
          },
        ],
      },
    ],
  };
  const argsText = JSON.stringify(chartPayload);
  const chunkEvents = Array.from({ length: Math.ceil(argsText.length / 4) }, (_, index) => {
    const offset = index * 4;
    const delta = argsText.slice(offset, offset + 4);
    return a2uiStreamDeltaChunk(streamId, toolCallId, index + 1, delta, offset + delta.length);
  });

  await dispatchAgentEvent(page, a2uiStreamStart("chart", streamId, toolCallId));
  const messageList = page.getByTestId("message-list");
  const messageListScroller = page.getByTestId("message-list-scroll");
  await expect(messageList).toHaveAttribute("data-list-mode", "virtual");
  await expect(messageList).toHaveAttribute("data-a2ui-live-count", "1");
  await messageListScroller.evaluate((element) => element.setAttribute("data-e2e-node", "stable-list"));
  const quarter = Math.ceil(chunkEvents.length / 4);
  let dispatchDuration = 0;
  for (let offset = 0; offset < chunkEvents.length; offset += quarter) {
    dispatchDuration += await dispatchAgentEventsBurst(page, chunkEvents.slice(offset, offset + quarter));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(page.getByTestId("a2ui-block")).toHaveCount(1);
    await expect(messageList).toHaveAttribute("data-list-mode", "virtual");
    await expect(messageListScroller).toHaveAttribute("data-e2e-node", "stable-list");
  }

  const chartSurface = page.getByTestId("a2ui-echarts-surface");
  await expect(chartSurface).toBeVisible({ timeout: 10_000 });
  expect(dispatchDuration).toBeLessThan(2_000);

  await dispatchAgentEvent(page, a2uiRenderCreated("chart", streamId, toolCallId, chartPayload));
  await expect(chartSurface).toHaveAttribute("data-a2ui-chart-data-count", "200", { timeout: 10_000 });
  await expect(chartSurface).toHaveAttribute("data-a2ui-chart-renderer", "canvas");
  await expect(messageList).toHaveAttribute("data-list-mode", "virtual");
  await expect(messageList).toHaveAttribute("data-a2ui-live-count", "0");
  await expect(messageListScroller).toHaveAttribute("data-e2e-node", "stable-list");
  expect(pageErrors).toEqual([]);
});

async function dispatchAgentEventsBurst(page: Page, events: unknown[]): Promise<number> {
  return page.evaluate((payloads) => {
    const dispatch = (window as Window & { __dispatchAgentEvent?: (event: unknown) => void }).__dispatchAgentEvent;
    if (!dispatch) {
      throw new Error("Agent event dispatcher is not installed");
    }
    const startedAt = performance.now();
    for (const payload of payloads) {
      dispatch(payload);
    }
    return performance.now() - startedAt;
  }, events);
}

function a2uiHistoryMessage({
  id,
  interactionId,
  payload,
  renderKey,
  title,
}: {
  id: string;
  interactionId: string;
  payload: Record<string, unknown>;
  renderKey: "form" | "choice";
  title: string;
}) {
  const interaction = {
    interaction_id: interactionId,
    status: "waiting_user_input",
    can_submit: true,
  };
  const a2ui = {
    render_key: renderKey,
    mode: "interactive",
    stream_id: `${id}-stream`,
    tool_call_id: `${id}-tool`,
    trace_id: "trace-a2ui-e2e",
    turn_index: 1,
    payload,
    input_schema: {},
    submit_schema: {},
    interaction,
  };
  return {
    id,
    sessionId: RICH_SESSION,
    role: "a2ui",
    content: "",
    contentType: "a2ui",
    content_type: "a2ui",
    hydratedFromHistory: true,
    status: "waiting_input",
    timestamp: 1_782_518_401_000,
    a2ui,
    a2uiDebug: {
      id: `${id}-debug`,
      status: "waiting_input",
      renderKey,
      mode: "interactive",
      streamId: `${id}-stream`,
      interactionId,
      toolCallId: `${id}-tool`,
      traceId: "trace-a2ui-e2e",
      turnIndex: 1,
      chunkCount: 0,
      argsBuffer: "",
      argsTextLength: 0,
      jsonParseStatus: "valid",
      a2ui,
      payload,
      inputSchema: {},
      submitSchema: {},
      interaction,
      rawEvents: [],
      updatedAt: 1_782_518_401_000,
    },
    metadata: { title },
  };
}

function fulfillOk(route: Route) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      status: "ok",
      version: "e2e",
    }),
  });
}

type A2UIE2ERenderKey = "chart" | "form" | "choice";

function a2uiStreamStart(renderKey: A2UIE2ERenderKey, streamId: string, toolCallId: string) {
  return {
    action: "a2ui_stream_start",
    data: {
      session_id: RICH_SESSION,
      render_key: renderKey,
      mode: renderKey === "chart" ? "render" : "interactive",
      stream_id: streamId,
      tool_call_id: toolCallId,
      trace_id: "trace-a2ui-live-e2e",
      turn_index: 1,
      stream: { status: "start", chunk_index: 0, args_text_length: 0 },
    },
  };
}

function a2uiStreamChunk(
  renderKey: A2UIE2ERenderKey,
  streamId: string,
  toolCallId: string,
  chunkIndex: number,
  payload: Record<string, unknown>,
) {
  const argsText = JSON.stringify(payload);
  return {
    action: "a2ui_stream_chunk",
    data: {
      session_id: RICH_SESSION,
      render_key: renderKey,
      mode: renderKey === "chart" ? "render" : "interactive",
      stream_id: streamId,
      tool_call_id: toolCallId,
      trace_id: "trace-a2ui-live-e2e",
      turn_index: 1,
      stream: {
        status: "chunk",
        chunk_index: chunkIndex,
        args_text: argsText,
        args_text_length: argsText.length,
      },
    },
  };
}

function a2uiStreamDeltaChunk(
  streamId: string,
  toolCallId: string,
  chunkIndex: number,
  delta: string,
  argsTextLength: number,
) {
  return {
    action: "a2ui_stream_chunk",
    data: {
      session_id: RICH_SESSION,
      render_key: "chart",
      mode: "render",
      stream_id: streamId,
      tool_call_id: toolCallId,
      trace_id: "trace-a2ui-large-chart-e2e",
      turn_index: 1,
      stream: {
        status: "chunk",
        chunk_index: chunkIndex,
        args_delta: delta,
        args_text_length: argsTextLength,
      },
    },
  };
}

function a2uiStreamFinish(
  streamId: string,
  toolCallId: string,
  payload: Record<string, unknown>,
  status: "finish" | "failed",
  finishReason: string,
  error = "",
) {
  const argsText = JSON.stringify(payload);
  return {
    action: "a2ui_stream_finish",
    data: {
      session_id: RICH_SESSION,
      render_key: "chart",
      mode: "render",
      stream_id: streamId,
      tool_call_id: toolCallId,
      trace_id: "trace-a2ui-chart-retry-e2e",
      turn_index: 1,
      stream: {
        status,
        chunk_index: 2,
        args_delta: "",
        args_text: argsText,
        args_text_length: argsText.length,
        finish_reason: finishReason,
        ...(error ? { error } : {}),
      },
    },
  };
}

function a2uiCreated(
  renderKey: "form" | "choice",
  streamId: string,
  toolCallId: string,
  interactionId: string,
  payload: Record<string, unknown>,
) {
  const interaction = {
    interaction_id: interactionId,
    status: "waiting_user_input",
    can_submit: true,
  };
  return {
    action: "a2ui_created",
    data: {
      session_id: RICH_SESSION,
      render_key: renderKey,
      mode: "interactive",
      stream_id: streamId,
      tool_call_id: toolCallId,
      interaction_id: interactionId,
      trace_id: "trace-a2ui-live-e2e",
      turn_index: 1,
      a2ui: {
        render_key: renderKey,
        mode: "interactive",
        stream_id: streamId,
        tool_call_id: toolCallId,
        trace_id: "trace-a2ui-live-e2e",
        turn_index: 1,
        payload,
        input_schema: {},
        submit_schema: {},
        interaction,
      },
      interaction,
    },
  };
}

function a2uiRenderCreated(
  renderKey: "chart",
  streamId: string,
  toolCallId: string,
  payload: Record<string, unknown>,
) {
  return {
    action: "a2ui_created",
    data: {
      session_id: RICH_SESSION,
      render_key: renderKey,
      mode: "render",
      stream_id: streamId,
      tool_call_id: toolCallId,
      trace_id: "trace-a2ui-live-e2e",
      turn_index: 1,
      a2ui: {
        render_key: renderKey,
        mode: "render",
        stream_id: streamId,
        tool_call_id: toolCallId,
        trace_id: "trace-a2ui-live-e2e",
        turn_index: 1,
        payload,
        input_schema: {},
        submit_schema: {},
      },
    },
  };
}
