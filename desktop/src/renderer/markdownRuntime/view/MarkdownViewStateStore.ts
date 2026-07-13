import {
  MARKDOWN_VIEW_STATE_SCHEMA_VERSION,
  type MarkdownViewDescriptor,
  type MarkdownViewFindState,
  type MarkdownViewFocusState,
  type MarkdownViewPendingReveal,
  type MarkdownViewRevealTarget,
  type MarkdownViewRevisionContext,
  type MarkdownViewScrollAnchor,
  type MarkdownViewSelection,
  type MarkdownViewState,
} from "./types";

export type MarkdownViewStateSubscriber = (state: MarkdownViewState) => void;

export interface MarkdownViewRevealHandle {
  readonly id: number;
  readonly signal: AbortSignal;
  readonly promise: Promise<void>;
}

export interface MarkdownViewStateAttachment {
  readonly descriptor: MarkdownViewDescriptor;
  snapshot(): MarkdownViewState;
  subscribe(subscriber: MarkdownViewStateSubscriber): () => void;
  setScrollAnchor(anchor: MarkdownViewScrollAnchor | null): void;
  setSelection(selection: MarkdownViewSelection | null): void;
  setFind(find: Partial<MarkdownViewFindState>): void;
  setFolded(blockId: string, folded: boolean): void;
  replaceFolds(blockIds: readonly string[]): void;
  setFocus(focus: MarkdownViewFocusState): void;
  requestReveal(
    target: MarkdownViewRevealTarget,
    options?: { behavior?: "auto" | "instant" | "smooth" },
  ): MarkdownViewRevealHandle;
  completeReveal(id: number): boolean;
  failReveal(id: number, error: unknown): boolean;
  cancelReveal(id: number, reason?: string): boolean;
  reconcileRevision(revision: string, context: MarkdownViewRevisionContext): void;
  detach(): void;
  dispose(): void;
}

export interface MarkdownViewStateStoreOptions {
  readonly maxRetainedViews?: number;
  readonly now?: () => number;
}

interface RevealDeferred {
  readonly id: number;
  readonly controller: AbortController;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface StoredViewState {
  readonly key: string;
  readonly entryKey: string;
  readonly descriptor: MarkdownViewDescriptor;
  readonly subscribers: Set<MarkdownViewStateSubscriber>;
  value: MarkdownViewState;
  reveal: RevealDeferred | null;
  attached: boolean;
  disposed: boolean;
  lastAccess: number;
}

export class MarkdownViewRevealError extends Error {
  constructor(
    readonly code: "superseded" | "detached" | "disposed" | "revision-changed" | "cancelled" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "AbortError";
  }
}

export class MarkdownViewStateStore {
  private readonly states = new Map<string, StoredViewState>();
  private readonly maxRetainedViews: number;
  private readonly now: () => number;
  private revealSequence = 0;

  constructor(options: MarkdownViewStateStoreOptions = {}) {
    this.maxRetainedViews = positiveInteger(options.maxRetainedViews ?? 128, "maxRetainedViews");
    this.now = options.now ?? Date.now;
  }

