import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  createKeydexDiffViewControllerState,
  reduceKeydexDiffViewController,
  useKeydexDiffViewController,
} from "@/renderer/components/diff/diffViewController";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";

const firstPatch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const secondPatch = "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n";

function document(version = "v1", patch = `${firstPatch}\n${secondPatch}`) {
  return normalizeUnifiedPatch(patch, { source: "git", sourceVersion: version });
}

describe("Keydex Diff controlled view state", () => {
  it("creates profile defaults and contains only serializable domain values", () => {
    const state = createKeydexDiffViewControllerState(document(), "git");
    expect(state).toMatchObject({ layout: "split", wrap: false, loadingAction: null });
    expect(state.activeFileId).toBe(document().files[0]!.id);
    expect(() => JSON.stringify(state)).not.toThrow();
    expect(JSON.stringify(state)).not.toMatch(/HTMLElement|Pierre|WorkerPool/u);
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("handles file, expansion, layout, wrap, selection, scroll and loading events", () => {
    const doc = document();
    const first = doc.files[0]!;
    const second = doc.files[1]!;
    let state = createKeydexDiffViewControllerState(doc, "git");
    state = reduceKeydexDiffViewController(state, { type: "set_active_file", fileId: second.id });
    state = reduceKeydexDiffViewController(state, { type: "toggle_file", fileId: second.id });
    state = reduceKeydexDiffViewController(state, { type: "set_layout", layout: "split" });
    state = reduceKeydexDiffViewController(state, { type: "set_wrap", wrap: true });
    state = reduceKeydexDiffViewController(state, {
      type: "set_selection",
      selection: {
        anchor: { fileId: second.id, fileCacheKey: second.cacheKey, side: "new", line: 1 },
        focus: { fileId: second.id, fileCacheKey: second.cacheKey, side: "new", line: 1 },
      },
    });
    state = reduceKeydexDiffViewController(state, {
      type: "set_scroll_target",
      target: { fileId: second.id, line: 1, side: "new", align: "center" },
    });
    state = reduceKeydexDiffViewController(state, { type: "set_loading_action", action: "copy_patch" });
    expect(state).toMatchObject({
      activeFileId: second.id,
      layout: "split",
      wrap: true,
      loadingAction: "copy_patch",
      scrollTarget: { fileId: second.id, line: 1 },
    });
    expect(state.expandedFileIds).toContain(first.id);
    expect(state.expandedFileIds).toContain(second.id);
    expect(state.selection?.anchor.fileId).toBe(second.id);
  });

  it("clears selection and scroll when sourceVersion or cacheKey changes", () => {
    const original = document("v1");
    const file = original.files[0]!;
    let state = createKeydexDiffViewControllerState(original, "git");
    state = reduceKeydexDiffViewController(state, {
      type: "set_selection",
      selection: {
        anchor: { fileId: file.id, fileCacheKey: file.cacheKey, side: "old", line: 1 },
        focus: { fileId: file.id, fileCacheKey: file.cacheKey, side: "new", line: 1 },
      },
    });
    state = reduceKeydexDiffViewController(state, {
      type: "set_scroll_target",
      target: { fileId: file.id, line: 1 },
    });
    const streamed = document("v2", firstPatch.replace("+new", "+newer"));
    state = reduceKeydexDiffViewController(state, {
      type: "sync_document",
      document: streamed,
      profile: "git",
    });
    expect(state.selection).toBeNull();
    expect(state.scrollTarget).toBeNull();
    expect(state.loadingAction).toBeNull();
  });

  it("keeps display state and the active file only while that file still exists", () => {
    const original = document("v1");
    const second = original.files[1]!;
    let state = createKeydexDiffViewControllerState(original, "git", {
      activeFileId: second.id,
      layout: "split",
      wrap: true,
    });
    state = reduceKeydexDiffViewController(state, {
      type: "sync_document",
      document: document("v2", `${firstPatch}\n${secondPatch.replace("+y", "+new-y")}`),
      profile: "git",
    });
    expect(state).toMatchObject({ activeFileId: second.id, layout: "split", wrap: true });
    state = reduceKeydexDiffViewController(state, {
      type: "sync_document",
      document: document("v3", firstPatch),
      profile: "git",
    });
    expect(state.activeFileId).not.toBe(second.id);
    expect(state).toMatchObject({ layout: "split", wrap: true, selection: null, scrollTarget: null });
  });

  it("preserves Git display preferences but resets nonpersistent review preferences", () => {
    let git = createKeydexDiffViewControllerState(document(), "git");
    git = reduceKeydexDiffViewController(git, { type: "set_layout", layout: "split" });
    git = reduceKeydexDiffViewController(git, { type: "set_wrap", wrap: true });
    git = reduceKeydexDiffViewController(git, {
      type: "sync_document",
      document: document("v2", firstPatch),
      profile: "git",
    });
    expect(git).toMatchObject({ layout: "split", wrap: true });

    let review = createKeydexDiffViewControllerState(document(), "review", { wrap: false });
    review = reduceKeydexDiffViewController(review, {
      type: "sync_document",
      document: document("v2", firstPatch),
      profile: "review",
    });
    expect(review).toMatchObject({ layout: "stacked", wrap: true });
  });

  it("ignores unsupported layouts and unknown file targets", () => {
    const state = createKeydexDiffViewControllerState(document(), "review");
    expect(reduceKeydexDiffViewController(state, { type: "set_layout", layout: "split" })).toBe(state);
    expect(reduceKeydexDiffViewController(state, { type: "set_active_file", fileId: "missing" })).toBe(state);
  });

  it("keeps controlled state through equivalent document and theme-style rerenders", () => {
    const doc = document();
    const { result, rerender } = renderHook(
      ({ currentDocument }) => useKeydexDiffViewController(currentDocument, "git"),
      { initialProps: { currentDocument: doc } },
    );
    act(() => {
      result.current.setLayout("split");
      result.current.setWrap(true);
      result.current.setLoadingAction("copy");
    });
    rerender({ currentDocument: { ...doc } });
    expect(result.current.state).toMatchObject({ layout: "split", wrap: true, loadingAction: "copy" });
    act(() => result.current.reset());
    expect(result.current.state).toMatchObject({ layout: "split", wrap: false, loadingAction: null });
  });
});
