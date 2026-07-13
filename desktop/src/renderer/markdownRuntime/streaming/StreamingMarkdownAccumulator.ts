export const STREAMING_MARKDOWN_ACCUMULATOR_SCHEMA_VERSION = "streaming-markdown-accumulator/v1";

export type StreamingMarkdownLifecycle = "streaming" | "completed" | "cancelled";
export type StreamingMarkdownMutation =
  | "hydrate"
  | "append"
  | "replace"
  | "prefix-commit"
  | "display"
  | "complete"
  | "cancel";

export interface StreamingMarkdownAccumulatorSnapshot {
  readonly schemaVersion: typeof STREAMING_MARKDOWN_ACCUMULATOR_SCHEMA_VERSION;
  readonly epoch: number;
  readonly version: number;
  readonly lifecycle: StreamingMarkdownLifecycle;
  readonly mutation: StreamingMarkdownMutation;
  readonly raw: string;
  readonly committedPrefixLength: number;
  readonly mutableTailStart: number;
  readonly displayCursor: number;
  readonly displayBacklog: number;
  readonly canonicalRequired: boolean;
}

export interface StreamingMarkdownAccumulatorOptions {
  readonly content?: string;
  readonly lifecycle?: StreamingMarkdownLifecycle;
  readonly committedPrefixLength?: number;
  readonly displayCursor?: number;
  readonly epoch?: number;
}

export class StreamingMarkdownAccumulator {
  private value: StreamingMarkdownAccumulatorSnapshot;

  constructor(options: StreamingMarkdownAccumulatorOptions = {}) {
    const raw = options.content ?? "";
    const lifecycle = options.lifecycle ?? "streaming";
    const committedPrefixLength = boundedOffset(
      options.committedPrefixLength ?? 0,
      raw.length,
      "committedPrefixLength",
    );
    const displayCursor = boundedOffset(
      options.displayCursor ?? (lifecycle === "streaming" ? 0 : raw.length),
      raw.length,
      "displayCursor",
    );
    const epoch = positiveInteger(options.epoch ?? 1, "epoch");
    this.value = freezeSnapshot({
      epoch,
      version: 0,
      lifecycle,
      mutation: "hydrate",
      raw,
      committedPrefixLength,
      displayCursor,
    });
  }

  snapshot(): StreamingMarkdownAccumulatorSnapshot {
    return this.value;
  }

  append(chunk: string): StreamingMarkdownAccumulatorSnapshot {
    this.assertStreaming("append");
    if (!chunk) return this.value;
    return this.commit({ raw: this.value.raw + chunk, mutation: "append" });
  }

  ingest(content: string): StreamingMarkdownAccumulatorSnapshot {
    this.assertStreaming("ingest");
    if (content === this.value.raw) return this.value;
    if (content.startsWith(this.value.raw)) {
      return this.append(content.slice(this.value.raw.length));
    }
    return this.replace(content);
  }

  replace(content: string, options: { readonly displayCursor?: number } = {}): StreamingMarkdownAccumulatorSnapshot {
    this.assertStreaming("replace");
    const displayCursor = options.displayCursor === undefined
      ? Math.min(commonPrefixLength(this.value.raw, content), this.value.displayCursor)
      : boundedOffset(options.displayCursor, content.length, "displayCursor");
    return this.commit({
      epoch: this.value.epoch + 1,
      raw: content,
      committedPrefixLength: 0,
      displayCursor,
      mutation: "replace",
    });
  }

  commitPrefix(end: number, expectedEpoch = this.value.epoch): boolean {
    if (expectedEpoch !== this.value.epoch) return false;
    this.assertStreaming("commitPrefix");
    const nextEnd = boundedOffset(end, this.value.raw.length, "prefix end");
    if (nextEnd < this.value.committedPrefixLength) {
      throw new Error("Committed Markdown prefix cannot move backward within one epoch");
    }
    if (nextEnd === this.value.committedPrefixLength) return true;
    this.commit({ committedPrefixLength: nextEnd, mutation: "prefix-commit" });
    return true;
  }

  consumeDisplayBatch(maxCharacters: number, expectedEpoch = this.value.epoch): StreamingMarkdownAccumulatorSnapshot {
    if (expectedEpoch !== this.value.epoch) return this.value;
    const batch = positiveInteger(maxCharacters, "maxCharacters");
    if (this.value.displayCursor >= this.value.raw.length) return this.value;
    return this.commit({
      displayCursor: Math.min(this.value.raw.length, this.value.displayCursor + batch),
      mutation: "display",
    });
  }

