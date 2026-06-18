import styles from "./MessageGhostFooter.module.css";

export interface MessageGhostFooterData {
  traceId?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  duration?: string;
}

export interface MessageGhostFooterProps {
  footer: MessageGhostFooterData | null;
}

export function MessageGhostFooter({ footer }: MessageGhostFooterProps) {
  if (!footer || !hasVisibleFooterData(footer)) {
    return null;
  }

  const tokenParts = tokenSummary(footer);
  return (
    <footer className={styles.footer} aria-label="message metadata" data-testid="message-ghost-footer">
      {tokenParts.length ? <span className={styles.meta}>token {tokenParts.join(" - ")}</span> : null}
      {footer.duration ? <span className={styles.meta}>耗时 {footer.duration}</span> : null}
    </footer>
  );
}

function hasVisibleFooterData(footer: MessageGhostFooterData): boolean {
  return Boolean(footer.duration || tokenSummary(footer).length);
}

function tokenSummary(footer: MessageGhostFooterData): string[] {
  return [
    formatTokenPart("输入", footer.inputTokens),
    formatTokenPart("缓存", footer.cacheReadTokens),
    formatTokenPart("输出", footer.outputTokens),
  ].filter((part): part is string => Boolean(part));
}

function formatTokenPart(label: string, value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return `${label} ${value}`;
}
