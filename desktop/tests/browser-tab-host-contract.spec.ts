import { describe, expect, it, vi } from "vitest";

import {
  BrowserTabLifecycle,
  type BrowserTabHostAdapter,
  type BrowserTabState,
} from "@/renderer/features/browser/domain";

function browserState(id: string): BrowserTabState {
  return {
    id,
    title: "Example",
    restoreUrl: "https://example.com/",
    restoreUrlSanitized: false,
    profileMode: "persistent",
    zoomFactor: 1,
    createdAt: "2026-07-23T00:00:00.000Z",
    lastActivatedAt: "2026-07-23T00:00:00.000Z",
  };
}

function fakeHost(kind: "agent" | "workbench"): BrowserTabHostAdapter {
  const state = browserState(`${kind}-browser`);
  return {
    kind,
    scopeKey: kind === "agent" ? "session:s-1" : "workspace:w-1",
    composerScopeKey: kind === "agent" ? "session:s-1" : "session:s-2",
    active: true,
    state,
    updateState: vi.fn(),
    createTab: vi.fn(),
    activateTab: vi.fn(),
    closeTab: vi.fn(),
    reportError: vi.fn(),
  };
}

describe("browser tab host contract", () => {
  it.each(["agent", "workbench"] as const)(
    "drives the browser core through a %s adapter",
    (kind) => {
      const host = fakeHost(kind);

      host.createTab({ restoreUrl: "https://example.com/new", activate: true });
      host.activateTab(host.state.id);
      host.updateState({ ...host.state, title: "Updated" });
      host.closeTab(host.state.id);

      expect(host.createTab).toHaveBeenCalledWith({
        restoreUrl: "https://example.com/new",
        activate: true,
      });
      expect(host.activateTab).toHaveBeenCalledWith(host.state.id);
      expect(host.updateState).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Updated" }),
      );
      expect(host.closeTab).toHaveBeenCalledWith(host.state.id);
    },
  );

  it("accepts one complete lifecycle in order", () => {
    const lifecycle = new BrowserTabLifecycle();

    lifecycle.transition("mount");
    lifecycle.transition("activate");
    lifecycle.transition("deactivate");
    lifecycle.transition("destroy");

    expect(lifecycle.snapshot).toEqual({
      mounted: true,
      active: false,
      destroyed: true,
    });
  });

  it.each([
    ["duplicate mount", ["mount", "mount"]],
    ["activate before mount", ["activate"]],
    ["duplicate activate", ["mount", "activate", "activate"]],
    ["deactivate before activate", ["mount", "deactivate"]],
    ["destroy while active", ["mount", "activate", "destroy"]],
    ["transition after destroy", ["mount", "destroy", "activate"]],
  ] as const)("rejects %s", (_label, phases) => {
    const lifecycle = new BrowserTabLifecycle();

    expect(() => {
      for (const phase of phases) lifecycle.transition(phase);
    }).toThrow(/lifecycle/);
  });

  it("routes host errors without throwing across the core boundary", () => {
    const host = fakeHost("workbench");
    const error = new Error("native surface failed");

    host.reportError?.(error);

    expect(host.reportError).toHaveBeenCalledWith(error);
  });
});
