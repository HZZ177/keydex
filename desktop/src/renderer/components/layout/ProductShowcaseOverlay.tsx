import { ArrowUp } from "lucide-react";
import { useEffect, useRef, type AnimationEvent, type CSSProperties } from "react";

import { prefersReducedMotion } from "@/renderer/utils/motionPreference";

import styles from "./ProductShowcaseOverlay.module.css";

const SHOWCASE_ICON_SRC = "/apple-touch-icon.png";
const STREAM_ITEMS = Array.from({ length: 8 }, (_, index) => index);

function cssVar(name: string, value: number): CSSProperties {
  return { [name]: value } as CSSProperties;
}

export type ProductShowcaseOverlayPhase = "open" | "exiting";

interface ProductShowcaseOverlayProps {
  phase: ProductShowcaseOverlayPhase;
  onRequestClose: () => void;
  onExited: () => void;
}

export function ProductShowcaseOverlay({
  phase,
  onRequestClose,
  onExited,
}: ProductShowcaseOverlayProps) {
  const returnButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    returnButtonRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onRequestClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onRequestClose]);

  useEffect(() => {
    if (phase !== "exiting" || !prefersReducedMotion()) {
      return;
    }
    const timer = window.setTimeout(onExited, 0);
    return () => window.clearTimeout(timer);
  }, [onExited, phase]);

  const handleAnimationEnd = (event: AnimationEvent<HTMLElement>) => {
    if (event.currentTarget !== event.target || phase !== "exiting") {
      return;
    }
    onExited();
  };

  return (
    <section
      className={styles.overlay}
      data-phase={phase}
      data-testid="product-showcase-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Keydex"
      onAnimationEnd={handleAnimationEnd}
    >
      <div className={styles.motionStage} aria-hidden="true">
        <div className={styles.gridLayer} />
        <div className={styles.topRail} />
        <div className={styles.scanBeam} />
        <div className={styles.crosshair} />
        <div className={styles.signalFrame} />
        <div className={styles.streams}>
          {STREAM_ITEMS.map((item) => (
            <span className={styles.stream} style={cssVar("--stream-index", item)} key={item} />
          ))}
        </div>
      </div>

      <div className={styles.brandLockup}>
        <div className={styles.logoTile} aria-hidden="true">
          <img alt="" draggable={false} src={SHOWCASE_ICON_SRC} />
        </div>
      </div>

      <button ref={returnButtonRef} className={styles.returnButton} type="button" onClick={onRequestClose}>
        <ArrowUp size={16} strokeWidth={2.1} />
        <span>回到应用</span>
      </button>
    </section>
  );
}
