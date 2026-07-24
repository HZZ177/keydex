import type { WebAnnotationTarget } from "../../runtime";
import { canonicalizeBrowserFileAddress } from "../../domain";
import type { WebAnnotationCoordinatorResolution } from "./resolverCoordinator";

export interface WebAnnotationNavigationTarget {
  readonly annotationId: string;
  readonly resourceId: string;
  readonly urlKey: string;
  readonly documentUrl: string;
}

export interface WebAnnotationNavigationPanelSnapshot {
  readonly hostKind: "agent" | "workbench";
  readonly scopeKey: string;
  readonly panelId: string;
  readonly active: boolean;
  readonly ready: boolean;
  readonly urlKey: string | null;
  readonly documentUrl: string;
}

export interface WebAnnotationNavigationPanel {
  getSnapshot(): WebAnnotationNavigationPanelSnapshot;
  getResolution(annotationId: string): WebAnnotationCoordinatorResolution | undefined;
  activate(): void;
  reveal(annotationId: string, target: WebAnnotationTarget): Promise<void>;
}

export type WebAnnotationNavigationResult =
  | { readonly status: "revealed"; readonly panelId: string }
  | {
      readonly status: "evidence_only";
      readonly panelId: string;
      readonly resolution: "ambiguous" | "orphaned";
    }
  | { readonly status: "cancelled" }
  | { readonly status: "unavailable"; readonly reason: string };

export class WebAnnotationPanelRegistry {
  readonly #panels = new Map<string, WebAnnotationNavigationPanel>();
  readonly #listeners = new Set<() => void>();

  register(panel: WebAnnotationNavigationPanel): () => void {
    const snapshot = panel.getSnapshot();
    const key = panelKey(snapshot.hostKind, snapshot.scopeKey, snapshot.panelId);
    this.#panels.set(key, panel);
    this.notify();
    return () => {
      if (this.#panels.get(key) !== panel) return;
      this.#panels.delete(key);
      this.notify();
    };
  }

  list(scopeKey: string): readonly WebAnnotationNavigationPanel[] {
    return [...this.#panels.values()].filter((panel) => panel.getSnapshot().scopeKey === scopeKey);
  }

  listAll(): readonly WebAnnotationNavigationPanel[] {
    return [...this.#panels.values()];
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  notify(): void {
    this.#listeners.forEach((listener) => listener());
  }
}

export class WebAnnotationNavigator {
  readonly #registry: WebAnnotationPanelRegistry;
  readonly #timeoutMs: number;
  readonly #requests = new Map<string, AbortController>();

  constructor(
    registry: WebAnnotationPanelRegistry,
    options: { readonly timeoutMs?: number } = {},
  ) {
    this.#registry = registry;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async navigate(input: {
    readonly scopeKey: string;
    readonly target: WebAnnotationNavigationTarget;
    readonly currentPanelId?: string;
    readonly preferredHostKind?: "agent" | "workbench";
    createPanel(documentUrl: string): void;
  }): Promise<WebAnnotationNavigationResult> {
    this.#requests.get(input.scopeKey)?.abort();
    const controller = new AbortController();
    this.#requests.set(input.scopeKey, controller);
    try {
      return await this.#navigate(input, controller.signal);
    } catch (error) {
      if (isAbortError(error)) return { status: "cancelled" };
      return {
        status: "unavailable",
        reason: error instanceof Error ? error.message : "Web annotation target is unavailable",
      };
    } finally {
      if (this.#requests.get(input.scopeKey) === controller) this.#requests.delete(input.scopeKey);
    }
  }

  cancel(scopeKey: string): void {
    this.#requests.get(scopeKey)?.abort();
  }

  async #navigate(
    input: {
      readonly scopeKey: string;
      readonly target: WebAnnotationNavigationTarget;
      readonly currentPanelId?: string;
      readonly preferredHostKind?: "agent" | "workbench";
      createPanel(documentUrl: string): void;
    },
    signal: AbortSignal,
  ): Promise<WebAnnotationNavigationResult> {
    let panel = choosePanel(
      this.#registry.list(input.scopeKey),
      input.target,
      input.currentPanelId,
      input.preferredHostKind,
    );
    if (!panel) {
      const priorIds = new Set(
        this.#registry.list(input.scopeKey).map((item) => snapshotKey(item.getSnapshot())),
      );
      input.createPanel(input.target.documentUrl);
      panel = await this.#waitFor(() => {
        const candidates = this.#registry.list(input.scopeKey).filter((item) => {
          const snapshot = item.getSnapshot();
          return !priorIds.has(snapshotKey(snapshot)) && panelMatches(snapshot, input.target);
        });
        return choosePanel(
          candidates,
          input.target,
          undefined,
          input.preferredHostKind,
        );
      }, signal, "Timed out while opening the annotation source page");
    }

