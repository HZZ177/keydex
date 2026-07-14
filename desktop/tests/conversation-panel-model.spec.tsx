import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "../src/runtime";
import type { AgentSessionController } from "../src/renderer/hooks/useAgentSessionController";
import { useConversationPanelModel } from "../src/renderer/pages/conversation/useConversationPanelModel";
import { NotificationProvider } from "../src/renderer/providers/NotificationProvider";
import { PreviewProvider, usePreview, type ReviewPanelRequest } from "../src/renderer/providers/PreviewProvider";
import type { ConversationRuntimeState } from "../src/renderer/stores/conversationStore";
import type { AgentSession, Workspace } from "../src/types/protocol";

let latestReviewPanelRequest: ReviewPanelRequest | null = null;

describe("useConversationPanelModel", () => {
  beforeEach(() => {
    latestReviewPanelRequest = null;
  });

  it("exposes workspace search and directory listing only for available workspace sessions", async () => {
    const runtime = fakeRuntime();
    const controller = fakeController({
      session: agentSession({
        session_type: "workspace",
        workspace_id: "ws-1",
        workspace: workspace(),
        cwd: "D:/repo/keydex",
      }),
    });

    const { result } = renderHook(
      () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller }),
      { wrapper: Providers },
    );

    expect(result.current.workspaceAvailable).toBe(true);
    expect(result.current.workspaceLabel).toBe("D:/repo/keydex");
    expect(result.current.searchWorkspace).toBeTypeOf("function");
    expect(result.current.listWorkspaceDirectory).toBeTypeOf("function");

    await act(async () => {
      await result.current.searchWorkspace?.("README", { signal: undefined });
    });
    expect(runtime.workspace.search).toHaveBeenCalledWith({ sessionId: "ses-1" }, "README", { signal: undefined });

    let entries;
    await act(async () => {
      entries = await result.current.listWorkspaceDirectory?.("/");
    });
    expect(runtime.workspace.listDirectory).toHaveBeenCalledWith({ sessionId: "ses-1" }, "/");
    expect(entries).toEqual([{ path: "README.md", name: "README.md", type: "file" }]);
  });

  it("includes workspace id in existing workspace session preview context", async () => {
    const runtime = fakeRuntime();
    const controller = fakeController({
      session: agentSession({
        session_type: "workspace",
        workspace_id: "ws-1",
        workspace: workspace(),
        cwd: "D:/repo/keydex",
      }),
    });

    const { result } = renderHook(
      () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller }),
      { wrapper: Providers },
    );

    expect(result.current.previewRenderContext.sessionId).toBe("ses-1");
    expect(result.current.previewRenderContext.workspaceId).toBe("ws-1");
    await waitFor(() => expect(runtime.workspace.listSkills).toHaveBeenCalled());
  });

  it("keeps pure chat and unavailable workspace sessions out of workspace file search", () => {
    const runtime = fakeRuntime();
    const pureChat = renderHook(
      () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller: fakeController() }),
      { wrapper: Providers },
    );
    expect(pureChat.result.current.workspaceAvailable).toBe(false);
    expect(pureChat.result.current.searchWorkspace).toBeUndefined();
    expect(pureChat.result.current.listWorkspaceDirectory).toBeUndefined();

    const missingWorkspace = renderHook(
      () =>
        useConversationPanelModel({
          runtime,
          sessionId: "ses-2",
          controller: fakeController({
            session: agentSession({
              session_type: "workspace",
              workspace_id: "missing",
              workspace: null,
              cwd: "D:/missing",
            }),
          }),
        }),
      { wrapper: Providers },
    );
    expect(missingWorkspace.result.current.workspaceAvailable).toBe(false);
    expect(missingWorkspace.result.current.workspaceUnavailable).toBe(true);
    expect(missingWorkspace.result.current.searchWorkspace).toBeUndefined();
    expect(runtime.workspace.search).not.toHaveBeenCalled();
  });

  it("cancels a pending row before restoring its complete structured composer draft", async () => {
    const runtime = fakeRuntime();
    const cancelPendingInput = vi.fn().mockResolvedValue(undefined);
    const restoreComposerDraft = vi.fn();
    const dispatch = vi.fn();
    const controller = fakeController({
      cancelPendingInput,
      restoreComposerDraft,
      dispatch,
    });
    const { result } = renderHook(
      () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller }),
      { wrapper: Providers },
    );

    await act(async () => {
      await result.current.editPendingInput({
        id: "pending-structured",
        pending_input_id: "pending-structured",
        session_id: "ses-1",
        mode: "queue",
        status: "queued",
        message: "继续检查",
        runtime_params: {
          message_context_items: [
            { type: "file", id: "file-1", label: "alpha.py", path: "src/alpha.py", content: "src/alpha.py" },
            {
              type: "quote",
              label: "引用",
              content: "selected code",
              metadata: { source: "selection", comment: "保留这条评论" },
            },
            { type: "skill", label: "/review", skill_name: "review", content: "Review changes" },
          ],
        },
        attachments: [
          {
            id: "att-1",
            attachment_id: "att-1",
            type: "image",
            name: "review.png",
            path: "D:/tmp/review.png",
            source: "upload",
            mime_type: "image/png",
            size: 128,
          },
        ],
      });
    });

    expect(cancelPendingInput).toHaveBeenCalledWith("pending-structured");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "event/receive",
        event: expect.objectContaining({ action: "pending_input_cancelled" }),
      }),
    );
    expect(restoreComposerDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "继续检查",
        files: [expect.objectContaining({ path: "src/alpha.py" })],
        quotes: [expect.objectContaining({ text: "selected code", comment: "保留这条评论" })],
        selectedSkill: expect.objectContaining({ name: "review" }),
        attachments: [expect.objectContaining({ attachment_id: "att-1", name: "review.png" })],
      }),
    );
  });

  it("caches successful tool detail patches by session and ref", async () => {
    const runtime = fakeRuntime();
    const controller = fakeController();
    const { result } = renderHook(
      () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller }),
      { wrapper: Providers },
    );
    const message = toolMessage();

    const first = await result.current.loadToolDetails(message);
    const second = await result.current.loadToolDetails(message);

    expect(first).toMatchObject({ payload: { toolDetailsDeferred: false } });
    expect(second).toEqual(first);
    expect(runtime.conversation.loadToolDetails).toHaveBeenCalledTimes(1);
    expect(runtime.conversation.loadToolDetails).toHaveBeenCalledWith("ses-1", {
      startEventId: "start-1",
      endEventId: "end-1",
      runId: "run-1",
      toolCallId: "call-1",
    });
  });

  it("drops failed tool detail promises so the next expansion can retry", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.conversation.loadToolDetails)
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({
        detailRef: { startEventId: "start-1", endEventId: "end-1" },
        toolName: "search_text",
        toolResult: "retry ok",
        status: "completed",
      });
    const controller = fakeController();
    const { result } = renderHook(
      () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller }),
      { wrapper: Providers },
    );

    await expect(result.current.loadToolDetails(toolMessage())).rejects.toThrow("temporary");
    await expect(result.current.loadToolDetails(toolMessage())).resolves.toMatchObject({
      payload: { result: { model_content: "retry ok" } },
    });
    expect(runtime.conversation.loadToolDetails).toHaveBeenCalledTimes(2);
  });

  it("opens file change previews through the review panel request channel", () => {
    const runtime = fakeRuntime();
    const controller = fakeController();
    const { result } = renderHook(
      () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller }),
      { wrapper: Providers },
    );

    act(() => {
      result.current.openFileChangePreview({
        path: "src/main.ts",
        diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new",
        files: [
          {
            path: "src/main.ts",
            additions: 1,
            deletions: 1,
            diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new",
            operation: "update",
          },
        ],
        title: "已编辑文件",
      });
    });

    expect(latestReviewPanelRequest).toMatchObject({
      focusedPath: "src/main.ts",
      title: "已编辑文件",
      files: [
        expect.objectContaining({
          path: "src/main.ts",
          diff: expect.stringContaining("+new"),
        }),
      ],
    });
    expect(runtime.conversation.loadToolDetails).not.toHaveBeenCalled();
  });

  it("loads deferred tool details before opening a file change review", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.conversation.loadToolDetails).mockResolvedValueOnce({
      detailRef: { startEventId: "start-file", endEventId: "end-file" },
      toolName: "apply_patch",
      toolParams: { path: "src/main.ts" },
      toolResult: "patched",
      status: "completed",
      fileChanges: [
        {
          path: "src/main.ts",
          operation: "update",
          added_lines: 1,
          deleted_lines: 1,
          diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+loaded",
        },
      ],
    });
    const controller = fakeController();
    const { result } = renderHook(
      () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller }),
      { wrapper: Providers },
    );

    act(() => {
      result.current.openFileChangePreview({
        path: "src/main.ts",
        diff: "",
        message: fileEditMessage(),
      });
    });

    await waitFor(() => {
      expect(runtime.conversation.loadToolDetails).toHaveBeenCalledWith("ses-1", {
        startEventId: "start-file",
        endEventId: "end-file",
        runId: "run-file",
        toolCallId: "call-file",
      });
      expect(latestReviewPanelRequest?.files[0]?.diff).toContain("+loaded");
    });
  });


  it("clears a selected skill when runtime reports a skill error", async () => {
    const setSelectedSkill = vi.fn();
    const runtime = fakeRuntime();
    const controller = fakeController({
      session: agentSession({
        session_type: "workspace",
        workspace_id: "ws-1",
        workspace: workspace(),
      }),
      selectedSkill: { name: "missing", label: "missing", source: "workspace", description: "", locator: "workspace:missing" },
      setSelectedSkill,
    });
    const { result } = renderHook(
      () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller }),
      { wrapper: Providers },
    );

    act(() => {
      const handled = result.current.handleRuntimeError({ code: "skill_not_found" });
      expect(handled).toBe(true);
    });

    expect(setSelectedSkill).toHaveBeenCalledWith(null);
    await waitFor(() => {
      expect(runtime.workspace.listSkills).toHaveBeenCalledWith({ sessionId: "ses-1" }, { forceReload: true });
    });
  });

  it("previews and executes code-only rewind without reloading conversation", async () => {
    const runtime = fakeRuntime();
    const reloadHistory = vi.fn().mockResolvedValue(undefined);
    const restoreComposerDraft = vi.fn();
    const controller = fakeController({ reloadHistory, restoreComposerDraft });
    const { result } = renderHook(
      () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller }),
      { wrapper: Providers },
    );

    act(() => result.current.reverseFromMessage(reverseMessage()));
    await waitFor(() => expect(result.current.reverseConfirmation?.preview).not.toBeNull());
    act(() => result.current.selectReverseMode("code"));
    act(() => result.current.confirmReverseFromMessage());
    await waitFor(() => expect(result.current.reverseConfirmation?.result?.status).toBe("full"));

    expect(runtime.conversation.previewSessionReverse).toHaveBeenCalledWith("ses-1", "event-user-1");
    expect(runtime.conversation.executeSessionReverse).toHaveBeenCalledWith(
      "ses-1",
      expect.objectContaining({ mode: "code", decision: "full", operation_id: "operation-1" }),
    );
    expect(reloadHistory).not.toHaveBeenCalled();
    expect(restoreComposerDraft).not.toHaveBeenCalled();
  });

  it("drops a late preview response after switching sessions", async () => {
    const runtime = fakeRuntime();
    let resolvePreview: ((value: ReturnType<typeof reversePreview>) => void) | null = null;
    vi.mocked(runtime.conversation.previewSessionReverse).mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
    );
    const controller = fakeController();
    const { result, rerender } = renderHook(
      ({ sessionId }) => useConversationPanelModel({ runtime, sessionId, controller }),
      { wrapper: Providers, initialProps: { sessionId: "ses-1" } },
    );

    act(() => result.current.reverseFromMessage(reverseMessage()));
    rerender({ sessionId: "ses-2" });
    await act(async () => {
      resolvePreview?.(reversePreview());
      await Promise.resolve();
    });

    expect(result.current.reverseConfirmation).toBeNull();
  });

  it("executes a conversation rewind once and applies only conversation UI side effects", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.conversation.executeSessionReverse).mockResolvedValueOnce({
      operation_id: "operation-1",
      status: "full",
      mode: "conversation",
      decision: "full",
      conversation_rewound: true,
      restored_files: [],
      skipped_files: [],
      forced_files: [],
      failed_files: [],
      restored_input: "restored draft",
      source: {},
    });
    const reloadHistory = vi.fn().mockResolvedValue(undefined);
    const restoreComposerDraft = vi.fn();
    const dispatch = vi.fn();
    const controller = fakeController({ reloadHistory, restoreComposerDraft, dispatch });
    const { result } = renderHook(
      () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller }),
      { wrapper: Providers },
    );

    act(() => result.current.reverseFromMessage(reverseMessage()));
    await waitFor(() => expect(result.current.reverseConfirmation?.preview).not.toBeNull());
    act(() => result.current.selectReverseMode("conversation"));
    act(() => result.current.confirmReverseFromMessage());
    await waitFor(() => expect(result.current.reverseConfirmation?.result?.status).toBe("full"));

    expect(reloadHistory).toHaveBeenCalledTimes(1);
    expect(restoreComposerDraft).toHaveBeenCalledWith(expect.objectContaining({ value: "restored draft" }));
    expect(runtime.conversation.getSession).toHaveBeenCalledWith("ses-1");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "session/upsert" }));
  });

  it("guards synchronous double confirmation with one execute request", async () => {
    const runtime = fakeRuntime();
    let resolveExecute: ((value: Awaited<ReturnType<RuntimeBridge["conversation"]["executeSessionReverse"]>>) => void) | null = null;
    vi.mocked(runtime.conversation.executeSessionReverse).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveExecute = resolve;
      }),
    );
    const { result } = renderHook(
      () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller: fakeController() }),
      { wrapper: Providers },
    );

    act(() => result.current.reverseFromMessage(reverseMessage()));
    await waitFor(() => expect(result.current.reverseConfirmation?.preview).not.toBeNull());
    act(() => {
      result.current.confirmReverseFromMessage();
      result.current.confirmReverseFromMessage();
    });

    expect(runtime.conversation.executeSessionReverse).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveExecute?.({
        operation_id: "operation-1",
        status: "full",
        mode: "both",
        decision: "full",
        conversation_rewound: false,
        restored_files: [],
        skipped_files: [],
        forced_files: [],
        failed_files: [],
        source: {},
      });
      await Promise.resolve();
    });
  });

  it("keeps a successful backend result when local conversation refresh fails", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.conversation.executeSessionReverse).mockResolvedValueOnce({
      operation_id: "operation-1",
      status: "full",
      mode: "both",
      decision: "full",
      conversation_rewound: true,
      restored_files: ["src/a.ts"],
      skipped_files: [],
      forced_files: [],
      failed_files: [],
      restored_input: "restored draft",
      source: {},
    });
    const controller = fakeController({ reloadHistory: vi.fn().mockRejectedValue(new Error("local refresh")) });
    const { result } = renderHook(
      () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller }),
      { wrapper: Providers },
    );

    act(() => result.current.reverseFromMessage(reverseMessage()));
    await waitFor(() => expect(result.current.reverseConfirmation?.preview).not.toBeNull());
    act(() => result.current.confirmReverseFromMessage());
    await waitFor(() => expect(result.current.reverseConfirmation?.result?.status).toBe("full"));

    expect(result.current.reverseConfirmation?.error).toBeNull();
    expect(result.current.reverseConfirmation?.result?.restored_files).toEqual(["src/a.ts"]);
  });

  it.each(["compensated", "compensation_failed", "blocked"] as const)(
    "loads the persisted %s terminal result after execute rejects",
    async (status) => {
      const runtime = fakeRuntime();
      vi.mocked(runtime.conversation.executeSessionReverse).mockRejectedValueOnce({
        code: "file_restore_failed",
        message: "restore failed",
      });
      vi.mocked(runtime.conversation.getSessionReverseStatus).mockResolvedValueOnce({
        operation_id: "operation-1",
        status,
        error_code: status === "compensated" ? "file_restore_failed" : "file_restore_compensation_failed",
        blocked_paths: status === "compensated" ? [] : ["src/a.ts"],
        result: {
          operation_id: "operation-1",
          status,
          mode: "both",
          decision: "full",
          conversation_rewound: false,
          restored_files: [],
          skipped_files: [],
          forced_files: [],
          failed_files: status === "compensated" ? [] : ["src/a.ts"],
          source: {},
        },
      });
      const { result } = renderHook(
        () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller: fakeController() }),
        { wrapper: Providers },
      );

      act(() => result.current.reverseFromMessage(reverseMessage()));
      await waitFor(() => expect(result.current.reverseConfirmation?.preview).not.toBeNull());
      act(() => result.current.confirmReverseFromMessage());

      await waitFor(() => expect(result.current.reverseConfirmation?.result?.status).toBe(status));
      expect(runtime.conversation.getSessionReverseStatus).toHaveBeenCalledWith("ses-1", "operation-1");
      expect(result.current.reverseConfirmation?.phase).toBe("result");
    },
  );
});

