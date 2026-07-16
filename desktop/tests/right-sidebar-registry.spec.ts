import { describe, expect, it } from "vitest";

import {
  RightSidebarPanelRegistry,
  rightSidebarPanelRegistry,
} from "@/renderer/components/layout/rightSidebarRegistry";

describe("right sidebar panel registry", () => {
  it("orders built-ins and gives Git a stable singleton identity", () => {
    expect(rightSidebarPanelRegistry.list().map((definition) => definition.type)).toEqual([
      "conversation",
      "files",
      "review",
      "git",
    ]);
    expect(rightSidebarPanelRegistry.panelId("git", 1)).toBe("right-sidebar:git:singleton");
    expect(rightSidebarPanelRegistry.panelId("git", 99)).toBe("right-sidebar:git:singleton");
  });

  it("resolves panel identity and rejects duplicate or unknown registrations", () => {
    expect(rightSidebarPanelRegistry.resolve("right-sidebar:git:singleton")?.type).toBe("git");
    expect(rightSidebarPanelRegistry.resolve("right-sidebar:unknown:1")).toBeNull();
    expect(() => rightSidebarPanelRegistry.get("missing" as "git")).toThrow("Unknown");

    const registry = new RightSidebarPanelRegistry([rightSidebarPanelRegistry.get("git")]);
    expect(() => registry.register(rightSidebarPanelRegistry.get("git"))).toThrow("already registered");
  });
});
