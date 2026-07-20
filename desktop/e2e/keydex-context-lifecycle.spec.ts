import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Locator, Page } from "@playwright/test";

import {
  openConversation,
  openWorkbench,
  replaceComposer,
  selectSkill,
  sendAndWait,
} from "./keydex-context-helpers";
import { startKeydexE2EFixture, type KeydexE2EFixture } from "./keydex-e2e-fixtures";

test.describe.configure({ mode: "serial", timeout: 120_000 });

let fixture: KeydexE2EFixture;

test.beforeAll(async () => {
  fixture = await startKeydexE2EFixture("context-lifecycle");
  await fixture.writeSkill("system", "system-demo", "System demo", "SYSTEM-DEMO");
});

test.beforeEach(async () => {
  await fixture.removeSystemKeydexMarkdown();
  await fixture.removeWorkspaceKeydexMarkdown();
  await setCompressionSettings(256_000, 0.8);
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
  await selectSkill(page, input, "system-demo", "KeydexSkillE2E system-demo system");
  const activated = await sendAndWait(page, input, "KeydexSkillE2E system-demo system");
  await expect(activated).toContainText("SYSTEM-DEMO");

  await replaceComposer(input, "/压缩");
  await input.press("Enter");
  await expect(page.getByTestId("context-compression-notice")).toContainText(
    "上下文压缩已完成",
    { timeout: 30_000 },
  );
  const afterCompression = "KeydexContextE2E E30 after compression";
  const answer = await sendAndWait(page, input, afterCompression);
  await expect(answer).toContainText("context_count=1");
  await expect(answer).toContainText("E30-SYSTEM-MD|E30-WORKSPACE-MD");
  const observations = await fixture.api<{
    observations: Array<{ last_user: string; activation_marker: string }>;
  }>("/api/e2e/model-observations");
  const replayedRequest = observations.observations.find(
    (observation) => observation.last_user === afterCompression,
  );
  expect(replayedRequest?.activation_marker).toBe("SYSTEM-DEMO");
  await expect(page.getByText("Keydex E2E", { exact: true })).toHaveCount(0);
  await expect(page.getByText("<keydex-instructions>", { exact: false })).toHaveCount(0);
  await fixture.evidence(page, "E30-context-after-compression");
});

