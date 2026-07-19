import type {
  ChangeTypes,
  DiffsHighlighter,
  FileDiffMetadata,
  Hunk,
  RenderDiffOptions,
  ThemedDiffResult,
} from "@pierre/diffs";

import type { KeydexDiffFile } from "../model";
import type { KeydexDiffTheme } from "./pierreOptions";
import { KEYDEX_DIFF_THEME_NAMES } from "./pierreThemes";
import { loadPierreDiffs } from "./loadPierreDiffs";

export const KEYDEX_PIERRE_ALIGNED_VERSION = "1.2.12";

export type PierreAlignedAdapterPhase = "unsupported" | "parse" | "contract" | "highlight";

export interface PierreAlignedContentSegment {
  readonly type: "context" | "change";
  readonly lines: number;
  readonly deletions: number;
  readonly additions: number;
  readonly deletionLineIndex: number;
  readonly additionLineIndex: number;
}

export interface PierreAlignedHunk {
  readonly index: number;
  readonly collapsedBefore: number;
  readonly additionStart: number;
  readonly additionCount: number;
  readonly deletionStart: number;
  readonly deletionCount: number;
  readonly additionLineIndex: number;
  readonly deletionLineIndex: number;
  readonly context: string | null;
  readonly specs: string | null;
  readonly noEofAdditions: boolean;
  readonly noEofDeletions: boolean;
  readonly content: readonly PierreAlignedContentSegment[];
}

export type PierreAlignedAstNode =
  | { readonly type: "text"; readonly value: string }
  | {
      readonly type: "element";
      readonly tagName: string;
      readonly properties: Readonly<Record<string, string | number | boolean | readonly string[]>>;
      readonly children: readonly PierreAlignedAstNode[];
    }
  | { readonly type: "unknown"; readonly children: readonly PierreAlignedAstNode[] };

export interface PierreAlignedPreparedFile {
  readonly pierreVersion: typeof KEYDEX_PIERRE_ALIGNED_VERSION;
  readonly fileId: string;
  readonly fileCacheKey: string;
  readonly sourceVersion: string;
  readonly name: string;
  readonly previousName: string | null;
  readonly oldMode: string | null;
  readonly newMode: string | null;
  readonly changeType: ChangeTypes;
  readonly language: string;
  readonly partial: boolean;
  readonly deletionLines: readonly string[];
  readonly additionLines: readonly string[];
  readonly hunks: readonly PierreAlignedHunk[];
  readonly highlightedDeletionLines: readonly PierreAlignedAstNode[];
  readonly highlightedAdditionLines: readonly PierreAlignedAstNode[];
  readonly themeStyles: string;
  readonly baseThemeType: "light" | "dark" | null;
}

export type PierreAlignedPublicApi = Pick<
  typeof import("@pierre/diffs"),
  | "parsePatchFiles"
  | "renderDiffWithHighlighter"
  | "getSharedHighlighter"
  | "getFiletypeFromFileName"
> & Partial<Pick<typeof import("@pierre/diffs"), "parseDiffFromFile">>;

export interface PreparePierreAlignedFileOptions {
  readonly theme: KeydexDiffTheme;
  readonly sourceVersion: string;
  readonly api?: PierreAlignedPublicApi;
  readonly highlighter?: DiffsHighlighter;
}

export class PierreAlignedAdapterError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly phase: PierreAlignedAdapterPhase,
    message: string,
    options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PierreAlignedAdapterError";
    this.retryable = options.retryable ?? phase === "highlight";
  }
}

export async function preparePierreAlignedFile(
  file: KeydexDiffFile,
  options: PreparePierreAlignedFileOptions,
): Promise<PierreAlignedPreparedFile> {
  if (file.binary || file.contentKind === "binary") {
    throw new PierreAlignedAdapterError("unsupported", "二进制文件不支持智能分栏", {
      retryable: false,
    });
  }
  if (file.truncated) {
    throw new PierreAlignedAdapterError("unsupported", "截断的差异不支持智能分栏", {
      retryable: false,
    });
  }
  const api = options.api ?? await loadPierreDiffs();
  const metadata = parsePierreAlignedFile(api, file);
  const themeName = KEYDEX_DIFF_THEME_NAMES[options.theme];
  const language = metadata.lang ?? api.getFiletypeFromFileName(metadata.name);
  let rendered: ThemedDiffResult;
  try {
    const highlighter = options.highlighter ?? await api.getSharedHighlighter({
      themes: [themeName],
      langs: [language],
    });
    rendered = api.renderDiffWithHighlighter(
      metadata,
      highlighter,
      pierreAlignedRenderOptions(themeName),
    );
  } catch (cause) {
    throw new PierreAlignedAdapterError(
      "highlight",
      "差异语法高亮准备失败",
      { retryable: true, cause },
    );
  }

  return finalizePierreAlignedFile(file, metadata, rendered, options.sourceVersion, language);
}

