import { describe, expect, it } from "vitest";

import {
  DocumentGeometryLedger,
  markerAnchorPoint,
  normalizeDocumentGeometry,
  sameDocumentGeometry,
} from "@/renderer/features/annotations/layout/DocumentGeometry";

describe("DocumentGeometrySnapshot", () => {
  it("normalizes CodeMirror and Virtuoso inputs into the same document coordinate protocol", () => {
    const source = normalizeDocumentGeometry("source", "text-r1", geometry(1));
    const markdown = normalizeDocumentGeometry("markdown", "text-r1", geometry(1));

    expect(source.markers.ann).toEqual(markdown.markers.ann);
    expect(source).toMatchObject({ viewId: "source", textRevision: "text-r1" });
    expect(markdown).toMatchObject({ viewId: "markdown", textRevision: "text-r1" });
    expect(markerAnchorPoint(markdown, "ann")).toEqual({ x: 220, y: 330 });
  });

  it("preserves multi-line fragments and clamps scroll offset to the document extent", () => {
    const snapshot = normalizeDocumentGeometry("source", "r", {
      ...geometry(2),
      documentHeight: 500,
      scrollOffset: 900,
      viewportHeight: 120,
      markers: {
        ann: [
          { left: 10, right: 100, top: 20, bottom: 40 },
          { left: 10, right: 80, top: 45, bottom: 65 },
        ],
      },
    });

    expect(snapshot.scrollOffset).toBe(380);
    expect(snapshot.markers.ann).toHaveLength(2);
  });

  it("commits scroll, resize, and measurement snapshots atomically by revision", () => {
    const ledger = new DocumentGeometryLedger("text-r1");

    expect(ledger.commit("markdown", "text-r1", geometry(1))).not.toBeNull();
    expect(ledger.commit("markdown", "text-r1", geometry(1))).toBeNull();
    expect(ledger.commit("markdown", "text-r1", { ...geometry(2), viewportHeight: 420 }))
      .toMatchObject({ revision: 2, viewportHeight: 420 });
    expect(ledger.get("markdown")?.revision).toBe(2);
  });

  it("treats revision and scroll-only changes as the same document geometry", () => {
    const first = normalizeDocumentGeometry("markdown", "text-r1", geometry(1));
    const scrolled = normalizeDocumentGeometry("markdown", "text-r1", {
      ...geometry(2),
      scrollOffset: 500,
    });
    const moved = normalizeDocumentGeometry("markdown", "text-r1", {
      ...geometry(3),
      markers: { ann: [{ left: 100, right: 220, top: 302, bottom: 362 }] },
    });

    expect(sameDocumentGeometry(first, scrolled)).toBe(true);
    expect(sameDocumentGeometry(first, moved)).toBe(false);
  });

  it("rejects snapshots from obsolete text revisions and resets both views together", () => {
    const ledger = new DocumentGeometryLedger("text-r1");
    ledger.commit("source", "text-r1", geometry(1));

    expect(ledger.commit("markdown", "text-old", geometry(3))).toBeNull();
    ledger.reset("text-r2");
    expect(ledger.get("source")).toBeNull();
    expect(ledger.commit("markdown", "text-r1", geometry(4))).toBeNull();
    expect(ledger.commit("markdown", "text-r2", geometry(1))).not.toBeNull();
  });

  it("rejects invalid and inverted coordinates", () => {
    expect(() => normalizeDocumentGeometry("source", "r", {
      ...geometry(1),
      markers: { ann: [{ left: 20, right: 10, top: 0, bottom: 10 }] },
    })).toThrow("inverted");
    expect(() => normalizeDocumentGeometry("source", "r", {
      ...geometry(1),
      documentHeight: Number.NaN,
    })).toThrow("documentHeight");
  });
});

function geometry(revision: number) {
  return {
    documentHeight: 1000,
    markers: { ann: [{ left: 100, right: 220, top: 300, bottom: 360 }] },
    revision,
    scrollOffset: 200,
    viewportHeight: 400,
    viewportWidth: 800,
  };
}
