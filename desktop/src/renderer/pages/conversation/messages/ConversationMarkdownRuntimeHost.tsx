import { useEffect, useId, useLayoutEffect, useRef } from "react";

import type { ConversationMarkdownHostAttachment } from "@/renderer/markdownRuntime/adapters";
import {
  createMarkdownSnapshot,
  type MarkdownSnapshot,
} from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import type {
  MarkdownRendererInteractionHandlers,
  MarkdownRendererResourceLifecycle,
  SemanticMarkdownRendererRegistry,
} from "@/renderer/markdownRuntime/renderers";
import {
  CONVERSATION_MARKDOWN_RENDERER_PROFILE,
  RetainedMarkdownDocumentRenderer,
} from "@/renderer/markdownRuntime/renderers";
import { StreamingTailView } from "@/renderer/markdownRuntime/streaming";
import {
  MARKDOWN_WORKER_PROTOCOL_VERSION,
  type MarkdownWorkerResponse,
} from "@/renderer/markdownRuntime/worker/protocol";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

import { conversationMarkdownAdapter, conversationMarkdownRuntimeStore } from "./conversationMarkdownRuntime";

export interface ConversationMarkdownRuntimeHostProps {
  readonly message: ConversationMessage;
  readonly source: string;
  readonly showCursor: boolean;
  readonly registry: SemanticMarkdownRendererRegistry;
  readonly interactions?: MarkdownRendererInteractionHandlers;
  readonly resourceLifecycle?: MarkdownRendererResourceLifecycle;
  readonly rootRef?: React.RefObject<HTMLDivElement | null>;
  readonly onSnapshot?: (snapshot: MarkdownSnapshot) => void;
  readonly onError?: (error: Error | null) => void;
  /** New-Runtime synchronous oracle for component tests; never used in release code. */
  readonly testSynchronous?: boolean;
}

interface DesiredState {
  readonly source: string;
  readonly status: string;
  readonly showCursor: boolean;
  readonly version: number;
}

interface RuntimeState {
  active: boolean;
  attachment: ConversationMarkdownHostAttachment;
  view: StreamingTailView;
  appliedSource: string;
  appliedSourceBytes: number;
  appliedStatus: string;
  baseRevision: string;
  epoch: number;
  syncing: boolean;
  desiredVersion: number;
}

let requestSequence = 0;

export function ConversationMarkdownRuntimeHost(props: ConversationMarkdownRuntimeHostProps) {
  if (import.meta.env.MODE === "test" && props.testSynchronous) {
    return <SynchronousConversationMarkdownRuntimeHost {...props} />;
  }
  return <AsynchronousConversationMarkdownRuntimeHost {...props} />;
}

/**
 * Vitest has no browser Worker lifecycle. Keep component tests synchronous by
 * exercising the canonical parser and retained renderer directly. This is a
 * new-Runtime oracle, not a production fallback, and is removed from release
 * bundles by the static MODE branch.
 */
function SynchronousConversationMarkdownRuntimeHost(props: ConversationMarkdownRuntimeHostProps) {
  const localRootRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<RetainedMarkdownDocumentRenderer | null>(null);
  const cursorRef = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const root = localRootRef.current;
    if (!root) return;
    if (props.rootRef) props.rootRef.current = root;
    const renderer = new RetainedMarkdownDocumentRenderer(root, {
      profile: CONVERSATION_MARKDOWN_RENDERER_PROFILE,
      registry: props.registry,
      interactions: props.interactions,
      resourceLifecycle: props.resourceLifecycle,
    });
    const cursor = root.ownerDocument.createElement("span");
    cursor.dataset.streamingMarkdownCursor = "true";
    cursor.setAttribute("data-testid", "streaming-cursor");
    cursor.setAttribute("aria-hidden", "true");
    cursor.textContent = "\u200b";
    cursor.hidden = true;
    root.append(cursor);
    rendererRef.current = renderer;
    cursorRef.current = cursor;
    return () => {
      // The same host element can be claimed by the replacement renderer
      // before nested React roots are safe to unmount. Retire the old renderer
      // asynchronously without clearing children now owned by the replacement.
      queueMicrotask(() => renderer.destroy({ clearRoot: false }));
      rendererRef.current = null;
      cursorRef.current = null;
      if (props.rootRef) props.rootRef.current = null;
    };
  }, [props.interactions, props.registry, props.resourceLifecycle, props.rootRef]);
  useLayoutEffect(() => {
    const renderer = rendererRef.current;
    const root = localRootRef.current;
    if (!renderer || !root) return;
    try {
      const canonical = parseCanonicalMarkdownSnapshot({
        surface: "message",
        documentId: `conversation:${props.message.threadId}:${props.message.id}`,
        revision: `${props.message.id}:${normalizedStatus(props.message)}:${props.source.length}`,
        source: props.source || " ",
        rendererProfile: "conversation",
      });
      const snapshot = isStreamingStatus(normalizedStatus(props.message))
        ? createMarkdownSnapshot({
            ...canonical,
            mode: "stream-tail",
            stream: {
              kind: "streaming",
              epoch: 1,
              prefix_revision: canonical.revision,
              prefix_block_count: 0,
              tail_block_start: 0,
              tail_source_start: 0,
              tail_complete: false,
            },
          })
        : canonical;
      renderer.render(snapshot);
      if (cursorRef.current) {
        cursorRef.current.dataset.streamingMarkdownDisplayCursor = String(props.source.length);
        if (props.showCursor) root.append(cursorRef.current);
        else cursorRef.current.remove();
      }
      root.dataset.messageMarkdownRuntimeStatus = "ready";
      root.dataset.messageMarkdownRuntimeRevision = snapshot.revision;
      props.onError?.(null);
      props.onSnapshot?.(snapshot);
    } catch (error) {
      const normalized = asError(error);
      root.dataset.messageMarkdownRuntimeStatus = "error";
      root.dataset.messageMarkdownRuntimeError = normalized.message;
      props.onError?.(normalized);
    }
  }, [
    props.interactions,
    props.message.id,
    props.message.threadId,
    props.registry,
    props.resourceLifecycle,
    props.showCursor,
    props.source,
  ]);
  return (
    <div
      className="keydex-markdown"
      data-message-markdown-mode="runtime"
      data-message-markdown-runtime-status="loading"
      ref={localRootRef}
    />
  );
}

