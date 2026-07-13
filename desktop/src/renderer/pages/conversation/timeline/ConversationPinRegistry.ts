import type { ConversationRenderUnit } from "./ConversationRenderUnit";

export type ConversationPinReason =
  | "selection"
  | "focus"
  | "dirty-input"
  | "expanded"
  | "active"
  | "interactive";

export interface ConversationPinTarget {
  setPinned(unitId: string, pinned: boolean): void;
}

export interface ConversationPinDiagnostics {
  readonly pinned: number;
  readonly maxPins: number;
  readonly rejected: number;
  readonly evicted: number;
  readonly pinsByReason: Readonly<Record<ConversationPinReason, number>>;
  readonly unitIds: readonly string[];
}

interface PinEntry {
  readonly unitId: string;
  readonly reasons: Set<ConversationPinReason>;
  touchedAt: number;
}

const PROTECTED_REASONS = new Set<ConversationPinReason>(["selection", "focus", "dirty-input", "expanded"]);

/** Keeps native interactive DOM alive without cloning or hiding a second tree. */
export class ConversationPinRegistry {
  private root: HTMLElement | null = null;
  private target: ConversationPinTarget | null = null;
  private units = new Map<string, ConversationRenderUnit>();
  private readonly entries = new Map<string, PinEntry>();
  private readonly maxPins: number;
  private sequence = 0;
  private rejected = 0;
  private evicted = 0;
  private mutationObserver: MutationObserver | null = null;
  private disposed = false;

  constructor(options: { maxPins?: number } = {}) {
    this.maxPins = positiveInteger(options.maxPins ?? 32);
  }

