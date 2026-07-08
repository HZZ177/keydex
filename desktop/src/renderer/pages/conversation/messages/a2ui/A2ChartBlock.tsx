import * as echarts from "echarts";
import type { EChartsOption, EChartsType, SeriesOption } from "echarts";
import { type MutableRefObject, useLayoutEffect, useMemo, useRef } from "react";

import type { ParsedA2UIMessage } from "./A2UIBlock";
import styles from "./A2ChartBlock.module.css";
import {
  A2UIMotionItem,
  A2UIMotionRoot,
} from "./A2UIMotion";

export interface A2ChartBlockProps {
  parsed: ParsedA2UIMessage;
}

type ChartType = "trend" | "column" | "pie";

interface ChartSeries {
  name: string;
  data: Array<number | null>;
  categories: string[];
}

interface ChartPoint {
  label: string;
  value: number;
  color?: string;
}

interface ChartSpec {
  type: ChartType;
  title: string;
  seriesLabel: string;
  categories: string[];
  series: ChartSeries[];
  points: ChartPoint[];
}

interface ChartPanelSpec {
  type: ChartType;
  title: string;
  chart: ChartSpec | null;
}

const COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2"];
const ECHARTS_FALLBACK_WIDTH = 620;
const ECHARTS_DEFAULT_HEIGHT = 280;
const ECHARTS_PIE_HEIGHT = 300;
const ECHARTS_STREAM_COMMIT_INTERVAL_MS = 200;
const ECHARTS_STREAM_ANIMATION_DURATION_MS = 170;
const ECHARTS_STREAM_MAX_PENDING_OPTIONS = 2;
const CHART_NUMBER_FORMATTER = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

export function A2ChartBlock({ parsed }: A2ChartBlockProps) {
  const isStreaming = isStreamingStatus(parsed.status) || Boolean(parsed.streamPlayer?.enabled && parsed.streamPlayer.phase !== "created");
  const animateChartUpdates = Boolean(parsed.streamPlayer?.enabled && parsed.streamPlayer.phase !== "created");
  const animateInitialCharts = animateChartUpdates;
  const payload = parsed.payload;
  const normalizedPanels = useMemo(() => normalizeChartPanels(payload, isStreaming, parsed), [isStreaming, parsed, payload]);
  const panels = useStableChartPanels(normalizedPanels, isStreaming, chartPanelStabilityKey(parsed));
  const summary = summaryText(payload.summary);
  const skeletonType = chartSkeletonType(parsed);

  return (
    <A2UIMotionRoot as="section" className={styles.chart} data-testid="a2ui-chart" {...parsed.streamPlayer?.rootProps}>
      {summary && panels.length > 1 ? (
        <A2UIMotionItem as="p" className={styles.summary} motionKey="chart:summary" motionKind="chart-summary">
          {summary}
        </A2UIMotionItem>
      ) : null}
      {panels.length ? (
        panels.map((panel, index) => {
          const caption = chartPanelCaption(panel.title, summary, panels.length);
          return (
            <A2UIMotionItem
              as="div"
              className={styles.panel}
              data-chart-type={panel.type}
              data-testid="a2ui-chart-panel"
              key={`${index}:${panel.type}`}
              motionKey={`chart:panel:${index}:${panel.type}`}
              motionKind="chart-panel"
            >
              {panel.chart ? renderChart(panel.chart, animateInitialCharts, animateChartUpdates) : <ChartSkeleton type={panel.type} />}
              {caption ? (
                <A2UIMotionItem
                  as="div"
                  className={styles.panelTitle}
                  motionKey={`chart:panel:${index}:title`}
                  motionKind="chart-title"
                >
                  {caption}
                </A2UIMotionItem>
              ) : null}
            </A2UIMotionItem>
          );
        })
      ) : isStreaming ? (
        <ChartSkeleton type={skeletonType} />
      ) : (
        <div className={styles.empty}>暂无图表数据</div>
      )}
    </A2UIMotionRoot>
  );
}

function chartPanelCaption(panelTitle: string, summary: string, panelCount: number): string {
  if (panelCount === 1 && summary) {
    return summary;
  }
  return panelTitle;
}

function renderChart(
  chart: ChartSpec,
  animateInitial: boolean,
  animateUpdates: boolean,
) {
  return <EChartsChart chart={chart} animateInitial={animateInitial} animateUpdates={animateUpdates} />;
}

