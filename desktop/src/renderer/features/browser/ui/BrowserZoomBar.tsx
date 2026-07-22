import { Minus, Plus, RotateCcw, X } from "lucide-react";

import styles from "./BrowserPanel.module.css";

export function BrowserZoomBar({
  factor,
  onChange,
  onClose,
}: {
  readonly factor: number;
  onChange(value: number): void;
  onClose(): void;
}) {
  const change = (next: number) => onChange(Math.min(3, Math.max(0.5, Number(next.toFixed(2)))));
  return (
    <div className={styles.zoomBar} aria-label="页面缩放">
      <button aria-label="缩小页面" className={styles.toolbarButton} disabled={factor <= 0.5} onClick={() => change(factor - 0.25)} type="button">
        <Minus size={14} />
      </button>
      <span aria-live="polite" className={styles.zoomLabel}>{Math.round(factor * 100)}%</span>
      <button aria-label="放大页面" className={styles.toolbarButton} disabled={factor >= 3} onClick={() => change(factor + 0.25)} type="button">
        <Plus size={14} />
      </button>
      <button aria-label="重置为 100%" className={styles.toolbarButton} disabled={factor === 1} onClick={() => change(1)} type="button">
        <RotateCcw size={14} />
      </button>
      <button aria-label="关闭缩放控制" className={styles.toolbarButton} onClick={onClose} type="button">
        <X size={14} />
      </button>
    </div>
  );
}
