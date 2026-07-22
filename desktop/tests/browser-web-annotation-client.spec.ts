import { describe, expect, it, vi } from "vitest";

import { createWebAnnotationClient } from "@/renderer/features/browser/annotations";
import type { WebRegionTarget } from "@/renderer/features/browser/runtime";
import { HttpClient } from "@/runtime/httpClient";

const regionTarget: WebRegionTarget = {
  type: "region",
  rect: { x: 10, y: 20, width: 100, height: 80 },
  viewport: { width: 800, height: 600 },
  scroll: { x: 0, y: 200 },
  relativeElement: {
    path: [{ childIndex: 2, shadowRoot: false }],
    rect: { x: 0, y: 0, width: 400, height: 300 },
    tag: "article",
    role: "article",
    accessibleName: "Release card",
    textSummary: "Release notes",
    stableAttributes: [{ name: "id", value: "release-card" }],
  },
  visual: {
    fingerprintVersion: 1,
    localDigest: "fnv1a32:0123abcd",
    perceptualHash: "dhash64:0123456789abcdef",
  },
  frame: {
    url: "https://example.test/frame",
    name: "article-frame",
    indexPath: [0],
    parentElementPath: [{ childIndex: 1, shadowRoot: false }],
  },
};

describe("WebAnnotationClient", () => {
  it("maps strict API DTOs at the boundary and forwards pagination cancellation", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(apiPage()));
    const client = createWebAnnotationClient(new HttpClient({
      baseUrl: "http://127.0.0.1:8765",
      fetcher,
    }));
    const controller = new AbortController();

    const page = await client.list({
      scope: { kind: "session", id: "session one" },
      url: "https://example.test/article?query=one",
      cursor: "cursor:1",
      limit: 25,
      signal: controller.signal,
    });

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("scope_kind=session");
    expect(url).toContain("scope_id=session+one");
    expect(url).toContain("url=https%3A%2F%2Fexample.test%2Farticle%3Fquery%3Done");
    expect(url).toContain("cursor=cursor%3A1");
    expect(init.signal).toBe(controller.signal);
    expect(page.nextCursor).toBe("next:cursor");
    expect(page.items[0]).toMatchObject({
      resource: { urlKey: "a".repeat(64), documentUrl: "https://example.test/article" },
      annotation: {
        bodyMarkdown: "Body",
        target: {
          type: "region",
          relativeElement: {
            path: [{ childIndex: 2, shadowRoot: false }],
            accessibleName: "Release card",
            stableAttributes: [{ name: "id", value: "release-card" }],
          },
          visual: {
            fingerprintVersion: 1,
            localDigest: "fnv1a32:0123abcd",
            perceptualHash: "dhash64:0123456789abcdef",
          },
          frame: { indexPath: [0], parentElementPath: [{ childIndex: 1 }] },
        },
      },
    });
  });

  it("serializes bridge targets and uses revision headers for update/retarget", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse(apiDetail(), 201))
      .mockResolvedValueOnce(jsonResponse(apiDetail({ revision: 2 })))
      .mockResolvedValueOnce(jsonResponse(apiDetail({ revision: 3 })));
    const client = createWebAnnotationClient(new HttpClient({
      baseUrl: "http://127.0.0.1:8765",
      fetcher,
    }));

    await client.create({
      scope: { kind: "workspace", id: "workspace-1" },
      source: {
        url: "https://example.test/article",
        title: "Article",
        canonicalUrl: "https://example.test/canonical",
        profileMode: "persistent",
      },
      target: regionTarget,
      bodyMarkdown: "Body",
      tags: ["review"],
      stagedAssetIds: ["web-capture-00000000000000000000000000000000"],
    });
    await client.patch("annotation/1", {
      expectedRevision: 1,
      bodyMarkdown: "Updated",
    });
    await client.retarget("annotation/1", {
      expectedRevision: 2,
      target: regionTarget,
      stagedAssetIds: ["web-capture-11111111111111111111111111111111"],
    });

    const createInit = fetcher.mock.calls[0][1] as RequestInit;
    const createBody = JSON.parse(String(createInit.body)) as Record<string, unknown>;
    expect(createBody).toMatchObject({
      schema_version: 1,
      source: {
        canonical_url: "https://example.test/canonical",
        profile_mode: "persistent",
      },
      target: {
        type: "region",
        relative_element: {
          path: [{ child_index: 2, shadow_root: false }],
          accessible_name: "Release card",
          stable_attributes: [{ name: "id", value: "release-card" }],
        },
        visual: {
          fingerprint_version: 1,
          local_digest: "fnv1a32:0123abcd",
          perceptual_hash: "dhash64:0123456789abcdef",
        },
        frame: {
          index_path: [0],
          parent_element_path: [{ child_index: 1, shadow_root: false }],
        },
      },
      staged_asset_ids: ["web-capture-00000000000000000000000000000000"],
    });
    expect(fetcher.mock.calls[1][0]).toContain("annotation%2F1");
    expect((fetcher.mock.calls[1][1] as RequestInit).headers).toMatchObject({ "If-Match": "1" });
    expect((fetcher.mock.calls[2][1] as RequestInit).headers).toMatchObject({ "If-Match": "2" });
    expect(JSON.parse(String((fetcher.mock.calls[2][1] as RequestInit).body))).toMatchObject({
      expected_revision: 2,
      reason: "user_retarget",
      staged_asset_ids: ["web-capture-11111111111111111111111111111111"],
    });
  });

  it("clones region evidence into an immutable session attachment", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse(apiEvidenceClone()));
    const client = createWebAnnotationClient(new HttpClient({
      baseUrl: "http://127.0.0.1:8765",
      fetcher,
    }));
    const controller = new AbortController();

    const result = await client.cloneEvidence(
      "annotation/1",
      "web-capture-00000000000000000000000000000001",
      {
        sessionId: "session-1",
        contextDigest: `sha256:${"a".repeat(64)}`,
        signal: controller.signal,
      },
    );

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("annotation%2F1/evidence/web-capture-");
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(String(init.body))).toEqual({
      schema_version: 1,
      session_id: "session-1",
      context_digest: `sha256:${"a".repeat(64)}`,
    });
    expect(result).toMatchObject({
      schemaVersion: 1,
      reused: false,
      attachment: {
        attachmentId: "attachment-1",
        sessionId: "session-1",
        source: "web_annotation",
        mimeType: "image/png",
      },
    });
    expect(Object.isFrozen(result.attachment)).toBe(true);
  });
});

