import { createRoot, type Root } from "react-dom/client";

import {
  loadMaterialFileIcon,
  resolveMaterialFileIcon,
} from "@/renderer/components/workspace/materialIconTheme";
import type { MarkdownSnapshotBlock } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import {
  SemanticMarkdownRendererRegistry,
  defaultSemanticMarkdownRenderers,
  type MarkdownBlockDomInstance,
  type MarkdownBlockRendererContext,
  type MarkdownBlockRendererDefinition,
  type MarkdownBlockRendererDefinitions,
  type MarkdownBlockSourceMap,
} from "@/renderer/markdownRuntime/renderers";
import { parseFileLinkTarget } from "@/renderer/utils/fileLinks";
import type { PreviewContextValue } from "@/renderer/providers/PreviewProvider";

import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

export function createConversationMarkdownRendererRegistry(
  options: { readonly previewContext?: PreviewContextValue | null } = {},
): SemanticMarkdownRendererRegistry {
  const code = conversationCodeRenderer(options);
  const enhanced = Object.fromEntries(
    Object.entries(defaultSemanticMarkdownRenderers).map(([kind, definition]) => [
      kind,
      definition ? enhanceConversationDefinition(definition) : definition,
    ]),
  ) as MarkdownBlockRendererDefinitions;
  return new SemanticMarkdownRendererRegistry(enhanced, {
    code,
    mermaid: code,
    math: hybridMathRenderer(code),
  });
}

function enhanceConversationDefinition(definition: MarkdownBlockRendererDefinition): MarkdownBlockRendererDefinition {
  return {
    create(context) {
      const instance = definition.create(context);
      enhanceConversationElement(instance.element);
      return {
        get element() { return instance.element; },
        update(next) {
          const result = instance.update(next);
          enhanceConversationElement(instance.element);
          return result;
        },
        sourceMap: () => instance.sourceMap(),
        measure: () => instance.measure(),
        destroy: () => instance.destroy(),
      };
    },
  };
}

function enhanceConversationElement(element: HTMLElement): void {
  if (element.dataset.markdownTableScroll === "true") element.classList.add("keydex-markdown-table-scroll");
  element.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.setAttribute("loading", "lazy");
    image.setAttribute("decoding", "async");
    image.setAttribute("referrerpolicy", "no-referrer");
  });
  element.querySelectorAll<HTMLElement>("code[data-markdown-inline-kind='code']").forEach((code) => {
    const match = /^\[([^\]]+)\]\(\s*<?([^)>]+)>?\s*\)$/u.exec(code.textContent ?? "");
    if (!match) return;
    const anchor = code.ownerDocument.createElement("a");
    anchor.textContent = match[1];
    anchor.setAttribute("href", match[2]);
    for (const [name, value] of Object.entries(code.dataset)) {
      if (value !== undefined) anchor.dataset[name] = value;
    }
    anchor.dataset.markdownInlineKind = "link";
    anchor.dataset.markdownLinkNavigation = "host";
    code.replaceWith(anchor);
  });
  element.querySelectorAll<HTMLAnchorElement>('a[data-markdown-link-navigation="host"]').forEach((anchor) => {
    if ((anchor.getAttribute("href") ?? "").startsWith("#keydex-web-source=")) {
      const citationNumber = (anchor.textContent ?? "").trim().replace(/^\[(\d+)\]$/u, "$1");
      anchor.textContent = `[${citationNumber}]`;
      anchor.dataset.keydexWebSourceCitation = "true";
      anchor.dataset.tooltipLabel = "查看对应来源";
      anchor.setAttribute("aria-label", `查看来源 ${citationNumber}`.trim());
      anchor.removeAttribute("title");
      return;
    }
    if (anchor.dataset.keydexFileLink === "true") return;
    if (isAutoLinkedBareFileName(anchor)) {
      anchor.replaceWith(anchor.ownerDocument.createTextNode(anchor.textContent ?? ""));
      return;
    }
    const target = parseFileLinkTarget(anchor.getAttribute("href") ?? "");
    if (!target) return;
    const targetPath = decodeMarkdownHrefPath(target.path);
    const labelText = anchor.textContent ?? target.path;
    const icon = resolveMaterialFileIcon(targetPath);
    const iconElement = anchor.ownerDocument.createElement("img");
    iconElement.alt = "";
    iconElement.setAttribute("aria-hidden", "true");
    iconElement.dataset.iconId = icon.id;
    iconElement.dataset.keydexFileLinkIcon = "true";
    iconElement.draggable = false;
    iconElement.src = icon.src;
    // Material icon assets have large intrinsic SVG dimensions. Retained DOM
    // links do not carry a generated CSS-module class, so keep the semantic icon's
    // dimensions explicit as well as covered by shared Markdown CSS.
    iconElement.style.display = "inline-block";
    iconElement.style.width = "16px";
    iconElement.style.height = "16px";
    iconElement.style.maxWidth = "16px";
    iconElement.style.margin = "0";
    iconElement.style.borderRadius = "0";
    iconElement.style.objectFit = "contain";
    iconElement.style.flex = "0 0 auto";
    void loadMaterialFileIcon(targetPath).then((loadedIcon) => {
      if (iconElement.dataset.iconId === loadedIcon.id) {
        iconElement.src = loadedIcon.src;
      }
    });
    const label = anchor.ownerDocument.createElement("span");
    label.textContent = labelText;
    label.dataset.keydexFileLinkLabel = "true";
    anchor.replaceChildren(iconElement, label);
    anchor.style.display = "inline-flex";
    anchor.style.alignItems = "center";
    anchor.style.gap = "3px";
    anchor.style.verticalAlign = "-0.15em";
    anchor.dataset.keydexFileLink = "true";
    anchor.dataset.keydexFilePath = targetPath;
    if (target.line) {
      anchor.dataset.keydexFileLine = String(target.line);
      const badge = anchor.ownerDocument.createElement("span");
      badge.dataset.keydexFileLinkLineBadge = "true";
      badge.setAttribute("aria-hidden", "true");
      badge.title = `第 ${target.line} 行`;
      badge.textContent = `L${target.line}`;
      anchor.append(badge);
    }
  });
}

