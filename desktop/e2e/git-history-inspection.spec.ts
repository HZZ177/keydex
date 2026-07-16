import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { expect, test, type Page } from "@playwright/test";

import { startGitE2EFixture } from "./git-e2e-fixtures";

const execFileAsync = promisify(execFile);

test("history filters, merge details, compare, blame and reflog match a real DAG", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await startGitE2EFixture("history-inspection");
  try {
    await fixture.createBranch("feature/history", true);
    await fixture.write("src/demo.txt", "first line\nfeature line\n");
    await fixture.commit("feat: add history demo", ["src/demo.txt"]);
    await fixture.git(["switch", "main"]);
    await fixture.write("main.txt", "main side\n");
    await fixture.commit("chore: main side", ["main.txt"]);
    await fixture.git(["merge", "--no-ff", "feature/history", "-m", "merge: history fixture"]);
    const mergeHash = (await fixture.git(["rev-parse", "HEAD"])).stdout.trim();

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "提交历史" }).click();

    const history = page.getByRole("region", { name: "Git history" });
    await expect(history.getByRole("option", { name: /merge: history fixture/ })).toBeVisible({ timeout: 10_000 });
    await expect(history.getByRole("option", { name: /feat: add history demo/ })).toBeVisible();
    await expect(history.getByRole("img", { name: "Merge graph with 2 parents" })).toBeVisible();
    await history.getByRole("option", { name: /merge: history fixture/ }).click();
    const details = page.getByLabel("Commit details");
    await expect(details).toContainText("merge: history fixture", { timeout: 10_000 });
    await expect(details.getByRole("button", { name: /^P[12] / })).toHaveCount(2);
    await expect(details.getByRole("button", { name: "Copy commit hash" })).toBeVisible();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await details.getByRole("button", { name: "Copy commit hash" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(mergeHash);
    await expect(details.getByRole("button", { name: /main/ })).toBeVisible();

    const filters = history.getByRole("form", { name: "History filters" });
    await filters.getByRole("textbox", { name: "Message or commit hash" }).fill("feat: add history demo");
    await filters.getByRole("button", { name: "Apply" }).click();
    await expect(history.getByRole("option", { name: /feat: add history demo/ })).toBeVisible({ timeout: 10_000 });
    await expect(history.getByRole("option", { name: /merge: history fixture/ })).toHaveCount(0);
    await filters.getByRole("button", { name: "Clear" }).click();
    await expect(history.getByRole("option", { name: /merge: history fixture/ })).toBeVisible({ timeout: 10_000 });
    await filters.getByRole("combobox", { name: "Revision" }).fill("HEAD~1..HEAD");
    await filters.getByRole("button", { name: "Apply" }).click();
    await expect(history.getByRole("option", { name: /merge: history fixture/ })).toBeVisible({ timeout: 10_000 });
    await expect(history.getByRole("option")).toHaveCount(2);
    await filters.getByRole("combobox", { name: "Revision" }).fill("-bad");
    await filters.getByRole("button", { name: "Apply" }).click();
    await expect(filters.getByRole("alert")).toContainText("valid Git revision");
    await expect(history.getByRole("option")).toHaveCount(2);
    await filters.getByRole("button", { name: "Clear" }).click();
    await expect(history.getByRole("option", { name: /merge: history fixture/ })).toBeVisible({ timeout: 10_000 });
    await history.getByRole("option", { name: /merge: history fixture/ }).click();

    const compare = page.getByRole("region", { name: "Compare revisions" });
    await expect(compare.getByRole("button", { name: "Compare" })).toBeEnabled({ timeout: 10_000 });
    await compare.getByRole("button", { name: "Compare" }).click();
    await expect(compare.getByRole("list", { name: "Compared files" })).toContainText(/main\.txt|src\/demo\.txt/, { timeout: 10_000 });

    await page.getByRole("tab", { name: "Blame" }).click();
    const blame = page.getByRole("region", { name: "Git blame" });
    await blame.getByRole("textbox", { name: "File path" }).fill("src/demo.txt");
    await blame.getByRole("button", { name: "Blame" }).click();
    await expect(blame.getByRole("table", { name: "Blame lines" })).toContainText("feature line", { timeout: 10_000 });

    await page.getByRole("tab", { name: "Reflog" }).click();
    const reflog = page.getByRole("region", { name: "Git reflog" });
    await reflog.getByRole("button", { name: "Load", exact: true }).click();
    await expect(reflog.getByRole("listbox", { name: "Reflog entries" })).toContainText("merge", { timeout: 10_000 });
    await reflog.getByRole("textbox", { name: "New branch" }).fill("recovery/e2e");
    await reflog.getByRole("button", { name: "Create branch" }).click();
    await expect.poll(async () => (await fixture.git(["branch", "--list", "recovery/e2e"])).stdout.trim()).toContain("recovery/e2e");

    await page.getByRole("tab", { name: "提交历史" }).click();
    await history.getByRole("option", { name: /merge: history fixture/ }).click();
    await details.getByRole("button", { name: /main/ }).click();
    await expect(page.getByRole("tab", { name: "分支" })).toHaveAttribute("aria-selected", "true");
    const refsTree = page.getByRole("tree", { name: "Repository refs" });
    const currentRef = refsTree.locator('[role="treeitem"][aria-current="true"]');
    const selectedRef = refsTree.locator('[role="treeitem"][aria-selected="true"]');
    await expect(currentRef).toContainText("recovery/e2e", { timeout: 20_000 });
    await expect(selectedRef).toContainText("main", { timeout: 20_000 });
    await fixture.screenshot(page, "e2e-055-history-compare-blame-reflog");
  } finally {
    await fixture.cleanup();
  }
});

