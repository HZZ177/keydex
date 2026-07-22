import { describe, expect, it, vi } from "vitest";

import type {
  RightSidebarPromotionResponse,
  RightSidebarScopeRecord,
  RuntimeBridge,
} from "@/runtime";
import {
  RightSidebarScopePersistence,
  mergeRightSidebarScopeConflict,
  normalizePersistedRightSidebarState,
  parseRightSidebarScopeKey,
  persistableRightSidebarScopeKey,
  serializePersistableRightSidebarState,
} from "@/renderer/components/layout/rightSidebar/persistence";
import { rightSidebarDefinitionRegistry } from "@/renderer/components/layout/rightSidebarRegistry";
import { filesPanelCreateInput } from "@/renderer/components/layout/rightSidebar/panels/files";
import type {
  FilesPanelState,
  RightSidebarScopeStateV2,
} from "@/renderer/components/layout/rightSidebar/types";

function filesPanel(id: string, lastActivatedAt = "2026-07-21T00:00:00.000Z"): FilesPanelState {
  return {
    ...rightSidebarDefinitionRegistry.create("files", {
      id,
      sequence: 1,
      now: "2026-07-20T00:00:00.000Z",
      input: filesPanelCreateInput(),
    }),
    lastActivatedAt,
  };
}

function scopeState(...panels: FilesPanelState[]): RightSidebarScopeStateV2 {
  return {
    version: 2,
    activePanelId: panels[0]?.id ?? null,
    panelOrder: panels.map((panel) => panel.id),
    panels: Object.fromEntries(panels.map((panel) => [panel.id, panel])),
    nextPanelSeq: panels.length,
  };
}

function record(
  scopeKey: string,
  state: RightSidebarScopeStateV2,
  revision: number,
): RightSidebarScopeRecord<unknown> {
  const scope = parseRightSidebarScopeKey(scopeKey);
  return {
    id: `${scopeKey}:${revision}`,
    scope_kind: scope.kind,
    scope_id: scope.id,
    schema_version: 2,
    state: rightSidebarDefinitionRegistry.serializeScopeState(state),
    revision,
    created_at: "2026-07-21T00:00:00Z",
    updated_at: "2026-07-21T00:00:00Z",
  };
}

