import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_START_URL,
  browserAnnotationComposerScopeKey,
  browserPanelCreateInput,
  normalizeBrowserPanelState,
  serializeBrowserPanelState,
} from "@/renderer/components/layout/rightSidebar/panels/browser";
import { serializePersistableRightSidebarState } from "@/renderer/components/layout/rightSidebar/persistence";
import {
  createRightSidebarDefinitionRegistry,
  rightSidebarDefinitionRegistry,
} from "@/renderer/components/layout/rightSidebarRegistry";
import type { BrowserEventEnvelope } from "@/renderer/features/browser/domain";
import {
  browserRuntimePanelId,
  BrowserPanelRuntimeController,
} from "@/renderer/features/browser/runtime/BrowserPanelRuntime";
import { BROWSER_INTERNAL_BLANK_URL } from "@/renderer/features/browser/config";
import { createBrowserRuntimeStore } from "@/renderer/features/browser/state";

const NOW = "2026-07-21T00:00:00.000Z";

function event(
  panelId: string,
  generation: number,
  surfaceId: string,
): BrowserEventEnvelope<"surface.ready"> {
  return {
    schemaVersion: 1,
    kind: "surface.ready",
    panelId,
    surfaceId,
    generation,
    sequence: 1,
    occurredAt: NOW,
    payload: { profileMode: "persistent", capabilities: [] },
  };
}

describe("browser right-sidebar definition", () => {
  it("maps the active browser scope to the current Agent composer capsule scope", () => {
    expect(browserAnnotationComposerScopeKey("session:session-a")).toBe("session:session-a");
    expect(browserAnnotationComposerScopeKey("workspace:workspace-a")).toBe("new-workspace:workspace-a");
    expect(browserAnnotationComposerScopeKey("global")).toBe("new-chat");
    expect(browserAnnotationComposerScopeKey("workspace:")).toBeNull();
  });

  it("isolates native browser resources that reuse the same panel id in different session scopes", () => {
    const first = browserRuntimePanelId("session:session-a", "right-sidebar:browser:1");
    const second = browserRuntimePanelId("session:session-b", "right-sidebar:browser:1");

    expect(first).not.toBe(second);
    expect(first).toBe(browserRuntimePanelId("session:session-a", "right-sidebar:browser:1"));
  });

  it("registers the browser only when the product flag is enabled", () => {
    expect(createRightSidebarDefinitionRegistry(true).list().map((item) => item.kind)).toContain("browser");
    expect(createRightSidebarDefinitionRegistry(false).list().map((item) => item.kind)).not.toContain("browser");
  });

  it("roundtrips safe restore metadata and strips sensitive URL parameters", () => {
    const created = rightSidebarDefinitionRegistry.create("browser", {
      id: "right-sidebar:browser:1",
      sequence: 1,
      now: NOW,
      input: browserPanelCreateInput({ restoreUrl: "https://example.com/callback?token=secret&view=1" }),
    });
    expect(created.restoreUrl).toBe("https://example.com/callback?view=1");
    const serialized = serializeBrowserPanelState(created);
    expect(normalizeBrowserPanelState(serialized)).toEqual(created);
    expect(serialized).not.toHaveProperty("surfaceId");
    expect(serialized).not.toHaveProperty("loading");
  });

  it("persists ordered normal tabs but never an incognito tab", () => {
    const persistent = rightSidebarDefinitionRegistry.create("browser", {
      id: "right-sidebar:browser:1", sequence: 1, now: NOW,
    });
    const incognito = rightSidebarDefinitionRegistry.create("browser", {
      id: "right-sidebar:browser:2", sequence: 2, now: NOW,
      input: browserPanelCreateInput({ profileMode: "incognito" }),
    });
    const serialized = serializePersistableRightSidebarState({
      version: 2,
      activePanelId: incognito.id,
      panelOrder: [persistent.id, incognito.id],
      panels: { [persistent.id]: persistent, [incognito.id]: incognito },
      nextPanelSeq: 2,
    });
    expect(serialized.panelOrder).toEqual([persistent.id]);
    expect(serialized.activePanelId).toBe(persistent.id);
  });

  it("creates a new tab with an empty address while bootstrapping the native surface with about:blank", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, requestId: "request" });
    const created = rightSidebarDefinitionRegistry.create("browser", {
      id: "right-sidebar:browser:blank", sequence: 1, now: NOW,
    });
    const controller = new BrowserPanelRuntimeController({
      connect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(() => vi.fn()),
      send,
    } as never, createBrowserRuntimeStore());

    expect(created.title).toBe("新标签页");
    expect(created.restoreUrl).toBe("");
    const serialized = serializeBrowserPanelState(created);
    expect(serialized.restoreUrl).toBe(BROWSER_INTERNAL_BLANK_URL);
    expect(normalizeBrowserPanelState(serialized)).toEqual(created);

    controller.activate(created);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("browser_create_surface", expect.objectContaining({
      initialUrl: BROWSER_INTERNAL_BLANK_URL,
    })));
  });

  it("rejects POST-like or internal restore schemes", () => {
    const created = rightSidebarDefinitionRegistry.create("browser", {
      id: "right-sidebar:browser:1", sequence: 1, now: NOW,
    });
    expect(normalizeBrowserPanelState({
      ...serializeBrowserPanelState(created),
      restoreUrl: "file:///C:/secret.txt",
    })).toBeNull();
    expect(created.restoreUrl).toBe(BROWSER_START_URL);
  });

  it("caps restored browser metadata at the centralized 20-panel limit", () => {
    const created = Array.from({ length: 21 }, (_, index) => rightSidebarDefinitionRegistry.create("browser", {
      id: `right-sidebar:browser:${index + 1}`,
      sequence: index + 1,
      now: NOW,
    }));
    const panelOrder = created.map((panel) => panel.id);
    const normalized = rightSidebarDefinitionRegistry.normalizeScopeState({
      version: 2,
      activePanelId: panelOrder[20],
      panelOrder,
      panels: Object.fromEntries(created.map((panel) => [panel.id, panel])),
      nextPanelSeq: 21,
    }, { now: NOW, source: "persistence" });
    expect(normalized?.panelOrder).toHaveLength(20);
    expect(normalized?.panels[panelOrder[20]]).toBeUndefined();
    expect(normalized?.activePanelId).toBe(panelOrder[0]);
  });
});

