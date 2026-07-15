import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PYTHON = path.join(REPO_ROOT, ".venv", "Scripts", "python.exe");
const SERVER_SCRIPT = path.join(REPO_ROOT, "backend", "tests", "e2e_keydex_server.py");

export interface KeydexE2EFixture {
  baseUrl: string;
  appBaseUrl: string;
  dataDir: string;
  evidenceDir: string;
  runDir: string;
  systemRoot: string;
  workspaceRoot: string;
  api<T>(requestPath: string, init?: RequestInit): Promise<T>;
  configurePage(page: Page): Promise<void>;
  createChatSession(title?: string): Promise<KeydexSession>;
  createWorkspaceSession(title?: string): Promise<KeydexSession>;
  writeSystemManifest(value?: unknown): Promise<void>;
  writeWorkspaceManifest(inheritSystem: boolean): Promise<void>;
  writeSkill(
    source: "system" | "workspace",
    name: string,
    description: string,
    marker: string,
    resources?: Record<string, string>,
  ): Promise<void>;
  writeInvalidSkill(source: "system" | "workspace", name: string): Promise<void>;
  renameSkill(
    source: "system" | "workspace",
    fromName: string,
    toName: string,
    description: string,
    marker: string,
  ): Promise<void>;
  removeSkill(source: "system" | "workspace", name: string): Promise<void>;
  removeWorkspaceManifest(): Promise<void>;
  evidence(page: Page, name: string, metadata?: Record<string, unknown>): Promise<void>;
  stop(): Promise<void>;
}

export interface KeydexSession {
  id: string;
  session_type: "chat" | "workspace";
  workspace_id: string | null;
  [key: string]: unknown;
}

