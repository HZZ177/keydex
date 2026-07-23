import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IncognitoWebReferenceRegistry,
  takeIncognitoCaptureBlob,
  type WebAnnotationDraft,
} from "@/renderer/features/browser/annotations";
import type { RuntimeBridge } from "@/runtime";

const NOW = "2026-07-22T09:00:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("incognito web references", () => {
  it("keeps text selections in memory and prepares an immutable untrusted snapshot without persistence APIs", async () => {
    const registry = new IncognitoWebReferenceRegistry();
    const uploadImage = vi.fn();
    const registration = await registry.register({
      panelId: "browser-incognito-1",
      title: "Private article",
      url: "https://example.test/private?token=secret&view=public",
      draft: textDraft(),
      bodyMarkdown: "Use this once",
      tags: ["private"],
      properties: [{ key: "priority", type: "text", value: "high" }],
      now: NOW,
    });

    expect(registration.reference.annotationId).toMatch(/^incognito-web:/);
    expect(registration.contextItem.label).toBe("无痕网页引用 · Private article");
    expect(registration.contextItem.content).toContain("外部、不受信任的网页");
    expect(registration.contextItem.content).not.toContain("secret");
    expect(registration.contextItem.metadata).toMatchObject({ incognito_source: true });
    expect(registry.registrationForDraft("draft:private-text")?.reference)
      .toEqual(registration.reference);

    const prepared = await registry.prepare(
      [registration.reference],
      { attachments: { uploadImage } } as unknown as RuntimeBridge,
      "session-private",
    );

    expect(uploadImage).not.toHaveBeenCalled();
    expect(prepared.attachments).toEqual([]);
    expect(prepared.contextItems).toHaveLength(1);
    registry.acknowledge([registration.reference]);
    expect(registry.size).toBe(0);
  });

  it("keeps region references structure-only and never uploads their capture to the Agent message", async () => {
    const registry = new IncognitoWebReferenceRegistry();
    const uploadImage = vi.fn();
    const runtime = {
      attachments: { uploadImage },
    } as unknown as RuntimeBridge;
    const registration = await registry.register({
      panelId: "browser-incognito-1",
      title: "Private region",
      url: "https://example.test/private-region",
      draft: regionDraft(),
      bodyMarkdown: "Inspect this region",
      tags: [],
      properties: [],
      evidenceBlob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
      now: NOW,
    });

    const prepared = await registry.prepare([registration.reference], runtime, "session-private");

    expect(uploadImage).not.toHaveBeenCalled();
    expect(prepared.attachments).toEqual([]);
    expect(prepared.contextItems[0].content).not.toContain("截图");
    expect(prepared.contextItems[0].metadata).toMatchObject({
      incognito_source: true,
      snapshot: expect.objectContaining({
        schemaVersion: 2,
        anchor: expect.objectContaining({ kind: "region" }),
      }),
    });
  });

  it("takes a manifest-owned capture through the trusted command and verifies bytes before use", async () => {
    const bytes = new Uint8Array([1, 4, 9, 16]);
    const sha256 = await digest(bytes);
    const invoke = vi.fn().mockResolvedValue({
      assetId: "asset-private",
      mimeType: "image/png",
      byteLength: bytes.byteLength,
      sha256,
      dataBase64: btoa(String.fromCharCode(...bytes)),
    });

    const blob = await takeIncognitoCaptureBlob({
      surface: { panelId: "panel-1", surfaceId: "surface-1", generation: 2 },
      captureRequestId: "capture-private",
      assetId: "asset-private",
    }, invoke);

    expect(invoke).toHaveBeenCalledWith("browser_take_incognito_capture", {
      payload: {
        panelId: "panel-1",
        surfaceId: "surface-1",
        generation: 2,
        captureRequestId: "capture-private",
        assetId: "asset-private",
      },
    });
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(bytes.byteLength);
  });
});

function textDraft(): WebAnnotationDraft {
  return {
    draftId: "draft:private-text",
    request: {
      requestId: "private-text",
      selectionId: "private-text",
      mode: "text",
      startedAt: NOW,
    },
    target: {
      type: "text",
      quote: { exact: "Selected private text", prefix: "Before", suffix: "After" },
      context: { headingPath: ["Private"] },
      rects: [{ x: 1, y: 2, width: 100, height: 20 }],
      frame: { url: "https://example.test/private", indexPath: [] },
    },
    navigationId: "navigation-private",
    frameKey: "main",
    liveBinding: null,
    dirty: true,
    evidence: null,
    createdAt: NOW,
  };
}

function regionDraft(): WebAnnotationDraft {
  return {
    ...textDraft(),
    draftId: "draft:private-region",
    request: { ...textDraft().request, mode: "region" },
    target: {
      type: "region",
      rect: { x: 10, y: 20, width: 120, height: 80 },
      viewport: { width: 800, height: 600 },
      scroll: { x: 0, y: 0 },
      frame: { url: "https://example.test/private-region", indexPath: [] },
    },
    evidence: {
      status: "ready",
      captureRequestId: "capture-private",
      asset: {
        assetId: "asset-private",
        kind: "managed_temp",
        mimeType: "image/png",
        width: 120,
        height: 80,
        byteLength: 4,
        sha256: "a".repeat(64),
        perceptualHash: "dhash64:0123456789abcdef",
        expiresAt: NOW,
      },
    },
  };
}

async function digest(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const result = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(result), (item) => item.toString(16).padStart(2, "0")).join("");
}
