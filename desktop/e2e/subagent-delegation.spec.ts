import { expect, test } from "@playwright/test";

import {
  SECOND_PARENT_SESSION,
  activeSidecar,
  capsule,
  makeSubagentRun,
  openSubagentHarness,
  transitionRun,
} from "./subagent-e2e-fixtures";

test("delegation capsules, parallel roles and controlled Sidecars stay correlated", async ({ page }) => {
  const explorer = makeSubagentRun({
    runId: "e2e-sa-001-explorer",
    role: "explorer",
    task: "inspect repository",
    sequence: 1,
  });
  const harness = await openSubagentHarness(page, [], {
    delegateInvocation: {
      runId: explorer.run_id,
      role: explorer.role,
      task: explorer.task,
    },
  });
  await test.step("E2E-SA-001 Explorer delegate -> capsule -> completed", async () => {
    const invocationCapsule = page.getByTestId("subagent-invocation-capsule");
    await expect(invocationCapsule).toHaveText("sub-explore");
    await expect(invocationCapsule).not.toContainText("inspect repository");
    const capsuleStyle = await invocationCapsule.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        borderTopWidth: style.borderTopWidth,
        display: style.display,
      };
    });
    expect(capsuleStyle).toMatchObject({
      borderRadius: "999px",
      borderTopWidth: "1px",
      display: "inline-flex",
    });
    expect(capsuleStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    await expect(page.getByTestId("tool-call-block")).toHaveCount(0);
    await invocationCapsule.click();
    await expect(page.getByRole("tab", { name: "子智能体" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("subagent-invocation-detail-panel")).toContainText("inspect repository");
    await page.getByRole("button", { name: "返回 Sub-Agent 列表" }).click();
    await expect(page.getByTestId("subagent-sidebar-empty")).toBeVisible();
    await harness.publish(explorer);
    await expect(invocationCapsule).toHaveCount(0);
    await expect(capsule(page, explorer.run_id)).toHaveAttribute("data-state", "running");
    await expect(capsule(page, explorer.run_id)).toHaveText("sub-explore");
    await harness.publish(transitionRun(explorer, "completed", { finalReport: "explorer findings" }));
    await expect(capsule(page, explorer.run_id)).toHaveAttribute("data-state", "completed");
    await expect(capsule(page, explorer.run_id)).toHaveText("sub-explore");
  });

  const worker = makeSubagentRun({
    runId: "e2e-sa-002-worker",
    role: "worker",
    task: "implement focused change",
    sequence: 2,
  });
  await test.step("E2E-SA-002 Worker delegate -> capsule -> report", async () => {
    await harness.publish(worker);
    await harness.publish(transitionRun(worker, "completed", { finalReport: "worker patch complete" }));
    await expect(capsule(page, worker.run_id)).toHaveAttribute("data-state", "completed");
    await expect(capsule(page, worker.run_id)).toHaveText("sub-worker");
  });

  const explorerA = makeSubagentRun({ runId: "e2e-sa-003-explorer-a", sequence: 3 });
  const explorerB = makeSubagentRun({ runId: "e2e-sa-003-explorer-b", sequence: 4 });
  await test.step("E2E-SA-003 multiple Explorers run in parallel", async () => {
    await harness.publish(explorerA);
    await harness.publish(explorerB);
    await expect(capsule(page, explorerA.run_id)).toHaveAttribute("data-state", "running");
    await expect(capsule(page, explorerB.run_id)).toHaveAttribute("data-state", "running");
  });

  const workerA = makeSubagentRun({ runId: "e2e-sa-004-worker-a", role: "worker", sequence: 5 });
  const workerB = makeSubagentRun({ runId: "e2e-sa-004-worker-b", role: "worker", sequence: 6 });
  await test.step("E2E-SA-004 multiple Workers run in parallel", async () => {
    await harness.publish(workerA);
    await harness.publish(workerB);
    await expect(capsule(page, workerA.run_id)).toHaveAttribute("data-state", "running");
    await expect(capsule(page, workerB.run_id)).toHaveAttribute("data-state", "running");
  });

  await test.step("E2E-SA-005 mixed Explorer and Worker parallel capsules", async () => {
    await expect(capsule(page, explorerA.run_id)).toContainText("sub-explore");
    await expect(capsule(page, workerA.run_id)).toContainText("sub-worker");
  });

  await test.step("E2E-SA-006 clicking a capsule opens its exact Sidecar", async () => {
    harness.childHistoryBySession.set(explorerA.child_session_id, "explorer-a private transcript");
    await harness.openRun(explorerA.run_id);
    const sidecar = activeSidecar(page);
    await expect(page.getByRole("tab", { name: "子智能体" })).toHaveAttribute("aria-selected", "true");
    await expect(sidecar).toContainText("explorer-a private transcript");

    await page.getByRole("button", { name: "返回 Sub-Agent 列表" }).click();
    const list = page.getByTestId("subagent-sidebar-list");
    await expect(list).toBeVisible();
    await expect(list.getByText("进行中 · 4")).toBeVisible();
    const listItems = list.locator('[data-testid^="subagent-sidebar-item:"]');
    const listItemLayout = await listItems.evaluateAll((items) =>
      items.map((item) => {
        const summary = item.querySelector<HTMLElement>('[class*="itemSummary"]');
        const summaryStyle = summary ? window.getComputedStyle(summary) : null;
        return {
          height: item.getBoundingClientRect().height,
          summaryOverflow: summaryStyle?.textOverflow,
          summaryWhiteSpace: summaryStyle?.whiteSpace,
        };
      }),
    );
    expect(listItemLayout.every((item) => item.height <= 42)).toBe(true);
    expect(listItemLayout.every((item) => item.summaryOverflow === "ellipsis")).toBe(true);
    expect(listItemLayout.every((item) => item.summaryWhiteSpace === "nowrap")).toBe(true);
    await expect(listItems.first()).toHaveAttribute(
      "data-testid",
      `subagent-sidebar-item:${workerB.subagent_id}`,
    );
    await page.getByTestId(`subagent-sidebar-item:${explorerA.subagent_id}`).click();
    await expect(activeSidecar(page)).toContainText("explorer-a private transcript");
  });

  await test.step("E2E-SA-007 child tool process never projects into parent", async () => {
    harness.childHistoryBySession.set(workerA.child_session_id, "worker-a child tool output");
    await harness.openRun(workerA.run_id);
    const panels = page.getByTestId("conversation-panel");
    await expect(activeSidecar(page)).toContainText("worker-a child tool output");
    await expect(panels.first()).not.toContainText("worker-a child tool output");
  });
});

