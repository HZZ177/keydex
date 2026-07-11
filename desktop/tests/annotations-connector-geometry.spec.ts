import { describe, expect, it } from "vitest";

import {
  connectorPreferredEdgeY,
  connectorGeometry,
  lastLineRightFragment,
  spreadConnectorEdgePorts,
} from "@/renderer/features/annotations/layout/ConnectorGeometry";

describe("ConnectorGeometry", () => {
  it("starts below the rightmost fragment on the last visual line", () => {
    const fragments = [
      rect(20, 20, 120, 40),
      rect(20, 60, 90, 80),
      rect(100, 60, 180, 80),
    ];

    expect(lastLineRightFragment(fragments)).toEqual(fragments[2]);
    expect(connectorGeometry(input(fragments))).toMatchObject({
      marker: { x: 140, y: 80 },
      dropY: 86,
      card: { x: 360, y: 220 },
    });
  });

  it("routes through line space and fans diagonally from the document edge to the card", () => {
    const result = connectorGeometry(input([rect(20, 20, 120, 40)]));

    expect(result?.points).toEqual([
      { x: 70, y: 40 },
      { x: 70, y: 46 },
      { x: 260, y: 46 },
      { x: 268, y: 46 },
      { x: 360, y: 220 },
    ]);
    expect(result?.path).toBe("M 70 40 L 70 46 L 260 46 L 268 46 L 360 220");
  });

  it("keeps the document-side route stable when a card moves", () => {
    const base = input([rect(20, 20, 120, 40)]);
    const first = connectorGeometry(base)!;
    const moved = connectorGeometry({ ...base, cardY: 340 })!;

    expect(moved.points.slice(0, 4)).toEqual(first.points.slice(0, 4));
    expect(moved.card.y).toBe(340);
    expect(moved.path).not.toBe(first.path);
  });

  it("does not emit paths while closed or unresolved", () => {
    const base = input([rect(20, 20, 120, 40)]);

    expect(connectorGeometry({ ...base, open: false })).toBeNull();
    expect(connectorGeometry({ ...base, resolved: false })).toBeNull();
    expect(connectorGeometry({ ...base, fragments: [] })).toBeNull();
  });

  it("spreads nearby document-edge ports monotonically before diagonal fan-out", () => {
    expect(connectorPreferredEdgeY([rect(20, 20, 120, 40)])).toBe(46);
    expect(spreadConnectorEdgePorts([
      { id: "a", preferredY: 46, targetY: 100 },
      { id: "b", preferredY: 46, targetY: 220 },
      { id: "c", preferredY: 48, targetY: 340 },
      { id: "d", preferredY: 80, targetY: 460 },
    ])).toEqual({ a: 46, b: 50, c: 54, d: 80 });

    const result = connectorGeometry({
      ...input([rect(20, 20, 120, 40)]),
      edgeY: 54,
    });
    expect(result?.points[3]).toEqual({ x: 268, y: 54 });
    expect(result?.edgeY).toBe(54);
  });

  it("is deterministic, clips offscreen marker ends, and rejects reversed layout boundaries", () => {
    const value = input([rect(20, 20, 120, 40)]);
    expect(connectorGeometry(value)).toEqual(connectorGeometry(value));
    expect(connectorGeometry({ ...value, fragments: [rect(300, 20, 400, 40)] })?.marker.x).toBe(260);
    expect(() => connectorGeometry({ ...value, fanOutX: 250 })).toThrow("monotonically");
  });
});

function input(fragments: ReturnType<typeof rect>[]) {
  return {
    cardX: 360,
    cardY: 220,
    documentEdgeX: 260,
    fanOutX: 268,
    fragments,
    open: true,
    resolved: true,
  };
}

function rect(left: number, top: number, right: number, bottom: number) {
  return { left, top, right, bottom };
}
