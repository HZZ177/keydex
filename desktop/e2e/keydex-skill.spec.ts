import { expect, test, type Locator, type Page } from "@playwright/test";

import { startKeydexE2EFixture, type KeydexE2EFixture, type KeydexSession } from "./keydex-e2e-fixtures";

test.describe.configure({ mode: "serial" });

let fixture: KeydexE2EFixture;

test.beforeAll(async () => {
  fixture = await startKeydexE2EFixture("project-hierarchy");
  await fixture.writeSystemKeydexMarkdown("SYSTEM-MD-PROJECT");
  await fixture.writeWorkspaceKeydexMarkdown("WORKSPACE-MD-PROJECT");
  await fixture.writeSkill(
    "system",
    "shared",
    "Shared system V1",
    "SYSTEM-SHARED-V1",
    { "references/system-secret.txt": "SYSTEM-SECRET-OUTSIDE-WORKSPACE\n" },
  );
  await fixture.writeSkill("system", "system-only", "System only V1", "SYSTEM-ONLY-V1");
  await fixture.writeSkill("workspace", "local", "Workspace local", "WORKSPACE-LOCAL");
});

test.afterAll(async () => {
  await fixture?.stop();
});

test("project hierarchy, watcher, security preview and affected pages use one effective catalog", async ({ page }) => {
  test.setTimeout(180_000);
  await fixture.configurePage(page);
  const session = await fixture.createWorkspaceSession();
  const workspaceId = requiredWorkspaceId(session);
  let skillRequestCount = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/sessions/${session.id}/skills`) skillRequestCount += 1;
  });

  await page.goto(`${fixture.appBaseUrl}/#/conversation/${session.id}`);
  const input = page.getByLabel("继续输入");
  await expect(input).toBeVisible();

  await test.step("P01 a project inherits one system winner", async () => {
    await expectSkillWinner(page, input, "shared", "Shared system V1", "系统级");
    await selectAndSend(page, input, "shared", "KeydexSkillE2E shared system");
    await expect(page.getByText(/KeydexSkillE2E activated SYSTEM-SHARED-V1/)).toBeVisible({
      timeout: 30_000,
    });
    const activation = page.getByTestId("skill-activation-block").filter({ hasText: "shared" }).last();
    await expect(activation).toHaveAttribute("data-skill-source", "system");
    await fixture.evidence(page, "p01-project-inherits-system-winner", {
      session_id: session.id,
      expected_source: "system",
    });
  });

  await test.step("P02 workspace add, modify, rename and delete switch the winner without reload", async () => {
    await fixture.writeSkill("workspace", "shared", "Shared workspace V1", "WORKSPACE-SHARED-V1");
    await expectSkillWinner(page, input, "shared", "Shared workspace V1", "项目级");
    await selectAndSend(page, input, "shared", "KeydexSkillE2E shared workspace");
    await expect(page.getByText(/KeydexSkillE2E activated WORKSPACE-SHARED-V1/)).toBeVisible({
      timeout: 30_000,
    });

    await fixture.writeSkill("workspace", "shared", "Shared workspace V2", "WORKSPACE-SHARED-V2");
    await expectSkillWinner(page, input, "shared", "Shared workspace V2", "项目级");
    await selectAndSend(page, input, "shared", "KeydexSkillE2E shared workspace");
    await expect(page.getByText(/KeydexSkillE2E activated WORKSPACE-SHARED-V2/)).toBeVisible({
      timeout: 30_000,
    });

    await fixture.writeSkill("workspace", "rename-old", "Rename old", "RENAME-OLD");
    await expectSkillWinner(page, input, "rename-old", "Rename old", "项目级");
    await fixture.renameSkill("workspace", "rename-old", "rename-new", "Rename new", "RENAME-NEW");
    await expectSkillWinner(page, input, "rename-new", "Rename new", "项目级");
    await expectSkillMissing(page, input, "rename-old");
    await fixture.removeSkill("workspace", "rename-new");
    await expectSkillMissing(page, input, "rename-new");

    await fixture.removeSkill("workspace", "shared");
    await expectSkillWinner(page, input, "shared", "Shared system V1", "系统级");
    await selectAndSend(page, input, "shared", "KeydexSkillE2E shared system");
    await expect(page.getByText(/KeydexSkillE2E activated SYSTEM-SHARED-V1/).last()).toBeVisible({
      timeout: 30_000,
    });
    await fixture.evidence(page, "p02-workspace-winner-and-system-fallback", {
      add_marker: "WORKSPACE-SHARED-V1",
      modify_marker: "WORKSPACE-SHARED-V2",
      fallback_marker: "SYSTEM-SHARED-V1",
    });
  });

  await test.step("P03 legacy inherit_system false is ignored and fixed inheritance remains live", async () => {
    await fixture.writeLegacyKeydexJson("workspace", {
      schema_version: 1,
      skills: { enabled: false, inherit_system: false },
    });
    await expectSkillWinner(page, input, "shared", "Shared system V1", "系统级");

    await fixture.writeSkill("system", "system-only", "System only V2", "SYSTEM-ONLY-V2");
    await expectSkillWinner(page, input, "system-only", "System only V2", "系统级");
    const after = await effectiveSkills(session.id, true);
    expect(after.skills.map((skill) => skill.name)).toEqual([
      "keydex-guide",
      "local",
      "shared",
      "system-only",
    ]);
    expect(skillRequestCount).toBeGreaterThan(0);
    await fixture.evidence(page, "p03-legacy-config-ignored-fixed-inheritance");
  });

  await test.step("P04 an invalid workspace candidate blocks system fallback and repair recovers", async () => {
    await fixture.writeInvalidSkill("workspace", "shared");
    await openSkillGroup(page, input);
    const diagnostic = page.getByTestId("skill-diagnostic");
    await expect(diagnostic).toBeVisible({ timeout: 15_000 });
    await expect(diagnostic).toContainText("Skill 配置错误");
    await expect(diagnostic).toHaveAttribute("data-diagnostic-code", /skill_/);
    await expect(page.getByRole("option", { name: "选择 Skill /shared" })).toHaveCount(0);
    const blocked = await effectiveSkills(session.id, true);
    expect(blocked.skills.some((skill) => skill.name === "shared")).toBe(false);
    expect(blocked.diagnostics.some((item) => item.code === "skill_shadow_barrier")).toBe(true);

    await fixture.writeSkill("workspace", "shared", "Shared workspace repaired", "WORKSPACE-REPAIRED");
    await expectSkillWinner(page, input, "shared", "Shared workspace repaired", "项目级");
    await selectAndSend(page, input, "shared", "KeydexSkillE2E shared workspace");
    await expect(page.getByText(/KeydexSkillE2E activated WORKSPACE-REPAIRED/)).toBeVisible({
      timeout: 30_000,
    });
    await fixture.evidence(page, "p04-shadow-barrier-repaired", {
      barrier_code: "skill_shadow_barrier",
      repaired_source: "workspace",
    });
  });

  await test.step("P05 Conversation and Workbench agree; system preview is controlled and read-only", async () => {
    await fixture.removeSkill("workspace", "shared");
    await expectSkillWinner(page, input, "shared", "Shared system V1", "系统级");

    await page.goto(`${fixture.appBaseUrl}/#/workbench/${workspaceId}/session/${session.id}`);
    const workbenchInput = await openWorkbenchComposer(page);
    await expectSkillWinner(page, workbenchInput, "shared", "Shared system V1", "系统级");
    await page.getByRole("option", { name: "选择 Skill /shared" }).click();
    await page.getByLabel("打开 Skill shared").click();

    const systemPreview = page.getByTestId("workbench-main-file-preview").locator(
      '[data-file-preview-root="true"][data-preview-source="skill-resource"][data-skill-source="system"]',
    );
    await expect(systemPreview).toBeVisible({ timeout: 20_000 });
    await expect(systemPreview).toContainText("SYSTEM-SHARED-V1");
    await expect(systemPreview).toHaveAttribute("data-file-preview-new-annotations-enabled", "false");
    await expect(systemPreview).toHaveAttribute("data-file-preview-file-allows-annotations", "false");
    await expect(systemPreview).not.toHaveAttribute("data-file-preview-auto-save-state", /.+/);

    const tree = await fixture.api<unknown>(`/api/workspaces/${workspaceId}/tree`);
    expect(JSON.stringify(tree)).not.toContain("system-keydex");
    expect(JSON.stringify(tree)).not.toContain("system-secret");
    const search = await fixture.api<Array<{ path: string }>>(
      `/api/workspaces/${workspaceId}/search?q=${encodeURIComponent("system-secret")}`,
    );
    expect(search).toEqual([]);
    await expectWorkspaceEscapeRejected(workspaceId);

    await page.getByRole("button", { name: "选择文件 README.md" }).click();
    const workspacePreview = page.getByTestId("workbench-main-file-preview").locator(
      '[data-file-preview-root="true"][data-preview-source="file"]',
    );
    await expect(workspacePreview).toBeVisible({ timeout: 20_000 });
    await expect(workspacePreview).toContainText("Keydex E2E workspace");
    await expect(workspacePreview).toHaveAttribute("data-file-preview-file-allows-annotations", "true");
    await fixture.evidence(page, "p05-system-preview-and-workspace-file-isolation", {
      system_preview_source: "skill-resource",
      workspace_preview_source: "file",
      outside_read_write_status: 403,
    });
  });

  await test.step("P06 Home, Conversation, Workbench and project history retain the same winner semantics", async () => {
    await page.goto(`${fixture.appBaseUrl}/#/conversation/${session.id}`);
    await page.reload();
    await expect(page.locator('[data-skill-source="system"]')).not.toHaveCount(0);
    await expect(page.locator('[data-skill-source="workspace"]')).not.toHaveCount(0);
    await expect(page.getByText(/KeydexSkillE2E activated WORKSPACE-REPAIRED/)).toBeVisible({
      timeout: 30_000,
    });

    await page.goto(`${fixture.appBaseUrl}/#/guid`);
    await page.getByLabel("选择工作区").click();
    await page
      .getByRole("dialog", { name: "工作区选择" })
      .getByRole("option")
      .filter({ hasText: /^keydex-e2e/ })
      .click();
    await expect(page.getByRole("heading", { name: "我们应该在 keydex-e2e 中构建什么？" })).toBeVisible();
    const homeInput = page.getByLabel("输入需求");
    await expectSkillWinner(page, homeInput, "shared", "Shared system V1", "系统级");
    await fixture.evidence(page, "p06-home-conversation-workbench-history", {
      project_home_winner: "system:shared",
      historical_sources: ["system", "workspace"],
    });
  });

  async function effectiveSkills(sessionId: string, forceReload: boolean): Promise<EffectiveSkills> {
    return fixture.api<EffectiveSkills>(
      `/api/sessions/${sessionId}/skills${forceReload ? "?force_reload=true" : ""}`,
    );
  }

  async function expectWorkspaceEscapeRejected(id: string) {
    const escapePath = "../system-keydex/skills/shared/SKILL.md";
    const readResponse = await fetch(
      `${fixture.baseUrl}/api/workspaces/${id}/read?path=${encodeURIComponent(escapePath)}`,
    );
    expect(readResponse.status).toBe(403);
    expect((await readResponse.json()).detail.code).toBe("workspace_path_forbidden");

    const writeResponse = await fetch(`${fixture.baseUrl}/api/workspaces/${id}/write/document`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol_version: "document-write/v1",
        write_id: "keydex-e2e-system-escape",
        path: escapePath,
        content: "must not write",
        expected_revision: `sha256:${"0".repeat(64)}`,
      }),
    });
    expect(writeResponse.status).toBe(403);
    expect((await writeResponse.json()).detail.code).toBe("workspace_path_forbidden");
  }
});

