import type { ConversationTimelineAnchor } from "./ConversationTimelineRuntime";

export interface ConversationNavigationTarget {
  revealUnit(unitId: string, align?: "start" | "center" | "end"): boolean;
  captureAnchor(viewportOffset?: number): ConversationTimelineAnchor | null;
  restoreAnchor(anchor: ConversationTimelineAnchor): boolean;
}

export interface ConversationTurnNavigationIntent {
  readonly requestId: string | number;
  readonly unitId: string;
  readonly align?: "start" | "center" | "end";
  readonly flash?: boolean;
  readonly source?: "turn-navigator" | "capsule" | "external";
  readonly onRevealed?: (intent: ConversationTurnNavigationIntent) => void;
}

export interface ConversationNavigationDiagnostics {
  readonly sequence: number;
  readonly userGeneration: number;
  readonly pendingNavigationId: string | number | null;
  readonly completedNavigationId: string | number | null;
  readonly activeNavigationAnchorId: string | null;
  readonly prependState: "idle" | "captured" | "restored" | "cancelled" | "missing";
  readonly revealAttempts: number;
  readonly revealSuccesses: number;
  readonly anchorRestores: number;
  readonly navigationStabilizations: number;
}

interface PendingPrepend {
  readonly sequence: number;
  readonly userGeneration: number;
  readonly anchor: ConversationTimelineAnchor;
}

/** Coordinates explicit navigation and history restoration by stable identity. */
export class ConversationNavigationController {
  private target: ConversationNavigationTarget | null = null;
  private pendingNavigation: ConversationTurnNavigationIntent | null = null;
  private pendingPrepend: PendingPrepend | null = null;
  private activeNavigationAnchor: ConversationTimelineAnchor | null = null;
  private navigationStabilizationsRemaining = 0;
  private revealInProgress = false;
  private sequence = 0;
  private userGeneration = 0;
  private completedNavigationId: string | number | null = null;
  private prependState: ConversationNavigationDiagnostics["prependState"] = "idle";
  private revealAttempts = 0;
  private revealSuccesses = 0;
  private anchorRestores = 0;
  private navigationStabilizations = 0;
  private disposed = false;

  attach(target: ConversationNavigationTarget | null): void {
    this.assertActive();
    this.target = target;
    if (target) this.onTimelinePublished();
  }

  beginPrepend(viewportOffset = 0): boolean {
    this.assertActive();
    const anchor = this.target?.captureAnchor(viewportOffset) ?? null;
    if (!anchor) {
      this.pendingPrepend = null;
      this.prependState = "missing";
      return false;
    }
    this.pendingPrepend = {
      sequence: ++this.sequence,
      userGeneration: this.userGeneration,
      anchor,
    };
    this.prependState = "captured";
    return true;
  }

  completePrepend(): boolean {
    this.assertActive();
    const prepend = this.pendingPrepend;
    if (!prepend) return false;
    if (prepend.userGeneration !== this.userGeneration) {
      this.pendingPrepend = null;
      this.prependState = "cancelled";
      return false;
    }
    if (this.pendingNavigation) return false;
    const restored = this.target?.restoreAnchor(prepend.anchor) ?? false;
    if (!restored) return false;
    this.pendingPrepend = null;
    this.prependState = "restored";
    this.anchorRestores += 1;
    return true;
  }

  requestNavigation(intent: ConversationTurnNavigationIntent): boolean {
    this.assertActive();
    if (this.completedNavigationId === intent.requestId && !this.pendingNavigation) {
      intent.onRevealed?.(intent);
      return true;
    }
    // A new request owns the viewport immediately. Publications left over from
    // the previous target must not restore its anchor during the next reveal.
    this.activeNavigationAnchor = null;
    this.navigationStabilizationsRemaining = 0;
    this.pendingNavigation = Object.freeze({ ...intent });
    this.sequence += 1;
    return this.tryRevealPending();
  }

  onTimelinePublished(): void {
    this.assertActive();
    // revealUnit can synchronously mount React roots and publish measurements.
    // Never re-enter the same pending reveal from that publication.
    if (this.revealInProgress) return;
    if (this.pendingNavigation && this.tryRevealPending()) return;
    if (this.completePrepend()) return;
  }

  recordUserScroll(): void {
    this.assertActive();
    this.userGeneration += 1;
    if (this.pendingPrepend) {
      this.pendingPrepend = null;
      this.prependState = "cancelled";
    }
    this.pendingNavigation = null;
    this.activeNavigationAnchor = null;
    this.navigationStabilizationsRemaining = 0;
  }

  cancelNavigation(requestId?: string | number): boolean {
    this.assertActive();
    if (!this.pendingNavigation) return false;
    if (requestId !== undefined && this.pendingNavigation.requestId !== requestId) return false;
    this.pendingNavigation = null;
    return true;
  }

  diagnostics(): ConversationNavigationDiagnostics {
    return Object.freeze({
      sequence: this.sequence,
      userGeneration: this.userGeneration,
      pendingNavigationId: this.pendingNavigation?.requestId ?? null,
      completedNavigationId: this.completedNavigationId,
      activeNavigationAnchorId: this.activeNavigationAnchor?.unitId ?? null,
      prependState: this.prependState,
      revealAttempts: this.revealAttempts,
      revealSuccesses: this.revealSuccesses,
      anchorRestores: this.anchorRestores,
      navigationStabilizations: this.navigationStabilizations,
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.target = null;
    this.pendingNavigation = null;
    this.pendingPrepend = null;
    this.activeNavigationAnchor = null;
    this.navigationStabilizationsRemaining = 0;
    this.revealInProgress = false;
  }

  private tryRevealPending(): boolean {
    if (this.revealInProgress) return false;
    const intent = this.pendingNavigation;
    const target = this.target;
    if (!intent || !target) return false;
    const revealSequence = this.sequence;
    // Claim the intent before invoking external code. Leaving it pending here
    // allows a synchronous publication to recursively reveal it forever.
    this.pendingNavigation = null;
    this.revealInProgress = true;
    this.revealAttempts += 1;
    let revealed = false;
    try {
      revealed = target.revealUnit(intent.unitId, intent.align ?? "center");
    } finally {
      this.revealInProgress = false;
    }
    if (!revealed) {
      if (this.sequence === revealSequence && !this.pendingNavigation) this.pendingNavigation = intent;
      return false;
    }
    // A newer request may have been queued synchronously by the reveal target.
    // Only the latest request may capture an anchor or run completion effects.
    if (this.sequence !== revealSequence) return this.tryRevealPending();
    this.completedNavigationId = intent.requestId;
    // revealUnit already patches and writes the exact indexed destination.
    // Capturing it again and restoring on later ResizeObserver publications
    // produces a second visible scroll after the target's first frame.
    this.activeNavigationAnchor = null;
    this.navigationStabilizationsRemaining = 0;
    this.revealSuccesses += 1;
    intent.onRevealed?.(intent);
    return true;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("ConversationNavigationController is destroyed");
  }
}
