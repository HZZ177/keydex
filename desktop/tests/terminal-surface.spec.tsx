import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TerminalAttachment, TerminalRuntime, TerminalSnapshot } from "@/runtime";
import { TerminalProvider } from "@/renderer/features/terminal/TerminalProvider";
import { TerminalSurface } from "@/renderer/features/terminal/TerminalSurface";
import {
  TerminalXtermRegistry,
  terminalTheme,
  type TerminalXtermHandle,
} from "@/renderer/features/terminal/terminalXtermRegistry";
import { createTerminalStore } from "@/renderer/features/terminal/terminalStore";
import { AppContextMenuProvider } from "@/renderer/providers/AppContextMenuProvider";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import { TerminalSessionScopeProvider } from "@/renderer/providers/TerminalSessionScopeProvider";

describe("TerminalSurface and TerminalXtermRegistry", () => {
  it("insets the xterm host so the fit addon reserves bottom space without exposing its viewport background", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/features/terminal/TerminalSurface.module.css"),
      "utf8",
    );
    expect(css).not.toMatch(/\.host\s*\{[^}]*padding:/s);
    expect(css).not.toMatch(/\.host :global\(\.xterm\)\s*\{[^}]*padding:/s);
    expect(css).toMatch(/\.host\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*8px 10px 18px;/s);
    expect(css).toMatch(/--terminal-surface-background:\s*#ffffff;/);
    expect(css).toMatch(/html\[data-theme="dark"\][^}]*\.surface\s*\{[^}]*#111318;/s);
    expect(css).toMatch(
      /\.host :global\(\.xterm \.xterm-viewport\)\s*\{[^}]*background-color:\s*var\(--terminal-surface-background\);/s,
    );
  });

  it("uses readable ANSI colors on the light terminal surface", () => {
    const theme = terminalTheme("light");
    expect(theme.background).toBe("#ffffff");
    expect(theme.yellow).toBe("#7d4e00");
    expect(theme.brightYellow).toBe("#8a5a00");
    expect(theme.white).toBe("#57606a");
    expect(theme.brightWhite).toBe("#24292f");
  });

  it("retains one public xterm handle per terminal and disposes only removed entries", () => {
    const first = fakeHandle("terminal-1");
    const second = fakeHandle("terminal-2");
    const factory = vi.fn((terminalId: string) => (terminalId === "terminal-1" ? first : second));
    const registry = new TerminalXtermRegistry(factory);
    const link = vi.fn();
    expect(registry.getOrCreate("terminal-1", link)).toBe(first);
    expect(registry.getOrCreate("terminal-1", link)).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);

    const host = document.createElement("div");
    const nextHost = document.createElement("div");
    const element = document.createElement("div");
    Object.defineProperty(first.terminal, "element", { configurable: true, value: element });
    registry.open(first, host);
    host.appendChild(element);
    registry.open(first, host);
    expect(first.terminal.open).toHaveBeenCalledTimes(1);
    registry.open(first, nextHost);
    expect(first.terminal.open).toHaveBeenCalledTimes(1);
    expect(nextHost.contains(element)).toBe(true);
    expect(first.host).toBe(nextHost);
    expect(first.terminal.refresh).toHaveBeenCalledWith(0, 23);
    registry.getOrCreate("terminal-2", link);
    registry.disposeMissing(["terminal-2"]);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
  });

  it("writes replay bytes through the xterm public API and releases listeners on unmount", async () => {
    const snapshot = fakeSnapshot();
    const store = createTerminalStore({ storage: null });
    store.getState().upsertSnapshot(snapshot, { activate: true });
    const handle = fakeHandle(snapshot.terminalId);
    const registry = new TerminalXtermRegistry(() => handle);
    const attachmentDispose = vi.fn();
    const runtime = fakeRuntime(snapshot, attachmentDispose);
    const { unmount } = render(
      <NotificationProvider>
        <TerminalSessionScopeProvider>
          <TerminalProvider runtime={runtime} store={store}>
            <TerminalSurface snapshot={snapshot} active={false} visible={false} registry={registry} />
          </TerminalProvider>
        </TerminalSessionScopeProvider>
      </NotificationProvider>,
    );

    await waitFor(() => expect(handle.terminal.write).toHaveBeenCalledTimes(1));
    const bytes = vi.mocked(handle.terminal.write).mock.calls[0]?.[0] as Uint8Array;
    expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode("中文")));
    unmount();
    expect(attachmentDispose).toHaveBeenCalledTimes(1);
    expect(handle.listenerDisposables.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it("advances the replay cursor only after xterm finishes parsing the output chunk", async () => {
    const snapshot = fakeSnapshot();
    const store = createTerminalStore({ storage: null });
    store.getState().upsertSnapshot(snapshot, { activate: true });
    const handle = fakeHandle(snapshot.terminalId);
    let parsed: (() => void) | undefined;
    vi.mocked(handle.terminal.write).mockImplementation((_data, callback) => {
      parsed = callback;
    });
    render(
      <NotificationProvider>
        <TerminalSessionScopeProvider>
          <TerminalProvider runtime={fakeRuntime(snapshot, vi.fn())} store={store}>
            <TerminalSurface snapshot={snapshot} active visible registry={new TerminalXtermRegistry(() => handle)} />
          </TerminalProvider>
        </TerminalSessionScopeProvider>
      </NotificationProvider>,
    );

    await waitFor(() => expect(handle.terminal.write).toHaveBeenCalledTimes(1));
    expect(store.getState().sessionsById[snapshot.sessionId]?.cursorByTerminalId[snapshot.terminalId] ?? 0).toBe(0);
    parsed?.();
    await waitFor(() =>
      expect(store.getState().sessionsById[snapshot.sessionId]?.cursorByTerminalId[snapshot.terminalId]).toBe(1),
    );
  });

  it("forwards Ctrl+C, arrow and Tab sequences as raw terminal input without agent mediation", async () => {
    const snapshot = fakeSnapshot();
    const store = createTerminalStore({ storage: null });
    store.getState().upsertSnapshot(snapshot, { activate: true });
    const handle = fakeHandle(snapshot.terminalId);
    let onData: ((data: string) => void) | null = null;
    vi.mocked(handle.terminal.onData).mockImplementation((listener) => {
      onData = listener;
      return { dispose: vi.fn() };
    });
    const runtime = fakeRuntime(snapshot, vi.fn());
    const write = vi.fn(async () => undefined);
    runtime.write = write;
    render(
      <NotificationProvider>
        <TerminalSessionScopeProvider>
          <TerminalProvider runtime={runtime} store={store}>
            <TerminalSurface snapshot={snapshot} active visible registry={new TerminalXtermRegistry(() => handle)} />
          </TerminalProvider>
        </TerminalSessionScopeProvider>
      </NotificationProvider>,
    );
    await waitFor(() => expect(onData).not.toBeNull());
    (onData as unknown as (data: string) => void)("\x03\x1b[A\t");
    await waitFor(() => expect(write).toHaveBeenCalledWith(snapshot.terminalId, "\x03\x1b[A\t"));
  });

  it("supports search, copy, paste and rejects unsafe links through the top notification layer", async () => {
    const snapshot = { ...fakeSnapshot(), title: "<img src=x onerror=alert(1)>" };
    const store = createTerminalStore({ storage: null });
    store.getState().upsertSnapshot(snapshot, { activate: true });
    const handle = fakeHandle(snapshot.terminalId);
    vi.mocked(handle.terminal.hasSelection).mockReturnValue(true);
    vi.mocked(handle.terminal.getSelection).mockReturnValue("selected text");
    let activateLink: ((uri: string, event: MouseEvent) => void) | null = null;
    const registry = new TerminalXtermRegistry((_terminalId, activate) => {
      activateLink = activate;
      return handle;
    });
    const clipboard = {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue("pasted 中文"),
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    render(
      <AppContextMenuProvider>
        <NotificationProvider>
          <TerminalSessionScopeProvider>
            <TerminalProvider runtime={fakeRuntime(snapshot, vi.fn())} store={store}>
              <TerminalSurface snapshot={snapshot} active={false} visible={true} registry={registry} />
            </TerminalProvider>
          </TerminalSessionScopeProvider>
        </NotificationProvider>
      </AppContextMenuProvider>,
    );
    const surface = await screen.findByLabelText(`终端 ${snapshot.title}`);
    expect(document.querySelector("img")).toBeNull();

    fireEvent.keyDown(surface, { key: "f", ctrlKey: true, shiftKey: true });
    const search = await screen.findByRole("textbox", { name: "搜索终端输出" });
    fireEvent.change(search, { target: { value: "needle" } });
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.keyDown(search, { key: "Enter", shiftKey: true });
    expect(handle.searchAddon.findNext).toHaveBeenCalled();
    expect(handle.searchAddon.findPrevious).toHaveBeenCalled();

    fireEvent.keyDown(surface, { key: "c", ctrlKey: true });
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith("selected text"));
    fireEvent.keyDown(surface, { key: "v", ctrlKey: true });
    await waitFor(() => expect(handle.terminal.paste).toHaveBeenCalledWith("pasted 中文"));

    fireEvent.contextMenu(surface, { clientX: 12, clientY: 18 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制" }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(2));

    fireEvent.contextMenu(surface, { clientX: 12, clientY: 18 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "粘贴" }));
    await waitFor(() => expect(handle.terminal.paste).toHaveBeenCalledTimes(2));

    fireEvent.contextMenu(surface, { clientX: 12, clientY: 18 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "全选" }));
    expect(handle.terminal.selectAll).toHaveBeenCalledTimes(1);

    expect(activateLink).not.toBeNull();
    (activateLink as unknown as (uri: string, event: MouseEvent) => void)(
      "javascript:alert(1)",
      new MouseEvent("click"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("notification-viewport").textContent).toContain("只允许打开 HTTP 或 HTTPS 链接"),
    );
  });
});

