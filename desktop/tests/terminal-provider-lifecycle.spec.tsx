import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { emitLifecycleEvent } from "@/renderer/events/lifecycleEvents";
import { TerminalProvider, useTerminal } from "@/renderer/features/terminal/TerminalProvider";
import { createTerminalStore } from "@/renderer/features/terminal/terminalStore";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import { TerminalSessionScopeProvider } from "@/renderer/providers/TerminalSessionScopeProvider";
import { TerminalRuntimeError, type TerminalRuntime, type TerminalSnapshot } from "@/runtime";

describe("TerminalProvider lifecycle and notifications", () => {
  it("does not call native IPC when the terminal runtime is unavailable", async () => {
    const store = createTerminalStore({ storage: null });
    const listProfiles = vi.fn(async () => []);
    const list = vi.fn(async () => []);
    renderProvider(store, runtime({ listProfiles, list }), <AvailabilityProbe />, false);

    expect(await screen.findByText("browser-fallback")).toBeTruthy();
    expect(listProfiles).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(store.getState().profilesLoading).toBe(false);
    expect(screen.getByTestId("notification-viewport").textContent).not.toContain("invoke");
  });

  it("cleans only affected sessions for archive and workspace purge events and ignores duplicates", async () => {
    const store = createTerminalStore({ storage: null });
    store.getState().upsertSnapshot(snapshot("a-1", "session-a"));
    store.getState().upsertSnapshot(snapshot("b-1", "session-b"));
    store.getState().upsertSnapshot(snapshot("c-1", "session-c"));
    store.getState().setSessionWorkspace("session-a", "workspace-1");
    store.getState().setSessionWorkspace("session-b", "workspace-1");
    store.getState().setSessionWorkspace("session-c", "workspace-2");
    const closeSession = vi.fn(async () => 1);
    renderProvider(store, runtime({ closeSession }));

    emitLifecycleEvent({
      type: "session_archived",
      session_id: "session-a",
      operation_id: "archive-1",
      revision: 1,
      occurred_at: "2026-07-20T01:00:00Z",
    });
    emitLifecycleEvent({
      type: "session_archived",
      session_id: "session-a",
      operation_id: "archive-1",
      revision: 1,
      occurred_at: "2026-07-20T01:00:00Z",
    });
    await waitFor(() => expect(closeSession).toHaveBeenCalledTimes(1));
    expect(closeSession).toHaveBeenCalledWith("session-a");
    expect(store.getState().sessionsById["session-a"]).toBeUndefined();

    emitLifecycleEvent({
      type: "workspace_sessions_purged",
      workspace_id: "workspace-1",
      operation_id: "purge-1",
      revision: 2,
      occurred_at: "2026-07-20T01:01:00Z",
    });
    await waitFor(() => expect(closeSession).toHaveBeenCalledWith("session-b"));
    expect(closeSession).not.toHaveBeenCalledWith("session-c");
    expect(store.getState().sessionsById["session-c"]?.terminalIds).toEqual(["c-1"]);
    expect(screen.getByTestId("notification-viewport").textContent).toContain("已清理 1 个项目会话终端");
  });

  it("deduplicates the same code and terminal error inside the notification cooldown", async () => {
    const store = createTerminalStore({ storage: null });
    store.getState().upsertSnapshot(snapshot("terminal-1", "session-1"));
    const write = vi.fn(async () => {
      throw new TerminalRuntimeError("terminal_write_failed", "写入终端失败");
    });
    renderProvider(store, runtime({ write }), <WriteTwice />);
    fireEvent.click(screen.getByRole("button", { name: "触发写入" }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByTestId("notification-item")).toHaveLength(1));
    expect(screen.getByTestId("notification-viewport").textContent).toContain("写入终端失败");
  });
});

function WriteTwice() {
  const { writeTerminal } = useTerminal();
  return <button type="button" onClick={() => { void writeTerminal("terminal-1", "a"); void writeTerminal("terminal-1", "b"); }}>触发写入</button>;
}

function AvailabilityProbe() {
  const { available } = useTerminal();
  return <span>{available ? "desktop-runtime" : "browser-fallback"}</span>;
}

function renderProvider(
  store: ReturnType<typeof createTerminalStore>,
  terminalRuntime: TerminalRuntime,
  child = <span>ready</span>,
  runtimeAvailable?: boolean,
) {
  return render(
    <NotificationProvider>
      <TerminalSessionScopeProvider>
        <TerminalProvider store={store} runtime={terminalRuntime} runtimeAvailable={runtimeAvailable}>
          {child}
        </TerminalProvider>
      </TerminalSessionScopeProvider>
    </NotificationProvider>,
  );
}

function runtime(overrides: Partial<TerminalRuntime> = {}): TerminalRuntime {
  return {
    listProfiles: async () => [],
    create: async () => snapshot("new-terminal", "session-1"),
    list: async () => [],
    attach: async () => ({ snapshot: snapshot("terminal-1", "session-1"), replay: [], cursor: 0, dispose() {} }),
    write: async () => undefined,
    resize: async () => undefined,
    kill: async () => undefined,
    rename: async (terminalId, title) => ({ ...snapshot(terminalId, "session-1"), title }),
    close: async () => undefined,
    closeSession: async () => 0,
    closeAll: async () => 0,
    ...overrides,
  };
}

function snapshot(terminalId: string, sessionId: string): TerminalSnapshot {
  return {
    contractVersion: 1,
    terminalId,
    sessionId,
    profileId: "powershell",
    cwd: "D:/repo",
    title: terminalId,
    status: "running",
    seq: 0,
    exitCode: null,
    createdAt: 1,
    updatedAt: 1,
  };
}
