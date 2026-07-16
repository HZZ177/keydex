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
  publish(sourceId: string, discovery: ActiveProjectDiscovery): void;
  clear(sourceId: string): void;
}

const ActiveProjectPublisherContext = createContext<ActiveProjectPublisher | null>(null);
const NO_PROJECT: ActiveProjectDiscovery = { project: null };

export function ActiveProjectCoordinatorProvider({ children }: PropsWithChildren) {
  const [published, setPublished] = useState<{ sourceId: string; discovery: ActiveProjectDiscovery }>({
    sourceId: "",
    discovery: NO_PROJECT,
  });
  const publisher = useMemo<ActiveProjectPublisher>(
    () => ({
      publish: (sourceId, discovery) => setPublished({ sourceId, discovery }),
      clear: (sourceId) =>
        setPublished((current) =>
          current.sourceId === sourceId ? { sourceId: "", discovery: NO_PROJECT } : current,
        ),
    }),
    [],
  );

  return (
    <ActiveProjectPublisherContext.Provider value={publisher}>
      <ActiveProjectProvider discovery={published.discovery}>{children}</ActiveProjectProvider>
    </ActiveProjectPublisherContext.Provider>
  );
}

export function usePublishActiveProjectDiscovery(
  sourceId: string,
  discovery: ActiveProjectDiscovery,
  enabled = true,
): void {
  const publisher = useContext(ActiveProjectPublisherContext);
  if (!publisher) throw new Error("ActiveProjectCoordinatorProvider is missing");
  useLayoutEffect(() => {
    if (!enabled) return;
    publisher.publish(sourceId, discovery);
    return () => publisher.clear(sourceId);
  }, [discovery, enabled, publisher, sourceId]);
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