function Providers({ children }: PropsWithChildren) {
  return (
    <NotificationProvider>
      <PreviewProvider>
        <PreviewProbe />
        {children}
      </PreviewProvider>
    </NotificationProvider>
  );
}

function PreviewProbe() {
  const preview = usePreview();
  latestReviewPanelRequest = preview.reviewPanelRequest;
  return null;
}

function fakeController(overrides: Partial<AgentSessionController> = {}): AgentSessionController {
  return {
    state: {},
    dispatch: vi.fn(),
    session: null,
    sessionViewState: null,
    agentMessages: [],
    runtimeState: "idle" as ConversationRuntimeState,
    pendingApproval: null,
    draft: "",
    setDraft: vi.fn(),
    selectedSkill: null,
    setSelectedSkill: vi.fn(),
    fileChipRequest: null,
    quoteChipRequest: null,
    loading: false,
    loadingOlderHistory: false,
    wsStatus: "open",
    runtimeDetail: null,
    setRuntimeDetail: vi.fn(),
    connectionReady: true,
    canSend: true,
    canStop: false,
    usingSharedRuntime: false,
    quoteSelection: vi.fn(),
    startChatFromAnnotation: vi.fn(),
    loadOlderHistory: vi.fn(),
    sendText: vi.fn(),
    send: vi.fn(),
    stop: vi.fn(),
    submitApproval: vi.fn(),
    approvalSubmitting: false,
    approvalError: null,
    ...overrides,
  } as unknown as AgentSessionController;
}

