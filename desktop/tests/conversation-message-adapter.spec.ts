import { describe, expect, it } from "vitest";

import {
  agentMessageToConversationMessage,
  conversationKindFromAgent,
  payloadFromAgentMessage,
} from "@/renderer/pages/conversation/conversationMessageAdapter";
import { shouldDisplayAgentTranscriptMessage } from "@/renderer/utils/agentTranscriptVisibility";
import type { AgentChatMessage } from "@/types/protocol";

describe("conversation message adapter", () => {
  it("maps user and assistant messages without changing ids or content", () => {
    const user = agentMessage({
      id: "u1",
      role: "user",
      content: "hello",
      pendingInputId: "pending-steer",
      deliveryMode: "steer",
    });
    const assistant = agentMessage({ id: "a1", role: "assistant", content: "world", streaming: true });

    expect(agentMessageToConversationMessage(user, 0)).toMatchObject({
      id: "agent:u1",
      threadId: "ses-1",
      itemId: "u1",
      kind: "user",
      content: "hello",
      payload: {
        _sortSeq: 1,
        pendingInputId: "pending-steer",
        pending_input_id: "pending-steer",
        deliveryMode: "steer",
        delivery_mode: "steer",
      },
    });
    expect(agentMessageToConversationMessage(assistant, 1)).toMatchObject({
      id: "agent:a1",
      kind: "assistant",
      status: "running",
      content: "world",
      payload: { _sortSeq: 2 },
    });
  });

  it("keeps special tool kinds aligned with the Agent transcript renderer", () => {
    expect(
      conversationKindFromAgent(
        agentMessage({
          role: "system",
          metadata: { retry: { kind: "llm_retry", stage: "retrying" } },
        }),
      ),
    ).toBe("llm_retry");
    expect(conversationKindFromAgent(agentMessage({ role: "tool", toolName: "update_plan" }))).toBe("plan");
    expect(conversationKindFromAgent(agentMessage({ role: "tool", toolName: "load_skill" }))).toBe("skill");
    expect(conversationKindFromAgent(agentMessage({ role: "turn" }))).toBe("turn_marker");
    expect(conversationKindFromAgent(agentMessage({ role: "thread_task", toolName: "update_thread_task" }))).toBe(
      "thread_task_status",
    );
    expect(conversationKindFromAgent(agentMessage({ role: "tool", toolName: "update_thread_task" }))).toBe("tool");
    expect(conversationKindFromAgent(agentMessage({ role: "tool", toolName: "get_thread_task" }))).toBe("tool");
    expect(conversationKindFromAgent(agentMessage({ role: "tool", toolName: "run_cmd" }))).toBe("command");
    expect(
      conversationKindFromAgent(
        agentMessage({
          role: "tool",
          toolName: "apply_patch",
          uiPayload: { files: [{ path: "src/app.ts", operation: "modify" }] },
        }),
      ),
    ).toBe("tool");
    expect(conversationKindFromAgent(agentMessage({ role: "tool", toolName: "search_text" }))).toBe("tool");
    expect(conversationKindFromAgent(agentMessage({ role: "tool", toolName: "search_files" }))).toBe("tool");
    expect(conversationKindFromAgent(agentMessage({ role: "tool", toolName: "create_file", status: "error" }))).toBe(
      "tool",
    );
    expect(conversationKindFromAgent(agentMessage({ role: "tool", toolName: "run_cmd", status: "cancelled" }))).toBe(
      "command",
    );
  });

  it("classifies only valid web_activity v1 payloads as native web messages", () => {
    const webActivity = {
      kind: "web_activity",
      schema_version: 1,
      activity_type: "search",
      status: "completed",
      query: "latest",
      requested_urls: [],
      sources: [
        {
          source_id: "src_1",
          url: "https://example.com/a",
          domain: "example.com",
          title: "Example",
          snippet: "Summary",
          favicon: null,
          published_at: null,
          truncated: false,
          provider_raw: "discarded",
        },
      ],
      items: [],
      error: null,
      api_key: "discarded",
    };
    const converted = agentMessageToConversationMessage(
      agentMessage({ role: "tool", toolName: "web_search", uiPayload: webActivity }),
      0,
    );

    expect(converted.kind).toBe("web_activity");
    expect(converted.payload.web_activity).toMatchObject({
      kind: "web_activity",
      schema_version: 1,
      activity_type: "search",
      sources: [{ source_id: "src_1" }],
    });
    expect(JSON.stringify(converted.payload.web_activity)).not.toContain("api_key");
    expect(JSON.stringify(converted.payload.web_activity)).not.toContain("provider_raw");
    expect(
      conversationKindFromAgent(
        agentMessage({
          role: "tool",
          toolName: "web_search",
          uiPayload: { ...webActivity, schema_version: 2 },
        }),
      ),
    ).toBe("tool");
    expect(conversationKindFromAgent(agentMessage({ role: "tool", toolName: "search_text" }))).toBe("tool");
  });

  it("preserves tool payload data for shared drawer and overlay rendering", () => {
    const payload = payloadFromAgentMessage(
      agentMessage({
        role: "tool",
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "search_text",
        toolParams: { query: "Shell" },
        toolResult: "found",
        toolDurationMs: 42,
        uiPayload: { files: [{ path: "README.md" }] },
      }),
    );

    expect(payload).toMatchObject({
      call: { id: "call-1", name: "search_text", arguments: { query: "Shell" } },
      result: {
        status: "success",
        model_content: "found",
        duration_ms: 42,
        ui_payload: { files: [{ path: "README.md" }] },
        files: [{ path: "README.md" }],
      },
      files: [{ path: "README.md" }],
      runId: "run-1",
      toolCallId: "call-1",
    });
  });

  it("preserves completed reasoning duration for rendering and history recovery", () => {
    const message = agentMessage({
      role: "reasoning",
      content: "分析完成",
      timestamp: 1_700_000_000_000,
      reasoningDurationMs: 2400,
    });

    expect(agentMessageToConversationMessage(message, 0)).toMatchObject({
      kind: "thinking",
      createdAt: "2023-11-14T22:13:20.000Z",
      updatedAt: "2023-11-14T22:13:22.400Z",
      payload: {
        durationMs: 2400,
        duration_ms: 2400,
      },
    });
  });

  it("preserves completed turn duration for the assistant footer", () => {
    const message = agentMessage({
      role: "assistant",
      content: "处理完成",
      timestamp: 1_700_000_000_000,
      turnDurationMs: 3_723_000,
    });

    expect(agentMessageToConversationMessage(message, 0)).toMatchObject({
      kind: "assistant",
      payload: {
        turnDurationMs: 3_723_000,
        turn_duration_ms: 3_723_000,
      },
    });
  });

  it("preserves cancelled command tool payloads for replay", () => {
    const payload = payloadFromAgentMessage(
      agentMessage({
        role: "tool",
        status: "cancelled",
        toolName: "run_cmd",
        uiPayload: { command_id: "cmd-1", status: "cancelled", command: "ping" },
      }),
    );

    expect(payload).toMatchObject({
      call: { name: "run_cmd" },
      result: {
        status: "cancelled",
        ui_payload: { command_id: "cmd-1", status: "cancelled", command: "ping" },
      },
    });
  });

  it("maps semantic thread task status messages to the target status panel payload", () => {
    const payload = payloadFromAgentMessage(
      agentMessage({
        role: "thread_task",
        toolName: "update_thread_task",
        toolParams: { status: "complete", summary: "目标已完成" },
        uiPayload: { task: { id: "task-1", type: "goal", objective: "验证目标", status: "complete" } },
        turnIndex: 3,
        traceId: "trace-goal-3",
        metadata: { kind: "thread_task_status", status: "complete" },
      }),
    );

    expect(payload).toMatchObject({
      turnIndex: 3,
      traceId: "trace-goal-3",
      call: { name: "update_thread_task", arguments: { status: "complete", summary: "目标已完成" } },
      result: {
        status: "success",
        ui_payload: { task: { id: "task-1", type: "goal", objective: "验证目标", status: "complete" } },
      },
    });
  });

  it("maps approval, error and subagent payloads for shared message components", () => {
    expect(agentMessageToConversationMessage(agentMessage({ role: "approval", status: "pending" }), 0)).toMatchObject({
      kind: "approval",
      status: "pending",
    });
    expect(payloadFromAgentMessage(agentMessage({ role: "error", status: "failed", content: "boom" }))).toMatchObject({
      error: { code: "failed", message: "boom", details: {} },
    });
    expect(
      payloadFromAgentMessage(
        agentMessage({
          role: "assistant",
          status: "failed",
          content: "answer",
          metadata: {
            turnError: {
              code: "llm_read_timeout",
              message: "模型响应超时，未收到后续响应数据",
              details: { exception_type: "httpx.ReadTimeout" },
            },
          },
        }),
      ),
    ).toMatchObject({
      error: {
        code: "llm_read_timeout",
        message: "模型响应超时，未收到后续响应数据",
        details: { exception_type: "httpx.ReadTimeout" },
      },
    });
    expect(
      payloadFromAgentMessage(
        agentMessage({
          role: "subagent",
          subagentName: "reviewer",
          subagentTask: "check",
          subagentItems: [{ id: "item-1", type: "text", content: "ok", timestamp: 1 }],
        }),
      ),
    ).toMatchObject({
      reasoningKind: "subagent",
      reasoning_kind: "subagent",
      subagentName: "reviewer",
      subagentTask: "check",
      subagentItems: [{ id: "item-1", type: "text", content: "ok", timestamp: 1 }],
    });
  });

  it("keeps task continuation prompts out of the visible transcript while preserving assistant output", () => {
    expect(
      shouldDisplayAgentTranscriptMessage(
        agentMessage({
          role: "user",
          content: "<thread_task_context>继续目标</thread_task_context>",
          metadata: { hidden_for_transcript: true, source: "thread_task" },
        }),
      ),
    ).toBe(false);
    expect(
      shouldDisplayAgentTranscriptMessage(
        agentMessage({
          role: "user",
          content: "legacy task continuation",
          metadata: {
            runtime_params: {
              thread_task: {
                task_id: "task-1",
                run_id: "run-1",
                trigger: "task_continue",
              },
            },
          },
        }),
      ),
    ).toBe(false);
    expect(
      shouldDisplayAgentTranscriptMessage(
        agentMessage({
          role: "assistant",
          content: "任务轮次结果",
          metadata: {
            runtime_params: {
              thread_task: {
                task_id: "task-1",
                run_id: "run-1",
                trigger: "task_continue",
              },
            },
          },
        }),
      ),
    ).toBe(true);
    expect(
      shouldDisplayAgentTranscriptMessage(
        agentMessage({
          role: "tool",
          toolName: "update_thread_task",
          content: "",
        }),
      ),
    ).toBe(false);
    expect(
      shouldDisplayAgentTranscriptMessage(
        agentMessage({
          role: "tool",
          toolName: "get_thread_task",
          content: "",
        }),
      ),
    ).toBe(false);
  });
});

function agentMessage(patch: Partial<AgentChatMessage>): AgentChatMessage {
  return {
    id: "msg-1",
    sessionId: "ses-1",
    role: "assistant",
    content: "",
    timestamp: 1_700_000_000_000,
    ...patch,
  } as AgentChatMessage;
}
