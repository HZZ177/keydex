import { isUpwardWheelIntent, wheelWillScrollElement, type WheelIntentEvent } from "../messages/scrollIntent";
import { EXPANSION_SCROLL_LOCK_ATTR } from "../messages/useExpansionScrollAnchor";
import type { ConversationTimelineScrollRequest } from "./ConversationTimelineRuntime";

export type ConversationFollowMode =
  | "bootstrapping-tail"
  | "following-bottom"
  | "user-detached"
  | "navigating-turn"
  | "restoring-history"
  | "suspended";

export type ConversationContentMutation =
  | "initial"
  | "token-append"
  | "typing-backlog"
  | "timeline-publish"
  | "resource-resize"
  | "a2ui-live"
  | "stream-complete";

export interface ConversationFollowSnapshot {
  readonly mode: ConversationFollowMode;
  readonly reason: string;
  readonly revision: number;
  readonly bottomGap: number;
  readonly showScrollToBottom: boolean;
  readonly autoFollow: boolean;
  readonly mutationSequence: number;
  readonly scrollSequence: number;
  readonly bootstrapCommitted: boolean;
  readonly tailReady: boolean;
}

export interface ConversationFollowControllerOptions {
  readonly autoFollow?: boolean;
  readonly followThresholdPx?: number;
  readonly buttonThresholdPx?: number;
  readonly onChange?: (snapshot: ConversationFollowSnapshot) => void;
}

const DEFAULT_FOLLOW_THRESHOLD = 4;
const DEFAULT_BUTTON_THRESHOLD = 100;

/** Explicit ownership state for the single conversation scroll element. */
export class ConversationFollowController {
  private element: HTMLElement | null = null;
  private mode: ConversationFollowMode = "bootstrapping-tail";
  private reason = "initial";
  private revision = 0;
  private mutationSequence = 0;
  private scrollSequence = 0;
  private autoFollow: boolean;
  private readonly followThreshold: number;
  private readonly buttonThreshold: number;
  private readonly onChange?: (snapshot: ConversationFollowSnapshot) => void;
  private temporaryPreviousMode: ConversationFollowMode = "following-bottom";
  private userIntent = false;
  private upwardDetachStartScrollTop: number | null = null;
  private scrollbarDrag = false;
  private contentAvailable = false;
  private bootstrapCommitted: boolean;
  private tailReady = false;
  private bootstrapFrame: number | null = null;
  private followFrame: number | null = null;
  private animationFrame: number | null = null;
  private disposed = false;

  constructor(options: ConversationFollowControllerOptions = {}) {
    this.autoFollow = options.autoFollow ?? true;
    this.mode = this.autoFollow ? "bootstrapping-tail" : "user-detached";
    this.bootstrapCommitted = !this.autoFollow;
    this.followThreshold = finiteNonNegative(options.followThresholdPx ?? DEFAULT_FOLLOW_THRESHOLD);
    this.buttonThreshold = finiteNonNegative(options.buttonThresholdPx ?? DEFAULT_BUTTON_THRESHOLD);
    this.onChange = options.onChange;
  }

  attach(element: HTMLElement | null): void {
    this.assertActive();
    if (this.element === element) return;
    this.detachListeners();
    this.element = element;
    if (element) {
      this.attachElementListeners(element);
      window.addEventListener("pointerup", this.finishPointerIntent);
      window.addEventListener("pointercancel", this.finishPointerIntent);
      window.addEventListener("blur", this.finishPointerIntent);
      if (this.autoFollow && this.contentAvailable && this.shouldFollowTail()) {
        this.writeScrollTop(bottomScrollTop(element));
        if (this.mode === "bootstrapping-tail" && this.tailReady) this.scheduleBootstrapCommit();
      }
    }
    this.emit(false);
  }

  setContentAvailable(available: boolean): void {
    this.assertActive();
    const becameAvailable = available && !this.contentAvailable;
    this.contentAvailable = available;
    if (!available) {
      this.cancelScheduledScroll();
      this.tailReady = false;
      this.bootstrapCommitted = !this.autoFollow;
      this.transition(this.autoFollow ? "bootstrapping-tail" : "user-detached", "empty");
      return;
    }
    if (becameAvailable && this.element && this.autoFollow && this.mode === "bootstrapping-tail") {
      this.writeScrollTop(bottomScrollTop(this.element));
      this.reason = "content:initial";
      this.mutationSequence += 1;
      if (this.tailReady) this.scheduleBootstrapCommit();
      this.emit();
      return;
    }
    this.notifyContentMutation("initial");
  }

