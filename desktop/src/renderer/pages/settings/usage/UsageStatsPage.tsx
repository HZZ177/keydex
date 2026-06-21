import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import {
  BarChart3,
  CalendarDays,
  ChevronDown,
  Database,
  Loader2,
  RefreshCw,
  Search,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { runtimeBridge, type ModelProvider, type RuntimeBridge } from "@/runtime";
import type {
  UsageRequestDetail,
  UsageRequestListResponse,
  UsageRequestLog,
  UsageSummary,
  UsageBucket,
  UsageTrendPoint,
} from "@/types/protocol";

import styles from "./UsageStatsPage.module.css";

type RangePreset = "today" | "7d" | "30d" | "custom";
type TokenInputLike = {
  input_tokens?: number | null;
  cache_read_tokens?: number | null;
};

const PAGE_SIZE = 12;
const EMPTY_SUMMARY: UsageSummary = {
  request_count: 0,
  total_tokens: 0,
  input_tokens: 0,
  cache_read_tokens: 0,
  output_tokens: 0,
  success_count: 0,
  failed_count: 0,
  avg_duration_ms: 0,
};
const EMPTY_REQUESTS: UsageRequestListResponse = {
  list: [],
  total: 0,
  page: 1,
  page_size: PAGE_SIZE,
};

export interface UsageStatsPageProps {
  runtime?: RuntimeBridge;
}

export function UsageStatsPage({ runtime = runtimeBridge }: UsageStatsPageProps) {
  const [rangePreset, setRangePreset] = useState<RangePreset>("7d");
  const initialCustomRange = useMemo(() => computeRange("7d"), []);
  const [customStart, setCustomStart] = useState(toDateTimeLocal(initialCustomRange.startTime));
  const [customEnd, setCustomEnd] = useState(toDateTimeLocal(initialCustomRange.endTime));
  const [selectedModel, setSelectedModel] = useState("");
  const [trendBucket, setTrendBucket] = useState<UsageBucket>("day");
  const [page, setPage] = useState(1);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [summary, setSummary] = useState<UsageSummary>(EMPTY_SUMMARY);
  const [trend, setTrend] = useState<UsageTrendPoint[]>([]);
  const [requests, setRequests] = useState<UsageRequestListResponse>(EMPTY_REQUESTS);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [detailId, setDetailId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timezoneOffsetMinutes = useMemo(() => -new Date().getTimezoneOffset(), []);

  const range = useMemo(
    () =>
      rangePreset === "custom"
        ? {
            startTime: fromDateTimeLocal(customStart),
            endTime: fromDateTimeLocal(customEnd),
          }
        : computeRange(rangePreset),
    [customEnd, customStart, rangePreset],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const query = {
      ...range,
      model: selectedModel || undefined,
    };
    void Promise.all([
      runtime.usage.getSummary(query),
      runtime.usage.getTrend({
        ...query,
        bucket: trendBucket,
        timezoneOffsetMinutes,
      }),
      runtime.usage.listRequests({ ...query, page, pageSize: PAGE_SIZE }),
      runtime.models.listProviders().catch(() => [] as ModelProvider[]),
    ])
      .then(([nextSummary, nextTrend, nextRequests, providers]) => {
        if (!active) {
          return;
        }
        setSummary(nextSummary);
        setTrend(nextTrend.points);
        setRequests(nextRequests);
        setModelOptions(collectModelOptions(providers, nextRequests.list, selectedModel));
      })
      .catch((reason: unknown) => {
        if (!active) {
          return;
        }
        setError(errorMessage(reason));
        setSummary(EMPTY_SUMMARY);
        setTrend([]);
        setRequests({ ...EMPTY_REQUESTS, page });
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [page, range, refreshNonce, runtime, selectedModel, timezoneOffsetMinutes, trendBucket]);

  const totalPages = Math.max(1, Math.ceil(requests.total / requests.page_size));

  function changeRange(next: RangePreset) {
    setRangePreset(next);
    setTrendBucket(next === "today" ? "hour" : "day");
    setPage(1);
  }

  function changeTrendBucket(next: UsageBucket) {
    setTrendBucket(next);
  }

  function changeModel(next: string) {
    setSelectedModel(next);
    setPage(1);
  }

  return (
    <main className={styles.page} data-testid="usage-stats-page">
      <header className={styles.header}>
        <div>
          <h1>用量统计</h1>
          <p>查看本地智能体的模型请求与 Token 使用情况</p>
        </div>
        <div className={styles.toolbar} aria-label="用量筛选">
          <ModelFilter models={modelOptions} value={selectedModel} onChange={changeModel} />
          <button
            className={styles.iconButton}
            type="button"
            onClick={() => setRefreshNonce((value) => value + 1)}
          >
            <RefreshCw size={16} />
            <span>刷新</span>
          </button>
        </div>
      </header>

      <section className={styles.rangeBar} aria-label="时间范围">
        <CalendarDays size={16} />
        {(["today", "7d", "30d", "custom"] as RangePreset[]).map((item) => (
          <button
            data-active={rangePreset === item ? "true" : "false"}
            key={item}
            onClick={() => changeRange(item)}
            type="button"
          >
            {rangeLabel(item)}
          </button>
        ))}
        {rangePreset === "custom" ? (
          <div className={styles.customRange}>
            <input
              aria-label="开始时间"
              onChange={(event) => {
                setCustomStart(event.target.value);
                setPage(1);
              }}
              type="datetime-local"
              value={customStart}
            />
            <span>至</span>
            <input
              aria-label="结束时间"
              onChange={(event) => {
                setCustomEnd(event.target.value);
                setPage(1);
              }}
              type="datetime-local"
              value={customEnd}
            />
          </div>
        ) : null}
      </section>

      {error ? (
        <section className={styles.error} role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setRefreshNonce((value) => value + 1)}>
            重试
          </button>
        </section>
      ) : null}

      <section className={styles.metrics} aria-label="用量指标" data-loading={loading ? "true" : "false"}>
        <MetricCard
          icon={<Zap size={18} />}
          label="请求数量"
          primary={formatNumber(summary.request_count)}
          secondary={`成功 ${formatNumber(summary.success_count)} / 失败 ${formatNumber(summary.failed_count)}`}
        />
        <MetricCard
          icon={<BarChart3 size={18} />}
          label="非缓存命中输入 Token"
          primary={formatNumber(nonCacheInputTokens(summary))}
          secondary={`平均耗时 ${formatDuration(summary.avg_duration_ms)}`}
        />
        <MetricCard
          icon={<Database size={18} />}
          label="命中缓存 Token"
          primary={formatNumber(summary.cache_read_tokens)}
          secondary="平均缓存命中率"
          progress={cacheHitRate(summary.cache_read_tokens, summary.input_tokens)}
        />
        <MetricCard
          icon={<Upload size={18} />}
          label="输出 Token"
          primary={formatNumber(summary.output_tokens)}
          secondary="模型输出"
        />
      </section>

      <section className={styles.chartPanel}>
        <div className={styles.panelHeader}>
          <div>
            <h2>使用趋势</h2>
            <p>
              {formatRange(range.startTime, range.endTime)}
              {selectedModel ? ` · ${selectedModel}` : ""}
            </p>
          </div>
          <div className={styles.panelHeaderActions}>
            <div className={styles.bucketToggle} aria-label="趋势粒度">
              <button
                data-active={trendBucket === "hour" ? "true" : "false"}
                onClick={() => changeTrendBucket("hour")}
                type="button"
              >
                按小时
              </button>
              <button
                data-active={trendBucket === "day" ? "true" : "false"}
                onClick={() => changeTrendBucket("day")}
                type="button"
              >
                按天
              </button>
            </div>
            {loading ? <Loader2 className={styles.spin} size={16} /> : null}
          </div>
        </div>
        <UsageTrendChart points={trend} />
      </section>

      <section className={styles.tablePanel}>
        <div className={styles.panelHeader}>
          <div>
            <h2>请求日志</h2>
            <p>共 {formatNumber(requests.total)} 条记录</p>
          </div>
        </div>
        <UsageRequestTable rows={requests.list} loading={loading} onOpen={(id) => setDetailId(id)} />
        <footer className={styles.pagination}>
          <button disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">
            上一页
          </button>
          <span>
            第 {requests.page} / {totalPages} 页
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            type="button"
          >
            下一页
          </button>
        </footer>
      </section>

      <UsageDetailLayer requestId={detailId} runtime={runtime} onClose={() => setDetailId("")} />
    </main>
  );
}

function ModelFilter({
  models,
  value,
  onChange,
}: {
  models: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return keyword ? models.filter((item) => item.toLowerCase().includes(keyword)) : models;
  }, [models, query]);

  return (
    <div className={styles.modelFilter}>
      <button className={styles.filterButton} onClick={() => setOpen((item) => !item)} type="button">
        <span>{value || "全部模型"}</span>
        <ChevronDown size={15} />
      </button>
      {open ? (
        <div className={styles.modelMenu} role="dialog" aria-label="选择模型">
          <label className={styles.modelSearch}>
            <Search size={15} />
            <input
              aria-label="筛选模型"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="筛选模型"
              value={query}
            />
          </label>
          <button
            data-active={!value ? "true" : "false"}
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
            type="button"
          >
            全部模型
          </button>
          {filtered.map((model) => (
            <button
              data-active={value === model ? "true" : "false"}
              key={model}
              onClick={() => {
                onChange(model);
                setOpen(false);
              }}
              title={model}
              type="button"
            >
              {model}
            </button>
          ))}
          {filtered.length === 0 ? <div className={styles.menuEmpty}>没有匹配模型</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function MetricCard({
  icon,
  label,
  primary,
  secondary,
  progress,
  featured = false,
}: {
  icon?: ReactNode;
  label: string;
  primary: string;
  secondary: string;
  progress?: number;
  featured?: boolean;
}) {
  const percent = progress === undefined ? null : Math.max(0, Math.min(1, progress));
  return (
    <article className={styles.metricCard} data-featured={featured ? "true" : "false"}>
      <div className={styles.metricLabel}>
        {icon}
        <span>{label}</span>
      </div>
      <strong>{primary}</strong>
      {percent === null ? (
        <span>{secondary}</span>
      ) : (
        <div className={styles.metricProgress} aria-label={`${secondary} ${formatPercent(percent)}`}>
          <div className={styles.progressMeta}>
            <span>{secondary}</span>
            <strong>{formatPercent(percent)}</strong>
          </div>
          <div className={styles.progressTrack}>
            <span style={{ width: `${Math.round(percent * 1000) / 10}%` }} />
          </div>
        </div>
      )}
    </article>
  );
}

export function UsageTrendChart({ points }: { points: UsageTrendPoint[] }) {
  const chartRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!chartRef.current || points.length === 0) {
      return;
    }
    const chart = echarts.init(chartRef.current, undefined, { renderer: "svg" });
    chart.setOption(buildUsageTrendOption(points));
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.dispose();
    };
  }, [points]);

  if (points.length === 0) {
    return (
      <div className={styles.chartEmpty} data-testid="usage-trend-empty">
        暂无趋势数据
      </div>
    );
  }

  return <div ref={chartRef} className={styles.chart} data-testid="usage-trend-chart" />;
}

export function buildUsageTrendOption(points: UsageTrendPoint[]): EChartsOption {
  const labels = points.map((item) => formatTrendAxisLabel(item.time));
  return {
    animationDuration: 260,
    color: ["#1f75ff", "#16a064", "#d9480f", "#7c5cff"],
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(255,255,255,0.96)",
      borderColor: "#e5e5e5",
      textStyle: { color: "#171717" },
    },
    legend: {
      bottom: 0,
      data: ["非缓存输入", "命中缓存", "输出", "请求数"],
      itemWidth: 9,
      itemHeight: 9,
      textStyle: { color: "#7a7a7a" },
    },
    grid: { left: 46, right: 28, top: 28, bottom: 44 },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: labels,
      axisLine: { lineStyle: { color: "#e5e5e5" } },
      axisTick: { show: false },
      axisLabel: { color: "#8a8a8a" },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: "#8a8a8a" },
      splitLine: { lineStyle: { color: "#eeeeee", type: "dashed" } },
    },
    series: [
      {
        name: "非缓存输入",
        type: "line",
        smooth: true,
        areaStyle: { opacity: 0.08 },
        data: points.map((item) => nonCacheInputTokens(item)),
      },
      { name: "命中缓存", type: "line", smooth: true, data: points.map((item) => item.cache_read_tokens) },
      { name: "输出", type: "line", smooth: true, data: points.map((item) => item.output_tokens) },
      { name: "请求数", type: "line", smooth: true, yAxisIndex: 0, data: points.map((item) => item.request_count) },
    ],
  };
}

