import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { connectorGeometry } from "@/renderer/features/annotations/layout/ConnectorGeometry";
import { AnnotationConnectorLayer } from "@/renderer/features/annotations/ui/AnnotationConnectorLayer";

describe("AnnotationConnectorLayer", () => {
  it("renders one full-document SVG with default and active dashed paths", () => {
    const items = [item("a", 200), item("b", 340)];
    const { container } = render(
      <AnnotationConnectorLayer
        activeAnnotationId="b"
        documentHeight={5000}
        hoveredAnnotationId="a"
        items={items}
        open
        width={900}
      />,
    );
    const svg = container.querySelector("svg") as SVGSVGElement;

    expect(svg.getAttribute("height")).toBe("5000");
    expect(svg.getAttribute("viewBox")).toBe("0 0 900 5000");
    expect(svg.style.transform).toBe("");
    expect(getComputedStyle(svg).pointerEvents).toBe("none");
    expect(container.querySelectorAll("path")).toHaveLength(2);
    expect(container.querySelector("[data-annotation-connector-id='a']")?.getAttribute("data-active")).toBe("false");
    expect(container.querySelector("[data-annotation-connector-id='a']")?.getAttribute("data-hovered")).toBe("true");
    expect(container.querySelector("[data-annotation-connector-id='b']")?.getAttribute("data-active")).toBe("true");
  });

  it("does not render while the embedded rail is collapsed", () => {
    const { container, rerender } = render(
      <AnnotationConnectorLayer activeAnnotationId={null} documentHeight={1000} hoveredAnnotationId={null} items={[item("a", 200)]} open width={800} />,
    );
    expect(container.querySelector("svg")).not.toBeNull();

    rerender(
      <AnnotationConnectorLayer activeAnnotationId={null} documentHeight={1000} hoveredAnnotationId={null} items={[item("a", 200)]} open={false} width={800} />,
    );
    expect(container.querySelector("svg")).toBeNull();
  });

  it("updates path endpoints and canvas dimensions after measurement changes", () => {
    const { container, rerender } = render(
      <AnnotationConnectorLayer activeAnnotationId={null} documentHeight={1000} hoveredAnnotationId={null} items={[item("a", 200)]} open width={800} />,
    );
    const first = container.querySelector("path")?.getAttribute("d");

    rerender(
      <AnnotationConnectorLayer activeAnnotationId={null} documentHeight={1600} hoveredAnnotationId={null} items={[item("a", 420)]} open width={960} />,
    );

    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 960 1600");
    expect((container.querySelector("svg") as SVGSVGElement).style.transform).toBe("");
    expect(container.querySelector("path")?.getAttribute("d")).not.toBe(first);
  });
});

function item(annotationId: string, cardY: number) {
  const geometry = connectorGeometry({
    cardX: 720,
    cardY,
    documentEdgeX: 620,
    fanOutX: 628,
    fragments: [{ left: 20, right: 180, top: 100, bottom: 120 }],
    open: true,
    resolved: true,
  });
  if (!geometry) {
    throw new Error("Expected connector geometry");
  }
  return { annotationId, geometry };
}
