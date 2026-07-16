import { act, render, screen } from "@testing-library/react";
import { useMemo, type PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";

import {
  ActiveProjectCoordinatorProvider,
  activeProjectDiscoveryFromSession,
  activeProjectDiscoveryFromWorkspace,
  usePublishActiveProjectDiscovery,
} from "@/renderer/providers/ActiveProjectCoordinatorProvider";
import { useActiveProjectState } from "@/renderer/providers/ActiveProjectProvider";
import type { AgentSession, Workspace } from "@/types/protocol";

const workspace = (id: string): Workspace => ({
  id,
  name: id,
  root_path: `D:/work/${id}`,
  normalized_root_path: `D:/work/${id}`,
  type: "local",
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
  last_opened_at: null,
  archived_at: null,
});

function Reader() {
  const state = useActiveProjectState();
  return <output>{state.status === "none" ? "none" : `${state.workspaceId}:${state.status}`}</output>;
}

function Publisher({ id, children }: PropsWithChildren<{ id: string }>) {
  const discovery = useMemo(() => activeProjectDiscoveryFromWorkspace(workspace(id), true), [id]);
  usePublishActiveProjectDiscovery(`route:${id}`, discovery);
  return children;
}

describe("ActiveProject route coordination", () => {
  it("publishes the mounted route and ignores stale route cleanup", () => {
    const view = render(
      <ActiveProjectCoordinatorProvider>
        <Publisher id="a"><Reader /></Publisher>
      </ActiveProjectCoordinatorProvider>,
    );
    expect(screen.getByText("a:loading")).not.toBeNull();

    act(() => {
      view.rerender(
        <ActiveProjectCoordinatorProvider>
          <Publisher id="b"><Reader /></Publisher>
        </ActiveProjectCoordinatorProvider>,
      );
    });
    expect(screen.getByText("b:loading")).not.toBeNull();
  });

  it("maps workspace and session ownership without inventing a project", () => {
    expect(activeProjectDiscoveryFromWorkspace(null, false)).toEqual({ project: null });
    const session = {
      workspace_id: "workspace-session",
      cwd: "D:/work/session",
      workspace_roots: [],
      workspace: null,
    } as unknown as AgentSession;
    expect(activeProjectDiscoveryFromSession(session, false)).toMatchObject({
      project: { workspaceId: "workspace-session", projectPath: "D:/work/session" },
      loading: false,
    });
    expect(activeProjectDiscoveryFromSession(null, false)).toEqual({ project: null });
  });
});
