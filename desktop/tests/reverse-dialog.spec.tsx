import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReverseDialog } from "../src/renderer/pages/conversation/ReverseDialog";
import type { ReverseDialogState } from "../src/renderer/pages/conversation/useConversationPanelModel";
import type { SessionReverseFilePreview } from "../src/runtime/conversation";

vi.mock("@/renderer/components/diff/wrappers/ReviewDiffView", () => ({
  ReviewDiffView: ({ document, density, showToolbar }: {
    document: { files: Array<{ displayPath: string; patch: string; binary: boolean; truncated: boolean }> };
    density?: string;
    showToolbar?: boolean;
  }) => (
    <section
      aria-label="文件审阅"
      data-keydex-diff-wrapper="review"
      data-density={density}
      data-show-toolbar={String(showToolbar)}
    >
      {document.files.map((file) => (
        <div key={file.displayPath}>
          <span>{file.displayPath}</span>
          <code>{file.patch}</code>
        </div>
      ))}
    </section>
  ),
}));

describe("ReverseDialog", () => {
  it("shows all three modes and disables code modes for legacy messages", () => {
    renderDialog({
      preview: { ...preview(), code_available: false, default_mode: "conversation", files: [] },
      mode: "conversation",
    });

    expect(screen.getByRole("radio", { name: /同时回溯修改和对话/u })).toHaveProperty("disabled", true);
    expect(screen.getByRole("radio", { name: /只回溯修改/u })).toHaveProperty("disabled", true);
    expect(screen.getByRole("radio", { name: /只回溯对话/u })).toHaveProperty("checked", true);
    expect(screen.getByText("仅回溯对话，修改过的文件不会回滚。")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "预计回溯" })).toBeNull();
  });

  it("hides file estimates and conflict warnings when only rewinding the conversation", () => {
    const conversationPreview = {
      ...preview(),
      warnings: ["file_conflicts_detected"],
    };
    const { rerender } = renderDialog({ mode: "conversation", preview: conversationPreview });

    expect(screen.getByText("仅回溯对话，修改过的文件不会回滚。")).toBeTruthy();
    expect(screen.getByText("确认需要恢复的对话范围，修改过的文件不会回滚。")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "预计回溯" })).toBeNull();
    expect(screen.queryByText("ready.ts")).toBeNull();
    expect(screen.queryByText("部分文件在其他对话或应用中发生了变化，回溯前需要确认处理方式。")).toBeNull();

    rerender(
      <ReverseDialog
        state={dialogState({ mode: "both", preview: conversationPreview })}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onSelectMode={vi.fn()}
        onDecision={vi.fn()}
        onRetryPreview={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "预计回溯" })).toBeTruthy();
    expect(screen.getByText("ready.ts")).toBeTruthy();
    expect(screen.getByText("另一个对话已修改")).toBeTruthy();
    expect(screen.getByText("部分文件在其他对话或应用中发生了变化，回溯前需要确认处理方式。")).toBeTruthy();
  });

  it("distinguishes another conversation from an unowned external change", () => {
    const base = preview();
    renderDialog({
      preview: {
        ...base,
        warnings: ["file_conflicts_detected"],
        files: [
          {
            ...base.files[1],
            resource_id: "resource-other-session",
            path: "other-session.ts",
            display_path: "other-session.ts",
            reason_code: "other_session_write",
          },
          {
            ...base.files[1],
            resource_id: "resource-external-drift",
            path: "external.ts",
            display_path: "external.ts",
            reason_code: "external_drift",
            writer_session_id: null,
          },
        ],
      },
    });

    expect(screen.getByText("另一个对话已修改")).toBeTruthy();
    expect(screen.getByText("已在对话外修改")).toBeTruthy();
  });

  it("replaces the file preview with a focused three-choice confirmation", () => {
    renderDialog({ phase: "decision", mode: "code" });

    expect(screen.queryByRole("button", { name: "仅回溯对话" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "预计回溯" })).toBeNull();
    expect(screen.getByRole("heading", { name: "需要确认的文件" })).toBeTruthy();
    expect(screen.getByText("conflict.ts")).toBeTruthy();
    expect(screen.queryByText("ready.ts")).toBeNull();
    expect(screen.getByRole("button", { name: "取消回溯" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "仅回溯其他文件" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "回溯所有文件" })).toBeTruthy();

    const conflictDetails = screen.getByText("conflict.ts").closest("details");
    expect(conflictDetails?.open).toBe(false);
    fireEvent.click(conflictDetails?.querySelector("summary") as HTMLElement);
    expect(conflictDetails?.open).toBe(true);
    expect(screen.getByLabelText("文件审阅")).toBeTruthy();

    fireEvent.mouseEnter(screen.getByRole("button", { name: "仅回溯其他文件" }));
    expect(screen.getByText("跳过上方文件，只回溯其他文件；对话按上方选择处理。")).toBeTruthy();
    fireEvent.mouseEnter(screen.getByRole("button", { name: "回溯所有文件" }));
    expect(screen.getByText("回溯包括上方文件在内的所有文件，并覆盖其他来源的修改。")).toBeTruthy();
  });

  it("passes the explicit destructive force decision", () => {
    const onDecision = vi.fn();
    renderDialog({ phase: "decision" }, { onDecision });

    fireEvent.click(screen.getByRole("button", { name: "回溯所有文件" }));
    expect(onDecision).toHaveBeenCalledWith("force_conflicts");
  });

  it("summarizes partial results by files and affected lines", () => {
    renderDialog({
      phase: "result",
      result: {
        operation_id: "operation-1",
        status: "partial",
        mode: "both",
        decision: "safe_partial",
        conversation_rewound: true,
        restored_files: ["ready.ts"],
        skipped_files: ["conflict.ts"],
        forced_files: [],
        failed_files: [],
        source: {},
      },
    });

    expect(screen.getByText("部分回溯完成")).toBeTruthy();
    expect(screen.getByText("共成功回溯 1 个文件，影响 2 行代码。")).toBeTruthy();
    expect(screen.getByLabelText("回溯结果统计").textContent).toContain("1成功文件2影响代码行1跳过文件0失败文件");
    expect(screen.getByText("代码变化：增加 1 行，删除 1 行")).toBeTruthy();
    expect(screen.getByText("查看问题详情")).toBeTruthy();
    expect(screen.getByText(/问题编号：/u)).toBeTruthy();
    expect(screen.getByText("ready.ts")).toBeTruthy();
    expect(screen.getByText("conflict.ts")).toBeTruthy();
  });

  it("keeps technical warning codes out of the user-facing preview", () => {
    renderDialog({
      preview: {
        ...preview(),
        warnings: ["file_conflicts_detected", "unknown_internal_warning"],
      },
    });

    expect(screen.getByText("部分文件在其他对话或应用中发生了变化，回溯前需要确认处理方式。")).toBeTruthy();
    expect(screen.getByText("部分历史内容无法用于文件回溯。")).toBeTruthy();
    expect(screen.queryByText("file_conflicts_detected")).toBeNull();
    expect(screen.queryByText("unknown_internal_warning")).toBeNull();
  });

  it("reports a conversation-only fallback without claiming file changes", () => {
    renderDialog({
      phase: "result",
      result: {
        operation_id: "operation-1",
        status: "partial",
        mode: "both",
        decision: "conversation_only",
        conversation_rewound: true,
        restored_files: [],
        skipped_files: ["conflict.ts"],
        forced_files: [],
        failed_files: [],
        source: {},
      },
    });

    expect(screen.getByText("对话已恢复，修改过的文件未回滚。")).toBeTruthy();
    expect(screen.queryByText(/代码变化：/u)).toBeNull();
  });

  it("keeps each file collapsed by default and expands its structured diff on click", () => {
    const { container, rerender } = renderDialog({ loading: true, preview: null });
    expect(screen.getByRole("status").textContent).toContain("正在检查可回溯的内容");

    rerender(
      <ReverseDialog
        state={dialogState({
          preview: {
            ...preview(),
            files: [
              ...preview().files,
              workspaceFilePreview("binary.bin", {
                binary: true,
              }),
              workspaceFilePreview("large.txt", {
                truncated: true,
              }),
            ],
          },
        })}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onSelectMode={vi.fn()}
        onDecision={vi.fn()}
        onRetryPreview={vi.fn()}
      />,
    );
    const readyDetails = screen.getByText("ready.ts").closest("details");
    expect(readyDetails?.open).toBe(false);
    expect(screen.getByLabelText("新增 1 行，删除 1 行")).toBeTruthy();
    fireEvent.click(readyDetails?.querySelector("summary") as HTMLElement);
    expect(readyDetails?.open).toBe(true);
    const diff = readyDetails?.querySelector('[aria-label="文件审阅"]') as HTMLElement;
    expect(diff).toBeTruthy();
    expect(diff.dataset.density).toBe("compact");
    expect(diff.dataset.showToolbar).toBe("false");
    expect(diff.textContent).toContain("-new");
    expect(diff.textContent).toContain("+old");
    expect(container.querySelector("pre")).toBeNull();
    fireEvent.click(readyDetails?.querySelector("summary") as HTMLElement);
    expect(readyDetails?.open).toBe(false);
    fireEvent.click(screen.getByText("binary.bin"));
    expect(screen.getByText(/可以回溯，但不提供代码行预览/u)).toBeTruthy();
    fireEvent.click(screen.getByText("large.txt"));
    expect(screen.getByText("内容较多，仅展示部分差异。")).toBeTruthy();

    rerender(
      <ReverseDialog
        state={dialogState({ preview: { ...preview(), files: [], insertions: 0, deletions: 0 } })}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onSelectMode={vi.fn()}
        onDecision={vi.fn()}
        onRetryPreview={vi.fn()}
      />,
    );
    expect(screen.getByText("文件已经是目标状态，无需修改。")).toBeTruthy();
  });

  it("reserves a visible viewport for the expanded rewind diff", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/conversation/ReverseDialog.module.css"),
      "utf8",
    );

    expect(css).toMatch(
      /\.fileExpanded\s+:global\(\[data-keydex-diff-wrapper="review"\]\)\s*\{[^}]*height:\s*clamp\(180px,\s*28vh,\s*280px\)[^}]*min-height:\s*180px/s,
    );
    expect(css).toMatch(
      /\.fileExpanded\s+:global\(\[data-keydex-diff-patch-viewport="true"\]\)\s*\{[^}]*overscroll-behavior-y:\s*auto/s,
    );
  });

  it("keeps unrecoverable files visible and offers only legal decisions", () => {
    const onDecision = vi.fn();
    const onSelectMode = vi.fn();
    renderDialog(
      {
        phase: "decision",
        preview: {
          ...preview(),
          files: [workspaceFilePreview("lost.txt", {
            classification: "unrecoverable",
            reason_code: "file_backup_missing",
          })],
        },
      },
      { onDecision, onSelectMode },
    );

    expect(screen.getByText("历史版本不可用")).toBeTruthy();
    expect(screen.getByRole("button", { name: "仅回溯其他文件" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "回溯所有文件" })).toBeNull();
    expect(screen.queryByRole("button", { name: "仅回溯对话" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /只回溯对话/u }));
    expect(onSelectMode).toHaveBeenCalledWith("conversation");
    expect(onDecision).not.toHaveBeenCalled();
  });

  it.each([
    ["compensated", "回溯未完成，文件已恢复原状"],
    ["compensation_failed", "回溯未完成"],
    ["blocked", "回溯未完成"],
  ] as const)("renders %s terminal status without claiming full success", (status, label) => {
    renderDialog({
      phase: "result",
      result: {
        operation_id: "operation-sensitive-free",
        status,
        mode: "both",
        decision: "full",
        conversation_rewound: false,
        restored_files: [],
        skipped_files: [],
        forced_files: [],
        failed_files: status === "compensated" ? [] : ["src/blocked.ts"],
        source: {},
      },
    });

    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText("回溯完成")).toBeNull();
    if (status !== "compensated") {
      expect(screen.getByText(/请先检查失败文件/u)).toBeTruthy();
    }
  });

  it("requires a new preview after stale and exposes blocked operation guidance", () => {
    const onRetryPreview = vi.fn();
    const { rerender } = render(
      <ReverseDialog
        state={dialogState({ error: "preview stale", errorCode: "file_preview_stale" })}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onSelectMode={vi.fn()}
        onDecision={vi.fn()}
        onRetryPreview={onRetryPreview}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重新预览" }));
    expect(onRetryPreview).toHaveBeenCalledTimes(1);
    expect(screen.getByText("文件状态已经变化，请重新检查后再回溯。")).toBeTruthy();
    expect(screen.queryByText("preview stale")).toBeNull();

    rerender(
      <ReverseDialog
        state={dialogState({
          error: "compensation failed",
          errorCode: "file_restore_compensation_failed",
        })}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onSelectMode={vi.fn()}
        onDecision={vi.fn()}
        onRetryPreview={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("查看问题详情"));
    expect(screen.getByText(/问题编号：/u)).toBeTruthy();
    expect(screen.getByText("operation-1")).toBeTruthy();
    expect(screen.queryByText("回溯完成")).toBeNull();
    expect(screen.queryByText("compensation failed")).toBeNull();
  });
});

