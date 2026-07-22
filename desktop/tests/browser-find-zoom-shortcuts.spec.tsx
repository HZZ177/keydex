import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BrowserPanelRuntimeController } from "@/renderer/features/browser/runtime/BrowserPanelRuntime";
import { createBrowserRuntimeStore } from "@/renderer/features/browser/state";
import { BrowserFindBar, BrowserZoomBar } from "@/renderer/features/browser/ui";
import { parseBrowserEventEnvelope } from "@/renderer/features/browser/domain/browserHostContract";

const surface = { panelId: "panel-1", surfaceId: "surface-1", generation: 1 } as const;

describe("browser find and zoom chrome", () => {
  it("supports Unicode queries, next, previous, match-case, empty guard, and Escape close", () => {
    const onQueryChange = vi.fn();
    const onSearch = vi.fn();
    const onClose = vi.fn();
    const view = render(
      <BrowserFindBar
        matchCase={false}
        query="中文🙂"
        onClose={onClose}
        onMatchCaseChange={vi.fn()}
        onQueryChange={onQueryChange}
        onSearch={onSearch}
      />,
    );
    const input = screen.getByRole("textbox", { name: "查找内容" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSearch).toHaveBeenNthCalledWith(1, false);
    expect(onSearch).toHaveBeenNthCalledWith(2, true);
    fireEvent.change(input, { target: { value: "" } });
    expect(onQueryChange).toHaveBeenCalledWith("");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(
      <BrowserFindBar
        matchCase={false}
        query=""
        onClose={onClose}
        onMatchCaseChange={vi.fn()}
        onQueryChange={onQueryChange}
        onSearch={onSearch}
      />,
    );
    expect(screen.getByRole("button", { name: "下一个匹配项" }).hasAttribute("disabled")).toBe(true);
  });

  it("clamps zoom to 50-300 percent and resets to 100 percent", () => {
    const onChange = vi.fn();
    const view = render(<BrowserZoomBar factor={0.5} onChange={onChange} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "缩小页面" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "放大页面" }));
    expect(onChange).toHaveBeenCalledWith(0.75);
    view.rerender(<BrowserZoomBar factor={3} onChange={onChange} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "放大页面" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重置为 100%" }));
    expect(onChange).toHaveBeenLastCalledWith(1);
  });
});

describe("BrowserPanelRuntime find and zoom commands", () => {
  it("accepts only the closed native shortcut event set", () => {
    expect(parseBrowserEventEnvelope({
      schemaVersion: 1,
      kind: "shortcut.requested",
      panelId: "panel-1",
      surfaceId: "surface-1",
      generation: 1,
      sequence: 1,
      occurredAt: "2026-07-22T00:00:00.000Z",
      payload: { shortcut: "find" },
    }).payload).toEqual({ shortcut: "find" });
    expect(() => parseBrowserEventEnvelope({
      schemaVersion: 1,
      kind: "shortcut.requested",
      panelId: "panel-1",
      surfaceId: "surface-1",
      generation: 1,
      sequence: 1,
      occurredAt: "2026-07-22T00:00:00.000Z",
      payload: { shortcut: "devtools" },
    })).toThrow();
  });

  it("sends query only to the typed native command and supports stop-find", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, requestId: "request" });
    const runtime = new BrowserPanelRuntimeController({
      connect: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      send,
    } as never, createBrowserRuntimeStore());
    await runtime.find(surface, "Unicode 中文", true, false);
    await runtime.find(surface, "Unicode 中文", true, true);
    await runtime.stopFind(surface);
    expect(send).toHaveBeenNthCalledWith(1, "browser_find", { ...surface, query: "Unicode 中文", matchCase: true, backwards: false });
    expect(send).toHaveBeenNthCalledWith(2, "browser_find", { ...surface, query: "Unicode 中文", matchCase: true, backwards: true });
    expect(send).toHaveBeenNthCalledWith(3, "browser_stop_find", surface);
  });

  it("sends exact zoom boundaries", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, requestId: "request" });
    const runtime = new BrowserPanelRuntimeController({
      connect: vi.fn(), subscribe: vi.fn(() => vi.fn()), send,
    } as never, createBrowserRuntimeStore());
    await runtime.setZoom(surface, 0.5);
    await runtime.setZoom(surface, 3);
    await runtime.setZoom(surface, 1);
    expect(send.mock.calls.map((call) => call[1].factor)).toEqual([0.5, 3, 1]);
  });
});
