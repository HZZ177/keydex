import type { EditorView } from "@codemirror/view";

export interface SourceLineScrollAnchor {
  /** One-based source line number. */
  readonly line: number;
  /** Vertical progress through the source line, from 0 at its top to 1 at its bottom. */
  readonly lineProgress: number;
}

export function codeMirrorViewportSourceAnchor(
  view: EditorView,
  scrollElement: HTMLElement,
): SourceLineScrollAnchor | null {
  if (!view.dom.isConnected || !scrollElement.isConnected) return null;
  const viewportRect = scrollElement.getBoundingClientRect();
  const scaleY = positiveScale(view.scaleY);
  const documentY = Math.max(0, (viewportRect.top - view.documentTop) / scaleY);
  const lineBlock = view.lineBlockAtHeight(documentY);
  const sourceLine = view.state.doc.lineAt(lineBlock.from);
  const lineProgress = lineBlock.height > 0
    ? clamp((documentY - lineBlock.top) / lineBlock.height, 0, 1)
    : 0;
  return Object.freeze({ line: sourceLine.number, lineProgress });
}

export function syncCodeMirrorViewportToSourceAnchor(
  view: EditorView,
  scrollElement: HTMLElement,
  anchor: SourceLineScrollAnchor,
): boolean {
  if (!view.dom.isConnected || !scrollElement.isConnected
    || !Number.isSafeInteger(anchor.line) || anchor.line < 1 || anchor.line > view.state.doc.lines
    || !Number.isFinite(anchor.lineProgress)) {
    return false;
  }
  const sourceLine = view.state.doc.line(anchor.line);
  const lineBlock = view.lineBlockAt(sourceLine.from);
  const scaleY = positiveScale(view.scaleY);
  const documentY = lineBlock.top + lineBlock.height * clamp(anchor.lineProgress, 0, 1);
  const viewportRect = scrollElement.getBoundingClientRect();
  const target = clamp(
    scrollElement.scrollTop + view.documentTop - viewportRect.top + documentY * scaleY,
    0,
    Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight),
  );
  scrollElement.scrollTo({ top: target, behavior: "auto" });
  return true;
}

function positiveScale(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
