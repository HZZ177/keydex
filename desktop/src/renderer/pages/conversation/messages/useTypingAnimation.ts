import { useEffect, useRef, useState } from "react";

import { calculateDynamicStreamStep } from "@/renderer/hooks/useDynamicStreamBuffer";
import {
  createRuntimeTypingSpeedSourceId,
  reportRuntimeTypingSpeed,
} from "@/renderer/hooks/useRuntimeTypingSpeed";

export interface UseTypingAnimationOptions {
  content: string;
  enabled?: boolean;
  completeImmediately?: boolean;
}

export function useTypingAnimation({
  content,
  enabled = true,
  completeImmediately = false,
}: UseTypingAnimationOptions) {
  const [displayedContent, setDisplayedContent] = useState(content);
  const [isAnimating, setIsAnimating] = useState(false);
  const frameRef = useRef<number | null>(null);
  const contentRef = useRef(content);
  const displayedRef = useRef(content);
  const lastTimestampRef = useRef<number | null>(null);
  const speedSourceIdRef = useRef(createRuntimeTypingSpeedSourceId());
  const carryRef = useRef(0);

  const commitDisplayedContent = (nextContent: string) => {
    displayedRef.current = nextContent;
    setDisplayedContent(nextContent);
  };

  const cancelFrame = () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    lastTimestampRef.current = null;
    carryRef.current = 0;
    reportRuntimeTypingSpeed(speedSourceIdRef.current, 0);
  };

  useEffect(() => {
    contentRef.current = content;

    if (completeImmediately || prefersReducedMotion()) {
      cancelFrame();
      commitDisplayedContent(content);
      setIsAnimating(false);
      return;
    }

    if (content === displayedRef.current) {
      return;
    }

    const diff = content.length - displayedRef.current.length;
    if (diff < 0 || !content.startsWith(displayedRef.current)) {
      cancelFrame();
      commitDisplayedContent(content);
      setIsAnimating(false);
      return;
    }

    if (!enabled && diff <= 0) {
      cancelFrame();
      commitDisplayedContent(content);
      setIsAnimating(false);
      return;
    }

    setIsAnimating(true);

    const animate = (timestamp: number) => {
      const targetContent = contentRef.current;
      const currentContent = displayedRef.current;
      const backlog = targetContent.length - currentContent.length;
      if (backlog <= 0) {
        frameRef.current = null;
        lastTimestampRef.current = null;
        reportRuntimeTypingSpeed(speedSourceIdRef.current, 0);
        setIsAnimating(false);
        return;
      }

      const lastTimestamp = lastTimestampRef.current ?? timestamp;
      const elapsed = timestamp - lastTimestamp;
      if (elapsed > 0) {
        const step = calculateDynamicStreamStep(elapsed, backlog, carryRef.current);
        reportRuntimeTypingSpeed(
          speedSourceIdRef.current,
          step.effectiveCharsPerSecond,
          Math.max(0, backlog - step.chars),
        );
        carryRef.current = step.carry;
        if (step.chars > 0) {
          commitDisplayedContent(targetContent.slice(0, currentContent.length + step.chars));
        }
        lastTimestampRef.current = timestamp;
      }

      if (displayedRef.current.length < targetContent.length) {
        frameRef.current = window.requestAnimationFrame(animate);
        return;
      }

      frameRef.current = null;
      lastTimestampRef.current = null;
      reportRuntimeTypingSpeed(speedSourceIdRef.current, 0);
      setIsAnimating(false);
    };

    if (frameRef.current === null) {
      lastTimestampRef.current = performance.now();
      frameRef.current = window.requestAnimationFrame(animate);
    }
  }, [completeImmediately, content, enabled]);

  useEffect(() => cancelFrame, []);

  return { displayedContent, isAnimating };
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
