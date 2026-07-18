import { expect, test } from "@playwright/test";

import { approval, dispatchAgentEvent } from "./workbench-e2e-fixtures";
import {
  activeSidecar,
  capsule,
  makeSubagentRun,
  openSubagentHarness,
  transitionRun,
} from "./subagent-e2e-fixtures";

test("steer, approval, cancel and failure controls remain addressable", async ({ page }) => {
  const steerRun = makeSubagentRun({ runId: "e2e-sa-008-steer", task: "initial direction", sequence: 1 });
  const harness = await openSubagentHarness(page, [steerRun]);

  await test.step("E2E-SA-008 Sidecar steer changes the later result", async () => {
    await harness.openRun(steerRun.run_id);
    const composer = activeSidecar(page).getByTestId("subagent-sidecar-composer");
    await composer.locator("textarea").fill("focus on the parser boundary");
    await composer.locator('button[type="submit"]').click();
    await expect.poll(() => harness.controls.filter((item) => item.action === "steer").length).toBe(1);
    const steered = harness.runsByParent.get(harness.parentSessionId)?.find((item) => item.run_id === steerRun.run_id);
    expect(steered?.version).toBe(2);
    await harness.publish(transitionRun(steered!, "completed", { finalReport: "parser boundary fixed" }));
    expect(harness.pageErrors).toEqual([]);
    await expect(capsule(page, steerRun.run_id)).toContainText("parser boundary fixed");
  });

  const approvalRun = makeSubagentRun({
    runId: "e2e-sa-009-approval",
    role: "worker",
    task: "command requiring approval",
    blockedOn: "approval",
    sequence: 2,
  });
  await test.step("E2E-SA-009 Sidecar resolves child approval then completes", async () => {
    await harness.publish(approvalRun);
    await harness.openRun(approvalRun.run_id);
    harness.approvalSessionById.set("e2e-sa-009-approval-id", approvalRun.child_session_id);
    await dispatchAgentEvent(page, {
      action: "approval_requested",
      data: {
        session_id: approvalRun.child_session_id,
        approval: { ...approval("e2e-sa-009-approval-id"), session_id: approvalRun.child_session_id },
      },
    });
    const card = activeSidecar(page).getByTestId("composer-approval-card");
    await expect(card).toBeVisible();
    await card.locator('[data-approval-choice="approve_once"]').click();
    await card.locator("footer button").last().click();
    await expect(card).toHaveCount(0);
    await harness.publish(transitionRun(approvalRun, "completed", { finalReport: "approved command finished" }));
    await expect(capsule(page, approvalRun.run_id)).toContainText("approved command finished");
  });

  const cancelRun = makeSubagentRun({ runId: "e2e-sa-010-cancel", role: "worker", sequence: 3 });
  await test.step("E2E-SA-010 Sidecar cancel yields a cancelled parent capsule", async () => {
    await harness.publish(cancelRun);
    await harness.openRun(cancelRun.run_id);
    await activeSidecar(page).getByTestId("subagent-sidecar-composer").locator('button[type="button"]').click();
    await expect(capsule(page, cancelRun.run_id)).toHaveAttribute("data-state", "cancelled");
    expect(harness.controls.at(-1)).toMatchObject({ action: "cancel", runId: cancelRun.run_id });
  });

  const failedRun = makeSubagentRun({ runId: "e2e-sa-011-failure", role: "worker", sequence: 4 });
  await test.step("E2E-SA-011 child failure is structured on the parent", async () => {
    await harness.publish(failedRun);
    await harness.publish(transitionRun(failedRun, "failed", {
      errorCode: "WORKER_TOOL_FAILED",
      errorMessage: "deterministic worker failure",
    }));
    await expect(capsule(page, failedRun.run_id)).toHaveAttribute("data-state", "failed");
    await expect(capsule(page, failedRun.run_id)).toContainText("deterministic worker failure");
  });
});