function fakeRuntime(snapshot: TerminalSnapshot, dispose: () => void): TerminalRuntime {
  return {
    listProfiles: async () => [],
    create: async () => snapshot,
    list: async () => [snapshot],
    attach: async (_terminalId, options): Promise<TerminalAttachment> => {
      const ready = Promise.resolve(
        options.onEvent({
          event: "output",
          terminalId: snapshot.terminalId,
          seq: 1,
          data: new TextEncoder().encode("中文"),
        }),
      );
      return { snapshot, cursor: 1, ready, dispose };
    },
    write: async () => undefined,
    resize: async () => undefined,
    kill: async () => undefined,
    rename: async (_terminalId, title) => ({ ...snapshot, title }),
    close: async () => undefined,
    closeSession: async () => 1,
    closeAll: async () => 1,
  };
}

function fakeHandle(terminalId: string): TerminalXtermHandle & { listenerDisposables: ReturnType<typeof vi.fn>[] } {
  const listenerDisposables = [vi.fn(), vi.fn()];
  const terminal = {
    open: vi.fn(),
    write: vi.fn((_data: string | Uint8Array, callback?: () => void) => callback?.()),
    onData: vi.fn(() => ({ dispose: listenerDisposables[0] })),
    onBinary: vi.fn(() => ({ dispose: listenerDisposables[1] })),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ""),
    paste: vi.fn(),
    selectAll: vi.fn(),
    focus: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
    cols: 80,
    rows: 24,
  };
  return {
    terminalId,
    terminal: terminal as unknown as TerminalXtermHandle["terminal"],
    fitAddon: { fit: vi.fn() } as unknown as TerminalXtermHandle["fitAddon"],
    searchAddon: {
      clearDecorations: vi.fn(),
      findNext: vi.fn(() => true),
      findPrevious: vi.fn(() => true),
    } as unknown as TerminalXtermHandle["searchAddon"],
    webLinksAddon: {} as TerminalXtermHandle["webLinksAddon"],
    opened: false,
    host: null,
    dispose: vi.fn(),
    listenerDisposables,
  };
}

function fakeSnapshot(): TerminalSnapshot {
  return {
    contractVersion: 2,
    terminalId: "terminal-1",
    sessionId: "session-1",
    profileId: "powershell",
    cwd: "D:/repo",
    title: "PowerShell 1",
    status: "running",
    seq: 0,
    exitCode: null,
    createdAt: 1,
    updatedAt: 1,
  };
}
