import * as echarts from "echarts";
import type { EChartsOption, EChartsType, SeriesOption } from "echarts";
import { type MutableRefObject, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ParsedA2UIMessage } from "./A2UIBlock";
import styles from "./A2ChartBlock.module.css";
import {
  A2UIMotionItem,
  A2UIMotionRoot,
} from "./A2UIMotion";

export interface A2ChartBlockProps {
  parsed: ParsedA2UIMessage;
}

type ChartType = "trend" | "column" | "pie" | "sankey";
type ChartValueFormat = "number" | "percent";
type ChartColumnMode = "grouped" | "stacked";
type ChartSortMode = "none" | "asc" | "desc";
type ChartLabelVisibility = "auto" | "always" | "never";

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

interface ChartNode {
  name: string;
  value: number | null;
  color?: string;
}

interface ChartLink {
  source: string;
  target: string;
  value: number;
  color?: string;
}

interface ChartSpec {
  type: ChartType;
  title: string;
  seriesLabel: string;
  unit: string;
  precision: number | null;
  prefix: string;
  suffix: string;
  valueFormat: ChartValueFormat;
  mode: ChartColumnMode;
  sort: ChartSortMode;
  showLabels: ChartLabelVisibility;
  showPercent: boolean;
  smooth: boolean;
  zoom: boolean;
  categories: string[];
  series: ChartSeries[];
  points: ChartPoint[];
  nodes: ChartNode[];
  links: ChartLink[];
}

interface ChartPanelSpec {
  type: ChartType;
  title: string;
  chart: ChartSpec | null;
}

interface StableChartPresentation {
  panelCount: number;
  panelTitles: string[];
  summary: string;
}

interface SelectedChartItem {
  dataIndex: number;
  seriesIndex: number;
}

type SelectedChartItems = SelectedChartItem[];

const COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2"];
const ECHARTS_FALLBACK_WIDTH = 620;
const ECHARTS_DEFAULT_HEIGHT = 280;
const ECHARTS_PIE_HEIGHT = 300;
const ECHARTS_STRUCTURE_HEIGHT = 360;
const ECHARTS_STREAM_COMMIT_INTERVAL_MS = 200;
const ECHARTS_STREAM_ANIMATION_DURATION_MS = 170;
const ECHARTS_STREAM_MAX_PENDING_OPTIONS = 2;
let canvasRendererAvailable: boolean | null = null;
export function A2ChartBlock({ parsed }: A2ChartBlockProps) {
  const isStreaming = isStreamingStatus(parsed.status) || Boolean(parsed.streamPlayer?.enabled && parsed.streamPlayer.phase !== "created");
  const animateChartUpdates = Boolean(parsed.streamPlayer?.enabled && parsed.streamPlayer.phase !== "created");
  const animateInitialCharts = animateChartUpdates;
  const payload = parsed.payload;
  const normalizedPanels = useMemo(() => normalizeChartPanels(payload, isStreaming, parsed), [isStreaming, parsed, payload]);
  const stabilityKey = chartPanelStabilityKey(parsed);
  const panels = useStableChartPanels(normalizedPanels, isStreaming, stabilityKey);
  const presentation = useStableChartPresentation(summaryText(payload.summary), panels, isStreaming, stabilityKey);
  const summary = presentation.summary;
  const skeletonType = chartSkeletonType(parsed);

  return (
    <A2UIMotionRoot as="section" className={styles.chart} data-testid="a2ui-chart" {...parsed.streamPlayer?.rootProps}>
      {summary && presentation.panelCount > 1 ? (
        <A2UIMotionItem as="p" className={styles.summary} motionKey="chart:summary" motionKind="chart-summary">
          {summary}
        </A2UIMotionItem>
      ) : null}
      {panels.length ? (
        panels.map((panel, index) => {
          const caption = chartPanelCaption(
            presentation.panelTitles[index] || panel.title,
            summary,
            presentation.panelCount,
          );
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
  const [selectedItems, setSelectedItems] = useState<SelectedChartItems>([]);
  const [surfaceWidth, setSurfaceWidth] = useState(ECHARTS_FALLBACK_WIDTH);
  const effectiveSelectedItems = isSelectableChart(chart.type) ? selectedItems : [];
  const chartSignature = useMemo(() => chartOptionSignature(chart), [chart]);
  const selectedItemSignature = useMemo(() => selectedItemsSignature(effectiveSelectedItems), [effectiveSelectedItems]);
  const option = useMemo(() => buildEChartsOption(chart, effectiveSelectedItems, surfaceWidth), [chart, effectiveSelectedItems, surfaceWidth]);
  const optionSignature = useMemo(() => `${chartSignature}|selected:${selectedItemSignature}|width:${surfaceWidth}`, [chartSignature, selectedItemSignature, surfaceWidth]);
  const interactionMode = chartInteractionMode(chart.type);

  heightRef.current = height;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const instance = echarts.init(container, undefined, {
      height,
      renderer: chartRenderer(chart.type),
      width: ECHARTS_FALLBACK_WIDTH,
    });
    chartRef.current = instance;

    const resize = () => {
      const width = Math.max(320, Math.round(container.getBoundingClientRect().width || ECHARTS_FALLBACK_WIDTH));
      instance.resize({ height: heightRef.current, width });
      setSurfaceWidth((current) => current === width ? current : width);
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
    if (!instance || !isSelectableChart(chart.type)) {
      return;
    }
    const handleClick = (params: unknown) => {
      const record = asRecord(params);
      const seriesType = scalarText(record?.seriesType);
      if ((chart.type === "column" && seriesType !== "bar") || (chart.type === "pie" && seriesType !== "pie")) {
        return;
      }
      const seriesIndex = numberValue(record?.seriesIndex);
      const dataIndex = numberValue(record?.dataIndex);
      if (seriesIndex === null || dataIndex === null) {
        return;
      }
      setSelectedItems((current) => toggleSelectedItem(current, { dataIndex, seriesIndex }));
    };
    instance.on("click", handleClick);
    return () => {
      instance.off("click", handleClick);
    };
  }, [chart.type]);

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
      data-a2ui-chart-format={chart.valueFormat}
      data-a2ui-chart-interactions={interactionMode}
      data-a2ui-chart-labels={chart.showLabels}
      data-a2ui-chart-mode={chart.type === "column" ? chart.mode : ""}
      data-a2ui-chart-paced-commit={animateUpdates ? "true" : "false"}
      data-a2ui-chart-renderer={chartRenderer(chart.type)}
      data-a2ui-chart-stream-adapter="setOption-diff"
      data-a2ui-chart-tooltip={isAxisInteractionChart(chart.type) ? "axis" : "item"}
      data-a2ui-chart-unit={chart.unit}
      data-a2ui-chart-zoom={chart.zoom ? "true" : "false"}
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
  if (chart.type === "sankey") {
    return ECHARTS_STRUCTURE_HEIGHT;
  }
  return ECHARTS_DEFAULT_HEIGHT;
}

function chartRenderer(type: ChartType): "canvas" | "svg" {
  return (type === "trend" || type === "column") && supportsCanvasRenderer() ? "canvas" : "svg";
}

function supportsCanvasRenderer(): boolean {
  if (canvasRendererAvailable !== null) {
    return canvasRendererAvailable;
  }
  if (typeof document === "undefined") {
    canvasRendererAvailable = false;
    return false;
  }
  const context = document.createElement("canvas").getContext("2d");
  canvasRendererAvailable = Boolean(
    context &&
    typeof context.clearRect === "function" &&
    typeof context.save === "function" &&
    typeof context.restore === "function" &&
    typeof context.measureText === "function",
  );
  return canvasRendererAvailable;
}

function chartOptionSignature(chart: ChartSpec): string {
  return safeJsonStringify({
    categories: chart.categories,
    links: chart.links,
    mode: chart.mode,
    nodes: chart.nodes,
    points: chart.points,
    precision: chart.precision,
    prefix: chart.prefix,
    series: chart.series,
    seriesLabel: chart.seriesLabel,
    showLabels: chart.showLabels,
    showPercent: chart.showPercent,
    smooth: chart.smooth,
    sort: chart.sort,
    suffix: chart.suffix,
    title: chart.title,
    type: chart.type,
    unit: chart.unit,
    valueFormat: chart.valueFormat,
    zoom: chart.zoom,
  });
}

function buildEChartsOption(chart: ChartSpec, selectedItems: SelectedChartItems = [], layoutWidth = ECHARTS_FALLBACK_WIDTH): EChartsOption {
  if (chart.type === "pie") {
    return buildPieOption(chart, selectedItems);
  }
  if (chart.type === "sankey") {
    return buildSankeyOption(chart, layoutWidth);
  }
  return buildCartesianOption(chart, selectedItems);
}

function buildCartesianOption(chart: ChartSpec, selectedItems: SelectedChartItems): EChartsOption {
  const prepared = prepareCartesianData(chart);
  const { categories } = prepared;
  const isTrend = chart.type === "trend";
  const hasZoom = chart.zoom && shouldUseDataZoom(categories.length);
  const showValueLabels = shouldShowValueLabels(chart);
  const series = prepared.series.map((item, index): SeriesOption => {
    const data = categories.map((category, pointIndex) => ({
      id: `${chart.type}:${index}:${item.name}:${category}`,
      name: category,
      value: numberValue(item.data[pointIndex]),
      ...(!isTrend ? selectedDataItemState("column", selectedItems, index, pointIndex) ?? {} : {}),
    }));
    if (isTrend) {
      return {
        id: `trend:${index}:${item.name}`,
        name: item.name,
        type: "line",
        data,
        animationDelay: staggerAnimationDelay,
        animationDelayUpdate: staggerAnimationDelay,
        smooth: chart.smooth,
        sampling: data.length > 80 ? "lttb" : undefined,
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
      } as SeriesOption;
    }
    return {
      id: `column:${index}:${item.name}`,
      name: item.name,
      type: "bar",
      data,
      animationDelay: staggerAnimationDelay,
      animationDelayUpdate: staggerAnimationDelay,
      barMaxWidth: 30,
      cursor: "pointer",
      stack: chart.mode === "stacked" ? "total" : undefined,
      blur: {
        itemStyle: {
          opacity: 0.56,
        },
      },
      emphasis: {
        focus: "series",
        itemStyle: {
          shadowBlur: 12,
          shadowColor: "rgba(37, 99, 235, 0.24)",
        },
        label: {
          fontWeight: 700,
        },
      },
      itemStyle: {
        borderColor: "transparent",
        borderWidth: 0,
        borderRadius: [5, 5, 2, 2],
      },
      label: {
        show: showValueLabels,
        color: "#334155",
        fontSize: 11,
        formatter: (params: unknown) => formatChartValue(chart, tooltipParam(params).value),
        position: "top",
      },
    } as SeriesOption;
  });

  return withBaseChartOption(chart, {
    dataZoom: hasZoom ? cartesianDataZoom() : undefined,
    grid: {
      bottom: hasZoom ? 62 : 34,
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
        snap: !isTrend,
      },
      formatter: (params: unknown) => axisTooltipFormatter(params, chart),
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
        formatter: (value: unknown) => formatAxisValue(chart, value),
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

function buildPieOption(chart: ChartSpec, selectedItems: SelectedChartItems): EChartsOption {
  const points = sortChartPoints(pointsForChart(chart), chart.sort);
  const showLabels = shouldShowValueLabels(chart);
  return withBaseChartOption(chart, {
    legend: legendOption("bottom"),
    series: [
      {
        id: "pie",
        name: chart.seriesLabel || chart.title || "数据",
        type: "pie",
        data: points.map((point, index) => ({
          id: `pie:${point.label}`,
          ...(mergeDataItemState(
            point.color ? { itemStyle: { color: point.color } } : undefined,
            selectedDataItemState("pie", selectedItems, 0, index),
          ) ?? {}),
          name: point.label,
          selected: isSelectedDataItem(selectedItems, 0, index) ? true : undefined,
          value: point.value,
        })),
        animationDelay: staggerAnimationDelay,
        animationDelayUpdate: staggerAnimationDelay,
        radius: ["42%", "68%"],
        center: ["50%", "46%"],
        selectedMode: "multiple",
        selectedOffset: 8,
        avoidLabelOverlap: true,
        minAngle: 0,
        emphasis: {
          focus: "self",
          scale: true,
          scaleSize: 7,
        },
        label: {
          show: showLabels,
          color: "#475569",
          formatter: (params: unknown) => pieLabelFormatter(params, chart),
          overflow: "truncate",
          width: 128,
        },
        labelLayout: {
          hideOverlap: true,
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
      formatter: (params: unknown) => itemTooltipFormatter(params, chart),
      trigger: "item",
    },
  });
}

function buildSankeyOption(chart: ChartSpec, layoutWidth: number): EChartsOption {
  const nodes = sankeyNodesForChart(chart);
  const labelWidth = sankeyLabelWidth(layoutWidth);
  return withBaseChartOption(chart, {
    series: [
      {
        id: "sankey",
        name: chart.title || "流向",
        type: "sankey",
        data: nodes.map((node) => ({
          name: node.name,
          value: node.value ?? undefined,
          itemStyle: node.color ? { color: node.color } : undefined,
        })),
        links: chart.links.map((link, index) => ({
          id: `sankey:${index}:${link.source}:${link.target}`,
          source: link.source,
          target: link.target,
          value: link.value,
          lineStyle: link.color ? { color: link.color } : undefined,
        })),
        animationDelay: staggerAnimationDelay,
        animationDelayUpdate: staggerAnimationDelay,
        draggable: true,
        emphasis: {
          focus: "adjacency",
          lineStyle: {
            opacity: 0.72,
          },
        },
        label: {
          color: "#334155",
          fontSize: 11,
          ellipsis: "...",
          overflow: "truncate",
          width: labelWidth,
        },
        labelLayout: sankeyLabelLayout(layoutWidth),
        layoutIterations: 32,
        lineStyle: {
          color: "gradient",
          curveness: 0.5,
          opacity: 0.34,
        },
        nodeAlign: "justify",
        nodeGap: 13,
        nodeWidth: 14,
        top: 18,
        right: 18,
        bottom: 18,
        left: 18,
      } as SeriesOption,
    ],
    tooltip: {
      ...tooltipBaseOption(),
      formatter: (params: unknown) => sankeyTooltipFormatter(params, chart),
      trigger: "item",
    },
  });
}

function selectedDataItemState(
  chartType: Extract<ChartType, "column" | "pie">,
  selectedItems: SelectedChartItems,
  seriesIndex: number,
  dataIndex: number,
): { itemStyle?: Record<string, unknown>; label?: Record<string, unknown> } | undefined {
  if (!selectedItems.length) {
    return undefined;
  }
  if (selectedItems.some((item) => item.seriesIndex === seriesIndex && item.dataIndex === dataIndex)) {
    return chartType === "pie"
      ? {
          itemStyle: {
            borderColor: "transparent",
            borderWidth: 0,
            opacity: 1,
          },
        }
      : undefined;
  }
  return {
    itemStyle: {
      borderColor: "transparent",
      borderWidth: 0,
      opacity: 0.36,
      shadowBlur: 0,
    },
    label: {
      fontWeight: 400,
    },
  };
}

function isSelectedDataItem(items: SelectedChartItems, seriesIndex: number, dataIndex: number): boolean {
  return items.some((item) => item.seriesIndex === seriesIndex && item.dataIndex === dataIndex);
}

function toggleSelectedItem(items: SelectedChartItems, next: SelectedChartItem): SelectedChartItems {
  const exists = items.some((item) => item.seriesIndex === next.seriesIndex && item.dataIndex === next.dataIndex);
  if (exists) {
    return items.filter((item) => item.seriesIndex !== next.seriesIndex || item.dataIndex !== next.dataIndex);
  }
  return [...items, next];
}

function selectedItemsSignature(items: SelectedChartItems): string {
  if (!items.length) {
    return "-";
  }
  return [...items]
    .sort((left, right) => left.seriesIndex - right.seriesIndex || left.dataIndex - right.dataIndex)
    .map((item) => `${item.seriesIndex}:${item.dataIndex}`)
    .join(",");
}

function mergeDataItemState(
  base: { itemStyle?: Record<string, unknown>; label?: Record<string, unknown> } | undefined,
  state: { itemStyle?: Record<string, unknown>; label?: Record<string, unknown> } | undefined,
): { itemStyle?: Record<string, unknown>; label?: Record<string, unknown> } | undefined {
  if (!base && !state) {
    return undefined;
  }
  const itemStyle = {
    ...(base?.itemStyle ?? {}),
    ...(state?.itemStyle ?? {}),
  };
  const label = {
    ...(base?.label ?? {}),
    ...(state?.label ?? {}),
  };
  return {
    ...(base ?? {}),
    ...(state ?? {}),
    ...(Object.keys(itemStyle).length ? { itemStyle } : {}),
    ...(Object.keys(label).length ? { label } : {}),
  };
}

function sankeyNodesForChart(chart: ChartSpec): ChartNode[] {
  const byName = new Map<string, ChartNode>();
  chart.nodes.forEach((node) => {
    byName.set(node.name, node);
  });
  chart.links.forEach((link) => {
    if (!byName.has(link.source)) {
      byName.set(link.source, { name: link.source, value: null });
    }
    if (!byName.has(link.target)) {
      byName.set(link.target, { name: link.target, value: null });
    }
  });
  return Array.from(byName.values());
}

function sankeyLabelWidth(layoutWidth: number): number {
  return Math.max(72, Math.min(132, Math.round(layoutWidth * 0.2)));
}

function sankeyLabelLayout(layoutWidth: number): (params: unknown) => Record<string, unknown> {
  return (params: unknown) => {
    const record = asRecord(params);
    const labelRect = asRecord(record?.labelRect);
    const x = numberValue(labelRect?.x);
    const width = numberValue(labelRect?.width);
    if (x === null || width === null) {
      return { hideOverlap: true };
    }
    const padding = 8;
    const maxX = Math.max(padding, layoutWidth - width - padding);
    const clampedX = Math.max(padding, Math.min(x, maxX));
    if (Math.abs(clampedX - x) < 0.5) {
      return { hideOverlap: true };
    }
    return {
      align: clampedX < x ? "right" : scalarText(record?.align) || "left",
      hideOverlap: true,
      x: clampedX,
    };
  };
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

function chartInteractionMode(type: ChartType): string {
  if (isAxisInteractionChart(type)) {
    return "tooltip,axisPointer,legendToggle";
  }
  if (type === "sankey") {
    return "tooltip,adjacencyFocus,dragNode";
  }
  return "tooltip,legendToggle";
}

function isSelectableChart(type: ChartType): boolean {
  return type === "column" || type === "pie";
}

function staggerAnimationDelay(dataIndex: number): number {
  return Math.min(dataIndex * 34, 220);
}

function prepareCartesianData(chart: ChartSpec): { categories: string[]; series: ChartSeries[] } {
  const categories = chart.categories.length ? chart.categories : defaultCategories(chart.series);
  if (chart.type !== "column" || chart.sort === "none" || categories.length <= 1) {
    return { categories, series: chart.series };
  }
  const order = categories
    .map((_, index) => ({
      index,
      total: chart.series.reduce((sum, item) => sum + (numberValue(item.data[index]) ?? 0), 0),
    }))
    .sort((left, right) => chart.sort === "asc" ? left.total - right.total : right.total - left.total)
    .map((item) => item.index);
  return {
    categories: order.map((index) => categories[index] ?? `项 ${index + 1}`),
    series: chart.series.map((item) => ({
      ...item,
      categories: order.map((index) => item.categories[index] ?? categories[index] ?? `项 ${index + 1}`),
      data: order.map((index) => item.data[index] ?? null),
    })),
  };
}

function sortChartPoints(points: ChartPoint[], sort: ChartSortMode): ChartPoint[] {
  if (sort === "none") {
    return points;
  }
  return [...points].sort((left, right) => sort === "asc" ? left.value - right.value : right.value - left.value);
}

function shouldUseDataZoom(categoryCount: number): boolean {
  return categoryCount > 1;
}

function cartesianDataZoom(): EChartsOption["dataZoom"] {
  return [
    {
      id: "a2ui-cartesian-inside-zoom",
      type: "inside",
      xAxisIndex: 0,
      filterMode: "none",
      rangeMode: ["percent", "percent"],
      start: 0,
      end: 100,
    },
    {
      id: "a2ui-cartesian-slider-zoom",
      type: "slider",
      xAxisIndex: 0,
      filterMode: "none",
      rangeMode: ["percent", "percent"],
      bottom: 6,
      height: 18,
      start: 0,
      end: 100,
      borderColor: "rgba(148, 163, 184, 0.28)",
      fillerColor: "rgba(37, 99, 235, 0.12)",
      handleStyle: {
        color: "#ffffff",
        borderColor: "#94a3b8",
      },
      moveHandleStyle: {
        color: "#94a3b8",
      },
      showDetail: false,
    },
  ];
}

function shouldShowValueLabels(chart: ChartSpec): boolean {
  if (chart.showLabels === "always") {
    return true;
  }
  if (chart.showLabels === "never") {
    return false;
  }
  if (chart.type === "pie") {
    return true;
  }
  return false;
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

function axisTooltipFormatter(params: unknown, chart: ChartSpec): string {
  const items = (Array.isArray(params) ? params : [params]).map(tooltipParam);
  const title = escapeHtml(String(items[0]?.axisValueLabel || items[0]?.name || ""));
  const rows = items
    .filter((item) => item.seriesName)
    .sort((left, right) => (numberValue(right.value) ?? Number.NEGATIVE_INFINITY) - (numberValue(left.value) ?? Number.NEGATIVE_INFINITY))
    .map((item) => tooltipRow(item.marker, item.seriesName, item.value, chart))
    .join("");
  return `<div class="${styles.tooltip}"><div class="${styles.tooltipTitle}">${title}</div>${rows}</div>`;
}

function itemTooltipFormatter(params: unknown, chart: ChartSpec): string {
  const item = tooltipParam(params);
  const percent = chart.type === "pie" && chart.showPercent && chart.valueFormat !== "percent" && item.percent !== null
    ? `${formatNumberWithPrecision(item.percent, chart.precision ?? 1)}%`
    : "";
  return `<div class="${styles.tooltip}"><div class="${styles.tooltipTitle}">${escapeHtml(item.name)}</div>${tooltipRow(item.marker, item.seriesName, item.value, chart, percent)}</div>`;
}

function sankeyTooltipFormatter(params: unknown, chart: ChartSpec): string {
  const record = asRecord(params);
  const data = asRecord(record?.data);
  const source = scalarText(data?.source);
  const target = scalarText(data?.target);
  const marker = scalarText(record?.marker);
  if (source && target) {
    const title = `${source} → ${target}`;
    return `<div class="${styles.tooltip}"><div class="${styles.tooltipTitle}">${escapeHtml(title)}</div>${tooltipRow(marker, chart.seriesLabel || "流量", data?.value, chart)}</div>`;
  }
  const name = scalarText(record?.name) || scalarText(data?.name);
  return `<div class="${styles.tooltip}"><div class="${styles.tooltipTitle}">${escapeHtml(name)}</div>${tooltipRow(marker, chart.seriesLabel || "节点", data?.value ?? record?.value, chart)}</div>`;
}

function tooltipRow(marker: string, label: string, value: unknown, chart: ChartSpec, extra = ""): string {
  const valueText = [formatChartValue(chart, value), extra].filter(Boolean).join(" · ");
  return [
    `<div class="${styles.tooltipRow}">`,
    marker,
    `<span class="${styles.tooltipLabel}">${escapeHtml(label)}</span>`,
    `<strong>${escapeHtml(valueText)}</strong>`,
    "</div>",
  ].join("");
}

function tooltipParam(value: unknown): {
  axisValueLabel: string;
  marker: string;
  name: string;
  percent: number | null;
  seriesName: string;
  value: unknown;
} {
  const record = asRecord(value);
  return {
    axisValueLabel: scalarText(record?.axisValueLabel),
    marker: scalarText(record?.marker),
    name: scalarText(record?.name),
    percent: numberValue(record?.percent),
    seriesName: scalarText(record?.seriesName),
    value: record?.value,
  };
}

function compactAxisLabel(value: unknown): string {
  const text = scalarText(value);
  return text.length > 8 ? `${text.slice(0, 8)}...` : text;
}

function formatAxisValue(chart: ChartSpec, value: unknown): string {
  return formatChartValue(chart, value, { compact: true });
}

function formatChartValue(
  chart: ChartSpec,
  value: unknown,
  options: { compact?: boolean } = {},
): string {
  if (Array.isArray(value)) {
    return value.map((item) => formatChartValue(chart, item, options)).join(" / ");
  }
  const number = numberValue(value);
  if (number === null) {
    return scalarText(value) || "-";
  }
  const isPercent = chart.valueFormat === "percent";
  const normalized = isPercent && Math.abs(number) <= 1 ? number * 100 : number;
  const precision = chart.precision ?? (isPercent ? 1 : options.compact ? 1 : 2);
  const suffix = chart.suffix || (isPercent ? chart.unit || "%" : chart.unit);
  const canCompact = options.compact
    && !isPercent
    && Math.abs(normalized) >= 10000
    && !/[A-Za-z]/.test(suffix)
    && !suffix.includes("万");
  const formatted = canCompact
    ? `${formatNumberWithPrecision(normalized / 10000, precision)}万`
    : formatNumberWithPrecision(normalized, precision);
  return `${chart.prefix}${formatted}${unitSeparator(suffix)}${suffix}`;
}

function formatNumberWithPrecision(value: number, precision: number): string {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: Math.max(0, Math.min(6, precision)),
    minimumFractionDigits: 0,
  }).format(Object.is(value, -0) ? 0 : value);
}

function unitSeparator(unit: string): string {
  return unit && /^[A-Za-z]/.test(unit) ? " " : "";
}

function pieLabelFormatter(params: unknown, chart: ChartSpec): string {
  const item = tooltipParam(params);
  const percent = chart.showPercent && item.percent !== null
    ? ` ${formatNumberWithPrecision(item.percent, chart.precision ?? 1)}%`
    : "";
  return `${item.name}${percent}`;
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
  const nodes = type === "sankey" ? normalizeNodes(record.nodes, structureRecord?.nodes) : [];
  const links = type === "sankey" ? normalizeLinks(record.links, structureRecord?.links) : [];
  return {
    type,
    title: scalarText(record.title) || scalarText(structureRecord?.title),
    seriesLabel: seriesLabel || scalarText(structureRecord?.series_label),
    unit: scalarText(record.unit) || scalarText(structureRecord?.unit),
    precision: normalizePrecision(record.precision) ?? normalizePrecision(structureRecord?.precision),
    prefix: scalarText(record.prefix) || scalarText(structureRecord?.prefix),
    suffix: scalarText(record.suffix) || scalarText(structureRecord?.suffix),
    valueFormat: normalizeValueFormat(record.value_format) ?? normalizeValueFormat(structureRecord?.value_format) ?? "number",
    mode: normalizeColumnMode(record.mode) ?? normalizeColumnMode(structureRecord?.mode) ?? "grouped",
    sort: normalizeSortMode(record.sort) ?? normalizeSortMode(structureRecord?.sort) ?? "none",
    showLabels: normalizeLabelVisibility(record.show_labels) ?? normalizeLabelVisibility(structureRecord?.show_labels) ?? "auto",
    showPercent: booleanValue(record.show_percent) ?? booleanValue(structureRecord?.show_percent) ?? false,
    smooth: booleanValue(record.smooth) ?? booleanValue(structureRecord?.smooth) ?? true,
    zoom: booleanValue(record.zoom) ?? booleanValue(structureRecord?.zoom) ?? false,
    categories,
    series,
    points,
    nodes,
    links,
  };
}

function hasChartData(chart: ChartSpec): boolean {
  if (chart.type === "sankey") {
    return chart.links.length > 0;
  }
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
  const match = text.match(/"type"\s*:\s*"(pie|column|trend|sankey)"/i);
  return normalizeChartType(match?.[1]);
}

function chartTypesFromBuffer(buffer: unknown): ChartType[] {
  const text = typeof buffer === "string" ? buffer : "";
  return Array.from(text.matchAll(/"type"\s*:\s*"(pie|column|trend|sankey)"/gi))
    .map((match) => normalizeChartType(match[1]))
    .filter((type): type is ChartType => Boolean(type));
}

function normalizeChartType(value: unknown): ChartType | null {
  const type = scalarText(value).toLowerCase();
  if (type === "pie" || type === "column" || type === "trend" || type === "sankey") {
    return type as ChartType;
  }
  return null;
}

function normalizeValueFormat(value: unknown): ChartValueFormat | null {
  const type = scalarText(value).toLowerCase();
  if (type === "number" || type === "percent") {
    return type;
  }
  return null;
}

function normalizeColumnMode(value: unknown): ChartColumnMode | null {
  const mode = scalarText(value).toLowerCase();
  if (mode === "grouped" || mode === "stacked") {
    return mode;
  }
  return null;
}

function normalizeSortMode(value: unknown): ChartSortMode | null {
  const mode = scalarText(value).toLowerCase();
  if (mode === "none" || mode === "asc" || mode === "desc") {
    return mode;
  }
  return null;
}

function normalizeLabelVisibility(value: unknown): ChartLabelVisibility | null {
  const visibility = scalarText(value).toLowerCase();
  if (visibility === "auto" || visibility === "always" || visibility === "never") {
    return visibility;
  }
  return null;
}

function normalizePrecision(value: unknown): number | null {
  const number = numberValue(value);
  if (number === null || !Number.isInteger(number) || number < 0 || number > 6) {
    return null;
  }
  return number;
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

function normalizeNodes(value: unknown, structureValue: unknown): ChartNode[] {
  const source = Array.isArray(value) && value.length ? value : structureValue;
  if (!Array.isArray(source)) {
    return [];
  }
  return source
    .map((item): ChartNode | null => {
      const record = asRecord(item);
      if (!record) {
        return null;
      }
      const name = scalarText(record.name);
      if (!name) {
        return null;
      }
      return {
        name,
        value: numberValue(record.value),
        color: scalarText(record.color) || undefined,
      };
    })
    .filter((item): item is ChartNode => Boolean(item));
}

function normalizeLinks(value: unknown, structureValue: unknown): ChartLink[] {
  const source = Array.isArray(value) && value.length ? value : structureValue;
  if (!Array.isArray(source)) {
    return [];
  }
  return source
    .map((item): ChartLink | null => {
      const record = asRecord(item);
      if (!record) {
        return null;
      }
      const sourceName = scalarText(record.source);
      const targetName = scalarText(record.target);
      const valueNumber = numberValue(record.value);
      if (!sourceName || !targetName || valueNumber === null) {
        return null;
      }
      return {
        source: sourceName,
        target: targetName,
        value: valueNumber,
        color: scalarText(record.color) || undefined,
      };
    })
    .filter((item): item is ChartLink => Boolean(item));
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

function useStableChartPresentation(
  summary: string,
  panels: ChartPanelSpec[],
  isStreaming: boolean,
  stabilityKey: string,
): StableChartPresentation {
  const cacheRef = useRef<{
    key: string;
    panelCount: number;
    panelTitles: Map<number, string>;
    summary: string;
  }>({
    key: stabilityKey,
    panelCount: 0,
    panelTitles: new Map(),
    summary: "",
  });

  if (cacheRef.current.key !== stabilityKey) {
    cacheRef.current = {
      key: stabilityKey,
      panelCount: 0,
      panelTitles: new Map(),
      summary: "",
    };
  }

  if (!isStreaming) {
    return {
      panelCount: panels.length,
      panelTitles: panels.map((panel) => panel.title),
      summary,
    };
  }

  const cache = cacheRef.current;
  cache.panelCount = Math.max(cache.panelCount, panels.length);
  cache.summary = stableStreamingText(cache.summary, summary);
  panels.forEach((panel, index) => {
    cache.panelTitles.set(index, stableStreamingText(cache.panelTitles.get(index) ?? "", panel.title));
  });

  return {
    panelCount: cache.panelCount,
    panelTitles: panels.map((panel, index) => cache.panelTitles.get(index) || panel.title),
    summary: cache.summary,
  };
}

function stableStreamingText(previous: string, incoming: string): string {
  if (!incoming) {
    return previous;
  }
  if (!previous || incoming.length >= previous.length) {
    return incoming;
  }
  return previous;
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
  if (chart.type === "sankey") {
    return chart.nodes.length + chart.links.length;
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

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  const text = scalarText(value).toLowerCase();
  if (text === "true" || text === "yes" || text === "1" || text === "是") {
    return true;
  }
  if (text === "false" || text === "no" || text === "0" || text === "否") {
    return false;
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

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
