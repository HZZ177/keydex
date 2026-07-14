import { MessageCircleQuestion, MessageSquarePlus, MessageSquareQuote, Quote } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import type { SelectionPosition } from "./useTextSelection";
import styles from "./SelectionToolbar.module.css";

const COMMENT_INPUT_MIN_HEIGHT = 28;
const COMMENT_INPUT_MAX_HEIGHT = 64;

export interface SelectionToolbarProps {
  selectedText: string;
  position: SelectionPosition | null;
  selectionRange?: Range | null;
  onQuote?: (text: string, comment?: string) => void;
  onAskInBtwConversation?: (text: string) => void;
  onAnnotate?: (text: string) => void;
  onClear: () => void;
}

export function SelectionToolbar({
  selectedText,
  position,
  selectionRange,
  onQuote,
  onAskInBtwConversation,
  onAnnotate,
  onClear,
}: SelectionToolbarProps) {
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState("");
  const [highlightRects, setHighlightRects] = useState<SelectionHighlightRect[]>([]);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const normalizedCommentValue = normalizedComment(comment);

  useEffect(() => {
    setCommenting(false);
    setComment("");
  }, [selectedText]);

  useLayoutEffect(() => {
    if (commenting && commentInputRef.current) {
      resizeCommentInput(commentInputRef.current);
    }
  }, [comment, commenting]);

  useLayoutEffect(() => {
    if (!commenting || !selectionRange) {
      setHighlightRects([]);
      return;
    }

    const updateHighlight = () => {
      if (!selectionRange.commonAncestorContainer.isConnected) {
        onClear();
        return;
      }
      setHighlightRects(selectionHighlightRects(selectionRange));
    };

    updateHighlight();
    window.addEventListener("resize", updateHighlight);
    window.addEventListener("scroll", updateHighlight, true);
    return () => {
      window.removeEventListener("resize", updateHighlight);
      window.removeEventListener("scroll", updateHighlight, true);
    };
  }, [commenting, onClear, selectionRange]);

  if (!selectedText || !position || (!onQuote && !onAskInBtwConversation && !onAnnotate)) {
    return null;
  }

  const highlightAnchor = commenting ? selectionHighlightAnchor(highlightRects) : null;
  const anchorX = highlightAnchor?.x ?? position.x;
  const anchorY = highlightAnchor?.y ?? position.y;
  const left = clamp(anchorX, 16, window.innerWidth - 16);
  const top = clamp(anchorY - 8, 12, window.innerHeight - 12);
  const toolbarStyle = {
    left,
    top,
    "--selection-pointer-offset-x": `${anchorX - left}px`,
  } as CSSProperties;

  return createPortal(
    <>
      {commenting && highlightRects.length ? (
        <div
          aria-hidden="true"
          className={styles.selectionHighlight}
          data-text-selection-highlight="true"
        >
          {highlightRects.map((rect, index) => (
            <span
              className={styles.selectionHighlightSegment}
              data-text-selection-highlight-segment="true"
              key={`${rect.left}:${rect.top}:${rect.width}:${rect.height}:${index}`}
              style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
            />
          ))}
        </div>
      ) : null}
      <div
        className={styles.toolbar}
        data-mode={commenting ? "comment" : "actions"}
        data-text-selection-overlay="true"
        role="toolbar"
        aria-label="选中文本操作"
        style={toolbarStyle}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        onMouseUp={(event) => {
          event.stopPropagation();
        }}
      >
        {onQuote && commenting ? (
          <form
            className={styles.commentForm}
            aria-label="评论并引用"
            onSubmit={(event) => {
              event.preventDefault();
              if (!normalizedCommentValue) {
                commentInputRef.current?.focus();
                return;
              }
              onQuote(selectedText, normalizedCommentValue);
              setCommenting(false);
              setComment("");
              onClear();
            }}
          >
            <textarea
              autoFocus
              className={styles.commentInput}
              aria-label="评论内容"
              placeholder="添加评论"
              ref={commentInputRef}
              required
              rows={1}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  event.preventDefault();
                  setCommenting(false);
                  setComment("");
                  onClear();
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              onKeyUp={(event) => event.stopPropagation()}
            />
            <button
              aria-label="确认评论并引用"
              className={styles.submitAction}
              disabled={!normalizedCommentValue}
              type="submit"
            >
              引用
            </button>
          </form>
        ) : onQuote ? (
          <>
            <button
              className={styles.action}
              type="button"
              aria-label="引用选中文本"
              title="引用"
              onClick={() => {
                onQuote(selectedText);
                onClear();
              }}
            >
              <Quote size={13} strokeWidth={2.1} />
              <span>引用</span>
            </button>
            <button
              className={styles.action}
              type="button"
              aria-label="评论并引用选中文本"
              title="评论并引用"
              onClick={() => {
                setCommenting(true);
              }}
            >
              <MessageSquareQuote size={13} strokeWidth={2.1} />
              <span>评论并引用</span>
            </button>
          </>
        ) : null}
        {!commenting && onAskInBtwConversation ? (
          <button
            className={styles.action}
            type="button"
            aria-label="在旁路对话中询问选中文本"
            title="在旁路对话中询问"
            onClick={() => {
              onAskInBtwConversation(selectedText);
              onClear();
            }}
          >
            <MessageCircleQuestion size={13} strokeWidth={2.1} />
            <span>在旁路对话中询问</span>
          </button>
        ) : null}
        {!commenting && onAnnotate ? (
          <button
            className={styles.action}
            type="button"
            aria-label="为选中文本添加批注"
            title="添加批注"
            onClick={() => {
              onAnnotate(selectedText);
              onClear();
            }}
          >
            <MessageSquarePlus size={13} strokeWidth={2.1} />
            <span>添加批注</span>
          </button>
        ) : null}
      </div>
    </>,
    document.body,
  );
}

interface SelectionHighlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function selectionHighlightRects(range: Range): SelectionHighlightRect[] {
  try {
    const clientRects = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
    const rects = clientRects.length ? clientRects : [range.getBoundingClientRect()];
    return rects.filter(isVisibleRect).map(({ left, top, width, height }) => ({ left, top, width, height }));
  } catch {
    return [];
  }
}

function isVisibleRect(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0 && [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite);
}

function selectionHighlightAnchor(rects: SelectionHighlightRect[]): { x: number; y: number } | null {
  if (!rects.length) {
    return null;
  }
  const top = Math.min(...rects.map((rect) => rect.top));
  const firstLineRects = rects.filter((rect) => Math.abs(rect.top - top) <= Math.max(2, rect.height * 0.25));
  const left = Math.min(...firstLineRects.map((rect) => rect.left));
  const right = Math.max(...firstLineRects.map((rect) => rect.left + rect.width));
  return { x: left + (right - left) / 2, y: top };
}

function normalizedComment(comment: string): string | undefined {
  const normalized = comment.trim();
  return normalized || undefined;
}

function resizeCommentInput(input: HTMLTextAreaElement): void {
  input.style.height = "auto";
  const contentHeight = Math.max(input.scrollHeight, COMMENT_INPUT_MIN_HEIGHT);
  input.style.height = `${Math.min(contentHeight, COMMENT_INPUT_MAX_HEIGHT)}px`;
  input.style.overflowY = contentHeight > COMMENT_INPUT_MAX_HEIGHT ? "auto" : "hidden";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
