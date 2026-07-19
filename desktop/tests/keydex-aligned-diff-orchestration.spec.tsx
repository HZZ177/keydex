import { forwardRef } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KeydexDiffView } from "@/renderer/components/diff/KeydexDiffView";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";

const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const single = normalizeUnifiedPatch(patch, { source: "git", sourceVersion: "v1" });
const multi = normalizeUnifiedPatch(`${patch}\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n`, {
  source: "git",
  sourceVersion: "v2",
});

const alignedAdapter = vi.fn((props: { file: { displayPath: string }; sourceVersion: string }) => (
  <div data-testid="aligned-adapter">{props.file.displayPath}:{props.sourceVersion}</div>
));
const patchAdapter = vi.fn((_props?: unknown) => <div data-testid="patch-adapter" />);
const codeViewAdapter = vi.fn((_props?: unknown) => <div data-testid="code-view-adapter" />);
const workerState = vi.hoisted(() => ({ status: "ready" as "ready" | "error", runtime: true }));

vi.mock("@/renderer/components/diff/aligned/AlignedDiffFileView", () => ({
  AlignedDiffFileView: forwardRef((props: never, _ref) => alignedAdapter(props)),
}));
vi.mock("@/renderer/components/diff/engine/PierrePatchDiff", () => ({
  PierrePatchDiff: (props: never) => patchAdapter(props),
}));
vi.mock("@/renderer/components/diff/engine/PierreCodeView", () => ({
  PierreCodeView: (props: never) => codeViewAdapter(props),
}));
vi.mock("@/renderer/components/diff/engine/PierreWorkerPoolHost", () => ({
  PierreWorkerPoolBoundary: ({ children }: { children: React.ReactNode }) => children,
  usePierreWorkerPoolLease: () => ({
    status: workerState.status,
    cacheEpoch: 3,
    workers: { workersFailed: workerState.status === "error" },
  }),
  usePierreWorkerPoolRuntime: () => workerState.runtime ? ({ module: {}, manager: {} }) : null,
  usePierreWorkerPoolRetry: () => vi.fn(),
}));
vi.mock("@/renderer/components/diff/DiffLayoutBridge", () => ({
  KeydexDiffLayoutBridge: ({
    preferredLayout,
    wrap,
    children,
  }: {
    preferredLayout: "stacked" | "split";
    wrap: boolean;
    children: (decision: { effectiveLayout: "stacked" | "split"; wrap: boolean }) => React.ReactNode;
  }) => children({ effectiveLayout: preferredLayout, wrap }),
}));

beforeEach(() => {
  alignedAdapter.mockClear();
  patchAdapter.mockClear();
  codeViewAdapter.mockClear();
  workerState.status = "ready";
  workerState.runtime = true;
});

describe("KeydexDiffView aligned split orchestration", () => {
  it("routes a single-file split view exclusively through the aligned engine", () => {
    renderView(<KeydexDiffView document={single} profile="git" />);
    expect(screen.getByTestId("aligned-adapter").textContent).toBe("a.ts:v1");
    expect(patchAdapter).not.toHaveBeenCalled();
    expect(codeViewAdapter).not.toHaveBeenCalled();
  });

  it("renders only the active file when a multi-file document uses split layout", () => {
    renderView(
      <KeydexDiffView
        document={multi}
        profile="git"
        state={{ layout: "split", activeFileId: multi.files[1]!.id }}
      />,
    );
    expect(screen.getByTestId("aligned-adapter").textContent).toBe("b.ts:v2");
    expect(alignedAdapter).toHaveBeenCalledTimes(1);
    expect(codeViewAdapter).not.toHaveBeenCalled();
  });

  it("preserves the Pierre stacked renderers", () => {
    renderView(<KeydexDiffView document={single} profile="review" state={{ layout: "stacked" }} />);
    expect(screen.getByTestId("patch-adapter")).toBeTruthy();
    expect(alignedAdapter).not.toHaveBeenCalled();
  });

  it("never mounts aligned panes for the compact profile", () => {
    renderView(<KeydexDiffView document={single} profile="compact" state={{ layout: "stacked" }} />);
    expect(screen.getByTestId("patch-adapter")).toBeTruthy();
    expect(alignedAdapter).not.toHaveBeenCalled();
    expect(document.querySelector("[data-keydex-aligned-split]")).toBeNull();
  });

  it("falls back to readable stacked content without mounting a stale connector after worker failure", () => {
    workerState.status = "error";
    workerState.runtime = false;
    renderView(<KeydexDiffView document={single} profile="git" />);
    expect(screen.getByTestId("patch-adapter")).toBeTruthy();
    expect(alignedAdapter).not.toHaveBeenCalled();
    expect(document.querySelector("[data-keydex-aligned-split]")).toBeNull();
  });
});

function renderView(node: React.ReactNode) {
  return render(<ThemeProvider>{node}</ThemeProvider>);
}
