import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DocumentReadResult, RuntimeBridge, WorkspaceSearchResult } from "@/runtime";
import { FilePreview } from "@/renderer/components/workspace/FilePreview";
import { WorkspacePanel } from "@/renderer/components/workspace";
import {
  FileChangeProvider,
  type FileChangeTransport,
  useWorkspaceFileWatchScope,
} from "@/renderer/providers/FileChangeProvider";
import type { AgentActionEnvelope, FileChangeEventItem } from "@/types/protocol";

describe("workspace search invalidation", () => {
  it("test-scope-001 活跃搜索随事件重查", async () => {
    const fixture = createFixture();
    fixture.search
      .mockResolvedValueOnce([result("old.txt")])
      .mockResolvedValueOnce([result("new.txt")]);
    renderPanel(fixture);
    await startSearch("target");
    expect(await searchResultButton("old.txt")).not.toBeNull();

    await emitWorkspace(fixture, "ws-1", [{ kind: "modified", path: "src/a.ts" }]);
    await flushSearchDebounce();

    expect(await searchResultButton("new.txt")).not.toBeNull();
    expect(fixture.search).toHaveBeenCalledTimes(2);
  });

  it("test-scope-002 搜索事件风暴防抖", async () => {
    const fixture = createFixture();
    fixture.search.mockResolvedValue([result("target.txt")]);
    renderPanel(fixture);
    await startSearch("target");
    await searchResultButton("target.txt");

    await emitWorkspace(fixture, "ws-1", [{ kind: "modified", path: "a.ts" }]);
    await emitWorkspace(fixture, "ws-1", [{ kind: "modified", path: "b.ts" }]);
    await emitWorkspace(fixture, "ws-1", [{ kind: "modified", path: "c.ts" }]);
    await flushSearchDebounce();

    await waitFor(() => expect(fixture.search).toHaveBeenCalledTimes(2), { timeout: 1500 });
  });

  it("test-scope-003 搜索竞态丢弃旧结果", async () => {
    const fixture = createFixture();
    const older = deferred<WorkspaceSearchResult[]>();
    const newer = deferred<WorkspaceSearchResult[]>();
    fixture.search
      .mockResolvedValueOnce([result("initial.txt")])
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    renderPanel(fixture);
    await startSearch("target");
    await searchResultButton("initial.txt");

    await emitWorkspace(fixture, "ws-1", [{ kind: "modified", path: "a.ts" }]);
    await flushSearchDebounce();
    await waitFor(() => expect(fixture.search).toHaveBeenCalledTimes(2), { timeout: 1500 });
    await emitWorkspace(fixture, "ws-1", [{ kind: "modified", path: "b.ts" }]);
    await flushSearchDebounce();
    await waitFor(() => expect(fixture.search).toHaveBeenCalledTimes(3), { timeout: 1500 });
    newer.resolve([result("newest.txt")]);
    expect(await searchResultButton("newest.txt")).not.toBeNull();
    older.resolve([result("stale.txt")]);

    await waitFor(() => expect(screen.queryByRole("button", { name: "选择文件 stale.txt" })).toBeNull());
    expect(screen.getByRole("button", { name: "选择文件 newest.txt" })).not.toBeNull();
  });

  it("test-scope-004 空查询不自动搜索", async () => {
    const fixture = createFixture();
    renderPanel(fixture);
    await screen.findByRole("tree", { name: "工作区目录" });

    await emitWorkspace(fixture, "ws-1", [{ kind: "modified", path: "a.ts" }]);

    await flushSearchDebounce();
    expect(fixture.search).not.toHaveBeenCalled();
  });

  it("test-scope-005 其他 workspace 不重查", async () => {
    const fixture = createFixture();
    fixture.search.mockResolvedValue([result("target.txt")]);
    renderPanel(fixture);
    await startSearch("target");
    await searchResultButton("target.txt");

    await emitWorkspace(fixture, "ws-2", [{ kind: "modified", path: "a.ts" }]);

    await flushSearchDebounce();
    expect(fixture.search).toHaveBeenCalledTimes(1);
  });

  it("test-scope-006 resync 与手动刷新重查搜索", async () => {
    const fixture = createFixture();
    fixture.search.mockResolvedValue([result("target.txt")]);
    renderPanel(fixture);
    await startSearch("target");
    await searchResultButton("target.txt");

    await emitWorkspace(fixture, "ws-1", [], true);
    await flushSearchDebounce();
    await waitFor(() => expect(fixture.search).toHaveBeenCalledTimes(2), { timeout: 1500 });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => expect(fixture.search).toHaveBeenCalledTimes(3));
  });
});

