import type { MarkdownSnapshot } from "../document/MarkdownSnapshot";
import type {
  DocumentWorkerAttachment,
} from "../worker/DocumentWorkerHost";
import {
  MARKDOWN_WORKER_PROTOCOL_VERSION,
  type MarkdownFindMatchPayload,
  type MarkdownWorkerResponse,
} from "../worker/protocol";
import type { MarkdownViewRevealTarget } from "../view/types";

export interface MarkdownFindControllerOptions {
  readonly attachment: Pick<DocumentWorkerAttachment, "request">;
  readonly snapshot: MarkdownSnapshot;
  readonly reveal?: (target: MarkdownViewRevealTarget) => void | Promise<void>;
  readonly onChange?: (state: MarkdownFindState, changedBlockIds: ReadonlySet<string>) => void;
}

export interface MarkdownFindState {
  readonly revision: string;
  readonly generation: number;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly matches: readonly MarkdownFindMatchPayload[];
  readonly activeIndex: number | null;
  readonly activeMatchId: string | null;
  readonly pending: boolean;
}

export interface MarkdownBlockFindHighlight {
  readonly matchId: string;
  readonly blockLocalStart: number;
  readonly blockLocalEnd: number;
  readonly active: boolean;
}

export class MarkdownFindSupersededError extends Error {
  constructor(message = "Markdown find superseded") {
    super(message);
    this.name = "AbortError";
  }
}

export class MarkdownFindController {
  private snapshot: MarkdownSnapshot;
  private state: MarkdownFindState;
  private generation = 0;
  private activeRequest: AbortController | null = null;
  private requestSequence = 0;
  private disposed = false;

  constructor(private readonly options: MarkdownFindControllerOptions) {
    this.snapshot = options.snapshot;
    this.state = emptyState(options.snapshot.revision, 0);
  }

  current(): MarkdownFindState {
    return this.state;
  }

