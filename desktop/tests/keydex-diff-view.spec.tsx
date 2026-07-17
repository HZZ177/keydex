import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  KeydexDiffView,
  keydexDiffEngineKind,
} from "@/renderer/components/diff/KeydexDiffView";
import { createKeydexDiffDocument } from "@/renderer/components/diff/model";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";

const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const single = normalizeUnifiedPatch(patch, { source: "git", sourceVersion: "v1" });
const replacementSingle = normalizeUnifiedPatch(
  "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-before\n+after\n",
  { source: "git", sourceVersion: "v1-replacement" },
);
const multi = normalizeUnifiedPatch(`${patch}\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n`, {
  source: "git",
  sourceVersion: "v2",
});
const largeSingle = normalizeUnifiedPatch([
  "diff --git a/large.ts b/large.ts",
  "--- a/large.ts",
  "+++ b/large.ts",
  "@@ -1,800 +1,800 @@",
  ...Array.from({ length: 800 }, (_, index) => `-before ${index + 1}`),
  ...Array.from({ length: 800 }, (_, index) => `+after ${index + 1}`),
  "",
].join("\n"), {
  source: "git",
  sourceVersion: "v-large",
});

const patchAdapter = vi.fn((props: { file: { displayPath: string }; layout: string; wrap: boolean }) => (
  <div data-testid="patch-adapter">{props.file.displayPath}:{props.layout}:{String(props.wrap)}</div>
));
const codeViewAdapter = vi.fn((props: { document: { id: string; files: unknown[] }; layout: string; wrap: boolean }) => (
  <div data-testid="code-view-adapter" data-document-id={props.document.id}>{props.document.files.length}:{props.layout}:{String(props.wrap)}</div>
));

vi.mock("@/renderer/components/diff/engine/PierrePatchDiff", () => ({
  PierrePatchDiff: (props: never) => patchAdapter(props),
}));
vi.mock("@/renderer/components/diff/engine/PierreCodeView", () => ({
  PierreCodeView: (props: never) => codeViewAdapter(props),
}));
vi.mock("@/renderer/components/diff/engine/PierreWorkerPoolHost", () => ({
  PierreWorkerPoolBoundary: ({ children }: { children: React.ReactNode }) => children,
  usePierreWorkerPoolLease: () => ({
    status: "ready",
    workers: { workersFailed: false },
  }),
  usePierreWorkerPoolRetry: () => vi.fn(),
}));

beforeEach(() => {
  patchAdapter.mockClear();
  codeViewAdapter.mockClear();
});

