export const INGRESS_PERFORMANCE_CONTRACT = Object.freeze({
  schemaVersion: "markdown-ingress-performance/v1",
  quickSizes: Object.freeze([
    512 * 1024 - 1,
    512 * 1024 + 1,
    1024 * 1024,
    5 * 1024 * 1024,
    10 * 1024 * 1024,
  ]),
  stressSizes: Object.freeze([20 * 1024 * 1024]),
  quickSamples: 3,
  officialSurfaces: Object.freeze([
    "python-workspace",
    "browser-local-preview",
    "tauri-webview2",
    "frontend-ndjson-transport",
  ]),
  actualTauriRequired: true,
  chromeMaySubstituteTauri: false,
  budgets: Object.freeze({
    tauriAdapter10MiBP95Ms: 2_000,
    frontendTransport10MiBP95Ms: 2_000,
    backendEndpoint10MiBP95Ms: 3_000,
    maxBufferedTransportBytes: 512 * 1024,
    maxHeapAmplificationRatio: 12,
  }),
});

export type IngressPerformanceContract = typeof INGRESS_PERFORMANCE_CONTRACT;
