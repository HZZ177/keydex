import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const DIFF_ISSUE_COUNT = 102;
export const DIFF_ISSUE_IDS = Object.freeze(
  Array.from({ length: DIFF_ISSUE_COUNT }, (_, index) => `DIFF-${String(index + 1).padStart(3, "0")}`),
);

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value.replace(/\r$/u, ""));
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else value += character;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (value !== "" || row.length > 0) {
    row.push(value.replace(/\r$/u, ""));
    rows.push(row);
  }
  return rows;
}

export function auditDiffPlanIssues(csvText, planText, { requireComplete = true } = {}) {
  const rows = parseCsv(csvText);
  const header = rows.shift() ?? [];
  const expectedHeader = ["id", "priority", "title", "refs", "dev_state", "test_state", "owner", "notes"];
  const violations = [];
  if (JSON.stringify(header) !== JSON.stringify(expectedHeader)) {
    violations.push({ code: "csv_header", actual: header, expected: expectedHeader });
  }
  const ids = rows.map((row) => row[0]);
  if (rows.length !== DIFF_ISSUE_COUNT) {
    violations.push({ code: "issue_count", actual: rows.length, expected: DIFF_ISSUE_COUNT });
  }
  if (JSON.stringify(ids) !== JSON.stringify(DIFF_ISSUE_IDS)) {
    violations.push({ code: "issue_ids", actual: ids, expected: DIFF_ISSUE_IDS });
  }
  const planLines = planText.split(/\r?\n/u).filter((line) => /^\| DIFF-\d{3} \/ P[01] \/ /u.test(line));
  const planById = new Map(planLines.map((line) => [line.match(/^\| (DIFF-\d{3})/u)?.[1], line]));
  for (const [index, row] of rows.entries()) {
    const [id, priority, title, refs, devState, testState, , notes] = row;
    if (row.length !== expectedHeader.length) violations.push({ code: "column_count", id, actual: row.length });
    if (!/^P[01]$/u.test(priority ?? "")) violations.push({ code: "priority", id, actual: priority });
    if (!(title ?? "").trim()) violations.push({ code: "title", id });
    if (!/^D: .+；C: .+/u.test(refs ?? "")) violations.push({ code: "refs", id, actual: refs });
    const planLine = planById.get(id);
    if (!planLine) violations.push({ code: "plan_mapping", id, index });
    else for (const layer of ["U:", "F:", "E:"]) {
      if (!planLine.includes(layer)) violations.push({ code: "test_layer", id, layer });
    }
    if (requireComplete && devState !== "已完成") violations.push({ code: "dev_state", id, actual: devState });
    if (requireComplete && testState !== "已完成") violations.push({ code: "test_state", id, actual: testState });
    if (devState === "已完成" && testState === "已完成" && !/evidence:/u.test(notes ?? "")) {
      violations.push({ code: "evidence", id });
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    issues: rows.length,
    planContracts: planById.size,
    completedDevelopment: rows.filter((row) => row[4] === "已完成").length,
    completedTesting: rows.filter((row) => row[5] === "已完成").length,
    violations: Object.freeze(violations),
  });
}

const directExecution = process.argv[1]
  && resolve(process.argv[1]) === resolve(import.meta.filename);
if (directExecution) {
  const root = resolve(process.cwd(), "..");
  const csvPath = resolve(root, ".dev/issues/2026-07-17_02-38-51-pierre-diffs-unified-refactor.csv");
  const planPath = resolve(root, ".dev/plans/2026-07-17_02-38-51-pierre-diffs-unified-refactor.md");
  const report = auditDiffPlanIssues(
    await readFile(csvPath, "utf8"),
    await readFile(planPath, "utf8"),
    { requireComplete: !process.argv.includes("--allow-incomplete") },
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.violations.length > 0) process.exitCode = 1;
}
