export type ConversationBaselineStage =
  | "message-list-render"
  | "message-text-render"
  | "process-messages"
  | "typing-commit"
  | "markdown-normalize"
  | "markdown-model";

export interface ConversationBaselineEvent {
  readonly stage: ConversationBaselineStage;
  readonly atMs: number;
  readonly messageId?: string;
  readonly status?: string;
  readonly characters?: number;
  readonly displayedCharacters?: number;
  readonly itemCount?: number;
  readonly blockCount?: number;
  readonly durationMs?: number;
}

const MAX_EVENTS = 100_000;
let enabled = false;
let events: ConversationBaselineEvent[] = [];

export const conversationBaselineDiagnostics = Object.freeze({
  isEnabled(): boolean { return enabled; },
  enable(value = true): void { enabled = value; },
  reset(): void { events = []; },
  record(event: Omit<ConversationBaselineEvent, "atMs">): void {
    if (!enabled) return;
    if (events.length >= MAX_EVENTS) events.shift();
    events.push(Object.freeze({ ...event, atMs: now() }));
  },
  snapshot(): { readonly enabled: boolean; readonly events: readonly ConversationBaselineEvent[] } {
    return Object.freeze({ enabled, events: Object.freeze([...events]) });
  },
});

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
