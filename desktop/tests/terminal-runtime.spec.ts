import { describe, expect, it, vi } from "vitest";

import {
  createTerminalRuntime,
  isTerminalRuntimeAvailable,
  type TerminalChannel,
  type TerminalIpcAdapter,
  type TerminalRuntimeEvent,
} from "@/runtime";

const snapshot = {
  contractVersion: 1,
  terminalId: "terminal-1",
  sessionId: "session-1",
  profileId: "powershell",
  cwd: "C:/repo",
  title: "PowerShell 1",
  status: "running",
  seq: 0,
  exitCode: null,
  createdAt: 1,
  updatedAt: 1,
};

class FakeTerminalAdapter implements TerminalIpcAdapter {
  readonly calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  readonly channels: TerminalChannel<unknown>[] = [];
  responses = new Map<string, unknown>();
  beforeResolve?: (command: string, args?: Record<string, unknown>) => void;

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, args });
    this.beforeResolve?.(command, args);
    if (!this.responses.has(command)) throw { code: "terminal_internal", message: `missing ${command}` };
    return this.responses.get(command) as T;
  }

  createChannel<T>(onMessage: (message: T) => void): TerminalChannel<T> {
    const channel: TerminalChannel<T> = { onmessage: onMessage };
    this.channels.push(channel as TerminalChannel<unknown>);
    return channel;
  }
}

function configuredAdapter() {
  const adapter = new FakeTerminalAdapter();
  adapter.responses.set("terminal_list_profiles", [
    {
      id: "powershell",
      label: "PowerShell",
      available: true,
      executable: "C:/pwsh.exe",
      args: ["-NoLogo"],
      unavailableReason: null,
    },
  ]);
  adapter.responses.set("terminal_create", snapshot);
  adapter.responses.set("terminal_list", [snapshot]);
  adapter.responses.set("terminal_attach", { snapshot, replay: [], cursor: 0 });
  adapter.responses.set("terminal_rename", { ...snapshot, title: "构建终端" });
  for (const command of ["terminal_write", "terminal_resize", "terminal_kill", "terminal_close"]) {
    adapter.responses.set(command, undefined);
  }
  adapter.responses.set("terminal_close_session", 1);
  adapter.responses.set("terminal_close_all", 2);
  return adapter;
}

describe("terminal runtime", () => {
  it("detects terminal IPC only when the Tauri invoke bridge exists", () => {
    const runtimeWindow = window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } };
    const previous = runtimeWindow.__TAURI_INTERNALS__;
    try {
      delete runtimeWindow.__TAURI_INTERNALS__;
      expect(isTerminalRuntimeAvailable()).toBe(false);
      runtimeWindow.__TAURI_INTERNALS__ = {};
      expect(isTerminalRuntimeAvailable()).toBe(false);
      runtimeWindow.__TAURI_INTERNALS__ = { invoke: () => undefined };
      expect(isTerminalRuntimeAvailable()).toBe(true);
    } finally {
      if (previous === undefined) delete runtimeWindow.__TAURI_INTERNALS__;
      else runtimeWindow.__TAURI_INTERNALS__ = previous;
    }
  });

  it("maps every command directly to typed Tauri IPC", async () => {
    const adapter = configuredAdapter();
    const runtime = createTerminalRuntime(adapter);

    await expect(runtime.listProfiles()).resolves.toHaveLength(1);
    await expect(
      runtime.create({ sessionId: "session-1", cwd: "C:/repo", profile: "powershell", cols: 80, rows: 24 }),
    ).resolves.toMatchObject({ terminalId: "terminal-1" });
    await expect(runtime.list("session-1")).resolves.toHaveLength(1);
    const attachment = await runtime.attach("terminal-1", { onEvent: vi.fn() });
    await runtime.write("terminal-1", "中文\r");
    await runtime.resize("terminal-1", { cols: 100, rows: 30 });
    await runtime.kill("terminal-1");
    await expect(runtime.rename("terminal-1", "构建终端")).resolves.toMatchObject({ title: "构建终端" });
    await runtime.close("terminal-1");
    await expect(runtime.closeSession("session-1")).resolves.toBe(1);
    await expect(runtime.closeAll()).resolves.toBe(2);

    expect(adapter.calls.map((call) => call.command)).toEqual([
      "terminal_list_profiles",
      "terminal_create",
      "terminal_list",
      "terminal_attach",
      "terminal_write",
      "terminal_resize",
      "terminal_kill",
      "terminal_rename",
      "terminal_close",
      "terminal_close_session",
      "terminal_close_all",
    ]);
    expect(adapter.calls.find((call) => call.command === "terminal_write")?.args?.dataBase64).toBe(
      "5Lit5paHDQ==",
    );
    attachment.dispose();
    expect(adapter.channels[0]?.onmessage).toBeNull();
  });

  it("queues early channel output, decodes bytes and reports duplicate or malformed events", async () => {
    const adapter = configuredAdapter();
    const runtime = createTerminalRuntime(adapter);
    const events: TerminalRuntimeEvent[] = [];
    const errors: string[] = [];
    adapter.beforeResolve = (command) => {
      if (command === "terminal_attach") {
        adapter.channels[0]?.onmessage?.({
          event: "output",
          terminalId: "terminal-1",
          seq: 1,
          dataBase64: "5Lit5paH",
        });
      }
    };
    const attachment = await runtime.attach("terminal-1", {
      onEvent: (event) => events.push(event),
      onError: (error) => errors.push(error.code),
    });
    expect(events[0]).toMatchObject({ event: "output", seq: 1 });
    expect(events[0]?.event === "output" ? Array.from(events[0].data) : []).toEqual(
      Array.from(new TextEncoder().encode("中文")),
    );

    adapter.channels[0]?.onmessage?.({
      event: "output",
      terminalId: "terminal-1",
      seq: 1,
      dataBase64: "QQ==",
    });
    adapter.channels[0]?.onmessage?.({
      event: "output",
      terminalId: "terminal-1",
      seq: 2,
      dataBase64: "%%invalid%%",
    });
    expect(errors).toEqual(["terminal_event_out_of_order", "terminal_event_invalid"]);
    attachment.dispose();
  });

  it("normalizes native command errors without involving HTTP runtime", async () => {
    const adapter = configuredAdapter();
    adapter.responses.delete("terminal_create");
    const runtime = createTerminalRuntime(adapter);
    await expect(
      runtime.create({ sessionId: "session-1", profile: "powershell", cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: "terminal_internal", message: "missing terminal_create" });
  });
});
