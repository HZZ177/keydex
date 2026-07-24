import type { BrowserNavigationIntent, BrowserSurfaceRef } from "../domain";
import { resolveBrowserAddress, type ResolvedBrowserAddress } from "../domain/browserNavigation";
import type { BrowserRuntimeStore } from "../state/browserRuntimeStore";
import type { BrowserHostClient } from "./BrowserHostClient";

export class BrowserNavigationController {
  readonly #client: Pick<BrowserHostClient, "send">;
  readonly #store: BrowserRuntimeStore;
  readonly #panelId: string;
  readonly #generation: number;
  #navigationSequence = 0;

  constructor(input: {
    readonly client: Pick<BrowserHostClient, "send">;
    readonly store: BrowserRuntimeStore;
    readonly panelId: string;
    readonly generation: number;
  }) {
    this.#client = input.client;
    this.#store = input.store;
    this.#panelId = input.panelId;
    this.#generation = input.generation;
  }

  async navigate(
    address: string,
    intent: BrowserNavigationIntent = {
      source: "address_bar",
      userGesture: true,
    },
  ): Promise<ResolvedBrowserAddress> {
    const resolved = resolveBrowserAddress(address);
    const surface = this.#surface();
    const navigationId = `${this.#panelId}-navigation-${++this.#navigationSequence}`;
    await this.#client.send("browser_navigate", {
      ...surface,
      navigationId,
      url: resolved.url,
      intent,
    });
    return resolved;
  }

  goBack(): Promise<unknown> {
    return this.#client.send("browser_go_back", this.#surface());
  }

  goForward(): Promise<unknown> {
    return this.#client.send("browser_go_forward", this.#surface());
  }

  reload(): Promise<unknown> {
    return this.#client.send("browser_reload", { ...this.#surface(), mode: "normal" });
  }

  stop(): Promise<unknown> {
    return this.#client.send("browser_stop", this.#surface());
  }

  #surface(): BrowserSurfaceRef {
    const runtime = this.#store.getState().surfaces[this.#panelId];
    if (!runtime || runtime.generation !== this.#generation || !runtime.surface) {
      throw new Error("浏览器页面尚未就绪");
    }
    return runtime.surface;
  }
}
