import { MarkdownRenderCache } from "../cache/MarkdownRenderCache";
import type { MarkdownSnapshotBlock } from "../document/MarkdownSnapshot";
import type {
  MarkdownBlockDomInstance,
  MarkdownBlockRendererContext,
  MarkdownBlockRendererDefinition,
  MarkdownBlockSourceMap,
} from "./types";
import { replaceMarkdownActionIcon } from "./domIcons";

export type MarkdownCodeTokenKind = "keyword" | "string" | "number" | "literal";
export interface MarkdownCodeToken { readonly start: number; readonly end: number; readonly kind: MarkdownCodeTokenKind }
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
export interface MarkdownCodeHighlighterOptions {
  readonly chunkCharacters?: number;
  readonly maxHighlightCharacters?: number;
  readonly maxTokens?: number;
  readonly yieldToMain?: () => Promise<void>;
}
export interface MarkdownCodeBlockRendererOptions {
  readonly cache?: MarkdownRenderCache;
  readonly highlighter?: MarkdownCodeHighlightService;
  readonly plainTextChunkCharacters?: number;
}

/** Cancellable descriptor-only highlighter. Multiple block tasks may run independently. */
export class MarkdownCodeHighlighter implements MarkdownCodeHighlightService {
  private readonly chunkCharacters: number;
  private readonly maxHighlightCharacters: number;
  private readonly maxTokens: number;

  constructor(private readonly options: MarkdownCodeHighlighterOptions = {}) {
    this.chunkCharacters = positiveInteger(options.chunkCharacters ?? 16_384, "chunkCharacters");
    this.maxHighlightCharacters = positiveInteger(options.maxHighlightCharacters ?? 200_000, "maxHighlightCharacters");
    this.maxTokens = positiveInteger(options.maxTokens ?? 1_000, "maxTokens");
  }

  highlight(block: MarkdownSnapshotBlock, code: string): MarkdownCodeHighlightTask {
    const controller = new AbortController();
    const promise = this.run(block, code, controller.signal);
    return Object.freeze({
      signal: controller.signal,
      promise,
      cancel: (reason?: string) => controller.abort(new DOMException(reason ?? "Code highlight cancelled", "AbortError")),
    });
  }

  private async run(block: MarkdownSnapshotBlock, code: string, signal: AbortSignal): Promise<MarkdownCodeHighlightResult> {
    const value = code.slice(0, this.maxHighlightCharacters);
    const tokens: MarkdownCodeToken[] = [];
    let tokenLimitReached = false;
    for (let start = 0; start < value.length; start += this.chunkCharacters) {
      if (signal.aborted) throw signal.reason;
      tokenize(value.slice(start, start + this.chunkCharacters), start, tokens);
      if (tokens.length >= this.maxTokens) {
        tokens.length = this.maxTokens;
        tokenLimitReached = true;
        break;
      }
      if (start + this.chunkCharacters < value.length) await (this.options.yieldToMain?.() ?? yieldToMain());
    }
    if (signal.aborted) throw signal.reason;
    return Object.freeze({
      blockId: block.id,
      contentHash: block.content_hash,
      language: normalizedLanguage(block.metadata.language),
      tokens: Object.freeze(tokens),
      truncated: code.length > this.maxHighlightCharacters || tokenLimitReached,
    });
  }
}