test("history combines message, author, branch, date and path filters and rejects an unsafe revision", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await startGitE2EFixture("history-combined-filters");
  try {
    await fixture.createBranch("feature/filters", true);
    await fixture.write("src/alice.txt", "alice path\n");
    await fixture.git(["add", "--", "src/alice.txt"]);
    await fixture.git(["-c", "user.name=Alice Filter", "-c", "user.email=alice@example.invalid", "commit", "-m", "feat: alice unique filter"]);
    await fixture.write("src/bob.txt", "bob path\n");
    await fixture.git(["add", "--", "src/bob.txt"]);
    await fixture.git(["-c", "user.name=Bob Filter", "-c", "user.email=bob@example.invalid", "commit", "-m", "feat: bob other filter"]);
    await fixture.git(["switch", "main"]);
    await fixture.write("main-filter.txt", "main path\n");
    await fixture.commit("chore: main filter fixture", ["main-filter.txt"]);

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "提交历史" }).click();
    const history = page.getByRole("region", { name: "Git history" });
    const filters = history.getByRole("form", { name: "History filters" });
    await filters.getByRole("textbox", { name: "Message or commit hash" }).fill("alice unique");
    await filters.getByRole("textbox", { name: "Author" }).fill("Alice Filter");
    await filters.getByRole("combobox", { name: "Revision" }).fill("feature/filters");
    await filters.getByRole("textbox", { name: "Path" }).fill("src/alice.txt");
    await filters.getByRole("button", { name: "Apply" }).click();
    await expect(history.getByRole("option", { name: /feat: alice unique filter/ })).toBeVisible({ timeout: 15_000 });
    await expect(history.getByRole("option")).toHaveCount(1);

    await filters.getByLabel("Since").fill("2099-01-01");
    await filters.getByRole("button", { name: "Apply" }).click();
    await expect(history.getByRole("status")).toContainText("No commits match", { timeout: 15_000 });
    await filters.getByRole("button", { name: "Clear" }).click();
    await expect(history).toContainText("4 loaded commit(s)", { timeout: 15_000 });
    await expect(history.getByRole("option", { name: /chore: main filter fixture/ })).toBeVisible();

    await filters.getByRole("combobox", { name: "Revision" }).fill("-unsafe");
    await filters.getByRole("button", { name: "Apply" }).click();
    await expect(filters.getByRole("alert")).toContainText("valid Git revision");
    await expect(history).toContainText("4 loaded commit(s)");
    await fixture.screenshot(page, "e2e-048-combined-history-filters");
  } finally {
    await fixture.cleanup();
  }
});

