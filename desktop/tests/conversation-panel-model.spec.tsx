import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "../src/runtime";
import { fileReviewDocumentFromChanges } from "../src/renderer/components/diff/adapters/fileReviewDocument";
import type { AgentSessionController } from "../src/renderer/hooks/useAgentSessionController";
import {
  contextWindowUsageUpdateFromProgress,
  useConversationPanelModel,
} from "../src/renderer/pages/conversation/useConversationPanelModel";
import { NotificationProvider } from "../src/renderer/providers/NotificationProvider";
import { PreviewProvider, usePreview, type ReviewPanelRequest } from "../src/renderer/providers/PreviewProvider";
import type { ConversationRuntimeState } from "../src/renderer/stores/conversationStore";
import type { AgentSession, Workspace } from "../src/types/protocol";

let latestReviewPanelRequest: ReviewPanelRequest | null = null;

describe("useConversationPanelModel", () => {
  beforeEach(() => {
    latestReviewPanelRequest = null;
  });

  it("clears context window usage only when the current session finishes compression", () => {
    expect(contextWindowUsageUpdateFromProgress({
      middleware: "ContextCompressionMiddleware",
      stage: "compression_completed",
      session_id: "ses-1",
      active_session_id: "ses-1",
    }, "ses-1")).toBeNull();

    expect(contextWindowUsageUpdateFromProgress({
      middleware: "ContextCompressionMiddleware",
      stage: "compression_completed",
      session_id: "ses-2",
      active_session_id: "ses-2",
    }, "ses-1")).toBeUndefined();
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
    await waitFor(() => expect(runtime.skills.listSession).toHaveBeenCalled());
  });

  it("routes Sub-Agent workspace resources through the visible parent Session", async () => {
    const runtime = fakeRuntime();
    const controller = fakeController({
      session: agentSession({
        id: "subagent-session-1",
        session_type: "workspace",
        workspace_id: "ws-1",
        workspace: workspace(),
        cwd: "D:/repo/keydex",
      }),
    });

    const { result } = renderHook(
      () => useConversationPanelModel({
        runtime,
        sessionId: "subagent-session-1",
        controller,
        subagentContext: {
          parentSessionId: "parent-session-1",
          runId: "subagent-run-1",
        },
      }),
      { wrapper: Providers },
    );

    expect(result.current.messageWorkspaceScope).toEqual({ sessionId: "parent-session-1" });
    expect(result.current.previewRenderContext.sessionId).toBe("parent-session-1");

    await act(async () => {
      await result.current.searchWorkspace?.("README", { signal: undefined });
      await result.current.listWorkspaceDirectory?.("/");
    });

    expect(runtime.workspace.search).toHaveBeenCalledWith(
      { sessionId: "parent-session-1" },
      "README",
      { signal: undefined },
    );
    expect(runtime.workspace.listDirectory).toHaveBeenCalledWith({ sessionId: "parent-session-1" }, "/");
    await waitFor(() => {
      expect(runtime.skills.listSession).toHaveBeenCalledWith(
        "parent-session-1",
        expect.objectContaining({ forceReload: false, signal: expect.any(AbortSignal) }),
      );
    });
  });

  it("keeps pure chat and unavailable workspace sessions out of workspace file search without disabling session skills", async () => {
    const runtime = fakeRuntime();
    const pureChat = renderHook(
      () => useConversationPanelModel({
        runtime,
        sessionId: "ses-1",
        controller: fakeController({ session: agentSession({ session_type: "chat" }) }),
      }),
      { wrapper: Providers },
    );
    expect(pureChat.result.current.workspaceAvailable).toBe(false);
    expect(pureChat.result.current.searchWorkspace).toBeUndefined();
    expect(pureChat.result.current.listWorkspaceDirectory).toBeUndefined();
    await waitFor(() => {
      expect(runtime.skills.listSession).toHaveBeenCalledWith(
        "ses-1",
        expect.objectContaining({ forceReload: false, signal: expect.any(AbortSignal) }),
      );
    });

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
    expect(missingWorkspace.result.current.listWorkspaceDirectory).toBeUndefined();
    await waitFor(() => {
      expect(runtime.skills.listSession).toHaveBeenCalledWith(
        "ses-2",
        expect.objectContaining({ forceReload: false, signal: expect.any(AbortSignal) }),
      );
    });
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
            {
              type: "web_annotation",
              id: "web-annotation:web-history:history-digest",
              label: "网页批注 · History",
              content: "Immutable web history",
              metadata: {
                annotation_id: "web-history",
                snapshot_digest: "history-digest",
                snapshot: {
                  schemaVersion: 1,
                  type: "web_annotation",
                  annotationId: "web-history",
                  annotationRevision: 2,
                  capturedAt: "2026-07-22T08:00:00Z",
                  source: {
                    title: "History",
                    url: "https://example.test/history",
                    urlKey: "f".repeat(64),
                    origin: "https://example.test",
                  },
                  target: {
                    type: "region",
                    summary: "History region",
                    resolution: "orphaned",
                    freshness: "last-known",
                  },
                  evidence: { attachmentId: "att-1" },
                  annotation: { bodyMarkdown: "Historical note", tags: [], properties: [] },
                  digest: "history-digest",
                },
              },
            },
          ],
        },
        attachments: [
          {
            id: "att-1",
            attachment_id: "att-1",
            type: "image",
            name: "review.png",
            path: "D:/tmp/review.png",
            source: "web_annotation",
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
        webAnnotations: [expect.objectContaining({ annotationId: "web-history", selectedRevision: 2 })],
        replayedContextItems: [expect.objectContaining({
          type: "web_annotation",
          metadata: expect.objectContaining({ snapshot_digest: "history-digest" }),
        })],
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
      () => useConversationPanelModel({
        runtime,
        sessionId: "ses-1",
        controller,
        previewPanelScopeKey: "sidebar:parent-session",
      }),
      { wrapper: Providers },
    );

    const files = [
      {
        path: "src/main.ts",
        additions: 1,
        deletions: 1,
        diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new",
        operation: "update" as const,
      },
    ];
    const document = fileReviewDocumentFromChanges(files, {
      sessionId: "ses-1",
      requestId: "message-file",
    });
    act(() => {
      result.current.openFileChangePreview({
        path: "src/main.ts",
        diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new",
        files,
        document,
        title: "已编辑文件",
      });
    });

    expect(latestReviewPanelRequest).toMatchObject({
      scopeKey: "sidebar:parent-session",
      focusedPath: "src/main.ts",
      title: "已编辑文件",
      files: [
        expect.objectContaining({
          path: "src/main.ts",
          diff: expect.stringContaining("+new"),
        }),
      ],
    });
    expect(latestReviewPanelRequest?.document).toBe(document);
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

  it("drops a deferred review result after the active session changes", async () => {
    let resolveDetails: ((value: Awaited<ReturnType<RuntimeBridge["conversation"]["loadToolDetails"]>>) => void) | null = null;
    const runtime = fakeRuntime();
    vi.mocked(runtime.conversation.loadToolDetails).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveDetails = resolve;
      }),
    );
    const controller = fakeController();
    const { result, rerender } = renderHook(
      ({ activeSessionId }) => useConversationPanelModel({ runtime, sessionId: activeSessionId, controller }),
      { wrapper: Providers, initialProps: { activeSessionId: "ses-1" } },
    );

    act(() => {
      result.current.openFileChangePreview({
        path: "src/main.ts",
        diff: "",
        message: fileEditMessage(),
      });
    });
    expect(runtime.conversation.loadToolDetails).toHaveBeenCalledTimes(1);

    rerender({ activeSessionId: "ses-2" });
    await act(async () => {
      resolveDetails?.({
        detailRef: { startEventId: "start-file", endEventId: "end-file" },
        toolName: "apply_patch",
        toolParams: { path: "src/main.ts" },
        toolResult: "patched",
        status: "completed",
        fileChanges: [{
          path: "src/main.ts",
          operation: "update",
          added_lines: 1,
          deleted_lines: 1,
          diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+stale",
        }],
      });
      await Promise.resolve();
    });

    expect(latestReviewPanelRequest).toBeNull();
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
      expect(runtime.skills.listSession).toHaveBeenCalledWith(
        "ses-1",
        expect.objectContaining({ forceReload: true, signal: expect.any(AbortSignal) }),
      );
    });
  });

  it("refreshes Conversation Skills only for matching Skills capability events", async () => {
    const runtime = fakeRuntime();
    const controller = fakeController({
      session: agentSession({ session_type: "workspace", workspace_id: "ws-1" }),
    });
    const { result } = renderHook(
      () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller }),
      { wrapper: Providers },
    );
    await waitFor(() => expect(runtime.skills.listSession).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.handleRuntimeEventSideEffects({
        action: "keydexWorkspaceChanged",
        data: {
          session_id: "ses-1",
          changed_capabilities: ["keydex_markdown"],
          capability_fingerprints: { keydex_markdown: "markdown-2" },
        },
      });
    });
    expect(runtime.skills.listSession).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.handleRuntimeEventSideEffects({
        action: "keydexWorkspaceChanged",
        data: {
          session_id: "ses-1",
          changed_capabilities: ["skills"],
          capability_fingerprints: { skills: "skills-2" },
        },
      });
    });
    await waitFor(() => {
      expect(runtime.skills.listSession).toHaveBeenCalledWith(
        "ses-1",
        expect.objectContaining({ forceReload: true }),
      );
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

  it("requires explicit external confirmation and forwards it to execution", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.conversation.previewSessionReverse).mockResolvedValueOnce({
      ...reversePreview(),
      requires_external_confirmation: true,
      external_paths: ["D:/outside/file.txt"],
      files: [{
        resource_id: "resource-external",
        scope_kind: "external",
        scope_identity: "external:d",
        scope_label: "D: external",
        display_path: "file.txt",
        absolute_path: "D:/outside/file.txt",
        requires_full_access: true,
        path: "file.txt",
        current_state: "file",
        target_state: "file",
        classification: "ready",
        binary: false,
        truncated: false,
        insertions: 1,
        deletions: 1,
      }],
    });
    const { result } = renderHook(
      () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller: fakeController() }),
      { wrapper: Providers },
    );

    act(() => result.current.reverseFromMessage(reverseMessage()));
    await waitFor(() => expect(result.current.reverseConfirmation?.preview).not.toBeNull());
    act(() => result.current.confirmReverseFromMessage());
    expect(runtime.conversation.executeSessionReverse).not.toHaveBeenCalled();

    act(() => result.current.confirmExternalReversePaths(true));
    act(() => result.current.confirmReverseFromMessage());
    await waitFor(() => expect(runtime.conversation.executeSessionReverse).toHaveBeenCalledTimes(1));
    expect(runtime.conversation.executeSessionReverse).toHaveBeenCalledWith(
      "ses-1",
      expect.objectContaining({ confirm_external_paths: true }),
    );
  });

  it("preserves the fork-boundary error code when reverse preview is rejected", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.conversation.previewSessionReverse).mockRejectedValueOnce({
      detail: {
        code: "reverse_before_fork_point",
        message: "无法回溯到派生点之前的会话轮次",
      },
    });
    const { result } = renderHook(
      () => useConversationPanelModel({ runtime, sessionId: "ses-1", controller: fakeController() }),
      { wrapper: Providers },
    );

    act(() => result.current.reverseFromMessage(reverseMessage()));

    await waitFor(() => {
      expect(result.current.reverseConfirmation?.loading).toBe(false);
      expect(result.current.reverseConfirmation?.errorCode).toBe("reverse_before_fork_point");
    });
  });

  it("keeps message fork state pending and suppresses duplicate confirmation until the request settles", async () => {
    const runtime = fakeRuntime();
    const response = {
      session: agentSession({ id: "ses-fork" }),
      source: {
        session_id: "ses-1",
        active_session_id: "ses-1",
        checkpoint_id: "checkpoint-1",
        checkpoint_ns: "",
        trace_id: "trace-1",
        turn_index: 1,
        message_event_id: "event-user-1",
        source_type: "message_event",
      },
    };
    let resolveFork: ((value: typeof response) => void) | null = null;
    vi.mocked(runtime.conversation.forkSession).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFork = resolve;
      }),
    );
    const onForkSessionCreated = vi.fn();
    const { result } = renderHook(
      () => useConversationPanelModel({
        runtime,
        sessionId: "ses-1",
        controller: fakeController(),
        onForkSessionCreated,
      }),
      { wrapper: Providers },
    );

    act(() => result.current.forkFromMessage(reverseMessage()));
    act(() => {
      result.current.confirmForkFromMessage();
      result.current.confirmForkFromMessage();
      result.current.cancelForkFromMessage();
    });

    expect(runtime.conversation.forkSession).toHaveBeenCalledTimes(1);
    expect(result.current.forkExecuting).toBe(true);
    expect(result.current.forkConfirmation).not.toBeNull();

    await act(async () => {
      resolveFork?.(response);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.forkExecuting).toBe(false));
    expect(result.current.forkConfirmation).toBeNull();
    expect(onForkSessionCreated).toHaveBeenCalledWith(response.session);
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

  it("closes the result dialog after a successful conversation-only rewind", async () => {
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
    await waitFor(() => expect(result.current.reverseConfirmation).toBeNull());

    await waitFor(() => expect(reloadHistory).toHaveBeenCalledTimes(1));
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
    composerDraft: {
      text: "",
      selectedSkill: null,
      files: [],
      quotes: [],
      attachments: [],
      webAnnotations: [],
      replayedContextItems: [],
      updatedAt: 0,
    },
    setComposerDraft: vi.fn(),
    clearComposerDraft: vi.fn(),
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
      forkSession: vi.fn().mockResolvedValue({
        session: agentSession({ id: "ses-fork" }),
        source: {
          session_id: "ses-1",
          active_session_id: "ses-1",
          checkpoint_id: "checkpoint-1",
          checkpoint_ns: "",
          trace_id: "trace-1",
          turn_index: 1,
          message_event_id: "event-user-1",
          source_type: "message_event",
        },
      }),
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
    skills: {
      listSession: vi.fn().mockResolvedValue({
        mode: "workspace_effective",
        workspace_root: "D:/repo/keydex",
        skills: [],
        diagnostics: [],
        fingerprint: "empty",
        loaded_at: "2026-06-27T00:00:00Z",
      }),
    },
    workspace: {
      search: vi.fn().mockResolvedValue([]),
      listDirectory: vi.fn().mockResolvedValue({
        root: "/",
        entries: [{ path: "README.md", name: "README.md", type: "file" }],
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
    requires_external_confirmation: false,
    external_paths: [],
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
