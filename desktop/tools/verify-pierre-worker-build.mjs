import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";

const root = resolve(import.meta.dirname, "..");
const outDir = await mkdtemp(join(tmpdir(), "keydex-pierre-worker-"));

try {
  await build({
    root,
    configFile: resolve(root, "vite.config.ts"),
    logLevel: "error",
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: {
        input: resolve(root, "tests/fixtures/pierre-worker-entry.ts"),
      },
    },
  });

  const files = await collectFiles(outDir);
  const javascript = files.filter((path) => path.endsWith(".js"));
  const workerAssets = [];
  for (const path of javascript) {
    const source = await readFile(path, "utf8");
    const details = await stat(path);
    if (
      details.size > 100_000
      && (source.includes("Worker request must include") || source.includes("Unhandled error"))
    ) {
      workerAssets.push({ path, size: details.size });
    }
  }
  if (workerAssets.length !== 1) {
    throw new Error(`Expected one local Pierre worker asset, found ${workerAssets.length}`);
  }
  const entrySource = await Promise.all(javascript.map((path) => readFile(path, "utf8")));
  if (!entrySource.some((source) => source.includes('type:"module"') || source.includes('type: "module"'))) {
    throw new Error("Pierre worker factory build does not preserve module Worker semantics");
  }
  process.stdout.write(`PIERRE_WORKER_ASSET_OK ${workerAssets[0].size}\n`);
} finally {
  await rm(outDir, { recursive: true, force: true });
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else files.push(path);
  }
  return files;
}
