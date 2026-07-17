# ADR: `@pierre/diffs` integration boundary

- Status: Adopted
- Decision date: 2026-07-17
- Package: `@pierre/diffs`
- Exact version: `1.2.12`
- SPDX license: `Apache-2.0`
- Source: <https://github.com/pierrecomputer/pierre>
- Documentation: <https://diffs.com/docs>
- React peer contract: `^18.3.1 || ^19.0.0`

## Decision

Keydex uses `@pierre/diffs` as the only code-diff rendering engine. Product code consumes a
Keydex-owned `KeydexDiffView` facade; third-party imports are isolated under
`src/renderer/components/diff/engine`. Pierre owns syntax-aware patch/file rendering,
virtualization, selection callbacks and the worker runtime. Keydex owns the domain model,
normalization, product shell, themes, actions, accessibility, errors and Git safety.

The dependency is pinned to `1.2.12` without a semver range. An upgrade must be a dedicated
change that updates this ADR, `pierreIntegrationContract.ts`, public-API contract tests,
visual baselines, bundle budgets and Web/Tauri worker smoke evidence before the new version is
accepted.

## Approved API surface

- `@pierre/diffs/react`: `PatchDiff`, `MultiFileDiff`, `FileDiff`, `CodeView` and
  `WorkerPoolContextProvider` where the installed public types expose them.
- `@pierre/diffs/worker` and its documented worker entry points, behind a Keydex worker factory.
- Public options, render callbacks, CSS variables and Shiki theme inputs documented by Pierre.

Business surfaces must not import `@pierre/diffs` directly. They import only the Keydex facade
or a profile wrapper. This keeps Shadow DOM details and third-party API churn inside one adapter.

## Explicitly rejected API and styling paths

- `UnresolvedFile` is experimental and cannot replace `GitThreeWayMergeEditor` in this change.
- Structural `unsafeCSS` selectors are forbidden. Pierre does not guarantee their compatibility
  across patch releases, so Keydex uses public variables, options, slots and theme inputs only.
- Pierre headers, menus and action buttons do not define product UI. Keydex renders its own
  Codex-like shell, toolbar, context menu, tooltip, status feedback and accessibility layer.
- Pierre selection never executes Git. It is mapped back to the original Keydex patch and passed
  through the existing repository/version/write-queue boundary.

## Worker and fallback policy

Worker availability is a performance capability, not a correctness source. Small documents may
use an explicit main-thread fallback after a worker failure. Large documents must surface a clear
error or degraded state instead of silently blocking the application on the main thread. Web
Renderer and packaged Tauri paths are tested independently.

## License and distribution

The registry metadata for `1.2.12` reports `apache-2.0`, normalized here to SPDX
`Apache-2.0`. The dependency remains visible in lock metadata and the packaged dependency/license
inventory. No Pierre branding or default product chrome is exposed to users.