export async function startKeydexE2EFixture(name: string): Promise<KeydexE2EFixture> {
  const port = await availablePort();
  const safeName = name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  const runDir = path.join(
    REPO_ROOT,
    ".dev",
    "test",
    "system-workspace-keydex-hierarchy",
    `${safeName}-${process.pid}-${Date.now()}`,
  );
  const dataDir = path.join(runDir, "data");
  const systemRoot = path.join(runDir, "system-keydex");
  const workspaceRoot = path.join(runDir, "workspace");
  const evidenceDir = path.join(runDir, "evidence");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(systemRoot, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(evidenceDir, { recursive: true }),
  ]);
  await writeFile(path.join(workspaceRoot, "README.md"), "# Keydex E2E workspace\n", "utf8");

  const child = spawn(
    PYTHON,
    [
      SERVER_SCRIPT,
      "--port",
      String(port),
      "--data-dir",
      dataDir,
      "--workspace-root",
      workspaceRoot,
      "--system-root",
      systemRoot,
      "--stream-delay-ms",
      "180",
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdio: "pipe",
      windowsHide: true,
    },
  );
  const processLog: string[] = [];
  child.stdout.on("data", (chunk) => appendProcessLog(processLog, String(chunk)));
  child.stderr.on("data", (chunk) => appendProcessLog(processLog, String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child, processLog);

  const api = async <T>(requestPath: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${baseUrl}${requestPath}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`${init.method ?? "GET"} ${requestPath} failed: ${response.status} ${body}`);
    }
    return (body ? JSON.parse(body) : null) as T;
  };

  const workspaces = await api<{ list: Array<{ id: string; root_path: string }> }>("/api/workspaces");
  let workspace = workspaces.list.find(
    (item) => normalizedPath(item.root_path) === normalizedPath(workspaceRoot),
  );
  if (!workspace) {
    const created = await api<{ workspace: { id: string; root_path: string } }>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ root_path: workspaceRoot, name: "keydex-e2e" }),
    });
    workspace = created.workspace;
  }

  const skillRoot = (source: "system" | "workspace") =>
    source === "system" ? systemRoot : path.join(workspaceRoot, ".keydex");
  const writeSkill = async (
    source: "system" | "workspace",
    skillName: string,
    description: string,
    marker: string,
    resources: Record<string, string> = {},
  ) => {
    const root = path.join(skillRoot(source), "skills", skillName);
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: ${description}\n---\n\n# ${skillName}\n\n${marker}\n`,
      "utf8",
    );
    await Promise.all(
      Object.entries(resources).map(async ([resourcePath, content]) => {
        const target = path.join(root, resourcePath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }),
    );
  };

  return {
    baseUrl,
    appBaseUrl: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173",
    dataDir,
    evidenceDir,
    runDir,
    systemRoot,
    workspaceRoot,
    api,
    async configurePage(page) {
      await page.addInitScript((agentBaseUrl) => {
        window.localStorage.setItem("keydex:agent-base-url", agentBaseUrl);
      }, baseUrl);
    },
    async createChatSession(title = "Keydex system E2E Chat") {
      const response = await api<{ session: KeydexSession }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ title, session_type: "chat" }),
      });
      return response.session;
    },
    async createWorkspaceSession(title = "Keydex hierarchy E2E Workspace") {
      const response = await api<{ session: KeydexSession }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          title,
          session_type: "workspace",
          workspace_id: workspace.id,
        }),
      });
      return response.session;
    },
    async writeSystemManifest(value = { schema_version: 1, skills: { enabled: true } }) {
      await mkdir(systemRoot, { recursive: true });
      await writeFile(
        path.join(systemRoot, "keydex.json"),
        typeof value === "string" ? value : JSON.stringify(value),
        "utf8",
      );
    },
    async writeWorkspaceManifest(inheritSystem) {
      const keydexRoot = skillRoot("workspace");
      await mkdir(keydexRoot, { recursive: true });
      await writeFile(
        path.join(keydexRoot, "keydex.json"),
        JSON.stringify({
          schema_version: 1,
          skills: { enabled: true, inherit_system: inheritSystem },
        }),
        "utf8",
      );
    },
    writeSkill,
    async writeInvalidSkill(source, skillName) {
      const root = path.join(skillRoot(source), "skills", skillName);
      await mkdir(root, { recursive: true });
      await writeFile(
        path.join(root, "SKILL.md"),
        `---\nname: ${skillName}\n---\n\ninvalid candidate\n`,
        "utf8",
      );
    },
    async renameSkill(source, fromName, toName, description, marker) {
      const sourceRoot = path.join(skillRoot(source), "skills", fromName);
      const targetRoot = path.join(skillRoot(source), "skills", toName);
      await rename(sourceRoot, targetRoot);
      await writeFile(
        path.join(targetRoot, "SKILL.md"),
        `---\nname: ${toName}\ndescription: ${description}\n---\n\n# ${toName}\n\n${marker}\n`,
        "utf8",
      );
    },
    async removeSkill(source, skillName) {
      await rm(path.join(skillRoot(source), "skills", skillName), { recursive: true, force: true });
    },
    async removeWorkspaceManifest() {
      await unlink(path.join(skillRoot("workspace"), "keydex.json")).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
    async evidence(page, evidenceName, metadata = {}) {
      const safeEvidenceName = evidenceName.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
      const screenshotPath = path.join(evidenceDir, `${safeEvidenceName}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const [systemFingerprint, workspaceFingerprint] = await Promise.all([
        treeFingerprint(systemRoot),
        treeFingerprint(path.join(workspaceRoot, ".keydex")),
      ]);
      await writeFile(
        path.join(evidenceDir, `${safeEvidenceName}.json`),
        JSON.stringify(
          {
            ...metadata,
            system_fingerprint: systemFingerprint,
            workspace_fingerprint: workspaceFingerprint,
            backend_base_url: baseUrl,
          },
          null,
          2,
        ),
        "utf8",
      );
    },
    async stop() {
      await stopChild(child);
      await writeFile(path.join(runDir, "backend.log"), processLog.join(""), "utf8");
    },
  };
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate E2E backend port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcessWithoutNullStreams,
  processLog: string[],
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Keydex E2E backend exited with ${child.exitCode}: ${processLog.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The server has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stopChild(child);
  throw new Error(`Timed out waiting for Keydex E2E backend: ${processLog.join("")}`);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>((resolve) =>
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 3_000),
    ),
  ]);
}

function appendProcessLog(log: string[], chunk: string) {
  log.push(chunk);
  while (log.join("").length > 200_000) log.shift();
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

async function treeFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  const { readdir, readFile } = await import("node:fs/promises");
  const visit = async (current: string, relative: string) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childPath = path.join(current, entry.name);
      hash.update(childRelative);
      if (entry.isDirectory()) await visit(childPath, childRelative);
      else if (entry.isFile()) hash.update(await readFile(childPath));
    }
  };
  await visit(root, "");
  return hash.digest("hex");
}
