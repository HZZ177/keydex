import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitThreeWayMergeEditor,
  applyConflictChoice,
  parseConflictBlocks,
} from "@/renderer/features/git/components/GitThreeWayMergeEditor";
import type { GitConflictFile } from "@/runtime/gitTypes";

afterEach(cleanup);

const marked = [
  "before\n",
  "<<<<<<< HEAD\n",
  "ours\n",
  "||||||| base\n",
  "base\n",
  "=======\n",
  "theirs\n",
  ">>>>>>> feature\n",
  "after\n",
].join("");

describe("Git three-way merge editor", () => {
  it("parses diff3 blocks and applies ours, theirs, or both without markers", () => {
    const block = parseConflictBlocks(marked)[0];
    expect(block).toMatchObject({ ours: "ours\n", base: "base\n", theirs: "theirs\n" });
    expect(applyConflictChoice(marked, block, "ours")).toBe("before\nours\nafter\n");
    expect(applyConflictChoice(marked, block, "theirs")).toBe("before\ntheirs\nafter\n");
    expect(applyConflictChoice(marked, block, "both")).toBe("before\nours\ntheirs\nafter\n");
  });

  it("supports conflict navigation and one-click choice actions", () => {
    const twice = `${marked}${marked}`;
    render(<GitThreeWayMergeEditor file={file(twice)} saving={false} onSave={vi.fn()} />);
    expect(screen.getByText("1 / 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一个冲突" }));
    expect(screen.getByText("2 / 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "采用传入版本" }));
    expect((screen.getByRole("textbox", { name: "合并结果" }) as HTMLTextAreaElement).value).not.toContain(">>>>>>> feature\nafter\nbefore\n<<<<<<< HEAD");
  });

  it("tracks manual edits, warns before unload, and saves explicit encoding/EOL", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onDirtyChange = vi.fn();
    const addEventListener = vi.spyOn(window, "addEventListener");
    render(<GitThreeWayMergeEditor file={{ ...file(marked), resultEol: "mixed" }} saving={false} onSave={onSave} onDirtyChange={onDirtyChange} />);

    fireEvent.change(screen.getByRole("textbox", { name: "合并结果" }), { target: { value: "manual\nresult\n" } });
    fireEvent.change(screen.getByLabelText("结果编码"), { target: { value: "utf-8-bom" } });
    fireEvent.change(screen.getByLabelText("结果换行符"), { target: { value: "crlf" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    expect(addEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    expect(screen.getByText(/检测到混合换行符/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "保存结果" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("manual\nresult\n", "utf-8-bom", "crlf"));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("shows all source panes and keeps save disabled until result changes", () => {
    render(<GitThreeWayMergeEditor file={file(marked)} saving={false} onSave={vi.fn()} />);
    expect(screen.getByLabelText("共同基础内容").textContent).toBe("base\n");
    expect(screen.getByLabelText("当前分支内容").textContent).toBe("ours\n");
    expect(screen.getByLabelText("传入版本内容").textContent).toBe("theirs\n");
    expect((screen.getByRole("button", { name: "保存结果" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("exposes screen-reader instructions and keyboard-only resolve/save shortcuts", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<GitThreeWayMergeEditor file={file(marked)} saving={false} onSave={onSave} />);
    const result = screen.getByRole("textbox", { name: "合并结果" });
    expect(result.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText(/Alt\+1.*Alt\+S/)).toBeTruthy();

    fireEvent.keyDown(result, { key: "2", altKey: true });
    expect((result as HTMLTextAreaElement).value).toBe("before\ntheirs\nafter\n");
    fireEvent.keyDown(result, { key: "s", altKey: true });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("before\ntheirs\nafter\n", "utf-8", "lf"));
    expect(screen.getByRole("status").textContent).toMatch(/已保存|尚未保存/);
  });
});

function file(resultContent: string): GitConflictFile {
  return {
    path: "src/conflict.ts",
    relatedPaths: [],
    kind: "both_modified",
    stages: [
      stage(1, "base", "base\n", "a"),
      stage(2, "ours", "ours\n", "b"),
      stage(3, "theirs", "theirs\n", "c"),
    ],
    resultContent,
    resultBinary: false,
    resultEncoding: "utf-8",
    resultEol: "lf",
    resultTooLarge: false,
    resultRevision: "revision-1",
    allowedActions: ["accept_ours", "accept_theirs", "edit", "take_both"],
    editable: true,
  };
}

function stage(stageNumber: 1 | 2 | 3, label: "base" | "ours" | "theirs", content: string, object: string) {
  return {
    stage: stageNumber,
    label,
    objectId: object.repeat(40) as never,
    mode: "100644",
    size: content.length,
    content,
    binary: false,
    encoding: "utf-8" as const,
    eol: "lf" as const,
    tooLarge: false,
  };
}
