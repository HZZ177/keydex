import { expect, test, type Page } from "@playwright/test";
import { access } from "node:fs/promises";
import * as path from "node:path";

import { startGitE2EFixture } from "./git-e2e-fixtures";

test("merge conflict recovery, merge commit, patch export and reset preview close on a disposable repo", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await startGitE2EFixture("conflict-advanced");
  try {
    await fixture.write("conflict.txt", "base\n");
    await fixture.commit("test: conflict base", ["conflict.txt"]);
    await fixture.createBranch("feature/conflict", true);
    await fixture.write("conflict.txt", "theirs\n");
    await fixture.commit("feat: conflicting side", ["conflict.txt"]);
    await fixture.git(["switch", "main"]);
    await fixture.write("conflict.txt", "ours\n");
    await fixture.commit("fix: main conflicting side", ["conflict.txt"]);

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "操作" }).click();

    const merge = page.getByRole("region", { name: "Merge workflow" });
    await merge.getByRole("combobox", { name: "Source branch or revision" }).fill("feature/conflict");
    await merge.getByRole("button", { name: "Preview" }).click();
    await expect(merge).toContainText("Merge commit required", { timeout: 10_000 });
    await merge.getByRole("button", { name: "Merge", exact: true }).click();
    await expect(page.getByRole("region", { name: "Recovered Git operation" })).toContainText("conflicted", { timeout: 15_000 });
    expect((await fixture.git(["diff", "--name-only", "--diff-filter=U"])).stdout.trim()).toBe("conflict.txt");

    await page.getByRole("button", { name: "Resolve conflicts" }).click();
    const conflictDetails = page.getByRole("region", { name: "Conflict details" });
    await expect(conflictDetails).toContainText("conflict.txt", { timeout: 10_000 });
    await conflictDetails.getByRole("option", { name: /conflict\.txt/ }).click();
    const conflictActions = page.getByRole("region", { name: "Conflict resolution actions" });
    page.on("dialog", (dialog) => dialog.accept());
    await conflictActions.getByRole("button", { name: "Accept ours" }).click();
    expect((await fixture.git(["diff", "--name-only", "--diff-filter=U"])).stdout.trim()).toBe("conflict.txt");
    await expect(conflictActions.getByRole("button", { name: "Mark resolved and stage" })).toBeEnabled({ timeout: 10_000 });
    await conflictActions.getByRole("button", { name: "Mark resolved and stage" }).click();
    await expect.poll(async () => (await fixture.git(["diff", "--name-only", "--diff-filter=U"])).stdout.trim()).toBe("");
    expect((await fixture.git(["show", ":conflict.txt"])).stdout.trim()).toBe("ours");

    const editor = page.getByRole("region", { name: "Commit 编辑器" });
    await expect(editor).toContainText("0 个已暂存文件", { timeout: 10_000 });
    await editor.getByRole("textbox", { name: "Commit message" }).fill("merge: resolve feature conflict");
    await expect(editor.getByRole("button", { name: "提交", exact: true })).toBeEnabled({ timeout: 10_000 });
    await editor.getByRole("button", { name: "提交", exact: true }).click();
    await expect.poll(async () => (await fixture.git(["log", "-1", "--pretty=%s"])).stdout.trim(), { timeout: 15_000 }).toBe("merge: resolve feature conflict");
    expect((await fixture.git(["show", "-s", "--pretty=%P", "HEAD"])).stdout.trim().split(/\s+/)).toHaveLength(2);

    await page.getByRole("tab", { name: "操作" }).click();
    const patchExchange = page.getByRole("region", { name: "Patch import and export" });
    await patchExchange.getByRole("combobox", { name: "Patch export mode" }).selectOption("commit");
    await patchExchange.getByRole("textbox", { name: "Patch left revision" }).fill("HEAD");
    await patchExchange.getByRole("button", { name: "Generate patch" }).click();
    await expect(patchExchange.getByRole("textbox", { name: "Exported patch" })).toContainText("diff --git", { timeout: 10_000 });

    const reset = page.getByRole("region", { name: "Reset and restore" });
    await reset.getByRole("textbox", { name: "Reset target" }).fill("HEAD~2");
    await reset.getByRole("combobox", { name: "Reset mode" }).selectOption("mixed");
    await reset.getByRole("button", { name: "Preview reset" }).click();
    await expect(reset.getByRole("list", { name: "Reset affected files" })).toContainText("conflict.txt", { timeout: 10_000 });
    await expect(reset).toContainText("history-rewrite");
    await fixture.screenshot(page, "e2e-066-conflict-and-advanced");
  } finally {
    await fixture.cleanup();
  }
});