test("commit details distinguish valid, invalid and unsigned signatures and keep refs aligned with the copied oid", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await startGitE2EFixture("history-signature-states");
  try {
    const privateKey = path.join(fixture.runDir, "signature-key");
    const allowedSigners = path.join(fixture.runDir, "allowed-signers");
    await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", privateKey], { windowsHide: true });
    const publicKey = (await readFile(`${privateKey}.pub`, "utf8")).trim();
    await writeFile(allowedSigners, `keydex-git-e2e@example.invalid ${publicKey}\n`, "utf8");
    await fixture.git(["config", "gpg.format", "ssh"]);
    await fixture.git(["config", "user.signingkey", privateKey]);
    await fixture.git(["config", "gpg.ssh.allowedSignersFile", allowedSigners]);
    await fixture.git(["commit", "--allow-empty", "-S", "-m", "test: valid signed commit"]);
    const validOid = (await fixture.git(["rev-parse", "HEAD"])).stdout.trim();
    const signedObject = (await fixture.git(["cat-file", "commit", validOid])).stdout;
    const invalidObjectPath = path.join(fixture.repositoryRoot, ".invalid-signed-commit");
    await writeFile(invalidObjectPath, signedObject.replace("test: valid signed commit", "test: invalid signed commit"), "utf8");
    const invalidOid = (await fixture.git(["hash-object", "-t", "commit", "-w", invalidObjectPath])).stdout.trim();
    await fixture.git(["update-ref", "refs/heads/signature-invalid", invalidOid]);
    await rm(invalidObjectPath);

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "提交历史" }).click();
    const history = page.getByRole("region", { name: "Git history" });
    const details = page.getByLabel("Commit details");
    await history.getByRole("option", { name: /test: valid signed commit/ }).click();
    await expect(details).toContainText("Signaturevalid", { timeout: 15_000 });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await details.getByRole("button", { name: "Copy commit hash" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(validOid);
    await expect(details.getByRole("button", { name: /main/ })).toBeVisible();

    await history.getByRole("option", { name: /test: invalid signed commit/ }).click();
    await expect(details).toContainText("Signatureinvalid", { timeout: 15_000 });
    await expect(details).toContainText(invalidOid);
    await history.getByRole("option", { name: /e2e: initial commit/ }).click();
    await expect(details).toContainText("Signatureunsigned", { timeout: 15_000 });
    await expect(page.getByTestId("git-tool-window")).not.toContainText("OPENSSH PRIVATE KEY");
    await fixture.screenshot(page, "e2e-051-signature-ref-states");
  } finally {
    await fixture.cleanup();
  }
});

test("history pagination and range rename diff retain exact counts and both diff modes", async ({ page }) => {
  test.setTimeout(180_000);
  const fixture = await startGitE2EFixture("history-pagination-range");
  try {
    await fixture.write("old-name.txt", "rename me\n");
    await fixture.write("other.txt", "before\n");
    const left = await fixture.commit("test: range baseline", ["old-name.txt", "other.txt"]);
    await fixture.git(["mv", "old-name.txt", "new-name.txt"]);
    await fixture.write("other.txt", "after\n");
    const right = await fixture.commit("test: range rename", ["new-name.txt", "other.txt"]);
    for (let index = 1; index <= 203; index += 1) {
      await fixture.git(["commit", "--allow-empty", "-m", `test: pagination ${String(index).padStart(3, "0")}`]);
    }

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "提交历史" }).click();
    const history = page.getByRole("region", { name: "Git history" });
    await expect(history).toContainText("200 loaded commit(s)", { timeout: 20_000 });
    await history.getByRole("button", { name: "Load older commits" }).click();
    await expect(history).toContainText("206 loaded commit(s)", { timeout: 20_000 });
    const historyScroller = history.getByRole("listbox", { name: "Commit history" });
    await historyScroller.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll")); });
    await expect(history.getByRole("option", { name: /e2e: initial commit/ })).toBeVisible({ timeout: 10_000 });

    const compare = page.getByRole("region", { name: "Compare revisions" });
    await compare.getByRole("combobox", { name: "Mode" }).selectOption("two_dot");
    await compare.getByRole("combobox", { name: "Left (A)" }).fill(left);
    await compare.getByRole("combobox", { name: "Right (B)" }).fill(right);
    await compare.getByRole("button", { name: "Compare", exact: true }).click();
    const files = compare.getByRole("list", { name: "Compared files" });
    await expect(files).toContainText("new-name.txt", { timeout: 15_000 });
    await expect(files).toContainText("other.txt");
    await expect(compare).toContainText("2 file(s)");
    await files.getByRole("button", { name: /new-name\.txt/ }).click();
    const display = page.getByRole("group", { name: "Diff 显示方式" });
    await display.getByRole("button", { name: "统一 Diff" }).click();
    await expect(page.getByRole("table", { name: "统一 Diff 内容" })).toBeVisible();
    await display.getByRole("button", { name: "并排 Diff" }).click();
    await expect(page.getByRole("table", { name: "并排 Diff 内容" })).toBeVisible();
    await expect(page.getByTestId("git-tool-window")).toContainText("new-name.txt");
    await fixture.screenshot(page, "e2e-053-pagination-range-rename");
  } finally {
    await fixture.cleanup();
  }
});

async function openGitToolWindow(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: /Git：main/ });
  await expect(trigger).toBeEnabled({ timeout: 10_000 });
  await trigger.click();
  await page.getByRole("menuitem", { name: "打开 Git 面板" }).click();
  await expect(page.getByRole("tablist", { name: "Git 面板视图" })).toBeVisible();
}
