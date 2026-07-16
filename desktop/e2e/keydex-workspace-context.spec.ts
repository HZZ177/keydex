import { expect, test } from "@playwright/test";

import {
  openConversation,
  openHomeScope,
  openWorkbench,
  sendAndWait,
} from "./keydex-context-helpers";
import { startKeydexE2EFixture, type KeydexE2EFixture } from "./keydex-e2e-fixtures";

test.describe.configure({ mode: "serial" });

let fixture: KeydexE2EFixture;

test.beforeAll(async () => {
  fixture = await startKeydexE2EFixture("context-workspace");
});

test.beforeEach(async () => {
  await fixture.removeSystemKeydexMarkdown();
  await fixture.removeWorkspaceKeydexMarkdown();
});

test.afterAll(async () => {
  await fixture?.stop();
});

test("E09 workspace context is ordered system then workspace", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("POLICY=SYSTEM SYSTEM-E09");
  await fixture.writeWorkspaceKeydexMarkdown("POLICY=WORKSPACE WORKSPACE-E09");
  const session = await fixture.createWorkspaceSession("E09 layer order");
  const input = await openConversation(fixture, page, session);
  const answer = await sendAndWait(page, input, "KeydexContextE2E inspect E09");

  await expect(answer).toContainText("documents=2");
  await expect(answer).toContainText("scopes=system,workspace");
  await expect(answer).toContainText("order=system>workspace");
  await expect(answer).toContainText("POLICY=SYSTEM SYSTEM-E09|POLICY=WORKSPACE WORKSPACE-E09");
  await fixture.evidence(page, "E09-layer-order");
});

test("E10 workspace session falls back to system-only context", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("SYSTEM-ONLY");
  const session = await fixture.createWorkspaceSession("E10 system only");
  const input = await openConversation(fixture, page, session);
  const answer = await sendAndWait(page, input, "KeydexContextE2E inspect E10");

  await expect(answer).toContainText("documents=1");
  await expect(answer).toContainText("scopes=system");
  await expect(answer).toContainText("SYSTEM-ONLY");
  await fixture.evidence(page, "E10-project-system-only");
});

test("E11 workspace-only context works without system keydex.md", async ({ page }) => {
  await fixture.writeWorkspaceKeydexMarkdown("WORKSPACE-ONLY");
  const session = await fixture.createWorkspaceSession("E11 workspace only");
  const input = await openConversation(fixture, page, session);
  const answer = await sendAndWait(page, input, "KeydexContextE2E inspect E11");

  await expect(answer).toContainText("documents=1");
  await expect(answer).toContainText("scopes=workspace");
  await expect(answer).toContainText("WORKSPACE-ONLY");
  await fixture.evidence(page, "E11-project-workspace-only");
});

test("E12 workspace A and B contexts remain strictly isolated", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("SHARED-SYSTEM-E12");
  await fixture.writeWorkspaceKeydexMarkdown("PROJECT-A");
  const workspaceB = await fixture.createAdditionalWorkspace("E12-B");
  await workspaceB.writeKeydexMarkdown("PROJECT-B");
  const sessionA = await fixture.createWorkspaceSession("E12 A");
  const sessionB = await workspaceB.createSession("E12 B");

  const inputA = await openConversation(fixture, page, sessionA);
  const answerA = await sendAndWait(page, inputA, "KeydexContextE2E inspect E12 A");
  await expect(answerA).toContainText("PROJECT-A");
  await expect(answerA).not.toContainText("PROJECT-B");

  const inputB = await openConversation(fixture, page, sessionB);
  const answerB = await sendAndWait(page, inputB, "KeydexContextE2E inspect E12 B");
  await expect(answerB).toContainText("PROJECT-B");
  await expect(answerB).not.toContainText("PROJECT-A");
  await fixture.evidence(page, "E12-workspace-isolation");
});

