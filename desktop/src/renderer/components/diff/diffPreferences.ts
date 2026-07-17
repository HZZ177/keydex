import { useCallback, useEffect, useMemo, useState } from "react";

import {
  KEYDEX_DIFF_PROFILES,
  type KeydexDiffLayout,
  type KeydexDiffProfileName,
} from "./profiles";

const STORAGE_PREFIX = "keydex.diff.display.v1";

export interface KeydexDiffDisplayPreference {
  readonly version: 1;
  readonly layout: KeydexDiffLayout;
  readonly wrap: boolean;
  readonly navigationOpen: boolean;
}

export interface KeydexDiffPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createKeydexDiffPreferenceKey(
  profile: KeydexDiffProfileName,
  scopeKey: string,
): string {
  return `${STORAGE_PREFIX}:${profile}:${stableScopeHash(scopeKey)}`;
}

export function defaultKeydexDiffPreference(
  profile: KeydexDiffProfileName,
): KeydexDiffDisplayPreference {
  const contract = KEYDEX_DIFF_PROFILES[profile];
  return Object.freeze({
    version: 1,
    layout: contract.defaultLayout,
    wrap: contract.defaultWrap,
    navigationOpen: false,
  });
}

export function readKeydexDiffPreference(
  profile: KeydexDiffProfileName,
  scopeKey: string,
  storage: KeydexDiffPreferenceStorage | null = browserStorage(),
): KeydexDiffDisplayPreference {
  const fallback = defaultKeydexDiffPreference(profile);
  if (!KEYDEX_DIFF_PROFILES[profile].persistDisplayPreferences || !storage) return fallback;
  try {
    const raw = storage.getItem(createKeydexDiffPreferenceKey(profile, scopeKey));
    if (!raw) return fallback;
    return normalizePreference(profile, JSON.parse(raw) as unknown, fallback);
  } catch {
    return fallback;
  }
}

export function writeKeydexDiffPreference(
  profile: KeydexDiffProfileName,
  scopeKey: string,
  preference: Partial<Omit<KeydexDiffDisplayPreference, "version">>,
  storage: KeydexDiffPreferenceStorage | null = browserStorage(),
): KeydexDiffDisplayPreference {
  const current = readKeydexDiffPreference(profile, scopeKey, storage);
  const next = normalizePreference(profile, { ...current, ...preference, version: 1 }, current);
  if (!KEYDEX_DIFF_PROFILES[profile].persistDisplayPreferences || !storage) return next;
  try {
    storage.setItem(createKeydexDiffPreferenceKey(profile, scopeKey), JSON.stringify(next));
  } catch {
    // Display preferences are best-effort and never block the viewer.
  }
  return next;
}

export function clearKeydexDiffPreference(
  profile: KeydexDiffProfileName,
  scopeKey: string,
  storage: KeydexDiffPreferenceStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(createKeydexDiffPreferenceKey(profile, scopeKey));
  } catch {
    // Ignore storage policy failures.
  }
}

export function useKeydexDiffDisplayPreference(
  profile: KeydexDiffProfileName,
  scopeKey: string,
) {
  const storageKey = useMemo(
    () => createKeydexDiffPreferenceKey(profile, scopeKey),
    [profile, scopeKey],
  );
  const [preference, setPreference] = useState(
    () => readKeydexDiffPreference(profile, scopeKey),
  );
  useEffect(() => {
    setPreference(readKeydexDiffPreference(profile, scopeKey));
  }, [profile, scopeKey, storageKey]);
  const update = useCallback((patch: Partial<Omit<KeydexDiffDisplayPreference, "version">>) => {
    setPreference((current) => writeKeydexDiffPreference(
      profile,
      scopeKey,
      { ...current, ...patch },
    ));
  }, [profile, scopeKey]);

  return Object.freeze({ preference, update, storageKey });
}

function normalizePreference(
  profile: KeydexDiffProfileName,
  value: unknown,
  fallback: KeydexDiffDisplayPreference,
): KeydexDiffDisplayPreference {
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  const contract = KEYDEX_DIFF_PROFILES[profile];
  const legacyLayout = typeof record.split === "boolean"
    ? record.split ? "split" : "stacked"
    : undefined;
  const candidateLayout = record.layout === "split" || record.layout === "stacked"
    ? record.layout
    : legacyLayout;
  const layout = candidateLayout && contract.allowedLayouts.includes(candidateLayout)
    ? candidateLayout
    : fallback.layout;
  const wrap = typeof record.wrap === "boolean"
    ? record.wrap
    : typeof record.lineWrapping === "boolean"
      ? record.lineWrapping
      : fallback.wrap;
  return Object.freeze({
    version: 1,
    layout,
    wrap,
    navigationOpen: typeof record.navigationOpen === "boolean"
      ? record.navigationOpen
      : fallback.navigationOpen,
  });
}

function stableScopeHash(value: string): string {
  let hash = 2166136261;
  for (const character of value.trim() || "default") {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function browserStorage(): KeydexDiffPreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
