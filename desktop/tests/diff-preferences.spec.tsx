import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createKeydexDiffPreferenceKey,
  defaultKeydexDiffPreference,
  readKeydexDiffPreference,
  useKeydexDiffDisplayPreference,
  writeKeydexDiffPreference,
  type KeydexDiffPreferenceStorage,
} from "@/renderer/components/diff/diffPreferences";

class MemoryStorage implements KeydexDiffPreferenceStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  window.localStorage.clear();
});

describe("Keydex Diff display preferences", () => {
  it("hashes the scope so storage never contains an absolute path", () => {
    const scope = "D:/private/project/repository";
    const key = createKeydexDiffPreferenceKey("git", scope);
    expect(key).toMatch(/^keydex\.diff\.display\.v1:git:[a-z0-9]+$/);
    expect(key).not.toContain("private");
    expect(key).not.toContain("D:");
  });

  it("persists only safe display fields and isolates scopes", () => {
    writeKeydexDiffPreference("git", "repo-a", { layout: "split", wrap: true }, storage);
    expect(readKeydexDiffPreference("git", "repo-a", storage)).toEqual({
      version: 1,
      layout: "split",
      wrap: true,
      navigationOpen: false,
    });
    expect(readKeydexDiffPreference("git", "repo-b", storage)).toEqual(defaultKeydexDiffPreference("git"));
    expect([...storage.values.values()].join(" ")).not.toMatch(/patch|selection|busy|repo-a/);
  });

  it("migrates legacy split and lineWrapping values and rejects unsupported layouts", () => {
    storage.setItem(createKeydexDiffPreferenceKey("preview", "tab"), JSON.stringify({ split: true, lineWrapping: false }));
    expect(readKeydexDiffPreference("preview", "tab", storage)).toMatchObject({ layout: "split", wrap: false, version: 1 });
    storage.setItem(createKeydexDiffPreferenceKey("git", "repo"), JSON.stringify({ layout: "other", wrap: true }));
    expect(readKeydexDiffPreference("git", "repo", storage).layout).toBe("split");
  });

  it.each(["compact", "review"] as const)("does not persist the %s profile", (profile) => {
    writeKeydexDiffPreference(profile, "scope", { wrap: false }, storage);
    expect(storage.values.size).toBe(0);
    expect(readKeydexDiffPreference(profile, "scope", storage)).toEqual(defaultKeydexDiffPreference(profile));
  });

  it("restores Git preferences after a hook remount", () => {
    const first = renderHook(() => useKeydexDiffDisplayPreference("git", "repo-hook"));
    act(() => first.result.current.update({ layout: "split", wrap: true }));
    first.unmount();
    const second = renderHook(() => useKeydexDiffDisplayPreference("git", "repo-hook"));
    expect(second.result.current.preference).toMatchObject({ layout: "split", wrap: true });
  });

  it("switches scope without leaking the previous project preference", () => {
    const hook = renderHook(({ scope }) => useKeydexDiffDisplayPreference("git", scope), {
      initialProps: { scope: "repo-one" },
    });
    act(() => hook.result.current.update({ layout: "split" }));
    expect(hook.result.current.preference.layout).toBe("split");
    hook.rerender({ scope: "repo-two" });
    expect(hook.result.current.preference.layout).toBe("split");
  });
});