function EChartsChart({
  chart,
  animateInitial,
  animateUpdates,
}: {
  chart: ChartSpec;
  animateInitial: boolean;
  animateUpdates: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const height = chartHeight(chart);
  const heightRef = useRef(height);
  const lastOptionSignatureRef = useRef("");
  const pendingAnimatedOptionsRef = useRef<Array<{ option: EChartsOption; signature: string }>>([]);
  const pendingTerminalOptionRef = useRef<{ option: EChartsOption; signature: string } | null>(null);
  const pendingCommitTimerRef = useRef<number | null>(null);
  const lastAnimatedCommitAtRef = useRef(0);
  const option = useMemo(() => buildEChartsOption(chart), [chart]);
  const optionSignature = useMemo(() => chartOptionSignature(chart), [chart]);
  const interactionMode = isAxisInteractionChart(chart.type) ? "tooltip,axisPointer,legendToggle" : "tooltip,legendToggle";

  heightRef.current = height;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const instance = echarts.init(container, undefined, {
      height,
      renderer: "svg",
      width: ECHARTS_FALLBACK_WIDTH,
    });
    chartRef.current = instance;

    const resize = () => {
      const width = Math.max(320, Math.round(container.getBoundingClientRect().width || ECHARTS_FALLBACK_WIDTH));
      instance.resize({ height: heightRef.current, width });
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(container);
    resize();

    return () => {
      observer?.disconnect();
      if (pendingCommitTimerRef.current !== null) {
        window.clearTimeout(pendingCommitTimerRef.current);
        pendingCommitTimerRef.current = null;
      }
      pendingAnimatedOptionsRef.current = [];
      pendingTerminalOptionRef.current = null;
      chartRef.current = null;
      instance.dispose();
    };
  }, []);

  useLayoutEffect(() => {
    const instance = chartRef.current;
    const container = containerRef.current;
    if (!instance || !container) {
      return;
    }
    const width = Math.max(320, Math.round(container.getBoundingClientRect().width || ECHARTS_FALLBACK_WIDTH));
    instance.resize({ height, width });
  }, [height]);

  useLayoutEffect(() => {
    const instance = chartRef.current;
    if (!instance || lastOptionSignatureRef.current === optionSignature) {
      return;
    }
    const isInitialOption = !lastOptionSignatureRef.current;
    const shouldAnimate = animateUpdates || (isInitialOption && animateInitial);
    if (shouldAnimate) {
      if (isInitialOption) {
        applyEChartsOption(
          instance,
          withStreamingEChartsAnimation(option),
          optionSignature,
          lastOptionSignatureRef,
          true,
        );
        lastAnimatedCommitAtRef.current = nowMs();
        return;
      }
      enqueueAnimatedEChartsOption({
        instance,
        lastAnimatedCommitAtRef,
        lastOptionSignatureRef,
        option,
        pendingAnimatedOptionsRef,
        pendingCommitTimerRef,
        pendingTerminalOptionRef,
        signature: optionSignature,
      });
      return;
    }
    const terminalOption = withoutEChartsAnimation(option);
    if (pendingAnimatedOptionsRef.current.length || pendingCommitTimerRef.current !== null) {
      pendingTerminalOptionRef.current = { option: terminalOption, signature: optionSignature };
      scheduleQueuedEChartsCommit({
        instance,
        lastAnimatedCommitAtRef,
        lastOptionSignatureRef,
        pendingAnimatedOptionsRef,
        pendingCommitTimerRef,
        pendingTerminalOptionRef,
      });
      return;
    }
    applyEChartsOption(instance, terminalOption, optionSignature, lastOptionSignatureRef, false, true);
  }, [animateInitial, animateUpdates, option, optionSignature]);

  return (
    <div
      ref={containerRef}
      className={styles.echartsSurface}
      data-a2ui-chart-category-count={chart.categories.length}
      data-a2ui-chart-animation={animateUpdates ? "enabled" : "settled"}
      data-a2ui-chart-data-count={chartDataCount(chart)}
      data-a2ui-chart-engine="echarts"
      data-a2ui-chart-interactions={interactionMode}
      data-a2ui-chart-paced-commit={animateUpdates ? "true" : "false"}
      data-a2ui-chart-stream-adapter="setOption-diff"
      data-a2ui-chart-tooltip={isAxisInteractionChart(chart.type) ? "axis" : "item"}
      data-chart-type={chart.type}
      data-testid="a2ui-echarts-surface"
      role="img"
      aria-label={chart.title || `${chart.type} chart`}
      style={{ minHeight: height }}
    />
  );
}

