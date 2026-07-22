import { describe, expect, it, vi } from "vitest";

import {
  RightSidebarDefinitionRegistry,
  emptyRightSidebarScopeStateV2,
  reduceRightSidebarState,
  runRightSidebarLifecycleIntents,
  type RightSidebarPanelDefinition,
} from "@/renderer/components/layout/rightSidebarRegistry";

function definition(
  lifecycle: RightSidebarPanelDefinition<"files">["lifecycle"] = undefined,
): RightSidebarPanelDefinition<"files"> {
  return {
    kind: "files",
    schemaVersion: 1,
    label: "文件",
    order: 10,
    multiplicity: "multiple",
    idPrefix: "right-sidebar:files:",
    create(context) {
      return {
        id: context.id,
        kind: "files",
        schemaVersion: 1,
        filePreviewPath: typeof context.input?.filePreviewPath === "string" ? context.input.filePreviewPath : null,
        filePreviewRequestId: 0,
        filePreviewRevealTarget: null,
        directoryRevealPath: null,
        directoryRevealRequestId: 0,
        createdAt: context.now,
        lastActivatedAt: context.now,
      };
    },
    normalize(raw) {
      if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== [
        "createdAt",
        "directoryRevealRequestId",
        "directoryRevealPath",
        "filePreviewPath",
        "filePreviewRequestId",
        "filePreviewRevealTarget",
        "id",
        "kind",
        "lastActivatedAt",
        "schemaVersion",
      ].sort().join(",")) return null;
      if (raw.kind !== "files" || raw.schemaVersion !== 1) return null;
      if (typeof raw.id !== "string" || typeof raw.createdAt !== "string" || typeof raw.lastActivatedAt !== "string") return null;
      if (raw.filePreviewPath !== null && typeof raw.filePreviewPath !== "string") return null;
      if (typeof raw.filePreviewRequestId !== "number" || typeof raw.directoryRevealRequestId !== "number") return null;
      if (raw.filePreviewRevealTarget !== null) return null;
      if (raw.directoryRevealPath !== null && typeof raw.directoryRevealPath !== "string") return null;
      return {
        id: raw.id,
        kind: "files",
        schemaVersion: 1,
        filePreviewPath: raw.filePreviewPath,
        filePreviewRequestId: raw.filePreviewRequestId,
        filePreviewRevealTarget: null,
        directoryRevealPath: raw.directoryRevealPath,
        directoryRevealRequestId: raw.directoryRevealRequestId,
        createdAt: raw.createdAt,
        lastActivatedAt: raw.lastActivatedAt,
      };
    },
    serialize(state) {
      return {
        id: state.id,
        kind: state.kind,
        schemaVersion: state.schemaVersion,
        filePreviewPath: state.filePreviewPath,
        filePreviewRequestId: state.filePreviewRequestId,
        filePreviewRevealTarget: null,
        directoryRevealPath: state.directoryRevealPath,
        directoryRevealRequestId: state.directoryRevealRequestId,
        createdAt: state.createdAt,
        lastActivatedAt: state.lastActivatedAt,
      };
    },
    getPresentation(state) {
      return { title: state.filePreviewPath ?? "文件" };
    },
    getCapabilities() {
      return { closable: true, duplicable: true, persistable: true };
    },
    render() {
      return null;
    },
    lifecycle,
  };
}

