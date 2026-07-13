import type { ConversationMessage } from "@/renderer/stores/conversationStore";

import {
  createMarkdownDocumentIdentity,
  stableMarkdownIdentityHash,
  type MarkdownDocumentIdentityInput,
} from "../document/identity";
import {
  type MarkdownRuntimeAttachment,
  type MarkdownRuntimeRetention,
  type MarkdownRuntimeStore,
} from "../MarkdownRuntimeStore";
import { CONVERSATION_MARKDOWN_RENDERER_PROFILE } from "../renderers";
import type { MarkdownViewDescriptor } from "../view";

export type ConversationMarkdownRole = "user" | "assistant";
export type ConversationMarkdownPhase = "streaming" | "settled";

export interface ConversationMarkdownInput {
  readonly sessionId: string;
  readonly message: Pick<ConversationMessage, "id" | "kind" | "status" | "content">;
  readonly source?: string;
}

export interface ConversationMarkdownProjection {
  readonly identity: Extract<MarkdownDocumentIdentityInput, { surface: "message" }>;
  readonly documentId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly role: ConversationMarkdownRole;
  readonly status: string;
  readonly phase: ConversationMarkdownPhase;
  readonly retention: MarkdownRuntimeRetention;
  readonly revision: string;
  readonly sequence: number;
  readonly source: string;
  readonly rendererProfile: typeof CONVERSATION_MARKDOWN_RENDERER_PROFILE;
}

export interface ConversationMarkdownHostAttachment {
  readonly documentId: string;
  readonly viewId: string;
  readonly runtime: MarkdownRuntimeAttachment;
  projection(): ConversationMarkdownProjection;
  load(signal?: AbortSignal): ReturnType<MarkdownRuntimeAttachment["load"]>;
  update(input: ConversationMarkdownInput, signal?: AbortSignal): ReturnType<MarkdownRuntimeAttachment["load"]>;
  detach(): void;
}

interface ProjectionState {
  sequence: number;
  lastRole: ConversationMarkdownRole | null;
  lastStatus: string | null;
  lastSource: string | null;
  projection: ConversationMarkdownProjection | null;
}

export class ConversationMarkdownAdapter {
  private readonly states = new Map<string, ProjectionState>();

  project(input: ConversationMarkdownInput): ConversationMarkdownProjection {
    const normalized = normalizeInput(input);
    const identity = Object.freeze({
      surface: "message" as const,
      sessionId: normalized.sessionId,
      messageId: normalized.messageId,
    });
    const documentId = createMarkdownDocumentIdentity(identity);
    const state = this.states.get(documentId) ?? {
      sequence: 0,
      lastRole: null,
      lastStatus: null,
      lastSource: null,
      projection: null,
    };
    if (
      state.projection
      && state.lastRole === normalized.role
      && state.lastStatus === normalized.status
      && state.lastSource === normalized.source
    ) {
      return state.projection;
    }

    state.sequence += 1;
    const phase = conversationMarkdownPhase(normalized.role, normalized.status);
    const retention: MarkdownRuntimeRetention = phase === "streaming" ? "transient" : "settled";
    const revision = phase === "streaming"
      ? streamingRevision(documentId, state.sequence, normalized.source)
      : settledRevision(documentId, normalized.role, normalized.status, normalized.source);
    const projection = Object.freeze({
      identity,
      documentId,
      sessionId: normalized.sessionId,
      messageId: normalized.messageId,
      role: normalized.role,
      status: normalized.status,
      phase,
      retention,
      revision,
      sequence: state.sequence,
      source: normalized.source,
      rendererProfile: CONVERSATION_MARKDOWN_RENDERER_PROFILE,
    });
    state.lastRole = normalized.role;
    state.lastStatus = normalized.status;
    state.lastSource = normalized.source;
    state.projection = projection;
    this.states.set(documentId, state);
    return projection;
  }

  viewDescriptor(projection: ConversationMarkdownProjection, viewId: string): MarkdownViewDescriptor {
    required(viewId, "viewId");
    return Object.freeze({
      scopeId: projection.sessionId,
      entryId: projection.messageId,
      viewId,
      kind: "conversation" as const,
    });
  }

  attach(
    store: MarkdownRuntimeStore,
    input: ConversationMarkdownInput,
    viewId: string,
  ): ConversationMarkdownHostAttachment {
    required(viewId, "viewId");
    let projection = this.project(input);
    const runtime = store.attach(projection.identity, viewId);
    let detached = false;
    const load = (signal?: AbortSignal) => {
      if (detached) return Promise.reject(new Error(`Conversation Markdown view ${viewId} is detached`));
      return runtime.load({
        revision: projection.revision,
        source: projection.source,
        retention: projection.retention,
        signal,
      });
    };
    return Object.freeze({
      documentId: projection.documentId,
      viewId,
      runtime,
      projection: () => projection,
      load,
      update: (nextInput: ConversationMarkdownInput, signal?: AbortSignal) => {
        const normalized = normalizeInput(nextInput);
        if (normalized.sessionId !== projection.sessionId || normalized.messageId !== projection.messageId) {
          return Promise.reject(new Error("Conversation Markdown attachment cannot switch session or message identity"));
        }
        projection = this.project(nextInput);
        return load(signal);
      },
      detach: () => {
        if (detached) return;
        detached = true;
        runtime.detach();
      },
    });
  }

  forget(sessionId: string, messageId: string): boolean {
    const identity = {
      surface: "message" as const,
      sessionId: required(sessionId, "sessionId"),
      messageId: required(messageId, "messageId"),
    };
    return this.states.delete(createMarkdownDocumentIdentity(identity));
  }
}

export function conversationMarkdownPhase(
  role: ConversationMarkdownRole,
  status: string,
): ConversationMarkdownPhase {
  return role === "assistant" && (status === "pending" || status === "running")
    ? "streaming"
    : "settled";
}

function normalizeInput(input: ConversationMarkdownInput): {
  readonly sessionId: string;
  readonly messageId: string;
  readonly role: ConversationMarkdownRole;
  readonly status: string;
  readonly source: string;
} {
  const sessionId = required(input.sessionId, "sessionId");
  const messageId = required(input.message.id, "message.id");
  if (input.message.kind !== "user" && input.message.kind !== "assistant") {
    throw new Error(`Conversation Markdown only accepts user or assistant messages, received ${input.message.kind}`);
  }
  return Object.freeze({
    sessionId,
    messageId,
    role: input.message.kind,
    status: typeof input.message.status === "string" && input.message.status.trim()
      ? input.message.status
      : "completed",
    source: input.source ?? input.message.content,
  });
}

function streamingRevision(documentId: string, sequence: number, source: string): string {
  // Streaming revisions are transient and already monotonic per document.
  // Hash only a bounded tail fingerprint: hashing the entire accumulated
  // response on every token batch turns an append-only stream into O(n²).
  const tail = source.slice(Math.max(0, source.length - 512));
  return [
    "conversation-stream",
    stableMarkdownIdentityHash(documentId),
    sequence.toString().padStart(12, "0"),
    source.length.toString(36),
    stableMarkdownIdentityHash(tail),
  ].join(":");
}

function settledRevision(
  documentId: string,
  role: ConversationMarkdownRole,
  status: string,
  source: string,
): string {
  return [
    "conversation-settled",
    stableMarkdownIdentityHash(documentId),
    role,
    encodeURIComponent(status),
    source.length.toString(36),
    stableMarkdownIdentityHash(source),
  ].join(":");
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}
