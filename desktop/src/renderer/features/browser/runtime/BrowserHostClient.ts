import {
  BROWSER_EVENT_TOPIC,
  BROWSER_HOST_SCHEMA_VERSION,
  parseBrowserCommandEnvelope,
  parseBrowserCommandResponse,
  parseBrowserEventEnvelope,
  type BrowserCommandEnvelope,
  type BrowserCommandKind,
  type BrowserCommandPayloadByKind,
  type BrowserCommandResponse,
  type BrowserEventEnvelope,
} from "../domain";

export type BrowserHostInvoke = (
  command: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<unknown>;
export type BrowserHostUnlisten = () => void;
export type BrowserHostListen = (
  topic: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<BrowserHostUnlisten>;

export interface BrowserHostClientOptions {
  readonly invoke?: BrowserHostInvoke;
  readonly listen?: BrowserHostListen;
  readonly requestId?: () => string;
  readonly onProtocolError?: (error: Error, payload: unknown) => void;
}

export class BrowserHostCommandError extends Error {
  readonly response: Extract<BrowserCommandResponse, { ok: false }>;

  constructor(response: Extract<BrowserCommandResponse, { ok: false }>) {
    super(response.error.message);
    this.name = "BrowserHostCommandError";
    this.response = response;
  }
}

export class BrowserHostUnavailableError extends Error {
  constructor() {
    super("侧边栏浏览器需要 Keydex 桌面运行时；普通 Web 开发页无法承载原生 WebView2 表面");
    this.name = "BrowserHostUnavailableError";
  }
}

export class BrowserHostClient {
  readonly #options: BrowserHostClientOptions;
  readonly #subscribers = new Set<(event: BrowserEventEnvelope) => void>();
  #unlisten: BrowserHostUnlisten | null = null;

  constructor(options: BrowserHostClientOptions = {}) {
    this.#options = options;
  }

  async connect(): Promise<void> {
    if (this.#unlisten) return;
    if (!this.#options.listen && !isBrowserHostRuntimeAvailable()) {
      throw new BrowserHostUnavailableError();
    }
    const listen = this.#options.listen ?? await loadTauriListen();
    this.#unlisten = await listen(BROWSER_EVENT_TOPIC, ({ payload }) => {
      try {
        const event = parseBrowserEventEnvelope(payload);
        this.#subscribers.forEach((subscriber) => subscriber(event));
      } catch (error) {
        this.#options.onProtocolError?.(toError(error), payload);
      }
    });
  }

  disconnect(): void {
    this.#unlisten?.();
    this.#unlisten = null;
  }

  subscribe(subscriber: (event: BrowserEventEnvelope) => void): BrowserHostUnlisten {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  async send<K extends BrowserCommandKind>(
    command: K,
    payload: BrowserCommandPayloadByKind[K],
  ): Promise<BrowserCommandResponse> {
    const requestId = (this.#options.requestId ?? createBrowserRequestId)();
    const envelope = parseBrowserCommandEnvelope({
      schemaVersion: BROWSER_HOST_SCHEMA_VERSION,
      requestId,
      command,
      payload,
    }) as BrowserCommandEnvelope<K>;
    if (!this.#options.invoke && !isBrowserHostRuntimeAvailable()) {
      throw new BrowserHostUnavailableError();
    }
    const invoke = this.#options.invoke ?? await loadTauriInvoke();
    const response = parseBrowserCommandResponse(await invoke(command, {
      requestId: envelope.requestId,
      payload: envelope.payload,
    }));
    if (response.requestId !== requestId) {
      throw new Error("BrowserHost response requestId does not match the command");
    }
    if (!response.ok) throw new BrowserHostCommandError(response);
    return response;
  }
}

export function isBrowserHostRuntimeAvailable(): boolean {
  return typeof window !== "undefined"
    && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

export function createBrowserRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `browser-${crypto.randomUUID()}`;
  }
  return `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function loadTauriInvoke(): Promise<BrowserHostInvoke> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke as unknown as BrowserHostInvoke;
}

async function loadTauriListen(): Promise<BrowserHostListen> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen as unknown as BrowserHostListen;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
