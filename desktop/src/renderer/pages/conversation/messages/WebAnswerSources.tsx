import { ExternalLink, Globe2 } from "lucide-react";
import { useEffect, useRef } from "react";

import type { WebSourceCitation } from "./webSourceMarkers";
import styles from "./MessageText.module.css";

export interface WebSourceActivation {
  sourceId: string;
  sequence: number;
}

export function WebAnswerSources({
  citations,
  activation,
}: {
  citations: readonly WebSourceCitation[];
  activation: WebSourceActivation | null;
}) {
  const rowsRef = useRef(new Map<string, HTMLAnchorElement>());

  useEffect(() => {
    if (!activation) return;
    const row = rowsRef.current.get(activation.sourceId);
    if (!row) return;
    row.focus({ preventScroll: true });
    if (typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
  }, [activation]);

  if (!citations.length) return null;

  return (
    <section className={styles.webAnswerSources} data-testid="web-answer-sources" aria-label="回答来源">
      <div className={styles.webAnswerSourcesHeader}>
        <Globe2 aria-hidden="true" size={13} />
        <span>来源</span>
        <small>{citations.length}</small>
      </div>
      <ol className={styles.webAnswerSourceList}>
        {citations.map((citation) => {
          const safeUrl = safeHttpUrl(citation.source.url);
          const active = Boolean(activation && citation.sourceIds.includes(activation.sourceId));
          const copy = (
            <>
              <span className={styles.webAnswerSourceNumber}>[{citation.number}]</span>
              <span className={styles.webAnswerSourceFavicon} aria-hidden="true">
                <Globe2 size={13} />
                {safeHttpUrl(citation.source.favicon ?? "") ? (
                  <img
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    src={citation.source.favicon ?? undefined}
                    onError={(event) => { event.currentTarget.hidden = true; }}
                  />
                ) : null}
              </span>
              <span className={styles.webAnswerSourceCopy}>
                <strong>{citation.source.title || citation.source.domain}</strong>
                <small>{citation.source.domain}</small>
              </span>
              {safeUrl ? <ExternalLink aria-hidden="true" size={12} /> : null}
            </>
          );
          return (
            <li key={citation.number}>
              {safeUrl ? (
                <a
                  aria-label={`打开来源 ${citation.number}：${citation.source.title || citation.source.domain}`}
                  className={styles.webAnswerSourceRow}
                  data-active={active ? "true" : "false"}
                  data-source-id={citation.sourceId}
                  href={safeUrl}
                  ref={(element) => {
                    for (const sourceId of citation.sourceIds) {
                      if (element) rowsRef.current.set(sourceId, element);
                      else rowsRef.current.delete(sourceId);
                    }
                  }}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {copy}
                </a>
              ) : (
                <div className={styles.webAnswerSourceRow} data-active={active ? "true" : "false"}>
                  {copy}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
