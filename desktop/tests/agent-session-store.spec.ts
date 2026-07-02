import { describe, expect, it } from "vitest";

import {
  AGENT_CHAT_ACTIONS,
  type AgentActionEnvelope,
  type AgentChatAction,
  type AgentChatMessage,
  type AgentChatMessagePayload,
  type AgentHistoryResponse,
  type AgentSession,
  type CommandApprovalRequest,
} from "@/types/protocol";
import {
  agentConversationReducer,
  createInitialAgentConversationState,
  reduceAgentWsEvent,
  selectAgentMessages,
  selectAgentRuntimeState,
  selectAgentSessionState,
  selectAgentSessions,
} from "@/renderer/stores/agentSessionStore";

describe("agentSessionStore reducer", () => {
  it("keeps the reducer test matrix aligned with every websocket action", () => {
    const coveredActions = new Set<AgentChatAction>([
      "session_created",
      "bind_ok",
      "unbind_ok",
      "stream",
      "system_message",
      "completed",
      "cancelled",
      "tool_start",
      "tool_progress",
      "tool_end",
      "subagent_start",
      "subagent_end",
      "subagent_error",
      "error",
      "pong",
      "status",
      "session_closed",
      "session_title_updated",
      "task_result",
      "reasoning",
      "middleware_progress",
      "workspaceSkillsChanged",
      "approval_requested",
      "approval_resolved",
    ]);

    expect([...coveredActions].sort()).toEqual([...AGENT_CHAT_ACTIONS].sort());
  });

  it("normalizes session lists and selects session_created sessions", () => {
    let state = agentConversationReducer(createInitialAgentConversationState(), {
      type: "sessions/set",
      sessions: [session("ses-old", "2026-06-18T08:00:00Z"), session("ses-new", "2026-06-18T09:00:00Z")],
    });

    expect(selectAgentSessions(state).map((item) => item.id)).toEqual(["ses-new", "ses-old"]);
    expect(selectAgentSessionState(state, "ses-new")).toMatchObject({
      sessionId: "ses-new",
      sceneId: "desktop-agent",
      runtimeState: "idle",
    });

    state = reduceAgentWsEvent(state, {
      action: "session_created",
      data: { session: session("ses-live", "2026-06-18T10:00:00Z") },
    });

    expect(selectAgentSessions(state).map((item) => item.id)).toEqual(["ses-live", "ses-new", "ses-old"]);
    expect(selectAgentSessionState(state)?.sessionId).toBe("ses-live");
  });

  it("updates session title from realtime title update events", () => {
    let state = agentConversationReducer(createInitialAgentConversationState(), {
      type: "sessions/set",
      sessions: [session("ses-old", "2026-06-18T08:00:00Z"), session("ses-new", "2026-06-18T09:00:00Z")],
    });

    state = reduceAgentWsEvent(state, {
      action: "session_title_updated",
      data: {
        session: {
          ...session("ses-old", "2026-06-18T10:00:00Z"),
          title: "自动标题",
          title_source: "auto",
        },
      },
    });

    expect(selectAgentSessions(state).map((item) => item.id)).toEqual(["ses-old", "ses-new"]);
    expect(selectAgentSessions(state)[0]).toMatchObject({
      id: "ses-old",
      title: "自动标题",
      title_source: "auto",
    });
  });

  it("preserves persisted context window usage when later session payloads omit it", () => {
    const usage = contextWindowUsage("ses-usage", 5371);
    let state = agentConversationReducer(createInitialAgentConversationState(), {
      type: "history/loaded",
      sessionId: "ses-usage",
      history: {
        ...history([]),
        session: {
          ...session("ses-usage", "2026-06-18T09:00:00Z"),
          context_window_usage: usage,
        },
      },
    });

    state = agentConversationReducer(state, {
      type: "sessions/set",
      sessions: [session("ses-usage", "2026-06-18T09:10:00Z")],
    });

    expect(selectAgentSessions(state)[0].context_window_usage).toEqual(usage);

    state = reduceAgentWsEvent(state, {
      action: "session_title_updated",
      data: {
        session: {
          ...session("ses-usage", "2026-06-18T09:20:00Z"),
          title: "新标题",
          context_window_usage: null,
        },
      },
    });

    expect(selectAgentSessions(state)[0]).toMatchObject({
      id: "ses-usage",
      title: "新标题",
      context_window_usage: usage,
    });
  });

  it("loads history into the same message view model as realtime messages", () => {
    const state = agentConversationReducer(createInitialAgentConversationState(), {
      type: "history/loaded",
      sessionId: "ses-1",
      history: history([
        { role: "user", content: "你好" },
        { role: "reasoning", content: "正在分析", reasoningKind: "progress_fact" },
        {
          role: "tool",
          content: "",
          runId: "run-1",
          toolName: "read_file",
          toolParams: { path: "README.md" },
          toolResult: "ok",
        },
        {
          role: "assistant",
          content: "完成",
          traceId: "trace-1",
          traceQueryContext: { trace_id: "trace-1" },
        },
      ]),
    });

    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      { id: "hist:ses-1:1", role: "user", content: "你好", streaming: false },
      { id: "hist:ses-1:2", role: "reasoning", content: "正在分析", reasoningKind: "progress_fact" },
      { role: "tool", runId: "run-1", status: "completed" },
      {
        role: "assistant",
        content: "完成",
        ghostStats: { traceId: "trace-1", inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      },
    ]);
    expect(selectAgentSessionState(state, "ses-1")?.hydrated).toBe(true);
    expect(selectAgentRuntimeState(state, "ses-1")).toBe("idle");
  });

  it("normalizes non-string history message content before it reaches renderers", () => {
    const state = agentConversationReducer(createInitialAgentConversationState(), {
      type: "history/loaded",
      sessionId: "ses-1",
      history: history([
        {
          role: "user",
          content: [
            { type: "text", text: "第一段" },
            { type: "text", text: "第二段" },
          ],
        } as unknown as AgentChatMessagePayload,
        {
          role: "assistant",
          content: { text: "对象内容" },
          timestamp: 1_700_000_000_000,
        } as unknown as AgentChatMessagePayload,
      ]),
    });

    expect(selectAgentMessages(state, "ses-1").map((item) => item.content)).toEqual([
      "第一段\n第二段",
      "对象内容",
    ]);
    expect(selectAgentMessages(state, "ses-1")[1].id).toMatch(/^hist:ses-1:turnless:assistant:/);
  });

  it("keeps an active local runtime state when stale active history is hydrated", () => {
    let state = agentConversationReducer(createInitialAgentConversationState(), {
      type: "sessions/set",
      sessions: [session("ses-1", "2026-06-18T08:00:00Z")],
    });
    state = agentConversationReducer(state, {
      type: "runtime/setState",
      sessionId: "ses-1",
      runtimeState: "running",
    });

    state = agentConversationReducer(state, {
      type: "history/loaded",
      sessionId: "ses-1",
      history: history([{ role: "user", content: "运行中的问题" }]),
    });

    expect(selectAgentRuntimeState(state, "ses-1")).toBe("running");
    expect(selectAgentSessionState(state, "ses-1")?.isStreaming).toBe(true);
  });

  it("keeps active local messages when initial history hydrates during a send", () => {
    let state = agentConversationReducer(createInitialAgentConversationState(), {
      type: "sessions/set",
      sessions: [session("ses-1", "2026-06-18T08:00:00Z")],
    });
    state = agentConversationReducer(state, {
      type: "message/addUser",
      sessionId: "ses-1",
      content: "冷启动请求",
      id: "quick:send-1:user",
      timestamp: 1_782_600_000_000,
    });
    state = agentConversationReducer(state, {
      type: "runtime/setState",
      sessionId: "ses-1",
      runtimeState: "running",
    });

    state = agentConversationReducer(state, {
      type: "history/loaded",
      sessionId: "ses-1",
      history: history([]),
    });

    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      { id: "quick:send-1:user", role: "user", content: "冷启动请求" },
    ]);
    expect(selectAgentRuntimeState(state, "ses-1")).toBe("running");

    state = agentConversationReducer(state, {
      type: "history/loaded",
      sessionId: "ses-1",
      history: history([
        {
          role: "user",
          content: "冷启动请求",
          messageEventId: "evt-user-1",
          turnIndex: 1,
          timestamp: 1_782_600_000_010,
        },
      ]),
    });

    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      { role: "user", content: "冷启动请求", messageEventId: "evt-user-1" },
    ]);
    expect(selectAgentMessages(state, "ses-1")).toHaveLength(1);
  });

  it("restores pending command approval from history", () => {
    const approval = commandApproval("approval-history");
    const state = agentConversationReducer(createInitialAgentConversationState(), {
      type: "history/loaded",
      sessionId: "ses-1",
      history: history([
        { role: "user", content: "运行测试" },
        {
          role: "approval",
          content: "等待批准执行命令: pnpm test",
          approval,
          status: "pending",
        },
      ]),
    });

    const view = selectAgentSessionState(state, "ses-1");
    expect(view?.pendingApproval).toMatchObject({ id: "approval-history", status: "pending" });
    expect(view?.runtimeState).toBe("waiting_approval");
    expect(selectAgentMessages(state, "ses-1").at(-1)).toMatchObject({
      role: "approval",
      status: "pending",
      approval: { details: { command: "pnpm test" } },
    });
  });

  it("prepends older history pages without replacing the latest page", () => {
    let state = agentConversationReducer(createInitialAgentConversationState(), {
      type: "history/loaded",
      sessionId: "ses-1",
      history: {
        ...history([
          { role: "user", content: "user 5", turnIndex: 5 },
          { role: "assistant", content: "answer 5", turnIndex: 5 },
        ]),
        next_cursor: "cursor-5",
        has_more_older: true,
      },
    });

    state = agentConversationReducer(state, {
      type: "history/olderLoaded",
      sessionId: "ses-1",
      history: {
        ...history([
          { role: "user", content: "user 4", turnIndex: 4 },
          { role: "assistant", content: "answer 4", turnIndex: 4 },
        ]),
        next_cursor: "cursor-4",
        has_more_older: true,
      },
    });

    expect(selectAgentMessages(state, "ses-1").map((message) => message.content)).toEqual([
      "user 4",
      "answer 4",
      "user 5",
      "answer 5",
    ]);
    expect(selectAgentSessionState(state, "ses-1")).toMatchObject({
      historyCursor: "cursor-4",
      historyHasMoreOlder: true,
    });
  });

  it("keeps realtime stream/tool/completed messages aligned with loaded history", () => {
    let realtimeState = createInitialAgentConversationState();
    realtimeState = agentConversationReducer(realtimeState, {
      type: "message/addUser",
      sessionId: "ses-1",
      content: "读文件",
      id: "user-1",
      timestamp: 1,
    });
    realtimeState = reduceAgentWsEvent(realtimeState, {
      action: "stream",
      data: { session_id: "ses-1", content: "我来" },
    });
    realtimeState = reduceAgentWsEvent(realtimeState, toolStart("ses-1", "run-1", "read_file"));
    realtimeState = reduceAgentWsEvent(realtimeState, {
      action: "tool_end",
      data: {
        session_id: "ses-1",
        run_id: "run-1",
        result: "content",
        duration_ms: 12,
        status: "success",
      },
    });
    realtimeState = reduceAgentWsEvent(realtimeState, {
      action: "stream",
      data: { session_id: "ses-1", content: "完成" },
    });
    realtimeState = reduceAgentWsEvent(realtimeState, {
      action: "completed",
      data: {
        session_id: "ses-1",
        status: "completed",
        events: [],
        trace_id: "trace-1",
        latest_llm_token_usage: { input_tokens: 1, output_tokens: 2 },
        trace_query_context: { trace_id: "trace-1" },
      },
    });

    const historyState = agentConversationReducer(createInitialAgentConversationState(), {
      type: "history/loaded",
      sessionId: "ses-1",
      history: history([
        { role: "user", content: "读文件" },
        { role: "assistant", content: "我来" },
        {
          role: "tool",
          content: "",
          runId: "run-1",
          toolName: "read_file",
          toolParams: { path: "README.md" },
          toolResult: "content",
          toolDurationMs: 12,
        },
        {
          role: "assistant",
          content: "完成",
          ghostStats: { traceId: "trace-1", inputTokens: 1, cacheReadTokens: 0, outputTokens: 2 },
          traceQueryContext: { trace_id: "trace-1" },
        },
      ]),
    });

    expect(selectAgentMessages(realtimeState, "ses-1").map(messageShape)).toEqual(
      selectAgentMessages(historyState, "ses-1").map(messageShape),
    );
  });

  it("updates bind, unbind, status and session closed actions without adding messages", () => {
    let state = reduceAgentWsEvent(createInitialAgentConversationState(), {
      action: "session_created",
      data: { session: session("ses-1", "2026-06-18T10:00:00Z") },
    });

    state = reduceAgentWsEvent(state, { action: "bind_ok", data: { session_id: "ses-1" } });
    expect(selectAgentSessionState(state, "ses-1")?.chatBound).toBe(true);

    state = reduceAgentWsEvent(state, { action: "status", data: { session_id: "ses-1", status: "running" } });
    expect(selectAgentRuntimeState(state, "ses-1")).toBe("running");

    state = reduceAgentWsEvent(state, { action: "pong", data: { timestamp: 1 } });
    state = reduceAgentWsEvent(state, { action: "task_result", data: { session_id: "ses-1" } });
    expect(selectAgentMessages(state, "ses-1")).toEqual([]);

    state = reduceAgentWsEvent(state, { action: "unbind_ok", data: { session_id: "ses-1" } });
    expect(selectAgentSessionState(state, "ses-1")?.chatBound).toBe(false);

    state = reduceAgentWsEvent(state, { action: "session_closed", data: { session_id: "ses-1" } });
    expect(selectAgentRuntimeState(state, "ses-1")).toBe("closed");
    expect(selectAgentSessionState(state, "ses-1")?.status).toBe("closed");
  });

  it("marks background sessions unread only after the turn reaches a terminal event", () => {
    let state = agentConversationReducer(createInitialAgentConversationState(), {
      type: "sessions/set",
      sessions: [session("ses-a", "2026-06-18T09:00:00Z"), session("ses-b", "2026-06-18T10:00:00Z")],
    });
    state = agentConversationReducer(state, { type: "session/select", sessionId: "ses-a" });

    state = reduceAgentWsEvent(state, {
      action: "stream",
      data: { session_id: "ses-b", content: "后台输出" },
    });

    expect(state.selectedSessionId).toBe("ses-a");
    expect(selectAgentSessionState(state, "ses-b")?.hasUnread).toBe(false);
    expect(selectAgentRuntimeState(state, "ses-b")).toBe("running");

    state = reduceAgentWsEvent(state, {
      action: "completed",
      data: { session_id: "ses-b", status: "completed", events: [] },
    });
    expect(selectAgentSessionState(state, "ses-b")?.hasUnread).toBe(true);

    state = agentConversationReducer(state, { type: "session/select", sessionId: "ses-b" });
    expect(selectAgentSessionState(state, "ses-b")?.hasUnread).toBe(false);
  });

  it("marks every session reported by running_sessions as streaming", () => {
    let state = agentConversationReducer(createInitialAgentConversationState(), {
      type: "sessions/set",
      sessions: [
        session("ses-a", "2026-06-18T08:00:00Z"),
        session("ses-b", "2026-06-18T09:00:00Z"),
        session("ses-c", "2026-06-18T10:00:00Z"),
      ],
    });
    state = agentConversationReducer(state, { type: "session/select", sessionId: "ses-a" });

    state = reduceAgentWsEvent(state, {
      action: "status",
      data: {
        status: "idle",
        running_sessions: [{ session_id: "ses-b" }, { session_id: "ses-c" }],
      },
    });

    expect(selectAgentRuntimeState(state, "ses-a")).toBe("idle");
    expect(selectAgentSessionState(state, "ses-b")).toMatchObject({ runtimeState: "running", isStreaming: true });
    expect(selectAgentSessionState(state, "ses-c")).toMatchObject({ runtimeState: "running", isStreaming: true });
  });

  it("tracks command approval request and resumes after approval resolution", () => {
    let state = agentConversationReducer(createInitialAgentConversationState(), {
      type: "sessions/set",
      sessions: [session("ses-1", "2026-06-18T08:00:00Z")],
    });
    state = agentConversationReducer(state, { type: "session/select", sessionId: "ses-1" });

    state = reduceAgentWsEvent(state, approvalRequested("ses-1", commandApproval("approval-1")));

    expect(selectAgentSessionState(state, "ses-1")).toMatchObject({
      runtimeState: "waiting_approval",
      isStreaming: false,
      pendingApproval: { id: "approval-1", status: "pending" },
    });
    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      {
        role: "approval",
        status: "pending",
        content: "等待批准执行命令: pnpm test",
      },
    ]);
    expect(selectAgentSessions(state)[0]).toMatchObject({ id: "ses-1", status: "waiting_approval" });

    state = reduceAgentWsEvent(state, approvalResolved("ses-1", { ...commandApproval("approval-1"), status: "approved" }));

    expect(selectAgentSessionState(state, "ses-1")).toMatchObject({
      runtimeState: "running",
      isStreaming: true,
      pendingApproval: null,
    });
    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      {
        role: "approval",
        status: "approved",
        content: "已允许执行命令: pnpm test",
      },
    ]);
  });

  it("keeps concurrent command approvals queued in arrival order", () => {
    let state = agentConversationReducer(createInitialAgentConversationState(), {
      type: "sessions/set",
      sessions: [session("ses-1", "2026-06-18T08:00:00Z")],
    });
    state = agentConversationReducer(state, { type: "session/select", sessionId: "ses-1" });

    state = reduceAgentWsEvent(state, approvalRequested("ses-1", commandApproval("approval-1")));
    state = reduceAgentWsEvent(state, approvalRequested("ses-1", commandApproval("approval-2")));
    state = reduceAgentWsEvent(state, approvalRequested("ses-1", commandApproval("approval-3")));

    expect(selectAgentSessionState(state, "ses-1")).toMatchObject({
      runtimeState: "waiting_approval",
      isStreaming: false,
      pendingApproval: { id: "approval-1", status: "pending" },
    });

    state = reduceAgentWsEvent(state, approvalResolved("ses-1", { ...commandApproval("approval-1"), status: "approved" }));

    expect(selectAgentSessionState(state, "ses-1")).toMatchObject({
      runtimeState: "waiting_approval",
      isStreaming: false,
      pendingApproval: { id: "approval-2", status: "pending" },
    });
    expect(selectAgentSessions(state)[0]).toMatchObject({ id: "ses-1", status: "waiting_approval" });

    state = reduceAgentWsEvent(state, approvalResolved("ses-1", { ...commandApproval("approval-2"), status: "approved" }));

    expect(selectAgentSessionState(state, "ses-1")).toMatchObject({
      runtimeState: "waiting_approval",
      isStreaming: false,
      pendingApproval: { id: "approval-3", status: "pending" },
    });

    state = reduceAgentWsEvent(state, approvalResolved("ses-1", { ...commandApproval("approval-3"), status: "rejected" }));

    expect(selectAgentSessionState(state, "ses-1")).toMatchObject({
      runtimeState: "running",
      isStreaming: true,
      pendingApproval: null,
    });
  });

  it("does not restore a stale local pending approval when history has resolved it", () => {
    let state = agentConversationReducer(createInitialAgentConversationState(), {
      type: "sessions/set",
      sessions: [session("ses-1", "2026-06-18T08:00:00Z")],
    });
    state = agentConversationReducer(state, { type: "session/select", sessionId: "ses-1" });
    state = reduceAgentWsEvent(state, approvalRequested("ses-1", commandApproval("approval-1")));

    state = agentConversationReducer(state, {
      type: "history/loaded",
      sessionId: "ses-1",
      history: history([
        approvalHistoryMessage({ ...commandApproval("approval-1"), status: "approved" }),
        approvalHistoryMessage(commandApproval("approval-2")),
      ]),
    });

    const view = selectAgentSessionState(state, "ses-1");
    expect(view).toMatchObject({
      runtimeState: "waiting_approval",
      pendingApproval: { id: "approval-2", status: "pending" },
    });
    expect(
      selectAgentMessages(state, "ses-1").filter(
        (message) => message.role === "approval" && message.approval?.id === "approval-1" && message.status === "pending",
      ),
    ).toHaveLength(0);
  });

  it("marks sessions from waiting_approval status payload without unread side effects", () => {
    let state = agentConversationReducer(createInitialAgentConversationState(), {
      type: "sessions/set",
      sessions: [session("ses-a", "2026-06-18T08:00:00Z"), session("ses-b", "2026-06-18T09:00:00Z")],
    });
    state = agentConversationReducer(state, { type: "session/select", sessionId: "ses-a" });

    state = reduceAgentWsEvent(state, {
      action: "status",
      data: {
        status: "idle",
        waiting_approval_sessions: [{ session_id: "ses-b" }],
      },
    });

    expect(selectAgentSessionState(state, "ses-b")).toMatchObject({
      runtimeState: "waiting_approval",
      isStreaming: false,
      hasUnread: false,
    });
  });

  it("keeps reasoning panels in event order when tools interleave", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(state, {
      action: "reasoning",
      data: { session_id: "ses-1", kind: "progress_fact", content: "先检查上下文" },
    });
    state = reduceAgentWsEvent(state, toolStart("ses-1", "run-1", "read_file"));
    state = reduceAgentWsEvent(state, {
      action: "reasoning",
      data: { session_id: "ses-1", kind: "progress_fact", content: "继续分析结果" },
    });
    state = reduceAgentWsEvent(state, {
      action: "reasoning",
      data: { session_id: "ses-1", kind: "progress_fact", done: true },
    });

    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      { role: "reasoning", content: "先检查上下文", reasoningKind: "progress_fact", streaming: false },
      { role: "tool", runId: "run-1", toolName: "read_file", status: "running" },
      { role: "reasoning", content: "继续分析结果", reasoningKind: "progress_fact", streaming: false },
    ]);
    expect(selectAgentRuntimeState(state, "ses-1")).toBe("running");
  });

  it("keeps assistant and reasoning chunks in arrival order", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(state, {
      action: "stream",
      data: { session_id: "ses-1", content: "先给结论。" },
    });
    state = reduceAgentWsEvent(state, {
      action: "reasoning",
      data: { session_id: "ses-1", kind: "reasoning", content: "中途思考" },
    });
    state = reduceAgentWsEvent(state, {
      action: "stream",
      data: { session_id: "ses-1", content: "继续回答。" },
    });

    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      { role: "assistant", content: "先给结论。", streaming: false },
      { role: "reasoning", content: "中途思考", streaming: false },
      { role: "assistant", content: "继续回答。", streaming: true },
    ]);
  });

  it("marks reasoning streams completed when the turn completes", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(state, {
      action: "reasoning",
      data: { session_id: "ses-1", kind: "reasoning", content: "先分析工具调用" },
    });
    state = reduceAgentWsEvent(state, {
      action: "completed",
      data: {
        session_id: "ses-1",
        status: "completed",
        final_content: "完成",
        trace_id: "trace-1",
      },
    });

    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      { role: "reasoning", content: "先分析工具调用", streaming: false, status: "completed" },
      { role: "assistant", content: "完成", streaming: false },
    ]);
    expect(selectAgentRuntimeState(state, "ses-1")).toBe("idle");
  });

  it("appends stream chunks and deduplicates events with explicit event ids", () => {
    let state = createInitialAgentConversationState();
    const streamTimestamp = new Date("2026-06-18T12:34:00+08:00").getTime();
    const first: AgentActionEnvelope = {
      action: "stream",
      data: { session_id: "ses-1", content: "你", event_id: "evt-1", timestamp_ms: streamTimestamp },
    };
    state = reduceAgentWsEvent(state, first);
    state = reduceAgentWsEvent(state, { action: "stream", data: { session_id: "ses-1", content: "好" } });
    state = reduceAgentWsEvent(state, first);

    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      { role: "assistant", content: "你好", timestamp: streamTimestamp, streaming: true, status: "streaming" },
    ]);
    expect(selectAgentRuntimeState(state, "ses-1")).toBe("running");
  });

  it("appends realtime system messages", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(state, {
      action: "system_message",
      data: {
        session_id: "ses-1",
        content: "上下文已压缩，后续对话将从压缩分支继续。",
        message_event_id: "evt-system-1",
        turn_index: 2,
        compression: { kind: "context_compressed" },
        timestamp_ms: 1_782_600_000_000,
      },
    });
    state = reduceAgentWsEvent(state, {
      action: "system_message",
      data: {
        session_id: "ses-1",
        content: "上下文已压缩，后续对话将从压缩分支继续。",
        message_event_id: "evt-system-1",
      },
    });

    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      {
        role: "system",
        content: "上下文已压缩，后续对话将从压缩分支继续。",
        messageEventId: "evt-system-1",
        turnIndex: 2,
        metadata: { compression: { kind: "context_compressed" } },
        streaming: false,
      },
    ]);
  });

  it("appends context compression notices when staging is applied", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(state, {
      action: "middleware_progress",
      data: {
        session_id: "ses-1",
        middleware: "ContextCompressionMiddleware",
        stage: "staging_applied",
        compression_mode: "background",
        notice_id: "context-compression:staging:1",
        staging_id: 1,
        timestamp_ms: 1_782_600_000_000,
      },
    });

    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      {
        role: "system",
        content: "无感压缩已完成",
        status: "completed",
        metadata: {
          compression: {
            kind: "context_compression",
            stage: "staging_applied",
            mode: "background",
            notice_id: "context-compression:staging:1",
          },
        },
      },
    ]);
  });

  it("updates one LLM retry notice through retrying and recovered states", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(state, {
      action: "middleware_progress",
      data: {
        session_id: "ses-1",
        middleware: "LLMRetry",
        kind: "llm_retry",
        stage: "retrying",
        notice_id: "llm-retry:trace-1:run-1",
        retry_index: 1,
        max_retries: 3,
        attempt: 2,
        trace_id: "trace-1",
      },
    });
    state = reduceAgentWsEvent(state, {
      action: "middleware_progress",
      data: {
        session_id: "ses-1",
        middleware: "LLMRetry",
        kind: "llm_retry",
        stage: "recovered",
        notice_id: "llm-retry:trace-1:run-1",
        retry_index: 1,
        max_retries: 3,
        attempt: 2,
        trace_id: "trace-1",
      },
    });

    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      {
        role: "system",
        content: "LLM 请求重试成功",
        status: "completed",
        metadata: {
          retry: {
            kind: "llm_retry",
            stage: "recovered",
            notice_id: "llm-retry:trace-1:run-1",
            retry_index: 1,
            max_retries: 3,
          },
        },
      },
    ]);
  });

  it("updates one emergency compression notice through running and terminal states", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(state, {
      action: "middleware_progress",
      data: {
        session_id: "ses-1",
        middleware: "ContextCompressionMiddleware",
        stage: "emergency_triggered",
        compression_mode: "emergency",
        notice_id: "context-compression:emergency:trace-1",
        trace_id: "trace-1",
      },
    });
    state = reduceAgentWsEvent(state, {
      action: "middleware_progress",
      data: {
        session_id: "ses-1",
        middleware: "ContextCompressionMiddleware",
        stage: "emergency_completed",
        compression_mode: "emergency",
        notice_id: "context-compression:emergency:trace-1",
        trace_id: "trace-1",
      },
    });

    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      {
        role: "system",
        content: "自动压缩成功",
        status: "completed",
        metadata: {
          compression: {
            stage: "emergency_completed",
            mode: "emergency",
            notice_id: "context-compression:emergency:trace-1",
          },
        },
      },
    ]);
    expect(selectAgentMessages(state, "ses-1")).toHaveLength(1);
  });

  it("keeps tool lifecycle idempotent by run id", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(state, toolStart("ses-1", "run-1", "read_file"));
    state = reduceAgentWsEvent(state, toolStart("ses-1", "run-1", "read_file"));
    state = reduceAgentWsEvent(state, {
      action: "tool_end",
      data: {
        session_id: "ses-1",
        run_id: "run-1",
        result: "文件内容",
        duration_ms: 12,
        status: "success",
      },
    });

    const messages = selectAgentMessages(state, "ses-1");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "tool",
      runId: "run-1",
      toolName: "read_file",
      toolResult: "文件内容",
      toolDurationMs: 12,
      status: "completed",
    });
  });

  it("merges tool progress into edit tool messages and lets final output override the same file stats", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(state, {
      action: "tool_progress",
      data: {
        session_id: "ses-1",
        run_id: "call-patch",
        tool_call_id: "call-patch",
        tool_name: "apply_patch",
        params: { patch: "*** Begin Patch" },
        files: [{ path: "src/app.ts", added_lines: 1, deleted_lines: 0 }],
      },
    });

    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      {
        role: "tool",
        runId: "call-patch",
        toolCallId: "call-patch",
        toolName: "apply_patch",
        status: "running",
        fileChanges: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
      },
    ]);

    state = reduceAgentWsEvent(state, {
      action: "tool_end",
      data: {
        session_id: "ses-1",
        run_id: "call-patch",
        tool_name: "apply_patch",
        result: "{}",
        status: "success",
        files: [{ path: "src/app.ts", added_lines: 4, deleted_lines: 2 }],
      },
    });

    expect(selectAgentMessages(state, "ses-1")[0]).toMatchObject({
      status: "completed",
      fileChanges: [{ path: "src/app.ts", additions: 4, deletions: 2 }],
      uiPayload: {
        files: [{ path: "src/app.ts", additions: 4, deletions: 2 }],
      },
    });
  });

  it("merges streamed apply_patch progress with later tool lifecycle events by tool call id", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(state, {
      action: "tool_progress",
      data: {
        session_id: "ses-1",
        run_id: "call-patch",
        tool_call_id: "call-patch",
        tool_name: "apply_patch",
        files: [{ path: "src/app.ts", added_lines: 1, deleted_lines: 0 }],
      },
    });

    state = reduceAgentWsEvent(state, {
      action: "tool_start",
      data: {
        session_id: "ses-1",
        run_id: "tool-run",
        tool_name: "apply_patch",
        tool_call_id: "call-patch",
        params: {},
      },
    });

    expect(selectAgentMessages(state, "ses-1")).toHaveLength(1);
    expect(selectAgentMessages(state, "ses-1")[0]).toMatchObject({
      runId: "tool-run",
      toolCallId: "call-patch",
      toolName: "apply_patch",
      status: "running",
      fileChanges: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
    });

    state = reduceAgentWsEvent(state, {
      action: "tool_progress",
      data: {
        session_id: "ses-1",
        run_id: "call-patch",
        tool_call_id: "call-patch",
        tool_name: "apply_patch",
        files: [{ path: "src/app.ts", added_lines: 2, deleted_lines: 0 }],
      },
    });

    expect(selectAgentMessages(state, "ses-1")[0]).toMatchObject({
      runId: "tool-run",
      toolCallId: "call-patch",
      status: "running",
      fileChanges: [{ path: "src/app.ts", additions: 2, deletions: 0 }],
    });

    state = reduceAgentWsEvent(state, {
      action: "tool_end",
      data: {
        session_id: "ses-1",
        run_id: "tool-run",
        tool_name: "apply_patch",
        tool_call_id: "call-patch",
        status: "completed",
        files: [{ path: "src/app.ts", added_lines: 2, deleted_lines: 1 }],
      },
    });

    expect(selectAgentMessages(state, "ses-1")).toHaveLength(1);
    expect(selectAgentMessages(state, "ses-1")[0]).toMatchObject({
      status: "completed",
      fileChanges: [{ path: "src/app.ts", additions: 2, deletions: 1 }],
    });
  });

  it("keeps the turn running after a tool finishes until a terminal event arrives", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(state, { action: "stream", data: { session_id: "ses-1", content: "我先查一下" } });
    state = reduceAgentWsEvent(state, toolStart("ses-1", "run-1", "read_file"));
    state = reduceAgentWsEvent(state, {
      action: "tool_end",
      data: {
        session_id: "ses-1",
        run_id: "run-1",
        result: "文件内容",
        duration_ms: 12,
        status: "success",
      },
    });

    expect(selectAgentMessages(state, "ses-1").at(-1)).toMatchObject({
      role: "tool",
      runId: "run-1",
      status: "completed",
    });
    expect(selectAgentRuntimeState(state, "ses-1")).toBe("running");

    state = reduceAgentWsEvent(state, {
      action: "completed",
      data: {
        session_id: "ses-1",
        status: "completed",
        events: [],
      },
    });

    expect(selectAgentRuntimeState(state, "ses-1")).toBe("idle");
  });

  it("keeps structured tool output for command rendering", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(state, toolStart("ses-1", "run-command", "run_command"));
    state = reduceAgentWsEvent(state, {
      action: "tool_end",
      data: {
        session_id: "ses-1",
        run_id: "run-command",
        result: "{\"command\":\"echo ok\"}",
        output_data: {
          result: {
            command: "echo ok",
            cwd: ".",
            stdout: "ok\n",
            stderr: "",
            exit_code: 0,
          },
        },
        duration_ms: 20,
        status: "success",
      },
    });

    expect(selectAgentMessages(state, "ses-1")[0]).toMatchObject({
      role: "tool",
      toolName: "run_command",
      uiPayload: {
        command: "echo ok",
        stdout: "ok\n",
        exit_code: 0,
      },
      status: "completed",
    });
  });

  it("tracks subagent stream and nested tools in event order", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(state, {
      action: "subagent_start",
      data: {
        session_id: "ses-1",
        subagent_id: "sub-1",
        subagent_name: "代码审查",
        task: "检查 diff",
        run_id: "sub-run",
      },
    });
    state = reduceAgentWsEvent(state, {
      action: "stream",
      data: {
        session_id: "ses-1",
        content: "正在检查",
        is_subagent: true,
        subagent_id: "sub-1",
      },
    });
    state = reduceAgentWsEvent(state, {
      action: "tool_start",
      data: {
        session_id: "ses-1",
        run_id: "tool-run",
        tool_name: "search",
        params: { q: "TODO" },
        is_subagent: true,
        subagent_id: "sub-1",
      },
    });
    state = reduceAgentWsEvent(state, {
      action: "tool_end",
      data: {
        session_id: "ses-1",
        run_id: "tool-run",
        result: "0 matches",
        is_subagent: true,
        subagent_id: "sub-1",
      },
    });
    state = reduceAgentWsEvent(state, {
      action: "subagent_end",
      data: {
        session_id: "ses-1",
        subagent_id: "sub-1",
        result_summary: "检查完成",
      },
    });

    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      {
        role: "subagent",
        subagentId: "sub-1",
        subagentName: "代码审查",
        content: "正在检查\n\n检查完成",
        streaming: false,
        subagentItems: [
          { type: "text", content: "正在检查", streaming: false },
          { type: "tool", runId: "tool-run", toolName: "search", status: "completed" },
          { type: "text", content: "检查完成", streaming: false },
        ],
      },
    ]);
  });

  it("marks subagent errors as failed ghost panels", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(state, {
      action: "subagent_start",
      data: {
        session_id: "ses-1",
        subagent_id: "sub-1",
        subagent_name: "代码审查",
      },
    });
    state = reduceAgentWsEvent(state, {
      action: "subagent_error",
      data: {
        session_id: "ses-1",
        subagent_id: "sub-1",
        error: "检查失败",
      },
    });

    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      {
        role: "subagent",
        status: "failed",
        streaming: false,
        content: "\n\n[错误: 检查失败]",
      },
    ]);
  });

  it("finalizes completed, cancelled and error states", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(state, { action: "stream", data: { session_id: "ses-1", content: "完成" } });
    state = reduceAgentWsEvent(state, {
      action: "completed",
      data: {
        session_id: "ses-1",
        status: "completed",
        events: [],
        trace_id: "trace-1",
        latest_llm_token_usage: {
          input_tokens: 10,
          cache_read_tokens: 3,
          output_tokens: 5,
        },
        trace_query_context: { trace_id: "trace-1", date_prefix: "2026-06-18" },
      },
    });

    expect(selectAgentMessages(state, "ses-1")[0]).toMatchObject({
      role: "assistant",
      content: "完成",
      streaming: false,
      ghostStats: { traceId: "trace-1", inputTokens: 10, cacheReadTokens: 3, outputTokens: 5 },
      traceQueryContext: { trace_id: "trace-1", date_prefix: "2026-06-18" },
    });
    expect(selectAgentRuntimeState(state, "ses-1")).toBe("idle");

    state = reduceAgentWsEvent(state, {
      action: "stream",
      data: { session_id: "ses-failed", content: "已经生成的回答" },
    });
    state = reduceAgentWsEvent(state, {
      action: "error",
      data: {
        session_id: "ses-failed",
        code: "llm_read_timeout",
        message: "模型响应超时，未收到后续响应数据",
        trace_id: "trace-failed",
        details: { exception_type: "httpx.ReadTimeout" },
      },
    });
    expect(selectAgentMessages(state, "ses-failed")).toMatchObject([
      {
        role: "assistant",
        content: "已经生成的回答",
        streaming: false,
        status: "failed",
        traceId: "trace-failed",
        metadata: {
          turnError: {
            code: "llm_read_timeout",
            message: "模型响应超时，未收到后续响应数据",
            details: { exception_type: "httpx.ReadTimeout" },
          },
        },
      },
    ]);
    expect(selectAgentMessages(state, "ses-failed").some((message) => message.role === "error")).toBe(false);
    expect(selectAgentRuntimeState(state, "ses-failed")).toBe("failed");

    state = reduceAgentWsEvent(state, { action: "stream", data: { session_id: "ses-2", content: "处理中" } });
    state = reduceAgentWsEvent(state, { action: "cancelled", data: { session_id: "ses-2" } });
    expect(selectAgentMessages(state, "ses-2")).toMatchObject([
      {
        role: "assistant",
        content: "处理中",
        streaming: false,
      },
      {
        role: "assistant",
        content: "",
        status: "cancelled",
        cancelled: true,
      },
    ]);

    state = reduceAgentWsEvent(state, toolStart("ses-tool-only", "run-1", "read_file"));
    state = reduceAgentWsEvent(state, { action: "cancelled", data: { session_id: "ses-tool-only" } });
    expect(selectAgentMessages(state, "ses-tool-only")).toMatchObject([
      {
        role: "tool",
        status: "cancelled",
      },
      {
        role: "assistant",
        content: "",
        status: "cancelled",
        cancelled: true,
      },
    ]);

    state = reduceAgentWsEvent(state, { action: "cancelled", data: { session_id: "ses-tool-only" } });
    expect(selectAgentMessages(state, "ses-tool-only").filter((message) => message.cancelled)).toHaveLength(1);
    expect(selectAgentMessages(state, "ses-2")[0]).toMatchObject({
      streaming: false,
    });

    state = reduceAgentWsEvent(state, {
      action: "error",
      data: { session_id: "ses-2", code: "turn_error", message: "模型失败", trace_id: "trace-2" },
    });
    expect(selectAgentMessages(state, "ses-2").at(-1)).toMatchObject({
      role: "error",
      content: "模型失败",
      traceId: "trace-2",
      status: "failed",
    });
    expect(selectAgentRuntimeState(state, "ses-2")).toBe("failed");

    state = reduceAgentWsEvent(state, {
      action: "error",
      data: {
        session_id: "ses-2",
        code: "tool_call_limit_exceeded",
        message: "本轮工具调用已达到上限 1 次，已阻止第 2 次工具调用",
        trace_id: "trace-3",
        details: { max_tool_calls: 1, attempted_count: 2 },
      },
    });
    expect(selectAgentMessages(state, "ses-2").at(-1)).toMatchObject({
      role: "error",
      content: "本轮工具调用已达到上限 1 次，已阻止第 2 次工具调用",
      traceId: "trace-3",
      status: "failed",
    });
    expect(selectAgentRuntimeState(state, "ses-2")).toBe("failed");
  });

  it("does not synthesize ghost stats when completed has no trace or token data", () => {
    let state = createInitialAgentConversationState();
    state = reduceAgentWsEvent(state, { action: "stream", data: { session_id: "ses-1", content: "完成" } });
    state = reduceAgentWsEvent(state, {
      action: "completed",
      data: {
        session_id: "ses-1",
        status: "completed",
        events: [],
      },
    });

    expect(selectAgentMessages(state, "ses-1")[0].ghostStats).toBeUndefined();
  });
});