export function createCodeBlockRenderer(options: MarkdownCodeBlockRendererOptions = {}): MarkdownBlockRendererDefinition {
  const cache = options.cache ?? SHARED_CODE_CACHE;
  const highlighter = options.highlighter ?? SHARED_HIGHLIGHTER;
  const plainChunk = positiveInteger(options.plainTextChunkCharacters ?? 65_536, "plainTextChunkCharacters");
  return {
    create(initial) {
      let context = initial;
      let element = createFrame(context);
      let code = element.querySelector("code")!;
      let task: MarkdownCodeHighlightTask | null = null;
      let generation = 0;
      const render = (next: MarkdownBlockRendererContext) => {
        context = next;
        task?.cancel("Code block changed");
        task = null;
        generation += 1;
        const currentGeneration = generation;
        const value = blockText(next);
        element.dataset.markdownCodeHighlightState = "plain";
        renderPlain(code, value, plainChunk);
        installCopy(element, next, value);
        const language = normalizedLanguage(next.block.metadata.language);
        if (!language || !KNOWN_LANGUAGES.has(language)) {
          element.dataset.markdownCodeHighlightState = language ? "unsupported" : "plain";
          return;
        }
        const cached = cache.getDescriptor<MarkdownCodeHighlightResult>(next.block, next.profile.id);
        if (cached) {
          renderHighlighted(code, value, cached.tokens, plainChunk, next.block.logical_start);
          element.dataset.markdownCodeHighlightState = "ready";
          element.dataset.markdownCodeHighlightTruncated = cached.truncated ? "true" : "false";
          return;
        }
        element.dataset.markdownCodeHighlightState = "pending";
        task = highlighter.highlight(next.block, value);
        void task.promise.then((result) => {
          if (currentGeneration !== generation || task?.signal.aborted
            || result.blockId !== context.block.id || result.contentHash !== context.block.content_hash) return;
          cache.setDescriptor(next.block, next.profile.id, result);
          renderHighlighted(code, value, result.tokens, plainChunk, next.block.logical_start);
          element.dataset.markdownCodeHighlightState = "ready";
          element.dataset.markdownCodeHighlightTruncated = result.truncated ? "true" : "false";
        }).catch((error) => {
          if (currentGeneration !== generation) return;
          element.dataset.markdownCodeHighlightState = error instanceof DOMException && error.name === "AbortError"
            ? "cancelled" : "failed";
        });
      };
      render(initial);
      const instance: MarkdownBlockDomInstance = {
        get element() { return element; },
        update(next) {
          const rebuild = next.block.content_hash !== context.block.content_hash || next.profile.id !== context.profile.id;
          if (!rebuild) {
            context = next;
            applyFrameAttributes(element, next);
            return "reused";
          }
          task?.cancel("Code block replaced");
          const replacement = createFrame(next);
          element.replaceWith(replacement);
          element = replacement;
          code = element.querySelector("code")!;
          render(next);
          return "updated";
        },
        sourceMap: () => sourceMap(context.block),
        measure: () => {
          const rect = element.getBoundingClientRect();
          return Object.freeze({ width: rect.width, height: rect.height });
        },
        destroy() {
          generation += 1;
          task?.cancel("Code block destroyed");
          task = null;
          element.remove();
        },
      };
      return instance;
    },
  };
}

function createFrame(context: MarkdownBlockRendererContext): HTMLDivElement {
  const element = context.ownerDocument.createElement("div");
  const header = context.ownerDocument.createElement("div");
  header.dataset.markdownCodeHeader = "true";
  const language = context.ownerDocument.createElement("span");
  language.dataset.markdownCodeLanguageLabel = "true";
  header.append(language);
  const pre = context.ownerDocument.createElement("pre");
  pre.dataset.testid = "markdown-code-viewport";
  pre.dataset.scrollAxis = "x";
  const code = context.ownerDocument.createElement("code");
  pre.append(code);
  element.append(header, pre);
  applyFrameAttributes(element, context);
  return element;
}

function applyFrameAttributes(element: HTMLElement, context: MarkdownBlockRendererContext): void {
  const block = context.block;
  element.dataset.markdownBlockId = block.id;
  element.dataset.markdownBlockKind = block.kind;
  element.dataset.markdownBlockIndex = String(block.index);
  element.dataset.markdownSourceStart = String(block.source_start);
  element.dataset.markdownSourceEnd = String(block.source_end);
  element.dataset.markdownLogicalStart = String(block.logical_start);
  element.dataset.markdownLogicalEnd = String(block.logical_end);
  element.dataset.markdownRendererProfile = context.profile.id;
  element.dataset.markdownCodeFrame = "true";
  element.dataset.markdownCodeLanguage = normalizedLanguage(block.metadata.language) ?? "text";
  const language = element.querySelector<HTMLElement>("[data-markdown-code-language-label]");
  if (language) language.textContent = normalizedLanguage(block.metadata.language) ?? "text";
  const code = element.querySelector("code");
  if (code) code.className = block.metadata.language ? `language-${safeClass(block.metadata.language)}` : "";
}

