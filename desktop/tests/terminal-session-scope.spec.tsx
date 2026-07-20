import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  TerminalSessionScopeProvider,
  terminalSessionScopeFromSession,
  terminalSessionScopeFromWorkbench,
  usePublishTerminalSessionScope,
  useTerminalSessionScope,
  type ActiveTerminalSessionScope,
} from "@/renderer/providers/TerminalSessionScopeProvider";
import type { AgentSession, Workspace } from "@/types/protocol";

describe("TerminalSessionScopeProvider", () => {
  it("uses workspace root, session cwd and workspace roots in the confirmed order", () => {
    const session = fakeSession();
    expect(terminalSessionScopeFromSession(session, false)).toMatchObject({
      sessionId: "session-a",
      workspaceId: "workspace-a",
      initialCwd: "D:/workspace-root",
      loading: false,
    });
    expect(
      terminalSessionScopeFromSession(
        { ...session, workspace: null, workspace_id: null, cwd: "D:/session-cwd" },
        false,
      ).initialCwd,
    ).toBe("D:/session-cwd");
    expect(
      terminalSessionScopeFromSession(
        { ...session, workspace: null, workspace_id: null, cwd: null },
        false,
      ).initialCwd,
    ).toBe("D:/fallback-root");
  });

  it("keeps workbench disabled while the selected session is not actually loaded", () => {
    const workspace = fakeWorkspace();
    expect(
      terminalSessionScopeFromWorkbench({
        selectedSessionId: "session-a",
        session: null,
        workspace,
        loading: false,
      }),
    ).toEqual({
      sessionId: "session-a",
      workspaceId: "workspace-a",
      initialCwd: "D:/workspace-root",
      loading: true,
    });
    expect(
      terminalSessionScopeFromWorkbench({
        selectedSessionId: undefined,
        session: null,
        workspace,
        loading: false,
      }).sessionId,
    ).toBeNull();
  });

  it("selects the latest highest-priority main publication and clears it on unmount", () => {
    const first: ActiveTerminalSessionScope = {
      sessionId: "session-a",
      workspaceId: "workspace-a",
      initialCwd: "D:/a",
      loading: false,
    };
    const second = { ...first, sessionId: "session-b", initialCwd: "D:/b" };
    const { rerender } = render(
      <TerminalSessionScopeProvider>
        <ScopePublisher sourceId="conversation" scope={first} />
        <ScopeReader />
      </TerminalSessionScopeProvider>,
    );
    expect(screen.getByTestId("terminal-scope").textContent).toContain("session-a");

    rerender(
      <TerminalSessionScopeProvider>
        <ScopePublisher sourceId="conversation" scope={first} />
        <ScopePublisher sourceId="workbench" scope={second} priority={1} />
        <ScopeReader />
      </TerminalSessionScopeProvider>,
    );
    expect(screen.getByTestId("terminal-scope").textContent).toContain("session-b");
  });
});

function ScopePublisher({
  sourceId,
  scope,
  priority = 0,
}: {
  sourceId: string;
  scope: ActiveTerminalSessionScope;
  priority?: number;
}) {
  usePublishTerminalSessionScope(sourceId, scope, true, priority);
  return null;
}

function ScopeReader() {
  const scope = useTerminalSessionScope();
  return <output data-testid="terminal-scope">{JSON.stringify(scope)}</output>;
}

function fakeWorkspace(): Workspace {
  return {
    id: "workspace-a",
    name: "Workspace",
    root_path: "D:/workspace-root",
    normalized_root_path: "D:/workspace-root",
    type: "local",
    created_at: "2026-07-20",
    updated_at: "2026-07-20",
    last_opened_at: null,
    archived_at: null,
  };
}

function fakeSession(): AgentSession {
  return {
    id: "session-a",
    user_id: "user",
    scene_id: "scene",
    status: "active",
    title: "Session",
    session_tag: "chat",
    session_type: "chat",
    workspace_id: "workspace-a",
    cwd: "D:/session-cwd",
    workspace_roots: ["D:/fallback-root"],
    workspace: fakeWorkspace(),
    current_model_provider_id: null,
    current_model: null,
    active_session_id: null,
    parent_session_id: null,
    child_session_id: null,
    source_trace_id: null,
    created_at: "2026-07-20",
    updated_at: "2026-07-20",
    archived_at: null,
    archive_origin: null,
    is_debug: false,
    is_scheduled: false,
    is_current: true,
  };
}