  async query(
    query: string,
    options: { readonly caseSensitive?: boolean; readonly wholeWord?: boolean; readonly limit?: number } = {},
  ): Promise<MarkdownFindState> {
    this.assertActive();
    this.activeRequest?.abort(new MarkdownFindSupersededError());
    const generation = ++this.generation;
    const normalized = query.trim();
    const caseSensitive = options.caseSensitive ?? false;
    const wholeWord = options.wholeWord ?? false;
    const limit = options.limit ?? 10_000;
    if (!normalized) {
      this.activeRequest = null;
      this.publish(Object.freeze({
        ...emptyState(this.snapshot.revision, generation),
        caseSensitive,
        wholeWord,
      }));
      return this.state;
    }
    const controller = new AbortController();
    this.activeRequest = controller;
    this.publish(Object.freeze({
      ...this.state,
      revision: this.snapshot.revision,
      generation,
      query: normalized,
      caseSensitive,
      wholeWord,
      activeIndex: null,
      activeMatchId: null,
      pending: true,
    }));
    let response: MarkdownWorkerResponse;
    try {
      response = await this.options.attachment.request({
        protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
        surface: this.snapshot.surface,
        document_id: this.snapshot.document_id,
        revision: this.snapshot.revision,
        request_id: `find-${++this.requestSequence}-${generation}`,
        type: "query-find",
        payload: {
          query: normalized,
          case_sensitive: caseSensitive,
          whole_word: wholeWord,
          limit,
        },
      }, { signal: controller.signal });
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) throw new MarkdownFindSupersededError();
      this.publish(Object.freeze({ ...this.state, pending: false }));
      throw error;
    }
    if (generation !== this.generation || controller.signal.aborted
      || response.revision !== this.snapshot.revision) {
      throw new MarkdownFindSupersededError();
    }
    if (response.type !== "find-result") throw new Error(`Expected find-result, received ${response.type}`);
    const matches = Object.freeze([...response.payload.matches]);
    this.activeRequest = null;
    this.publish(Object.freeze({
      revision: this.snapshot.revision,
      generation,
      query: response.payload.query,
      caseSensitive,
      wholeWord,
      matches,
      activeIndex: matches.length ? 0 : null,
      activeMatchId: matches[0]?.id ?? null,
      pending: false,
    }));
    return this.state;
  }

  async next(): Promise<MarkdownFindMatchPayload | null> {
    return this.move(1);
  }

  async previous(): Promise<MarkdownFindMatchPayload | null> {
    return this.move(-1);
  }

  async activate(index: number): Promise<MarkdownFindMatchPayload | null> {
    this.assertActive();
    if (!this.state.matches.length) return null;
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.state.matches.length) {
      throw new RangeError(`Markdown find index ${index} is out of range`);
    }
    const match = this.state.matches[index]!;
    this.publish(Object.freeze({ ...this.state, activeIndex: index, activeMatchId: match.id }));
    await this.options.reveal?.({ kind: "source-offset", sourceOffset: match.source_start });
    return match;
  }

  highlightsForBlock(blockId: string): readonly MarkdownBlockFindHighlight[] {
    return Object.freeze(this.state.matches
      .filter((match) => match.block_id === blockId)
      .map((match) => Object.freeze({
        matchId: match.id,
        blockLocalStart: match.block_local_start,
        blockLocalEnd: match.block_local_end,
        active: match.id === this.state.activeMatchId,
      })));
  }

  updateSnapshot(snapshot: MarkdownSnapshot): void {
    this.assertActive();
    if (snapshot.document_id !== this.snapshot.document_id || snapshot.surface !== this.snapshot.surface) {
      throw new Error("Markdown FindController cannot switch documents");
    }
    this.activeRequest?.abort(new MarkdownFindSupersededError("Markdown revision changed"));
    this.activeRequest = null;
    this.generation += 1;
    this.snapshot = snapshot;
    this.publish(emptyState(snapshot.revision, this.generation));
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeRequest?.abort(new MarkdownFindSupersededError("Markdown FindController destroyed"));
    this.activeRequest = null;
  }

  private async move(delta: -1 | 1): Promise<MarkdownFindMatchPayload | null> {
    this.assertActive();
    const count = this.state.matches.length;
    if (!count) return null;
    const current = this.state.activeIndex ?? (delta > 0 ? -1 : 0);
    return this.activate((current + delta + count) % count);
  }

  private publish(next: MarkdownFindState): void {
    const previousSignatures = blockSignatures(this.state.matches);
    const nextSignatures = blockSignatures(next.matches);
    const changed = new Set<string>();
    for (const blockId of new Set([...previousSignatures.keys(), ...nextSignatures.keys()])) {
      if (previousSignatures.get(blockId) !== nextSignatures.get(blockId)) changed.add(blockId);
    }
    if (this.state.activeMatchId !== next.activeMatchId) {
      const previousActive = this.state.matches.find((match) => match.id === this.state.activeMatchId);
      const nextActive = next.matches.find((match) => match.id === next.activeMatchId);
      if (previousActive) changed.add(previousActive.block_id);
      if (nextActive) changed.add(nextActive.block_id);
    }
    this.state = next;
    this.options.onChange?.(next, changed);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Markdown FindController is destroyed");
  }
}

function blockSignatures(matches: readonly MarkdownFindMatchPayload[]): Map<string, string> {
  const grouped = new Map<string, string[]>();
  for (const match of matches) {
    const values = grouped.get(match.block_id) ?? [];
    values.push(`${match.id}:${match.block_local_start}:${match.block_local_end}`);
    grouped.set(match.block_id, values);
  }
  return new Map([...grouped].map(([blockId, values]) => [blockId, values.join("|")]));
}

function emptyState(revision: string, generation: number): MarkdownFindState {
  return Object.freeze({
    revision,
    generation,
    query: "",
    caseSensitive: false,
    wholeWord: false,
    matches: Object.freeze([]),
    activeIndex: null,
    activeMatchId: null,
    pending: false,
  });
}
