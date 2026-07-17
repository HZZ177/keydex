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
    await openAdvancedGitView(page);

    const merge = page.getByRole("region", { name: "合并流程" });
    await merge.getByRole("combobox", { name: "来源分支或修订" }).fill("feature/conflict");
    await merge.getByRole("button", { name: "预览" }).click();
    await expect(merge).toContainText("需要创建合并提交", { timeout: 10_000 });
    await merge.getByRole("button", { name: "合并", exact: true }).click();
    await page.getByRole("dialog", { name: "确认合并" }).getByRole("button", { name: "确认合并" }).click();
    await expect(page.getByRole("region", { name: "已恢复的 Git 操作" })).toContainText("存在冲突", { timeout: 15_000 });
    expect((await fixture.git(["diff", "--name-only", "--diff-filter=U"])).stdout.trim()).toBe("conflict.txt");

    await page.getByRole("button", { name: "解决冲突" }).click();
    const conflictDetails = page.getByRole("region", { name: "冲突详情" });
    await expect(conflictDetails).toContainText("conflict.txt", { timeout: 10_000 });
    await conflictDetails.getByRole("option", { name: /conflict\.txt/ }).click();
    const conflictActions = page.getByRole("region", { name: "冲突解决操作" });
    await conflictActions.getByRole("button", { name: "采用当前分支版本" }).click();
    await page.getByRole("dialog", { name: "确认采用当前分支版本" }).getByRole("button", { name: "确认采用当前分支版本" }).click();
    expect((await fixture.git(["diff", "--name-only", "--diff-filter=U"])).stdout.trim()).toBe("conflict.txt");
    await expect(conflictActions.getByRole("button", { name: "标记为已解决并暂存" })).toBeEnabled({ timeout: 10_000 });
    await conflictActions.getByRole("button", { name: "标记为已解决并暂存" }).click();
    await expect.poll(async () => (await fixture.git(["diff", "--name-only", "--diff-filter=U"])).stdout.trim()).toBe("");
    expect((await fixture.git(["show", ":conflict.txt"])).stdout.trim()).toBe("ours");

    const editor = page.getByRole("region", { name: "提交编辑器" });
    await expect(editor).toContainText("0 个已选择文件", { timeout: 10_000 });
    await editor.getByRole("textbox", { name: "提交说明" }).fill("merge: resolve feature conflict");
    await expect(editor.getByRole("button", { name: "提交", exact: true })).toBeEnabled({ timeout: 10_000 });
    await editor.getByRole("button", { name: "提交", exact: true }).click();
    await expect.poll(async () => (await fixture.git(["log", "-1", "--pretty=%s"])).stdout.trim(), { timeout: 15_000 }).toBe("merge: resolve feature conflict");
    expect((await fixture.git(["show", "-s", "--pretty=%P", "HEAD"])).stdout.trim().split(/\s+/)).toHaveLength(2);

    await openAdvancedGitView(page);
    const patchExchange = page.getByRole("region", { name: "补丁导入与导出" });
    await patchExchange.getByRole("combobox", { name: "补丁导出方式" }).selectOption("commit");
    await patchExchange.getByRole("textbox", { name: "补丁左侧修订" }).fill("HEAD");
    await patchExchange.getByRole("button", { name: "生成补丁" }).click();
    await expect(patchExchange.getByRole("textbox", { name: "已导出的补丁" })).toContainText("diff --git", { timeout: 10_000 });

    const reset = page.getByRole("region", { name: "重置与还原" });
    await reset.getByRole("textbox", { name: "重置目标" }).fill("HEAD~2");
    await reset.getByRole("combobox", { name: "重置模式" }).selectOption("mixed");
    await reset.getByRole("button", { name: "预览重置" }).click();
    await expect(reset.getByRole("list", { name: "重置影响的文件" })).toContainText("conflict.txt", { timeout: 10_000 });
    await expect(reset).toContainText("重写历史");
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
    await openAdvancedGitView(page);
    const reset = page.getByRole("region", { name: "重置与还原" });
    await reset.getByRole("textbox", { name: "要还原的路径" }).fill("a.txt");
    await reset.getByRole("textbox", { name: "还原来源" }).fill("HEAD");
    await reset.getByRole("combobox", { name: "还原目标位置" }).selectOption("worktree");
    await reset.getByRole("button", { name: "还原所选路径" }).click();
    const restoreDialog = page.getByRole("dialog", { name: "确认还原路径" });
    await expect(restoreDialog).toContainText("a.txt");
    await restoreDialog.getByRole("button", { name: "取消" }).click();
    expect((await fixture.git(["show", ":a.txt"])).stdout.trim()).toBe("a base");
    expect((await fixture.git(["diff", "--", "a.txt"])).stdout).toContain("a local");
    expect((await fixture.git(["diff", "--", "b.txt"])).stdout).toContain("b local");

    await reset.getByRole("button", { name: "还原所选路径" }).click();
    await restoreDialog.getByRole("button", { name: "确认还原" }).click();
    await expect(reset).toContainText("还原成功", { timeout: 20_000 });
    await expect.poll(async () => (await fixture.git(["diff", "--", "a.txt"])).stdout.trim(), { timeout: 15_000 }).toBe("");
    expect((await fixture.git(["diff", "--", "b.txt"])).stdout).toContain("b local");

    await reset.getByRole("textbox", { name: "重置目标" }).fill("HEAD~1");
    await reset.getByRole("combobox", { name: "重置模式" }).selectOption("hard");
    await reset.getByRole("button", { name: "预览重置" }).click();
    await expect(reset).toContainText("破坏性操作", { timeout: 10_000 });
    await reset.getByRole("button", { name: "重置到目标" }).click();
    await page.getByRole("dialog", { name: "确认重置分支" }).getByRole("button", { name: "取消" }).click();
    expect((await fixture.git(["rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);

    await reset.getByRole("button", { name: "重置到目标" }).click();
    await page.getByRole("dialog", { name: "确认重置分支" }).getByRole("button", { name: "确认重置" }).click();
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
    await openAdvancedGitView(page);
    const rebase = page.getByRole("region", { name: "变基流程" });
    await rebase.getByRole("combobox", { name: "变基上游修订" }).fill("main");
    await rebase.getByRole("checkbox", { name: "编辑交互式任务列表" }).check();
    await rebase.getByRole("button", { name: "预览" }).click();
    const todo = rebase.getByRole("list", { name: "交互式变基任务列表" });
    await expect(todo.getByRole("listitem")).toHaveCount(2, { timeout: 15_000 });
    const firstAction = todo.getByRole("combobox").nth(0);
    await firstAction.selectOption("squash");
    await expect(rebase.getByRole("alert")).toContainText("压缩合并前必须有一个未丢弃的提交");
    await firstAction.selectOption("pick");
    const secondAction = todo.getByRole("combobox").nth(1);
    await secondAction.selectOption("reword");
    await todo.getByRole("textbox", { name: /feat: rebase second 的新提交说明/ }).fill("feat: rebase second rewritten");

    await rebase.getByRole("button", { name: "变基", exact: true }).click();
    const confirmRebase = page.getByRole("dialog", { name: "确认变基" });
    await expect(confirmRebase).toContainText("模式：交互式");
    await expect(confirmRebase).toContainText("feat: rebase second");
    await confirmRebase.getByRole("button", { name: "取消" }).click();
    expect((await fixture.git(["rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);
    await rebase.getByRole("button", { name: "变基", exact: true }).click();
    await confirmRebase.getByRole("button", { name: "确认变基" }).click();
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
    await openAdvancedGitView(page);
    const cherry = page.getByRole("region", { name: "摘取提交流程" });
    await cherry.getByRole("textbox", { name: "要摘取的提交" }).fill([first, empty, third].join("\n"));
    await cherry.getByRole("checkbox", { name: "附加来源信息（-x）" }).check();
    await cherry.getByRole("button", { name: "摘取提交" }).click();
    await page.getByRole("dialog", { name: "确认摘取提交" }).getByRole("button", { name: "确认摘取" }).click();
    await expect(cherry.getByRole("status")).toContainText(/可以继续|存在冲突/, { timeout: 30_000 });
    const queue = cherry.getByRole("list", { name: "摘取提交结果队列" });
    await expect(queue.getByText(empty.slice(0, 12)).locator("..")).toHaveAttribute("data-state", "empty");
    await cherry.getByRole("button", { name: "跳过" }).click();
    const skipDialog = page.getByRole("dialog", { name: "确认跳过当前提交" });
    await expect(skipDialog).toContainText("其余提交继续执行");
    await skipDialog.getByRole("button", { name: "确认跳过" }).click();
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
    await expect(page.getByRole("region", { name: "已恢复的 Git 操作" })).toHaveAttribute("data-kind", "rebase", { timeout: 30_000 });
    await expect(page.getByRole("region", { name: "已恢复的 Git 操作" })).toHaveAttribute("data-state", "conflicted");
    expect((await fixture.git(["diff", "--name-only", "--diff-filter=U"])).stdout.trim()).toBe("rebase-conflict.txt");

    await page.reload();
    await openGitToolWindow(page);
    await openAdvancedGitView(page);
    const recovered = page.getByRole("region", { name: "已恢复的 Git 操作" });
    await expect(recovered).toHaveAttribute("data-kind", "rebase", { timeout: 30_000 });
    await expect(recovered).toContainText("存在冲突");
    await recovered.getByRole("button", { name: "中止", exact: true }).click();
    const abortDialog = page.getByRole("dialog", { name: "确认中止变基" });
    await abortDialog.getByRole("button", { name: "确认中止" }).click();
    await expect.poll(async () => (await fixture.git(["rev-parse", "HEAD"])).stdout.trim(), { timeout: 30_000 }).toBe(originalHead);
    await expect.poll(async () => await fileExists(path.join(fixture.repositoryRoot, ".git", "rebase-merge")), { timeout: 30_000 }).toBe(false);

    await startConflictingRebase(page);
    await resolveCurrentConflict(page, "rebase-conflict.txt", "theirs");
    await openAdvancedGitView(page);
    const rebase = page.getByRole("region", { name: "变基流程" });
    await expect(rebase.getByRole("button", { name: "继续", exact: true })).toBeEnabled({ timeout: 20_000 });
    await rebase.getByRole("button", { name: "继续", exact: true }).click();
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
    await openAdvancedGitView(page);
    const cherry = page.getByRole("region", { name: "摘取提交流程" });
    const commits = cherry.getByRole("textbox", { name: "要摘取的提交" });
    await commits.fill([conflictOne, tailOne].join("\n"));
    await cherry.getByRole("button", { name: "摘取提交" }).click();
    await page.getByRole("dialog", { name: "确认摘取提交" }).getByRole("button", { name: "确认摘取" }).click();
    await expect(cherry.getByRole("status")).toContainText("存在冲突", { timeout: 30_000 });
    await cherry.getByRole("button", { name: "中止", exact: true }).click();
    await page.getByRole("dialog", { name: "确认中止摘取提交" }).getByRole("button", { name: "确认中止" }).click();
    await expect.poll(async () => (await fixture.git(["rev-parse", "HEAD"])).stdout.trim(), { timeout: 30_000 }).toBe(originalHead);
    await expect.poll(async () => await fileExists(path.join(fixture.repositoryRoot, ".git", "CHERRY_PICK_HEAD")), { timeout: 30_000 }).toBe(false);

    await cherry.getByRole("button", { name: "摘取提交" }).click();
    await page.getByRole("dialog", { name: "确认摘取提交" }).getByRole("button", { name: "确认摘取" }).click();
    await expect(cherry.getByRole("status")).toContainText("存在冲突", { timeout: 30_000 });
    await cherry.getByRole("button", { name: "跳过", exact: true }).click();
    await page.getByRole("dialog", { name: "确认跳过当前提交" }).getByRole("button", { name: "确认跳过" }).click();
    await expect.poll(async () => (await fixture.git(["log", "-1", "--pretty=%s"])).stdout.trim(), { timeout: 30_000 }).toBe("feat: cherry tail one");
    await expect.poll(async () => (await fixture.git(["status", "--porcelain=v1"])).stdout.trim(), { timeout: 30_000 }).toBe("");
    await expect(cherry.getByRole("list", { name: "摘取提交结果队列" }).getByText(conflictOne.slice(0, 12)).locator("..")).toHaveAttribute("data-state", "empty");

    await page.reload();
    await openGitToolWindow(page);
    await openAdvancedGitView(page);
    await commits.fill([conflictTwo, tailTwo].join("\n"));
    await cherry.getByRole("button", { name: "摘取提交" }).click();
    await page.getByRole("dialog", { name: "确认摘取提交" }).getByRole("button", { name: "确认摘取" }).click();
    await expect(cherry.getByRole("status")).toContainText("存在冲突", { timeout: 30_000 });
    await resolveCurrentConflict(page, "cherry-conflict.txt", "theirs");
    await openAdvancedGitView(page);
    await expect(cherry.getByRole("button", { name: "继续", exact: true })).toBeEnabled({ timeout: 20_000 });
    await cherry.getByRole("button", { name: "继续", exact: true }).click();
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
    await openAdvancedGitView(page);
    const revert = page.getByRole("region", { name: "反向提交处理流程" });
    await revert.getByRole("textbox", { name: "要撤销的提交" }).fill(target);
    await revert.getByRole("button", { name: "创建反向提交" }).click();
    await page.getByRole("dialog", { name: "确认创建反向提交" }).getByRole("button", { name: "确认创建" }).click();
    await expect(revert.getByRole("status")).toContainText("存在冲突", { timeout: 30_000 });
    await revert.getByRole("button", { name: "中止" }).click();
    await page.getByRole("dialog", { name: "确认中止反向提交" }).getByRole("button", { name: "确认中止" }).click();
    await expect.poll(async () => (await fixture.git(["rev-parse", "HEAD"])).stdout.trim(), { timeout: 30_000 }).toBe(originalHead);
    await expect.poll(async () => await fileExists(path.join(fixture.repositoryRoot, ".git", "REVERT_HEAD")), { timeout: 30_000 }).toBe(false);

    await page.reload();
    await openGitToolWindow(page);
    await openAdvancedGitView(page);
    await revert.getByRole("textbox", { name: "要撤销的提交" }).fill(target);
    await expect(revert.getByRole("button", { name: "创建反向提交" })).toBeEnabled({ timeout: 20_000 });
    await revert.getByRole("button", { name: "创建反向提交" }).click();
    await page.getByRole("dialog", { name: "确认创建反向提交" }).getByRole("button", { name: "确认创建" }).click();
    await expect(revert.getByRole("status")).toContainText("存在冲突", { timeout: 30_000 });
    await resolveCurrentConflict(page, "revert-conflict.txt", "theirs");
    await openAdvancedGitView(page);
    await expect(revert.getByRole("button", { name: "继续" })).toBeEnabled({ timeout: 20_000 });
    await revert.getByRole("button", { name: "继续" }).click();
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
    await openAdvancedGitView(page);
    const bisect = page.getByRole("region", { name: "Git 二分定位助手" });
    await bisect.getByRole("combobox", { name: "已知正常修订" }).fill("HEAD~4");
    await bisect.getByRole("combobox", { name: "已知异常修订" }).fill("HEAD");
    await bisect.getByRole("button", { name: "开始二分定位" }).click();
    const confirm = page.getByRole("dialog", { name: "确认开始二分定位" });
    await confirm.getByRole("button", { name: "取消" }).click();
    expect((await fixture.git(["branch", "--show-current"])).stdout.trim()).toBe("main");
    await bisect.getByRole("button", { name: "开始二分定位" }).click();
    await confirm.getByRole("button", { name: "确认开始" }).click();
    await expect(bisect).toContainText("候选范围", { timeout: 20_000 });
    await bisect.getByRole("button", { name: "跳过此修订" }).click();
    await expect(bisect).toContainText(/已跳过 [1-9]/, { timeout: 20_000 });
    await bisect.getByRole("button", { name: "结束二分定位" }).click();
    await page.getByRole("dialog", { name: "确认结束二分定位" }).getByRole("button", { name: "取消" }).click();
    await expect(bisect).toContainText(/已跳过 [1-9]/);
    await bisect.getByRole("button", { name: "结束二分定位" }).click();
    await page.getByRole("dialog", { name: "确认结束二分定位" }).getByRole("button", { name: "确认结束" }).click();
    await expect(bisect.getByRole("button", { name: "开始二分定位" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /Git：main/ })).toBeVisible({ timeout: 20_000 });

    await bisect.getByRole("button", { name: "开始二分定位" }).click();
    await confirm.getByRole("button", { name: "确认开始" }).click();
    await expect(bisect).toContainText("候选范围", { timeout: 20_000 });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (await bisect.getByText(/首个异常提交/).isVisible().catch(() => false)) break;
      const beforeClassification = (await fixture.git(["rev-parse", "HEAD"])).stdout.trim();
      const subject = (await fixture.git(["log", "-1", "--pretty=%s"])).stdout.trim();
      const action = /bisect [12] good/.test(subject) ? "标记为正常" : "标记为异常";
      const classification = bisect.getByRole("button", { name: action });
      await expect(classification).toBeEnabled({ timeout: 20_000 });
      await classification.click();
      await expect.poll(async () => (
        await bisect.getByText(/首个异常提交/).isVisible().catch(() => false)
        || (await fixture.git(["rev-parse", "HEAD"])).stdout.trim() !== beforeClassification
      ), { timeout: 20_000 }).toBe(true);
    }
    await expect(bisect).toContainText(`首个异常提交 ${expectedCulprit}`, { timeout: 20_000 });
    await bisect.getByRole("button", { name: "在日志中打开" }).click();
    await expect(page.getByRole("tab", { name: "Git 日志" })).toHaveAttribute("aria-selected", "true");
    await openAdvancedGitView(page);
    await bisect.getByRole("button", { name: "结束二分定位" }).click();
    await page.getByRole("dialog", { name: "确认结束二分定位" }).getByRole("button", { name: "确认结束" }).click();
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

async function openAdvancedGitView(page: Page): Promise<void> {
  await page.getByRole("button", { name: "更多 Git 视图" }).click();
  await page.getByRole("menuitem", { name: /高级 Git 工具/ }).click();
  await expect(page.getByRole("region", { name: "合并流程" })).toBeVisible();
}

async function startConflictingRebase(page: Page): Promise<void> {
  await openAdvancedGitView(page);
  const rebase = page.getByRole("region", { name: "变基流程" });
  await rebase.getByRole("combobox", { name: "变基上游修订" }).fill("main");
  await rebase.getByRole("button", { name: "预览" }).click();
  await expect(rebase).toContainText("提交数1", { timeout: 20_000 });
  await rebase.getByRole("button", { name: "变基", exact: true }).click();
  await page.getByRole("dialog", { name: "确认变基" }).getByRole("button", { name: "确认变基" }).click();
  await expect(page.getByRole("region", { name: "已恢复的 Git 操作" })).toHaveAttribute("data-state", "conflicted", { timeout: 30_000 });
}

async function resolveCurrentConflict(page: Page, conflictPath: string, side: "ours" | "theirs"): Promise<void> {
  const recovered = page.getByRole("region", { name: "已恢复的 Git 操作" });
  await recovered.getByRole("button", { name: "解决冲突" }).click();
  const conflictDetails = page.getByRole("region", { name: "冲突详情" });
  await expect(conflictDetails).toContainText(conflictPath, { timeout: 20_000 });
  await conflictDetails.getByRole("option", { name: new RegExp(conflictPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  const editor = page.getByRole("region", { name: `三方合并编辑器：${conflictPath}` });
  const expectedResult = await editor.getByLabel(side === "ours" ? "当前分支内容" : "传入版本内容").textContent();
  const actions = page.getByRole("region", { name: "冲突解决操作" });
  const actionLabel = side === "ours" ? "采用当前分支版本" : "采用传入版本";
  await actions.getByRole("button", { name: actionLabel }).click();
  await page.getByRole("dialog", { name: `确认${actionLabel}` }).getByRole("button", { name: `确认${actionLabel}` }).click();
  await expect(editor.getByRole("textbox", { name: "合并结果" })).toHaveValue(expectedResult ?? "", { timeout: 20_000 });
  await expect(actions.getByRole("button", { name: "标记为已解决并暂存" })).toBeEnabled({ timeout: 20_000 });
  await actions.getByRole("button", { name: "标记为已解决并暂存" }).click();
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
