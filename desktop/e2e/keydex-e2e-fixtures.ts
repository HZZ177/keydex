import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
  workspaceId: string;
  api<T>(requestPath: string, init?: RequestInit): Promise<T>;
  configurePage(page: Page): Promise<void>;
  createChatSession(title?: string): Promise<KeydexSession>;
  createWorkspaceSession(title?: string): Promise<KeydexSession>;
  createAdditionalWorkspace(name: string): Promise<KeydexAdditionalWorkspace>;
  waitForModelRequest(message: string, occurrence?: number): Promise<void>;
  writeLegacyKeydexJson(source: "system" | "workspace", value: unknown): Promise<void>;
  writeSystemKeydexMarkdown(content: string | Uint8Array): Promise<void>;
  writeWorkspaceKeydexMarkdown(content: string | Uint8Array): Promise<void>;
  removeSystemKeydexMarkdown(): Promise<void>;
  removeWorkspaceKeydexMarkdown(): Promise<void>;
  renameSystemKeydexMarkdown(targetName: string): Promise<void>;
  renameWorkspaceKeydexMarkdown(targetName: string): Promise<void>;
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
  evidence(page: Page, name: string, metadata?: Record<string, unknown>): Promise<void>;
  stop(): Promise<void>;
}

export interface KeydexSession {
  id: string;
  session_type: "chat" | "workspace";
  workspace_id: string | null;
  [key: string]: unknown;
}

export interface KeydexAdditionalWorkspace {
  id: string;
  rootPath: string;
  createSession(title?: string): Promise<KeydexSession>;
  writeKeydexMarkdown(content: string | Uint8Array): Promise<void>;
  removeKeydexMarkdown(): Promise<void>;
}

export interface KeydexE2EFixtureOptions {
  runRoot?: string;
  cleanupRunDir?: boolean;
}

export async function startKeydexE2EFixture(
  name: string,
  options: KeydexE2EFixtureOptions = {},
): Promise<KeydexE2EFixture> {
  const port = await availablePort();
  const safeName = name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  const runRoot = options.runRoot
    ? path.resolve(options.runRoot)
    : path.join(REPO_ROOT, ".dev", "test", "system-workspace-keydex-hierarchy");
  const runDir = path.join(
    runRoot,
    `${safeName}-${process.pid}-${Date.now()}`,
  );
  const dataDir = path.join(runDir, "data");
  const systemRoot = path.join(runDir, "system-keydex");
  const workspaceRoot = path.join(runDir, "workspace");
  const evidenceDir = path.join(
    REPO_ROOT,
    ".dev",
    "e2e",
    "evidence",
    "2026-07-15_21-52-18-keydex-workspace-capability-runtime",
  );
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
  const markdownPath = (source: "system" | "workspace") =>
    path.join(skillRoot(source), "keydex.md");
  const writeMarkdown = async (source: "system" | "workspace", content: string | Uint8Array) => {
    await mkdir(skillRoot(source), { recursive: true });
    await writeFile(markdownPath(source), content);
    await settleWatcher();
  };
  const removeMarkdown = async (source: "system" | "workspace") => {
    await unlink(markdownPath(source)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await settleWatcher();
  };
  const renameMarkdown = async (source: "system" | "workspace", targetName: string) => {
    await rename(markdownPath(source), path.join(skillRoot(source), targetName));
    await settleWatcher();
  };
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
    await settleWatcher();
  };

  return {
    baseUrl,
    appBaseUrl: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173",
    dataDir,
    evidenceDir,
    runDir,
    systemRoot,
    workspaceRoot,
    workspaceId: workspace.id,
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
    async waitForModelRequest(message, occurrence = 1) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const payload = await api<{ observations: Array<{ last_user: string }> }>(
          "/api/e2e/model-observations",
        );
        if (
          payload.observations.filter((observation) => observation.last_user === message).length >=
          occurrence
        ) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Timed out waiting for model request: ${message} #${occurrence}`);
    },
    async createAdditionalWorkspace(name) {
      const safeWorkspaceName = name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
      const rootPath = path.join(runDir, `workspace-${safeWorkspaceName}`);
      await mkdir(rootPath, { recursive: true });
      await writeFile(path.join(rootPath, "README.md"), `# ${name}\n`, "utf8");
      const created = await api<{ workspace: { id: string } }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ root_path: rootPath, name }),
      });
      const keydexRoot = path.join(rootPath, ".keydex");
      const keydexMarkdown = path.join(keydexRoot, "keydex.md");
      return {
        id: created.workspace.id,
        rootPath,
        async createSession(title = `${name} E2E Workspace`) {
          const response = await api<{ session: KeydexSession }>("/api/sessions", {
            method: "POST",
            body: JSON.stringify({
              title,
              session_type: "workspace",
              workspace_id: created.workspace.id,
            }),
          });
          return response.session;
        },
        async writeKeydexMarkdown(content) {
          await mkdir(keydexRoot, { recursive: true });
          await writeFile(keydexMarkdown, content);
          await settleWatcher();
        },
        async removeKeydexMarkdown() {
          await unlink(keydexMarkdown).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
          await settleWatcher();
        },
      };
    },
    async writeLegacyKeydexJson(source, value) {
      const keydexRoot = skillRoot(source);
      await mkdir(keydexRoot, { recursive: true });
      await writeFile(
        path.join(keydexRoot, "keydex.md"),
        typeof value === "string" ? value : JSON.stringify(value),
        "utf8",
      );
      await settleWatcher();
    },
    writeSystemKeydexMarkdown: (content) => writeMarkdown("system", content),
    writeWorkspaceKeydexMarkdown: (content) => writeMarkdown("workspace", content),
    removeSystemKeydexMarkdown: () => removeMarkdown("system"),
    removeWorkspaceKeydexMarkdown: () => removeMarkdown("workspace"),
    renameSystemKeydexMarkdown: (targetName) => renameMarkdown("system", targetName),
    renameWorkspaceKeydexMarkdown: (targetName) => renameMarkdown("workspace", targetName),
    writeSkill,
    async writeInvalidSkill(source, skillName) {
      const root = path.join(skillRoot(source), "skills", skillName);
      await mkdir(root, { recursive: true });
      await writeFile(
        path.join(root, "SKILL.md"),
        `---\nname: ${skillName}\n---\n\ninvalid candidate\n`,
        "utf8",
      );
      await settleWatcher();
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
      await settleWatcher();
    },
    async removeSkill(source, skillName) {
      await rm(path.join(skillRoot(source), "skills", skillName), { recursive: true, force: true });
      await settleWatcher();
    },
    async evidence(page, evidenceName, _metadata = {}) {
      const safeEvidenceName = evidenceName.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
      const screenshotPath = path.join(evidenceDir, `${safeEvidenceName}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
    },
    async stop() {
      await stopChild(child);
      await writeFile(path.join(runDir, "backend.log"), processLog.join(""), "utf8");
      if (options.cleanupRunDir) {
        const normalizedRunRoot = path.resolve(runRoot);
        const normalizedRunDir = path.resolve(runDir);
        if (!normalizedRunDir.startsWith(`${normalizedRunRoot}${path.sep}`)) {
          throw new Error(`Refusing to clean E2E path outside its run root: ${normalizedRunDir}`);
        }
        await rm(normalizedRunDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });
      }
    },
  };
}

async function settleWatcher(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 160));
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
