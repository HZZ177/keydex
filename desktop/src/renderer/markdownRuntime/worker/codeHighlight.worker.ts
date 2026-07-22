import {
  CODE_HIGHLIGHT_WORKER_PROTOCOL_VERSION,
  type MarkdownCodeHighlightWorkerMessage,
  type MarkdownCodeHighlightWorkerRequest,
  type MarkdownCodeHighlightWorkerResponse,
} from "../renderers/CodeHighlightProtocol";
import { highlightCodeWithGrammar } from "./CodeHighlightEngine";

interface MarkdownCodeHighlightWorkerScope {
  onmessage: ((event: MessageEvent<MarkdownCodeHighlightWorkerMessage>) => void) | null;
  postMessage(message: MarkdownCodeHighlightWorkerResponse): void;
}

const scope = globalThis as unknown as MarkdownCodeHighlightWorkerScope;
const queued: MarkdownCodeHighlightWorkerRequest[] = [];
const cancelled = new Set<string>();
const knownRequests = new Set<string>();
let pumpScheduled = false;

scope.onmessage = (event) => {
  const message = event.data;
  if (message.protocolVersion !== CODE_HIGHLIGHT_WORKER_PROTOCOL_VERSION) return;
  if (message.type === "cancel") {
    if (knownRequests.has(message.requestId)) cancelled.add(message.requestId);
    return;
  }
  knownRequests.add(message.requestId);
  queued.push(message);
  schedulePump();
};

function schedulePump(): void {
  if (pumpScheduled || queued.length === 0) return;
  pumpScheduled = true;
  setTimeout(() => {
    pumpScheduled = false;
    void pumpOne();
  }, 0);
}

async function pumpOne(): Promise<void> {
  const request = queued.shift();
  if (!request) return;
  if (cancelled.delete(request.requestId)) {
    knownRequests.delete(request.requestId);
    schedulePump();
    return;
  }
  try {
    const result = await highlightCodeWithGrammar({
      language: request.language,
      code: request.code,
      maxTokens: request.maxTokens,
      sourceTruncated: request.sourceTruncated,
    });
    if (!cancelled.delete(request.requestId)) {
      scope.postMessage({
        protocolVersion: CODE_HIGHLIGHT_WORKER_PROTOCOL_VERSION,
        type: "highlight-result",
        requestId: request.requestId,
        language: result.language,
        tokens: result.tokens,
        truncated: result.truncated,
      });
    }
  } catch (error) {
    if (!cancelled.delete(request.requestId)) {
      scope.postMessage({
        protocolVersion: CODE_HIGHLIGHT_WORKER_PROTOCOL_VERSION,
        type: "highlight-error",
        requestId: request.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    knownRequests.delete(request.requestId);
    schedulePump();
  }
}
