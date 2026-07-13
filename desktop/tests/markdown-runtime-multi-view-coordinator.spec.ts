import { describe, expect, it, vi } from "vitest";

import {
  MarkdownMultiViewCoordinator,
  type MarkdownMultiViewAdapter,
  type MarkdownViewSyncContext,
  type MarkdownViewSyncIntent,
} from "@/renderer/markdownRuntime/view/MarkdownMultiViewCoordinator";

describe("MarkdownMultiViewCoordinator", () => {
  it("preserves a logical source anchor across Preview -> Source -> Preview mode switches", async () => {
    const coordinator = new MarkdownMultiViewCoordinator({ mode: "preview", revision: "r1" });
    const preview = adapter("preview", "preview", 120);
    const source = adapter("source", "source", 0);
    coordinator.register(preview);
    coordinator.register(source);

    await coordinator.setMode("source", preview.id);
    source.anchor = { sourceOffset: 340, alignment: "center" };
    await coordinator.setMode("preview", source.id);

    expect(source.applied[0]?.intent).toMatchObject({ kind: "scroll", sourceOffset: 120 });
    expect(preview.applied[0]?.intent).toMatchObject({ kind: "scroll", sourceOffset: 340 });
  });

  it("synchronizes Split cursor/reveal/annotation both ways with one monotonic epoch", async () => {
    const coordinator = new MarkdownMultiViewCoordinator({ mode: "split", revision: "r1" });
    const preview = adapter("preview", "preview", 0);
    const source = adapter("source", "source", 0);
    coordinator.register(preview);
    coordinator.register(source);

    const cursorEpoch = await coordinator.reportLocal("source", event("cursor", 42));
    const revealEpoch = await coordinator.reportLocal("preview", event("reveal", 900));
    const annotationEpoch = await coordinator.navigate({
      kind: "annotation", sourceOffset: 777, annotationId: "ann-1", alignment: "center",
    });

    expect(cursorEpoch).toBe(1);
    expect(revealEpoch).toBe(2);
    expect(annotationEpoch).toBe(3);
    expect(preview.applied.map((value) => value.intent.kind)).toEqual(["cursor", "annotation"]);
    expect(source.applied.map((value) => value.intent.kind)).toEqual(["reveal", "annotation"]);
  });

  it("ignores a receiver echo carrying the applied epoch and prevents feedback loops", async () => {
    const coordinator = new MarkdownMultiViewCoordinator({ mode: "split", revision: "r1" });
    const source = adapter("source", "source", 0);
    const preview = adapter("preview", "preview", 0, async (intent, context) => {
      await coordinator.reportLocal("preview", { intent, revision: "r1", causeEpoch: context.epoch });
    });
    coordinator.register(source);
    coordinator.register(preview);

    await coordinator.reportLocal("source", event("scroll", 55));

    expect(preview.applied).toHaveLength(1);
    expect(source.applied).toHaveLength(0);
    expect(coordinator.diagnostics().epoch).toBe(1);
  });

  it("cancels obsolete sync work during rapid navigation and mode switching", async () => {
    const coordinator = new MarkdownMultiViewCoordinator({ mode: "split", revision: "r1" });
    const pending: Array<{ context: MarkdownViewSyncContext; resolve(): void }> = [];
    const preview = adapter("preview", "preview", 10, (_intent, context) => new Promise<void>((resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      pending.push({ context, resolve });
    }));
    const source = adapter("source", "source", 20);
    coordinator.register(preview);
    coordinator.register(source);

    const old = coordinator.reportLocal("source", event("reveal", 100));
    const latest = coordinator.reportLocal("source", event("reveal", 200));
    pending.at(-1)?.resolve();

    await expect(old).resolves.toBe(1);
    await expect(latest).resolves.toBe(2);
    expect(pending[0].context.signal.aborted).toBe(true);
    expect(preview.applied.at(-1)?.intent.sourceOffset).toBe(200);
  });

  it("rejects stale revisions and clears loop epochs on revision publication", async () => {
    const coordinator = new MarkdownMultiViewCoordinator({ mode: "split", revision: "r1" });
    const preview = adapter("preview", "preview", 0);
    const source = adapter("source", "source", 0);
    coordinator.register(preview);
    coordinator.register(source);
    await coordinator.reportLocal("source", event("scroll", 12));

    coordinator.reconcileRevision("r2");
    preview.revision = "r2";
    source.revision = "r2";
    await expect(coordinator.reportLocal("source", { ...event("scroll", 20), revision: "r1" })).resolves.toBeNull();
    await coordinator.reportLocal("source", { ...event("scroll", 30), revision: "r2" });

    expect(preview.applied.at(-1)?.context).toMatchObject({ revision: "r2", epoch: 3 });
  });

  it("supports two preview hosts and detaching either side without corrupting the other", async () => {
    const coordinator = new MarkdownMultiViewCoordinator({ mode: "split", revision: "r1" });
    const previewA = adapter("preview-a", "preview", 0);
    const previewB = adapter("preview-b", "preview", 0);
    const source = adapter("source", "source", 0);
    coordinator.register(previewA);
    const detachB = coordinator.register(previewB);
    coordinator.register(source);

    await coordinator.reportLocal("source", event("cursor", 10));
    detachB();
    await coordinator.reportLocal("source", event("cursor", 20));

    expect(previewA.applied).toHaveLength(2);
    expect(previewB.applied).toHaveLength(1);
    expect(coordinator.diagnostics()).toMatchObject({ registeredViews: 2, previewViews: 1, sourceViews: 1 });
  });

  it("does not copy independent find/fold state while synchronizing logical position", async () => {
    const coordinator = new MarkdownMultiViewCoordinator({ mode: "split", revision: "r1" });
    const preview = adapter("preview", "preview", 0);
    const source = adapter("source", "source", 0);
    preview.localState = { find: "needle", folds: ["block-a"] };
    source.localState = { find: "other", folds: [] };
    coordinator.register(preview);
    coordinator.register(source);

    await coordinator.reportLocal("preview", event("scroll", 50));

    expect(preview.localState).toEqual({ find: "needle", folds: ["block-a"] });
    expect(source.localState).toEqual({ find: "other", folds: [] });
  });

  it("validates registration, annotation intents, and lifecycle", async () => {
    const coordinator = new MarkdownMultiViewCoordinator({ mode: "preview", revision: "r1" });
    const preview = adapter("preview", "preview", 0);
    coordinator.register(preview);
    expect(() => coordinator.register(preview)).toThrow("already registered");
    await expect(coordinator.navigate({ kind: "annotation", sourceOffset: 0 })).rejects.toThrow("annotationId");
    coordinator.destroy();
    expect(() => coordinator.reconcileRevision("r2")).toThrow("destroyed");
  });
});

function adapter(
  id: string,
  surface: "preview" | "source",
  sourceOffset: number,
  onApply?: (intent: MarkdownViewSyncIntent, context: MarkdownViewSyncContext) => void | Promise<void>,
) {
  const value: MarkdownMultiViewAdapter & {
    revision: string;
    anchor: { sourceOffset: number; alignment?: "start" | "center" };
    applied: Array<{ intent: MarkdownViewSyncIntent; context: MarkdownViewSyncContext }>;
    localState: { find: string; folds: string[] };
  } = {
    id,
    surface,
    revision: "r1",
    anchor: { sourceOffset },
    applied: [],
    localState: { find: "", folds: [] },
    currentRevision() { return value.revision; },
    captureAnchor() { return value.anchor; },
    async apply(intent, context) {
      value.applied.push({ intent, context });
      await onApply?.(intent, context);
    },
  };
  return value;
}

function event(kind: MarkdownViewSyncIntent["kind"], sourceOffset: number) {
  return { intent: { kind, sourceOffset }, revision: "r1" } as const;
}
