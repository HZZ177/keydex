import { describe, expect, it } from "vitest";

import {
  RightSidebarPanelRegistry,
  rightSidebarPanelRegistry,
} from "@/renderer/components/layout/rightSidebarRegistry";

describe("right sidebar panel registry", () => {
  it("orders only the content panels that still belong to the right sidebar", () => {
    expect(rightSidebarPanelRegistry.list().map((definition) => definition.type)).toEqual([
      "conversation",
      "files",
      "review",
    ]);
    expect(rightSidebarPanelRegistry.panelId("files", 1)).toBe("right-sidebar:files:1");
    expect(rightSidebarPanelRegistry.panelId("files", 2)).toBe("right-sidebar:files:2");
  });

  it("resolves panel identity and rejects duplicate or unknown registrations", () => {
    expect(rightSidebarPanelRegistry.resolve("right-sidebar:review:1")?.type).toBe("review");
    expect(rightSidebarPanelRegistry.resolve("right-sidebar:git:singleton")).toBeNull();
    expect(rightSidebarPanelRegistry.resolve("right-sidebar:unknown:1")).toBeNull();
    expect(() => rightSidebarPanelRegistry.get("missing" as "review")).toThrow("Unknown");

    const registry = new RightSidebarPanelRegistry([rightSidebarPanelRegistry.get("review")]);
    expect(() => registry.register(rightSidebarPanelRegistry.get("review"))).toThrow("already registered");
  });
});
