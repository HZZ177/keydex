import { AlertTriangle, Check, CircleSlash, Info, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import styles from "./A2UIStateLine.module.css";

export type A2UIStateTone = "neutral" | "success" | "warning" | "danger" | "running";

export interface A2UIStateLineProps {
  children: ReactNode;
  tone?: A2UIStateTone;
  testId?: string;
}

export function A2UIStateLine({ children, tone = "neutral", testId = "a2ui-state-line" }: A2UIStateLineProps) {
  return (
    <div className={styles.line} data-testid={testId} data-tone={tone} aria-live={tone === "danger" ? "polite" : undefined}>
      {stateIcon(tone)}
      <span>{children}</span>
    </div>
  );
}

export function A2UIInlineError({
  message,
  prefix = "A2UI 渲染失败，等待重新生成",
}: {
  message?: string;
  prefix?: string;
}) {
  const text = message ? `${prefix}：${message}` : prefix;
  return (
    <div className={styles.errorLine} data-testid="a2ui-error-line" title={message || undefined} role="status">
      <AlertTriangle size={14} aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

function stateIcon(tone: A2UIStateTone) {
  if (tone === "success") {
    return <Check size={13} aria-hidden="true" />;
  }
  if (tone === "warning") {
    return <CircleSlash size={13} aria-hidden="true" />;
  }
  if (tone === "danger") {
    return <AlertTriangle size={13} aria-hidden="true" />;
  }
  if (tone === "running") {
    return <Loader2 size={13} aria-hidden="true" />;
  }
  return <Info size={13} aria-hidden="true" />;
}
