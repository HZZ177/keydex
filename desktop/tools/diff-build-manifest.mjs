import { readFile, readdir, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

export const DIFF_BUILD_BUDGET = Object.freeze({
  initialPierreSources: 0,
  initialShikiSources: 0,
  eagerGrammarEntries: 0,
  pierreLazyRawBytes: 1_000_000,
  pierreLazyGzipBytes: 300_000,
  workerAssets: 1,
  workerRawBytes: 300_000,
  reactVersions: 1,
  reactDomVersions: 1,
  pierreChunksContainingReact: 0,
});

export function analyzeManifestGraph(manifest) {
  const entries = Object.entries(manifest);
  const entry = entries.find(([, chunk]) => chunk.isEntry);
  if (!entry) throw new Error("Vite manifest does not contain an application entry");
  const initial = collectStaticClosure(manifest, [entry[0]]);
  const pierreRoots = entries
    .filter(([source, chunk]) => isPierreSource(source) && chunk.isDynamicEntry)
    .map(([source]) => source);
  if (pierreRoots.length === 0) throw new Error("Vite manifest does not contain a lazy Pierre entry");
  const pierre = collectStaticClosure(manifest, pierreRoots, initial);
  const grammarEntries = entries
    .filter(([source]) => isGrammarSource(source))
    .map(([source]) => source);
  const workerAssets = entries
    .filter(([source, chunk]) => isPierreWorkerAsset(source, chunk))
    .map(([, chunk]) => chunk.file);
  return Object.freeze({
    entrySource: entry[0],
    entryFile: entry[1].file,
    initialSources: Object.freeze([...initial]),
    pierreSources: Object.freeze([...pierre]),
    initialPierreSources: Object.freeze([...initial].filter(isPierreSource)),
    initialShikiSources: Object.freeze([...initial].filter(isShikiSource)),
    grammarEntries: Object.freeze(grammarEntries),
    eagerGrammarEntries: Object.freeze(grammarEntries.filter((source) => (
      initial.has(source) || !manifest[source]?.isDynamicEntry
    ))),
    pierreRoots: Object.freeze(pierreRoots),
    workerAssets: Object.freeze([...new Set(workerAssets)]),
  });
}

export async function measureDiffBuild({
  distRoot = resolve(process.cwd(), "dist"),
  manifest,
  lockText = "",
  requireSourceMaps = false,
}) {
  const graph = analyzeManifestGraph(manifest);
  const initial = await measureFiles(distRoot, [manifest[graph.entrySource].file]);
  const pierreFiles = graph.pierreSources.map((source) => manifest[source].file);
  const pierreLazy = await measureFiles(distRoot, pierreFiles);
  const workerAssets = [...new Set([
    ...graph.workerAssets,
    ...await discoverWorkerAssets(distRoot),
  ])];
  const worker = await measureFiles(distRoot, workerAssets);
  const sourceMaps = await inspectPierreSourceMaps(distRoot, pierreFiles);
  const dependencyVersions = extractReactVersions(lockText);
  const report = {
    schemaVersion: 2,
    entry: { file: graph.entryFile, ...initial },
    graph: {
      initialSources: graph.initialSources.length,
      initialPierreSources: graph.initialPierreSources,
      initialShikiSources: graph.initialShikiSources,
      pierreRoots: graph.pierreRoots,
      pierreChunks: pierreFiles,
      grammarEntries: graph.grammarEntries.length,
      eagerGrammarEntries: graph.eagerGrammarEntries,
    },
    pierreLazy,
    worker: { assets: workerAssets, ...worker },
    sourceMaps,
    dependencyVersions,
    budget: DIFF_BUILD_BUDGET,
    violations: [],
  };
  report.violations = evaluateDiffBuildReport(report, DIFF_BUILD_BUDGET, { requireSourceMaps });
  return report;
}

export function evaluateDiffBuildReport(report, budget = DIFF_BUILD_BUDGET, options = {}) {
  const violations = [];
  maximum(violations, "initial_pierre_sources", report.graph.initialPierreSources.length, budget.initialPierreSources);
  maximum(violations, "initial_shiki_sources", report.graph.initialShikiSources.length, budget.initialShikiSources);
  maximum(violations, "eager_grammar_entries", report.graph.eagerGrammarEntries.length, budget.eagerGrammarEntries);
  maximum(violations, "pierre_lazy_raw_bytes", report.pierreLazy.rawBytes, budget.pierreLazyRawBytes);
  maximum(violations, "pierre_lazy_gzip_bytes", report.pierreLazy.gzipBytes, budget.pierreLazyGzipBytes);
  exact(violations, "worker_assets", report.worker.assets.length, budget.workerAssets);
  maximum(violations, "worker_raw_bytes", report.worker.rawBytes, budget.workerRawBytes);
  maximum(violations, "react_versions", report.dependencyVersions.react.length, budget.reactVersions);
  maximum(violations, "react_dom_versions", report.dependencyVersions.reactDom.length, budget.reactDomVersions);
  maximum(
    violations,
    "pierre_chunks_containing_react",
    report.sourceMaps.pierreChunksContainingReact.length,
    budget.pierreChunksContainingReact,
  );
  if (options.requireSourceMaps && report.sourceMaps.checked !== report.graph.pierreChunks.length) {
    violations.push({
      metric: "pierre_source_maps",
      actual: report.sourceMaps.checked,
      expected: report.graph.pierreChunks.length,
    });
  }
  return violations;
}

export function extractReactVersions(lockText) {
  return Object.freeze({
    react: Object.freeze(extractPackageVersions(lockText, "react")),
    reactDom: Object.freeze(extractPackageVersions(lockText, "react-dom")),
  });
}

export function collectStaticClosure(manifest, roots, stopAt = new Set()) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const source = queue.pop();
    if (!source || seen.has(source) || stopAt.has(source) || !manifest[source]) continue;
    seen.add(source);
    queue.push(...(manifest[source].imports ?? []));
  }
  return seen;
}