describe("BrowserPanelRuntimeController", () => {
  it("warms a deactivated panel, reuses its surface on return, and destroys it only on explicit disposal", async () => {
    let subscriber: ((event: BrowserEventEnvelope) => void) | null = null;
    const send = vi.fn().mockResolvedValue({ ok: true, requestId: "request" });
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn((next: (event: BrowserEventEnvelope) => void) => {
        subscriber = next;
        return vi.fn();
      }),
      send,
    };
    const controller = new BrowserPanelRuntimeController(client as never, createBrowserRuntimeStore());
    const panel = rightSidebarDefinitionRegistry.create("browser", {
      id: "right-sidebar:browser:1", sequence: 1, now: NOW,
    });
    const generation = controller.activate(panel, "dark");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("browser_create_surface", {
      panelId: panel.id,
      generation,
      profileMode: "persistent",
      initialUrl: BROWSER_INTERNAL_BLANK_URL,
      theme: "dark",
      backgroundColor: { red: 40, green: 42, blue: 54, alpha: 255 },
    }));
    (subscriber as ((event: BrowserEventEnvelope) => void) | null)?.(
      event(panel.id, generation, "surface-1"),
    );
    controller.deactivate(panel.id, generation);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("browser_set_resource_state", expect.objectContaining({
      panelId: panel.id,
      surfaceId: "surface-1",
      generation,
      state: "warm",
    })));
    expect(send).toHaveBeenCalledWith("browser_set_visibility", expect.objectContaining({
      panelId: panel.id,
      visible: false,
      reason: "inactive_tab",
    }));
    expect(send).not.toHaveBeenCalledWith("browser_destroy_surface", expect.anything());

    send.mockClear();
    expect(controller.activate(panel, "dark")).toBe(generation);
    expect(controller.store.getState().surfaces[panel.id]?.resourceState).toBe("visible");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("browser_set_resource_state", expect.objectContaining({
      panelId: panel.id,
      surfaceId: "surface-1",
      generation,
      state: "visible",
    })));
    expect(send).not.toHaveBeenCalledWith("browser_create_surface", expect.anything());
    expect(send).not.toHaveBeenCalledWith("browser_destroy_surface", expect.anything());
    expect(send).not.toHaveBeenCalledWith("browser_navigate", expect.anything());
    expect(send).not.toHaveBeenCalledWith("browser_reload", expect.anything());

    controller.disposeCurrent(panel.id);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("browser_destroy_surface", {
      panelId: panel.id,
      surfaceId: "surface-1",
      generation,
    }));
  });

  it("serializes a rapid deactivate/reactivate so a stale warm transition cannot hide the active tab", async () => {
    let subscriber: ((event: BrowserEventEnvelope) => void) | null = null;
    let releaseWarm: () => void = () => undefined;
    let markWarmStarted: () => void = () => undefined;
    const warmStarted = new Promise<void>((resolve) => { markWarmStarted = resolve; });
    const transitionOrder: string[] = [];
    const send = vi.fn(async (command: string, payload: unknown) => {
      const input = payload as { state?: string; visible?: boolean };
      if (command === "browser_set_resource_state" && input.state === "warm") {
        transitionOrder.push("warm:start");
        markWarmStarted();
        await new Promise<void>((resolve) => { releaseWarm = resolve; });
        transitionOrder.push("warm:finish");
      } else if (command === "browser_set_resource_state" && input.state === "visible") {
        transitionOrder.push("visible");
      } else if (command === "browser_set_visibility" && input.visible === true) {
        transitionOrder.push("show");
      }
      return { ok: true, requestId: "request" };
    });
    const controller = new BrowserPanelRuntimeController({
      connect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn((next: (event: BrowserEventEnvelope) => void) => {
        subscriber = next;
        return vi.fn();
      }),
      send,
    } as never, createBrowserRuntimeStore());
    const panel = rightSidebarDefinitionRegistry.create("browser", {
      id: "right-sidebar:browser:1", sequence: 1, now: NOW,
    });
    const generation = controller.activate(panel);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(
      "browser_create_surface",
      expect.objectContaining({ panelId: panel.id, generation }),
    ));
    (subscriber as ((event: BrowserEventEnvelope) => void) | null)?.(
      event(panel.id, generation, "surface-1"),
    );

    controller.deactivate(panel.id, generation);
    await warmStarted;
    expect(controller.activate(panel)).toBe(generation);
    const shown = controller.setVisibility({
      panelId: panel.id,
      surfaceId: "surface-1",
      generation,
    }, true, "active");

    await Promise.resolve();
    expect(transitionOrder).toEqual(["warm:start"]);

    releaseWarm();
    await shown;
    expect(transitionOrder).toEqual(["warm:start", "warm:finish", "visible", "show"]);
  });

  it("does not create a surface when scope deactivates before the host connects", async () => {
    let resolveConnect: () => void = () => undefined;
    const connect = new Promise<void>((resolve) => { resolveConnect = resolve; });
    const send = vi.fn();
    const controller = new BrowserPanelRuntimeController({
      connect: () => connect,
      subscribe: () => vi.fn(),
      send,
    } as never, createBrowserRuntimeStore());
    const panel = rightSidebarDefinitionRegistry.create("browser", {
      id: "right-sidebar:browser:1", sequence: 1, now: NOW,
    });
    const generation = controller.activate(panel);
    controller.deactivate(panel.id, generation);
    resolveConnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });
});
