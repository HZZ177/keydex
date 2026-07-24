import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type PropsWithChildren,
  type RefObject,
} from "react";

import { browserGeometryCoordinator } from "./BrowserGeometryCoordinator";

export type BrowserOcclusionReason =
  | "dialog"
  | "menu"
  | "permission"
  | "download"
  | "notification"
  | "annotation_drawer"
  | "command_palette"
  | "window_transition"
  | "system_picker";

export interface BrowserOcclusionSnapshot {
  readonly count: number;
  readonly reasons: Readonly<Record<BrowserOcclusionReason, number>>;
}

export class BrowserOcclusionCoordinator {
  private readonly counts = new Map<BrowserOcclusionReason, number>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  acquire(reason: BrowserOcclusionReason): () => void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
    this.emit();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = Math.max(0, (this.counts.get(reason) ?? 0) - 1);
      if (next === 0) this.counts.delete(reason);
      else this.counts.set(reason, next);
      this.emit();
    };
  }

  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot(): BrowserOcclusionSnapshot {
    const reasons = {} as Record<BrowserOcclusionReason, number>;
    let count = 0;
    for (const [reason, value] of this.counts) {
      reasons[reason] = value;
      count += value;
    }
    return Object.freeze({ count, reasons: Object.freeze(reasons) });
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

const BrowserOcclusionContext = createContext<BrowserOcclusionCoordinator | null>(null);

export function BrowserOcclusionProvider({ children }: PropsWithChildren) {
  const coordinator = useMemo(() => new BrowserOcclusionCoordinator(), []);
  return (
    <BrowserOcclusionContext.Provider value={coordinator}>
      {children}
    </BrowserOcclusionContext.Provider>
  );
}

export function useBrowserOcclusionToken(active: boolean, reason: BrowserOcclusionReason): void {
  const coordinator = useContext(BrowserOcclusionContext);
  useEffect(() => {
    if (!active || !coordinator) return;
    return coordinator.acquire(reason);
  }, [active, coordinator, reason]);
}

export function useBrowserOcclusionSnapshot(): BrowserOcclusionSnapshot {
  const coordinator = useContext(BrowserOcclusionContext);
  useSyncExternalStore(
    coordinator?.subscribe ?? NOOP_SUBSCRIBE,
    coordinator?.getVersion ?? ZERO_SNAPSHOT,
    ZERO_SNAPSHOT,
  );
  return coordinator?.snapshot() ?? EMPTY_SNAPSHOT;
}

export function useBrowserSpatialOcclusion(
  elementRef: RefObject<HTMLElement | null>,
  active: boolean,
  reason: string,
  options: { readonly observeResize?: boolean } = {},
): void {
  const instanceId = useId();
  const frameRef = useRef<number | null>(null);
  const observeResize = options.observeResize !== false;
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!active || !element) return;
    const schedule = () => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        browserGeometryCoordinator.syncAll();
      });
    };
    const release = browserGeometryCoordinator.registerSpatialOcclusionElement(
      `${reason}:${instanceId}`,
      element,
    );
    const resizeObserver = !observeResize || typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedule);
    const mutationObserver = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(schedule);
    resizeObserver?.observe(element);
    mutationObserver?.observe(element, {
      attributes: true,
      attributeFilter: ["class", "hidden", "style"],
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      release();
    };
  }, [active, elementRef, instanceId, observeResize, reason]);
}

const EMPTY_SNAPSHOT: BrowserOcclusionSnapshot = Object.freeze({
  count: 0,
  reasons: Object.freeze({}) as Readonly<Record<BrowserOcclusionReason, number>>,
});
const ZERO_SNAPSHOT = () => 0;
const NOOP_SUBSCRIBE = () => () => undefined;
