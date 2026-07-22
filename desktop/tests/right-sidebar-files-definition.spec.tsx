import { isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { rightSidebarDefinitionRegistry } from "@/renderer/components/layout/rightSidebarRegistry";
import {
  filesPanelCreateInput,
  filesPanelDefinition,
  normalizeFilesPanelState,
  serializeFilesPanelState,
} from "@/renderer/components/layout/rightSidebar/panels/files";

const NOW = "2026-07-21T00:00:00.000Z";

describe("files right sidebar panel definition", () => {
  it("creates independent panels for file and directory navigation", () => {
    const first = filesPanelDefinition.create({
      id: "right-sidebar:files:1",
      sequence: 1,
      now: NOW,
      input: filesPanelCreateInput({ path: "README.md", requestId: 7 }),
    });
    const second = filesPanelDefinition.create({
      id: "right-sidebar:files:2",
      sequence: 2,
      now: NOW,
      input: filesPanelCreateInput({ directoryRevealPath: "desktop/src", requestId: 8 }),
    });

    expect(first).toMatchObject({
      id: "right-sidebar:files:1",
      filePreviewPath: "README.md",
      filePreviewRequestId: 7,
    });
    expect(second).toMatchObject({
      id: "right-sidebar:files:2",
      directoryRevealPath: "desktop/src",
      directoryRevealRequestId: 8,
    });
  });

  it("roundtrips the exact persisted contract and rejects unknown fields or schemas", () => {
    const state = filesPanelDefinition.create({
      id: "right-sidebar:files:1",
      sequence: 1,
      now: NOW,
      input: filesPanelCreateInput({
        path: "README.md",
        requestId: 9,
        revealTarget: { selectedText: "Keydex", lineStart: 1, lineEnd: 1 },
      }),
    });
    const serialized = serializeFilesPanelState(state);

    expect(normalizeFilesPanelState(serialized)).toEqual(state);
    expect(normalizeFilesPanelState({ ...serialized, schemaVersion: 2 })).toBeNull();
    expect(normalizeFilesPanelState({ ...serialized, runtime: true })).toBeNull();
  });

  it("provides host presentation, capabilities, and registry-owned rendering", () => {
    const state = rightSidebarDefinitionRegistry.create("files", {
      id: "right-sidebar:files:1",
      sequence: 1,
      now: NOW,
    });
    const rendered = rightSidebarDefinitionRegistry.get("files").render({
      active: true,
      scopeKey: "session:test",
      state,
      hostContext: {
        maximized: false,
        renderContext: {
          workspaceId: "workspace-test",
          runtime: {} as RuntimeBridge,
        },
        onRestore: vi.fn(),
      },
      updateState: vi.fn(),
    });

    expect(isValidElement(rendered)).toBe(true);
    expect(rightSidebarDefinitionRegistry.getPresentation(state)).toEqual({
      title: "文件",
      icon: "folder",
    });
    expect(rightSidebarDefinitionRegistry.getCapabilities(state)).toEqual({
      closable: true,
      duplicable: true,
      persistable: true,
    });
  });
});
