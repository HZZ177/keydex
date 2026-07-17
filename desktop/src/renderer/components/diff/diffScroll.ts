import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { KeydexDiffProfileName } from "./profiles";

export type KeydexDiffScrollOwner = "host" | "code_view";

export interface KeydexDiffViewportMetrics {
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
}

export interface KeydexDiffScrollRestoreIdentity {
  readonly profile: KeydexDiffProfileName;
  readonly scopeKey: string;
  readonly documentId: string;
  readonly sourceVersion: string;
}

export interface UseKeydexDiffScrollBridgeOptions
  extends KeydexDiffScrollRestoreIdentity {
  readonly memory?: KeydexDiffScrollMemory;
  readonly onRestoreRequested: (position: number) => void;
  readonly onViewportMetrics?: (metrics: KeydexDiffViewportMetrics) => void;
}

const MAX_SCROLL_MEMORY_ENTRIES = 96;

export const KEYDEX_DIFF_SCROLL_OWNERS = Object.freeze({
  compact: "host",
  review: "code_view",
  git: "code_view",
  preview: "code_view",
} satisfies Record<KeydexDiffProfileName, KeydexDiffScrollOwner>);

export function resolveKeydexDiffScrollOwner(
  profile: KeydexDiffProfileName,
): KeydexDiffScrollOwner {
  return KEYDEX_DIFF_SCROLL_OWNERS[profile];
}

export function createKeydexDiffScrollRestoreKey(
  identity: KeydexDiffScrollRestoreIdentity,
): string {
  return [
    "keydex-diff-scroll-v1",
    identity.profile,
    encodeKeyPart(identity.scopeKey),
    encodeKeyPart(identity.documentId),
    encodeKeyPart(identity.sourceVersion),
  ].join(":");
}

export class KeydexDiffScrollMemory {
  private readonly positions = new Map<string, number>();

  constructor(private readonly maximumEntries = MAX_SCROLL_MEMORY_ENTRIES) {}

  capture(key: string, position: number): void {
    if (!key || !Number.isFinite(position)) return;
    const normalized = Math.max(0, position);
    this.positions.delete(key);
    this.positions.set(key, normalized);
    while (this.positions.size > this.maximumEntries) {
      const oldest = this.positions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.positions.delete(oldest);
    }
  }

  restore(key: string): number | null {
    const position = this.positions.get(key);
    return position === undefined ? null : position;
  }

  delete(key: string): void {
    this.positions.delete(key);
  }

  readonly size = (): number => this.positions.size;
}

export const keydexDiffScrollMemory = new KeydexDiffScrollMemory();

export function useKeydexDiffScrollBridge({
  profile,
  scopeKey,
  documentId,
  sourceVersion,
  memory = keydexDiffScrollMemory,
  onRestoreRequested,
  onViewportMetrics,
}: UseKeydexDiffScrollBridgeOptions) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const lastVisible = useRef(false);
  const restoreKey = createKeydexDiffScrollRestoreKey({
    profile,
    scopeKey,
    documentId,
    sourceVersion,
  });
  const restoreKeyRef = useRef(restoreKey);
  restoreKeyRef.current = restoreKey;

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    setElement(node);
  }, []);

  const onScroll = useCallback((position: number) => {
    memory.capture(restoreKeyRef.current, position);
  }, [memory]);

  useEffect(() => {
    if (!element) return;
    let frame: number | null = null;
    const measure = (width?: number, height?: number) => {
      const rect = element.getBoundingClientRect();
      const nextWidth = Math.max(0, Math.round(width ?? rect.width ?? element.clientWidth));
      const nextHeight = Math.max(0, Math.round(height ?? rect.height ?? element.clientHeight));
      const visible = !element.hidden
        && nextWidth > 0
        && nextHeight > 0
        && getComputedStyle(element).display !== "none";
      const metrics = Object.freeze({ width: nextWidth, height: nextHeight, visible });
      onViewportMetrics?.(metrics);
      if (visible && !lastVisible.current) {
        onRestoreRequested(memory.restore(restoreKeyRef.current) ?? 0);
      }
      lastVisible.current = visible;
    };
    const scheduleMeasure = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    measure();
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(([entry]) => {
          if (entry) measure(entry.contentRect.width, entry.contentRect.height);
        });
    resizeObserver?.observe(element);
    const mutationObserver = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(scheduleMeasure);
    mutationObserver?.observe(element, {
      attributes: true,
      attributeFilter: ["class", "hidden", "style"],
    });
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      lastVisible.current = false;
    };
  }, [element, memory, onRestoreRequested, onViewportMetrics, restoreKey]);

  return Object.freeze({
    owner: resolveKeydexDiffScrollOwner(profile),
    restoreKey,
    containerRef,
    onScroll,
  });
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value.trim());
}