describe("KeydexDiffView facade", () => {
  it("selects empty, single and multi engines deterministically", () => {
    expect(keydexDiffEngineKind(createKeydexDiffDocument({
      id: "empty",
      source: "preview",
      sourceVersion: "v0",
      files: [],
    }), "single")).toBe("empty");
    expect(keydexDiffEngineKind(single, "single")).toBe("single");
    expect(keydexDiffEngineKind(multi, "code_view")).toBe("code_view");
  });

  it.each([
    ["compact", "stacked", true],
    ["review", "stacked", true],
    ["preview", "stacked", true],
  ] as const)("routes the %s profile through the single-file adapter", (profile, layout, wrap) => {
    renderView(<KeydexDiffView document={single} profile={profile} />);
    expect(screen.getByTestId("patch-adapter").textContent).toContain(`${layout}:${String(wrap)}`);
    expect(patchAdapter).toHaveBeenCalled();
    expect(codeViewAdapter).not.toHaveBeenCalled();
  });

  it("keeps a single Git file on the bounded direct renderer", () => {
    renderView(<KeydexDiffView document={single} profile="git" />);
    expect(patchAdapter).toHaveBeenCalledWith(expect.objectContaining({
      file: single.files[0],
      layout: "stacked",
      wrap: false,
    }));
    expect(codeViewAdapter).not.toHaveBeenCalled();
  });

  it("routes a multi-file document through CodeView and preserves controlled state", () => {
    renderView(
      <KeydexDiffView
        document={multi}
        profile="git"
        state={{ layout: "split", wrap: true, activeFileId: multi.files[1]!.id }}
        scrollScopeKey="repo-a"
      />,
    );
    expect(screen.getByTestId("code-view-adapter").textContent).toBe("2:stacked:true");
    expect(codeViewAdapter).toHaveBeenCalledWith(expect.objectContaining({
      activeFileId: multi.files[1]!.id,
      scrollScopeKey: "repo-a",
    }));
  });

  it("lets an embedded host own the outer panel boundary", () => {
    const { container } = renderView(
      <KeydexDiffView document={single} profile="review" embedded />,
    );
    expect(container.querySelector("[data-keydex-diff-surface]")?.getAttribute("data-embedded"))
      .toBe("true");
  });

  it("gives direct single-file patches a bounded viewport that resets when the file changes", () => {
    const view = renderView(<KeydexDiffView document={single} profile="preview" />);
    const firstViewport = view.container.querySelector("[data-keydex-diff-patch-viewport]");
    expect(firstViewport?.getAttribute("data-diff-file-id")).toBe(single.files[0]!.id);

    view.rerender(
      <ThemeProvider>
        <KeydexDiffView document={replacementSingle} profile="preview" />
      </ThemeProvider>,
    );
    const replacementViewport = view.container.querySelector("[data-keydex-diff-patch-viewport]");
    expect(replacementViewport?.getAttribute("data-diff-file-id"))
      .toBe(replacementSingle.files[0]!.id);
    expect(replacementViewport).not.toBe(firstViewport);
  });

  it("keeps the review toolbar mounted while a direct single-file patch is collapsed", () => {
    const view = renderView(
      <KeydexDiffView
        document={single}
        profile="review"
        singleFileExpanded={false}
        onWrapChange={vi.fn()}
      />,
    );
    expect(view.container.querySelector('[data-single-file-expanded="false"]')).not.toBeNull();
    expect(screen.queryByTestId("patch-adapter")).toBeNull();
    expect(view.container.querySelector('[data-keydex-diff-toolbar="true"]')).not.toBeNull();
  });

  it("keeps the vertical multi-file CodeView mounted when the active review file is collapsed", () => {
    renderView(
      <KeydexDiffView
        document={multi}
        profile="review"
        state={{ expandedFileIds: [] }}
        singleFileExpanded={false}
      />,
    );
    expect(screen.getByTestId("code-view-adapter")).not.toBeNull();
    expect(codeViewAdapter).toHaveBeenLastCalledWith(expect.objectContaining({
      expandedFileIds: [],
    }));
  });

  it("replaces an initial multi-file CodeView with a bounded single-file viewport", () => {
    const view = renderView(<KeydexDiffView document={multi} profile="git" />);
    expect(codeViewAdapter).toHaveBeenLastCalledWith(expect.objectContaining({ document: multi }));

    view.rerender(
      <ThemeProvider>
        <KeydexDiffView document={single} profile="git" />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("patch-adapter")).toBeTruthy();
    expect(view.container.querySelector("[data-keydex-diff-patch-viewport]")?.getAttribute("data-diff-file-id"))
      .toBe(single.files[0]!.id);
    expect(patchAdapter).toHaveBeenLastCalledWith(expect.objectContaining({ file: single.files[0] }));
  });

  it("routes a large single-file document through virtualized CodeView", () => {
    renderView(<KeydexDiffView document={largeSingle} profile="preview" />);
    expect(screen.getByTestId("code-view-adapter").textContent).toBe("1:stacked:true");
    expect(codeViewAdapter).toHaveBeenCalledWith(expect.objectContaining({
      virtualizationPolicy: expect.objectContaining({
        strategy: "code_view",
        level: "aggressive",
        virtualized: true,
      }),
    }));
    expect(patchAdapter).not.toHaveBeenCalled();
  });

  it("renders empty and producer-error states without invoking an engine", () => {
    const empty = createKeydexDiffDocument({
      id: "empty",
      source: "preview",
      sourceVersion: "v0",
      files: [],
    });
    renderView(<KeydexDiffView document={empty} profile="preview" />);
    expect(screen.getByText("没有可显示的差异")).toBeTruthy();
    expect(patchAdapter).not.toHaveBeenCalled();
  });

  it("rejects Git mutation capabilities outside the Git profile", () => {
    expect(() => renderView(
      <KeydexDiffView
        document={single}
        profile="review"
        actions={{ git: { mode: "stage", applyPatches: vi.fn() } }}
      />,
    )).toThrow(/Git write actions are not allowed/);
  });

  it("keeps the Hunk callback contract hidden from the Diff UI", () => {
    const applyHunk = vi.fn();
    renderView(
      <KeydexDiffView
        document={single}
        profile="git"
        actions={{ git: { mode: "stage", applyPatches: vi.fn(), applyHunk } }}
      />,
    );
    const props = patchAdapter.mock.calls.at(-1)?.[0] as unknown as {
      annotations?: unknown;
      onAnnotationAction?: unknown;
    };
    expect(props.annotations).toBeUndefined();
    expect(props.onAnnotationAction).toBeUndefined();
    expect(applyHunk).not.toHaveBeenCalled();
  });
});

function renderView(node: React.ReactNode) {
  return render(<ThemeProvider>{node}</ThemeProvider>);
}
