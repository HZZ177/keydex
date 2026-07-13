import type { AgentActionEnvelope, AgentSession } from "@/types/protocol";

const SESSION_CREATED_EVENT = "keydex-session-created";
const SESSION_UPDATED_EVENT = "keydex-session-updated";
const SESSION_DELETED_EVENT = "keydex-session-deleted";

export type AgentSessionUpdate = Partial<AgentSession> & { id: string };

export function emitSessionCreated(session: AgentSession) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent<AgentSession>(SESSION_CREATED_EVENT, { detail: session }));
}

export function emitSessionUpdated(session: AgentSessionUpdate) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent<AgentSessionUpdate>(SESSION_UPDATED_EVENT, { detail: session }));
}

export function emitSessionDeleted(sessionId: string) {
  if (typeof window === "undefined" || !sessionId) {
    return;
  }
  window.dispatchEvent(new CustomEvent<string>(SESSION_DELETED_EVENT, { detail: sessionId }));
}

export function emitSessionEventsFromRuntimeEvent(event: AgentActionEnvelope) {
  if (event.action === "session_created") {
    const session = sessionFromEventData(event.data);
    if (session) {
      emitSessionCreated(session);
    }
    return;
  }
  if (event.action !== "session_title_updated") {
    return;
  }
  const session = sessionFromEventData(event.data);
  if (session) {
    emitSessionUpdated(session);
    return;
  }
  if (!event.data || typeof event.data !== "object") {
    return;
  }
  const data = event.data as Record<string, unknown>;
  const sessionId = typeof data.session_id === "string" ? data.session_id.trim() : "";
  const title = typeof data.title === "string" ? data.title : null;
  if (!sessionId || title === null) {
    return;
  }
  emitSessionUpdated({
    id: sessionId,
    title,
    title_source: titleSourceFromValue(data.title_source),
    updated_at: typeof data.updated_at === "string" ? data.updated_at : undefined,
  });
}

export function subscribeSessionCreated(handler: (session: AgentSession) => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  const listener = (event: Event) => {
    const session = (event as CustomEvent<AgentSession>).detail;
    if (session?.id) {
      handler(session);
    }
  };
  window.addEventListener(SESSION_CREATED_EVENT, listener);
  return () => window.removeEventListener(SESSION_CREATED_EVENT, listener);
}

export function subscribeSessionUpdated(handler: (session: AgentSessionUpdate) => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  const listener = (event: Event) => {
    const session = (event as CustomEvent<AgentSessionUpdate>).detail;
    if (session?.id) {
      handler(session);
    }
  };
  window.addEventListener(SESSION_UPDATED_EVENT, listener);
  return () => window.removeEventListener(SESSION_UPDATED_EVENT, listener);
}

export function subscribeSessionDeleted(handler: (sessionId: string) => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  const listener = (event: Event) => {
    const sessionId = (event as CustomEvent<string>).detail;
    if (sessionId) {
      handler(sessionId);
    }
  };
  window.addEventListener(SESSION_DELETED_EVENT, listener);
  return () => window.removeEventListener(SESSION_DELETED_EVENT, listener);
}

function sessionFromEventData(data: unknown): AgentSession | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const session = (data as { session?: unknown }).session;
  if (session && typeof session === "object" && typeof (session as { id?: unknown }).id === "string") {
    return session as AgentSession;
  }
  return null;
}

function titleSourceFromValue(value: unknown): AgentSession["title_source"] | undefined {
  return value === "auto_candidate" || value === "auto" || value === "manual" ? value : undefined;
}
