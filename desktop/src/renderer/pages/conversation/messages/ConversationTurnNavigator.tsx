import { useRef, useState, type CSSProperties, type PointerEvent } from "react";

import styles from "./MessageList.module.css";

export interface ConversationTurnNavigationItem {
  id: string;
  targetIndex: number;
  userPreview: string;
  assistantPreview: string[];
}

export interface ConversationTurnNavigatorProps {
  turns: ConversationTurnNavigationItem[];
  onNavigate: (index: number) => void;
}

const WAVE_RADIUS = 3.6;
const WAVE_FALLOFF_EXPONENT = 1.45;
const BASE_MARKER_WIDTH = 12;
const PEAK_MARKER_WIDTH = 35;
const MARKER_STEP_PX = 12;
const MARKER_HIT_HEIGHT_PX = 14;

export function ConversationTurnNavigator({ turns, onNavigate }: ConversationTurnNavigatorProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const markerRefsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const hoveredIndexRef = useRef<number | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const setActiveIndex = (index: number | null) => {
    if (hoveredIndexRef.current === index) {
      return;
    }
    hoveredIndexRef.current = index;
    setHoveredIndex(index);
  };

  const setWavePosition = (wavePosition: number | null) => {
    markerRefsRef.current.forEach((marker, index) => {
      marker?.style.setProperty("--turn-marker-width", `${markerWidth(index, wavePosition)}px`);
    });
  };

  const activeTurn = hoveredIndex === null ? null : turns[hoveredIndex] ?? null;
  const railHeight = markerRailHeight(turns.length);
  const activeTop = hoveredIndex === null ? markerTopPx(Math.max(0, Math.floor(turns.length / 2))) : markerTopPx(hoveredIndex);

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    if (!rail || turns.length === 0) {
      return;
    }
    const rect = rail.getBoundingClientRect();
    const relativeY = event.clientY - rect.top - MARKER_HIT_HEIGHT_PX / 2;
    const nextWavePosition = clamp(relativeY / MARKER_STEP_PX, 0, Math.max(0, turns.length - 1));
    setWavePosition(nextWavePosition);
    setActiveIndex(Math.round(nextWavePosition));
  };

  const handlePointerLeave = () => {
    setWavePosition(null);
    setActiveIndex(null);
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
      data-testid="conversation-turn-navigator"
      style={{ "--turn-navigator-height": `${railHeight}px` } as CSSProperties}
    >
      <div className={styles.turnNavigatorRail} ref={railRef}>
        {turns.map((turn, index) => (
          <button
            className={styles.turnNavigatorMarker}
            key={turn.id}
            type="button"
            aria-label={`跳转到第 ${index + 1} 轮：${turn.userPreview}`}
            data-active={index === hoveredIndex ? "true" : "false"}
            ref={(node) => {
              markerRefsRef.current[index] = node;
            }}
            onFocus={() => {
              setWavePosition(index);
              setActiveIndex(index);
            }}
            onBlur={handlePointerLeave}
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