test("terminal Runs resume as new immutable Runs", async ({ page }) => {
  const interrupted = makeSubagentRun({
    runId: "e2e-sa-012-interrupted",
    state: "interrupted",
    subagentId: "resume-instance-interrupted",
    childSessionId: "resume-child-interrupted",
    sequence: 1,
  });
  const completed = makeSubagentRun({
    runId: "e2e-sa-013-completed",
    state: "completed",
    subagentId: "resume-instance-completed",
    childSessionId: "resume-child-completed",
    sequence: 10,
  });
  const harness = await openSubagentHarness(page, [interrupted, completed]);

  await test.step("E2E-SA-012 interrupted Run resumes with a new capsule", async () => {
    await harness.openRun(interrupted.run_id);
    const composer = activeSidecar(page).getByTestId("subagent-sidecar-composer");
    await composer.locator("textarea").fill("resume interrupted context");
    await composer.locator('button[type="submit"]').click();
    await expect(capsule(page, `${interrupted.run_id}-resume-1`)).toHaveAttribute("data-state", "queued");
  });

  await test.step("E2E-SA-013 completed Run resumes with a new capsule", async () => {
    await harness.openRun(completed.run_id);
    const composer = activeSidecar(page).getByTestId("subagent-sidecar-composer");
    await composer.locator("textarea").fill("follow-up completed context");
    await composer.locator('button[type="submit"]').click();
    await expect(capsule(page, `${completed.run_id}-resume-2`)).toHaveAttribute("data-state", "queued");
  });

  await test.step("E2E-SA-014 old terminal capsules remain unchanged after resume", async () => {
    await expect(capsule(page, interrupted.run_id)).toHaveAttribute("data-state", "interrupted");
    await expect(capsule(page, completed.run_id)).toHaveAttribute("data-state", "completed");
    await expect(page.locator('[data-testid^="subagent-run-capsule:"]')).toHaveCount(4);
  });
});

test("exact trace cancellation and historical controls cannot cross Runs", async ({ page }) => {
  const traceA = makeSubagentRun({
    runId: "e2e-sa-023-trace-a",
    role: "worker",
    parentTraceId: "shared-parent-trace",
    sequence: 1,
  });
  const traceB = makeSubagentRun({
    runId: "e2e-sa-023-trace-b",
    role: "worker",
    parentTraceId: "shared-parent-trace",
    sequence: 2,
  });
  const oldRun = makeSubagentRun({
    runId: "e2e-sa-027-old",
    state: "completed",
    subagentId: "history-instance",
    childSessionId: "history-child",
    sequence: 3,
  });
  const currentRun = makeSubagentRun({
    runId: "e2e-sa-027-current",
    subagentId: "history-instance",
    childSessionId: "history-child",
    sequence: 4,
  });
  const harness = await openSubagentHarness(page, [traceA, traceB, oldRun, currentRun]);

  await test.step("E2E-SA-023 parent trace cancellation targets the exact Run", async () => {
    await harness.openRun(traceA.run_id);
    await activeSidecar(page).getByTestId("subagent-sidecar-composer").locator('button[type="button"]').click();
    await expect(capsule(page, traceA.run_id)).toHaveAttribute("data-state", "cancelled");
    await expect(capsule(page, traceB.run_id)).toHaveAttribute("data-state", "running");
  });

  await test.step("E2E-SA-027 historical Run is readonly and current Run owns controls", async () => {
    await harness.openRun(oldRun.run_id);
    await expect(activeSidecar(page).getByTestId("subagent-historical-run-notice")).toBeVisible();
    await expect(activeSidecar(page).getByTestId("subagent-sidecar-composer")).toHaveCount(0);
    await harness.openRun(currentRun.run_id);
    await expect(activeSidecar(page).getByTestId("subagent-sidecar-composer")).toBeVisible();
    await expect(activeSidecar(page).getByTestId("subagent-historical-run-notice")).toHaveCount(0);
  });
});