  attach(descriptorInput: MarkdownViewDescriptor): MarkdownViewStateAttachment {
    const descriptor = normalizeDescriptor(descriptorInput);
    const key = viewKey(descriptor);
    const state = this.states.get(key) ?? this.createState(descriptor, key);
    if (state.disposed) throw new Error(`Markdown view ${key} is disposed`);
    if (state.attached) throw new Error(`Markdown view ${key} is already attached`);
    state.attached = true;
    state.lastAccess = this.now();
    this.trim();
    let active = true;
    const assertActive = () => {
      if (!active || state.disposed) throw new Error(`Markdown view ${key} is not active`);
    };
    return Object.freeze({
      descriptor,
      snapshot: () => {
        assertActive();
        return state.value;
      },
      subscribe: (subscriber: MarkdownViewStateSubscriber) => {
        assertActive();
        state.subscribers.add(subscriber);
        return () => state.subscribers.delete(subscriber);
      },
      setScrollAnchor: (anchor: MarkdownViewScrollAnchor | null) => {
        assertActive();
        this.commit(state, { scrollAnchor: validateScrollAnchor(anchor) });
      },
      setSelection: (selection: MarkdownViewSelection | null) => {
        assertActive();
        this.commit(state, { selection: validateSelection(selection) });
      },
      setFind: (find: Partial<MarkdownViewFindState>) => {
        assertActive();
        this.commit(state, { find: validateFind({ ...state.value.find, ...find }) });
      },
      setFolded: (blockId: string, folded: boolean) => {
        assertActive();
        required(blockId, "blockId");
        const next = new Set(state.value.foldedBlockIds);
        if (folded) next.add(blockId);
        else next.delete(blockId);
        this.commit(state, { foldedBlockIds: Object.freeze([...next]) });
      },
      replaceFolds: (blockIds: readonly string[]) => {
        assertActive();
        blockIds.forEach((blockId) => required(blockId, "blockId"));
        this.commit(state, { foldedBlockIds: Object.freeze([...new Set(blockIds)]) });
      },
      setFocus: (focus: MarkdownViewFocusState) => {
        assertActive();
        this.commit(state, { focus: validateFocus(focus) });
      },
      requestReveal: (
        target: MarkdownViewRevealTarget,
        options?: { behavior?: "auto" | "instant" | "smooth" },
      ) => {
        assertActive();
        return this.requestReveal(state, validateRevealTarget(target), options?.behavior ?? "auto");
      },
      completeReveal: (id: number) => {
        assertActive();
        return this.settleReveal(state, id, null);
      },
      failReveal: (id: number, error: unknown) => {
        assertActive();
        return this.settleReveal(state, id, revealError("failed", error));
      },
      cancelReveal: (id: number, reason?: string) => {
        assertActive();
        return this.settleReveal(state, id, new MarkdownViewRevealError("cancelled", reason ?? "Reveal cancelled"));
      },
      reconcileRevision: (revision: string, context: MarkdownViewRevisionContext) => {
        assertActive();
        this.reconcileRevision(state, revision, context);
      },
      detach: () => {
        if (!active) return;
        active = false;
        this.detachState(state, false);
      },
      dispose: () => {
        if (!active && state.disposed) return;
        active = false;
        this.detachState(state, true);
      },
    });
  }

  evictEntry(scopeId: string, entryId: string): number {
    const key = entryKey(required(scopeId, "scopeId"), required(entryId, "entryId"));
    const candidates = [...this.states.values()].filter((state) => state.entryKey === key);
    for (const state of candidates) this.disposeState(state, "Entry evicted");
    return candidates.length;
  }

  diagnostics(): {
    readonly retainedViews: number;
    readonly attachedViews: number;
    readonly pendingReveals: number;
    readonly entries: number;
  } {
    const states = [...this.states.values()];
    return Object.freeze({
      retainedViews: states.length,
      attachedViews: states.filter((state) => state.attached).length,
      pendingReveals: states.filter((state) => state.reveal).length,
      entries: new Set(states.map((state) => state.entryKey)).size,
    });
  }

  clear(): void {
    for (const state of [...this.states.values()]) this.disposeState(state, "View store cleared");
  }

  private createState(descriptor: MarkdownViewDescriptor, key: string): StoredViewState {
    const now = this.now();
    const state: StoredViewState = {
      key,
      entryKey: entryKey(descriptor.scopeId, descriptor.entryId),
      descriptor,
      subscribers: new Set(),
      value: initialState(descriptor, key, now),
      reveal: null,
      attached: false,
      disposed: false,
      lastAccess: now,
    };
    this.states.set(key, state);
    return state;
  }

  private requestReveal(
    state: StoredViewState,
    target: MarkdownViewRevealTarget,
    behavior: "auto" | "instant" | "smooth",
  ): MarkdownViewRevealHandle {
    if (state.reveal) {
      this.settleReveal(
        state,
        state.reveal.id,
        new MarkdownViewRevealError("superseded", "Reveal superseded by a newer request"),
      );
    }
    const id = ++this.revealSequence;
    const controller = new AbortController();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    void promise.catch(() => undefined);
    state.reveal = { id, controller, resolve, reject };
    const pendingReveal: MarkdownViewPendingReveal = Object.freeze({
      id,
      target,
      behavior,
      requestedRevision: state.value.revision,
      requestedAt: this.now(),
    });
    this.commit(state, { pendingReveal });
    return Object.freeze({ id, signal: controller.signal, promise });
  }

