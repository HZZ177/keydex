export const MARKDOWN_RUNTIME_CAPABILITY_VERSION = "markdown-runtime-capabilities/v1";
export const MINIMUM_WEBVIEW2_MAJOR = 120;

export type MarkdownRuntimeKind = "chrome" | "webview2" | "unknown";

export interface MarkdownRuntimeCapabilitySnapshot {
  readonly schemaVersion: string;
  readonly capturedAt: string;
  readonly runtimeKind: MarkdownRuntimeKind;
  readonly runtimeVersion: string | null;
  readonly userAgent: string;
  readonly mainThread: {
    readonly structuredClone: boolean;
    readonly structuredCloneTransfer: boolean;
    readonly textEncoder: boolean;
  };
  readonly worker: {
    readonly available: boolean;
    readonly moduleWorker: boolean;
    readonly structuredClone: boolean;
    readonly transferableArrayBuffer: boolean;
    readonly textEncoder: boolean;
    readonly error: string | null;
  };
  readonly observers: {
    readonly resizeObserver: boolean;
    readonly intersectionObserver: boolean;
    readonly mutationObserver: boolean;
    readonly performanceObserver: boolean;
    readonly supportedEntryTypes: readonly string[];
    readonly longTask: boolean;
  };
  readonly dom: {
    readonly range: boolean;
    readonly selection: boolean;
    readonly clipboardApi: boolean;
  };
  readonly memory: {
    readonly performanceMemory: boolean;
    readonly userAgentSpecificMemory: boolean;
  };
  readonly optional: {
    readonly requestIdleCallback: boolean;
    readonly sharedArrayBuffer: boolean;
    readonly crossOriginIsolated: boolean;
    readonly offscreenCanvas: boolean;
  };
}

export interface MarkdownRuntimeCapabilityEvaluation {
  readonly supported: boolean;
  readonly requiredErrors: readonly string[];
  readonly diagnosticWarnings: readonly string[];
}

export interface MarkdownRuntimeObservationChannels {
  readonly timeline: "performance-observer" | "cdp-tracing" | "unavailable";
  readonly memory: "performance-memory" | "process-rss" | "unavailable";
  readonly automation: "playwright-cdp" | "manual-only";
}

export async function probeMarkdownRuntimeCapabilities(): Promise<MarkdownRuntimeCapabilitySnapshot> {
  const userAgent = navigator.userAgent;
  const runtime = parseRuntime(userAgent);
  const directTransfer = probeStructuredCloneTransfer();
  const worker = await probeWorker();
  const supportedEntryTypes = typeof PerformanceObserver === "function"
    ? [...(PerformanceObserver.supportedEntryTypes ?? [])]
    : [];
  const performanceWithMemory = performance as Performance & { memory?: unknown };
  const performanceWithMeasure = performance as Performance & { measureUserAgentSpecificMemory?: unknown };

  return Object.freeze({
    schemaVersion: MARKDOWN_RUNTIME_CAPABILITY_VERSION,
    capturedAt: new Date().toISOString(),
    runtimeKind: runtime.kind,
    runtimeVersion: runtime.version,
    userAgent,
    mainThread: Object.freeze({
      structuredClone: typeof structuredClone === "function",
      structuredCloneTransfer: directTransfer,
      textEncoder: typeof TextEncoder === "function",
    }),
    worker,
    observers: Object.freeze({
      resizeObserver: constructibleObserver("ResizeObserver"),
      intersectionObserver: constructibleObserver("IntersectionObserver"),
      mutationObserver: constructibleObserver("MutationObserver"),
      performanceObserver: typeof PerformanceObserver === "function",
      supportedEntryTypes: Object.freeze(supportedEntryTypes),
      longTask: supportedEntryTypes.includes("longtask"),
    }),
    dom: Object.freeze({
      range: typeof document?.createRange === "function",
      selection: typeof window?.getSelection === "function",
      clipboardApi: typeof navigator.clipboard?.writeText === "function",
    }),
    memory: Object.freeze({
      performanceMemory: Boolean(performanceWithMemory.memory),
      userAgentSpecificMemory: typeof performanceWithMeasure.measureUserAgentSpecificMemory === "function",
    }),
    optional: Object.freeze({
      requestIdleCallback: typeof window.requestIdleCallback === "function",
      sharedArrayBuffer: typeof SharedArrayBuffer === "function",
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      offscreenCanvas: typeof OffscreenCanvas === "function",
    }),
  });
}

