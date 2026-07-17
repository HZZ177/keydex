import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitPatchExchangeView, patchImportSignature } from "@/renderer/features/git/components/GitPatchExchangeView";
import { createGitRuntime } from "@/runtime/git";
import { HttpClient } from "@/runtime/httpClient";

afterEach(cleanup);

describe("Git patch exchange", () => {
  it("maps selected range export and explicit dry-run/reject import options", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(String(input).includes("patch-export") ? rawExport() : rawOperation()));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    const scope = { workspaceId: "workspace-a", projectRoot: "C:/project", repositoryId: "git-patch" as never };
    const exported = await runtime.exportPatch(scope, "range", { left: "main", right: "topic", paths: ["src/a.ts", "src/b.ts"] });
    await runtime.applyPatch({ ...scope, idempotencyKey: "check", patch: exported.patch, cached: false, reverse: true, checkOnly: true, reject: false });
    await runtime.applyPatch({ ...scope, idempotencyKey: "apply", patch: exported.patch, cached: false, reverse: true, checkOnly: false, reject: true });

    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.searchParams.getAll("paths")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ mode: "range", left: "main", right: "topic" });
    expect(JSON.parse(String((fetcher.mock.calls[1][1] as RequestInit).body))).toMatchObject({ check_only: true, reject: false, reverse: true });
    expect(JSON.parse(String((fetcher.mock.calls[2][1] as RequestInit).body))).toMatchObject({ check_only: false, reject: true, cached: false });
  });

  it("gates Apply on the exact dry-run signature and invalidates it when options change", () => {
    const onCheck = vi.fn();
    const onApply = vi.fn();
    const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n";
    const options = { cached: false, reverse: false, reject: false };
    const props = { exported: null, busy: false, rejectFiles: [], onExport: vi.fn(), onCheck, onApply };
    const { rerender } = render(<GitPatchExchangeView {...props} dryRunSignature={null} />);
    fireEvent.change(screen.getByLabelText("补丁内容"), { target: { value: patch } });
    expect((screen.getByRole("button", { name: "应用补丁" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "试运行" }));
    expect(onCheck).toHaveBeenCalledWith(patch, options);

    rerender(<GitPatchExchangeView {...props} dryRunSignature={patchImportSignature(patch, options)} />);
    expect((screen.getByRole("button", { name: "应用补丁" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "应用补丁" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "确认应用补丁" }).textContent).toContain("影响 1 个路径，1 个变更块");
    fireEvent.click(screen.getByRole("button", { name: "确认应用" }));
    expect(onApply).toHaveBeenCalledWith(patch, options);
    fireEvent.click(screen.getByLabelText("反向应用补丁"));
    expect((screen.getByRole("button", { name: "应用补丁" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("validates range export fields and makes partial reject files visible", () => {
    const onExport = vi.fn();
    render(<GitPatchExchangeView exported={null} busy={false} dryRunSignature={null} rejectFiles={["src/a.ts.rej"]} onExport={onExport} onCheck={vi.fn()} onApply={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("补丁导出方式"), { target: { value: "range" } });
    expect((screen.getByRole("button", { name: "生成补丁" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("补丁左侧修订"), { target: { value: "main" } });
    fireEvent.change(screen.getByLabelText("补丁右侧修订"), { target: { value: "topic" } });
    fireEvent.change(screen.getByLabelText("补丁导出路径"), { target: { value: "src/a.ts" } });
    fireEvent.click(screen.getByRole("button", { name: "生成补丁" }));
    expect(onExport).toHaveBeenCalledWith("range", "main", "topic", ["src/a.ts"]);
    expect(screen.getByRole("alert").textContent).toContain("src/a.ts.rej");
    expect(screen.getByRole("alert").textContent).toContain("仅部分应用");
  });
});

function rawExport() { return { repository_id: "git-patch", repository_version: "version-1", mode: "range", left: "main", right: "topic", paths: ["src/a.ts", "src/b.ts"], filename: "keydex-range-main-topic.patch", patch: "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\n" }; }
function rawOperation() { return { operation_id: "patch-op", repository_id: "git-patch", repository_version: "version-2", state: "succeeded", summary: "Patch", result: {} }; }
function jsonResponse(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }); }
