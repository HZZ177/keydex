import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import {
  BarChart3,
  CalendarDays,
  ChevronDown,
  Database,
  LocateFixed,
  Loader2,
  RefreshCw,
  Search,
  Upload,
  Zap,
} from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";

import { runtimeBridge, type ModelProvider, type RuntimeBridge } from "@/runtime";
import { AppDialog } from "@/renderer/components/dialog";
import { AppTooltipLayer } from "@/renderer/components/tooltip";
import { prefersReducedMotion } from "@/renderer/utils/motionPreference";
import type {
  UsageRequestDetail,
  UsageRequestListResponse,
  UsageRequestLog,
  UsageSummary,
  UsageBucket,
  UsageTrendPoint,
} from "@/types/protocol";

import {
  UsageDateTimeRangePicker,
  type UsageDateTimeRangeValue,
} from "./UsageDateTimeRangePicker";
import styles from "./UsageStatsPage.module.css";

type RangePreset = "today" | "7d" | "30d" | "custom";
type TokenHeatBucket = "day" | "week";
type TokenInputLike = {
  input_tokens?: number | null;
  cache_read_tokens?: number | null;
};
type TokenHeatWallCell = {
  time: string;
  column: number;
  totalTokens: number;
  weeklyTotalTokens: number;
  level: number;
  weeklyLevel: number;
  tooltip: string;
  weeklyTooltip: string;
  weekLabel: string;
  outsideRange: boolean;
};
type TokenHeatWallMarker = {
  column: number;
  label: string;
};
type TokenHeatTooltipState = {
  title: string;
  value: number;
  left: number;
  top: number;
};

const PAGE_SIZE = 12;
const TREND_PROGRESSIVE_POINT_THRESHOLD = 240;
const TREND_BATCH_POINT_LIMIT = 168;
const TOKEN_HEAT_RIPPLE_DELAY_PER_DISTANCE = 0.018;
const TOKEN_HEAT_RIPPLE_EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];
const TOKEN_HEAT_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;
const TOKEN_HEAT_RIPPLE_INITIAL_SCALE = 0.28;
const TOKEN_HEAT_RIPPLE_SPRING = {
  type: "spring",
  stiffness: 300,
  damping: 14,
  mass: 0.75,
  restDelta: 0.001,
  restSpeed: 0.001,
} as const;
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
  onNavigateToConversationTurn?: (target: UsageConversationTurnTarget) => void;
}

export interface UsageConversationTurnTarget {
  sessionId: string;
  turnIndex: number;
}

