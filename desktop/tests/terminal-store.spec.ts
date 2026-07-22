import { describe, expect, it } from "vitest";

import {
  DEFAULT_TERMINAL_PROFILE,
  TERMINAL_PREFERENCES_KEY,
  createTerminalStore,
  type TerminalPreferenceStorage,
} from "@/renderer/features/terminal/terminalStore";
import { selectRunningTerminalCount } from "@/renderer/features/terminal/terminalSelectors";
import type { TerminalSnapshot } from "@/runtime";

class MemoryStorage implements TerminalPreferenceStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("terminal store", () => {
  it("defaults new preferences to PowerShell while preserving a stored profile", () => {
    expect(DEFAULT_TERMINAL_PROFILE).toBe("powershell");
    expect(createTerminalStore({ storage: null }).getState().ui.defaultProfile).toBe("powershell");

    const storage = new MemoryStorage();
    storage.values.set(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({ defaultProfile: "git-bash" }),
    );
    expect(createTerminalStore({ storage }).getState().ui.defaultProfile).toBe("git-bash");
  });

  it("migrates the legacy Git Bash default to PowerShell without losing layout preferences", () => {
    const storage = new MemoryStorage();
    storage.values.set(
      "keydex.terminal.preferences.v1",
      JSON.stringify({ dockHeight: 410, defaultProfile: "git-bash", listPresentation: "list" }),
    );

    const store = createTerminalStore({ storage });

    expect(store.getState().ui).toMatchObject({
      dockHeight: 410,
      defaultProfile: "powershell",
      listPresentation: "list",
    });
    expect(JSON.parse(storage.values.get(TERMINAL_PREFERENCES_KEY) ?? "{}")).toEqual({
      dockHeight: 410,
      defaultProfile: "powershell",
      listPresentation: "list",
    });
  });

  it("isolates ordered terminals, active id and cursor state by session", () => {
    const store = createTerminalStore({ storage: null });
    store.getState().hydrateSession("session-a", [snapshot("a-1", "session-a"), snapshot("a-2", "session-a")]);
    store.getState().hydrateSession("session-b", [snapshot("b-1", "session-b")]);
    store.getState().setActiveTerminal("session-a", "a-2");

    expect(store.getState().sessionsById["session-a"]).toMatchObject({
      terminalIds: ["a-1", "a-2"],
      activeTerminalId: "a-2",
      hydrated: true,
    });
    expect(store.getState().sessionsById["session-b"]).toMatchObject({
      terminalIds: ["b-1"],
      activeTerminalId: "b-1",
    });
    store.getState().removeTerminal("a-2");
    expect(store.getState().sessionsById["session-a"]?.activeTerminalId).toBe("a-1");
    expect(store.getState().snapshotsById["b-1"]?.sessionId).toBe("session-b");
  });

  it("accepts monotonic output, drops duplicates and marks sequence gaps", () => {
    const store = createTerminalStore({ storage: null });
    store.getState().upsertSnapshot(snapshot("terminal-1", "session-a"), { activate: true });
    expect(store.getState().acceptOutput("terminal-1", 1)).toBe("accepted");
    expect(store.getState().acceptOutput("terminal-1", 1)).toBe("duplicate");
    expect(store.getState().acceptOutput("terminal-1", 3)).toBe("gap");
    expect(store.getState().sessionsById["session-a"]?.cursorByTerminalId["terminal-1"]).toBe(3);
    expect(store.getState().sessionsById["session-a"]?.attachStateByTerminalId["terminal-1"]).toBe(
      "gap",
    );
  });

  it("hydrates native snapshots as truth and removes stale session records", () => {
    const store = createTerminalStore({ storage: null });
    store.getState().hydrateSession("session-a", [snapshot("a-1", "session-a"), snapshot("a-old", "session-a")]);
    store.getState().hydrateSession("session-a", [snapshot("a-1", "session-a", "exited")]);
    expect(store.getState().sessionsById["session-a"]?.terminalIds).toEqual(["a-1"]);
    expect(store.getState().snapshotsById["a-old"]).toBeUndefined();
    expect(store.getState().snapshotsById["a-1"]?.status).toBe("exited");
  });

  it("keeps workspace ownership and native rename metadata scoped to the terminal session", () => {
    const store = createTerminalStore({ storage: null });
    store.getState().upsertSnapshot(snapshot("terminal-1", "session-a"));
    store.getState().setSessionWorkspace("session-a", "workspace-a");
    store.getState().renameTerminal("terminal-1", "构建终端");
    expect(store.getState().sessionsById["session-a"]?.workspaceId).toBe("workspace-a");
    expect(store.getState().snapshotsById["terminal-1"]?.title).toBe("构建终端");
  });

  it("counts only running terminals in the requested session", () => {
    const store = createTerminalStore({ storage: null });
    store.getState().hydrateSession("session-a", [
      snapshot("a-running", "session-a"),
      snapshot("a-exited", "session-a", "exited"),
    ]);
    store.getState().hydrateSession("session-b", [snapshot("b-running", "session-b")]);

    expect(selectRunningTerminalCount(store.getState(), "session-a")).toBe(1);
    expect(selectRunningTerminalCount(store.getState(), "session-b")).toBe(1);
    expect(selectRunningTerminalCount(store.getState(), null)).toBe(0);
  });

  it("persists only UI preferences and never process, cursor or output state", () => {
    const storage = new MemoryStorage();
    storage.values.set(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify({ dockHeight: 410, defaultProfile: "cmd", listPresentation: "list" }),
    );
    const store = createTerminalStore({ storage });
    expect(store.getState().ui).toMatchObject({
      dockOpen: false,
      dockHeight: 410,
      defaultProfile: "cmd",
      listPresentation: "list",
    });
    store.getState().upsertSnapshot(snapshot("terminal-secret", "session-secret"));
    store.getState().acceptOutput("terminal-secret", 99);
    store.getState().setDockOpen(true);
    store.getState().setDockHeight(500);

    const persisted = JSON.parse(storage.values.get(TERMINAL_PREFERENCES_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(persisted).toEqual({ dockHeight: 500, defaultProfile: "cmd", listPresentation: "list" });
    expect(JSON.stringify(persisted)).not.toContain("terminal-secret");
    expect(JSON.stringify(persisted)).not.toContain("session-secret");
    expect(persisted).not.toHaveProperty("dockOpen");
  });
});

function snapshot(
  terminalId: string,
  sessionId: string,
  status: TerminalSnapshot["status"] = "running",
): TerminalSnapshot {
  return {
    contractVersion: 2,
    terminalId,
    sessionId,
    profileId: "powershell",
    cwd: "D:/repo",
    title: terminalId,
    status,
    seq: 0,
    exitCode: status === "exited" ? 0 : null,
    createdAt: 1,
    updatedAt: 1,
  };
}