function isPierreSource(source) {
  return source.includes("/@pierre+diffs@") || source.includes("/node_modules/@pierre/diffs/");
}

function isShikiSource(source) {
  return source.includes("/@shikijs+") || source.includes("/shiki@");
}

function isGrammarSource(source) {
  return source.includes("/@shikijs+langs@") || source.includes("/shiki/dist/langs/");
}

function isPierreWorkerAsset(source, chunk) {
  return source.includes("@pierre/diffs/worker/worker-portable.js")
    || chunk.file?.includes("worker-portable-");
}

async function measureFiles(distRoot, files) {
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const file of [...new Set(files)]) {
    const buffer = await readFile(resolve(distRoot, file));
    rawBytes += buffer.byteLength;
    gzipBytes += gzipSync(buffer).byteLength;
  }
  return { files: [...new Set(files)].length, rawBytes, gzipBytes };
}

async function inspectPierreSourceMaps(distRoot, files) {
  let checked = 0;
  const pierreChunksContainingReact = [];
  for (const file of [...new Set(files)]) {
    const mapPath = resolve(distRoot, `${file}.map`);
    try {
      await stat(mapPath);
    } catch {
      continue;
    }
    checked += 1;
    const map = JSON.parse(await readFile(mapPath, "utf8"));
    const reactSources = (map.sources ?? []).filter((source) => (
      /(?:^|\/)node_modules\/(?:\.pnpm\/react(?:-dom)?@[^/]+\/node_modules\/)?react(?:-dom)?\//u.test(source)
    ));
    if (reactSources.length > 0) {
      pierreChunksContainingReact.push({ file, sources: reactSources });
    }
  }
  return { checked, pierreChunksContainingReact };
}

async function discoverWorkerAssets(distRoot) {
  const assetNames = await readdir(resolve(distRoot, "assets"));
  return assetNames
    .filter((name) => /^worker-portable-[^.]+\.js$/u.test(name))
    .map((name) => `assets/${name}`);
}

function extractPackageVersions(lockText, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^  ${escaped}@([^:()\\s]+)(?:\\([^:]+\\))?:$`, "gmu");
  return [...new Set([...lockText.matchAll(pattern)].map((match) => match[1]))].sort();
}

function maximum(violations, metric, actual, maximumValue) {
  if (actual > maximumValue) violations.push({ metric, actual, maximum: maximumValue });
}

function exact(violations, metric, actual, expected) {
  if (actual !== expected) violations.push({ metric, actual, expected });
}
