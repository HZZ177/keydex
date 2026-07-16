import { expect, test } from "@playwright/test";

import {
  expectSkillMissing,
  expectSkillWinner,
  openConversation,
  openHomeScope,
  openSkillGroup,
  openWorkbench,
  replaceComposer,
  selectSkill,
  sendAndWait,
} from "./keydex-context-helpers";
import { startKeydexE2EFixture, type KeydexE2EFixture } from "./keydex-e2e-fixtures";

test.describe.configure({ mode: "serial" });

let fixture: KeydexE2EFixture;

test.beforeAll(async () => {
  fixture = await startKeydexE2EFixture("skill-context-coexistence");
});

test.beforeEach(async () => {
  await fixture.removeSystemKeydexMarkdown();
  await fixture.removeWorkspaceKeydexMarkdown();
  await fixture.removeSkill("workspace", "shared");
  await fixture.removeSkill("workspace", "local");
  await fixture.writeSkill("system", "shared", "Shared system V1", "SYSTEM-SHARED-V1", {
    "references/guide.md": "# System reference\n\nSYSTEM-REFERENCE",
  });
  await fixture.writeSkill("system", "system-demo", "System demo", "SYSTEM-DEMO");
});

test.afterAll(async () => {
  await fixture?.stop();
});

test("E19 damaged keydex.md is ignored while Skills and keydex.md work", async ({
  page,
}) => {
  await fixture.writeLegacyKeydexJson("system", "{invalid");
  await fixture.writeLegacyKeydexJson("workspace", "{invalid");
  await fixture.writeSystemKeydexMarkdown("KEYDEX-JSON-IGNORED-SYSTEM");
  await fixture.writeWorkspaceKeydexMarkdown("KEYDEX-JSON-IGNORED-WORKSPACE");
  await fixture.writeSkill("workspace", "shared", "Shared workspace V1", "WORKSPACE-SHARED-V1");
  const session = await fixture.createWorkspaceSession("E19 ignored JSON");
  const input = await openConversation(fixture, page, session);

  await selectSkill(page, input, "shared", "KeydexSkillE2E shared workspace");
  const answer = await sendAndWait(page, input, "KeydexSkillE2E shared workspace");
  await expect(answer).toContainText("WORKSPACE-SHARED-V1");
  await expect(answer).toContainText("KEYDEX-JSON-IGNORED-SYSTEM");
  await expect(answer).toContainText("KEYDEX-JSON-IGNORED-WORKSPACE");
  await expect(page.getByTestId("skill-diagnostic")).toHaveCount(0);
  await fixture.evidence(page, "E19-keydex-json-ignored");
});

test("E20 explicit slash Skill and layered keydex.md coexist", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("SYSTEM-MD");
  await fixture.writeWorkspaceKeydexMarkdown("WORKSPACE-MD");
  await fixture.writeSkill("workspace", "shared", "Shared workspace V1", "WORKSPACE-SHARED-V1");
  const session = await fixture.createWorkspaceSession("E20 explicit coexistence");
  const input = await openConversation(fixture, page, session);

  await selectSkill(page, input, "shared", "KeydexSkillE2E shared workspace");
  const answer = await sendAndWait(page, input, "KeydexSkillE2E shared workspace");
  await expect(answer).toContainText("activated WORKSPACE-SHARED-V1");
  await expect(answer).toContainText("scopes=system,workspace");
  await expect(answer).toContainText("markers=SYSTEM-MD|WORKSPACE-MD");
  await expect(answer).toContainText("context_count=1");
  await fixture.evidence(page, "E20-explicit-skill-context");
});

test("E21 model-initiated load_skill retains layered keydex.md", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("E21-SYSTEM-MD");
  await fixture.writeWorkspaceKeydexMarkdown("E21-WORKSPACE-MD");
  await fixture.writeSkill("workspace", "shared", "Shared workspace V1", "WORKSPACE-SHARED-V1");
  const session = await fixture.createWorkspaceSession("E21 automatic Skill");
  const input = await openConversation(fixture, page, session);

  const answer = await sendAndWait(
    page,
    input,
    "KeydexAutoSkillE2E shared workspace",
    /KeydexSkillE2E activated/,
  );
  await expect(page.getByLabel("删除 Skill /shared")).toHaveCount(0);
  await expect(page.getByTestId("skill-activation-block").filter({ hasText: "shared" })).toBeVisible();
  await expect(answer).toContainText("WORKSPACE-SHARED-V1");
  await expect(answer).toContainText("E21-SYSTEM-MD|E21-WORKSPACE-MD");
  await fixture.evidence(page, "E21-auto-skill-context");
});

test("E22 builtin keydex-guide activation and resource path remain available", async ({
  page,
}) => {
  await fixture.writeSystemKeydexMarkdown("E22-SYSTEM-MD");
  const input = await openHomeScope(fixture, page, "chat");
  await selectSkill(page, input, "keydex-guide", "KeydexSkillE2E keydex-guide builtin");
  const answer = await sendAndWait(
    page,
    input,
    "KeydexSkillE2E keydex-guide builtin",
    /KeydexSkillE2E activated/,
  );

  await expect(answer).toContainText("BUILTIN-KEYDEX-GUIDE");
  await expect(answer).toContainText("E22-SYSTEM-MD");
  await expect(
    page.getByTestId("skill-activation-block").filter({ hasText: "keydex-guide" }),
  ).toHaveAttribute("data-skill-source", "builtin");
  await fixture.evidence(page, "E22-builtin-guide");
});

