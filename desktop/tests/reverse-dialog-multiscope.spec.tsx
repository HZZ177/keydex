import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReverseDialog } from "../src/renderer/pages/conversation/ReverseDialog";
import type { ReverseDialogState } from "../src/renderer/pages/conversation/useConversationPanelModel";
import type { SessionReverseFilePreview } from "../src/runtime";


describe("ReverseDialog multiscope resources", () => {
  it("groups same-named resources by scope and exposes the external absolute path", () => {
    const onExternalConfirmationChange = vi.fn();
    const { rerender } = render(
      <ReverseDialog
        state={state()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onSelectMode={vi.fn()}
        onExternalConfirmationChange={onExternalConfirmationChange}
        onDecision={vi.fn()}
        onRetryPreview={vi.fn()}
      />,
    );

    expect(screen.getByText("Keydex 项目")).toBeTruthy();
    expect(screen.getByText("D: 外部目录")).toBeTruthy();
    expect(screen.getByText("项目 · 1 个文件")).toBeTruthy();
    expect(screen.getByText("工作区外 · 1 个文件")).toBeTruthy();
    expect(screen.getAllByText("same.txt")).toHaveLength(2);
    expect(screen.getAllByText("D:/outside/same.txt")).toHaveLength(2);
    expect(screen.getAllByTestId("reverse-file-preview")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "回溯到此处" })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("checkbox", { name: /确认恢复工作区外文件/u }));
    expect(onExternalConfirmationChange).toHaveBeenCalledWith(true);
    rerender(
      <ReverseDialog
        state={state(true)}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onSelectMode={vi.fn()}
        onExternalConfirmationChange={onExternalConfirmationChange}
        onDecision={vi.fn()}
        onRetryPreview={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "回溯到此处" })).toHaveProperty("disabled", false);
  });

  it("maps resource-id results back to scope-aware display paths", () => {
    const resultState = state(true);
    resultState.phase = "result";
    resultState.result = {
      operation_id: "operation-1",
      status: "partial",
      mode: "code",
      decision: "safe_partial",
      conversation_rewound: false,
      restored_files: ["resource-external"],
      skipped_files: ["resource-workspace"],
      forced_files: [],
      failed_files: [],
      source: {},
    };

    render(
      <ReverseDialog
        state={resultState}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onSelectMode={vi.fn()}
        onDecision={vi.fn()}
        onRetryPreview={vi.fn()}
      />,
    );

    expect(screen.getByText("共成功回溯 1 个文件，影响 2 行代码。")).toBeTruthy();
    expect(screen.getByText("D:/outside/same.txt")).toBeTruthy();
    expect(screen.getByText("D: 外部目录")).toBeTruthy();
    expect(screen.getByText("same.txt")).toBeTruthy();
    expect(screen.getByText("Keydex 项目")).toBeTruthy();
    expect(screen.queryByText("resource-external")).toBeNull();
  });
});


function resource(
  resourceId: string,
  scopeKind: "workspace" | "external",
  scopeIdentity: string,
  scopeLabel: string,
  absolutePath: string,
): SessionReverseFilePreview {
  return {
    resource_id: resourceId,
    scope_kind: scopeKind,
    scope_identity: scopeIdentity,
    scope_label: scopeLabel,
    display_path: "same.txt",
    absolute_path: absolutePath,
    requires_full_access: scopeKind === "external",
    path: "same.txt",
    current_state: "file",
    target_state: "file",
    classification: "ready",
    binary: false,
    truncated: false,
    insertions: 1,
    deletions: 1,
    diff: "-after\n+before",
  };
}


function state(externalPathsConfirmed = false): ReverseDialogState {
  return {
    sessionId: "session-1",
    candidate: {
      id: "message-1",
      threadId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
      kind: "user",
      status: "completed",
      content: "回溯目标",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      payload: { messageEventId: "event-1" },
    },
    messageEventId: "event-1",
    phase: "preview",
    loading: false,
    executing: false,
    mode: "code",
    externalPathsConfirmed,
    preview: {
      operation_id: "operation-1",
      source: {},
      conversation_available: true,
      code_available: true,
      default_mode: "code",
      snapshot_id: "snapshot-1",
      preview_token: "token-1",
      files: [
        resource("resource-workspace", "workspace", "workspace:keydex", "Keydex 项目", "D:/repo/same.txt"),
        resource("resource-external", "external", "external:d", "D: 外部目录", "D:/outside/same.txt"),
      ],
      insertions: 2,
      deletions: 2,
      warnings: [],
      requires_external_confirmation: true,
      external_paths: ["D:/outside/same.txt"],
    },
    result: null,
    error: null,
    errorCode: null,
  };
}
