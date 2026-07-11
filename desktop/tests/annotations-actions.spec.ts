import { describe, expect, it, vi } from "vitest";

import { RuntimeHttpError } from "@/runtime/errors";
import type { AnnotationRecord, AnnotationsRuntime, TextSelector } from "@/runtime/annotations";
import { createPlainTextModel } from "@/renderer/features/annotations/document/PlainTextModel";
import { createAnnotationActions } from "@/renderer/features/annotations/state/annotationActions";
import { createAnnotationStore } from "@/renderer/features/annotations/state/annotationStore";

describe("annotation async actions", () => {
  it("loads, creates, updates, retargets, and deletes through the runtime boundary", async () => {
    const alpha = record("alpha", "alpha", 0);
    const runtime = fakeRuntime({
      list: vi.fn().mockResolvedValue([alpha]),
      create: vi.fn().mockResolvedValue(record("beta", "beta", 6)),
      updateBody: vi.fn().mockResolvedValue({ ...alpha, body: "Updated" }),
      replaceTarget: vi.fn().mockResolvedValue(record("alpha", "beta", 6)),
      delete: vi.fn().mockResolvedValue(undefined),
    });
    const store = documentStore("alpha beta");
    const actions = createAnnotationActions({ runtime, store });

    await actions.load();
    await actions.createText("Beta", selector("beta", 6));
    await actions.updateBody("alpha", "Updated");
    await actions.retarget("alpha", selector("beta", 6));
    store.getState().activate("alpha");
    expect(await actions.delete("alpha")).toBe(true);

    expect(store.getState().records.map((item) => item.id)).toEqual(["beta"]);
    expect(store.getState().activeAnnotationId).toBeNull();
    expect(store.getState().resolutions.resolved.map((item) => item.record.id)).toEqual(["beta"]);
    expect(runtime.create).toHaveBeenCalledWith("ws-1", expect.objectContaining({
      path: "README.md",
      target: { type: "text", selector: selector("beta", 6) },
    }));
  });

  it("does not mutate records when an API operation fails", async () => {
    const alpha = record("alpha", "alpha", 0);
    const runtime = fakeRuntime({
      list: vi.fn().mockResolvedValue([alpha]),
      updateBody: vi.fn().mockRejectedValue(new Error("save failed")),
    });
    const store = documentStore("alpha");
    const actions = createAnnotationActions({ runtime, store });
    await actions.load();

    const result = await actions.updateBody("alpha", "Changed");

    expect(result).toBeNull();
    expect(store.getState().records[0].body).toBe("alpha");
    expect(store.getState().error).toBe("save failed");
  });

  it("cancels an obsolete draft or retarget interaction on a 409 revision conflict", async () => {
    const runtime = fakeRuntime({
      create: vi.fn().mockRejectedValue(revisionConflict()),
      replaceTarget: vi.fn().mockRejectedValue(revisionConflict()),
    });
    const store = documentStore("alpha");
    const actions = createAnnotationActions({ runtime, store });
    const textSelector = selector("alpha", 0);
    store.getState().beginDraft({ start: 0, end: 5 }, textSelector);

    await actions.createText("Draft", textSelector);
    expect(store.getState().interaction.type).toBe("idle");

    store.getState().beginRetarget("ann");
    await actions.retarget("ann", textSelector);
    expect(store.getState().interaction.type).toBe("idle");
    expect(store.getState().error).toContain("changed");
  });

  it("retargets by replacing only target while preserving id and body", async () => {
    const original = { ...record("ann", "alpha", 0), body: "Original comment" };
    const nextSelector = selector("beta", 6);
    const updated = { ...original, target: { type: "text" as const, selector: nextSelector } };
    const runtime = fakeRuntime({
      list: vi.fn().mockResolvedValue([original]),
      replaceTarget: vi.fn().mockResolvedValue(updated),
    });
    const store = documentStore("alpha beta");
    const actions = createAnnotationActions({ runtime, store });
    await actions.load();
    store.getState().beginRetarget("ann");
    store.getState().setRetargetSelection({ start: 6, end: 10 }, nextSelector);

    const result = await actions.retarget("ann", nextSelector);

    expect(runtime.replaceTarget).toHaveBeenCalledWith("ws-1", "ann", { target: { type: "text", selector: nextSelector } });
    expect(result).toMatchObject({ id: "ann", body: "Original comment" });
    expect(store.getState().interaction.type).toBe("idle");
    expect(store.getState().resolutions.resolved[0]).toMatchObject({ record: { id: "ann", body: "Original comment" } });
  });

  it("blocks duplicate mutations while the first operation is pending", async () => {
    const pending = deferred<AnnotationRecord>();
    const runtime = fakeRuntime({ create: vi.fn().mockReturnValue(pending.promise) });
    const store = documentStore("alpha");
    const actions = createAnnotationActions({ runtime, store });
    const first = actions.createDocument("First");
    const second = actions.createDocument("Second");

    await expect(second).rejects.toThrow("already pending");
    pending.resolve(documentRecord("doc"));
    await expect(first).resolves.toMatchObject({ id: "doc" });
    expect(runtime.create).toHaveBeenCalledTimes(1);
  });

  it("ignores an obsolete response after the preview switches documents", async () => {
    const pending = deferred<AnnotationRecord>();
    const runtime = fakeRuntime({ create: vi.fn().mockReturnValue(pending.promise) });
    const store = documentStore("alpha");
    const actions = createAnnotationActions({ runtime, store });
    const create = actions.createDocument("Old document");

    store.getState().setDocument({
      workspaceId: "ws-1",
      path: "next.md",
      model: createPlainTextModel("next", "sha256:next"),
    });
    pending.resolve(documentRecord("old"));

    await expect(create).resolves.toBeNull();
    expect(store.getState().document?.path).toBe("next.md");
    expect(store.getState().records).toEqual([]);
    expect(store.getState().pendingMutation).toBeNull();
  });
});

function documentStore(source: string) {
  const store = createAnnotationStore();
  store.getState().setDocument({
    workspaceId: "ws-1",
    path: "README.md",
    model: createPlainTextModel(source, `sha256:${source}`),
  });
  return store;
}

function fakeRuntime(overrides: Partial<AnnotationsRuntime>): AnnotationsRuntime {
  return {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    updateBody: vi.fn(),
    replaceTarget: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}

function record(id: string, exact: string, start: number): AnnotationRecord {
  return {
    id,
    workspace_id: "ws-1",
    document_path: "README.md",
    target: { type: "text", selector: selector(exact, start) },
    body: id,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
}

function documentRecord(id: string): AnnotationRecord {
  return {
    id,
    workspace_id: "ws-1",
    document_path: "README.md",
    target: { type: "document" },
    body: id,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
}

function selector(exact: string, start: number): TextSelector {
  return {
    position: { start, end: start + exact.length },
    quote: { exact, prefix: "", suffix: "" },
    context: { containerType: "source", headingPath: [] },
    textRevision: "text",
    documentRevision: "document",
  };
}

function revisionConflict(): RuntimeHttpError {
  return new RuntimeHttpError({
    code: "annotation_document_changed",
    message: "The annotation document changed",
    status: 409,
    method: "POST",
    path: "/annotations",
    body: {},
    rawText: "",
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
