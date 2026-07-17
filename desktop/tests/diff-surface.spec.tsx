import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  KeydexDiffQuietState,
  KeydexDiffSurface,
} from "@/renderer/components/diff/DiffSurface";

afterEach(cleanup);

describe("Keydex Codex-like Diff surface", () => {
  it.each(["compact", "review", "git", "preview"] as const)(
    "exposes the %s profile contract without a Pierre card header",
    (profile) => {
      const { container } = render(
        <KeydexDiffSurface profile={profile} aria-label={`${profile} 差异`}>
          <span>内容</span>
        </KeydexDiffSurface>,
      );
      const surface = container.querySelector("[data-keydex-diff-surface]");
      expect(surface?.getAttribute("data-profile")).toBe(profile);
      expect(surface?.getAttribute("data-scroll-owner")).toBe("viewer");
      expect(surface?.getAttribute("data-embedded")).toBe("false");
      expect(surface?.hasAttribute("data-diffs-header")).toBe(false);
    },
  );

  it("removes the second frame when nested in an existing host", () => {
    const { container } = render(
      <aside data-testid="sidebar">
        <KeydexDiffSurface profile="review" embedded>
          <span>审阅内容</span>
        </KeydexDiffSurface>
      </aside>,
    );
    expect(container.querySelector("[data-keydex-diff-surface]")?.getAttribute("data-embedded"))
      .toBe("true");
  });

  it("declares exactly one scroll owner", () => {
    const { container, rerender } = render(
      <KeydexDiffSurface profile="git" scrollOwner="viewer"><span>Git</span></KeydexDiffSurface>,
    );
    expect(container.querySelector("[data-keydex-diff-surface]")?.getAttribute("data-scroll-owner"))
      .toBe("viewer");
    rerender(
      <KeydexDiffSurface profile="git" scrollOwner="host"><span>Git</span></KeydexDiffSurface>,
    );
    expect(container.querySelector("[data-keydex-diff-surface]")?.getAttribute("data-scroll-owner"))
      .toBe("host");
  });

  it("renders quiet neutral and Chinese error states without a card", () => {
    const { rerender } = render(<KeydexDiffQuietState title="暂无差异" />);
    expect(screen.getByRole("status", { name: "暂无差异" })).not.toBeNull();
    rerender(<KeydexDiffQuietState title="差异加载失败" detail="请稍后重试" tone="error" />);
    expect(screen.getByRole("alert").textContent).toBe("差异加载失败请稍后重试");
  });

  it("uses only semantic tokens, weak boundaries and rectangular radii", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/components/diff/DiffSurface.module.css"),
      "utf8",
    );
    expect(css).toContain("border: 1px solid var(--diff-border-subtle)");
    expect(css).toContain("border-radius: var(--radius-md)");
    expect(css).toContain('data-profile="compact"');
    expect(css).toContain('data-embedded="true"');
    expect(css).not.toMatch(/#[\da-f]{3,8}/iu);
    expect(css).not.toContain("var(--radius-pill);\n  background: var(--diff-surface-bg)");
    expect(css).not.toContain("box-shadow: var(--shadow");
  });
});