test("path restore confirmation, hard reset cancellation and confirmed recovery preserve unselected data semantics", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await startGitE2EFixture("reset-restore-safety");
  try {
    await fixture.write("a.txt", "a base\n");
    await fixture.write("b.txt", "b base\n");
    await fixture.commit("test: reset baseline", ["a.txt", "b.txt"]);
    const originalHead = (await fixture.git(["rev-parse", "HEAD"])).stdout.trim();
    const resetTarget = (await fixture.git(["rev-parse", "HEAD~1"])).stdout.trim();
    await fixture.write("a.txt", "a local\n");
    await fixture.write("b.txt", "b local\n");

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "操作" }).click();
    const reset = page.getByRole("region", { name: "Reset and restore" });
    await reset.getByRole("textbox", { name: "Restore paths" }).fill("a.txt");
    await reset.getByRole("textbox", { name: "Restore source" }).fill("HEAD");
    await reset.getByRole("combobox", { name: "Restore destination" }).selectOption("worktree");
    await reset.getByRole("button", { name: "Restore selected paths" }).click();
    const restoreDialog = reset.getByRole("alertdialog", { name: "Confirm path restore" });
    await expect(restoreDialog).toContainText("a.txt");
    await restoreDialog.getByRole("button", { name: "Cancel" }).click();
    expect((await fixture.git(["show", ":a.txt"])).stdout.trim()).toBe("a base");
    expect((await fixture.git(["diff", "--", "a.txt"])).stdout).toContain("a local");
    expect((await fixture.git(["diff", "--", "b.txt"])).stdout).toContain("b local");

    await reset.getByRole("button", { name: "Restore selected paths" }).click();
    await restoreDialog.getByRole("button", { name: "Confirm restore" }).click();
    await expect(page.getByTestId("git-tool-window")).toContainText("Restored 1 path(s) in worktree", { timeout: 20_000 });
    await expect.poll(async () => (await fixture.git(["diff", "--", "a.txt"])).stdout.trim(), { timeout: 15_000 }).toBe("");
    expect((await fixture.git(["diff", "--", "b.txt"])).stdout).toContain("b local");

    await reset.getByRole("textbox", { name: "Reset target" }).fill("HEAD~1");
    await reset.getByRole("combobox", { name: "Reset mode" }).selectOption("hard");
    await reset.getByRole("button", { name: "Preview reset" }).click();
    await expect(reset).toContainText("destructive", { timeout: 10_000 });
    page.once("dialog", (dialog) => dialog.dismiss());
    await reset.getByRole("button", { name: "Reset to target" }).click();
    expect((await fixture.git(["rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);

    page.on("dialog", (dialog) => dialog.accept());
    await reset.getByRole("button", { name: "Reset to target" }).click();
    await expect.poll(async () => (await fixture.git(["rev-parse", "HEAD"])).stdout.trim(), { timeout: 20_000 }).toBe(resetTarget);
    expect((await fixture.git(["status", "--porcelain"])).stdout.trim()).toBe("");
    expect((await fixture.git(["reflog", "-1", "--format=%H", "HEAD@{1}"])).stdout.trim()).toBe(originalHead);
    await fixture.screenshot(page, "e2e-064-reset-restore-safety");
  } finally {
    await fixture.cleanup();
  }
});

test("interactive rebase validates todo, cancels safely and applies a reword message", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await startGitE2EFixture("interactive-rebase");
  try {
    await fixture.createBranch("feature/reword", true);
    await fixture.write("rebase-one.txt", "first\n");
    await fixture.commit("feat: rebase first", ["rebase-one.txt"]);
    await fixture.write("rebase-two.txt", "second\n");
    await fixture.commit("feat: rebase second", ["rebase-two.txt"]);
    const originalHead = (await fixture.git(["rev-parse", "HEAD"])).stdout.trim();
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "操作" }).click();
    const rebase = page.getByRole("region", { name: "Rebase workflow" });
    await rebase.getByRole("combobox", { name: "Rebase upstream" }).fill("main");
    await rebase.getByRole("checkbox", { name: "Edit interactive todo" }).check();
    await rebase.getByRole("button", { name: "Preview" }).click();
    const todo = rebase.getByRole("list", { name: "Interactive rebase todo" });
    await expect(todo.getByRole("listitem")).toHaveCount(2, { timeout: 15_000 });
    const firstAction = todo.getByRole("combobox").nth(0);
    await firstAction.selectOption("squash");
    await expect(rebase.getByRole("alert")).toContainText("needs a previous");
    await firstAction.selectOption("pick");
    const secondAction = todo.getByRole("combobox").nth(1);
    await secondAction.selectOption("reword");
    await todo.getByRole("textbox", { name: /New message for feat: rebase second/ }).fill("feat: rebase second rewritten");

    await rebase.getByRole("button", { name: "Rebase", exact: true }).click();
    const confirmRebase = rebase.getByRole("alertdialog", { name: "Confirm rebase" });
    await expect(confirmRebase).toContainText("Rewrite 2 local commit");
    await confirmRebase.getByRole("button", { name: "Cancel" }).click();
    expect((await fixture.git(["rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);
    await rebase.getByRole("button", { name: "Rebase", exact: true }).click();
    await confirmRebase.getByRole("button", { name: "Confirm rebase" }).click();
    await expect.poll(async () => (await fixture.git(["log", "-1", "--pretty=%s"])).stdout.trim(), { timeout: 30_000 })
      .toBe("feat: rebase second rewritten");
    expect((await fixture.git(["rev-parse", "HEAD"])).stdout.trim()).not.toBe(originalHead);
    await expect.poll(async () => await fileExists(path.join(fixture.repositoryRoot, ".git", "rebase-merge")), { timeout: 30_000 }).toBe(false);
    await fixture.screenshot(page, "e2e-057-interactive-rebase-reword");
  } finally {
    await fixture.cleanup();
  }
});

test("ordered cherry-pick marks an empty commit, confirms skip and continues the remaining queue with origin trailers", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await startGitE2EFixture("cherry-pick-empty-skip");
  try {
    await fixture.createBranch("source/cherry", true);
    await fixture.write("one.txt", "one\n");
    const first = await fixture.commit("feat: cherry first", ["one.txt"]);
    await fixture.write("same.txt", "same\n");
    const empty = await fixture.commit("feat: cherry already present", ["same.txt"]);
    await fixture.write("three.txt", "three\n");
    const third = await fixture.commit("feat: cherry third", ["three.txt"]);
    await fixture.git(["switch", "main"]);
    await fixture.write("same.txt", "same\n");
    await fixture.commit("main: pre-apply same content", ["same.txt"]);

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "操作" }).click();
    const cherry = page.getByRole("region", { name: "Cherry-pick workflow" });
    await cherry.getByRole("textbox", { name: "Commits" }).fill([first, empty, third].join("\n"));
    await cherry.getByRole("checkbox", { name: "Append origin metadata (-x)" }).check();
    await cherry.getByRole("button", { name: "Cherry-pick commits" }).click();
    await expect(cherry.getByRole("status")).toContainText(/Cherry-pick (continuable|conflicted)/, { timeout: 30_000 });
    const queue = cherry.getByRole("list", { name: "Cherry-pick result queue" });
    await expect(queue.getByText(empty.slice(0, 12)).locator("..")).toHaveAttribute("data-state", "empty");
    await cherry.getByRole("button", { name: "Skip" }).click();
    const skipDialog = cherry.getByRole("alertdialog", { name: "Confirm cherry-pick skip" });
    await expect(skipDialog).toContainText("remaining commits continue");
    await skipDialog.getByRole("button", { name: "Confirm skip" }).click();
    await expect.poll(async () => (await fixture.git(["status", "--porcelain=v1"])).stdout.trim(), { timeout: 30_000 }).toBe("");
    expect((await fixture.git(["log", "--pretty=%s", "-3"])).stdout).toContain("feat: cherry first");
    expect((await fixture.git(["log", "--pretty=%s", "-3"])).stdout).toContain("feat: cherry third");
    expect((await fixture.git(["log", "-2", "--pretty=%B"])).stdout).toContain(`cherry picked from commit ${third}`);
    await expect(queue.getByText(first.slice(0, 12)).locator("..")).toHaveAttribute("data-state", "applied");
    await expect(queue.getByText(empty.slice(0, 12)).locator("..")).toHaveAttribute("data-state", "empty");
    await expect(queue.getByText(third.slice(0, 12)).locator("..")).toHaveAttribute("data-state", "applied");
    await fixture.screenshot(page, "e2e-058-cherry-pick-empty-skip");
  } finally {
    await fixture.cleanup();
  }
});