async function expectSkillWinner(
  page: Page,
  input: Locator,
  name: string,
  description: string,
  sourceLabel: "系统级" | "项目级",
) {
  await replaceComposer(input, `/${name}`);
  const option = page.getByRole("option", { name: `选择 Skill /${name}` });
  await expect(option).toHaveCount(1, { timeout: 15_000 });
  await expect(option).toContainText(description, { timeout: 15_000 });
  await expect(option).toContainText(sourceLabel);
}

async function expectSkillMissing(page: Page, input: Locator, name: string) {
  await replaceComposer(input, `/${name}`);
  await expect(page.getByTestId("slash-command-menu")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("option", { name: `选择 Skill /${name}` })).toHaveCount(0, {
    timeout: 15_000,
  });
}

async function selectAndSend(page: Page, input: Locator, name: string, message: string) {
  await replaceComposer(input, `${message} /${name}`);
  const option = page.getByRole("option", { name: `选择 Skill /${name}` });
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click();
  await expect(input).toHaveText(message);
  await page.getByLabel("发送").click();
}

async function openSkillGroup(page: Page, input: Locator) {
  await replaceComposer(input, "/");
  const group = page.getByRole("option").filter({ hasText: /^Skill/ });
  await expect(group).toBeVisible({ timeout: 15_000 });
  await group.click();
}

async function openWorkbenchComposer(page: Page): Promise<Locator> {
  const input = page.getByLabel("工作台助手输入");
  if ((await input.count()) === 0) {
    await page.getByRole("button", { name: "展开工作台输入框" }).click();
  }
  await expect(input).toBeVisible();
  return input;
}

async function replaceComposer(input: Locator, value: string) {
  await input.click();
  await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await input.press("Backspace");
  if (value) await input.pressSequentially(value);
}

function requiredWorkspaceId(session: KeydexSession): string {
  if (!session.workspace_id) throw new Error("Expected a workspace-bound E2E session");
  return session.workspace_id;
}

interface EffectiveSkills {
  fingerprint: string;
  skills: Array<{ name: string; source: "system" | "workspace" }>;
  diagnostics: Array<{ code: string }>;
}
