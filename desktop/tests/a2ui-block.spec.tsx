import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { A2UIBlock, parseA2UIMessage } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { A2UIDebugBlockState, A2UIObject } from "@/types/protocol";

describe("A2UIBlock", () => {
  it("renders created built-in chart objects with title, status and chart body", () => {
    render(
      <A2UIBlock
        message={a2uiMessage({
          a2ui: a2uiObject({
            render_key: "chart",
            mode: "render",
            payload: {
              title: "销售趋势",
              summary: "近 4 个季度",
              charts: [
                {
                  type: "trend",
                  title: "销售趋势",
                  series: [
                    {
                      name: "收入",
                      items: [
                        { name: "Q1", value: 12 },
                        { name: "Q2", value: 18 },
                      ],
                    },
                  ],
                },
              ],
            },
            interaction: null,
          }),
        })}
      />,
    );

    expect(screen.getByTestId("a2ui-block").getAttribute("data-render-key")).toBe("chart");
    expect(screen.getAllByText("销售趋势")).toHaveLength(1);
    expect(screen.getByText("已生成")).toBeTruthy();
    expect(screen.getByText("近 4 个季度")).toBeTruthy();
    expect(screen.getByTestId("a2ui-chart-panel").getAttribute("data-chart-type")).toBe("trend");
  });

  it("treats a completed render a2ui object as created even when debug status is finished", () => {
    const chart = a2uiObject({
      render_key: "chart",
      mode: "render",
      payload: {
        title: "最终图表",
        charts: [
          {
            type: "column",
            title: "最终图表",
            series: [
              {
                name: "数量",
                items: [{ name: "A", value: 10 }],
              },
            ],
          },
        ],
      },
      interaction: null,
    });
    const { rerender } = render(
      <A2UIBlock
        message={a2uiMessage({
          a2ui: chart,
          debug: a2uiDebug({
            a2ui: chart,
            status: "finished",
            chunkCount: 8,
            argsBuffer: JSON.stringify(chart.payload),
            parsedArgs: chart.payload,
          }),
        })}
      />,
    );

    expect(screen.getByTestId("a2ui-block").getAttribute("data-status")).toBe("created");
    expect(screen.getByText("已生成")).toBeTruthy();
    const surface = screen.getByTestId("a2ui-echarts-surface");
    expect(surface.getAttribute("data-a2ui-chart-engine")).toBe("echarts");
    expect(surface.getAttribute("data-a2ui-chart-data-count")).toBe("1");

    rerender(
      <A2UIBlock
        message={a2uiMessage({
          a2ui: chart,
          debug: a2uiDebug({
            a2ui: chart,
            status: "created",
            chunkCount: 8,
            argsBuffer: JSON.stringify(chart.payload),
            parsedArgs: chart.payload,
          }),
        })}
      />,
    );

    expect(screen.getByTestId("a2ui-block").getAttribute("data-status")).toBe("created");
    expect(screen.getByTestId("a2ui-echarts-surface")).toBe(surface);
  });

  it("renders streaming debug buffers before a created object is complete", () => {
    render(
      <A2UIBlock
        message={a2uiMessage({
          a2ui: null,
          debug: a2uiDebug({
            a2ui: undefined,
            status: "streaming",
            renderKey: "confirm",
            mode: "interactive",
            argsBuffer: '{"title":"确认删除"',
            jsonParseStatus: "partial",
          }),
        })}
      />,
    );

    expect(screen.getByTestId("a2ui-block").getAttribute("data-status")).toBe("streaming");
    expect(screen.getByText("生成中")).toBeTruthy();
    expect(screen.getByTestId("a2ui-stream-preview").textContent).toContain('"title":"确认删除"');
  });

  it("uses the streamed chart type for an empty chart skeleton", () => {
    render(
      <A2UIBlock
        message={a2uiMessage({
          a2ui: null,
          debug: a2uiDebug({
            a2ui: undefined,
            status: "streaming",
            renderKey: "chart",
            mode: "render",
            parsedArgs: {
              title: "市场份额",
              charts: [{ type: "pie" }],
            },
            payload: {
              title: "市场份额",
              charts: [{ type: "pie" }],
            },
            argsBuffer: '{"title":"市场份额","charts":[{"type":"pie"',
            jsonParseStatus: "partial",
          }),
        })}
      />,
    );

    const skeleton = screen.getByTestId("a2ui-chart-skeleton");
    expect(skeleton.getAttribute("data-chart-skeleton-type")).toBe("pie");
    expect(skeleton.getAttribute("aria-label")).toBe("饼图生成中");
  });

  it("replaces a failed streaming chart with a lightweight error line", () => {
    render(
      <A2UIBlock
        message={a2uiMessage({
          a2ui: null,
          debug: a2uiDebug({
            a2ui: undefined,
            status: "failed",
            renderKey: "chart",
            mode: "render",
            argsBuffer: '{"title":"错误图表"',
            error: "$.charts[0].items[0].value: expected number",
            finishReason: "tool_error",
            jsonParseStatus: "invalid",
          }),
        })}
      />,
    );

    expect(screen.getByTestId("a2ui-block").getAttribute("data-status")).toBe("failed");
    expect(screen.getByTestId("a2ui-error-line").textContent).toContain("A2UI 渲染失败，等待重新生成");
    expect(screen.queryByTestId("a2ui-chart-panel")).toBeNull();
    expect(screen.queryByTestId("a2ui-stream-preview")).toBeNull();
  });

  it("normalizes waiting interaction status for interactive cards", () => {
    const message = a2uiMessage();

    expect(parseA2UIMessage(message)).toMatchObject({
      renderKey: "confirm",
      mode: "interactive",
      status: "waiting_input",
      interactionId: "int-1",
    });

    render(<A2UIBlock message={message} onSubmit={() => undefined} onCancel={() => undefined} />);

    expect(screen.getByTestId("a2ui-block").getAttribute("data-interactive-ready")).toBe("true");
    expect(screen.getByText("等待输入")).toBeTruthy();
  });
});

