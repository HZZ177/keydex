import type { BrowserPanelState } from "@/renderer/components/layout/rightSidebar/types";

import type { BrowserSurfaceRef, BrowserVisibilityReason } from "../domain";
import { BROWSER_INTERNAL_BLANK_URL } from "../config";
import { readBrowserOverlayTheme } from "../visualContract";
import { createBrowserRuntimeStore, type BrowserRuntimeStore } from "../state";
import { BrowserHostClient } from "./BrowserHostClient";
import { browserDownloadController } from "./BrowserDownloadController";
import { planBrowserResources } from "./BrowserResourceCoordinator";
import type { BrowserSurfaceResourceState } from "../state/browserRuntimeStore";

interface BrowserResourceEntry {
  readonly panelId: string;
  panel: BrowserPanelState;
  generation: number;
  surface: BrowserSurfaceRef | null;
  active: boolean;
  lastUsed: number;
  state: BrowserSurfaceResourceState;
  readonly protections: Set<string>;
}

export interface BrowserPanelRuntimeClient {
  connect(): Promise<void>;
  subscribe(subscriber: Parameters<BrowserHostClient["subscribe"]>[0]): () => void;
  send: BrowserHostClient["send"];
}

export class BrowserPanelRuntimeController {
  readonly client: BrowserPanelRuntimeClient;
  readonly store: BrowserRuntimeStore;
  readonly #desiredGeneration = new Map<string, number>();
  readonly #lastGeneration = new Map<string, number>();
  readonly #resources = new Map<string, BrowserResourceEntry>();
  readonly #recoveringFailures = new Set<string>();
  #browserCircuitOpen = false;
  #usageClock = 0;
  #connected: Promise<void> | null = null;
  #unlisten: (() => void) | null = null;

  constructor(
    client: BrowserPanelRuntimeClient = new BrowserHostClient(),
    store: BrowserRuntimeStore = createBrowserRuntimeStore(),
  ) {
    this.client = client;
    this.store = store;
  }