function renderDialog(
  overrides: Partial<ReverseDialogState> = {},
  handlers: {
    onDecision?: ReturnType<typeof vi.fn>;
    onSelectMode?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return render(
    <ReverseDialog
      state={dialogState(overrides)}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      onSelectMode={handlers.onSelectMode ?? vi.fn()}
      onDecision={handlers.onDecision ?? vi.fn()}
      onRetryPreview={vi.fn()}
    />,
  );
}

function dialogState(overrides: Partial<ReverseDialogState> = {}): ReverseDialogState {
  return {
    sessionId: "session-1",
    candidate: {
      id: "message-1",
      threadId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
      kind: "user",
      status: "completed",
      content: "rewind target",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      payload: { messageEventId: "event-1" },
    },
    messageEventId: "event-1",
    phase: "preview",
    loading: false,
    executing: false,
    mode: "both",
    externalPathsConfirmed: false,
    preview: preview(),
    result: null,
    error: null,
    errorCode: null,
    ...overrides,
  };
}

function preview() {
  return {
    operation_id: "operation-1",
    source: {},
    conversation_available: true,
    code_available: true,
    default_mode: "both" as const,
    snapshot_id: "snapshot-1",
    preview_token: "token-1",
    insertions: 2,
    deletions: 1,
    warnings: [],
    requires_external_confirmation: false,
    external_paths: [],
    files: [
      {
        resource_id: "resource-ready",
        scope_kind: "workspace" as const,
        scope_identity: "workspace-current",
        scope_label: "当前项目",
        display_path: "ready.ts",
        absolute_path: "D:/repo/ready.ts",
        requires_full_access: false,
        path: "ready.ts",
        current_state: "file",
        target_state: "file",
        classification: "ready" as const,
        binary: false,
        truncated: false,
        insertions: 1,
        deletions: 1,
        diff: "-new\n+old",
      },
      {
        resource_id: "resource-conflict",
        scope_kind: "workspace" as const,
        scope_identity: "workspace-current",
        scope_label: "当前项目",
        display_path: "conflict.ts",
        absolute_path: "D:/repo/conflict.ts",
        requires_full_access: false,
        path: "conflict.ts",
        current_state: "file",
        target_state: "file",
        classification: "forceable_conflict" as const,
        reason_code: "other_session_write",
        binary: false,
        truncated: false,
        insertions: 1,
        deletions: 0,
        diff: "-other-session\n+target-version",
      },
    ],
  };
}

function workspaceFilePreview(
  path: string,
  overrides: Partial<SessionReverseFilePreview> = {},
): SessionReverseFilePreview {
  return {
    resource_id: `resource-${path}`,
    scope_kind: "workspace",
    scope_identity: "workspace-current",
    scope_label: "褰撳墠椤圭洰",
    display_path: path,
    absolute_path: `D:/repo/${path}`,
    requires_full_access: false,
    path,
    current_state: "file",
    target_state: "file",
    classification: "ready",
    binary: false,
    truncated: false,
    insertions: 0,
    deletions: 0,
    ...overrides,
  };
}