  setAutoFollow(enabled: boolean): void {
    this.assertActive();
    if (this.autoFollow === enabled) return;
    this.autoFollow = enabled;
    if (!enabled) {
      this.upwardDetachStartScrollTop = null;
      this.bootstrapCommitted = true;
      if (this.mode === "following-bottom" || this.mode === "bootstrapping-tail") {
        this.transition("user-detached", "auto-follow-disabled");
      } else this.emit();
      return;
    }
    if (!this.contentAvailable) {
      this.bootstrapCommitted = false;
      this.transition("bootstrapping-tail", "auto-follow-enabled-empty");
    } else if (this.atBottom()) {
      this.upwardDetachStartScrollTop = null;
      this.bootstrapCommitted = true;
      this.transition("following-bottom", "auto-follow-enabled-at-bottom");
    } else this.emit();
  }

  resetForIdentity(reason = "conversation-changed"): void {
    this.assertActive();
    this.cancelScheduledScroll();
    this.contentAvailable = false;
    this.tailReady = false;
    this.bootstrapCommitted = !this.autoFollow;
    this.userIntent = false;
    this.upwardDetachStartScrollTop = null;
    this.scrollbarDrag = false;
    this.transition(this.autoFollow ? "bootstrapping-tail" : "user-detached", reason);
  }

  setTailReady(ready: boolean): void {
    this.assertActive();
    if (this.tailReady === ready) {
      if (ready && this.mode === "bootstrapping-tail") this.scheduleBootstrapCommit();
      return;
    }
    this.tailReady = ready;
    if (!ready && this.bootstrapFrame !== null) {
      cancelAnimationFrame(this.bootstrapFrame);
      this.bootstrapFrame = null;
    }
    if (ready && this.mode === "bootstrapping-tail" && this.contentAvailable && this.autoFollow) {
      this.scheduleBootstrapCommit();
    }
    this.emit();
  }

  applyScrollRequest(request: ConversationTimelineScrollRequest): void {
    this.assertActive();
    if (!this.element) return;
    if (
      isFollowBottomRequest(request.reason)
      && (!this.shouldFollowTail() || this.element.hasAttribute(EXPANSION_SCROLL_LOCK_ATTR))
    ) return;
    this.writeScrollTop(request.scrollTop);
    if (isFollowBottomRequest(request.reason) && this.mode === "bootstrapping-tail" && this.tailReady) {
      this.scheduleBootstrapCommit();
    }
  }

  notifyContentMutation(kind: ConversationContentMutation): void {
    this.assertActive();
    this.mutationSequence += 1;
    if (this.upwardDetachStartScrollTop !== null && !this.atBottom()) {
      this.upwardDetachStartScrollTop = null;
    }
    if (!this.autoFollow || !this.shouldFollowTail() || !this.contentAvailable) {
      this.emit();
      return;
    }
    if (this.element?.hasAttribute(EXPANSION_SCROLL_LOCK_ATTR)) {
      this.reason = `blocked:${kind}:expansion-lock`;
      this.emit();
      return;
    }
    if (this.mode === "bootstrapping-tail") {
      this.reason = `content:${kind}`;
      if (this.element) this.writeScrollTop(bottomScrollTop(this.element));
      if (this.tailReady) this.scheduleBootstrapCommit();
      this.emit();
      return;
    }
    this.scheduleFollow(kind);
  }

  beginNavigation(reason = "turn-navigation"): void {
    this.assertActive();
    this.cancelScheduledScroll();
    this.upwardDetachStartScrollTop = null;
    this.bootstrapCommitted = true;
    this.temporaryPreviousMode = this.mode;
    this.transition("navigating-turn", reason);
  }

  endNavigation(): void {
    this.assertActive();
    if (this.mode !== "navigating-turn") return;
    this.transition(this.atBottom() && this.autoFollow ? "following-bottom" : "user-detached", "turn-navigation-ended");
  }

  beginHistoryRestore(): void {
    this.assertActive();
    this.cancelScheduledScroll();
    this.upwardDetachStartScrollTop = null;
    this.bootstrapCommitted = true;
    this.temporaryPreviousMode = this.mode;
    this.transition("restoring-history", "history-prepend");
  }

  endHistoryRestore(): void {
    this.assertActive();
    if (this.mode !== "restoring-history") return;
    const next = this.temporaryPreviousMode !== "user-detached" && this.autoFollow
      ? "following-bottom"
      : "user-detached";
    this.transition(next, "history-restored");
    if (next === "following-bottom") this.notifyContentMutation("timeline-publish");
  }