function enqueueAnimatedEChartsOption({
  instance,
  lastAnimatedCommitAtRef,
  lastOptionSignatureRef,
  option,
  pendingAnimatedOptionsRef,
  pendingCommitTimerRef,
  pendingTerminalOptionRef,
  signature,
}: {
  instance: EChartsType;
  lastAnimatedCommitAtRef: MutableRefObject<number>;
  lastOptionSignatureRef: MutableRefObject<string>;
  option: EChartsOption;
  pendingAnimatedOptionsRef: MutableRefObject<Array<{ option: EChartsOption; signature: string }>>;
  pendingCommitTimerRef: MutableRefObject<number | null>;
  pendingTerminalOptionRef: MutableRefObject<{ option: EChartsOption; signature: string } | null>;
  signature: string;
}) {
  if (
    pendingAnimatedOptionsRef.current.some((item) => item.signature === signature) ||
    pendingTerminalOptionRef.current?.signature === signature
  ) {
    return;
  }
  pendingAnimatedOptionsRef.current.push({
    option: withStreamingEChartsAnimation(option),
    signature,
  });
  pendingAnimatedOptionsRef.current = collapsePendingAnimatedEChartsOptions(pendingAnimatedOptionsRef.current);
  scheduleQueuedEChartsCommit({
    instance,
    lastAnimatedCommitAtRef,
    lastOptionSignatureRef,
    pendingAnimatedOptionsRef,
    pendingCommitTimerRef,
    pendingTerminalOptionRef,
  });
}

function collapsePendingAnimatedEChartsOptions(
  pendingOptions: Array<{ option: EChartsOption; signature: string }>,
): Array<{ option: EChartsOption; signature: string }> {
  if (pendingOptions.length <= ECHARTS_STREAM_MAX_PENDING_OPTIONS) {
    return pendingOptions;
  }
  const first = pendingOptions[0];
  const latest = pendingOptions[pendingOptions.length - 1];
  return first.signature === latest.signature ? [first] : [first, latest];
}

function scheduleQueuedEChartsCommit({
  instance,
  lastAnimatedCommitAtRef,
  lastOptionSignatureRef,
  pendingAnimatedOptionsRef,
  pendingCommitTimerRef,
  pendingTerminalOptionRef,
}: {
  instance: EChartsType;
  lastAnimatedCommitAtRef: MutableRefObject<number>;
  lastOptionSignatureRef: MutableRefObject<string>;
  pendingAnimatedOptionsRef: MutableRefObject<Array<{ option: EChartsOption; signature: string }>>;
  pendingCommitTimerRef: MutableRefObject<number | null>;
  pendingTerminalOptionRef: MutableRefObject<{ option: EChartsOption; signature: string } | null>;
}) {
  if (pendingCommitTimerRef.current !== null || typeof window === "undefined") {
    return;
  }
  const elapsed = nowMs() - lastAnimatedCommitAtRef.current;
  const delay = pendingAnimatedOptionsRef.current.length
    ? Math.max(0, ECHARTS_STREAM_COMMIT_INTERVAL_MS - elapsed)
    : 0;
  pendingCommitTimerRef.current = window.setTimeout(() => {
    pendingCommitTimerRef.current = null;
    const next = pendingAnimatedOptionsRef.current.shift();
    if (next) {
      applyEChartsOption(instance, next.option, next.signature, lastOptionSignatureRef, true);
      lastAnimatedCommitAtRef.current = nowMs();
      scheduleQueuedEChartsCommit({
        instance,
        lastAnimatedCommitAtRef,
        lastOptionSignatureRef,
        pendingAnimatedOptionsRef,
        pendingCommitTimerRef,
        pendingTerminalOptionRef,
      });
      return;
    }
    const terminal = pendingTerminalOptionRef.current;
    if (terminal) {
      pendingTerminalOptionRef.current = null;
      applyEChartsOption(instance, terminal.option, terminal.signature, lastOptionSignatureRef, false, true);
    }
  }, delay);
}

