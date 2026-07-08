import { useMemo, useRef } from "react";

import type { ParsedA2UIMessage } from "./A2UIBlock";
import styles from "./A2ChartBlock.module.css";
import {
  A2UIMotionItem,
  A2UIMotionRoot,
  a2uiMotionItemProps,
} from "./A2UIMotion";
import revealStyles from "./A2UIReveal.module.css";

export interface A2ChartBlockProps {
  parsed: ParsedA2UIMessage;
}

type ChartType = "funnel" | "trend" | "column" | "pie";

interface ChartSeries {
  name: string;
  data: Array<number | null>;
  categories: string[];
}

interface ChartPoint {
  label: string;
  value: number;
  color?: string;
  ratio?: number;
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
const SVG_WIDTH = 560;
const SVG_HEIGHT = 240;
const PIE_SVG_WIDTH = 260;
const PIE_SVG_HEIGHT = 220;
const PADDING = { bottom: 38, left: 42, right: 20, top: 18 };
const CHART_NUMBER_FORMATTER = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

export function A2ChartBlock({ parsed }: A2ChartBlockProps) {
  const isStreaming = isStreamingStatus(parsed.status) || Boolean(parsed.streamPlayer?.enabled && parsed.streamPlayer.phase !== "created");
  const payload = parsed.payload;
  const normalizedPanels = useMemo(() => normalizeChartPanels(payload, isStreaming, parsed), [isStreaming, parsed, payload]);
  const panels = useStableChartPanels(normalizedPanels, isStreaming, chartPanelStabilityKey(parsed));
  const summary = summaryText(payload.summary);
  const skeletonType = chartSkeletonType(parsed);

  return (
    <A2UIMotionRoot as="section" className={styles.chart} data-testid="a2ui-chart" {...parsed.streamPlayer?.rootProps}>
      {panels.length ? (
        panels.map((panel, index) => (
          <A2UIMotionItem
            as="div"
            className={styles.panel}
            data-chart-type={panel.type}
            data-testid="a2ui-chart-panel"
            key={`${index}:${panel.type}`}
            motionKey={`chart:panel:${index}:${panel.type}`}
            motionKind="chart-panel"
          >
            {panel.title ? (
              <A2UIMotionItem
                as="div"
                className={styles.panelTitle}
                motionKey={`chart:panel:${index}:title`}
                motionKind="chart-title"
              >
                {panel.title}
              </A2UIMotionItem>
            ) : null}
            {panel.chart ? renderChart(panel.chart) : <ChartSkeleton type={panel.type} />}
            {panel.chart?.series.length && panel.chart.series.length > 1 && (panel.chart.type === "column" || panel.chart.type === "trend") ? (
              <ChartLegend series={panel.chart.series} />
            ) : null}
          </A2UIMotionItem>
        ))
      ) : isStreaming ? (
        <ChartSkeleton type={skeletonType} />
      ) : (
        <div className={styles.empty}>暂无图表数据</div>
      )}
      {summary ? (
        <A2UIMotionItem as="p" className={styles.summary} motionKey="chart:summary" motionKind="chart-summary">
          {summary}
        </A2UIMotionItem>
      ) : null}
    </A2UIMotionRoot>
  );
}

function renderChart(
  chart: ChartSpec,
) {
  if (chart.type === "pie") {
    return <PieChart chart={chart} points={pointsForChart(chart)} />;
  }
  if (chart.type === "trend") {
    return <TrendChart chart={chart} />;
  }
  if (chart.type === "funnel") {
    return <FunnelChart chart={chart} points={pointsForChart(chart)} />;
  }
  return <ColumnChart chart={chart} />;
}

function ColumnChart({
  chart,
}: {
  chart: ChartSpec;
}) {
  const plotWidth = SVG_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = SVG_HEIGHT - PADDING.top - PADDING.bottom;
  const values = chart.series.flatMap((series) => series.data.map(numberValue)).filter((value) => value !== null) as number[];
  const max = Math.max(1, ...values);
  const categories = chart.categories.length ? chart.categories : defaultCategories(chart.series);
  const groupWidth = plotWidth / Math.max(1, categories.length);
  const barWidth = Math.max(5, (groupWidth - 12) / Math.max(1, chart.series.length));

  return (
    <svg className={styles.svg} viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`} role="img" aria-label={chart.title || "column chart"}>
      <ChartAxes />
      {chart.series.map((series, seriesIndex) =>
        categories.map((category, index) => {
          const value = numberValue(series.data[index]);
          if (value === null) {
            return null;
          }
          const height = (value / max) * plotHeight;
          const x = PADDING.left + index * groupWidth + 6 + seriesIndex * barWidth;
          const y = PADDING.top + plotHeight - height;
          return (
            <g
              {...a2uiMotionItemProps(`chart:column:${seriesIndex}:${index}:${series.name}:${category}`, "chart-column")}
              className={revealStyles.motionItem}
              key={`${series.name}:${category}:${seriesIndex}:${index}`}
            >
              <rect
                className={revealStyles.revealBar}
                data-testid="a2ui-chart-column"
                fill={COLORS[seriesIndex % COLORS.length]}
                height={height}
                rx="3"
                width={Math.max(4, barWidth - 3)}
                x={x}
                y={y}
              >
                <title>{tooltipText(series.name, category, value)}</title>
              </rect>
            </g>
          );
        }),
      )}
      {categories.map((category, index) => (
        <text className={styles.label} key={category} textAnchor="middle" x={PADDING.left + index * groupWidth + groupWidth / 2} y={SVG_HEIGHT - 14}>
          {category}
        </text>
      ))}
    </svg>
  );
}

function TrendChart({
  chart,
}: {
  chart: ChartSpec;
}) {
  const plotWidth = SVG_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = SVG_HEIGHT - PADDING.top - PADDING.bottom;
  const values = chart.series.flatMap((series) => series.data.map(numberValue)).filter((value) => value !== null) as number[];
  const max = Math.max(1, ...values);
  const categories = chart.categories.length ? chart.categories : defaultCategories(chart.series);
  const step = categories.length > 1 ? plotWidth / (categories.length - 1) : plotWidth;

  return (
    <svg className={styles.svg} viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`} role="img" aria-label={chart.title || "trend chart"}>
      <ChartAxes />
      {chart.series.map((series, seriesIndex) => {
        const points = categories.map((_, index) => {
          const value = numberValue(series.data[index]);
          if (value === null) {
            return null;
          }
          const x = PADDING.left + index * step;
          const y = PADDING.top + plotHeight - (value / max) * plotHeight;
          return { category: categories[index] || `项 ${index + 1}`, point: `${x},${y}`, value };
        }).filter((item): item is { category: string; point: string; value: number } => Boolean(item));
        return (
          <g
            {...a2uiMotionItemProps(`chart:trend:${seriesIndex}:${series.name}`, "chart-trend")}
            className={revealStyles.motionItem}
            key={series.name}
          >
            <polyline
              className={revealStyles.revealLine}
              fill="none"
              points={points.map((item) => item.point).join(" ")}
              stroke={COLORS[seriesIndex % COLORS.length]}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.4"
            />
            {points.map(({ category, point, value }, index) => {
              const [x, y] = point.split(",").map(Number);
              return (
                <g
                  {...a2uiMotionItemProps(`chart:point:${seriesIndex}:${index}:${series.name}:${category}`, "chart-point")}
                  className={revealStyles.motionItem}
                  key={`${series.name}:${index}`}
                >
                  <circle
                    className={revealStyles.revealPoint}
                    cx={x}
                    cy={y}
                    fill={COLORS[seriesIndex % COLORS.length]}
                    r="3"
                  >
                    <title>{tooltipText(series.name, category, value)}</title>
                  </circle>
                </g>
              );
            })}
          </g>
        );
      })}
      {categories.map((category, index) => (
        <text className={styles.label} key={category} textAnchor="middle" x={PADDING.left + index * step} y={SVG_HEIGHT - 14}>
          {category}
        </text>
      ))}
    </svg>
  );
}

