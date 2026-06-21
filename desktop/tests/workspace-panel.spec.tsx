import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge, WorkspaceEntry, WorkspaceTreeResponse } from "@/runtime";
import { WorkspacePanel } from "@/renderer/components/workspace";

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

    fireEvent.click(screen.getByRole("button", { name: "展开 src" }));
    expect(await screen.findByText("main.py")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "选择文件 src/main.py" }));
    expect(screen.getByText("src/main.py")).not.toBeNull();
    expect(onSelectFile).toHaveBeenCalledWith("src/main.py");
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
    expect(screen.queryByText("main.py")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开 src" }));
    expect(screen.getByText("main.py")).not.toBeNull();

    await waitFor(() => {
      expect(
        vi.mocked(runtime.workspace.listDirectory).mock.calls.filter(([, path]) => path === "src"),
      ).toHaveLength(1);
    });
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
});

function fakeRuntime(entriesByPath: Record<string, WorkspaceEntry[]>): RuntimeBridge {
  const listDirectory = vi.fn((_scope: unknown, path = ""): Promise<WorkspaceTreeResponse> => {
    const entries = entriesByPath[path];
    if (!entries) {
      return Promise.reject(new Error(`目录不存在：${path}`));
    }
    return Promise.resolve({ root: "D:/repo", entries });
  });
  return {
    workspace: {
      listDirectory,
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