  private settleReveal(state: StoredViewState, id: number, error: unknown): boolean {
    const deferred = state.reveal;
    if (!deferred || deferred.id !== id) return false;
    state.reveal = null;
    if (error) {
      deferred.controller.abort(error);
      deferred.reject(error);
    } else {
      deferred.resolve();
    }
    this.commit(state, { pendingReveal: null });
    return true;
  }

  private reconcileRevision(
    state: StoredViewState,
    revision: string,
    context: MarkdownViewRevisionContext,
  ): void {
    required(revision, "revision");
    nonNegativeInteger(context.sourceCharacters, "sourceCharacters");
    const revisionChanged = state.value.revision !== null && state.value.revision !== revision;
    if (revisionChanged && state.reveal) {
      this.settleReveal(
        state,
        state.reveal.id,
        new MarkdownViewRevealError("revision-changed", "Reveal revision changed before completion"),
      );
    }
    const scrollAnchor = state.value.scrollAnchor
      ? Object.freeze({
          ...state.value.scrollAnchor,
          blockId: state.value.scrollAnchor.blockId && context.blockIds.has(state.value.scrollAnchor.blockId)
            ? state.value.scrollAnchor.blockId
            : null,
          sourceOffset: Math.min(state.value.scrollAnchor.sourceOffset, context.sourceCharacters),
        })
      : null;
    const selection = state.value.selection
      ? Object.freeze({
          ...state.value.selection,
          sourceStart: Math.min(state.value.selection.sourceStart, context.sourceCharacters),
          sourceEnd: Math.min(state.value.selection.sourceEnd, context.sourceCharacters),
        })
      : null;
    const find = revisionChanged
      ? Object.freeze({
          ...state.value.find,
          activeMatchId: null,
          activeMatchIndex: null,
          matchCount: 0,
        })
      : state.value.find;
    this.commit(state, {
      revision,
      scrollAnchor,
      selection,
      find,
      foldedBlockIds: Object.freeze(state.value.foldedBlockIds.filter((id) => context.blockIds.has(id))),
    });
  }

  private detachState(state: StoredViewState, dispose: boolean): void {
    state.attached = false;
    state.subscribers.clear();
    state.lastAccess = this.now();
    if (state.reveal) {
      this.settleReveal(
        state,
        state.reveal.id,
        new MarkdownViewRevealError(dispose ? "disposed" : "detached", "Reveal owner detached"),
      );
    }
    if (dispose) this.disposeState(state, "View disposed");
    else this.trim();
  }

  private disposeState(state: StoredViewState, reason: string): void {
    if (state.disposed) return;
    if (state.reveal) {
      this.settleReveal(state, state.reveal.id, new MarkdownViewRevealError("disposed", reason));
    }
    state.disposed = true;
    state.attached = false;
    state.subscribers.clear();
    this.states.delete(state.key);
  }

  private trim(): void {
    while (this.states.size > this.maxRetainedViews) {
      const candidate = [...this.states.values()]
        .filter((state) => !state.attached)
        .sort((left, right) => left.lastAccess - right.lastAccess)[0];
      if (!candidate) return;
      this.disposeState(candidate, "View state LRU evicted");
    }
  }

