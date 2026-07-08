import type { A2UIInteractionState } from "@/types/protocol";

export type A2UILifecycle = "streaming" | "waiting_input" | "submitting" | "settled" | "failed";
export type A2UIOutcome = "none" | "submitted" | "cancelled_by_user" | "tool_failed" | "expired" | "superseded";
export type A2UIPresentation = "live" | "readonly_current" | "readonly_history" | "error_recoverable" | "error_final";

export interface A2UIRenderState {
  lifecycle: A2UILifecycle;
  outcome: A2UIOutcome;
  presentation: A2UIPresentation;
  normalizedStatus: string;
  resumeStatus: string;
  isStreaming: boolean;
  isWaitingInput: boolean;
  isSubmitted: boolean;
  isCancelled: boolean;
  isFailed: boolean;
  isReadonly: boolean;
}

export interface A2UIRenderStateInput {
  status: string;
  mode: string;
  interaction: Partial<A2UIInteractionState> | null;
  historyHydrated: boolean;
}

export function resolveA2UIRenderState(input: A2UIRenderStateInput): A2UIRenderState {
  const normalizedStatus = normalizeA2UIStatus(input.interaction?.status) || normalizeA2UIStatus(input.status) || "created";
  const resumeStatus = stringValue(input.interaction?.resume_status).toLowerCase();
  const isStreaming = normalizedStatus === "started" || normalizedStatus === "streaming" || normalizedStatus === "finished";
  const isWaitingInput = normalizedStatus === "waiting_input";
  const isSubmitted = normalizedStatus === "submitted";
  const isCancelled = normalizedStatus === "cancelled";
  const isFailed = normalizedStatus === "failed" || normalizedStatus === "missing" || resumeStatus === "failed";
  const isInteractive = input.mode === "interactive";
  const isReadonly = isInteractive && (isSubmitted || isCancelled || input.historyHydrated);

  if (isFailed) {
    return {
      lifecycle: "failed",
      outcome: "tool_failed",
      presentation: input.historyHydrated ? "error_final" : "error_recoverable",
      normalizedStatus,
      resumeStatus,
      isStreaming: false,
      isWaitingInput: false,
      isSubmitted: false,
      isCancelled: false,
      isFailed: true,
      isReadonly: false,
    };
  }

  if (isStreaming) {
    return {
      lifecycle: "streaming",
      outcome: "none",
      presentation: "live",
      normalizedStatus,
      resumeStatus,
      isStreaming: true,
      isWaitingInput: false,
      isSubmitted: false,
      isCancelled: false,
      isFailed: false,
      isReadonly: false,
    };
  }

  if (isWaitingInput) {
    return {
      lifecycle: "waiting_input",
      outcome: "none",
      presentation: "live",
      normalizedStatus,
      resumeStatus,
      isStreaming: false,
      isWaitingInput: true,
      isSubmitted: false,
      isCancelled: false,
      isFailed: false,
      isReadonly: false,
    };
  }

  if (isSubmitted || isCancelled) {
    return {
      lifecycle: "settled",
      outcome: isSubmitted ? "submitted" : "cancelled_by_user",
      presentation: input.historyHydrated ? "readonly_history" : "readonly_current",
      normalizedStatus,
      resumeStatus,
      isStreaming: false,
      isWaitingInput: false,
      isSubmitted,
      isCancelled,
      isFailed: false,
      isReadonly: true,
    };
  }

  return {
    lifecycle: "settled",
    outcome: "none",
    presentation: input.historyHydrated && isInteractive ? "readonly_history" : "live",
    normalizedStatus,
    resumeStatus,
    isStreaming: false,
    isWaitingInput: false,
    isSubmitted: false,
    isCancelled: false,
    isFailed: false,
    isReadonly,
  };
}

export function normalizeA2UIStatus(status: unknown): string {
  const normalized = stringValue(status).toLowerCase();
  if (normalized === "waiting_user_input") {
    return "waiting_input";
  }
  if (normalized === "missing") {
    return "failed";
  }
  return normalized;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
