import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const srcDir = resolve(process.cwd(), "src");

describe("annotation visual style", () => {
  it("uses one pale-red accent for text marks without highlighting line numbers", () => {
    const css = readSource("renderer/components/workspace/FilePreview.module.css");
    const sourceView = readSource("renderer/components/workspace/FilePreview.tsx");

    expect(css).toContain("--annotation-accent: #d87575;");
    expect(css).toMatch(/\.previewAnnotationMark\s*{[^}]*var\(--annotation-accent\)/s);
    expect(css).toContain('.previewAnnotationMark[data-hovered="true"]');
    expect(css).not.toContain('.previewAnnotationMark[data-active="true"]');
    expect(css).not.toContain('.markdownPreviewLineNumber[data-active="true"]');
    expect(sourceView).toMatch(/"\.cm-annotation-mark"\s*:\s*{[^}]*var\(--annotation-accent\)/s);
    expect(sourceView).toContain(".cm-annotation-mark[data-hovered='true']");
    expect(sourceView).not.toContain(".cm-annotation-mark[data-active='true']");
    expect(css).not.toContain("annotationMarkFlash");
    expect(sourceView).not.toContain("annotationMarkFlash");
  });

  it("renders short accent dashes and borderless cards with one left rule", () => {
    const connectorCss = readSource("renderer/features/annotations/ui/AnnotationConnectorLayer.module.css");
    const connector = readSource("renderer/features/annotations/ui/AnnotationConnectorLayer.tsx");
    const railCss = readSource("renderer/features/annotations/ui/AnnotationRail.module.css");

    expect(connectorCss).toMatch(/\.path\s*{[^}]*stroke:\s*var\(--annotation-accent\);[^}]*stroke-dasharray:\s*4 4;/s);
    expect(connectorCss).toContain('.path[data-hovered="true"]');
    expect(connectorCss).not.toContain('.path[data-active="true"]');
    expect(connector).not.toContain("pathLength=");
    expect(railCss).toMatch(/\.card\s*{[^}]*border:\s*0;[^}]*border-left:\s*3px solid var\(--annotation-accent\);[^}]*box-shadow:\s*none;/s);
    expect(railCss).toContain('.card[data-hovered="true"]');
    expect(railCss).not.toContain('.card[data-active="true"]');
  });

  it("keeps click navigation flashes separate from hover highlighting", () => {
    const previewCss = readSource("renderer/components/workspace/FilePreview.module.css");
    const railCss = readSource("renderer/features/annotations/ui/AnnotationRail.module.css");

    expect(previewCss).toContain('[data-annotation-navigation-flash="true"]');
    expect(previewCss).toContain("annotationNavigationTargetFlash");
    expect(railCss).toContain('.card[data-annotation-navigation-flash="true"]');
    expect(railCss).toContain("annotationCardNavigationFlash");
  });

  it("animates the complete document annotation group while respecting reduced motion", () => {
    const railCss = readSource("renderer/features/annotations/ui/AnnotationRail.module.css");

    expect(railCss).toMatch(/\.documentSectionCollapse\s*{[^}]*grid-template-rows:\s*1fr;[^}]*transition:[^}]*grid-template-rows/s);
    expect(railCss).toMatch(/\.documentSectionCollapse\[data-collapsed="true"\]\s*{[^}]*grid-template-rows:\s*0fr;[^}]*opacity:\s*0;/s);
    expect(railCss).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.documentSectionCollapse[\s\S]*transition:\s*none;/s);
  });

  it("pins two equal-width labeled actions outside the shared scroll viewport", () => {
    const previewCss = readSource("renderer/components/workspace/FilePreview.module.css");

    expect(previewCss).toMatch(/\.annotationBottomActionsHost\s*{[^}]*position:\s*absolute;[^}]*bottom:\s*0;[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s);
    expect(previewCss).toMatch(/\.annotationBottomActionsHost button\s*{[^}]*justify-content:\s*center;[^}]*gap:\s*7px;/s);
  });
});

function readSource(relativePath: string): string {
  return readFileSync(resolve(srcDir, relativePath), "utf8");
}