  beginScrollbarDrag(reason = "scrollbar-drag"): void {
    this.assertActive();
    this.cancelScheduledScroll();
    this.userIntent = true;
    this.upwardDetachStartScrollTop = null;
    this.scrollbarDrag = true;
    this.bootstrapCommitted = true;
    if (this.mode === "following-bottom" || this.mode === "bootstrapping-tail") {
      this.transition("user-detached", reason);
    } else this.emit();
  }

  endScrollbarDrag(): void {
    this.assertActive();
    this.scrollbarDrag = false;
    if (this.atBottom() && this.autoFollow && this.mode === "user-detached") {
      this.userIntent = false;
      this.transition("following-bottom", "scrollbar-drag-ended-at-bottom");
    }
  }

  suspend(reason: string): void {
    this.assertActive();
    if (this.mode !== "suspended") this.temporaryPreviousMode = this.mode;
    this.cancelScheduledScroll();
    this.transition("suspended", reason || "suspended");
  }

  resume(reason = "resumed"): void {
    this.assertActive();
    if (this.mode !== "suspended") return;
    const next = this.temporaryPreviousMode !== "user-detached" && this.autoFollow
      ? "following-bottom"
      : "user-detached";
    this.transition(next, reason);
    if (next === "following-bottom") this.notifyContentMutation("timeline-publish");
  }

  scrollToBottom(_behavior: ScrollBehavior = "smooth"): void {
    this.assertActive();
    const element = this.element;
    if (!element || !this.contentAvailable) return;
    this.cancelScheduledScroll();
    this.userIntent = false;
    this.upwardDetachStartScrollTop = null;
    this.scrollbarDrag = false;
    this.bootstrapCommitted = true;
    this.tailReady = true;
    this.transition("following-bottom", "scroll-to-bottom");
    this.writeScrollTop(bottomScrollTop(element));
    this.emit();
  }