test("E30A mixed rounds restore all selected structured groups in chronology", async ({
  page,
}) => {
  const session = await fixture.createWorkspaceSession("E30A mixed structured groups");
  const input = await openConversation(fixture, page, session);
  await sendAndWait(page, input, "KeydexMixedCompressionE2E ROUND8-DATA");
  await selectSkill(
    page,
    input,
    "system-demo",
    "KeydexMixedCompressionE2E KeydexSkillE2E ROUND9-SKILL system-demo system",
  );
  await sendAndWait(
    page,
    input,
    "KeydexMixedCompressionE2E KeydexSkillE2E ROUND9-SKILL system-demo system",
  );
  await attachReadmeAndSend(
    page,
    input,
    "KeydexMixedCompressionE2E ROUND10-FILE",
  );

  await manualCompress(page, input, "上下文压缩已完成", session.id);
  const compressed = await compressionState(session.id);
  expect(compressed.summary_count).toBe(1);
  expect(compressed.structured_groups).toHaveLength(2);
  expect(compressed.diagnostics.selected_group_ids).toEqual(
    compressed.structured_groups.map((group) => group.group_id),
  );
  expect(compressed.structured_groups[0]?.member_kinds).toContain("skill_activation");
  expect(compressed.structured_groups[1]?.member_kinds).toContain(
    "message_injection_follow",
  );

  const answer = await sendAndWait(
    page,
    input,
    "KeydexInspectCompressionE2E E30A",
    /KeydexInspectCompressionE2E/,
  );
  await expect(answer).toContainText("KeydexMixedCompressionE2E");
  await expect(answer).toContainText("activation=SYSTEM-DEMO");
  await expect(answer).toContainText("compact_summaries=1");
  const materialized = await compressionState(session.id);
  expect(Number(materialized.diagnostics.deferred_replay_actual_tokens)).toBeGreaterThan(0);
  expect(Number(materialized.diagnostics.deferred_replay_delta_tokens)).toBe(
    Number(materialized.diagnostics.deferred_replay_actual_tokens) -
      Number(materialized.diagnostics.deferred_replay_reserve),
  );
  expect(Number(materialized.diagnostics.provider_hard_window_margin)).toBeGreaterThan(0);
  await expect(page.getByText("<keydex_context_compression>", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Keydex E2E compacted", { exact: false })).toHaveCount(0);
});

test("E30B budget keeps rounds nine and ten without authorizing round eight", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const session = await fixture.createWorkspaceSession("E30B filtered structured groups");
  const input = await openConversation(fixture, page, session);
  await sendAndWait(page, input, "KeydexBudgetFilteredE2E ROUND8-DATA");
  await expandStructuredGroup(session.id, 0, 50_000);
  await selectSkill(
    page,
    input,
    "system-demo",
    "KeydexBudgetFilteredE2E KeydexSkillE2E ROUND9-SKILL system-demo system",
  );
  await sendAndWait(
    page,
    input,
    "KeydexBudgetFilteredE2E KeydexSkillE2E ROUND9-SKILL system-demo system",
  );
  await attachReadmeAndSend(
    page,
    input,
    "KeydexBudgetFilteredE2E ROUND10-FILE",
  );
  const beforeCompression = await compressionState(session.id);
  expect(beforeCompression.structured_groups).toHaveLength(3);
  expect(beforeCompression.structured_groups[1]?.member_kinds).toContain("skill_activation");

  await manualCompress(page, input, "上下文压缩已完成", session.id);
  const compressed = await compressionState(session.id);
  expect(
    compressed.structured_groups,
    JSON.stringify(compressed.diagnostics),
  ).toHaveLength(2);
  expect(compressed.structured_groups[0]?.member_kinds).toContain("skill_activation");
  expect(compressed.structured_groups[1]?.member_kinds).toContain(
    "message_injection_follow",
  );
  expect(compressed.diagnostics.selected_group_ids).toEqual(
    compressed.structured_groups.map((group) => group.group_id),
  );
  expect(
    Number(compressed.diagnostics.replacement_actual_tokens) +
      Number(compressed.diagnostics.deferred_replay_reserve),
  ).toBeLessThanOrEqual(20_000);

  const answer = await sendAndWait(
    page,
    input,
    "KeydexInspectCompressionE2E E30B",
    /KeydexInspectCompressionE2E/,
  );
  await expect(answer).toContainText("activation=SYSTEM-DEMO");
  await expect(page.getByText("Keydex E2E compacted", { exact: false })).toHaveCount(0);
});

test("E30C one user turn survives two automatic compactions and keeps recent reads bounded", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await writeFile(
    path.join(fixture.workspaceRoot, "README.md"),
    `# Keydex long task\n${"read-context\n".repeat(600)}`,
    "utf8",
  );
  await setCompressionSettings(10_000, 0.1);
  const session = await fixture.createWorkspaceSession("E30C double automatic compression");
  const input = await openConversation(fixture, page, session);
  const answer = await sendAndWait(
    page,
    input,
    "KeydexLongCompactE2E execute this one long task",
    /KeydexLongCompactE2E completed after two automatic compactions/,
  );
  await expect(answer).toContainText("completed after two automatic compactions");
  await expect
    .poll(async () => (await compressionState(session.id)).context_compression_epoch, {
      timeout: 30_000,
    })
    .toBe(2);
  const observations = await fixture.api<{
    observations: Array<{
      scenario_markers: string[];
      stream: boolean;
      compact_summary_count: number;
    }>;
  }>("/api/e2e/model-observations");
  const modelCalls = observations.observations.filter(
    (item) => item.stream && item.scenario_markers.includes("KeydexLongCompactE2E"),
  );
  expect(modelCalls).toHaveLength(3);
  expect(modelCalls.slice(1).map((item) => item.compact_summary_count)).toEqual([1, 1]);
  await expect(
    page.getByTestId("context-compression-notice").filter({ hasText: "上下文压缩已完成" }),
  ).toHaveCount(2);

  await sendPreparedAndWait(
    page,
    input,
    `Keydex recent read separator ${"z".repeat(8_000)}`,
    /KeydexLongCompactE2E completed/,
  );
  await setCompressionSettings(256_000, 0.8);
  await fixture.api(`/api/sessions/${session.id}/context-compression`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  const recentState = await compressionState(session.id);
  expect(recentState.runtime_attachment_kinds).toContain("recent_read_manifest");
  expect(recentState.runtime_attachment_kinds).toContain("recent_read_snippet");
  expect(
    Number(recentState.diagnostics.replacement_actual_tokens) +
      Number(recentState.diagnostics.deferred_replay_reserve),
  ).toBeLessThanOrEqual(20_000);
});

test("E30D compression retries recover on attempt four and preserve checkpoint after exhaustion", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const retrySession = await fixture.createWorkspaceSession("E30D retry succeeds");
  let input = await openConversation(fixture, page, retrySession);
  await sendAndWait(page, input, "KeydexCompressionRetryE2E history");
  await manualCompress(page, input, "上下文压缩已完成", retrySession.id);
  let counts = await compressionScenarioCounts();
  expect(counts.KeydexCompressionRetryE2E).toBe(4);
  expect((await compressionState(retrySession.id)).context_compression_epoch).toBe(1);

  const failSession = await fixture.createWorkspaceSession("E30D retry exhausted");
  input = await openConversation(fixture, page, failSession);
  await sendAndWait(page, input, "KeydexCompressionFailE2E history");
  const before = await compressionState(failSession.id);
  await manualCompress(page, input, "上下文压缩失败", failSession.id);
  counts = await compressionScenarioCounts();
  expect(counts.KeydexCompressionFailE2E).toBe(4);
  const after = await compressionState(failSession.id);
  expect(after.checkpoint_id).toBe(before.checkpoint_id);
  expect(after.context_compression_epoch).toBe(0);
  const recovery = await sendAndWait(page, input, "KeydexPlainE2E after failed compression");
  await expect(recovery).toContainText("after failed compression");
});

