import type { DocumentCoordinateRect } from "../navigation/types";

export interface ConnectorGeometryInput {
  readonly cardX: number;
  readonly cardY: number;
  readonly documentEdgeX: number;
  readonly edgeY?: number;
  readonly fanOutX: number;
  readonly fragments: readonly DocumentCoordinateRect[];
  readonly open: boolean;
  readonly resolved: boolean;
}

export interface ConnectorEdgePortInput {
  readonly id: string;
  readonly preferredY: number;
  readonly targetY: number;
}

export interface ConnectorPoint {
  readonly x: number;
  readonly y: number;
}

export interface ConnectorGeometry {
  readonly card: ConnectorPoint;
  readonly dropY: number;
  readonly edgeY: number;
  readonly marker: ConnectorPoint;
  readonly path: string;
  readonly points: readonly ConnectorPoint[];
}

const LINE_DROP = 6;
const DEFAULT_EDGE_PORT_GAP = 4;

export function connectorGeometry(input: ConnectorGeometryInput): ConnectorGeometry | null {
  if (!input.open || !input.resolved || input.fragments.length === 0) {
    return null;
  }
  const fragment = lastLineRightFragment(input.fragments);
  const documentEdgeX = finite(input.documentEdgeX, "documentEdgeX");
  const fanOutX = finite(input.fanOutX, "fanOutX");
  const cardX = finite(input.cardX, "cardX");
  const cardY = finite(input.cardY, "cardY");
  if (fanOutX < documentEdgeX || cardX < fanOutX) {
    throw new RangeError("Connector x coordinates must move monotonically from document to rail");
  }
  const marker = Object.freeze({
    x: Math.min((fragment.left + fragment.right) / 2, documentEdgeX),
    y: fragment.bottom,
  });
  const dropY = fragment.bottom + LINE_DROP;
  const edgeY = finite(input.edgeY ?? dropY, "edgeY");
  const card = Object.freeze({ x: cardX, y: cardY });
  const points = Object.freeze([
    marker,
    Object.freeze({ x: marker.x, y: dropY }),
    Object.freeze({ x: documentEdgeX, y: dropY }),
    Object.freeze({ x: fanOutX, y: edgeY }),
    card,
  ]);
  return Object.freeze({
    card,
    dropY,
    edgeY,
    marker,
    path: points.map((point, index) => `${index === 0 ? "M" : "L"} ${number(point.x)} ${number(point.y)}`).join(" "),
    points,
  });
}

export function connectorPreferredEdgeY(
  fragments: readonly DocumentCoordinateRect[],
): number {
  return lastLineRightFragment(fragments).bottom + LINE_DROP;
}

export function spreadConnectorEdgePorts(
  items: readonly ConnectorEdgePortInput[],
  minimumGap = DEFAULT_EDGE_PORT_GAP,
): Readonly<Record<string, number>> {
  if (!Number.isFinite(minimumGap) || minimumGap < 0) {
    throw new RangeError("Connector edge port gap must be finite and non-negative");
  }
  const ordered = [...items]
    .map((item) => ({
      id: item.id.trim(),
      preferredY: finite(item.preferredY, `preferredY:${item.id}`),
      targetY: finite(item.targetY, `targetY:${item.id}`),
    }))
    .sort((left, right) =>
      left.preferredY - right.preferredY
      || left.targetY - right.targetY
      || left.id.localeCompare(right.id));
  const ports: Record<string, number> = {};
  let previousY = Number.NEGATIVE_INFINITY;
  for (const item of ordered) {
    if (!item.id) {
      throw new Error("Connector edge port id cannot be empty");
    }
    const edgeY = Math.max(item.preferredY, previousY + minimumGap);
    ports[item.id] = edgeY;
    previousY = edgeY;
  }
  return Object.freeze(ports);
}

export function lastLineRightFragment(
  fragments: readonly DocumentCoordinateRect[],
): DocumentCoordinateRect {
  if (fragments.length === 0) {
    throw new Error("Connector requires at least one marker fragment");
  }
  return [...fragments]
    .map(validateRect)
    .sort((left, right) =>
      right.top - left.top
      || right.bottom - left.bottom
      || right.right - left.right)[0];
}

function validateRect(rect: DocumentCoordinateRect): DocumentCoordinateRect {
  if ([rect.left, rect.right, rect.top, rect.bottom].some((value) => !Number.isFinite(value))) {
    throw new RangeError("Connector fragment coordinates must be finite");
  }
  if (rect.right < rect.left || rect.bottom < rect.top) {
    throw new RangeError("Connector fragment rectangle is inverted");
  }
  return rect;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
  return value;
}

function number(value: number): string {
  return Number(value.toFixed(2)).toString();
}
