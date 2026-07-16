import { expect, test } from "@playwright/test";

import {
  openConversation,
  replaceComposer,
  selectSkill,
  sendAndWait,
} from "./keydex-context-helpers";
import { startKeydexE2EFixture, type KeydexE2EFixture } from "./keydex-e2e-fixtures";

test.describe.configure({ mode: "serial" });

let fixture: KeydexE2EFixture;

test.beforeAll(async () => {
  fixture = await startKeydexE2EFixture("context-lifecycle");
  await fixture.writeSkill("system", "system-demo", "System demo", "SYSTEM-DEMO");
});

test.beforeEach(async () => {
  await fixture.removeSystemKeydexMarkdown();
  await fixture.removeWorkspaceKeydexMarkdown();
});

test.afterAll(async () => {
  await fixture?.stop();
});

test("E29 each model request in a tool loop gets one keydex context", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("E29-SYSTEM-MD");
  await fixture.writeWorkspaceKeydexMarkdown("E29-WORKSPACE-MD");
  const session = await fixture.createWorkspaceSession("E29 tool loop");
  const input = await openConversation(fixture, page, session);
  await selectSkill(page, input, "system-demo", "KeydexSkillE2E system-demo system");
  const answer = await sendAndWait(page, input, "KeydexSkillE2E system-demo system");

  await expect(answer).toContainText("context_count=1");
  await expect(answer).toContainText("request_context_counts=1,1");
  await expect(answer).toContainText("scopes=system,workspace");
  await fixture.evidence(page, "E29-tool-loop-context-counts");
});

test("E30 manual context compression keeps keydex context on the next model call", async ({
  page,
}) => {
  await fixture.writeSystemKeydexMarkdown("E30-SYSTEM-MD");
  await fixture.writeWorkspaceKeydexMarkdown("E30-WORKSPACE-MD");
  const session = await fixture.createWorkspaceSession("E30 compression");
  const input = await openConversation(fixture, page, session);
  await sendAndWait(page, input, "KeydexPlainE2E E30 history one");
  await sendAndWait(page, input, "KeydexPlainE2E E30 history two");

  await replaceComposer(input, "/压缩");
  await input.press("Enter");
  await expect(page.getByTestId("context-compression-notice")).toContainText(
    "上下文压缩已完成",
    { timeout: 30_000 },
  );
  const answer = await sendAndWait(page, input, "KeydexContextE2E E30 after compression");
  await expect(answer).toContainText("context_count=1");
  await expect(answer).toContainText("E30-SYSTEM-MD|E30-WORKSPACE-MD");
  await expect(page.getByText("<keydex-instructions>", { exact: false })).toHaveCount(0);
  await fixture.evidence(page, "E30-context-after-compression");
});

test("E31 forked session resolves the target project context on its new Turn", async ({
  page,
}) => {
  await fixture.writeSystemKeydexMarkdown("E31-SYSTEM");
  await fixture.writeWorkspaceKeydexMarkdown("FORK-TARGET-V1");
  const session = await fixture.createWorkspaceSession("E31 fork source");
  const input = await openConversation(fixture, page, session);
  await sendAndWait(page, input, "KeydexContextE2E E31 source");
  await fixture.writeWorkspaceKeydexMarkdown("FORK-TARGET-V2");

  await page.getByRole("button", { name: "从该轮派生对话" }).last().click({ force: true });
  const dialog = page.getByRole("dialog", { name: "确认从该轮派生对话？" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "派生对话" }).click();
  await expect(page).not.toHaveURL(new RegExp(`${session.id}$`), { timeout: 20_000 });
  const forkInput = page.getByLabel("继续输入");
  await expect(forkInput).toBeVisible();
  const answer = await sendAndWait(page, forkInput, "KeydexContextE2E E31 fork");
  await expect(answer).toContainText("FORK-TARGET-V2");
  await expect(page.getByText("<keydex-instructions>", { exact: false })).toHaveCount(0);
  await fixture.evidence(page, "E31-fork-target-context");
});

test("E32 page reload resolves updated context for the first new Turn", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("E32-SYSTEM");
  await fixture.writeWorkspaceKeydexMarkdown("RELOAD-V1");
  const session = await fixture.createWorkspaceSession("E32 reload");
  const input = await openConversation(fixture, page, session);
  await expect(await sendAndWait(page, input, "KeydexContextE2E E32 V1")).toContainText(
    "RELOAD-V1",
  );
  await fixture.writeWorkspaceKeydexMarkdown("RELOAD-V2");
  await page.reload();
  await expect(page.getByText(/KeydexContextE2E .*RELOAD-V1/)).toBeVisible({ timeout: 20_000 });
  const reloadedInput = page.getByLabel("继续输入");
  const answer = await sendAndWait(page, reloadedInput, "KeydexContextE2E E32 V2");
  await expect(answer).toContainText("RELOAD-V2");
  await fixture.evidence(page, "E32-reload-next-turn");
});

test("E35 running steer keeps V1 and the next independent Turn gets V2", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("E35-SYSTEM");
  await fixture.writeWorkspaceKeydexMarkdown("KEYDEX-V1");
  const session = await fixture.createWorkspaceSession("E35 steer pin");
  const input = await openConversation(fixture, page, session);
  const runningMessage = "KeydexContextE2E E35 slow turn";
  await input.fill(runningMessage);
  await page.getByLabel("发送").click();
  await fixture.waitForModelRequest(runningMessage);
  await fixture.writeWorkspaceKeydexMarkdown("KEYDEX-V2");
  const steerMessage = "KeydexContextE2E E35 steer";
  await input.fill(steerMessage);
  await expect(page.getByLabel("发送")).toBeEnabled();
  await page.getByLabel("发送").click();

  await expect(page.getByText(/KeydexContextE2E .*KEYDEX-V1/).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(steerMessage, { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("停止")).toHaveCount(0, { timeout: 30_000 });
  const nextMessage = "KeydexContextE2E E35 next turn";
  const next = await sendAndWait(
    page,
    input,
    nextMessage,
    /KeydexContextE2E .*last_user=KeydexContextE2E E35 next turn/,
  );
  await expect(next).toContainText("KEYDEX-V2");
  await fixture.evidence(page, "E35-steer-turn-pinning");
});