test("rebase conflict survives reload, aborts to the original head and can be resolved and continued", async ({ page }) => {
  test.setTimeout(150_000);
  const fixture = await startGitE2EFixture("rebase-conflict-recovery");
  try {
    await fixture.write("rebase-conflict.txt", "base\n");
    await fixture.commit("test: rebase conflict base", ["rebase-conflict.txt"]);
    await fixture.createBranch("feature/rebase-conflict", true);
    await fixture.write("rebase-conflict.txt", "feature\n");
    await fixture.commit("feat: rebase conflicting change", ["rebase-conflict.txt"]);
    const originalHead = (await fixture.git(["rev-parse", "HEAD"])).stdout.trim();
    await fixture.git(["switch", "main"]);
    await fixture.write("rebase-conflict.txt", "main\n");
    await fixture.commit("fix: main rebase conflict", ["rebase-conflict.txt"]);
    await fixture.git(["switch", "feature/rebase-conflict"]);

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await startConflictingRebase(page);
    await expect(page.getByRole("region", { name: "Recovered Git operation" })).toHaveAttribute("data-kind", "rebase", { timeout: 30_000 });
    await expect(page.getByRole("region", { name: "Recovered Git operation" })).toHaveAttribute("data-state", "conflicted");
    expect((await fixture.git(["diff", "--name-only", "--diff-filter=U"])).stdout.trim()).toBe("rebase-conflict.txt");

    await page.reload();
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "操作" }).click();
    const recovered = page.getByRole("region", { name: "Recovered Git operation" });
    await expect(recovered).toHaveAttribute("data-kind", "rebase", { timeout: 30_000 });
    await expect(recovered).toContainText("conflicted");
    await recovered.getByRole("button", { name: "Abort", exact: true }).click();
    const abortDialog = recovered.getByRole("alertdialog", { name: "Confirm recovered operation abort" });
    await abortDialog.getByRole("button", { name: "Confirm abort" }).click();
    await expect.poll(async () => (await fixture.git(["rev-parse", "HEAD"])).stdout.trim(), { timeout: 30_000 }).toBe(originalHead);
    await expect.poll(async () => await fileExists(path.join(fixture.repositoryRoot, ".git", "rebase-merge")), { timeout: 30_000 }).toBe(false);

    await startConflictingRebase(page);
    await resolveCurrentConflict(page, "rebase-conflict.txt", "theirs");
    await page.getByRole("tab", { name: "操作" }).click();
    const rebase = page.getByRole("region", { name: "Rebase workflow" });
    await expect(rebase.getByRole("button", { name: "Continue", exact: true })).toBeEnabled({ timeout: 20_000 });
    await rebase.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.poll(async () => await fileExists(path.join(fixture.repositoryRoot, ".git", "rebase-merge")), { timeout: 30_000 }).toBe(false);
    expect((await fixture.git(["branch", "--show-current"])).stdout.trim()).toBe("feature/rebase-conflict");
    expect((await fixture.git(["show", "HEAD:rebase-conflict.txt"])).stdout.trim()).toBe("feature");
    expect((await fixture.git(["rev-parse", "HEAD"])).stdout.trim()).not.toBe(originalHead);
    await fixture.screenshot(page, "e2e-061-072-rebase-conflict-recovery");
  } finally {
    await fixture.cleanup();
  }
});

