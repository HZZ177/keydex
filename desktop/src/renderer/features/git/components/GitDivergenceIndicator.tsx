import { ArrowDownLeft, ArrowUpRight } from "lucide-react";

import styles from "./GitDivergenceIndicator.module.css";

export function GitDivergenceIndicator({
  ahead,
  behind,
}: {
  ahead: number | null | undefined;
  behind: number | null | undefined;
}) {
  const outgoing = Math.max(0, ahead ?? 0);
  const incoming = Math.max(0, behind ?? 0);
  if (incoming === 0 && outgoing === 0) return null;

  return (
    <span
      className={styles.root}
      aria-label={[
        incoming > 0 ? `传入 ${incoming} 个提交` : "",
        outgoing > 0 ? `传出 ${outgoing} 个提交` : "",
      ].filter(Boolean).join("，")}
    >
      {incoming > 0 ? (
        <span className={styles.incoming} data-direction="incoming" title={`传入 ${incoming} 个提交`}>
          <ArrowDownLeft size={13} strokeWidth={2} aria-hidden="true" />
          <span>{incoming}</span>
        </span>
      ) : null}
      {outgoing > 0 ? (
        <span className={styles.outgoing} data-direction="outgoing" title={`传出 ${outgoing} 个提交`}>
          <ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />
          <span>{outgoing}</span>
        </span>
      ) : null}
    </span>
  );
}
