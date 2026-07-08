import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { A2UIBlock } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { A2UIDebugBlockState, A2UIObject } from "@/types/protocol";

describe("A2ChartBlock", () => {
  it("renders one SDK chart payload with column, trend, pie and funnel panels", () => {
    const { container } = render(
      <A2UIBlock
        message={chartMessage({
          title: "组合图表",
          summary: "数据截止到今天",
          charts: [
            {
              type: "column",
              title: "渠道表现",
              series: [
                {
                  name: "点击",
                  items: [
                    { name: "微信", value: 120 },
                    { name: "抖音", value: 90 },
                  ],
                },
                {
                  name: "转化",
                  items: [
                    { name: "微信", value: 32 },
                    { name: "抖音", value: 18 },
                  ],
                },
              ],
            },
            {
              type: "trend",
              title: "成交趋势",
              series: [
                {
                  name: "成交",
                  items: [
                    { name: "周一", value: 1 },
                    { name: "周二", value: 3 },
                    { name: "周三", value: 2 },
                  ],
                },
              ],
            },
            {
              type: "pie",
              title: "客群占比",
              items: [
                { name: "新客", value: 40, color: "#2563eb" },
                { name: "老客", value: 60, color: "#16a34a" },
              ],
            },
            {
              type: "funnel",
              title: "转化漏斗",
              items: [
                { name: "曝光", value: 1000, ratio: 100 },
                { name: "点击", value: 360, ratio: 36 },
              ],
            },
          ],
        })}
      />,
    );

    const panels = screen.getAllByTestId("a2ui-chart-panel");
    expect(panels.map((panel) => panel.getAttribute("data-chart-type"))).toEqual([
      "column",
      "trend",
      "pie",
      "funnel",
    ]);
    expect(screen.getAllByText("组合图表")).toHaveLength(1);
    expect(screen.getByText("数据截止到今天")).not.toBeNull();
    const surfaces = screen.getAllByTestId("a2ui-echarts-surface");
    expect(surfaces).toHaveLength(4);
    expect(surfaces.map((surface) => surface.getAttribute("data-chart-type"))).toEqual([
      "column",
      "trend",
      "pie",
      "funnel",
    ]);
    expect(surfaces.every((surface) => surface.getAttribute("data-a2ui-chart-engine") === "echarts")).toBe(true);
      expect(surfaces[0].getAttribute("data-a2ui-chart-data-count")).toBe("4");
      expect(surfaces[0].getAttribute("data-a2ui-chart-category-count")).toBe("2");
      expect(surfaces[1].getAttribute("data-a2ui-chart-data-count")).toBe("3");
      expect(surfaces[1].getAttribute("data-a2ui-chart-category-count")).toBe("3");
    expect(surfaces[2].getAttribute("data-a2ui-chart-data-count")).toBe("2");
    expect(surfaces[3].getAttribute("data-a2ui-chart-data-count")).toBe("2");
    expect(surfaces[1].getAttribute("data-a2ui-chart-interactions")).toBe("tooltip,axisPointer,legendToggle");
    expect(surfaces[1].getAttribute("data-a2ui-chart-tooltip")).toBe("axis");
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("does not render legacy single-chart payloads", () => {
    render(
      <A2UIBlock
        message={chartMessage({
          title: "旧格式",
          chart_type: "column",
          categories: ["微信", "抖音"],
          series: [{ name: "点击", data: [120, 90] }],
        })}
      />,
    );

    expect(screen.getByText("暂无图表数据")).not.toBeNull();
    expect(screen.queryByTestId("a2ui-chart-panel")).toBeNull();
  });

  it("shows empty and streaming skeleton states without legacy type fallback", () => {
    const { rerender } = render(
      <A2UIBlock
        message={chartMessage({
          title: "空图表",
          charts: [],
        })}
      />,
    );

    expect(screen.getByText("暂无图表数据")).not.toBeNull();

    rerender(<A2UIBlock message={streamingChartMessage()} />);

    const skeleton = screen.getByTestId("a2ui-chart-skeleton");
    expect(skeleton.getAttribute("data-chart-skeleton-type")).toBe("pie");
    expect(skeleton.getAttribute("aria-label")).toBe("饼图生成中");
    expect(screen.queryByTestId("a2ui-stream-preview")).toBeNull();
  });

  it("keeps multi-chart shells visible while streaming before data arrives", () => {
    render(
      <A2UIBlock
        message={streamingChartMessage(
          { title: "多图生成中" },
          '{"title":"多图生成中","charts":[{"type":"column","title":"渠道"},{"type":"pie","title":"占比"},{"type":"funnel","title":"漏斗"}',
        )}
      />,
    );

    const panels = screen.getAllByTestId("a2ui-chart-panel");
    expect(panels.map((panel) => panel.getAttribute("data-chart-type"))).toEqual([
      "column",
      "pie",
      "funnel",
    ]);
    expect(screen.getAllByTestId("a2ui-chart-skeleton")).toHaveLength(3);
    expect(screen.queryByText("暂无图表数据")).toBeNull();
  });

  it("reveals streamed multi-chart payloads in parallel inside each chart", () => {
    vi.useFakeTimers();
    const restoreRaf = installTimerBackedRaf();
    try {
      render(
        <A2UIBlock
          message={streamedCreatedChartMessage({
            title: "并行多图",
            charts: [
              {
                type: "column",
                title: "用户转化",
                series: [
                  {
                    name: "访问",
                    items: [
                      { name: "首页", value: 100 },
                      { name: "注册", value: 65 },
                    ],
                  },
                ],
              },
              {
                type: "column",
                title: "项目转化",
                series: [
                  {
                    name: "项目",
                    items: [
                      { name: "创建", value: 38 },
                      { name: "完成", value: 21 },
                      { name: "复用", value: 12 },
                    ],
                  },
                ],
              },
            ],
          })}
        />,
      );

      const panels = screen.getAllByTestId("a2ui-chart-panel");
      expect(panels).toHaveLength(2);
      expect(totalChartDataCount()).toBe(1);
      expect(screen.getByTestId("a2ui-echarts-surface").getAttribute("data-a2ui-chart-category-count")).toBe("1");

      act(() => {
        vi.advanceTimersByTime(1_600);
      });

      expect(chartDataCounts()).toEqual([2, 3]);
    } finally {
      restoreRaf();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not drop rendered chart panels during streaming parse gaps", () => {
    const stablePayload = {
      title: "解析缺口",
      charts: [
        {
          type: "column",
          title: "稳定图表",
          series: [
            {
              name: "数量",
              items: [{ name: "A", value: 10 }],
            },
          ],
        },
      ],
    };
    const { rerender } = render(<A2UIBlock message={streamingChartMessage(stablePayload)} />);

    expect(screen.getByTestId("a2ui-chart-panel")).not.toBeNull();
    expect(screen.getByTestId("a2ui-echarts-surface").getAttribute("data-a2ui-chart-data-count")).toBe("1");

    rerender(<A2UIBlock message={streamingChartMessage({ title: "解析缺口" }, '{"title":"解析缺口","charts":[')} />);

    expect(screen.getByTestId("a2ui-chart-panel")).not.toBeNull();
    expect(screen.getByTestId("a2ui-echarts-surface").getAttribute("data-a2ui-chart-data-count")).toBe("1");
    expect(screen.queryByText("暂无图表数据")).toBeNull();
  });

  it("does not shrink already revealed chart items when a later stream parse is shorter", () => {
    vi.useFakeTimers();
    const restoreRaf = installTimerBackedRaf();
    try {
      const fullPayload = {
        title: "流式回退保护",
        charts: [
          {
            type: "column",
            title: "横向数据",
            series: [
              {
                name: "数量",
                items: [
                  { name: "A", value: 10 },
                  { name: "B", value: 20 },
                  { name: "C", value: 30 },
                  { name: "D", value: 40 },
                ],
              },
            ],
          },
        ],
      };
      const shorterPayload = {
        title: "流式回退保护",
        charts: [
          {
            type: "column",
            title: "横向数据",
            series: [
              {
                name: "数量",
                items: [{ name: "A", value: 10 }],
              },
            ],
          },
        ],
      };

      const { rerender } = render(<A2UIBlock message={streamingChartMessage(fullPayload)} />);

      act(() => {
        vi.advanceTimersByTime(1_200);
      });
      expect(chartDataCounts()).toEqual([4]);

      rerender(<A2UIBlock message={streamingChartMessage(shorterPayload)} />);
      expect(chartDataCounts()).toEqual([4]);

      rerender(<A2UIBlock message={streamedCreatedChartMessage(fullPayload, "stream-chart-stream", "tool-chart-stream")} />);
      expect(chartDataCounts()).toEqual([4]);
      expect(screen.getByTestId("a2ui-chart").getAttribute("data-a2ui-reveal-visible")).toBe("4");
    } finally {
      restoreRaf();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps the rendered chart visible when a terminal stream update has no final payload yet", () => {
    vi.useFakeTimers();
    const restoreRaf = installTimerBackedRaf();
    try {
      const fullPayload = {
        title: "终态空包保护",
        charts: [
          {
            type: "column",
            title: "完整数据",
            series: [
              {
                name: "数量",
                items: [
                  { name: "A", value: 10 },
                  { name: "B", value: 20 },
                  { name: "C", value: 30 },
                  { name: "D", value: 40 },
                ],
              },
            ],
          },
        ],
      };
      const { rerender } = render(
        <A2UIBlock message={streamedCreatedChartMessage(fullPayload, "stream-chart-terminal", "tool-chart-terminal")} />,
      );

      act(() => {
        vi.advanceTimersByTime(1_200);
      });
      expect(chartDataCounts()).toEqual([4]);

      rerender(<A2UIBlock message={terminalEmptyChartMessage("stream-chart-terminal", "tool-chart-terminal")} />);

      expect(chartDataCounts()).toEqual([4]);
      expect(screen.queryByTestId("a2ui-chart-skeleton")).toBeNull();
      expect(screen.queryByText("暂无图表数据")).toBeNull();
    } finally {
      restoreRaf();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not flash back to skeleton when a stable stream receives new chart items", () => {
    vi.useFakeTimers();
    const restoreRaf = installTimerBackedRaf();
    try {
      const firstPayload = {
        title: "稳定增长",
        charts: [
          {
            type: "column",
            title: "新增数据",
            series: [
              {
                name: "数量",
                items: [{ name: "A", value: 10 }],
              },
            ],
          },
        ],
      };
      const secondPayload = {
        title: "稳定增长",
        charts: [
          {
            type: "column",
            title: "新增数据",
            series: [
              {
                name: "数量",
                items: [
                  { name: "A", value: 10 },
                  { name: "B", value: 20 },
                ],
              },
            ],
          },
        ],
      };
      const { rerender } = render(
        <A2UIBlock message={withDebugId(streamingChartMessage(firstPayload), "chunk-1")} />,
      );

      expect(chartDataCounts()).toEqual([1]);
      expect(screen.queryByTestId("a2ui-chart-skeleton")).toBeNull();

      rerender(<A2UIBlock message={withDebugId(streamingChartMessage(secondPayload), "chunk-2")} />);

      expect(chartDataCounts()).toEqual([1]);
      expect(screen.queryByTestId("a2ui-chart-skeleton")).toBeNull();

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(chartDataCounts()).toEqual([2]);
      expect(screen.queryByTestId("a2ui-chart-skeleton")).toBeNull();
    } finally {
      restoreRaf();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("reveals streamed created chart payloads element by element", () => {
    vi.useFakeTimers();
    const restoreRaf = installTimerBackedRaf();
    try {
      render(
        <A2UIBlock
          message={streamedCreatedChartMessage({
            title: "流式柱状图",
            charts: [
              {
                type: "column",
                title: "每月活跃用户",
                series: [
                  {
                    name: "活跃用户",
                    items: [
                      { name: "1月", value: 100 },
                      { name: "2月", value: 180 },
                      { name: "3月", value: 260 },
                    ],
                  },
                  {
                    name: "新增用户",
                    items: [
                      { name: "1月", value: 30 },
                      { name: "2月", value: 60 },
                      { name: "3月", value: 90 },
                    ],
                  },
                ],
              },
            ],
          })}
        />,
      );

      expect(chartDataCounts()[0]).toBeGreaterThan(0);
      expect(chartDataCounts()[0]).toBeLessThan(6);

      act(() => {
        vi.advanceTimersByTime(1_600);
      });

      expect(chartDataCounts()).toEqual([6]);
    } finally {
      restoreRaf();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

function installTimerBackedRaf(): () => void {
  const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => (
    window.setTimeout(() => callback(performance.now()), 0) as unknown as number
  ));
  const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
    window.clearTimeout(handle);
  });
  return () => {
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  };
}

function chartDataCounts(): number[] {
  return screen
    .getAllByTestId("a2ui-echarts-surface")
    .map((surface) => Number(surface.getAttribute("data-a2ui-chart-data-count")));
}

function totalChartDataCount(): number {
  return chartDataCounts().reduce((sum, count) => sum + count, 0);
}

function withDebugId(message: ConversationMessage, id: string): ConversationMessage {
  const debug = message.payload.a2uiDebug as A2UIDebugBlockState;
  return {
    ...message,
    payload: {
      ...message.payload,
      a2uiDebug: {
        ...debug,
        id,
      },
    },
  };
}

function chartMessage(payload: Record<string, unknown>): ConversationMessage {
  const a2ui = chartObject(payload);
  return {
    id: "agent:a2ui-chart-1",
    threadId: "ses-1",
    turnId: null,
    itemId: "a2ui-chart-1",
    kind: "a2ui",
    status: "completed",
    content: "",
    payload: {
      a2ui,
      a2uiDebug: chartDebug(a2ui),
      renderKey: "chart",
      streamId: "stream-chart-1",
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function chartObject(
  payload: Record<string, unknown>,
  streamId = "stream-chart-1",
  toolCallId = "tool-chart-1",
): A2UIObject {
  return {
    render_key: "chart",
    mode: "render",
    stream_id: streamId,
    tool_call_id: toolCallId,
    trace_id: "trace-1",
    turn_index: 1,
    payload,
    input_schema: {},
    submit_schema: {},
  };
}

function chartDebug(a2ui: A2UIObject): A2UIDebugBlockState {
  return {
    id: a2ui.stream_id,
    status: "created",
    renderKey: "chart",
    mode: "render",
    streamId: a2ui.stream_id,
    toolCallId: a2ui.tool_call_id ?? null,
    traceId: a2ui.trace_id ?? null,
    turnIndex: a2ui.turn_index ?? null,
    chunkCount: 0,
    argsBuffer: "",
    argsTextLength: 0,
    jsonParseStatus: "valid",
    a2ui,
    payload: a2ui.payload,
    inputSchema: a2ui.input_schema,
    submitSchema: a2ui.submit_schema,
    rawEvents: [],
    updatedAt: 1_700_000_000_000,
  };
}

function streamingChartMessage(
  payload: Record<string, unknown> = { title: "市场份额", charts: [{ type: "pie" }] },
  argsBuffer = JSON.stringify(payload).slice(0, -1),
): ConversationMessage {
  return {
    id: "agent:a2ui-chart-stream",
    threadId: "ses-1",
    turnId: null,
    itemId: "a2ui-chart-stream",
    kind: "a2ui",
    status: "pending",
    content: "",
    payload: {
      a2ui: null,
      a2uiDebug: {
        id: "stream-chart-stream",
        status: "streaming",
        renderKey: "chart",
        mode: "render",
        streamId: "stream-chart-stream",
        toolCallId: "tool-chart-stream",
        traceId: "trace-stream",
        turnIndex: 1,
        chunkCount: 1,
        argsBuffer,
        argsTextLength: argsBuffer.length,
        jsonParseStatus: "partial",
        parsedArgs: payload,
        payload,
        rawEvents: [],
        updatedAt: 1_700_000_000_000,
      },
      renderKey: "chart",
      streamId: "stream-chart-stream",
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function streamedCreatedChartMessage(
  payload: Record<string, unknown>,
  streamId = "stream-chart-1",
  toolCallId = "tool-chart-1",
): ConversationMessage {
  const a2ui = chartObject(payload, streamId, toolCallId);
  const argsBuffer = JSON.stringify(payload);
  return {
    id: "agent:a2ui-chart-streamed-created",
    threadId: "ses-1",
    turnId: null,
    itemId: "a2ui-chart-streamed-created",
    kind: "a2ui",
    status: "completed",
    content: "",
    payload: {
      a2ui,
      a2uiDebug: {
        ...chartDebug(a2ui),
        chunkCount: 154,
        argsBuffer,
        argsTextLength: argsBuffer.length,
        jsonParseStatus: "valid",
        parsedArgs: payload,
        rawEvents: [
          {
            id: "chunk-1",
            action: "a2ui_stream_chunk",
            timestamp: 1_700_000_000_001,
            data: { stream: { args_delta: argsBuffer.slice(0, 12) } },
          },
        ],
      },
      renderKey: "chart",
      streamId: "stream-chart-1",
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function terminalEmptyChartMessage(
  streamId: string,
  toolCallId: string,
): ConversationMessage {
  return {
    id: "agent:a2ui-chart-terminal-empty",
    threadId: "ses-1",
    turnId: null,
    itemId: "a2ui-chart-terminal-empty",
    kind: "a2ui",
    status: "completed",
    content: "",
    payload: {
      a2ui: null,
      a2uiDebug: {
        id: streamId,
        status: "created",
        renderKey: "chart",
        mode: "render",
        streamId,
        toolCallId,
        traceId: "trace-stream",
        turnIndex: 1,
        chunkCount: 154,
        argsBuffer: "",
        argsTextLength: 0,
        jsonParseStatus: "empty",
        payload: {},
        rawEvents: [],
        updatedAt: 1_700_000_000_050,
      },
      renderKey: "chart",
      streamId,
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}
