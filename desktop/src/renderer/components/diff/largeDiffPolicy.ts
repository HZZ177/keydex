import type { KeydexDiffTruncation } from "./model";

export const DIFF_MAIN_THREAD_MAX_BYTES = 2 * 1024 * 1024;
export const DIFF_MAIN_THREAD_MAX_LINES = 20_000;
export const DIFF_RESPONSIVE_TARGET_BYTES = 8 * 1024 * 1024;
export const DIFF_RESPONSIVE_TARGET_LINES = 100_000;

export type DiffRenderStrategy =
  | "main_thread"
  | "worker"
  | "worker_unavailable"
  | "truncated_recoverable"
  | "truncated_unrecoverable";

export interface LargeDiffPolicyInput {
  readonly bytes: number;
  readonly lines: number;
  readonly workerAvailable: boolean;
  readonly truncation?: KeydexDiffTruncation;
}

export interface LargeDiffPolicy {
  readonly strategy: DiffRenderStrategy;
  readonly requiresWorker: boolean;
  readonly renderText: boolean;
  readonly allowPatchSelection: boolean;
  readonly canLoadMore: boolean;
  readonly message: string | null;
}

const COMPLETE: KeydexDiffTruncation = {
  state: "complete",
  reason: null,
  canLoadMore: false,
  continuationToken: null,
  loadedBytes: null,
  totalBytes: null,
  loadedLines: null,
  totalLines: null,
};

export function resolveLargeDiffPolicy(input: LargeDiffPolicyInput): LargeDiffPolicy {
  assertNonNegativeInteger(input.bytes, "bytes");
  assertNonNegativeInteger(input.lines, "lines");
  const truncation = input.truncation ?? COMPLETE;
  if (truncation.state !== "complete") {
    const recoverable = truncation.state === "recoverable" && truncation.canLoadMore;
    return {
      strategy: recoverable ? "truncated_recoverable" : "truncated_unrecoverable",
      requiresWorker: false,
      renderText: false,
      allowPatchSelection: false,
      canLoadMore: recoverable,
      message: recoverable
        ? "差异内容尚未完整加载，可继续加载后查看。"
        : "差异内容已被截断，无法安全展示或执行局部操作。",
    };
  }

  const requiresWorker =
    input.bytes >= DIFF_MAIN_THREAD_MAX_BYTES || input.lines >= DIFF_MAIN_THREAD_MAX_LINES;
  if (!requiresWorker) {
    return {
      strategy: "main_thread",
      requiresWorker: false,
      renderText: true,
      allowPatchSelection: true,
      canLoadMore: false,
      message: null,
    };
  }
  if (input.workerAvailable) {
    return {
      strategy: "worker",
      requiresWorker: true,
      renderText: true,
      allowPatchSelection: true,
      canLoadMore: false,
      message: null,
    };
  }
  return {
    strategy: "worker_unavailable",
    requiresWorker: true,
    renderText: false,
    allowPatchSelection: false,
    canLoadMore: false,
    message: "差异内容较大，需要后台解析服务；当前服务不可用。",
  };
}

function assertNonNegativeInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}