function fakeRuntime(): RuntimeBridge {
  return {
    conversation: {
      loadToolDetails: vi.fn().mockResolvedValue({
        detailRef: { startEventId: "start-1", endEventId: "end-1" },
        toolName: "search_text",
        toolParams: { query: "needle" },
        toolResult: "loaded result",
        status: "completed",
      }),
      previewSessionReverse: vi.fn().mockResolvedValue(reversePreview()),
      executeSessionReverse: vi.fn().mockResolvedValue({
        operation_id: "operation-1",
        status: "full",
        mode: "code",
        decision: "full",
        conversation_rewound: false,
        restored_files: [],
        skipped_files: [],
        forced_files: [],
        failed_files: [],
        source: {},
      }),
      getSessionReverseStatus: vi.fn().mockResolvedValue({
        operation_id: "operation-1",
        status: "full",
        result: null,
        error_code: null,
        blocked_paths: [],
      }),
      getSession: vi.fn().mockResolvedValue(agentSession()),
    },
    workspace: {
      search: vi.fn().mockResolvedValue([]),
      listDirectory: vi.fn().mockResolvedValue({
        root: "/",
        entries: [{ path: "README.md", name: "README.md", type: "file" }],
      }),
      listSkills: vi.fn().mockResolvedValue({
        workspace_root: "D:/repo/keydex",
        skills: [],
        diagnostics: [],
        fingerprint: "empty",
        loaded_at: "2026-06-27T00:00:00Z",
      }),
    },
  } as unknown as RuntimeBridge;
}

