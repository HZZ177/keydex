import { BanknoteArrowDown, ChevronDown, MessageSquarePlus } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";

import styles from "./WebAnnotationShelf.module.css";

export function WebAnnotationShelf({
  count,
  open,
  pageTitle,
  pageUrl,
  children,
  onAddAllToComposer,
  onOpenChange,
}: {
  readonly count: number;
  readonly open: boolean;
  readonly pageTitle: string;
  readonly pageUrl: string;
  readonly children: ReactNode;
  onAddAllToComposer?(): void;
  onOpenChange(open: boolean): void;
}) {
  const panelId = useId();
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [onOpenChange, open]);

  const safeCount = Math.max(0, Math.trunc(count));
  const countLabel = `${safeCount > 999 ? "999+" : safeCount} 条批注`;
  const title = pageTitle.trim() || pageUrl.trim() || "当前页面";

  return (
    <section
      ref={rootRef}
      aria-label="当前页面网页批注"
      className={styles.root}
      data-app-tooltip-owner="browser-panel"
      data-browser-chrome-tooltips="true"
      data-browser-surface-occlusion="true"
      data-annotation-mode="active"
      data-open={open ? "true" : "false"}
    >
      <div className={styles.summary}>
        <button
          aria-controls={panelId}
          aria-expanded={open}
          aria-label={`当前页面批注消息列表，${countLabel}`}
          className={styles.summaryTrigger}
          onClick={() => onOpenChange(!open)}
          type="button"
        >
          <span aria-hidden="true" className={styles.leadingIcon}>
            <BanknoteArrowDown size={13} />
          </span>
          <span className={styles.pageCopy}>
            <strong>当前页面批注消息列表</strong>
            <span title={pageUrl || title}>{title}</span>
          </span>
        </button>
        <div className={styles.trailing}>
          <span className={styles.count}>{countLabel}</span>
          <button
            aria-label="全部加入对话框"
            className={styles.addAllButton}
            data-tooltip-label="全部加入对话框"
            disabled={safeCount === 0 || !onAddAllToComposer}
            onClick={onAddAllToComposer}
            type="button"
          >
            <MessageSquarePlus aria-hidden="true" size={12} />
            <span>全部加入对话框</span>
          </button>
          <button
            aria-controls={panelId}
            aria-expanded={open}
            aria-label={`${open ? "收起" : "展开"}当前页面网页批注，${countLabel}`}
            className={styles.toggle}
            onClick={() => onOpenChange(!open)}
            type="button"
          >
            <ChevronDown aria-hidden="true" size={14} />
          </button>
        </div>
      </div>
      <div
        id={panelId}
        aria-hidden={!open}
        className={styles.collapse}
        data-open={open ? "true" : "false"}
        inert={!open ? true : undefined}
      >
        <div className={styles.clip}>
          <div className={styles.floatingPanel}>{children}</div>
        </div>
      </div>
    </section>
  );
}