test("cherry-pick conflicts support abort, skip and resolve-continue across ordered queues", async ({ page }) => {
  test.setTimeout(180_000);
  const fixture = await startGitE2EFixture("cherry-conflict-controls");
  try {
    await fixture.write("cherry-conflict.txt", "base\n");
    await fixture.commit("test: cherry conflict base", ["cherry-conflict.txt"]);
    await fixture.createBranch("source/cherry-one", true);
    await fixture.write("cherry-conflict.txt", "source one\n");
    const conflictOne = await fixture.commit("feat: cherry conflict one", ["cherry-conflict.txt"]);
    await fixture.write("tail-one.txt", "tail one\n");
    const tailOne = await fixture.commit("feat: cherry tail one", ["tail-one.txt"]);
    await fixture.git(["switch", "main"]);
    await fixture.createBranch("source/cherry-two", true);
    await fixture.write("cherry-conflict.txt", "source two\n");
    const conflictTwo = await fixture.commit("feat: cherry conflict two", ["cherry-conflict.txt"]);
    await fixture.write("tail-two.txt", "tail two\n");
    const tailTwo = await fixture.commit("feat: cherry tail two", ["tail-two.txt"]);
    await fixture.git(["switch", "main"]);
    await fixture.write("cherry-conflict.txt", "main\n");
    await fixture.commit("fix: main cherry conflict", ["cherry-conflict.txt"]);
    const originalHead = (await fixture.git(["rev-parse", "HEAD"])).stdout.trim();

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "操作" }).click();
    const cherry = page.getByRole("region", { name: "Cherry-pick workflow" });
    const commits = cherry.getByRole("textbox", { name: "Commits" });
    await commits.fill([conflictOne, tailOne].join("\n"));
    await cherry.getByRole("button", { name: "Cherry-pick commits" }).click();
    await expect(cherry.getByRole("status")).toContainText("conflicted", { timeout: 30_000 });
    await cherry.getByRole("button", { name: "Abort", exact: true }).click();
    await cherry.getByRole("alertdialog", { name: "Confirm cherry-pick abort" }).getByRole("button", { name: "Confirm abort" }).click();
    await expect.poll(async () => (await fixture.git(["rev-parse", "HEAD"])).stdout.trim(), { timeout: 30_000 }).toBe(originalHead);
    await expect.poll(async () => await fileExists(path.join(fixture.repositoryRoot, ".git", "CHERRY_PICK_HEAD")), { timeout: 30_000 }).toBe(false);

    await cherry.getByRole("button", { name: "Cherry-pick commits" }).click();
    await expect(cherry.getByRole("status")).toContainText("conflicted", { timeout: 30_000 });
    await cherry.getByRole("button", { name: "Skip", exact: true }).click();
    await cherry.getByRole("alertdialog", { name: "Confirm cherry-pick skip" }).getByRole("button", { name: "Confirm skip" }).click();
    await expect.poll(async () => (await fixture.git(["log", "-1", "--pretty=%s"])).stdout.trim(), { timeout: 30_000 }).toBe("feat: cherry tail one");
    await expect.poll(async () => (await fixture.git(["status", "--porcelain=v1"])).stdout.trim(), { timeout: 30_000 }).toBe("");
    await expect(cherry.getByRole("list", { name: "Cherry-pick result queue" }).getByText(conflictOne.slice(0, 12)).locator("..")).toHaveAttribute("data-state", "empty");

    await page.reload();
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "操作" }).click();
    await commits.fill([conflictTwo, tailTwo].join("\n"));
    await cherry.getByRole("button", { name: "Cherry-pick commits" }).click();
    await expect(cherry.getByRole("status")).toContainText("conflicted", { timeout: 30_000 });
    await resolveCurrentConflict(page, "cherry-conflict.txt", "theirs");
    await page.getByRole("tab", { name: "操作" }).click();
    await expect(cherry.getByRole("button", { name: "Continue", exact: true })).toBeEnabled({ timeout: 20_000 });
    await cherry.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.poll(async () => (await fixture.git(["log", "-1", "--pretty=%s"])).stdout.trim(), { timeout: 30_000 }).toBe("feat: cherry tail two");
    await expect.poll(async () => (await fixture.git(["status", "--porcelain=v1"])).stdout.trim(), { timeout: 30_000 }).toBe("");
    await expect.poll(async () => (await fixture.git(["show", "HEAD~1:cherry-conflict.txt"])).stdout.trim(), { timeout: 30_000 }).toBe("source two");
    await fixture.screenshot(page, "e2e-062-cherry-conflict-controls");
  } finally {
    await fixture.cleanup();
  }
});

