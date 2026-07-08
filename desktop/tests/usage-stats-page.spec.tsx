import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ModelProvider, RuntimeBridge } from "@/runtime";
import {
  buildUsageTrendOption,
  completeUsageTrendPoints,
  TokenHeatWall,
  UsageStatsPage,
} from "@/renderer/pages/settings/usage/UsageStatsPage";
import type {
  UsageRequestDetail,
  UsageRequestListResponse,
  UsageSummary,
  UsageTrendPoint,
  UsageTrendResponse,
} from "@/types/protocol";

const setOption = vi.fn();
const resize = vi.fn();
const dispose = vi.fn();

vi.mock("echarts", () => ({
  init: vi.fn(() => ({ setOption, resize, dispose })),
}));

describe("UsageStatsPage", () => {
  it("renders real usage data, metric cards, chart and request table", async () => {
    const runtime = fakeRuntime();

    render(<UsageStatsPage runtime={runtime} />);

    expect(screen.getByRole("heading", { name: "用量统计" })).not.toBeNull();
    expect(await screen.findByText("24")).not.toBeNull();
    expect(screen.queryByText("总 Token")).toBeNull();
    expect(screen.queryByText("输入 Token")).toBeNull();
    expect(screen.getByText("非缓存命中输入 Token")).not.toBeNull();
    expect(screen.getByText("命中缓存 Token")).not.toBeNull();
    expect(screen.getByLabelText("平均缓存命中率 72.4%")).not.toBeNull();
    expect(screen.getAllByText("72.4%")).toHaveLength(2);
    expect(screen.queryByText("18,445")).toBeNull();
    expect(screen.queryByText("17,907")).toBeNull();
    expect(screen.getAllByText("4,947")).toHaveLength(1);
    expect(screen.getAllByText("12,960")).toHaveLength(1);
    expect(screen.getByRole("columnheader", { name: "总输入/命中缓存" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "缓存命中率" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "用时/首字" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "输出速率" })).not.toBeNull();
    expect(screen.queryByRole("columnheader", { name: "耗时" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "首字时长" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "总量" })).toBeNull();
    expect(screen.getByText("17,907 / 12,960")).not.toBeNull();
    expect(screen.queryByText("12,960 (72.4%)")).toBeNull();
    expect(screen.getByText("640ms")).not.toBeNull();
    expect(screen.getByText("305.7 tok/s")).not.toBeNull();
    expect(screen.queryByText("2.4s / 640ms")).toBeNull();
    expect(screen.getAllByText("538")).toHaveLength(2);
    expect(screen.getByTestId("usage-token-heatwall")).not.toBeNull();
    expect(screen.getByTestId("usage-trend-chart")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "使用趋势" })).toBeNull();
    expect(screen.queryByText("Token 活动")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "会话" })).toBeNull();
    expect(screen.queryByText("ses-1234...")).toBeNull();
    expect(screen.getByRole("button", { name: "按小时" }).getAttribute("data-active")).toBe("true");
    expect(runtime.usage.getTrend).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "hour",
        timezoneOffsetMinutes: expect.any(Number),
      }),
    );
    expect(runtime.usage.getTrend).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "day",
        startTime: expect.any(String),
        endTime: expect.any(String),
        timezoneOffsetMinutes: expect.any(Number),
      }),
    );
    const heatCall = runtime.usage.getTrend.mock.calls.find(([options]) => options.bucket === "day" && options.startTime);
    expect(heatCall).toBeTruthy();
    if (heatCall) {
      const [{ startTime, endTime }] = heatCall;
      const days = (new Date(endTime).getTime() - new Date(startTime).getTime()) / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThanOrEqual(365);
      expect(days).toBeLessThanOrEqual(367);
    }
    await waitFor(() => {
      expect(setOption).toHaveBeenCalledWith(
        expect.objectContaining({
          legend: expect.objectContaining({ data: ["非缓存输入", "命中缓存", "输出", "请求数"] }),
        }),
      );
    });
    const modelText = screen.getByText("deepseek-v4-flash");
    expect(modelText.getAttribute("title")).toBeNull();
    expect(modelText.getAttribute("data-tooltip-label")).toBe("deepseek-v4-flash");
    expect(modelText.className).toContain("modelCellText");
    fireEvent.pointerOver(modelText);
    expect((await screen.findByRole("tooltip")).textContent).toBe("deepseek-v4-flash");
    fireEvent.pointerOut(modelText);
    expect(screen.getByText("成功")).not.toBeNull();
    expect(screen.queryByText("来源")).toBeNull();
  });

  it("changes range, filters by model and refreshes without native select", async () => {
    const runtime = fakeRuntime();

    render(<UsageStatsPage runtime={runtime} />);

    await screen.findByText("24");
    fireEvent.click(screen.getByRole("button", { name: "今天" }));

    await waitFor(() => {
      expect(runtime.usage.getTrend).toHaveBeenLastCalledWith(
        expect.objectContaining({
          bucket: "hour",
          timezoneOffsetMinutes: expect.any(Number),
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "按天" }));

    await waitFor(() => {
      expect(runtime.usage.getTrend).toHaveBeenLastCalledWith(
        expect.objectContaining({
          bucket: "day",
          timezoneOffsetMinutes: expect.any(Number),
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "按小时" }));

    await waitFor(() => {
      expect(runtime.usage.getTrend).toHaveBeenLastCalledWith(
        expect.objectContaining({
          bucket: "hour",
          timezoneOffsetMinutes: expect.any(Number),
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /全部模型/ }));
    expect(screen.getByRole("dialog", { name: "选择模型" })).not.toBeNull();
    expect(screen.getByLabelText("筛选模型")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("筛选模型"), { target: { value: "qwen" } });
    fireEvent.click(screen.getByRole("button", { name: "qwen3-coder-plus" }));

    await waitFor(() => {
      expect(runtime.usage.getSummary).toHaveBeenLastCalledWith(
        expect.objectContaining({ model: "qwen3-coder-plus" }),
      );
    });

    const beforeRefresh = runtime.usage.getSummary.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => {
      expect(runtime.usage.getSummary.mock.calls.length).toBeGreaterThan(beforeRefresh);
    });
  });

  it("closes the model filter menu from outside interactions", async () => {
    const runtime = fakeRuntime();

    render(<UsageStatsPage runtime={runtime} />);

    await screen.findByText("24");
    fireEvent.click(screen.getByRole("button", { name: /全部模型/ }));

    expect(screen.getByRole("dialog", { name: "选择模型" })).not.toBeNull();

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "选择模型" })).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: /全部模型/ }));
    expect(screen.getByRole("dialog", { name: "选择模型" })).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "选择模型" })).toBeNull();
    });
  });

  it("uses progressive trend loading for large hourly ranges", async () => {
    const runtime = fakeRuntime();

    render(<UsageStatsPage runtime={runtime} />);

    await screen.findByText("24");
    runtime.usage.getTrend.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "近 30 天" }));

    await waitFor(() => {
      expect(runtime.usage.getTrend).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: "hour",
          limit: 168,
          timezoneOffsetMinutes: expect.any(Number),
        }),
      );
    });
  });

  it("paginates request logs without reloading summary or trend data", async () => {
    const runtime = fakeRuntime({
      requests: {
        ...defaultRequests(),
        total: 24,
      },
    });

    render(<UsageStatsPage runtime={runtime} />);

    await screen.findByText("24");
    await waitFor(() => {
      expect(runtime.usage.listRequests).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 12 }));
      expect(runtime.usage.getTrend).toHaveBeenCalledTimes(2);
    });

    const summaryCalls = runtime.usage.getSummary.mock.calls.length;
    const trendCalls = runtime.usage.getTrend.mock.calls.length;
    const providerCalls = runtime.models.listProviders.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));

    await waitFor(() => {
      expect(runtime.usage.listRequests).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, pageSize: 12 }));
    });
    expect(runtime.usage.getSummary).toHaveBeenCalledTimes(summaryCalls);
    expect(runtime.usage.getTrend).toHaveBeenCalledTimes(trendCalls);
    expect(runtime.models.listProviders).toHaveBeenCalledTimes(providerCalls);
  });

  it("shows empty state without mock fallback data", async () => {
    const runtime = fakeRuntime({
      summary: emptySummary(),
      trend: { points: [] },
      requests: { list: [], total: 0, page: 1, page_size: 12 },
      providers: [],
    });

    render(<UsageStatsPage runtime={runtime} />);

    expect(await screen.findAllByText("0")).not.toHaveLength(0);
    expect(screen.getByTestId("usage-token-heatwall").textContent).toContain("暂无 Token 活动");
    expect(screen.getByTestId("usage-trend-empty").textContent).toBe("暂无趋势数据");
    expect(screen.getByTestId("usage-request-empty").textContent).toBe("暂无请求日志");
    expect(screen.queryByText("deepseek-v4-flash")).toBeNull();
  });

  it("shows errors and retry action when usage API fails", async () => {
    const runtime = fakeRuntime({
      summaryError: new Error("用量接口不可用"),
    });

    render(<UsageStatsPage runtime={runtime} />);

    expect((await screen.findByRole("alert")).textContent).toContain("用量接口不可用");
    expect(screen.getByTestId("usage-trend-empty")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => {
      expect(runtime.usage.getSummary).toHaveBeenCalledTimes(2);
    });
  });

  it("opens and closes request detail layer", async () => {
    const runtime = fakeRuntime();
    const onNavigateToConversationTurn = vi.fn();

    render(<UsageStatsPage runtime={runtime} onNavigateToConversationTurn={onNavigateToConversationTurn} />);

    fireEvent.click(await screen.findByText("deepseek-v4-flash"));

    expect(await screen.findByRole("dialog", { name: "请求详情" })).not.toBeNull();
    expect(runtime.usage.getRequestDetail).toHaveBeenCalledWith("llm_req_1");
    expect(screen.getByText("trace-1")).not.toBeNull();
    expect(screen.getByText("ses-1234567890")).not.toBeNull();
    expect(screen.getAllByText("640ms").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("305.7 tok/s").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("2.4s / 640ms")).toBeNull();
    expect(screen.getByText("命中缓存 12,960 (72.4%)")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "事件摘要" })).toBeNull();
    expect(screen.queryByText("on_chat_model_end")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "跳转对话" }));
    expect(onNavigateToConversationTurn).toHaveBeenCalledWith({
      sessionId: "ses-1234567890",
      turnIndex: 1,
    });

    fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "请求详情" })).toBeNull();
    });
  });

  it("shows non-streaming request output rate as not counted", async () => {
    const requests = defaultRequests();
    requests.list[0] = {
      ...requests.list[0],
      call_kind: "agenerate",
      output_tokens_per_second: null,
    };
    const runtime = fakeRuntime({ requests });

    render(<UsageStatsPage runtime={runtime} />);

    expect(await screen.findByText("非流式不统计")).not.toBeNull();
    expect(screen.queryByText("305.7 tok/s")).toBeNull();

    fireEvent.click(await screen.findByText("deepseek-v4-flash"));

    expect(await screen.findByRole("dialog", { name: "请求详情" })).not.toBeNull();
    expect(screen.getAllByText("非流式不统计").length).toBeGreaterThanOrEqual(2);
  });

  it("builds localized ECharts option from trend points", () => {
    const option = buildUsageTrendOption([
      {
        time: "2026-06-19",
        request_count: 3,
        input_tokens: 100,
        cache_read_tokens: 20,
        output_tokens: 30,
        total_tokens: 150,
        failed_count: 1,
      },
    ]);

    expect(option.legend).toMatchObject({ data: ["非缓存输入", "命中缓存", "输出", "请求数"] });
    expect(option.xAxis).toMatchObject({ data: ["06/19"] });
    expect(option.series).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "非缓存输入", data: [80] }),
        expect.objectContaining({ name: "命中缓存", data: [20] }),
        expect.objectContaining({ name: "请求数", data: [3] }),
      ]),
    );
    const series = option.series as Array<Record<string, unknown>>;
    expect(series.every((item) => item.showSymbol === false)).toBe(true);
    expect(series.every((item) => item.symbol === "circle")).toBe(true);
    expect(series.every((item) => item.symbolSize === 7)).toBe(true);
  });

  it("formats hourly trend labels for ECharts", () => {
    const option = buildUsageTrendOption([
      {
        time: "2026-06-19T16:00:00",
        request_count: 1,
        input_tokens: 10,
        cache_read_tokens: 2,
        output_tokens: 3,
        total_tokens: 13,
        failed_count: 0,
      },
    ]);

    expect(option.xAxis).toMatchObject({ data: ["06/19 16:00"] });
  });

  it("renders token heat wall cells with total token tooltip data", () => {
    render(
      <TokenHeatWall
        bucket="day"
        points={[
          trendPoint({
            time: "2026-06-19",
            request_count: 2,
            input_tokens: 17_907,
            cache_read_tokens: 12_960,
            output_tokens: 538,
            total_tokens: 18_445,
          }),
        ]}
      />,
    );

    const heatWall = screen.getByTestId("usage-token-heatwall");
    const cell = screen.getByRole("button", { name: "06/19 · 总 Token 18,445" });

    expect(heatWall.textContent).toContain("一");
    expect(heatWall.textContent).toContain("日");
    expect(screen.queryByText("18,445 Token")).toBeNull();
    expect(cell.getAttribute("title")).toBeNull();
    expect(cell.getAttribute("data-level")).toBe("4");
    expect(screen.queryByText("总 Token 18,445")).toBeNull();
    fireEvent.mouseEnter(cell);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("06/19");
    expect(tooltip.textContent).toContain("总 Token 18,445");
    expect(tooltip.parentElement).toBe(document.body);
    expect(heatWall.contains(tooltip)).toBe(false);
  });

  it("highlights the whole heat wall week in weekly mode", () => {
    render(
      <TokenHeatWall
        bucket="week"
        points={[
          trendPoint({
            time: "2026-06-19",
            request_count: 2,
            input_tokens: 17_907,
            cache_read_tokens: 12_960,
            output_tokens: 538,
            total_tokens: 18_445,
          }),
        ]}
      />,
    );

    const weekCells = screen.getAllByRole("button", { name: "06/15 - 06/21 · 总 Token 18,445" });

    expect(weekCells).toHaveLength(7);
    expect(weekCells.every((cell) => cell.getAttribute("data-level") === "4")).toBe(true);
    expect(weekCells.every((cell) => cell.getAttribute("data-outside") === "false")).toBe(true);
    fireEvent.mouseEnter(weekCells[4]);
    expect(weekCells.every((cell) => cell.getAttribute("data-active") === "true")).toBe(true);
  });

  it("fills hourly trend buckets inside the selected range", () => {
    const completed = completeUsageTrendPoints(
      [
        trendPoint({
          time: "2026-06-19T16:00:00",
          request_count: 2,
          input_tokens: 100,
          cache_read_tokens: 20,
          output_tokens: 30,
          total_tokens: 150,
        }),
      ],
      "hour",
      {
        startTime: "2026-06-19T14:30:00Z",
        endTime: "2026-06-19T17:05:00Z",
      },
      0,
    );

    expect(completed.map((point) => point.time)).toEqual([
      "2026-06-19T14:00:00",
      "2026-06-19T15:00:00",
      "2026-06-19T16:00:00",
      "2026-06-19T17:00:00",
    ]);
    expect(completed.map((point) => point.request_count)).toEqual([0, 0, 2, 0]);
    expect(completed[2].input_tokens).toBe(100);
  });

  it("fills day trend buckets using the same local timezone offset as the backend", () => {
    const completed = completeUsageTrendPoints(
      [trendPoint({ time: "2026-06-20", request_count: 1 })],
      "day",
      {
        startTime: "2026-06-18T16:00:00Z",
        endTime: "2026-06-20T12:00:00Z",
      },
      480,
    );

    expect(completed.map((point) => point.time)).toEqual(["2026-06-19", "2026-06-20"]);
    expect(completed.map((point) => point.request_count)).toEqual([0, 1]);
  });
});

