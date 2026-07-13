import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge, WorkspaceEntry, WorkspaceTreeResponse } from "@/runtime";
import { WorkspacePanel } from "@/renderer/components/workspace";
import {
  planWorkspaceDirectoryInvalidation,
  purgeDeletedDirectoryPaths,
} from "@/renderer/components/workspace/workspaceFileInvalidation";
import {
  FileChangeProvider,
  type FileChangeTransport,
} from "@/renderer/providers/FileChangeProvider";
import type { AgentActionEnvelope, FileChangeEventItem } from "@/types/protocol";

describe("workspace file invalidation planning", () => {
  it("maps batches to loaded parent directories and deleted directory caches deterministically", () => {
    const plan = planWorkspaceDirectoryInvalidation(
      [
        { kind: "modified", path: "src/a.ts" },
        { kind: "added", path: "src/b.ts" },
        { kind: "deleted", path: "old/nested" },
        { kind: "added", path: "new/nested/item.ts" },
        { kind: "modified", path: "root.txt" },
      ],
      ["", "src", "old", "old/nested", "old/nested/deep", "new/nested"],
    );

    expect(plan).toEqual({
      directoriesToRefresh: ["", "new/nested", "old", "src"],
      deletedDirectoryPaths: ["old/nested"],
    });
    expect(
      purgeDeletedDirectoryPaths(
        { "": 0, old: 1, "old/nested": 2, "old/nested/deep": 3, src: 4 },
        plan.deletedDirectoryPaths,
      ),
    ).toEqual({ "": 0, old: 1, src: 4 });
  });
});

