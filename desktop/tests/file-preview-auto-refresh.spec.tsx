import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DocumentReadResult, RuntimeBridge, WorkspaceMediaResponse } from "@/runtime";
import { FilePreview } from "@/renderer/components/workspace/FilePreview";
import {
  FileChangeProvider,
  type FileChangeTransport,
} from "@/renderer/providers/FileChangeProvider";
import type { AgentActionEnvelope, FileChangeEventItem } from "@/types/protocol";

describe("FilePreview auto refresh", () => {
  it("test-preview-001 当前文本修改自动重载", async () => {
    const fixture = createFixture();
    fixture.readDocument
      .mockResolvedValueOnce(snapshot("notes.txt", "before", "r1"))
      .mockResolvedValueOnce(snapshot("notes.txt", "after", "r2"));
    renderPreview(fixture, <FilePreview request={{ type: "file", path: "notes.txt" }} runtime={fixture.runtime} workspaceId="ws-1" />);
    expect(await screen.findByText("before")).not.toBeNull();

    emitChanges(fixture, [{ kind: "modified", path: "notes.txt" }]);

    expect(await screen.findByText("after")).not.toBeNull();
    expect(fixture.readDocument).toHaveBeenCalledTimes(2);
  });

  it("test-preview-002 无关文件不重载", async () => {
    const fixture = createFixture();
    fixture.readDocument.mockResolvedValue(snapshot("notes.txt", "before", "r1"));
    renderPreview(fixture, <FilePreview request={{ type: "file", path: "notes.txt" }} runtime={fixture.runtime} workspaceId="ws-1" />);
    await screen.findByText("before");

    emitChanges(fixture, [{ kind: "modified", path: "other.txt" }]);

    await waitFor(() => expect(fixture.readDocument).toHaveBeenCalledTimes(1));
  });

  it("test-preview-003 pending 保留旧内容", async () => {
    const fixture = createFixture();
    const pending = deferred<DocumentReadResult>();
    fixture.readDocument
      .mockResolvedValueOnce(snapshot("notes.txt", "before", "r1"))
      .mockReturnValueOnce(pending.promise);
    renderPreview(fixture, <FilePreview request={{ type: "file", path: "notes.txt" }} runtime={fixture.runtime} workspaceId="ws-1" />);
    await screen.findByText("before");

    emitChanges(fixture, [{ kind: "modified", path: "notes.txt" }]);

    expect((await screen.findByRole("status")).textContent).toContain("仍显示上次内容");
    expect(screen.getByText("before")).not.toBeNull();
    pending.resolve(snapshot("notes.txt", "after", "r2"));
    expect(await screen.findByText("after")).not.toBeNull();
  });

  it("test-preview-004 revision 与 runtime 原子更新", async () => {
    const fixture = createFixture();
    const pending = deferred<DocumentReadResult>();
    fixture.readDocument
      .mockResolvedValueOnce(snapshot("notes.txt", "before", "r1"))
      .mockReturnValueOnce(pending.promise);
    renderPreview(fixture, <FilePreview request={{ type: "file", path: "notes.txt" }} runtime={fixture.runtime} workspaceId="ws-1" />);
    await screen.findByText("before");
    const root = previewRoot();
    expect(root.getAttribute("data-document-revision")).toBe("r1");

    emitChanges(fixture, [{ kind: "modified", path: "notes.txt" }]);
    expect(root.getAttribute("data-document-revision")).toBe("r1");
    expect(screen.getByText("before")).not.toBeNull();
    pending.resolve(snapshot("notes.txt", "after", "r2"));

    expect(await screen.findByText("after")).not.toBeNull();
    expect(root.getAttribute("data-document-revision")).toBe("r2");
    expect(screen.queryByText("before")).toBeNull();
  });

  it("test-preview-005 旧读取结果丢弃", async () => {
    const fixture = createFixture();
    const first = deferred<DocumentReadResult>();
    const second = deferred<DocumentReadResult>();
    fixture.readDocument
      .mockResolvedValueOnce(snapshot("notes.txt", "initial", "r0"))
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderPreview(fixture, <FilePreview request={{ type: "file", path: "notes.txt" }} runtime={fixture.runtime} workspaceId="ws-1" />);
    await screen.findByText("initial");

    emitChanges(fixture, [{ kind: "modified", path: "notes.txt" }]);
    await waitFor(() => expect(fixture.readDocument).toHaveBeenCalledTimes(2));
    emitChanges(fixture, [{ kind: "modified", path: "notes.txt" }]);
    await waitFor(() => expect(fixture.readDocument).toHaveBeenCalledTimes(3));
    second.resolve(snapshot("notes.txt", "newest", "r2"));
    expect(await screen.findByText("newest")).not.toBeNull();
    first.resolve(snapshot("notes.txt", "stale", "r1"));

    await waitFor(() => expect(screen.queryByText("stale")).toBeNull());
    expect(screen.getByText("newest")).not.toBeNull();
    expect(previewRoot().getAttribute("data-document-revision")).toBe("r2");
  });

  it("test-preview-006 刷新保留预览交互状态", async () => {
    const fixture = createFixture();
    fixture.readDocument
      .mockResolvedValueOnce(snapshot("guide.md", "# Before\nneedle", "r1"))
      .mockResolvedValueOnce(snapshot("guide.md", "# After\nneedle", "r2"));
    renderPreview(fixture, <FilePreview request={{ type: "file", path: "guide.md" }} runtime={fixture.runtime} workspaceId="ws-1" />);
    await screen.findByRole("heading", { name: "Before" });
    fireEvent.click(screen.getByRole("button", { name: "搜索文件内容" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索文件内容" }), {
      target: { value: "missing" },
    });
    const viewport = screen.getByLabelText("预览内容");
    viewport.scrollTop = 120;

    emitChanges(fixture, [{ kind: "modified", path: "guide.md" }]);

    await waitFor(() => expect(previewRoot().getAttribute("data-document-revision")).toBe("r2"));
    expect(screen.getByRole("button", { name: "预览" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("textbox", { name: "搜索文件内容" }) as HTMLInputElement).value).toBe("missing");
    await waitFor(() => expect(screen.getByLabelText("预览内容").scrollTop).toBe(120));
  });

  it("test-preview-007 当前文件删除状态", async () => {
    const fixture = createFixture();
    fixture.readDocument.mockResolvedValue(snapshot("notes.txt", "last known", "r1"));
    renderPreview(fixture, <FilePreview request={{ type: "file", path: "notes.txt" }} runtime={fixture.runtime} workspaceId="ws-1" />);
    await screen.findByText("last known");

    emitChanges(fixture, [{ kind: "deleted", path: "notes.txt" }]);

    expect((await screen.findByRole("alert")).textContent).toContain("文件已删除");
    expect(screen.getByText("last known")).not.toBeNull();
    expect(previewRoot().getAttribute("data-file-preview-unavailable")).toBe("true");
  });

  it("test-preview-008 删除后禁止新建批注", async () => {
    const fixture = createFixture({ annotations: true });
    fixture.readDocument.mockResolvedValue(snapshot("notes.md", "# Keep", "r1"));
    renderPreview(fixture, <FilePreview request={{ type: "file", path: "notes.md" }} runtime={fixture.runtime} workspaceId="ws-1" />);
    await screen.findByRole("heading", { name: "Keep" });
    fireEvent.click(await screen.findByLabelText("文件批注 0"));
    const createDocumentButton = await screen.findByRole("button", { name: "新增文档批注" });
    expect((createDocumentButton as HTMLButtonElement).disabled).toBe(false);

    emitChanges(fixture, [{ kind: "deleted", path: "notes.md" }]);

    await waitFor(() => {
      expect((createDocumentButton as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("test-preview-009 同路径重建自动恢复", async () => {
    const fixture = createFixture();
    fixture.readDocument
      .mockResolvedValueOnce(snapshot("notes.txt", "old", "r1"))
      .mockResolvedValueOnce(snapshot("notes.txt", "rebuilt", "r2"));
    renderPreview(fixture, <FilePreview request={{ type: "file", path: "notes.txt" }} runtime={fixture.runtime} workspaceId="ws-1" />);
    await screen.findByText("old");
    emitChanges(fixture, [{ kind: "deleted", path: "notes.txt" }]);
    await screen.findByRole("alert");

    emitChanges(fixture, [{ kind: "added", path: "notes.txt" }]);

    expect(await screen.findByText("rebuilt")).not.toBeNull();
    expect(previewRoot().getAttribute("data-file-preview-unavailable")).toBe("false");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("test-preview-010 重载失败保留旧内容", async () => {
    const fixture = createFixture();
    fixture.readDocument
      .mockResolvedValueOnce(snapshot("notes.txt", "safe copy", "r1"))
      .mockRejectedValueOnce(new Error("disk busy"));
    renderPreview(fixture, <FilePreview request={{ type: "file", path: "notes.txt" }} runtime={fixture.runtime} workspaceId="ws-1" />);
    await screen.findByText("safe copy");

    emitChanges(fixture, [{ kind: "modified", path: "notes.txt" }]);

    expect((await screen.findByRole("alert")).textContent).toContain("刷新失败");
    expect(screen.getByText("safe copy")).not.toBeNull();
    expect(previewRoot().getAttribute("data-document-revision")).toBe("r1");
  });

  it("test-preview-011 当前图片修改自动更新", async () => {
    const fixture = createFixture();
    fixture.readMedia
      .mockResolvedValueOnce(media("image.png", "data:image/png;base64,old"))
      .mockResolvedValueOnce(media("image.png", "data:image/png;base64,new"));
    renderPreview(fixture, <FilePreview request={{ type: "file", path: "image.png" }} runtime={fixture.runtime} workspaceId="ws-1" />);
    const image = await screen.findByRole("img", { name: "image.png" });
    expect(image.getAttribute("src")).toContain("old");

    emitChanges(fixture, [{ kind: "modified", path: "image.png" }]);

    await waitFor(() => expect(image.getAttribute("src")).toContain("new"));
    expect(fixture.readMedia).toHaveBeenCalledTimes(2);
  });

  it("test-preview-012 无关图片不更新", async () => {
    const fixture = createFixture();
    fixture.readMedia.mockResolvedValue(media("image.png", "data:image/png;base64,old"));
    renderPreview(fixture, <FilePreview request={{ type: "file", path: "image.png" }} runtime={fixture.runtime} workspaceId="ws-1" />);
    await screen.findByRole("img", { name: "image.png" });

    emitChanges(fixture, [{ kind: "modified", path: "other.png" }]);

    await waitFor(() => expect(fixture.readMedia).toHaveBeenCalledTimes(1));
  });

  it("test-preview-013 手动刷新当前预览", async () => {
    const fixture = createFixture();
    fixture.readDocument
      .mockResolvedValueOnce(snapshot("notes.txt", "before", "r1"))
      .mockResolvedValueOnce(snapshot("notes.txt", "manual", "r2"));
    const view = renderPreview(
      fixture,
      <FilePreview refreshRequestId={0} request={{ type: "file", path: "notes.txt" }} runtime={fixture.runtime} workspaceId="ws-1" />,
    );
    await screen.findByText("before");

    view.rerender(wrap(fixture, <FilePreview refreshRequestId={1} request={{ type: "file", path: "notes.txt" }} runtime={fixture.runtime} workspaceId="ws-1" />));

    expect(await screen.findByText("manual")).not.toBeNull();
    expect(fixture.readDocument).toHaveBeenCalledTimes(2);
  });

  it("test-preview-014 同文件复用与自动失效回归", async () => {
    const fixture = createFixture();
    fixture.readDocument
      .mockResolvedValueOnce(snapshot("guide.md", "# First", "r1"))
      .mockResolvedValueOnce(snapshot("guide.md", "# Changed", "r2"));
    const view = renderPreview(
      fixture,
      <FilePreview request={{ type: "file", path: "guide.md" }} runtime={fixture.runtime} workspaceId="ws-1" />,
    );
    await screen.findByRole("heading", { name: "First" });

    view.rerender(wrap(fixture, <FilePreview request={{ type: "file", path: "guide.md" }} runtime={fixture.runtime} workspaceId="ws-1" />));
    expect(fixture.readDocument).toHaveBeenCalledTimes(1);
    emitChanges(fixture, [{ kind: "modified", path: "guide.md" }]);

    expect(await screen.findByRole("heading", { name: "Changed" })).not.toBeNull();
    expect(fixture.readDocument).toHaveBeenCalledTimes(2);
  });
});

interface Fixture {
  runtime: RuntimeBridge;
  readDocument: ReturnType<typeof vi.fn>;
  readMedia: ReturnType<typeof vi.fn>;
  transport: FileChangeTransport & { emit(event: AgentActionEnvelope): void };
  sequence: number;
}

function createFixture({ annotations = false }: { annotations?: boolean } = {}): Fixture {
  const listeners = new Set<(event: AgentActionEnvelope) => void>();
  const readDocument = vi.fn();
  const readMedia = vi.fn();
  const runtime = {
    workspace: {
      readFile: vi.fn(),
      readDocument,
      readMedia,
    },
    ...(annotations ? {
      annotations: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        updateBody: vi.fn(),
        replaceTarget: vi.fn(),
        delete: vi.fn(),
      },
    } : {}),
  } as unknown as RuntimeBridge;
  return {
    readDocument,
    readMedia,
    runtime,
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

function renderPreview(fixture: Fixture, preview: ReactElement) {
  return render(wrap(fixture, preview));
}

function wrap(fixture: Fixture, preview: ReactElement) {
  return <FileChangeProvider transport={fixture.transport}>{preview}</FileChangeProvider>;
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

function snapshot(path: string, content: string, revision: string): DocumentReadResult {
  return {
    document_id: `workspace:ws-1:${path}`,
    source: "workspace",
    path,
    revision,
    encoding: "utf-8",
    total_bytes: new TextEncoder().encode(content).byteLength,
    content,
  };
}

function media(path: string, dataUrl: string): WorkspaceMediaResponse {
  return { path, data_url: dataUrl, media_type: "image/png", size: dataUrl.length };
}

function previewRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>("[data-file-preview-root='true']");
  if (!root) {
    throw new Error("FilePreview root not found");
  }
  return root;
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