test("revert conflict abort restores the starting head and resolve-continue creates a consistent revert", async ({ page }) => {
  test.setTimeout(150_000);
  const fixture = await startGitE2EFixture("revert-conflict-controls");
  try {
    await fixture.write("revert-conflict.txt", "base\n");
    await fixture.commit("test: revert conflict base", ["revert-conflict.txt"]);
    await fixture.write("revert-conflict.txt", "target\n");
    const target = await fixture.commit("feat: revert conflict target", ["revert-conflict.txt"]);
    await fixture.write("revert-conflict.txt", "later\n");
    await fixture.commit("fix: later conflicting change", ["revert-conflict.txt"]);
    const originalHead = (await fixture.git(["rev-parse", "HEAD"])).stdout.trim();

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "操作" }).click();
    const revert = page.getByRole("region", { name: "Revert workflow" });
    await revert.getByRole("textbox", { name: "Commits to revert" }).fill(target);
    await revert.getByRole("button", { name: "Create revert commits" }).click();
    await expect(revert.getByRole("status")).toContainText("conflicted", { timeout: 30_000 });
    await revert.getByRole("button", { name: "Abort revert" }).click();
    await revert.getByRole("alertdialog", { name: "Confirm revert abort" }).getByRole("button", { name: "Confirm abort" }).click();
    await expect.poll(async () => (await fixture.git(["rev-parse", "HEAD"])).stdout.trim(), { timeout: 30_000 }).toBe(originalHead);
    await expect.poll(async () => await fileExists(path.join(fixture.repositoryRoot, ".git", "REVERT_HEAD")), { timeout: 30_000 }).toBe(false);

    await page.reload();
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "操作" }).click();
    await revert.getByRole("textbox", { name: "Commits to revert" }).fill(target);
    await expect(revert.getByRole("button", { name: "Create revert commits" })).toBeEnabled({ timeout: 20_000 });
    await revert.getByRole("button", { name: "Create revert commits" }).click();
    await expect(revert.getByRole("status")).toContainText("conflicted", { timeout: 30_000 });
    await resolveCurrentConflict(page, "revert-conflict.txt", "theirs");
    await page.getByRole("tab", { name: "操作" }).click();
    await expect(revert.getByRole("button", { name: "Continue revert" })).toBeEnabled({ timeout: 20_000 });
    await revert.getByRole("button", { name: "Continue revert" }).click();
    await expect.poll(async () => (await fixture.git(["status", "--porcelain=v1"])).stdout.trim(), { timeout: 30_000 }).toBe("");
    expect((await fixture.git(["show", "HEAD:revert-conflict.txt"])).stdout.trim()).toBe("base");
    expect((await fixture.git(["rev-parse", "HEAD"])).stdout.trim()).not.toBe(originalHead);
    expect((await fixture.git(["log", "-1", "--pretty=%s"])).stdout.trim()).toContain("Revert");
    await fixture.screenshot(page, "e2e-063-revert-conflict-controls");
  } finally {
    await fixture.cleanup();
  }
});

