import { describe, expect, it } from "vitest";

import {
  BROWSER_TAB_PERSISTENCE_SCHEMA_VERSION,
  normalizePersistedBrowserTab,
  serializePersistableBrowserTab,
  type BrowserTabState,
} from "../src/renderer/features/browser/domain";

const base: BrowserTabState = {
  id: "workbench:browser:1",
  title: " Local preview ",
  restoreUrl: "file:///D:/workspace/demo.html",
  restoreUrlSanitized: false,
  profileMode: "persistent",
  zoomFactor: 1.25,
  createdAt: "2026-07-23T00:00:00.000Z",
  lastActivatedAt: "2026-07-23T00:01:00.000Z",
};

describe("shared browser tab persistence", () => {
  it("roundtrips a canonical file URL, title, and zoom without runtime tokens", () => {
    const serialized = serializePersistableBrowserTab(base);
    expect(serialized).toEqual({
      schemaVersion: BROWSER_TAB_PERSISTENCE_SCHEMA_VERSION,
      id: base.id,
      title: "Local preview",
      faviconUrl: null,
      restoreUrl: "file:///D:/workspace/demo.html",
      restoreUrlSanitized: false,
      profileMode: "persistent",
      zoomFactor: 1.25,
      createdAt: base.createdAt,
      lastActivatedAt: base.lastActivatedAt,
    });
    expect(normalizePersistedBrowserTab(serialized)).toEqual({
      ...base,
      title: "Local preview",
    });
    expect(serialized).not.toHaveProperty("surfaceId");
    expect(serialized).not.toHaveProperty("navigationId");
    expect(serialized).not.toHaveProperty("bridgeToken");
  });

  it("keeps a missing file as a recoverable navigation target instead of probing disk at startup", () => {
    const snapshot = serializePersistableBrowserTab({
      ...base,
      restoreUrl: "file:///D:/workspace/does-not-exist.html",
    });
    expect(normalizePersistedBrowserTab(snapshot)).toMatchObject({
      restoreUrl: "file:///D:/workspace/does-not-exist.html",
      profileMode: "persistent",
    });
  });

  it("excludes incognito and rejects malformed, unsafe, or token-bearing snapshots locally", () => {
    expect(serializePersistableBrowserTab({ ...base, profileMode: "incognito" })).toBeNull();
    const valid = serializePersistableBrowserTab(base)!;
    for (const invalid of [
      { ...valid, restoreUrl: "javascript:alert(1)" },
      { ...valid, restoreUrl: "file:///D:/workspace/folder/" },
      { ...valid, zoomFactor: Number.NaN },
      { ...valid, profileMode: "incognito" },
      { ...valid, bridgeToken: "one-time-secret" },
      { ...valid, schemaVersion: 999 },
    ]) {
      expect(normalizePersistedBrowserTab(invalid)).toBeNull();
    }
  });

  it("preserves HTTP sanitization and the legacy empty-tab representation", () => {
    const remote = serializePersistableBrowserTab({
      ...base,
      restoreUrl: "https://example.test/callback?token=secret&view=docs",
    });
    expect(remote?.restoreUrl).toBe("https://example.test/callback?view=docs");
    expect(remote?.restoreUrlSanitized).toBe(true);
    expect(normalizePersistedBrowserTab(remote)?.restoreUrl)
      .toBe("https://example.test/callback?view=docs");

    const blank = serializePersistableBrowserTab({ ...base, restoreUrl: "" });
    expect(blank?.restoreUrl).toBe("about:blank");
    expect(normalizePersistedBrowserTab(blank)?.restoreUrl).toBe("");
  });
});
