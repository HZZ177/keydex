import type { ConnectorGeometry } from "../layout/ConnectorGeometry";
import styles from "./AnnotationConnectorLayer.module.css";

export interface AnnotationConnectorItem {
  readonly annotationId: string;
  readonly geometry: ConnectorGeometry;
}

export function AnnotationConnectorLayer({
  activeAnnotationId,
  documentHeight,
  hoveredAnnotationId,
  items,
  open,
  width,
}: {
  activeAnnotationId: string | null;
  documentHeight: number;
  hoveredAnnotationId: string | null;
  items: readonly AnnotationConnectorItem[];
  open: boolean;
  width: number;
}) {
  if (!open || documentHeight <= 0 || width <= 0) {
    return null;
  }
  return (
    <svg
      aria-hidden="true"
      className={styles.layer}
      data-annotation-connector-layer="true"
      height={documentHeight}
      preserveAspectRatio="none"
      style={{ pointerEvents: "none" }}
      viewBox={`0 0 ${width} ${documentHeight}`}
      width={width}
    >
      {items.map((item) => (
        <path
          className={styles.path}
          d={item.geometry.path}
          data-active={item.annotationId === activeAnnotationId ? "true" : "false"}
          data-annotation-connector-id={item.annotationId}
          data-hovered={item.annotationId === hoveredAnnotationId ? "true" : "false"}
          key={item.annotationId}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
