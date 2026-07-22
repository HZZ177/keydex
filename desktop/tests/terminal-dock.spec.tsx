import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalDock } from "@/renderer/features/terminal/TerminalDock";
import { TerminalProvider } from "@/renderer/features/terminal/TerminalProvider";
import { resolveTerminalDockHeight } from "@/renderer/features/terminal/TerminalResizeHandle";
import { TerminalXtermRegistry } from "@/renderer/features/terminal/terminalXtermRegistry";
import { createTerminalStore } from "@/renderer/features/terminal/terminalStore";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import {
  TerminalSessionScopeProvider,
  usePublishTerminalSessionScope,
} from "@/renderer/providers/TerminalSessionScopeProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";
import type { TerminalRuntime, TerminalSnapshot } from "@/runtime";

vi.mock("@/renderer/features/terminal/TerminalSurfacePool", () => ({
  TerminalSurfacePool: () => <div data-testid="mock-terminal-surface-pool" />,
}));

afterEach(() => vi.unstubAllGlobals());

describe("TerminalDock", () => {
  it("clamps persisted dock height to 160px..70% and restores the 320px default inside that range", () => {
    expect(resolveTerminalDockHeight(120, 700)).toBe(160);
    expect(resolveTerminalDockHeight(320, 700)).toBe(320);
    expect(resolveTerminalDockHeight(900, 700)).toBe(700);
  });

  it("creates, renames and confirms closing a running terminal through standard UI", async () => {
    const store = createTerminalStore({ storage: null });
    store.getState().setDockOpen(true);
    const running = snapshot("terminal-1", "PowerShell 1");
    const create = vi.fn(async () => snapshot("terminal-2", "PowerShell 2"));
    const rename = vi.fn(async (_terminalId: string, title: string) => ({ ...running, title }));
    const close = vi.fn(async () => undefined);
    renderDock(store, runtime({ create, rename, close, list: async () => [running] }));

    await screen.findByText("PowerShell 1");
    const createButton = screen.getByRole("button", { name: "新建终端" });
    await waitFor(() => expect(createButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(createButton);
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      cwd: "D:/repo",
      profile: "powershell",
    })));

    fireEvent.click(screen.getByRole("button", { name: "重命名当前终端" }));
    const input = await screen.findByRole("textbox", { name: "终端名称" });
    fireEvent.change(input, { target: { value: "构建终端" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith("terminal-2", "构建终端"));

    fireEvent.click(screen.getByRole("button", { name: "关闭当前终端" }));
    expect(await screen.findByText("关闭正在运行的终端？")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关闭当前终端" }));
    fireEvent.click(await screen.findByRole("button", { name: "关闭终端" }));
    await waitFor(() => expect(close).toHaveBeenCalledWith("terminal-2"));
  });

  it("uses the project-styled terminal profile selector instead of a native select", async () => {
    const store = createTerminalStore({ storage: null });
    store.getState().setDockOpen(true);
    const create = vi.fn(async () => snapshot("terminal-2", "CMD 1"));
    renderDock(store, runtime({
      create,
      list: async () => [snapshot("terminal-1", "PowerShell 1")],
      listProfiles: async () => [
        { id: "powershell", label: "PowerShell", available: true, executable: "pwsh.exe", args: [], unavailableReason: null },
        { id: "cmd", label: "CMD", available: true, executable: "cmd.exe", args: [], unavailableReason: null },
      ],
    }));

    const selector = await screen.findByRole("button", { name: "新终端配置" });
    expect(selector.tagName).toBe("BUTTON");
    expect(document.querySelector("select[aria-label='新终端配置']")).toBeNull();
    fireEvent.click(selector);
    fireEvent.click(await screen.findByRole("option", { name: "CMD" }));
    await waitFor(() => expect(store.getState().ui.defaultProfile).toBe("cmd"));
    fireEvent.click(within(screen.getByRole("toolbar", { name: "终端操作" }))
      .getByRole("button", { name: "新建终端" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ profile: "cmd" })));
  });

  it("auto-creates the default profile once after an opened empty session is hydrated", async () => {
    const store = createTerminalStore({ storage: null });
    store.getState().setDockOpen(true);
    const create = vi.fn(async () => snapshot("terminal-1", "PowerShell 1"));
    renderDock(store, runtime({ create, list: async () => [] }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      profile: "powershell",
    }));
    await waitFor(() => expect(store.getState().sessionsById["session-1"]?.terminalIds).toEqual(["terminal-1"]));
  });

  it("does not auto-create while hydration finds an existing terminal", async () => {
    const store = createTerminalStore({ storage: null });
    store.getState().setDockOpen(true);
    const create = vi.fn(async () => snapshot("terminal-2", "PowerShell 2"));
    let resolveList: ((snapshots: TerminalSnapshot[]) => void) | null = null;
    const list = vi.fn(() => new Promise<TerminalSnapshot[]>((resolve) => { resolveList = resolve; }));
    renderDock(store, runtime({ create, list }));

    await waitFor(() => expect(list).toHaveBeenCalledWith("session-1"));
    expect(create).not.toHaveBeenCalled();
    act(() => resolveList?.([snapshot("terminal-1", "PowerShell 1")]));
    await screen.findByText("PowerShell 1");
    expect(create).not.toHaveBeenCalled();

    act(() => store.getState().removeTerminal("terminal-1"));
    await waitFor(() => expect(store.getState().sessionsById["session-1"]?.terminalIds).toEqual([]));
    expect(create).not.toHaveBeenCalled();
  });

  it("confirms and closes every terminal in the current session", async () => {
    const store = createTerminalStore({ storage: null });
    store.getState().setDockOpen(true);
    const first = snapshot("terminal-1", "PowerShell 1");
    const second = snapshot("terminal-2", "Git Bash 2");
    const closeSession = vi.fn(async () => 2);
    renderDock(store, runtime({ closeSession, list: async () => [first, second] }));

    await screen.findByText("PowerShell 1");
    fireEvent.click(screen.getByRole("button", { name: "全部终止并关闭当前会话终端" }));
    const dialog = await screen.findByRole("dialog", { name: "终止并关闭全部终端？" });
    expect(within(dialog).getByText("2 个终端")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "全部终止并关闭" }));

    await waitFor(() => expect(closeSession).toHaveBeenCalledWith("session-1"));
    await waitFor(() => expect(store.getState().sessionsById["session-1"]).toBeUndefined());
    expect(screen.getByTestId("notification-viewport").textContent).toContain("已清理 2 个会话终端");
  });

  it("uses its ResizeObserver for compact mode and toggles without killing terminals", async () => {
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(next: ResizeObserverCallback) { callbacks.push(next); }
      observe() {}
      disconnect() {}
      unobserve() {}
    });
    const store = createTerminalStore({ storage: null });
    store.getState().setDockOpen(true);
    const kill = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const first = snapshot("terminal-1", "PowerShell 1");
    const second = snapshot("terminal-2", "PowerShell 2");
    renderDock(store, runtime({ kill, close, list: async () => [first, second] }));
    await screen.findByText("PowerShell 1");
    await waitFor(() => expect(screen.getByTestId("terminal-dock").getAttribute("data-open")).toBe("true"));
    act(() => {
      const notifyResize = callbacks[0];
      notifyResize?.([{ contentRect: { width: 420 } } as ResizeObserverEntry], {} as ResizeObserver);
    });
    expect(screen.getByTestId("terminal-dock").getAttribute("data-compact")).toBe("true");
    const compactSelector = screen.getByRole("button", { name: "选择当前终端" });
    expect(compactSelector.tagName).toBe("BUTTON");
    expect(document.querySelector("select[aria-label='选择当前终端']")).toBeNull();
    fireEvent.click(compactSelector);
    fireEvent.click(await screen.findByRole("option", { name: /PowerShell 2/ }));
    expect(store.getState().sessionsById["session-1"]?.activeTerminalId).toBe("terminal-2");

    fireEvent.click(screen.getByRole("button", { name: "收起终端面板" }));
    expect(store.getState().ui.dockOpen).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { code: "Backquote", ctrlKey: true });
    expect(store.getState().ui.dockOpen).toBe(true);
  });
});