function AsynchronousConversationMarkdownRuntimeHost(props: ConversationMarkdownRuntimeHostProps) {
  const localRootRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<RuntimeState | null>(null);
  const propsRef = useRef(props);
  const desiredRef = useRef<DesiredState>({
    source: props.source,
    status: normalizedStatus(props.message),
    showCursor: props.showCursor,
    version: 0,
  });
  const viewId = `conversation-markdown-${useId().replace(/:/gu, "")}`;
  propsRef.current = props;

  useLayoutEffect(() => {
    if (props.rootRef) props.rootRef.current = localRootRef.current;
    return () => {
      if (props.rootRef) props.rootRef.current = null;
    };
  }, [props.rootRef]);

  useEffect(() => {
    const root = localRootRef.current;
    if (!root) return;
    const desired = desiredRef.current;
    const streaming = isStreamingStatus(desired.status);
    const baseSource = streaming ? "" : desired.source;
    const adapter = conversationMarkdownAdapter();
    const attachment = adapter.attach(
      conversationMarkdownRuntimeStore(),
      adapterInput(props.message, baseSource),
      viewId,
    );
    const view = new StreamingTailView(root, {
      registry: props.registry,
      interactions: props.interactions,
      resourceLifecycle: props.resourceLifecycle,
    });
    const state: RuntimeState = {
      active: true,
      attachment,
      view,
      appliedSource: baseSource,
      appliedSourceBytes: new TextEncoder().encode(baseSource).byteLength,
      appliedStatus: streaming ? "running" : desired.status,
      baseRevision: attachment.projection().revision,
      epoch: 1,
      syncing: true,
      desiredVersion: desired.version,
    };
    stateRef.current = state;
    propsRef.current.onError?.(null);
    void attachment.load().then((snapshot) => {
      if (!state.active) return;
      if (state.desiredVersion === desiredRef.current.version && baseSource === desiredRef.current.source) {
        publish(state, snapshot, desiredRef.current, propsRef.current);
      }
      state.syncing = false;
      void drain(state, propsRef, desiredRef);
    }).catch((error: unknown) => {
      state.syncing = false;
      if (state.active) publishError(state, propsRef.current, error);
    });
    return () => {
      state.active = false;
      state.view.destroy();
      state.attachment.detach();
      if (stateRef.current === state) stateRef.current = null;
    };
  }, [props.interactions, props.message.id, props.message.threadId, props.registry, props.resourceLifecycle, viewId]);

  useEffect(() => {
    const previous = desiredRef.current;
    desiredRef.current = {
      source: props.source,
      status: normalizedStatus(props.message),
      showCursor: props.showCursor,
      version: previous.version + 1,
    };
    const state = stateRef.current;
    if (!state) return;
    state.desiredVersion = desiredRef.current.version;
    void drain(state, propsRef, desiredRef);
  }, [props.message.status, props.showCursor, props.source]);

  return (
    <div
      className="keydex-markdown"
      data-message-markdown-mode="runtime"
      data-message-markdown-runtime-status="loading"
      ref={localRootRef}
    />
  );
}