function applyEChartsOption(
  instance: EChartsType,
  option: EChartsOption,
  signature: string,
  lastOptionSignatureRef: MutableRefObject<string>,
  lazyUpdate: boolean,
  force = false,
) {
  if (!force && lastOptionSignatureRef.current === signature) {
    return;
  }
  lastOptionSignatureRef.current = signature;
  instance.setOption(option, {
    lazyUpdate,
    notMerge: false,
  });
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function withoutEChartsAnimation(option: EChartsOption): EChartsOption {
  const series = Array.isArray(option.series)
    ? option.series.map(withoutSeriesAnimation)
    : option.series
      ? withoutSeriesAnimation(option.series as SeriesOption)
      : option.series;
  return {
    ...option,
    animation: false,
    animationDelay: 0,
    animationDelayUpdate: 0,
    animationDuration: 0,
    animationDurationUpdate: 0,
    series,
  } as EChartsOption;
}

function withStreamingEChartsAnimation(option: EChartsOption): EChartsOption {
  const series = Array.isArray(option.series)
    ? option.series.map(withStreamingSeriesAnimation)
    : option.series
      ? withStreamingSeriesAnimation(option.series as SeriesOption)
      : option.series;
  return {
    ...option,
    animation: true,
    animationDelay: 0,
    animationDelayUpdate: 0,
    animationDurationUpdate: ECHARTS_STREAM_ANIMATION_DURATION_MS,
    animationEasingUpdate: "cubicOut",
    series,
  } as EChartsOption;
}

function withStreamingSeriesAnimation(series: SeriesOption): SeriesOption {
  return {
    ...series,
    animation: true,
    animationDelay: 0,
    animationDelayUpdate: 0,
    animationDurationUpdate: ECHARTS_STREAM_ANIMATION_DURATION_MS,
  } as SeriesOption;
}

function withoutSeriesAnimation(series: SeriesOption): SeriesOption {
  return {
    ...series,
    animation: false,
    animationDelay: 0,
    animationDelayUpdate: 0,
    animationDuration: 0,
    animationDurationUpdate: 0,
  } as SeriesOption;
}

function chartHeight(chart: ChartSpec): number {
  if (chart.type === "pie") {
    return ECHARTS_PIE_HEIGHT;
  }
  return ECHARTS_DEFAULT_HEIGHT;
}

function chartOptionSignature(chart: ChartSpec): string {
  return safeJsonStringify({
    categories: chart.categories,
    points: chart.points,
    series: chart.series,
    seriesLabel: chart.seriesLabel,
    title: chart.title,
    type: chart.type,
  });
}

function buildEChartsOption(chart: ChartSpec): EChartsOption {
  if (chart.type === "pie") {
    return buildPieOption(chart);
  }
  return buildCartesianOption(chart);
}

function buildCartesianOption(chart: ChartSpec): EChartsOption {
  const categories = chart.categories.length ? chart.categories : defaultCategories(chart.series);
  const isTrend = chart.type === "trend";
  const series = chart.series.map((item, index): SeriesOption => {
    const data = categories.map((category, pointIndex) => ({
      id: `${chart.type}:${index}:${item.name}:${category}`,
      name: category,
      value: numberValue(item.data[pointIndex]),
    }));
    if (isTrend) {
      return {
        id: `trend:${index}:${item.name}`,
        name: item.name,
        type: "line",
        data,
        animationDelay: staggerAnimationDelay,
        animationDelayUpdate: staggerAnimationDelay,
        smooth: true,
        showSymbol: false,
        symbol: "circle",
        symbolSize: 6,
        connectNulls: false,
        emphasis: {
          focus: "series",
          lineStyle: { width: 3.4 },
          scale: true,
        },
        lineStyle: {
          width: 2.4,
        },
        areaStyle: {
          opacity: 0.055,
        },
      };
    }
    return {
      id: `column:${index}:${item.name}`,
      name: item.name,
      type: "bar",
      data,
      animationDelay: staggerAnimationDelay,
      animationDelayUpdate: staggerAnimationDelay,
      barMaxWidth: 30,
      emphasis: {
        focus: "series",
      },
      itemStyle: {
        borderRadius: [5, 5, 2, 2],
      },
    };
  });

  return withBaseChartOption(chart, {
    grid: {
      bottom: 34,
      containLabel: true,
      left: 14,
      right: 12,
      top: 34,
    },
    legend: legendOption("top"),
    series,
    tooltip: {
      ...tooltipBaseOption(),
      axisPointer: {
        animation: true,
        type: isTrend ? "cross" : "shadow",
        snap: true,
        label: {
          backgroundColor: "#334155",
          color: "#ffffff",
          fontSize: 11,
        },
        lineStyle: {
          color: "#64748b",
          type: "dashed",
          width: 1,
        },
        crossStyle: {
          color: "#64748b",
          type: "dashed",
          width: 1,
        },
        shadowStyle: {
          color: "rgba(100, 116, 139, 0.10)",
        },
      },
      formatter: axisTooltipFormatter,
      trigger: "axis",
    },
    xAxis: {
      type: "category",
      boundaryGap: !isTrend,
      data: categories,
      axisLabel: {
        color: "#64748b",
        fontSize: 11,
        hideOverlap: true,
        formatter: compactAxisLabel,
      },
      axisLine: {
        lineStyle: {
          color: "#cbd5e1",
        },
      },
      axisTick: {
        alignWithLabel: true,
        lineStyle: {
          color: "#cbd5e1",
        },
      },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        color: "#64748b",
        fontSize: 11,
        formatter: compactNumberLabel,
      },
      splitLine: {
        lineStyle: {
          color: "#e5e7eb",
          type: "dashed",
        },
      },
    },
  });
}

