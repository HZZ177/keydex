export const TERMINAL_FEATURE_MANIFEST = Object.freeze({
  contractVersion: 2,
  supportedPlatforms: ["windows"] as const,
  profiles: ["git-bash", "powershell", "cmd"] as const,
  limits: Object.freeze({
    terminalsPerSession: 8,
    terminalsGlobal: 24,
    replayBytesPerTerminal: 1024 * 1024,
    replayChunksPerTerminal: 4096,
    scrollbackLines: 5000,
    maxOutputChunkBytes: 32 * 1024,
    deliveryWindowBytes: 256 * 1024,
    deliveryWindowChunks: 64,
    maxInputBytes: 64 * 1024,
    minRows: 2,
    maxRows: 500,
    minColumns: 2,
    maxColumns: 500,
  }),
  unsupported: [
    "agent-command-runtime",
    "command-approval",
    "command-whitelist",
    "command-trust-rules",
    "wsl",
    "ssh",
    "remote-container",
    "serial-port",
    "split-pane",
    "cross-restart-process-restore",
  ] as const,
});

export type TerminalProfileId = (typeof TERMINAL_FEATURE_MANIFEST.profiles)[number];
