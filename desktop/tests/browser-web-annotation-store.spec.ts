import { describe, expect, it, vi } from "vitest";

import {
  createWebAnnotationStore,
  type WebAnnotationClient,
  type WebAnnotationDetail,
  type WebAnnotationItem,
  type WebAnnotationPage,
  type WebAnnotationScope,
  webAnnotationCacheKey,
} from "@/renderer/features/browser/annotations";
import type { BrowserSurfaceRef } from "@/renderer/features/browser/domain";
import type { WebRegionTarget } from "@/renderer/features/browser/runtime";
import { RuntimeHttpError } from "@/runtime";

const firstSurface: BrowserSurfaceRef = {
  panelId: "browser-1",
  surfaceId: "surface-1",
  generation: 1,
};
const secondSurface: BrowserSurfaceRef = {
  panelId: "browser-2",
  surfaceId: "surface-2",
  generation: 1,
};
const target: WebRegionTarget = {
  type: "region",
  rect: { x: 1, y: 2, width: 30, height: 40 },
  viewport: { width: 800, height: 600 },
  scroll: { x: 0, y: 0 },
  frame: { url: "https://example.test", indexPath: [] },
};

describe("webAnnotationStore", () => {
  it("cancels stale URL loads and aligns the accepted page with the active surface", async () => {
    const first = deferred<WebAnnotationPage>();
    const secondItem = item("session", "session-1", "b", "annotation-b");
    const list = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(page(secondItem));
    const store = createWebAnnotationStore(client({ list }));

    const stale = store.getState().activatePage(activation(
      { kind: "session", id: "session-1" },
      "https://example.test/first",
      firstSurface,
      "navigation-1",
    ));
    const accepted = store.getState().activatePage(activation(
      { kind: "session", id: "session-1" },
      "https://example.test/second",
      secondSurface,
      "navigation-2",
    ));
    first.resolve(page(item("session", "session-1", "a", "annotation-a")));
    await Promise.all([stale, accepted]);

    const firstSignal = list.mock.calls[0][0].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
    expect(store.getState().activePage).toMatchObject({
      surface: secondSurface,
      navigationId: "navigation-2",
      pageKey: webAnnotationCacheKey({ kind: "session", id: "session-1" }, "b".repeat(64)),
    });
    expect(activeEntry(store).items.map((entry) => entry.annotation.id)).toEqual(["annotation-b"]);
  });

  it("isolates equal URLs by scope and keeps cached records across panel close/reopen", async () => {
    const sessionItem = item("session", "session-1", "a", "annotation-session");
    const workspaceItem = item("workspace", "workspace-1", "b", "annotation-workspace");
    const reopened = deferred<WebAnnotationPage>();
    const list = vi.fn()
      .mockResolvedValueOnce(page(sessionItem))
      .mockResolvedValueOnce(page(workspaceItem))
      .mockImplementationOnce(() => reopened.promise);
    const store = createWebAnnotationStore(client({ list }));

    await store.getState().activatePage(activation(
      sessionItem.resource.scope,
      "https://example.test/article",
      firstSurface,
      "navigation-1",
    ));
    await store.getState().activatePage(activation(
      workspaceItem.resource.scope,
      "https://example.test/article",
      secondSurface,
      "navigation-2",
    ));

    const sessionKey = webAnnotationCacheKey(sessionItem.resource.scope, sessionItem.resource.urlKey);
    const workspaceKey = webAnnotationCacheKey(workspaceItem.resource.scope, workspaceItem.resource.urlKey);
    expect(store.getState().pages[sessionKey]?.items[0].annotation.id).toBe("annotation-session");
    expect(store.getState().pages[workspaceKey]?.items[0].annotation.id).toBe("annotation-workspace");

    store.getState().closeSurface(secondSurface);
    expect(store.getState().activePage).toBeNull();
    expect(store.getState().pages[workspaceKey]?.items).toHaveLength(1);

    const nextSurface = { ...secondSurface, surfaceId: "surface-3", generation: 2 };
    const reopen = store.getState().activatePage(activation(
      workspaceItem.resource.scope,
      "https://example.test/article",
      nextSurface,
      "navigation-3",
    ));
    expect(activeEntry(store)).toMatchObject({ status: "ready", refreshing: true });
    expect(activeEntry(store).items[0].annotation.id).toBe("annotation-workspace");
    reopened.resolve(page(workspaceItem));
    await reopen;
    expect(activeEntry(store)).toMatchObject({ status: "ready", refreshing: false });
  });

  it("recovers a stale concurrent update from the server current record", async () => {
    const original = item("session", "session-1", "a", "annotation-1", 1, "Original");
    const current = item("session", "session-1", "a", "annotation-1", 2, "Remote");
    const patch = vi.fn().mockRejectedValue(revisionConflict(current, 1));
    const store = createWebAnnotationStore(client({
      list: vi.fn().mockResolvedValue(page(original)),
      patch,
    }));
    await store.getState().activatePage(activation(
      original.resource.scope,
      original.resource.urlNormalized,
      firstSurface,
      "navigation-1",
    ));

    const result = await store.getState().patchAnnotation("annotation-1", {
      expectedRevision: 1,
      bodyMarkdown: "Local",
    });

    expect(result).toMatchObject({ status: "conflict", expectedRevision: 1 });
    expect(store.getState().conflict).toMatchObject({
      annotationId: "annotation-1",
      current: { annotation: { revision: 2, bodyMarkdown: "Remote" } },
    });
    expect(activeEntry(store).items[0].annotation).toMatchObject({ revision: 2, bodyMarkdown: "Remote" });
    expect(store.getState().mutation).toBeNull();
  });

  it("reloads a retarget conflict and can retry against the current revision", async () => {
    const original = item("session", "session-1", "a", "annotation-1", 1, "Original body");
    const current = item("session", "session-1", "a", "annotation-1", 2, "Remote body");
    const saved = item("session", "session-1", "a", "annotation-1", 3, "Remote body");
    const retarget = vi.fn()
      .mockRejectedValueOnce(revisionConflict(current, 1))
      .mockResolvedValueOnce(detail(saved));
    const store = createWebAnnotationStore(client({
      list: vi.fn().mockResolvedValue(page(original)),
      retarget,
    }));
    await store.getState().activatePage(activation(
      original.resource.scope,
      original.resource.urlNormalized,
      firstSurface,
      "navigation-1",
    ));

    const conflict = await store.getState().retargetAnnotation("annotation-1", {
      expectedRevision: 1,
      target,
    });
    expect(conflict).toMatchObject({
      status: "conflict",
      current: { annotation: { revision: 2, bodyMarkdown: "Remote body" } },
    });
    expect(activeEntry(store).items[0].annotation.revision).toBe(2);

    const retried = await store.getState().retargetAnnotation("annotation-1", {
      expectedRevision: 2,
      target,
    });
    expect(retried).toMatchObject({ status: "saved", detail: { annotation: { revision: 3 } } });
    expect(retarget).toHaveBeenNthCalledWith(2, "annotation-1", {
      expectedRevision: 2,
      target,
      stagedAssetIds: undefined,
    });
    expect(activeEntry(store).items[0].annotation.bodyMarkdown).toBe("Remote body");
  });

  it("updates and deletes records without reusing the file annotation store", async () => {
    const original = item("session", "session-1", "a", "annotation-1", 1, "Original");
    const updated = detail(item("session", "session-1", "a", "annotation-1", 2, "Updated"));
    const remove = vi.fn().mockResolvedValue(undefined);
    const store = createWebAnnotationStore(client({
      list: vi.fn().mockResolvedValue(page(original)),
      patch: vi.fn().mockResolvedValue(updated),
      delete: remove,
    }));
    await store.getState().activatePage(activation(
      original.resource.scope,
      original.resource.urlNormalized,
      firstSurface,
      "navigation-1",
    ));

    const saved = await store.getState().patchAnnotation("annotation-1", {
      expectedRevision: 1,
      bodyMarkdown: "Updated",
    });
    expect(saved).toMatchObject({ status: "saved", detail: { annotation: { revision: 2 } } });
    expect(activeEntry(store).items[0].annotation.bodyMarkdown).toBe("Updated");

    await store.getState().deleteAnnotation("annotation-1");
    expect(remove).toHaveBeenCalledWith("annotation-1");
    expect(activeEntry(store).items).toEqual([]);
  });

  it("registers staged region evidence before creating its annotation", async () => {
    const created = detail(item("session", "session-1", "a", "annotation-region"));
    const registerAsset = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue(created);
    const store = createWebAnnotationStore(client({
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      registerAsset,
      create,
    }));
    await store.getState().activatePage(activation(
      { kind: "session", id: "session-1" },
      "https://example.test/article",
      firstSurface,
      "navigation-1",
    ));
    const stagedAsset = {
      assetId: "asset-region-1",
      kind: "staged" as const,
      mimeType: "image/png" as const,
      width: 30,
      height: 40,
      byteLength: 256,
      sha256: "a".repeat(64),
      expiresAt: "2026-07-22T01:00:00Z",
    };

    await store.getState().createAnnotation({
      target,
      bodyMarkdown: "Region note",
      stagedAsset,
    });

    expect(registerAsset).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: "session", id: "session-1" },
      asset: stagedAsset,
    }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      bodyMarkdown: "Region note",
      stagedAssetIds: ["asset-region-1"],
    }));
    expect(registerAsset.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
  });

  it("registers new region evidence before retargeting and keeps content out of the target mutation", async () => {
    const original = item("session", "session-1", "a", "annotation-region", 1, "Keep this body");
    const retargetedItem: WebAnnotationItem = {
      ...original,
      annotation: {
        ...original.annotation,
        target: { ...target, rect: { x: 10, y: 12, width: 90, height: 70 } },
        revision: 2,
      },
    };
    const registerAsset = vi.fn().mockResolvedValue(undefined);
    const retarget = vi.fn().mockResolvedValue(detail(retargetedItem));
    const store = createWebAnnotationStore(client({
      list: vi.fn().mockResolvedValue(page(original)),
      registerAsset,
      retarget,
    }));
    await store.getState().activatePage(activation(
      original.resource.scope,
      original.resource.urlNormalized,
      firstSurface,
      "navigation-1",
    ));
    const stagedAsset = {
      assetId: "web-capture-11111111111111111111111111111111",
      kind: "staged" as const,
      mimeType: "image/png" as const,
      width: 90,
      height: 70,
      byteLength: 512,
      sha256: "b".repeat(64),
      expiresAt: "2026-07-22T01:00:00Z",
    };
    const replacement = retargetedItem.annotation.target;

    await store.getState().retargetAnnotation(original.annotation.id, {
      expectedRevision: 1,
      target: replacement,
      stagedAsset,
    });

    expect(registerAsset).toHaveBeenCalledWith(expect.objectContaining({
      scope: original.resource.scope,
      asset: stagedAsset,
    }));
    expect(retarget).toHaveBeenCalledWith(original.annotation.id, {
      expectedRevision: 1,
      target: replacement,
      stagedAssetIds: [stagedAsset.assetId],
    });
    expect(retarget.mock.calls[0][1]).not.toHaveProperty("bodyMarkdown");
    expect(retarget.mock.calls[0][1]).not.toHaveProperty("tags");
    expect(registerAsset.mock.invocationCallOrder[0]).toBeLessThan(retarget.mock.invocationCallOrder[0]);
    expect(activeEntry(store).items[0].annotation.bodyMarkdown).toBe("Keep this body");
  });

  it("preserves cached records when a refresh fails", async () => {
    const original = item("session", "session-1", "a", "annotation-1");
    const list = vi.fn()
      .mockResolvedValueOnce(page(original))
      .mockRejectedValueOnce(new Error("offline"));
    const store = createWebAnnotationStore(client({ list }));
    await store.getState().activatePage(activation(
      original.resource.scope,
      original.resource.urlNormalized,
      firstSurface,
      "navigation-1",
    ));

    await store.getState().reload();

    expect(activeEntry(store)).toMatchObject({ status: "ready", refreshing: false, error: "offline" });
    expect(activeEntry(store).items[0].annotation.id).toBe("annotation-1");
  });
});