function buildPieOption(chart: ChartSpec): EChartsOption {
  const points = pointsForChart(chart);
  return withBaseChartOption(chart, {
    legend: legendOption("bottom"),
    series: [
      {
        id: "pie",
        name: chart.seriesLabel || chart.title || "数据",
        type: "pie",
        data: points.map((point, index) => ({
          id: `pie:${point.label}`,
          itemStyle: point.color ? { color: point.color } : undefined,
          name: point.label,
          value: point.value,
          selected: index === 0 && points.length > 1 ? false : undefined,
        })),
        animationDelay: staggerAnimationDelay,
        animationDelayUpdate: staggerAnimationDelay,
        radius: ["0%", "68%"],
        center: ["50%", "46%"],
        avoidLabelOverlap: true,
        emphasis: {
          focus: "self",
          scale: true,
          scaleSize: 7,
        },
        label: {
          color: "#475569",
          formatter: "{b}",
        },
        labelLine: {
          lineStyle: {
            color: "#94a3b8",
          },
          smooth: true,
        },
      },
    ],
    tooltip: {
      ...tooltipBaseOption(),
      formatter: itemTooltipFormatter,
      trigger: "item",
    },
  });
}

function withBaseChartOption(chart: ChartSpec, option: EChartsOption): EChartsOption {
  return {
    animation: true,
    animationDuration: 420,
    animationDurationUpdate: 220,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicOut",
    animationThreshold: 3000,
    aria: {
      enabled: true,
    },
    color: COLORS,
    textStyle: {
      color: "#334155",
      fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
    },
    ...option,
  };
}

function isAxisInteractionChart(type: ChartType): boolean {
  return type === "trend" || type === "column";
}

function staggerAnimationDelay(dataIndex: number): number {
  return Math.min(dataIndex * 34, 220);
}

function legendOption(position: "top" | "bottom"): EChartsOption["legend"] {
  return {
    type: "scroll",
    selectedMode: true,
    left: 0,
    right: 0,
    ...(position === "bottom" ? { bottom: 0 } : { top: 0 }),
    icon: "roundRect",
    itemGap: 12,
    itemHeight: 8,
    itemWidth: 10,
    pageIconColor: "#64748b",
    pageIconInactiveColor: "#cbd5e1",
    pageTextStyle: {
      color: "#64748b",
      fontSize: 10,
    },
    textStyle: {
      color: "#64748b",
      fontSize: 11,
      overflow: "truncate",
      width: 92,
    },
  };
}

function tooltipBaseOption(): NonNullable<EChartsOption["tooltip"]> {
  return {
    appendToBody: false,
    backgroundColor: "rgba(255, 255, 255, 0.98)",
    borderColor: "rgba(148, 163, 184, 0.32)",
    borderRadius: 8,
    borderWidth: 1,
    confine: true,
    extraCssText: "box-shadow: 0 12px 28px rgba(15, 23, 42, 0.12);",
    padding: [8, 10],
    transitionDuration: 0.14,
    triggerOn: "mousemove|click",
    textStyle: {
      color: "#334155",
      fontSize: 12,
      lineHeight: 18,
    },
  };
}

function axisTooltipFormatter(params: unknown): string {
  const items = (Array.isArray(params) ? params : [params]).map(tooltipParam);
  const title = escapeHtml(String(items[0]?.axisValueLabel || items[0]?.name || ""));
  const rows = items
    .filter((item) => item.seriesName)
    .map((item) => tooltipRow(item.marker, item.seriesName, item.value))
    .join("");
  return `<div class="${styles.tooltip}"><div class="${styles.tooltipTitle}">${title}</div>${rows}</div>`;
}

function itemTooltipFormatter(params: unknown): string {
  const item = tooltipParam(params);
  return `<div class="${styles.tooltip}"><div class="${styles.tooltipTitle}">${escapeHtml(item.name)}</div>${tooltipRow(item.marker, item.seriesName, item.value)}</div>`;
}

