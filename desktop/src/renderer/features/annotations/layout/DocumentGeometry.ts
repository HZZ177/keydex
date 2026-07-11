import type {
  AnnotationViewGeometrySnapshot,
  AnnotationViewId,
  DocumentCoordinateRect,
} from "../navigation/types";

export interface DocumentGeometrySnapshot extends AnnotationViewGeometrySnapshot {
  readonly textRevision: string;
  readonly viewId: AnnotationViewId;
}

export class DocumentGeometryLedger {
  private expectedTextRevision: string;
  private readonly snapshots = new Map<AnnotationViewId, DocumentGeometrySnapshot>();

  constructor(textRevision: string) {
    this.expectedTextRevision = textRevision;
  }

  reset(textRevision: string): void {
    this.expectedTextRevision = textRevision;
    this.snapshots.clear();
  }

  commit(
    viewId: AnnotationViewId,
    textRevision: string,
    input: AnnotationViewGeometrySnapshot,
  ): DocumentGeometrySnapshot | null {
    if (textRevision !== this.expectedTextRevision) {
      return null;
    }
    const previous = this.snapshots.get(viewId);
    if (previous && input.revision <= previous.revision) {
      return null;
    }
    const snapshot = normalizeDocumentGeometry(viewId, textRevision, input);
    this.snapshots.set(viewId, snapshot);
    return snapshot;
  }

  get(viewId: AnnotationViewId): DocumentGeometrySnapshot | null {
    return this.snapshots.get(viewId) ?? null;
  }
}

export function normalizeDocumentGeometry(
  viewId: AnnotationViewId,
  textRevision: string,
  input: AnnotationViewGeometrySnapshot,
): DocumentGeometrySnapshot {
  const documentHeight = finiteNonNegative(input.documentHeight, "documentHeight");
  const viewportHeight = finiteNonNegative(input.viewportHeight, "viewportHeight");
  const viewportWidth = finiteNonNegative(input.viewportWidth, "viewportWidth");
  const markers: Record<string, readonly DocumentCoordinateRect[]> = {};
  for (const [annotationId, fragments] of Object.entries(input.markers)) {
    markers[annotationId] = Object.freeze(fragments.map((fragment) => normalizeRect(fragment)));
  }
  return Object.freeze({
    documentHeight,
    markers: Object.freeze(markers),
    revision: safeRevision(input.revision),
    scrollOffset: Math.min(
      finiteNonNegative(input.scrollOffset, "scrollOffset"),
      Math.max(0, documentHeight - viewportHeight),
    ),
    textRevision,
    viewId,
    viewportHeight,
    viewportWidth,
  });
}

export function markerAnchorPoint(
  snapshot: DocumentGeometrySnapshot,
  annotationId: string,
): { x: number; y: number } | null {
  const fragments = snapshot.markers[annotationId];
  if (!fragments?.length) {
    return null;
  }
  const last = fragments.at(-1) as DocumentCoordinateRect;
  return Object.freeze({
    x: last.right,
    y: (last.top + last.bottom) / 2,
  });
}

export function sameDocumentGeometry(
  left: DocumentGeometrySnapshot,
  right: DocumentGeometrySnapshot,
  tolerance = 0.25,
): boolean {
  if (
    left.textRevision !== right.textRevision
    || left.viewId !== right.viewId
    || !closeNumber(left.documentHeight, right.documentHeight, tolerance)
    || !closeNumber(left.viewportHeight, right.viewportHeight, tolerance)
    || !closeNumber(left.viewportWidth, right.viewportWidth, tolerance)
  ) {
    return false;
  }
  const leftIds = Object.keys(left.markers);
  const rightIds = Object.keys(right.markers);
  if (leftIds.length !== rightIds.length) {
    return false;
  }
  return leftIds.every((annotationId) => {
    const leftFragments = left.markers[annotationId];
    const rightFragments = right.markers[annotationId];
    return Boolean(rightFragments)
      && leftFragments.length === rightFragments.length
      && leftFragments.every((fragment, index) => {
        const candidate = rightFragments[index];
        return Boolean(candidate)
          && closeNumber(fragment.top, candidate.top, tolerance)
          && closeNumber(fragment.right, candidate.right, tolerance)
          && closeNumber(fragment.bottom, candidate.bottom, tolerance)
          && closeNumber(fragment.left, candidate.left, tolerance);
      });
  });
}

function normalizeRect(rect: DocumentCoordinateRect): DocumentCoordinateRect {
  const left = finiteNonNegative(rect.left, "rect.left");
  const right = finiteNonNegative(rect.right, "rect.right");
  const top = finiteNonNegative(rect.top, "rect.top");
  const bottom = finiteNonNegative(rect.bottom, "rect.bottom");
  if (right < left || bottom < top) {
    throw new RangeError("Document geometry rectangle is inverted");
  }
  return Object.freeze({ bottom, left, right, top });
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative document coordinate`);
  }
  return value;
}

function closeNumber(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

function safeRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Geometry revision must be a non-negative safe integer");
  }
  return value;
}
