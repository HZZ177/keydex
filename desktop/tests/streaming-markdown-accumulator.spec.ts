import { describe, expect, it } from "vitest";

import {
  StreamingMarkdownAccumulator,
  committedStreamingMarkdownPrefix,
  displayedStreamingMarkdown,
  mutableStreamingMarkdownTail,
} from "@/renderer/markdownRuntime/streaming";

describe("StreamingMarkdownAccumulator", () => {
  it("produces identical raw buffers for character and chunk ingress", () => {
    const source = "Alpha\n\n- one\n- two\n\n```ts\nconst ok = true;\n```";
    const characters = new StreamingMarkdownAccumulator();
    const chunks = new StreamingMarkdownAccumulator();
    for (const character of source) characters.append(character);
    for (const chunk of [source.slice(0, 7), source.slice(7, 21), source.slice(21)]) chunks.append(chunk);

    expect(characters.snapshot().raw).toBe(source);
    expect(chunks.snapshot().raw).toBe(source);
    expect(displayedStreamingMarkdown(characters.flushDisplay())).toBe(source);
    expect(displayedStreamingMarkdown(chunks.flushDisplay())).toBe(source);
  });

  it("separates token ingress, safe-prefix commits, and display batches", () => {
    const accumulator = new StreamingMarkdownAccumulator();
    const ingressed = accumulator.append("Alpha\n\nBeta");

    expect(ingressed).toMatchObject({
      raw: "Alpha\n\nBeta",
      committedPrefixLength: 0,
      displayCursor: 0,
      displayBacklog: 11,
    });
    expect(accumulator.commitPrefix(7, ingressed.epoch)).toBe(true);
    const committed = accumulator.snapshot();
    expect(committedStreamingMarkdownPrefix(committed)).toBe("Alpha\n\n");
    expect(mutableStreamingMarkdownTail(committed)).toBe("Beta");
    expect(displayedStreamingMarkdown(committed)).toBe("");

    const displayed = accumulator.consumeDisplayBatch(3);
    expect(displayedStreamingMarkdown(displayed)).toBe("Alp");
    expect(displayed.displayBacklog).toBe(8);
    expect(committedStreamingMarkdownPrefix(displayed)).toBe("Alpha\n\n");
  });

  it("never changes an immutable committed prefix during append-only ingress", () => {
    const accumulator = new StreamingMarkdownAccumulator({ content: "Closed\n\nTail" });
    accumulator.commitPrefix(8);
    const prefix = committedStreamingMarkdownPrefix(accumulator.snapshot());

    for (const chunk of [" one", " two", " three"]) {
      accumulator.append(chunk);
      expect(committedStreamingMarkdownPrefix(accumulator.snapshot())).toBe(prefix);
      expect(accumulator.snapshot().committedPrefixLength).toBe(8);
    }
    expect(mutableStreamingMarkdownTail(accumulator.snapshot())).toBe("Tail one two three");
  });

  it("opens a new epoch for rollback or replacement and rejects stale parser commits", () => {
    const accumulator = new StreamingMarkdownAccumulator({
      content: "Stable prefix and old tail",
      displayCursor: 18,
    });
    accumulator.commitPrefix(14);
    const oldEpoch = accumulator.snapshot().epoch;
    const replaced = accumulator.ingest("Stable prefix and corrected");

    expect(replaced).toMatchObject({
      epoch: oldEpoch + 1,
      mutation: "replace",
      committedPrefixLength: 0,
      displayCursor: 18,
    });
    expect(accumulator.commitPrefix(14, oldEpoch)).toBe(false);
    expect(accumulator.snapshot().committedPrefixLength).toBe(0);
    expect(accumulator.commitPrefix(14, replaced.epoch)).toBe(true);
    expect(() => accumulator.commitPrefix(10)).toThrow(/cannot move backward/u);
  });

  it("clips displayed text to the common prefix when a correction changes visible content", () => {
    const accumulator = new StreamingMarkdownAccumulator({
      content: "abcdef-old",
      displayCursor: 10,
    });
    const replaced = accumulator.replace("abcXYZ-new");

    expect(replaced.displayCursor).toBe(3);
    expect(displayedStreamingMarkdown(replaced)).toBe("abc");
    expect(replaced.displayBacklog).toBe(7);
  });

  it("handles a 1 MiB backlog through bounded batches without changing raw content", () => {
    const accumulator = new StreamingMarkdownAccumulator();
    const chunk = "x".repeat(1024);
    for (let index = 0; index < 1024; index += 1) accumulator.append(chunk);
    const raw = accumulator.snapshot().raw;

    expect(raw.length).toBe(1_048_576);
    expect(accumulator.snapshot().displayBacklog).toBe(1_048_576);
    accumulator.consumeDisplayBatch(512);
    expect(accumulator.snapshot()).toMatchObject({ displayCursor: 512, displayBacklog: 1_048_064 });
    accumulator.consumeDisplayBatch(32_768);
    expect(accumulator.snapshot().displayCursor).toBe(33_280);
    expect(accumulator.snapshot().raw).toBe(raw);
  });

  it("supports animated, fast-drain, and reduced-motion display policies without parsing", () => {
    const accumulator = new StreamingMarkdownAccumulator({ content: "x".repeat(20_000) });
    accumulator.consumeDisplayBatch(24);
    const animatedCursor = accumulator.snapshot().displayCursor;
    accumulator.consumeDisplayBatch(12_000);
    const fastDrainCursor = accumulator.snapshot().displayCursor;
    const reducedMotion = accumulator.flushDisplay();

    expect(animatedCursor).toBe(24);
    expect(fastDrainCursor).toBe(12_024);
    expect(reducedMotion.displayCursor).toBe(20_000);
    expect(reducedMotion.displayBacklog).toBe(0);
    expect(reducedMotion.committedPrefixLength).toBe(0);
  });

  it("atomically completes or cancels with every character visible and canonical work pending", () => {
    const completed = new StreamingMarkdownAccumulator({ content: "Partial", displayCursor: 2 });
    const completedSnapshot = completed.complete("Partial answer");
    expect(completedSnapshot).toMatchObject({
      raw: "Partial answer",
      lifecycle: "completed",
      mutation: "complete",
      displayCursor: 14,
      displayBacklog: 0,
      canonicalRequired: true,
    });
    expect(completed.complete()).toBe(completedSnapshot);
    expect(() => completed.append(" late")).toThrow(/is completed/u);

    const cancelled = new StreamingMarkdownAccumulator({ content: "Keep partial", displayCursor: 1 });
    const cancelledSnapshot = cancelled.cancel();
    expect(cancelledSnapshot).toMatchObject({
      lifecycle: "cancelled",
      displayCursor: 12,
      displayBacklog: 0,
      canonicalRequired: true,
    });
    expect(() => cancelled.complete()).toThrow(/already cancelled/u);
  });

  it("rehydrates streaming and terminal messages with explicit cursor and prefix state", () => {
    const streaming = new StreamingMarkdownAccumulator({
      content: "Hydrated stream",
      lifecycle: "streaming",
      committedPrefixLength: 8,
      displayCursor: 10,
      epoch: 7,
    }).snapshot();
    const history = new StreamingMarkdownAccumulator({
      content: "Historical answer",
      lifecycle: "completed",
    }).snapshot();

    expect(streaming).toMatchObject({ epoch: 7, version: 0, mutation: "hydrate", displayCursor: 10 });
    expect(committedStreamingMarkdownPrefix(streaming)).toBe("Hydrated");
    expect(history).toMatchObject({
      lifecycle: "completed",
      displayCursor: 17,
      displayBacklog: 0,
      canonicalRequired: true,
    });
  });

  it("returns frozen snapshots and validates offsets, batches, and lifecycle transitions", () => {
    const accumulator = new StreamingMarkdownAccumulator({ content: "abc" });
    expect(Object.isFrozen(accumulator.snapshot())).toBe(true);
    expect(() => accumulator.commitPrefix(4)).toThrow(/between 0 and 3/u);
    expect(() => accumulator.consumeDisplayBatch(0)).toThrow(/positive integer/u);
    expect(() => new StreamingMarkdownAccumulator({ content: "abc", displayCursor: 4 }))
      .toThrow(/between 0 and 3/u);
    const before = accumulator.snapshot();
    expect(accumulator.consumeDisplayBatch(1, before.epoch + 1)).toBe(before);
  });
});
