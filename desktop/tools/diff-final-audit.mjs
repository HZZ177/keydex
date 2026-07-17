import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export const PIERRE_DIFFS_VERSION = "1.2.12";

const SOURCE_EXTENSIONS = /\.(?:css|ts|tsx)$/u;
const FORBIDDEN_SOURCE_PATTERNS = Object.freeze([
  ["old_review_rows", /\bUnifiedDiffRows\b/u],
  ["old_review_projection", /\bfileReviewDisplayLines\b/u],
  ["old_git_viewer", /\bGitDiffViewer\b/u],
  ["old_preview_viewer", /\bDiffPreview\b/u],
  ["old_engine_flag", /keydex-native/u],
  ["old_dependency", /git-diff-view/u],
  ["temporary_gate", /\bmigrationGate\b/u],
  ["temporary_marker", /data-diff-migration/u],
  ["unfinished_inventory", /audit_then_remove/u],
  ["old_dom_selector", /data-(?:legacy-diff-renderer|git-diff-viewer)/u],
  ["old_css_selector", /\.(?:diffPane|diffLine)\b/u],
]);
const PIERRE_IMPORT = /(?:from\s+|import\s*\(\s*)["']@pierre\/diffs(?:\/[^"']*)?["']/u;
const APPROVED_PIERRE_BOUNDARY = "src/renderer/components/diff/";

export function auditDiffFinalEntries(entries, packageText, lockText) {
  const violations = [];
  for (const entry of entries) {
    const path = normalizePath(entry.path);
    for (const [code, pattern] of FORBIDDEN_SOURCE_PATTERNS) {
      if (pattern.test(entry.source)) violations.push({ code, path });
    }
    if (PIERRE_IMPORT.test(entry.source) && !path.startsWith(APPROVED_PIERRE_BOUNDARY)) {
      violations.push({ code: "pierre_boundary", path });
    }
  }

  const packageJson = JSON.parse(packageText);
  const dependencySections = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };
  if (dependencySections["@pierre/diffs"] !== PIERRE_DIFFS_VERSION) {
    violations.push({
      code: "pierre_version",
      actual: dependencySections["@pierre/diffs"] ?? null,
      expected: PIERRE_DIFFS_VERSION,
    });
  }
  for (const dependency of Object.keys(dependencySections)) {
    if (/git-diff-view|react-diff|diff2html/u.test(dependency)) {
      violations.push({ code: "competing_dependency", dependency });
    }
  }
  const lockVersions = new Set(Array.from(
    lockText.matchAll(/^\s{2}'@pierre\/diffs@([^'(]+)(?:\([^\n]*)?':$/gmu),
    (match) => match[1],
  ));
  if (lockVersions.size !== 1 || !lockVersions.has(PIERRE_DIFFS_VERSION)) {
    violations.push({ code: "lock_versions", actual: Array.from(lockVersions).sort() });
  }

  return Object.freeze({
    schemaVersion: 1,
    sourceFiles: entries.length,
    pierreVersion: dependencySections["@pierre/diffs"] ?? null,
    lockVersions: Object.freeze(Array.from(lockVersions).sort()),
    violations: Object.freeze(violations),
  });
}

async function collectSourceEntries(root) {
  const files = [];
  const visit = async (directory) => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, item.name);
      if (item.isDirectory()) await visit(path);
      else if (item.isFile() && SOURCE_EXTENSIONS.test(item.name)) files.push(path);
    }
  };
  await visit(root);
  return Promise.all(files.sort().map(async (path) => ({
    path: normalizePath(relative(resolve(root, ".."), path)),
    source: await readFile(path, "utf8"),
  })));
}

function normalizePath(path) {
  return path.split(sep).join("/");
}

const directExecution = process.argv[1]
  && resolve(process.argv[1]) === resolve(import.meta.filename);
if (directExecution) {
  const root = process.cwd();
  const report = auditDiffFinalEntries(
    await collectSourceEntries(resolve(root, "src")),
    await readFile(resolve(root, "package.json"), "utf8"),
    await readFile(resolve(root, "pnpm-lock.yaml"), "utf8"),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.violations.length > 0) process.exitCode = 1;
}