function apiEvidenceClone() {
  return {
    schema_version: 1,
    annotation_id: "annotation/1",
    asset_id: "web-capture-00000000000000000000000000000001",
    context_digest: `sha256:${"a".repeat(64)}`,
    reused: false,
    attachment: {
      id: "attachment-1",
      attachment_id: "attachment-1",
      session_id: "session-1",
      user_id: "user-1",
      type: "image",
      source: "web_annotation",
      name: "web-annotation.png",
      path: "D:/data/attachments/attachment-1/web-annotation.png",
      mime_type: "image/png",
      size: 128,
      created_at: "2026-07-22T08:00:00Z",
      updated_at: "2026-07-22T08:00:00Z",
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function apiPage() {
  return { items: [apiItem()], next_cursor: "next:cursor" };
}

function apiDetail(overrides: { revision?: number } = {}) {
  return { ...apiItem(overrides), target_history: [], assets: [] };
}

function apiItem(overrides: { revision?: number } = {}) {
  return {
    resource: {
      id: "resource-1",
      scope: { kind: "session", id: "session one" },
      normalization_version: 1,
      url_key: "a".repeat(64),
      url_normalized: "https://example.test/article",
      document_url: "https://example.test/article",
      canonical_url: null,
      origin: "https://example.test",
      title: "Article",
      created_at: "2026-07-22T00:00:00Z",
      updated_at: "2026-07-22T00:00:00Z",
    },
    annotation: {
      id: "annotation-1",
      resource_id: "resource-1",
      target_schema_version: 1,
      target: {
        type: "region",
        rect: regionTarget.rect,
        viewport: regionTarget.viewport,
        scroll: regionTarget.scroll,
        relative_element: {
          path: [{ child_index: 2, shadow_root: false }],
          rect: regionTarget.relativeElement!.rect,
          tag: "article",
          role: "article",
          accessible_name: "Release card",
          text_summary: "Release notes",
          stable_attributes: [{ name: "id", value: "release-card" }],
        },
        visual: {
          fingerprint_version: 1,
          local_digest: "fnv1a32:0123abcd",
          perceptual_hash: "dhash64:0123456789abcdef",
        },
        frame: {
          url: "https://example.test/frame",
          name: "article-frame",
          index_path: [0],
          parent_element_path: [{ child_index: 1, shadow_root: false }],
        },
      },
      body_markdown: "Body",
      tags: ["review"],
      properties: [],
      revision: overrides.revision ?? 1,
      created_at: "2026-07-22T00:00:00Z",
      updated_at: "2026-07-22T00:00:00Z",
    },
  };
}
