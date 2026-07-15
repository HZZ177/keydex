import type { StreamingTailGeometryCommit } from "@/renderer/markdownRuntime/streaming/StreamingTailView";

export const CONVERSATION_GEOMETRY_COMMIT_EVENT = "keydex:conversation-geometry-commit";

export interface ConversationGeometryCommitDetail extends StreamingTailGeometryCommit {
  readonly messageId: string;
  readonly source: "streaming-markdown";
}

export function dispatchConversationGeometryCommit(
  target: HTMLElement,
  detail: Omit<ConversationGeometryCommitDetail, "source">,
): void {
  target.dispatchEvent(new CustomEvent<ConversationGeometryCommitDetail>(CONVERSATION_GEOMETRY_COMMIT_EVENT, {
    bubbles: true,
    composed: true,
    detail: Object.freeze({ ...detail, source: "streaming-markdown" }),
  }));
}

export function conversationGeometryCommitDetail(event: Event): ConversationGeometryCommitDetail | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail = event.detail as Partial<ConversationGeometryCommitDetail> | null;
  if (
    !detail
    || detail.source !== "streaming-markdown"
    || typeof detail.messageId !== "string"
    || typeof detail.revision !== "string"
    || (detail.phase !== "snapshot" && detail.phase !== "measurement" && detail.phase !== "cursor")
    || typeof detail.delta !== "number"
    || !Number.isFinite(detail.delta)
    || typeof detail.previousHeight !== "number"
    || !Number.isFinite(detail.previousHeight)
    || typeof detail.height !== "number"
    || !Number.isFinite(detail.height)
  ) return null;
  return detail as ConversationGeometryCommitDetail;
}
