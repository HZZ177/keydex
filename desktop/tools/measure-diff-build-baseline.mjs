import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { measureDiffBuild } from "./diff-build-manifest.mjs";

const distRoot = resolve(process.cwd(), "dist");
const manifest = JSON.parse(await readFile(resolve(distRoot, ".vite", "manifest.json"), "utf8"));
const lockText = await readFile(resolve(process.cwd(), "pnpm-lock.yaml"), "utf8");
const measurement = await measureDiffBuild({
  distRoot,
  manifest,
  lockText,
  requireSourceMaps: process.argv.includes("--require-sourcemaps"),
});

process.stdout.write(`${JSON.stringify(measurement, null, 2)}\n`);
if (measurement.violations.length > 0) process.exitCode = 1;
