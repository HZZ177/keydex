import { describe, expect, it } from "vitest";

// The production audit is a Node ESM script so the same analyzer can run after Vite emits dist.
// @ts-ignore The repository's broad *.mjs declaration only describes the MCP harness exports.
import { analyzeManifestGraph, evaluateDiffBuildReport, extractReactVersions } from "../tools/diff-build-manifest.mjs";

describe("Diff production build manifest gate", () => {
  it("keeps Pierre and grammar modules outside the initial static closure", () => {
    const pierre = "node_modules/.pnpm/@pierre+diffs@1.2.12/node_modules/@pierre/diffs/dist/index.js";
    const grammar = "node_modules/.pnpm/@shikijs+langs@4.3.1/node_modules/@shikijs/langs/dist/python.mjs";
    const graph = analyzeManifestGraph({
      "index.html": { file: "assets/app.js", isEntry: true, dynamicImports: [pierre] },
      [pierre]: { file: "assets/pierre.js", isDynamicEntry: true, imports: ["shared"] },
      shared: { file: "assets/shared.js" },
      [grammar]: { file: "assets/python.js", isDynamicEntry: true },
    });
    expect(graph.initialSources).toEqual(["index.html"]);
    expect(graph.initialPierreSources).toEqual([]);
    expect(graph.eagerGrammarEntries).toEqual([]);
    expect(graph.pierreSources).toEqual(expect.arrayContaining([pierre, "shared"]));
  });

  it("fails closed when Pierre or a grammar becomes eager", () => {
    const pierre = "node_modules/.pnpm/@pierre+diffs@1.2.12/node_modules/@pierre/diffs/dist/index.js";
    const grammar = "node_modules/.pnpm/@shikijs+langs@4.3.1/node_modules/@shikijs/langs/dist/python.mjs";
    const graph = analyzeManifestGraph({
      "index.html": { file: "assets/app.js", isEntry: true, imports: [pierre, grammar] },
      [pierre]: { file: "assets/pierre.js", isDynamicEntry: true },
      [grammar]: { file: "assets/python.js" },
    });
    expect(graph.initialPierreSources).toEqual([pierre]);
    expect(graph.eagerGrammarEntries).toEqual([grammar]);
  });

  it("reports every bundle contract violation", () => {
    const report = {
      graph: {
        initialPierreSources: ["pierre"],
        initialShikiSources: ["shiki"],
        eagerGrammarEntries: ["python"],
        pierreChunks: ["pierre.js", "shared.js"],
      },
      pierreLazy: { rawBytes: 11, gzipBytes: 11 },
      worker: { assets: [], rawBytes: 11 },
      sourceMaps: { checked: 0, pierreChunksContainingReact: [{ file: "pierre.js" }] },
      dependencyVersions: { react: ["18", "19"], reactDom: ["18", "19"] },
    };
    const violations = evaluateDiffBuildReport(report, {
      initialPierreSources: 0,
      initialShikiSources: 0,
      eagerGrammarEntries: 0,
      pierreLazyRawBytes: 10,
      pierreLazyGzipBytes: 10,
      workerAssets: 1,
      workerRawBytes: 10,
      reactVersions: 1,
      reactDomVersions: 1,
      pierreChunksContainingReact: 0,
    }, { requireSourceMaps: true });
    expect(violations.map(({ metric }: { metric: string }) => metric)).toEqual([
      "initial_pierre_sources",
      "initial_shiki_sources",
      "eager_grammar_entries",
      "pierre_lazy_raw_bytes",
      "pierre_lazy_gzip_bytes",
      "worker_assets",
      "worker_raw_bytes",
      "react_versions",
      "react_dom_versions",
      "pierre_chunks_containing_react",
      "pierre_source_maps",
    ]);
  });

  it("extracts one canonical React and React DOM version from pnpm snapshots", () => {
    const versions = extractReactVersions([
      "  react@19.2.7:",
      "  react-dom@19.2.7(react@19.2.7):",
      "  react@19.2.7:",
    ].join("\n"));
    expect(versions).toEqual({ react: ["19.2.7"], reactDom: ["19.2.7"] });
  });
});
