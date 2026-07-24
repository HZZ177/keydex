import { describe, expect, it } from "vitest";

import {
  normalizePersistedWorkbenchModeUiState,
  serializePersistableWorkbenchPreviewTabs,
  workbenchModeUiScopeKey,
} from "../src/renderer/pages/workbench/WorkbenchModePage";
import {
  createWorkbenchBrowserAdapter,
  createWorkbenchBrowserTabState,
} from "../src/renderer/pages/workbench/workbenchBrowserAdapter";

function legacyFileTab(id: string, path: string) {
  return {
    id,
    request: { type: "file" as const, path },
    requestId: 1,
    refreshRequestId: 0,
    revealTarget: null,
    renderContext: null,
    sourceEntryId: null,
    sourceLabel: path,
    title: path.split("/").at(-1) ?? path,
    markdownView: {
      scopeId: `scope:${id}`,
      entryId: `entry:${id}`,
      viewId: `view:${id}`,
      kind: "workbench" as const,
    },
  };
}

describe("workbench persisted legacy file tabs", () => {
  it("restores the old file-only array without a manual migration", () => {
    const tab = legacyFileTab("file:readme", "README.md");
    const normalized = normalizePersistedWorkbenchModeUiState({
      previewBrowserWidth: 320,
      previewTabs: { activeTabId: tab.id, tabs: [tab] },
      activeMainPreviewOutline: [],
      activeMainPreviewOutlineReady: false,
      workspaceBrowserState: null,
    });

    expect(normalized?.previewTabs).toMatchObject({
      activeTabId: tab.id,
      tabs: [{ id: tab.id, request: { type: "file", path: "README.md" } }],
    });
  });

  it("drops only a corrupted tab and repairs the active id", () => {
    const valid = legacyFileTab("file:valid", "docs/guide.md");
    const normalized = normalizePersistedWorkbenchModeUiState({
      previewBrowserWidth: 300,
      previewTabs: {
        activeTabId: "file:corrupted",
        tabs: [
          valid,
          { ...legacyFileTab("file:corrupted", "broken.md"), requestId: "NaN" },
        ],
      },
      activeMainPreviewOutline: [{ id: "heading", text: "Guide", level: 1 }],
      activeMainPreviewOutlineReady: true,
      workspaceBrowserState: null,
    });

    expect(normalized?.previewTabs.tabs.map((tab) => tab.id)).toEqual([valid.id]);
    expect(normalized?.previewTabs.activeTabId).toBe(valid.id);
    expect(normalized?.activeMainPreviewOutlineReady).toBe(true);
  });

  it("treats malformed storage as a local miss instead of blocking startup", () => {
    expect(normalizePersistedWorkbenchModeUiState(null)).toBeNull();
    expect(normalizePersistedWorkbenchModeUiState({
      previewBrowserWidth: Number.NaN,
      previewTabs: { activeTabId: null, tabs: [] },
    })).toBeNull();
  });
});