function a2uiMessage(options: { a2ui?: A2UIObject | null; debug?: A2UIDebugBlockState } = {}): ConversationMessage {
  const a2ui = options.a2ui === undefined ? a2uiObject() : options.a2ui;
  const debug = options.debug ?? (a2ui ? a2uiDebug({ a2ui }) : a2uiDebug());
  return {
    id: "agent:a2ui-1",
    threadId: "ses-1",
    turnId: null,
    itemId: "a2ui-1",
    kind: "a2ui",
    status: "pending",
    content: "",
    payload: {
      a2ui,
      a2uiDebug: debug,
      interaction: a2ui?.interaction,
      interactionId: a2ui?.interaction?.interaction_id,
      renderKey: a2ui?.render_key ?? debug.renderKey,
      streamId: a2ui?.stream_id ?? debug.streamId,
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function a2uiObject(patch: Partial<A2UIObject> = {}): A2UIObject {
  return {
    render_key: "confirm",
    mode: "interactive",
    stream_id: "stream-1",
    tool_call_id: "tool-1",
    trace_id: "trace-1",
    turn_index: 1,
    payload: {
      title: "确认发布",
      description: "发布后用户可见",
    },
    input_schema: {},
    submit_schema: {},
    interaction: {
      interaction_id: "int-1",
      status: "waiting_user_input",
      can_submit: true,
    },
    ...patch,
  };
}

function a2uiDebug(patch: Partial<A2UIDebugBlockState> = {}): A2UIDebugBlockState {
  const hasA2UI = Object.prototype.hasOwnProperty.call(patch, "a2ui");
  const a2ui = (hasA2UI ? patch.a2ui : a2uiObject()) as A2UIObject | undefined;
  return {
    id: "stream-1",
    status: "created",
    renderKey: a2ui?.render_key,
    mode: a2ui?.mode,
    streamId: a2ui?.stream_id,
    interactionId: a2ui?.interaction?.interaction_id,
    toolCallId: a2ui?.tool_call_id,
    traceId: a2ui?.trace_id,
    turnIndex: a2ui?.turn_index ?? undefined,
    chunkCount: 0,
    argsBuffer: "",
    argsTextLength: 0,
    jsonParseStatus: "valid",
    a2ui,
    payload: a2ui?.payload,
    inputSchema: a2ui?.input_schema,
    submitSchema: a2ui?.submit_schema,
    interaction: a2ui?.interaction ?? undefined,
    rawEvents: [],
    updatedAt: 1_700_000_000_000,
    ...patch,
  };
}
