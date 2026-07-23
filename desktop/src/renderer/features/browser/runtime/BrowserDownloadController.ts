import { createStore, type StoreApi } from "zustand/vanilla";

import type { BrowserEventEnvelope, BrowserSurfaceRef } from "../domain";
import type { BrowserHostClient } from "./BrowserHostClient";

export type BrowserDownloadState =
  | "requested"
  | "downloading"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface BrowserDownloadItem {
  readonly id: string;
  readonly surface: BrowserSurfaceRef;
  readonly url: string;
  readonly filename: string;
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
  readonly state: BrowserDownloadState;
  readonly errorCategory: string | null;
  readonly dangerous: boolean;
  readonly filePath: string | null;
}

interface BrowserDownloadRuntimeState {
  readonly items: Readonly<Record<string, BrowserDownloadItem | undefined>>;
}

export class BrowserDownloadController {
  readonly store: StoreApi<BrowserDownloadRuntimeState> = createStore(() => ({ items: {} }));
  readonly #pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #progressTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #client: Pick<BrowserHostClient, "send" | "subscribe"> | null = null;
  #unsubscribe: (() => void) | null = null;
  #onSurfaceIdle: ((surface: BrowserSurfaceRef) => void) | null = null;

  start(client: Pick<BrowserHostClient, "send" | "subscribe">): void {
    if (this.#unsubscribe) return;
    this.#client = client;
    this.#unsubscribe = client.subscribe((event) => this.#handle(event));
  }

  setSurfaceIdleHandler(handler: (surface: BrowserSurfaceRef) => void): void {
    this.#onSurfaceIdle = handler;
  }

  hasWork(surface: BrowserSurfaceRef): boolean {
    return Object.values(this.store.getState().items).some((item) =>
      item
      && item.surface.panelId === surface.panelId
      && item.surface.surfaceId === surface.surfaceId
      && item.surface.generation === surface.generation
      && (item.state === "requested" || item.state === "downloading" || item.state === "paused"));
  }

  failSurface(surface: BrowserSurfaceRef, errorCategory = "process_failed"): void {
    const failedIds = Object.values(this.store.getState().items).flatMap((item) =>
      item
        && sameSurface(item.surface, surface)
        && (item.state === "requested" || item.state === "downloading" || item.state === "paused")
        ? [item.id]
        : [],
    );
    if (failedIds.length === 0) return;
    for (const id of failedIds) this.#clearTimers(id);
    const failed = new Set(failedIds);
    this.store.setState((state) => ({
      items: Object.fromEntries(Object.entries(state.items).map(([id, item]) => [
        id,
        item && failed.has(id)
          ? { ...item, state: "failed" as const, errorCategory }
          : item,
      ])),
    }));
    this.#releaseIfIdle(surface);
  }

  async respond(downloadId: string, decision: "accept" | "cancel"): Promise<void> {
    const item = this.store.getState().items[downloadId];
    if (!item || item.state !== "requested" || !this.#client) return;
    this.#clearPendingTimer(downloadId);
    try {
      await this.#client.send("browser_respond_download", {
        ...item.surface,
        downloadId,
        decision,
      });
      this.#update(downloadId, {
        state: decision === "accept" ? "downloading" : "cancelled",
        errorCategory: null,
      });
      if (decision === "accept") this.#armProgressWatchdog(downloadId);
      else this.#releaseIfIdle(item.surface);
    } catch (error) {
      this.#update(downloadId, { state: "failed", errorCategory: "host_rejected" });
      this.#releaseIfIdle(item.surface);
      throw error;
    }
  }

  async control(downloadId: string, action: "pause" | "resume" | "cancel"): Promise<void> {
    const item = this.store.getState().items[downloadId];
    if (!item || !this.#client) return;
    if (item.state === "requested" && action === "cancel") {
      await this.respond(downloadId, "cancel");
      return;
    }
    const allowed = (action === "pause" && item.state === "downloading")
      || (action === "resume" && item.state === "paused")
      || (action === "cancel" && (item.state === "downloading" || item.state === "paused"));
    if (!allowed) return;
    await this.#client.send("browser_control_download", {
      ...item.surface,
      downloadId,
      action,
    });
    if (action === "pause") {
      this.#clearProgressTimer(downloadId);
      this.#update(downloadId, { state: "paused", errorCategory: null });
    } else if (action === "resume") {
      this.#update(downloadId, { state: "downloading", errorCategory: null });
      this.#armProgressWatchdog(downloadId);
    } else {
      this.#clearProgressTimer(downloadId);
      this.#update(downloadId, { state: "cancelled", errorCategory: null });
      this.#releaseIfIdle(item.surface);
    }
  }

  remove(downloadId: string): void {
    this.#clearTimers(downloadId);
    this.store.setState((state) => {
      if (!state.items[downloadId]) return state;
      const items = { ...state.items };
      delete items[downloadId];
      return { items };
    });
  }

  #handle(event: BrowserEventEnvelope): void {
    if (event.kind === "download.requested") {
      const item: BrowserDownloadItem = {
        id: event.payload.downloadId,
        surface: {
          panelId: event.panelId,
          surfaceId: event.surfaceId,
          generation: event.generation,
        },
        url: event.payload.url,
        filename: event.payload.suggestedFilename,
        receivedBytes: 0,
        totalBytes: event.payload.totalBytes,
        state: "requested",
        errorCategory: null,
        dangerous: isDangerousFilename(event.payload.suggestedFilename),
        filePath: null,
      };
      this.store.setState((state) => ({ items: { ...state.items, [item.id]: item } }));
      if (item.dangerous) {
        this.#pendingTimers.set(item.id, setTimeout(() => void this.respond(item.id, "cancel"), 30_000));
      } else {
        void this.respond(item.id, "accept").catch(() => undefined);
      }
      return;
    }
    const payload = event.payload as { readonly downloadId?: string };
    if (!payload.downloadId) return;
    const current = this.store.getState().items[payload.downloadId];
    if (!current) return;
    if (event.kind === "download.started") {
      this.#update(payload.downloadId, {
        filename: event.payload.filename,
        filePath: event.payload.filePath,
        state: "downloading",
        errorCategory: null,
      });
      this.#armProgressWatchdog(payload.downloadId);
    } else if (event.kind === "download.progress") {
      this.#update(payload.downloadId, {
        receivedBytes: event.payload.receivedBytes,
        totalBytes: event.payload.totalBytes,
        state: current.state === "paused" ? "paused" : "downloading",
      });
      if (current.state !== "paused" && event.payload.receivedBytes > current.receivedBytes) {
        this.#armProgressWatchdog(payload.downloadId);
      }
    } else if (event.kind === "download.completed") {
      this.#clearTimers(payload.downloadId);
      this.#update(payload.downloadId, {
        state: "completed",
        filePath: event.payload.filePath,
      });
      this.#releaseIfIdle(current.surface);
    } else if (event.kind === "download.failed") {
      this.#clearTimers(payload.downloadId);
      const timedOut = current.state === "failed" && current.errorCategory === "no_progress";
      this.#update(payload.downloadId, {
        state: event.payload.errorCategory === "cancelled" && !timedOut ? "cancelled" : "failed",
        errorCategory: event.payload.errorCategory === "cancelled" && !timedOut
          ? null
          : timedOut ? "no_progress" : event.payload.errorCategory,
      });
      this.#releaseIfIdle(current.surface);
    }
  }

  #update(id: string, patch: Partial<BrowserDownloadItem>): void {
    this.store.setState((state) => {
      const current = state.items[id];
      return current ? { items: { ...state.items, [id]: { ...current, ...patch } } } : state;
    });
  }

  #releaseIfIdle(surface: BrowserSurfaceRef): void {
    if (!this.hasWork(surface)) this.#onSurfaceIdle?.(surface);
  }

  #armProgressWatchdog(id: string): void {
    this.#clearProgressTimer(id);
    this.#progressTimers.set(id, setTimeout(() => {
      const item = this.store.getState().items[id];
      if (!item || item.state !== "downloading") return;
      void this.#client?.send("browser_control_download", {
        ...item.surface,
        downloadId: id,
        action: "cancel",
      }).catch(() => undefined);
      this.#update(id, { state: "failed", errorCategory: "no_progress" });
      this.#releaseIfIdle(item.surface);
      this.#clearProgressTimer(id);
    }, 60_000));
  }

  #clearPendingTimer(id: string): void {
    const timer = this.#pendingTimers.get(id);
    if (timer) clearTimeout(timer);
    this.#pendingTimers.delete(id);
  }

  #clearProgressTimer(id: string): void {
    const timer = this.#progressTimers.get(id);
    if (timer) clearTimeout(timer);
    this.#progressTimers.delete(id);
  }

  #clearTimers(id: string): void {
    this.#clearPendingTimer(id);
    this.#clearProgressTimer(id);
  }
}

export const browserDownloadController = new BrowserDownloadController();

export function isDangerousFilename(filename: string): boolean {
  return /\.(?:exe|msi|bat|cmd|com|ps1|vbs|js|scr)$/i.test(filename);
}

function sameSurface(left: BrowserSurfaceRef, right: BrowserSurfaceRef): boolean {
  return left.panelId === right.panelId
    && left.surfaceId === right.surfaceId
    && left.generation === right.generation;
}
