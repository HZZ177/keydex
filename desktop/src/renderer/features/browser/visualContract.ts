export const BROWSER_VISUAL_CONTRACT_SCHEMA_VERSION = 1 as const;

export const BROWSER_BASE_TOKENS = Object.freeze([
  "--radius-xs",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--radius-pill",
  "--shadow-soft",
  "--shadow-popover",
  "--motion-fast",
  "--motion-panel",
  "--motion-ease-out",
  "--motion-ease-standard",
] as const);

export const BROWSER_DUAL_THEME_TOKENS = Object.freeze([
  "--surface-bg",
  "--surface-muted",
  "--surface-hover",
  "--surface-active",
  "--color-bg-elevated",
  "--color-border-default",
  "--color-border-subtle",
  "--color-border-strong",
  "--color-text-1",
  "--color-text-2",
  "--color-text-3",
  "--color-text-4",
  "--color-accent",
  "--annotation-accent",
  "--color-warning",
  "--color-danger",
  "--control-pill-bg",
  "--control-pill-active-bg",
  "--control-pill-hover-bg",
  "--control-pill-border",
  "--control-pill-shadow",
] as const);

export const BROWSER_SHARED_COMPONENTS = Object.freeze([
  { name: "AppDialog", source: "renderer/components/dialog/AppDialog.tsx" },
  { name: "ConfirmDialog", source: "renderer/components/dialog/ConfirmDialog.tsx" },
  { name: "DialogButton", source: "renderer/components/dialog/DialogButton.tsx" },
  { name: "FloatingLayer", source: "renderer/components/floating/FloatingLayer.tsx" },
  { name: "AppTooltipLayer", source: "renderer/components/tooltip/AppTooltipLayer.tsx" },
  {
    name: "AppContextMenuProvider",
    source: "renderer/providers/AppContextMenuProvider.tsx",
  },
  { name: "NotificationProvider", source: "renderer/providers/NotificationProvider.tsx" },
] as const);

export const BROWSER_RIGHT_SIDEBAR_SELECTORS = Object.freeze([
  ".rightSidebar",
  ".rightSidebarTopbar",
  ".rightSidebarTabs",
  ".rightSidebarTab",
  ".rightSidebarTabMain",
  ".rightSidebarTabClose",
  ".rightSidebarAddTab",
  ".rightSidebarBody",
] as const);

export const BROWSER_INTERACTION_STATES = Object.freeze([
  ":hover",
  ":focus-visible",
  ":active",
  ":disabled",
  '[data-active="true"]',
  "prefers-reduced-motion",
] as const);

export const BROWSER_REMOTE_PAGE_THEME_POLICY = "force-keydex-appearance" as const;

export const BROWSER_OVERLAY_TOKEN_MAP = Object.freeze({
  accent: "--annotation-accent",
  surface: "--color-bg-elevated",
  text: "--color-text-1",
  border: "--color-border-strong",
  focus: "--annotation-accent",
  warning: "--color-warning",
  danger: "--color-danger",
  radius: "--radius-xs",
  motion: "--motion-fast",
} as const);

export interface BrowserRgbaColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

export interface BrowserPageAppearance {
  readonly theme: "light" | "dark";
  readonly backgroundColor: BrowserRgbaColor;
}

export interface BrowserAppearanceTheme extends BrowserPageAppearance {
  readonly tokens: {
    readonly accent: string;
    readonly surface: string;
    readonly text: string;
    readonly border: string;
    readonly focus: string;
    readonly warning: string;
    readonly danger: string;
  };
  readonly radiusPx: number;
  readonly motionMs: number;
  readonly reducedMotion: boolean;
}

export function readBrowserPageAppearance(
  theme: BrowserPageAppearance["theme"],
  root: Element = document.documentElement,
): BrowserPageAppearance {
  const styles = getComputedStyle(root);
  const fallback = theme === "dark" ? "#282a36" : "#ffffff";
  const background = resolveCssCustomProperty(styles, "--surface-bg") || fallback;
  return Object.freeze({
    theme,
    backgroundColor: Object.freeze(parseCssColor(background)),
  });
}

export function readBrowserAppearanceTheme(
  theme: BrowserAppearanceTheme["theme"],
  reducedMotion: boolean,
  root: Element = document.documentElement,
): BrowserAppearanceTheme {
  const styles = getComputedStyle(root);
  const color = (name: keyof BrowserAppearanceTheme["tokens"]): string => {
    const value = styles.getPropertyValue(BROWSER_OVERLAY_TOKEN_MAP[name]).trim();
    if (!value) throw new Error(`Missing Keydex browser overlay token: ${BROWSER_OVERLAY_TOKEN_MAP[name]}`);
    return value;
  };
  return Object.freeze({
    ...readBrowserPageAppearance(theme, root),
    tokens: Object.freeze({
      accent: color("accent"),
      surface: color("surface"),
      text: color("text"),
      border: color("border"),
      focus: color("focus"),
      warning: color("warning"),
      danger: color("danger"),
    }),
    radiusPx: readCssNumber(styles.getPropertyValue(BROWSER_OVERLAY_TOKEN_MAP.radius), "px", 0, 32),
    motionMs: reducedMotion
      ? 0
      : readCssNumber(styles.getPropertyValue(BROWSER_OVERLAY_TOKEN_MAP.motion), "ms", 0, 2_000),
    reducedMotion,
  });
}

function resolveCssCustomProperty(styles: CSSStyleDeclaration, name: string, depth = 0): string {
  if (depth > 8) throw new Error(`Circular Keydex browser color token: ${name}`);
  const value = styles.getPropertyValue(name).trim();
  const reference = /^var\(\s*(--[\w-]+)\s*(?:,[^)]+)?\)$/.exec(value);
  return reference ? resolveCssCustomProperty(styles, reference[1], depth + 1) : value;
}

function parseCssColor(rawValue: string): BrowserRgbaColor {
  const value = rawValue.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(value)?.[1];
  if (hex) {
    const expanded = hex.length <= 4 ? [...hex].map((part) => `${part}${part}`).join("") : hex;
    if (expanded.length === 6 || expanded.length === 8) {
      return {
        red: Number.parseInt(expanded.slice(0, 2), 16),
        green: Number.parseInt(expanded.slice(2, 4), 16),
        blue: Number.parseInt(expanded.slice(4, 6), 16),
        alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) : 255,
      };
    }
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value);
  if (rgb) {
    const channel = (index: number) => Math.round(Math.max(0, Math.min(255, Number(rgb[index]))));
    const alpha = rgb[4]?.endsWith("%")
      ? Math.round(Math.max(0, Math.min(100, Number(rgb[4].slice(0, -1)))) * 2.55)
      : Math.round(Math.max(0, Math.min(1, Number(rgb[4] ?? "1"))) * 255);
    return { red: channel(1), green: channel(2), blue: channel(3), alpha };
  }
  throw new Error(`Invalid Keydex browser page background token: ${rawValue}`);
}

function readCssNumber(
  rawValue: string,
  unit: "px" | "ms",
  minimum: number,
  maximum: number,
): number {
  const value = rawValue.trim();
  if (!value.endsWith(unit)) throw new Error(`Invalid Keydex browser overlay token: ${value}`);
  const parsed = Number(value.slice(0, -unit.length));
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid Keydex browser overlay token: ${value}`);
  }
  return parsed;
}
