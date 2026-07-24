export const BROWSER_CONFIG_SCHEMA_VERSION = 1 as const;
export const BROWSER_DEFAULT_SEARCH_URL = "https://www.bing.com/search?q={query}" as const;
export const BROWSER_INTERNAL_BLANK_URL = "about:blank" as const;

export const BROWSER_PROTOCOL_VERSIONS = Object.freeze({
  rightSidebarState: 2,
  browserHost: 2,
  webAnnotation: 1,
  webAnnotationBridge: 1,
} as const);

export const BROWSER_LIMITS = Object.freeze({
  maxPanelMetadata: 20,
  maxLiveSurfaces: 10,
  maxWarmSurfaces: 5,
  permissionTimeoutMs: 30_000,
  bridgeMaxMessageBytes: 256 * 1024,
  resolveBatchSize: 50,
  resolveMutationDebounceMs: 250,
  resolveMutationMaxDelayMs: 2_000,
  resolveSliceBudgetMs: 8,
  crashLoopCount: 3,
  crashLoopWindowMs: 5 * 60_000,
  stagedAssetTtlHours: 24,
  maxContextItems: 20,
  maxContextBytes: 128 * 1024,
} as const);

export interface BrowserFeatureFlags {
  readonly browserEnabled: boolean;
  readonly annotationsEnabled: boolean;
  readonly internalProbeEnabled: boolean;
}

export interface BrowserBuildEnvironment {
  readonly VITE_KEYDEX_BROWSER_ENABLED?: string;
  readonly VITE_KEYDEX_BROWSER_ANNOTATIONS_ENABLED?: string;
  readonly VITE_KEYDEX_BROWSER_M0_PROBE_ENABLED?: string;
}

export interface BrowserContractFixture {
  readonly schemaVersion: typeof BROWSER_CONFIG_SCHEMA_VERSION;
  readonly protocols: typeof BROWSER_PROTOCOL_VERSIONS;
  readonly releaseFeatureFlags: BrowserFeatureFlags;
  readonly limits: typeof BROWSER_LIMITS;
}

const RELEASE_FEATURE_FLAGS: BrowserFeatureFlags = Object.freeze({
  browserEnabled: true,
  annotationsEnabled: true,
  internalProbeEnabled: false,
});

export function resolveBrowserFeatureFlags(
  mode: string,
  environment: BrowserBuildEnvironment = {},
): BrowserFeatureFlags {
  const browserEnabled = resolveBuildFlag(environment.VITE_KEYDEX_BROWSER_ENABLED, true);
  const annotationsEnabled =
    browserEnabled
    && resolveBuildFlag(environment.VITE_KEYDEX_BROWSER_ANNOTATIONS_ENABLED, true);
  const internalProbeEnabled =
    mode !== "production"
    && resolveBuildFlag(environment.VITE_KEYDEX_BROWSER_M0_PROBE_ENABLED, true);

  return Object.freeze({ browserEnabled, annotationsEnabled, internalProbeEnabled });
}

function resolveBuildFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === "1") return true;
  if (value === "0") return false;
  return fallback;
}

export const BROWSER_FEATURE_FLAGS = resolveBrowserFeatureFlags(import.meta.env.MODE, {
  VITE_KEYDEX_BROWSER_ENABLED: import.meta.env.VITE_KEYDEX_BROWSER_ENABLED,
  VITE_KEYDEX_BROWSER_ANNOTATIONS_ENABLED:
    import.meta.env.VITE_KEYDEX_BROWSER_ANNOTATIONS_ENABLED,
  VITE_KEYDEX_BROWSER_M0_PROBE_ENABLED:
    import.meta.env.VITE_KEYDEX_BROWSER_M0_PROBE_ENABLED,
});

export function parseBrowserContractFixture(value: unknown): BrowserContractFixture {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "protocols",
    "releaseFeatureFlags",
    "limits",
  ])) {
    throw new Error("browser contract fixture fields are invalid");
  }
  if (value.schemaVersion !== BROWSER_CONFIG_SCHEMA_VERSION) {
    throw new Error("browser contract fixture schema version is unsupported");
  }
  if (!matchesNumberRecord(value.protocols, BROWSER_PROTOCOL_VERSIONS)) {
    throw new Error("browser protocol versions do not match the runtime contract");
  }
  if (!matchesFeatureFlags(value.releaseFeatureFlags, RELEASE_FEATURE_FLAGS)) {
    throw new Error("browser release feature flags do not match the production defaults");
  }
  if (!matchesNumberRecord(value.limits, BROWSER_LIMITS)) {
    throw new Error("browser limits do not match the runtime contract");
  }
  return {
    schemaVersion: BROWSER_CONFIG_SCHEMA_VERSION,
    protocols: BROWSER_PROTOCOL_VERSIONS,
    releaseFeatureFlags: RELEASE_FEATURE_FLAGS,
    limits: BROWSER_LIMITS,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function matchesNumberRecord(
  value: unknown,
  expected: Readonly<Record<string, number>>,
): boolean {
  if (!isRecord(value) || !hasExactKeys(value, Object.keys(expected))) return false;
  return Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

function matchesFeatureFlags(
  value: unknown,
  expected: BrowserFeatureFlags,
): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "browserEnabled",
    "annotationsEnabled",
    "internalProbeEnabled",
  ])) return false;
  return value.browserEnabled === expected.browserEnabled
    && value.annotationsEnabled === expected.annotationsEnabled
    && value.internalProbeEnabled === expected.internalProbeEnabled;
}