function UsageRequestTable({
  rows,
  loading,
  onOpen,
}: {
  rows: UsageRequestLog[];
  loading: boolean;
  onOpen: (requestId: string) => void;
}) {
  if (!loading && rows.length === 0) {
    return (
      <div className={styles.tableEmpty} data-testid="usage-request-empty">
        暂无请求日志
      </div>
    );
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>时间</th>
            <th>模型</th>
            <th>总输入</th>
            <th>命中缓存</th>
            <th>输出</th>
            <th>总量</th>
            <th>耗时</th>
            <th>状态</th>
            <th>会话</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} onClick={() => onOpen(row.id)} tabIndex={0}>
              <td>{formatDateTime(row.start_time)}</td>
              <td title={row.model}>{row.model}</td>
              <td>{formatNumber(row.input_tokens)}</td>
              <td>{formatNumber(row.cache_read_tokens)}</td>
              <td>{formatNumber(row.output_tokens)}</td>
              <td>{formatNumber(row.total_tokens)}</td>
              <td>{formatDuration(row.duration_ms)}</td>
              <td>
                <span className={styles.status} data-status={row.status}>
                  {statusLabel(row.status)}
                </span>
              </td>
              <td title={row.session_id}>{shortId(row.session_id)}</td>
            </tr>
          ))}
          {loading ? (
            <tr>
              <td colSpan={9}>
                <span className={styles.loadingLine}>
                  <Loader2 className={styles.spin} size={15} />
                  正在读取请求日志
                </span>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function UsageDetailLayer({
  requestId,
  runtime,
  onClose,
}: {
  requestId: string;
  runtime: RuntimeBridge;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<UsageRequestDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!requestId) {
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    setDetail(null);
    void runtime.usage
      .getRequestDetail(requestId)
      .then((value) => {
        if (active) {
          setDetail(value);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(errorMessage(reason));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [requestId, runtime]);

  if (!requestId) {
    return null;
  }

  return (
    <div className={styles.detailOverlay} role="presentation" onMouseDown={onClose}>
      <aside
        className={styles.detail}
        role="dialog"
        aria-label="请求详情"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2>请求详情</h2>
            <p>{requestId}</p>
          </div>
          <button aria-label="关闭详情" onClick={onClose} type="button">
            <X size={17} />
          </button>
        </header>
        {loading ? (
          <div className={styles.detailState}>
            <Loader2 className={styles.spin} size={16} />
            正在读取详情
          </div>
        ) : null}
        {error ? <div className={styles.detailError}>{error}</div> : null}
        {detail ? <UsageDetailContent detail={detail} /> : null}
      </aside>
    </div>
  );
}

function UsageDetailContent({ detail }: { detail: UsageRequestDetail }) {
  const request = detail.request;
  return (
    <div className={styles.detailBody}>
      <section>
        <h3>基本信息</h3>
        <dl>
          <dt>模型</dt>
          <dd>{request.model}</dd>
          <dt>状态</dt>
          <dd>{statusLabel(request.status)}</dd>
          <dt>耗时</dt>
          <dd>{formatDuration(request.duration_ms)}</dd>
          <dt>Trace</dt>
          <dd>{request.trace_id}</dd>
          <dt>网关 Thread</dt>
          <dd>{request.gateway_thread_id || "-"}</dd>
          <dt>网关 Trace</dt>
          <dd>{request.gateway_trace_id || "-"}</dd>
          <dt>会话</dt>
          <dd>{request.session_id}</dd>
        </dl>
      </section>
      <section>
        <h3>Token 明细</h3>
        <div className={styles.detailTokens}>
          <span>总输入 {formatNumber(request.input_tokens)}</span>
          <span>非缓存输入 {formatNumber(nonCacheInputTokens(request))}</span>
          <span>命中缓存 {formatNumber(request.cache_read_tokens)}</span>
          <span>输出 {formatNumber(request.output_tokens)}</span>
          <span>总量 {formatNumber(request.total_tokens)}</span>
        </div>
      </section>
      {request.error_message ? (
        <section>
          <h3>错误信息</h3>
          <pre>{request.error_message}</pre>
        </section>
      ) : null}
      <section>
        <h3>请求摘要</h3>
        <pre>{request.request_preview || "无请求摘要"}</pre>
      </section>
      <section>
        <h3>响应摘要</h3>
        <pre>{request.response_preview || "无响应摘要"}</pre>
      </section>
      <section>
        <h3>事件摘要</h3>
        {detail.events.length ? (
          <ul className={styles.eventList}>
            {detail.events.map((event) => (
              <li key={event.id}>
                <strong>{event.event_type}</strong>
                <span>{event.source}</span>
                <small>{event.payload_summary}</small>
              </li>
            ))}
          </ul>
        ) : (
          <div className={styles.detailState}>暂无事件摘要</div>
        )}
      </section>
    </div>
  );
}

function collectModelOptions(providers: ModelProvider[], requestRows: UsageRequestLog[], selectedModel: string) {
  const values = new Set<string>();
  providers.forEach((provider) => provider.models.forEach((model) => values.add(model)));
  requestRows.forEach((row) => values.add(row.model));
  if (selectedModel) {
    values.add(selectedModel);
  }
  return Array.from(values).sort((left, right) => left.localeCompare(right));
}

function computeRange(preset: RangePreset) {
  const end = new Date();
  const start = new Date(end);
  if (preset === "today") {
    start.setHours(0, 0, 0, 0);
  } else if (preset === "30d") {
    start.setDate(start.getDate() - 29);
    start.setHours(0, 0, 0, 0);
  } else {
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
  }
  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

function rangeLabel(preset: RangePreset) {
  if (preset === "today") {
    return "今天";
  }
  if (preset === "30d") {
    return "近 30 天";
  }
  if (preset === "custom") {
    return "自定义";
  }
  return "近 7 天";
}

function fromDateTimeLocal(value: string) {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function toDateTimeLocal(value: string | undefined) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function formatRange(startTime?: string, endTime?: string) {
  if (!startTime || !endTime) {
    return "全部时间";
  }
  return `${formatDate(startTime)} - ${formatDate(endTime)}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTrendAxisLabel(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?/.exec(value);
  if (!match) {
    return value;
  }
  const [, , month, day, hour] = match;
  const dateLabel = `${month}/${day}`;
  return hour ? `${dateLabel} ${hour}:00` : dateLabel;
}

function formatNumber(value: number | null | undefined) {
  return new Intl.NumberFormat("zh-CN").format(value ?? 0);
}

function nonCacheInputTokens(value: TokenInputLike) {
  return Math.max(0, (value.input_tokens ?? 0) - (value.cache_read_tokens ?? 0));
}

function cacheHitRate(cacheReadTokens: number | null | undefined, inputTokens: number | null | undefined) {
  const totalInput = inputTokens ?? 0;
  if (totalInput <= 0) {
    return 0;
  }
  return (cacheReadTokens ?? 0) / totalInput;
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(value: number | null | undefined) {
  const ms = Math.max(0, value ?? 0);
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function statusLabel(status: string) {
  if (status === "completed") {
    return "成功";
  }
  if (status === "failed") {
    return "失败";
  }
  if (status === "running") {
    return "运行中";
  }
  if (status === "cancelled") {
    return "已取消";
  }
  return status || "未知";
}

function shortId(value: string) {
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 8)}...`;
}

function errorMessage(reason: unknown) {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "读取用量统计失败";
}
