import type { CodeViewOptions, FileDiffOptions } from "@pierre/diffs";
import type {
  WorkerInitializationRenderOptions,
  WorkerPoolOptions,
  WorkerRenderingOptions,
} from "@pierre/diffs/worker";

import {
  KEYDEX_DIFF_PROFILES,
  type KeydexDiffLayout,
  type KeydexDiffProfileName,
} from "../profiles";
import { keydexDiffTypography } from "../diffTypography";
import { KEYDEX_DIFF_THEME_NAMES } from "./pierreThemes";

export type KeydexDiffTheme = "light" | "dark";
export type PierreViewKind = "single" | "multi";

const PIERRE_WORKER_POOL_MIN = 2;
const PIERRE_WORKER_POOL_MAX = 4;
const PIERRE_WORKER_AST_CACHE_SIZE = 100;

export interface KeydexPierreRenderConfig {
  readonly kind: PierreViewKind;
  readonly profile: KeydexDiffProfileName;
  readonly theme: KeydexDiffTheme;
  readonly layout?: KeydexDiffLayout;
  readonly wrap?: boolean;
  readonly selectionEnabled?: boolean;
}

export function createPierreWorkerPoolOptions(
  workerFactory: () => Worker,
  hardwareConcurrency = globalThis.navigator?.hardwareConcurrency,
): WorkerPoolOptions {
  const availableCores = Number.isFinite(hardwareConcurrency)
    ? Math.max(1, Math.floor(hardwareConcurrency!))
    : PIERRE_WORKER_POOL_MAX;
  const poolSize = Math.min(
    PIERRE_WORKER_POOL_MAX,
    Math.max(PIERRE_WORKER_POOL_MIN, Math.floor(availableCores / 2)),
  );
  return Object.freeze({
    workerFactory,
    poolSize,
    totalASTLRUCacheSize: PIERRE_WORKER_AST_CACHE_SIZE,
  });
}

export function createPierreWorkerHighlighterOptions(
  theme: KeydexDiffTheme,
): WorkerInitializationRenderOptions {
  return Object.freeze({
    theme: KEYDEX_DIFF_THEME_NAMES[theme],
    lineDiffType: "word-alt",
    maxLineDiffLength: 1_000,
    tokenizeMaxLineLength: 1_000,
    useTokenTransformer: false,
  });
}

export function createPierreWorkerThemeRefresh(
  theme: KeydexDiffTheme,
): Pick<WorkerRenderingOptions, "theme"> {
  return Object.freeze({ theme: KEYDEX_DIFF_THEME_NAMES[theme] });
}

export function keydexCodeViewLayout(profile: KeydexDiffProfileName) {
  const typography = keydexDiffTypography(profile);
  return Object.freeze({
    paddingTop: 0,
    paddingBottom: typography.paddingBlock,
    gap: typography.itemGap,
  });
}

export function keydexCodeViewItemMetrics(profile: KeydexDiffProfileName) {
  const typography = keydexDiffTypography(profile);
  return Object.freeze({
    hunkLineCount: typography.hunkLineCount,
    lineHeight: typography.lineHeight,
    diffHeaderHeight: typography.headerHeight,
    spacing: 0,
    paddingTop: 0,
    paddingBottom: typography.paddingBlock,
  });
}

export class PierreOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PierreOptionsError";
  }
}

export function createPierreRenderOptions<LAnnotation = undefined>(
  config: KeydexPierreRenderConfig & { readonly kind: "single" },
): FileDiffOptions<LAnnotation>;
export function createPierreRenderOptions<LAnnotation = undefined>(
  config: KeydexPierreRenderConfig & { readonly kind: "multi" },
): CodeViewOptions<LAnnotation>;
export function createPierreRenderOptions<LAnnotation = undefined>(
  config: KeydexPierreRenderConfig,
): FileDiffOptions<LAnnotation> | CodeViewOptions<LAnnotation> {
  assertKnownConfig(config);
  const profile = KEYDEX_DIFF_PROFILES[config.profile];
  if (!profile) throw new PierreOptionsError(`未知差异视图类型：${String(config.profile)}`);
  const layout = config.layout ?? profile.defaultLayout;
  if (!profile.allowedLayouts.includes(layout)) {
    throw new PierreOptionsError(`${config.profile} 视图不支持 ${layout} 布局`);
  }
  const selectionEnabled = config.selectionEnabled ?? false;
  if (selectionEnabled && profile.selection !== "git_patch") {
    throw new PierreOptionsError(`${config.profile} 视图不允许 Git 行选择`);
  }

  const common: FileDiffOptions<LAnnotation> = {
    theme: KEYDEX_DIFF_THEME_NAMES,
    themeType: config.theme,
    diffStyle: layout === "stacked" ? "unified" : "split",
    overflow: (config.wrap ?? profile.defaultWrap) ? "wrap" : "scroll",
    disableFileHeader: true,
    disableLineNumbers: false,
    disableBackground: false,
    diffIndicators: "bars",
    hunkSeparators: "line-info",
    expandUnchanged: false,
    collapsedContextThreshold: profile.density === "compact" ? 2 : 4,
    expansionLineCount: 20,
    lineDiffType: "word-alt",
    maxLineDiffLength: 1_000,
    tokenizeMaxLineLength: 1_000,
    tokenizeMaxLength: 100_000,
    lineHoverHighlight: "line",
    enableLineSelection: selectionEnabled,
    controlledSelection: selectionEnabled,
    enableTokenInteractionsOnWhitespace: false,
    enableGutterUtility: false,
    useTokenTransformer: false,
    disableErrorHandling: false,
  };

  if (config.kind === "single") return Object.freeze(common);
  return Object.freeze({
    ...common,
    stickyHeaders: true,
    pointerEventsOnScroll: true,
    layout: keydexCodeViewLayout(config.profile),
    itemMetrics: keydexCodeViewItemMetrics(config.profile),
  });
}

const CONFIG_KEYS = new Set([
  "kind",
  "profile",
  "theme",
  "layout",
  "wrap",
  "selectionEnabled",
]);

function assertKnownConfig(config: KeydexPierreRenderConfig) {
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length > 0) {
    throw new PierreOptionsError(`不允许直接传入 Pierre 参数：${unknown.join("、")}`);
  }
}