describe("WorkspacePanel file changes", () => {
  it("test-tree-001 单个父目录刷新", async () => {
    const fixture = createFixture({
      "": [entry("src", "src", "directory")],
      src: [entry("old.ts", "src/old.ts", "file")],
    });
    renderPanel(fixture);
    await expand("src");
    fixture.entries.src = [entry("new.ts", "src/new.ts", "file")];

    emitChanges(fixture, [{ kind: "modified", path: "src/new.ts" }]);

    expect(await screen.findByText("new.ts")).not.toBeNull();
    expect(directoryCallCount(fixture, "src")).toBe(2);
  });

  it("test-tree-002 同父目录批次去重", async () => {
    const fixture = createFixture({
      "": [entry("src", "src", "directory")],
      src: [entry("a.ts", "src/a.ts", "file")],
    });
    renderPanel(fixture);
    await expand("src");

    emitChanges(fixture, [
      { kind: "modified", path: "src/a.ts" },
      { kind: "added", path: "src/b.ts" },
    ]);

    await waitFor(() => expect(directoryCallCount(fixture, "src")).toBe(2));
  });

  it("test-tree-003 多父目录分别刷新", async () => {
    const fixture = createFixture({
      "": [entry("a", "a", "directory"), entry("b", "b", "directory")],
      a: [entry("one.ts", "a/one.ts", "file")],
      b: [entry("two.ts", "b/two.ts", "file")],
    });
    renderPanel(fixture);
    await expand("a");
    await expand("b");

    emitChanges(fixture, [
      { kind: "modified", path: "a/one.ts" },
      { kind: "modified", path: "b/two.ts" },
    ]);

    await waitFor(() => {
      expect(directoryCallCount(fixture, "a")).toBe(2);
      expect(directoryCallCount(fixture, "b")).toBe(2);
    });
  });

  it("test-tree-004 未加载父目录跳过", async () => {
    const fixture = createFixture({
      "": [entry("src", "src", "directory")],
      src: [entry("a.ts", "src/a.ts", "file")],
    });
    renderPanel(fixture);
    await screen.findByText("src");

    emitChanges(fixture, [{ kind: "modified", path: "src/a.ts" }]);

    await waitFor(() => expect(directoryCallCount(fixture, "src")).toBe(0));
  });

  it("test-tree-005 已加载折叠目录刷新", async () => {
    const fixture = createFixture({
      "": [entry("src", "src", "directory")],
      src: [entry("old.ts", "src/old.ts", "file")],
    });
    renderPanel(fixture);
    await expand("src");
    fireEvent.click(screen.getByRole("button", { name: "折叠 src" }));
    fixture.entries.src = [entry("new.ts", "src/new.ts", "file")];

    emitChanges(fixture, [{ kind: "modified", path: "src/new.ts" }]);

    await waitFor(() => expect(directoryCallCount(fixture, "src")).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "展开 src" }));
    expect(screen.getByText("new.ts")).not.toBeNull();
  });

  it("test-tree-006 删除目录清理后代缓存", async () => {
    const states: Array<Parameters<NonNullable<ComponentProps<typeof WorkspacePanel>["onStateChange"]>>[0]> = [];
    const fixture = createFixture({
      "": [entry("old", "old", "directory")],
      old: [entry("nested", "old/nested", "directory")],
      "old/nested": [entry("deep", "old/nested/deep", "directory")],
      "old/nested/deep": [entry("gone.ts", "old/nested/deep/gone.ts", "file")],
    });
    renderPanel(fixture, { onStateChange: (state) => states.push(state) });
    await expand("old");
    await expand("old/nested");
    await expand("old/nested/deep");
    fixture.entries.old = [];

    emitChanges(fixture, [{ kind: "deleted", path: "old/nested" }]);

    await waitFor(() => {
      const state = states.at(-1);
      expect(state?.entriesByPath["old/nested"]).toBeUndefined();
      expect(state?.entriesByPath["old/nested/deep"]).toBeUndefined();
      expect(state?.expandedPaths).not.toContain("old/nested");
      expect(state?.expandedPaths).not.toContain("old/nested/deep");
    });
  });

  it("test-tree-007 move 刷新旧新父目录", async () => {
    const fixture = createFixture({
      "": [entry("old", "old", "directory"), entry("next", "next", "directory")],
      old: [entry("a.ts", "old/a.ts", "file")],
      next: [],
    });
    renderPanel(fixture);
    await expand("old");
    await expand("next");

    emitChanges(fixture, [
      { kind: "deleted", path: "old/a.ts" },
      { kind: "added", path: "next/a.ts" },
    ]);

    await waitFor(() => {
      expect(directoryCallCount(fixture, "old")).toBe(2);
      expect(directoryCallCount(fixture, "next")).toBe(2);
    });
  });

  it("test-tree-008 resync 全量已加载且并发不超 4", async () => {
    const directoryNames = ["d1", "d2", "d3", "d4", "d5", "d6"];
    const fixture = createFixture({
      "": directoryNames.map((name) => entry(name, name, "directory")),
      ...Object.fromEntries(directoryNames.map((name) => [name, []])),
    });
    renderPanel(fixture);
    for (const name of directoryNames) {
      await expand(name);
    }
    const baselineCalls = fixture.listDirectory.mock.calls.length;
    const release = deferred<void>();
    let active = 0;
    let maximumActive = 0;
    fixture.listDirectory.mockImplementation(async (_scope: unknown, path = "") => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await release.promise;
      active -= 1;
      return { root: "D:/repo", entries: fixture.entries[path] ?? [] };
    });

    emitResync(fixture);

    await waitFor(() => expect(maximumActive).toBe(4));
    expect(fixture.listDirectory.mock.calls.length - baselineCalls).toBe(4);
    release.resolve(undefined);
    await waitFor(() => expect(fixture.listDirectory.mock.calls.length - baselineCalls).toBe(7));
    expect(maximumActive).toBe(4);
  });

  it("test-tree-009 旧 generation 响应丢弃", async () => {
    const fixture = createFixture({
      "": [entry("src", "src", "directory")],
      src: [entry("initial.ts", "src/initial.ts", "file")],
    });
    renderPanel(fixture);
    await expand("src");
    const older = deferred<WorkspaceTreeResponse>();
    const newer = deferred<WorkspaceTreeResponse>();
    let refreshRequest = 0;
    fixture.listDirectory.mockImplementation((_scope: unknown, path = "") => {
      if (path !== "src") {
        return Promise.resolve({ root: "D:/repo", entries: fixture.entries[path] ?? [] });
      }
      refreshRequest += 1;
      return refreshRequest === 1 ? older.promise : newer.promise;
    });

    emitChanges(fixture, [{ kind: "modified", path: "src/first.ts" }]);
    await waitFor(() => expect(refreshRequest).toBe(1));
    emitChanges(fixture, [{ kind: "modified", path: "src/second.ts" }]);
    await waitFor(() => expect(refreshRequest).toBe(2));
    await act(async () => {
      newer.resolve({ root: "D:/repo", entries: [entry("newer.ts", "src/newer.ts", "file")] });
      await newer.promise;
    });
    expect(await screen.findByText("newer.ts")).not.toBeNull();

    await act(async () => {
      older.resolve({ root: "D:/repo", entries: [entry("stale.ts", "src/stale.ts", "file")] });
      await older.promise;
    });
    expect(screen.getByText("newer.ts")).not.toBeNull();
    expect(screen.queryByText("stale.ts")).toBeNull();
  });

  it("test-tree-010 刷新保留 UI 状态", async () => {
    const states: Array<Parameters<NonNullable<ComponentProps<typeof WorkspacePanel>["onStateChange"]>>[0]> = [];
    const fixture = createFixture({
      "": [entry("src", "src", "directory")],
      src: [entry("keep.ts", "src/keep.ts", "file")],
    });
    renderPanel(fixture, { onStateChange: (state) => states.push(state) });
    await expand("src");
    fireEvent.click(await screen.findByRole("button", { name: "选择文件 src/keep.ts" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "筛选文件" }), {
      target: { value: "keep" },
    });
    const baselineCalls = fixture.listDirectory.mock.calls.length;

    emitResync(fixture);

    await waitFor(() => expect(fixture.listDirectory.mock.calls.length - baselineCalls).toBe(2));
    await waitFor(() => {
      const state = states.at(-1);
      expect(state?.selectedPath).toBe("src/keep.ts");
      expect(state?.filterQuery).toBe("keep");
      expect(state?.expandedPaths).toContain("src");
    });
  });

  it("test-tree-011 panel chrome 手动刷新", async () => {
    const fixture = createFixture({ "": [entry("a.txt", "a.txt", "file")] });
    const onManualRefresh = vi.fn();
    renderPanel(fixture, { chrome: "panel", onManualRefresh });
    await screen.findByText("a.txt");

    fireEvent.click(screen.getByRole("button", { name: "刷新工作区" }));

    await waitFor(() => expect(directoryCallCount(fixture, "")).toBe(2));
    expect(onManualRefresh).toHaveBeenCalledTimes(1);
  });

  it("test-tree-012 根路径事件刷新根目录", async () => {
    const fixture = createFixture({ "": [entry("old.txt", "old.txt", "file")] });
    renderPanel(fixture);
    await screen.findByText("old.txt");
    fixture.entries[""] = [entry("new.txt", "new.txt", "file")];

    emitChanges(fixture, [{ kind: "added", path: "new.txt" }]);

    expect(await screen.findByText("new.txt")).not.toBeNull();
    expect(directoryCallCount(fixture, "")).toBe(2);
  });
});

