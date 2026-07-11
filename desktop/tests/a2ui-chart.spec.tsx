import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { A2UIBlock } from "@/renderer/pages/conversation/messages";
import type { ParsedA2UIMessage } from "@/renderer/pages/conversation/messages/a2ui/A2UIBlock";
import { A2ChartBlock } from "@/renderer/pages/conversation/messages/a2ui/A2ChartBlock";
import { resolveA2UIRenderState } from "@/renderer/pages/conversation/messages/a2ui/A2UIState";
import { resetA2UIStreamPlayerPlaybackForTests } from "@/renderer/pages/conversation/messages/a2ui/useA2UIStreamPlayer";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { A2UIDebugBlockState, A2UIObject } from "@/types/protocol";

const echartsMock = vi.hoisted(() => {
  const setOption = vi.fn();
  const resize = vi.fn();
  const dispose = vi.fn();
  const on = vi.fn();
  const off = vi.fn();
  const init = vi.fn((container: HTMLElement) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    container.appendChild(svg);
    return { dispose, off, on, resize, setOption };
  });
  return { dispose, init, off, on, resize, setOption };
});

vi.mock("echarts", () => ({
  init: echartsMock.init,
}));

describe("A2ChartBlock", () => {
  beforeEach(() => {
    resetA2UIStreamPlayerPlaybackForTests();
    echartsMock.dispose.mockClear();
    echartsMock.init.mockClear();
    echartsMock.off.mockClear();
    echartsMock.on.mockClear();
    echartsMock.resize.mockClear();
    echartsMock.setOption.mockClear();
  });

  it("renders one SDK chart payload with column, trend and pie panels", () => {
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
          ],
        })}
      />,
    );

    const panels = screen.getAllByTestId("a2ui-chart-panel");
    expect(panels.map((panel) => panel.getAttribute("data-chart-type"))).toEqual([
      "column",
      "trend",
      "pie",
    ]);
    expect(screen.getAllByText("组合图表")).toHaveLength(1);
    const summary = screen.getByText("数据截止到今天");
    expect(summary).not.toBeNull();
    expect(summary.compareDocumentPosition(panels[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const surfaces = screen.getAllByTestId("a2ui-echarts-surface");
    expect(surfaces).toHaveLength(3);
    expect(surfaces.map((surface) => surface.getAttribute("data-chart-type"))).toEqual([
      "column",
      "trend",
      "pie",
    ]);
    expect(surfaces.every((surface) => surface.getAttribute("data-a2ui-chart-engine") === "echarts")).toBe(true);
    expect(surfaces.every((surface) => surface.getAttribute("data-a2ui-chart-stream-adapter") === "setOption-diff")).toBe(true);
    expect(surfaces[0].getAttribute("data-a2ui-chart-data-count")).toBe("4");
    expect(surfaces[0].getAttribute("data-a2ui-chart-category-count")).toBe("2");
    expect(surfaces[1].getAttribute("data-a2ui-chart-data-count")).toBe("3");
    expect(surfaces[1].getAttribute("data-a2ui-chart-category-count")).toBe("3");
    expect(surfaces[2].getAttribute("data-a2ui-chart-data-count")).toBe("2");
    expect(surfaces[1].getAttribute("data-a2ui-chart-interactions")).toBe("tooltip,axisPointer,legendToggle");
    expect(surfaces[1].getAttribute("data-a2ui-chart-tooltip")).toBe("axis");
    expect(surfaces.every((surface) => surface.getAttribute("data-a2ui-chart-renderer") === "svg")).toBe(true);
    expect(echartsMock.setOption.mock.calls.every(([option]) => (option as Record<string, unknown>).animation === false)).toBe(true);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders sankey chart panels with bounded labels and ECharts structure series", () => {
    render(
      <A2UIBlock
        message={chartMessage({
          title: "结构图表",
          charts: [
            {
              type: "sankey",
              title: "用户转化流向",
              unit: "人",
              nodes: [
                { name: "访问首页", color: "#2563eb" },
                { name: "注册" },
                { name: "创建项目" },
              ],
              links: [
                { source: "访问首页", target: "注册", value: 650 },
                { source: "注册", target: "创建项目", value: 380 },
              ],
            },
          ],
        })}
      />,
    );

    const panels = screen.getAllByTestId("a2ui-chart-panel");
    expect(panels.map((panel) => panel.getAttribute("data-chart-type"))).toEqual([
      "sankey",
    ]);
    const surfaces = screen.getAllByTestId("a2ui-echarts-surface");
    expect(surfaces.map((surface) => surface.getAttribute("data-chart-type"))).toEqual([
      "sankey",
    ]);
    expect(surfaces[0].getAttribute("data-a2ui-chart-data-count")).toBe("5");
    expect(surfaces[0].getAttribute("data-a2ui-chart-interactions")).toBe("tooltip,adjacencyFocus,dragNode");

    const sankeyOption = echartsMock.setOption.mock.calls[0][0] as {
      series?: Array<Record<string, unknown>>;
      tooltip?: { formatter?: (params: unknown) => string };
    };
    const sankeySeries = sankeyOption.series?.[0] as {
      data?: Array<{ name?: string; itemStyle?: Record<string, unknown> }>;
      label?: { overflow?: string; width?: number };
      labelLayout?: (params: unknown) => Record<string, unknown>;
      links?: Array<{ source?: string; target?: string; value?: number }>;
      type?: string;
    };
    expect(sankeySeries.type).toBe("sankey");
    expect(sankeySeries.data?.map((item) => item.name)).toEqual(["访问首页", "注册", "创建项目"]);
    expect(sankeySeries.data?.[0].itemStyle).toMatchObject({ color: "#2563eb" });
    expect(sankeySeries.links).toMatchObject([
      { source: "访问首页", target: "注册", value: 650 },
      { source: "注册", target: "创建项目", value: 380 },
    ]);
    expect(sankeySeries.label).toMatchObject({ overflow: "truncate", width: 124 });
    expect(typeof sankeySeries.labelLayout).toBe("function");
    expect(sankeySeries.labelLayout?.({
      labelRect: { height: 16, width: 124, x: 560, y: 0 },
      rect: { height: 16, width: 14, x: 590, y: 0 },
    })).toMatchObject({
      align: "right",
      hideOverlap: true,
      x: 488,
    });
    expect(sankeyOption.tooltip?.formatter?.({
      data: { source: "访问首页", target: "注册", value: 650 },
      marker: "",
    })).toContain("访问首页 → 注册");
  });

  it("maps chart enhancement fields to ECharts options", () => {
    render(
      <A2UIBlock
        message={chartMessage({
          title: "增强图表",
          charts: [
            {
              type: "trend",
              title: "收入趋势",
              unit: "万元",
              precision: 1,
              smooth: false,
              zoom: true,
              series: [
                {
                  name: "收入",
                  items: Array.from({ length: 20 }, (_, index) => ({
                    name: `${index + 1}月`,
                    value: 80 + index,
                  })),
                },
              ],
            },
            {
              type: "column",
              title: "渠道对比",
              suffix: "人",
              mode: "stacked",
              sort: "desc",
              show_labels: "always",
              series: [
                {
                  name: "访问",
                  items: [
                    { name: "A", value: 10 },
                    { name: "B", value: 20 },
                    { name: "C", value: 5 },
                  ],
                },
                {
                  name: "转化",
                  items: [
                    { name: "A", value: 5 },
                    { name: "B", value: 1 },
                    { name: "C", value: 30 },
                  ],
                },
              ],
            },
            {
              type: "pie",
              title: "占比",
              value_format: "percent",
              precision: 1,
              show_percent: true,
              sort: "desc",
              items: [
                { name: "低", value: 0.2 },
                { name: "高", value: 0.6 },
              ],
            },
          ],
        })}
      />,
    );

    const trendOption = echartsMock.setOption.mock.calls[0][0] as {
      dataZoom?: unknown[];
      series?: Array<Record<string, unknown>>;
      tooltip?: { formatter?: (params: unknown) => string };
      yAxis?: { axisLabel?: { formatter?: (value: unknown) => string } };
    };
    expect(trendOption.dataZoom).toHaveLength(2);
    expect(trendOption.series?.[0]).toMatchObject({
      smooth: false,
    });
    expect(trendOption.yAxis?.axisLabel?.formatter?.(123.4)).toBe("123.4万元");
    expect(trendOption.tooltip?.formatter?.([{ axisValueLabel: "1月", marker: "", seriesName: "收入", value: 123.4 }])).toContain("123.4万元");

    const columnOption = echartsMock.setOption.mock.calls[1][0] as {
      series?: Array<Record<string, unknown>>;
      xAxis?: { data?: string[] };
    };
    expect(columnOption.xAxis?.data).toEqual(["C", "B", "A"]);
    expect(columnOption.series?.[0]).toMatchObject({
      cursor: "pointer",
      emphasis: {
        itemStyle: {
          shadowBlur: 12,
        },
      },
      label: { show: true },
      stack: "total",
    });
    expect(columnOption.series?.[0].selectedMode).toBeUndefined();
    expect(columnOption.series?.[0].select).toBeUndefined();
    expect((columnOption.series?.[0].emphasis as { itemStyle?: Record<string, unknown> } | undefined)?.itemStyle?.borderColor).toBeUndefined();
    expect((columnOption.series?.[0].emphasis as { itemStyle?: Record<string, unknown> } | undefined)?.itemStyle?.borderWidth).toBeUndefined();
    expect((columnOption.series?.[0].itemStyle as Record<string, unknown> | undefined)?.borderColor).toBe("transparent");
    expect((columnOption.series?.[0].itemStyle as Record<string, unknown> | undefined)?.borderWidth).toBe(0);

    const pieOption = echartsMock.setOption.mock.calls[2][0] as {
      series?: Array<{ data?: Array<{ name?: string }>; radius?: string[] }>;
      tooltip?: { formatter?: (params: unknown) => string };
    };
    expect(pieOption.series?.[0].radius).toEqual(["42%", "68%"]);
    expect(pieOption.series?.[0].data?.map((item) => item.name)).toEqual(["高", "低"]);
    const pieTooltip = pieOption.tooltip?.formatter?.({ marker: "", name: "高", percent: 60, seriesName: "占比", value: 0.6 }) ?? "";
    expect(pieTooltip).toContain("60%");
    expect(pieTooltip).not.toContain("60% · 60%");
  });

  it("uses custom multi-item selection for column and pie charts without ECharts selection borders", () => {
    render(
      <A2UIBlock
        message={chartMessage({
          title: "可选图表",
          charts: [
            {
              type: "column",
              title: "柱状",
              series: [
                {
                  name: "访问",
                  items: [
                    { name: "A", value: 10 },
                    { name: "B", value: 20 },
                  ],
                },
              ],
            },
            {
              type: "pie",
              title: "占比",
              items: [
                { name: "新客", value: 40, color: "#2563eb" },
                { name: "老客", value: 60, color: "#16a34a" },
              ],
            },
          ],
        })}
      />,
    );

    const clickHandlers = echartsMock.on.mock.calls
      .filter(([event]) => event === "click")
      .map(([, handler]) => handler as (params: unknown) => void);
    expect(clickHandlers).toHaveLength(2);

    act(() => {
      clickHandlers.forEach((handler) => handler({ dataIndex: 1, seriesIndex: 0, seriesType: "bar" }));
    });

    const selectedColumnSeries = optionSeries(lastSetOption())[0];
    const selectedColumnData = selectedColumnSeries.data as Array<{ itemStyle?: Record<string, unknown>; label?: Record<string, unknown> }>;
    expect(selectedColumnSeries.selectedMode).toBeUndefined();
    expect(selectedColumnSeries.select).toBeUndefined();
    expect(selectedColumnData[0].itemStyle).toMatchObject({
      borderColor: "transparent",
      borderWidth: 0,
      opacity: 0.36,
    });
    expect(selectedColumnData[0].itemStyle?.color).toBeUndefined();
    expect(selectedColumnData[1].itemStyle).toBeUndefined();
    expect(selectedColumnData[1].label).toBeUndefined();

    act(() => {
      clickHandlers.forEach((handler) => handler({ dataIndex: 0, seriesIndex: 0, seriesType: "bar" }));
    });

    const multiSelectedColumnData = (optionSeries(lastSetOption())[0].data ?? []) as Array<{ itemStyle?: Record<string, unknown>; label?: Record<string, unknown> }>;
    expect(multiSelectedColumnData[0].itemStyle).toBeUndefined();
    expect(multiSelectedColumnData[1].itemStyle).toBeUndefined();

    act(() => {
      clickHandlers.forEach((handler) => handler({ dataIndex: 0, seriesIndex: 0, seriesType: "bar" }));
    });

    act(() => {
      clickHandlers.forEach((handler) => handler({ dataIndex: 0, seriesIndex: 0, seriesType: "pie" }));
    });

    const selectedPieSeries = optionSeries(lastSetOption())[0];
    const selectedPieData = selectedPieSeries.data as Array<{ itemStyle?: Record<string, unknown>; label?: Record<string, unknown> }>;
    expect(selectedPieSeries.selectedMode).toBe("multiple");
    expect(selectedPieSeries.select).toBeUndefined();
    expect(selectedPieSeries.selectedOffset).toBe(8);
    expect(selectedPieData[0]).toMatchObject({
      selected: true,
    });
    expect(selectedPieData[0].itemStyle).toMatchObject({
      borderColor: "transparent",
      borderWidth: 0,
      color: "#2563eb",
      opacity: 1,
    });
    expect(selectedPieData[0].itemStyle?.shadowBlur).toBeUndefined();
    expect(selectedPieData[0].label).toBeUndefined();
    expect(selectedPieData[1].itemStyle).toMatchObject({
      borderColor: "transparent",
      borderWidth: 0,
      color: "#16a34a",
      opacity: 0.36,
    });
  });

  it("keeps visual-heavy chart enhancements disabled by default", () => {
    render(
      <A2UIBlock
        message={chartMessage({
          title: "默认图表",
          charts: [
            {
              type: "trend",
              title: "趋势",
              series: [
                {
                  name: "访问",
                  items: Array.from({ length: 20 }, (_, index) => ({
                    name: `${index + 1}月`,
                    value: 100 + index,
                  })),
                },
              ],
            },
            {
              type: "column",
              title: "柱状",
              series: [
                {
                  name: "访问",
                  items: [
                    { name: "A", value: 10 },
                    { name: "B", value: 20 },
                  ],
                },
              ],
            },
            {
              type: "pie",
              title: "占比",
              items: [
                { name: "A", value: 40 },
                { name: "B", value: 60 },
              ],
            },
          ],
        })}
      />,
    );

    const trendOption = echartsMock.setOption.mock.calls[0][0] as {
      dataZoom?: unknown;
      series?: Array<Record<string, unknown>>;
    };
    expect(trendOption.dataZoom).toBeUndefined();
    expect(trendOption.series?.[0]).toMatchObject({
      smooth: true,
    });

    const columnOption = echartsMock.setOption.mock.calls[1][0] as {
      series?: Array<Record<string, unknown>>;
    };
    expect(columnOption.series?.[0].label).toMatchObject({ show: false });
    expect(columnOption.series?.[0].stack).toBeUndefined();

    const pieOption = echartsMock.setOption.mock.calls[2][0] as {
      series?: Array<Record<string, unknown>>;
    };
    expect(pieOption.series?.[0]).toMatchObject({
      label: { show: true },
      minAngle: 0,
      radius: ["42%", "68%"],
    });
    const pieLabel = pieOption.series?.[0].label as { formatter?: (params: unknown) => string } | undefined;
    expect(pieLabel?.formatter?.({ name: "A", percent: 40 })).toBe("A");
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

  it("does not render the removed horizontal_bar chart type", () => {
    render(
      <A2UIBlock
        message={chartMessage({
          title: "旧横向类型",
          charts: [
            {
              type: "horizontal_bar",
              title: "旧类型",
              items: [{ name: "A", value: 1 }],
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("暂无图表数据")).not.toBeNull();
    expect(screen.queryByTestId("a2ui-chart-panel")).toBeNull();
  });

  it("does not render the removed funnel chart type", () => {
    render(
      <A2UIBlock
        message={chartMessage({
          title: "旧漏斗类型",
          charts: [
            {
              type: "funnel",
              title: "旧类型",
              items: [{ name: "A", value: 1 }],
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("暂无图表数据")).not.toBeNull();
    expect(screen.queryByTestId("a2ui-chart-panel")).toBeNull();
  });

  it("does not render the removed treemap chart type", () => {
    render(
      <A2UIBlock
        message={chartMessage({
          title: "旧矩形树图",
          charts: [
            {
              type: "treemap",
              title: "旧类型",
              items: [{ name: "A", value: 1 }],
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("暂无图表数据")).not.toBeNull();
    expect(screen.queryByTestId("a2ui-chart-panel")).toBeNull();
  });

  it("shows empty and type-specific ECharts placeholder states without legacy fallback", () => {
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

    const placeholder = screen.getByTestId("a2ui-echarts-surface");
    expect(placeholder.getAttribute("data-chart-type")).toBe("pie");
    expect(placeholder.getAttribute("data-a2ui-chart-placeholder")).toBe("true");
    expect(placeholder.getAttribute("data-a2ui-chart-data-count")).toBe("0");
    expect(placeholder.getAttribute("data-a2ui-chart-interactions")).toBe("none");
    expect(placeholder.getAttribute("aria-label")).toBe("饼图生成中");
    expect(optionSeries(lastSetOption())[0]?.type).toBe("pie");
    expect(optionSeries(lastSetOption())[0]?.data).toHaveLength(4);
    expect(screen.queryByTestId("a2ui-stream-preview")).toBeNull();
  });

  it("uses the neutral dark palette for ECharts placeholders", () => {
    document.documentElement.dataset.theme = "dark";
    try {
      render(<A2UIBlock message={streamingChartMessage()} />);

      expect(lastSetOption().color).toEqual(["#444444", "#2a2a2a"]);
      expect(screen.getByTestId("a2ui-echarts-surface").getAttribute("data-a2ui-chart-placeholder")).toBe("true");
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });

  it("keeps multi-chart shells visible while streaming before data arrives", () => {
    render(
      <A2UIBlock
        message={streamingChartMessage(
          { title: "多图生成中" },
          '{"title":"多图生成中","charts":[{"type":"column","title":"渠道"},{"type":"pie","title":"占比"},{"type":"trend","title":"趋势"}',
        )}
      />,
    );

    const panels = screen.getAllByTestId("a2ui-chart-panel");
    expect(panels.map((panel) => panel.getAttribute("data-chart-type"))).toEqual([
      "column",
      "pie",
      "trend",
    ]);
    const placeholders = screen.getAllByTestId("a2ui-echarts-surface");
    expect(placeholders.map((placeholder) => placeholder.getAttribute("data-a2ui-chart-placeholder"))).toEqual([
      "true",
      "true",
      "true",
    ]);
    expect(placeholders.map((placeholder) => placeholder.getAttribute("aria-label"))).toEqual([
      "柱状图生成中",
      "饼图生成中",
      "趋势图生成中",
    ]);
    const renderedPlaceholderTypes = new Set(
      echartsMock.setOption.mock.calls.flatMap(([option]) => (
        optionSeries(option as Record<string, unknown>).map((series) => series.type)
      )),
    );
    expect(renderedPlaceholderTypes).toEqual(new Set(["bar", "pie", "line"]));
    expect(screen.queryByText("暂无图表数据")).toBeNull();
  });

  it("keeps sankey shells visible while streaming before data arrives", () => {
    render(
      <A2UIBlock
        message={streamingChartMessage(
          { title: "结构图生成中" },
          '{"title":"结构图生成中","charts":[{"type":"sankey","title":"流向"}',
        )}
      />,
    );

    const panels = screen.getAllByTestId("a2ui-chart-panel");
    expect(panels.map((panel) => panel.getAttribute("data-chart-type"))).toEqual([
      "sankey",
    ]);
    const placeholder = screen.getByTestId("a2ui-echarts-surface");
    expect(placeholder.getAttribute("data-a2ui-chart-placeholder")).toBe("true");
    expect(placeholder.getAttribute("aria-label")).toBe("桑基图生成中");
    const sankeySeries = optionSeries(lastSetOption())[0];
    expect(sankeySeries?.type).toBe("sankey");
    expect(sankeySeries?.data).toHaveLength(5);
    expect(sankeySeries?.links).toHaveLength(4);
  });

  it("reuses the ECharts instance when a placeholder receives its first streamed data", () => {
    const emptyPayload = {
      title: "流式占位",
      charts: [{ type: "trend", title: "趋势" }],
    };
    const dataPayload = {
      title: "流式占位",
      charts: [
        {
          type: "trend",
          title: "趋势",
          items: [
            { name: "A", value: 10 },
            { name: "B", value: 20 },
          ],
        },
      ],
    };
    const { rerender } = render(
      <A2ChartBlock parsed={parsedChart(emptyPayload, "waiting_created")} />,
    );

    const surface = screen.getByTestId("a2ui-echarts-surface");
    expect(surface.getAttribute("data-a2ui-chart-placeholder")).toBe("true");
    expect(echartsMock.init).toHaveBeenCalledTimes(1);
    const placeholderCallCount = echartsMock.setOption.mock.calls.length;

    rerender(<A2ChartBlock parsed={parsedChart(dataPayload, "waiting_created")} />);

    expect(screen.getByTestId("a2ui-echarts-surface")).toBe(surface);
    expect(surface.getAttribute("data-a2ui-chart-placeholder")).toBe("false");
    expect(surface.getAttribute("data-a2ui-chart-data-count")).toBe("2");
    expect(echartsMock.init).toHaveBeenCalledTimes(1);
    expect(
      echartsMock.setOption.mock.calls
        .slice(placeholderCallCount)
        .some(([option, options]) => (
          optionSeries(option as Record<string, unknown>)[0]?.type === "line"
          && (options as { notMerge?: boolean }).notMerge === true
        )),
    ).toBe(true);
  });

  it("reveals streamed multi-chart payloads in parallel inside each chart", () => {
    vi.useFakeTimers();
    const restoreRaf = installTimerBackedRaf();
    try {
      render(
        <A2UIBlock
          message={streamingChartMessage({
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
      expect(chartDataCounts()).toEqual([1, 1]);
      expect(totalChartDataCount()).toBe(2);
      expect(screen.getAllByTestId("a2ui-echarts-surface").map((surface) => surface.getAttribute("data-a2ui-chart-category-count"))).toEqual([
        "1",
        "1",
      ]);

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
            title: "柱状数据",
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
            title: "柱状数据",
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
        vi.advanceTimersByTime(1_500);
      });
      expect(chartDataCounts()).toEqual([4]);
      const surface = screen.getByTestId("a2ui-echarts-surface");

      rerender(<A2UIBlock message={streamingChartMessage(shorterPayload)} />);
      expect(chartDataCounts()).toEqual([4]);

      rerender(<A2UIBlock message={streamedCreatedChartMessage(fullPayload, "stream-chart-stream", "tool-chart-stream")} />);
      expect(chartDataCounts()).toEqual([4]);
      expect(screen.getByTestId("a2ui-echarts-surface")).toBe(surface);
      expect(screen.getByTestId("a2ui-chart").getAttribute("data-a2ui-reveal-visible")).toBe("4");
    } finally {
      restoreRaf();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("continues chart reveal instead of flushing complete data when later agent completion drops stream evidence", () => {
    vi.useFakeTimers();
    const restoreRaf = installTimerBackedRaf();
    try {
      const fullPayload = {
        title: "完成帧保护",
        charts: [
          {
            type: "column",
            title: "增长数据",
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
        <A2UIBlock message={streamingChartMessage(fullPayload)} />,
      );

      expect(chartDataCounts()).toEqual([1]);
      rerender(
        <A2UIBlock
          message={streamedCreatedChartMessageWithoutStreamEvidence(
            fullPayload,
            "stream-chart-stream",
            "tool-chart-stream",
          )}
        />,
      );

      expect(chartDataCounts()).toEqual([1]);
      expect(screen.getByTestId("a2ui-chart").getAttribute("data-a2ui-player-phase")).toBe("waiting_created");

      act(() => {
        vi.advanceTimersByTime(2_200);
      });

      expect(chartDataCounts()).toEqual([4]);
      expect(screen.getByTestId("a2ui-chart").getAttribute("data-a2ui-player-phase")).toBe("created");
    } finally {
      restoreRaf();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not replay ECharts animation when a stream-backed chart settles", () => {
    const activePayload = {
      title: "终态动画保护",
      charts: [
        {
          type: "column",
          title: "增长数据",
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
    const settledPayload = {
      ...activePayload,
      charts: [
        {
          ...activePayload.charts[0],
          title: "增长数据（终态）",
        },
      ],
    };

    const { rerender } = render(<A2ChartBlock parsed={parsedChart(activePayload, "waiting_created")} />);

    const surface = screen.getByTestId("a2ui-echarts-surface");
    expect(surface.getAttribute("data-a2ui-chart-animation")).toBe("enabled");
    expect(lastSetOption().animation).toBe(true);

    rerender(<A2ChartBlock parsed={parsedChart(settledPayload, "created")} />);

    expect(screen.getByTestId("a2ui-echarts-surface")).toBe(surface);
    expect(surface.getAttribute("data-a2ui-chart-animation")).toBe("settled");
    const terminalOption = lastSetOption();
    expect(terminalOption.animation).toBe(false);
    expect(terminalOption.animationDuration).toBe(0);
    expect(optionSeries(terminalOption).every((series) => series.animation === false)).toBe(true);
  });

  it("does not replay streamed chart chunks when rendering hydrated history", () => {
    render(
      <A2UIBlock
        message={historyHydratedChartMessage({
          title: "历史图表",
          charts: [
            {
              type: "column",
              title: "历史数据",
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
        })}
      />,
    );

    const chart = screen.getByTestId("a2ui-chart");
    const surface = screen.getByTestId("a2ui-echarts-surface");
    expect(chart.getAttribute("data-a2ui-player-enabled")).toBe("false");
    expect(surface.getAttribute("data-a2ui-chart-data-count")).toBe("4");
    expect(surface.getAttribute("data-a2ui-chart-animation")).toBe("settled");
    expect(lastSetOption().animation).toBe(false);
  });

  it("does not replay a created frame when raw stream lifecycle events are present", () => {
    vi.useFakeTimers();
    const restoreRaf = installTimerBackedRaf();
    try {
      render(
        <A2UIBlock
          message={streamedCreatedChartMessage({
            title: "已完成图表",
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
          })}
        />,
      );

      const chart = screen.getByTestId("a2ui-chart");
      const surface = screen.getByTestId("a2ui-echarts-surface");
      expect(chart.getAttribute("data-a2ui-player-enabled")).toBe("false");
      expect(chart.getAttribute("data-a2ui-player-phase")).toBe("created");
      expect(chartDataCounts()).toEqual([4]);
      expect(surface.getAttribute("data-a2ui-chart-animation")).toBe("settled");
      expect(lastSetOption().animation).toBe(false);
    } finally {
      restoreRaf();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not replay stream animation when a completed A2UI remounts after the turn settles", () => {
    vi.useFakeTimers();
    const restoreRaf = installTimerBackedRaf();
    try {
      const fullPayload = {
        title: "完成后重挂载",
        charts: [
          {
            type: "column",
            title: "增长数据",
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
      const completedMessage = streamedCreatedChartMessage(fullPayload, "stream-chart-stream", "tool-chart-stream");
      const { rerender, unmount } = render(<A2UIBlock message={streamingChartMessage(fullPayload)} />);

      rerender(<A2UIBlock message={completedMessage} />);

      act(() => {
        vi.advanceTimersByTime(3_200);
      });

      expect(screen.getByTestId("a2ui-chart").getAttribute("data-a2ui-player-phase")).toBe("created");
      unmount();
      echartsMock.setOption.mockClear();

      render(<A2UIBlock message={completedMessage} />);

      const chart = screen.getByTestId("a2ui-chart");
      const surface = screen.getByTestId("a2ui-echarts-surface");
      expect(chart.getAttribute("data-a2ui-player-enabled")).toBe("false");
      expect(surface.getAttribute("data-a2ui-chart-data-count")).toBe("4");
      expect(lastSetOption().animation).toBe(false);
    } finally {
      restoreRaf();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps a visible reveal pace for small fast chart payloads", () => {
    vi.useFakeTimers();
    const restoreRaf = installTimerBackedRaf();
    try {
      const smallPayload = {
        title: "小数据节奏",
        charts: [
          {
            type: "column",
            title: "四项数据",
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
        <A2UIBlock
          message={streamingChartMessage(smallPayload)}
        />,
      );
      rerender(<A2UIBlock message={streamedCreatedChartMessage(smallPayload, "stream-chart-stream", "tool-chart-stream")} />);

      expect(chartDataCounts()[0]).toBeGreaterThan(0);
      expect(chartDataCounts()[0]).toBeLessThan(4);

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(chartDataCounts()[0]).toBeLessThan(4);

      act(() => {
        vi.advanceTimersByTime(2_000);
      });

      expect(chartDataCounts()).toEqual([4]);
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
        <A2UIBlock message={streamingChartMessage(fullPayload)} />,
      );

      act(() => {
        vi.advanceTimersByTime(1_500);
      });
      expect(chartDataCounts()).toEqual([4]);

      rerender(<A2UIBlock message={terminalEmptyChartMessage("stream-chart-stream", "tool-chart-stream")} />);

      expect(chartDataCounts()).toEqual([4]);
      expect(screen.getByTestId("a2ui-echarts-surface").getAttribute("data-a2ui-chart-placeholder")).toBe("false");
      expect(screen.queryByText("暂无图表数据")).toBeNull();
    } finally {
      restoreRaf();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps the streaming chart caption monotonic when partial metadata regresses", () => {
    const chartPayload = (summary: string, title: string) => ({
      title: "Caption stability",
      summary,
      charts: [
        {
          type: "trend",
          title,
          series: [
            {
              name: "Requests",
              items: [
                { name: "T1", value: 10 },
                { name: "T2", value: 20 },
              ],
            },
          ],
        },
      ],
    });
    const fullCaption = "Complete streaming chart summary";
    const { rerender } = render(
      <A2ChartBlock parsed={parsedChart(chartPayload(fullCaption, "Request trend"), "waiting_created")} />,
    );

    expect(screen.getByText(fullCaption)).not.toBeNull();

    rerender(
      <A2ChartBlock parsed={parsedChart(chartPayload("Short", "Trend"), "waiting_created")} />,
    );
    expect(screen.getByText(fullCaption)).not.toBeNull();
    expect(screen.queryByText("Short")).toBeNull();

    rerender(
      <A2ChartBlock parsed={parsedChart(chartPayload("", "Trend"), "waiting_created")} />,
    );
    expect(screen.getByText(fullCaption)).not.toBeNull();

    rerender(
      <A2ChartBlock parsed={parsedChart(chartPayload("Final summary", "Trend"), "created")} />,
    );
    expect(screen.getByText("Final summary")).not.toBeNull();
    expect(screen.queryByText(fullCaption)).toBeNull();
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
      expect(screen.getByTestId("a2ui-echarts-surface").getAttribute("data-a2ui-chart-placeholder")).toBe("false");

      rerender(<A2UIBlock message={withDebugId(streamingChartMessage(secondPayload), "chunk-2")} />);

      expect(chartDataCounts()).toEqual([1]);
      expect(screen.getByTestId("a2ui-echarts-surface").getAttribute("data-a2ui-chart-placeholder")).toBe("false");

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(chartDataCounts()).toEqual([2]);
      expect(screen.getByTestId("a2ui-echarts-surface").getAttribute("data-a2ui-chart-placeholder")).toBe("false");
    } finally {
      restoreRaf();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("applies each released stream frame immediately without a second chart timer", () => {
    const payloadWithCount = (count: number) => ({
      title: "快速流式",
      charts: [
        {
          type: "column",
          title: "快速增长",
          series: [
            {
              name: "数量",
              items: Array.from({ length: count }, (_, index) => ({
                name: `项 ${index + 1}`,
                value: (index + 1) * 10,
              })),
            },
          ],
        },
      ],
    });
    const { rerender } = render(<A2ChartBlock parsed={parsedChart(payloadWithCount(1), "waiting_created")} />);
    const initialCalls = echartsMock.setOption.mock.calls.length;

    rerender(<A2ChartBlock parsed={parsedChart(payloadWithCount(2), "waiting_created")} />);
    expect(echartsMock.setOption.mock.calls.length).toBe(initialCalls + 1);
    expect(lastOptionDataCount()).toBe(2);

    rerender(<A2ChartBlock parsed={parsedChart(payloadWithCount(3), "waiting_created")} />);
    expect(echartsMock.setOption.mock.calls.length).toBe(initialCalls + 2);
    expect(lastOptionDataCount()).toBe(3);
    expect(echartsMock.setOption.mock.calls.at(-1)?.[1]).toMatchObject({ lazyUpdate: false });
  });

  it("does not collapse player-released frames inside the ECharts adapter", () => {
    const payloadWithCount = (count: number) => ({
      title: "大数据流式",
      charts: [
        {
          type: "trend",
          title: "访问趋势",
          series: [
            {
              name: "访问量",
              items: Array.from({ length: count }, (_, index) => ({
                name: `点 ${index + 1}`,
                value: index + 1,
              })),
            },
          ],
        },
      ],
    });
    const { rerender } = render(<A2ChartBlock parsed={parsedChart(payloadWithCount(1), "waiting_created")} />);
    const initialCalls = echartsMock.setOption.mock.calls.length;

    for (let count = 2; count <= 20; count += 1) {
      rerender(<A2ChartBlock parsed={parsedChart(payloadWithCount(count), "waiting_created")} />);
    }

    expect(echartsMock.setOption.mock.calls.length).toBe(initialCalls + 19);
    expect(lastOptionDataCount()).toBe(20);
  });

  it("keeps large streaming trends on one unsampled animation pipeline", () => {
    const payload = {
      title: "Large streaming trend",
      charts: [
        {
          type: "trend",
          title: "Stable trend",
          series: [
            {
              name: "Value",
              items: Array.from({ length: 120 }, (_, index) => ({
                name: `Point ${index + 1}`,
                value: index + 1,
              })),
            },
          ],
        },
      ],
    };

    render(<A2ChartBlock parsed={parsedChart(payload, "waiting_created")} />);

    const option = lastSetOption();
    const series = optionSeries(option)[0];
    expect(series.sampling).toBeUndefined();
    expect(option.animationDuration).toBe(170);
    expect(option.animationDurationUpdate).toBe(170);
    expect(series.animationDelay).toBe(0);
    expect(series.animationDelayUpdate).toBe(0);
    expect(series.animationDuration).toBe(170);
    expect(series.animationDurationUpdate).toBe(170);
  });

  it("keeps zoomed streaming trend charts on the full generated range", () => {
    vi.useFakeTimers();
    try {
      const payloadWithCount = (count: number) => ({
        title: "大数据缩放趋势",
        charts: [
          {
            type: "trend",
            title: "访问趋势",
            zoom: true,
            series: [
              {
                name: "访问量",
                items: Array.from({ length: count }, (_, index) => ({
                  name: `点 ${index + 1}`,
                  value: index + 1,
                })),
              },
            ],
          },
        ],
      });
      const { rerender } = render(<A2ChartBlock parsed={parsedChart(payloadWithCount(2), "waiting_created")} />);
      const initialZoom = lastDataZoom();
      expect(initialZoom[0]).toMatchObject({ end: 100, start: 0 });

      rerender(<A2ChartBlock parsed={parsedChart(payloadWithCount(260), "waiting_created")} />);

      act(() => {
        vi.advanceTimersByTime(200);
      });

      const streamingZoom = lastDataZoom();
      expect(streamingZoom).toHaveLength(2);
      expect(streamingZoom[0]).toMatchObject({ end: 100, rangeMode: ["percent", "percent"], start: 0 });
      expect(streamingZoom[1]).toMatchObject({ end: 100, rangeMode: ["percent", "percent"], start: 0 });
      expect(lastOptionDataCount()).toBe(260);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("reveals live streaming chart payloads element by element", () => {
    vi.useFakeTimers();
    const restoreRaf = installTimerBackedRaf();
    try {
      render(
        <A2UIBlock
          message={streamingChartMessage({
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
        vi.advanceTimersByTime(1_900);
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

function lastSetOption(): Record<string, unknown> {
  const calls = echartsMock.setOption.mock.calls;
  return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>;
}

function lastDataZoom(): Array<Record<string, unknown>> {
  const dataZoom = lastSetOption().dataZoom;
  return Array.isArray(dataZoom)
    ? dataZoom.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function optionSeries(option: Record<string, unknown>): Array<Record<string, unknown>> {
  const series = option.series;
  if (Array.isArray(series)) {
    return series.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  }
  return series && typeof series === "object" ? [series as Record<string, unknown>] : [];
}

function lastOptionDataCount(): number {
  return optionSeries(lastSetOption()).reduce((sum, series) => {
    const data = series.data;
    return sum + (Array.isArray(data) ? data.length : 0);
  }, 0);
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

function parsedChart(
  payload: Record<string, unknown>,
  phase: NonNullable<ParsedA2UIMessage["streamPlayer"]>["phase"],
): ParsedA2UIMessage {
  const a2ui = chartObject(payload, "stream-direct-chart", "tool-direct-chart");
  const debug = chartDebug(a2ui);
  const totalElementCount = 4;
  const running = phase !== "created";
  return {
    a2ui,
    debug,
    interaction: null,
    interactionId: "",
    mode: "render",
    parseError: "",
    historyHydrated: false,
    payload,
    renderKey: "chart",
    status: "completed",
    renderState: resolveA2UIRenderState({
      status: "completed",
      mode: "render",
      interaction: null,
      historyHydrated: false,
    }),
    streamPlayer: {
      enabled: true,
      phase,
      payload,
      renderedElementCount: totalElementCount,
      rootProps: {
        "data-a2ui-player-enabled": "true",
        "data-a2ui-player-phase": phase,
        "data-a2ui-player-rendered": totalElementCount,
        "data-a2ui-player-total": totalElementCount,
        "data-a2ui-player-running": running ? "true" : "false",
        "data-a2ui-reveal-enabled": "true",
        "data-a2ui-reveal-total": totalElementCount,
        "data-a2ui-reveal-visible": totalElementCount,
        "data-a2ui-reveal-backlog": 0,
        "data-a2ui-reveal-speed": running ? 7 : 0,
        "data-a2ui-reveal-running": running ? "true" : "false",
      },
      running,
      totalElementCount,
    },
    streamText: "",
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

function historyHydratedChartMessage(payload: Record<string, unknown>): ConversationMessage {
  const message = streamedCreatedChartMessage(payload, "history-chart-stream", "history-chart-tool");
  return {
    ...message,
    id: "agent:hist:ses-1:1:a2ui",
    payload: {
      ...message.payload,
      historyHydrated: true,
    },
  };
}

function streamedCreatedChartMessageWithoutStreamEvidence(
  payload: Record<string, unknown>,
  streamId: string,
  toolCallId: string,
): ConversationMessage {
  const message = streamedCreatedChartMessage(payload, streamId, toolCallId);
  const debug = message.payload.a2uiDebug as A2UIDebugBlockState;
  return {
    ...message,
    payload: {
      ...message.payload,
      a2uiDebug: {
        ...debug,
        argsBuffer: "",
        argsTextLength: 0,
        chunkCount: 0,
        jsonParseStatus: "empty",
        parsedArgs: undefined,
        rawEvents: [],
      },
    },
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
