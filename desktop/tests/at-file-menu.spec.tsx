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
    expect(screen.getByText("最多返回 100 项 · 最多搜索 2 秒")).not.toBeNull();
    expectWorkspaceSearch(onSearchWorkspace, "ma");

    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("main.ts");
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

  it("wraps keyboard navigation at the start and end of the file menu", async () => {
    const onSearchWorkspace = vi.fn().mockResolvedValue([
      { path: "alpha.md", name: "alpha.md", type: "file" as const },
      { path: "beta.md", name: "beta.md", type: "file" as const },
    ]);

    render(
      <SendBox
        value="@a"
        runtimeState="idle"
        canSend
        canStop={false}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onSearchWorkspace={onSearchWorkspace}
      />,
    );

    const input = screen.getByLabelText("继续输入");
    const first = await screen.findByRole("option", { name: "选择文件 alpha.md" });
    const last = await screen.findByRole("option", { name: "选择文件 beta.md" });

    expect(first.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() => {
      expect(last.getAttribute("aria-selected")).toBe("true");
    });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() => {
      expect(first.getAttribute("aria-selected")).toBe("true");
    });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() => {
      expect(last.getAttribute("aria-selected")).toBe("true");
    });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() => {
      expect(first.getAttribute("aria-selected")).toBe("true");
    });
  });

  it("reopens the bare at menu after deleting and typing the trigger again", async () => {
    const onListWorkspaceDirectory = vi.fn().mockResolvedValue([
      { path: "README.md", name: "README.md", type: "file" as const },
    ]);

    render(<StatefulSendBox initialValue="" onListWorkspaceDirectory={onListWorkspaceDirectory} />);

    const input = screen.getByLabelText("继续输入");
    input.textContent = "@";
    fireEvent.input(input);
    expect(await screen.findByRole("option", { name: "选择文件 README.md" })).not.toBeNull();
    expect(onListWorkspaceDirectory).toHaveBeenCalledTimes(1);

    input.textContent = "";
    fireEvent.input(input);
    await waitFor(() => {
      expect(screen.queryByTestId("at-file-menu")).toBeNull();
    });

    input.textContent = "@";
    fireEvent.input(input);
    await waitFor(() => {
      expect(onListWorkspaceDirectory).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByRole("option", { name: "选择文件 README.md" })).not.toBeNull();
  });

  it("forgets a dismissed bare at query once the trigger is deleted", async () => {
    const onListWorkspaceDirectory = vi.fn().mockResolvedValue([
      { path: "README.md", name: "README.md", type: "file" as const },
    ]);

    render(<StatefulSendBox initialValue="@" onListWorkspaceDirectory={onListWorkspaceDirectory} />);

    const input = screen.getByLabelText("继续输入");
    expect(await screen.findByTestId("at-file-menu")).not.toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("at-file-menu")).toBeNull();

    input.textContent = "";
    fireEvent.input(input);

    input.textContent = "@";
    fireEvent.input(input);

    await waitFor(() => {
      expect(onListWorkspaceDirectory).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByRole("option", { name: "选择文件 README.md" })).not.toBeNull();
  });

  it("references directories from the explicit at-menu action", async () => {
    const onChange = vi.fn();
    const onOpenFileReference = vi.fn();
    const onListWorkspaceDirectory = vi.fn().mockResolvedValue([
      { path: "src", name: "src", type: "directory" as const },
      { path: "README.md", name: "README.md", type: "file" as const },
    ]);

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
        onOpenFileReference={onOpenFileReference}
      />,
    );

    expect(await screen.findByRole("option", { name: "打开目录 src" })).not.toBeNull();
    fireEvent.mouseDown(screen.getByRole("button", { name: "引用目录 src" }));

    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("src");
    const directoryChip = screen.getByRole("button", { name: "在文件列表中定位目录 src" });
    expect(directoryChip.hasAttribute("disabled")).toBe(false);
    expect(document.querySelector('[data-context-chip-icon="directory"]')).not.toBeNull();

    fireEvent.click(directoryChip);
    expect(onOpenFileReference).toHaveBeenCalledWith({
      path: "src",
      name: "src",
      type: "directory",
      source: "workspace",
    });

    fireEvent.click(screen.getByRole("button", { name: "移除目录引用 src" }));
    expect(screen.queryByRole("button", { name: "在文件列表中定位目录 src" })).toBeNull();
  });

  it("keeps directory browsing on the primary row action", async () => {
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
    const directoryOption = await screen.findByRole("option", { name: "打开目录 src" });

    await act(async () => {
      fireEvent.mouseDown(directoryOption);
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
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("main.ts");
  });

  it("references the active directory with control-enter", async () => {
    render(
      <SendBox
        value="@"
        runtimeState="idle"
        canSend
        canStop={false}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onListWorkspaceDirectory={vi.fn().mockResolvedValue([
          { path: "src", name: "src", type: "directory" as const },
        ])}
      />,
    );

    const input = screen.getByLabelText("继续输入");
    expect(await screen.findByRole("option", { name: "打开目录 src" })).not.toBeNull();
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    expect(screen.getByLabelText("已添加上下文").textContent).toContain("src");
    expect(screen.getByRole("button", { name: "目录引用 src" })).not.toBeNull();
  });

  it("browses into and out of directories with horizontal arrow keys", async () => {
    const onListWorkspaceDirectory = vi.fn((path: string) =>
      Promise.resolve(
        path === "src"
          ? [{ path: "src/main.ts", name: "main.ts", type: "file" as const }]
          : [{ path: "src", name: "src", type: "directory" as const }],
      ),
    );

    render(
      <SendBox
        value="@"
        runtimeState="idle"
        canSend
        canStop={false}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onListWorkspaceDirectory={onListWorkspaceDirectory}
      />,
    );

    const input = screen.getByLabelText("继续输入");
    expect(await screen.findByRole("option", { name: "打开目录 src" })).not.toBeNull();

    fireEvent.keyDown(input, { key: "ArrowRight" });
    await waitFor(() => {
      expect(onListWorkspaceDirectory).toHaveBeenCalledWith("src");
    });
    expect(await screen.findByRole("option", { name: "选择文件 src/main.ts" })).not.toBeNull();

    fireEvent.keyDown(input, { key: "ArrowLeft" });
    await waitFor(() => {
      expect(onListWorkspaceDirectory.mock.calls.filter(([path]) => path === "")).toHaveLength(2);
    });
    expect(await screen.findByRole("option", { name: "打开目录 src" })).not.toBeNull();
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

  it("debounces file mention search until the query is stable for 350ms", async () => {
    vi.useFakeTimers();
    const onSearchWorkspace = vi.fn().mockResolvedValue([]);

    try {
      render(<StatefulSendBox initialValue="" onSearchWorkspace={onSearchWorkspace} />);

      const input = screen.getByLabelText("继续输入");
      input.textContent = "@1";
      fireEvent.input(input);
      input.textContent = "@10";
      fireEvent.input(input);
      input.textContent = "@10m";
      fireEvent.input(input);

      expect(onSearchWorkspace).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(349);
      });
      expect(onSearchWorkspace).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(onSearchWorkspace).toHaveBeenCalledTimes(1);
      expectWorkspaceSearch(onSearchWorkspace, "10m");
    } finally {
      vi.useRealTimers();
    }
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