describe("workbench mixed tab persistence", () => {
  it("round-trips file and associated browser branches independently", () => {
    const file = { ...legacyFileTab("file:readme", "README.md"), kind: "file" as const };
    const browser = createWorkbenchBrowserTabState({
      id: "browser:preview",
      now: "2026-07-23T12:00:00.000Z",
      previewFilePath: "d:/demo/../demo/index.html",
    });
    const serialized = serializePersistableWorkbenchPreviewTabs({
      activeTabId: browser.id,
      tabs: [file, browser],
    });
    const normalized = normalizePersistedWorkbenchModeUiState({
      previewBrowserWidth: 360,
      previewTabs: serialized,
      activeMainPreviewOutline: [],
      activeMainPreviewOutlineReady: false,
      workspaceBrowserState: null,
    });

    expect(serialized.tabs).toHaveLength(2);
    expect(serialized.tabs[1]).toMatchObject({
      kind: "browser",
      previewFilePath: "D:\\demo\\index.html",
      previewFileKey: "file:///d:/demo/index.html",
      browser: {
        id: browser.id,
        restoreUrl: "file:///D:/demo/index.html",
        profileMode: "persistent",
      },
    });
    expect(JSON.stringify(serialized)).not.toContain("surfaceId");
    expect(normalized?.previewTabs).toMatchObject({
      activeTabId: browser.id,
      tabs: [
        { kind: "file", id: file.id },
        {
          kind: "browser",
          id: browser.id,
          previewFilePath: "D:\\demo\\index.html",
          restoreUrl: "file:///D:/demo/index.html",
        },
      ],
    });
  });

  it("excludes incognito browser tabs and repairs active selection locally", () => {
    const file = { ...legacyFileTab("file:guide", "guide.md"), kind: "file" as const };
    const incognito = createWorkbenchBrowserTabState({
      id: "browser:incognito",
      now: "2026-07-23T12:00:00.000Z",
      profileMode: "incognito",
      restoreUrl: "https://example.test/private",
    });
    const serialized = serializePersistableWorkbenchPreviewTabs({
      activeTabId: incognito.id,
      tabs: [file, incognito],
    });

    expect(serialized.tabs).toEqual([expect.objectContaining({ kind: "file", id: file.id })]);
    expect(serialized.activeTabId).toBe(file.id);
  });

  it("drops an invalid browser branch without losing a valid legacy file branch", () => {
    const file = legacyFileTab("file:valid", "docs/valid.md");
    const normalized = normalizePersistedWorkbenchModeUiState({
      previewBrowserWidth: 300,
      previewTabs: {
        activeTabId: "browser:corrupt",
        tabs: [
          file,
          {
            kind: "browser",
            browser: {
              schemaVersion: 1,
              id: "browser:corrupt",
              title: "Corrupt",
              faviconUrl: null,
              restoreUrl: "file:///D:/demo/index.html",
              restoreUrlSanitized: false,
              profileMode: "persistent",
              zoomFactor: 1,
              createdAt: "2026-07-23T12:00:00.000Z",
              lastActivatedAt: "2026-07-23T12:00:00.000Z",
              runtimeToken: "must-not-be-accepted",
            },
          },
          { kind: "future-kind", id: "future" },
        ],
      },
      activeMainPreviewOutline: [],
      activeMainPreviewOutlineReady: false,
      workspaceBrowserState: null,
    });

    expect(normalized?.previewTabs.tabs).toEqual([
      expect.objectContaining({ kind: "file", id: file.id }),
    ]);
    expect(normalized?.previewTabs.activeTabId).toBe(file.id);
  });

  it("keeps browser persistence and composer routing isolated by workspace", () => {
    const state = createWorkbenchBrowserTabState({
      id: "browser:shared-id",
      now: "2026-07-23T12:00:00.000Z",
      restoreUrl: "https://example.test/",
    });
    const noOp = () => undefined;
    const first = createWorkbenchBrowserAdapter({
      workspaceId: "workspace-a",
      selectedSessionId: "session-a",
      active: true,
      state,
      updateState: noOp,
      createTab: noOp,
      activateTab: noOp,
      closeTab: noOp,
    });
    const second = createWorkbenchBrowserAdapter({
      workspaceId: "workspace-b",
      selectedSessionId: "session-b",
      active: true,
      state,
      updateState: noOp,
      createTab: noOp,
      activateTab: noOp,
      closeTab: noOp,
    });

    expect(first.scopeKey).toBe("workspace:workspace-a");
    expect(second.scopeKey).toBe("workspace:workspace-b");
    expect(first.composerScopeKey).toBe("session:session-a");
    expect(second.composerScopeKey).toBe("session:session-b");
    expect(workbenchModeUiScopeKey({ workspaceId: "workspace-a" })).toBe("workspace:workspace-a");
    expect(workbenchModeUiScopeKey({ workspaceId: "workspace-b" })).toBe("workspace:workspace-b");
    expect(workbenchModeUiScopeKey({ workspaceId: "workspace-a" })).not.toBe(
      workbenchModeUiScopeKey({ workspaceId: "workspace-b" }),
    );
  });
});
