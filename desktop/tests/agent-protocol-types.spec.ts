import { describe, expect, it } from "vitest";

import {
  AGENT_CHAT_ACTIONS,
  AGENT_COMPLETED_EVENT_ITEM_ACTIONS,
  AGENT_INBOUND_ACTIONS,
  AGENT_REPLAY_ACTIONS,
  type AgentActionEnvelope,
  type AgentChatMessage,
  type AgentCompletedPayload,
  type AgentSession,
  type AgentToolEventData,
  type ThreadTask,
  type ThreadTaskEventData,
  type ThreadTaskRun,
  type ThreadTaskRunEventData,
} from "@/types/protocol";

describe("agent protocol types", () => {
  it("exposes action constants aligned with the backend event contract", () => {
    expect(AGENT_CHAT_ACTIONS).toContain("session_created");
    expect(AGENT_CHAT_ACTIONS).toContain("stream");
    expect(AGENT_CHAT_ACTIONS).toContain("tool_start");
    expect(AGENT_CHAT_ACTIONS).toContain("tool_progress");
    expect(AGENT_CHAT_ACTIONS).toContain("tool_end");
    expect(AGENT_CHAT_ACTIONS).toContain("reasoning");
    expect(AGENT_CHAT_ACTIONS).toContain("completed");
    expect(AGENT_CHAT_ACTIONS).toContain("session_title_updated");
    expect(AGENT_CHAT_ACTIONS).toContain("task_updated");
    expect(AGENT_CHAT_ACTIONS).toContain("task_deleted");
    expect(AGENT_CHAT_ACTIONS).toContain("task_run_started");
    expect(AGENT_CHAT_ACTIONS).toContain("task_run_finished");
    expect(AGENT_REPLAY_ACTIONS).toContain("stream_batch");
    expect(AGENT_REPLAY_ACTIONS).toContain("reasoning");
    expect(AGENT_REPLAY_ACTIONS).toContain("task_updated");
    expect(AGENT_REPLAY_ACTIONS).toContain("task_run_finished");
    expect(AGENT_COMPLETED_EVENT_ITEM_ACTIONS).toEqual([
      "ai_message",
      "tool_start",
      "tool_end",
      "stream",
      "reasoning_message",
    ]);
    expect(AGENT_INBOUND_ACTIONS).toContain("create_session");
    expect(AGENT_INBOUND_ACTIONS).toContain("bind_session");
    expect(AGENT_INBOUND_ACTIONS).toContain("cancel");
  });

  it("constructs session and message shapes for all visible roles", () => {
    const session = {
      id: "ses_1",
      user_id: "local-user",
      scene_id: "desktop-agent",
      status: "running",
      title: "研读源码",
      session_tag: "chat",
      session_type: "workspace",
      workspace_id: "ws-1",
      cwd: "D:/repo",
      workspace_roots: ["D:/repo"],
      workspace: {
        id: "ws-1",
        name: "repo",
        root_path: "D:/repo",
        normalized_root_path: "d:/repo",
        type: "project",
        created_at: "2026-06-18T01:00:00Z",
        updated_at: "2026-06-18T01:00:00Z",
        last_opened_at: null,
        is_deleted: false,
      },
      active_session_id: null,
      parent_session_id: null,
      child_session_id: null,
      source_trace_id: null,
      created_at: "2026-06-18T01:00:00Z",
      updated_at: "2026-06-18T01:01:00Z",
      is_debug: false,
      is_scheduled: false,
      is_current: true,
      current_model_provider_id: "provider-1",
      current_model: "qwen-coder",
    } satisfies AgentSession;

    const messages = [
      message("user", "需求说明", { attachments: [{ type: "file", name: "REQ.md", path: "REQ.md" }] }),
      message("assistant", "实现完成", {
        ghostStats: {
          traceId: "trace_1",
          inputTokens: 120,
          cacheReadTokens: 0,
          outputTokens: 80,
        },
      }),
      message("tool", "", {
        runId: "run_tool",
        toolName: "read_file",
        toolParams: { path: "README.md" },
        toolResult: "content",
        toolDurationMs: 12,
        status: "completed",
      }),
      message("system", "系统提示"),
      message("subagent", "子任务结果", {
        subagentName: "reviewer",
        subagentId: "sub_1",
        subagentToolCalls: [
          {
            runId: "run_sub_tool",
            toolName: "search_text",
            status: "completed",
          },
        ],
      }),
      message("reasoning", "正在分析", { reasoningKind: "progress_fact" }),
      message("error", "模型失败", { traceId: "trace_failed" }),
    ] satisfies AgentChatMessage[];

    expect(session.status).toBe("running");
    expect(messages.map((item) => item.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "system",
      "subagent",
      "reasoning",
      "error",
    ]);
    expect(messages[0].attachments?.[0].name).toBe("REQ.md");
    expect(messages[1].ghostStats?.traceId).toBe("trace_1");
    expect(messages[2].toolName).toBe("read_file");
  });

  it("constructs tool and completed websocket payloads", () => {
    const toolStart = {
      session_id: "ses_1",
      run_id: "run_1",
      parent_run_id: null,
      tool: "apply_patch",
      params: { patch: "*** Begin Patch" },
      status: "running",
      trace_id: "trace_1",
      files: [{ path: "src/app.ts", added_lines: 2, deleted_lines: 1 }],
    } satisfies AgentToolEventData;

    const completed = {
      action: "completed",
      data: {
        session_id: "ses_1",
        status: "completed",
        trace_id: "trace_1",
        trace_record_id: "trace_1",
        events: [
          { action: "tool_start", data: toolStart },
          {
            action: "tool_end",
            data: {
              run_id: "run_1",
              tool: "apply_patch",
              result: "ok",
              duration_ms: 18,
            },
          },
          { action: "reasoning_message", data: { kind: "progress_fact", text: "已分析" } },
        ],
        chain_token_usage: {
          input_tokens: 100,
          cache_read_tokens: 10,
          output_tokens: 30,
        },
        latest_llm_token_usage: {
          input_tokens: 60,
          output_tokens: 20,
        },
        trace_query_context: {
          trace_id: "trace_1",
          trace_record_id: "trace_1",
        },
        final_content: "完成",
      },
    } satisfies AgentActionEnvelope<"completed", AgentCompletedPayload>;

    expect(completed.data.events.map((item) => item.action)).toEqual([
      "tool_start",
      "tool_end",
      "reasoning_message",
    ]);
    expect(completed.data.latest_llm_token_usage?.output_tokens).toBe(20);
  });

  it("constructs thread task websocket payloads", () => {
    const task = {
      id: "task_1",
      session_id: "ses_1",
      type: "goal",
      type_label: "目标",
      title: "目标",
      objective: "完成目标",
      status: "active",
      metadata: {},
      evidence: [],
      blocked_audit: {},
      system_stop_reason: null,
      current_run_id: "run_1",
      turn_count: 1,
      elapsed_seconds: 2,
      token_usage: { total_tokens: 42 },
      created_at: "2026-07-03T00:00:00Z",
      updated_at: "2026-07-03T00:01:00Z",
      deleted_at: null,
      is_open: true,
      is_terminal: false,
    } satisfies ThreadTask;
    const run = {
      id: "run_1",
      task_id: "task_1",
      session_id: "ses_1",
      turn_index: 3,
      trace_id: "trace_1",
      status: "running",
      summary: {},
      error: {},
      started_at: "2026-07-03T00:00:10Z",
      finished_at: null,
      created_at: "2026-07-03T00:00:10Z",
      updated_at: "2026-07-03T00:00:10Z",
      is_running: true,
    } satisfies ThreadTaskRun;

    const updated = {
      action: "task_updated",
      data: {
        session_id: "ses_1",
        task_id: task.id,
        task,
        run_id: run.id,
        trace_id: "trace_1",
        turn_index: 3,
      },
    } satisfies AgentActionEnvelope<"task_updated", ThreadTaskEventData>;
    const runStarted = {
      action: "task_run_started",
      data: {
        session_id: "ses_1",
        task_id: task.id,
        task,
        run_id: run.id,
        run,
        status: "running",
        reason: "auto_continue",
        trace_id: null,
        turn_index: null,
      },
    } satisfies AgentActionEnvelope<"task_run_started", ThreadTaskRunEventData>;
    const deleted = {
      action: "task_deleted",
      data: {
        session_id: "ses_1",
        task_id: task.id,
        task: { ...task, status: "cancelled", deleted_at: "2026-07-03T00:02:00Z" },
      },
    } satisfies AgentActionEnvelope<"task_deleted", ThreadTaskEventData>;
    const runFinished = {
      action: "task_run_finished",
      data: {
        session_id: "ses_1",
        task_id: task.id,
        task: { ...task, current_run_id: null },
        run_id: run.id,
        run: { ...run, status: "succeeded", is_running: false, finished_at: "2026-07-03T00:02:00Z" },
        run_status: "succeeded",
        trace_id: "trace_1",
        turn_index: 3,
      },
    } satisfies AgentActionEnvelope<"task_run_finished", ThreadTaskRunEventData>;

    expect(updated.data.task?.status).toBe("active");
    expect(runStarted.data.run.status).toBe("running");
    expect(deleted.data.task?.deleted_at).toBe("2026-07-03T00:02:00Z");
    expect(runFinished.data.run.status).toBe("succeeded");
  });
});

function message(
  role: AgentChatMessage["role"],
  content: string,
  patch: Partial<AgentChatMessage> = {},
): AgentChatMessage {
  return {
    id: `msg_${role}`,
    sessionId: "ses_1",
    role,
    content,
    timestamp: Date.UTC(2026, 5, 18),
    ...patch,
  };
}