interface FakeRuntimeOptions {
  summary?: UsageSummary;
  trend?: UsageTrendResponse;
  requests?: UsageRequestListResponse;
  detail?: UsageRequestDetail;
  providers?: ModelProvider[];
  summaryError?: Error;
}

function fakeRuntime(options: FakeRuntimeOptions = {}) {
  const summary = options.summary ?? {
    request_count: 24,
    total_tokens: 18_445,
    input_tokens: 17_907,
    cache_read_tokens: 12_960,
    output_tokens: 538,
    success_count: 23,
    failed_count: 1,
    avg_duration_ms: 2400,
  };
  const trend = options.trend ?? {
    points: [
      {
        time: "2026-06-19T16:00:00",
        request_count: 2,
        input_tokens: 17_907,
        cache_read_tokens: 12_960,
        output_tokens: 538,
        total_tokens: 18_445,
        failed_count: 0,
      },
    ],
  };
  const requests = options.requests ?? defaultRequests();
  const detail = options.detail ?? {
    request: requests.list[0],
    trace: {
      trace_id: "trace-1",
      session_id: "ses-1234567890",
      active_session_id: null,
      scene_id: "desktop-agent",
      scene_name: "本地智能体",
      user_id: "local-user",
      turn_index: 1,
      status: "completed",
      start_time: "2026-06-19T23:12:00Z",
      end_time: "2026-06-19T23:12:02Z",
      duration_ms: 2400,
      total_input_tokens: 17_907,
      total_cache_read_tokens: 12_960,
      total_output_tokens: 538,
      total_tokens: 18_445,
      user_message_preview: "帮我看下项目",
    },
    events: [
      {
        id: 1,
        event_type: "on_chat_model_end",
        source: "langchain_event_handler",
        occurred_at: "2026-06-19T23:12:02Z",
        sequence_no: 3,
        run_id: "run-1",
        turn_index: 1,
        payload_summary: "usage 已写入",
      },
    ],
  };
  const providers = options.providers ?? [
    {
      id: "provider-1",
      name: "默认模型服务",
      base_url: "https://api.example.com/v1",
      enabled: true,
      api_key_set: true,
      api_key_preview: "sk-***abcd",
      models: ["deepseek-v4-flash", "qwen3-coder-plus"],
      model_enabled: {},
      health: {},
    },
  ];

  return {
    usage: {
      getSummary: vi.fn(
        options.summaryError
          ? () => Promise.reject(options.summaryError)
          : () => Promise.resolve(summary),
      ),
      getTrend: vi.fn((query?: { bucket?: string; startTime?: string; endTime?: string }) => {
        if (query?.bucket === "day" && query.startTime && query.endTime && isYearRange(query.startTime, query.endTime)) {
          return Promise.resolve({ points: [] });
        }
        return Promise.resolve(trend);
      }),
      listRequests: vi.fn((query?: { page?: number; pageSize?: number }) =>
        Promise.resolve({
          ...requests,
          page: query?.page ?? requests.page,
          page_size: query?.pageSize ?? requests.page_size,
        }),
      ),
      getRequestDetail: vi.fn(() => Promise.resolve(detail)),
    },
    models: {
      listProviders: vi.fn(() => Promise.resolve(providers)),
    },
  } as unknown as RuntimeBridge & {
    usage: {
      getSummary: ReturnType<typeof vi.fn>;
      getTrend: ReturnType<typeof vi.fn>;
      listRequests: ReturnType<typeof vi.fn>;
      getRequestDetail: ReturnType<typeof vi.fn>;
    };
    models: {
      listProviders: ReturnType<typeof vi.fn>;
    };
  };
}

