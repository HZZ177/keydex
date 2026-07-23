import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ComposerDraftProvider,
  composerSessionDraftScope,
  useComposerDraft,
} from "@/renderer/features/composer";
import { emitLifecycleEvent } from "@/renderer/events/lifecycleEvents";
import {
  emitAddWebAnnotationToComposer,
  emitRemoveWebAnnotationFromComposers,
} from "@/renderer/events/webAnnotationContext";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("ComposerDraftProvider", () => {
  it("restores a draft after the provider is unmounted and recreated", () => {
    const storage = new MemoryStorage();
    const scope = composerSessionDraftScope("ses-restart");
    const first = render(
      <ComposerDraftProvider storage={storage} persistDelayMs={0}>
        <DraftInput scope={scope} />
      </ComposerDraftProvider>,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "应用重启后继续" } });
    first.unmount();

    render(
      <ComposerDraftProvider storage={storage} persistDelayMs={0}>
        <DraftInput scope={scope} />
      </ComposerDraftProvider>,
    );

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("应用重启后继续");
  });

  it("removes a persisted session draft when that session is purged", () => {
    const storage = new MemoryStorage();
    const scope = composerSessionDraftScope("ses-purged");
    render(
      <ComposerDraftProvider storage={storage} persistDelayMs={0}>
        <DraftInput scope={scope} />
      </ComposerDraftProvider>,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "待清理草稿" } });

    act(() => {
      emitLifecycleEvent({ type: "session_purged", session_id: "ses-purged" });
    });

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
  });

  it("removes a deleted web annotation capsule from the unsent composer draft", () => {
    const scope = composerSessionDraftScope("ses-web-annotation");
    render(
      <ComposerDraftProvider storage={null}>
        <DraftAnnotationCount scope={scope} />
      </ComposerDraftProvider>,
    );

    act(() => {
      expect(emitAddWebAnnotationToComposer({
        composerScopeKey: scope,
        reference: {
          annotationId: "annotation-delete",
          selectedRevision: 1,
          selectedAt: "2026-07-23T00:00:00.000Z",
          sourcePanelId: "browser-1",
        },
        presentation: {
          annotationId: "annotation-delete",
          title: "Page",
          summary: "Selected element",
          bodyMarkdown: "Delete me",
          origin: "https://example.test",
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
      })).toBe("added");
    });
    expect(screen.getByTestId("annotation-count").textContent).toBe("1");

    let removedCount = 0;
    act(() => {
      removedCount = emitRemoveWebAnnotationFromComposers("annotation-delete");
    });

    expect(removedCount).toBe(1);
    expect(screen.getByTestId("annotation-count").textContent).toBe("0");
  });
});

function DraftInput({ scope }: { scope: string }) {
  const binding = useComposerDraft(scope);
  return (
    <input
      aria-label="draft"
      value={binding.draft.text}
      onChange={(event) => binding.setText(event.currentTarget.value)}
    />
  );
}

function DraftAnnotationCount({ scope }: { scope: string }) {
  const binding = useComposerDraft(scope);
  return <output data-testid="annotation-count">{binding.draft.webAnnotations.length}</output>;
}