function tooltipRow(marker: string, label: string, value: unknown): string {
  return [
    `<div class="${styles.tooltipRow}">`,
    marker,
    `<span class="${styles.tooltipLabel}">${escapeHtml(label)}</span>`,
    `<strong>${escapeHtml(formatTooltipValue(value))}</strong>`,
    "</div>",
  ].join("");
}

function tooltipParam(value: unknown): {
  axisValueLabel: string;
  marker: string;
  name: string;
  seriesName: string;
  value: unknown;
} {
  const record = asRecord(value);
  return {
    axisValueLabel: scalarText(record?.axisValueLabel),
    marker: scalarText(record?.marker),
    name: scalarText(record?.name),
    seriesName: scalarText(record?.seriesName),
    value: record?.value,
  };
}

function compactAxisLabel(value: unknown): string {
  const text = scalarText(value);
  return text.length > 8 ? `${text.slice(0, 8)}...` : text;
}

function compactNumberLabel(value: unknown): string {
  const number = numberValue(value);
  if (number === null) {
    return scalarText(value);
  }
  if (Math.abs(number) >= 10000) {
    return `${CHART_NUMBER_FORMATTER.format(number / 10000)}万`;
  }
  return CHART_NUMBER_FORMATTER.format(number);
}

function formatTooltipValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(formatTooltipValue).join(" / ");
  }
  const number = numberValue(value);
  return number === null ? scalarText(value) || "-" : formatNumber(number);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function ChartSkeleton({ type }: { type: ChartType }) {
  if (type === "pie") {
    return (
      <div
        className={styles.skeleton}
        data-chart-skeleton-type="pie"
        data-testid="a2ui-chart-skeleton"
        aria-label="饼图生成中"
      >
        <span className={styles.skeletonPie} />
        <span className={styles.skeletonList} aria-hidden="true">
          <span className={styles.skeletonLine} />
          <span className={styles.skeletonLine} />
          <span className={styles.skeletonLine} />
          <span className={styles.skeletonLine} />
        </span>
      </div>
    );
  }
  return (
    <div
      className={styles.skeleton}
      data-chart-skeleton-type={type}
      data-testid="a2ui-chart-skeleton"
      aria-label="图表生成中"
    >
      <span className={styles.skeletonBar} />
      <span className={styles.skeletonBar} />
      <span className={styles.skeletonBar} />
      <span className={styles.skeletonBar} />
    </div>
  );
}

function isStreamingStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized === "started" || normalized === "streaming" || normalized === "finished";
}

function normalizeChartPanels(
  payload: Record<string, unknown>,
  isStreaming: boolean,
  parsed: ParsedA2UIMessage,
): ChartPanelSpec[] {
  const structureCharts = chartStructureRecords(parsed);
  const panels = Array.isArray(payload.charts)
    ? payload.charts
      .map((item, index) => ({ index, record: asRecord(item) }))
      .filter((item): item is { index: number; record: Record<string, unknown> } => Boolean(item.record))
      .map(({ index, record }): ChartPanelSpec | null => {
        const chart = chartSpecFromRecord(record, structureCharts[index]);
        if (!chart) {
          return null;
        }
        if (!isStreaming && !hasChartData(chart)) {
          return null;
        }
        return {
          type: chart.type,
          title: chart.title,
          chart: hasChartData(chart) ? chart : null,
        };
      })
      .filter((item): item is ChartPanelSpec => Boolean(item))
    : [];

  if (!isStreaming) {
    return panels;
  }

  const hintedTypes = chartTypesFromBuffer(parsed.debug?.argsBuffer ?? parsed.streamText);
  if (hintedTypes.length <= panels.length) {
    return panels;
  }
  return [
    ...panels,
    ...hintedTypes.slice(panels.length).map((type): ChartPanelSpec => ({
      type,
      title: "",
      chart: null,
    })),
  ];
}

function chartStructureRecords(parsed: ParsedA2UIMessage): Array<Record<string, unknown> | null> {
  if (parsed.streamPlayer?.enabled && parsed.streamPlayer.phase !== "created") {
    return [];
  }
  const payloads = [
    asRecord(parsed.a2ui?.payload),
    asRecord(parsed.debug?.payload),
    asRecord(parsed.debug?.parsedArgs),
  ];
  for (const payload of payloads) {
    if (!payload || !Array.isArray(payload.charts)) {
      continue;
    }
    return payload.charts.map((item) => asRecord(item));
  }
  return [];
}

