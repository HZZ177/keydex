import type { CSSProperties } from "react";
import type { KeydexDiffProfileName } from "../profiles";
import { keydexDiffTypography } from "../diffTypography";

export type PierreStyleBridge = CSSProperties & Record<`--diffs-${string}`, string>;

export const KEYDEX_PIERRE_UNSAFE_CSS = `
[data-separator="line-info"] [data-separator-content],
[data-separator="line-info"] [data-expand-button] {
  box-shadow:
    inset 0 1px 0 var(--diffs-keydex-separator-border),
    inset 0 -1px 0 var(--diffs-keydex-separator-border);
}

[data-separator="line-info"] [data-unmodified-lines] {
  color: var(--diffs-keydex-separator-text);
  font-size: 0.92em;
  font-weight: 500;
  letter-spacing: 0.01em;
}

:is([data-column-number], [data-gutter-buffer], [data-line], [data-no-newline])[data-line-type="change-addition"]:not([data-selected-line]) {
  background-color: var(--diffs-keydex-addition-line-bg);
}

:is([data-column-number], [data-gutter-buffer], [data-line], [data-no-newline])[data-line-type="change-deletion"]:not([data-selected-line]) {
  background-color: var(--diffs-keydex-deletion-line-bg);
}
`;

export const KEYDEX_PIERRE_STYLE_BRIDGE: Readonly<PierreStyleBridge> = Object.freeze({
  "--diffs-background": "var(--diff-surface-bg)",
  "--diffs-foreground": "var(--diff-code-text)",
  "--diffs-light-bg": "var(--diff-surface-bg)",
  "--diffs-dark-bg": "var(--diff-surface-bg)",
  "--diffs-light": "var(--diff-code-text)",
  "--diffs-dark": "var(--diff-code-text)",
  "--diffs-bg-buffer-override": "var(--diff-surface-muted)",
  "--diffs-bg-context-override": "var(--diff-surface-bg)",
  "--diffs-bg-context-gutter-override": "var(--diff-gutter-bg)",
  "--diffs-gap-style": "1px solid var(--diff-border-subtle)",
  "--diffs-bg-separator-override": "var(--color-fill-2)",
  "--diffs-keydex-separator-border": "var(--diff-border-default)",
  "--diffs-keydex-separator-text": "var(--color-text-tertiary)",
  "--diffs-keydex-addition-line-bg": "var(--diff-added-bg)",
  "--diffs-keydex-deletion-line-bg": "var(--diff-removed-bg)",
  "--diffs-fg-number-override": "var(--diff-line-number)",
  "--diffs-light-addition-color": "var(--diff-added-text)",
  "--diffs-dark-addition-color": "var(--diff-added-text)",
  "--diffs-light-deletion-color": "var(--diff-removed-text)",
  "--diffs-dark-deletion-color": "var(--diff-removed-text)",
  "--diffs-light-modified-color": "var(--diff-selection-border)",
  "--diffs-dark-modified-color": "var(--diff-selection-border)",
  "--diffs-modified-color-override": "var(--diff-selection-border)",
  "--diffs-bg-addition-override": "var(--diff-added-bg)",
  "--diffs-bg-addition-emphasis-override": "var(--diff-added-word-bg)",
  "--diffs-bg-deletion-override": "var(--diff-removed-bg)",
  "--diffs-bg-deletion-emphasis-override": "var(--diff-removed-word-bg)",
  "--diffs-bg-hover-override": "var(--diff-context-hover-bg)",
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-header-font-family": "var(--font-sans)",
  "--diffs-token-foreground": "var(--diff-code-text)",
  "--diffs-token-background": "var(--diff-surface-bg)",
  "--diffs-token-string": "var(--syntax-string)",
  "--diffs-token-comment": "var(--syntax-comment)",
  "--diffs-token-constant": "var(--syntax-number)",
  "--diffs-token-keyword": "var(--syntax-keyword)",
  "--diffs-token-parameter": "var(--syntax-variable)",
  "--diffs-token-function": "var(--syntax-function)",
  "--diffs-token-string-expression": "var(--syntax-string)",
  "--diffs-token-punctuation": "var(--syntax-punctuation)",
  "--diffs-token-link": "var(--syntax-property)",
  "--diffs-token-inserted": "var(--diff-added-text)",
  "--diffs-token-deleted": "var(--diff-removed-text)",
  "--diffs-token-changed": "var(--syntax-type)",
});

export function keydexPierreStyle(
  profile: KeydexDiffProfileName,
  style?: CSSProperties,
): PierreStyleBridge {
  const typography = keydexDiffTypography(profile);
  return {
    ...style,
    ...KEYDEX_PIERRE_STYLE_BRIDGE,
    ...(profile === "compact" ? { "--diffs-overflow-override": "visible" } : {}),
    "--diffs-font-size": `${typography.fontSize}px`,
    "--diffs-line-height": `${typography.lineHeight}px`,
    "--diffs-tab-size": String(typography.tabSize),
    "--diffs-gap-inline": `${typography.paddingInline}px`,
    "--diffs-gap-block": `${typography.paddingBlock}px`,
    "--diffs-min-number-column-width": `${typography.minLineNumberDigits}ch`,
    "--diffs-scrollbar-gutter-override": "8px",
    "--diffs-font-features": '"tnum" 1, "liga" 0',
  } as PierreStyleBridge;
}
