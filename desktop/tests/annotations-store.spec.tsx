import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createPlainTextModel } from "@/renderer/features/annotations/document/PlainTextModel";
import { AnnotationProvider, useAnnotationStore } from "@/renderer/features/annotations/state/AnnotationProvider";
import { createAnnotationStore, emptyResolvedAnnotationIndex } from "@/renderer/features/annotations/state/annotationStore";
import type { TextSelector } from "@/runtime/annotations";
import { createTextSelector } from "@/renderer/features/annotations/anchoring/createTextSelector";

describe("AnnotationStore", () => {
  it("isolates every preview instance", () => {
    const first = createAnnotationStore();
    const second = createAnnotationStore();

    first.getState().openPanel();
    first.getState().activate("ann-1");

    expect(first.getState().panelOpen).toBe(true);
    expect(first.getState().activeAnnotationId).toBe("ann-1");
    expect(second.getState().panelOpen).toBe(false);
    expect(second.getState().activeAnnotationId).toBeNull();
  });

  it("moves through named interaction, navigation, and flash transitions", () => {
    const store = createAnnotationStore();
    const selector = textSelector();
    store.getState().beginDraft({ start: 0, end: 5 }, selector);
    store.getState().updateInteractionBody("Draft body");
    store.getState().beginEdit("ann-1", "Body");
    store.getState().updateInteractionBody("Edited");
    store.getState().beginRetarget("ann-1");
    store.getState().setRetargetSelection({ start: 1, end: 3 }, selector);
    const requestId = store.getState().requestNavigation("ann-1");
    store.getState().finishNavigation(requestId);
    store.getState().flash("ann-1");
    store.getState().flash("ann-1");
    store.getState().hover("ann-1");

    expect(store.getState().interaction).toMatchObject({
      type: "retargeting",
      annotationId: "ann-1",
      range: { start: 1, end: 3 },
    });
    expect(store.getState().navigation).toMatchObject({ requestId, status: "ready" });
    expect(store.getState().flashToken).toBe(2);
    expect(store.getState().flashAnnotationId).toBe("ann-1");
    expect(store.getState().hoveredAnnotationId).toBe("ann-1");
  });

  it("switches documents atomically and clears document-scoped state", () => {
    const store = createAnnotationStore();
    store.getState().openPanel();
    store.getState().activate("old");
    store.getState().setError("old error");
    const model = createPlainTextModel("next", "sha256:next");

    store.getState().setDocument({ workspaceId: "ws-2", path: "next.md", model });

    expect(store.getState()).toMatchObject({
      document: { workspaceId: "ws-2", path: "next.md" },
      activeAnnotationId: null,
      error: null,
      hoveredAnnotationId: null,
      interaction: { type: "idle" },
      panelOpen: false,
      records: [],
    });
    expect(store.getState().resolutions).toEqual(emptyResolvedAnnotationIndex());
  });

  it("preserves and rebases a draft when the same document publishes a new revision", () => {
    const store = createAnnotationStore();
    const first = createPlainTextModel("alpha target", "sha256:first");
    store.getState().setDocument({ workspaceId: "ws", path: "README.md", model: first });
    const selector = createTextSelector(first, { start: 0, end: 5 });
    store.getState().beginDraft({ start: 0, end: 5 }, selector);
    store.getState().updateInteractionBody("Keep this draft");
    const next = createPlainTextModel("prefix alpha target", "sha256:next");

    store.getState().setDocument({ workspaceId: "ws", path: "README.md", model: next });

    expect(store.getState().interaction).toMatchObject({
      type: "drafting",
      body: "Keep this draft",
      range: { start: 7, end: 12 },
      selectionStatus: "ready",
      selector: {
        quote: { exact: "alpha" },
        documentRevision: "sha256:next",
      },
    });
    expect(store.getState().panelOpen).toBe(true);
    expect(store.getState().error).toBeNull();
  });

  it("keeps draft text but clears an ambiguous selection until the user selects again", () => {
    const store = createAnnotationStore();
    const first = createPlainTextModel("target", "sha256:first");
    store.getState().setDocument({ workspaceId: "ws", path: "README.md", model: first });
    const ambiguousSelector: TextSelector = {
      ...textSelector(),
      position: { start: 100, end: 106 },
      quote: { exact: "target", prefix: "", suffix: "" },
    };
    store.getState().beginDraft({ start: 0, end: 6 }, ambiguousSelector);
    store.getState().updateInteractionBody("Do not lose me");

    store.getState().setDocument({
      workspaceId: "ws",
      path: "README.md",
      model: createPlainTextModel("target x target", "sha256:next"),
    });

    expect(store.getState().interaction).toEqual({
      type: "drafting",
      body: "Do not lose me",
      range: null,
      selector: null,
      selectionStatus: "ambiguous",
    });
    expect(store.getState().error).toContain("ambiguous");

    const nextModel = store.getState().document!.model;
    const nextSelector = createTextSelector(nextModel, { start: 9, end: 15 });
    store.getState().beginDraft({ start: 9, end: 15 }, nextSelector);
    expect(store.getState().interaction).toMatchObject({
      type: "drafting",
      body: "Do not lose me",
      selectionStatus: "ready",
    });
  });

  it("rebases a pending retarget to a new stable selector on same-document revision", () => {
    const store = createAnnotationStore();
    const first = createPlainTextModel("alpha beta", "sha256:first");
    store.getState().setDocument({ workspaceId: "ws", path: "README.md", model: first });
    store.getState().beginRetarget("ann");
    store.getState().setRetargetSelection(
      { start: 6, end: 10 },
      createTextSelector(first, { start: 6, end: 10 }),
    );
    const next = createPlainTextModel("insert alpha beta", "sha256:next");

    store.getState().setDocument({ workspaceId: "ws", path: "README.md", model: next });

    expect(store.getState().interaction).toMatchObject({
      type: "retargeting",
      annotationId: "ann",
      range: { start: 13, end: 17 },
      selectionStatus: "ready",
      selector: {
        quote: { exact: "beta" },
        documentRevision: "sha256:next",
      },
    });
  });

  it("removes active and flash references when records disappear", () => {
    const store = createAnnotationStore();
    store.getState().activate("missing");
    store.getState().flash("missing");
    store.getState().hover("missing");

    store.getState().setRecords([], emptyResolvedAnnotationIndex("revision"));

    expect(store.getState().activeAnnotationId).toBeNull();
    expect(store.getState().flashAnnotationId).toBeNull();
    expect(store.getState().hoveredAnnotationId).toBeNull();
  });

  it("clears active and flash state when the current annotation is dismissed", () => {
    const store = createAnnotationStore();
    store.getState().activate("ann");
    store.getState().flash("ann");
    store.getState().hover("ann");

    store.getState().activate(null);

    expect(store.getState().activeAnnotationId).toBeNull();
    expect(store.getState().flashAnnotationId).toBeNull();
    expect(store.getState().hoveredAnnotationId).toBeNull();
  });

  it("provides per-provider state and disposes it on unmount", () => {
    const store = createAnnotationStore();
    store.getState().openPanel();
    const view = render(
      <AnnotationProvider store={store}>
        <PanelState />
      </AnnotationProvider>,
    );

    expect(screen.getByText("open")).not.toBeNull();
    view.unmount();
    expect(store.getState().panelOpen).toBe(false);
    expect(store.getState().document).toBeNull();
  });
});

function PanelState() {
  const open = useAnnotationStore((state) => state.panelOpen);
  return <span>{open ? "open" : "closed"}</span>;
}

function textSelector(): TextSelector {
  return {
    position: { start: 0, end: 5 },
    quote: { exact: "alpha", prefix: "", suffix: "" },
    context: { containerType: "source", headingPath: [] },
    textRevision: "text",
    documentRevision: "document",
  };
}
