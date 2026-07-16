import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ComposerDraftProvider,
  composerSessionDraftScope,
  useComposerDraft,
} from "@/renderer/features/composer";
import { emitLifecycleEvent } from "@/renderer/events/lifecycleEvents";

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
