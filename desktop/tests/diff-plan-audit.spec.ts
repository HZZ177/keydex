import { describe, expect, it } from "vitest";

// @ts-ignore The repository's broad *.mjs declaration only describes the MCP harness exports.
import { auditDiffPlanIssues, parseCsv } from "../tools/diff-plan-audit.mjs";

describe("Diff plan and CSV traceability audit", () => {
  it("parses quoted commas, escaped quotes and CRLF", () => {
    expect(parseCsv('"id","notes"\r\n"DIFF-001","a,b ""quoted"""\r\n')).toEqual([
      ["id", "notes"],
      ["DIFF-001", 'a,b "quoted"'],
    ]);
  });

  it("reports incomplete states, missing evidence and missing U/F/E contracts", () => {
    const header = '"id","priority","title","refs","dev_state","test_state","owner","notes"';
    const rows = Array.from({ length: 102 }, (_, index) => {
      const id = `DIFF-${String(index + 1).padStart(3, "0")}`;
      return `"${id}","P0","title","D: design；C: code","${index === 0 ? "进行中" : "已完成"}","已完成","","${index === 1 ? "" : "evidence:test"}"`;
    });
    const plan = Array.from({ length: 102 }, (_, index) => {
      const id = `DIFF-${String(index + 1).padStart(3, "0")}`;
      return `| ${id} / P0 / title | summary | refs | U: unit; F: function; ${index === 2 ? "" : "E: e2e"} | constraints |`;
    }).join("\n");
    const report = auditDiffPlanIssues([header, ...rows].join("\n"), plan);
    expect(report.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "dev_state", id: "DIFF-001" }),
      expect.objectContaining({ code: "evidence", id: "DIFF-002" }),
      expect.objectContaining({ code: "test_layer", id: "DIFF-003", layer: "E:" }),
    ]));
  });
});
