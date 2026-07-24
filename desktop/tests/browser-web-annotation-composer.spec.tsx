import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SendBox } from "@/renderer/components/chat/SendBox";
import {
  emitAddWebAnnotationToComposer,
  emitRemoveWebAnnotationFromComposers,
} from "@/renderer/events/webAnnotationContext";
import {
  webAnnotationReferencePresentations,
  type SelectedWebAnnotationReference,
  type WebAnnotationVisibleStatus,
} from "@/renderer/features/browser/annotations";
import {
  ComposerDraftProvider,
  composerNewWorkspaceDraftScope,
  composerSessionDraftScope,
  useComposerDraft,
} from "@/renderer/features/composer";
import type { SelectedFile } from "@/renderer/components/chat/SendBox/fileSelection";

afterEach(() => {
  act(() => webAnnotationReferencePresentations.clear());
});

describe("browser web annotation composer references", () => {
  it("adds, deduplicates, warns, sends and removes only explicitly selected references", () => {
    const onSend = vi.fn().mockReturnValue(false);
    const scope = composerSessionDraftScope("session-a");
    render(
      <ComposerDraftProvider storage={null}>
        <BoundSendBox scope={scope} onSend={onSend} />
      </ComposerDraftProvider>,
    );

    let firstResult = "unhandled";
    act(() => {
      firstResult = emitReference(scope, "annotation-1", "Article one", "resolved", true);
    });
    expect(firstResult).toBe("added");
    expect(screen.getByRole("button", { name: "移除网页批注引用 Article one" })).not.toBeNull();
    expect(screen.getByRole("status", { name: "网页目标有变化，发送时将保留原始目标、当前目标与变化证据" })).not.toBeNull();

    let duplicateResult = "unhandled";
    act(() => {
      duplicateResult = emitReference(scope, "annotation-1", "Article one", "orphaned");
    });
    expect(duplicateResult).toBe("duplicate");
    expect(screen.getAllByLabelText(/网页批注 · Article one，修订 1/)).toHaveLength(1);
    expect(screen.getByRole("status", { name: "网页目标已失联，发送时仅保留原始引用和来源" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalledWith([], [], [], {}, [{
      annotationId: "annotation-1",
      selectedRevision: 1,
      selectedAt: "2026-07-22T08:00:00Z",
      sourcePanelId: "browser-1",
    }]);

    fireEvent.click(screen.getByRole("button", { name: "移除网页批注引用 Article one" }));
    expect(screen.queryByRole("button", { name: "移除网页批注引用 Article one" })).toBeNull();
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps references isolated by composer scope and enforces the 20 item collection limit", () => {
    const sessionA = composerSessionDraftScope("session-a");
    const sessionB = composerSessionDraftScope("session-b");
    const { rerender } = render(
      <ComposerDraftProvider storage={null}>
        <BoundSendBox scope={sessionA} onSend={vi.fn()} />
      </ComposerDraftProvider>,
    );

    for (let index = 1; index <= 20; index += 1) {
      act(() => {
        expect(emitReference(sessionA, `annotation-${index}`, `Article ${index}`)).toBe("added");
      });
    }
    let overflow = "unhandled";
    act(() => {
      overflow = emitReference(sessionA, "annotation-21", "Article 21");
      expect(emitReference(sessionB, "annotation-b", "Session B article")).toBe("added");
    });
    expect(overflow).toBe("limit");
    expect(screen.getAllByRole("button", { name: /移除网页批注引用 Article/ })).toHaveLength(20);

    rerender(
      <ComposerDraftProvider storage={null}>
        <BoundSendBox scope={sessionB} onSend={vi.fn()} />
      </ComposerDraftProvider>,
    );
    expect(screen.getByRole("button", { name: "移除网页批注引用 Session B article" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "移除网页批注引用 Article 1" })).toBeNull();
  });

  it("routes Workbench references to the current session or workspace new-session draft without cross-workspace leakage", () => {
    const currentSession = composerSessionDraftScope("session-current");
    const workspaceDraft = composerNewWorkspaceDraftScope("workspace-a");
    const otherWorkspaceDraft = composerNewWorkspaceDraftScope("workspace-b");
    const view = render(
      <ComposerDraftProvider storage={null}>
        <BoundSendBox scope={currentSession} onSend={vi.fn()} />
      </ComposerDraftProvider>,
    );

    act(() => {
      expect(emitReference(currentSession, "annotation-current", "Current session local file"))
        .toBe("added");
      expect(emitReference(workspaceDraft, "annotation-new", "New session local file"))
        .toBe("added");
      expect(emitReference(otherWorkspaceDraft, "annotation-other", "Other workspace local file"))
        .toBe("added");
    });
    expect(screen.getByRole("button", {
      name: "移除网页批注引用 Current session local file",
    })).not.toBeNull();
    expect(screen.queryByText("New session local file")).toBeNull();
    expect(screen.queryByText("Other workspace local file")).toBeNull();

    view.rerender(
      <ComposerDraftProvider storage={null}>
        <BoundSendBox scope={workspaceDraft} onSend={vi.fn()} />
      </ComposerDraftProvider>,
    );
    expect(screen.getByRole("button", {
      name: "移除网页批注引用 New session local file",
    })).not.toBeNull();
    expect(screen.queryByText("Current session local file")).toBeNull();
    expect(screen.queryByText("Other workspace local file")).toBeNull();

    view.rerender(
      <ComposerDraftProvider storage={null}>
        <BoundSendBox scope={otherWorkspaceDraft} onSend={vi.fn()} />
      </ComposerDraftProvider>,
    );
    expect(screen.getByRole("button", {
      name: "移除网页批注引用 Other workspace local file",
    })).not.toBeNull();
    expect(screen.queryByText("New session local file")).toBeNull();
  });

  it("removes a deleted annotation from every unsent composer draft while keeping unrelated references", () => {
    const sessionA = composerSessionDraftScope("session-a");
    const sessionB = composerSessionDraftScope("session-b");
    const view = render(
      <ComposerDraftProvider storage={null}>
        <BoundSendBox scope={sessionA} onSend={vi.fn()} />
      </ComposerDraftProvider>,
    );
    act(() => {
      expect(emitReference(sessionA, "annotation-shared", "Shared A")).toBe("added");
      expect(emitReference(sessionA, "annotation-keep", "Keep A")).toBe("added");
      expect(emitReference(sessionB, "annotation-shared", "Shared B")).toBe("added");
    });

    let removed = 0;
    act(() => {
      removed = emitRemoveWebAnnotationFromComposers("annotation-shared");
    });
    expect(removed).toBe(2);
    expect(screen.queryByText("Shared A")).toBeNull();
    expect(screen.getByRole("button", { name: "移除网页批注引用 Keep A" })).not.toBeNull();

    view.rerender(
      <ComposerDraftProvider storage={null}>
        <BoundSendBox scope={sessionB} onSend={vi.fn()} />
      </ComposerDraftProvider>,
    );
    expect(screen.queryByText("Shared B")).toBeNull();
  });

  it("keeps an HTML source annotation and local rendered-page annotation distinct through send and deletion", () => {
    const onSend = vi.fn().mockReturnValue(false);
    act(() => {
      webAnnotationReferencePresentations.upsert({
        annotationId: "web-local",
        title: "Rendered index",
        summary: "Rendered DOM target",
        bodyMarkdown: "Review rendered output",
        origin: "file://",
        sourceKind: "local_file",
        displayAddress: "D:\\workspace\\index.html",
        updatedAt: "2026-07-22T08:00:00Z",
      });
    });

    render(<DualAnnotationSendBox onSend={onSend} />);

    expect(screen.getByText("HTML 源码批注 · index.html")).not.toBeNull();
    expect(screen.getByLabelText("本地页面批注 · Rendered index，修订 1")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalledWith(
      [expect.objectContaining({
        id: "annotation:workspace-a:source-html",
        path: "index.html",
        annotationReference: expect.objectContaining({ annotationId: "source-html" }),
      })],
      [],
      [],
      {},
      [expect.objectContaining({ annotationId: "web-local" })],
    );

    fireEvent.click(screen.getByRole("button", {
      name: "移除本地页面批注引用 Rendered index",
    }));
    expect(screen.queryByText("本地页面批注 · Rendered index")).toBeNull();
    expect(screen.getByText("HTML 源码批注 · index.html")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "移除文件引用 index.html" }));
    expect(screen.queryByText("HTML 源码批注 · index.html")).toBeNull();
  });
});

function DualAnnotationSendBox({
  onSend,
}: {
  readonly onSend: ReturnType<typeof vi.fn>;
}) {
  const [files, setFiles] = useState<SelectedFile[]>([{
    id: "annotation:workspace-a:source-html",
    path: "index.html",
    name: "index.html",
    type: "file",
    source: "workspace",
    annotationReference: {
      annotationId: "source-html",
      body: "Review source",
      kind: "text",
      path: "index.html",
      workspaceId: "workspace-a",
    },
  }]);
  const [webAnnotations, setWebAnnotations] = useState<SelectedWebAnnotationReference[]>([{
    annotationId: "web-local",
    selectedRevision: 1,
    selectedAt: "2026-07-22T08:00:00Z",
    sourcePanelId: "browser-local",
  }]);
  return (
    <SendBox
      value=""
      selectedFiles={files}
      selectedWebAnnotations={webAnnotations}
      runtimeState="idle"
      canSend={false}
      canStop={false}
      onChange={vi.fn()}
      onSelectedFilesChange={setFiles}
      onSelectedWebAnnotationsChange={setWebAnnotations}
      onSend={onSend}
      onStop={vi.fn()}
    />
  );
}

function BoundSendBox({
  scope,
  onSend,
}: {
  readonly scope: string;
  readonly onSend: ReturnType<typeof vi.fn>;
}) {
  const { draft, setDraft } = useComposerDraft(scope);
  return (
    <SendBox
      value={draft.text}
      selectedWebAnnotations={draft.webAnnotations}
      runtimeState="idle"
      canSend={false}
      canStop={false}
      onChange={(text) => setDraft({ text })}
      onSelectedWebAnnotationsChange={(webAnnotations) => setDraft({ webAnnotations })}
      onSend={onSend}
      onStop={vi.fn()}
    />
  );
}

function emitReference(
  scope: string,
  annotationId: string,
  title: string,
  status?: WebAnnotationVisibleStatus,
  changed = false,
) {
  const reference: SelectedWebAnnotationReference = {
    annotationId,
    selectedRevision: 1,
    selectedAt: "2026-07-22T08:00:00Z",
    sourcePanelId: "browser-1",
  };
  return emitAddWebAnnotationToComposer({
    composerScopeKey: scope,
    reference,
    presentation: {
      annotationId,
      title,
      summary: "Selected text",
      bodyMarkdown: "Review this section",
      origin: "https://example.test",
      status,
      ...(changed ? {
        change: {
          kinds: ["content"] as const,
          materialKinds: ["content"] as const,
          signals: ["quote_changed"],
          material: true,
        },
      } : {}),
      updatedAt: "2026-07-22T08:00:00Z",
    },
  });
}
