# ADR: Git workbench dependency and reuse policy

Status: accepted for the initial Keydex Git workbench.

## Decision

- Keep Git execution in the existing Python/FastAPI backend and use the system
  Git executable. Do not import LiveAgent's Rust/Tauri command layer.
- Build the React UI with Keydex-owned components, state, tokens, and semantic
  roles. Do not import LiveAgent's Git review components or CSS.
- Permit a TypeScript port of LiveAgent's pure `gitGraph.ts` lane algorithm
  under its MIT attribution. Rendering remains Keydex-owned.
- Start with a Keydex-owned diff domain model and renderer. Do not add
  `@git-diff-view/file`, `@git-diff-view/react`, or
  `@tanstack/react-virtual` as initial dependencies.

## Evaluation

LiveAgent uses `@git-diff-view/file` and `@git-diff-view/react` version 0.1.3
plus `@tanstack/react-virtual`. Keydex currently has no dependency or theme
integration for those packages. The renderer imports package-global CSS and is
embedded in a UI architecture that Keydex will not reuse. Adding it now would
couple protocol work to a pre-1.0 rendering API and create a second styling and
accessibility surface.

The Keydex adapter boundary remains explicit in
`desktop/src/renderer/features/git/diffViewerPolicy.ts`. A later spike may set
the requested engine to `git-diff-view` only after all of these gates pass:

1. License and transitive license review.
2. Light/dark theme token isolation without global CSS leakage.
3. Keyboard and screen-reader semantics for files, hunks, and selected lines.
4. Lazy chunk and large-diff memory budget measurements.
5. Maintenance assessment and a tested native fallback.

Failure of a gate keeps `keydex-native`; there is no hidden runtime downgrade.