test("E30E Goal continuation uses compacted checkpoint without seed replay", async ({ page }) => {
  test.setTimeout(120_000);
  const session = await fixture.createWorkspaceSession("E30E goal continuation");
  const input = await openConversation(fixture, page, session);
  await sendAndWait(page, input, "KeydexPlainE2E goal history before compression");
  const created = await fixture.api<{ task: { id: string } }>(
    `/api/sessions/${session.id}/tasks`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "goal",
        objective: "KeydexGoalCompactE2E finish after compact",
      }),
    },
  );
  await fixture.api(`/api/sessions/${session.id}/tasks/${created.task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "paused" }),
  });
  await manualCompress(page, input, "上下文压缩已完成", session.id);
  await fixture.api(`/api/sessions/${session.id}/tasks/${created.task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "active" }),
  });
  await expect(
    page.locator("article").filter({
      hasText: "KeydexGoalCompactE2E continuation completed after compression",
    }),
  ).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => {
      const response = await fixture.api<{ list: Array<{ id: string; status: string }> }>(
        `/api/sessions/${session.id}/tasks`,
      );
      return response.list.find((task) => task.id === created.task.id)?.status;
    })
    .toBe("complete");
  const observations = await fixture.api<{
    observations: Array<{ stream: boolean; scenario_markers: string[] }>;
  }>("/api/e2e/model-observations");
  expect(
    observations.observations.filter(
      (item) => item.stream && item.scenario_markers.includes("KeydexGoalCompactE2E"),
    ),
  ).toHaveLength(2);
  await expect(page.getByText("Keydex E2E compacted", { exact: false })).toHaveCount(0);
});

test("E30F soft and mandatory overflow expose budget and hard-window outcomes", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const softSession = await fixture.createWorkspaceSession("E30F soft overflow");
  let input = await openConversation(fixture, page, softSession);
  await sendAndWait(page, input, "KeydexSoftOverflowE2E history");
  await expandStructuredGroup(softSession.id, 0, 41_000);
  await manualCompress(page, input, "上下文压缩已完成", softSession.id);
  const soft = await compressionState(softSession.id);
  const softTotal =
    Number(soft.diagnostics.replacement_actual_tokens) +
    Number(soft.diagnostics.deferred_replay_reserve);
  expect(softTotal).toBeGreaterThan(20_000);
  expect(softTotal).toBeLessThanOrEqual(24_000);
  expect(soft.diagnostics.mandatory_group_overflow).toBe(false);

  await setCompressionSettings(100_000, 0.95);
  const mandatorySession = await fixture.createWorkspaceSession("E30F mandatory overflow");
  input = await openConversation(fixture, page, mandatorySession);
  await sendAndWait(page, input, "KeydexMandatoryOverflowE2E history");
  await expandStructuredGroup(mandatorySession.id, 0, 55_000);
  await manualCompress(page, input, "上下文压缩已完成", mandatorySession.id);
  const success = await compressionState(mandatorySession.id);
  expect(success.diagnostics.mandatory_group_overflow).toBe(true);
  expect(Number(success.diagnostics.replacement_actual_tokens)).toBeGreaterThan(24_000);
  expect(Number(success.diagnostics.provider_hard_window_margin)).toBeGreaterThan(0);
  const successfulEpoch = success.context_compression_epoch;

  await sendAndWait(
    page,
    input,
    "KeydexMandatoryOverflowE2E prepare hard-window failure",
  );
  await expandStructuredGroup(mandatorySession.id, 1, 55_000, "latest_human");
  const beforeFailure = await compressionState(mandatorySession.id);
  await setCompressionSettings(25_000, 0.95);
  await expect(
    fixture.api(`/api/sessions/${mandatorySession.id}/context-compression`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  ).rejects.toThrow(/provider_hard_window_exceeded|context_compression_failed/);
  await page.reload();
  await expect(
    page.getByTestId("context-compression-notice").filter({ hasText: "上下文压缩失败" }),
  ).toBeVisible({ timeout: 30_000 });
  const failure = await compressionState(mandatorySession.id);
  expect(failure.checkpoint_id).toBe(beforeFailure.checkpoint_id);
  expect(failure.context_compression_epoch).toBe(successfulEpoch);
});