function chartSpecFromRecord(
  record: Record<string, unknown>,
  structureRecord?: Record<string, unknown> | null,
): ChartSpec | null {
  const type = normalizeChartType(record.type) ?? normalizeChartType(structureRecord?.type);
  if (!type) {
    return null;
  }
  const seriesLabel = scalarText(record.series_label);
  const isCartesian = type === "column" || type === "trend";
  const directPoints = normalizePoints(record.items);
  const structurePoints = isCartesian ? normalizePoints(structureRecord?.items) : [];
  const series = normalizeSeries(record, directPoints, isCartesian ? structureRecord : null);
  const categories = chartCategories(series, directPoints, structurePoints);
  const points = directPoints.length ? directPoints : pointsFromSeries(series[0]);
  return {
    type,
    title: scalarText(record.title) || scalarText(structureRecord?.title),
    seriesLabel: seriesLabel || scalarText(structureRecord?.series_label),
    categories,
    series,
    points,
  };
}

function hasChartData(chart: ChartSpec): boolean {
  return chart.series.some((series) => series.data.some((value) => value !== null)) || chart.points.length > 0;
}

function chartSkeletonType(parsed: ParsedA2UIMessage): ChartType {
  return explicitChartTypeFromPayload(parsed.payload)
    ?? explicitChartTypeFromPayload(asRecord(parsed.debug?.parsedArgs) ?? {})
    ?? explicitChartTypeFromPayload(asRecord(parsed.debug?.payload) ?? {})
    ?? chartTypeFromBuffer(parsed.debug?.argsBuffer ?? parsed.streamText)
    ?? "column";
}

function explicitChartTypeFromPayload(payload: Record<string, unknown>): ChartType | null {
  const chartRecord = firstChartRecord(payload) ?? payload;
  return normalizeChartType(chartRecord.type);
}

function firstChartRecord(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(payload.charts)) {
    return null;
  }
  for (const item of payload.charts) {
    const record = asRecord(item);
    if (record) {
      return record;
    }
  }
  return null;
}

function chartTypeFromBuffer(buffer: unknown): ChartType | null {
  const text = typeof buffer === "string" ? buffer : "";
  const match = text.match(/"type"\s*:\s*"(pie|column|trend)"/i);
  return normalizeChartType(match?.[1]);
}

function chartTypesFromBuffer(buffer: unknown): ChartType[] {
  const text = typeof buffer === "string" ? buffer : "";
  return Array.from(text.matchAll(/"type"\s*:\s*"(pie|column|trend)"/gi))
    .map((match) => normalizeChartType(match[1]))
    .filter((type): type is ChartType => Boolean(type));
}

function normalizeChartType(value: unknown): ChartType | null {
  const type = scalarText(value).toLowerCase();
  if (type === "pie" || type === "column" || type === "trend") {
    return type as ChartType;
  }
  return null;
}

function normalizeSeries(
  record: Record<string, unknown>,
  directPoints: ChartPoint[],
  structureRecord?: Record<string, unknown> | null,
): ChartSeries[] {
  const structureSeries = Array.isArray(structureRecord?.series)
    ? structureRecord.series.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  if (!Array.isArray(record.series)) {
    if (!directPoints.length) {
      return [];
    }
    return [
      {
        name: scalarText(record.series_label) || scalarText(record.title) || "数据",
        data: directPoints.map((point) => point.value),
        categories: directPoints.map((point) => point.label),
      },
    ];
  }
  const visibleSeries = record.series.map(asRecord);
  if (structureSeries.length) {
    return structureSeries
      .map((seriesRecord, index): ChartSeries | null => {
        if (!Array.isArray(seriesRecord.items)) {
          return null;
        }
        const visibleRecord = asRecord(visibleSeries[index]);
        const structurePoints = normalizePoints(seriesRecord.items);
        const visiblePoints = visibleRecord && Array.isArray(visibleRecord.items)
          ? normalizePoints(visibleRecord.items)
          : [];
        return {
          name: scalarText(seriesRecord.name) || `系列 ${index + 1}`,
          data: structurePoints.map((_, pointIndex) => visiblePoints[pointIndex]?.value ?? null),
          categories: structurePoints.map((point) => point.label),
        };
      })
      .filter((item): item is ChartSeries => Boolean(item));
  }
  const sourceSeries = structureSeries.length ? structureSeries : visibleSeries;
  return sourceSeries
    .map((item, index): ChartSeries | null => {
      const seriesRecord = asRecord(item);
      const visibleRecord = asRecord(visibleSeries[index]);
      if (!seriesRecord || !Array.isArray(seriesRecord.items)) {
        return null;
      }
      const points = visibleRecord && Array.isArray(visibleRecord.items)
        ? normalizePoints(visibleRecord.items)
        : normalizePoints(seriesRecord.items);
      return {
        name: scalarText(seriesRecord.name) || `系列 ${index + 1}`,
        data: points.map((point) => point.value),
        categories: points.map((point) => point.label),
      };
    })
    .filter((item): item is ChartSeries => Boolean(item));
}