  attach(root: HTMLElement | null, target: ConversationPinTarget | null): void {
    this.assertActive();
    if (this.root === root && this.target === target) return;
    this.detachListeners();
    this.root = root;
    this.target = target;
    if (!root || !target) return;
    root.addEventListener("focusin", this.handleFocusChange);
    root.addEventListener("focusout", this.handleFocusChange);
    root.addEventListener("input", this.handleDirtyInput);
    root.addEventListener("change", this.handleDirtyInput);
    root.addEventListener("submit", this.handleInteractionComplete);
    root.addEventListener("reset", this.handleInteractionComplete);
    root.ownerDocument.addEventListener("selectionchange", this.handleSelectionChange);
    this.mutationObserver = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => this.syncExpanded());
    this.mutationObserver?.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-expanded", "data-status", "disabled"],
    });
    this.resyncNativeState();
  }

  sync(units: readonly ConversationRenderUnit[]): void {
    this.assertActive();
    this.units = new Map(units.map((unit) => [unit.id, unit]));
    for (const unitId of [...this.entries.keys()]) {
      if (!this.units.has(unitId)) this.releaseAll(unitId);
    }
    this.syncMounted();
  }

  syncMounted(): void {
    this.assertActive();
    const mountedIds = new Set(
      [...(this.root?.querySelectorAll<HTMLElement>("[data-conversation-unit-id]") ?? [])]
        .map((element) => element.dataset.conversationUnitId)
        .filter((value): value is string => Boolean(value)),
    );
    for (const unitId of mountedIds) {
      const unit = this.units.get(unitId);
      if (!unit) continue;
      this.setReason(unit.id, "active", unit.dynamic && unit.pinPolicy === "while-active");
      this.setReason(unit.id, "interactive", unit.interactive && unit.pinPolicy === "while-interacting");
    }
    for (const [unitId] of this.entries) {
      const unit = this.units.get(unitId);
      if (!unit || !unit.dynamic) this.setReason(unitId, "active", false);
      if (!unit || !unit.interactive) this.setReason(unitId, "interactive", false);
    }
    this.resyncNativeState();
  }

  pin(unitId: string, reason: ConversationPinReason): boolean {
    this.assertActive();
    if (!this.units.has(unitId)) return false;
    const existing = this.entries.get(unitId);
    if (existing) {
      existing.reasons.add(reason);
      existing.touchedAt = ++this.sequence;
      return true;
    }
    if (this.entries.size >= this.maxPins && !this.evictAutomaticPin()) {
      this.rejected += 1;
      return false;
    }
    const entry: PinEntry = { unitId, reasons: new Set([reason]), touchedAt: ++this.sequence };
    this.entries.set(unitId, entry);
    this.target?.setPinned(unitId, true);
    return true;
  }

  unpin(unitId: string, reason: ConversationPinReason): void {
    this.assertActive();
    const entry = this.entries.get(unitId);
    if (!entry) return;
    entry.reasons.delete(reason);
    if (entry.reasons.size) return;
    this.entries.delete(unitId);
    this.target?.setPinned(unitId, false);
  }

  diagnostics(): ConversationPinDiagnostics {
    const pinsByReason = {
      selection: 0,
      focus: 0,
      "dirty-input": 0,
      expanded: 0,
      active: 0,
      interactive: 0,
    } satisfies Record<ConversationPinReason, number>;
    for (const entry of this.entries.values()) {
      for (const reason of entry.reasons) pinsByReason[reason] += 1;
    }
    return Object.freeze({
      pinned: this.entries.size,
      maxPins: this.maxPins,
      rejected: this.rejected,
      evicted: this.evicted,
      pinsByReason: Object.freeze(pinsByReason),
      unitIds: Object.freeze([...this.entries.keys()]),
    });
  }

  destroy(): void {
    if (this.disposed) return;
    for (const unitId of [...this.entries.keys()]) this.releaseAll(unitId);
    this.detachListeners();
    this.root = null;
    this.target = null;
    this.units.clear();
    this.disposed = true;
  }

  private readonly handleFocusChange = () => queueMicrotask(() => {
    if (!this.disposed) this.syncFocus();
  });

  private readonly handleSelectionChange = () => this.syncSelection();

  private readonly handleDirtyInput = (event: Event) => {
    const unitId = this.unitIdFromNode(event.target as Node | null);
    if (unitId) this.pin(unitId, "dirty-input");
  };

  private readonly handleInteractionComplete = (event: Event) => {
    const unitId = this.unitIdFromNode(event.target as Node | null);
    if (unitId) this.unpin(unitId, "dirty-input");
  };

  private resyncNativeState(): void {
    this.syncFocus();
    this.syncSelection();
    this.syncExpanded();
  }

  private syncFocus(): void {
    const focusedId = this.unitIdFromNode(this.root?.ownerDocument.activeElement ?? null);
    for (const [unitId] of this.entries) this.setReason(unitId, "focus", unitId === focusedId);
    if (focusedId) this.pin(focusedId, "focus");
  }

  private syncSelection(): void {
    const selected = new Set<string>();
    const selection = this.root?.ownerDocument.getSelection?.();
    if (selection?.rangeCount && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      const start = this.unitIdFromNode(range.startContainer);
      const end = this.unitIdFromNode(range.endContainer);
      if (start) selected.add(start);
      if (end) selected.add(end);
    }
    for (const [unitId] of this.entries) this.setReason(unitId, "selection", selected.has(unitId));
    for (const unitId of selected) this.pin(unitId, "selection");
  }

  private syncExpanded(): void {
    const expanded = new Set<string>();
    for (const element of this.root?.querySelectorAll<HTMLElement>('[aria-expanded="true"]') ?? []) {
      const unitId = this.unitIdFromNode(element);
      if (unitId) expanded.add(unitId);
    }
    for (const [unitId] of this.entries) this.setReason(unitId, "expanded", expanded.has(unitId));
    for (const unitId of expanded) this.pin(unitId, "expanded");
  }

  private setReason(unitId: string, reason: ConversationPinReason, enabled: boolean): void {
    if (enabled) this.pin(unitId, reason);
    else this.unpin(unitId, reason);
  }

  private releaseAll(unitId: string): void {
    if (!this.entries.delete(unitId)) return;
    this.target?.setPinned(unitId, false);
  }

  private evictAutomaticPin(): boolean {
    const candidates = [...this.entries.values()]
      .filter((entry) => [...entry.reasons].every((reason) => !PROTECTED_REASONS.has(reason)))
      .sort((left, right) => left.touchedAt - right.touchedAt);
    const candidate = candidates[0];
    if (!candidate) return false;
    this.releaseAll(candidate.unitId);
    this.evicted += 1;
    return true;
  }

  private unitIdFromNode(node: Node | null): string | null {
    const element = node instanceof Element ? node : node?.parentElement;
    if (!element || !this.root?.contains(element)) return null;
    return element.closest<HTMLElement>("[data-conversation-unit-id]")?.dataset.conversationUnitId ?? null;
  }

  private detachListeners(): void {
    const root = this.root;
    if (root) {
      root.removeEventListener("focusin", this.handleFocusChange);
      root.removeEventListener("focusout", this.handleFocusChange);
      root.removeEventListener("input", this.handleDirtyInput);
      root.removeEventListener("change", this.handleDirtyInput);
      root.removeEventListener("submit", this.handleInteractionComplete);
      root.removeEventListener("reset", this.handleInteractionComplete);
      root.ownerDocument.removeEventListener("selectionchange", this.handleSelectionChange);
    }
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("ConversationPinRegistry is destroyed");
  }
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("maxPins must be a positive integer");
  return value;
}
