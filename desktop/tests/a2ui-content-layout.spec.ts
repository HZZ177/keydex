import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("A2UI content layout contract", () => {
  it("does not cap or internally scroll business component content", () => {
    const chartCss = readSource("renderer/pages/conversation/messages/a2ui/A2ChartBlock.module.css");
    const blockCss = readSource("renderer/pages/conversation/messages/a2ui/A2UIBlock.module.css");
    const formCss = readSource("renderer/pages/conversation/messages/a2ui/A2FormBlock.module.css");
    const chartSource = readSource("renderer/pages/conversation/messages/a2ui/A2ChartBlock.tsx");

    expect(chartCss).not.toContain("max-height:");
    expect(chartCss).not.toMatch(/\.pointList\s*{[^}]*overflow:\s*auto/s);
    expect(blockCss).not.toMatch(/\.streamPreview\s*{[^}]*(max-height|overflow:\s*auto)/s);
    expect(formCss).not.toMatch(/\.valueItem\s+dd\s*{[^}]*(overflow:\s*hidden|text-overflow|white-space:\s*nowrap)/s);
    expect(chartSource).not.toContain("truncate(");
  });

  it("wraps long table cell content and lets AG Grid measure the resulting row height", () => {
    const tableCss = readSource("renderer/pages/conversation/messages/a2ui/A2TableBlock.module.css");
    const tableSource = readSource("renderer/pages/conversation/messages/a2ui/A2TableBlock.tsx");
    const cellTextRule = tableCss.match(/\.cellText\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";

    expect(tableSource).toMatch(/autoHeight:\s*true[\s\S]*wrapText:\s*true/);
    expect(cellTextRule).toContain("flex: 1 1 auto");
    expect(cellTextRule).toContain("overflow-wrap: anywhere");
    expect(cellTextRule).toContain("white-space: pre-wrap");
    expect(cellTextRule).not.toContain("text-overflow: ellipsis");
    expect(cellTextRule).not.toContain("white-space: nowrap");
    expect(tableCss).toMatch(/\.gridShell :global\(\.ag-cell\)\s*{[^}]*align-items:\s*flex-start/s);
  });

  it("grows from measured AG Grid row heights until the table reaches three quarters of the window", () => {
    const tableCss = readSource("renderer/pages/conversation/messages/a2ui/A2TableBlock.module.css");
    const tableSource = readSource("renderer/pages/conversation/messages/a2ui/A2TableBlock.tsx");

    expect(tableCss).toMatch(/\.surface\s*{[^}]*max-height:\s*75vh/s);
    expect(tableCss).toMatch(/\.gridShell\s*{[^}]*max-height:\s*calc\(75vh - 37px\)/s);
    expect(tableSource).toContain("measuredTableGridHeight(api)");
    expect(tableSource).toContain("api.forEachNodeAfterFilterAndSort");
    expect(tableSource).toContain("rowNode.rowTop ?? accumulatedHeight");
    expect(tableSource).toContain("onModelUpdated={scheduleNaturalGridHeightMeasure}");
    expect(tableSource).toContain("Math.max(naturalGridHeight, tableGridFallbackHeight(rows.length))");
    expect(tableSource).toContain("`min(calc(75vh - 37px), ${gridHeight}px)`");
    expect(tableSource).not.toContain('domLayout="autoHeight"');
  });

  it("keeps semantic column widths independent from streamed cell text", () => {
    const tableSource = readSource("renderer/pages/conversation/messages/a2ui/A2TableBlock.tsx");

    expect(tableSource).toContain("tableColumnLayout(column)");
    expect(tableSource).not.toContain("tableColumnLayout(column, model.rows)");
    expect(tableSource).toContain("return { minWidth: 360, flex: 1.8 }");
    expect(tableSource).toContain("return { minWidth: 140, flex: 0.55 }");
    expect(tableSource).toContain("return { minWidth: 104, flex: 0.55 }");
    expect(tableSource).not.toContain("flex: column.width ? undefined : 1");
  });

  it("suppresses row and root position animation while table content is streaming", () => {
    const motionSource = readSource("renderer/pages/conversation/messages/a2ui/A2UIMotion.tsx");
    const tableSource = readSource("renderer/pages/conversation/messages/a2ui/A2TableBlock.tsx");

    expect(motionSource).toContain('layout = "position"');
    expect(motionSource).toContain("layout={layout}");
    expect(tableSource).toContain("animateRows={!tableStreaming}");
    expect(tableSource).toContain('layout={tableStreaming ? false : "position"}');
    expect(tableSource).toContain("Math.max(current, measuredHeight)");
  });

  it("uses a multiline editor for text cells", () => {
    const tableCss = readSource("renderer/pages/conversation/messages/a2ui/A2TableBlock.module.css");
    const tableSource = readSource("renderer/pages/conversation/messages/a2ui/A2TableBlock.tsx");

    expect(tableSource).toContain("<textarea");
    expect(tableSource).toContain("event.ctrlKey || event.metaKey");
    expect(tableCss).toMatch(/\.textareaEditor\s*{[^}]*white-space:\s*pre-wrap/s);
  });

  it("does not cover the table with full-value tooltips on cell hover", () => {
    const tableSource = readSource("renderer/pages/conversation/messages/a2ui/A2TableBlock.tsx");

    expect(tableSource).not.toContain("tooltipValueGetter");
    expect(tableSource).not.toContain("tooltipShowDelay");
  });

  it("expands the existing table surface instead of mounting a second grid", () => {
    const tableCss = readSource("renderer/pages/conversation/messages/a2ui/A2TableBlock.module.css");
    const tableSource = readSource("renderer/pages/conversation/messages/a2ui/A2TableBlock.tsx");

    expect(tableSource).toContain('aria-label={expanded ? "还原表格" : "放大表格"}');
    expect(tableSource.match(/<AgGridReact/g)).toHaveLength(1);
    expect(tableSource).not.toContain("<AppDialog");
    expect(tableSource).toContain("<dialog");
    expect(tableSource).toContain("surface.showModal");
    expect(tableSource).toContain("surfaceSlotRef");
    expect(tableSource).toContain("surfaceRef");
    expect(tableCss).toMatch(/\.expandedSurface\s*{[^}]*position:\s*fixed/s);
    expect(tableCss).toMatch(/\.expandedSurface\s*{[^}]*inset:\s*24px/s);
    expect(tableCss).toMatch(/\.expandedSurface\s*{[^}]*width:\s*min\(1320px, calc\(100vw - 48px\)\)/s);
    expect(tableCss).toMatch(/\.expandedSurface\s*{[^}]*height:\s*min\(860px, calc\(100vh - 350px\)\)/s);
    expect(tableCss).toMatch(/\.expandedSurface::backdrop\s*{[^}]*background:\s*rgb\(255 255 255 \/ 58%\)/s);
    expect(tableCss).toMatch(/\.expandedSurface::backdrop\s*{[^}]*backdrop-filter:\s*blur\(10px\)/s);
    expect(tableSource).toContain("{expanded ? model.title");
    expect(tableSource).not.toContain("data-a2ui-table-expanded");
  });

  it("animates the same table surface with live layout geometry in both directions", () => {
    const tableCss = readSource("renderer/pages/conversation/messages/a2ui/A2TableBlock.module.css");
    const tableSource = readSource("renderer/pages/conversation/messages/a2ui/A2TableBlock.tsx");

    expect(tableSource).toContain("expandedClosing");
    expect(tableSource).toContain("tableSurfaceGeometryKeyframes(start, end)");
    expect(tableSource).toContain("tableSurfaceGeometryKeyframes(start, target)");
    expect(tableSource).toContain('left: `${rect.left}px`');
    expect(tableSource).toContain('width: `${Math.max(rect.width, 1)}px`');
    expect(tableSource).not.toContain("tableSurfaceFlipTransform");
    expect(tableSource).not.toContain("scale(");
    expect(tableSource).toContain("duration: TABLE_EXPAND_MS");
    expect(tableSource).toContain("duration: TABLE_COLLAPSE_MS");
    expect(tableCss).toMatch(/\.expandedSurface\s*{[^}]*will-change:\s*left, top, width, height/s);
    expect(tableCss).toMatch(/\.expandedSurface\[data-closing="true"\]::backdrop\s*{[^}]*animation:\s*table-dialog-backdrop-out 220ms/s);
    expect(tableCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.expandedSurface\[data-closing="true"\]::backdrop[\s\S]*animation:\s*none/s);
  });

  it("uses more relaxed row spacing only in the expanded table", () => {
    const tableCss = readSource("renderer/pages/conversation/messages/a2ui/A2TableBlock.module.css");
    const tableSource = readSource("renderer/pages/conversation/messages/a2ui/A2TableBlock.tsx");

    expect(tableSource).toContain("rowHeight={40}");
    expect(tableCss).toMatch(/\.expandedSurface \.gridShell :global\(\.ag-cell\)\s*{[^}]*line-height:\s*1\.55/s);
    expect(tableCss).toMatch(/\.expandedSurface \.cellValue\s*{[^}]*padding-block:\s*5px/s);
    expect(tableCss).toMatch(/\.expandedSurface\[data-closing="true"\] \.gridShell :global\(\.ag-cell\)\s*{[^}]*line-height:\s*1\.45/s);
    expect(tableCss).toMatch(/\.expandedSurface\[data-closing="true"\] \.cellValue\s*{[^}]*padding-block:\s*0/s);
    expect(tableCss).toMatch(/\.gridShell :global\(\.ag-cell\)\s*{[^}]*transition:\s*line-height 220ms ease/s);
    expect(tableCss).toMatch(/\.cellValue\s*{[^}]*transition:\s*padding-block 220ms ease/s);
  });

  it("renders chart captions as centered text below the chart surface", () => {
    const chartCss = readSource("renderer/pages/conversation/messages/a2ui/A2ChartBlock.module.css");

    expect(chartCss).toMatch(/\.panelTitle\s*{[^}]*justify-self:\s*center/s);
    expect(chartCss).toMatch(/\.panelTitle\s*{[^}]*text-align:\s*center/s);
    expect(chartCss).toMatch(/\.summary\s*{[^}]*justify-self:\s*center/s);
    expect(chartCss).toMatch(/\.summary\s*{[^}]*text-align:\s*center/s);
  });

  it("keeps form A2UI as a compact canvas with inline field headers", () => {
    const formCss = readSource("renderer/pages/conversation/messages/a2ui/A2FormBlock.module.css");

    expect(formCss).toMatch(/\.workspace\s*{[^}]*border-radius:\s*18px/s);
    expect(formCss).toMatch(/\.workspace\s*{[^}]*isolation:\s*isolate/s);
    expect(formCss).toMatch(/\.fields\s*{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
    expect(formCss).toMatch(/\.field\s*{[^}]*min-height:\s*86px/s);
    expect(formCss).toMatch(/\.field\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
    expect(formCss).toMatch(/\.fieldBrief\s*{[^}]*grid-template-columns:\s*auto auto minmax\(0, 1fr\)/s);
    expect(formCss).toMatch(/\.fieldIcon\s*{[^}]*width:\s*15px/s);
    expect(formCss).not.toContain(".fieldDots");
    expect(formCss).not.toMatch(/\.field\s*{[^}]*grid-template-columns:\s*52px minmax\(148px/s);
    expect(formCss).not.toMatch(/\.field\s*{[^}]*grid-template-columns:\s*24px minmax\(0, 1fr\)/s);
  });

  it("keeps choice gallery card text padded against transform clipping", () => {
    const choiceCss = readSource("renderer/pages/conversation/messages/a2ui/A2ChoiceBlock.module.css");

    expect(choiceCss).toMatch(/\.optionDescription\s*{[^}]*box-sizing:\s*border-box/s);
    expect(choiceCss).toMatch(/\.optionDescription\s*{[^}]*padding:\s*1px 2px/s);
    expect(choiceCss).toMatch(/\.optionDescription\[data-detail-expanded="true"\]\s*{[^}]*padding:\s*1px 6px 1px 2px/s);
  });

  it("keeps choice gallery cards visually separated from the white page background", () => {
    const choiceCss = readSource("renderer/pages/conversation/messages/a2ui/A2ChoiceBlock.module.css");

    expect(choiceCss).toMatch(/--a2ui-choice-card-bg-top:\s*color-mix\(in srgb, var\(--surface-muted\) 38%, var\(--color-bg-elevated\)\)/s);
    expect(choiceCss).toMatch(/--a2ui-choice-card-bg-bottom:\s*color-mix\(in srgb, var\(--surface-muted\) 58%, var\(--color-bg-elevated\)\)/s);
    expect(choiceCss).toMatch(/--a2ui-choice-card-bg-base:\s*color-mix\(in srgb, var\(--surface-muted\) 46%, var\(--color-bg-elevated\)\)/s);
    expect(choiceCss).toMatch(/\.optionFace\s*{[^}]*background:[^}]*var\(--a2ui-choice-card-bg-top\)[^}]*var\(--a2ui-choice-card-bg-bottom\)[^}]*var\(--a2ui-choice-card-bg-base\)/s);
  });

  it("does not fade the entire historical unselected choice card", () => {
    const choiceCss = readSource("renderer/pages/conversation/messages/a2ui/A2ChoiceBlock.module.css");
    const dimmedRule = choiceCss.match(/\.option\[data-dimmed="true"\]\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";

    expect(dimmedRule).not.toMatch(/^\s*opacity\s*:/m);
    expect(dimmedRule).not.toMatch(/^\s*filter\s*:/m);
    expect(dimmedRule).toContain("--a2ui-choice-card-filter: saturate(0.88)");
    expect(dimmedRule).toContain("--a2ui-choice-card-text-opacity: 0.74");
  });

  it("keeps selected choice gallery cards as subtle green double frames", () => {
    const choiceCss = readSource("renderer/pages/conversation/messages/a2ui/A2ChoiceBlock.module.css");

    expect(choiceCss).not.toContain("a2ui-choice-vine");
    expect(choiceCss).not.toMatch(/\.option\[data-selected="true"\]\s+\.optionFace::before\s*{[^}]*radial-gradient/s);
    expect(choiceCss).toMatch(/\.option\[data-selected="true"\]\s*{[^}]*--a2ui-choice-selected-frame-outer:/s);
    expect(choiceCss).toMatch(/\.option\[data-selected="true"\]\s*{[^}]*--a2ui-choice-selected-frame-inner:/s);
    expect(choiceCss).toMatch(/\.option\[data-selected="true"\]\s+\.optionFace::before\s*{[^}]*border:\s*1px solid var\(--a2ui-choice-selected-frame-outer\)/s);
    expect(choiceCss).toMatch(/\.option\[data-selected="true"\]\s+\.optionFace::after\s*{[^}]*border:\s*1px solid var\(--a2ui-choice-selected-frame-inner\)/s);
    expect(choiceCss).toMatch(/\.option:not\(\[data-selected="true"\]\):hover\s+\.optionFace::before\s*{[^}]*content:\s*none/s);
    expect(choiceCss).toMatch(/\.option\[data-readonly="true"\]:not\(\[data-selected="true"\]\):hover\s+\.optionFace::before\s*{[^}]*opacity:\s*0/s);
  });

  it("keeps the A2UI debug panel header actions inside the panel with long ids", () => {
    const debugCss = readSource("renderer/pages/conversation/messages/a2ui/A2UIDebugPanel.module.css");

    expect(debugCss).toMatch(/\.titleArea\s*{[^}]*min-width:\s*0/s);
    expect(debugCss).toMatch(/\.titleArea\s*{[^}]*flex:\s*1 1 auto/s);
    expect(debugCss).toMatch(/\.actions\s*{[^}]*flex:\s*0 0 auto/s);
    expect(debugCss).toMatch(/\.actions\s*{[^}]*margin-left:\s*auto/s);
    expect(debugCss).toMatch(/\.subtitle\s*{[^}]*text-overflow:\s*ellipsis/s);
  });

  it("keeps A2UI status metadata hidden and the debug trigger visually neutral", () => {
    const blockCss = readSource("renderer/pages/conversation/messages/a2ui/A2UIBlock.module.css");
    const debugCss = readSource("renderer/pages/conversation/messages/a2ui/A2UIDebugPanel.module.css");

    expect(blockCss).toContain(".statusMeta");
    expect(blockCss).not.toContain(".status {");
    expect(debugCss).toMatch(/\.debugButton:focus-visible\s*{[^}]*outline:\s*1px solid color-mix\(in srgb, var\(--color-border-default\)/s);
    expect(debugCss).not.toMatch(/\.debugButton:focus-visible\s*{[^}]*color-info-6/s);
  });
});

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), "src", relativePath), "utf8");
}
