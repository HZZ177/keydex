import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  KEYDEX_PIERRE_STYLE_BRIDGE,
  keydexPierreStyle,
} from "@/renderer/components/diff/engine/pierreStyleBridge";
import { pierrePatchDiffProps } from "@/renderer/components/diff/engine/PierrePatchDiff";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";

const file = normalizeUnifiedPatch(
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  { sourceVersion: "style" },
).files[0]!;

describe("Pierre official Shadow DOM style bridge", () => {
  it("delegates compact horizontal scrolling to the fixed-height host", () => {
    expect(keydexPierreStyle("compact")["--diffs-overflow-override"]).toBe("visible");
    expect(keydexPierreStyle("git")["--diffs-overflow-override"]).toBeUndefined();
  });

  it("maps only documented --diffs variables to Keydex semantic tokens", () => {
    expect(Object.keys(KEYDEX_PIERRE_STYLE_BRIDGE).length).toBeGreaterThanOrEqual(30);
    expect(KEYDEX_PIERRE_STYLE_BRIDGE["--diffs-background"]).toBe("var(--diff-surface-bg)");
    expect(KEYDEX_PIERRE_STYLE_BRIDGE["--diffs-foreground"]).toBe("var(--diff-code-text)");
    Object.entries(KEYDEX_PIERRE_STYLE_BRIDGE).forEach(([property, value]) => {
      expect(property).toMatch(/^--diffs-/u);
      expect(value).toMatch(/^var\(--(?:diff|syntax|font)-/u);
      expect(value).not.toMatch(/#[\da-f]{3,8}/iu);
    });
  });

  it("applies the bridge through the public style prop and blocks raw overrides", () => {
    const style = keydexPierreStyle("preview", {
      width: "100%",
      "--diffs-light-bg": "hotpink",
    } as never);
    expect(style.width).toBe("100%");
    expect(style["--diffs-light-bg"]).toBe("var(--diff-surface-bg)");

    const props = pierrePatchDiffProps(file, {
      profile: "preview",
      theme: "light",
      style: { minHeight: 120 },
    });
    expect(props.style).toMatchObject({
      minHeight: 120,
      "--diffs-background": "var(--diff-surface-bg)",
      "--diffs-foreground": "var(--diff-code-text)",
      "--diffs-light-bg": "var(--diff-surface-bg)",
      "--diffs-font-family": "var(--font-mono)",
      "--diffs-token-string": "var(--syntax-string)",
      "--diffs-font-size": "13px",
      "--diffs-line-height": "20px",
    });
  });

  it("keeps official variables on an open-shadow host for inheritance", () => {
    const host = document.createElement("div");
    Object.entries(KEYDEX_PIERRE_STYLE_BRIDGE).forEach(([property, value]) => {
      host.style.setProperty(property, String(value));
    });
    const shadow = host.attachShadow({ mode: "open" });
    shadow.append(document.createElement("code"));
    document.body.append(host);

    expect(host.shadowRoot).toBe(shadow);
    expect(getComputedStyle(host).getPropertyValue("--diffs-background").trim()).toBe(
      "var(--diff-surface-bg)",
    );
    expect(getComputedStyle(host).getPropertyValue("--diffs-foreground").trim()).toBe(
      "var(--diff-code-text)",
    );
    expect(getComputedStyle(host).getPropertyValue("--diffs-light-bg").trim()).toBe(
      "var(--diff-surface-bg)",
    );
    expect(getComputedStyle(host).getPropertyValue("--diffs-font-family").trim()).toBe(
      "var(--font-mono)",
    );
    host.remove();
  });

  it("contains no structural Shadow DOM selector or unsafeCSS escape hatch", () => {
    const engineDir = resolve(process.cwd(), "src/renderer/components/diff/engine");
    const bridge = readFileSync(resolve(engineDir, "pierreStyleBridge.ts"), "utf8");
    const options = readFileSync(resolve(engineDir, "pierreOptions.ts"), "utf8");
    expect(bridge).not.toMatch(/\[data-|shadowRoot\.querySelector|unsafeCSS/u);
    expect(options).not.toMatch(/unsafeCSS\s*:/u);
  });
});
