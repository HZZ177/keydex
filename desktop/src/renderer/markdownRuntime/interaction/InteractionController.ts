import { COPY_FEEDBACK_RESET_MS } from "@/renderer/hooks/useCopyFeedback";
import { isAbsoluteFilePath, parseFileLinkTarget } from "@/renderer/utils/fileLinks";

import type { MarkdownSnapshotBlock } from "../document/MarkdownSnapshot";
import type { MarkdownRendererInteractionHandlers } from "../renderers";

export type MarkdownCopyFeedbackStatus = "idle" | "success" | "error";

export interface MarkdownCopyFeedback {
  readonly targetId: string;
  readonly status: MarkdownCopyFeedbackStatus;
  readonly error: string | null;
}

export type MarkdownResolvedLinkTarget =
  | { readonly kind: "external"; readonly href: string; readonly scheme: string | null }
  | { readonly kind: "file"; readonly path: string; readonly line: number | null; readonly absolute: boolean }
  | { readonly kind: "anchor"; readonly fragment: string }
  | { readonly kind: "unsafe"; readonly href: string; readonly reason: string };

export interface MarkdownInteractionControllerOptions {
  readonly root: HTMLElement;
  readonly clipboard?: Pick<Clipboard, "writeText"> | null;
  readonly resetDelayMs?: number;
  readonly openExternal?: (href: string) => void | Promise<void>;
  readonly openFilePreview?: (input: {
    readonly request: { readonly type: "file" | "local-file"; readonly path: string };
    readonly revealTarget: { readonly lineStart: number; readonly lineEnd: number } | null;
  }) => void | Promise<void>;
  readonly revealAnchor?: (fragment: string) => void | Promise<void>;
  readonly onUnsafeLink?: (target: Extract<MarkdownResolvedLinkTarget, { kind: "unsafe" }>) => void;
  readonly onCopyFeedback?: (feedback: MarkdownCopyFeedback) => void;
  readonly onFocusedBlockChanged?: (blockId: string | null, blockIndex: number | null) => void;
  readonly scrollPage?: (direction: "up" | "down") => void;
  readonly scheduleReset?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancelReset?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class MarkdownInteractionController {
  private readonly root: HTMLElement;
  private readonly clipboard: Pick<Clipboard, "writeText"> | null;
  private readonly resetDelayMs: number;
  private readonly options: MarkdownInteractionControllerOptions;
  private readonly feedback = new Map<string, MarkdownCopyFeedback>();
  private readonly resetHandles = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly scheduleReset: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly cancelReset: (handle: ReturnType<typeof setTimeout>) => void;
  private attached = false;
  private disposed = false;

  constructor(options: MarkdownInteractionControllerOptions) {
    this.options = options;
    this.root = options.root;
    this.clipboard = options.clipboard === undefined ? navigator.clipboard ?? null : options.clipboard;
    this.resetDelayMs = finiteNonNegative(options.resetDelayMs ?? COPY_FEEDBACK_RESET_MS, "resetDelayMs");
    this.scheduleReset = options.scheduleReset ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancelReset = options.cancelReset ?? ((handle) => clearTimeout(handle));
  }

  attach(): () => void {
    this.assertActive();
    if (this.attached) return () => this.detach();
    this.attached = true;
    this.root.addEventListener("keydown", this.handleKeyDown);
    this.root.addEventListener("focusin", this.handleFocusChange);
    this.root.addEventListener("focusout", this.handleFocusChange);
    return () => this.detach();
  }

  rendererHandlers(): MarkdownRendererInteractionHandlers {
    const handlers: MarkdownRendererInteractionHandlers = {
      onLinkActivate: (event, input) => {
        void this.activateLink(input.href, event, input.block);
      },
      onCodeCopy: (input) => this.copyText(input.code, `code:${input.block.id}`),
    };
    return Object.freeze(handlers);
  }

  async copySelection(selection: Selection | null = this.root.ownerDocument.getSelection()): Promise<boolean> {
    this.assertActive();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    if (!this.root.contains(range.commonAncestorContainer)) return false;
    const value = selection.toString();
    if (!value) return false;
    await this.copyText(value, "selection");
    return true;
  }

  async copyText(value: string, targetId = "document"): Promise<void> {
    this.assertActive();
    if (!this.clipboard) {
      this.setFeedback(targetId, "error", "Clipboard is unavailable");
      throw new Error("Clipboard is unavailable");
    }
    try {
      await this.clipboard.writeText(value);
      this.setFeedback(targetId, "success", null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setFeedback(targetId, "error", message);
      throw error;
    }
  }

  feedbackFor(targetId: string): MarkdownCopyFeedback {
    return this.feedback.get(targetId) ?? Object.freeze({ targetId, status: "idle", error: null });
  }

  async activateLink(
    href: string,
    event?: Pick<Event, "preventDefault" | "stopPropagation"> | null,
    _block?: MarkdownSnapshotBlock,
  ): Promise<"handled" | "native" | "rejected"> {
    this.assertActive();
    const target = resolveMarkdownLinkTarget(href);
    if (target.kind === "unsafe") {
      event?.preventDefault();
      event?.stopPropagation();
      this.options.onUnsafeLink?.(target);
      return "rejected";
    }
    if (target.kind === "file") {
      event?.preventDefault();
      event?.stopPropagation();
      if (!this.options.openFilePreview) return "rejected";
      await this.options.openFilePreview({
        request: {
          type: target.absolute ? "local-file" : "file",
          path: target.path,
        },
        revealTarget: target.line ? { lineStart: target.line, lineEnd: target.line } : null,
      });
      return "handled";
    }
    if (target.kind === "anchor") {
      event?.preventDefault();
      event?.stopPropagation();
      if (!this.options.revealAnchor) return "rejected";
      await this.options.revealAnchor(target.fragment);
      return "handled";
    }
    if (!this.options.openExternal) return "native";
    event?.preventDefault();
    event?.stopPropagation();
    await this.options.openExternal(target.href);
    return "handled";
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.root.removeEventListener("keydown", this.handleKeyDown);
    this.root.removeEventListener("focusin", this.handleFocusChange);
    this.root.removeEventListener("focusout", this.handleFocusChange);
  }

  destroy(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
    for (const handle of this.resetHandles.values()) this.cancelReset(handle);
    this.resetHandles.clear();
    this.feedback.clear();
  }

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape") {
      const active = this.root.ownerDocument.activeElement;
      if (active instanceof HTMLElement && this.root.contains(active)) {
        active.blur();
        event.preventDefault();
      }
      return;
    }
    if (event.key === "PageUp" || event.key === "PageDown") {
      if (!this.options.scrollPage) return;
      event.preventDefault();
      this.options.scrollPage(event.key === "PageUp" ? "up" : "down");
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      const focusable = mountedFocusableElements(this.root);
      const target = event.key === "Home" ? focusable[0] : focusable.at(-1);
      if (target) {
        event.preventDefault();
        target.focus();
      }
      return;
    }
    if (event.key === "Enter") {
      const active = this.root.ownerDocument.activeElement;
      const anchor = active instanceof HTMLAnchorElement ? active : active?.closest?.("a");
      if (anchor instanceof HTMLAnchorElement) void this.activateLink(anchor.getAttribute("href") ?? "", event);
    }
    // Tab, Space, text input, and system shortcuts retain native browser behavior.
  };

