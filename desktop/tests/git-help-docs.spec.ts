import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd(), "..");
const guideRoot = resolve(repositoryRoot, "backend/app/keydex/builtin_skills/skills/keydex-guide");

describe("Git workbench help documentation", () => {
  it("is linked from the built-in Keydex guide and covers the required risk topics", () => {
    const skill = readFileSync(resolve(guideRoot, "SKILL.md"), "utf8");
    const guide = readFileSync(resolve(guideRoot, "references/git-workbench.md"), "utf8");

    expect(skill).toContain("[git-workbench.md](references/git-workbench.md)");
    for (const requiredText of [
      "祖先仓库",
      "多个 Git 根",
      "--force-with-lease",
      "冲突和进行中操作",
      "认证、网络与诊断",
      "Git LFS",
      "不声明与 PyCharm 完全兼容",
    ]) {
      expect(guide).toContain(requiredText);
    }
  });

  it("keeps the pinned LiveAgent MIT attribution and implementation boundary", () => {
    const guide = readFileSync(resolve(guideRoot, "references/git-workbench.md"), "utf8");
    const attribution = readFileSync(resolve(repositoryRoot, "docs/git-open-source-attribution.md"), "utf8");

    for (const requiredText of [
      "Stack-Cairn/LiveAgent",
      "1616eb5e574274693dc29e18248650dc30911123",
      "MIT",
      "没有直接复制进 Keydex",
      "gitGraph.ts",
    ]) {
      expect(guide).toContain(requiredText);
    }
    expect(attribution).toContain("1616eb5e574274693dc29e18248650dc30911123");
    expect(attribution.replace(/\s+/g, " ")).toContain("No LiveAgent React component or CSS is included.");
  });
});
