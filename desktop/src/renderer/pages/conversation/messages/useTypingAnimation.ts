import { useEffect, useRef, useState } from "react";

import { calculateDynamicStreamStep } from "@/renderer/hooks/useDynamicStreamBuffer";
import {
  createRuntimeTypingSpeedSourceId,
  reportRuntimeTypingSpeed,
} from "@/renderer/hooks/useRuntimeTypingSpeed";
import { conversationBaselineDiagnostics } from "./conversationBaselineDiagnostics";

export interface UseTypingAnimationOptions {
  content: string;
  sessionId: string;
  enabled?: boolean;
  completeImmediately?: boolean;
  fastDrain?: boolean;
  passthrough?: boolean;
  resetKey?: string;
}

export function useTypingAnimation({
  content,
  sessionId,
  enabled = true,
  completeImmediately = false,
  fastDrain = false,
  passthrough = false,
  resetKey = "",
}: UseTypingAnimationOptions) {
  const initialCacheKey = typingDisplayCacheKey(sessionId, resetKey);
  const initialContent = initialDisplayedContent(content, enabled, completeImmediately, initialCacheKey);
  const [displayedContent, setDisplayedContent] = useState(initialContent);
  const [isAnimating, setIsAnimating] = useState(false);
  const frameRef = useRef<number | null>(null);
  const contentRef = useRef(content);
  const displayedRef = useRef(initialContent);
  const lastTimestampRef = useRef<number | null>(null);
  const speedSourceIdRef = useRef(createRuntimeTypingSpeedSourceId());
  const sessionIdRef = useRef(sessionId);
  const carryRef = useRef(0);
  const fastDrainRef = useRef(fastDrain);
  const resetKeyRef = useRef(resetKey);
  const cacheKeyRef = useRef(initialCacheKey);

  const commitDisplayedContent = (nextContent: string) => {
    displayedRef.current = nextContent;
    rememberDisplayedContent(cacheKeyRef.current, nextContent);
    setDisplayedContent(nextContent);
    conversationBaselineDiagnostics.record({
      stage: "typing-commit",
      messageId: resetKeyRef.current,
      characters: contentRef.current.length,
      displayedCharacters: nextContent.length,
    });
  };

  const cancelFrame = () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    lastTimestampRef.current = null;
    carryRef.current = 0;
    reportRuntimeTypingSpeed(sessionIdRef.current, speedSourceIdRef.current, 0);
  };

  useEffect(() => {
    contentRef.current = content;
    const nextCacheKey = typingDisplayCacheKey(sessionId, resetKey);
    if (sessionIdRef.current !== sessionId) {
      cancelFrame();
      sessionIdRef.current = sessionId;
    }
    if (passthrough) {
      cancelFrame();
      displayedRef.current = content;
      setIsAnimating(false);
      return;
    }
    if (fastDrainRef.current !== fastDrain) {
      fastDrainRef.current = fastDrain;
      carryRef.current = 0;
    }

    if (cacheKeyRef.current !== nextCacheKey) {
      resetKeyRef.current = resetKey;
      cacheKeyRef.current = nextCacheKey;
      cancelFrame();
      commitDisplayedContent(initialDisplayedContent(content, enabled, completeImmediately, nextCacheKey));
    }

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
    if (diff < 0 || !isAppendOnlySnapshot(displayedRef.current, content)) {
      cancelFrame();
      commitDisplayedContent(content);
      setIsAnimating(false);
      return;
    }

    // Once a response is large, character-by-character animation multiplies
    // every real ingress batch into many full Markdown snapshot revisions.
    // Keep it streaming at the transport cadence without exhausting WebView
    // heap/native snapshot buffers.
    if (content.length >= LARGE_STREAM_DIRECT_COMMIT_CHARS) {
      cancelFrame();
      commitDisplayedContent(content);
      setIsAnimating(false);
      return;
    }

    // A completed/replayed large response must not spend minutes draining at
    // character-animation speed. Preserve the visual catch-up for ordinary
    // replies, but publish a large canonical backlog atomically so the shared
    // Markdown runtime can settle immediately.
    if (fastDrainRef.current && diff >= FAST_DRAIN_IMMEDIATE_BACKLOG_CHARS) {
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
        reportRuntimeTypingSpeed(sessionIdRef.current, speedSourceIdRef.current, 0);
        setIsAnimating(false);
        return;
      }

      const lastTimestamp = lastTimestampRef.current ?? timestamp;
      const elapsed = timestamp - lastTimestamp;
      if (elapsed > 0) {
        const step = calculateDynamicStreamStep(
          elapsed,
          backlog,
          carryRef.current,
          fastDrainRef.current ? FAST_DRAIN_STREAM_STEP_OPTIONS : undefined,
        );
        reportRuntimeTypingSpeed(
          sessionIdRef.current,
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
      reportRuntimeTypingSpeed(sessionIdRef.current, speedSourceIdRef.current, 0);
      setIsAnimating(false);
    };

    if (frameRef.current === null) {
      lastTimestampRef.current = performance.now();
      frameRef.current = window.requestAnimationFrame(animate);
    }
  }, [completeImmediately, content, enabled, fastDrain, passthrough, resetKey, sessionId]);

  useEffect(() => cancelFrame, []);

  return {
    displayedContent: passthrough ? content : displayedContent,
    isAnimating: passthrough ? false : isAnimating,
  };
}

