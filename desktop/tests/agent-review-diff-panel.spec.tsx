import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentReviewDiffPanel } from "@/renderer/components/review/AgentReviewDiffPanel";
import { fileReviewDocumentFromChanges } from "@/renderer/components/diff/adapters/fileReviewDocument";
import type { FileReviewChange } from "@/renderer/utils/fileReview";

let reviewProps: Record<string, unknown> | null = null;

vi.mock("@/renderer/components/diff/wrappers/ReviewDiffView", () => ({
  ReviewDiffView: (props: Record<string, unknown>) => {
    reviewProps = props;
    return <div data-testid="agent-review-pierre" />;
  },
}));

describe("AgentReviewDiffPanel", () => {
  beforeEach(() => {
    reviewProps = null;
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("preserves the established empty review-panel contract", () => {
    render(<AgentReviewDiffPanel files={[]} scopeKey="scope" />);
    expect(screen.getByTestId("right-sidebar-review-panel")).not.toBeNull();
    expect(screen.getByTestId("review-empty-state").textContent).toContain("暂无可审阅的文件变更");
  });

  it("normalizes all files once and forwards the focused path", () => {
    render(
      <AgentReviewDiffPanel
        files={[change("src/a.ts"), change("src/b.ts")]}
        focusedPath="src/b.ts"
        scopeKey="session:panel"
      />,
    );
    expect(screen.getByTestId("agent-review-pierre")).not.toBeNull();
    const props = reviewProps as {
      document: { source: string; files: Array<{ displayPath: string }> };
      focusedPath: string;
      scrollScopeKey: string;
      wrap: boolean;
      onWrapChange: (wrap: boolean) => void;
    };
    expect(props.document.source).toBe("agent");
    expect(props.document.files.map((file) => file.displayPath)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(props.focusedPath).toBe("src/b.ts");
    expect(props.scrollScopeKey).toBe("agent-review:session:panel");
    expect(props.wrap).toBe(false);
    act(() => props.onWrapChange(true));
    expect((reviewProps as { wrap: boolean }).wrap).toBe(true);
  });

  it("keeps focus, open and exact-copy callbacks on the host boundary", async () => {
    const onFocusPath = vi.fn();
    const onOpenFile = vi.fn();
    render(
      <AgentReviewDiffPanel
        files={[change("src/a.ts")]}
        focusedPath="src/a.ts"
        scopeKey="scope"
        onFocusPath={onFocusPath}
        onOpenFile={onOpenFile}
      />,
    );
    const props = reviewProps as {
      onFocusPath: (path: string) => void;
      actions: { copyPatch: (patch: string) => Promise<void>; openFile: (path: string) => void };
    };
    act(() => props.onFocusPath("src/a.ts"));
    props.actions.openFile("src/a.ts");
    await props.actions.copyPatch("exact review patch");
    expect(onFocusPath).toHaveBeenCalledWith("src/a.ts");
    expect(onOpenFile).toHaveBeenCalledWith("src/a.ts");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("exact review patch");
  });

  it("restores the same document identity and focus after a sidebar remount", () => {
    const files = [change("src/a.ts"), change("src/b.ts")];
    const first = render(
      <AgentReviewDiffPanel files={files} focusedPath="src/b.ts" scopeKey="session:panel" />,
    );
    const before = reviewProps as { document: { id: string }; focusedPath: string };
    const documentId = before.document.id;
    first.unmount();
    render(<AgentReviewDiffPanel files={files} focusedPath="src/b.ts" scopeKey="session:panel" />);
    const after = reviewProps as { document: { id: string }; focusedPath: string };
    expect(after.document.id).toBe(documentId);
    expect(after.focusedPath).toBe("src/b.ts");
  });

  it("reuses the exact canonical document supplied by the source card", () => {
    const files = [change("src/source.ts")];
    const document = fileReviewDocumentFromChanges(files, {
      sessionId: "source-session",
      requestId: "source-message",
    });
    render(
      <AgentReviewDiffPanel
        files={files}
        document={document}
        scopeKey="sidebar-session:panel"
        title="不同的侧栏标题"
      />,
    );
    expect((reviewProps as { document: unknown }).document).toBe(document);
  });
});

function change(path: string): FileReviewChange {
  return {
    path,
    additions: 1,
    deletions: 1,
    operation: "update",
    diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    content: "",
    source: "final",
  };
}
