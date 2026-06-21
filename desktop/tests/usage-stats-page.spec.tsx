import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ModelProvider, RuntimeBridge } from "@/runtime";
import {
  buildUsageTrendOption,
  UsageStatsPage,
} from "@/renderer/pages/settings/usage/UsageStatsPage";
import type {
  UsageRequestDetail,
  UsageRequestListResponse,
  UsageSummary,
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
    expect(screen.getByText("72.4%")).not.toBeNull();
    expect(screen.getAllByText("18,445")).toHaveLength(1);
    expect(screen.getAllByText("17,907")).toHaveLength(1);
    expect(screen.getAllByText("4,947")).toHaveLength(1);
    expect(screen.getAllByText("12,960")).toHaveLength(2);
    expect(screen.getAllByText("538")).toHaveLength(2);
    expect(screen.getByTestId("usage-trend-chart")).not.toBeNull();
    await waitFor(() => {
      expect(setOption).toHaveBeenCalledWith(
        expect.objectContaining({
          legend: expect.objectContaining({ data: ["非缓存输入", "命中缓存", "输出", "请求数"] }),
        }),
      );
    });
    expect(screen.getByText("deepseek-v4-flash")).not.toBeNull();
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

  it("shows empty state without mock fallback data", async () => {
    const runtime = fakeRuntime({
      summary: emptySummary(),
      trend: { points: [] },
      requests: { list: [], total: 0, page: 1, page_size: 12 },
      providers: [],
    });

    render(<UsageStatsPage runtime={runtime} />);

    expect(await screen.findAllByText("0")).not.toHaveLength(0);
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

    render(<UsageStatsPage runtime={runtime} />);

    fireEvent.click(await screen.findByText("ses-1234..."));

    expect(await screen.findByRole("dialog", { name: "请求详情" })).not.toBeNull();
    expect(runtime.usage.getRequestDetail).toHaveBeenCalledWith("llm_req_1");
    expect(screen.getByText("trace-1")).not.toBeNull();
    expect(screen.getByText("on_chat_model_end")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "请求详情" })).toBeNull();
    });
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
        time: "2026-06-19",
        request_count: 2,
        input_tokens: 17_907,
        cache_read_tokens: 12_960,
        output_tokens: 538,
        total_tokens: 18_445,
        failed_count: 0,
      },
    ],
  };
  const requests = options.requests ?? {
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
      default_model: "deepseek-v4-flash",
    },
  ];

  return {
    usage: {
      getSummary: vi.fn(
        options.summaryError
          ? () => Promise.reject(options.summaryError)
          : () => Promise.resolve(summary),
      ),
      getTrend: vi.fn(() => Promise.resolve(trend)),
      listRequests: vi.fn(() => Promise.resolve(requests)),
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
