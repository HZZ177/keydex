export interface ParsedFileLinkTarget {
  path: string;
  line: number | null;
  absolute: boolean;
}

export interface ParsedMarkdownFileLink {
  label: string;
  path: string;
  line: number | null;
  absolute: boolean;
}

const FILE_EXTENSION_PATTERN =
  /\.(?:avif|bmp|c|cc|cjs|cpp|cs|css|csv|diff|gif|go|h|hpp|htm|html|ico|ini|java|jpeg|jpg|js|json|jsx|kt|less|log|markdown|md|mdx|mjs|patch|png|ps1|py|rb|rs|sass|scss|sh|sql|svg|toml|ts|tsx|txt|vue|webp|xml|yaml|yml)$/i;
const MARKDOWN_FILE_LINK_PATTERN = /^\[([^\]\r\n]+)]\((<[^>\r\n]+>|[^)\s\r\n]+)(?:\s+"[^"]*")?\)$/;

export function parseMarkdownFileLinkExpression(value: string | undefined): ParsedMarkdownFileLink | null {
  const match = MARKDOWN_FILE_LINK_PATTERN.exec(value?.trim() ?? "");
  if (!match) {
    return null;
  }
  const label = match[1].trim();
  if (!label) {
    return null;
  }
  const target = parseFileLinkTarget(match[2]);
  if (!target) {
    return null;
  }
  return {
    label,
    path: target.path,
    line: target.line,
    absolute: target.absolute,
  };
}

export function parseFileLinkTarget(value: string | undefined): ParsedFileLinkTarget | null {
  const raw = normalizeMarkdownLinkTarget(value);
  if (!raw || raw.startsWith("#")) {
    return null;
  }

  const { line, path } = splitTrailingLineNumber(raw);
  const cleanPath = path.trim();
  if (!cleanPath || cleanPath.startsWith("#")) {
    return null;
  }
  if (!isWindowsAbsoluteFilePath(cleanPath) && hasNonFileScheme(cleanPath)) {
    return null;
  }
  const absolute = isAbsoluteFilePath(cleanPath);
  if (!absolute && !looksLikeFilePath(cleanPath)) {
    return null;
  }
  return { path: cleanPath, line, absolute };
}

export function resolveRelativeFileLinkPath(path: string, sourcePath: string): string | null {
  const rawPath = path.trim();
  const rawSourcePath = sourcePath.trim();
  if (!rawPath || !rawSourcePath || isAbsoluteFilePath(rawPath)) {
    return null;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (!decodedPath || /[\u0000-\u001f]/u.test(decodedPath)) {
    return null;
  }

  const source = splitPathRoot(normalizePathSeparators(rawSourcePath));
  const segments = source.rest.split("/").filter(Boolean);
  if (segments.length > 0) {
    segments.pop();
  }
  for (const segment of normalizePathSeparators(decodedPath).split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (!segments.length) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (!segments.length) {
    return null;
  }
  return `${source.root}${segments.join("/")}`;
}

export function isAbsoluteFilePath(path: string): boolean {
  const value = path.trim();
  return isWindowsAbsoluteFilePath(value) || value.startsWith("/") || value.startsWith("\\\\") || value.startsWith("//");
}

export function workspaceRelativeFilePath(path: string, workspaceRootPath: string): string | null {
  const target = normalizePathSeparators(path);
  const root = normalizePathSeparators(workspaceRootPath);
  if (!isAbsoluteFilePath(target) || !isAbsoluteFilePath(root)) {
    return null;
  }

  const normalizedRoot = root === "/" ? root : root.replace(/\/+$/u, "");
  const rootPrefix = normalizedRoot === "/" ? normalizedRoot : `${normalizedRoot}/`;
  const caseInsensitive = isWindowsAbsoluteFilePath(normalizedRoot) || normalizedRoot.startsWith("//");
  const comparableTarget = caseInsensitive ? target.toLowerCase() : target;
  const comparablePrefix = caseInsensitive ? rootPrefix.toLowerCase() : rootPrefix;
  if (!comparableTarget.startsWith(comparablePrefix)) {
    return null;
  }

  const relativePath = target.slice(rootPrefix.length).replace(/^\/+|\/+$/gu, "");
  if (!relativePath || relativePath.split("/").some((segment) => segment === "..")) {
    return null;
  }
  return relativePath;
}

function normalizeMarkdownLinkTarget(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function hasNonFileScheme(value: string): boolean {
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  return Boolean(scheme && scheme !== "file");
}

function isWindowsAbsoluteFilePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function normalizePathSeparators(value: string): string {
  return value.trim().replace(/\\/g, "/");
}

function splitPathRoot(path: string): { root: string; rest: string } {
  const windowsDrive = /^([a-zA-Z]:\/)/u.exec(path);
  if (windowsDrive) {
    return { root: windowsDrive[1], rest: path.slice(windowsDrive[1].length) };
  }
  const uncRoot = /^(\/\/[^/]+\/[^/]+\/)/u.exec(path);
  if (uncRoot) {
    return { root: uncRoot[1], rest: path.slice(uncRoot[1].length) };
  }
  if (path.startsWith("/")) {
    return { root: "/", rest: path.slice(1) };
  }
  return { root: "", rest: path };
}

function splitTrailingLineNumber(value: string): { path: string; line: number | null } {
  const match = /:(\d+)(?::\d+)?$/.exec(value);
  if (!match || typeof match.index !== "number") {
    return { path: value, line: null };
  }
  const line = Number.parseInt(match[1], 10);
  if (!Number.isFinite(line) || line <= 0) {
    return { path: value, line: null };
  }
  return { path: value.slice(0, match.index), line };
}

function looksLikeFilePath(value: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    /[\\/]/.test(value) ||
    FILE_EXTENSION_PATTERN.test(value)
  );
}
