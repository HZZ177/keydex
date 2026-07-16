import { expect, test } from "@playwright/test";

import {
  openConversation,
  openHomeScope,
  openWorkbench,
  selectSkill,
  sendAndWait,
} from "./keydex-context-helpers";
import {
  startKeydexE2EFixture,
  type KeydexE2EFixture,
  type KeydexSession,
} from "./keydex-e2e-fixtures";

test.describe.configure({ mode: "serial" });

let fixture: KeydexE2EFixture;

test.beforeAll(async () => {
  fixture = await startKeydexE2EFixture("context-safety");
});

test.beforeEach(async () => {
  await fixture.removeSystemKeydexMarkdown();
  await fixture.removeWorkspaceKeydexMarkdown();
  await fixture.removeSkill("workspace", "local");
});

test.afterAll(async () => {
  await fixture?.stop();
});

test("E33 invalid system keydex.md does not block valid workspace context or Skill", async ({
  page,
}) => {
  await fixture.writeSystemKeydexMarkdown(new Uint8Array([0xff, 0xfe, 0x00]));
  await fixture.writeWorkspaceKeydexMarkdown("WORKSPACE-VALID");
  await fixture.writeSkill("workspace", "local", "Local workspace Skill", "WORKSPACE-LOCAL");
  const session = await fixture.createWorkspaceSession("E33 invalid system isolation");
  const input = await openConversation(fixture, page, session);
  const context = await sendAndWait(page, input, "KeydexContextE2E inspect E33");
  await expect(context).toContainText("scopes=workspace");
  await expect(context).toContainText("WORKSPACE-VALID");

  await selectSkill(page, input, "local", "KeydexSkillE2E local workspace");
  const skill = await sendAndWait(page, input, "KeydexSkillE2E local workspace");
  await expect(skill).toContainText("WORKSPACE-VALID");
  await expect(page.getByTestId("skill-activation-block").filter({ hasText: "local" })).toBeVisible();
  await fixture.evidence(page, "E33-invalid-system-isolation");
});

test("E34 system keydex.md is model context but never a workspace file capability", async ({
  page,
}) => {
  await fixture.writeSystemKeydexMarkdown("SYSTEM-PRIVATE-MARKER");
  const session = await fixture.createWorkspaceSession("E34 system file isolation");
  const input = await openWorkbench(fixture, page, session);
  const answer = await sendAndWait(page, input, "KeydexContextE2E inspect E34");
  await expect(answer).toContainText("SYSTEM-PRIVATE-MARKER");

  const tree = await fixture.api<unknown>(`/api/workspaces/${session.workspace_id}/tree`);
  expect(JSON.stringify(tree)).not.toContain("system-keydex");
  expect(JSON.stringify(tree)).not.toContain("keydex.md");
  const search = await fixture.api<Array<{ path: string }>>(
    `/api/workspaces/${session.workspace_id}/search?q=${encodeURIComponent("SYSTEM-PRIVATE-MARKER")}`,
  );
  expect(search).toEqual([]);
  await page.getByRole("button", { name: "收起工作台消息层" }).click();
  await page.getByRole("button", { name: "选择文件 README.md" }).click();
  await expect(
    page
      .getByTestId("workbench-main-file-preview")
      .locator('[data-file-preview-root="true"][data-preview-source="file"]'),
  ).toContainText("Keydex E2E workspace");
  await fixture.evidence(page, "E34-system-file-isolation");
});

test("E36 Home Conversation Workbench and ordinary FilePreview stay coherent", async ({
  page,
}) => {
  await fixture.writeSystemKeydexMarkdown("E36-SYSTEM");
  await fixture.writeWorkspaceKeydexMarkdown("E36-WORKSPACE");
  await fixture.writeSkill("workspace", "local", "Local workspace Skill", "WORKSPACE-LOCAL");
  const homeInput = await openHomeScope(fixture, page, "workspace");
  const homeAnswer = await sendAndWait(page, homeInput, "KeydexContextE2E E36 Home");
  await expect(homeAnswer).toContainText("E36-SYSTEM|E36-WORKSPACE");
  await expect(page).toHaveURL(/#\/conversation\//);

  const sessionId = page.url().split("/conversation/")[1]?.split(/[?#]/)[0];
  if (!sessionId) throw new Error("E36 Home did not create a Conversation session");
  const response = await fixture.api<{ session: KeydexSession }>(`/api/sessions/${sessionId}`);
  const session = response.session;
  const conversationInput = page.getByLabel("继续输入");
  await selectSkill(page, conversationInput, "local", "KeydexSkillE2E local workspace");
  await expect(
    await sendAndWait(page, conversationInput, "KeydexSkillE2E local workspace"),
  ).toContainText("E36-SYSTEM|E36-WORKSPACE");

  const workbenchInput = await openWorkbench(fixture, page, session);
  await expect(
    await sendAndWait(page, workbenchInput, "KeydexContextE2E E36 Workbench"),
  ).toContainText("E36-WORKSPACE");
  await page.getByRole("button", { name: "收起工作台消息层" }).click();
  await page.getByRole("button", { name: "选择文件 README.md" }).click();
  await expect(
    page
      .getByTestId("workbench-main-file-preview")
      .locator('[data-file-preview-root="true"][data-preview-source="file"]'),
  ).toContainText("Keydex E2E workspace");
  await page.goto(`${fixture.appBaseUrl}/#/conversation/${session.id}`);
  await expect(page.getByLabel("继续输入")).toBeVisible();
  await expect(page.getByText(/KeydexSkillE2E activated/)).toBeVisible();
  await fixture.evidence(page, "E36-cross-surface-regression");
});