describe("right sidebar reducer", () => {
  it("creates, activates, closes, and destroys in UI-first intent order", () => {
    const registry = new RightSidebarDefinitionRegistry([definition()]);
    const first = reduceRightSidebarState(emptyRightSidebarScopeStateV2(), {
      type: "panel.create",
      kind: "files",
      now: "2026-07-21T00:00:00.000Z",
      input: { filePreviewPath: "one.md" },
    }, registry);
    const second = reduceRightSidebarState(first.state, {
      type: "panel.create",
      kind: "files",
      now: "2026-07-21T00:00:01.000Z",
      input: { filePreviewPath: "two.md" },
    }, registry);

    expect(second.state.activePanelId).toBe("right-sidebar:files:2");
    expect(second.intents.map((intent) => intent.type)).toEqual([
      "panel.deactivate",
      "panel.mount",
      "panel.activate",
    ]);

    const closed = reduceRightSidebarState(second.state, {
      type: "panel.close",
      panelId: "right-sidebar:files:2",
    }, registry);
    expect(closed.state.activePanelId).toBe("right-sidebar:files:1");
    expect(closed.state.panels["right-sidebar:files:2"]).toBeUndefined();
    expect(closed.intents.map((intent) => intent.type)).toEqual([
      "panel.deactivate",
      "panel.destroy",
      "panel.activate",
    ]);
  });

  it("treats duplicate close and empty-state actions as safe no-ops", () => {
    const registry = new RightSidebarDefinitionRegistry([definition()]);
    const empty = emptyRightSidebarScopeStateV2();

    expect(reduceRightSidebarState(empty, {
      type: "panel.close",
      panelId: "missing",
    }, registry)).toEqual({ state: empty, intents: [], warnings: [] });
    expect(reduceRightSidebarState(empty, {
      type: "panel.activate",
      panelId: "missing",
      now: "2026-07-21T00:00:00.000Z",
    }, registry).warnings).toEqual(["missing_panel"]);
  });

  it("reorders panels and canonicalizes replacement scopes", () => {
    const registry = new RightSidebarDefinitionRegistry([definition()]);
    const first = reduceRightSidebarState(emptyRightSidebarScopeStateV2(), {
      type: "panel.create",
      kind: "files",
      now: "2026-07-21T00:00:00.000Z",
    }, registry);
    const second = reduceRightSidebarState(first.state, {
      type: "panel.create",
      kind: "files",
      now: "2026-07-21T00:00:01.000Z",
    }, registry);
    const reordered = reduceRightSidebarState(second.state, {
      type: "panel.reorder",
      panelId: "right-sidebar:files:2",
      toIndex: 0,
    }, registry);
    expect(reordered.state.panelOrder).toEqual([
      "right-sidebar:files:2",
      "right-sidebar:files:1",
    ]);

    const replacement = reduceRightSidebarState(reordered.state, {
      type: "scope.replace",
      raw: {
        ...registry.serializeScopeState(first.state),
        activePanelId: "missing",
        panelOrder: ["right-sidebar:files:1", "right-sidebar:files:1"],
      },
      normalizeContext: {
        now: "2026-07-21T00:00:02.000Z",
        source: "persistence",
      },
    }, registry);
    expect(replacement.state.panelOrder).toEqual(["right-sidebar:files:1"]);
    expect(replacement.state.activePanelId).toBe("right-sidebar:files:1");
    expect(replacement.intents.some((intent) => intent.type === "panel.destroy")).toBe(true);
  });

  it("isolates lifecycle failures and cannot write a destroyed panel back into state", async () => {
    const destroy = vi.fn(async () => {
      throw new Error("native destroy failed");
    });
    const activate = vi.fn(async () => undefined);
    const registry = new RightSidebarDefinitionRegistry([definition({ destroy, activate })]);
    const first = reduceRightSidebarState(emptyRightSidebarScopeStateV2(), {
      type: "panel.create",
      kind: "files",
      now: "2026-07-21T00:00:00.000Z",
    }, registry);
    const second = reduceRightSidebarState(first.state, {
      type: "panel.create",
      kind: "files",
      now: "2026-07-21T00:00:01.000Z",
    }, registry);
    const closed = reduceRightSidebarState(second.state, {
      type: "panel.close",
      panelId: "right-sidebar:files:2",
    }, registry);
    const failures = await runRightSidebarLifecycleIntents(
      closed.intents,
      registry,
      { scopeKey: "session:test" },
    );

    expect(failures).toHaveLength(1);
    expect(failures[0].intent.type).toBe("panel.destroy");
    expect(activate).toHaveBeenCalled();
    expect(closed.state.panels["right-sidebar:files:2"]).toBeUndefined();
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