  private commit(state: StoredViewState, patch: Partial<MarkdownViewState>): void {
    if (state.disposed) return;
    state.lastAccess = this.now();
    state.value = Object.freeze({
      ...state.value,
      ...patch,
      version: state.value.version + 1,
      updatedAt: state.lastAccess,
    });
    for (const subscriber of state.subscribers) {
      try {
        subscriber(state.value);
      } catch {
        // View observers cannot corrupt state transitions.
      }
    }
  }
}

function initialState(descriptor: MarkdownViewDescriptor, key: string, now: number): MarkdownViewState {
  return Object.freeze({
    schemaVersion: MARKDOWN_VIEW_STATE_SCHEMA_VERSION,
    key,
    scopeId: descriptor.scopeId,
    entryId: descriptor.entryId,
    viewId: descriptor.viewId,
    kind: descriptor.kind,
    revision: null,
    scrollAnchor: null,
    selection: null,
    find: Object.freeze({
      open: false,
      query: "",
      caseSensitive: false,
      wholeWord: false,
      activeMatchId: null,
      activeMatchIndex: null,
      matchCount: 0,
    }),
    foldedBlockIds: Object.freeze([]),
    focus: Object.freeze({ target: "none", keyboardVisible: false }),
    pendingReveal: null,
    version: 0,
    updatedAt: now,
  });
}

function normalizeDescriptor(value: MarkdownViewDescriptor): MarkdownViewDescriptor {
  if (!VIEW_KINDS.has(value.kind)) throw new Error("Markdown view kind is invalid");
  return Object.freeze({
    scopeId: required(value.scopeId, "scopeId"),
    entryId: required(value.entryId, "entryId"),
    viewId: required(value.viewId, "viewId"),
    kind: value.kind,
  });
}

function validateScrollAnchor(value: MarkdownViewScrollAnchor | null): MarkdownViewScrollAnchor | null {
  if (!value) return null;
  if (value.blockId !== null) required(value.blockId, "scroll blockId");
  nonNegativeInteger(value.sourceOffset, "scroll sourceOffset");
  if (!Number.isFinite(value.offsetPx)) throw new Error("scroll offsetPx must be finite");
  if (!(["start", "center", "end", "nearest"] as const).includes(value.alignment)) {
    throw new Error("scroll alignment is invalid");
  }
  return Object.freeze({ ...value });
}

function validateSelection(value: MarkdownViewSelection | null): MarkdownViewSelection | null {
  if (!value) return null;
  nonNegativeInteger(value.sourceStart, "selection sourceStart");
  nonNegativeInteger(value.sourceEnd, "selection sourceEnd");
  if (value.sourceEnd < value.sourceStart) throw new Error("selection range is reversed");
  if (!(["forward", "backward", "none"] as const).includes(value.direction)) {
    throw new Error("selection direction is invalid");
  }
  return Object.freeze({ ...value });
}

function validateFind(value: MarkdownViewFindState): MarkdownViewFindState {
  if (typeof value.query !== "string"
    || typeof value.open !== "boolean"
    || typeof value.caseSensitive !== "boolean"
    || typeof value.wholeWord !== "boolean") {
    throw new Error("find state is invalid");
  }
  if (!Number.isSafeInteger(value.matchCount) || value.matchCount < 0) throw new Error("find matchCount is invalid");
  if (value.activeMatchIndex !== null
    && (!Number.isSafeInteger(value.activeMatchIndex) || value.activeMatchIndex < 0)) {
    throw new Error("find activeMatchIndex is invalid");
  }
  return Object.freeze({ ...value });
}

function validateFocus(value: MarkdownViewFocusState): MarkdownViewFocusState {
  if (!(["none", "content", "source", "find", "annotation"] as const).includes(value.target)) {
    throw new Error("focus target is invalid");
  }
  if (typeof value.keyboardVisible !== "boolean") throw new Error("focus keyboardVisible is invalid");
  return Object.freeze({ ...value });
}

function validateRevealTarget(value: MarkdownViewRevealTarget): MarkdownViewRevealTarget {
  switch (value.kind) {
    case "block":
      required(value.blockId, "blockId");
      break;
    case "source-offset":
      nonNegativeInteger(value.sourceOffset, "sourceOffset");
      break;
    case "source-line":
      if (!Number.isSafeInteger(value.line) || value.line < 1) throw new Error("line must be a positive integer");
      if (value.column !== undefined) nonNegativeInteger(value.column, "column");
      break;
    case "annotation":
      required(value.annotationId, "annotationId");
      break;
    case "find":
      required(value.matchId, "matchId");
      break;
    case "turn":
      required(value.turnId, "turnId");
      break;
    case "capsule":
      required(value.capsuleId, "capsuleId");
      if (value.sourceOffset !== undefined) nonNegativeInteger(value.sourceOffset, "sourceOffset");
      break;
    default:
      throw new Error("Reveal target is invalid");
  }
  return Object.freeze({ ...value });
}

function revealError(code: "failed", error: unknown): MarkdownViewRevealError {
  return new MarkdownViewRevealError(code, error instanceof Error ? error.message : String(error));
}

function viewKey(descriptor: MarkdownViewDescriptor): string {
  return `${descriptor.scopeId}\u0000${descriptor.entryId}\u0000${descriptor.viewId}\u0000${descriptor.kind}`;
}

function entryKey(scopeId: string, entryId: string): string {
  return `${scopeId}\u0000${entryId}`;
}

function required(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required`);
  return value;
}

function nonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const VIEW_KINDS = new Set([
  "preview", "source", "split-preview", "split-source", "sidebar", "workbench", "conversation",
]);
