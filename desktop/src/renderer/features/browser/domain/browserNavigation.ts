import { BROWSER_DEFAULT_SEARCH_URL } from "../config";

const MAX_RUNTIME_URL_LENGTH = 8_192;
const MAX_PERSISTED_TITLE_LENGTH = 512;
const MAX_FAVICON_URL_LENGTH = 2_048;
const HOST_LIKE_PATTERN = /^(?:localhost|(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#]|$)/u;
const SENSITIVE_PARAMETER = /^(?:code|token|access_token|id_token|refresh_token|auth|authorization|key|api_key|password|passwd|secret|client_secret|session|session_id|sid|signature|sig|x-amz-signature|[^=]*_(?:token|signature|secret)|session_[^=]*)$/i;
const SENSITIVE_FRAGMENT = /(?:^|[?&#])(code|token|access_token|id_token|refresh_token|session|signature|sig)=/i;

export interface ResolvedBrowserAddress {
  readonly kind: "url" | "domain" | "search";
  readonly url: string;
}

export interface SanitizedBrowserRestoreUrl {
  readonly restoreUrl: string | null;
  readonly sanitized: boolean;
}

export interface PersistableBrowserMetadata {
  readonly title: string;
  readonly faviconUrl?: string;
  readonly restoreUrl: string;
  readonly restoreUrlSanitized: boolean;
}

export interface BrowserMetadataRuntimeInput {
  readonly navigation: {
    readonly url: string;
    readonly title: string;
    readonly faviconUrl: string | null;
  };
}

export function resolveBrowserAddress(
  input: string,
  searchTemplate = BROWSER_DEFAULT_SEARCH_URL,
): ResolvedBrowserAddress {
  const value = input.trim();
  if (!value) throw new Error("请输入地址或搜索内容");

  const explicit = parseAllowedRemoteUrl(value);
  if (explicit) return { kind: "url", url: explicit.toString() };

  if (HOST_LIKE_PATTERN.test(value)) {
    const domain = parseAllowedRemoteUrl(`https://${value}`);
    if (domain) return { kind: "domain", url: domain.toString() };
  }
  if (looksLikeBlockedScheme(value)) throw new Error("不支持此地址协议");

  const searchUrl = searchTemplate.replace("{query}", encodeURIComponent(value));
  const search = parseAllowedRemoteUrl(searchUrl);
  if (!search) throw new Error("默认搜索地址无效");
  return { kind: "search", url: search.toString() };
}

export function sanitizeBrowserRestoreUrl(value: string): SanitizedBrowserRestoreUrl {
  const url = parseAllowedRemoteUrl(value);
  if (!url) return { restoreUrl: null, sanitized: true };
  let sanitized = false;

  if (url.username || url.password) {
    url.username = "";
    url.password = "";
    sanitized = true;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_PARAMETER.test(key)) {
      url.searchParams.delete(key);
      sanitized = true;
    }
  }
  if (SENSITIVE_FRAGMENT.test(url.hash)) {
    url.hash = "";
    sanitized = true;
  }
  if (url.toString().length > MAX_RUNTIME_URL_LENGTH) {
    url.search = "";
    url.hash = "";
    sanitized = true;
  }
  return { restoreUrl: url.toString(), sanitized };
}

export function sanitizeBrowserTitle(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PERSISTED_TITLE_LENGTH);
}

export function sanitizeBrowserFaviconUrl(
  value: string | null | undefined,
  documentUrl: string,
): string | undefined {
  if (!value || value.length > MAX_FAVICON_URL_LENGTH) return undefined;
  const favicon = parseAllowedRemoteUrl(value);
  const document = parseAllowedRemoteUrl(documentUrl);
  if (!favicon || !document || favicon.origin !== document.origin) return undefined;
  return favicon.toString();
}

export function persistableBrowserMetadata(
  runtime: BrowserMetadataRuntimeInput,
): PersistableBrowserMetadata | null {
  const restore = sanitizeBrowserRestoreUrl(runtime.navigation.url);
  if (!restore.restoreUrl) return null;
  const title = sanitizeBrowserTitle(runtime.navigation.title) || "浏览器";
  const faviconUrl = sanitizeBrowserFaviconUrl(
    runtime.navigation.faviconUrl,
    runtime.navigation.url,
  );
  return {
    title,
    ...(faviconUrl ? { faviconUrl } : {}),
    restoreUrl: restore.restoreUrl,
    restoreUrlSanitized: restore.sanitized,
  };
}

function parseAllowedRemoteUrl(value: string): URL | null {
  if (value.length > MAX_RUNTIME_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function looksLikeBlockedScheme(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(value);
}