function session(id: string, updatedAt: string, status: AgentSession["status"] = "active"): AgentSession {
  return {
    id,
    user_id: "local-user",
    scene_id: "desktop-agent",
    status,
    title: id,
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
    created_at: "2026-06-18T07:00:00Z",
    updated_at: updatedAt,
    is_debug: false,
    is_scheduled: false,
    is_current: false,
    current_model_provider_id: "provider-1",
    current_model: "qwen-coder",
  };
}

function contextWindowUsage(sessionId: string, tokenCount: number): NonNullable<AgentSession["context_window_usage"]> {
  return {
    middleware: "ContextCompressionMiddleware",
    stage: "context_window_snapshot",
    session_id: sessionId,
    active_session_id: sessionId,
    timestamp_ms: 1000,
    token_count: tokenCount,
    context_window: 200000,
    threshold_token_count: 160000,
    threshold_usage_fraction: tokenCount / 160000,
    token_source: "usage_metadata",
  };
}

function approvalHistoryMessage(approval: CommandApprovalRequest): AgentChatMessagePayload {
  return {
    role: "approval",
    content: approval.status === "pending" ? "等待批准执行命令: pnpm test" : "已处理命令审批",
    approval,
    status: approval.status,
  };
}

function history(list: AgentHistoryResponse["list"]): AgentHistoryResponse {
  return {
    list,
    total: list.length,
    page: 1,
    page_size: 50,
    session: session("ses-1", "2026-06-18T08:00:00Z"),
    event_total: list.length,
    turn_indexes: [1],
  };
}

