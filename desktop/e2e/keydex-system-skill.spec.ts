import { expect, test, type Locator, type Page } from "@playwright/test";

import { startKeydexE2EFixture, type KeydexE2EFixture } from "./keydex-e2e-fixtures";

test.describe.configure({ mode: "serial" });

let fixture: KeydexE2EFixture;

test.beforeAll(async () => {
  fixture = await startKeydexE2EFixture("system-chat");
  await fixture.writeSystemKeydexMarkdown("SYSTEM-MD-SKILL-REGRESSION");
  await fixture.writeSkill(
    "system",
    "system-demo",
    "System demo skill",
    "SYSTEM-DEMO",
    { "references/guide.md": "# System guide\n\nread only\n" },
  );
  await fixture.writeSkill("system", "shared", "Shared system V1", "SYSTEM-V1");
});

test.afterAll(async () => {
  await fixture?.stop();
});

test("ordinary Chat uses the real system layer, watcher and safe tool boundary", async ({ page }) => {
  test.setTimeout(120_000);
  await fixture.configurePage(page);

  await test.step("S00 ordinary Chat exposes and activates the packaged builtin guide", async () => {
    await page.goto(`${fixture.appBaseUrl}/#/guid`);
    await expect(page.getByLabel("输入需求")).toBeVisible();
    await page.getByLabel("选择工作区").click();
    await page.getByRole("button", { name: /无项目聊天/ }).click();
    const input = page.getByLabel("输入需求");
    await openDirectSkillQuery(page, input, "keydex-guide");
    const option = page.getByRole("option", { name: "选择 Skill /keydex-guide" });
    await expect(option).toContainText("内置");
    await option.click();
    await replaceComposer(input, "KeydexSkillE2E keydex-guide builtin");
    await page.getByLabel("发送").click();

    await expect(page.getByText(/KeydexSkillE2E activated BUILTIN-KEYDEX-GUIDE/)).toBeVisible({
      timeout: 30_000,
    });
    const activation = page.getByTestId("skill-activation-block").filter({ hasText: "keydex-guide" });
    await expect(activation).toHaveAttribute("data-skill-source", "builtin");
    await fixture.evidence(page, "s00-builtin-guide", { expected_source: "builtin" });
  });

  await test.step("S01 Home Chat selects a system winner and runs real load_skill", async () => {
    const chat = await fixture.createChatSession("S01 direct system Chat");
    await page.goto(`${fixture.appBaseUrl}/#/conversation/${chat.id}`);
    await expect(page.getByLabel("继续输入")).toBeVisible();
    await expect(page.getByRole("button", { name: "文件" })).toHaveCount(0);

    const input = page.getByLabel("继续输入");
    await selectSkill(page, input, "system-demo", "KeydexSkillE2E system-demo system");
    await expect(page.getByLabel("删除 Skill /system-demo")).toBeVisible();
    await page.getByLabel("发送").click();

    await expect(page).toHaveURL(new RegExp(`#\/conversation\/${chat.id}$`));
    await expect(page.getByText(/KeydexSkillE2E activated SYSTEM-DEMO/)).toBeVisible({ timeout: 30_000 });
    const activation = page.getByTestId("skill-activation-block").filter({ hasText: "system-demo" });
    await expect(activation).toHaveAttribute("data-skill-source", "system");
    await fixture.evidence(page, "s01-system-chat-load-skill", {
      session_url: page.url(),
      expected_source: "system",
    });
  });

  await test.step("S02 Chat exposes load_skill but no workspace file tools", async () => {
    await expect(page.getByRole("button", { name: "文件" })).toHaveCount(0);
    const input = page.getByLabel("继续输入");
    await replaceComposer(input, "KeydexToolsE2E");
    await page.getByLabel("发送").click();
    const answer = page.getByText(/KeydexToolsE2E available:/).last();
    await expect(answer).toBeVisible({ timeout: 30_000 });
    const text = (await answer.textContent()) ?? "";
    expect(text).toContain("load_skill");
    for (const forbidden of ["read_file", "search_text", "edit_file", "run_cmd", "list_dir"]) {
      expect(text.split(/[:,]/)).not.toContain(forbidden);
    }
  });

  await test.step("S03 system source survives reload and history restoration", async () => {
    const sessionUrl = page.url();
    await page.reload();
    await expect(page).toHaveURL(sessionUrl);
    await expect(page.getByText(/KeydexSkillE2E activated SYSTEM-DEMO/)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-skill-source="system"]')).not.toHaveCount(0);
  });

  await test.step("S04 current turn keeps V1 and the next turn observes watcher-refreshed V2", async () => {
    const input = page.getByLabel("继续输入");
    const currentMessage = "KeydexSkillE2E shared system";
    await selectSkill(page, input, "shared", currentMessage);
    await page.getByLabel("发送").click();
    await expect(page.getByLabel("停止")).toBeVisible();
    await fixture.waitForModelRequest(currentMessage);

    await fixture.writeSkill("system", "shared", "Shared system V2", "SYSTEM-V2");
    await expect(page.getByText(/KeydexSkillE2E activated SYSTEM-V1/)).toBeVisible({ timeout: 30_000 });

    await openDirectSkillQuery(page, input, "shared");
    await expect(page.getByRole("option", { name: "选择 Skill /shared" })).toContainText(
      "Shared system V2",
      { timeout: 15_000 },
    );
    await page.getByRole("option", { name: "选择 Skill /shared" }).click();
    await replaceComposer(input, currentMessage);
    await page.getByLabel("发送").click();
    await expect(page.getByText(/KeydexSkillE2E activated SYSTEM-V2/)).toBeVisible({ timeout: 30_000 });
    await fixture.evidence(page, "s04-system-watcher-next-turn", {
      current_turn_marker: "SYSTEM-V1",
      next_turn_marker: "SYSTEM-V2",
    });
  });

  await test.step("S05 damaged keydex.md is ignored and the fixed runtime stays usable", async () => {
    await fixture.writeLegacyKeydexJson("system", "{invalid");
    const input = page.getByLabel("继续输入");
    await openDirectSkillQuery(page, input, "system-demo");
    await expect(page.getByRole("option", { name: "选择 Skill /system-demo" })).toContainText(
      "System demo skill",
    );

    await replaceComposer(input, "KeydexContextE2E damaged-keydex-json-ignored");
    await page.getByLabel("发送").click();
    await expect(
      page.getByText(/KeydexContextE2E .*SYSTEM-MD-SKILL-REGRESSION/),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("skill-diagnostic")).toHaveCount(0);
    await fixture.evidence(page, "s05-damaged-keydex-json-ignored");
  });
});

async function selectSkill(page: Page, input: Locator, name: string, message: string) {
  await replaceComposer(input, `${message} /${name}`);
  const option = page.getByRole("option", { name: `选择 Skill /${name}` });
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click();
  await expect(input).toHaveText(message);
}

async function openDirectSkillQuery(page: Page, input: Locator, name: string) {
  await replaceComposer(input, `/${name}`);
  await expect(page.getByRole("option", { name: `选择 Skill /${name}` })).toBeVisible({
    timeout: 15_000,
  });
}

async function replaceComposer(input: Locator, value: string) {
  await input.click();
  await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await input.press("Backspace");
  if (value) await input.pressSequentially(value);
}