function PieChart({
  chart,
  points,
}: {
  chart: ChartSpec;
  points: ChartPoint[];
}) {
  const total = points.reduce((sum, point) => sum + Math.max(0, point.value), 0);
  if (!points.length || total <= 0) {
    return <div className={styles.empty}>暂无饼图数据</div>;
  }
  let startAngle = -90;
  const center = { x: PIE_SVG_WIDTH / 2, y: PIE_SVG_HEIGHT / 2 };
  const radius = 76;
  return (
    <div className={styles.pieLayout} data-testid="a2ui-chart-pie-layout">
      <svg
        className={[styles.svg, styles.pieSvg].join(" ")}
        viewBox={`0 0 ${PIE_SVG_WIDTH} ${PIE_SVG_HEIGHT}`}
        role="img"
        aria-label="pie chart"
      >
        {points.map((point, index) => {
          const angle = (Math.max(0, point.value) / total) * 360;
          const path = describeArc(center.x, center.y, radius, startAngle, startAngle + angle);
          startAngle += angle;
          return (
            <g
              {...a2uiMotionItemProps(`chart:pie:${index}:${point.label}`, "chart-pie")}
              className={revealStyles.motionItem}
              key={`${point.label}:${index}`}
            >
              <path className={revealStyles.revealPoint} d={path} fill={point.color || COLORS[index % COLORS.length]}>
                <title>{tooltipText(point.label, "", point.value)}</title>
              </path>
            </g>
          );
        })}
      </svg>
      <ChartPointList points={points} />
    </div>
  );
}