export function finalizePierreAlignedFile(
  file: KeydexDiffFile,
  metadata: FileDiffMetadata,
  rendered: ThemedDiffResult,
  sourceVersion: string,
  language = metadata.lang ?? file.language,
): PierreAlignedPreparedFile {
  if (
    rendered.code.deletionLines.length !== metadata.deletionLines.length
    || rendered.code.additionLines.length !== metadata.additionLines.length
  ) {
    throw new PierreAlignedAdapterError("contract", "差异高亮结果与行模型不一致");
  }
  return Object.freeze({
    pierreVersion: KEYDEX_PIERRE_ALIGNED_VERSION,
    fileId: file.id,
    fileCacheKey: file.cacheKey,
    sourceVersion,
    name: metadata.name,
    previousName: metadata.prevName ?? null,
    oldMode: metadata.prevMode ?? file.oldMode,
    newMode: metadata.mode ?? file.newMode,
    changeType: metadata.type,
    language,
    partial: metadata.isPartial,
    deletionLines: Object.freeze([...metadata.deletionLines]),
    additionLines: Object.freeze([...metadata.additionLines]),
    hunks: Object.freeze(metadata.hunks.map(toAlignedHunk)),
    highlightedDeletionLines: Object.freeze(rendered.code.deletionLines.map(cloneAstNode)),
    highlightedAdditionLines: Object.freeze(rendered.code.additionLines.map(cloneAstNode)),
    themeStyles: rendered.themeStyles,
    baseThemeType: rendered.baseThemeType ?? null,
  });
}

export function pierreAlignedRenderOptions(theme: string): RenderDiffOptions {
  return Object.freeze({
    theme,
    useTokenTransformer: false,
    tokenizeMaxLineLength: 1_000,
    lineDiffType: "word-alt",
    maxLineDiffLength: 1_000,
  });
}

export function parsePierreAlignedFile(
  api: PierreAlignedPublicApi,
  file: KeydexDiffFile,
): FileDiffMetadata {
  if (file.oldContent !== undefined && file.newContent !== undefined && api.parseDiffFromFile) {
    try {
      return api.parseDiffFromFile(
        {
          name: file.oldPath ?? file.displayPath,
          contents: file.oldContent,
          lang: file.language as never,
          cacheKey: `${file.cacheKey}:old`,
        },
        {
          name: file.newPath ?? file.displayPath,
          contents: file.newContent,
          lang: file.language as never,
          cacheKey: `${file.cacheKey}:new`,
        },
        undefined,
        true,
      );
    } catch (cause) {
      throw new PierreAlignedAdapterError("parse", "完整文件差异解析失败", { cause });
    }
  }
  let parsed: ReturnType<PierreAlignedPublicApi["parsePatchFiles"]>;
  try {
    parsed = api.parsePatchFiles(file.patch, file.cacheKey, true);
  } catch (cause) {
    throw new PierreAlignedAdapterError("parse", "差异补丁解析失败", { cause });
  }
  const candidates = parsed.flatMap((patch) => patch.files);
  if (candidates.length === 0) {
    throw new PierreAlignedAdapterError("contract", "差异补丁中没有可显示的文件");
  }
  const paths = new Set(
    [file.displayPath, file.oldPath, file.newPath]
      .filter((path): path is string => Boolean(path))
      .map(normalizePath),
  );
  return candidates.find((candidate) => (
    paths.has(normalizePath(candidate.name))
    || (candidate.prevName ? paths.has(normalizePath(candidate.prevName)) : false)
  )) ?? candidates[0]!;
}

function toAlignedHunk(hunk: Hunk, index: number): PierreAlignedHunk {
  return Object.freeze({
    index,
    collapsedBefore: hunk.collapsedBefore,
    additionStart: hunk.additionStart,
    additionCount: hunk.additionCount,
    deletionStart: hunk.deletionStart,
    deletionCount: hunk.deletionCount,
    additionLineIndex: hunk.additionLineIndex,
    deletionLineIndex: hunk.deletionLineIndex,
    context: hunk.hunkContext?.trim() || null,
    specs: hunk.hunkSpecs?.trimEnd() || null,
    noEofAdditions: hunk.noEOFCRAdditions,
    noEofDeletions: hunk.noEOFCRDeletions,
    content: Object.freeze(hunk.hunkContent.map((content) => Object.freeze({
      type: content.type,
      lines: content.type === "context" ? content.lines : 0,
      deletions: content.type === "change" ? content.deletions : 0,
      additions: content.type === "change" ? content.additions : 0,
      deletionLineIndex: content.deletionLineIndex,
      additionLineIndex: content.additionLineIndex,
    }))),
  });
}

function cloneAstNode(value: unknown): PierreAlignedAstNode {
  if (!value || typeof value !== "object") {
    return Object.freeze({ type: "text", value: String(value ?? "") });
  }
  const node = value as Record<string, unknown>;
  if (node.type === "text") {
    return Object.freeze({ type: "text", value: typeof node.value === "string" ? node.value : "" });
  }
  const children = Array.isArray(node.children)
    ? Object.freeze(node.children.map(cloneAstNode))
    : Object.freeze([] as PierreAlignedAstNode[]);
  if (node.type !== "element" || typeof node.tagName !== "string") {
    return Object.freeze({ type: "unknown", children });
  }
  return Object.freeze({
    type: "element",
    tagName: node.tagName,
    properties: clonePrimitiveProperties(node.properties),
    children,
  });
}

function clonePrimitiveProperties(
  value: unknown,
): Readonly<Record<string, string | number | boolean | readonly string[]>> {
  if (!value || typeof value !== "object") return Object.freeze({});
  const result: Record<string, string | number | boolean | readonly string[]> = {};
  for (const [key, property] of Object.entries(value as Record<string, unknown>)) {
    if (typeof property === "string" || typeof property === "number" || typeof property === "boolean") {
      result[key] = property;
    } else if (Array.isArray(property) && property.every((item) => typeof item === "string")) {
      result[key] = Object.freeze([...property]);
    }
  }
  return Object.freeze(result);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^(?:a|b)\//u, "");
}
