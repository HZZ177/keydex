import { act, render, screen, waitFor } from "@testing-library/react";
import { createContext, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerPoolManager, WorkerStats } from "@pierre/diffs/worker";

import {
  PierreWorkerPoolHost,
  usePierreWorkerPoolDiagnostics,
  usePierreWorkerPoolLease,
} from "@/renderer/components/diff/engine/PierreWorkerPoolHost";
import {
  PierreWorkerPoolLifecycle,
  pierreWorkerCacheKey,
} from "@/renderer/components/diff/engine/pierreWorkerPoolLifecycle";
import { KEYDEX_DIFF_THEME_NAMES } from "@/renderer/components/diff/engine/pierreThemes";
import type { PierreDiffsReactModule } from "@/renderer/components/diff/engine/loadPierreDiffs";
import { ThemeProvider, useTheme } from "@/renderer/providers/ThemeProvider";

interface FakePool {
  readonly manager: WorkerPoolManager;
  readonly module: PierreDiffsReactModule;
  readonly createPool: ReturnType<typeof vi.fn>;
  readonly terminatePool: ReturnType<typeof vi.fn>;
  readonly setRenderOptions: ReturnType<typeof vi.fn>;
  readonly fileCache: Map<string, unknown>;
  readonly diffCache: Map<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Pierre Worker Pool lifecycle", () => {
  it("shares one pool across four viewers and terminates only after the last lease", async () => {
    vi.useFakeTimers();
    const fake = fakePool();
    const lifecycle = lifecycleFor(fake);
    const releases = Array.from({ length: 4 }, () => lifecycle.acquire("light"));

    await vi.waitFor(() => expect(lifecycle.snapshot().status).toBe("ready"));
    expect(fake.createPool).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot().references).toBe(4);

    releases.slice(0, 3).forEach((release) => release());
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.terminatePool).not.toHaveBeenCalled();
    releases[3]!();
    await vi.advanceTimersByTimeAsync(49);
    expect(fake.terminatePool).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.terminatePool).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot()).toMatchObject({ status: "idle", references: 0 });
  });

  it("cancels a pending release during a rapid unmount/remount race", async () => {
    vi.useFakeTimers();
    const fake = fakePool();
    const lifecycle = lifecycleFor(fake);
    const firstRelease = lifecycle.acquire("light");
    await vi.waitFor(() => expect(lifecycle.snapshot().status).toBe("ready"));
    firstRelease();
    await vi.advanceTimersByTimeAsync(25);
    const secondRelease = lifecycle.acquire("light");
    await vi.advanceTimersByTimeAsync(100);

    expect(fake.createPool).toHaveBeenCalledTimes(1);
    expect(fake.terminatePool).not.toHaveBeenCalled();
    secondRelease();
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.terminatePool).toHaveBeenCalledTimes(1);
  });

  it("invalidates cached AST entries and advances the cache key on theme changes", async () => {
    const fake = fakePool();
    fake.fileCache.set("file-a", {});
    fake.diffCache.set("diff-a", {});
    const lifecycle = lifecycleFor(fake);
    const release = lifecycle.acquire("light");
    await vi.waitFor(() => expect(lifecycle.snapshot().status).toBe("ready"));
    const before = pierreWorkerCacheKey("document-a", lifecycle.snapshot());

    lifecycle.updateTheme("dark");
    const after = pierreWorkerCacheKey("document-a", lifecycle.snapshot());

    expect(fake.fileCache.size).toBe(0);
    expect(fake.diffCache.size).toBe(0);
    expect(fake.setRenderOptions).toHaveBeenCalledWith({
      theme: KEYDEX_DIFF_THEME_NAMES.dark,
    });
    expect(after).not.toBe(before);
    expect(after).toContain(":pierre-dark-");
    release();
    lifecycle.terminateImmediately();
  });

  it("does not resurrect a pool when loading finishes after every viewer left", async () => {
    vi.useFakeTimers();
    const fake = fakePool();
    let resolve!: (module: PierreDiffsReactModule) => void;
    const lifecycle = new PierreWorkerPoolLifecycle({
      loadModule: () => new Promise((done) => { resolve = done; }),
      releaseDelayMs: 50,
      hardwareConcurrency: 8,
    });
    const release = lifecycle.acquire("light");
    release();
    await vi.advanceTimersByTimeAsync(50);
    resolve(fake.module);
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.createPool).not.toHaveBeenCalled();
    expect(fake.terminatePool).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot()).toMatchObject({ status: "idle", references: 0 });
  });

  it("keeps diagnostics frozen and exposes no manager control surface", async () => {
    const fake = fakePool();
    const lifecycle = lifecycleFor(fake);
    const release = lifecycle.acquire("light");
    await vi.waitFor(() => expect(lifecycle.snapshot().status).toBe("ready"));
    const diagnostics = lifecycle.snapshot();
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(Object.isFrozen(diagnostics.workers)).toBe(true);
    expect(diagnostics).not.toHaveProperty("manager");
    expect(diagnostics).not.toHaveProperty("terminate");
    release();
    lifecycle.terminateImmediately();
  });
});