function FunnelChart({
  chart,
  points,
}: {
  chart: ChartSpec;
  points: ChartPoint[];
}) {
  const max = Math.max(1, ...points.map((point) => point.value));
  return (
    <div className={styles.funnelList} role="img" aria-label={chart.title || "funnel chart"}>
      {points.map((point, index) => {
        const width = `${Math.max(8, (point.value / max) * 100)}%`;
        return (
          <A2UIMotionItem
            className={[styles.funnelRow, revealStyles.motionItem].join(" ")}
            key={point.label}
            motionKey={`chart:funnel:${index}:${point.label}`}
            motionKind="chart-funnel"
          >
            <div className={styles.funnelMeta}>
              <span className={styles.funnelName} title={point.label}>{point.label}</span>
              <span className={styles.funnelValue} title={formatNumber(point.value)}>{formatNumber(point.value)}</span>
            </div>
            <div className={styles.funnelTrack} title={tooltipText(point.label, "", point.value)}>
              <span
                className={[styles.funnelBar, revealStyles.revealBar].join(" ")}
                style={{ width, backgroundColor: point.color || COLORS[index % COLORS.length] }}
              />
            </div>
            {point.ratio !== undefined ? (
              <span className={styles.funnelRatio}>{formatNumber(point.ratio)}%</span>
            ) : null}
          </A2UIMotionItem>
        );
      })}
    </div>
  );
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

function ChartAxes() {
  const plotHeight = SVG_HEIGHT - PADDING.top - PADDING.bottom;
  const plotWidth = SVG_WIDTH - PADDING.left - PADDING.right;
  return (
    <g>
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
        <line
          className={styles.gridLine}
          key={tick}
          x1={PADDING.left}
          x2={SVG_WIDTH - PADDING.right}
          y1={PADDING.top + plotHeight * tick}
          y2={PADDING.top + plotHeight * tick}
        />
      ))}
      <line className={styles.axis} x1={PADDING.left} x2={PADDING.left} y1={PADDING.top} y2={PADDING.top + plotHeight} />
      <line className={styles.axis} x1={PADDING.left} x2={PADDING.left + plotWidth} y1={PADDING.top + plotHeight} y2={PADDING.top + plotHeight} />
    </g>
  );
}

function ChartLegend({ series }: { series: ChartSeries[] }) {
  return (
    <div className={styles.legend}>
      {series.map((item, index) => (
        <A2UIMotionItem
          as="span"
          className={styles.legendItem}
          key={item.name}
          motionKey={`chart:legend:${index}:${item.name}`}
          motionKind="chart-legend"
        >
          <span className={styles.legendSwatch} style={{ backgroundColor: COLORS[index % COLORS.length] }} />
          <span className={styles.legendText} title={item.name}>{item.name}</span>
        </A2UIMotionItem>
      ))}
    </div>
  );
}