  activate(panel: BrowserPanelState): number {
    if (this.#browserCircuitOpen) {
      const generation = this.#lastGeneration.get(panel.id) ?? 1;
      this.store.getState().beginCreate(panel.id, generation, panel.profileMode, panel.restoreUrl);
      this.store.getState().failCommand(panel.id, generation, "浏览器连续崩溃，已停止自动恢复；请重启 Keydex 或清除浏览数据");
      return generation;
    }
    const existing = this.store.getState().surfaces[panel.id];
    if (existing && existing.resourceState !== "discarded") {
      this.#desiredGeneration.set(panel.id, existing.generation);
      const resource = this.#resource(panel.id, existing.generation);
      resource.panel = panel;
      resource.active = true;
      resource.lastUsed = ++this.#usageClock;
      resource.surface = existing.surface;
      void this.#rebalance("panel_activated");
      return existing.generation;
    }
    const generation = (this.#lastGeneration.get(panel.id) ?? 0) + 1;
    this.#lastGeneration.set(panel.id, generation);
    this.#desiredGeneration.set(panel.id, generation);
    this.store.getState().beginCreate(panel.id, generation, panel.profileMode, panel.restoreUrl);
    const resource = this.#resource(panel.id, generation);
    resource.panel = panel;
    resource.active = true;
    resource.lastUsed = ++this.#usageClock;
    resource.surface = null;
    resource.state = "visible";
    void this.#ensureConnected()
      .then(async () => {
        if (this.#desiredGeneration.get(panel.id) !== generation) return;
        await this.client.send("browser_create_surface", {
          panelId: panel.id,
          generation,
          profileMode: panel.profileMode,
          initialUrl: panel.restoreUrl || BROWSER_INTERNAL_BLANK_URL,
        });
      })
      .catch((error: unknown) => {
        this.store.getState().failCommand(panel.id, generation, errorMessage(error));
      });
    return generation;
  }

  deactivate(panelId: string, generation: number): void {
    if (this.#desiredGeneration.get(panelId) !== generation) return;
    const resource = this.#resources.get(panelId);
    if (resource && resource.generation === generation) resource.active = false;
    const runtime = this.store.getState().surfaces[panelId];
    if (!runtime || runtime.generation !== generation) return;
    if (runtime.surface) {
      void this.setVisibility(runtime.surface, false, "inactive_tab");
    }
    void this.#rebalance("panel_deactivated");
  }

  dispose(panelId: string, generation: number): void {
    if (this.#desiredGeneration.get(panelId) !== generation) return;
    this.#desiredGeneration.delete(panelId);
    this.#resources.delete(panelId);
    const runtime = this.store.getState().surfaces[panelId];
    if (!runtime || runtime.generation !== generation) return;
    if (runtime.surface) void this.hideAndDestroy(runtime.surface);
    this.store.getState().forget(panelId, generation);
  }

  releaseIfInactive(surface: BrowserSurfaceRef): void {
    this.setProtection(surface.panelId, "download", false);
  }

  setProtection(panelId: string, reason: string, protectedValue: boolean): void {
    const entry = this.#resources.get(panelId);
    if (!entry) return;
    if (protectedValue) entry.protections.add(reason);
    else entry.protections.delete(reason);
    void this.#rebalance(protectedValue ? `${reason}_protected` : `${reason}_settled`);
  }

  handleMemoryPressure(): void {
    void this.#rebalance("memory_pressure", true);
  }

  async navigate(surface: BrowserSurfaceRef, url: string): Promise<void> {
    await this.client.send("browser_navigate", {
      ...surface,
      navigationId: `navigation-${cryptoId()}`,
      url,
    });
  }

  async setZoom(surface: BrowserSurfaceRef, factor: number): Promise<void> {
    await this.client.send("browser_set_zoom", { ...surface, factor });
  }

  async configureOverlay(
    surface: BrowserSurfaceRef,
    theme: "light" | "dark",
    reducedMotion: boolean,
  ): Promise<void> {
    const overlayTheme = readBrowserOverlayTheme(theme, reducedMotion);
    await this.client.send("browser_configure_overlay", { ...surface, ...overlayTheme });
  }

  async find(surface: BrowserSurfaceRef, query: string, matchCase: boolean, backwards: boolean): Promise<void> {
    await this.client.send("browser_find", { ...surface, query, matchCase, backwards });
  }

  async stopFind(surface: BrowserSurfaceRef): Promise<void> {
    await this.client.send("browser_stop_find", surface);
  }

  async setVisibility(
    surface: BrowserSurfaceRef,
    visible: boolean,
    reason: BrowserVisibilityReason,
  ): Promise<void> {
    await this.client.send("browser_set_visibility", { ...surface, visible, reason });
  }

  async history(surface: BrowserSurfaceRef, action: "back" | "forward" | "reload" | "stop"): Promise<void> {
    if (action === "reload") {
      await this.client.send("browser_reload", { ...surface, mode: "normal" });
      return;
    }
    const command = action === "back"
      ? "browser_go_back"
      : action === "forward"
        ? "browser_go_forward"
        : "browser_stop";
    await this.client.send(command, surface);
  }

  async #ensureConnected(): Promise<void> {
    if (!this.#connected) {
      this.#unlisten = this.client.subscribe((event) => {
        const accepted = this.store.getState().applyEvent(event);
        if (!accepted) return;
        const resource = this.#resources.get(event.panelId);
        if (resource && resource.generation === event.generation) {
          if (event.kind === "surface.ready") {
            resource.surface = {
              panelId: event.panelId,
              surfaceId: event.surfaceId,
              generation: event.generation,
            };
            resource.state = "visible";
            void this.#rebalance("surface_ready");
          } else if (event.kind === "navigation.started") {
            this.setProtection(event.panelId, "navigation", true);
          } else if (event.kind === "navigation.completed" || event.kind === "navigation.failed") {
            this.setProtection(event.panelId, "navigation", false);
          } else if (event.kind === "permission.requested") {
            this.setProtection(event.panelId, "permission", true);
          } else if (event.kind === "permission.expired") {
            this.setProtection(event.panelId, "permission", false);
          } else if (event.kind === "download.requested") {
            this.setProtection(event.panelId, "download", true);
          } else if (event.kind === "download.completed" || event.kind === "download.failed") {
            this.setProtection(event.panelId, "download", false);
          } else if (event.kind === "process.failed") {
            void this.#recoverFromFailure(event);
          }
        }
        if (
          event.kind === "surface.ready"
          && this.#desiredGeneration.get(event.panelId) !== event.generation
        ) {
          const surface = {
            panelId: event.panelId,
            surfaceId: event.surfaceId,
            generation: event.generation,
          };
          void this.hideAndDestroy(surface).finally(() => {
            this.store.getState().forget(event.panelId, event.generation);
          });
        }
      });
      this.#connected = this.client.connect().catch((error) => {
        this.#unlisten?.();
        this.#unlisten = null;
        this.#connected = null;
        throw error;
      });
    }
    return this.#connected;
  }

  private async hideAndDestroy(surface: BrowserSurfaceRef): Promise<void> {
    try {
      await this.client.send("browser_set_visibility", {
        ...surface,
        visible: false,
        reason: "sidebar_closed",
      });
    } catch {
      // Destruction remains mandatory even when an already-closing surface cannot be hidden.
    }
    try {
      await this.client.send("browser_destroy_surface", surface);
    } catch {
      // Host lifecycle remains generation-safe and process-exit cleanup is the final fallback.
    }
  }

  async #rebalance(reason: string, memoryPressure = false): Promise<void> {
    const decisions = planBrowserResources(
      [...this.#resources.values()].flatMap((entry) => entry.surface ? [{
        panelId: entry.panelId,
        surface: entry.surface,
        active: entry.active,
        protected: entry.protections.size > 0 || browserDownloadController.hasWork(entry.surface),
        lastUsed: entry.lastUsed,
      }] : []),
      { memoryPressure },
    );
    for (const decision of decisions) {
      const entry = this.#resources.get(decision.panelId);
      if (!entry || !entry.surface || !sameSurface(entry.surface, decision.surface) || entry.state === decision.next) continue;
      const priorSurface = entry.surface;
      entry.state = decision.next;
      if (decision.next === "discarded") {
        entry.surface = null;
        this.store.getState().discard(entry.panelId, entry.generation);
        void this.hideAndDestroy(priorSurface);
        continue;
      }
      try {
        await this.client.send("browser_set_resource_state", {
          ...priorSurface,
          state: decision.next,
          reason,
        });
        const current = this.#resources.get(entry.panelId);
        if (current && current.generation === entry.generation && current.state === decision.next) {
          this.store.getState().setResourceState(entry.panelId, entry.generation, decision.next);
        }
      } catch (error) {
        this.store.getState().failCommand(
          entry.panelId,
          entry.generation,
          errorMessage(error),
        );
      }
    }
  }

  #resource(panelId: string, generation: number): BrowserResourceEntry {
    const existing = this.#resources.get(panelId);
    if (existing && existing.generation === generation) return existing;
    const entry: BrowserResourceEntry = {
      panelId,
      panel: {
        id: panelId,
        kind: "browser",
        schemaVersion: 1,
        title: "新标签页",
        restoreUrl: "",
        restoreUrlSanitized: false,
        profileMode: "persistent",
        zoomFactor: 1,
        createdAt: new Date(0).toISOString(),
        lastActivatedAt: new Date(0).toISOString(),
      },
      generation,
      surface: null,
      active: false,
      lastUsed: ++this.#usageClock,
      state: "visible",
      protections: new Set(),
    };
    this.#resources.set(panelId, entry);
    return entry;
  }

  async #recoverFromFailure(event: Extract<import("../domain").BrowserEventEnvelope, { kind: "process.failed" }>): Promise<void> {
    const trigger = this.#resources.get(event.panelId);
    if (!trigger || trigger.generation !== event.generation) return;
    const key = event.payload.scope === "browser"
      ? `browser:${trigger.panel.profileMode}`
      : `surface:${event.panelId}:${event.surfaceId}:${event.generation}`;
    if (this.#recoveringFailures.has(key)) return;
    this.#recoveringFailures.add(key);
    try {
      const targets = event.payload.scope === "browser"
        ? [...this.#resources.values()].filter((entry) => entry.panel.profileMode === trigger.panel.profileMode)
        : [trigger];
      const active = targets.filter((entry) => entry.active).sort((left, right) => right.lastUsed - left.lastUsed)[0] ?? null;
      for (const entry of targets) {
        const surface = entry.surface;
        if (!surface) continue;
        entry.protections.clear();
        browserDownloadController.failSurface(surface, event.payload.reasonCategory);
        entry.surface = null;
        entry.state = "discarded";
        this.store.getState().discard(entry.panelId, entry.generation);
        await this.hideAndDestroy(surface);
      }
      if (event.payload.scope === "browser" && event.payload.crashCount >= 3) {
        this.#browserCircuitOpen = true;
        for (const entry of targets) {
          this.store.getState().failCommand(
            entry.panelId,
            entry.generation,
            "浏览器在 5 分钟内连续崩溃 3 次，已停止自动恢复；主任务仍可继续使用",
          );
        }
        return;
      }
      if (active) this.activate(active.panel);
    } finally {
      this.#recoveringFailures.delete(key);
    }
  }
}

export const browserPanelRuntime = new BrowserPanelRuntimeController();
browserDownloadController.start(browserPanelRuntime.client);
browserDownloadController.setSurfaceIdleHandler((surface) => {
  browserPanelRuntime.releaseIfInactive(surface);
});

function cryptoId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "浏览器宿主调用失败";
}

function sameSurface(left: BrowserSurfaceRef, right: BrowserSurfaceRef): boolean {
  return left.panelId === right.panelId
    && left.surfaceId === right.surfaceId
    && left.generation === right.generation;
}
