import type { AgentSession } from "@/types/protocol";

const SESSION_CREATED_EVENT = "codex-session-created";

export function emitSessionCreated(session: AgentSession) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent<AgentSession>(SESSION_CREATED_EVENT, { detail: session }));
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
