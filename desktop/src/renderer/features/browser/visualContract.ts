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

export const BROWSER_REMOTE_PAGE_THEME_POLICY = "preserve-site" as const;

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

export interface BrowserOverlayTheme {
  readonly theme: "light" | "dark";
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

export function readBrowserOverlayTheme(
  theme: BrowserOverlayTheme["theme"],
  reducedMotion: boolean,
  root: Element = document.documentElement,
): BrowserOverlayTheme {
  const styles = getComputedStyle(root);
  const color = (name: keyof BrowserOverlayTheme["tokens"]): string => {
    const value = styles.getPropertyValue(BROWSER_OVERLAY_TOKEN_MAP[name]).trim();
    if (!value) throw new Error(`Missing Keydex browser overlay token: ${BROWSER_OVERLAY_TOKEN_MAP[name]}`);
    return value;
  };
  return Object.freeze({
    theme,
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