describe("workspace surface watch scopes", () => {
  it("test-scope-007 Home 直接绑定 workspace", () => {
    const fixture = createFixture();
    renderScopes(fixture, <ScopeConsumer workspaceId="home-ws" />);

    expect(fixture.transport.bindWorkspaceWatch).toHaveBeenCalledWith("home-ws");
  });

  it("test-scope-008 Workbench 无 session 绑定", () => {
    const fixture = createFixture();
    renderScopes(fixture, <ScopeConsumer workspaceId="workbench-ws" />);

    expect(fixture.transport.bindWorkspaceWatch).toHaveBeenCalledWith("workbench-ws");
    expect(fixture.transport.bindWorkspaceWatch).toHaveBeenCalledTimes(1);
  });

  it("test-scope-009 Conversation 同连接双 scope", () => {
    const fixture = createFixture();
    renderScopes(fixture, <ScopeConsumer workspaceId="conversation-ws" />);

    expect(fixture.transport.bindWorkspaceWatch).toHaveBeenCalledWith("conversation-ws");
    expect(fixture.transport.subscribeEvent).toHaveBeenCalledTimes(1);
  });

  it("test-scope-010 workspace 切换解绑重绑", () => {
    const fixture = createFixture();
    const view = renderScopes(fixture, <ScopeConsumer workspaceId="ws-a" />);
    expect(fixture.transport.bindWorkspaceWatch).toHaveBeenCalledWith("ws-a");

    view.rerender(wrapScopes(fixture, <ScopeConsumer workspaceId="ws-b" />));

    expect(fixture.transport.unbindWorkspaceWatch).toHaveBeenCalledWith("ws-a");
    expect(fixture.transport.bindWorkspaceWatch).toHaveBeenCalledWith("ws-b");
  });

  it("test-scope-011 多页面共享订阅", () => {
    const fixture = createFixture();
    const view = renderScopes(
      fixture,
      <>
        <ScopeConsumer key="one" workspaceId="shared-ws" />
        <ScopeConsumer key="two" workspaceId="shared-ws" />
      </>,
    );
    expect(fixture.transport.bindWorkspaceWatch).toHaveBeenCalledTimes(1);

    view.rerender(wrapScopes(fixture, <ScopeConsumer key="one" workspaceId="shared-ws" />));
    expect(fixture.transport.unbindWorkspaceWatch).not.toHaveBeenCalled();
    view.unmount();

    expect(fixture.transport.unbindWorkspaceWatch).toHaveBeenCalledWith("shared-ws");
    expect(fixture.transport.unbindWorkspaceWatch).toHaveBeenCalledTimes(1);
  });
});

