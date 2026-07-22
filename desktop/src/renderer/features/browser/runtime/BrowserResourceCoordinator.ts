import { BROWSER_LIMITS } from "../config";
import type { BrowserSurfaceRef } from "../domain";
import type { BrowserSurfaceResourceState } from "../state/browserRuntimeStore";

export interface BrowserResourceCandidate {
  readonly panelId: string;
  readonly surface: BrowserSurfaceRef;
  readonly active: boolean;
  readonly protected: boolean;
  readonly lastUsed: number;
}

export interface BrowserResourceDecision extends BrowserResourceCandidate {
  readonly next: BrowserSurfaceResourceState;
}

export function planBrowserResources(
  candidates: readonly BrowserResourceCandidate[],
  options: {
    readonly maxLive?: number;
    readonly maxWarm?: number;
    readonly memoryPressure?: boolean;
  } = {},
): BrowserResourceDecision[] {
  const maxLive = options.maxLive ?? BROWSER_LIMITS.maxLiveSurfaces;
  const maxWarm = options.maxWarm ?? BROWSER_LIMITS.maxWarmSurfaces;
  const ordered = [...candidates].sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    if (left.protected !== right.protected) return left.protected ? -1 : 1;
    return right.lastUsed - left.lastUsed || left.panelId.localeCompare(right.panelId);
  });
  let warmOrVisible = 0;
  let live = 0;
  return ordered.map((candidate) => {
    let next: BrowserSurfaceResourceState;
    if (candidate.active) {
      next = "visible";
      warmOrVisible += 1;
      live += 1;
    } else if (candidate.protected) {
      // A protected page cannot be safely suspended or discarded. Safety wins over a soft cap.
      next = "warm";
      warmOrVisible += 1;
      live += 1;
    } else if (!options.memoryPressure && warmOrVisible < maxWarm) {
      next = "warm";
      warmOrVisible += 1;
      live += 1;
    } else if (!options.memoryPressure && live < maxLive) {
      next = "native_suspended";
      live += 1;
    } else {
      next = "discarded";
    }
    return { ...candidate, next };
  });
}
