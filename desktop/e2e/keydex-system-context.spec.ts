import { expect, test } from "@playwright/test";

import {
  openConversation,
  openHomeScope,
  sendAndWait,
} from "./keydex-context-helpers";
import { startKeydexE2EFixture, type KeydexE2EFixture } from "./keydex-e2e-fixtures";

test.describe.configure({ mode: "serial" });

let fixture: KeydexE2EFixture;

test.beforeAll(async () => {
  fixture = await startKeydexE2EFixture("context-system");
});

test.beforeEach(async () => {
  await fixture.removeSystemKeydexMarkdown();
  await fixture.removeWorkspaceKeydexMarkdown();
});

test.afterAll(async () => {
  await fixture?.stop();
});

test("E01 ordinary Chat automatically uses system keydex.md", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("SYSTEM-MD-V1");
  const input = await openHomeScope(fixture, page, "chat");
  const answer = await sendAndWait(page, input, "KeydexContextE2E inspect E01");

  await expect(answer).toContainText("context_count=1");
  await expect(answer).toContainText("scopes=system");
  await expect(answer).toContainText("markers=SYSTEM-MD-V1");
  await expect(page.getByText("KeydexContextE2E inspect E01", { exact: true })).toBeVisible();
  await fixture.evidence(page, "E01-system-context");
});

test("E02 ordinary Chat never loads workspace keydex.md", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("SYSTEM-MD");
  await fixture.writeWorkspaceKeydexMarkdown("WORKSPACE-MD-SECRET");
  const session = await fixture.createChatSession("E02 chat isolation");
  const input = await openConversation(fixture, page, session);
  const answer = await sendAndWait(page, input, "KeydexContextE2E inspect E02");

  await expect(answer).toContainText("scopes=system");
  await expect(answer).toContainText("workspace_present=false");
  await expect(answer).not.toContainText("WORKSPACE-MD-SECRET");
  await expect(page.getByRole("button", { name: "文件" })).toHaveCount(0);
  await fixture.evidence(page, "E02-no-workspace-leak");
});

test("E03 missing documents keep plain Chat free of wrapper messages", async ({ page }) => {
  const session = await fixture.createChatSession("E03 no documents");
  const input = await openConversation(fixture, page, session);
  const answer = await sendAndWait(page, input, "KeydexPlainE2E E03 no docs");

  await expect(answer).toContainText("context_count=0");
  await expect(answer).toContainText("documents=0");
  await expect(page.getByText("Keydex workspace guidance", { exact: false })).toHaveCount(0);
  await expect(page.getByText("system:keydex.md", { exact: false })).toHaveCount(0);
  await fixture.evidence(page, "E03-no-documents");
});

test("E04 blank system keydex.md contributes no model context", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("  \n\t");
  const session = await fixture.createChatSession("E04 blank document");
  const input = await openConversation(fixture, page, session);
  const answer = await sendAndWait(page, input, "KeydexContextE2E inspect E04");

  await expect(answer).toContainText("context_count=0");
  await expect(answer).toContainText("documents=0");
  await fixture.evidence(page, "E04-blank-document");
});

test("E05 latest real user remains the actual request", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("LATEST-USER-GUIDANCE");
  const session = await fixture.createChatSession("E05 latest user");
  const input = await openConversation(fixture, page, session);
  const answer = await sendAndWait(page, input, "KeydexContextE2E E2E-LATEST-REQUEST");

  await expect(answer).toContainText("last_user=KeydexContextE2E E2E-LATEST-REQUEST");
  await expect(answer).toContainText("context_role=user");
  await expect(answer).toContainText("context_before_conversation=true");
  await fixture.evidence(page, "E05-latest-real-user");
});

test("E06 reload and history never reveal the temporary wrapper", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("HISTORY-HIDDEN-MARKER");
  const session = await fixture.createChatSession("E06 hidden history");
  const input = await openConversation(fixture, page, session);
  await sendAndWait(page, input, "KeydexContextE2E inspect E06");

  await page.reload();
  await expect(page.getByText(/KeydexContextE2E .*HISTORY-HIDDEN-MARKER/)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("<keydex-instructions>", { exact: false })).toHaveCount(0);
  await expect(page.getByText("system:keydex.md", { exact: false })).toHaveCount(0);
  await fixture.evidence(page, "E06-history-wrapper-hidden");
});

test("E07 current system Turn stays V1 and next Turn observes V2", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("SYSTEM-MD-V1");
  const session = await fixture.createChatSession("E07 system turn pin");
  const input = await openConversation(fixture, page, session);
  const firstMessage = "KeydexContextE2E inspect E07 first";
  await input.fill(firstMessage);
  await page.getByLabel("发送").click();
  await fixture.waitForModelRequest(firstMessage);
  await fixture.writeSystemKeydexMarkdown("SYSTEM-MD-V2");
  await expect(page.getByText(/KeydexContextE2E .*SYSTEM-MD-V1/)).toBeVisible({
    timeout: 30_000,
  });

  const second = await sendAndWait(page, input, "KeydexContextE2E inspect E07 second");
  await expect(second).toContainText("SYSTEM-MD-V2");
  await fixture.evidence(page, "E07-system-turn-pinning");
});

test("E08 create and delete system keydex.md switches the next Turn", async ({ page }) => {
  const session = await fixture.createChatSession("E08 system lifecycle");
  const input = await openConversation(fixture, page, session);
  await expect(await sendAndWait(page, input, "KeydexContextE2E E08 missing")).toContainText(
    "context_count=0",
  );

  await fixture.writeSystemKeydexMarkdown("SYSTEM-CREATED");
  await expect(await sendAndWait(page, input, "KeydexContextE2E E08 created")).toContainText(
    "SYSTEM-CREATED",
  );

  await fixture.removeSystemKeydexMarkdown();
  await expect(await sendAndWait(page, input, "KeydexContextE2E E08 removed")).toContainText(
    "context_count=0",
  );
  await fixture.evidence(page, "E08-system-create-delete");
});

test("E18 project context never leaks into a later project-free Chat", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("E18-SYSTEM");
  await fixture.writeWorkspaceKeydexMarkdown("RECENT-PROJECT-SECRET");
  const projectSession = await fixture.createWorkspaceSession("E18 recent project");
  const projectInput = await openConversation(fixture, page, projectSession);
  await expect(
    await sendAndWait(page, projectInput, "KeydexContextE2E E18 project"),
  ).toContainText("RECENT-PROJECT-SECRET");

  const chatInput = await openHomeScope(fixture, page, "chat");
  const answer = await sendAndWait(page, chatInput, "KeydexContextE2E E18 chat");
  await expect(answer).toContainText("scopes=system");
  await expect(answer).not.toContainText("RECENT-PROJECT-SECRET");
  await fixture.evidence(page, "E18-recent-project-no-leak");
});
