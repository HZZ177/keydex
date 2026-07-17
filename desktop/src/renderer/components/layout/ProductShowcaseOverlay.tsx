import { ArrowUp } from "lucide-react";
import {
  useEffect,
  useRef,
  type AnimationEvent,
  type MouseEvent,
} from "react";

import { prefersReducedMotion } from "@/renderer/utils/motionPreference";

import { ProductParticleSphere } from "./ProductParticleSphere";
import styles from "./ProductShowcaseOverlay.module.css";

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
      if (!event.repeat && (event.key === "Escape" || event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
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

  const closeOverlay = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onRequestClose();
  };

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
      <div className={styles.ambientField} aria-hidden="true" />
      <div className={styles.particleStage}>
        <div className={styles.orbitFrame} aria-hidden="true" />
        <ProductParticleSphere />
      </div>

      <button ref={returnButtonRef} className={styles.returnButton} type="button" onClick={closeOverlay}>
        <ArrowUp size={16} strokeWidth={2.1} />
        <span>回到应用</span>
      </button>
    </section>
  );
}
