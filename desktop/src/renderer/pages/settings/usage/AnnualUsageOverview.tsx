import { Loader2, RefreshCw } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";

import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import { prefersReducedMotion } from "@/renderer/utils/motionPreference";
import type { UsageTrendPoint } from "@/types/protocol";

import styles from "./UsageStatsPage.module.css";

type TokenHeatBucket = "day" | "week";
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

export function AnnualUsageOverview({ runtime = runtimeBridge }: { runtime?: RuntimeBridge }) {
  const [bucket, setBucket] = useState<TokenHeatBucket>("day");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [trend, setTrend] = useState<UsageTrendPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const timezoneOffsetMinutes = useMemo(() => -new Date().getTimezoneOffset(), []);
  const range = useMemo(() => computeAnnualRange(), [refreshNonce]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void runtime.usage
      .getTrend({
        ...range,
        bucket: "day",
        timezoneOffsetMinutes,
      })
      .then((response) => {
        if (active) {
          setTrend(completeDailyTrendPoints(response.points, range, timezoneOffsetMinutes));
        }
      })
      .catch(() => {
        if (active) {
          setTrend([]);
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
  }, [range, runtime, timezoneOffsetMinutes]);

  return (
    <section
      className={styles.annualOverview}
      data-settings-group
      data-testid="annual-usage-overview"
      aria-labelledby="annual-usage-overview-title"
    >
      <div className={styles.groupHeader} data-settings-group-header>
        <h2 id="annual-usage-overview-title">年度概览</h2>
        <span>最近 1 年</span>
      </div>
      <section className={styles.overviewGrid} aria-label="用量总览">
        <section className={styles.chartPanel} data-settings-panel>
          <div className={styles.chartToolbar}>
            <span className={styles.chartRange}>最近 1 年</span>
            <div className={styles.panelHeaderActions}>
              <div className={styles.bucketToggle} aria-label="Token 热力粒度">
                <button
                  data-active={bucket === "day" ? "true" : "false"}
                  onClick={() => setBucket("day")}
                  type="button"
                >
                  每日
                </button>
                <button
                  data-active={bucket === "week" ? "true" : "false"}
                  onClick={() => setBucket("week")}
                  type="button"
                >
                  每周
                </button>
              </div>
              <button
                aria-label="刷新年度概览"
                className={styles.heatRefreshButton}
                disabled={loading}
                onClick={() => setRefreshNonce((value) => value + 1)}
                type="button"
              >
                {loading ? <Loader2 className={styles.spin} size={14} /> : <RefreshCw size={14} />}
              </button>
            </div>
          </div>
          <TokenHeatWall points={trend} bucket={bucket} rippleKey={String(refreshNonce)} />
        </section>
      </section>
    </section>
  );
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

function buildTokenHeatWall(points: UsageTrendPoint[]) {
  if (points.length === 0) {
    return { cells: [] as TokenHeatWallCell[], columns: 1, markers: [] as TokenHeatWallMarker[] };
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

function completeDailyTrendPoints(
  points: UsageTrendPoint[],
  range: { startTime: string; endTime: string },
  timezoneOffsetMinutes: number,
) {
  if (!points.length) {
    return points;
  }
  const start = toDailyBucketDate(range.startTime, timezoneOffsetMinutes);
  const end = toDailyBucketDate(range.endTime, timezoneOffsetMinutes);
  if (!start || !end || end.getTime() < start.getTime()) {
    return points;
  }

  const pointsByTime = new Map(points.map((point) => [point.time, point]));
  const completed: UsageTrendPoint[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    const time = formatHeatDateKey(cursor);
    completed.push(pointsByTime.get(time) ?? emptyTrendPoint(time));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return completed;
}

function computeAnnualRange() {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 1);
  start.setHours(0, 0, 0, 0);
  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

function toDailyBucketDate(value: string, timezoneOffsetMinutes: number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const shifted = new Date(date.getTime() + timezoneOffsetMinutes * 60_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return shifted;
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

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}