  private readonly handleFocusChange = () => {
    queueMicrotask(() => {
      if (this.disposed) return;
      const active = this.root.ownerDocument.activeElement;
      const block = active instanceof Element && this.root.contains(active)
        ? active.closest<HTMLElement>("[data-markdown-block-id]")
        : null;
      const index = block?.dataset.markdownBlockIndex;
      this.options.onFocusedBlockChanged?.(
        block?.dataset.markdownBlockId ?? null,
        index !== undefined && /^\d+$/u.test(index) ? Number(index) : null,
      );
    });
  };

  private setFeedback(targetId: string, status: Exclude<MarkdownCopyFeedbackStatus, "idle">, error: string | null): void {
    const previous = this.resetHandles.get(targetId);
    if (previous !== undefined) this.cancelReset(previous);
    const value = Object.freeze({ targetId, status, error });
    this.feedback.set(targetId, value);
    this.options.onCopyFeedback?.(value);
    const handle = this.scheduleReset(() => {
      this.resetHandles.delete(targetId);
      this.feedback.delete(targetId);
      this.options.onCopyFeedback?.(Object.freeze({ targetId, status: "idle", error: null }));
    }, this.resetDelayMs);
    this.resetHandles.set(targetId, handle);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Markdown InteractionController is destroyed");
  }
}

export function resolveMarkdownLinkTarget(href: string): MarkdownResolvedLinkTarget {
  const value = unwrapAngles(href.trim());
  if (!value) return { kind: "unsafe", href: value, reason: "empty" };
  if (value.startsWith("#")) {
    const fragment = value.slice(1);
    return fragment
      ? { kind: "anchor", fragment }
      : { kind: "unsafe", href: value, reason: "empty-fragment" };
  }
  if (/^file:/iu.test(value)) {
    const file = fileUrlTarget(value);
    return file ?? { kind: "unsafe", href: value, reason: "invalid-file-url" };
  }
  const file = parseFileLinkTarget(value);
  if (file) return { kind: "file", ...file };
  const scheme = /^([a-z][a-z\d+.-]*):/iu.exec(value)?.[1]?.toLowerCase() ?? null;
  if (scheme && !SAFE_EXTERNAL_SCHEMES.has(scheme)) {
    return { kind: "unsafe", href: value, reason: `unsafe-scheme:${scheme}` };
  }
  return { kind: "external", href: value, scheme };
}

function fileUrlTarget(value: string): Extract<MarkdownResolvedLinkTarget, { kind: "file" }> | null {
  try {
    const url = new URL(value);
    let path = decodeURIComponent(url.pathname);
    if (/^\/[a-z]:\//iu.test(path)) path = path.slice(1);
    if (url.host && url.host !== "localhost") path = `//${url.host}${path}`;
    const parsed = parseFileLinkTarget(path);
    if (!parsed) return null;
    return { kind: "file", ...parsed, absolute: isAbsoluteFilePath(parsed.path) };
  } catch {
    return null;
  }
}

function unwrapAngles(value: string): string {
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1).trim() : value;
}

function mountedFocusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>([
    "a[href]",
    "button:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(","))].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}

const SAFE_EXTERNAL_SCHEMES = new Set(["http", "https", "mailto", "xmpp", "irc", "ircs"]);
