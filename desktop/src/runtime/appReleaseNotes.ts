const RELEASES_API_URL = "https://api.github.com/repos/HZZ177/keydex/releases";
const RELEASES_PAGE_SIZE = 100;
const RELEASES_MAX_PAGES = 10;
const RELEASE_HISTORY_CACHE_KEY = "keydex.app-release-history.v2";
const RELEASE_HISTORY_FRESH_MS = 30 * 60 * 1000;

export interface AppReleaseNote {
  id: string;
  version: string;
  tagName: string;
  title: string;
  body: string;
  publishedAt: string | null;
  htmlUrl: string;
  prerelease: boolean;
}

export interface AppReleaseHistory {
  releases: AppReleaseNote[];
  source: "network" | "cache";
  fetchedAt: number;
  stale: boolean;
}

export interface LoadAppReleaseHistoryOptions {
  signal?: AbortSignal;
  forceRefresh?: boolean;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  now?: () => number;
}

interface CachedReleaseHistory {
  fetchedAt: number;
  releases: AppReleaseNote[];
}

let memoryCache: CachedReleaseHistory | null = null;

export async function loadAppReleaseHistory(
  options: LoadAppReleaseHistoryOptions = {},
): Promise<AppReleaseHistory> {
  const now = options.now?.() ?? Date.now();
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const cached = memoryCache ?? readCachedReleaseHistory(storage);
  if (!options.forceRefresh && cached && now - cached.fetchedAt < RELEASE_HISTORY_FRESH_MS) {
    memoryCache = cached;
    return historyFromCache(cached, false);
  }

  try {
    const releases = await fetchAllReleasePages(options.fetcher ?? fetch, options.signal);
    const nextCache = { fetchedAt: now, releases };
    memoryCache = nextCache;
    writeCachedReleaseHistory(storage, nextCache);
    return { releases, source: "network", fetchedAt: now, stale: false };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    if (cached) {
      memoryCache = cached;
      return historyFromCache(cached, true);
    }
    throw error;
  }
}

export function parseGitHubReleaseList(payload: unknown): AppReleaseNote[] {
  if (!Array.isArray(payload)) {
    throw new Error("GitHub 返回的更新日志格式无效");
  }

  return payload
    .filter(isRecord)
    .filter((release) => release.draft !== true)
    .map((release): AppReleaseNote | null => {
      const tagName = stringValue(release.tag_name).trim();
      if (!tagName) {
        return null;
      }
      const version = tagName.replace(/^v/iu, "");
      const title = stringValue(release.name).trim() || `Keydex ${version}`;
      const publishedAt = nullableStringValue(release.published_at);
      return {
        id: String(release.id ?? tagName),
        version,
        tagName,
        title,
        body: normalizeReleaseMarkdown(stringValue(release.body)),
        publishedAt,
        htmlUrl: safeGitHubReleaseUrl(stringValue(release.html_url)),
        prerelease: release.prerelease === true,
      };
    })
    .filter((release): release is AppReleaseNote => release !== null)
    .sort((left, right) => releaseTimestamp(right) - releaseTimestamp(left));
}

/**
 * v0.3.11 was published through a workflow_dispatch string input, which
 * flattened every line break. Repair only that recognizable shape; normal
 * multi-line Markdown is kept byte-for-byte apart from newline normalization.
 */
export function normalizeReleaseMarkdown(value: string | null | undefined): string {
  const normalized = (value ?? "").replace(/\r\n?/gu, "\n").trim();
  if (!normalized || normalized.includes("\n")) {
    return normalized;
  }
  const headingCount = normalized.match(/\s#{2,6}\s/gu)?.length ?? 0;
  const listItemCount = normalized.match(/\s-\s(?=\S)/gu)?.length ?? 0;
  if (headingCount < 2 || listItemCount < 2) {
    return normalized;
  }
  return normalized
    .replace(/\s+(#{2,6})\s+/gu, "\n\n$1 ")
    .replace(/\s+-\s+(?=\S)/gu, "\n- ")
    .replace(/\s+(Built from commit\b)/giu, "\n\n$1")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function resetAppReleaseHistoryCacheForTests(): void {
  memoryCache = null;
}

async function fetchAllReleasePages(
  fetcher: NonNullable<LoadAppReleaseHistoryOptions["fetcher"]>,
  signal?: AbortSignal,
): Promise<AppReleaseNote[]> {
  const releases: AppReleaseNote[] = [];
  for (let page = 1; page <= RELEASES_MAX_PAGES; page += 1) {
    const response = await fetcher(`${RELEASES_API_URL}?per_page=${RELEASES_PAGE_SIZE}&page=${page}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal,
    });
    if (!response.ok) {
      if (response.status === 403) {
        throw new Error("GitHub 更新日志请求过于频繁，请稍后重试");
      }
      throw new Error(`获取更新日志失败（HTTP ${response.status}）`);
    }
    const pagePayload = await response.json() as unknown;
    if (!Array.isArray(pagePayload)) {
      throw new Error("GitHub 返回的更新日志格式无效");
    }
    releases.push(...parseGitHubReleaseList(pagePayload));
    if (pagePayload.length < RELEASES_PAGE_SIZE) {
      break;
    }
  }
  return deduplicateReleases(releases)
    .sort((left, right) => releaseTimestamp(right) - releaseTimestamp(left));
}

function deduplicateReleases(releases: AppReleaseNote[]): AppReleaseNote[] {
  return [...new Map(releases.map((release) => [release.tagName, release])).values()];
}

function historyFromCache(cache: CachedReleaseHistory, stale: boolean): AppReleaseHistory {
  return {
    releases: cache.releases,
    source: "cache",
    fetchedAt: cache.fetchedAt,
    stale,
  };
}

function readCachedReleaseHistory(
  storage: LoadAppReleaseHistoryOptions["storage"],
): CachedReleaseHistory | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(RELEASE_HISTORY_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.releases)) {
      return null;
    }
    const releases = parsed.releases.filter(isCachedReleaseNote);
    if (releases.length !== parsed.releases.length) {
      return null;
    }
    return {
      fetchedAt: parsed.fetchedAt,
      releases: releases.map((release) => ({
        ...release,
        body: normalizeReleaseMarkdown(release.body),
      })),
    };
  } catch {
    return null;
  }
}

function writeCachedReleaseHistory(
  storage: LoadAppReleaseHistoryOptions["storage"],
  cache: CachedReleaseHistory,
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(RELEASE_HISTORY_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // A successful network response should still be usable when storage is unavailable.
  }
}

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function safeGitHubReleaseUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : "";
  } catch {
    return "";
  }
}

function releaseTimestamp(release: AppReleaseNote): number {
  const timestamp = release.publishedAt ? Date.parse(release.publishedAt) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isCachedReleaseNote(value: unknown): value is AppReleaseNote {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.version === "string"
    && typeof value.tagName === "string"
    && typeof value.title === "string"
    && typeof value.body === "string"
    && (value.publishedAt === null || typeof value.publishedAt === "string")
    && typeof value.htmlUrl === "string"
    && typeof value.prerelease === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}
