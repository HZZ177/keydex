import { isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { rightSidebarDefinitionRegistry } from "@/renderer/components/layout/rightSidebarRegistry";
import {
  normalizeReviewPanelState,
  reviewPanelCreateInput,
  reviewPanelDefinition,
  serializeReviewPanelState,
} from "@/renderer/components/layout/rightSidebar/panels/review";

const NOW = "2026-07-21T00:00:00.000Z";
const CHANGE = {
  path: "desktop/src/main.tsx",
  additions: 2,
  deletions: 1,
  diff: "@@ -1 +1 @@\n-old\n+new",
  operation: "update" as const,
  source: "final" as const,
};

describe("review right sidebar panel definition", () => {
  it("creates and roundtrips review files and focused path", () => {
    const state = reviewPanelDefinition.create({
      id: "right-sidebar:review:1",
      sequence: 1,
      now: NOW,
      input: reviewPanelCreateInput({
        title: "审阅 main.tsx",
        files: [CHANGE],
        focusedPath: CHANGE.path,
        panelKey: "tool:1",
        sourceMessageId: "message-1",
        toolCallId: "tool-1",
        requestId: 3,
      }),
    });

    expect(state).toMatchObject({
      title: "审阅 main.tsx",
      focusedPath: CHANGE.path,
      panelKey: "tool:1",
      requestId: 3,
    });
    expect(normalizeReviewPanelState(serializeReviewPanelState(state))).toEqual(state);
  });

  it("keeps multiple review instances independent", () => {
    const first = rightSidebarDefinitionRegistry.create("review", {
      id: "right-sidebar:review:1",
      sequence: 1,
      now: NOW,
      input: reviewPanelCreateInput({ panelKey: "review:one", files: [CHANGE] }),
    });
    const second = rightSidebarDefinitionRegistry.create("review", {
      id: "right-sidebar:review:2",
      sequence: 2,
      now: NOW,
      input: reviewPanelCreateInput({ panelKey: "review:two", files: [] }),
    });

    expect(first.id).not.toBe(second.id);
    expect(first.panelKey).toBe("review:one");
    expect(second.panelKey).toBe("review:two");
  });

  it("rejects unknown schemas and runtime-only top-level fields", () => {
    const state = reviewPanelDefinition.create({
      id: "right-sidebar:review:1",
      sequence: 1,
      now: NOW,
      input: reviewPanelCreateInput({ panelKey: "review:one" }),
    });
    const serialized = serializeReviewPanelState(state);

    expect(normalizeReviewPanelState({ ...serialized, schemaVersion: 2 })).toBeNull();
    expect(normalizeReviewPanelState({ ...serialized, renderer: true })).toBeNull();
  });

  it("uses registry presentation and definition-owned rendering", () => {
    const state = rightSidebarDefinitionRegistry.create("review", {
      id: "right-sidebar:review:1",
      sequence: 1,
      now: NOW,
      input: reviewPanelCreateInput({ title: "变更审阅", panelKey: "review:one" }),
    });
    const rendered = rightSidebarDefinitionRegistry.get("review").render({
      active: true,
      scopeKey: "session:main",
      state,
      hostContext: { onOpenFile: vi.fn() },
      updateState: vi.fn(),
    });

    expect(isValidElement(rendered)).toBe(true);
    expect(rightSidebarDefinitionRegistry.getPresentation(state)).toEqual({
      title: "变更审阅",
      icon: "review",
    });
  });
});