async function drain(
  state: RuntimeState,
  propsRef: React.MutableRefObject<ConversationMarkdownRuntimeHostProps>,
  desiredRef: React.MutableRefObject<DesiredState>,
): Promise<void> {
  if (!state.active || state.syncing) return;
  state.syncing = true;
  try {
    while (state.active) {
      const desired = desiredRef.current;
      if (desired.source === state.appliedSource && desired.status === state.appliedStatus) {
        state.view.updateDisplay({ displayCursor: desired.source.length, showCursor: desired.showCursor });
        break;
      }
      const requestedVersion = desired.version;
      let snapshot: MarkdownSnapshot;
      if (!isStreamingStatus(desired.status)) {
        snapshot = await state.attachment.update(
          adapterInput(propsRef.current.message, desired.source),
        );
      } else {
        const appendOnly = isAppendOnlySnapshot(state.appliedSource, desired.source);
        if (!appendOnly) state.epoch += 1;
        const projection = conversationMarkdownAdapter().project(
          adapterInput(propsRef.current.message, desired.source),
        );
        const append = appendOnly ? desired.source.slice(state.appliedSource.length) : desired.source;
        const appendBytes = new TextEncoder().encode(append).byteLength;
        const response = await state.attachment.runtime.request({
          protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
          surface: "message",
          document_id: state.attachment.documentId,
          revision: projection.revision,
          request_id: `conversation-tail-${++requestSequence}`,
          type: "parse-stream-tail",
          payload: {
            base_revision: state.baseRevision,
            base_source_bytes: appendOnly ? state.appliedSourceBytes : 0,
            stream_epoch: state.epoch,
            final: false,
            append: {
              kind: "text",
              encoding: "utf-8",
              content: append,
              byte_length: appendBytes,
            },
            options: { renderer_profile: "conversation", enable_html: false, enable_mdx: false },
          },
        });
        snapshot = snapshotResponse(response);
        state.appliedSourceBytes = (appendOnly ? state.appliedSourceBytes : 0) + appendBytes;
      }
      state.appliedSource = desired.source;
      if (!isStreamingStatus(desired.status)) {
        state.appliedSourceBytes = new TextEncoder().encode(desired.source).byteLength;
      }
      state.appliedStatus = desired.status;
      state.baseRevision = snapshot.revision;
      if (requestedVersion === desiredRef.current.version) publish(state, snapshot, desiredRef.current, propsRef.current);
    }
  } catch (error) {
    if (state.active && !isCancellation(error)) publishError(state, propsRef.current, error);
  } finally {
    state.syncing = false;
    if (state.active) {
      const desired = desiredRef.current;
      if (desired.source !== state.appliedSource || desired.status !== state.appliedStatus) {
        queueMicrotask(() => void drain(state, propsRef, desiredRef));
      }
    }
  }
}

function publish(
  state: RuntimeState,
  snapshot: MarkdownSnapshot,
  desired: DesiredState,
  props: ConversationMarkdownRuntimeHostProps,
): void {
  state.view.publish(snapshot, {
    displayCursor: desired.source.length,
    showCursor: desired.showCursor,
  });
  state.view.root.dataset.messageMarkdownRuntimeStatus = "ready";
  state.view.root.dataset.messageMarkdownRuntimeRevision = snapshot.revision;
  delete state.view.root.dataset.messageMarkdownRuntimeError;
  props.onError?.(null);
  props.onSnapshot?.(snapshot);
}

function publishError(
  state: RuntimeState,
  props: ConversationMarkdownRuntimeHostProps,
  error: unknown,
): void {
  const normalized = asError(error);
  state.view.root.dataset.messageMarkdownRuntimeStatus = "error";
  state.view.root.dataset.messageMarkdownRuntimeError = normalized.message;
  props.onError?.(normalized);
}

function adapterInput(message: ConversationMessage, source: string) {
  return {
    sessionId: message.threadId,
    message: {
      id: message.id,
      kind: message.kind,
      status: message.status,
      content: message.content,
    },
    source,
  } as const;
}

function normalizedStatus(message: ConversationMessage): string {
  return typeof message.status === "string" && message.status ? message.status : "completed";
}

function isStreamingStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

function snapshotResponse(response: MarkdownWorkerResponse): MarkdownSnapshot {
  if (response.type !== "snapshot-result") throw new Error(`Expected snapshot-result, received ${response.type}`);
  return response.payload;
}

function isCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function isAppendOnlySnapshot(previous: string, next: string): boolean {
  if (next === previous) return true;
  if (next.length <= previous.length) return false;
  if (previous.length <= 1_024) return next.startsWith(previous);
  const windowSize = 512;
  return next.slice(0, windowSize) === previous.slice(0, windowSize)
    && next.slice(previous.length - windowSize, previous.length) === previous.slice(-windowSize);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
