import { describe, expect, it } from "vitest";

import { normalizeRightSidebarScopePanelState } from "@/renderer/components/layout/Layout";
import {
  panelIdsByKind,
  panelRecordByKind,
  previewScopePanelIds,
  removeRegisteredPanels,
  replaceRegisteredPanel,
  type PreviewScopePanelState,
} from "@/renderer/components/layout/rightSidebar/scopeAdapter";
import { filesPanelCreateInput } from "@/renderer/components/layout/rightSidebar/panels/files";
import { reviewPanelCreateInput } from "@/renderer/components/layout/rightSidebar/panels/review";
import { rightSidebarDefinitionRegistry } from "@/renderer/components/layout/rightSidebarRegistry";

const NOW = "2026-07-21T00:00:00.000Z";

function scope(): PreviewScopePanelState {
  const files = rightSidebarDefinitionRegistry.create("files", {
    id: "right-sidebar:files:1",
    sequence: 1,
    now: NOW,
    input: filesPanelCreateInput({ path: "README.md" }),
  });
  const review = rightSidebarDefinitionRegistry.create("review", {
    id: "right-sidebar:review:2",
    sequence: 2,
    now: NOW,
    input: reviewPanelCreateInput({ panelKey: "manual" }),
  });
  return {
    version: 2,
    activePanelId: files.id,
    panelOrder: [files.id, "preview:one", review.id, "initial:3"],
    panels: { [files.id]: files, [review.id]: review },
    initialPanelIds: ["initial:3"],
    nextPanelSeq: 3,
  };
}

describe("right sidebar preview scope adapter", () => {
  it("selects typed panels without storing per-kind records", () => {
    const state = scope();

    expect(panelIdsByKind(state, "files")).toEqual(["right-sidebar:files:1"]);
    expect(Object.keys(panelRecordByKind(state, "review"))).toEqual(["right-sidebar:review:2"]);
    expect(Object.keys(state)).not.toContain("filePanels");
    expect(Object.keys(state)).not.toContain("reviewPanels");
  });

  it("merges PreviewProvider entries and initial tabs in stable scope order", () => {
    expect(previewScopePanelIds(scope(), ["preview:one", "preview:two"])).toEqual([
      "right-sidebar:files:1",
      "preview:one",
      "right-sidebar:review:2",
      "initial:3",
      "preview:two",
    ]);
  });

  it("updates and removes registered panels atomically", () => {
    const state = scope();
    const file = panelRecordByKind(state, "files")["right-sidebar:files:1"];
    const updated = replaceRegisteredPanel(state, { ...file, filePreviewPath: "desktop/README.md" });
    const removed = removeRegisteredPanels(updated, new Set([file.id]));

    expect(panelRecordByKind(updated, "files")[file.id].filePreviewPath).toBe("desktop/README.md");
    expect(removed.panels[file.id]).toBeUndefined();
    expect(removed.activePanelId).toBe("preview:one");
  });

  it("migrates V1 files, conversation, and review records into one V2 panel map", () => {
    const migrated = normalizeRightSidebarScopePanelState({
      activePanelId: "right-sidebar:conversation:2",
      panelOrder: [
        "right-sidebar:files:1",
        "right-sidebar:conversation:2",
        "right-sidebar:review:3",
      ],
      filePanelIds: ["right-sidebar:files:1"],
      filePanels: {
        "right-sidebar:files:1": {
          id: "right-sidebar:files:1",
          filePreviewPath: "README.md",
          filePreviewRequestId: 1,
        },
      },
      conversationPanelIds: ["right-sidebar:conversation:2"],
      conversationPanels: {
        "right-sidebar:conversation:2": {
          id: "right-sidebar:conversation:2",
          kind: "conversation",
          status: "ready",
          sessionId: "session-btw",
          title: "旁路对话",
        },
      },
      reviewPanelIds: ["right-sidebar:review:3"],
      reviewPanels: {
        "right-sidebar:review:3": {
          id: "right-sidebar:review:3",
          title: "审阅",
          panelKey: "manual",
          files: [],
          requestId: 1,
        },
      },
      initialPanelIds: [],
      nextPanelSeq: 3,
    });

    expect(migrated.version).toBe(2);
    expect(Object.values(migrated.panels).map((panel) => panel.kind)).toEqual([
      "files",
      "conversation",
      "review",
    ]);
    expect(migrated.activePanelId).toBe("right-sidebar:conversation:2");
  });

  it("isolates corrupt legacy panels, duplicate ids, and unknown kinds", () => {
    const migrated = normalizeRightSidebarScopePanelState({
      activePanelId: "unknown-1",
      panelOrder: ["unknown-1", "right-sidebar:files:1", "right-sidebar:files:1"],
      filePanelIds: ["right-sidebar:files:1", "right-sidebar:files:broken"],
      filePanels: {
        "right-sidebar:files:1": {
          id: "right-sidebar:files:1",
          filePreviewPath: "README.md",
        },
        "right-sidebar:files:broken": {
          id: "different-id",
          filePreviewPath: "broken.md",
        },
      },
      panels: {
        "unknown-1": {
          id: "unknown-1",
          kind: "unknown",
          schemaVersion: 1,
        },
      } as never,
      initialPanelIds: [],
    });

    expect(migrated.panelOrder).toEqual(["right-sidebar:files:1"]);
    expect(Object.keys(migrated.panels)).toEqual(["right-sidebar:files:1"]);
    expect(migrated.activePanelId).toBe("right-sidebar:files:1");
    expect(normalizeRightSidebarScopePanelState(null)).toMatchObject({
      activePanelId: null,
      panelOrder: [],
      panels: {},
    });
  });
});
