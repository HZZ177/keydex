import { describe, expect, it } from "vitest";

// @ts-ignore The repository's broad *.mjs declaration only describes the MCP harness exports.
import { ALIGNED_DIFF_ISSUE_IDS, auditAlignedDiffPlan } from "../tools/aligned-diff-plan-audit.mjs";

const header = '"id","priority","title","refs","dev_state","test_state","owner","notes"';

function fixture(state = "已完成") {
  const csv = [
    header,
    ...ALIGNED_DIFF_ISSUE_IDS.map((id: string) => (
      `"${id}","P0","任务","D:Review §1; C:file.ts","${state}","${state}","Codex","evidence;done_at:2026-07-19"`
    )),
  ].join("\n");
  const plan = ALIGNED_DIFF_ISSUE_IDS.map((id: string) => (
    `| **${id} / P0 / 任务** | 验收 | D: refs | U: unit；F: functional；E: e2e | constraints |`
  )).join("\n");
  return { csv, plan };
}

describe("aligned Diff Plan audit", () => {
  it("accepts the exact 42 issue contracts with development and test evidence", () => {
    const { csv, plan } = fixture();
    expect(auditAlignedDiffPlan(csv, plan)).toMatchObject({
      issues: 42,
      planContracts: 42,
      completedDevelopment: 42,
      completedTesting: 42,
      violations: [],
    });
  });

  it("reports an incomplete final issue and supports an in-progress audit", () => {
    const { csv, plan } = fixture("未开始");
    expect(auditAlignedDiffPlan(csv, plan).violations).toContainEqual({
      code: "dev_state",
      id: "ASD-001",
      actual: "未开始",
    });
    expect(auditAlignedDiffPlan(csv, plan, { requireComplete: false }).violations).toEqual([]);
  });

  it("rejects non-contract aliases even when they look complete", () => {
    const { csv, plan } = fixture("完成");
    expect(auditAlignedDiffPlan(csv, plan, { requireComplete: false }).violations).toEqual(
      expect.arrayContaining([
        { code: "dev_state_enum", id: "ASD-001", actual: "完成" },
        { code: "test_state_enum", id: "ASD-001", actual: "完成" },
      ]),
    );
    expect(auditAlignedDiffPlan(csv, plan)).toEqual(expect.objectContaining({
      completedDevelopment: 0,
      completedTesting: 0,
    }));
  });
});