function client(overrides: Partial<WebAnnotationClient>): WebAnnotationClient {
  return {
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    get: vi.fn(),
    create: vi.fn(),
    patch: vi.fn(),
    retarget: vi.fn(),
    delete: vi.fn(),
    registerAsset: vi.fn(),
    discardAsset: vi.fn(),
    cloneEvidence: vi.fn(),
    ...overrides,
  };
}

function activation(
  scope: WebAnnotationScope,
  url: string,
  surface: BrowserSurfaceRef,
  navigationId: string,
) {
  return {
    scope,
    url,
    title: "Article",
    canonicalUrl: null,
    profileMode: "persistent" as const,
    surface,
    navigationId,
  };
}

function item(
  scopeKind: "session" | "workspace",
  scopeId: string,
  keyCharacter: string,
  annotationId: string,
  revision = 1,
  bodyMarkdown = "Body",
): WebAnnotationItem {
  const resourceId = `resource-${scopeKind}-${keyCharacter}`;
  return {
    resource: {
      id: resourceId,
      scope: { kind: scopeKind, id: scopeId },
      normalizationVersion: 1,
      urlKey: keyCharacter.repeat(64),
      urlNormalized: "https://example.test/article",
      documentUrl: "https://example.test/article",
      canonicalUrl: null,
      origin: "https://example.test",
      title: "Article",
      createdAt: "2026-07-22T00:00:00Z",
      updatedAt: "2026-07-22T00:00:00Z",
    },
    annotation: {
      id: annotationId,
      resourceId,
      targetSchemaVersion: 1,
      target,
      bodyMarkdown,
      tags: [],
      properties: [],
      revision,
      createdAt: "2026-07-22T00:00:00Z",
      updatedAt: "2026-07-22T00:00:00Z",
    },
  };
}

