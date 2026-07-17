import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  keydexDiffContextMenuItems,
  keydexDiffOpenPath,
  useKeydexDiffContextMenu,
} from "@/renderer/components/diff/DiffContextMenu";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";
import type { KeydexDiffActions } from "@/renderer/components/diff/profiles";
import { AppContextMenuProvider } from "@/renderer/providers/AppContextMenuProvider";

const modified = normalizeUnifiedPatch(
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+A\n",
  { source: "git", sourceVersion: "menu" },
).files[0]!;
const deleted = { ...modified, status: "deleted" as const, newOperationPath: null, newPath: null };

describe("Keydex Diff application context menu", () => {
  it("builds capability-driven items in a stable order with exact sources", async () => {
    const actions: Required<Pick<KeydexDiffActions, "copySelection" | "copyPatch" | "copyPath" | "openFile">> = {
      copySelection: vi.fn(),
      copyPatch: vi.fn(),
      copyPath: vi.fn(),
      openFile: vi.fn(),
    };
    const items = keydexDiffContextMenuItems({ file: modified, actions, selectionText: "chosen" });
    expect(items.map((item) => item.label)).toEqual([
      "复制选中代码",
      "复制原始补丁",
      "复制文件路径",
      "打开文件",
    ]);
    await items[0]!.action?.();
    await items[1]!.action?.();
    await items[2]!.action?.();
    await items[3]!.action?.();
    expect(actions.copySelection).toHaveBeenCalledWith("chosen");
    expect(actions.copyPatch).toHaveBeenCalledWith(modified.patch);
    expect(actions.copyPath).toHaveBeenCalledWith(modified.displayPath);
    expect(actions.openFile).toHaveBeenCalledWith(modified.newOperationPath);
  });

  it("does not offer selection copy without a selection and disables deleted-file open", () => {
    const items = keydexDiffContextMenuItems({
      file: deleted,
      selectionText: "",
      actions: { copySelection: vi.fn(), openFile: vi.fn() },
    });
    expect(items.map((item) => item.label)).toEqual(["打开文件（文件已删除）"]);
    expect(items[0]?.disabled).toBe(true);
    expect(keydexDiffOpenPath(deleted)).toBeNull();
  });

  it("opens exactly one Keydex menu and suppresses the default menu surface", () => {
    render(
      <AppContextMenuProvider>
        <Harness actions={{ copyPatch: vi.fn(), copyPath: vi.fn() }} />
      </AppContextMenuProvider>,
    );
    fireEvent.contextMenu(screen.getByTestId("diff-context-target"), { clientX: 20, clientY: 30 });
    expect(screen.getAllByRole("menu", { name: "页面右键菜单" })).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: "复制原始补丁" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "复制文件路径" })).toBeTruthy();
    expect(document.querySelectorAll('[aria-label="页面右键菜单"]')).toHaveLength(1);
  });

  it("keeps rejected copy promises in the shared menu action boundary", async () => {
    const failure = Promise.reject(new Error("clipboard denied"));
    failure.catch(() => undefined);
    const item = keydexDiffContextMenuItems({ file: modified, actions: { copyPatch: () => failure } })[0]!;
    await expect(item.action?.()).rejects.toThrow("clipboard denied");
  });
});

function Harness({ actions }: { actions: KeydexDiffActions }) {
  const menu = useKeydexDiffContextMenu({ file: modified, actions });
  return (
    <div
      data-testid="diff-context-target"
      data-app-context-menu={menu.enabled ? "local" : undefined}
      onContextMenu={menu.onContextMenu}
    >
      Diff
    </div>
  );
}