function workspace(): Workspace {
  return {
    id: "ws-1",
    name: "keydex",
    root_path: "D:/repo/keydex",
    created_at: "2026-06-27T00:00:00Z",
    updated_at: "2026-06-27T00:00:00Z",
  } as Workspace;
}

function agentSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "ses-1",
    title: "Session",
    session_type: "chat",
    workspace_id: null,
    workspace: null,
    cwd: null,
    created_at: "2026-06-27T00:00:00Z",
    updated_at: "2026-06-27T00:00:00Z",
    ...overrides,
  } as AgentSession;
}

function toolMessage() {
  return {
    id: "message-1",
    threadId: "ses-1",
    turnId: "turn-1",
    itemId: "item-1",
    kind: "tool",
    status: "completed",
    content: "",
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    payload: {
      call: { name: "search_text", arguments: { query: "needle" } },
      result: { status: "success" },
      toolDetailRef: {
        startEventId: "start-1",
        endEventId: "end-1",
        runId: "run-1",
        toolCallId: "call-1",
      },
      toolDetailsDeferred: true,
    },
  } as const;
}

function reverseMessage() {
  return {
    id: "message-user-1",
    threadId: "ses-1",
    turnId: "turn-1",
    itemId: "item-user-1",
    kind: "user",
    status: "completed",
    content: "restore this",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    payload: { messageEventId: "event-user-1" },
  } as const;
}

function reversePreview() {
  return {
    operation_id: "operation-1",
    source: { message_event_id: "event-user-1" },
    conversation_available: true,
    code_available: true,
    default_mode: "both" as const,
    snapshot_id: "snapshot-1",
    preview_token: "preview-token",
    files: [],
    insertions: 0,
    deletions: 0,
    warnings: [],
  };
}

function fileEditMessage() {
  return {
    id: "message-file",
    threadId: "ses-1",
    turnId: "turn-1",
    itemId: "item-file",
    kind: "tool",
    status: "completed",
    content: "apply_patch",
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    payload: {
      call: { id: "call-file", name: "apply_patch", arguments: { path: "src/main.ts" } },
      result: {
        status: "success",
        files: [{ path: "src/main.ts", operation: "update", added_lines: 1, deleted_lines: 1 }],
      },
      files: [{ path: "src/main.ts", operation: "update", added_lines: 1, deleted_lines: 1 }],
      toolDetailRef: {
        startEventId: "start-file",
        endEventId: "end-file",
        runId: "run-file",
        toolCallId: "call-file",
      },
      toolDetailsDeferred: true,
    },
  } as const;
}
