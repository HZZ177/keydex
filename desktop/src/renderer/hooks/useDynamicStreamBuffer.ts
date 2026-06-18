export interface DynamicStreamStepOptions {
  minCharsPerSecond?: number;
  maxCharsPerSecond?: number;
  comfortableBacklog?: number;
  drainTargetSeconds?: number;
}

export interface DynamicStreamStep {
  chars: number;
  carry: number;
  effectiveCharsPerSecond: number;
}

export const DEFAULT_MIN_STREAM_CHARS_PER_SECOND = 120;
export const DEFAULT_MAX_STREAM_CHARS_PER_SECOND = 640;
export const DEFAULT_COMFORTABLE_STREAM_BACKLOG = 120;
export const DEFAULT_STREAM_DRAIN_TARGET_SECONDS = 1.4;

export function calculateDynamicStreamStep(
  elapsedMs: number,
  backlog: number,
  carry = 0,
  options: DynamicStreamStepOptions = {},
): DynamicStreamStep {
  const minCharsPerSecond = positiveNumber(
    options.minCharsPerSecond,
    DEFAULT_MIN_STREAM_CHARS_PER_SECOND,
  );
  const maxCharsPerSecond = Math.max(
    minCharsPerSecond,
    positiveNumber(options.maxCharsPerSecond, DEFAULT_MAX_STREAM_CHARS_PER_SECOND),
  );
  const comfortableBacklog = positiveNumber(
    options.comfortableBacklog,
    DEFAULT_COMFORTABLE_STREAM_BACKLOG,
  );
  const drainTargetSeconds = positiveNumber(
    options.drainTargetSeconds,
    DEFAULT_STREAM_DRAIN_TARGET_SECONDS,
  );

  const targetDrainSpeed = backlog > comfortableBacklog ? backlog / drainTargetSeconds : minCharsPerSecond;
  const effectiveCharsPerSecond = Math.min(
    maxCharsPerSecond,
    Math.max(minCharsPerSecond, targetDrainSpeed),
  );
  const total = Math.max(0, carry) + (Math.max(0, elapsedMs) / 1000) * effectiveCharsPerSecond;
  const chars = Math.min(Math.max(0, backlog), Math.floor(total));
  return {
    chars,
    carry: chars >= backlog ? 0 : total - chars,
    effectiveCharsPerSecond,
  };
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
