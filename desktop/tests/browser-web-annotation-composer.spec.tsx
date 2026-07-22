import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SendBox } from "@/renderer/components/chat/SendBox";
import { emitAddWebAnnotationToComposer } from "@/renderer/events/webAnnotationContext";
import {
  webAnnotationReferencePresentations,
  type SelectedWebAnnotationReference,
  type WebAnnotationVisibleStatus,
} from "@/renderer/features/browser/annotations";
import {
  ComposerDraftProvider,
  composerSessionDraftScope,
  useComposerDraft,
} from "@/renderer/features/composer";

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
      firstResult = emitReference(scope, "annotation-1", "Article one", "changed");
    });
    expect(firstResult).toBe("added");
    expect(screen.getByRole("button", { name: "移除网页批注引用 Article one" })).not.toBeNull();
    expect(screen.getByRole("status", { name: "网页内容已变化，发送时将保留原始与当前引用" })).not.toBeNull();

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
});

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
      updatedAt: "2026-07-22T08:00:00Z",
    },
  });
}