test("a waiting parent leaves the rest of the application interactive", async ({ page }) => {
  const waiting = makeSubagentRun({ runId: "e2e-sa-022-waiting", task: "long child work" });
  const harness = await openSubagentHarness(page, [waiting]);

  await test.step("E2E-SA-022 parent waits while another session remains usable", async () => {
    await expect(capsule(page, waiting.run_id)).toHaveAttribute("data-state", "running");
    await page.goto(`/#/conversation/${SECOND_PARENT_SESSION}`);
    await expect(page.getByTestId("conversation-panel")).toBeVisible();
    await expect(capsule(page, waiting.run_id)).toHaveCount(0);
    await page.goto(`/#/conversation/${harness.parentSessionId}`);
    await expect(page.getByTestId("conversation-panel")).toBeVisible();
    await harness.snapshot();
    await expect(capsule(page, waiting.run_id)).toHaveAttribute("data-state", "running");
  });
});

test("parallel Worker completion order cannot cross reports", async ({ page }) => {
  const first = makeSubagentRun({ runId: "e2e-sa-024-worker-a", role: "worker", sequence: 1 });
  const second = makeSubagentRun({ runId: "e2e-sa-024-worker-b", role: "worker", sequence: 2 });
  const harness = await openSubagentHarness(page, [first, second]);

  await test.step("E2E-SA-024 out-of-order Worker completion keeps exact correlation", async () => {
    await harness.publish(transitionRun(second, "completed", { finalReport: "report-for-worker-b" }));
    await harness.publish(transitionRun(first, "completed", { finalReport: "report-for-worker-a" }));
    await expect(capsule(page, first.run_id)).toHaveText("sub-worker");
    await expect(capsule(page, second.run_id)).toHaveText("sub-worker");
    const orderedIds = await page
      .locator('[data-testid^="subagent-run-capsule:"]')
      .evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")));
    expect(orderedIds).toEqual([
      `subagent-run-capsule:${first.run_id}`,
      `subagent-run-capsule:${second.run_id}`,
    ]);

    await harness.openRun(first.run_id);
    await page.getByRole("button", { name: "返回 Sub-Agent 列表" }).click();
    await expect(page.getByTestId(`subagent-sidebar-item:${first.subagent_id}`)).toContainText(
      "report-for-worker-a",
    );
    await expect(page.getByTestId(`subagent-sidebar-item:${first.subagent_id}`)).not.toContainText(
      "report-for-worker-b",
    );
    await expect(page.getByTestId(`subagent-sidebar-item:${second.subagent_id}`)).toContainText(
      "report-for-worker-b",
    );
  });
});
