import { describe, expect, it } from "vitest";

import {
  AGENT_CHAT_ACTIONS,
  type AgentActionEnvelope,
  type AgentChatAction,
  type AgentChatMessage,
  type AgentHistoryResponse,
  type AgentSession,
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
      "completed",
      "cancelled",
      "tool_start",
      "tool_end",
      "subagent_start",
      "subagent_end",
      "subagent_error",
      "error",
      "pong",
      "status",
      "session_closed",
      "task_result",
      "reasoning",
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
      { id: "hist:ses-1:3", role: "tool", runId: "run-1", status: "completed" },
      {
        id: "hist:ses-1:4",
        role: "assistant",
        content: "完成",
        ghostStats: { traceId: "trace-1", inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      },
    ]);
    expect(selectAgentSessionState(state, "ses-1")?.hydrated).toBe(true);
    expect(selectAgentRuntimeState(state, "ses-1")).toBe("idle");
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
    ]);
    expect(selectAgentRuntimeState(state, "ses-1")).toBe("idle");
  });

  it("appends stream chunks and deduplicates events with explicit event ids", () => {
    let state = createInitialAgentConversationState();
    const first: AgentActionEnvelope = {
      action: "stream",
      data: { session_id: "ses-1", content: "你", event_id: "evt-1" },
    };
    state = reduceAgentWsEvent(state, first);
    state = reduceAgentWsEvent(state, { action: "stream", data: { session_id: "ses-1", content: "好" } });
    state = reduceAgentWsEvent(state, first);

    expect(selectAgentMessages(state, "ses-1")).toMatchObject([
      { role: "assistant", content: "你好", streaming: true, status: "streaming" },
    ]);
    expect(selectAgentRuntimeState(state, "ses-1")).toBe("running");
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

    state = reduceAgentWsEvent(state, { action: "stream", data: { session_id: "ses-2", content: "处理中" } });
    state = reduceAgentWsEvent(state, { action: "cancelled", data: { session_id: "ses-2" } });
    expect(selectAgentMessages(state, "ses-2")[0]).toMatchObject({
      streaming: false,
      cancelled: true,
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
    active_session_id: null,
    parent_session_id: null,
    child_session_id: null,
    source_trace_id: null,
    created_at: "2026-06-18T07:00:00Z",
    updated_at: updatedAt,
    is_debug: false,
    is_scheduled: false,
    is_current: false,
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
