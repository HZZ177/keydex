import { describe, expect, it, vi } from "vitest";

import {
  MarkdownNavigationIntentController,
  type MarkdownNavigationIntent,
} from "@/renderer/markdownRuntime/view/NavigationIntent";
import type { MarkdownViewDescriptor, MarkdownViewScrollAnchor } from "@/renderer/markdownRuntime/view/types";

const DESCRIPTOR: MarkdownViewDescriptor = Object.freeze({
  scopeId: "workspace:ws",
  entryId: "file:README.md",
  viewId: "preview-main",
  kind: "preview",
});

function anchor(sourceOffset = 100): MarkdownViewScrollAnchor {
  return { blockId: "block-1", sourceOffset, alignment: "nearest", offsetPx: 8 };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("Markdown NavigationIntent priority state machine", () => {
  it("lets an explicit reveal supersede an in-flight historical restore", async () => {
    const restore = deferred();
    const seen: MarkdownNavigationIntent[] = [];
    const controller = new MarkdownNavigationIntentController(DESCRIPTOR, "file:README.md");
    controller.publishRuntime({
      revision: "r1",
      epoch: 1,
      execute: (intent) => {
        seen.push(intent);
        return intent.kind === "restore" ? restore.promise : undefined;
      },
    });
    const historical = controller.requestRestore(anchor());
    const explicit = controller.requestReveal({ kind: "source-line", line: 500 });

    await expect(historical.promise).rejects.toMatchObject({ code: "superseded" });
    await expect(explicit.promise).resolves.toBeUndefined();
    restore.resolve();
    await Promise.resolve();
    expect(seen.map((intent) => intent.kind)).toEqual(["restore", "reveal"]);
    expect(controller.diagnostics()).toMatchObject({ completed: 1, superseded: 1, pending: false });
  });

  it("rejects a lower-priority restore without disturbing a running annotation reveal", async () => {
    const annotation = deferred();
    const execute = vi.fn((intent: MarkdownNavigationIntent) => intent.kind === "annotation" ? annotation.promise : undefined);
    const controller = new MarkdownNavigationIntentController(DESCRIPTOR, "file:README.md");
    controller.publishRuntime({ revision: "r1", epoch: 1, execute });
    const explicit = controller.requestReveal({ kind: "annotation", annotationId: "ann-1" });
    const historical = controller.requestRestore(anchor(20));

    await expect(historical.promise).rejects.toMatchObject({ code: "lower-priority" });
    expect(explicit.signal.aborted).toBe(false);
    annotation.resolve();
    await explicit.promise;
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("uses latest-wins consistently for find, annotation, capsule, and ordinary reveal", async () => {
    const controller = new MarkdownNavigationIntentController(DESCRIPTOR, "file:README.md");
    const first = controller.requestReveal({ kind: "find", matchId: "match-1" });
    const second = controller.requestReveal({ kind: "annotation", annotationId: "ann-1" });
    const third = controller.requestReveal({ kind: "capsule", capsuleId: "cap-1", sourceOffset: 900 });
    const latest = controller.requestReveal({ kind: "block", blockId: "block-9" });

    await expect(first.promise).rejects.toMatchObject({ code: "superseded" });
    await expect(second.promise).rejects.toMatchObject({ code: "superseded" });
    await expect(third.promise).rejects.toMatchObject({ code: "superseded" });
    const execute = vi.fn();
    controller.publishRuntime({ revision: "r1", epoch: 1, execute });
    await latest.promise;
    expect(execute.mock.calls[0][0]).toMatchObject({
      kind: "reveal",
      payload: { target: { kind: "block", blockId: "block-9" } },
    });
  });

  it("cancels both queued and running automatic navigation when the user scrolls", async () => {
    const queuedController = new MarkdownNavigationIntentController(DESCRIPTOR, "file:README.md");
    const queued = queuedController.requestRestore(anchor());
    queuedController.recordUserScroll();
    await expect(queued.promise).rejects.toMatchObject({ code: "user-interrupted" });

    const runningWork = deferred();
    const runningController = new MarkdownNavigationIntentController(DESCRIPTOR, "file:README.md");
    runningController.publishRuntime({ revision: "r1", epoch: 1, execute: () => runningWork.promise });
    const running = runningController.requestReveal({ kind: "source-offset", sourceOffset: 800 });
    runningController.recordUserScroll();
    await expect(running.promise).rejects.toMatchObject({ code: "user-interrupted" });
    runningWork.resolve();
    await Promise.resolve();
    expect(runningController.diagnostics()).toMatchObject({ completed: 0, userInterrupted: 1 });
  });

  it("rejects stale requested revisions and cancels work on Runtime revision change", async () => {
    const beforeParse = new MarkdownNavigationIntentController(DESCRIPTOR, "file:README.md");
    const staleQueued = beforeParse.requestRestore(anchor(), { requestedRevision: "r1" });
    beforeParse.publishRuntime({ revision: "r2", epoch: 1, execute: vi.fn() });
    await expect(staleQueued.promise).rejects.toMatchObject({ code: "revision-changed" });

    const work = deferred();
    const controller = new MarkdownNavigationIntentController(DESCRIPTOR, "file:README.md");
    controller.publishRuntime({ revision: "r1", epoch: 1, execute: () => work.promise });
    const running = controller.requestReveal({ kind: "source-line", line: 9 });
    controller.publishRuntime({ revision: "r2", epoch: 2, execute: vi.fn() });
    await expect(running.promise).rejects.toMatchObject({ code: "revision-changed" });
    expect(controller.diagnostics().revisionCancelled).toBe(1);
  });

  it("binds repeated same-file reveals to the existing entry descriptor", async () => {
    const intents: MarkdownNavigationIntent[] = [];
    const controller = new MarkdownNavigationIntentController(DESCRIPTOR, "file:README.md");
    controller.publishRuntime({
      revision: "r1",
      epoch: 1,
      execute: (intent) => { intents.push(intent); },
    });
    await controller.requestReveal({ kind: "source-line", line: 10 }).promise;
    await controller.requestReveal({ kind: "capsule", capsuleId: "cap", sourceOffset: 1000 }).promise;

    expect(intents).toHaveLength(2);
    expect(new Set(intents.map((intent) => intent.descriptor.entryId))).toEqual(new Set([DESCRIPTOR.entryId]));
    expect(new Set(intents.map((intent) => intent.documentId))).toEqual(new Set(["file:README.md"]));
  });

  it("cancels late work on mode switch and restores only after the new view publishes a Runtime epoch", async () => {
    const oldWork = deferred();
    const preview = new MarkdownNavigationIntentController(DESCRIPTOR, "file:README.md");
    preview.publishRuntime({ revision: "r1", epoch: 1, execute: () => oldWork.promise });
    const oldReveal = preview.requestReveal({ kind: "source-line", line: 30 });
    preview.detach();
    await expect(oldReveal.promise).rejects.toMatchObject({ code: "view-detached" });

    const sourceDescriptor = { ...DESCRIPTOR, viewId: "source-main", kind: "source" as const };
    const sourceView = new MarkdownNavigationIntentController(sourceDescriptor, "file:README.md");
    const restored = sourceView.requestRestore(anchor(300));
    expect(sourceView.diagnostics().pending).toBe(true);
    const execute = vi.fn();
    sourceView.publishRuntime({ revision: "r1", epoch: 1, execute });
    await restored.promise;
    expect(execute.mock.calls[0][0]).toMatchObject({ descriptor: sourceDescriptor, kind: "restore" });
    oldWork.resolve();
  });

  it("does not let close/reopen inherit an old pending task", async () => {
    const closed = new MarkdownNavigationIntentController(DESCRIPTOR, "file:README.md");
    const old = closed.requestRestore(anchor());
    closed.destroy();
    await expect(old.promise).rejects.toMatchObject({ code: "disposed" });
    expect(() => closed.requestRestore(anchor())).toThrow(/destroyed/u);

    const reopened = new MarkdownNavigationIntentController(DESCRIPTOR, "file:README.md");
    const execute = vi.fn();
    reopened.publishRuntime({ revision: "r1", epoch: 1, execute });
    await reopened.requestRestore(anchor()).promise;
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("is driven only by Runtime events and never schedules readiness timeouts", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const controller = new MarkdownNavigationIntentController(DESCRIPTOR, "file:README.md");
    const handle = controller.requestInitial(anchor(0));
    await Promise.resolve();
    expect(timeout).not.toHaveBeenCalled();
    controller.publishRuntime({ revision: "r1", epoch: 1, execute: vi.fn() });
    await handle.promise;
    expect(timeout).not.toHaveBeenCalled();
    timeout.mockRestore();
  });

  it("rejects older Runtime epochs and supports external cancellation", async () => {
    const controller = new MarkdownNavigationIntentController(DESCRIPTOR, "file:README.md");
    controller.publishRuntime({ revision: "r1", epoch: 2, execute: vi.fn() });
    expect(() => controller.publishRuntime({ revision: "r1", epoch: 1, execute: vi.fn() })).toThrow(/older/u);

    const external = new AbortController();
    const handle = controller.requestRestore(anchor(), { signal: external.signal });
    external.abort("stop");
    await expect(handle.promise).rejects.toMatchObject({ code: "cancelled" });
  });
});