function detail(value: WebAnnotationItem): WebAnnotationDetail {
  return { ...value, targetHistory: [], assets: [] };
}

function page(value: WebAnnotationItem): WebAnnotationPage {
  return { items: [value], nextCursor: null };
}

function activeEntry(store: ReturnType<typeof createWebAnnotationStore>) {
  const active = store.getState().activePage;
  if (!active) throw new Error("Expected active page");
  const entry = store.getState().pages[active.pageKey];
  if (!entry) throw new Error("Expected active page entry");
  return entry;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function revisionConflict(current: WebAnnotationItem, expectedRevision: number): RuntimeHttpError {
  return new RuntimeHttpError({
    code: "web_annotation_revision_conflict",
    message: "changed",
    method: "PATCH",
    path: "/api/web-annotations/annotation-1",
    status: 409,
    body: null,
    rawText: "",
    details: {
      expected_revision: expectedRevision,
      current: toApiItem(current),
    },
  });
}

function toApiItem(value: WebAnnotationItem) {
  return {
    resource: {
      id: value.resource.id,
      scope: value.resource.scope,
      normalization_version: value.resource.normalizationVersion,
      url_key: value.resource.urlKey,
      url_normalized: value.resource.urlNormalized,
      document_url: value.resource.documentUrl,
      canonical_url: value.resource.canonicalUrl,
      origin: value.resource.origin,
      title: value.resource.title,
      created_at: value.resource.createdAt,
      updated_at: value.resource.updatedAt,
    },
    annotation: {
      id: value.annotation.id,
      resource_id: value.annotation.resourceId,
      target_schema_version: 1,
      target: {
        type: "region",
        rect: target.rect,
        viewport: target.viewport,
        scroll: target.scroll,
        relative_element: null,
        frame: { url: target.frame.url, name: null, index_path: [], parent_element_path: null },
      },
      body_markdown: value.annotation.bodyMarkdown,
      tags: value.annotation.tags,
      properties: value.annotation.properties,
      revision: value.annotation.revision,
      created_at: value.annotation.createdAt,
      updated_at: value.annotation.updatedAt,
    },
  };
}
