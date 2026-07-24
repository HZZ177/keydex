import { BROWSER_DEFAULT_SEARCH_URL } from "../config";

const MAX_RUNTIME_URL_LENGTH = 8_192;
const MAX_PERSISTED_TITLE_LENGTH = 512;
const MAX_FAVICON_URL_LENGTH = 2_048;
const HOST_LIKE_PATTERN = /^(?:localhost|(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#]|$)/u;
const SENSITIVE_PARAMETER = /^(?:code|token|access_token|id_token|refresh_token|auth|authorization|key|api_key|password|passwd|secret|client_secret|session|session_id|sid|signature|sig|x-amz-signature|[^=]*_(?:token|signature|secret)|session_[^=]*)$/i;
const SENSITIVE_FRAGMENT = /(?:^|[?&#])(code|token|access_token|id_token|refresh_token|session|signature|sig)=/i;

export interface ResolvedBrowserAddress {
  readonly kind: "url" | "domain" | "search" | "file";
  readonly url: string;
}

export type BrowserFileAddressErrorCode =
  | "control_character"
  | "invalid_percent_encoding"
  | "relative_path"
  | "directory_path"
  | "invalid_file_authority"
  | "invalid_file_path";

export class BrowserFileAddressError extends Error {
  readonly code: BrowserFileAddressErrorCode;

  constructor(code: BrowserFileAddressErrorCode, message: string) {
    super(message);
    this.name = "BrowserFileAddressError";
    this.code = code;
  }
}

export interface CanonicalBrowserFileAddress {
  readonly kind: "local_file";
  readonly url: string;
  readonly canonicalKey: string;
  readonly authority: string | null;
  readonly windowsPath: string;
}

export type BrowserNavigationIntentSource =
  | "address_bar"
  | "app_preview"
  | "page_link"
  | "redirect"
  | "popup"
  | "restore"
  | "history";

export interface BrowserNavigationIntent {
  readonly source: BrowserNavigationIntentSource;
  readonly initiatorUrl?: string;
  readonly userGesture: boolean;
}

export interface AuthorizedBrowserNavigation {
  readonly url: string;
  readonly targetKind: "remote" | "local_file";
  readonly intent: BrowserNavigationIntent;
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

  if (looksLikeWindowsAbsolutePath(value) || value.toLowerCase().startsWith("file:")) {
    const file = canonicalizeBrowserFileAddress(value);
    return { kind: "file", url: file.url };
  }

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
  if (looksLikeWindowsAbsolutePath(value) || value.trim().toLowerCase().startsWith("file:")) {
    try {
      const file = canonicalizeBrowserFileAddress(value);
      return {
        restoreUrl: file.url,
        sanitized: value !== file.url,
      };
    } catch {
      return { restoreUrl: null, sanitized: true };
    }
  }
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

export function canonicalizeBrowserFileAddress(
  input: string,
): CanonicalBrowserFileAddress {
  const value = input.trim();
  if (!value) {
    throw new BrowserFileAddressError("relative_path", "本地文件路径不能为空");
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new BrowserFileAddressError("control_character", "本地文件路径包含控制字符");
  }
  if (value.toLowerCase().startsWith("file:") && hasMalformedPercentEncoding(value)) {
    throw new BrowserFileAddressError(
      "invalid_percent_encoding",
      "本地文件路径包含非法百分号编码",
    );
  }
  if (endsWithPathSeparator(value)) {
    throw new BrowserFileAddressError("directory_path", "本地目录不能作为浏览器页面打开");
  }

  if (looksLikeWindowsDrivePath(value)) {
    return canonicalizeWindowsDrivePath(value);
  }
  if (looksLikeUncPath(value)) {
    return canonicalizeUncPath(value);
  }
  if (!value.toLowerCase().startsWith("file:")) {
    throw new BrowserFileAddressError("relative_path", "仅支持 Windows 绝对文件路径");
  }
  return canonicalizeFileUrl(value);
}

export function authorizeBrowserNavigation(input: {
  readonly target: string;
  readonly intent: BrowserNavigationIntent;
}): AuthorizedBrowserNavigation {
  const targetValue = input.target.trim();
  const remote = parseAllowedRemoteUrl(targetValue);
  if (remote) {
    return {
      url: remote.toString(),
      targetKind: "remote",
      intent: input.intent,
    };
  }

  let file: CanonicalBrowserFileAddress;
  try {
    file = canonicalizeBrowserFileAddress(targetValue);
  } catch (error) {
    if (looksLikeBlockedScheme(targetValue) || looksLikeWindowsAbsolutePath(targetValue)) {
      throw error;
    }
    throw new Error("不支持此地址协议");
  }
  const initiatorKind = navigationInitiatorKind(input.intent.initiatorUrl);
  const trustedDirect = input.intent.source === "address_bar"
    || input.intent.source === "app_preview"
    || input.intent.source === "restore";
  const sameLocalContext = initiatorKind === "local_file"
    && (
      input.intent.source === "page_link"
      || input.intent.source === "redirect"
      || input.intent.source === "popup"
      || input.intent.source === "history"
    );
  const gestureSatisfied = input.intent.source !== "popup"
    && input.intent.source !== "page_link"
    || input.intent.userGesture;
  if ((!trustedDirect && !sameLocalContext) || !gestureSatisfied) {
    throw new BrowserFileAddressError(
      "invalid_file_path",
      "远程页面不能导航到本地文件",
    );
  }
  return {
    url: file.url,
    targetKind: "local_file",
    intent: input.intent,
  };
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

function canonicalizeWindowsDrivePath(value: string): CanonicalBrowserFileAddress {
  const drive = value[0].toUpperCase();
  const segments = normalizeFileSegments(value.slice(3).split(/[\\/]/));
  if (!segments.length) {
    throw new BrowserFileAddressError("directory_path", "本地目录不能作为浏览器页面打开");
  }
  const url = new URL("file:///");
  url.pathname = `/${drive}:/${segments.map(encodeFilePathSegment).join("/")}`;
  return browserFileAddress(url, null, `${drive}:\\${segments.join("\\")}`);
}

function canonicalizeUncPath(value: string): CanonicalBrowserFileAddress {
  const segments = value.slice(2).split(/[\\/]/);
  const authority = segments.shift()?.trim().toLowerCase() ?? "";
  const normalized = normalizeFileSegments(segments);
  if (!isValidFileAuthority(authority) || normalized.length < 2) {
    throw new BrowserFileAddressError(
      "invalid_file_authority",
      "UNC 路径必须包含合法主机、共享名和文件名",
    );
  }
  const url = new URL(`file://${authority}/`);
  url.pathname = `/${normalized.map(encodeFilePathSegment).join("/")}`;
  return browserFileAddress(
    url,
    authority,
    `\\\\${authority}\\${normalized.join("\\")}`,
  );
}

function canonicalizeFileUrl(value: string): CanonicalBrowserFileAddress {
  const authorityEnd = value.indexOf("/", "file://".length);
  const rawAuthority = authorityEnd === -1
    ? value.slice("file://".length)
    : value.slice("file://".length, authorityEnd);
  if (value.toLowerCase().startsWith("file://") && /[@:]/.test(rawAuthority)) {
    throw new BrowserFileAddressError(
      "invalid_file_authority",
      "file URL authority 无效",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserFileAddressError("invalid_file_path", "file URL 无效");
  }
  if (url.protocol !== "file:" || url.username || url.password || url.port) {
    throw new BrowserFileAddressError(
      "invalid_file_authority",
      "file URL authority 无效",
    );
  }
  const authority = url.hostname.toLowerCase();
  if (authority && authority !== "localhost" && !isValidFileAuthority(authority)) {
    throw new BrowserFileAddressError(
      "invalid_file_authority",
      "file URL authority 无效",
    );
  }
  const decodedSegments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  if (!decodedSegments.length) {
    throw new BrowserFileAddressError("directory_path", "本地目录不能作为浏览器页面打开");
  }

  const driveSegment = decodedSegments[0] ?? "";
  if (/^[a-zA-Z]:$/.test(driveSegment)) {
    const pathSegments = normalizeFileSegments(decodedSegments.slice(1));
    if (!pathSegments.length) {
      throw new BrowserFileAddressError("directory_path", "本地目录不能作为浏览器页面打开");
    }
    const drive = driveSegment[0].toUpperCase();
    const canonical = new URL("file:///");
    canonical.pathname = `/${drive}:/${pathSegments.map(encodeFilePathSegment).join("/")}`;
    canonical.hash = url.hash;
    return browserFileAddress(
      canonical,
      null,
      `${drive}:\\${pathSegments.join("\\")}`,
    );
  }

  const normalized = normalizeFileSegments(decodedSegments);
  if (!authority || authority === "localhost" || normalized.length < 2) {
    throw new BrowserFileAddressError(
      "invalid_file_path",
      "file URL 必须是 Windows 盘符路径或合法 UNC 路径",
    );
  }
  const canonical = new URL(`file://${authority}/`);
  canonical.pathname = `/${normalized.map(encodeFilePathSegment).join("/")}`;
  canonical.hash = url.hash;
  return browserFileAddress(
    canonical,
    authority,
    `\\\\${authority}\\${normalized.join("\\")}`,
  );
}

function browserFileAddress(
  url: URL,
  authority: string | null,
  windowsPath: string,
): CanonicalBrowserFileAddress {
  const href = url.toString();
  return {
    kind: "local_file",
    url: href,
    canonicalKey: href.toLocaleLowerCase("en-US"),
    authority,
    windowsPath,
  };
}

function normalizeFileSegments(segments: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!normalized.length) {
        throw new BrowserFileAddressError(
          "invalid_file_path",
          "本地文件路径不能越过根目录",
        );
      }
      normalized.pop();
      continue;
    }
    if (/[<>:"|?*\u0000-\u001f]/.test(segment)) {
      throw new BrowserFileAddressError(
        "invalid_file_path",
        "本地文件路径包含 Windows 非法字符",
      );
    }
    normalized.push(segment);
  }
  return normalized;
}

function encodeFilePathSegment(segment: string): string {
  // URL.pathname does not escape a literal percent sign. Encode each decoded
  // filesystem segment first so %, #, spaces and non-ASCII names remain one
  // path segment and round-trip through both WebView2 and the Rust URL parser.
  return encodeURIComponent(segment);
}

function looksLikeWindowsAbsolutePath(value: string): boolean {
  return looksLikeWindowsDrivePath(value) || looksLikeUncPath(value);
}

function looksLikeWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function looksLikeUncPath(value: string): boolean {
  return /^(?:\\\\|\/\/)[^\\/]/.test(value);
}

function endsWithPathSeparator(value: string): boolean {
  return value.endsWith("\\") || value.endsWith("/");
}

function hasMalformedPercentEncoding(value: string): boolean {
  for (let index = value.indexOf("%"); index !== -1; index = value.indexOf("%", index + 1)) {
    if (!/^[\da-f]{2}$/i.test(value.slice(index + 1, index + 3))) return true;
  }
  return false;
}

function isValidFileAuthority(value: string): boolean {
  return value.length > 0
    && value.length <= 255
    && value !== "."
    && value !== ".."
    && /^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(value);
}

function navigationInitiatorKind(
  value: string | undefined,
): "remote" | "local_file" | "unknown" {
  if (!value) return "unknown";
  if (parseAllowedRemoteUrl(value)) return "remote";
  try {
    canonicalizeBrowserFileAddress(value);
    return "local_file";
  } catch {
    return "unknown";
  }
}

function looksLikeBlockedScheme(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(value);
}
