import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge, WorkspaceEntry, WorkspaceSubtreeResponse, WorkspaceTreeResponse } from "@/runtime";
import { WorkspaceFileBrowser, WorkspacePanel } from "@/renderer/components/workspace";
import { APP_FIND_SHORTCUT_EVENT } from "@/renderer/events/findShortcut";

describe("WorkspacePanel", () => {
  it("renders cwd, expands directories and selects files", async () => {
    const runtime = fakeRuntime({
      "": [
        entry("src", "src", "directory"),
        entry("README.md", "README.md", "file", 12),
      ],
      src: [entry("main.py", "src/main.py", "file", 24)],
    });
    const onSelectFile = vi.fn();

    render(<WorkspacePanel onSelectFile={onSelectFile} sessionId="ses-1" label="D:/repo" runtime={runtime} />);

    expect(await screen.findByText("D:/repo")).not.toBeNull();
    expect(screen.getByText("README.md")).not.toBeNull();
    expect(entryIconIdForLabel("src")).toBe("folder");

    fireEvent.click(screen.getByRole("button", { name: "展开 src" }));
    expect(await screen.findByText("main.py")).not.toBeNull();
    expect(entryIconIdForLabel("src")).toBe("folder");

    fireEvent.click(await screen.findByRole("button", { name: "选择文件 src/main.py" }));
    expect(screen.getByText("src/main.py")).not.toBeNull();
    expect(onSelectFile).toHaveBeenCalledWith("src/main.py");
  });

  it("waits for the first directory load before mounting expanded content", async () => {
    const srcDirectory = deferred<WorkspaceTreeResponse>();
    const runtime = {
      workspace: {
        listDirectory: vi.fn((_scope: unknown, path = "") => {
          if (path === "") {
            return Promise.resolve({
              root: "D:/repo",
              entries: [entry("src", "src", "directory")],
            });
          }
          return srcDirectory.promise;
        }),
        readFile: vi.fn(),
        search: vi.fn(),
      },
    } as unknown as RuntimeBridge;

    render(<WorkspacePanel sessionId="ses-1" label="D:/repo" runtime={runtime} />);

    const srcButton = await screen.findByRole("button", { name: "展开 src" });
    fireEvent.click(srcButton);

    expect(screen.getByRole("button", { name: "展开 src" }).textContent).toContain("读取中");
    expect(screen.queryByText("main.py")).toBeNull();

    srcDirectory.resolve({
      root: "D:/repo",
      entries: [entry("main.py", "src/main.py", "file", 24)],
    });

    expect(await screen.findByText("main.py")).not.toBeNull();
    expect(screen.getByRole("button", { name: "折叠 src" })).not.toBeNull();
  });

  it("keeps loaded directory content stable across collapse and expand", async () => {
    const runtime = fakeRuntime({
      "": [entry("src", "src", "directory")],
      src: [entry("main.py", "src/main.py", "file", 24)],
    });

    render(<WorkspacePanel sessionId="ses-1" label="D:/repo" runtime={runtime} />);

    await screen.findByText("src");
    fireEvent.click(screen.getByRole("button", { name: "展开 src" }));
    await screen.findByText("main.py");
    fireEvent.click(screen.getByRole("button", { name: "折叠 src" }));
    await waitFor(() => {
      expect(screen.queryByText("main.py")).toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "展开 src" }));
    expect(screen.getByText("main.py")).not.toBeNull();

    await waitFor(() => {
      expect(
        vi.mocked(runtime.workspace.listDirectory).mock.calls.filter(([, path]) => path === "src"),
      ).toHaveLength(1);
    });
  });

  it("does not scroll back to the keyboard active row after mouse-expanding a directory", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const runtime = fakeRuntime({
      "": [
        entry("alpha", "alpha", "directory"),
        entry("target", "target", "directory"),
      ],
      alpha: [entry("alpha.ts", "alpha/alpha.ts", "file", 12)],
      target: [entry("item.ts", "target/item.ts", "file", 24)],
    });

    try {
      render(<WorkspacePanel sessionId="ses-1" label="D:/repo" runtime={runtime} />);

      const targetButton = await screen.findByRole("button", { name: "展开 target" });
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "展开 alpha" }).getAttribute("data-keyboard-active")).toBe(
          "true",
        );
      });
      scrollIntoView.mockClear();

      fireEvent.click(targetButton);

      expect(await screen.findByRole("button", { name: "选择文件 target/item.ts" })).not.toBeNull();
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    }
  });

  it("toggles all descendant directories from the right edge control", async () => {
    const runtime = fakeRuntime({
      "": [entry("src", "src", "directory")],
      src: [
        entry("components", "src/components", "directory"),
        entry("index.ts", "src/index.ts", "file", 12),
      ],
      "src/components": [entry("ui", "src/components/ui", "directory")],
      "src/components/ui": [entry("Button.tsx", "src/components/ui/Button.tsx", "file", 24)],
    });

    render(<WorkspacePanel sessionId="ses-1" label="D:/repo" runtime={runtime} />);

    expect(await screen.findByRole("button", { name: "展开 src" })).not.toBeNull();
    const expandSubtreeButton = screen.getByRole("button", { name: "展开 src 的目录树" });
    expect(expandSubtreeButton.querySelector(".lucide-chevrons-up-down")).not.toBeNull();
    fireEvent.click(expandSubtreeButton);

    expect(await screen.findByRole("button", { name: "选择文件 src/components/ui/Button.tsx" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "折叠 src" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "折叠 components" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "折叠 ui" })).not.toBeNull();
    const collapseSubtreeButton = screen.getByRole("button", { name: "收起 src 的目录树" });
    expect(collapseSubtreeButton.querySelector(".lucide-chevrons-down-up")).not.toBeNull();
    await waitFor(() => {
      expect(runtime.workspace.listDirectorySubtree).toHaveBeenCalledWith(
        { sessionId: "ses-1" },
        "src",
        expect.objectContaining({ maxDepth: 6, maxDirs: 300, maxEntries: 1500, timeoutMs: 700 }),
      );
    });

    fireEvent.click(collapseSubtreeButton);

    expect(screen.getByRole("button", { name: "展开 src" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "展开 src 的目录树" }).querySelector(".lucide-chevrons-up-down")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "选择文件 src/components/ui/Button.tsx" })).toBeNull();
  });

  it("shows backend workspace errors", async () => {
    const runtime = {
      workspace: {
        listDirectory: vi.fn().mockRejectedValue(new Error("工作区不存在")),
      },
    } as unknown as RuntimeBridge;

    render(<WorkspacePanel sessionId="ses-missing" label="D:/missing" runtime={runtime} />);

    expect((await screen.findByRole("alert")).textContent).toBe("工作区不存在");
  });

  it("renders compact panel chrome with file filtering", async () => {
    const runtime = fakeRuntime({
      "": [
        entry("desktop", "desktop", "directory"),
        entry("package.json", "package.json", "file", 12),
      ],
    });

    render(<WorkspacePanel chrome="panel" sessionId="ses-1" label="D:/repo" runtime={runtime} />);

    expect(await screen.findByRole("searchbox", { name: "筛选文件" })).not.toBeNull();
    expect((screen.getByRole("button", { name: "定位当前文件" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("最多返回 100 项 · 最多搜索 2 秒")).not.toBeNull();
    expect(screen.getByText("desktop")).not.toBeNull();
    expect(screen.getByText("package.json")).not.toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "筛选文件" }), { target: { value: "package" } });

    await waitFor(() => {
      expect(runtime.workspace.search).toHaveBeenCalledWith(
        { sessionId: "ses-1" },
        "package",
        expect.objectContaining({ signal: expect.any(Object) }),
      );
    });
    expect(screen.getByRole("tree", { name: "工作区搜索结果" })).not.toBeNull();
    const result = await screen.findByRole("button", { name: "选择文件 package.json" });
    expect(result).not.toBeNull();
    expect(within(result).getByText("12 B")).not.toBeNull();
    expect(screen.queryByText("desktop")).toBeNull();

    fireEvent.click(result);

    expect(screen.getByRole("tree", { name: "工作区目录" })).not.toBeNull();
    expect((screen.getByRole("searchbox", { name: "筛选文件" }) as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "选择文件 package.json" }).getAttribute("data-selected")).toBe("true");
    expect(screen.getByText("desktop")).not.toBeNull();
  });

  it("focuses the file filter from the tree with Ctrl+F", async () => {
    const runtime = fakeRuntime({
      "": [
        entry("desktop", "desktop", "directory"),
        entry("package.json", "package.json", "file", 12),
      ],
    });

    render(<WorkspacePanel chrome="panel" sessionId="ses-1" label="D:/repo" runtime={runtime} />);

    const treeButton = await screen.findByRole("button", { name: "展开 desktop" });
    const filterInput = screen.getByRole("searchbox", { name: "筛选文件" });
    treeButton.focus();
    expect(document.activeElement).toBe(treeButton);

    fireEvent.keyDown(treeButton, { key: "f", ctrlKey: true });

    expect(document.activeElement).toBe(filterInput);

    treeButton.focus();
    expect(document.activeElement).toBe(treeButton);
    act(() => {
      document.dispatchEvent(
        new CustomEvent(APP_FIND_SHORTCUT_EVENT, {
          detail: { sourceTarget: treeButton },
        }),
      );
    });

    expect(document.activeElement).toBe(filterInput);
  });

  it("navigates visible file tree entries from the focused file filter", async () => {
    const runtime = fakeRuntime({
      "": [
        entry("desktop", "desktop", "directory"),
        entry("package.json", "package.json", "file", 12),
      ],
    });
    const onSelectFile = vi.fn();

    render(<WorkspacePanel chrome="panel" sessionId="ses-1" label="D:/repo" runtime={runtime} onSelectFile={onSelectFile} />);

    const filterInput = (await screen.findByRole("searchbox", { name: "筛选文件" })) as HTMLInputElement;
    filterInput.focus();
    const directoryButton = screen.getByRole("button", { name: "展开 desktop" });
    const fileButton = screen.getByRole("button", { name: "选择文件 package.json" });

    await waitFor(() => {
      expect(directoryButton.getAttribute("data-keyboard-active")).toBe("true");
    });

    fireEvent.keyDown(filterInput, { key: "ArrowDown" });

    expect(fileButton.getAttribute("data-keyboard-active")).toBe("true");
    expect(directoryButton.getAttribute("data-keyboard-active")).toBeNull();

    expect(document.activeElement).toBe(filterInput);

    fireEvent.keyDown(filterInput, { key: "Enter" });

    expect(onSelectFile).toHaveBeenCalledWith("package.json");
  });

  it("supports parent-controlled file selection and type icons", async () => {
    const runtime = fakeRuntime({
      "": [
        entry("app.tsx", "app.tsx", "file", 12),
        entry("package.json", "package.json", "file", 12),
        entry("pnpm-lock.yaml", "pnpm-lock.yaml", "file", 12),
        entry("README.md", "README.md", "file", 12),
      ],
    });

    render(<WorkspacePanel chrome="panel" selectedPath="package.json" sessionId="ses-1" runtime={runtime} />);

    await screen.findByText("app.tsx");
    const selected = screen.getByRole("button", { name: "选择文件 package.json" });
    expect(selected.getAttribute("data-selected")).toBe("true");
    expect(entryIconId(screen.getByRole("button", { name: "选择文件 app.tsx" }))).toBe("react_ts");
    expect(entryIconId(selected)).toBe("nodejs");
    expect(entryIconId(screen.getByRole("button", { name: "选择文件 pnpm-lock.yaml" }))).toBe("pnpm");
    expect(entryIconId(screen.getByRole("button", { name: "选择文件 README.md" }))).toBe("readme");
  });

  it("shows full entry names after a delayed hover only when labels are ellipsized", async () => {
    const longName = "very-long-file-name-that-is-truncated-in-the-tree.ts";
    const runtime = fakeRuntime({
      "": [
        entry(longName, longName, "file", 12),
        entry("README.md", "README.md", "file", 12),
      ],
    });
    const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");

    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get() {
        return this.textContent === longName ? 220 : 80;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.textContent === longName ? 120 : 120;
      },
    });

    try {
      render(<WorkspacePanel chrome="panel" sessionId="ses-1" label="D:/repo" runtime={runtime} />);

      const longLabel = await screen.findByText(longName);
      longLabel.getBoundingClientRect = vi.fn(() => ({
        x: 20,
        y: 30,
        left: 20,
        top: 30,
        right: 120,
        bottom: 48,
        width: 100,
        height: 18,
        toJSON: () => ({}),
      }));
      vi.useFakeTimers();
      fireEvent.mouseEnter(longLabel);
      await act(async () => {
        vi.advanceTimersByTime(499);
      });
      expect(screen.queryByRole("tooltip")).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      const tooltip = screen.getByRole("tooltip");
      expect(tooltip.textContent).toBe(longName);
      expect(tooltip.style.left).toBe("130px");
      expect(tooltip.style.top).toBe("39px");

      fireEvent.mouseLeave(longLabel);
      expect(screen.queryByRole("tooltip")).toBeNull();

      fireEvent.mouseEnter(screen.getByText("README.md"));
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
      if (originalScrollWidth) {
        Object.defineProperty(HTMLElement.prototype, "scrollWidth", originalScrollWidth);
      }
      if (originalClientWidth) {
        Object.defineProperty(HTMLElement.prototype, "clientWidth", originalClientWidth);
      }
    }
  });

  it("locates the current file by expanding its parent directories", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const runtime = fakeRuntime({
      "": [entry("src", "src", "directory")],
      src: [entry("components", "src/components", "directory")],
      "src/components": [entry("main.py", "src/components/main.py", "file", 24)],
    });

    try {
      render(
        <WorkspacePanel
          chrome="panel"
          selectedPath="src/components/main.py"
          sessionId="ses-1"
          runtime={runtime}
        />,
      );

      expect(await screen.findByRole("button", { name: "展开 src" })).not.toBeNull();
      expect(screen.queryByRole("button", { name: "选择文件 src/components/main.py" })).toBeNull();

      const locateButton = screen.getByRole("button", { name: "定位当前文件" }) as HTMLButtonElement;
      expect(locateButton.disabled).toBe(false);
      fireEvent.click(locateButton);

      const selected = await screen.findByRole("button", { name: "选择文件 src/components/main.py" });
      expect(selected.getAttribute("data-selected")).toBe("true");
      expect(document.activeElement).toBe(selected);
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "center",
        inline: "nearest",
      });
      await waitFor(() => {
        expect(runtime.workspace.listDirectory).toHaveBeenCalledWith({ sessionId: "ses-1" }, "src");
        expect(runtime.workspace.listDirectory).toHaveBeenCalledWith({ sessionId: "ses-1" }, "src/components");
      });
    } finally {
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    }
  });

  it("auto-locates externally requested preview files in the tree", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const runtime = fakeRuntime(
      {
        "": [entry("src", "src", "directory")],
        src: [entry("components", "src/components", "directory")],
        "src/components": [entry("main.py", "src/components/main.py", "file", 24)],
      },
      {
        "src/components/main.py": "print('ok')",
      },
    );

    try {
      render(
        <WorkspaceFileBrowser
          previewPath="src/components/main.py"
          previewRequestId={1}
          sessionId="ses-1"
          label="D:/repo"
          runtime={runtime}
        />,
      );

      expect(await screen.findByTestId("file-source-viewer")).not.toBeNull();
      const treePane = screen.getByTestId("workspace-file-browser-tree");
      const selectedLabel = await within(treePane).findByText("main.py");
      const selected = selectedLabel.closest("button");
      expect(selected).not.toBeNull();
      if (!selected) {
        throw new Error("selected tree button not found");
      }
      expect(selected.getAttribute("data-selected")).toBe("true");
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "center",
        inline: "nearest",
      });
      await waitFor(() => {
        expect(runtime.workspace.listDirectory).toHaveBeenCalledWith({ sessionId: "ses-1" }, "src");
        expect(runtime.workspace.listDirectory).toHaveBeenCalledWith({ sessionId: "ses-1" }, "src/components");
      });
    } finally {
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    }
  });

  it("opens selected files in a right-hand preview while keeping the tree visible", async () => {
    const runtime = fakeRuntime(
      {
        "": [entry("README.md", "README.md", "file", 12)],
      },
      {
        "README.md": "# Project\n\nRead me",
      },
    );

    render(<WorkspaceFileBrowser sessionId="ses-1" label="D:/repo" runtime={runtime} />);

    expect(await screen.findByRole("button", { name: "选择文件 README.md" })).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser-pathbar").textContent).toContain("/");
    expect(screen.queryByTestId("workspace-file-browser-preview")).toBeNull();
    expect(screen.queryByRole("separator", { name: "调整文件树宽度" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "选择文件 README.md" }));

    expect(await screen.findByRole("heading", { name: "Project" })).not.toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId("workspace-file-browser").getAttribute("data-preview-open")).toBe("true");
    });
    await waitFor(() => {
      expect(screen.getByTestId("workspace-file-browser").getAttribute("data-preview-layout-open")).toBe("true");
    });
    expect(screen.getByTestId("workspace-file-browser-pathbar").textContent).toContain("/README.md");
    expect(screen.queryByTitle("repo / README.md")).toBeNull();
    expect(screen.getByTestId("workspace-file-browser-preview")).not.toBeNull();
    expect(screen.getByRole("separator", { name: "调整文件树宽度" })).not.toBeNull();
    expect(screen.getByRole("tree", { name: "工作区目录" })).not.toBeNull();
    expect(runtime.workspace.readFile).toHaveBeenCalledWith({ sessionId: "ses-1" }, "README.md");

    fireEvent.click(screen.getByRole("button", { name: "关闭文件预览" }));

    expect(screen.getByTestId("workspace-file-browser").getAttribute("data-preview-layout-open")).toBe("false");
    await waitFor(() => {
      expect(screen.getByTestId("workspace-file-browser").getAttribute("data-preview-open")).toBe("false");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("workspace-file-browser-preview")).toBeNull();
      expect(screen.getByTestId("workspace-file-browser").getAttribute("data-preview-layout-open")).toBe("false");
      expect(screen.queryByRole("separator", { name: "调整文件树宽度" })).toBeNull();
    });
    expect(screen.getByRole("tree", { name: "工作区目录" })).not.toBeNull();
  });

  it("switches markdown file navigation to document outline and jumps to headings", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const runtime = fakeRuntime(
      {
        "": [entry("README.md", "README.md", "file", 12)],
      },
      {
        "README.md": "# Project\n\nIntro\n\n## Setup\n\nRun it.\n\n### Details\n\nMore.",
      },
    );

    try {
      render(<WorkspaceFileBrowser sessionId="ses-1" label="D:/repo" runtime={runtime} />);

      expect(await screen.findByRole("button", { name: "选择文件 README.md" })).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "选择文件 README.md" }));

      expect(await screen.findByRole("heading", { name: "Project" })).not.toBeNull();
      expect(screen.getByRole("button", { name: "文件" }).getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(screen.getByRole("button", { name: "大纲" }));

      expect(await screen.findByRole("navigation", { name: "Markdown 文档大纲" })).not.toBeNull();
      expect(screen.queryByRole("tree", { name: "工作区目录" })).toBeNull();
      expect(screen.getByRole("button", { name: "跳转到 Setup" }).textContent).toBe("Setup");
      expect(screen.getByRole("button", { name: "跳转到 Details" })).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "折叠 Setup" }));

      expect(screen.getByRole("button", { name: "展开 Setup" }).getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("button", { name: "跳转到 Details" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "展开 Setup" }));

      fireEvent.click(screen.getByRole("button", { name: "跳转到 Details" }));

      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalledWith({
          block: "start",
          inline: "nearest",
          behavior: "smooth",
        });
      });
      const scrolledElement = scrollIntoView.mock.contexts[
        scrollIntoView.mock.contexts.length - 1
      ] as HTMLElement;
      expect(scrolledElement.dataset.markdownOutlineId).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "文件" }));

      expect(screen.getByRole("tree", { name: "工作区目录" })).not.toBeNull();
      expect(screen.getByRole("button", { name: "文件" }).getAttribute("aria-pressed")).toBe("true");
    } finally {
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    }
  });

  it("collapses the file tree to an empty file prompt when no preview is open", async () => {
    const runtime = fakeRuntime({
      "": [entry("README.md", "README.md", "file", 12)],
    });

    render(<WorkspaceFileBrowser sessionId="ses-1" label="D:/repo" runtime={runtime} />);

    const browser = await screen.findByTestId("workspace-file-browser");
    expect(await screen.findByText("README.md")).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser-pathbar").textContent).toContain("/");
    expect(screen.getByRole("button", { name: "收起文件树" }).querySelector(".lucide-folder-open")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "收起文件树" }));

    expect(browser.getAttribute("data-tree-collapsed")).toBe("true");
    expect(screen.getByRole("button", { name: "展开文件树" }).querySelector(".lucide-folder")).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser-tree").getAttribute("data-collapsed")).toBe("true");
    expect(screen.queryByRole("tree", { name: "工作区目录" })).toBeNull();
    expect(screen.getByTestId("workspace-file-browser-empty").getAttribute("data-visible")).toBe("true");
    expect(screen.getByTestId("workspace-file-browser-empty").textContent).toContain("打开文件");
    expect(screen.getByText("从工作区目录树中选择文件")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开文件树" }));

    expect(browser.getAttribute("data-tree-collapsed")).toBe("false");
    expect(screen.getByTestId("workspace-file-browser-tree").getAttribute("data-collapsed")).toBe("false");
    expect(screen.getByTestId("workspace-file-browser-empty").getAttribute("data-visible")).toBe("false");
    expect(await screen.findByRole("button", { name: "选择文件 README.md" })).not.toBeNull();
    expect(screen.getByRole("tree", { name: "工作区目录" })).not.toBeNull();
  });

  it("collapses the file tree while keeping an open preview visible", async () => {
    const runtime = fakeRuntime(
      {
        "": [entry("README.md", "README.md", "file", 12)],
      },
      {
        "README.md": "# Project\n\nRead me",
      },
    );

    render(<WorkspaceFileBrowser sessionId="ses-1" label="D:/repo" runtime={runtime} />);

    const browser = await screen.findByTestId("workspace-file-browser");
    await screen.findByText("README.md");
    fireEvent.click(screen.getByRole("button", { name: "选择文件 README.md" }));

    expect(await screen.findByRole("heading", { name: "Project" })).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser-pathbar").textContent).toContain("/README.md");
    await waitFor(() => {
      expect(browser.getAttribute("data-preview-open")).toBe("true");
    });

    fireEvent.click(screen.getByRole("button", { name: "收起文件树" }));

    expect(browser.getAttribute("data-tree-collapsed")).toBe("true");
    expect(screen.queryByRole("tree", { name: "工作区目录" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "调整文件树宽度" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Project" })).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser-preview")).not.toBeNull();
    expect(screen.getByRole("button", { name: "展开文件树" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开文件树" }));

    expect(browser.getAttribute("data-tree-collapsed")).toBe("false");
    expect(await screen.findByRole("button", { name: "选择文件 README.md" })).not.toBeNull();
    expect(screen.getByRole("tree", { name: "工作区目录" })).not.toBeNull();
    expect(screen.getByRole("separator", { name: "调整文件树宽度" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Project" })).not.toBeNull();
  });

  it("marks the rightmost breadcrumb segment as the primary visible file name", async () => {
    const runtime = fakeRuntime(
      {
        "": [entry("test_entrypoints_with_long_name.ts", "src/components/test_entrypoints_with_long_name.ts", "file", 12)],
      },
      {
        "src/components/test_entrypoints_with_long_name.ts": "export const ok = true;",
      },
    );

    render(<WorkspaceFileBrowser sessionId="ses-1" label="D:/repo" runtime={runtime} />);

    await screen.findByText("test_entrypoints_with_long_name.ts");
    fireEvent.click(screen.getByRole("button", { name: "选择文件 src/components/test_entrypoints_with_long_name.ts" }));

    expect(await screen.findByTestId("file-source-viewer")).not.toBeNull();
    const pathbar = screen.getByTestId("workspace-file-browser-pathbar");
    expect(pathbar.textContent).toContain("/src/components/test_entrypoints_with_long_name.ts");
    expect(pathbar.querySelector('[data-last="true"]')?.textContent).toBe("/test_entrypoints_with_long_name.ts");
  });

  it("resizes the file tree pane through a CSS variable", async () => {
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const cancelRaf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const runtime = fakeRuntime({
      "": [entry("README.md", "README.md", "file", 12)],
    });

    render(<WorkspaceFileBrowser sessionId="ses-1" label="D:/repo" runtime={runtime} />);

    const browser = await screen.findByTestId("workspace-file-browser");
    await screen.findByText("README.md");
    fireEvent.click(screen.getByRole("button", { name: "选择文件 README.md" }));
    browser.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 900,
      bottom: 600,
      width: 900,
      height: 600,
      toJSON: () => ({}),
    }));
    const handle = await screen.findByRole("separator", { name: "调整文件树宽度" });

    const previewPane = await screen.findByTestId("workspace-file-browser-preview");

    expect(previewPane.getAttribute("data-workspace-file-preview-pane")).toBe("true");
    expect(browser.querySelector("[data-resize-tree-skeleton]")).toBeNull();

    dispatchPointer(handle, "pointerdown", { button: 0, pointerId: 1, clientX: 260 });
    expect(browser.getAttribute("data-resizing")).toBe("true");
    dispatchPointer(handle, "pointermove", { pointerId: 1, clientX: 700 });
    dispatchPointer(handle, "pointerup", { pointerId: 1, clientX: 700 });

    expect(browser.style.getPropertyValue("--workspace-file-tree-width")).toBe("620px");
    expect(browser.getAttribute("data-resizing")).toBeNull();
    raf.mockRestore();
    cancelRaf.mockRestore();
  });

  it("keeps the file tree usable when preview reading fails", async () => {
    const runtime = fakeRuntime(
      {
        "": [
          entry("bad.txt", "bad.txt", "file", 12),
          entry("README.md", "README.md", "file", 12),
        ],
      },
      {
        "README.md": "# OK",
      },
      new Set(["bad.txt"]),
    );

    render(<WorkspaceFileBrowser sessionId="ses-1" label="D:/repo" runtime={runtime} />);

    await screen.findByText("bad.txt");
    fireEvent.click(screen.getByRole("button", { name: "选择文件 bad.txt" }));

    expect((await screen.findByRole("alert")).textContent).toBe("文件过大，暂不预览");
    expect(screen.getByRole("tree", { name: "工作区目录" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "选择文件 README.md" }));
    expect(await screen.findByRole("heading", { name: "OK" })).not.toBeNull();
  });
});

function fakeRuntime(
  entriesByPath: Record<string, WorkspaceEntry[]>,
  fileContents: Record<string, string> = {},
  failingFiles: Set<string> = new Set(),
): RuntimeBridge {
  const listDirectory = vi.fn((_scope: unknown, path = ""): Promise<WorkspaceTreeResponse> => {
    const entries = entriesByPath[path];
    if (!entries) {
      return Promise.reject(new Error(`目录不存在：${path}`));
    }
    return Promise.resolve({ root: "D:/repo", entries });
  });
  const listDirectorySubtree = vi.fn((_scope: unknown, path = ""): Promise<WorkspaceSubtreeResponse> => {
    const entriesByDirectory: Record<string, WorkspaceEntry[]> = {};
    const expandedPaths: string[] = [];
    const visit = (directoryPath: string) => {
      const entries = entriesByPath[directoryPath];
      if (!entries) {
        throw new Error(`目录不存在：${directoryPath}`);
      }
      entriesByDirectory[directoryPath] = entries;
      expandedPaths.push(directoryPath);
      entries
        .filter((item) => item.type === "directory")
        .forEach((item) => visit(item.path));
    };
    try {
      visit(path);
    } catch (reason) {
      return Promise.reject(reason);
    }
    return Promise.resolve({
      root: "D:/repo",
      path,
      entries_by_path: entriesByDirectory,
      expanded_paths: expandedPaths,
      truncated: false,
      truncated_reason: null,
      visited_dirs: expandedPaths.length,
      entry_count: Object.values(entriesByDirectory).reduce((count, entries) => count + entries.length, 0),
    });
  });
  const readFile = vi.fn((_scope: unknown, path: string) => {
    if (failingFiles.has(path)) {
      return Promise.reject(new Error("文件过大，暂不预览"));
    }
    return Promise.resolve({ path, content: fileContents[path] ?? "", encoding: "utf-8" });
  });
  const search = vi.fn((_scope: unknown, query: string) => {
    const normalizedQuery = query.trim().toLowerCase();
    const seen = new Set<string>();
    const entries = Object.values(entriesByPath)
      .flat()
      .filter((item) => {
        if (seen.has(item.path)) {
          return false;
        }
        seen.add(item.path);
        return (
          !normalizedQuery ||
          item.name.toLowerCase().includes(normalizedQuery) ||
          item.path.toLowerCase().includes(normalizedQuery)
        );
      });
    return Promise.resolve(entries);
  });
  return {
    workspace: {
      listDirectory,
      listDirectorySubtree,
      readFile,
      search,
    },
  } as unknown as RuntimeBridge;
}

function entry(
  name: string,
  path: string,
  type: WorkspaceEntry["type"],
  size: number | null = null,
): WorkspaceEntry {
  return {
    name,
    path,
    type,
    size,
    modified_at: null,
  };
}

function dispatchPointer(target: Element, type: string, props: Record<string, number>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  fireEvent(target, event);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function entryIconId(button: HTMLElement): string | null {
  return button.querySelector("[data-icon-id]")?.getAttribute("data-icon-id") ?? null;
}

function entryIconIdForLabel(label: string): string | null {
  const treeItem = screen.getByText(label).closest('[role="treeitem"]');
  return treeItem?.querySelector("[data-icon-id]")?.getAttribute("data-icon-id") ?? null;
}
