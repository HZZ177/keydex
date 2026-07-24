import { describe, expect, it, vi } from "vitest";

import type { BrowserTabCreateOptions } from "@/renderer/features/browser/domain";
import {
  closeWorkbenchTabState,
  disposeWorkbenchBrowserTabOnce,
  openWorkbenchBrowserTabState,
  requestWorkbenchAssociatedBrowserReloadState,
  type WorkbenchMixedTabState,
} from "@/renderer/pages/workbench/workbenchMainTabModel";

interface FileTab {
  readonly id: string;
  readonly kind: "file";
  readonly title: string;
}

const fileTab: FileTab = { id: "file:readme", kind: "file", title: "README.md" };
const NOW = "2026-07-23T12:00:00.000Z";

function open(
  state: WorkbenchMixedTabState<FileTab>,
  id: string,
  options: BrowserTabCreateOptions,
) {
  return openWorkbenchBrowserTabState(state, { id, now: NOW, options });
}

describe("workbench browser tab lifecycle", () => {
  it("deduplicates equivalent associated file previews by canonical key", () => {
    const initial: WorkbenchMixedTabState<FileTab> = { activeTabId: fileTab.id, tabs: [fileTab] };
    const first = open(initial, "browser:first", {
      previewFilePath: "D:\\demo\\index.html",
      activate: true,
    });
    const second = open(first.state, "browser:ignored", {
      previewFilePath: "d:/demo/./index.html",
      activate: true,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.tab.id).toBe(first.tab.id);
    expect(second.state.tabs.filter((tab) => tab.kind === "browser")).toHaveLength(1);
    expect(second.state.activeTabId).toBe(first.tab.id);
  });

  it("passes the canonical file URL and a refresh navigation command when reusing an associated preview", () => {
    const initial: WorkbenchMixedTabState<FileTab> = { activeTabId: fileTab.id, tabs: [fileTab] };
    const first = openWorkbenchBrowserTabState(initial, {
      id: "browser:first",
      now: NOW,
      commandId: "preview-command-1",
      options: { previewFilePath: "D:\\演示 目录\\index.html" },
    });
    const reused = openWorkbenchBrowserTabState(
      { ...first.state, activeTabId: fileTab.id },
      {
        id: "browser:ignored",
        now: "2026-07-23T12:01:00.000Z",
        commandId: "preview-command-2",
        options: { previewFilePath: "d:/演示 目录/./index.html" },
      },
    );

    expect(first.tab.restoreUrl).toBe("file:///D:/%E6%BC%94%E7%A4%BA%20%E7%9B%AE%E5%BD%95/index.html");
    expect(first.tab.title).toBe("index.html");
    expect(reused.created).toBe(false);
    expect(reused.tab.navigationCommand).toEqual({
      id: "preview-command-2",
      kind: "navigate",
      source: "app_preview",
      url: "file:///D:/%E6%BC%94%E7%A4%BA%20%E7%9B%AE%E5%BD%95/index.html",
    });
    expect(reused.state.activeTabId).toBe(first.tab.id);
  });

  it("creates a new associated browser tab after the previous preview tab closes", () => {
    const initial: WorkbenchMixedTabState<FileTab> = { activeTabId: fileTab.id, tabs: [fileTab] };
    const first = open(initial, "browser:first", { previewFilePath: "D:\\demo\\index.html" });
    const closed = closeWorkbenchTabState(first.state, first.tab.id);
    const reopened = open(closed.state, "browser:reopened", {
      previewFilePath: "D:\\demo\\index.html",
    });

    expect(reopened.created).toBe(true);
    expect(reopened.tab.id).toBe("browser:reopened");
    expect(reopened.state.tabs.map((tab) => tab.id)).toEqual([fileTab.id, "browser:reopened"]);
  });

  it("queues a reload only for the associated browser tab and keeps it in the background", () => {
    const initial: WorkbenchMixedTabState<FileTab> = { activeTabId: fileTab.id, tabs: [fileTab] };
    const one = open(initial, "browser:one", { previewFilePath: "D:\\demo\\one.html" });
    const two = open({ ...one.state, activeTabId: fileTab.id }, "browser:two", {
      previewFilePath: "D:\\demo\\two.html",
      activate: false,
    });
    const reloaded = requestWorkbenchAssociatedBrowserReloadState(
      two.state,
      "d:/demo/./one.html",
      "reload-1",
    );

    expect(reloaded.tab?.id).toBe("browser:one");
    expect(reloaded.tab?.navigationCommand).toEqual({
      id: "reload-1",
      kind: "reload",
      source: "file_change",
      url: "file:///D:/demo/one.html",
    });
    expect(reloaded.state.activeTabId).toBe(fileTab.id);
    expect((reloaded.state.tabs[2] as { navigationCommand?: unknown }).navigationCommand).toBeUndefined();
  });

  it("does not create a browser tab when a persisted HTML revision has no association", () => {
    const initial: WorkbenchMixedTabState<FileTab> = { activeTabId: fileTab.id, tabs: [fileTab] };
    const result = requestWorkbenchAssociatedBrowserReloadState(
      initial,
      "D:\\demo\\missing.html",
      "reload-missing",
    );

    expect(result.tab).toBeNull();
    expect(result.state).toBe(initial);
  });

  it("keeps different associated HTML files as independent browser tabs", () => {
    const initial: WorkbenchMixedTabState<FileTab> = { activeTabId: fileTab.id, tabs: [fileTab] };
    const first = open(initial, "browser:first", { previewFilePath: "D:\\demo\\one.html" });
    const second = open(first.state, "browser:second", { previewFilePath: "D:\\demo\\two.html" });

    expect(second.created).toBe(true);
    expect(second.state.tabs.map((tab) => tab.id)).toEqual([
      fileTab.id,
      "browser:first",
      "browser:second",
    ]);
  });

  it("allows ordinary popup tabs with the same URL to have multiple instances", () => {
    const initial: WorkbenchMixedTabState<FileTab> = { activeTabId: fileTab.id, tabs: [fileTab] };
    const first = open(initial, "browser:popup-1", {
      restoreUrl: "https://example.test/popup",
      activate: false,
    });
    const second = open(first.state, "browser:popup-2", {
      restoreUrl: "https://example.test/popup",
      activate: true,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.state.tabs.filter((tab) => tab.kind === "browser")).toHaveLength(2);
    expect(second.state.activeTabId).toBe("browser:popup-2");
  });

  it("closes a background tab without changing the active tab", () => {
    const initial: WorkbenchMixedTabState<FileTab> = { activeTabId: fileTab.id, tabs: [fileTab] };
    const first = open(initial, "browser:active", { restoreUrl: "https://example.test/active" });
    const second = open(first.state, "browser:background", {
      restoreUrl: "https://example.test/background",
      activate: false,
    });
    const closed = closeWorkbenchTabState(second.state, "browser:background");

    expect(closed.closed?.id).toBe("browser:background");
    expect(closed.state.activeTabId).toBe("browser:active");
    expect(closed.state.tabs.map((tab) => tab.id)).toEqual([fileTab.id, "browser:active"]);
  });

  it("activates the nearest left tab when the current tab closes", () => {
    const initial: WorkbenchMixedTabState<FileTab> = { activeTabId: fileTab.id, tabs: [fileTab] };
    const first = open(initial, "browser:left", { restoreUrl: "https://example.test/left" });
    const second = open(first.state, "browser:active", { restoreUrl: "https://example.test/active" });
    const third = open(second.state, "browser:right", {
      restoreUrl: "https://example.test/right",
      activate: false,
    });
    const closed = closeWorkbenchTabState(third.state, "browser:active");

    expect(closed.state.activeTabId).toBe("browser:left");
    expect(closed.state.tabs.map((tab) => tab.id)).toEqual([
      fileTab.id,
      "browser:left",
      "browser:right",
    ]);
  });

  it("supports close-right and close-other as deterministic repeated closes", () => {
    const initial: WorkbenchMixedTabState<FileTab> = { activeTabId: fileTab.id, tabs: [fileTab] };
    const first = open(initial, "browser:one", { restoreUrl: "https://example.test/one" });
    const second = open(first.state, "browser:two", { restoreUrl: "https://example.test/two" });
    const third = open(second.state, "browser:three", { restoreUrl: "https://example.test/three" });
    const closeRightIds = third.state.tabs.slice(2).map((tab) => tab.id);
    const afterCloseRight = closeRightIds.reduce(
      (state, id) => closeWorkbenchTabState(state, id).state,
      third.state,
    );
    const afterCloseOther = afterCloseRight.tabs
      .filter((tab) => tab.id !== fileTab.id)
      .reduce((state, tab) => closeWorkbenchTabState(state, tab.id).state, afterCloseRight);

    expect(afterCloseRight.tabs.map((tab) => tab.id)).toEqual([fileTab.id, "browser:one"]);
    expect(afterCloseOther).toEqual({ activeTabId: fileTab.id, tabs: [fileTab] });
  });

  it("returns a local no-op for duplicate closes", () => {
    const initial: WorkbenchMixedTabState<FileTab> = { activeTabId: fileTab.id, tabs: [fileTab] };
    const first = closeWorkbenchTabState(initial, fileTab.id);
    const duplicate = closeWorkbenchTabState(first.state, fileTab.id);

    expect(first.closed?.id).toBe(fileTab.id);
    expect(duplicate.closed).toBeNull();
    expect(duplicate.state).toBe(first.state);
  });

  it("disposes each native runtime panel exactly once across duplicate close paths", () => {
    const disposedIds = new Set<string>();
    const dispose = vi.fn();

    expect(disposeWorkbenchBrowserTabOnce(disposedIds, "workspace:a:browser:1", dispose)).toBe(true);
    expect(disposeWorkbenchBrowserTabOnce(disposedIds, "workspace:a:browser:1", dispose)).toBe(false);
    expect(disposeWorkbenchBrowserTabOnce(disposedIds, "workspace:a:browser:2", dispose)).toBe(true);
    expect(dispose).toHaveBeenNthCalledWith(1, "workspace:a:browser:1");
    expect(dispose).toHaveBeenNthCalledWith(2, "workspace:a:browser:2");
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
