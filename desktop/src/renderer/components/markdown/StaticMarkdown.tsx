import { useId, useLayoutEffect, useRef } from "react";

import {
  CONVERSATION_MARKDOWN_RENDERER_PROFILE,
  RetainedMarkdownDocumentRenderer,
} from "@/renderer/markdownRuntime/renderers";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import { openExternalUrl } from "@/runtime/externalLinks";

export interface StaticMarkdownProps {
  source: string;
  className?: string;
  ariaLabel?: string;
}

export function StaticMarkdown({ source, className = "", ariaLabel }: StaticMarkdownProps) {
  const documentId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const renderer = new RetainedMarkdownDocumentRenderer(root, {
      profile: CONVERSATION_MARKDOWN_RENDERER_PROFILE,
      interactions: {
        onLinkActivate: (_event, { href }) => {
          if (/^https:\/\//iu.test(href)) {
            void openExternalUrl(href).catch(() => undefined);
          }
        },
      },
    });
    try {
      renderer.render(parseCanonicalMarkdownSnapshot({
        surface: "message",
        documentId,
        revision: staticMarkdownRevision(source),
        source,
        rendererProfile: "conversation",
      }));
      delete root.dataset.staticMarkdownError;
    } catch (error) {
      renderer.destroy();
      root.textContent = source;
      root.dataset.staticMarkdownError = error instanceof Error ? error.message : String(error);
    }
    return () => renderer.destroy();
  }, [documentId, source]);

  return <div aria-label={ariaLabel} className={className} ref={rootRef} />;
}

function staticMarkdownRevision(source: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `static-${source.length}-${(hash >>> 0).toString(16)}`;
}