export function evaluateMarkdownRuntimeCapabilities(
  snapshot: MarkdownRuntimeCapabilitySnapshot,
): MarkdownRuntimeCapabilityEvaluation {
  const requiredErrors: string[] = [];
  const diagnosticWarnings: string[] = [];
  if (snapshot.schemaVersion !== MARKDOWN_RUNTIME_CAPABILITY_VERSION) {
    requiredErrors.push(`Unsupported capability schema: ${snapshot.schemaVersion}`);
  }
  if (snapshot.runtimeKind === "webview2") {
    const major = Number(snapshot.runtimeVersion?.split(".")[0] ?? NaN);
    if (!Number.isInteger(major) || major < MINIMUM_WEBVIEW2_MAJOR) {
      requiredErrors.push(`WebView2 ${snapshot.runtimeVersion ?? "unknown"} is below required major ${MINIMUM_WEBVIEW2_MAJOR}`);
    }
  }
  const required: Array<[boolean, string]> = [
    [snapshot.mainThread.structuredClone, "structuredClone is unavailable"],
    [snapshot.mainThread.structuredCloneTransfer, "structuredClone transferable ArrayBuffer is unavailable"],
    [snapshot.mainThread.textEncoder, "TextEncoder is unavailable"],
    [snapshot.worker.available, "Worker is unavailable"],
    [snapshot.worker.moduleWorker, "module Worker is unavailable"],
    [snapshot.worker.structuredClone, "Worker structured clone is unavailable"],
    [snapshot.worker.transferableArrayBuffer, "Worker transferable ArrayBuffer is unavailable"],
    [snapshot.worker.textEncoder, "Worker TextEncoder is unavailable"],
    [snapshot.observers.resizeObserver, "ResizeObserver is unavailable"],
    [snapshot.observers.intersectionObserver, "IntersectionObserver is unavailable"],
    [snapshot.observers.mutationObserver, "MutationObserver is unavailable"],
    [snapshot.observers.performanceObserver, "PerformanceObserver is unavailable"],
    [snapshot.dom.range, "DOM Range is unavailable"],
    [snapshot.dom.selection, "Selection API is unavailable"],
  ];
  for (const [available, message] of required) {
    if (!available) requiredErrors.push(message);
  }
  if (!snapshot.observers.longTask) {
    diagnosticWarnings.push("Long Task PerformanceObserver channel is unavailable");
  }
  if (!snapshot.memory.performanceMemory && !snapshot.memory.userAgentSpecificMemory) {
    diagnosticWarnings.push("In-page memory diagnostics are unavailable; desktop process RSS is required");
  }
  if (!snapshot.dom.clipboardApi) {
    diagnosticWarnings.push("Clipboard API is unavailable; native selection remains required and clipboard needs product E2E");
  }
  return Object.freeze({
    supported: requiredErrors.length === 0,
    requiredErrors: Object.freeze(requiredErrors),
    diagnosticWarnings: Object.freeze(diagnosticWarnings),
  });
}

export function selectMarkdownRuntimeObservationChannels(
  snapshot: MarkdownRuntimeCapabilitySnapshot,
  options: { readonly cdpAvailable: boolean },
): MarkdownRuntimeObservationChannels {
  return Object.freeze({
    timeline: snapshot.observers.longTask
      ? "performance-observer"
      : options.cdpAvailable ? "cdp-tracing" : "unavailable",
    memory: snapshot.memory.performanceMemory || snapshot.memory.userAgentSpecificMemory
      ? "performance-memory"
      : options.cdpAvailable ? "process-rss" : "unavailable",
    automation: options.cdpAvailable ? "playwright-cdp" : "manual-only",
  });
}

function probeStructuredCloneTransfer(): boolean {
  if (typeof structuredClone !== "function") return false;
  try {
    const source = new ArrayBuffer(8);
    const cloned = structuredClone({ source }, { transfer: [source] });
    return source.byteLength === 0 && cloned.source instanceof ArrayBuffer && cloned.source.byteLength === 8;
  } catch {
    return false;
  }
}

async function probeWorker(): Promise<MarkdownRuntimeCapabilitySnapshot["worker"]> {
  if (typeof Worker !== "function") {
    return workerResult(false, false, false, false, false, "Worker constructor is unavailable");
  }
  const source = `
    self.onmessage = (event) => {
      const buffer = event.data.buffer;
      const encoded = new TextEncoder().encode(event.data.text);
      self.postMessage({
        buffer,
        encodedLength: encoded.byteLength,
        structured: event.data.nested?.value === 42
      }, [buffer]);
    };
  `;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "module", name: "markdown-runtime-capability-probe" });
  try {
    const buffer = new ArrayBuffer(16);
    const result = await new Promise<{ buffer: ArrayBuffer; encodedLength: number; structured: boolean }>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Worker capability probe timed out")), 5_000);
      worker.onmessage = (event: MessageEvent) => {
        window.clearTimeout(timeout);
        resolve(event.data);
      };
      worker.onerror = (event) => {
        window.clearTimeout(timeout);
        reject(new Error(event.message || "Worker capability probe failed"));
      };
      worker.postMessage({ buffer, text: "中文", nested: { value: 42 } }, [buffer]);
    });
    return workerResult(
      true,
      true,
      result.structured,
      buffer.byteLength === 0 && result.buffer.byteLength === 16,
      result.encodedLength === new TextEncoder().encode("中文").byteLength,
      null,
    );
  } catch (error) {
    return workerResult(true, false, false, false, false, error instanceof Error ? error.message : String(error));
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}

function workerResult(
  available: boolean,
  moduleWorker: boolean,
  structuredCloneAvailable: boolean,
  transferableArrayBuffer: boolean,
  textEncoder: boolean,
  error: string | null,
): MarkdownRuntimeCapabilitySnapshot["worker"] {
  return Object.freeze({
    available,
    moduleWorker,
    structuredClone: structuredCloneAvailable,
    transferableArrayBuffer,
    textEncoder,
    error,
  });
}

function constructibleObserver(name: "ResizeObserver" | "IntersectionObserver" | "MutationObserver"): boolean {
  try {
    const Constructor = globalThis[name];
    if (typeof Constructor !== "function") return false;
    const observer = name === "MutationObserver"
      ? new Constructor(() => undefined)
      : new Constructor(() => undefined);
    observer.disconnect();
    return true;
  } catch {
    return false;
  }
}

function parseRuntime(userAgent: string): { kind: MarkdownRuntimeKind; version: string | null } {
  const edge = /Edg\/([\d.]+)/u.exec(userAgent);
  if (edge) return { kind: "webview2", version: edge[1] };
  const chrome = /Chrome\/([\d.]+)/u.exec(userAgent);
  if (chrome) return { kind: "chrome", version: chrome[1] };
  return { kind: "unknown", version: null };
}

