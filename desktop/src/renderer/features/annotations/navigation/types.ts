import type {
  BlockRangeProjection,
  DocumentSelection,
  LogicalRange,
  SourceRange,
} from "../document/DocumentTextModel";

export type AnnotationViewId = "markdown" | "source";

export interface AnnotationRenderMarker {
  readonly annotationId: string;
  readonly blockRanges: readonly BlockRangeProjection[];
  readonly logicalRange: LogicalRange;
  readonly sourceRanges: readonly SourceRange[];
}

export interface AnnotationRenderState {
  readonly activeAnnotationId: string | null;
  readonly flashAnnotationId: string | null;
  readonly flashToken: number;
  readonly hoveredAnnotationId: string | null;
  readonly markers: readonly AnnotationRenderMarker[];
  readonly revision: string;
}

export interface DocumentCoordinateRect {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

export interface AnnotationViewGeometrySnapshot {
  readonly documentHeight: number;
  readonly markers: Readonly<Record<string, readonly DocumentCoordinateRect[]>>;
  readonly revision: number;
  readonly scrollOffset: number;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
}

export interface AnnotationRevealRequest {
  readonly annotationId: string;
  readonly blockRanges: readonly BlockRangeProjection[];
  readonly logicalRange: LogicalRange;
  readonly requestId: number;
  readonly scroll: boolean;
  readonly signal: AbortSignal;
  readonly sourceRanges: readonly SourceRange[];
}

export type AnnotationViewEvent =
  | { readonly type: "geometry"; readonly snapshot: AnnotationViewGeometrySnapshot }
  | { readonly type: "marker-activate"; readonly annotationId: string }
  | { readonly type: "marker-hover"; readonly annotationId: string | null }
  | { readonly type: "selection"; readonly selection: DocumentSelection | null };

export interface AnnotationViewAdapter {
  readonly id: AnnotationViewId;
  flashMarker(annotationId: string): void;
  geometry(): AnnotationViewGeometrySnapshot;
  isReady(): boolean;
  render(state: AnnotationRenderState): void;
  reveal(request: AnnotationRevealRequest): Promise<void>;
  selection(): DocumentSelection | null;
  subscribe(listener: (event: AnnotationViewEvent) => void): () => void;
  whenReady(signal: AbortSignal): Promise<void>;
}
