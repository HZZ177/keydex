import { describe, expect, it, vi } from "vitest";

import {
  WebAnnotationPanelRegistry,
  WebAnnotationSendCoordinator,
  type SelectedWebAnnotationReference,
  type WebAnnotationDetail,
} from "@/renderer/features/browser/annotations";

describe("WebAnnotationSendCoordinator", () => {
  it("reuses a frozen snapshot after a transport failure until success is acknowledged", async () => {
    let revision = 1;
    const get = vi.fn().mockImplementation(async () => detail(revision));
    const coordinator = new WebAnnotationSendCoordinator({
      client: { get },
      panelRegistry: new WebAnnotationPanelRegistry(),
      resolutionTimeoutMs: 0,
      now: () => "2026-07-22T08:01:00Z",
    });
    const references = [reference()];

    const first = await coordinator.prepare(references);
    revision = 2;
    const retry = await coordinator.prepare(references);

    expect(retry).toBe(first);
    expect(retry.snapshots[0].reference.revision).toBe(1);
    expect(get).toHaveBeenCalledTimes(1);

    coordinator.acknowledge(references);
    const nextSend = await coordinator.prepare(references);
    expect(nextSend).not.toBe(first);
    expect(nextSend.snapshots[0].reference.revision).toBe(2);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight assembly for duplicate concurrent submissions", async () => {
    let resolveDetail!: (value: WebAnnotationDetail) => void;
    const get = vi.fn().mockImplementation(() => new Promise<WebAnnotationDetail>((resolve) => {
      resolveDetail = resolve;
    }));
    const coordinator = new WebAnnotationSendCoordinator({
      client: { get },
      panelRegistry: new WebAnnotationPanelRegistry(),
      resolutionTimeoutMs: 0,
    });
    const references = [reference()];

    const first = coordinator.prepare(references);
    const second = coordinator.prepare(references);
    resolveDetail(detail(1));

    await expect(first).resolves.toBe(await second);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("prewarms once and reuses the completed envelope when a later session sends it", async () => {
    const get = vi.fn().mockResolvedValue(detail(1));
    const coordinator = new WebAnnotationSendCoordinator({
      client: { get },
      panelRegistry: new WebAnnotationPanelRegistry(),
      resolutionTimeoutMs: 60_000,
      now: () => "2026-07-22T08:01:00Z",
    });
    const references = [reference()];

    const prewarmed = await coordinator.prewarm(references);
    const sent = await coordinator.prepare(references, { sessionId: "ses-later" });

    expect(sent).toBe(prewarmed);
    expect(sent.snapshots[0].observation).toMatchObject({
      status: "missing",
      freshness: "captured_only",
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("sends region annotations as structure-only envelopes without screenshot attachments", async () => {
    const get = vi.fn().mockResolvedValue(regionDetail());
    const coordinator = new WebAnnotationSendCoordinator({
      client: { get },
      panelRegistry: new WebAnnotationPanelRegistry(),
      resolutionTimeoutMs: 0,
      now: () => "2026-07-22T08:01:00Z",
    });
    const references = [reference()];

    const prepared = await coordinator.prepare(references, { sessionId: "ses-1" });
    const retry = await coordinator.prepare(references, { sessionId: "ses-1" });

    expect(retry).toBe(prepared);
    expect(prepared.snapshots[0].anchor).toMatchObject({
      kind: "region",
      geometry: {
        viewport: { width: 1280, height: 720 },
        scroll: { x: 0, y: 240 },
      },
    });
    expect(prepared.snapshots[0].anchor.structure.locators.map((locator) => locator.kind))
      .toContain("coordinate_region");
    expect(prepared.markdown).not.toContain("截图");
    expect(prepared.attachments).toEqual([]);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.attachments)).toBe(true);
  });
});

function reference(): SelectedWebAnnotationReference {
  return {
    annotationId: "annotation-1",
    selectedRevision: 1,
    selectedAt: "2026-07-22T08:00:00Z",
    sourcePanelId: "browser-1",
  };
}

function detail(revision: number): WebAnnotationDetail {
  return {
    resource: {
      id: "resource-1",
      scope: { kind: "session", id: "ses-1" },
      normalizationVersion: 1,
      urlKey: "a".repeat(64),
      urlNormalized: "https://example.test/article",
      documentUrl: "https://example.test/article",
      canonicalUrl: null,
      origin: "https://example.test",
      title: "Article",
      createdAt: "2026-07-22T08:00:00Z",
      updatedAt: "2026-07-22T08:00:00Z",
    },
    annotation: {
      id: "annotation-1",
      resourceId: "resource-1",
      targetSchemaVersion: 1,
      target: {
        type: "text",
        quote: { exact: "Selected evidence", prefix: "", suffix: "" },
        position: { start: 0, end: 17, textModelVersion: 1 },
        context: { headingPath: ["Evidence"] },
        rects: [{ x: 10, y: 20, width: 120, height: 18 }],
        frame: { url: "https://example.test/article", indexPath: [] },
      },
      bodyMarkdown: `Revision ${revision}`,
      tags: [],
      properties: [],
      revision,
      createdAt: "2026-07-22T08:00:00Z",
      updatedAt: "2026-07-22T08:00:00Z",
    },
    targetHistory: [],
    assets: [],
  };
}

function regionDetail(): WebAnnotationDetail {
  const base = detail(1);
  return {
    ...base,
    annotation: {
      ...base.annotation,
      target: {
        type: "region",
        rect: { x: 10, y: 20, width: 120, height: 80 },
        viewport: { width: 1280, height: 720 },
        scroll: { x: 0, y: 240 },
        frame: { url: "https://example.test/article", indexPath: [] },
      },
    },
    assets: [
      {
        id: "web-capture-00000000000000000000000000000001",
        resourceId: "resource-1",
        annotationId: "annotation-1",
        assetKind: "region_screenshot",
        state: "attached",
        storagePath: "browser/captures/staged/old/capture.png",
        mimeType: "image/png",
        sizeBytes: 64,
        sha256: "a".repeat(64),
        width: 120,
        height: 80,
        expiresAt: null,
        createdAt: "2026-07-22T07:00:00Z",
        updatedAt: "2026-07-22T07:00:00Z",
      },
      {
        id: "web-capture-00000000000000000000000000000002",
        resourceId: "resource-1",
        annotationId: "annotation-1",
        assetKind: "region_screenshot",
        state: "attached",
        storagePath: "browser/captures/staged/current/capture.png",
        mimeType: "image/png",
        sizeBytes: 128,
        sha256: "b".repeat(64),
        width: 120,
        height: 80,
        expiresAt: null,
        createdAt: "2026-07-22T08:00:00Z",
        updatedAt: "2026-07-22T08:00:00Z",
      },
    ],
  };
}