function isAutoLinkedBareFileName(anchor: HTMLAnchorElement): boolean {
  const label = (anchor.textContent ?? "").trim();
  const href = anchor.getAttribute("href") ?? "";
  if (!/^[\w.@+-]+\.(?:md|mdx|ts|tsx|js|jsx|py|rs|go|java|json|ya?ml|toml|css|html?)$/iu.test(label)) return false;
  return /^https?:\/\//iu.test(href) && href.replace(/^https?:\/\//iu, "").replace(/\/$/u, "") === label;
}

function decodeMarkdownHrefPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function hybridMathRenderer(code: MarkdownBlockRendererDefinition): MarkdownBlockRendererDefinition {
  const math = defaultSemanticMarkdownRenderers.math!;
  return {
    create(context) {
      return context.block.metadata.fence_markup ? code.create(context) : math.create(context);
    },
  };
}

function conversationCodeRenderer(
  options: { readonly previewContext?: PreviewContextValue | null },
): MarkdownBlockRendererDefinition {
  return {
    create(initial) {
      let context = initial;
      const element = initial.ownerDocument.createElement("div");
      applyAttributes(element, initial.block);
      const reactRoot = createRoot(element);
      render(reactRoot, initial, options);
      return {
        element,
        update(next) {
          const unchanged = next.block.content_hash === context.block.content_hash;
          context = next;
          applyAttributes(element, next.block);
          if (!unchanged) render(reactRoot, next, options);
          return unchanged ? "reused" : "updated";
        },
        sourceMap: () => sourceMap(context.block),
        measure: () => {
          const rect = element.getBoundingClientRect();
          return Object.freeze({ width: rect.width, height: rect.height });
        },
        destroy() {
          reactRoot.unmount();
          element.remove();
        },
      } satisfies MarkdownBlockDomInstance;
    },
  };
}

function render(
  root: Root,
  context: MarkdownBlockRendererContext,
  options: { readonly previewContext?: PreviewContextValue | null },
): void {
  const language = context.block.metadata.language;
  const source = context.snapshot.logical_text.slice(context.block.logical_start, context.block.logical_end);
  const streaming = context.snapshot.stream.kind === "streaming"
    && context.block.index >= context.snapshot.stream.tail_block_start
    && context.block.metadata.fence_markup !== undefined
    && context.block.metadata.fence_closed !== true;
  root.render(
    <MarkdownCodeBlock previewContextOverride={options.previewContext} streaming={streaming}>
      <code className={language ? `language-${language}` : undefined}>{source}</code>
    </MarkdownCodeBlock>,
  );
}

function applyAttributes(element: HTMLElement, block: MarkdownSnapshotBlock): void {
  element.dataset.markdownBlockId = block.id;
  element.dataset.markdownBlockKind = block.kind;
  element.dataset.markdownBlockIndex = String(block.index);
  element.dataset.markdownSourceStart = String(block.source_start);
  element.dataset.markdownSourceEnd = String(block.source_end);
  element.dataset.markdownLogicalStart = String(block.logical_start);
  element.dataset.markdownLogicalEnd = String(block.logical_end);
  element.dataset.markdownRendererProfile = "conversation";
  element.dataset.conversationMarkdownCodeHost = "true";
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
