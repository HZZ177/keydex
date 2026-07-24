import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createWorkbenchBrowserAdapter,
  createWorkbenchBrowserTabState,
} from "@/renderer/pages/workbench/workbenchBrowserAdapter";

const NOW = "2026-07-23T00:00:00.000Z";

function harness(selectedSessionId?: string) {
  const state = createWorkbenchBrowserTabState({
    id: "workbench:browser:1",
    now: NOW,
    restoreUrl: "https://example.test/",
  });
  const callbacks = {
    updateState: vi.fn(),
    createTab: vi.fn(),
    activateTab: vi.fn(),
    closeTab: vi.fn(),
  };
  return {
    state,
    callbacks,
    adapter: createWorkbenchBrowserAdapter({
      workspaceId: "workspace-a",
      selectedSessionId,
      active: true,
      state,
      ...callbacks,
    }),
  };
}

describe("workbench browser adapter", () => {
  it("routes tab lifecycle and popup creation to the current workspace", () => {
    const run = harness("session-a");

    run.adapter.createTab({
      restoreUrl: "https://example.test/popup",
      activate: true,
    });
    run.adapter.activateTab(run.state.id);
    run.adapter.closeTab(run.state.id);

    expect(run.adapter.kind).toBe("workbench");
    expect(run.adapter.scopeKey).toBe("workspace:workspace-a");
    expect(run.callbacks.createTab).toHaveBeenCalledWith({
      restoreUrl: "https://example.test/popup",
      activate: true,
    });
    expect(run.callbacks.activateTab).toHaveBeenCalledWith(run.state.id);
    expect(run.callbacks.closeTab).toHaveBeenCalledWith(run.state.id);
  });

  it("retargets annotations to the selected session composer without changing workspace scope", () => {
    const first = harness("session-a").adapter;
    const second = harness("session-b").adapter;
    const draft = harness().adapter;

    expect(first.scopeKey).toBe(second.scopeKey);
    expect(first.composerScopeKey).toBe("session:session-a");
    expect(second.composerScopeKey).toBe("session:session-b");
    expect(draft.composerScopeKey).toBe("new-workspace:workspace-a");
  });

  it("isolates persisted annotation scope by workspace while composer routing follows session selection", () => {
    const workspaceA = harness("session-a").adapter;
    const workspaceBState = createWorkbenchBrowserTabState({
      id: "workbench:browser:b",
      now: NOW,
      restoreUrl: "file:///D:/workspaces/b/index.html",
    });
    const workspaceB = createWorkbenchBrowserAdapter({
      workspaceId: "workspace-b",
      selectedSessionId: "session-a",
      active: true,
      state: workspaceBState,
      updateState: vi.fn(),
      createTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });

    expect(workspaceA.scopeKey).toBe("workspace:workspace-a");
    expect(workspaceB.scopeKey).toBe("workspace:workspace-b");
    expect(workspaceA.composerScopeKey).toBe(workspaceB.composerScopeKey);
  });

  it("creates a persistent browser tab associated with an optional preview file", () => {
    const state = createWorkbenchBrowserTabState({
      id: "workbench:browser:file",
      now: NOW,
      restoreUrl: "file:///D:/demo/index.html",
      previewFilePath: "D:\\demo\\index.html",
    });

    expect(state).toMatchObject({
      kind: "browser",
      title: "index.html",
      profileMode: "persistent",
      previewFilePath: "D:\\demo\\index.html",
    });
  });

  it("does not depend on or mount the global RightSidebar host", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/workbenchBrowserAdapter.ts"),
      "utf8",
    );

    expect(source).not.toContain("RightSidebarHost");
    expect(source).not.toContain("rightSidebarPersistence");
  });

  it("rejects a workspace-free adapter", () => {
    const run = harness();

    expect(() => createWorkbenchBrowserAdapter({
      workspaceId: " ",
      active: true,
      state: run.state,
      ...run.callbacks,
    })).toThrow(/requires a workspace/);
  });
});