    const selectedSnapshot = panel.getSnapshot();
    const panelId = selectedSnapshot.panelId;
    const hostKind = selectedSnapshot.hostKind;
    panel.activate();
    panel = await this.#waitFor(() => {
      const current = this.#registry.list(input.scopeKey).find(
        (candidate) => {
          const snapshot = candidate.getSnapshot();
          return snapshot.panelId === panelId && snapshot.hostKind === hostKind;
        },
      );
      if (!current) return null;
      const snapshot = current.getSnapshot();
      return snapshot.active && snapshot.ready && panelMatches(snapshot, input.target) ? current : null;
    }, signal, "Timed out while restoring the annotation browser panel");

    const resolution = await this.#waitFor(() => {
      const snapshot = panel.getSnapshot();
      if (!panelMatches(snapshot, input.target)) {
        throw new DOMException("Annotation navigation was replaced by page navigation", "AbortError");
      }
      const candidate = panel.getResolution(input.target.annotationId);
      if (!candidate?.settled || candidate.settled.identity.resourceId !== input.target.resourceId) return null;
      return candidate;
    }, signal, "Timed out while resolving the annotation target");

    const settled = resolution.settled;
    if (!settled) throw new Error("Annotation resolution is unavailable");
    if (settled.status === "ambiguous" || settled.status === "orphaned") {
      return { status: "evidence_only", panelId, resolution: settled.status };
    }
    if (!settled.target) throw new Error("Resolved annotation target is missing");
    throwIfAborted(signal);
    await panel.reveal(input.target.annotationId, settled.target);
    throwIfAborted(signal);
    return { status: "revealed", panelId };
  }

  #waitFor<T>(
    read: () => T | null,
    signal: AbortSignal,
    timeoutMessage: string,
  ): Promise<T> {
    throwIfAborted(signal);
    const initial = read();
    if (initial !== null) return Promise.resolve(initial);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const check = () => {
        try {
          const value = read();
          if (value !== null) finish(() => resolve(value));
        } catch (error) {
          finish(() => reject(error));
        }
      };
      const onAbort = () => finish(() => reject(abortError()));
      const unsubscribe = this.#registry.subscribe(check);
      const timeout = setTimeout(
        () => finish(() => reject(new Error(timeoutMessage))),
        this.#timeoutMs,
      );
      signal.addEventListener("abort", onAbort, { once: true });
      check();
    });
  }
}

export const webAnnotationPanelRegistry = new WebAnnotationPanelRegistry();
export const webAnnotationNavigator = new WebAnnotationNavigator(webAnnotationPanelRegistry);

function choosePanel(
  panels: readonly WebAnnotationNavigationPanel[],
  target: WebAnnotationNavigationTarget,
  currentPanelId?: string,
  preferredHostKind?: "agent" | "workbench",
): WebAnnotationNavigationPanel | null {
  return panels
    .filter((panel) => panelMatches(panel.getSnapshot(), target))
    .sort((left, right) => {
      const leftSnapshot = left.getSnapshot();
      const rightSnapshot = right.getSnapshot();
      const leftRank = panelRank(
        leftSnapshot,
        target,
        currentPanelId,
        preferredHostKind,
      );
      const rightRank = panelRank(
        rightSnapshot,
        target,
        currentPanelId,
        preferredHostKind,
      );
      return rightRank - leftRank || leftSnapshot.panelId.localeCompare(rightSnapshot.panelId);
    })[0] ?? null;
}

function panelRank(
  panel: WebAnnotationNavigationPanelSnapshot,
  target: WebAnnotationNavigationTarget,
  currentPanelId?: string,
  preferredHostKind?: "agent" | "workbench",
): number {
  return (panel.urlKey === target.urlKey ? 16 : 0)
    + (panel.panelId === currentPanelId ? 8 : 0)
    + (panel.hostKind === preferredHostKind ? 4 : 0)
    + (panel.active ? 2 : 0)
    + (panel.ready ? 1 : 0);
}

function panelMatches(
  panel: WebAnnotationNavigationPanelSnapshot,
  target: WebAnnotationNavigationTarget,
): boolean {
  if (panel.urlKey && panel.urlKey === target.urlKey) return true;
  return comparableDocumentUrl(panel.documentUrl) === comparableDocumentUrl(target.documentUrl);
}

function comparableDocumentUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    if (url.protocol === "file:") {
      return canonicalizeBrowserFileAddress(url.href).canonicalKey;
    }
    return url.href;
  } catch {
    return value.trim();
  }
}

function panelKey(
  hostKind: WebAnnotationNavigationPanelSnapshot["hostKind"],
  scopeKey: string,
  panelId: string,
): string {
  return `${hostKind}\u0000${scopeKey}\u0000${panelId}`;
}

function snapshotKey(snapshot: WebAnnotationNavigationPanelSnapshot): string {
  return panelKey(snapshot.hostKind, snapshot.scopeKey, snapshot.panelId);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function abortError(): DOMException {
  return new DOMException("Annotation navigation was cancelled", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
