import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createPlainTextModel } from "@/renderer/features/annotations/document/PlainTextModel";
import { AnnotationProvider, useAnnotationStore } from "@/renderer/features/annotations/state/AnnotationProvider";
import { createAnnotationStore, emptyResolvedAnnotationIndex } from "@/renderer/features/annotations/state/annotationStore";
import type { TextSelector } from "@/runtime/annotations";

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
