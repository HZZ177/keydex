import { expect, test } from "@playwright/test";

import {
  INTERNAL_CHILD_TITLE,
  SECOND_PARENT_SESSION,
  capsule,
  makeSubagentRun,
  openSubagentHarness,
  transitionRun,
} from "./subagent-e2e-fixtures";

test("refresh and reconnect snapshots restore durable Run state", async ({ page }) => {
  const completed = makeSubagentRun({ runId: "e2e-sa-015-refresh", state: "completed" });
  const reconnecting = makeSubagentRun({ runId: "e2e-sa-016-reconnect", sequence: 2 });
  const harness = await openSubagentHarness(page, [completed, reconnecting]);

  await test.step("E2E-SA-015 refresh restores capsules from a snapshot", async () => {
    await page.reload({ waitUntil: "commit" });
    await expect(page.getByTestId("conversation-panel")).toBeVisible({ timeout: 30_000 });
    await harness.snapshot();
    await expect(capsule(page, completed.run_id)).toHaveAttribute("data-state", "completed");
  });

  await test.step("E2E-SA-016 reconnect snapshot reconciles completion while disconnected", async () => {
    const terminal = transitionRun(reconnecting, "completed", { finalReport: "finished during reconnect" });
    harness.setRun(terminal);
    await harness.snapshot();
    await expect(capsule(page, reconnecting.run_id)).toHaveAttribute("data-state", "completed");
    await expect(capsule(page, reconnecting.run_id)).toContainText("finished during reconnect");
  });
});

test("internal child Sessions never enter ordinary discovery surfaces", async ({ page }) => {
  await openSubagentHarness(page);

  await test.step("E2E-SA-017 left Session list hides internal children", async () => {
    await expect(page.getByText(INTERNAL_CHILD_TITLE)).toHaveCount(0);
  });

  await test.step("E2E-SA-018 Session search cannot discover internal children", async () => {
    const searchButton = page.locator("nav button:has(svg.lucide-search)").first();
    if (await searchButton.count()) await searchButton.click();
    await expect(page.getByText(INTERNAL_CHILD_TITLE)).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  await test.step("E2E-SA-019 recent Session surfaces hide internal children", async () => {
    await expect(page.locator("aside").getByText(INTERNAL_CHILD_TITLE)).toHaveCount(0);
  });

  await test.step("E2E-SA-020 pinned Session surfaces hide internal children", async () => {
    await expect(page.getByText(INTERNAL_CHILD_TITLE, { exact: true })).toHaveCount(0);
  });
});

test("two parents remain isolated in navigation and projection", async ({ page }) => {
  const parentA = makeSubagentRun({ runId: "e2e-sa-021-parent-a", sequence: 1 });
  const parentB = makeSubagentRun({
    runId: "e2e-sa-021-parent-b",
    parentSessionId: SECOND_PARENT_SESSION,
    sequence: 1,
  });
  const harness = await openSubagentHarness(page, [parentA, parentB]);

  await test.step("E2E-SA-021 two parent sessions never contaminate each other", async () => {
    await harness.snapshot(parentA.parent_session_id);
    await harness.snapshot(parentB.parent_session_id);
    await expect(capsule(page, parentA.run_id)).toBeVisible();
    await expect(capsule(page, parentB.run_id)).toHaveCount(0);

    await page.goto(`/#/conversation/${SECOND_PARENT_SESSION}`);
    await expect(page.getByTestId("conversation-panel")).toBeVisible();
    await harness.snapshot(SECOND_PARENT_SESSION);
    await expect(capsule(page, parentB.run_id)).toBeVisible();
    await expect(capsule(page, parentA.run_id)).toHaveCount(0);
  });
});