function isAppendOnlySnapshot(previous: string, next: string): boolean {
  if (next === previous) return true;
  if (next.length <= previous.length) return false;
  if (previous.length <= 1_024) return next.startsWith(previous);
  const windowSize = 512;
  return next.slice(0, windowSize) === previous.slice(0, windowSize)
    && next.slice(previous.length - windowSize, previous.length) === previous.slice(-windowSize);
}

const INITIAL_STREAM_BACKLOG_CHARS = 420;
const INITIAL_STREAM_PREFIX_CHARS = 24;
const MAX_DISPLAY_CACHE_SIZE = 80;
const FAST_DRAIN_IMMEDIATE_BACKLOG_CHARS = 32 * 1024;
const LARGE_STREAM_DIRECT_COMMIT_CHARS = 64 * 1024;
const FAST_DRAIN_STREAM_STEP_OPTIONS = {
  minCharsPerSecond: 800,
  maxCharsPerSecond: 12000,
  comfortableBacklog: 1,
  drainTargetSeconds: 0.7,
};
const displayedContentByKey = new Map<string, string>();

function typingDisplayCacheKey(sessionId: string, resetKey: string): string {
  return sessionId && resetKey ? `${sessionId}:${resetKey}` : "";
}

function initialDisplayedContent(
  content: string,
  enabled: boolean,
  completeImmediately: boolean,
  resetKey: string,
): string {
  if (!enabled || completeImmediately || prefersReducedMotion()) {
    return content;
  }
  const cached = resetKey ? displayedContentByKey.get(resetKey) : undefined;
  if (cached !== undefined && content.startsWith(cached)) {
    return cached;
  }
  if (content.length <= INITIAL_STREAM_BACKLOG_CHARS) {
    return content;
  }
  const displayedLength = Math.max(INITIAL_STREAM_PREFIX_CHARS, content.length - INITIAL_STREAM_BACKLOG_CHARS);
  return content.slice(0, displayedLength);
}

function rememberDisplayedContent(resetKey: string, content: string) {
  if (!resetKey) {
    return;
  }
  displayedContentByKey.delete(resetKey);
  displayedContentByKey.set(resetKey, content);
  while (displayedContentByKey.size > MAX_DISPLAY_CACHE_SIZE) {
    const oldestKey = displayedContentByKey.keys().next().value;
    if (!oldestKey) {
      break;
    }
    displayedContentByKey.delete(oldestKey);
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
