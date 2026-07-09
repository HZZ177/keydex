import { describe, expect, it } from "vitest";

import type { A2UIObject } from "@/types/protocol";
import {
  A2UIStreamCache,
  applyA2UIEventToDebug,
  buildA2UICancelPayload,
  buildA2UIDebugKey,
  buildA2UISubmitPayload,
  createA2UIDebugState,
  createA2UIRequestId,
  extractA2UIEventSnapshot,
  mergeA2UIDebugSnapshot,
  mergeA2UIEventIntoMessages,
  normalizeA2UIAction,
  parseA2UIArgsBuffer,
  parsePartialJson,
  sanitizeA2UIPayload,
} from "@/renderer/pages/conversation/messages/a2ui";

describe("A2UI protocol utilities", () => {
  it("parses partial JSON objects, arrays, and strings", () => {
    expect(parsePartialJson('{"title":"继续')).toMatchObject({
      complete: false,
      value: { title: "继续" },
    });
    expect(parsePartialJson('{"items":[{"id":1}')).toMatchObject({
      complete: false,
      value: { items: [{ id: 1 }] },
    });
    expect(parsePartialJson('["a","b"')).toMatchObject({
      complete: false,
      value: ["a", "b"],
    });
    expect(parsePartialJson('{"ok":true}')).toMatchObject({
      complete: true,
      value: { ok: true },
    });

    expect(parseA2UIArgsBuffer('{"title":"确认', false)).toMatchObject({
      jsonParseStatus: "partial",
      parsedArgs: { title: "确认" },
    });
    expect(parseA2UIArgsBuffer('{"title":"确认', true)).toMatchObject({
      jsonParseStatus: "invalid",
      parsedArgs: { title: "确认" },
    });
  });

  it("extracts snapshots from root, a2ui, interaction, and stream payloads", () => {
    const snapshot = extractA2UIEventSnapshot({
      trace_id: "trace-1",
      turn_index: 3,
      stream_group_id: "stream-group-confirm",
      stream: {
        status: "chunk",
        chunk_index: 2,
        args_delta: '"title":"确认"',
        args_text_length: 18,
      },
      a2ui: {
        render_key: "confirm",
        mode: "interactive",
        stream_id: "stream-confirm",
        tool_call_id: "tool-confirm",
        payload: { title: "确认" },
        input_schema: { type: "object" },
        submit_schema: { type: "object" },
        interaction: {
          interaction_id: "int-confirm",
          status: "waiting_user_input",
          can_submit: true,
        },
      },
    });

    expect(snapshot).toMatchObject({
      traceId: "trace-1",
      turnIndex: 3,
      renderKey: "confirm",
      mode: "interactive",
      streamId: "stream-confirm",
      streamGroupId: "stream-group-confirm",
      interactionId: "int-confirm",
      toolCallId: "tool-confirm",
      argsDelta: '"title":"确认"',
      argsTextLength: 18,
      chunkIndex: 2,
      payload: { title: "确认" },
      inputSchema: { type: "object" },
      submitSchema: { type: "object" },
    });
    expect(buildA2UIDebugKey("a2ui.stream.chunk", snapshot)).toBe("stream-confirm");
  });

  it("merges stream start, chunk, finish, and created by the same stream id", () => {
    const cache = new A2UIStreamCache();
    const streamId = "a2ui:confirm:tool-1";

    cache.apply("a2ui.stream.start", {
      render_key: "confirm",
      stream_id: streamId,
      tool_call_id: "tool-1",
      stream: { status: "start", chunk_index: 0, args_text_length: 0 },
    }, { now: 1000 });
    cache.apply("a2ui_stream_chunk", {
      render_key: "confirm",
      stream_id: streamId,
      tool_call_id: "tool-1",
      stream: {
        status: "chunk",
        chunk_index: 1,
        args_delta: '{"title":"确认"',
        args_text_length: 14,
      },
    }, { now: 1001 });
    cache.apply("a2ui_stream_finish", {
      render_key: "confirm",
      stream_id: streamId,
      tool_call_id: "tool-1",
      stream: { status: "finish", args_text_length: 14, finish_reason: "tool_args_completed" },
    }, { now: 1002 });
    const created = cache.apply("a2ui_created", {
      stream_id: streamId,
      interaction_id: "int-1",
      a2ui: a2uiObject({
        render_key: "confirm",
        mode: "interactive",
        stream_id: streamId,
        tool_call_id: "tool-1",
        interaction: {
          interaction_id: "int-1",
          status: "waiting_user_input",
          can_submit: true,
        },
      }),
    }, { now: 1003 });

    expect(created.created).toBe(false);
    expect(created.messages).toHaveLength(1);
    expect(created.message).toMatchObject({
      role: "a2ui",
      streaming: false,
      a2ui: { render_key: "confirm", stream_id: streamId },
      a2uiDebug: {
        status: "created",
        chunkCount: 1,
        argsBuffer: '{"title":"确认"',
        jsonParseStatus: "invalid",
        parsedArgs: { title: "确认" },
        finishReason: "tool_args_completed",
      },
    });
  });

  it("upgrades a weak stream placeholder when the stable stream identity arrives", () => {
    const cache = new A2UIStreamCache();

    const started = cache.apply("a2ui_stream_start", {
      trace_id: "trace-weak",
      turn_index: 5,
      render_key: "chart",
      stream: { status: "start", chunk_index: 0, args_delta: '{"title":"图表"', args_text_length: 13 },
    }, {
      idFactory: () => "msg-weak-start",
      now: 4000,
    });
    const chunk = cache.apply("a2ui_stream_chunk", {
      trace_id: "trace-weak",
      turn_index: 5,
      render_key: "chart",
      stream_id: "trace-weak:a2ui:call-chart",
      tool_call_id: "call-chart",
      stream: {
        status: "chunk",
        chunk_index: 1,
        args_delta: ',"charts":[{"type":"column"}]}',
        args_text_length: 42,
      },
    }, {
      idFactory: () => "msg-strong-chunk",
      now: 4001,
    });

    expect(started.created).toBe(true);
    expect(chunk.created).toBe(false);
    expect(chunk.messages).toHaveLength(1);
    expect(chunk.message).toMatchObject({
      id: "msg-weak-start",
      role: "a2ui",
      streaming: true,
      a2uiDebug: {
        id: "trace-weak:a2ui:call-chart",
        streamId: "trace-weak:a2ui:call-chart",
        toolCallId: "call-chart",
        chunkCount: 1,
      },
    });
    expect(chunk.message?.a2uiDebug?.rawEvents.map((event) => event.action)).toEqual([
      "a2ui_stream_start",
      "a2ui_stream_chunk",
    ]);
  });

  it("keeps concurrent choice and form streams isolated in one turn", () => {
    const cache = new A2UIStreamCache();

    cache.apply("a2ui_stream_start", {
      trace_id: "trace-parallel",
      turn_index: 2,
      render_key: "form",
      stream: {
        status: "start",
        chunk_index: 0,
        args_delta: '{"title":"表单"',
        args_text_length: 13,
      },
    }, {
      idFactory: () => "msg-form",
      now: 5_000,
    });
    cache.apply("a2ui_stream_start", {
      trace_id: "trace-parallel",
      turn_index: 2,
      render_key: "choice",
      stream: {
        status: "start",
        chunk_index: 0,
        args_delta: '{"title":"选择"',
        args_text_length: 13,
      },
    }, {
      idFactory: () => "msg-choice",
      now: 5_001,
    });

    const snapshot = cache.snapshot();

    expect(snapshot).toHaveLength(2);
    expect(snapshot.map((message) => message.a2uiDebug?.renderKey).sort()).toEqual(["choice", "form"]);
    expect(snapshot.map((message) => message.id).sort()).toEqual(["msg-choice", "msg-form"]);
  });

  it("merges A2UI stream chunks by explicit stream group when stream id drifts", () => {
    const cache = new A2UIStreamCache();
    const groupId = "trace-drift:a2ui:model-run:0";

    const started = cache.apply("a2ui_stream_start", {
      trace_id: "trace-drift",
      turn_index: 2,
      render_key: "chart",
      stream_group_id: groupId,
      stream_id: "trace-drift:a2ui:model-run-a:0",
      tool_call_id: "model-run-a:0",
      stream: {
        status: "start",
        chunk_index: 0,
        args_delta: '{"title":"趋势图"',
        args_text: '{"title":"趋势图"',
        args_text_length: 13,
      },
    }, { now: 4100 });
    const chunk = cache.apply("a2ui_stream_chunk", {
      trace_id: "trace-drift",
      turn_index: 2,
      render_key: "chart",
      stream_group_id: groupId,
      stream_id: "trace-drift:a2ui:model-run-b:0",
      tool_call_id: "model-run-b:0",
      stream: {
        status: "chunk",
        chunk_index: 1,
        args_delta: ',"charts":[{"type":"line"}]}',
        args_text: '{"title":"趋势图","charts":[{"type":"line"}]}',
        args_text_length: 42,
      },
    }, { now: 4101 });
    const finished = cache.apply("a2ui_stream_finish", {
      trace_id: "trace-drift",
      turn_index: 2,
      render_key: "chart",
      stream_group_id: groupId,
      stream_id: "trace-drift:a2ui:model-run-c:0",
      tool_call_id: "model-run-c:0",
      stream: {
        status: "finish",
        args_text: '{"title":"趋势图","charts":[{"type":"line"}]}',
        args_text_length: 42,
        finish_reason: "tool_args_completed",
      },
    }, { now: 4102 });

    expect(started.created).toBe(true);
    expect(chunk.created).toBe(false);
    expect(finished.created).toBe(false);
    expect(finished.messages).toHaveLength(1);
    expect(finished.message?.a2uiDebug).toMatchObject({
      id: "trace-drift:a2ui:model-run-a:0",
      streamGroupId: groupId,
      status: "finished",
      chunkCount: 1,
      argsBuffer: '{"title":"趋势图","charts":[{"type":"line"}]}',
      jsonParseStatus: "valid",
      parsedArgs: { title: "趋势图", charts: [{ type: "line" }] },
    });
    expect(finished.message?.a2uiDebug?.rawEvents.map((event) => event.action)).toEqual([
      "a2ui_stream_start",
      "a2ui_stream_chunk",
      "a2ui_stream_finish",
    ]);
  });

  it("removes discarded stream placeholders before retry", () => {
    const cache = new A2UIStreamCache();

    cache.apply("a2ui_stream_start", {
      render_key: "chart",
      stream_id: "trace-1:a2ui:call_bad",
      tool_call_id: "call_bad",
      stream: {
        status: "start",
        args_delta: "{\"title\":",
        args_text: "{\"title\":",
        args_text_length: 9,
      },
    });
    const discarded = cache.apply("a2ui_stream_finish", {
      render_key: "chart",
      stream_id: "trace-1:a2ui:call_bad",
      tool_call_id: "call_bad",
      stream: {
        status: "finish",
        args_text: "{\"title\":",
        args_text_length: 9,
        finish_reason: "invalid_tool_call",
      },
    });
    cache.apply("a2ui_stream_start", {
      render_key: "chart",
      stream_id: "trace-1:a2ui:call_good",
      tool_call_id: "call_good",
      stream: {
        status: "start",
        args_delta: "{\"title\":\"有效图表\"}",
        args_text: "{\"title\":\"有效图表\"}",
        args_text_length: 16,
      },
    });

    const snapshot = cache.snapshot();
    expect(discarded.messages).toHaveLength(0);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.a2uiDebug?.streamId).toBe("trace-1:a2ui:call_good");
  });

  it("keeps tool error streams as failed cards before retry", () => {
    const cache = new A2UIStreamCache();

    cache.apply("a2ui_stream_start", {
      render_key: "chart",
      stream_id: "trace-1:a2ui:call_bad",
      tool_call_id: "call_bad",
      stream: {
        status: "start",
        args_delta: "{\"title\":\"错误图表\"",
        args_text: "{\"title\":\"错误图表\"",
        args_text_length: 15,
      },
    });
    const failed = cache.apply("a2ui_stream_finish", {
      render_key: "chart",
      stream_id: "trace-1:a2ui:call_bad",
      tool_call_id: "call_bad",
      stream: {
        status: "failed",
        args_text: "{\"title\":\"错误图表\"",
        args_text_length: 15,
        finish_reason: "tool_error",
        error: "$.charts[0].items[0].value: expected number",
      },
    });
    cache.apply("a2ui_stream_start", {
      render_key: "chart",
      stream_id: "trace-1:a2ui:call_retry",
      tool_call_id: "call_retry",
      stream: {
        status: "start",
        args_delta: "{\"title\":\"重试图表\"}",
        args_text: "{\"title\":\"重试图表\"}",
        args_text_length: 16,
      },
    });

    const snapshot = cache.snapshot();
    expect(failed.messages).toHaveLength(1);
    expect(failed.message?.a2uiDebug).toMatchObject({
      status: "failed",
      finishReason: "tool_error",
      error: "$.charts[0].items[0].value: expected number",
      parseError: "$.charts[0].items[0].value: expected number",
    });
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]?.a2uiDebug?.streamId).toBe("trace-1:a2ui:call_bad");
    expect(snapshot[0]?.a2uiDebug?.status).toBe("failed");
    expect(snapshot[1]?.a2uiDebug?.streamId).toBe("trace-1:a2ui:call_retry");
    expect(snapshot[1]?.a2uiDebug?.status).toBe("started");
  });

  it("keeps A2UI stream buffers monotonic from start delta and authoritative args text", () => {
    const debug = createA2UIDebugState("debug-chart", {
      renderKey: "chart",
      streamId: "stream-chart",
    }, 1100);

    applyA2UIEventToDebug(debug, "a2ui_stream_start", {
      render_key: "chart",
      stream_id: "stream-chart",
      stream: {
        status: "start",
        chunk_index: 0,
        args_delta: '{"title":"多图"',
        args_text: '{"title":"多图"',
        args_text_length: 13,
      },
    }, { now: 1101 });
    applyA2UIEventToDebug(debug, "a2ui_stream_chunk", {
      render_key: "chart",
      stream_id: "stream-chart",
      stream: {
        status: "chunk",
        chunk_index: 1,
        args_delta: ',"charts":[{"type":"pie","items":[{"name":"A","value":1}]}]}',
        args_text: '{"title":"多图","charts":[{"type":"pie","items":[{"name":"A","value":1}]}]}',
        args_text_length: 74,
      },
    }, { now: 1102 });

    expect(debug.argsBuffer).toBe('{"title":"多图","charts":[{"type":"pie","items":[{"name":"A","value":1}]}]}');
    expect(debug.argsBuffer).not.toContain('{"title":"多图"{"title"');
    expect(debug.jsonParseStatus).toBe("valid");
    expect(debug.parsedArgs).toEqual({
      title: "多图",
      charts: [{ type: "pie", items: [{ name: "A", value: 1 }] }],
    });
  });

  it("creates an A2UI message for created events without a stream preview", () => {
    const result = mergeA2UIEventIntoMessages([], "a2ui_created", {
      a2ui: a2uiObject({
        render_key: "chart",
        mode: "render",
        stream_id: "chart-stream",
        interaction: null,
      }),
    }, {
      idFactory: () => "msg-a2ui",
      now: 2000,
    });

    expect(result.created).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.message).toMatchObject({
      id: "msg-a2ui",
      role: "a2ui",
      contentType: "a2ui",
      a2ui: { render_key: "chart", mode: "render" },
      a2uiDebug: { status: "created" },
    });
  });

  it("ignores duplicated A2UI created events with the same semantic identity", () => {
    const cache = new A2UIStreamCache();
    const payload = {
      render_key: "chart",
      mode: "render",
      stream_id: "chart-stream",
      tool_call_id: "tool-chart",
      trace_id: "trace-1",
      turn_index: 1,
      a2ui: a2uiObject({
        render_key: "chart",
        mode: "render",
        stream_id: "chart-stream",
        tool_call_id: "tool-chart",
        interaction: null,
      }),
    };

    const first = cache.apply("a2ui_created", payload, {
      idFactory: () => "msg-a2ui",
      now: 2000,
    });
    const duplicated = cache.apply("a2ui_created", payload, {
      idFactory: () => "msg-a2ui-duplicated",
      now: 2001,
    });

    const snapshot = cache.snapshot();
    expect(first.created).toBe(true);
    expect(duplicated.message).toBeNull();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.id).toBe("msg-a2ui");
    expect(snapshot[0]?.a2uiDebug?.rawEvents).toHaveLength(1);
  });

  it("does not let non-terminal interaction snapshots overwrite submitted or cancelled state", () => {
    const debug = createA2UIDebugState("debug-1", {
      interactionId: "int-1",
      interaction: {
        interaction_id: "int-1",
        status: "submitted",
        can_submit: false,
        submit_request_id: "req-submit",
        submit_result: { confirmed: true },
      },
    }, 3000);

    mergeA2UIDebugSnapshot(debug, {
      interactionId: "int-1",
      interaction: {
        interaction_id: "int-1",
        status: "waiting_user_input",
        can_submit: true,
      },
    }, 3001);

    expect(debug.interaction).toMatchObject({
      interaction_id: "int-1",
      status: "submitted",
      can_submit: false,
      submit_request_id: "req-submit",
      submit_result: { confirmed: true },
    });
  });

  it("does not let stale waiting_input events regress terminal debug status", () => {
    const debug = createA2UIDebugState("debug-1", {
      interactionId: "int-1",
      interaction: {
        interaction_id: "int-1",
        status: "submitted",
        can_submit: false,
        submit_request_id: "req-submit",
        submit_result: { confirmed: true },
      },
    }, 3000);
    debug.status = "submitted";

    applyA2UIEventToDebug(debug, "waiting_input", {
      interaction_id: "int-1",
      interaction: {
        interaction_id: "int-1",
        status: "waiting_user_input",
        can_submit: true,
      },
    }, { now: 3001 });

    expect(debug.status).toBe("submitted");
    expect(debug.interaction).toMatchObject({
      interaction_id: "int-1",
      status: "submitted",
      can_submit: false,
      submit_request_id: "req-submit",
    });
  });

  it("builds submit and cancel payloads with stable request ids", () => {
    const submit = buildA2UISubmitPayload("ses-1", "int-1", {
      confirmed: true,
      skip: undefined,
      nested: { value: 1, dropped: undefined },
    }, "req-submit");
    const cancel = buildA2UICancelPayload("ses-1", "int-1", "用户取消", "req-cancel");

    expect(submit).toEqual({
      action: "a2ui_submit",
      session_id: "ses-1",
      interaction_id: "int-1",
      request_id: "req-submit",
      submit_result: { confirmed: true, nested: { value: 1 } },
    });
    expect(cancel).toEqual({
      action: "a2ui_cancel",
      session_id: "ses-1",
      interaction_id: "int-1",
      request_id: "req-cancel",
      cancel_reason: "用户取消",
    });
    expect(createA2UIRequestId("submit", 12345)).toMatch(/^submit-/);
    expect(normalizeA2UIAction("a2ui.stream.start")).toBe("a2ui_stream_start");
    expect(normalizeA2UIAction("a2ui_stream_start")).toBe("a2ui_stream_start");
  });

  it("sanitizes non-object A2UI payloads before submit", () => {
    expect(sanitizeA2UIPayload(null)).toEqual({});
    expect(sanitizeA2UIPayload({ value: 1, skip: undefined, list: [{ a: 1, b: undefined }] })).toEqual({
      value: 1,
      list: [{ a: 1 }],
    });
  });
});

function a2uiObject(patch: Partial<A2UIObject>): A2UIObject {
  return {
    render_key: "confirm",
    mode: "interactive",
    stream_id: "stream-1",
    tool_call_id: "tool-1",
    trace_id: "trace-1",
    turn_index: 1,
    payload: { title: "确认" },
    input_schema: { type: "object" },
    submit_schema: { type: "object" },
    interaction: {
      interaction_id: "int-1",
      status: "waiting_user_input",
      can_submit: true,
    },
    ...patch,
  };
}