function ScopePublisher() {
  usePublishTerminalSessionScope("terminal-dock-test", {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    initialCwd: "D:/repo",
    loading: false,
  });
  return null;
}

function renderDock(store: ReturnType<typeof createTerminalStore>, terminalRuntime: TerminalRuntime) {
  return render(
    <ThemeProvider>
      <NotificationProvider>
        <TerminalSessionScopeProvider>
          <ScopePublisher />
          <TerminalProvider store={store} runtime={terminalRuntime}>
            <TerminalDock registry={new TerminalXtermRegistry()} />
          </TerminalProvider>
        </TerminalSessionScopeProvider>
      </NotificationProvider>
    </ThemeProvider>,
  );
}

function runtime(overrides: Partial<TerminalRuntime> = {}): TerminalRuntime {
  return {
    listProfiles: async () => [{
      id: "powershell", label: "PowerShell", available: true, executable: "pwsh.exe", args: [], unavailableReason: null,
    }],
    create: async () => snapshot("terminal-1", "PowerShell 1"),
    list: async () => [],
    attach: async () => ({ snapshot: snapshot("terminal-1", "PowerShell 1"), cursor: 0, ready: Promise.resolve(), dispose() {} }),
    write: async () => undefined,
    resize: async () => undefined,
    kill: async () => undefined,
    rename: async (terminalId, title) => ({ ...snapshot(terminalId, title), title }),
    close: async () => undefined,
    closeSession: async () => 0,
    closeAll: async () => 0,
    ...overrides,
  };
}

function snapshot(terminalId: string, title: string): TerminalSnapshot {
  return {
    contractVersion: 2,
    terminalId,
    sessionId: "session-1",
    profileId: "powershell",
    cwd: "D:/repo",
    title,
    status: "running",
    seq: 0,
    exitCode: null,
    createdAt: terminalId === "terminal-1" ? 1 : 2,
    updatedAt: 1,
  };
}
