export type GitReferenceReusePolicy = "analyze-and-rewrite" | "pure-algorithm-port";

export interface GitReferenceEntry {
  id: string;
  repository: string;
  upstream: string;
  commit: string;
  license: "MIT";
  copyright: string;
  sourcePath: string;
  policy: GitReferenceReusePolicy;
  purpose: string;
}

/**
 * Auditable source references for the Git workbench.
 *
 * LiveAgent UI and Rust/Tauri code are behavioral references only. The graph
 * layout is the sole source currently approved for a TypeScript port, and any
 * port must retain its source entry and a change note beside the implementation.
 */
export const GIT_REFERENCE_MANIFEST: readonly GitReferenceEntry[] = [
  {
    id: "liveagent-git-command-behavior",
    repository: "Stack-Cairn/LiveAgent",
    upstream: "https://github.com/Stack-Cairn/LiveAgent.git",
    commit: "1616eb5e574274693dc29e18248650dc30911123",
    license: "MIT",
    copyright: "Copyright (c) 2026 Stack-Cairn",
    sourcePath: "crates/agent-gui/src-tauri/src/commands/workspace/git.rs",
    policy: "analyze-and-rewrite",
    purpose: "Git command semantics, parsing fixtures, and error-boundary analysis",
  },
  {
    id: "liveagent-git-client-contract",
    repository: "Stack-Cairn/LiveAgent",
    upstream: "https://github.com/Stack-Cairn/LiveAgent.git",
    commit: "1616eb5e574274693dc29e18248650dc30911123",
    license: "MIT",
    copyright: "Copyright (c) 2026 Stack-Cairn",
    sourcePath: "crates/agent-gui/src/lib/git/types.ts",
    policy: "analyze-and-rewrite",
    purpose: "Domain vocabulary and client-boundary analysis",
  },
  {
    id: "liveagent-git-graph-layout",
    repository: "Stack-Cairn/LiveAgent",
    upstream: "https://github.com/Stack-Cairn/LiveAgent.git",
    commit: "1616eb5e574274693dc29e18248650dc30911123",
    license: "MIT",
    copyright: "Copyright (c) 2026 Stack-Cairn",
    sourcePath: "crates/agent-gui/src/lib/git/gitGraph.ts",
    policy: "pure-algorithm-port",
    purpose: "Pure commit-lane graph layout with Keydex-owned types and rendering",
  },
] as const;

export function validateGitReferenceManifest(
  entries: readonly GitReferenceEntry[] = GIT_REFERENCE_MANIFEST,
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const commitPattern = /^[0-9a-f]{40}$/;

  for (const entry of entries) {
    if (ids.has(entry.id)) errors.push(`duplicate id: ${entry.id}`);
    ids.add(entry.id);
    if (!commitPattern.test(entry.commit)) errors.push(`invalid commit: ${entry.id}`);
    if (entry.license !== "MIT") errors.push(`unsupported license: ${entry.id}`);
    if (!entry.sourcePath.trim()) errors.push(`missing source path: ${entry.id}`);
    if (entry.policy === "pure-algorithm-port" && !entry.purpose.includes("Pure")) {
      errors.push(`algorithm port must be explicitly pure: ${entry.id}`);
    }
  }

  return errors;
}
