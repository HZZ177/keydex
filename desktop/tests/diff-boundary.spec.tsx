import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  KeydexDiffErrorState,
  KeydexDiffLoadingState,
  KeydexDiffRenderBoundary,
  buildKeydexDiffDiagnostic,
  keydexDiffFailurePresentation,
} from "@/renderer/components/diff/DiffBoundary";

describe("Keydex Diff loading and recovery boundary", () => {
  it.each([
    ["lazy_load", "差异组件加载失败"],
    ["parse", "此文件的差异无法解析"],
    ["highlight", "代码高亮失败"],
    ["worker", "后台解析失败"],
    ["render", "差异显示失败"],
  ] as const)("presents %s as Chinese product copy", (phase, title) => {
    expect(keydexDiffFailurePresentation(phase).title).toBe(title);
  });

  it("renders a quiet Keydex skeleton with an accessible Chinese label", () => {
    render(<KeydexDiffLoadingState profile="review" label="正在加载审阅差异" />);
    expect(screen.getByRole("status", { name: "正在加载审阅差异" })
      .getAttribute("data-keydex-diff-state")).toBe("loading");
    expect(screen.getByRole("status").querySelectorAll('[aria-hidden="true"] > span'))
      .toHaveLength(4);
  });

  it("centers the shared loading skeleton across the available diff region", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/renderer/components/diff/DiffBoundary.tsx"), "utf8");
    const css = readFileSync(resolve(process.cwd(), "src/renderer/components/diff/DiffBoundary.module.css"), "utf8");
    expect(source).toContain("LoadingSkeletonStack");
    expect(source).not.toContain("loadingLine");
    expect(css).toMatch(/\.loading\s*{[^}]*height:\s*100%[^}]*place-items:\s*center/s);
    expect(css).not.toContain("diff-loading");
  });

  it("keeps diagnostics collapsed and removes third-party stack and messages", () => {
    const diagnostic = buildKeydexDiffDiagnostic({
      phase: "render",
      profile: "git",
      documentId: "doc-1",
      fileId: "file-1",
      rawSource: "diff --git a/a b/a",
    });
    expect(diagnostic).toContain('"code": "diff_render_failed"');
    expect(diagnostic).toContain('"third_party_detail": "已隐藏"');
    expect(diagnostic).not.toContain("stack");
    render(<KeydexDiffErrorState phase="render" profile="git" rawSource="patch" />);
    const details = screen.getByText("诊断信息").closest("details");
    expect(details?.hasAttribute("open")).toBe(false);
  });

  it("copies raw source and sanitized diagnostics independently", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<KeydexDiffErrorState phase="worker" profile="preview" rawSource="raw-patch" />);
    fireEvent.click(screen.getByRole("button", { name: "复制原文" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("raw-patch"));
    fireEvent.click(screen.getByRole("button", { name: "复制诊断" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining(
      '"code": "diff_worker_failed"',
    )));
  });

  it("keeps a normalized input diagnostic instead of flattening it to a generic parse failure", () => {
    render(
      <KeydexDiffErrorState
        phase="parse"
        profile="preview"
        presentation={{
          title: "差异内容过大",
          message: "差异超过安全解析上限，请缩小范围或改为按文件查看。",
          code: "unsafe_size",
          retryable: true,
        }}
      />,
    );

    expect(screen.getByText("差异内容过大")).toBeTruthy();
    expect(screen.getByText("差异超过安全解析上限，请缩小范围或改为按文件查看。")).toBeTruthy();
  });

  it("contains a render crash and retries without removing healthy siblings", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let shouldThrow = true;
    const retry = vi.fn(() => { shouldThrow = false; });
    const { rerender } = render(
      <div>
        <span>其他页面操作</span>
        <KeydexDiffRenderBoundary
          profile="git"
          documentId="doc"
          rawSource="patch"
          resetKey="v1"
          onRetry={retry}
        >
          <ThrowingChild shouldThrow={shouldThrow} />
        </KeydexDiffRenderBoundary>
      </div>,
    );
    expect(screen.getByText("其他页面操作")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("差异显示失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(
      <div>
        <span>其他页面操作</span>
        <KeydexDiffRenderBoundary
          profile="git"
          documentId="doc"
          rawSource="patch"
          resetKey="v2"
          onRetry={retry}
        >
          <ThrowingChild shouldThrow={shouldThrow} />
        </KeydexDiffRenderBoundary>
      </div>,
    );
    expect(screen.getByText("差异内容可用")).toBeTruthy();
    consoleError.mockRestore();
  });

  it("lets a failed file coexist with successfully rendered files", () => {
    render(
      <div>
        <KeydexDiffErrorState compact phase="parse" profile="review" fileId="bad" rawSource="bad" />
        <article>正常文件差异</article>
      </div>,
    );
    expect(screen.getByRole("alert").textContent).toContain("已跳过这个文件");
    expect(screen.getByText("正常文件差异")).toBeTruthy();
  });
});

function ThrowingChild({ shouldThrow }: { readonly shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("third party english stack");
  return <div>差异内容可用</div>;
}
