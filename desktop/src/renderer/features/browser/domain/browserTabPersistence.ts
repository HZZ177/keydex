import { BROWSER_INTERNAL_BLANK_URL } from "../config";
import {
  sanitizeBrowserFaviconUrl,
  sanitizeBrowserRestoreUrl,
  sanitizeBrowserTitle,
} from "./browserNavigation";
import type { BrowserTabState } from "./browserTabHost";

export const BROWSER_TAB_PERSISTENCE_SCHEMA_VERSION = 1 as const;

export interface PersistedBrowserTabSnapshot {
  readonly schemaVersion: typeof BROWSER_TAB_PERSISTENCE_SCHEMA_VERSION;
  readonly id: string;
  readonly title: string;
  readonly faviconUrl: string | null;
  readonly restoreUrl: string;
  readonly restoreUrlSanitized: boolean;
  readonly profileMode: "persistent";
  readonly zoomFactor: number;
  readonly createdAt: string;
  readonly lastActivatedAt: string;
}

const PERSISTED_BROWSER_TAB_KEYS = [
  "schemaVersion",
  "id",
  "title",
  "faviconUrl",
  "restoreUrl",
  "restoreUrlSanitized",
  "profileMode",
  "zoomFactor",
  "createdAt",
  "lastActivatedAt",
] as const;

export function serializePersistableBrowserTab(
  state: BrowserTabState,
): PersistedBrowserTabSnapshot | null {
  if (state.profileMode !== "persistent") return null;
  const restore = persistedRestoreUrl(state.restoreUrl);
  if (!restore) return null;
  return {
    schemaVersion: BROWSER_TAB_PERSISTENCE_SCHEMA_VERSION,
    id: state.id,
    title: sanitizeBrowserTitle(state.title) || "浏览器",
    faviconUrl: sanitizeBrowserFaviconUrl(state.faviconUrl, restore.restoreUrl) ?? null,
    restoreUrl: restore.restoreUrl,
    restoreUrlSanitized: state.restoreUrlSanitized || restore.sanitized,
    profileMode: "persistent",
    zoomFactor: normalizeZoomFactor(state.zoomFactor) ?? 1,
    createdAt: state.createdAt,
    lastActivatedAt: state.lastActivatedAt,
  };
}

export function normalizePersistedBrowserTab(
  raw: unknown,
): BrowserTabState | null {
  if (!isRecord(raw)
    || Object.keys(raw).length !== PERSISTED_BROWSER_TAB_KEYS.length
    || PERSISTED_BROWSER_TAB_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(raw, key))
    || raw.schemaVersion !== BROWSER_TAB_PERSISTENCE_SCHEMA_VERSION
    || raw.profileMode !== "persistent"
    || !isNonEmptyString(raw.id)
    || !isNonEmptyString(raw.createdAt)
    || !isNonEmptyString(raw.lastActivatedAt)
    || typeof raw.title !== "string"
    || (raw.faviconUrl !== null && typeof raw.faviconUrl !== "string")
    || typeof raw.restoreUrl !== "string"
    || typeof raw.restoreUrlSanitized !== "boolean") return null;
  const zoomFactor = normalizeZoomFactor(raw.zoomFactor);
  const restore = persistedRestoreUrl(raw.restoreUrl);
  if (zoomFactor === null || !restore) return null;
  const faviconUrl = typeof raw.faviconUrl === "string"
    ? sanitizeBrowserFaviconUrl(raw.faviconUrl, restore.restoreUrl)
    : undefined;
  return {
    id: raw.id,
    title: sanitizeBrowserTitle(raw.title) || "浏览器",
    ...(faviconUrl ? { faviconUrl } : {}),
    restoreUrl: restore.restoreUrl === BROWSER_INTERNAL_BLANK_URL ? "" : restore.restoreUrl,
    restoreUrlSanitized: raw.restoreUrlSanitized || restore.sanitized,
    profileMode: "persistent",
    zoomFactor,
    createdAt: raw.createdAt,
    lastActivatedAt: raw.lastActivatedAt,
  };
}

function persistedRestoreUrl(
  value: string,
): { readonly restoreUrl: string; readonly sanitized: boolean } | null {
  if (!value || value === BROWSER_INTERNAL_BLANK_URL) {
    return { restoreUrl: BROWSER_INTERNAL_BLANK_URL, sanitized: false };
  }
  const restore = sanitizeBrowserRestoreUrl(value);
  return restore.restoreUrl
    ? { restoreUrl: restore.restoreUrl, sanitized: restore.sanitized }
    : null;
}

function normalizeZoomFactor(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.5 && value <= 3
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
