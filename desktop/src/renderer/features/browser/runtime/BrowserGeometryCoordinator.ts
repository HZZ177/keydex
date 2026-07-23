import type {
  BrowserGeometryFrame,
  BrowserLogicalRect,
  BrowserSurfaceRef,
} from "../domain";
import { BrowserHostClient } from "./BrowserHostClient";

const geometryClient = new BrowserHostClient();

interface GeometryEntry {
  readonly key: string;
  readonly surface: BrowserSurfaceRef;
  readonly element: HTMLElement;
  revision: number;
  visible: boolean;
  lastRect: BrowserLogicalRect | null;
  lastOcclusions: readonly BrowserLogicalRect[];
}

export interface BrowserInteractiveResizeStart {
  readonly placement: "left" | "right";
  readonly startScreenX: number;
  readonly minDelta: number;
  readonly maxDelta: number;
}

class BrowserGeometryCoordinator {
  readonly #entries = new Map<string, GeometryEntry>();
  readonly #lastRevisions = new Map<string, number>();
  readonly #occlusionElements = new Map<string, readonly HTMLElement[]>();
  #interactiveSessionId: number | null = null;
  #lastInteractiveSessionId = 0;

  register(surface: BrowserSurfaceRef, element: HTMLElement, visible: boolean): () => void {
    const key = surfaceKey(surface);
    const entry: GeometryEntry = {
      key,
      surface,
      element,
      revision: this.#lastRevisions.get(key) ?? 0,
      visible,
      lastRect: null,
      lastOcclusions: [],
    };
    this.#entries.set(key, entry);
    this.#sync(entry, true);
    return () => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    };
  }

  setVisibility(surface: BrowserSurfaceRef, visible: boolean): void {
    const entry = this.#entries.get(surfaceKey(surface));
    if (!entry || entry.visible === visible) return;
    entry.visible = visible;
    this.#sync(entry, true);
  }

  syncSurface(surface: BrowserSurfaceRef): void {
    const entry = this.#entries.get(surfaceKey(surface));
    if (entry) this.#sync(entry, false);
  }

  syncAll(): void {
    if (this.#interactiveSessionId !== null) return;
    for (const entry of this.#entries.values()) this.#sync(entry, true);
  }

  setOcclusionElements(surface: BrowserSurfaceRef, elements: readonly HTMLElement[]): void {
    const key = surfaceKey(surface);
    if (elements.length > 0) this.#occlusionElements.set(key, [...elements]);
    else this.#occlusionElements.delete(key);
    const entry = this.#entries.get(key);
    if (entry) this.#sync(entry, true);
  }

  beginInteractiveResize(input: BrowserInteractiveResizeStart): number | null {
    const surfaces = this.#collectFrames(true);
    if (surfaces.length === 0) return null;
    const sessionId = Math.max(this.#lastInteractiveSessionId + 1, Date.now() * 1024);
    this.#lastInteractiveSessionId = sessionId;
    this.#interactiveSessionId = sessionId;
    geometryClient.beginInteractiveResize({
      sessionId,
      placement: input.placement,
      startScreenX: finiteOrZero(input.startScreenX),
      minDelta: finiteOrZero(input.minDelta),
      maxDelta: finiteOrZero(input.maxDelta),
      surfaces,
    });
    return sessionId;
  }

  endInteractiveResize(sessionId: number | null): void {
    if (sessionId === null || this.#interactiveSessionId !== sessionId) return;
    this.#interactiveSessionId = null;
    const surfaces = this.#collectFrames(true);
    if (surfaces.length === 0) return;
    geometryClient.endInteractiveResize({ sessionId, surfaces });
  }

  #collectFrames(force: boolean): BrowserGeometryFrame[] {
    const frames: BrowserGeometryFrame[] = [];
    for (const entry of this.#entries.values()) {
      const frame = this.#frame(entry, force);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  #sync(entry: GeometryEntry, force: boolean): void {
    if (this.#interactiveSessionId !== null) return;
    const frame = this.#frame(entry, force);
    if (frame) geometryClient.syncGeometry(frame);
  }

  #frame(entry: GeometryEntry, force: boolean): BrowserGeometryFrame | null {
    if (!entry.element.isConnected) return null;
    const domRect = entry.element.getBoundingClientRect();
    const rect: BrowserLogicalRect = {
      x: finiteOrZero(domRect.x),
      y: finiteOrZero(domRect.y),
      width: Math.max(0, finiteOrZero(domRect.width)),
      height: Math.max(0, finiteOrZero(domRect.height)),
    };
    const occlusions = browserSurfaceOcclusionRects(
      domRect,
      this.#occlusionElements.get(entry.key)?.map((element) => element.getBoundingClientRect()) ?? [],
    );
    if (!force && sameRect(entry.lastRect, rect) && sameRects(entry.lastOcclusions, occlusions)) return null;
    entry.lastRect = rect;
    entry.lastOcclusions = occlusions;
    entry.revision += 1;
    this.#lastRevisions.set(entry.key, entry.revision);
    return {
      ...entry.surface,
      occlusions,
      revision: entry.revision,
      rect,
      visible: entry.visible && rect.width > 0 && rect.height > 0,
    };
  }
}

export const browserGeometryCoordinator = new BrowserGeometryCoordinator();

function surfaceKey(surface: BrowserSurfaceRef): string {
  return `${surface.panelId}:${surface.surfaceId}:${surface.generation}`;
}

function sameRect(left: BrowserLogicalRect | null, right: BrowserLogicalRect): boolean {
  return left !== null
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function sameRects(
  left: readonly BrowserLogicalRect[],
  right: readonly BrowserLogicalRect[],
): boolean {
  return left.length === right.length
    && left.every((rect, index) => sameRect(rect, right[index]!));
}

export function browserSurfaceOcclusionRects(
  surface: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
  overlays: readonly Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">[],
  margin = 1,
): readonly BrowserLogicalRect[] {
  return overlays.flatMap((overlay) => {
    if (overlay.width <= 0 || overlay.height <= 0) return [];
    const left = Math.max(surface.left, overlay.left - margin);
    const top = Math.max(surface.top, overlay.top - margin);
    const right = Math.min(surface.right, overlay.right + margin);
    const bottom = Math.min(surface.bottom, overlay.bottom + margin);
    if (right <= left || bottom <= top) return [];
    return [{
      x: finiteOrZero(left - surface.left),
      y: finiteOrZero(top - surface.top),
      width: Math.max(0, finiteOrZero(right - left)),
      height: Math.max(0, finiteOrZero(bottom - top)),
    }];
  });
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