function installCopy(element: HTMLElement, context: MarkdownBlockRendererContext, value: string): void {
  element.querySelector("[data-markdown-code-copy]")?.remove();
  if (!context.profile.codeActions || !context.interactions.onCodeCopy) return;
  const button = context.ownerDocument.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "复制代码");
  button.title = "复制代码";
  button.dataset.markdownCodeCopy = "true";
  button.dataset.markdownSelectionExclude = "true";
  button.style.userSelect = "none";
  replaceMarkdownActionIcon(button, "copy");
  button.addEventListener("click", () => {
    const result = context.interactions.onCodeCopy?.({
      code: value,
      language: context.block.metadata.language ?? null,
      block: context.block,
    });
    Promise.resolve(result).then(() => {
      if (!button.isConnected) return;
      replaceMarkdownActionIcon(button, "check");
      button.ownerDocument.defaultView?.setTimeout(() => {
        if (button.isConnected) replaceMarkdownActionIcon(button, "copy");
      }, 1_400);
    }).catch(() => undefined);
  });
  element.querySelector("[data-markdown-code-header]")?.append(button);
}

function renderPlain(code: HTMLElement, value: string, chunkSize: number): void {
  const fragment = code.ownerDocument.createDocumentFragment();
  for (let start = 0; start < value.length; start += chunkSize) {
    fragment.append(code.ownerDocument.createTextNode(value.slice(start, start + chunkSize)));
  }
  code.replaceChildren(fragment);
}

function renderHighlighted(
  code: HTMLElement,
  value: string,
  tokens: readonly MarkdownCodeToken[],
  chunkSize: number,
  logicalStart: number,
): void {
  const fragment = code.ownerDocument.createDocumentFragment();
  let cursor = 0;
  for (const token of tokens) {
    if (token.start < cursor || token.end > value.length) continue;
    appendPlain(fragment, code.ownerDocument, value.slice(cursor, token.start), chunkSize);
    const span = code.ownerDocument.createElement("span");
    span.dataset.codeTokenKind = token.kind;
    span.dataset.markdownLogicalStart = String(logicalStart + token.start);
    span.dataset.markdownLogicalEnd = String(logicalStart + token.end);
    span.textContent = value.slice(token.start, token.end);
    fragment.append(span);
    cursor = token.end;
  }
  appendPlain(fragment, code.ownerDocument, value.slice(cursor), chunkSize);
  code.replaceChildren(fragment);
}

function appendPlain(target: DocumentFragment, owner: Document, value: string, chunkSize: number): void {
  for (let start = 0; start < value.length; start += chunkSize) {
    target.append(owner.createTextNode(value.slice(start, start + chunkSize)));
  }
}

function sourceMap(block: MarkdownSnapshotBlock): MarkdownBlockSourceMap {
  return Object.freeze({
    blockId: block.id,
    sourceStart: block.source_start,
    sourceEnd: block.source_end,
    logicalStart: block.logical_start,
    logicalEnd: block.logical_end,
    inline: Object.freeze(block.inline_spans.map((span) => Object.freeze({ span, element: null }))),
  });
}

function blockText(context: MarkdownBlockRendererContext): string {
  return context.logicalText.slice(context.block.logical_start, context.block.logical_end);
}

function tokenize(value: string, offset: number, target: MarkdownCodeToken[]): void {
  const pattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|class|import|from|export|if|else|for|while|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b)/gu;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    target.push(Object.freeze({ start: offset + match.index, end: offset + match.index + match[0].length, kind: tokenKind(match[0]) }));
  }
}

function tokenKind(token: string): MarkdownCodeTokenKind {
  if (/^["'`]/u.test(token)) return "string";
  if (/^\d/u.test(token)) return "number";
  if (/^(?:true|false|null|undefined)$/u.test(token)) return "literal";
  return "keyword";
}

function normalizedLanguage(value: string | null | undefined): string | null {
  const language = value?.trim().toLowerCase();
  return language ? LANGUAGE_ALIASES.get(language) ?? language : null;
}

function safeClass(value: string): string {
  return value.replace(/[^a-z0-9_-]/giu, "-").slice(0, 64);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const LANGUAGE_ALIASES = new Map([["js", "javascript"], ["ts", "typescript"], ["py", "python"], ["yml", "yaml"]]);
const KNOWN_LANGUAGES = new Set(["javascript", "typescript", "jsx", "tsx", "json", "python", "css", "html", "xml", "yaml"]);
const SHARED_CODE_CACHE = new MarkdownRenderCache({ maxEntries: 512, maxBytes: 8 * 1024 * 1024 });
const SHARED_HIGHLIGHTER = new MarkdownCodeHighlighter();

export const codeBlockRenderer = createCodeBlockRenderer();
