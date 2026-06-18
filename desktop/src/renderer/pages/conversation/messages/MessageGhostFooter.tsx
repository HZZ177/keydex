import styles from "./MessageGhostFooter.module.css";

export interface MessageGhostFooterData {
  duration?: string;
}

export interface MessageGhostFooterProps {
  footer: MessageGhostFooterData | null;
}

export function MessageGhostFooter({ footer }: MessageGhostFooterProps) {
  if (!footer?.duration) {
    return null;
  }

  return (
    <footer className={styles.footer} aria-label="message metadata" data-testid="message-ghost-footer">
      <span className={styles.meta}>耗时 {footer.duration}</span>
    </footer>
  );
}
