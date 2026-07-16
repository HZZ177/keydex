import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Page } from "@playwright/test";

import { startKeydexE2EFixture, type KeydexE2EFixture } from "./keydex-e2e-fixtures";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_PREFIX = "e2e-git-";
const FIXTURE_RUN_ROOT = path.resolve(
  process.env.KEYDEX_GIT_E2E_RUN_ROOT ?? path.join(tmpdir(), "keydex-git-e2e"),
);
const GIT_IDENTITY = {
  name: "Keydex Git E2E",
  email: "keydex-git-e2e@example.invalid",
} as const;

export interface GitCommandOutput {
  stdout: string;
  stderr: string;
}

export interface GitE2EFixture extends KeydexE2EFixture {
  repositoryRoot: string;
  bareRemoteRoot: string;
  git(args: readonly string[], cwd?: string): Promise<GitCommandOutput>;
  write(relativePath: string, content: string): Promise<void>;
  commit(message: string, relativePaths?: readonly string[]): Promise<string>;
  createBranch(name: string, checkout?: boolean): Promise<void>;
  screenshot(page: Page, caseId: string): Promise<string>;
  cleanup(): Promise<void>;
}

export function startGitBaseE2EFixture(name: string): Promise<KeydexE2EFixture> {
  return startKeydexE2EFixture(name, {
    runRoot: FIXTURE_RUN_ROOT,
    cleanupRunDir: true,
  });
}

export async function startGitE2EFixture(name: string): Promise<GitE2EFixture> {
  const safeName = fixtureSafeName(name);
  const base = await startGitBaseE2EFixture(`${FIXTURE_PREFIX}${safeName}`);
  assertFixturePath(base.runDir);
  const repositoryRoot = base.workspaceRoot;
  const bareRemoteRoot = path.join(base.runDir, `${FIXTURE_PREFIX}origin.git`);
  const evidenceRoot = path.join(
    REPO_ROOT,
    ".dev",
    "e2e",
    "evidence",
    "2026-07-15_22-24-53-keydex-git-workbench",
  );
  const runGit = (args: readonly string[], cwd = repositoryRoot) => gitCommand(args, cwd);

  try {
    await runGit(["init", "--initial-branch=main"]);
    await runGit(["config", "user.name", GIT_IDENTITY.name]);
    await runGit(["config", "user.email", GIT_IDENTITY.email]);
    await runGit(["config", "core.autocrlf", "false"]);
    await runGit(["config", "core.safecrlf", "false"]);
    await runGit(["config", "core.quotepath", "false"]);
    await runGit(["add", "--", "README.md"]);
    await runGit(["commit", "-m", "e2e: initial commit"]);
    await gitCommand(["init", "--bare", "--initial-branch=main", bareRemoteRoot], base.runDir);
    await runGit(["remote", "add", "origin", bareRemoteRoot]);
    await runGit(["push", "--set-upstream", "origin", "main"]);
  } catch (error) {
    await base.stop();
    await guardedRemoveFixturePath(base.runDir);
    throw error;
  }

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await base.stop();
    await guardedRemoveFixturePath(base.runDir);
  };

  return {
    ...base,
    repositoryRoot,
    bareRemoteRoot,
    git: runGit,
    async write(relativePath, content) {
      const target = resolveFixtureChild(repositoryRoot, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    },
    async commit(message, relativePaths = ["."]) {
      await runGit(["add", "--", ...relativePaths]);
      await runGit(["commit", "-m", message]);
      return (await runGit(["rev-parse", "HEAD"])).stdout.trim();
    },
    async createBranch(branchName, checkout = false) {
      assertGitRefName(branchName);
      await runGit(checkout ? ["switch", "-c", branchName] : ["branch", branchName]);
    },
    async screenshot(page, caseId) {
      const safeCaseId = fixtureSafeName(caseId);
      await mkdir(evidenceRoot, { recursive: true });
      const target = path.join(evidenceRoot, `${safeCaseId}.png`);
      await page.screenshot({ path: target, fullPage: true });
      return target;
    },
    cleanup,
    stop: cleanup,
  };
}

export function assertFixturePath(target: string): void {
  const basename = path.basename(path.resolve(target)).toLowerCase();
  if (!basename.startsWith(FIXTURE_PREFIX)) {
    throw new Error(`Refusing to clean a non-${FIXTURE_PREFIX} path: ${target}`);
  }
}

export function resolveFixtureChild(root: string, relativePath: string): string {
  const normalizedRoot = path.resolve(root);
  const target = path.resolve(normalizedRoot, relativePath);
  const prefix = `${normalizedRoot}${path.sep}`.toLowerCase();
  if (target.toLowerCase() !== normalizedRoot.toLowerCase() && !target.toLowerCase().startsWith(prefix)) {
    throw new Error(`Git fixture path escapes repository root: ${relativePath}`);
  }
  return target;
}

async function guardedRemoveFixturePath(target: string): Promise<void> {
  assertFixturePath(target);
  await rm(target, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });
}

async function gitCommand(args: readonly string[], cwd: string): Promise<GitCommandOutput> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    windowsHide: true,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function fixtureSafeName(value: string): string {
  const safe = value.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return safe || "fixture";
}

function assertGitRefName(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes("..") || value.endsWith("/")) {
    throw new Error(`Invalid fixture Git ref: ${value}`);
  }
}
