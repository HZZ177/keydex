import { describe, expect, it } from "vitest";

import { layoutAnnotationLane } from "@/renderer/features/annotations/layout/AnnotationLaneLayout";

describe("AnnotationLaneLayout", () => {
  it("aligns a single card connector to its anchor without entering the document section", () => {
    const [card] = layoutAnnotationLane({
      documentHeight: 800,
      reservedTop: 100,
      items: [item("ann", 240, 80)],
    }).placements;

    expect(card.cardY).toBe(216);
    expect(card.connectorY).toBe(240);
  });

  it("pushes dense cards downward without overlap", () => {
    const cards = layoutAnnotationLane({
      documentHeight: 1000,
      reservedTop: 80,
      gap: 12,
      items: [item("a", 200, 100), item("b", 205, 90), item("c", 210, 110)],
    }).placements;

    expect(cards[1].cardY).toBeGreaterThanOrEqual(cards[0].cardY + cards[0].height + 12);
    expect(cards[2].cardY).toBeGreaterThanOrEqual(cards[1].cardY + cards[1].height + 12);
  });

  it("orders equal anchors by createdAt then id", () => {
    const cards = layoutAnnotationLane({
      documentHeight: 600,
      reservedTop: 0,
      items: [
        { ...item("b", 100, 50), createdAt: "2026-01-01" },
        { ...item("a", 100, 50), createdAt: "2026-01-01" },
        { ...item("old", 100, 50), createdAt: "2025-01-01" },
      ],
    }).placements;

    expect(cards.map((card) => card.id)).toEqual(["old", "a", "b"]);
  });

  it("pushes upward from the bottom while preserving gaps and bounds", () => {
    const cards = layoutAnnotationLane({
      documentHeight: 400,
      reservedTop: 20,
      bottomPadding: 16,
      items: [item("a", 330, 80), item("b", 350, 70)],
    }).placements;

    expect(cards.at(-1)!.cardY + cards.at(-1)!.height).toBe(384);
    expect(cards[0].cardY + cards[0].height + 12).toBeLessThanOrEqual(cards[1].cardY);
    expect(cards[0].cardY).toBeGreaterThanOrEqual(20);
  });

  it("recomputes deterministically when measured card heights change", () => {
    const input = {
      documentHeight: 700,
      reservedTop: 80,
      items: [item("a", 200, 60), item("b", 210, 60)],
    };
    const first = layoutAnnotationLane(input).placements;
    const second = layoutAnnotationLane(input).placements;
    const resized = layoutAnnotationLane({ ...input, items: [item("a", 200, 120), item("b", 210, 60)] }).placements;

    expect(second).toEqual(first);
    expect(resized[1].cardY).toBeGreaterThan(first[1].cardY);
  });

  it("maintains layout invariants for a deterministic randomized dense set", () => {
    let seed = 73013;
    const random = () => {
      seed = (seed * 48271) % 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const items = Array.from({ length: 30 }, (_, index) =>
      item(`ann-${index}`, 100 + random() * 3600, 40 + random() * 100));
    const cards = layoutAnnotationLane({
      documentHeight: 5000,
      reservedTop: 120,
      items,
    }).placements;

    cards.forEach((card, index) => {
      expect(card.cardY).toBeGreaterThanOrEqual(120);
      expect(card.cardY + card.height).toBeLessThanOrEqual(4984);
      if (index > 0) {
        expect(card.cardY).toBeGreaterThanOrEqual(cards[index - 1].cardY + cards[index - 1].height + 12);
      }
    });
  });

  it("grows the invasive document canvas when dense cards exceed the content height", () => {
    const layout = layoutAnnotationLane({
      documentHeight: 200,
      reservedTop: 50,
      items: [item("a", 60, 100), item("b", 70, 100)],
    });

    expect(layout.documentHeight).toBe(278);
    expect(layout.placements[0].cardY).toBeGreaterThanOrEqual(50);
    expect(layout.placements[1].cardY).toBeGreaterThanOrEqual(layout.placements[0].cardY + 112);
    expect(layout.placements[1].cardY + layout.placements[1].height).toBe(262);
  });
});

function item(id: string, anchorY: number, height: number) {
  return { id, anchorY, height, createdAt: "2026-01-01" };
}