test("E30G Workbench Composer restores retained Skill after manual compression", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const session = await fixture.createWorkspaceSession("E30G Workbench compression");
  const input = await openWorkbench(fixture, page, session);
  await sendAndWait(page, input, "KeydexMixedCompressionE2E Workbench history");
  await selectSkill(
    page,
    input,
    "system-demo",
    "KeydexMixedCompressionE2E KeydexSkillE2E Workbench system-demo system",
  );
  await sendAndWait(
    page,
    input,
    "KeydexMixedCompressionE2E KeydexSkillE2E Workbench system-demo system",
  );
  await manualCompress(page, input, "上下文压缩已完成", session.id);
  const answer = await sendAndWait(
    page,
    input,
    "KeydexInspectCompressionE2E E30G Workbench",
    /KeydexInspectCompressionE2E/,
  );
  await expect(answer).toContainText("activation=SYSTEM-DEMO");
  expect((await compressionState(session.id)).summary_count).toBe(1);
  await expect(page.getByText("Keydex E2E compacted", { exact: false })).toHaveCount(0);
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

interface CompressionState {
  checkpoint_id: string | null;
  summary_count: number;
  structured_groups: Array<{
    group_id: string;
    completeness: string;
    member_kinds: string[];
  }>;
  diagnostics: Record<string, unknown>;
  runtime_attachment_kinds: string[];
  context_compression_epoch: number;
  compression_events: Array<{ action: string; data: Record<string, unknown> }>;
}

async function setCompressionSettings(
  contextWindowTokens: number,
  triggerFraction: number,
): Promise<void> {
  const settings = await fixture.api<Record<string, unknown>>("/api/settings/extensions");
  await fixture.api("/api/settings/extensions", {
    method: "PUT",
    body: JSON.stringify({
      ...settings,
      context_compression: {
        enabled: true,
        context_window_tokens: contextWindowTokens,
        trigger_fraction: triggerFraction,
      },
    }),
  });
}

async function compressionState(sessionId: string): Promise<CompressionState> {
  return fixture.api<CompressionState>(`/api/e2e/compression-state/${sessionId}`);
}

async function compressionScenarioCounts(): Promise<Record<string, number>> {
  const response = await fixture.api<{ counts: Record<string, number> }>(
    "/api/e2e/compression-scenario-counts",
  );
  return response.counts;
}

async function expandStructuredGroup(
  sessionId: string,
  index: number,
  extraChars: number,
  messageMode: "matching" | "latest_human" = "matching",
): Promise<void> {
  const response = await fixture.api<{ message_expanded: boolean }>(
    `/api/e2e/expand-structured-group/${sessionId}`,
    {
      method: "POST",
      body: JSON.stringify({
        index,
        extra_chars: extraChars,
        message_mode: messageMode,
      }),
    },
  );
  if (messageMode === "latest_human") {
    expect(response.message_expanded).toBe(true);
  }
}

async function manualCompress(
  page: Page,
  input: Locator,
  expected: "上下文压缩已完成" | "上下文压缩失败",
  debugSessionId?: string,
): Promise<void> {
  const notices = page.getByTestId("context-compression-notice");
  const previousCount = await notices.count();
  await replaceComposer(input, "/压缩");
  await input.press("Enter");
  await expect(notices).toHaveCount(previousCount + 1, { timeout: 30_000 });
  try {
    await expect(notices.last()).toContainText(expected, { timeout: 30_000 });
  } catch (error) {
    if (!debugSessionId) throw error;
    const state = await compressionState(debugSessionId);
    throw new Error(`${String(error)}\ncompression_state=${JSON.stringify(state)}`);
  }
}

async function attachReadmeAndSend(
  page: Page,
  input: Locator,
  message: string,
): Promise<Locator> {
  await replaceComposer(input, `${message} @READ`);
  const option = page.getByRole("option", { name: "选择文件 README.md" });
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click();
  await expect(page.getByLabel("移除文件引用 README.md")).toBeVisible();
  return sendPreparedAndWait(page, input, undefined, /KeydexPlainE2E completed/);
}

async function sendPreparedAndWait(
  page: Page,
  input: Locator,
  message: string | undefined,
  expected: string | RegExp,
): Promise<Locator> {
  if (message !== undefined) {
    await input.fill(message);
  }
  const send = page.getByLabel("发送");
  await expect(send).toBeEnabled();
  await send.click();
  const answer = page.locator("article").filter({ hasText: expected }).last();
  await expect(answer).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("停止")).toHaveCount(0, { timeout: 30_000 });
  return answer;
}

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