test("E23 system Skill history and safe tool boundary survive reload", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("E23-SYSTEM-MD");
  const session = await fixture.createChatSession("E23 system Skill");
  const input = await openConversation(fixture, page, session);
  await selectSkill(page, input, "system-demo", "KeydexSkillE2E system-demo system");
  await expect(await sendAndWait(page, input, "KeydexSkillE2E system-demo system")).toContainText(
    "SYSTEM-DEMO",
  );
  const tools = await sendAndWait(page, input, "KeydexToolsE2E");
  await expect(tools).toContainText("load_skill");
  await expect(tools).not.toContainText("read_file");
  await page.reload();
  await expect(page.getByTestId("skill-activation-block").filter({ hasText: "system-demo" })).toBeVisible({
    timeout: 20_000,
  });
  await fixture.evidence(page, "E23-system-skill-history-tools");
});

test("E24 workspace winner deletion reveals the system Skill without reload", async ({
  page,
}) => {
  await fixture.writeSystemKeydexMarkdown("E24-SYSTEM-MD");
  await fixture.writeWorkspaceKeydexMarkdown("E24-WORKSPACE-MD");
  await fixture.writeSkill("workspace", "shared", "Shared workspace V1", "WORKSPACE-SHARED-V1");
  const session = await fixture.createWorkspaceSession("E24 winner fallback");
  const input = await openConversation(fixture, page, session);

  await expectSkillWinner(page, input, "shared", "Shared workspace V1", "项目级");
  await selectSkill(page, input, "shared", "KeydexSkillE2E shared workspace");
  await expect(await sendAndWait(page, input, "KeydexSkillE2E shared workspace")).toContainText(
    "WORKSPACE-SHARED-V1",
  );
  await fixture.removeSkill("workspace", "shared");
  await expectSkillWinner(page, input, "shared", "Shared system V1", "系统级");
  await selectSkill(page, input, "shared", "KeydexSkillE2E shared system");
  await expect(await sendAndWait(page, input, "KeydexSkillE2E shared system")).toContainText(
    "SYSTEM-SHARED-V1",
  );
  await fixture.evidence(page, "E24-workspace-winner-fallback");
});

test("E25 invalid workspace Skill blocks fallback and repair restores it", async ({ page }) => {
  await fixture.writeWorkspaceKeydexMarkdown("E25-WORKSPACE-MD");
  await fixture.writeInvalidSkill("workspace", "shared");
  const session = await fixture.createWorkspaceSession("E25 shadow barrier");
  const input = await openConversation(fixture, page, session);

  await openSkillGroup(page, input);
  await expect(page.getByTestId("skill-diagnostic")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("option", { name: "选择 Skill /shared" })).toHaveCount(0);
  await fixture.writeSkill("workspace", "shared", "Shared workspace repaired", "WORKSPACE-REPAIRED");
  await expectSkillWinner(page, input, "shared", "Shared workspace repaired", "项目级");
  await selectSkill(page, input, "shared", "KeydexSkillE2E shared workspace");
  await expect(await sendAndWait(page, input, "KeydexSkillE2E shared workspace")).toContainText(
    "WORKSPACE-REPAIRED",
  );
  await fixture.evidence(page, "E25-shadow-barrier-repair");
});

test("E26 system Skill resource preview stays read-only and outside workspace files", async ({
  page,
}) => {
  const session = await fixture.createWorkspaceSession("E26 system preview");
  const input = await openWorkbench(fixture, page, session);
  const option = await expectSkillWinner(page, input, "shared", "Shared system V1", "系统级");
  await option.click();
  await page.getByLabel("打开 Skill shared").click();

  const preview = page.getByTestId("workbench-main-file-preview").locator(
    '[data-file-preview-root="true"][data-preview-source="skill-resource"][data-skill-source="system"]',
  );
  await expect(preview).toBeVisible({ timeout: 20_000 });
  await expect(preview).toContainText("SYSTEM-SHARED-V1");
  await expect(preview).toHaveAttribute("data-file-preview-new-annotations-enabled", "false");
  const tree = await fixture.api<unknown>(`/api/workspaces/${session.workspace_id}/tree`);
  expect(JSON.stringify(tree)).not.toContain("system-keydex");
  await fixture.evidence(page, "E26-system-skill-preview");
});

test("E27 keydex.md-only event does not clear an already selected Skill", async ({ page }) => {
  await fixture.writeWorkspaceKeydexMarkdown("KEYDEX-MD-V1");
  await fixture.writeSkill("workspace", "shared", "Shared workspace V1", "WORKSPACE-SHARED-V1");
  const session = await fixture.createWorkspaceSession("E27 keydex only event");
  const input = await openConversation(fixture, page, session);
  await selectSkill(page, input, "shared", "KeydexSkillE2E shared workspace");

  await fixture.writeWorkspaceKeydexMarkdown("KEYDEX-MD-V2");
  await expect(page.getByLabel("删除 Skill /shared")).toBeVisible();
  await page.getByLabel("发送").click();
  const answer = page.getByText(/KeydexSkillE2E activated/).last();
  await expect(answer).toBeVisible({ timeout: 30_000 });
  await expect(answer).toContainText("KEYDEX-MD-V2");
  await expect(answer).toContainText("WORKSPACE-SHARED-V1");
  await fixture.evidence(page, "E27-keydex-event-keeps-skill");
});

test("E28 Skills events still refresh the effective winner in real time", async ({ page }) => {
  const session = await fixture.createWorkspaceSession("E28 skill events");
  const input = await openConversation(fixture, page, session);
  await expectSkillWinner(page, input, "shared", "Shared system V1", "系统级");

  await fixture.writeSkill("workspace", "shared", "Shared workspace V2", "WORKSPACE-SHARED-V2");
  await expectSkillWinner(page, input, "shared", "Shared workspace V2", "项目级");
  await fixture.removeSkill("workspace", "shared");
  await expectSkillWinner(page, input, "shared", "Shared system V1", "系统级");
  await fixture.evidence(page, "E28-skill-winner-event-refresh");
});
