export interface DiffLanguageInput {
  readonly path?: string | null;
  readonly explicitLanguage?: string | null;
  readonly content?: string | null;
}

const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = Object.freeze({
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  diff: "diff",
  go: "go",
  h: "c",
  hpp: "cpp",
  htm: "html",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "jsonc",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  patch: "diff",
  php: "php",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sass: "sass",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
});

const FILE_NAME_LANGUAGES: Readonly<Record<string, string>> = Object.freeze({
  dockerfile: "dockerfile",
  makefile: "makefile",
  rakefile: "ruby",
  gemfile: "ruby",
  "pnpm-lock.yaml": "yaml",
  "package-lock.json": "json",
});

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  js: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  shell: "bash",
  sh: "bash",
  yml: "yaml",
  ps1: "powershell",
  plaintext: "text",
  txt: "text",
});

export function resolveDiffLanguage(input: DiffLanguageInput): string {
  const explicit = normalizeLanguage(input.explicitLanguage);
  if (explicit) return explicit;

  const normalizedPath = input.path?.replaceAll("\\", "/") ?? "";
  const name = normalizedPath.split("/").pop()?.toLowerCase() ?? "";
  const byName = FILE_NAME_LANGUAGES[name];
  if (byName) return byName;
  const extension = name.includes(".") ? name.split(".").pop() ?? "" : "";
  const byExtension = EXTENSION_LANGUAGES[extension];
  if (byExtension) return byExtension;
  return languageFromShebang(input.content) ?? "text";
}

export function normalizeDiffLanguage(language: string | null | undefined): string {
  return normalizeLanguage(language) ?? "text";
}

function normalizeLanguage(language: string | null | undefined): string | null {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return null;
  return LANGUAGE_ALIASES[normalized] ?? (normalized.replace(/[^a-z0-9_+-]/gu, "") || null);
}

function languageFromShebang(content: string | null | undefined): string | null {
  const firstLine = content?.replace(/^\uFEFF/u, "").split(/\r?\n/u, 1)[0]?.toLowerCase();
  if (!firstLine?.startsWith("#!")) return null;
  if (/\b(?:python|python3)\b/u.test(firstLine)) return "python";
  if (/\b(?:node|deno|bun)\b/u.test(firstLine)) return "javascript";
  if (/\b(?:bash|zsh|sh)\b/u.test(firstLine)) return "bash";
  if (/\b(?:pwsh|powershell)\b/u.test(firstLine)) return "powershell";
  if (/\bruby\b/u.test(firstLine)) return "ruby";
  return null;
}
