import type { MarkdownSnapshotBlock } from "../document/MarkdownSnapshot";

export type MarkdownCodeTokenKind =
  | "keyword"
  | "string"
  | "number"
  | "literal"
  | "comment"
  | "function"
  | "property"
  | "attribute"
  | "tag"
  | "type"
  | "variable"
  | "operator"
  | "punctuation"
  | "regexp"
  | "meta"
  | "addition"
  | "deletion"
  | "selector";

export interface MarkdownCodeToken {
  readonly start: number;
  readonly end: number;
  readonly kind: MarkdownCodeTokenKind;
}

export interface MarkdownCodeHighlightResult {
  readonly blockId: string;
  readonly contentHash: string;
  readonly language: string | null;
  readonly tokens: readonly MarkdownCodeToken[];
  readonly truncated: boolean;
}

export interface MarkdownCodeHighlightTask {
  readonly signal: AbortSignal;
  readonly promise: Promise<MarkdownCodeHighlightResult>;
  cancel(reason?: string): void;
}

export interface MarkdownCodeHighlightService {
  highlight(block: MarkdownSnapshotBlock, code: string): MarkdownCodeHighlightTask;
}

export const CODE_HIGHLIGHT_WORKER_PROTOCOL_VERSION = 1;

export interface MarkdownCodeHighlightWorkerRequest {
  readonly protocolVersion: typeof CODE_HIGHLIGHT_WORKER_PROTOCOL_VERSION;
  readonly type: "highlight";
  readonly requestId: string;
  readonly language: MarkdownCodeHighlightLanguage;
  readonly code: string;
  readonly maxTokens: number;
  readonly sourceTruncated: boolean;
}

export interface MarkdownCodeHighlightWorkerCancelRequest {
  readonly protocolVersion: typeof CODE_HIGHLIGHT_WORKER_PROTOCOL_VERSION;
  readonly type: "cancel";
  readonly requestId: string;
}

export type MarkdownCodeHighlightWorkerMessage =
  | MarkdownCodeHighlightWorkerRequest
  | MarkdownCodeHighlightWorkerCancelRequest;

export interface MarkdownCodeHighlightWorkerResult {
  readonly protocolVersion: typeof CODE_HIGHLIGHT_WORKER_PROTOCOL_VERSION;
  readonly type: "highlight-result";
  readonly requestId: string;
  readonly language: MarkdownCodeHighlightLanguage;
  readonly tokens: readonly MarkdownCodeToken[];
  readonly truncated: boolean;
}

export interface MarkdownCodeHighlightWorkerError {
  readonly protocolVersion: typeof CODE_HIGHLIGHT_WORKER_PROTOCOL_VERSION;
  readonly type: "highlight-error";
  readonly requestId: string;
  readonly message: string;
}

export type MarkdownCodeHighlightWorkerResponse =
  | MarkdownCodeHighlightWorkerResult
  | MarkdownCodeHighlightWorkerError;

export const MARKDOWN_CODE_HIGHLIGHT_LANGUAGES = [
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "dart",
  "diff",
  "dockerfile",
  "go",
  "ini",
  "java",
  "javascript",
  "json",
  "kotlin",
  "less",
  "lua",
  "makefile",
  "markdown",
  "nginx",
  "objectivec",
  "perl",
  "pgsql",
  "php",
  "powershell",
  "properties",
  "protobuf",
  "python",
  "r",
  "ruby",
  "rust",
  "scala",
  "scss",
  "sql",
  "swift",
  "typescript",
  "vbnet",
  "xml",
  "yaml",
] as const;

export type MarkdownCodeHighlightLanguage = (typeof MARKDOWN_CODE_HIGHLIGHT_LANGUAGES)[number];

const HIGHLIGHT_LANGUAGE_SET = new Set<string>(MARKDOWN_CODE_HIGHLIGHT_LANGUAGES);
const HIGHLIGHT_LANGUAGE_ALIASES = new Map<string, MarkdownCodeHighlightLanguage>([
  ["c++", "cpp"],
  ["cc", "cpp"],
  ["cxx", "cpp"],
  ["hpp", "cpp"],
  ["cs", "csharp"],
  ["c#", "csharp"],
  ["docker", "dockerfile"],
  ["golang", "go"],
  ["htm", "xml"],
  ["html", "xml"],
  ["svg", "xml"],
  ["jsx", "javascript"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["kt", "kotlin"],
  ["kts", "kotlin"],
  ["make", "makefile"],
  ["mk", "makefile"],
  ["md", "markdown"],
  ["mdx", "markdown"],
  ["objc", "objectivec"],
  ["objective-c", "objectivec"],
  ["postgres", "pgsql"],
  ["postgresql", "pgsql"],
  ["ps1", "powershell"],
  ["pwsh", "powershell"],
  ["py", "python"],
  ["rb", "ruby"],
  ["rs", "rust"],
  ["sass", "scss"],
  ["sh", "bash"],
  ["shell", "bash"],
  ["shellscript", "bash"],
  ["zsh", "bash"],
  ["toml", "ini"],
  ["conf", "ini"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["yml", "yaml"],
]);

export function markdownCodeLanguageLabel(value: string | null | undefined): string | null {
  const language = value?.trim().toLowerCase();
  return language || null;
}

export function resolveMarkdownCodeHighlightLanguage(
  value: string | null | undefined,
): MarkdownCodeHighlightLanguage | null {
  const language = markdownCodeLanguageLabel(value);
  if (!language) return null;
  const alias = HIGHLIGHT_LANGUAGE_ALIASES.get(language);
  if (alias) return alias;
  return HIGHLIGHT_LANGUAGE_SET.has(language) ? language as MarkdownCodeHighlightLanguage : null;
}
