import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";

import styles from "./MessageList.module.css";

export interface ConversationTurnNavigationItem {
  id: string;
  targetIndex: number;
  userPreview: string;
  assistantPreview: string[];
}

export interface ConversationTurnNavigatorProps {
  turns: ConversationTurnNavigationItem[];
  activeIndex?: number | null;
  layout?: "floating" | "contained";
  onNavigate: (index: number) => void;
}

const WAVE_RADIUS = 3.6;
const WAVE_FALLOFF_EXPONENT = 1.45;
const BASE_MARKER_WIDTH = 12;
const PEAK_MARKER_WIDTH = 35;
const MARKER_STEP_PX = 12;
const MARKER_HIT_HEIGHT_PX = 14;
const SCROLL_EDGE_PX = 24;

export function ConversationTurnNavigator({
  turns,
  activeIndex,
  layout = "floating",
  onNavigate,
}: ConversationTurnNavigatorProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const currentIndicatorRef = useRef<HTMLDivElement>(null);
  const markerRefsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const hoveredIndexRef = useRef<number | null>(null);
  const wavePositionRef = useRef<number | null>(null);
  const knownTurnIdsRef = useRef<Set<string> | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [enteringTurnIds, setEnteringTurnIds] = useState<Set<string>>(() => new Set());
  const [viewportMetrics, setViewportMetrics] = useState({ clientHeight: 0, scrollHeight: 0, scrollTop: 0 });

  const setActiveIndex = (index: number | null) => {
    if (hoveredIndexRef.current === index) {
      return;
    }
    hoveredIndexRef.current = index;
    setHoveredIndex(index);
  };

  const setWavePosition = (wavePosition: number | null) => {
    wavePositionRef.current = wavePosition;
    markerRefsRef.current.forEach((marker, index) => {
      marker?.style.setProperty("--turn-marker-width", `${markerWidth(index, wavePosition)}px`);
    });
    currentIndicatorRef.current?.style.setProperty(
      "--turn-current-marker-width",
      `${currentIndicatorWidth(currentIndex, wavePosition)}px`,
    );
  };

  const updateViewportMetrics = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const nextMetrics = {
      clientHeight: viewport.clientHeight,
      scrollHeight: viewport.scrollHeight,
      scrollTop: viewport.scrollTop,
    };
    setViewportMetrics((previous) =>
      previous.clientHeight === nextMetrics.clientHeight &&
      previous.scrollHeight === nextMetrics.scrollHeight &&
      previous.scrollTop === nextMetrics.scrollTop
        ? previous
        : nextMetrics,
    );
  }, []);

  const railHeight = markerRailHeight(turns.length);
  const currentIndex = normalizeActiveIndex(activeIndex, turns.length);
  const activeTurn = hoveredIndex === null ? null : turns[hoveredIndex] ?? null;
  const currentIndicatorTop = currentIndex === null ? null : markerTopPx(currentIndex);
  const activeMarkerTop =
    hoveredIndex === null ? markerTopPx(currentIndex ?? Math.max(0, Math.floor(turns.length / 2))) : markerTopPx(hoveredIndex);
  const activeTop = clamp(
    activeMarkerTop - viewportMetrics.scrollTop,
    MARKER_HIT_HEIGHT_PX / 2,
    Math.max(MARKER_HIT_HEIGHT_PX / 2, (viewportMetrics.clientHeight || railHeight) - MARKER_HIT_HEIGHT_PX / 2),
  );
  const isScrollable = viewportMetrics.scrollHeight - viewportMetrics.clientHeight > 1;

  useLayoutEffect(() => {
    if (knownTurnIdsRef.current === null) {
      knownTurnIdsRef.current = new Set(turns.map((turn) => turn.id));
      return;
    }
    const knownTurnIds = knownTurnIdsRef.current;
    const nextEnteringIds = turns.filter((turn) => !knownTurnIds.has(turn.id)).map((turn) => turn.id);
    knownTurnIdsRef.current = new Set(turns.map((turn) => turn.id));
    if (!nextEnteringIds.length) {
      return;
    }
    setEnteringTurnIds((current) => {
      const next = new Set(current);
      nextEnteringIds.forEach((id) => next.add(id));
      return next;
    });
  }, [turns]);

  useLayoutEffect(() => {
    updateViewportMetrics();
  }, [railHeight, updateViewportMetrics]);

  useLayoutEffect(() => {
    currentIndicatorRef.current?.style.setProperty(
      "--turn-current-marker-width",
      `${currentIndicatorWidth(currentIndex, wavePositionRef.current)}px`,
    );
  }, [currentIndex]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    updateViewportMetrics();
    if (typeof ResizeObserver === "undefined") {
      if (typeof window === "undefined") {
        return;
      }
      window.addEventListener("resize", updateViewportMetrics);
      return () => {
        window.removeEventListener("resize", updateViewportMetrics);
      };
    }
    const observer = new ResizeObserver(updateViewportMetrics);
    observer.observe(viewport);
    if (railRef.current) {
      observer.observe(railRef.current);
    }
    return () => {
      observer.disconnect();
    };
  }, [updateViewportMetrics]);

  useEffect(() => {
    if (hoveredIndex !== null || currentIndex === null) {
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport || viewport.clientHeight <= 0) {
      return;
    }
    const markerTop = markerTopPx(currentIndex) - MARKER_HIT_HEIGHT_PX / 2;
    const markerBottom = markerTop + MARKER_HIT_HEIGHT_PX;
    const visibleTop = viewport.scrollTop;
    const visibleBottom = visibleTop + viewport.clientHeight;
    let nextScrollTop: number | null = null;

    if (markerTop < visibleTop + SCROLL_EDGE_PX) {
      nextScrollTop = markerTop - SCROLL_EDGE_PX;
    } else if (markerBottom > visibleBottom - SCROLL_EDGE_PX) {
      nextScrollTop = markerBottom + SCROLL_EDGE_PX - viewport.clientHeight;
    }

    if (nextScrollTop === null) {
      return;
    }
    viewport.scrollTop = clamp(nextScrollTop, 0, Math.max(0, viewport.scrollHeight - viewport.clientHeight));
    updateViewportMetrics();
  }, [currentIndex, hoveredIndex, updateViewportMetrics]);

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    if (!rail || turns.length === 0) {
      return;
    }
    const rect = rail.getBoundingClientRect();
    const relativeY = event.clientY - rect.top - MARKER_HIT_HEIGHT_PX / 2;
    if (!Number.isFinite(relativeY)) {
      return;
    }
    const nextWavePosition = clamp(relativeY / MARKER_STEP_PX, 0, Math.max(0, turns.length - 1));
    setWavePosition(nextWavePosition);
    setActiveIndex(Math.round(nextWavePosition));
  };

  const handlePointerLeave = () => {
    setWavePosition(null);
    setActiveIndex(null);
  };

  const handleViewportScroll = () => {
    updateViewportMetrics();
  };

  const handleMarkerAnimationEnd = (turnId: string) => {
    setEnteringTurnIds((current) => {
      if (!current.has(turnId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(turnId);
      return next;
    });
  };

  const navigateHoveredTurn = () => {
    const activeIndex = hoveredIndexRef.current;
    if (activeIndex === null) {
      return;
    }
    const turn = turns[activeIndex];
    if (turn) {
      onNavigate(turn.targetIndex);
    }
  };

  if (turns.length < 2) {
    return null;
  }

  return (
    <nav
      className={styles.turnNavigator}
      aria-label="对话轮次导航"
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onClick={navigateHoveredTurn}
      data-layout={layout}
      data-testid="conversation-turn-navigator"
      style={
        {
          "--turn-navigator-height": layout === "contained" ? "100%" : `${railHeight}px`,
          "--turn-navigator-rail-height": `${railHeight}px`,
          ...(layout === "contained" ? { "--turn-navigator-width": "44px" } : {}),
        } as CSSProperties
      }
    >
      <div
        className={styles.turnNavigatorViewport}
        data-scrollable={isScrollable ? "true" : "false"}
        data-testid="conversation-turn-navigator-viewport"
        ref={viewportRef}
        onScroll={handleViewportScroll}
      >
        <div className={styles.turnNavigatorRail} ref={railRef}>
          {currentIndicatorTop !== null ? (
            <div
              className={styles.turnNavigatorCurrentIndicator}
              aria-hidden="true"
              data-entering={enteringTurnIds.has(turns[currentIndex ?? -1]?.id ?? "") ? "true" : "false"}
              data-testid="conversation-turn-navigator-current-indicator"
              ref={currentIndicatorRef}
              style={
                {
                  "--turn-current-marker-top": `${currentIndicatorTop}px`,
                  "--turn-current-marker-width": `${currentIndicatorWidth(currentIndex, wavePositionRef.current)}px`,
                } as CSSProperties
              }
            >
              <span />
            </div>
          ) : null}
          {turns.map((turn, index) => (
            <button
              className={styles.turnNavigatorMarker}
              key={turn.id}
              type="button"
              aria-label={`跳转到第 ${index + 1} 轮：${turn.userPreview}`}
              data-active={index === hoveredIndex ? "true" : "false"}
              data-current={index === currentIndex ? "true" : "false"}
              data-entering={enteringTurnIds.has(turn.id) ? "true" : "false"}
              ref={(node) => {
                markerRefsRef.current[index] = node;
              }}
              onFocus={() => {
                setWavePosition(index);
                setActiveIndex(index);
              }}
              onBlur={handlePointerLeave}
              onAnimationEnd={() => handleMarkerAnimationEnd(turn.id)}
              style={
                {
                  "--turn-marker-top": `${markerTopPx(index)}px`,
                  "--turn-marker-width": `${BASE_MARKER_WIDTH}px`,
                } as CSSProperties
              }
            >
              <span />
            </button>
          ))}
        </div>
      </div>

      {activeTurn ? (
        <article
          className={styles.turnNavigatorCard}
          style={{ "--turn-card-top": `${activeTop}px` } as CSSProperties}
          data-testid="conversation-turn-navigator-card"
        >
          <strong>{activeTurn.userPreview}</strong>
          {activeTurn.assistantPreview.length ? (
            <span>{activeTurn.assistantPreview.join("\n")}</span>
          ) : (
            <span>暂无回复</span>
          )}
        </article>
      ) : null}
    </nav>
  );
}

function markerRailHeight(count: number): number {
  return Math.max(MARKER_HIT_HEIGHT_PX, MARKER_HIT_HEIGHT_PX + Math.max(0, count - 1) * MARKER_STEP_PX);
}

function markerTopPx(index: number): number {
  return MARKER_HIT_HEIGHT_PX / 2 + index * MARKER_STEP_PX;
}

function normalizeActiveIndex(index: number | null | undefined, count: number): number | null {
  if (index === null || index === undefined || count <= 0) {
    return null;
  }
  return Math.round(clamp(index, 0, count - 1));
}

function currentIndicatorWidth(index: number | null, waveIndex: number | null): number {
  return index === null ? BASE_MARKER_WIDTH : markerWidth(index, waveIndex);
}

function markerWidth(index: number, waveIndex: number | null): number {
  if (waveIndex === null) {
    return BASE_MARKER_WIDTH;
  }
  const distance = Math.abs(index - waveIndex);
  const influence = clamp(1 - distance / WAVE_RADIUS, 0, 1);
  return BASE_MARKER_WIDTH + (PEAK_MARKER_WIDTH - BASE_MARKER_WIDTH) * waveFalloff(influence);
}

function waveFalloff(value: number): number {
  return Math.pow(value, WAVE_FALLOFF_EXPONENT);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
