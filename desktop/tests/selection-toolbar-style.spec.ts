import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

describe("selection toolbar style", () => {
  it("does not animate transform or scale during selection toolbar entry", () => {
    const css = readSource("renderer/pages/conversation/messages/SelectionToolbar.module.css");
    const keyframes = /@keyframes\s+toolbarEnter\s*{([\s\S]*?)\n}/.exec(css)?.[1] ?? "";

    expect(css).toMatch(/\.toolbar\s*{[^}]*transform:\s*translate\(-50%,\s*-100%\)/s);
    expect(keyframes).not.toMatch(/transform\s*:/);
    expect(keyframes).not.toMatch(/scale\(/);
  });

  it("adapts the comment shell from an initial capsule into a bounded rounded panel", () => {
    const css = readSource("renderer/pages/conversation/messages/SelectionToolbar.module.css");
    const commentToolbarRule = /\.toolbar\[data-mode="comment"\]\s*{([^}]*)}/.exec(css)?.[1] ?? "";
    const inputRule = /\.commentInput\s*{([^}]*)}/.exec(css)?.[1] ?? "";
    const submitRule = /\.submitAction\s*{([^}]*)}/.exec(css)?.[1] ?? "";

    expect(commentToolbarRule).toMatch(/border-radius:\s*18px/);
    expect(commentToolbarRule).toMatch(/padding:\s*4px 5px 4px 9px/);
    expect(inputRule).toMatch(/max-height:\s*64px/);
    expect(inputRule).toMatch(/overflow-y:\s*auto/);
    expect(inputRule).toMatch(/resize:\s*none/);
    expect(inputRule).toMatch(/border:\s*0/);
    expect(inputRule).toMatch(/background:\s*transparent/);
    expect(submitRule).toMatch(/background:\s*color-mix\([^;]*var\(--surface-hover\)/);
    expect(submitRule).toMatch(/display:\s*inline-flex/);
    expect(submitRule).toMatch(/align-items:\s*center/);
    expect(submitRule).toMatch(/justify-content:\s*center/);
    expect(submitRule).not.toMatch(/background:\s*var\(--color-text-primary\)/);
  });

  it("points the comment bubble at a temporary selection highlight", () => {
    const css = readSource("renderer/pages/conversation/messages/SelectionToolbar.module.css");
    const pointerRule = /\.toolbar\[data-mode="comment"\]::after\s*{([^}]*)}/.exec(css)?.[1] ?? "";
    const highlightLayerRule = /\.selectionHighlight\s*{([^}]*)}/.exec(css)?.[1] ?? "";
    const highlightSegmentRule = /\.selectionHighlightSegment\s*{([^}]*)}/.exec(css)?.[1] ?? "";

    expect(pointerRule).toMatch(/left:\s*calc\(50% \+ var\(--selection-pointer-offset-x, 0px\)\)/);
    expect(pointerRule).toMatch(/transform:\s*translateX\(-50%\) rotate\(45deg\)/);
    expect(highlightLayerRule).toMatch(/position:\s*fixed/);
    expect(highlightLayerRule).toMatch(/pointer-events:\s*none/);
    expect(highlightSegmentRule).toMatch(/var\(--color-accent\) 18%/);
  });
});

function readSource(relativePath: string): string {
  return readFileSync(resolve(srcDir, relativePath), "utf8");
}
