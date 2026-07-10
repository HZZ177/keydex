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
