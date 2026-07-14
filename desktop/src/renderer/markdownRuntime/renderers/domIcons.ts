const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export type MarkdownDomIcon = "annotation" | "check" | "copy" | "maximize";

/**
 * Runtime blocks are retained DOM rather than React trees. Keep their action
 * glyphs structurally equivalent to the lucide-react icons used elsewhere
 * without mounting a React root for every code block.
 */
export function replaceMarkdownActionIcon(button: HTMLButtonElement, icon: MarkdownDomIcon): void {
  const svg = button.ownerDocument.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("height", "14");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.dataset.markdownActionIcon = icon;

  if (icon === "annotation") {
    appendSvgElement(svg, "path", { d: "M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h6" });
    appendSvgElement(svg, "path", { d: "M19 5v6" });
    appendSvgElement(svg, "path", { d: "M16 8h6" });
  } else if (icon === "copy") {
    appendSvgElement(svg, "rect", { x: "8", y: "8", width: "12", height: "12", rx: "2", ry: "2" });
    appendSvgElement(svg, "path", { d: "M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" });
  } else if (icon === "check") {
    appendSvgElement(svg, "path", { d: "m20 6-11 11-5-5" });
  } else {
    appendSvgElement(svg, "path", { d: "M15 3h6v6" });
    appendSvgElement(svg, "path", { d: "M9 21H3v-6" });
    appendSvgElement(svg, "path", { d: "m21 3-7 7" });
    appendSvgElement(svg, "path", { d: "m3 21 7-7" });
  }

  button.replaceChildren(svg);
}

function appendSvgElement(
  parent: SVGSVGElement,
  tag: "path" | "rect",
  attributes: Readonly<Record<string, string>>,
): void {
  const element = parent.ownerDocument.createElementNS(SVG_NAMESPACE, tag);
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
  parent.append(element);
}