export function UsageStatsPage({ runtime = runtimeBridge, onNavigateToConversationTurn }: UsageStatsPageProps) {
  const [rangePreset, setRangePreset] = useState<RangePreset>("7d");
  const initialCustomRange = useMemo(() => computeRange("7d"), []);
  const [customRange, setCustomRange] = useState<UsageDateTimeRangeValue>(initialCustomRange);
  const [selectedModel, setSelectedModel] = useState("");
  const [trendBucket, setTrendBucket] = useState<UsageBucket>("hour");
  const [heatBucket, setHeatBucket] = useState<TokenHeatBucket>("day");
  const [page, setPage] = useState(1);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [heatRefreshNonce, setHeatRefreshNonce] = useState(0);
  const [summary, setSummary] = useState<UsageSummary>(EMPTY_SUMMARY);
  const [trend, setTrend] = useState<UsageTrendPoint[]>([]);
  const [heatTrend, setHeatTrend] = useState<UsageTrendPoint[]>([]);
  const [requests, setRequests] = useState<UsageRequestListResponse>(EMPTY_REQUESTS);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [detailId, setDetailId] = useState("");
  const [statsLoading, setStatsLoading] = useState(true);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [heatLoading, setHeatLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const timezoneOffsetMinutes = useMemo(() => -new Date().getTimezoneOffset(), []);
  const heatRange = useMemo(() => computeHeatWallRange(), [heatRefreshNonce, refreshNonce]);

  const range = useMemo(
    () => (rangePreset === "custom" ? customRange : computeRange(rangePreset)),
    [customRange, rangePreset],
  );
  const query = useMemo(
    () => ({
      ...range,
      model: selectedModel || undefined,
    }),
    [range, selectedModel],
  );
  const modelOptions = useMemo(
    () => collectModelOptions(providers, requests.list, selectedModel),
    [providers, requests.list, selectedModel],
  );
  const error = statsError ?? requestsError;

  useEffect(() => {
    let active = true;
    setStatsLoading(true);
    void Promise.all([
      runtime.usage.getSummary(query),
      loadUsageTrend({
        bucket: trendBucket,
        onPoints: (points) => {
          if (active) {
            setTrend(points);
          }
        },
        query,
        range,
        runtime,
        timezoneOffsetMinutes,
      }),
      runtime.models.listProviders().catch(() => [] as ModelProvider[]),
    ])
      .then(([nextSummary, nextTrend, nextProviders]) => {
        if (!active) {
          return;
        }
        setStatsError(null);
        setSummary(nextSummary);
        setTrend(nextTrend);
        setProviders(nextProviders);
      })
      .catch((reason: unknown) => {
        if (!active) {
          return;
        }
        setStatsError(errorMessage(reason));
        setSummary(EMPTY_SUMMARY);
        setTrend([]);
        setProviders([]);
      })
      .finally(() => {
        if (active) {
          setStatsLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [query, range, refreshNonce, runtime, timezoneOffsetMinutes, trendBucket]);

  useEffect(() => {
    let active = true;
    setRequestsLoading(true);
    void runtime.usage
      .listRequests({ ...query, page, pageSize: PAGE_SIZE })
      .then((nextRequests) => {
        if (active) {
          setRequestsError(null);
          setRequests(nextRequests);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setRequestsError(errorMessage(reason));
          setRequests({ ...EMPTY_REQUESTS, page });
        }
      })
      .finally(() => {
        if (active) {
          setRequestsLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [page, query, refreshNonce, runtime]);

  useEffect(() => {
    let active = true;
    setHeatLoading(true);
    const query = {
      ...heatRange,
      model: selectedModel || undefined,
    };
    void runtime.usage
      .getTrend({
        ...query,
        bucket: "day",
        timezoneOffsetMinutes,
      })
      .then((nextTrend) => {
        if (active) {
          setHeatTrend(completeUsageTrendPoints(nextTrend.points, "day", heatRange, timezoneOffsetMinutes));
        }
      })
      .catch(() => {
        if (active) {
          setHeatTrend([]);
        }
      })
      .finally(() => {
        if (active) {
          setHeatLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [heatRange, runtime, selectedModel, timezoneOffsetMinutes]);

  const totalPages = Math.max(1, Math.ceil(requests.total / requests.page_size));

  function changeRange(next: RangePreset) {
    setRangePreset(next);
    setPage(1);
  }

  function applyCustomRange(next: UsageDateTimeRangeValue) {
    setCustomRange(next);
    setRangePreset("custom");
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
    <main className={styles.page} data-settings-page data-testid="usage-stats-page" data-usage-tooltips="true">
      <AppTooltipLayer scopeSelector="[data-usage-tooltips='true']" defaultPlacement="top" />
      <header className={styles.header} data-settings-header>
        <div>
          <h1>用量统计</h1>
          <p>查看本地智能体的模型请求与 Token 使用情况</p>
        </div>
      </header>

      <section className={styles.settingsGroup} data-settings-group aria-labelledby="usage-year-title">
        <div className={styles.groupHeader} data-settings-group-header>
          <h2 id="usage-year-title">年度概览</h2>
          <span>最近 1 年{selectedModel ? ` · ${selectedModel}` : ""}</span>
        </div>
        <section className={styles.overviewGrid} aria-label="用量总览">
          <section className={styles.chartPanel} data-settings-panel>
            <div className={styles.chartToolbar}>
              <span className={styles.chartRange}>
                最近 1 年
                {selectedModel ? ` · ${selectedModel}` : ""}
              </span>
              <div className={styles.panelHeaderActions}>
                <div className={styles.bucketToggle} aria-label="Token 热力粒度">
                  <button
                    data-active={heatBucket === "day" ? "true" : "false"}
                    onClick={() => setHeatBucket("day")}
                    type="button"
                  >
                    每日
                  </button>
                  <button
                    data-active={heatBucket === "week" ? "true" : "false"}
                    onClick={() => setHeatBucket("week")}
                    type="button"
                  >
                    每周
                  </button>
                </div>
                <button
                  aria-label="刷新年度概览"
                  className={styles.heatRefreshButton}
                  disabled={heatLoading}
                  onClick={() => setHeatRefreshNonce((value) => value + 1)}
                  type="button"
                >
                  {heatLoading ? <Loader2 className={styles.spin} size={14} /> : <RefreshCw size={14} />}
                </button>
              </div>
            </div>
            <TokenHeatWall
              points={heatTrend}
              bucket={heatBucket}
              rippleKey={`${refreshNonce}:${heatRefreshNonce}:${selectedModel}`}
            />
          </section>
        </section>
      </section>

      <section className={styles.settingsGroup} data-settings-group aria-labelledby="usage-current-title">
        <div className={styles.groupHeader} data-settings-group-header>
          <h2 id="usage-current-title">数据统计</h2>
          <span>
            {formatRange(range.startTime, range.endTime)}
            {selectedModel ? ` · ${selectedModel}` : ""}
          </span>
        </div>
        <div className={styles.controlStrip} aria-label="用量筛选">
          <ModelFilter models={modelOptions} value={selectedModel} onChange={changeModel} />
          <section className={styles.rangeBar} aria-label="时间范围">
            <CalendarDays size={16} />
            {(["today", "7d", "30d"] as RangePreset[]).map((item) => (
              <button
                data-active={rangePreset === item ? "true" : "false"}
                key={item}
                onClick={() => changeRange(item)}
                type="button"
              >
                {rangeLabel(item)}
              </button>
            ))}
            <UsageDateTimeRangePicker
              active={rangePreset === "custom"}
              onApply={applyCustomRange}
              value={customRange}
            />
          </section>
          <button
            className={styles.iconButton}
            data-settings-secondary
            type="button"
            onClick={() => setRefreshNonce((value) => value + 1)}
          >
            <RefreshCw size={16} />
            <span>刷新</span>
          </button>
        </div>
        <section className={styles.scopedStats} aria-label="时间范围统计">
        {error ? (
          <section className={styles.error} data-settings-error role="alert">
            <span>{error}</span>
            <button data-settings-secondary type="button" onClick={() => setRefreshNonce((value) => value + 1)}>
              重试
            </button>
          </section>
        ) : null}

        <section className={styles.metrics} aria-label="用量指标" data-loading={statsLoading ? "true" : "false"}>
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

        <section className={styles.chartPanel} data-settings-panel>
          <div className={styles.chartToolbar}>
            <span className={styles.chartRange}>
              {formatRange(range.startTime, range.endTime)}
              {selectedModel ? ` · ${selectedModel}` : ""}
            </span>
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
              {statsLoading ? <Loader2 className={styles.spin} size={16} /> : null}
            </div>
          </div>
          <UsageTrendChart points={trend} />
        </section>

        <section className={styles.tablePanel} data-settings-panel>
          <div className={styles.panelHeader}>
            <div>
              <h2>请求日志</h2>
              <p>共 {formatNumber(requests.total)} 条记录</p>
            </div>
          </div>
          <UsageRequestTable rows={requests.list} loading={requestsLoading} onOpen={(id) => setDetailId(id)} />
          <footer className={styles.pagination}>
            <button
              data-settings-secondary
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              type="button"
            >
              上一页
            </button>
            <span>
              第 {requests.page} / {totalPages} 页
            </span>
            <button
              data-settings-secondary
              disabled={page >= totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              type="button"
            >
              下一页
            </button>
          </footer>
        </section>
        </section>
      </section>

      <UsageDetailLayer
        requestId={detailId}
        runtime={runtime}
        onClose={() => setDetailId("")}
        onNavigateToConversationTurn={onNavigateToConversationTurn}
      />
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return keyword ? models.filter((item) => item.toLowerCase().includes(keyword)) : models;
  }, [models, query]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className={styles.modelFilter} ref={rootRef}>
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

async function loadUsageTrend({
  bucket,
  onPoints,
  query,
  range,
  runtime,
  timezoneOffsetMinutes,
}: {
  bucket: UsageBucket;
  onPoints: (points: UsageTrendPoint[]) => void;
  query: { startTime?: string; endTime?: string; model?: string };
  range: { startTime?: string; endTime?: string };
  runtime: RuntimeBridge;
  timezoneOffsetMinutes: number;
}) {
  const estimatedPoints = estimateUsageTrendPointCount(range, bucket, timezoneOffsetMinutes);
  if (estimatedPoints <= TREND_PROGRESSIVE_POINT_THRESHOLD) {
    const nextTrend = await runtime.usage.getTrend({
      ...query,
      bucket,
      timezoneOffsetMinutes,
    });
    const completed = completeUsageTrendPoints(nextTrend.points, bucket, range, timezoneOffsetMinutes);
    onPoints(completed);
    return completed;
  }

  let mergedPoints: UsageTrendPoint[] = [];
  const chunks = buildUsageTrendChunks(range, bucket, timezoneOffsetMinutes, TREND_BATCH_POINT_LIMIT);
  for (const chunk of chunks) {
    const nextTrend = await runtime.usage.getTrend({
      ...query,
      ...chunk,
      bucket,
      limit: TREND_BATCH_POINT_LIMIT,
      timezoneOffsetMinutes,
    });
    mergedPoints = mergeUsageTrendPoints(mergedPoints, nextTrend.points);
    const completed = completeUsageTrendPoints(mergedPoints, bucket, range, timezoneOffsetMinutes);
    onPoints(completed);
  }
  return completeUsageTrendPoints(mergedPoints, bucket, range, timezoneOffsetMinutes);
}

export function TokenHeatWall({
  points,
  bucket,
  rippleKey = "initial",
}: {
  points: UsageTrendPoint[];
  bucket: TokenHeatBucket;
  rippleKey?: string;
}) {
  const [hoveredColumn, setHoveredColumn] = useState<number | null>(null);
  const [hoveredTime, setHoveredTime] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TokenHeatTooltipState | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = prefersReducedMotion();
  const heatWall = useMemo(() => buildTokenHeatWall(points), [points]);
  const heatRippleOrigin = useMemo(() => computeTokenHeatRippleOrigin(heatWall.cells), [heatWall.cells]);
  const heatWallStyle = {
    "--heat-columns": heatWall.columns,
  } as CSSProperties;

  useEffect(() => {
    if (!tooltip) {
      return;
    }
    const hide = () => {
      setHoveredColumn(null);
      setHoveredTime(null);
      setTooltip(null);
    };
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [tooltip]);

  useLayoutEffect(() => {
    if (!tooltip) {
      return;
    }
    const element = tooltipRef.current;
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const viewportMargin = 8;
    const deltaLeft =
      rect.left < viewportMargin
        ? viewportMargin - rect.left
        : rect.right > viewportWidth - viewportMargin
          ? viewportWidth - viewportMargin - rect.right
          : 0;
    const deltaTop =
      rect.top < viewportMargin
        ? viewportMargin - rect.top
        : rect.bottom > viewportHeight - viewportMargin
          ? viewportHeight - viewportMargin - rect.bottom
          : 0;

    if (Math.abs(deltaLeft) < 0.5 && Math.abs(deltaTop) < 0.5) {
      return;
    }

    setTooltip((current) =>
      current
        ? {
            ...current,
            left: Math.round(current.left + deltaLeft),
            top: Math.round(current.top + deltaTop),
          }
        : current,
    );
  }, [tooltip]);

  function hideTooltip() {
    setHoveredColumn(null);
    setHoveredTime(null);
    setTooltip(null);
  }

  return (
    <div className={styles.heatWall} data-empty={points.length === 0 ? "true" : "false"} data-testid="usage-token-heatwall">
      {points.length === 0 ? (
        <div className={styles.heatWallEmpty}>暂无 Token 活动</div>
      ) : (
        <>
          <div className={styles.heatWallViewport}>
            <div className={styles.heatWallMatrix}>
              <div className={styles.heatWallWeekdays} aria-hidden="true">
                {["一", "二", "三", "四", "五", "六", "日"].map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
              <div className={styles.heatWallGrid} style={heatWallStyle}>
                {heatWall.cells.map((cell) => {
                  const isWeekly = bucket === "week";
                  const label = isWeekly ? cell.weeklyTooltip : cell.tooltip;
                  const level = isWeekly ? cell.weeklyLevel : cell.level;
                  const value = isWeekly ? cell.weeklyTotalTokens : cell.totalTokens;
                  const tooltipTitle = isWeekly ? cell.weekLabel : formatHeatCellDate(cell.time);
                  const outsideRange = isWeekly ? false : cell.outsideRange;
                  const active =
                    isWeekly && hoveredColumn !== null
                      ? hoveredColumn === cell.column
                      : hoveredTime === cell.time;
                  return (
                    <motion.button
                      aria-label={label}
                      className={styles.heatCell}
                      data-active={active ? "true" : "false"}
                      data-level={level}
                      data-outside={outsideRange ? "true" : "false"}
                      key={cell.time}
                      onBlur={hideTooltip}
                      onFocus={(event) => {
                        setHoveredColumn(cell.column);
                        setHoveredTime(cell.time);
                        setTooltip({
                          title: tooltipTitle,
                          value,
                          ...positionHeatTooltip(event.currentTarget),
                        });
                      }}
                      onMouseEnter={(event) => {
                        setHoveredColumn(cell.column);
                        setHoveredTime(cell.time);
                        setTooltip({
                          title: tooltipTitle,
                          value,
                          ...positionHeatTooltip(event.currentTarget),
                        });
                      }}
                      onMouseLeave={hideTooltip}
                      type="button"
                      whileHover={
                        reducedMotion
                          ? undefined
                          : { y: -1, transition: { duration: 0.14, ease: TOKEN_HEAT_RIPPLE_EASE } }
                      }
                    >
                      <motion.span
                        aria-hidden="true"
                        animate={
                          reducedMotion
                            ? undefined
                            : {
                                opacity: 1,
                                scale: 1,
                              }
                        }
                        className={styles.heatCellVisual}
                        data-ripple-key={rippleKey}
                        initial={
                          reducedMotion
                            ? false
                            : {
                                opacity: 0,
                                scale: TOKEN_HEAT_RIPPLE_INITIAL_SCALE,
                              }
                        }
                        key={`${cell.time}-${rippleKey}`}
                        transition={
                          reducedMotion
                            ? undefined
                            : tokenHeatRippleTransition(tokenHeatRippleDelay(cell, heatRippleOrigin))
                        }
                      />
                    </motion.button>
                  );
                })}
              </div>
            </div>
            <div className={styles.heatWallAxisRow}>
              <div aria-hidden="true" />
              <div aria-hidden="true" className={styles.heatWallAxis} style={heatWallStyle}>
                {heatWall.markers.map((marker) => (
                  <span key={`${marker.column}-${marker.label}`} style={{ gridColumn: marker.column + 1 }}>
                    {marker.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className={styles.heatWallLegend} aria-hidden="true">
            <span>少</span>
            <span className={styles.heatWallLegendLevels}>
              {TOKEN_HEAT_LEVELS.map((level) => (
                <i data-level={level} key={level} />
              ))}
            </span>
            <span>多</span>
          </div>
        </>
      )}
      {tooltip
        ? createPortal(
            <div
              className={styles.heatCellTooltip}
              ref={tooltipRef}
              role="tooltip"
              style={{ left: tooltip.left, top: tooltip.top }}
            >
              <strong>{tooltip.title}</strong>
              <span>总 Token {formatNumber(tooltip.value)}</span>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function positionHeatTooltip(target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  return {
    left: Math.round(rect.left + rect.width / 2),
    top: Math.round(rect.top),
  };
}

function computeTokenHeatRippleOrigin(cells: TokenHeatWallCell[]) {
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    const cell = cells[index];
    if (!cell.outsideRange && cell.totalTokens > 0) {
      return { column: cell.column, row: tokenHeatCellRow(cell) };
    }
  }
  const lastCell = cells[cells.length - 1];
  return {
    column: lastCell?.column ?? 0,
    row: 3,
  };
}

function tokenHeatRippleDelay(cell: TokenHeatWallCell, origin: { column: number; row: number }) {
  const distance = Math.hypot(cell.column - origin.column, tokenHeatCellRow(cell) - origin.row);
  return distance * TOKEN_HEAT_RIPPLE_DELAY_PER_DISTANCE;
}

function tokenHeatRippleTransition(delay: number) {
  return {
    opacity: { delay, duration: 0.08, ease: TOKEN_HEAT_RIPPLE_EASE },
    scale: { delay, ...TOKEN_HEAT_RIPPLE_SPRING },
  };
}

function tokenHeatCellRow(cell: Pick<TokenHeatWallCell, "time">) {
  return heatDayRow(parseHeatDate(cell.time));
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
      buildUsageLineSeries({
        name: "非缓存输入",
        data: points.map((item) => nonCacheInputTokens(item)),
        areaStyle: { opacity: 0.08 },
      }),
      buildUsageLineSeries({ name: "命中缓存", data: points.map((item) => item.cache_read_tokens) }),
      buildUsageLineSeries({ name: "输出", data: points.map((item) => item.output_tokens) }),
      buildUsageLineSeries({ name: "请求数", data: points.map((item) => item.request_count), yAxisIndex: 0 }),
    ],
  };
}

function buildUsageLineSeries({
  name,
  data,
  areaStyle,
  yAxisIndex,
}: {
  name: string;
  data: number[];
  areaStyle?: { opacity: number };
  yAxisIndex?: number;
}) {
  return {
    name,
    type: "line" as const,
    smooth: true,
    showSymbol: false,
    symbol: "circle",
    symbolSize: 7,
    emphasis: {
      focus: "series" as const,
      scale: false,
    },
    areaStyle,
    yAxisIndex,
    data,
  };
}

function buildTokenHeatWall(points: UsageTrendPoint[]) {
  if (points.length === 0) {
    return { cells: [] as TokenHeatWallCell[], columns: 1, markers: [] as TokenHeatWallMarker[], totalTokens: 0 };
  }

  const pointByTime = new Map(points.map((point) => [formatHeatDateKey(parseHeatDate(point.time)), point]));
  const rangeStart = parseHeatDate(points[0].time);
  const rangeEnd = parseHeatDate(points[points.length - 1].time);
  const paddedStart = addHeatDays(rangeStart, -heatDayRow(rangeStart));
  const paddedEnd = addHeatDays(rangeEnd, 6 - heatDayRow(rangeEnd));
  const baseCells: Array<Omit<TokenHeatWallCell, "weeklyTotalTokens" | "weeklyLevel" | "weeklyTooltip" | "weekLabel">> = [];
  const cursor = new Date(paddedStart);

  while (cursor.getTime() <= paddedEnd.getTime()) {
    const time = formatHeatDateKey(cursor);
    const point = pointByTime.get(time);
    const column = Math.floor(baseCells.length / 7);
    const outsideRange = cursor.getTime() < rangeStart.getTime() || cursor.getTime() > rangeEnd.getTime();
    const totalTokens = outsideRange ? 0 : totalTokensForTrendPoint(point ?? emptyTrendPoint(time));
    baseCells.push({
      time,
      column,
      totalTokens,
      level: 0,
      tooltip: `${formatHeatCellDate(time)} · 总 Token ${formatNumber(totalTokens)}`,
      outsideRange,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const maxTokens = Math.max(0, ...baseCells.map((cell) => cell.totalTokens));
  const weeklyTotals = new Map<number, number>();
  baseCells.forEach((cell) => {
    weeklyTotals.set(cell.column, (weeklyTotals.get(cell.column) ?? 0) + cell.totalTokens);
  });
  const maxWeeklyTokens = Math.max(0, ...weeklyTotals.values());
  const cells: TokenHeatWallCell[] = baseCells.map((cell) => {
    const weeklyTotalTokens = weeklyTotals.get(cell.column) ?? 0;
    const weekLabel = heatWeekLabel(baseCells, cell.column);
    return {
      ...cell,
      level: tokenHeatLevel(cell.totalTokens, maxTokens),
      weeklyTotalTokens,
      weeklyLevel: tokenHeatLevel(weeklyTotalTokens, maxWeeklyTokens),
      weeklyTooltip: `${weekLabel} · 总 Token ${formatNumber(weeklyTotalTokens)}`,
      weekLabel,
    };
  });

  return {
    cells,
    columns: Math.max(1, Math.ceil(cells.length / 7)),
    markers: buildTokenHeatWallMarkers(cells),
    totalTokens: cells.reduce((sum, cell) => sum + cell.totalTokens, 0),
  };
}

function buildTokenHeatWallMarkers(cells: TokenHeatWallCell[]): TokenHeatWallMarker[] {
  const markers: TokenHeatWallMarker[] = [];
  let lastMarkerColumn = -Infinity;
  let lastMarkerKey = "";
  const minColumnGap = 3;

  cells.forEach((cell) => {
    const markerKey = tokenHeatMarkerKey(cell.time);
    if (!markerKey || markerKey === lastMarkerKey) {
      return;
    }

    const column = cell.column;
    if (markers.length > 0 && column - lastMarkerColumn < minColumnGap) {
      lastMarkerKey = markerKey;
      return;
    }

    markers.push({
      column,
      label: formatTokenHeatMarkerLabel(cell.time),
    });
    lastMarkerColumn = column;
    lastMarkerKey = markerKey;
  });

  return markers;
}

function totalTokensForTrendPoint(point: UsageTrendPoint) {
  if (point.total_tokens > 0) {
    return point.total_tokens;
  }
  return Math.max(0, (point.input_tokens ?? 0) + (point.output_tokens ?? 0));
}

function tokenHeatLevel(totalTokens: number, maxTokens: number) {
  if (totalTokens <= 0 || maxTokens <= 0) {
    return 0;
  }
  const ratio = Math.min(1, totalTokens / maxTokens);
  return Math.max(1, Math.ceil(ratio * 8));
}

function parseHeatDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    const fallback = new Date(value);
    if (!Number.isNaN(fallback.getTime())) {
      return new Date(Date.UTC(fallback.getFullYear(), fallback.getMonth(), fallback.getDate()));
    }
    return new Date(Date.UTC(1970, 0, 1));
  }
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

function addHeatDays(value: Date, days: number) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function heatDayRow(value: Date) {
  return (value.getUTCDay() + 6) % 7;
}

function formatHeatDateKey(value: Date) {
  return `${value.getUTCFullYear()}-${padDatePart(value.getUTCMonth() + 1)}-${padDatePart(value.getUTCDate())}`;
}

function formatHeatCellDate(value: string) {
  const date = parseHeatDate(value);
  return `${padDatePart(date.getUTCMonth() + 1)}/${padDatePart(date.getUTCDate())}`;
}

function heatWeekLabel(cells: Array<Pick<TokenHeatWallCell, "time" | "column">>, column: number) {
  const weekCells = cells.filter((cell) => cell.column === column);
  const first = weekCells[0];
  const last = weekCells[weekCells.length - 1];
  if (!first || !last) {
    return "";
  }
  return `${formatHeatCellDate(first.time)} - ${formatHeatCellDate(last.time)}`;
}

function tokenHeatMarkerKey(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    return value;
  }
  const [, year, month] = match;
  return `${year}-${month}`;
}

function formatTokenHeatMarkerLabel(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    return value;
  }
  const [, , month] = match;
  return `${Number(month)}月`;
}

export function completeUsageTrendPoints(
  points: UsageTrendPoint[],
  bucket: UsageBucket,
  range: { startTime?: string; endTime?: string },
  timezoneOffsetMinutes: number,
): UsageTrendPoint[] {
  if (!points.length || !range.startTime || !range.endTime) {
    return points;
  }

  const start = toUsageBucketDate(range.startTime, bucket, timezoneOffsetMinutes);
  const end = toUsageBucketDate(range.endTime, bucket, timezoneOffsetMinutes);
  if (!start || !end || end.getTime() < start.getTime()) {
    return points;
  }

  const pointsByTime = new Map(points.map((point) => [point.time, point]));
  const completed: UsageTrendPoint[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    const time = formatUsageBucketKey(cursor, bucket);
    completed.push(pointsByTime.get(time) ?? emptyTrendPoint(time));
    advanceUsageBucket(cursor, bucket);
  }
  return completed;
}

function estimateUsageTrendPointCount(
  range: { startTime?: string; endTime?: string },
  bucket: UsageBucket,
  timezoneOffsetMinutes: number,
) {
  if (!range.startTime || !range.endTime) {
    return 0;
  }
  const start = toUsageBucketDate(range.startTime, bucket, timezoneOffsetMinutes);
  const end = toUsageBucketDate(range.endTime, bucket, timezoneOffsetMinutes);
  if (!start || !end || end.getTime() < start.getTime()) {
    return 0;
  }
  const bucketMs = bucket === "hour" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return Math.floor((end.getTime() - start.getTime()) / bucketMs) + 1;
}

function buildUsageTrendChunks(
  range: { startTime?: string; endTime?: string },
  bucket: UsageBucket,
  timezoneOffsetMinutes: number,
  bucketLimit: number,
) {
  if (!range.startTime || !range.endTime) {
    return [{ startTime: range.startTime, endTime: range.endTime }];
  }
  const rangeStart = new Date(range.startTime);
  const rangeEnd = new Date(range.endTime);
  const bucketStart = toUsageBucketDate(range.startTime, bucket, timezoneOffsetMinutes);
  const bucketEnd = toUsageBucketDate(range.endTime, bucket, timezoneOffsetMinutes);
  if (
    Number.isNaN(rangeStart.getTime()) ||
    Number.isNaN(rangeEnd.getTime()) ||
    !bucketStart ||
    !bucketEnd ||
    rangeEnd.getTime() < rangeStart.getTime()
  ) {
    return [{ startTime: range.startTime, endTime: range.endTime }];
  }

  const chunks: Array<{ startTime: string; endTime: string }> = [];
  const cursor = new Date(bucketStart);
  while (cursor.getTime() <= bucketEnd.getTime()) {
    const nextCursor = new Date(cursor);
    advanceUsageBucketBy(nextCursor, bucket, bucketLimit);
    const chunkStart = maxDate(new Date(cursor.getTime() - timezoneOffsetMinutes * 60_000), rangeStart);
    const chunkEnd = minDate(new Date(nextCursor.getTime() - timezoneOffsetMinutes * 60_000 - 1), rangeEnd);
    if (chunkEnd.getTime() >= chunkStart.getTime()) {
      chunks.push({
        startTime: chunkStart.toISOString(),
        endTime: chunkEnd.toISOString(),
      });
    }
    cursor.setTime(nextCursor.getTime());
  }
  return chunks.length ? chunks : [{ startTime: range.startTime, endTime: range.endTime }];
}

function mergeUsageTrendPoints(left: UsageTrendPoint[], right: UsageTrendPoint[]) {
  const pointsByTime = new Map<string, UsageTrendPoint>();
  left.forEach((point) => pointsByTime.set(point.time, point));
  right.forEach((point) => pointsByTime.set(point.time, point));
  return Array.from(pointsByTime.values()).sort((a, b) => a.time.localeCompare(b.time));
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
        <colgroup>
          <col className={styles.timeColumn} />
          <col className={styles.modelColumn} />
          <col className={styles.inputCacheColumn} />
          <col className={styles.cacheRateColumn} />
          <col className={styles.outputColumn} />
          <col className={styles.durationColumn} />
          <col className={styles.rateColumn} />
          <col className={styles.statusColumn} />
        </colgroup>
        <thead>
          <tr>
            <th>时间</th>
            <th>模型</th>
            <th>总输入/命中缓存</th>
            <th>缓存命中率</th>
            <th>输出</th>
            <th>用时/首字</th>
            <th>输出速率</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} onClick={() => onOpen(row.id)} tabIndex={0}>
              <td>{formatDateTime(row.start_time)}</td>
              <td>
                <span className={styles.modelCellText} data-tooltip-label={row.model}>
                  {row.model}
                </span>
              </td>
              <td>{formatInputCacheTokens(row)}</td>
              <td>{formatCacheHitPercent(row)}</td>
              <td>{formatNumber(row.output_tokens)}</td>
              <td>{formatUsageLatency(row)}</td>
              <td>{formatOutputTokenRate(row)}</td>
              <td>
                <span className={styles.status} data-status={row.status}>
                  {statusLabel(row.status)}
                </span>
              </td>
            </tr>
          ))}
          {loading ? (
            <tr>
              <td colSpan={8}>
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
  onNavigateToConversationTurn,
}: {
  requestId: string;
  runtime: RuntimeBridge;
  onClose: () => void;
  onNavigateToConversationTurn?: (target: UsageConversationTurnTarget) => void;
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
    <AppDialog
      title="请求详情"
      description={requestId}
      size="drawer"
      placement="right"
      backdrop="panel"
      inset="below-titlebar"
      closeLabel="关闭详情"
      onClose={onClose}
    >
      {loading ? (
        <div className={styles.detailState}>
          <Loader2 className={styles.spin} size={16} />
          正在读取详情
        </div>
      ) : null}
      {error ? <div className={styles.detailError}>{error}</div> : null}
      {detail ? <UsageDetailContent detail={detail} onNavigateToConversationTurn={onNavigateToConversationTurn} /> : null}
    </AppDialog>
  );
}

function UsageDetailContent({
  detail,
  onNavigateToConversationTurn,
}: {
  detail: UsageRequestDetail;
  onNavigateToConversationTurn?: (target: UsageConversationTurnTarget) => void;
}) {
  const request = detail.request;
  const conversationSessionId = (request.active_session_id || request.session_id || "").trim();
  const canNavigateToTurn =
    Boolean(conversationSessionId) && typeof request.turn_index === "number" && Number.isFinite(request.turn_index);
  return (
    <div className={styles.detailBody}>
      <section>
        <div className={styles.detailSectionHeader}>
          <h3>基本信息</h3>
          {canNavigateToTurn && onNavigateToConversationTurn ? (
            <button
              className={styles.detailActionButton}
              type="button"
              onClick={() =>
                onNavigateToConversationTurn({
                  sessionId: conversationSessionId,
                  turnIndex: request.turn_index as number,
                })
              }
            >
              <LocateFixed size={14} />
              <span>跳转对话</span>
            </button>
          ) : null}
        </div>
        <dl>
          <dt>模型</dt>
          <dd>{request.model}</dd>
          <dt>状态</dt>
          <dd>{statusLabel(request.status)}</dd>
          <dt>用时/首字</dt>
          <dd>{formatUsageLatency(request)}</dd>
          <dt>输出速率</dt>
          <dd>{formatOutputTokenRate(request)}</dd>
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
          <span>命中缓存 {formatCacheHitTokens(request)}</span>
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

function computeHeatWallRange() {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 1);
  start.setHours(0, 0, 0, 0);
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

function toUsageBucketDate(value: string, bucket: UsageBucket, timezoneOffsetMinutes: number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const shifted = new Date(date.getTime() + timezoneOffsetMinutes * 60_000);
  if (bucket === "hour") {
    shifted.setUTCMinutes(0, 0, 0);
  } else {
    shifted.setUTCHours(0, 0, 0, 0);
  }
  return shifted;
}

function advanceUsageBucket(value: Date, bucket: UsageBucket) {
  if (bucket === "hour") {
    value.setUTCHours(value.getUTCHours() + 1);
  } else {
    value.setUTCDate(value.getUTCDate() + 1);
  }
}

function advanceUsageBucketBy(value: Date, bucket: UsageBucket, amount: number) {
  if (bucket === "hour") {
    value.setUTCHours(value.getUTCHours() + amount);
  } else {
    value.setUTCDate(value.getUTCDate() + amount);
  }
}

function formatUsageBucketKey(value: Date, bucket: UsageBucket) {
  const year = value.getUTCFullYear();
  const month = padDatePart(value.getUTCMonth() + 1);
  const day = padDatePart(value.getUTCDate());
  if (bucket === "hour") {
    return `${year}-${month}-${day}T${padDatePart(value.getUTCHours())}:00:00`;
  }
  return `${year}-${month}-${day}`;
}

function emptyTrendPoint(time: string): UsageTrendPoint {
  return {
    time,
    request_count: 0,
    input_tokens: 0,
    cache_read_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    failed_count: 0,
  };
}

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

function maxDate(left: Date, right: Date) {
  return left.getTime() >= right.getTime() ? left : right;
}

function minDate(left: Date, right: Date) {
  return left.getTime() <= right.getTime() ? left : right;
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

function formatCacheHitTokens(value: TokenInputLike) {
  return `${formatNumber(value.cache_read_tokens)} (${formatCacheHitPercent(value)})`;
}

function formatInputCacheTokens(value: TokenInputLike) {
  return `${formatNumber(value.input_tokens)} / ${formatNumber(value.cache_read_tokens)}`;
}

function formatCacheHitPercent(value: TokenInputLike) {
  const inputTokens = value.input_tokens ?? 0;
  return inputTokens > 0 ? formatPercent(cacheHitRate(value.cache_read_tokens, inputTokens)) : "-";
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

function formatNullableDuration(value: number | null | undefined) {
  return value == null ? "-" : formatDuration(value);
}

function formatUsageLatency(value: Pick<UsageRequestLog, "time_to_first_token">) {
  return formatNullableDuration(value.time_to_first_token);
}

function formatOutputTokenRate(value: Pick<UsageRequestLog, "call_kind" | "output_tokens_per_second">) {
  if (isNonStreamingCall(value.call_kind)) {
    return "非流式不统计";
  }
  const rate = value.output_tokens_per_second;
  if (rate == null || !Number.isFinite(rate)) {
    return "-";
  }
  return `${Math.max(0, rate).toFixed(1)} tok/s`;
}

function isNonStreamingCall(callKind: string | null | undefined) {
  return callKind === "agenerate" || callKind === "generate";
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

function errorMessage(reason: unknown) {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "读取用量统计失败";
}
