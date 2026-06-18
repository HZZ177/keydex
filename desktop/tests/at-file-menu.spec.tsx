import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SendBox } from "@/renderer/components/chat/SendBox";
import { getAtQuery, replaceAtQuery } from "@/renderer/components/chat/AtFileMenu";
import type { WorkspaceSearchResult } from "@/runtime";

describe("AtFileMenu", () => {
  it("parses and replaces file mention queries", () => {
    const result: WorkspaceSearchResult = { path: "src/main.ts", name: "main.ts", type: "file" };

    expect(getAtQuery("@")).toBe("");
    expect(getAtQuery("请看 @mai")).toBe("mai");
    expect(getAtQuery("没有引用")).toBeNull();
    expect(replaceAtQuery("请看 @mai", result)).toBe("请看 @src/main.ts ");
  });

  it("searches workspace and inserts selected file mention", async () => {
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
    expect(onSearchWorkspace).toHaveBeenCalledWith("ma");

    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("@src/main.ts ");
    fireEvent.click(screen.getByRole("button", { name: "移除文件 src/main.ts" }));
    expect(screen.queryByRole("button", { name: "移除文件 src/main.ts" })).toBeNull();
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
});
