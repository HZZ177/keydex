import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseCsv } from "./diff-plan-audit.mjs";

export const ALIGNED_DIFF_ISSUE_COUNT = 42;
export const ALIGNED_DIFF_ISSUE_IDS = Object.freeze(
  Array.from(
    { length: ALIGNED_DIFF_ISSUE_COUNT },
    (_, index) => `ASD-${String(index + 1).padStart(3, "0")}`,
  ),
);

const DEV_STATES = new Set(["未开始", "进行中", "已完成"]);
const TEST_STATES = new Set(["未开始", "进行中", "已完成", "失败"]);
const COMPLETE_STATE = "已完成";

export function auditAlignedDiffPlan(csvText, planText, { requireComplete = true } = {}) {
  const rows = parseCsv(csvText);
  const header = rows.shift() ?? [];
  const expectedHeader = ["id", "priority", "title", "refs", "dev_state", "test_state", "owner", "notes"];
  const violations = [];
  if (JSON.stringify(header) !== JSON.stringify(expectedHeader)) {
    violations.push({ code: "csv_header", actual: header, expected: expectedHeader });
  }

  const ids = rows.map((row) => row[0]);
  if (rows.length !== ALIGNED_DIFF_ISSUE_COUNT) {
    violations.push({ code: "issue_count", actual: rows.length, expected: ALIGNED_DIFF_ISSUE_COUNT });
  }
  if (JSON.stringify(ids) !== JSON.stringify(ALIGNED_DIFF_ISSUE_IDS)) {
    violations.push({ code: "issue_ids", actual: ids, expected: ALIGNED_DIFF_ISSUE_IDS });
  }

  const planLines = planText
    .split(/\r?\n/u)
    .filter((line) => /^\| \*\*ASD-\d{3} \/ P[01] \/ /u.test(line));
  const planById = new Map(planLines.map((line) => [line.match(/ASD-\d{3}/u)?.[0], line]));
  for (const row of rows) {
    const [id, priority, title, refs, devState, testState, owner, notes] = row;
    if (row.length !== expectedHeader.length) violations.push({ code: "column_count", id, actual: row.length });
    if (!/^P[01]$/u.test(priority ?? "")) violations.push({ code: "priority", id, actual: priority });
    if (!(title ?? "").trim()) violations.push({ code: "title", id });
    if (!/^D:.+; C:.+/u.test(refs ?? "")) violations.push({ code: "refs", id, actual: refs });
    const planLine = planById.get(id);
    if (!planLine) violations.push({ code: "plan_mapping", id });
    else for (const layer of ["U:", "F:", "E:"]) {
      if (!planLine.includes(layer)) violations.push({ code: "test_layer", id, layer });
    }
    if (!DEV_STATES.has(devState ?? "")) {
      violations.push({ code: "dev_state_enum", id, actual: devState });
    }
    if (!TEST_STATES.has(testState ?? "")) {
      violations.push({ code: "test_state_enum", id, actual: testState });
    }
    if (requireComplete && devState !== COMPLETE_STATE) {
      violations.push({ code: "dev_state", id, actual: devState });
    }
    if (requireComplete && testState !== COMPLETE_STATE) {
      violations.push({ code: "test_state", id, actual: testState });
    }
    if (!(owner ?? "").trim()) violations.push({ code: "owner", id });
    if (!(notes ?? "").trim()) violations.push({ code: "evidence", id });
    if (devState === COMPLETE_STATE && testState === COMPLETE_STATE && !/done_at:\d{4}-\d{2}-\d{2}/u.test(notes ?? "")) {
      violations.push({ code: "completion_evidence", id });
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    issues: rows.length,
    planContracts: planById.size,
    completedDevelopment: rows.filter((row) => row[4] === COMPLETE_STATE).length,
    completedTesting: rows.filter((row) => row[5] === COMPLETE_STATE).length,
    violations: Object.freeze(violations),
  });
}

const directExecution = process.argv[1]
  && resolve(process.argv[1]) === resolve(import.meta.filename);
if (directExecution) {
  const root = resolve(process.cwd(), "..");
  const report = auditAlignedDiffPlan(
    await readFile(resolve(root, ".dev/issues/2026-07-19_04-01-37-keydex-aligned-split-diff.csv"), "utf8"),
    await readFile(resolve(root, ".dev/plans/2026-07-19_04-01-37-keydex-aligned-split-diff.md"), "utf8"),
    { requireComplete: !process.argv.includes("--allow-incomplete") },
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.violations.length > 0) process.exitCode = 1;
}
