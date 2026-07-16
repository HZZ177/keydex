import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitPatchExchangeView, patchImportSignature } from "@/renderer/features/git/components/GitPatchExchangeView";
import { createGitRuntime } from "@/runtime/git";
import { HttpClient } from "@/runtime/httpClient";
import type { GitCommandResult } from "@/runtime/gitTypes";

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
    const props = { exported: null, busy: false, outcome: null, rejectFiles: [], onExport: vi.fn(), onCheck, onApply };
    const { rerender } = render(<GitPatchExchangeView {...props} dryRunSignature={null} />);
    fireEvent.change(screen.getByLabelText("Patch content"), { target: { value: patch } });
    expect((screen.getByRole("button", { name: "Apply patch" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Dry-run" }));
    expect(onCheck).toHaveBeenCalledWith(patch, options);

    rerender(<GitPatchExchangeView {...props} dryRunSignature={patchImportSignature(patch, options)} />);
    expect((screen.getByRole("button", { name: "Apply patch" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Apply patch" }));
    expect(onApply).toHaveBeenCalledWith(patch, options);
    fireEvent.click(screen.getByLabelText("Reverse patch"));
    expect((screen.getByRole("button", { name: "Apply patch" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("validates range export fields and makes partial reject files visible", () => {
    const onExport = vi.fn();
    render(<GitPatchExchangeView exported={null} busy={false} dryRunSignature={null} outcome={failed()} rejectFiles={["src/a.ts.rej"]} onExport={onExport} onCheck={vi.fn()} onApply={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Patch export mode"), { target: { value: "range" } });
    expect((screen.getByRole("button", { name: "Generate patch" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Patch left revision"), { target: { value: "main" } });
    fireEvent.change(screen.getByLabelText("Patch right revision"), { target: { value: "topic" } });
    fireEvent.change(screen.getByLabelText("Patch export paths"), { target: { value: "src/a.ts" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate patch" }));
    expect(onExport).toHaveBeenCalledWith("range", "main", "topic", ["src/a.ts"]);
    expect(screen.getByRole("alert").textContent).toContain("src/a.ts.rej");
    expect(screen.getByRole("alert").textContent).toContain("partially applied");
  });
});

function failed(): GitCommandResult { return { operationId: "patch-op", repositoryId: "git-patch" as never, repositoryVersion: "version-2" as never, state: "failed", summary: "Patch failed", result: {}, command: "apply_patch", risk: "write", createdAt: null, startedAt: null, finishedAt: null, durationMs: null, retryable: false, error: null }; }
function rawExport() { return { repository_id: "git-patch", repository_version: "version-1", mode: "range", left: "main", right: "topic", paths: ["src/a.ts", "src/b.ts"], filename: "keydex-range-main-topic.patch", patch: "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\n" }; }
function rawOperation() { return { operation_id: "patch-op", repository_id: "git-patch", repository_version: "version-2", state: "succeeded", summary: "Patch", result: {} }; }
function jsonResponse(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }); }
