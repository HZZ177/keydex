import { describe, expect, it, vi } from "vitest";

import {
  MARKDOWN_VIEW_STATE_SCHEMA_VERSION,
  MarkdownViewRevealError,
  MarkdownViewStateStore,
  type MarkdownViewDescriptor,
} from "@/renderer/markdownRuntime/view";

const preview: MarkdownViewDescriptor = {
  scopeId: "workspace-a",
  entryId: "preview-entry-readme",
  viewId: "main-preview",
  kind: "preview",
};

function store(maxRetainedViews = 128) {
  let now = 0;
  return new MarkdownViewStateStore({ maxRetainedViews, now: () => ++now });
}

describe("Markdown multi-view ViewState", () => {
  it("keeps two preview scroll, selection, find, fold, and focus states independent", () => {
    const registry = store();
    const first = registry.attach(preview);
    const second = registry.attach({ ...preview, viewId: "secondary-preview" });
    first.setScrollAnchor({ blockId: "block-a", sourceOffset: 10, alignment: "start", offsetPx: 4 });
    first.setSelection({ sourceStart: 10, sourceEnd: 20, direction: "forward" });
    first.setFind({ open: true, query: "alpha", matchCount: 2, activeMatchIndex: 0, activeMatchId: "m1" });
    first.setFolded("heading-a", true);
    first.setFocus({ target: "content", keyboardVisible: true });

    expect(first.snapshot()).toMatchObject({
      scrollAnchor: { blockId: "block-a", sourceOffset: 10 },
      selection: { sourceStart: 10, sourceEnd: 20 },
      find: { query: "alpha", matchCount: 2 },
      foldedBlockIds: ["heading-a"],
      focus: { target: "content" },
    });
    expect(second.snapshot()).toMatchObject({
      scrollAnchor: null,
      selection: null,
      find: { query: "", matchCount: 0 },
      foldedBlockIds: [],
      focus: { target: "none" },
    });
    first.detach();
    expect(second.snapshot().viewId).toBe("secondary-preview");
    second.detach();
  });

  it("separates preview, source, split, sidebar, and workbench views for one entry", () => {
    const registry = store();
    const kinds = ["preview", "source", "split-preview", "split-source", "sidebar", "workbench"] as const;
    const attachments = kinds.map((kind) => registry.attach({
      ...preview,
      viewId: `${kind}-view`,
      kind,
    }));
    attachments.forEach((attachment, index) => {
      attachment.setScrollAnchor({ blockId: null, sourceOffset: index * 10, alignment: "nearest", offsetPx: index });
    });

    expect(attachments.map((attachment) => attachment.snapshot().scrollAnchor?.sourceOffset))
      .toEqual([0, 10, 20, 30, 40, 50]);
    expect(registry.diagnostics()).toEqual({ retainedViews: 6, attachedViews: 6, pendingReveals: 0, entries: 1 });
    attachments.forEach((attachment) => attachment.detach());
  });

  it("restores the same entry/view state after a mode switch detach", () => {
    const registry = store();
    const initial = registry.attach(preview);
    initial.setScrollAnchor({ blockId: "stable", sourceOffset: 99, alignment: "center", offsetPx: -12 });
    initial.setFind({ open: true, query: "restore" });
    initial.setFolded("folded", true);
    const version = initial.snapshot().version;
    initial.detach();

    const restored = registry.attach(preview);
    expect(restored.snapshot()).toMatchObject({
      scrollAnchor: { blockId: "stable", sourceOffset: 99, offsetPx: -12 },
      find: { open: true, query: "restore" },
      foldedBlockIds: ["folded"],
      version,
    });
    restored.detach();
  });

  it("evicts all view roles for a closed product entry without touching another entry", () => {
    const registry = store();
    const first = registry.attach(preview);
    const source = registry.attach({ ...preview, viewId: "source", kind: "source" });
    const other = registry.attach({ ...preview, entryId: "other-entry", viewId: "other" });
    first.detach();
    source.detach();

    expect(registry.evictEntry(preview.scopeId, preview.entryId)).toBe(2);
    expect(registry.diagnostics()).toEqual({ retainedViews: 1, attachedViews: 1, pendingReveals: 0, entries: 1 });
    expect(() => registry.attach(preview)).not.toThrow();
    registry.evictEntry(preview.scopeId, preview.entryId);
    other.detach();
  });

  it("keeps simultaneous reveal targets independent for the same file", async () => {
    const registry = store();
    const main = registry.attach(preview);
    const split = registry.attach({ ...preview, viewId: "split", kind: "split-preview" });
    const annotation = main.requestReveal({ kind: "annotation", annotationId: "annotation-1" });
    const capsule = split.requestReveal({ kind: "capsule", capsuleId: "capsule-1", sourceOffset: 200 });

    expect(main.snapshot().pendingReveal).toMatchObject({ id: annotation.id, target: { kind: "annotation" } });
    expect(split.snapshot().pendingReveal).toMatchObject({ id: capsule.id, target: { kind: "capsule" } });
    expect(main.completeReveal(annotation.id)).toBe(true);
    await expect(annotation.promise).resolves.toBeUndefined();
    expect(split.snapshot().pendingReveal?.id).toBe(capsule.id);
    expect(split.completeReveal(capsule.id)).toBe(true);
    await expect(capsule.promise).resolves.toBeUndefined();
    main.detach();
    split.detach();
  });

  it("supersedes reveal only within one view and supports line, block, turn, and source targets", async () => {
    const registry = store();
    const main = registry.attach(preview);
    const first = main.requestReveal({ kind: "source-line", line: 40, column: 2 }, { behavior: "smooth" });
    const second = main.requestReveal({ kind: "block", blockId: "block-40" }, { behavior: "instant" });

    await expect(first.promise).rejects.toMatchObject({ code: "superseded" });
    expect(first.signal.aborted).toBe(true);
    expect(main.snapshot().pendingReveal).toMatchObject({
      id: second.id,
      behavior: "instant",
      target: { kind: "block", blockId: "block-40" },
    });
    expect(main.cancelReveal(second.id, "test cancel")).toBe(true);
    await expect(second.promise).rejects.toMatchObject({ code: "cancelled" });

    const turn = main.requestReveal({ kind: "turn", turnId: "turn-1" });
    expect(main.failReveal(turn.id, new Error("not mounted"))).toBe(true);
    await expect(turn.promise).rejects.toMatchObject({ code: "failed" });
    const source = main.requestReveal({ kind: "source-offset", sourceOffset: 12 });
    main.completeReveal(source.id);
    await source.promise;
    main.detach();
  });

  it("reconciles semantic state against a new revision and cancels stale reveal", async () => {
    const registry = store();
    const view = registry.attach(preview);
    view.reconcileRevision("r1", { sourceCharacters: 1000, blockIds: new Set(["a", "b"]) });
    view.setScrollAnchor({ blockId: "a", sourceOffset: 900, alignment: "start", offsetPx: 0 });
    view.setSelection({ sourceStart: 800, sourceEnd: 950, direction: "backward" });
    view.replaceFolds(["a", "missing"]);
    view.setFind({ query: "needle", matchCount: 4, activeMatchId: "match-3", activeMatchIndex: 2 });
    const reveal = view.requestReveal({ kind: "annotation", annotationId: "old-revision" });
    view.reconcileRevision("r2", { sourceCharacters: 850, blockIds: new Set(["b"]) });

    await expect(reveal.promise).rejects.toMatchObject({ code: "revision-changed" });
    expect(view.snapshot()).toMatchObject({
      revision: "r2",
      scrollAnchor: { blockId: null, sourceOffset: 850 },
      selection: { sourceStart: 800, sourceEnd: 850 },
      foldedBlockIds: [],
      find: { query: "needle", matchCount: 0, activeMatchId: null, activeMatchIndex: null },
      pendingReveal: null,
    });
    view.detach();
  });

  it("cancels an in-flight reveal on detach but preserves continuity fields", async () => {
    const registry = store();
    const view = registry.attach(preview);
    view.setScrollAnchor({ blockId: null, sourceOffset: 50, alignment: "nearest", offsetPx: 2 });
    const reveal = view.requestReveal({ kind: "capsule", capsuleId: "capsule" });
    view.detach();

    await expect(reveal.promise).rejects.toMatchObject({ code: "detached" });
    const restored = registry.attach(preview);
    expect(restored.snapshot()).toMatchObject({
      scrollAnchor: { sourceOffset: 50 },
      pendingReveal: null,
    });
    restored.detach();
  });

  it("retains attached views and LRU-evicts only detached states", () => {
    const registry = store(2);
    const pinned = registry.attach(preview);
    const detached = registry.attach({ ...preview, entryId: "old", viewId: "old" });
    detached.detach();
    const newest = registry.attach({ ...preview, entryId: "new", viewId: "new" });

    expect(registry.diagnostics()).toMatchObject({ retainedViews: 2, attachedViews: 2 });
    expect(pinned.snapshot().entryId).toBe(preview.entryId);
    expect(newest.snapshot().entryId).toBe("new");
    pinned.detach();
    newest.detach();
  });

  it("publishes immutable serializable state and isolates subscriber failures", () => {
    const registry = store();
    const view = registry.attach(preview);
    const observer = vi.fn();
    view.subscribe(() => { throw new Error("observer failed"); });
    view.subscribe(observer);
    view.setSelection({ sourceStart: 1, sourceEnd: 2, direction: "none" });

    const state = view.snapshot();
    expect(state.schemaVersion).toBe(MARKDOWN_VIEW_STATE_SCHEMA_VERSION);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.selection)).toBe(true);
    expect(observer).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(state).toLowerCase();
    for (const forbidden of ["htmlelement", "dom", "range", "snapshot", "source_text"]) {
      expect(serialized).not.toContain(forbidden);
    }
    view.detach();
  });

  it("validates descriptors, state ranges, and reveal inputs", () => {
    const registry = store();
    expect(() => registry.attach({ ...preview, kind: "invalid" as "preview" })).toThrow(/kind/u);
    const view = registry.attach(preview);
    expect(() => view.setSelection({ sourceStart: 10, sourceEnd: 2, direction: "none" })).toThrow(/reversed/u);
    expect(() => view.requestReveal({ kind: "source-line", line: 0 })).toThrow(/positive/u);
    expect(() => registry.attach(preview)).toThrow(/already attached/u);
    view.dispose();
    expect(registry.diagnostics().retainedViews).toBe(0);
  });
});
