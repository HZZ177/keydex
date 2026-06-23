import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { SendBox } from "@/renderer/components/chat/SendBox";
import { getAtQuery, removeAtQuery, replaceAtQuery } from "@/renderer/components/chat/AtFileMenu";
import type { WorkspaceSearchResult } from "@/runtime";

describe("AtFileMenu", () => {
  it("parses and replaces file mention queries", () => {
    const result: WorkspaceSearchResult = { path: "src/main.ts", name: "main.ts", type: "file" };

    expect(getAtQuery("@")).toBe("");
    expect(getAtQuery("请看 @mai")).toBe("mai");
    expect(getAtQuery("没有引用")).toBeNull();
    expect(replaceAtQuery("请看 @mai", result)).toBe("请看 @src/main.ts ");
    expect(removeAtQuery("请看 @mai")).toBe("请看");
  });

  it("searches workspace and adds selected file references outside the text", async () => {
    const onChange = vi.fn();
    const onSearchWorkspace = vi.fn().mockResolvedValue([
      { path: "src/main.ts", name: "main.ts", type: "file" },
      { path: "src/utils.ts", name: "utils.ts", type: "file" },
    ]);

    render(
      <SendBox
        value="@ma"
        runtimeState="idle"
        canSend
        canStop={false}
        onChange={onChange}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onSearchWorkspace={onSearchWorkspace}
      />,
    );

    await screen.findByText("main.ts");
    expectWorkspaceSearch(onSearchWorkspace, "ma");

    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("src/main.ts");
    fireEvent.click(screen.getByRole("button", { name: "移除文件引用 src/main.ts" }));
    expect(screen.queryByLabelText("移除文件引用 src/main.ts")).toBeNull();
  });

  it("loads workspace file candidates for a bare at trigger", async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const onSearchWorkspace = vi.fn().mockResolvedValue([
      { path: "src", name: "src", type: "directory" },
      { path: "README.md", name: "README.md", type: "file" },
    ]);

    try {
      render(
        <SendBox
          value="@"
          runtimeState="idle"
          canSend
          canStop={false}
          onChange={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
          onSearchWorkspace={onSearchWorkspace}
        />,
      );

      expect(await screen.findByRole("option", { name: /README\.md/ })).not.toBeNull();
      expectWorkspaceSearch(onSearchWorkspace, "");
      expect(screen.queryByText("继续输入文件名")).toBeNull();

      scrollIntoView.mockClear();
      fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "ArrowDown" });
      expect(scrollIntoView).toHaveBeenCalled();
    } finally {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    }
  });

  it("opens directories from the at menu and only inserts files", async () => {
    const onChange = vi.fn();
    const onListWorkspaceDirectory = vi.fn((path: string) =>
      Promise.resolve(
        path === "src"
          ? [{ path: "src/main.ts", name: "main.ts", type: "file" as const }]
          : [
              { path: "src", name: "src", type: "directory" as const },
              { path: "README.md", name: "README.md", type: "file" as const },
            ],
      ),
    );

    render(
      <SendBox
        value="@"
        runtimeState="idle"
        canSend
        canStop={false}
        onChange={onChange}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onListWorkspaceDirectory={onListWorkspaceDirectory}
      />,
    );

    const input = screen.getByLabelText("继续输入");
    expect(await screen.findByRole("option", { name: "打开目录 src" })).not.toBeNull();

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await waitFor(() => {
      expect(onListWorkspaceDirectory).toHaveBeenCalledWith("src");
    });
    expect(await screen.findByRole("option", { name: "选择文件 src/main.ts" })).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("src/main.ts");
  });

  it("shows real workspace search errors", async () => {
    render(
      <SendBox
        value="@main"
        runtimeState="idle"
        canSend
        canStop={false}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onSearchWorkspace={vi.fn().mockRejectedValue(new Error("工作区搜索失败：HTTP 403"))}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("工作区搜索失败：HTTP 403")).not.toBeNull();
    });
  });

  it("returns from search mode to the root file tree when the query is deleted back to bare at", async () => {
    const onListWorkspaceDirectory = vi.fn((path: string) =>
      Promise.resolve(
        path
          ? []
          : [
              { path: "README.md", name: "README.md", type: "file" as const },
              { path: "src", name: "src", type: "directory" as const },
            ],
      ),
    );
    const onSearchWorkspace = vi.fn().mockResolvedValue([
      { path: "src/main.ts", name: "main.ts", type: "file" as const },
    ]);

    render(
      <StatefulSendBox
        initialValue="@"
        onListWorkspaceDirectory={onListWorkspaceDirectory}
        onSearchWorkspace={onSearchWorkspace}
      />,
    );

    const input = screen.getByLabelText("继续输入");
    expect(await screen.findByRole("option", { name: "选择文件 README.md" })).not.toBeNull();
    expect(onListWorkspaceDirectory).toHaveBeenCalledWith("");

    input.textContent = "@m";
    fireEvent.input(input);
    await waitFor(() => {
      expectWorkspaceSearch(onSearchWorkspace, "m");
    });
    expect(await screen.findByRole("option", { name: "选择文件 src/main.ts" })).not.toBeNull();

    input.textContent = "@ma";
    fireEvent.input(input);
    await waitFor(() => {
      expectWorkspaceSearch(onSearchWorkspace, "ma");
    });
    expect(await screen.findByRole("option", { name: "选择文件 src/main.ts" })).not.toBeNull();

    input.textContent = "@";
    fireEvent.input(input);
    await waitFor(() => {
      expect(onListWorkspaceDirectory).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByRole("option", { name: "选择文件 README.md" })).not.toBeNull();
  });

  it("cancels stale workspace searches when the file mention query changes", async () => {
    const pending = new Map<string, Deferred<WorkspaceSearchResult[]>>();
    const onSearchWorkspace = vi.fn((query: string, _options?: { signal?: AbortSignal }) => {
      const deferred = createDeferred<WorkspaceSearchResult[]>();
      pending.set(query, deferred);
      return deferred.promise;
    });

    render(<StatefulSendBox initialValue="@m" onSearchWorkspace={onSearchWorkspace} />);

    const input = screen.getByLabelText("继续输入");
    await waitFor(() => {
      expect(pending.has("m")).toBe(true);
    });
    const firstSignal = onSearchWorkspace.mock.calls[0]?.[1]?.signal;

    input.textContent = "@ma";
    fireEvent.input(input);

    await waitFor(() => {
      expect(pending.has("ma")).toBe(true);
    });
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => {
      pending.get("ma")?.resolve([{ path: "src/main.ts", name: "main.ts", type: "file" }]);
    });
    expect(await screen.findByRole("option", { name: "选择文件 src/main.ts" })).not.toBeNull();

    await act(async () => {
      pending.get("m")?.resolve([{ path: "src/old.ts", name: "old.ts", type: "file" }]);
    });
    expect(screen.queryByRole("option", { name: "选择文件 src/old.ts" })).toBeNull();
  });
});

function StatefulSendBox({
  initialValue,
  onListWorkspaceDirectory,
  onSearchWorkspace,
}: {
  initialValue: string;
  onListWorkspaceDirectory?: (path: string) => Promise<WorkspaceSearchResult[]>;
  onSearchWorkspace?: (query: string, options?: { signal?: AbortSignal }) => Promise<WorkspaceSearchResult[]>;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <SendBox
      value={value}
      runtimeState="idle"
      canSend
      canStop={false}
      onChange={setValue}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onListWorkspaceDirectory={onListWorkspaceDirectory}
      onSearchWorkspace={onSearchWorkspace}
    />
  );
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function expectWorkspaceSearch(search: ReturnType<typeof vi.fn>, query: string) {
  expect(search).toHaveBeenCalledWith(query, expect.objectContaining({ signal: expect.any(Object) }));
}
