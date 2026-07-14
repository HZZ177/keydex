import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useUnifiedAnnotationSession } from "@/renderer/features/annotations/state/useUnifiedAnnotationSession";
import type { AnnotationsRuntime } from "@/runtime/annotations";

describe("unified annotation session lifecycle", () => {
  it("keeps long-lived view resources open when the runtime becomes available after mount", async () => {
    const runtime = fakeRuntime();
    const view = renderHook(
      ({ annotationsRuntime }: { annotationsRuntime: AnnotationsRuntime | null }) => useUnifiedAnnotationSession({
        documentRevision: "sha256:readme",
        kind: "text",
        markdownModel: null,
        mode: "source",
        path: "README.txt",
        runtime: annotationsRuntime,
        source: "Alpha",
        workspaceId: "ws-1",
      }),
      { initialProps: { annotationsRuntime: null as AnnotationsRuntime | null } },
    );

    expect(view.result.current.available).toBe(false);

    view.rerender({ annotationsRuntime: runtime });

    await waitFor(() => {
      expect(view.result.current.available).toBe(true);
      expect(runtime.list).toHaveBeenCalledWith(
        "ws-1",
        "README.txt",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });
});

function fakeRuntime(): AnnotationsRuntime {
  return {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    updateBody: vi.fn(),
    replaceTarget: vi.fn(),
    delete: vi.fn(),
  };
}
