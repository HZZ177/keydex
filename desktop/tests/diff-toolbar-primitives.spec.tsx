import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Copy, Rows3 } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KeydexDiffToolbar,
  KeydexDiffToolbarAction,
} from "@/renderer/components/diff/DiffToolbar";

afterEach(cleanup);

describe("Keydex Diff 工具栏基元", () => {
  it.each(["compact", "review", "git", "preview"] as const)(
    "exposes the %s profile without changing action order",
    (profile) => {
      const { container } = render(
        <KeydexDiffToolbar profile={profile}>
          <KeydexDiffToolbarAction label="布局" icon={<Rows3 />} />
          <KeydexDiffToolbarAction label="复制" icon={<Copy />} />
        </KeydexDiffToolbar>,
      );
      const toolbar = screen.getByRole("toolbar", { name: "差异工具栏" });
      expect(toolbar.getAttribute("data-profile")).toBe(profile);
      expect(Array.from(container.querySelectorAll("button"), (button) => button.getAttribute("aria-label")))
        .toEqual(["布局", "复制"]);
    },
  );

  it("exposes pressed state and keeps the visible label optional", () => {
    render(<KeydexDiffToolbarAction label="自动换行" icon={<Rows3 />} pressed showLabel />);
    const button = screen.getByRole("button", { name: "自动换行" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.textContent).toBe("自动换行");
  });

  it("keeps Git actions centered when a leading title is present", () => {
    render(
      <KeydexDiffToolbar profile="git" leading={<span>详情</span>}>
        <KeydexDiffToolbarAction label="布局" icon={<Rows3 />} />
      </KeydexDiffToolbar>,
    );
    const toolbar = screen.getByRole("toolbar", { name: "差异工具栏" });
    expect(toolbar.textContent).toContain("详情");
    const css = readFileSync(resolve(process.cwd(), "src/renderer/components/diff/DiffToolbar.module.css"), "utf8");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)");
    expect(css).toMatch(/\.toolbar\[data-profile="git"\] \.actions \{\s*grid-column: 2;/u);
  });

  it.each([
    ["loading", "复制中", "true"],
    ["success", "复制成功", null],
    ["error", "复制失败", null],
  ] as const)("renders the %s feedback state", (state, label, busy) => {
    render(<KeydexDiffToolbarAction label="复制" icon={<Copy />} state={state} />);
    const button = screen.getByRole("button", { name: label });
    expect(button.getAttribute("data-action-state")).toBe(state);
    expect(button.getAttribute("aria-busy")).toBe(busy);
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("blocks repeated clicks while loading", () => {
    const onClick = vi.fn();
    render(<KeydexDiffToolbarAction label="复制" icon={<Copy />} state="loading" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "复制中" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("uses the disabled reason and shortcut in the shared tooltip contract", () => {
    render(
      <KeydexDiffToolbarAction
        label="打开文件"
        icon={<Copy />}
        disabled
        disabledReason="当前文件没有可打开的路径"
        shortcut="Enter"
      />,
    );
    expect(screen.getByRole("button", { name: "打开文件" }).getAttribute("data-tooltip-label"))
      .toBe("当前文件没有可打开的路径 · Enter");
  });

  it("uses semantic tokens, rectangular targets, focus states and reduced-motion fallback", () => {
    const css = readFileSync(resolve(process.cwd(), "src/renderer/components/diff/DiffToolbar.module.css"), "utf8");
    expect(css).toContain("min-width: 28px");
    expect(css).toContain("min-height: 28px");
    expect(css).toContain("border-radius: var(--radius-sm)");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).not.toMatch(/#[\da-f]{3,8}/iu);
    expect(css).not.toContain("var(--radius-pill)");
  });
});
