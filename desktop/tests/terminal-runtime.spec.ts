import { describe, expect, it, vi } from "vitest";

import {
  createTerminalRuntime,
  isTerminalRuntimeAvailable,
  type TerminalChannel,
  type TerminalIpcAdapter,
  type TerminalRuntimeEvent,
} from "@/runtime";

const snapshot = {
  contractVersion: 2,
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
  adapter.responses.set("terminal_attach", {
    snapshot,
    replay: [],
    cursor: 0,
    subscriptionId: "subscription-1",
  });
  adapter.responses.set("terminal_rename", { ...snapshot, title: "构建终端" });
  for (const command of [
    "terminal_ack",
    "terminal_detach",
    "terminal_write",
    "terminal_resize",
    "terminal_kill",
    "terminal_close",
  ]) {
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
    await attachment.ready;
    await runtime.write("terminal-1", "中文\r");
    await runtime.resize("terminal-1", { cols: 100, rows: 30 });
    await runtime.kill("terminal-1");
    await expect(runtime.rename("terminal-1", "构建终端")).resolves.toMatchObject({ title: "构建终端" });
    await runtime.close("terminal-1");
    await expect(runtime.closeSession("session-1")).resolves.toBe(1);
    await expect(runtime.closeAll()).resolves.toBe(2);
    attachment.dispose();
    await vi.waitFor(() => expect(adapter.calls.at(-1)?.command).toBe("terminal_detach"));

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
      "terminal_detach",
    ]);
    expect(adapter.calls.find((call) => call.command === "terminal_write")?.args?.dataBase64).toBe(
      "5Lit5paHDQ==",
    );
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
      onEvent: (event) => {
        events.push(event);
      },
      onError: (error) => errors.push(error.code),
    });
    await attachment.ready;
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
    await vi.waitFor(() => expect(errors).toContain("terminal_event_out_of_order"));
    adapter.channels[0]?.onmessage?.({
      event: "output",
      terminalId: "terminal-1",
      seq: 2,
      dataBase64: "%%invalid%%",
    });
    await vi.waitFor(() =>
      expect(errors).toEqual(["terminal_event_out_of_order", "terminal_event_invalid"]),
    );
    attachment.dispose();
  });

  it("delivers replay before early live output and acknowledges only after the consumer finishes", async () => {
    const adapter = configuredAdapter();
    adapter.responses.set("terminal_attach", {
      snapshot: { ...snapshot, seq: 2 },
      replay: [
        {
          event: "output",
          terminalId: "terminal-1",
          seq: 1,
          dataBase64: "QQ==",
        },
      ],
      cursor: 1,
      subscriptionId: "subscription-ordered",
    });
    adapter.beforeResolve = (command) => {
      if (command === "terminal_attach") {
        adapter.channels[0]?.onmessage?.({
          event: "output",
          terminalId: "terminal-1",
          seq: 2,
          dataBase64: "Qg==",
        });
      }
    };
    let releaseReplay: (() => void) | undefined;
    const replayParsed = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const events: number[] = [];
    const runtime = createTerminalRuntime(adapter);
    const attachment = await runtime.attach("terminal-1", {
      onEvent: async (event) => {
        if (event.event !== "output") return;
        events.push(event.seq);
        if (event.seq === 1) await replayParsed;
      },
    });

    expect(events).toEqual([1]);
    expect(adapter.calls.some((call) => call.command === "terminal_ack")).toBe(false);
    releaseReplay?.();
    await attachment.ready;
    await vi.waitFor(() => expect(events).toEqual([1, 2]));
    await vi.waitFor(() =>
      expect(
        adapter.calls
          .filter((call) => call.command === "terminal_ack")
          .map((call) => call.args?.seq),
      ).toEqual([1, 2]),
    );
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
