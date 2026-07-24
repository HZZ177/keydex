import type { BrowserProfileMode, BrowserVisibilityReason } from "./browserHostContract";

/**
 * State required by the browser core. Host-specific persistence records may
 * extend this shape, but the core must never depend on their container type.
 */
export interface BrowserTabState {
  readonly id: string;
  readonly title: string;
  readonly faviconUrl?: string;
  readonly restoreUrl: string;
  readonly restoreUrlSanitized: boolean;
  readonly profileMode: BrowserProfileMode;
  readonly zoomFactor: number;
  readonly createdAt: string;
  readonly lastActivatedAt: string;
  /**
   * Ephemeral command issued by a host adapter. It is intentionally excluded
   * from persisted tab snapshots and is cleared by BrowserTabSurface after the
   * native host accepts it.
   */
  readonly navigationCommand?: BrowserTabNavigationCommand;
}

export interface BrowserTabNavigationCommand {
  readonly id: string;
  readonly kind: "navigate" | "reload";
  readonly url?: string;
  readonly source: "app_preview" | "file_change";
}

export type BrowserTabHostKind = "agent" | "workbench";

export interface BrowserTabCreateOptions {
  readonly profileMode?: BrowserProfileMode;
  readonly restoreUrl?: string;
  readonly previewFilePath?: string;
  readonly activate?: boolean;
}

export interface BrowserTabHostAdapter<TState extends BrowserTabState = BrowserTabState> {
  readonly kind: BrowserTabHostKind;
  readonly scopeKey: string;
  readonly composerScopeKey: string | null;
  readonly active: boolean;
  readonly state: TState;
  updateState(state: TState): void;
  createTab(options?: BrowserTabCreateOptions): void;
  activateTab(tabId: string): void;
  closeTab(tabId: string): void;
  setOccluded?(occluded: boolean, reason: BrowserVisibilityReason): void;
  reportError?(error: Error): void;
}

export type BrowserTabLifecyclePhase =
  | "mount"
  | "activate"
  | "deactivate"
  | "destroy";

/**
 * Small host-neutral lifecycle guard shared by adapters and tests. It catches
 * duplicate or out-of-order calls before they can leak native WebView2
 * surfaces.
 */
export class BrowserTabLifecycle {
  #mounted = false;
  #active = false;
  #destroyed = false;

  get snapshot(): Readonly<{
    mounted: boolean;
    active: boolean;
    destroyed: boolean;
  }> {
    return {
      mounted: this.#mounted,
      active: this.#active,
      destroyed: this.#destroyed,
    };
  }

  transition(phase: BrowserTabLifecyclePhase): void {
    if (phase === "mount") {
      if (this.#mounted || this.#destroyed) {
        throw new Error("Browser tab lifecycle mount is duplicated or occurs after destroy");
      }
      this.#mounted = true;
      return;
    }
    if (phase === "activate") {
      if (!this.#mounted || this.#destroyed || this.#active) {
        throw new Error("Browser tab lifecycle activate is out of order");
      }
      this.#active = true;
      return;
    }
    if (phase === "deactivate") {
      if (!this.#mounted || this.#destroyed || !this.#active) {
        throw new Error("Browser tab lifecycle deactivate is out of order");
      }
      this.#active = false;
      return;
    }
    if (!this.#mounted || this.#destroyed || this.#active) {
      throw new Error("Browser tab lifecycle destroy is out of order");
    }
    this.#destroyed = true;
  }
}