function defaultRequests(): UsageRequestListResponse {
  return {
    list: [
      {
        id: "llm_req_1",
        created_at: "2026-06-19T23:12:00Z",
        updated_at: "2026-06-19T23:12:02Z",
        trace_id: "trace-1",
        trace_record_id: "trace_record-1",
        session_id: "ses-1234567890",
        active_session_id: null,
        turn_index: 1,
        provider_id: "provider-1",
        provider_name: "默认模型服务",
        model: "deepseek-v4-flash",
        status: "completed",
        start_time: "2026-06-19T23:12:00Z",
        end_time: "2026-06-19T23:12:02Z",
        duration_ms: 2400,
        time_to_first_token: 640,
        call_kind: "astream",
        output_tokens_per_second: 305.7,
        input_tokens: 17_907,
        cache_read_tokens: 12_960,
        output_tokens: 538,
        total_tokens: 18_445,
        request_preview: "用户消息摘要",
        response_preview: "模型响应摘要",
        error_message: null,
        metadata: {},
      },
    ],
    total: 1,
    page: 1,
    page_size: 12,
  };
}

function isYearRange(startTime: string, endTime: string) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  return end.getTime() - start.getTime() > 300 * 24 * 60 * 60 * 1000;
}

function trendPoint(overrides: Partial<UsageTrendPoint>): UsageTrendPoint {
  return {
    time: "2026-06-19T00:00:00",
    request_count: 0,
    input_tokens: 0,
    cache_read_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    failed_count: 0,
    ...overrides,
  };
}

function emptySummary(): UsageSummary {
  return {
    request_count: 0,
    total_tokens: 0,
    input_tokens: 0,
    cache_read_tokens: 0,
    output_tokens: 0,
    success_count: 0,
    failed_count: 0,
    avg_duration_ms: 0,
  };
}