describe("right sidebar scope persistence", () => {
  it("parses scope keys and strips preview-only order entries", () => {
    expect(parseRightSidebarScopeKey("global")).toEqual({ kind: "global", id: null });
    expect(parseRightSidebarScopeKey("session:session-1")).toEqual({
      kind: "session",
      id: "session-1",
    });
    expect(() => parseRightSidebarScopeKey("panel:1")).toThrow("Invalid");
    expect(persistableRightSidebarScopeKey("workbench:workspace-1")).toBeNull();
    expect(persistableRightSidebarScopeKey(" workspace:workspace-1 ")).toBe("workspace:workspace-1");

    const panel = filesPanel("files-1");
    const serialized = serializePersistableRightSidebarState({
      ...scopeState(panel),
      activePanelId: "preview-1",
      panelOrder: ["preview-1", panel.id],
    });
    expect(serialized.panelOrder).toEqual([panel.id]);
    expect(serialized.activePanelId).toBe(panel.id);
  });

  it("isolates corrupt and unknown panels while restoring a V2 document", () => {
    const valid = filesPanel("files-1");
    const restored = normalizePersistedRightSidebarState({
      version: 2,
      activePanelId: "unknown-1",
      panelOrder: ["unknown-1", valid.id, "broken-1"],
      panels: {
        "unknown-1": { id: "unknown-1", kind: "unknown", schemaVersion: 1 },
        [valid.id]: valid,
        "broken-1": { id: "different-id", kind: "files", schemaVersion: 1 },
      },
      nextPanelSeq: 3,
    });
    expect(restored?.panelOrder).toEqual([valid.id]);
    expect(restored?.activePanelId).toBe(valid.id);
  });

  it("treats a successful null response as an empty scope", async () => {
    const get = vi.fn().mockResolvedValue(null);
    const persistence = new RightSidebarScopePersistence({
      rightSidebar: { get },
    } as unknown as RuntimeBridge);

    const first = await persistence.load("global");
    const cached = await persistence.load("global");

    expect(first).toEqual({ exists: false, revision: 0, state: scopeState() });
    expect(cached).toEqual(first);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("merges concurrent edits deterministically and lets an explicit local close win", () => {
    const original = filesPanel("files-1", "2026-07-21T00:00:00.000Z");
    const remoteChanged = filesPanel("files-1", "2026-07-21T00:02:00.000Z");
    const remoteAdded = filesPanel("files-2", "2026-07-21T00:03:00.000Z");
    const merged = mergeRightSidebarScopeConflict(
      scopeState(original),
      scopeState(),
      scopeState(remoteChanged, remoteAdded),
    );
    expect(merged.panelOrder).toEqual([remoteAdded.id]);
    expect(merged.panels[original.id]).toBeUndefined();
  });

  it("retries a concurrent PUT against the latest revision", async () => {
    const base = scopeState(filesPanel("files-1"));
    const local = scopeState(filesPanel("files-1", "2026-07-21T00:02:00.000Z"));
    const remote = scopeState(filesPanel("files-2", "2026-07-21T00:01:00.000Z"));
    const conflict = Object.assign(new Error("conflict"), { status: 409, code: "conflict" });
    Object.setPrototypeOf(conflict, (await import("@/runtime")).RuntimeHttpError.prototype);
    const put = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce((_scope, state, expectedRevision) =>
        Promise.resolve(record("workspace:workspace-1", state, expectedRevision + 1)),
      );
    const runtime = {
      rightSidebar: {
        get: vi.fn().mockResolvedValueOnce(record("workspace:workspace-1", base, 1))
          .mockResolvedValueOnce(record("workspace:workspace-1", remote, 2)),
        put,
      },
    } as unknown as RuntimeBridge;
    const persistence = new RightSidebarScopePersistence(runtime);

    await persistence.load("workspace:workspace-1");
    persistence.queueSave("workspace:workspace-1", local);
    const saved = await persistence.flush("workspace:workspace-1");

    expect(put).toHaveBeenNthCalledWith(1, { kind: "workspace", id: "workspace-1" }, local, 1);
    expect(put).toHaveBeenNthCalledWith(
      2,
      { kind: "workspace", id: "workspace-1" },
      expect.objectContaining({ panelOrder: ["files-1", "files-2"] }),
      2,
    );
    expect(saved.revision).toBe(3);
  });

  it("flushes before promotion and installs the returned session snapshot", async () => {
    const source = scopeState(filesPanel("files-1"));
    const target = scopeState(filesPanel("files-2"));
    const promotion: RightSidebarPromotionResponse<unknown> = {
      source_scope_kind: "workspace",
      source_scope_id: "workspace-1",
      source_revision: 1,
      target_session_id: "session-1",
      target: record("session:session-1", target, 1),
      panel_id_mapping: { "files-1": "files-2" },
      idempotent_replay: false,
    };
    const promote = vi.fn().mockResolvedValue(promotion);
    const runtime = {
      rightSidebar: {
        get: vi.fn().mockResolvedValue(record("workspace:workspace-1", source, 1)),
        put: vi.fn(),
        promote,
      },
    } as unknown as RuntimeBridge;
    const persistence = new RightSidebarScopePersistence(runtime);

    await persistence.promote("workspace:workspace-1", "session-1");
    const restored = await persistence.load("session:session-1");
    const repeated = await persistence.promote("workspace:workspace-1", "session-1");

    expect(promote).toHaveBeenCalledWith(expect.objectContaining({ source_revision: 1 }));
    expect(restored.state.panelOrder).toEqual(["files-2"]);
    expect(repeated).toBeNull();
  });

  it("keeps late scope loads isolated during rapid task switching", async () => {
    const deferred: {
      resolve(value: RightSidebarScopeRecord<unknown>): void;
    } = {
      resolve: () => undefined,
    };
    const firstLoad = new Promise<RightSidebarScopeRecord<unknown>>((resolve) => {
      deferred.resolve = resolve;
    });
    const firstState = scopeState(filesPanel("files-session-1"));
    const secondState = scopeState(filesPanel("files-session-2"));
    const get = vi.fn().mockImplementation((scope: { id: string | null }) =>
      scope.id === "session-1"
        ? firstLoad
        : Promise.resolve(record("session:session-2", secondState, 2)),
    );
    const persistence = new RightSidebarScopePersistence({
      rightSidebar: { get },
    } as unknown as RuntimeBridge);

    const staleRequest = persistence.load("session:session-1");
    const activeRequest = persistence.load("session:session-2");
    deferred.resolve(record("session:session-1", firstState, 1));

    const [stale, active] = await Promise.all([staleRequest, activeRequest]);
    expect(stale.state.panelOrder).toEqual(["files-session-1"]);
    expect(active.state.panelOrder).toEqual(["files-session-2"]);
    expect((await persistence.load("session:session-2")).revision).toBe(2);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
