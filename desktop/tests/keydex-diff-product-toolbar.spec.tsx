import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KeydexDiffProductToolbar } from "@/renderer/components/diff/KeydexDiffProductToolbar";
import type { KeydexDiffActions, KeydexDiffProfileName } from "@/renderer/components/diff/profiles";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";

const document = normalizeUnifiedPatch(
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  { source: "git", sourceVersion: "toolbar" },
);
const file = document.files[0]!;
const selection = {
  anchor: { fileId: file.id, fileCacheKey: file.cacheKey, side: "old" as const, line: 1 },
  focus: { fileId: file.id, fileCacheKey: file.cacheKey, side: "new" as const, line: 1 },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("KeydexDiffProductToolbar", () => {
  it.each([
    ["compact", ["复制选中代码", "复制原始补丁", "打开文件"]],
    ["review", ["复制选中代码", "复制原始补丁", "打开文件", "切换为并排视图", "关闭自动换行"]],
    ["preview", ["复制选中代码", "复制原始补丁", "打开文件", "切换为并排视图", "关闭自动换行"]],
    ["git", ["复制选中代码", "复制原始补丁", "打开文件", "切换为并排视图", "开启自动换行", "暂存选择"]],
  ] as const)("uses the stable %s capability order", (profile, labels) => {
    renderToolbar(profile, fullActions(profile));
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(labels);
  });

  it("does not render an empty toolbar when the host exposes no capability", () => {
    const { container } = renderToolbar("compact", {});
    expect(container.querySelector("[data-keydex-diff-product-toolbar]")).toBeNull();
  });

  it("lets the Git host hide duplicate file-tree and patch actions", () => {
    render(
      <KeydexDiffProductToolbar
        profile="git"
        files={[file]}
        activeFile={file}
        actions={fullActions("git")}
        layout="split"
        wrap={false}
        selectionText="selected"
        selection={selection}
        onLayoutChange={vi.fn()}
        onWrapChange={vi.fn()}
        hiddenActions={["copy_selection", "copy_patch", "apply_git_patch"]}
      />,
    );
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "打开文件",
      "切换为统一视图",
      "开启自动换行",
    ]);
  });

  it("treats layout and wrapping as persistent toggles without success-check feedback", () => {
    vi.useFakeTimers();
    const onLayoutChange = vi.fn();
    const onWrapChange = vi.fn();
    render(
      <KeydexDiffProductToolbar
        profile="git"
        files={[file]}
        activeFile={file}
        actions={{}}
        layout="stacked"
        wrap={false}
        onLayoutChange={onLayoutChange}
        onWrapChange={onWrapChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换为并排视图" }));
    fireEvent.click(screen.getByRole("button", { name: "开启自动换行" }));
    act(() => vi.advanceTimersByTime(1_000));

    expect(onLayoutChange).toHaveBeenCalledWith("split");
    expect(onWrapChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("button", { name: /成功/u })).toBeNull();
  });

  it("shows synchronized change navigation only for an effective split layout", () => {
    const onPreviousChange = vi.fn();
    const onNextChange = vi.fn();
    const onSyncScrollChange = vi.fn();
    const { rerender } = render(
      <KeydexDiffProductToolbar
        profile="git"
        files={[file]}
        activeFile={file}
        layout="split"
        wrap={false}
        syncScroll
        changeCount={3}
        onPreviousChange={onPreviousChange}
        onNextChange={onNextChange}
        onSyncScrollChange={onSyncScrollChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上一个差异" }));
    fireEvent.click(screen.getByRole("button", { name: "下一个差异" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭同步滚动" }));
    expect(onPreviousChange).toHaveBeenCalledOnce();
    expect(onNextChange).toHaveBeenCalledOnce();
    expect(onSyncScrollChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: "上一个差异" }).getAttribute("data-tooltip-label"))
      .toBe("上一个差异");
    expect(screen.getByRole("button", { name: "下一个差异" }).getAttribute("data-tooltip-label"))
      .toBe("下一个差异");

    rerender(
      <KeydexDiffProductToolbar
        profile="git"
        files={[file]}
        activeFile={file}
        layout="stacked"
        wrap={false}
        syncScroll
        changeCount={3}
        onPreviousChange={onPreviousChange}
        onNextChange={onNextChange}
        onSyncScrollChange={onSyncScrollChange}
      />,
    );
    expect(screen.queryByRole("button", { name: "上一个差异" })).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭同步滚动" })).toBeNull();
  });

  it("hides change navigation when there are no changes and never uses inline busy text", () => {
    const { container } = render(
      <KeydexDiffProductToolbar
        profile="preview"
        files={[file]}
        activeFile={file}
        layout="split"
        wrap
        changeCount={0}
        syncScroll={false}
        onPreviousChange={vi.fn()}
        onNextChange={vi.fn()}
        onSyncScrollChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "上一个差异" })).toBeNull();
    expect(screen.getByRole("button", { name: "开启同步滚动" })).toBeTruthy();
    expect(container.textContent).not.toContain("处理中");
    expect(container.querySelector('[title]')).toBeNull();
  });

  it("scopes hover feedback to one toolbar when multiple Diff surfaces are mounted", () => {
    vi.useFakeTimers();
    const { container } = render(
      <>
        {toolbar("compact", { copyPatch: vi.fn() })}
        {toolbar("review", { copyPatch: vi.fn() })}
      </>,
    );
    const scopes = Array.from(
      container.querySelectorAll<HTMLElement>("[data-keydex-diff-tooltip-scope]"),
      (element) => element.dataset.keydexDiffTooltipScope,
    );
    expect(scopes).toHaveLength(2);
    expect(new Set(scopes).size).toBe(2);

    fireEvent.pointerOver(screen.getAllByRole("button", { name: "复制原始补丁" })[0]!);
    act(() => vi.advanceTimersByTime(420));
    expect(screen.getAllByRole("tooltip", { name: "复制原始补丁" })).toHaveLength(1);
  });

  it("shows success for one second and restores the original action", async () => {
    vi.useFakeTimers();
    const copyPatch = vi.fn();
    renderToolbar("compact", { copyPatch });
    fireEvent.click(screen.getByRole("button", { name: "复制原始补丁" }));
    await act(async () => { await Promise.resolve(); });
    expect(copyPatch).toHaveBeenCalledWith(file.patch);
    expect(screen.getByRole("button", { name: "复制原始补丁成功" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("button", { name: "复制原始补丁" })).toBeTruthy();
  });

  it("contains callback failures and exposes an error state", async () => {
    vi.useFakeTimers();
    renderToolbar("compact", { copyPatch: vi.fn().mockRejectedValue(new Error("denied")) });
    fireEvent.click(screen.getByRole("button", { name: "复制原始补丁" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("button", { name: "复制原始补丁失败" })).toBeTruthy();
  });

  it("delegates Git line selection to the host and disables missing or inexact selection", async () => {
    const applyPatches = vi.fn();
    const applySelection = vi.fn();
    const { rerender } = render(
      toolbar("git", { git: { mode: "stage", applyPatches, applySelection } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "暂存选择" }));
    await act(async () => { await Promise.resolve(); });
    expect(applySelection).toHaveBeenCalledWith(selection);
    expect(applyPatches).not.toHaveBeenCalled();

    rerender(toolbar("git", { git: { mode: "stage", applyPatches, applySelection } }, {
      ...file,
      selectableForPatch: false,
    }));
    expect(screen.getByRole("button", { name: "暂存选择" }).hasAttribute("disabled")).toBe(true);

    rerender(toolbar("git", { git: { mode: "stage", applyPatches, applySelection } }, file, null));
    expect(screen.getByRole("button", { name: "暂存选择" }).hasAttribute("disabled")).toBe(true);
  });

  it("uses the host Git action lifecycle without reporting a failed action as success", () => {
    const applySelection = vi.fn();
    const applyPatches = vi.fn();
    const { rerender } = render(toolbar("git", {
      git: {
        mode: "stage",
        status: "queued",
        busy: true,
        disabledReason: "Git 操作已进入队列",
        applyPatches,
        applySelection,
      },
    }));
    const queued = screen.getByRole("button", { name: "暂存选择中" });
    expect(queued.getAttribute("aria-busy")).toBe("true");
    expect(queued.getAttribute("data-tooltip-label")).toBe("Git 操作已进入队列");

    rerender(toolbar("git", {
      git: { mode: "stage", status: "success", applyPatches, applySelection },
    }));
    expect(screen.getByRole("button", { name: "暂存选择成功" })).toBeTruthy();

    rerender(toolbar("git", {
      git: { mode: "stage", status: "error", applyPatches, applySelection },
    }));
    expect(screen.getByRole("button", { name: "暂存选择失败" })).toBeTruthy();
    expect(applySelection).not.toHaveBeenCalled();
  });
});

function fullActions(profile: KeydexDiffProfileName): KeydexDiffActions {
  return {
    copyPatch: vi.fn(),
    copySelection: vi.fn(),
    openFile: vi.fn(),
    ...(profile === "git" ? {
      git: { mode: "stage" as const, applyPatches: vi.fn(), applySelection: vi.fn() },
    } : {}),
  };
}

function renderToolbar(profile: KeydexDiffProfileName, actions: KeydexDiffActions) {
  return render(toolbar(profile, actions));
}

function toolbar(
  profile: KeydexDiffProfileName,
  actions: KeydexDiffActions,
  activeFile = file,
  activeSelection: typeof selection | null = selection,
) {
  return (
    <KeydexDiffProductToolbar
      profile={profile}
      files={[activeFile]}
      activeFile={activeFile}
      actions={actions}
      layout="stacked"
      wrap={profile !== "git"}
      selectionText="selected"
      selection={activeSelection}
      onLayoutChange={vi.fn()}
      onWrapChange={vi.fn()}
    />
  );
}