interface Fixture {
  entries: Record<string, WorkspaceEntry[]>;
  runtime: RuntimeBridge;
  listDirectory: ReturnType<typeof vi.fn>;
  transport: FileChangeTransport & { emit(event: AgentActionEnvelope): void };
  sequence: number;
}

function createFixture(entries: Record<string, WorkspaceEntry[]>): Fixture {
  const listeners = new Set<(event: AgentActionEnvelope) => void>();
  const listDirectory = vi.fn((_scope: unknown, path = ""): Promise<WorkspaceTreeResponse> => {
    const current = entries[path];
    return current
      ? Promise.resolve({ root: "D:/repo", entries: current })
      : Promise.reject(new Error(`目录不存在：${path}`));
  });
  return {
    entries,
    listDirectory,
    runtime: {
      workspace: {
        listDirectory,
        listDirectorySubtree: vi.fn(),
        readFile: vi.fn(),
        search: vi.fn().mockResolvedValue([]),
      },
    } as unknown as RuntimeBridge,
    sequence: 0,
    transport: {
      bindWorkspaceWatch: vi.fn(),
      unbindWorkspaceWatch: vi.fn(),
      bindLocalFileWatch: vi.fn(),
      unbindLocalFileWatch: vi.fn(),
      subscribeEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit(event) {
        listeners.forEach((listener) => listener(event));
      },
    },
  };
}

function renderPanel(
  fixture: Fixture,
  props: Partial<ComponentProps<typeof WorkspacePanel>> = {},
) {
  return render(
    <FileChangeProvider transport={fixture.transport}>
      <WorkspacePanel runtime={fixture.runtime} workspaceId="ws-1" {...props} />
    </FileChangeProvider>,
  );
}

async function expand(path: string) {
  fireEvent.click(await screen.findByRole("button", { name: `展开 ${path.split("/").at(-1)}` }));
  await waitFor(() => expect(screen.getByRole("button", { name: `折叠 ${path.split("/").at(-1)}` })).not.toBeNull());
}

function emitChanges(fixture: Fixture, changes: FileChangeEventItem[]) {
  fixture.sequence += 1;
  act(() => {
    fixture.transport.emit({
      action: "workspaceFilesChanged",
      data: {
        workspace_id: "ws-1",
        sequence: fixture.sequence,
        resync_required: false,
        changes,
      },
    } as unknown as AgentActionEnvelope);
  });
}

function emitResync(fixture: Fixture) {
  fixture.sequence += 1;
  act(() => {
    fixture.transport.emit({
      action: "workspaceFilesChanged",
      data: {
        workspace_id: "ws-1",
        sequence: fixture.sequence,
        resync_required: true,
        changes: [],
      },
    } as unknown as AgentActionEnvelope);
  });
}

function directoryCallCount(fixture: Fixture, path: string): number {
  return fixture.listDirectory.mock.calls.filter((call) => (call[1] ?? "") === path).length;
}

function entry(name: string, path: string, type: WorkspaceEntry["type"]): WorkspaceEntry {
  return { name, path, type, size: null, modified_at: null };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}
