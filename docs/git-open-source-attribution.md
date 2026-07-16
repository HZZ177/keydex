# Git Workbench open-source references

Keydex's Git workbench is an original implementation built on the existing
Keydex React/FastAPI runtime. It uses the following LiveAgent sources as an
auditable engineering reference:

- Repository: `https://github.com/Stack-Cairn/LiveAgent.git`
- Pinned commit: `1616eb5e574274693dc29e18248650dc30911123`
- License: MIT
- Copyright: Copyright (c) 2026 Stack-Cairn

The Rust/Tauri Git command implementation, TypeScript client contract, and
React Git review UI are used only to study behavior, edge cases, and protocol
vocabulary. They are not copied into Keydex. Keydex implements those layers
against its own Python backend, runtime bridge, state store, and visual system.

The pure commit-lane layout in
`crates/agent-gui/src/lib/git/gitGraph.ts` is the only source approved for a
local algorithm port. A port must keep this repository, commit, license, source
path, and a summary of Keydex modifications next to the implementation.

Keydex's port lives at
`desktop/src/renderer/features/git/graph/gitGraph.ts`. It retains the lane
state transition and deterministic color allocation while replacing upstream
types with Keydex object IDs, removing ref-marker and UI-specific behavior,
and exposing unresolved lanes for cursor-truncated pages. No LiveAgent React
component or CSS is included.

The authoritative machine-readable list lives in
`desktop/src/renderer/features/git/referenceManifest.ts`.
