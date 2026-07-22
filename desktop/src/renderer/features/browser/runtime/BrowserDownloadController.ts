import { createStore, type StoreApi } from "zustand/vanilla";

import type { BrowserEventEnvelope, BrowserSurfaceRef } from "../domain";
import type { BrowserHostClient } from "./BrowserHostClient";

export type BrowserDownloadState = "requested" | "downloading" | "completed" | "failed" | "cancelled";

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
}

interface BrowserDownloadRuntimeState {
  readonly items: Readonly<Record<string, BrowserDownloadItem | undefined>>;
}

export class BrowserDownloadController {
  readonly store: StoreApi<BrowserDownloadRuntimeState> = createStore(() => ({ items: {} }));
  readonly #pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
      && (item.state === "requested" || item.state === "downloading"));
  }

  failSurface(surface: BrowserSurfaceRef, errorCategory = "process_failed"): void {
    const failedIds = Object.values(this.store.getState().items).flatMap((item) =>
      item
        && sameSurface(item.surface, surface)
        && (item.state === "requested" || item.state === "downloading")
        ? [item.id]
        : [],
    );
    if (failedIds.length === 0) return;
    for (const id of failedIds) this.#clearTimer(id);
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
    this.#clearTimer(downloadId);
    await this.#client.send("browser_respond_download", {
      ...item.surface,
      downloadId,
      decision,
    });
    this.#update(downloadId, {
      state: decision === "accept" ? "downloading" : "cancelled",
    });
    if (decision === "cancel") this.#releaseIfIdle(item.surface);
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
      };
      this.store.setState((state) => ({ items: { ...state.items, [item.id]: item } }));
      if (item.dangerous) {
        this.#pendingTimers.set(item.id, setTimeout(() => void this.respond(item.id, "cancel"), 30_000));
      } else {
        void this.respond(item.id, "accept").catch(() => {
          this.#update(item.id, { state: "failed", errorCategory: "host_rejected" });
          this.#releaseIfIdle(item.surface);
        });
      }
      return;
    }
    const payload = event.payload as { readonly downloadId?: string };
    if (!payload.downloadId) return;
    const current = this.store.getState().items[payload.downloadId];
    if (!current) return;
    if (event.kind === "download.progress") {
      this.#update(payload.downloadId, {
        receivedBytes: event.payload.receivedBytes,
        totalBytes: event.payload.totalBytes,
        state: "downloading",
      });
    } else if (event.kind === "download.completed") {
      this.#update(payload.downloadId, { state: "completed" });
      this.#releaseIfIdle(current.surface);
    } else if (event.kind === "download.failed") {
      this.#update(payload.downloadId, { state: "failed", errorCategory: event.payload.errorCategory });
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

  #clearTimer(id: string): void {
    const timer = this.#pendingTimers.get(id);
    if (timer) clearTimeout(timer);
    this.#pendingTimers.delete(id);
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
