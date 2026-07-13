import {
  encodeMarkdownSnapshotCandidate,
  type MarkdownSnapshotCodecCandidate,
} from "./index";
import type { MarkdownSnapshot } from "../../document/MarkdownSnapshot";

interface InstallMessage {
  readonly type: "install";
  readonly snapshot: MarkdownSnapshot;
}

interface RunMessage {
  readonly type: "run";
  readonly requestId: string;
  readonly codec: MarkdownSnapshotCodecCandidate;
}

let snapshot: MarkdownSnapshot | null = null;
const scope = self as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<InstallMessage | RunMessage>) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.addEventListener("message", (event) => {
  if (event.data.type === "install") {
    snapshot = event.data.snapshot;
    scope.postMessage({ type: "installed", revision: snapshot.revision });
    return;
  }
  if (!snapshot) {
    scope.postMessage({ type: "error", requestId: event.data.requestId, message: "Snapshot not installed" });
    return;
  }
  try {
    const startedAt = performance.now();
    const encoded = encodeMarkdownSnapshotCandidate(snapshot, event.data.codec);
    const encodeMs = performance.now() - startedAt;
    scope.postMessage({
      type: "encoded",
      requestId: event.data.requestId,
      codec: event.data.codec,
      wire: encoded.wire,
      encodedBytes: encoded.encodedBytes,
      encodeMs,
    }, [...encoded.transfer]);
  } catch (error) {
    scope.postMessage({
      type: "error",
      requestId: event.data.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