test("bisect requires confirmation, supports skip and classification, opens the culprit and resets the original branch", async ({ page }) => {
  test.setTimeout(150_000);
  const fixture = await startGitE2EFixture("bisect-assistant");
  try {
    for (let index = 1; index <= 4; index += 1) {
      await fixture.git(["commit", "--allow-empty", "-m", `test: bisect ${index} ${index < 3 ? "good" : "bad"}`]);
    }
    const originalHead = (await fixture.git(["rev-parse", "HEAD"])).stdout.trim();
    const expectedCulprit = (await fixture.git(["rev-parse", "HEAD~1"])).stdout.trim();
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "操作" }).click();
    const bisect = page.getByRole("region", { name: "Git bisect assistant" });
    await bisect.getByRole("combobox", { name: "Known good revision" }).fill("HEAD~4");
    await bisect.getByRole("combobox", { name: "Known bad revision" }).fill("HEAD");
    await bisect.getByRole("button", { name: "Start bisect" }).click();
    const confirm = bisect.getByRole("alertdialog", { name: "Confirm bisect start" });
    await confirm.getByRole("button", { name: "Cancel" }).click();
    expect((await fixture.git(["branch", "--show-current"])).stdout.trim()).toBe("main");
    await bisect.getByRole("button", { name: "Start bisect" }).click();
    await confirm.getByRole("button", { name: "Confirm start" }).click();
    await expect(bisect).toContainText("Candidate range", { timeout: 20_000 });
    await bisect.getByRole("button", { name: "Skip revision" }).click();
    await expect(bisect).toContainText(/Skipped [1-9]/, { timeout: 20_000 });
    page.once("dialog", (dialog) => dialog.dismiss());
    await bisect.getByRole("button", { name: "Reset bisect" }).click();
    await expect(bisect).toContainText(/Skipped [1-9]/);
    page.once("dialog", (dialog) => dialog.accept());
    await bisect.getByRole("button", { name: "Reset bisect" }).click();
    await expect(bisect.getByRole("button", { name: "Start bisect" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /Git：main/ })).toBeVisible({ timeout: 20_000 });

    await bisect.getByRole("button", { name: "Start bisect" }).click();
    await confirm.getByRole("button", { name: "Confirm start" }).click();
    await expect(bisect).toContainText("Candidate range", { timeout: 20_000 });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (await bisect.getByText(/First bad commit/).isVisible().catch(() => false)) break;
      const beforeClassification = (await fixture.git(["rev-parse", "HEAD"])).stdout.trim();
      const subject = (await fixture.git(["log", "-1", "--pretty=%s"])).stdout.trim();
      const action = /bisect [12] good/.test(subject) ? "Mark good" : "Mark bad";
      const classification = bisect.getByRole("button", { name: action });
      await expect(classification).toBeEnabled({ timeout: 20_000 });
      await classification.click();
      await expect.poll(async () => (
        await bisect.getByText(/First bad commit/).isVisible().catch(() => false)
        || (await fixture.git(["rev-parse", "HEAD"])).stdout.trim() !== beforeClassification
      ), { timeout: 20_000 }).toBe(true);
    }
    await expect(bisect).toContainText(`First bad commit ${expectedCulprit}`, { timeout: 20_000 });
    await bisect.getByRole("button", { name: "Open in history" }).click();
    await expect(page.getByRole("tab", { name: "提交历史" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "操作" }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await bisect.getByRole("button", { name: "Reset bisect" }).click();
    await expect.poll(async () => (await fixture.git(["branch", "--show-current"])).stdout.trim(), { timeout: 20_000 }).toBe("main");
    expect((await fixture.git(["rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);
    expect(await fileExists(path.join(fixture.repositoryRoot, ".git", "BISECT_START"))).toBe(false);
    await fixture.screenshot(page, "e2e-066-bisect-lifecycle");
  } finally {
    await fixture.cleanup();
  }
});

async function openGitToolWindow(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: /Git：/ });
  await expect(trigger).toBeEnabled({ timeout: 20_000 });
  await trigger.click();
  await page.getByRole("menuitem", { name: "打开 Git 面板" }).click();
  await expect(page.getByRole("tablist", { name: "Git 面板视图" })).toBeVisible();
}

async function startConflictingRebase(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "操作" }).click();
  const rebase = page.getByRole("region", { name: "Rebase workflow" });
  await rebase.getByRole("combobox", { name: "Rebase upstream" }).fill("main");
  await rebase.getByRole("button", { name: "Preview" }).click();
  await expect(rebase).toContainText("Commits1", { timeout: 20_000 });
  await rebase.getByRole("button", { name: "Rebase", exact: true }).click();
  await rebase.getByRole("alertdialog", { name: "Confirm rebase" }).getByRole("button", { name: "Confirm rebase" }).click();
  await expect(page.getByRole("region", { name: "Recovered Git operation" })).toHaveAttribute("data-state", "conflicted", { timeout: 30_000 });
}

