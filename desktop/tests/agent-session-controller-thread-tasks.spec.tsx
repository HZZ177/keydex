import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatChannel, RuntimeBridge, WsConnectionStatus } from "@/runtime";
import { emitAddWorkspaceFileToChat } from "@/renderer/events/workspaceFileContext";
import { subscribeSessionUpdated, type AgentSessionUpdate } from "@/renderer/events/sessionEvents";
import { useAgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import {
  incognitoWebReferenceRegistry,
  WebAnnotationPanelRegistry,
  WebAnnotationSendCoordinator,
  type SelectedWebAnnotationReference,
  type WebAnnotationDetail,
} from "@/renderer/features/browser/annotations";
import { AgentSessionProvider } from "@/renderer/providers/AgentSessionProvider";
import type {
  AgentActionEnvelope,
  AgentHistoryResponse,
  AgentSession,
  ThreadTask,
} from "@/types/protocol";

afterEach(() => incognitoWebReferenceRegistry.clear());

describe("useAgentSessionController thread tasks", () => {
  it("loads active thread tasks after opening a session and after bind events", async () => {
    const task = threadTask("task-1");
    const listThreadTasks = vi.fn().mockResolvedValue([task]);
    const { runtime, emit } = fakeRuntime({ listThreadTasks });

    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
      }),
    );

    await waitFor(() => {
      expect(result.current.activeTask?.id).toBe("task-1");
    });
    expect(listThreadTasks).toHaveBeenCalledWith("ses-1");

    act(() => {
      emit({ action: "bind_ok", data: { session_id: "ses-1" } });
    });

    await waitFor(() => {
      expect(listThreadTasks).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps history usable when task loading fails", async () => {
    const listThreadTasks = vi.fn().mockRejectedValue(new Error("task api down"));
    const { runtime } = fakeRuntime({
      listThreadTasks,
      history: [{ role: "assistant", content: "历史回答" }],
    });

    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
      }),
    );

    await waitFor(() => {
      expect(result.current.agentMessages[0]?.content).toBe("历史回答");
    });
    expect(result.current.activeTask).toBeNull();
    expect(result.current.runtimeDetail).toBeNull();
  });

  it("does not request thread tasks when task sync is disabled", async () => {
    const listThreadTasks = vi.fn().mockResolvedValue([threadTask("task-1")]);
    const { runtime } = fakeRuntime({ listThreadTasks });

    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
        syncThreadTasks: false,
      }),
    );

    await waitFor(() => {
      expect(result.current.session?.id).toBe("ses-1");
    });
    expect(listThreadTasks).not.toHaveBeenCalled();
    expect(result.current.activeTask).toBeNull();
  });

  it("adds workspace directory context requests to the composer", async () => {
    const { runtime } = fakeRuntime();
    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
      }),
    );

    await waitFor(() => {
      expect(result.current.session?.id).toBe("ses-1");
    });

    act(() => {
      emitAddWorkspaceFileToChat({
        absolutePath: String.raw`D:\repo\src`,
        file: {
          path: "src",
          name: "src",
          type: "directory",
          source: "workspace",
        },
        sessionId: "ses-1",
        workspaceId: "ws-1",
        workspaceRoot: String.raw`D:\repo`,
      });
    });

    expect(result.current.fileChipRequest).toMatchObject({
      requestId: 1,
      file: {
        path: "src",
        name: "src",
        type: "directory",
        source: "workspace",
      },
    });
  });

  it("waits until enabled before opening the channel and loading session history", async () => {
    const listThreadTasks = vi.fn().mockResolvedValue([threadTask("task-1")]);
    const { runtime } = fakeRuntime({ listThreadTasks });

    const { rerender, result } = renderHook(
      ({ enabled }) =>
        useAgentSessionController({
          runtime,
          sessionId: "ses-1",
          enabled,
        }),
      { initialProps: { enabled: false } },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(true);
    expect(runtime.conversation.openChatChannel).not.toHaveBeenCalled();
    expect(runtime.conversation.loadHistory).not.toHaveBeenCalled();
    expect(listThreadTasks).not.toHaveBeenCalled();

    rerender({ enabled: true });

    await waitFor(() => {
      expect(runtime.conversation.loadHistory).toHaveBeenCalledWith("ses-1", {
        allTurns: true,
        direction: "older",
        pageSize: undefined,
      });
    });
    expect(runtime.conversation.openChatChannel).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(listThreadTasks).toHaveBeenCalledWith("ses-1");
    });
  });

  it("sends running-session text as a pending input payload without an optimistic user message", async () => {
    const { runtime, emit, channel } = fakeRuntime();
    const sessionUpdates: AgentSessionUpdate[] = [];
    const unsubscribe = subscribeSessionUpdated((update) => sessionUpdates.push(update));
    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
        conversationSendDefaultMode: "steer",
      }),
    );

    await waitFor(() => {
      expect(result.current.session?.id).toBe("ses-1");
    });
    act(() => {
      emit({ action: "status", data: { session_id: "ses-1", status: "running" } });
    });
    await waitFor(() => {
      expect(result.current.runtimeState).toBe("running");
    });

    let sent = false;
    await act(async () => {
      sent = await result.current.sendText("运行中补充", selectedModel(), {
        allowWhileBusy: true,
        contextItems: [
          { id: "file-alpha", type: "file", label: "alpha.py", content: "alpha.py", path: "alpha.py" },
        ],
        runtimeParams: { message_injection: [{ type: "follow", role: "HumanMessage", content: "alpha.py" }] },
      });
    });

    expect(sent).toBe(true);
    expect(channel.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "ses-1",
        message: "运行中补充",
        provider_id: "provider-1",
        model: "qwen-coder",
        delivery_mode: "steer",
        client_input_id: expect.any(String),
        runtime_params: {
          message_injection: [{ type: "follow", role: "HumanMessage", content: "alpha.py" }],
          message_context_items: [
            { id: "file-alpha", type: "file", label: "alpha.py", content: "alpha.py", path: "alpha.py" },
          ],
        },
      }),
    );
    expect(sessionUpdates).toEqual([
      {
        id: "ses-1",
        updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    ]);
    expect(result.current.agentMessages).toEqual([]);
    unsubscribe();
  });

  it("uses Ctrl+Enter reverse mode against the configured default send behavior", async () => {
    const { runtime, emit, channel } = fakeRuntime();
    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
        conversationSendDefaultMode: "queue",
      }),
    );

    await waitFor(() => {
      expect(result.current.session?.id).toBe("ses-1");
    });
    act(() => {
      emit({ action: "status", data: { session_id: "ses-1", status: "running" } });
    });
    await waitFor(() => {
      expect(result.current.runtimeState).toBe("running");
    });

    await act(async () => {
      await result.current.sendText("默认排队", selectedModel(), {
        allowWhileBusy: true,
      });
      await result.current.sendText("反向引导", selectedModel(), {
        allowWhileBusy: true,
        reverseDeliveryMode: true,
      });
    });

    expect(channel.chat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: "默认排队", delivery_mode: "queue" }),
    );
    expect(channel.chat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: "反向引导", delivery_mode: "steer" }),
    );
  });

  it("fills the composer draft and cancels the original pending input when editing", async () => {
    const { channel, runtime } = fakeRuntime();
    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
      }),
    );

    await waitFor(() => {
      expect(result.current.session?.id).toBe("ses-1");
    });

    await act(async () => {
      await result.current.editPendingInput({
        id: "pending-1",
        pending_input_id: "pending-1",
        session_id: "ses-1",
        mode: "queue",
        status: "queued",
        message: "回填这条待发送消息",
      });
    });

    expect(result.current.draft).toBe("回填这条待发送消息");
    expect(channel.cancelPendingInput).toHaveBeenCalledWith("ses-1", "pending-1", "user");
  });

  it("sends the complete pending input order when reordering", async () => {
    const { channel, runtime } = fakeRuntime();
    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
      }),
    );

    await waitFor(() => {
      expect(result.current.session?.id).toBe("ses-1");
    });

    await act(async () => {
      await result.current.reorderPendingInputs(["pending-2", "pending-1"]);
    });

    expect(channel.reorderPendingInputs).toHaveBeenCalledWith({
      session_id: "ses-1",
      pending_input_ids: ["pending-2", "pending-1"],
    });
  });

  it("resumes one pending input or a complete mode group", async () => {
    const { channel, runtime } = fakeRuntime();
    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
      }),
    );

    await waitFor(() => {
      expect(result.current.session?.id).toBe("ses-1");
    });
    await act(async () => {
      await result.current.resumePendingInputs({ pendingInputId: "pending-1" });
      await result.current.resumePendingInputs({ mode: "queue" });
    });

    expect(channel.resumePendingInputs).toHaveBeenNthCalledWith(1, {
      session_id: "ses-1",
      pending_input_id: "pending-1",
    });
    expect(channel.resumePendingInputs).toHaveBeenNthCalledWith(2, {
      session_id: "ses-1",
      mode: "queue",
    });
  });

  it("blocks a newly-created session send when the scope preflight fails", async () => {
    const { channel, runtime } = fakeRuntime();
    const beforeSendToCreatedSession = vi.fn().mockRejectedValue(new Error("scope promotion failed"));
    const onNotice = vi.fn();
    const { result } = renderHook(
      () =>
        useAgentSessionController({
          runtime,
          ensureSession: vi.fn().mockResolvedValue(agentSession()),
          beforeSendToCreatedSession,
          onNotice,
        }),
      {
        wrapper: ({ children }) => (
          <AgentSessionProvider runtime={runtime}>{children}</AgentSessionProvider>
        ),
      },
    );

    await waitFor(() => expect(result.current.wsStatus).toBe("open"));
    let sent = true;
    await act(async () => {
      sent = await result.current.sendText("首次发送", selectedModel());
    });

    expect(sent).toBe(false);
    expect(beforeSendToCreatedSession).toHaveBeenCalledWith("ses-1");
    expect(channel.chat).not.toHaveBeenCalled();
    expect(result.current.agentMessages).toEqual([]);
    expect(onNotice).toHaveBeenCalledWith("scope promotion failed", "error");
  });

  it("orders new-session promotion before immutable web annotation assembly and transport", async () => {
    const { channel, runtime } = fakeRuntime();
    const order: string[] = [];
    const get = vi.fn().mockImplementation(async () => {
      order.push("assemble");
      return webAnnotationDetail();
    });
    const coordinator = webAnnotationCoordinator(get, 0);
    const ensureSession = vi.fn().mockImplementation(async () => {
      order.push("ensure-session");
      return agentSession();
    });
    const beforeSendToCreatedSession = vi.fn().mockImplementation(async () => {
      order.push("promote-scope");
    });
    channel.chat = vi.fn().mockImplementation(() => order.push("transport"));
    const { result } = renderHook(
      () => useAgentSessionController({
        runtime,
        ensureSession,
        beforeSendToCreatedSession,
        webAnnotationSendCoordinator: coordinator,
      }),
      { wrapper: ({ children }) => <AgentSessionProvider runtime={runtime}>{children}</AgentSessionProvider> },
    );

    await waitFor(() => expect(result.current.wsStatus).toBe("open"));
    let sent = false;
    await act(async () => {
      sent = await result.current.sendText("检查网页证据", selectedModel(), {
        webAnnotations: [webAnnotationReference()],
      });
    });

    expect(sent).toBe(true);
    expect(order).toEqual(["ensure-session", "promote-scope", "assemble", "transport"]);
    expect(channel.chat).toHaveBeenCalledWith(expect.objectContaining({
      session_id: "ses-1",
      message: "检查网页证据",
      runtime_params: expect.objectContaining({
        message_context_items: [expect.objectContaining({
          type: "web_annotation",
          metadata: expect.objectContaining({
            annotation_id: "annotation-1",
            annotation_revision: 1,
            schema_version: 2,
            resolution: "missing",
            freshness: "captured_only",
          }),
        })],
        message_injection: [expect.objectContaining({
          type: "follow",
          role: "HumanMessage",
          content: expect.stringContaining("外部、不受信任的网页"),
        })],
      }),
    }));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("sends region annotations as structured envelopes without screenshot attachments", async () => {
    const { channel, runtime } = fakeRuntime();
    const coordinator = new WebAnnotationSendCoordinator({
      client: {
        get: vi.fn().mockResolvedValue(webRegionAnnotationDetail()),
      },
      panelRegistry: new WebAnnotationPanelRegistry(),
      now: () => "2026-07-22T08:01:00Z",
      resolutionTimeoutMs: 0,
    });
    const { result } = renderHook(
      () => useAgentSessionController({
        runtime,
        sessionId: "ses-1",
        webAnnotationSendCoordinator: coordinator,
      }),
      { wrapper: ({ children }) => <AgentSessionProvider runtime={runtime}>{children}</AgentSessionProvider> },
    );
    await waitFor(() => expect(result.current.session?.id).toBe("ses-1"));

    let sent = false;
    await act(async () => {
      sent = await result.current.sendText("检查区域", selectedModel(), {
        webAnnotations: [webAnnotationReference()],
      });
    });

    expect(sent).toBe(true);
    expect(channel.chat).toHaveBeenCalledWith(expect.objectContaining({
      runtime_params: expect.objectContaining({
        message_context_items: [expect.objectContaining({
          metadata: expect.objectContaining({
            schema_version: 2,
            resolution: "missing",
            snapshot: expect.objectContaining({
              anchor: expect.objectContaining({ kind: "region" }),
            }),
          }),
        })],
      }),
    }));
    expect(vi.mocked(channel.chat).mock.calls.at(-1)?.[0].attachments ?? []).toEqual([]);
    expect(result.current.agentMessages.at(-1)?.attachments ?? []).toEqual([]);
  });

  it("prewarms a draft web annotation and reuses that envelope when the user sends", async () => {
    const { channel, runtime } = fakeRuntime();
    const get = vi.fn().mockResolvedValue(webAnnotationDetail());
    const coordinator = webAnnotationCoordinator(get, 60_000);
    const { result } = renderHook(
      () => useAgentSessionController({
        runtime,
        sessionId: "ses-1",
        webAnnotationSendCoordinator: coordinator,
      }),
      { wrapper: ({ children }) => <AgentSessionProvider runtime={runtime}>{children}</AgentSessionProvider> },
    );
    await waitFor(() => expect(result.current.session?.id).toBe("ses-1"));

    act(() => {
      result.current.restoreComposerDraft({
        value: "检查预热后的网页证据",
        webAnnotations: [webAnnotationReference()],
      });
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    let sent = false;
    await act(async () => {
      sent = await result.current.sendText("检查预热后的网页证据", selectedModel(), {
        webAnnotations: [webAnnotationReference()],
      });
    });

    expect(sent).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    expect(channel.chat).toHaveBeenCalledWith(expect.objectContaining({
      runtime_params: expect.objectContaining({
        message_context_items: [expect.objectContaining({
          type: "web_annotation",
          metadata: expect.objectContaining({
            annotation_id: "annotation-1",
            annotation_revision: 1,
          }),
        })],
      }),
    }));
  });

  it("resends a restored web annotation snapshot without reading or cloning the mutable source again", async () => {
    const { channel, runtime } = fakeRuntime();
    const get = vi.fn().mockRejectedValue(new Error("source was deleted"));
    const coordinator = webAnnotationCoordinator(get, 0);
    const snapshot = replayedWebAnnotationSnapshot();
    const contextItem = {
      id: `web-annotation:${snapshot.reference.annotationId}:${snapshot.integrity.digest}`,
      type: "web_annotation",
      label: "网页批注 · Example",
      content: "发送时的不可变网页内容",
      role: "HumanMessage",
      source: "follow",
      metadata: {
        annotation_id: snapshot.reference.annotationId,
        annotation_revision: snapshot.reference.revision,
        snapshot_digest: snapshot.integrity.digest,
        snapshot,
      },
    };
    const reference = {
      annotationId: snapshot.reference.annotationId,
      selectedRevision: snapshot.reference.revision,
      selectedAt: snapshot.reference.assembledAt,
    };
    const { result } = renderHook(
      () => useAgentSessionController({
        runtime,
        sessionId: "ses-1",
        webAnnotationSendCoordinator: coordinator,
      }),
      { wrapper: ({ children }) => <AgentSessionProvider runtime={runtime}>{children}</AgentSessionProvider> },
    );
    await waitFor(() => expect(result.current.session?.id).toBe("ses-1"));
    act(() => result.current.setComposerDraft({
      text: "再次检查",
      webAnnotations: [reference],
      replayedContextItems: [contextItem],
    }));
    await waitFor(() => expect(result.current.composerDraft.replayedContextItems).toHaveLength(1));

    let sent = false;
    await act(async () => {
      sent = await result.current.send([], [], [], selectedModel(), {}, [reference]);
    });

    expect(sent).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(channel.chat).toHaveBeenCalledWith(expect.objectContaining({
      runtime_params: expect.objectContaining({
        message_context_items: [expect.objectContaining({
          metadata: expect.objectContaining({ snapshot }),
        })],
        message_injection: [expect.objectContaining({
          content: "发送时的不可变网页内容",
        })],
      }),
    }));
    expect(vi.mocked(channel.chat).mock.calls.at(-1)?.[0].attachments ?? []).toEqual([]);
  });

  it("sends a confirmed incognito reference from memory and clears it only after transport succeeds", async () => {
    const { channel, runtime } = fakeRuntime();
    const registration = await incognitoWebReferenceRegistry.register({
      panelId: "browser-incognito-1",
      title: "Private article",
      url: "https://example.test/private?token=secret&view=public",
      draft: {
        draftId: "draft:incognito-controller",
        request: {
          requestId: "incognito-controller",
          selectionId: "incognito-controller",
          mode: "text",
          startedAt: "2026-07-22T08:00:00Z",
        },
        target: {
          type: "text",
          quote: { exact: "Private selected evidence", prefix: "", suffix: "" },
          context: { headingPath: ["Private"] },
          rects: [{ x: 10, y: 20, width: 120, height: 18 }],
          frame: { url: "https://example.test/private", indexPath: [] },
        },
        navigationId: "navigation-private",
        frameKey: "main",
        liveBinding: null,
        dirty: true,
        evidence: null,
        createdAt: "2026-07-22T08:00:00Z",
      },
      bodyMarkdown: "One-time private evidence",
      tags: [],
      properties: [],
      now: "2026-07-22T08:00:00Z",
    });
    const { result } = renderHook(
      () => useAgentSessionController({ runtime, sessionId: "ses-1" }),
      { wrapper: ({ children }) => <AgentSessionProvider runtime={runtime}>{children}</AgentSessionProvider> },
    );
    await waitFor(() => expect(result.current.session?.id).toBe("ses-1"));
    act(() => result.current.setComposerDraft({
      text: "检查无痕引用",
      webAnnotations: [registration.reference],
      replayedContextItems: [registration.contextItem],
    }));

    let sent = false;
    await act(async () => {
      sent = await result.current.send([], [], [], selectedModel(), {}, [registration.reference]);
    });

    expect(sent).toBe(true);
    expect(channel.chat).toHaveBeenCalledWith(expect.objectContaining({
      session_id: "ses-1",
      runtime_params: expect.objectContaining({
        message_context_items: [expect.objectContaining({
          type: "web_annotation",
          label: "无痕网页引用 · Private article",
          metadata: expect.objectContaining({
            incognito_source: true,
            snapshot: expect.objectContaining({
              reference: expect.objectContaining({
                annotationId: registration.reference.annotationId,
              }),
              page: expect.objectContaining({
                documentUrl: "https://example.test/private?view=public",
              }),
            }),
          }),
        })],
      }),
    }));
    expect(incognitoWebReferenceRegistry.size).toBe(0);
  });

  it("does not create an optimistic message when web annotation assembly fails", async () => {
    const { channel, runtime } = fakeRuntime();
    const onNotice = vi.fn();
    const coordinator = webAnnotationCoordinator(
      vi.fn().mockRejectedValue(new Error("annotation source missing")),
      0,
    );
    const { result } = renderHook(
      () => useAgentSessionController({
        runtime,
        ensureSession: vi.fn().mockResolvedValue(agentSession()),
        beforeSendToCreatedSession: vi.fn().mockResolvedValue(undefined),
        webAnnotationSendCoordinator: coordinator,
        onNotice,
      }),
      { wrapper: ({ children }) => <AgentSessionProvider runtime={runtime}>{children}</AgentSessionProvider> },
    );

    await waitFor(() => expect(result.current.wsStatus).toBe("open"));
    let sent = true;
    await act(async () => {
      sent = await result.current.sendText("不能半发送", selectedModel(), {
        webAnnotations: [webAnnotationReference()],
      });
    });

    expect(sent).toBe(false);
    expect(channel.chat).not.toHaveBeenCalled();
    expect(result.current.agentMessages).toEqual([]);
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("已删除或暂时无法读取"), "error");
  });

  it("cancels an in-flight resolver wait without sending a message", async () => {
    const { channel, runtime } = fakeRuntime();
    const coordinator = webAnnotationCoordinator(vi.fn().mockResolvedValue(webAnnotationDetail()), 60_000);
    const { result } = renderHook(
      () => useAgentSessionController({
        runtime,
        sessionId: "ses-1",
        webAnnotationSendCoordinator: coordinator,
      }),
      { wrapper: ({ children }) => <AgentSessionProvider runtime={runtime}>{children}</AgentSessionProvider> },
    );
    await waitFor(() => expect(result.current.session?.id).toBe("ses-1"));

    let sendPromise: Promise<boolean> | null = null;
    act(() => {
      sendPromise = result.current.sendText("取消解析", selectedModel(), {
        webAnnotations: [webAnnotationReference()],
      });
    });
    await waitFor(() => expect(result.current.canStop).toBe(true));
    act(() => result.current.stop());

    let sent = true;
    await act(async () => {
      sent = await sendPromise!;
    });
    expect(sent).toBe(false);
    expect(channel.chat).not.toHaveBeenCalled();
    expect(result.current.agentMessages).toEqual([]);
  });
});

function fakeRuntime({
  history = [],
  listThreadTasks = vi.fn().mockResolvedValue([]),
}: {
  history?: AgentHistoryResponse["list"];
  listThreadTasks?: ReturnType<typeof vi.fn>;
} = {}) {
  let handler: ((event: AgentActionEnvelope) => void) | null = null;
  const channel: ChatChannel = {
    close: vi.fn(),
    getStatus: vi.fn((): WsConnectionStatus => "open"),
    getSessionId: vi.fn(() => "ses-1"),
    createSession: vi.fn(),
    bindSession: vi.fn(),
    unbindSession: vi.fn(),
    chat: vi.fn(),
    resumePendingInputs: vi.fn(),
    submitA2UI: vi.fn(),
    cancelA2UI: vi.fn(),
    approvalDecision: vi.fn(),
    cancel: vi.fn(),
    terminateCommand: vi.fn(),
    requestStatus: vi.fn(),
    updatePendingInput: vi.fn(),
    reorderPendingInputs: vi.fn(),
    cancelPendingInput: vi.fn(),
    ping: vi.fn(),
  };
  const runtime = {
    conversation: {
      loadHistory: vi.fn().mockResolvedValue(historyResponse(history)),
      listThreadTasks,
      openChatChannel: vi.fn(
        (onEvent: (event: AgentActionEnvelope) => void, options?: { onStatus?: (status: WsConnectionStatus) => void }) => {
          handler = onEvent;
          options?.onStatus?.("open");
          return channel;
        },
      ),
    },
  } as unknown as RuntimeBridge;
  return {
    channel,
    runtime,
    emit(event: AgentActionEnvelope) {
      handler?.(event);
    },
  };
}

function selectedModel() {
  return {
    providerId: "provider-1",
    model: "qwen-coder",
  };
}

function historyResponse(list: AgentHistoryResponse["list"]): AgentHistoryResponse {
  return {
    list,
    total: list.length,
    page: 1,
    page_size: 50,
    session: agentSession(),
    event_total: list.length,
    turn_indexes: list.length ? [1] : [],
  };
}

function agentSession(): AgentSession {
  return {
    id: "ses-1",
    user_id: "local-user",
    scene_id: "desktop-agent",
    status: "active",
    title: "测试对话",
    session_tag: "chat",
    session_type: "chat",
    workspace_id: null,
    cwd: null,
    workspace_roots: [],
    workspace: null,
    active_session_id: null,
    parent_session_id: null,
    child_session_id: null,
    source_trace_id: null,
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-07-03T00:00:00Z",
    archived_at: null,
    archive_origin: null,
    is_debug: false,
    is_scheduled: false,
    is_current: false,
    current_model_provider_id: "provider-1",
    current_model: "qwen-coder",
  };
}

function webAnnotationReference(): SelectedWebAnnotationReference {
  return {
    annotationId: "annotation-1",
    selectedRevision: 1,
    selectedAt: "2026-07-22T08:00:00Z",
    sourcePanelId: "browser-1",
  };
}

function webAnnotationCoordinator(
  get: ReturnType<typeof vi.fn>,
  resolutionTimeoutMs: number,
): WebAnnotationSendCoordinator {
  return new WebAnnotationSendCoordinator({
    client: { get },
    panelRegistry: new WebAnnotationPanelRegistry(),
    now: () => "2026-07-22T08:01:00Z",
    resolutionTimeoutMs,
  });
}

function webAnnotationDetail(revision = 1, bodyMarkdown = "Review this evidence"): WebAnnotationDetail {
  return {
    resource: {
      id: "resource-1",
      scope: { kind: "session", id: "ses-1" },
      normalizationVersion: 1,
      urlKey: "a".repeat(64),
      urlNormalized: "https://example.test/article",
      documentUrl: "https://example.test/article",
      canonicalUrl: null,
      origin: "https://example.test",
      title: "Article",
      createdAt: "2026-07-22T08:00:00Z",
      updatedAt: "2026-07-22T08:00:00Z",
    },
    annotation: {
      id: "annotation-1",
      resourceId: "resource-1",
      targetSchemaVersion: 1,
      target: {
        type: "text",
        quote: { exact: "Selected evidence", prefix: "", suffix: "" },
        position: { start: 0, end: 17, textModelVersion: 1 },
        context: { headingPath: ["Evidence"] },
        rects: [{ x: 10, y: 20, width: 120, height: 18 }],
        frame: { url: "https://example.test/article", indexPath: [] },
      },
      bodyMarkdown,
      tags: ["review"],
      properties: [{ key: "owner", type: "text", value: "Keydex" }],
      revision,
      createdAt: "2026-07-22T08:00:00Z",
      updatedAt: "2026-07-22T08:00:00Z",
    },
    targetHistory: [],
    assets: [],
  };
}

function webRegionAnnotationDetail(): WebAnnotationDetail {
  const base = webAnnotationDetail();
  return {
    ...base,
    annotation: {
      ...base.annotation,
      target: {
        type: "region",
        rect: { x: 10, y: 20, width: 120, height: 80 },
        viewport: { width: 1280, height: 720 },
        scroll: { x: 0, y: 240 },
        frame: { url: "https://example.test/article", indexPath: [] },
      },
    },
    assets: [{
      id: "web-capture-00000000000000000000000000000001",
      resourceId: "resource-1",
      annotationId: "annotation-1",
      assetKind: "region_screenshot",
      state: "attached",
      storagePath: "browser/captures/staged/current/capture.png",
      mimeType: "image/png",
      sizeBytes: 128,
      sha256: "a".repeat(64),
      width: 120,
      height: 80,
      expiresAt: null,
      createdAt: "2026-07-22T08:00:00Z",
      updatedAt: "2026-07-22T08:00:00Z",
    }],
  };
}

function replayedWebAnnotationSnapshot() {
  const machineTarget = {
    type: "region" as const,
    rect: { x: 0, y: 0, width: 120, height: 80 },
    viewport: { width: 800, height: 600 },
    scroll: { x: 0, y: 0 },
    frame: { url: "https://example.test/history", indexPath: [] },
  };
  return {
    schemaVersion: 2 as const,
    type: "web_annotation" as const,
    reference: {
      annotationId: "annotation-history-1",
      revision: 2,
      anchorId: "wa_history00000001",
      createdAt: "2026-07-22T08:00:00Z",
      assembledAt: "2026-07-22T08:00:00Z",
    },
    trust: {
      userComment: "user_instruction" as const,
      pageEvidence: "untrusted_reference" as const,
      hostObservation: "trusted_application_observation" as const,
    },
    comment: {
      bodyMarkdown: "发送时正文",
      tags: ["history"],
      properties: [],
    },
    page: {
      title: "Example",
      documentUrl: "https://example.test/history",
      canonicalUrl: null,
      urlKey: "b".repeat(64),
      origin: "https://example.test",
      frame: machineTarget.frame,
    },
    anchor: {
      kind: "region" as const,
      display: { label: "页面区域 120 × 80" },
      semantic: { stableAttributes: [] },
      content: {},
      structure: {
        locators: [{
          kind: "coordinate_region" as const,
          stability: "weak" as const,
          value: "region:0,0,120,80",
        }],
        headingPath: [],
      },
      geometry: {
        rects: [machineTarget.rect],
        viewport: machineTarget.viewport,
        scroll: machineTarget.scroll,
      },
      machineTarget,
    },
    observation: {
      status: "missing" as const,
      freshness: "last_known" as const,
      observedAt: "2026-07-22T08:00:00Z",
      match: { strategy: null, confidence: 0, candidateCount: 0 },
      currentTarget: null,
      changes: { kinds: [], materialKinds: [], signals: [], material: false },
    },
    integrity: {
      canonicalization: "keydex-json-c14n/v1" as const,
      digest: `sha256:${"d".repeat(64)}`,
    },
  };
}

function threadTask(id: string): ThreadTask {
  return {
    id,
    session_id: "ses-1",
    type: "goal",
    type_label: "目标",
    title: "目标",
    objective: "完成目标",
    status: "active",
    metadata: {},
    evidence: [],
    blocked_audit: {},
    system_stop_reason: null,
    current_run_id: null,
    turn_count: 0,
    elapsed_seconds: 0,
    token_usage: {},
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-07-03T00:00:00Z",
    deleted_at: null,
    is_open: true,
    is_terminal: false,
  };
}