function toolStart(sessionId: string, runId: string, toolName: string): AgentActionEnvelope {
  return {
    action: "tool_start",
    data: {
      session_id: sessionId,
      run_id: runId,
      tool_name: toolName,
      params: { path: "README.md" },
    },
  };
}

function commandApproval(id: string, status: CommandApprovalRequest["status"] = "pending"): CommandApprovalRequest {
  return {
    id,
    session_id: "ses-1",
    thread_id: "ses-1",
    turn_id: "turn-1",
    item_id: "item-command",
    call_id: "call-command",
    run_id: "run-command",
    tool_name: "run_command",
    kind: "exec",
    title: "是否允许执行命令？",
    description: "请求执行命令。",
    details: { command: "pnpm test", cwd: "D:/repo" },
    status,
    created_at: "2026-06-18T08:00:01Z",
    resolved_at: status === "pending" ? null : "2026-06-18T08:00:02Z",
  };
}

function approvalRequested(sessionId: string, approval: CommandApprovalRequest): AgentActionEnvelope {
  return {
    action: "approval_requested",
    data: { session_id: sessionId, approval },
  };
}

function approvalResolved(sessionId: string, approval: CommandApprovalRequest): AgentActionEnvelope {
  return {
    action: "approval_resolved",
    data: { session_id: sessionId, approval },
  };
}

function messageShape(message: AgentChatMessage) {
  return {
    role: message.role,
    content: message.content,
    runId: message.runId,
    toolName: message.toolName,
    toolParams: message.toolParams,
    toolResult: message.toolResult,
    toolDurationMs: message.toolDurationMs,
    status: message.status,
    ghostStats: message.ghostStats,
    traceQueryContext: message.traceQueryContext,
    streaming: Boolean(message.streaming),
    cancelled: Boolean(message.cancelled),
  };
}
