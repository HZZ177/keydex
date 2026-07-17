import { describe, expect, it, vi } from "vitest";

import {
  PierreEngineLoader,
  pierreEngineLoadSnapshot,
  type PierreDiffsReactModule,
} from "@/renderer/components/diff/engine/loadPierreDiffs";

function moduleValue(): PierreDiffsReactModule {
  return {
    PatchDiff: vi.fn(),
    CodeView: vi.fn(),
    parsePatchFiles: vi.fn(),
    registerCustomCSSVariableTheme: vi.fn(),
  } as unknown as PierreDiffsReactModule;
}

describe("Pierre engine lazy loader", () => {
  it("stays idle at application import time", () => {
    expect(pierreEngineLoadSnapshot()).toMatchObject({ status: "idle", module: null, attempt: 0 });
  });

  it("deduplicates concurrent mounts into one dynamic import", async () => {
    let resolve!: (module: PierreDiffsReactModule) => void;
    const importer = vi.fn(() => new Promise<PierreDiffsReactModule>((done) => { resolve = done; }));
    const loader = new PierreEngineLoader(importer);
    const first = loader.load();
    const second = loader.load();
    expect(first).toBe(second);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(loader.snapshot().status).toBe("loading");
    resolve(moduleValue());
    await expect(first).resolves.toMatchObject({ PatchDiff: expect.anything() });
    expect(loader.snapshot()).toMatchObject({ status: "ready", attempt: 1 });
  });

  it("preloads without surfacing unhandled failures and retries once requested", async () => {
    const expected = moduleValue();
    const importer = vi.fn()
      .mockRejectedValueOnce(new Error("chunk unavailable"))
      .mockResolvedValueOnce(expected);
    const loader = new PierreEngineLoader(importer);
    loader.preload();
    await vi.waitFor(() => expect(loader.snapshot().status).toBe("error"));
    await expect(loader.retry()).resolves.toBe(expected);
    expect(loader.snapshot()).toMatchObject({ status: "ready", attempt: 2, error: null });
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes an unmounted host while the shared load can still settle", async () => {
    let resolve!: (module: PierreDiffsReactModule) => void;
    const loader = new PierreEngineLoader(() => new Promise((done) => { resolve = done; }));
    const listener = vi.fn();
    const unsubscribe = loader.subscribe(listener);
    const pending = loader.load();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    resolve(moduleValue());
    await pending;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(loader.snapshot().status).toBe("ready");
  });

  it("returns the cached module without another import", async () => {
    const expected = moduleValue();
    const importer = vi.fn().mockResolvedValue(expected);
    const loader = new PierreEngineLoader(importer);
    await loader.load();
    await expect(loader.load()).resolves.toBe(expected);
    expect(importer).toHaveBeenCalledTimes(1);
  });
});
