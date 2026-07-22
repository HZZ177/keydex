import { X } from "lucide-react";
import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBrowserOcclusionToken } from "@/renderer/features/browser/runtime";

import styles from "./AppDialog.module.css";

export type AppDialogPlacement = "center" | "top" | "right" | "fullscreen";
export type AppDialogSize = "confirm" | "form" | "search" | "drawer" | "fullscreen";
export type AppDialogBackdrop = "plain" | "blur" | "page" | "panel" | "preview";
export type AppDialogInset = "full" | "below-titlebar";

export interface AppDialogProps {
  title?: ReactNode;
  description?: ReactNode;
  ariaLabel?: string;
  children: ReactNode;
  footer?: ReactNode;
  placement?: AppDialogPlacement;
  size?: AppDialogSize;
  backdrop?: AppDialogBackdrop;
  inset?: AppDialogInset;
  closeLabel?: string;
  showClose?: boolean;
  closeOnEscape?: boolean;
  closeOnOverlayClick?: boolean;
  modal?: boolean;
  onClose?: () => void;
  overlayClassName?: string;
  panelClassName?: string;
  bodyClassName?: string;
  footerClassName?: string;
  style?: CSSProperties;
}

export function AppDialog({
  title,
  description,
  ariaLabel,
  children,
  footer,
  placement = "center",
  size = "form",
  backdrop = "blur",
  inset = "full",
  closeLabel = "关闭",
  showClose,
  closeOnEscape = true,
  closeOnOverlayClick = true,
  modal = true,
  onClose,
  overlayClassName = "",
  panelClassName = "",
  bodyClassName = "",
  footerClassName = "",
  style,
}: AppDialogProps) {
  useBrowserOcclusionToken(true, "dialog");
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const labelledBy = title ? titleId : undefined;
  const describedBy = description ? descriptionId : undefined;

  useEffect(() => {
    if (!onClose || !closeOnEscape) {
      return;
    }
    const closeOnEscapeKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscapeKey, true);
    return () => document.removeEventListener("keydown", closeOnEscapeKey, true);
  }, [closeOnEscape, onClose]);

  useEffect(() => {
    if (!modal) return;
    const panel = panelRef.current;
    if (!panel) return;
    const previouslyFocused = previouslyFocusedRef.current;
    const focusInitial = window.requestAnimationFrame(() => {
      if (panel.contains(document.activeElement)) return;
      const preferred = panel.querySelector<HTMLElement>("[autofocus]");
      (preferred ?? focusableElements(panel)[0] ?? panel).focus();
    });
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = focusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus, true);
    return () => {
      window.cancelAnimationFrame(focusInitial);
      document.removeEventListener("keydown", trapFocus, true);
      if (previouslyFocused?.isConnected) {
        window.requestAnimationFrame(() => previouslyFocused.focus());
      }
    };
  }, [modal]);

  const overlayClasses = [styles.overlay, overlayClassName].filter(Boolean).join(" ");
  const panelClasses = [styles.panel, panelClassName].filter(Boolean).join(" ");
  const bodyClasses = [styles.body, bodyClassName].filter(Boolean).join(" ");
  const footerClasses = [styles.footer, footerClassName].filter(Boolean).join(" ");
  const resolvedShowClose = showClose ?? Boolean(onClose);
  const hasHeader = Boolean(title || description || (resolvedShowClose && onClose));

  const dialog = (
    <div
      className={overlayClasses}
      data-backdrop={backdrop}
      data-inset={inset}
      data-placement={placement}
      role="presentation"
      style={style}
      onMouseDown={(event) => {
        if (!closeOnOverlayClick || !onClose || event.target !== event.currentTarget) {
          return;
        }
        onClose();
      }}
    >
      <section
        ref={panelRef}
        aria-label={!labelledBy ? ariaLabel : undefined}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-modal={modal ? "true" : undefined}
        className={panelClasses}
        data-size={size}
        role="dialog"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {hasHeader ? (
          <header
            className={styles.header}
            data-size={size}
            data-has-close={resolvedShowClose && onClose ? "true" : "false"}
          >
            <div className={styles.titleBlock}>
              {title ? <h2 id={titleId}>{title}</h2> : null}
              {description ? <p id={descriptionId}>{description}</p> : null}
            </div>
            {resolvedShowClose && onClose ? (
              <button className={styles.closeButton} type="button" aria-label={closeLabel} onClick={onClose}>
                <X size={16} />
              </button>
            ) : null}
          </header>
        ) : null}
        <div className={bodyClasses} data-size={size}>
          {children}
        </div>
        {footer ? <footer className={footerClasses} data-size={size}>{footer}</footer> : null}
      </section>
    </div>
  );

  return createPortal(dialog, document.body);
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>([
    "button:not([disabled])",
    "a[href]",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(","))).filter((element) => element.getAttribute("aria-hidden") !== "true");
}
