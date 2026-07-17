import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { A2UIBlock, parseA2UIMessage } from "@/renderer/pages/conversation/messages";
import { formSemanticAdapter } from "@/renderer/pages/conversation/messages/a2ui/adapters/formSemanticAdapter";
import {
  resetA2UISemanticStreamPlaybackForTests,
  useA2UISemanticStream,
} from "@/renderer/pages/conversation/messages/a2ui/runtime/useA2UISemanticStream";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { A2UIDebugBlockState, A2UIInteractionState, A2UIObject } from "@/types/protocol";

describe("A2UI semantic stream isolation", () => {
  beforeEach(() => {
    resetA2UISemanticStreamPlaybackForTests();
  });

  it("keeps concurrent form and choice streams independent while final payloads drain", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <>
          <A2UIBlock message={formStreamMessage([{ name: "title", label: "标题", type: "text", required: true }])} />
          <A2UIBlock
            message={choiceStreamMessage([{ label: "方案 A", value: "a", description: "先出现" }])}
          />
        </>,
      );

      expect(screen.getByLabelText(/标题/)).not.toBeNull();
      expect(screen.getByText(/方案 A/)).not.toBeNull();
      expect(screen.queryByLabelText(/预算/)).toBeNull();
      expect(screen.queryByText(/方案 B/)).toBeNull();

      rerender(
        <>
          <A2UIBlock
            message={formFinalMessage([
              { name: "title", label: "标题", type: "text", required: true },
              { name: "budget", label: "预算", type: "number" },
              { name: "owner", label: "负责人", type: "text" },
            ])}
          />
          <A2UIBlock
            message={choiceStreamMessage([
              { label: "方案 A", value: "a", description: "先出现" },
              { label: "方案 B", value: "b", description: "并发追加" },
            ], 2)}
          />
        </>,
      );

      expect(screen.getByLabelText(/标题/)).not.toBeNull();
      expect(screen.getByText(/方案 A/)).not.toBeNull();
      expect(screen.queryByLabelText(/预算/)).toBeNull();
      expect(screen.queryByText(/方案 B/)).toBeNull();

      act(() => {
        vi.advanceTimersByTime(900);
      });

      expect(screen.getByLabelText(/预算/)).not.toBeNull();
      expect(screen.getByText(/方案 B/)).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(900);
      });

      expect(screen.getByLabelText(/负责人/)).not.toBeNull();
      expect(screen.getAllByTestId("a2ui-block")).toHaveLength(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("replaces a partial choice option when its streamed value grows", () => {
    vi.useFakeTimers();
    try {
      const label = "Technical notes";
      const { rerender } = render(
        <A2UIBlock
          message={choiceStreamMessage([{ label, value: "technical", description: "" }])}
        />,
      );

      rerender(
        <A2UIBlock
          message={choiceStreamMessage([
            { label, value: "technical_notes", description: "Notes about languages and tools" },
          ], 2)}
        />,
      );

      act(() => {
        vi.advanceTimersByTime(1_200);
      });

      expect(screen.getByRole("radiogroup", { name: "选项" }).querySelectorAll("[data-option-value]")).toHaveLength(1);
      expect(screen.getByText("Notes about languages and tools")).not.toBeNull();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("converges when every render recreates an equivalent semantic frame", () => {
    vi.useFakeTimers();
    try {
      render(<UnstableSemanticProbe />);

      expect(screen.getByTestId("unstable-semantic-probe").getAttribute("data-visible")).toBe("1");

      act(() => {
        vi.advanceTimersByTime(2_400);
      });

      expect(screen.getByTestId("unstable-semantic-probe").getAttribute("data-visible")).toBe("3");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not replay a settled semantic stream after virtualization remounts it", () => {
    vi.useFakeTimers();
    try {
      const fields = [
        { name: "title", label: "Title", type: "text", required: true },
        { name: "budget", label: "Budget", type: "number" },
        { name: "owner", label: "Owner", type: "text" },
      ];
      const liveParsed = parseA2UIMessage(formStreamMessage(fields, 3));
      const finalParsed = parseA2UIMessage(formFinalMessage(fields));
      const view = render(<SemanticProbe parsed={liveParsed} scopeKey="remounted-form" />);

      act(() => {
        vi.advanceTimersByTime(2_400);
      });
      expect(screen.getByTestId("semantic-probe").getAttribute("data-visible")).toBe("3");

      view.rerender(<SemanticProbe parsed={finalParsed} scopeKey="remounted-form" />);
      expect(screen.getByTestId("semantic-probe").getAttribute("data-phase")).toBe("created");
      view.unmount();

      render(<SemanticProbe parsed={finalParsed} scopeKey="remounted-form" />);
      const remounted = screen.getByTestId("semantic-probe");
      expect(remounted.getAttribute("data-enabled")).toBe("false");
      expect(remounted.getAttribute("data-phase")).toBe("created");
      expect(remounted.getAttribute("data-visible")).toBe("3");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not start semantic playback from a created frame with stream evidence", () => {
    const fields = [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "budget", label: "Budget", type: "number" },
      { name: "owner", label: "Owner", type: "text" },
    ];
    const finalParsed = parseA2UIMessage(formFinalMessage(fields));
    const createdParsed = {
      ...finalParsed,
      status: "created" as const,
      debug: finalParsed.debug ? { ...finalParsed.debug, status: "created" as const } : null,
    };

    render(<SemanticProbe parsed={createdParsed} scopeKey="created-form" />);

    const probe = screen.getByTestId("semantic-probe");
    expect(probe.getAttribute("data-enabled")).toBe("false");
    expect(probe.getAttribute("data-phase")).toBe("created");
    expect(probe.getAttribute("data-visible")).toBe("3");
  });
});

function SemanticProbe({ parsed, scopeKey }: { parsed: ReturnType<typeof parseA2UIMessage>; scopeKey: string }) {
  const stream = useA2UISemanticStream(parsed, formSemanticAdapter, { scopeKey });
  return (
    <div
      data-testid="semantic-probe"
      data-enabled={stream.enabled ? "true" : "false"}
      data-phase={stream.phase}
      data-visible={stream.visibleUnitCount}
    />
  );
}

function UnstableSemanticProbe() {
  const parsed = parseA2UIMessage(formStreamMessage([
    { name: "title", label: "Title", type: "text", required: true },
    { name: "budget", label: "Budget", type: "number" },
    { name: "owner", label: "Owner", type: "text" },
  ], 3));
  const stream = useA2UISemanticStream(parsed, formSemanticAdapter, { scopeKey: "unstable-form" });
  return <div data-testid="unstable-semantic-probe" data-visible={stream.visibleUnitCount} />;
}

function formStreamMessage(fields: Array<Record<string, unknown>>, chunkCount = 1): ConversationMessage {
  const payload = {
    title: "请补充信息",
    fields,
  };
  return a2uiMessage({
    id: "form-live",
    renderKey: "form",
    mode: "interactive",
    status: "streaming",
    debug: {
      chunkCount,
      parsedArgs: payload,
      rawEvents: [streamEvent("form", "form-stream", chunkCount)],
    },
  });
}

function formFinalMessage(fields: Array<Record<string, unknown>>): ConversationMessage {
  const interaction = interactionState("form-interaction");
  const a2ui = a2uiObject({
    renderKey: "form",
    streamId: "form-stream",
    toolCallId: "form-tool",
    payload: {
      title: "请补充信息",
      fields,
    },
    interaction,
  });
  return a2uiMessage({
    id: "form-live",
    renderKey: "form",
    mode: "interactive",
    status: "waiting_input",
    a2ui,
    interaction,
    debug: {
      chunkCount: 12,
      parsedArgs: a2ui.payload,
      rawEvents: [streamEvent("form", "form-stream", 12), createdEvent("form", "form-stream")],
    },
  });
}

function choiceStreamMessage(options: Array<Record<string, unknown>>, chunkCount = 1): ConversationMessage {
  const payload = {
    title: "请选择",
    options,
  };
  return a2uiMessage({
    id: "choice-live",
    renderKey: "choice",
    mode: "interactive",
    status: "streaming",
    debug: {
      chunkCount,
      parsedArgs: payload,
      rawEvents: [streamEvent("choice", "choice-stream", chunkCount)],
    },
  });
}

function a2uiMessage({
  a2ui,
  debug,
  id,
  interaction,
  mode,
  renderKey,
  status,
}: {
  a2ui?: A2UIObject;
  debug: Partial<A2UIDebugBlockState>;
  id: string;
  interaction?: A2UIInteractionState;
  mode: "interactive" | "render";
  renderKey: string;
  status: A2UIDebugBlockState["status"];
}): ConversationMessage {
  return {
    id: `agent:${id}`,
    threadId: "semantic-stream-test",
    turnId: null,
    itemId: id,
    kind: "a2ui",
    status: status === "waiting_input" ? "pending" : "running",
    content: "",
    payload: {
      ...(a2ui ? { a2ui } : {}),
      a2uiDebug: {
        id,
        status,
        renderKey,
        mode,
        streamId: `${renderKey}-stream`,
        interactionId: interaction?.interaction_id ?? "",
        toolCallId: `${renderKey}-tool`,
        traceId: "trace-semantic-stream",
        turnIndex: 1,
        chunkCount: 0,
        argsBuffer: JSON.stringify(debug.parsedArgs ?? {}),
        argsTextLength: JSON.stringify(debug.parsedArgs ?? {}).length,
        jsonParseStatus: "valid",
        payload: {},
        inputSchema: {},
        submitSchema: {},
        updatedAt: 1_700_000_000_000,
        ...debug,
        rawEvents: debug.rawEvents ?? [],
      } satisfies A2UIDebugBlockState,
      ...(interaction ? { interaction, interactionId: interaction.interaction_id } : {}),
      renderKey,
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function a2uiObject({
  interaction,
  payload,
  renderKey,
  streamId,
  toolCallId,
}: {
  interaction: A2UIInteractionState;
  payload: Record<string, unknown>;
  renderKey: string;
  streamId: string;
  toolCallId: string;
}): A2UIObject {
  return {
    render_key: renderKey,
    mode: "interactive",
    stream_id: streamId,
    tool_call_id: toolCallId,
    trace_id: "trace-semantic-stream",
    turn_index: 1,
    payload,
    input_schema: {},
    submit_schema: {},
    interaction,
  };
}

function interactionState(interactionId: string): A2UIInteractionState {
  return {
    interaction_id: interactionId,
    status: "waiting_user_input",
    can_submit: true,
  };
}

function streamEvent(renderKey: string, streamId: string, chunkIndex: number) {
  return {
    id: `${streamId}:chunk:${chunkIndex}`,
    action: "a2ui_stream_chunk",
    timestamp: 1_700_000_000_000 + chunkIndex,
    data: {
      render_key: renderKey,
      stream_id: streamId,
      trace_id: "trace-semantic-stream",
      turn_index: 1,
      stream: {
        chunk_index: chunkIndex,
        status: "streaming",
      },
    },
  };
}

function createdEvent(renderKey: string, streamId: string) {
  return {
    id: `${streamId}:created`,
    action: "a2ui_created",
    timestamp: 1_700_000_000_100,
    data: {
      render_key: renderKey,
      stream_id: streamId,
      trace_id: "trace-semantic-stream",
      turn_index: 1,
    },
  };
}
