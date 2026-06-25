export interface SvgDimensions {
  width: number;
  height: number;
}

interface MermaidCanvasPadding {
  x: number;
  y: number;
}

const MERMAID_CANVAS_MIN_PADDING_X = 160;
const MERMAID_CANVAS_MIN_PADDING_Y = 120;
const MERMAID_CANVAS_PADDING_X_VAR = "--mermaid-canvas-padding-x";
const MERMAID_CANVAS_PADDING_Y_VAR = "--mermaid-canvas-padding-y";

export function normalizeMermaidSvgDimensions(svg: string): { svg: string; dimensions: SvgDimensions | null } {
  const rawDimensions = extractSvgDimensions(svg);
  if (!svg.trim() || typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
    return { svg, dimensions: rawDimensions };
  }

  try {
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    if (document.querySelector("parsererror")) {
      return { svg, dimensions: rawDimensions };
    }

    const svgElement = document.querySelector("svg");
    const dimensions = parseSvgViewBox(svgElement?.getAttribute("viewBox")) ?? rawDimensions;
    if (!svgElement || !dimensions) {
      return { svg, dimensions: rawDimensions };
    }

    svgElement.setAttribute("width", formatSvgDimension(dimensions.width));
    svgElement.setAttribute("height", formatSvgDimension(dimensions.height));

    const style = svgElement.getAttribute("style");
    if (style) {
      const normalizedStyle = removeInlineMaxWidth(style);
      if (normalizedStyle) {
        svgElement.setAttribute("style", normalizedStyle);
      } else {
        svgElement.removeAttribute("style");
      }
    }

    return { svg: new XMLSerializer().serializeToString(svgElement), dimensions };
  } catch {
    return { svg, dimensions: rawDimensions };
  }
}

export function formatMermaidCssPixels(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, "")}px`;
}

export function syncMermaidCanvasPadding(viewport: HTMLElement): MermaidCanvasPadding {
  const padding = calculateMermaidCanvasPadding(viewport);
  viewport.style.setProperty(MERMAID_CANVAS_PADDING_X_VAR, formatMermaidCssPixels(padding.x));
  viewport.style.setProperty(MERMAID_CANVAS_PADDING_Y_VAR, formatMermaidCssPixels(padding.y));
  return padding;
}

export function centerMermaidViewport(viewport: HTMLElement, dimensions: SvgDimensions, scale: number) {
  const padding = syncMermaidCanvasPadding(viewport);
  const expectedWidth = dimensions.width * scale + padding.x * 2;
  const expectedHeight = dimensions.height * scale + padding.y * 2;
  const scrollWidth = Math.max(viewport.scrollWidth, expectedWidth);
  const scrollHeight = Math.max(viewport.scrollHeight, expectedHeight);
  viewport.scrollLeft = Math.max(0, (scrollWidth - viewport.clientWidth) / 2);
  viewport.scrollTop = Math.max(0, (scrollHeight - viewport.clientHeight) / 2);
}

export function preserveMermaidZoomAnchor(
  viewport: HTMLElement,
  currentScale: number,
  nextScale: number,
  focus: { clientX: number; clientY: number },
) {
  const padding = syncMermaidCanvasPadding(viewport);
  const rect = viewport.getBoundingClientRect();
  const viewportX = focus.clientX - rect.left;
  const viewportY = focus.clientY - rect.top;
  const anchorX = viewport.scrollLeft + viewportX - padding.x;
  const anchorY = viewport.scrollTop + viewportY - padding.y;
  const ratio = nextScale / currentScale;

  window.requestAnimationFrame(() => {
    const nextPadding = syncMermaidCanvasPadding(viewport);
    viewport.scrollLeft = Math.max(0, anchorX * ratio + nextPadding.x - viewportX);
    viewport.scrollTop = Math.max(0, anchorY * ratio + nextPadding.y - viewportY);
  });
}

function calculateMermaidCanvasPadding(viewport: HTMLElement): MermaidCanvasPadding {
  return {
    x: Math.max(MERMAID_CANVAS_MIN_PADDING_X, viewport.clientWidth / 2),
    y: Math.max(MERMAID_CANVAS_MIN_PADDING_Y, viewport.clientHeight / 2),
  };
}

function extractSvgDimensions(svg: string): SvgDimensions | null {
  const svgTag = /<svg\b[\s\S]*?>/i.exec(svg)?.[0];
  if (!svgTag) {
    return null;
  }

  const viewBoxDimensions = parseSvgViewBox(readSvgAttribute(svgTag, "viewBox"));
  if (viewBoxDimensions) {
    return viewBoxDimensions;
  }

  const width = parseSvgLength(readSvgAttribute(svgTag, "width"));
  const height = parseSvgLength(readSvgAttribute(svgTag, "height"));
  return width && height ? { width, height } : null;
}

function readSvgAttribute(svgTag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(svgTag);
  return match?.[2] ?? match?.[3] ?? match?.[4] ?? null;
}

function parseSvgViewBox(viewBox?: string | null): SvgDimensions | null {
  const values = viewBox
    ?.trim()
    .split(/[\s,]+/)
    .map((value) => Number(value));
  if (!values || values.length !== 4) {
    return null;
  }

  const [, , width, height] = values;
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
}

function parseSvgLength(value?: string | null): number | null {
  if (!value || value.trim().endsWith("%")) {
    return null;
  }

  const match = /^([+-]?\d*\.?\d+)(px)?$/i.exec(value.trim());
  if (!match) {
    return null;
  }

  const numeric = Number(match[1]);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function formatSvgDimension(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function removeInlineMaxWidth(style: string): string {
  return style
    .split(";")
    .map((rule) => rule.trim())
    .filter((rule) => rule && !/^max-width\s*:/i.test(rule))
    .join("; ");
}
