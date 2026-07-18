import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  capsule,
  makeSubagentRun,
  openSubagentHarness,
} from "./subagent-e2e-fixtures";

test("Explorer is read-only while Worker may change its temporary workspace", async ({ page }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "keydex-subagent-e2e-"));
  const target = path.join(directory, "role-boundary.txt");
  await writeFile(target, "original", "utf8");
  try {
    const harness = await openSubagentHarness(page);

    await test.step("E2E-SA-025 Explorer write is refused and the file is unchanged", async () => {
      const explorer = makeSubagentRun({
        runId: "e2e-sa-025-explorer-refused",
        role: "explorer",
        state: "failed",
        errorCode: "EXPLORER_WRITE_DENIED",
        errorMessage: "Explorer role cannot mutate files",
      });
      await harness.publish(explorer);
      await expect(capsule(page, explorer.run_id)).toHaveAttribute("data-state", "failed");
      await expect(capsule(page, explorer.run_id)).toContainText("Explorer role cannot mutate files");
      await expect.poll(() => readFile(target, "utf8")).toBe("original");
    });

    await test.step("E2E-SA-026 Worker may write inside the temporary workspace", async () => {
      await writeFile(target, "worker-updated", "utf8");
      const worker = makeSubagentRun({
        runId: "e2e-sa-026-worker-write",
        role: "worker",
        state: "completed",
        sequence: 2,
        finalReport: "temporary workspace updated",
      });
      await harness.publish(worker);
      await expect(capsule(page, worker.run_id)).toHaveAttribute("data-state", "completed");
      await expect(capsule(page, worker.run_id)).toContainText("temporary workspace updated");
      await expect.poll(() => readFile(target, "utf8")).toBe("worker-updated");
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy subagent projection coexists without double-projecting new Runs", async ({ page }) => {
  const harness = await openSubagentHarness(page, [], { legacyHistory: true });

  await test.step("E2E-SA-028 legacy event remains visible and new Run projects once", async () => {
    await page.getByTestId("message-thinking").getByRole("button").click();
    await expect(page.getByText("legacy subagent result", { exact: true })).toHaveCount(1);
    const run = makeSubagentRun({ runId: "e2e-sa-028-versioned", state: "completed" });
    await harness.publish(run);
    await expect(capsule(page, run.run_id)).toHaveCount(1);
    await expect(page.getByText("legacy subagent result", { exact: true })).toHaveCount(1);
  });
});