  snapshot(): ConversationFollowSnapshot {
    const bottomGap = this.bottomGap();
    return Object.freeze({
      mode: this.mode,
      reason: this.reason,
      revision: this.revision,
      bottomGap,
      showScrollToBottom: this.bootstrapCommitted && bottomGap > this.buttonThreshold,
      autoFollow: this.autoFollow,
      mutationSequence: this.mutationSequence,
      scrollSequence: this.scrollSequence,
      bootstrapCommitted: this.bootstrapCommitted,
      tailReady: this.tailReady,
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelScheduledScroll();
    this.detachListeners();
    this.element = null;
  }

  private scheduleBootstrapCommit(): void {
    if (this.bootstrapFrame !== null || this.mode !== "bootstrapping-tail") return;
    this.bootstrapFrame = requestAnimationFrame(() => {
      this.bootstrapFrame = null;
      if (
        this.mode !== "bootstrapping-tail"
        || !this.tailReady
        || !this.contentAvailable
        || !this.autoFollow
        || !this.element
      ) return;
      this.writeScrollTop(bottomScrollTop(this.element));
      this.bootstrapCommitted = true;
      this.transition("following-bottom", "tail-bootstrap-committed");
    });
  }

  private scheduleFollow(kind: ConversationContentMutation): void {
    if (this.followFrame !== null) cancelAnimationFrame(this.followFrame);
    this.reason = `content:${kind}`;
    this.followFrame = requestAnimationFrame(() => {
      this.followFrame = null;
      if (this.mode !== "following-bottom" || !this.autoFollow || this.scrollbarDrag) return;
      const element = this.element;
      if (!element || element.hasAttribute(EXPANSION_SCROLL_LOCK_ATTR)) return;
      this.writeScrollTop(bottomScrollTop(element));
      this.emit();
    });
    this.emit();
  }

  private readonly handleWheel = (event: WheelEvent) => {
    const element = this.element;
    if (!element || !wheelWillScrollElement(event as WheelIntentEvent, element)) return;
    this.cancelScheduledScroll();
    this.userIntent = true;
    if (
      isUpwardWheelIntent(event as WheelIntentEvent)
      && (this.mode === "following-bottom" || this.mode === "user-detached")
    ) {
      this.upwardDetachStartScrollTop = element.scrollTop;
      if (this.mode === "following-bottom") this.transition("user-detached", "user-wheel-up");
    } else {
      this.upwardDetachStartScrollTop = null;
    }
  };

  private readonly handlePointerDown = (event: Event) => {
    const element = this.element;
    if (!element || !isScrollbarPointerStart(event, element)) return;
    this.beginScrollbarDrag();
  };

  private readonly finishPointerIntent = () => {
    this.endScrollbarDrag();
  };

  private readonly handleScroll = (event: Event) => {
    const element = this.element;
    if (!element) return;
    this.scrollSequence += 1;
    if (this.mode === "bootstrapping-tail") {
      this.emit();
      return;
    }
    // An upward wheel can be followed by a scroll event which still reports
    // the old bottom because the virtual tail settled its measured height in
    // the same frame. That geometry result must not override the explicit
    // detach intent. Once a later event is observably away from the bottom,
    // ordinary downward scrolling may attach again as before.
    if (this.upwardDetachStartScrollTop !== null) {
      const movedDownPastDetachStart = element.scrollTop > this.upwardDetachStartScrollTop + 0.5;
      if (movedDownPastDetachStart) {
        this.upwardDetachStartScrollTop = null;
      } else {
        if (!this.atBottom()) this.upwardDetachStartScrollTop = null;
        this.emit();
        return;
      }
    }
    if (this.atBottom()) {
      this.userIntent = false;
      if (this.mode === "user-detached" && this.autoFollow) this.transition("following-bottom", "user-returned-bottom");
      else this.emit();
      return;
    }
    if (this.userIntent && this.mode === "following-bottom") this.transition("user-detached", "user-scroll");
    else this.emit();
  };

  private transition(mode: ConversationFollowMode, reason: string): void {
    if (this.mode === mode && this.reason === reason) return;
    this.mode = mode;
    this.reason = reason;
    this.revision += 1;
    this.emit(false);
  }

  private emit(increment = false): void {
    if (increment) this.revision += 1;
    this.onChange?.(this.snapshot());
  }

  private atBottom(): boolean {
    return this.bottomGap() <= this.followThreshold;
  }

  private shouldFollowTail(): boolean {
    return this.mode === "following-bottom" || this.mode === "bootstrapping-tail";
  }

  private writeScrollTop(scrollTop: number): void {
    const element = this.element;
    if (!element) return;
    const target = Math.max(0, scrollTop);
    if (Math.abs(element.scrollTop - target) <= 0.5) return;
    element.scrollTop = target;
  }

  private bottomGap(): number {
    const element = this.element;
    return element ? Math.max(0, bottomScrollTop(element) - element.scrollTop) : 0;
  }

  private cancelScheduledScroll(): void {
    if (this.followFrame !== null) cancelAnimationFrame(this.followFrame);
    if (this.bootstrapFrame !== null) cancelAnimationFrame(this.bootstrapFrame);
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.followFrame = null;
    this.bootstrapFrame = null;
    this.animationFrame = null;
  }

  private detachListeners(): void {
    if (this.element) this.detachElementListeners(this.element);
    window.removeEventListener("pointerup", this.finishPointerIntent);
    window.removeEventListener("pointercancel", this.finishPointerIntent);
    window.removeEventListener("blur", this.finishPointerIntent);
  }

  private attachElementListeners(element: HTMLElement): void {
    element.addEventListener("scroll", this.handleScroll, { passive: true });
    element.addEventListener("wheel", this.handleWheel, { passive: true });
    element.addEventListener("pointerdown", this.handlePointerDown);
  }

  private detachElementListeners(element: HTMLElement): void {
    element.removeEventListener("scroll", this.handleScroll);
    element.removeEventListener("wheel", this.handleWheel);
    element.removeEventListener("pointerdown", this.handlePointerDown);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("ConversationFollowController is destroyed");
  }
}

function isFollowBottomRequest(reason: ConversationTimelineScrollRequest["reason"]): boolean {
  return reason === "follow-bottom" || reason === "follow-bottom-geometry";
}

function bottomScrollTop(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function isScrollbarPointerStart(event: Event, element: HTMLElement): boolean {
  if (event.type !== "pointerdown" && event.type !== "mousedown") return false;
  const pointer = event as MouseEvent;
  const scrollbarSize = Math.max(0, element.offsetWidth - element.clientWidth);
  if (!Number.isFinite(pointer.clientX) || scrollbarSize <= 0) return false;
  const rect = element.getBoundingClientRect();
  const edge = Math.max(12, Math.min(24, scrollbarSize));
  return pointer.clientX >= rect.right - edge && pointer.clientX <= rect.right;
}

function finiteNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Follow threshold must be finite and non-negative");
  return value;
}