async function resolveCurrentConflict(page: Page, conflictPath: string, side: "ours" | "theirs"): Promise<void> {
  const recovered = page.getByRole("region", { name: "Recovered Git operation" });
  await recovered.getByRole("button", { name: "Resolve conflicts" }).click();
  const conflictDetails = page.getByRole("region", { name: "Conflict details" });
  await expect(conflictDetails).toContainText(conflictPath, { timeout: 20_000 });
  await conflictDetails.getByRole("option", { name: new RegExp(conflictPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  const editor = page.getByRole("region", { name: `Three-way merge editor: ${conflictPath}` });
  const expectedResult = await editor.getByLabel(`${side.toUpperCase()} content`).textContent();
  const actions = page.getByRole("region", { name: "Conflict resolution actions" });
  page.once("dialog", (dialog) => dialog.accept());
  await actions.getByRole("button", { name: side === "ours" ? "Accept ours" : "Accept theirs" }).click();
  await expect(editor.getByRole("textbox", { name: "Merge result" })).toHaveValue(expectedResult ?? "", { timeout: 20_000 });
  await expect(actions.getByRole("button", { name: "Mark resolved and stage" })).toBeEnabled({ timeout: 20_000 });
  await actions.getByRole("button", { name: "Mark resolved and stage" }).click();
  await expect(conflictDetails).toHaveCount(0, { timeout: 20_000 });
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