function ChartPointList({ points }: { points: ChartPoint[] }) {
  if (!points.length) {
    return null;
  }
  return (
    <div className={styles.pointList} data-testid="a2ui-chart-pie-list">
      {points.map((item, index) => (
        <A2UIMotionItem
          as="div"
          className={styles.pointItem}
          key={`${item.label}:${index}`}
          motionKey={`chart:point-list:${index}:${item.label}`}
          motionKind="chart-point-list"
        >
          <span className={styles.legendSwatch} style={{ backgroundColor: COLORS[index % COLORS.length] }} />
          <span className={styles.pointName} title={item.label}>{item.label}</span>
          <span className={styles.pointValue} title={formatNumber(item.value)}>{formatNumber(item.value)}</span>
        </A2UIMotionItem>
      ))}
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
  const panels = Array.isArray(payload.charts)
    ? payload.charts
      .map(asRecord)
      .filter((chart): chart is Record<string, unknown> => Boolean(chart))
      .map((record): ChartPanelSpec | null => {
        const chart = chartSpecFromRecord(record);
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

function chartSpecFromRecord(record: Record<string, unknown>): ChartSpec | null {
  const type = normalizeChartType(record.type);
  if (!type) {
    return null;
  }
  const seriesLabel = scalarText(record.series_label);
  const directPoints = normalizePoints(record.items);
  const series = normalizeSeries(record, directPoints);
  const categories = chartCategories(series, directPoints);
  const points = directPoints.length ? directPoints : pointsFromSeries(series[0]);
  return {
    type,
    title: scalarText(record.title),
    seriesLabel,
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
  const match = text.match(/"type"\s*:\s*"(pie|column|funnel|trend)"/i);
  return normalizeChartType(match?.[1]);
}

function chartTypesFromBuffer(buffer: unknown): ChartType[] {
  const text = typeof buffer === "string" ? buffer : "";
  return Array.from(text.matchAll(/"type"\s*:\s*"(pie|column|funnel|trend)"/gi))
    .map((match) => normalizeChartType(match[1]))
    .filter((type): type is ChartType => Boolean(type));
}

function normalizeChartType(value: unknown): ChartType | null {
  const type = scalarText(value).toLowerCase();
  if (type === "pie" || type === "column" || type === "funnel" || type === "trend") {
    return type as ChartType;
  }
  return null;
}

function normalizeSeries(record: Record<string, unknown>, directPoints: ChartPoint[]): ChartSeries[] {
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
  return record.series
    .map((item, index): ChartSeries | null => {
      const seriesRecord = asRecord(item);
      if (!seriesRecord || !Array.isArray(seriesRecord.items)) {
        return null;
      }
      const points = normalizePoints(seriesRecord.items);
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
        const ratio = numberValue(record.ratio);
        return {
          label,
          value: valueNumber,
          color: scalarText(record.color) || undefined,
          ratio: ratio ?? undefined,
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

function chartCategories(series: ChartSeries[], points: ChartPoint[]): string[] {
  const seriesCategories = series.find((item) => item.categories.length)?.categories ?? [];
  if (seriesCategories.length) {
    return seriesCategories;
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
  const seriesCount = chart.series.reduce((sum, series) => sum + series.data.filter((value) => value !== null).length, 0);
  return seriesCount + chart.points.length;
}

function chartPanelStabilityKey(parsed: ParsedA2UIMessage): string {
  return [
    scalarText(parsed.a2ui?.stream_id),
    scalarText(parsed.debug?.streamId),
    scalarText(parsed.a2ui?.tool_call_id),
    scalarText(parsed.debug?.toolCallId),
    scalarText(parsed.interactionId),
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

function tooltipText(series: string, category: string, value: number): string {
  return [series, category].filter(Boolean).join(" · ") + `: ${formatNumber(value)}`;
}

function polarToCartesian(centerX: number, centerY: number, radius: number, angleInDegrees: number) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

function describeArc(x: number, y: number, radius: number, startAngle: number, endAngle: number): string {
  const start = polarToCartesian(x, y, radius, endAngle);
  const end = polarToCartesian(x, y, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  return ["M", x, y, "L", start.x, start.y, "A", radius, radius, 0, largeArcFlag, 0, end.x, end.y, "Z"].join(" ");
}
