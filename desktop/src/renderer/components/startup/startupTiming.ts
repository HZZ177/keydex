export const STARTUP_MIN_VISIBLE_MS = 550;
export const STARTUP_EXIT_MS = 280;

export function remainingStartupVisibleMs(startedAtMs: number, nowMs: number): number {
  return Math.max(0, STARTUP_MIN_VISIBLE_MS - Math.max(0, nowMs - startedAtMs));
}