describe("Pierre Worker Pool application host", () => {
  it("does not remount the application subtree when the worker runtime becomes ready", async () => {
    const fake = fakePool();
    const lifecycle = lifecycleFor(fake);
    const mounts = vi.fn();

    function StableApplication() {
      useEffect(() => {
        mounts();
      }, []);
      return <Viewer name="stable" />;
    }

    render(
      <ThemeProvider>
        <PierreWorkerPoolHost lifecycle={lifecycle}>
          <StableApplication />
        </PierreWorkerPoolHost>
      </ThemeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("stable").textContent).toContain("ready:1"));
    expect(mounts).toHaveBeenCalledTimes(1);
  });

  it("provides the same manager to concurrent viewer leases and follows the app theme", async () => {
    const fake = fakePool();
    const lifecycle = lifecycleFor(fake);

    render(
      <ThemeProvider>
        <PierreWorkerPoolHost lifecycle={lifecycle}>
          <Viewer name="a" />
          <Viewer name="b" />
          <Viewer name="c" />
          <Viewer name="d" />
          <ThemeToggle />
        </PierreWorkerPoolHost>
      </ThemeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("a").textContent).toContain("ready:4"));
    expect(fake.createPool).toHaveBeenCalledTimes(1);
    await act(async () => screen.getByRole("button", { name: "切换主题" }).click());
    await waitFor(() => expect(fake.setRenderOptions).toHaveBeenCalledWith({
      theme: KEYDEX_DIFF_THEME_NAMES.dark,
    }));
    expect(screen.getByTestId("d").textContent).toContain("dark");
  });
});

function Viewer({ name }: { readonly name: string }) {
  usePierreWorkerPoolLease();
  const diagnostics = usePierreWorkerPoolDiagnostics();
  return (
    <span data-testid={name}>
      {diagnostics.status}:{diagnostics.references}:{diagnostics.theme}
    </span>
  );
}

function ThemeToggle() {
  const { toggleTheme } = useTheme();
  return <button type="button" onClick={toggleTheme}>切换主题</button>;
}

function lifecycleFor(fake: FakePool) {
  return new PierreWorkerPoolLifecycle({
    loadModule: vi.fn().mockResolvedValue(fake.module),
    releaseDelayMs: 50,
    hardwareConcurrency: 8,
  });
}

function fakePool(): FakePool {
  const fileCache = new Map<string, unknown>();
  const diffCache = new Map<string, unknown>();
  const stats: WorkerStats = {
    managerState: "initialized",
    workersFailed: false,
    totalWorkers: 4,
    busyWorkers: 0,
    queuedTasks: 0,
    activeTasks: 0,
    themeSubscribers: 0,
    fileCacheSize: 0,
    diffCacheSize: 0,
  };
  const setRenderOptions = vi.fn().mockResolvedValue(undefined);
  const manager = {
    setRenderOptions,
    getStats: vi.fn(() => stats),
    subscribeToStatChanges: vi.fn(() => vi.fn()),
    inspectCaches: vi.fn(() => ({ fileCache, diffCache })),
    evictFileFromCache: vi.fn((key: string) => fileCache.delete(key)),
    evictDiffFromCache: vi.fn((key: string) => diffCache.delete(key)),
  } as unknown as WorkerPoolManager;
  const createPool = vi.fn(() => manager);
  const terminatePool = vi.fn();
  const module = {
    WorkerPoolContext: createContext<WorkerPoolManager | undefined>(undefined),
    getOrCreateWorkerPoolSingleton: createPool,
    terminateWorkerPoolSingleton: terminatePool,
    pierreWorkerFactory: vi.fn(),
  } as unknown as PierreDiffsReactModule;
  return {
    manager,
    module,
    createPool,
    terminatePool,
    setRenderOptions,
    fileCache,
    diffCache,
  };
}
