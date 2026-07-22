import { describe, expect, it } from "vitest";

import {
  RIGHT_SIDEBAR_SCOPE_STATE_SCHEMA_VERSION,
  RightSidebarDefinitionRegistry,
  type RightSidebarPanelDefinition,
} from "@/renderer/components/layout/rightSidebarRegistry";

const filesDefinition: RightSidebarPanelDefinition<"files"> = {
  kind: "files",
  schemaVersion: 1,
  label: "文件",
  order: 20,
  multiplicity: "multiple",
  idPrefix: "right-sidebar:files:",
  create(context) {
    return {
      id: context.id,
      kind: "files",
      schemaVersion: 1,
      filePreviewPath: readNullableString(context.input?.filePreviewPath),
      filePreviewRequestId: 0,
      filePreviewRevealTarget: null,
      directoryRevealPath: null,
      directoryRevealRequestId: 0,
      createdAt: context.now,
      lastActivatedAt: context.now,
    };
  },
  normalize(raw) {
    if (!isRecord(raw) || !hasExactKeys(raw, [
      "id",
      "kind",
      "schemaVersion",
      "filePreviewPath",
      "filePreviewRequestId",
      "filePreviewRevealTarget",
      "directoryRevealPath",
      "directoryRevealRequestId",
      "createdAt",
      "lastActivatedAt",
    ])) return null;
    if (raw.kind !== "files" || raw.schemaVersion !== 1) return null;
    if (!isString(raw.id) || !isString(raw.createdAt) || !isString(raw.lastActivatedAt)) return null;
    if (!isNullableString(raw.filePreviewPath) || !isNullableString(raw.directoryRevealPath)) return null;
    if (typeof raw.filePreviewRequestId !== "number" || typeof raw.directoryRevealRequestId !== "number") return null;
    if (raw.filePreviewRevealTarget !== null) return null;
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
    return { title: state.filePreviewPath ?? "文件", icon: "folder" };
  },
  getCapabilities() {
    return { closable: true, duplicable: true, persistable: true };
  },
  render({ state }) {
    return <div>{state.filePreviewPath}</div>;
  },
};

describe("right sidebar definition registry", () => {
  it("requires unique kinds and valid definition metadata", () => {
    const registry = new RightSidebarDefinitionRegistry([filesDefinition]);

    expect(registry.list().map((definition) => definition.kind)).toEqual(["files"]);
    expect(() => registry.register(filesDefinition)).toThrow("already registered");
    expect(() => new RightSidebarDefinitionRegistry([
      { ...filesDefinition, schemaVersion: 0 },
    ])).toThrow("positive schemaVersion");
  });

  it("roundtrips created state through serialize and normalize", () => {
    const registry = new RightSidebarDefinitionRegistry([filesDefinition]);
    const created = registry.create("files", {
      id: "right-sidebar:files:1",
      sequence: 1,
      now: "2026-07-21T00:00:00.000Z",
      input: { filePreviewPath: "README.md" },
    });

    expect(created.filePreviewPath).toBe("README.md");
    const serialized = registry.serializePanel(created);
    expect(registry.normalizePanel(serialized, {
      now: "2026-07-21T00:00:01.000Z",
      source: "persistence",
    })).toEqual(created);
    expect(registry.getPresentation(created)).toEqual({ title: "README.md", icon: "folder" });
  });

  it("rejects unknown schemas and isolates corrupt panels while normalizing a scope", () => {
    const registry = new RightSidebarDefinitionRegistry([filesDefinition]);
    const valid = filesDefinition.create({
      id: "right-sidebar:files:1",
      sequence: 1,
      now: "2026-07-21T00:00:00.000Z",
    });
    const normalized = registry.normalizeScopeState({
      version: RIGHT_SIDEBAR_SCOPE_STATE_SCHEMA_VERSION,
      activePanelId: "right-sidebar:missing:1",
      panelOrder: [
        "right-sidebar:missing:1",
        "right-sidebar:files:1",
        "right-sidebar:files:1",
      ],
      panels: {
        "right-sidebar:files:1": filesDefinition.serialize(valid),
        "right-sidebar:files:2": { ...filesDefinition.serialize(valid), id: "right-sidebar:files:2", runtime: true },
        "right-sidebar:missing:1": { id: "right-sidebar:missing:1", kind: "missing", schemaVersion: 1 },
      },
      nextPanelSeq: 2,
    }, {
      now: "2026-07-21T00:00:01.000Z",
      source: "persistence",
    });

    expect(normalized).toEqual({
      version: RIGHT_SIDEBAR_SCOPE_STATE_SCHEMA_VERSION,
      activePanelId: "right-sidebar:files:1",
      panelOrder: ["right-sidebar:files:1"],
      panels: { "right-sidebar:files:1": valid },
      nextPanelSeq: 2,
    });
    expect(registry.normalizeScopeState({ ...normalized, version: 99 }, {
      now: "2026-07-21T00:00:01.000Z",
      source: "persistence",
    })).toBeNull();
    expect(registry.normalizePanel({ ...valid, schemaVersion: 2 }, {
      now: "2026-07-21T00:00:01.000Z",
      source: "persistence",
    })).toBeNull();
  });

  it("never serializes runtime-only fields accepted outside the normalized state", () => {
    const registry = new RightSidebarDefinitionRegistry([filesDefinition]);
    const raw = {
      ...filesDefinition.create({
        id: "right-sidebar:files:1",
        sequence: 1,
        now: "2026-07-21T00:00:00.000Z",
      }),
      webviewLabel: "must-not-persist",
    };

    expect(registry.normalizePanel(raw, {
      now: "2026-07-21T00:00:01.000Z",
      source: "persistence",
    })).toBeNull();
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
