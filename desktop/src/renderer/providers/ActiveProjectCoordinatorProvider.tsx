import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import type { ActiveProjectDiscovery } from "@/renderer/features/git/activeProject";
import type { AgentSession, Workspace } from "@/types/protocol";

import { ActiveProjectProvider } from "./ActiveProjectProvider";

interface ActiveProjectPublisher {
  publish(sourceId: string, discovery: ActiveProjectDiscovery, priority?: number): void;
  clear(sourceId: string): void;
}

const ActiveProjectPublisherContext = createContext<ActiveProjectPublisher | null>(null);
const NO_PROJECT: ActiveProjectDiscovery = { project: null };

interface ActiveProjectPublication {
  discovery: ActiveProjectDiscovery;
  priority: number;
  order: number;
}

export function ActiveProjectCoordinatorProvider({ children }: PropsWithChildren) {
  const [publications, setPublications] = useState<ReadonlyMap<string, ActiveProjectPublication>>(
    () => new Map(),
  );
  const publisher = useMemo<ActiveProjectPublisher>(
    () => ({
      publish: (sourceId, discovery, priority = 0) =>
        setPublications((current) => {
          const next = new Map(current);
          next.set(sourceId, {
            discovery,
            priority,
            order: nextPublicationOrder(),
          });
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
  const activeDiscovery = useMemo(() => selectActiveDiscovery(publications), [publications]);

  return (
    <ActiveProjectPublisherContext.Provider value={publisher}>
      <ActiveProjectProvider discovery={activeDiscovery}>{children}</ActiveProjectProvider>
    </ActiveProjectPublisherContext.Provider>
  );
}

export function usePublishActiveProjectDiscovery(
  sourceId: string,
  discovery: ActiveProjectDiscovery,
  enabled = true,
  priority = 0,
): void {
  const publisher = useContext(ActiveProjectPublisherContext);
  useLayoutEffect(() => {
    if (!enabled) return;
    if (!publisher) throw new Error("ActiveProjectCoordinatorProvider is missing");
    publisher.publish(sourceId, discovery, priority);
    return () => publisher.clear(sourceId);
  }, [discovery, enabled, priority, publisher, sourceId]);
}

let publicationOrder = 0;

function nextPublicationOrder(): number {
  publicationOrder += 1;
  return publicationOrder;
}

function selectActiveDiscovery(
  publications: ReadonlyMap<string, ActiveProjectPublication>,
): ActiveProjectDiscovery {
  let selected: ActiveProjectPublication | null = null;
  for (const publication of publications.values()) {
    if (
      !selected
      || publication.priority > selected.priority
      || (publication.priority === selected.priority && publication.order > selected.order)
    ) {
      selected = publication;
    }
  }
  return selected?.discovery ?? NO_PROJECT;
}

export function activeProjectDiscoveryFromWorkspace(
  workspace: Workspace | null,
  loading: boolean,
): ActiveProjectDiscovery {
  if (!workspace) return { project: null };
  return {
    project: {
      workspaceId: workspace.id,
      projectPath: workspace.root_path,
      name: workspace.name || workspace.root_path || workspace.id,
    },
    loading,
  };
}

export function activeProjectDiscoveryFromSession(
  session: AgentSession | null | undefined,
  loading: boolean,
): ActiveProjectDiscovery {
  const workspaceId = session?.workspace?.id ?? session?.workspace_id ?? null;
  const projectPath = session?.workspace?.root_path ?? session?.cwd ?? session?.workspace_roots?.[0] ?? null;
  if (!workspaceId || !projectPath) return { project: null };
  return {
    project: {
      workspaceId,
      projectPath,
      name: session?.workspace?.name || projectPath,
    },
    loading,
  };
}