test("E13 workspace update is Turn-pinned and isolated from another project", async ({
  page,
}) => {
  await fixture.writeSystemKeydexMarkdown("SHARED-SYSTEM-E13");
  await fixture.writeWorkspaceKeydexMarkdown("A-V1");
  const workspaceB = await fixture.createAdditionalWorkspace("E13-B");
  await workspaceB.writeKeydexMarkdown("B-STABLE");
  const sessionA = await fixture.createWorkspaceSession("E13 A");
  const sessionB = await workspaceB.createSession("E13 B");

  const inputA = await openConversation(fixture, page, sessionA);
  const firstMessage = "KeydexContextE2E E13 A first";
  await inputA.fill(firstMessage);
  await page.getByLabel("发送").click();
  await fixture.waitForModelRequest(firstMessage);
  await fixture.writeWorkspaceKeydexMarkdown("A-V2");
  await expect(page.getByText(/KeydexContextE2E .*A-V1/)).toBeVisible({ timeout: 30_000 });
  await expect(await sendAndWait(page, inputA, "KeydexContextE2E E13 A second")).toContainText(
    "A-V2",
  );

  const inputB = await openConversation(fixture, page, sessionB);
  const answerB = await sendAndWait(page, inputB, "KeydexContextE2E E13 B");
  await expect(answerB).toContainText("B-STABLE");
  await expect(answerB).not.toContainText("A-V2");
  await fixture.evidence(page, "E13-workspace-turn-pin-isolation");
});

test("E14 workspace create rename restore and delete refreshes without reload", async ({
  page,
}) => {
  await fixture.writeSystemKeydexMarkdown("E14-SYSTEM");
  const session = await fixture.createWorkspaceSession("E14 workspace lifecycle");
  const input = await openConversation(fixture, page, session);
  await expect(await sendAndWait(page, input, "KeydexContextE2E E14 missing")).toContainText(
    "scopes=system",
  );

  await fixture.writeWorkspaceKeydexMarkdown("WORKSPACE-CREATED");
  await expect(await sendAndWait(page, input, "KeydexContextE2E E14 created")).toContainText(
    "WORKSPACE-CREATED",
  );
  await fixture.renameWorkspaceKeydexMarkdown("keydex-away.md");
  const renamed = await sendAndWait(page, input, "KeydexContextE2E E14 renamed");
  await expect(renamed).not.toContainText("WORKSPACE-CREATED");

  await fixture.writeWorkspaceKeydexMarkdown("WORKSPACE-RESTORED");
  await expect(await sendAndWait(page, input, "KeydexContextE2E E14 restored")).toContainText(
    "WORKSPACE-RESTORED",
  );
  await fixture.removeWorkspaceKeydexMarkdown();
  const removed = await sendAndWait(page, input, "KeydexContextE2E E14 removed");
  await expect(removed).not.toContainText("WORKSPACE-RESTORED");
  await fixture.evidence(page, "E14-workspace-lifecycle");
});

test("E15 Home project selection uses workspace context on the first message", async ({
  page,
}) => {
  await fixture.writeSystemKeydexMarkdown("E15-SYSTEM");
  await fixture.writeWorkspaceKeydexMarkdown("HOME-PROJECT");
  const input = await openHomeScope(fixture, page, "workspace");
  const answer = await sendAndWait(page, input, "KeydexContextE2E inspect E15");

  await expect(page).toHaveURL(/#\/conversation\//);
  await expect(answer).toContainText("E15-SYSTEM");
  await expect(answer).toContainText("HOME-PROJECT");
  await fixture.evidence(page, "E15-home-project-first-turn");
});

test("E16 directly opened Conversation resolves the same effective context", async ({
  page,
}) => {
  await fixture.writeSystemKeydexMarkdown("E16-SYSTEM");
  await fixture.writeWorkspaceKeydexMarkdown("CONVERSATION-PROJECT");
  const session = await fixture.createWorkspaceSession("E16 direct conversation");
  const input = await openConversation(fixture, page, session);
  const answer = await sendAndWait(page, input, "KeydexContextE2E inspect E16");

  await expect(answer).toContainText("E16-SYSTEM");
  await expect(answer).toContainText("CONVERSATION-PROJECT");
  await fixture.evidence(page, "E16-direct-conversation");
});

test("E17 Workbench and Conversation share one effective context", async ({ page }) => {
  await fixture.writeSystemKeydexMarkdown("E17-SYSTEM");
  await fixture.writeWorkspaceKeydexMarkdown("WORKBENCH-SAME");
  const session = await fixture.createWorkspaceSession("E17 cross surface");
  const conversationInput = await openConversation(fixture, page, session);
  await expect(
    await sendAndWait(page, conversationInput, "KeydexContextE2E E17 conversation"),
  ).toContainText("WORKBENCH-SAME");

  const workbenchInput = await openWorkbench(fixture, page, session);
  const answer = await sendAndWait(page, workbenchInput, "KeydexContextE2E E17 workbench");
  await expect(answer).toContainText("scopes=system,workspace");
  await expect(answer).toContainText("WORKBENCH-SAME");
  await fixture.evidence(page, "E17-conversation-workbench-context");
});
