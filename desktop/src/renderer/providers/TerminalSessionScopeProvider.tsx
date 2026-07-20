import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import type { AgentSession, Workspace } from "@/types/protocol";

export interface ActiveTerminalSessionScope {
  sessionId: string | null;
  workspaceId: string | null;
  initialCwd: string | null;
  loading: boolean;
}

interface TerminalSessionScopePublisher {
  publish(sourceId: string, scope: ActiveTerminalSessionScope, priority?: number): void;
  clear(sourceId: string): void;
}

interface TerminalSessionScopePublication {
  scope: ActiveTerminalSessionScope;
  priority: number;
  order: number;
}

const EMPTY_TERMINAL_SESSION_SCOPE: ActiveTerminalSessionScope = {
  sessionId: null,
  workspaceId: null,
  initialCwd: null,
  loading: false,
};

const TerminalSessionScopeContext = createContext<ActiveTerminalSessionScope>(EMPTY_TERMINAL_SESSION_SCOPE);
const TerminalSessionScopePublisherContext = createContext<TerminalSessionScopePublisher | null>(null);

export function TerminalSessionScopeProvider({ children }: PropsWithChildren) {
  const [publications, setPublications] = useState<
    ReadonlyMap<string, TerminalSessionScopePublication>
  >(() => new Map());
  const publisher = useMemo<TerminalSessionScopePublisher>(
    () => ({
      publish: (sourceId, scope, priority = 0) =>
        setPublications((current) => {
          const previous = current.get(sourceId);
          if (previous && sameTerminalScope(previous.scope, scope) && previous.priority === priority) {
            return current;
          }
          const next = new Map(current);
          next.set(sourceId, { scope, priority, order: nextPublicationOrder() });
          return next;
        }),
      clear: (sourceId) =>
        setPublications((current) => {
          if (!current.has(sourceId)) return current;
          const next = new Map(current);
          next.delete(sourceId);
          return next;
        }),
    }),
    [],
  );
  const activeScope = useMemo(() => selectActiveTerminalScope(publications), [publications]);

  return (
    <TerminalSessionScopePublisherContext.Provider value={publisher}>
      <TerminalSessionScopeContext.Provider value={activeScope}>
        {children}
      </TerminalSessionScopeContext.Provider>
    </TerminalSessionScopePublisherContext.Provider>
  );
}

export function useTerminalSessionScope(): ActiveTerminalSessionScope {
  return useContext(TerminalSessionScopeContext);
}

export function usePublishTerminalSessionScope(
  sourceId: string,
  scope: ActiveTerminalSessionScope,
  enabled = true,
  priority = 0,
): void {
  const publisher = useContext(TerminalSessionScopePublisherContext);
  useLayoutEffect(() => {
    if (!enabled) return;
    if (!publisher) throw new Error("TerminalSessionScopeProvider is missing");
    publisher.publish(sourceId, scope, priority);
    return () => publisher.clear(sourceId);
  }, [enabled, priority, publisher, scope, sourceId]);
}

export function terminalSessionScopeFromSession(
  session: AgentSession | null | undefined,
  loading: boolean,
): ActiveTerminalSessionScope {
  if (!session) {
    return { ...EMPTY_TERMINAL_SESSION_SCOPE, loading };
  }
  return {
    sessionId: session.id,
    workspaceId: session.workspace?.id ?? session.workspace_id ?? null,
    initialCwd: firstNonEmpty(
      session.workspace?.root_path,
      session.cwd,
      session.workspace_roots?.find((root) => root.trim()),
    ),
    loading,
  };
}

export function terminalSessionScopeFromWorkbench(options: {
  selectedSessionId?: string | null;
  session?: AgentSession | null;
  workspace?: Workspace | null;
  loading: boolean;
}): ActiveTerminalSessionScope {
  const selectedSessionId = options.selectedSessionId?.trim() || null;
  if (!selectedSessionId) {
    return { ...EMPTY_TERMINAL_SESSION_SCOPE, loading: options.loading };
  }
  const session = options.session?.id === selectedSessionId ? options.session : null;
  return {
    sessionId: selectedSessionId,
    workspaceId: session?.workspace?.id ?? session?.workspace_id ?? options.workspace?.id ?? null,
    initialCwd: firstNonEmpty(
      session?.workspace?.root_path,
      options.workspace?.root_path,
      session?.cwd,
      session?.workspace_roots?.find((root) => root.trim()),
    ),
    loading: options.loading || !session,
  };
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const cleaned = value?.trim();
    if (cleaned) return cleaned;
  }
  return null;
}

function selectActiveTerminalScope(
  publications: ReadonlyMap<string, TerminalSessionScopePublication>,
): ActiveTerminalSessionScope {
  let selected: TerminalSessionScopePublication | null = null;
  for (const publication of publications.values()) {
    if (
      !selected ||
      publication.priority > selected.priority ||
      (publication.priority === selected.priority && publication.order > selected.order)
    ) {
      selected = publication;
    }
  }
  return selected?.scope ?? EMPTY_TERMINAL_SESSION_SCOPE;
}

function sameTerminalScope(left: ActiveTerminalSessionScope, right: ActiveTerminalSessionScope): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.workspaceId === right.workspaceId &&
    left.initialCwd === right.initialCwd &&
    left.loading === right.loading
  );
}

let publicationOrder = 0;

function nextPublicationOrder(): number {
  publicationOrder += 1;
  return publicationOrder;
}