describe("local file watch scope", () => {
  it("test-scope-012 当前 local-file 修改自动重载", async () => {
    const fixture = createFixture();
    fixture.readLocalDocument
      .mockResolvedValueOnce(localSnapshot("D:/notes/a.txt", "before", "r1"))
      .mockResolvedValueOnce(localSnapshot("D:/notes/a.txt", "after", "r2"));
    renderScopes(
      fixture,
      <FilePreview request={{ type: "local-file", path: "D:/notes/a.txt" }} runtime={fixture.runtime} />,
    );
    await screen.findByText("before");
    const watchId = localWatchId(fixture);

    await emitLocal(fixture, watchId, "D:/notes/a.txt", [{ kind: "modified", path: "D:/notes/a.txt" }]);

    expect(await screen.findByText("after")).not.toBeNull();
    expect(fixture.readLocalDocument).toHaveBeenCalledTimes(2);
  });

  it("test-scope-013 sibling local-file 不重载", async () => {
    const fixture = createFixture();
    fixture.readLocalDocument.mockResolvedValue(localSnapshot("D:/notes/a.txt", "before", "r1"));
    renderScopes(
      fixture,
      <FilePreview request={{ type: "local-file", path: "D:/notes/a.txt" }} runtime={fixture.runtime} />,
    );
    await screen.findByText("before");

    await emitLocal(fixture, "sibling-watch", "D:/notes/b.txt", [
      { kind: "modified", path: "D:/notes/b.txt" },
    ]);

    expect(fixture.readLocalDocument).toHaveBeenCalledTimes(1);
  });

  it("test-scope-014 local-file 生命周期解绑", async () => {
    const fixture = createFixture();
    fixture.readLocalDocument.mockResolvedValue(localSnapshot("D:/notes/a.txt", "before", "r1"));
    const view = renderScopes(
      fixture,
      <FilePreview request={{ type: "local-file", path: "D:/notes/a.txt" }} runtime={fixture.runtime} />,
    );
    await screen.findByText("before");
    const watchId = localWatchId(fixture);

    view.unmount();

    expect(fixture.transport.unbindLocalFileWatch).toHaveBeenCalledWith(watchId);
    expect(fixture.transport.unbindLocalFileWatch).toHaveBeenCalledTimes(1);
  });

  it("test-scope-015 local-file 删除重建恢复", async () => {
    const fixture = createFixture();
    fixture.readLocalDocument
      .mockResolvedValueOnce(localSnapshot("D:/notes/a.txt", "old copy", "r1"))
      .mockResolvedValueOnce(localSnapshot("D:/notes/a.txt", "rebuilt", "r2"));
    renderScopes(
      fixture,
      <FilePreview request={{ type: "local-file", path: "D:/notes/a.txt" }} runtime={fixture.runtime} />,
    );
    await screen.findByText("old copy");
    const watchId = localWatchId(fixture);
    await emitLocal(fixture, watchId, "D:/notes/a.txt", [{ kind: "deleted", path: "D:/notes/a.txt" }]);
    expect((await screen.findByRole("alert")).textContent).toContain("文件已删除");

    await emitLocal(fixture, watchId, "D:/notes/a.txt", [{ kind: "added", path: "D:/notes/a.txt" }]);

    expect(await screen.findByText("rebuilt")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

interface Fixture {
  runtime: RuntimeBridge;
  search: ReturnType<typeof vi.fn>;
  readLocalDocument: ReturnType<typeof vi.fn>;
  transport: FileChangeTransport & { emit(event: AgentActionEnvelope): void };
  sequences: Map<string, number>;
}

function createFixture(): Fixture {
  const listeners = new Set<(event: AgentActionEnvelope) => void>();
  const search = vi.fn();
  const readLocalDocument = vi.fn();
  return {
    readLocalDocument,
    search,
    sequences: new Map(),
    runtime: {
      localPreview: {
        readFile: vi.fn(),
        readDocument: readLocalDocument,
        readMedia: vi.fn(),
        releaseDocumentConsumer: vi.fn(),
      },
      workspace: {
        listDirectory: vi.fn().mockResolvedValue({ root: "D:/repo", entries: [] }),
        listDirectorySubtree: vi.fn(),
        readFile: vi.fn(),
        search,
      },
    } as unknown as RuntimeBridge,
    transport: {
      bindWorkspaceWatch: vi.fn(),
      unbindWorkspaceWatch: vi.fn(),
      bindLocalFileWatch: vi.fn(),
      unbindLocalFileWatch: vi.fn(),
      subscribeEvent: vi.fn((listener: (event: AgentActionEnvelope) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      emit(event) {
        listeners.forEach((listener) => listener(event));
      },
    },
  };
}

function renderPanel(fixture: Fixture) {
  return render(
    <FileChangeProvider transport={fixture.transport}>
      <WorkspacePanel runtime={fixture.runtime} workspaceId="ws-1" />
    </FileChangeProvider>,
  );
}

function ScopeConsumer({ workspaceId }: { workspaceId: string }) {
  useWorkspaceFileWatchScope(workspaceId);
  return <span>{workspaceId}</span>;
}

function renderScopes(fixture: Fixture, children: ReactNode) {
  return render(wrapScopes(fixture, children));
}

function wrapScopes(fixture: Fixture, children: ReactNode) {
  return <FileChangeProvider transport={fixture.transport}>{children}</FileChangeProvider>;
}

async function startSearch(query: string) {
  const input = await screen.findByRole("searchbox", { name: "筛选文件" });
  await act(async () => {
    fireEvent.change(input, { target: { value: query } });
    await Promise.resolve();
  });
}

async function emitWorkspace(
  fixture: Fixture,
  workspaceId: string,
  changes: FileChangeEventItem[],
  resyncRequired = false,
) {
  const sequence = (fixture.sequences.get(workspaceId) ?? 0) + 1;
  fixture.sequences.set(workspaceId, sequence);
  await act(async () => {
    fixture.transport.emit({
      action: "workspaceFilesChanged",
      data: {
        workspace_id: workspaceId,
        sequence,
        resync_required: resyncRequired,
        changes,
      },
    } as unknown as AgentActionEnvelope);
    await Promise.resolve();
  });
}

async function emitLocal(
  fixture: Fixture,
  watchId: string,
  path: string,
  changes: FileChangeEventItem[],
) {
  const sequenceKey = `local:${watchId}`;
  const sequence = (fixture.sequences.get(sequenceKey) ?? 0) + 1;
  fixture.sequences.set(sequenceKey, sequence);
  await act(async () => {
    fixture.transport.emit({
      action: "localFileChanged",
      data: {
        watch_id: watchId,
        path,
        sequence,
        resync_required: false,
        changes,
      },
    } as unknown as AgentActionEnvelope);
    await Promise.resolve();
  });
}

function result(path: string): WorkspaceSearchResult {
  return { path, name: path.split("/").at(-1) ?? path, type: "file", size: 1 };
}

function localWatchId(fixture: Fixture): string {
  const watchId = vi.mocked(fixture.transport.bindLocalFileWatch).mock.calls[0]?.[0];
  if (typeof watchId !== "string") {
    throw new Error("local watch was not bound");
  }
  return watchId;
}

function localSnapshot(path: string, content: string, revision: string): DocumentReadResult {
  return {
    document_id: `local:${path}`,
    source: "local-preview",
    path,
    revision,
    encoding: "utf-8",
    total_bytes: new TextEncoder().encode(content).byteLength,
    content,
  };
}

function searchResultButton(path: string) {
  return screen.findByRole("button", { name: `选择文件 ${path}` });
}

async function flushSearchDebounce() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 300));
  });
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
