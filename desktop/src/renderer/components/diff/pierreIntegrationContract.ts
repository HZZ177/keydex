export const PIERRE_DIFFS_INTEGRATION = {
  status: "adopted",
  packageName: "@pierre/diffs",
  version: "1.2.12",
  license: "Apache-2.0",
  registryLicense: "apache-2.0",
  sourceUrl: "https://github.com/pierrecomputer/pierre",
  documentationUrl: "https://diffs.com/docs",
  reactPeer: "^18.3.1 || ^19.0.0",
  approvedImports: [
    "@pierre/diffs",
    "@pierre/diffs/react",
    "@pierre/diffs/worker",
    "@pierre/diffs/worker/worker-portable.js",
  ],
  approvedCapabilities: [
    "PatchDiff",
    "MultiFileDiff",
    "FileDiff",
    "CodeView",
    "registerCustomCSSVariableTheme",
    "WorkerPoolContextProvider",
  ],
  forbiddenCapabilities: ["UnresolvedFile", "unsafeCSS"],
  importBoundary: "src/renderer/components/diff/engine",
  coreImportPurpose:
    "parsePatchFiles and official CSS-variable theme registration only; loaded through the shared lazy engine",
  versionPolicy: "exact",
  upgradePolicy:
    "Update this contract and its API tests in a dedicated change before upgrading the package.",
} as const;

export type PierreDiffsIntegrationContract = typeof PIERRE_DIFFS_INTEGRATION;