function normalizePoints(value: unknown): ChartPoint[] {
  if (Array.isArray(value)) {
    return value
      .map((item): ChartPoint | null => {
        const record = asRecord(item);
        if (!record) {
          return null;
        }
        const label = scalarText(record.name);
        const valueNumber = numberValue(record.value);
        if (!label || valueNumber === null) {
          return null;
        }
        return {
          label,
          value: valueNumber,
          color: scalarText(record.color) || undefined,
        };
      })
      .filter((item): item is ChartPoint => Boolean(item));
  }
  return [];
}

function pointsForChart(chart: ChartSpec): ChartPoint[] {
  if (chart.points.length) {
    return chart.points;
  }
  return pointsFromSeries(chart.series[0]);
}

function chartCategories(series: ChartSeries[], points: ChartPoint[], structurePoints: ChartPoint[] = []): string[] {
  const seriesCategories = series.find((item) => item.categories.length)?.categories ?? [];
  if (seriesCategories.length) {
    return seriesCategories;
  }
  if (structurePoints.length) {
    return structurePoints.map((point) => point.label);
  }
  return points.map((point) => point.label);
}

function pointsFromSeries(series: ChartSeries | undefined): ChartPoint[] {
  if (!series) {
    return [];
  }
  return series.data
    .map((item, index) => {
      const valueNumber = numberValue(item);
      return valueNumber === null ? null : { label: series.categories[index] || `项 ${index + 1}`, value: valueNumber };
    })
    .filter((item): item is ChartPoint => Boolean(item));
}

function defaultCategories(series: ChartSeries[]): string[] {
  const count = Math.max(0, ...series.map((item) => item.data.length));
  return Array.from({ length: count }, (_, index) => `项 ${index + 1}`);
}

function summaryText(value: unknown): string {
  return scalarText(value);
}

function useStableChartPanels(
  panels: ChartPanelSpec[],
  isStreaming: boolean,
  stabilityKey: string,
): ChartPanelSpec[] {
  const cacheRef = useRef<{
    charts: Map<string, ChartSpec>;
    key: string;
  }>({ charts: new Map(), key: stabilityKey });

  if (cacheRef.current.key !== stabilityKey) {
    cacheRef.current = { charts: new Map(), key: stabilityKey };
  }

  if (!isStreaming) {
    cacheRef.current.charts.clear();
    return panels;
  }

  return panels.map((panel, index) => {
    const key = stablePanelKey(panel, index);
    const cached = cacheRef.current.charts.get(key);
    if (!panel.chart) {
      return cached ? { ...panel, chart: cached, title: panel.title || cached.title } : panel;
    }
    if (!cached || chartDataCount(panel.chart) >= chartDataCount(cached)) {
      cacheRef.current.charts.set(key, panel.chart);
      return panel;
    }
    return { ...panel, chart: cached, title: panel.title || cached.title };
  });
}

function stablePanelKey(panel: ChartPanelSpec, index: number): string {
  return `${index}:${panel.type}`;
}

function chartDataCount(chart: ChartSpec): number {
  if (chart.type === "pie") {
    return pointsForChart(chart).length;
  }
  return chart.series.reduce((sum, series) => sum + series.data.filter((value) => value !== null).length, 0);
}

function chartPanelStabilityKey(parsed: ParsedA2UIMessage): string {
  const identity = [
    scalarText(parsed.debug?.streamId),
    scalarText(parsed.a2ui?.stream_id),
    scalarText(parsed.debug?.streamGroupId),
    scalarText(parsed.a2ui?.tool_call_id),
    scalarText(parsed.debug?.toolCallId),
    scalarText(parsed.interactionId),
  ].find(Boolean);
  return identity || [
    scalarText(parsed.debug?.traceId),
    scalarText(parsed.debug?.turnIndex),
    parsed.renderKey,
  ].filter(Boolean).join(":");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function scalarText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }
  return "";
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  return CHART_NUMBER_FORMATTER.format(Object.is(value, -0) ? 0 : value);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
