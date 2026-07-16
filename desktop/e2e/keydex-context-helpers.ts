import { expect, type Locator, type Page } from "@playwright/test";

import type { KeydexE2EFixture, KeydexSession } from "./keydex-e2e-fixtures";

export async function openConversation(
  fixture: KeydexE2EFixture,
  page: Page,
  session: KeydexSession,
): Promise<Locator> {
  await fixture.configurePage(page);
  await page.goto(`${fixture.appBaseUrl}/#/conversation/${session.id}`);
  const input = page.getByLabel("继续输入");
  await expect(input).toBeVisible({ timeout: 20_000 });
  await waitForControlledModel(page);
  return input;
}

export async function openWorkbench(
  fixture: KeydexE2EFixture,
  page: Page,
  session: KeydexSession,
): Promise<Locator> {
  if (!session.workspace_id) throw new Error("Workbench E2E requires a workspace session");
  await fixture.configurePage(page);
  await page.goto(
    `${fixture.appBaseUrl}/#/workbench/${session.workspace_id}/session/${session.id}`,
  );
  const input = page.getByLabel("工作台助手输入");
  if ((await input.count()) === 0) {
    await page.getByRole("button", { name: "展开工作台输入框" }).click();
  }
  await expect(input).toBeVisible({ timeout: 20_000 });
  await waitForControlledModel(page);
  return input;
}

export async function openHomeScope(
  fixture: KeydexE2EFixture,
  page: Page,
  scope: "chat" | "workspace",
): Promise<Locator> {
  await fixture.configurePage(page);
  if (scope === "chat") {
    const session = await fixture.createChatSession("Keydex E2E direct Chat");
    return openConversation(fixture, page, session);
  }
  await page.goto(`${fixture.appBaseUrl}/#/guid`);
  const input = page.getByLabel("输入需求");
  await expect(input).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("选择工作区").click();
  const dialog = page.getByRole("dialog", { name: "工作区选择" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("option").filter({ hasText: /^keydex-e2e/ }).click();
  return input;
}

export async function sendAndWait(
  page: Page,
  input: Locator,
  message: string,
  expected: string | RegExp =
    /Keydex(?:ContextE2E context_count|PlainE2E completed|SkillE2E activated|ToolsE2E available)/,
): Promise<Locator> {
  await replaceComposer(input, message);
  await waitForControlledModel(page);
  const send = page.getByLabel("发送");
  await expect(send).toBeEnabled();
  await send.click();
  const answer = page.locator("article").filter({ hasText: expected }).last();
  if ((await page.getByRole("main", { name: "工作台" }).count()) > 0) {
    const carrier = page.getByTestId("workbench-message-carrier");
    await expect(carrier).toHaveAttribute("data-state", "completed", { timeout: 30_000 });
    if ((await carrier.getAttribute("data-expanded")) !== "true") {
      await carrier.click();
    }
  } else {
    await expect(answer).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("停止")).toHaveCount(0, { timeout: 30_000 });
  }
  await expect(answer).toBeVisible({ timeout: 30_000 });
  return answer;
}

export async function selectSkill(
  page: Page,
  input: Locator,
  name: string,
  message: string,
): Promise<void> {
  await replaceComposer(input, `${message} /${name}`);
  const option = page.getByRole("option", { name: `选择 Skill /${name}` });
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click();
  await expect(page.getByLabel(`删除 Skill /${name}`)).toBeVisible();
  await expect(input).toHaveText(message);
}

export async function expectSkillWinner(
  page: Page,
  input: Locator,
  name: string,
  description: string,
  sourceLabel: "内置" | "系统级" | "项目级",
): Promise<Locator> {
  await replaceComposer(input, `/${name}`);
  const option = page.getByRole("option", { name: `选择 Skill /${name}` });
  await expect(option).toHaveCount(1, { timeout: 15_000 });
  await expect(option).toContainText(description);
  await expect(option).toContainText(sourceLabel);
  return option;
}

export async function expectSkillMissing(
  page: Page,
  input: Locator,
  name: string,
): Promise<void> {
  await replaceComposer(input, `/${name}`);
  await expect(page.getByTestId("slash-command-menu")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("option", { name: `选择 Skill /${name}` })).toHaveCount(0);
}

export async function openSkillGroup(page: Page, input: Locator): Promise<void> {
  await replaceComposer(input, "/");
  const group = page.getByRole("option").filter({ hasText: /^Skill/ });
  await expect(group).toBeVisible({ timeout: 15_000 });
  await group.click();
}

export async function replaceComposer(input: Locator, value: string): Promise<void> {
  await input.click();
  await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await input.press("Backspace");
  if (value) await input.pressSequentially(value);
}

async function waitForControlledModel(page: Page): Promise<void> {
  const selector = page.getByLabel("运行模型").getByLabel("选择模型").last();
  await expect(selector).toBeVisible({ timeout: 20_000 });
  await expect(selector).toBeEnabled({ timeout: 20_000 });
  await expect(selector).toContainText("e2e-keydex-stream", { timeout: 20_000 });
}