  flushDisplay(expectedEpoch = this.value.epoch): StreamingMarkdownAccumulatorSnapshot {
    if (expectedEpoch !== this.value.epoch || this.value.displayCursor === this.value.raw.length) return this.value;
    return this.commit({ displayCursor: this.value.raw.length, mutation: "display" });
  }

  complete(content?: string): StreamingMarkdownAccumulatorSnapshot {
    return this.finish("completed", content);
  }

  cancel(content?: string): StreamingMarkdownAccumulatorSnapshot {
    return this.finish("cancelled", content);
  }

  private finish(
    lifecycle: Exclude<StreamingMarkdownLifecycle, "streaming">,
    content?: string,
  ): StreamingMarkdownAccumulatorSnapshot {
    if (this.value.lifecycle !== "streaming") {
      if (this.value.lifecycle === lifecycle && (content === undefined || content === this.value.raw)) return this.value;
      throw new Error(`Streaming Markdown is already ${this.value.lifecycle}`);
    }
    const nextRaw = content ?? this.value.raw;
    const replacement = content !== undefined
      && content !== this.value.raw
      && !content.startsWith(this.value.raw);
    return this.commit({
      epoch: replacement ? this.value.epoch + 1 : this.value.epoch,
      raw: nextRaw,
      committedPrefixLength: replacement ? 0 : this.value.committedPrefixLength,
      lifecycle,
      displayCursor: nextRaw.length,
      mutation: lifecycle === "completed" ? "complete" : "cancel",
    });
  }

  private commit(change: {
    readonly epoch?: number;
    readonly raw?: string;
    readonly committedPrefixLength?: number;
    readonly displayCursor?: number;
    readonly lifecycle?: StreamingMarkdownLifecycle;
    readonly mutation: StreamingMarkdownMutation;
  }): StreamingMarkdownAccumulatorSnapshot {
    this.value = freezeSnapshot({
      epoch: change.epoch ?? this.value.epoch,
      version: this.value.version + 1,
      lifecycle: change.lifecycle ?? this.value.lifecycle,
      mutation: change.mutation,
      raw: change.raw ?? this.value.raw,
      committedPrefixLength: change.committedPrefixLength ?? this.value.committedPrefixLength,
      displayCursor: change.displayCursor ?? this.value.displayCursor,
    });
    return this.value;
  }

  private assertStreaming(operation: string): void {
    if (this.value.lifecycle !== "streaming") {
      throw new Error(`Cannot ${operation}; Streaming Markdown is ${this.value.lifecycle}`);
    }
  }
}

export function committedStreamingMarkdownPrefix(snapshot: StreamingMarkdownAccumulatorSnapshot): string {
  return snapshot.raw.slice(0, snapshot.committedPrefixLength);
}

export function mutableStreamingMarkdownTail(snapshot: StreamingMarkdownAccumulatorSnapshot): string {
  return snapshot.raw.slice(snapshot.mutableTailStart);
}

export function displayedStreamingMarkdown(snapshot: StreamingMarkdownAccumulatorSnapshot): string {
  return snapshot.raw.slice(0, snapshot.displayCursor);
}

function freezeSnapshot(input: {
  readonly epoch: number;
  readonly version: number;
  readonly lifecycle: StreamingMarkdownLifecycle;
  readonly mutation: StreamingMarkdownMutation;
  readonly raw: string;
  readonly committedPrefixLength: number;
  readonly displayCursor: number;
}): StreamingMarkdownAccumulatorSnapshot {
  if (input.committedPrefixLength > input.raw.length || input.displayCursor > input.raw.length) {
    throw new Error("Streaming Markdown offsets exceed the raw buffer");
  }
  return Object.freeze({
    schemaVersion: STREAMING_MARKDOWN_ACCUMULATOR_SCHEMA_VERSION,
    epoch: input.epoch,
    version: input.version,
    lifecycle: input.lifecycle,
    mutation: input.mutation,
    raw: input.raw,
    committedPrefixLength: input.committedPrefixLength,
    mutableTailStart: input.committedPrefixLength,
    displayCursor: input.displayCursor,
    displayBacklog: input.raw.length - input.displayCursor,
    canonicalRequired: input.lifecycle !== "streaming",
  });
}

function commonPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

function boundedOffset(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
