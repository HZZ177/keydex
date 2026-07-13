import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { A2UIBlock } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { A2UIDebugBlockState, A2UIInteractionState, A2UIObject, A2UIRenderKey } from "@/types/protocol";

describe("A2UI shared component states", () => {
  it("keeps long titles accessible inside a constrained container", () => {
    const longTitle = "一个非常长的图表标题用于验证窄宽容器不会丢失可访问标题和原始标题";
    render(
      <div style={{ width: 260 }}>
        <A2UIBlock
          message={a2uiMessage("chart", {
            title: longTitle,
            summary: "窄容器说明",
            charts: [
              {
                type: "column",
                title: "转化",
                series: [
                  {
                    name: "转化",
                    items: [
                      { name: "超长渠道名称 A", value: 10 },
                      { name: "超长渠道名称 B", value: 20 },
                    ],
                  },
                ],
              },
            ],
          })}
        />
      </div>,
    );

    const block = screen.getByTestId("a2ui-block");
    expect(block.getAttribute("aria-label")).toContain(`图表 A2UI：${longTitle}`);
    expect(block.querySelector(`[title="${longTitle}"]`)).not.toBeNull();
    expect(screen.getByTestId("a2ui-chart-panel").getAttribute("data-chart-type")).toBe("column");
  });

  it("renders pie charts through the shared ECharts surface", () => {
    render(
      <A2UIBlock
        message={a2uiMessage("chart", {
          title: "中国城市常住人口分布",
          summary: "覆盖主要城市",
          charts: [
            {
              type: "pie",
              title: "中国城市常住人口分布",
              items: [
                { name: "武汉", value: 932.3257913943515 },
                { name: "重庆", value: 3190.979 },
              ],
            },
          ],
        })}
      />,
    );

    const panel = screen.getByTestId("a2ui-chart-panel");
    const surface = screen.getByTestId("a2ui-echarts-surface");
    expect(panel.getAttribute("data-chart-type")).toBe("pie");
    expect(surface.getAttribute("data-a2ui-chart-engine")).toBe("echarts");
    expect(surface.getAttribute("data-a2ui-chart-tooltip")).toBe("item");
    expect(surface.getAttribute("data-a2ui-chart-interactions")).toBe("tooltip,legendToggle");
    expect(surface.getAttribute("data-a2ui-chart-data-count")).toBe("2");
  });

  it("does not expose editable form controls after a submitted form is restored", () => {
    render(
      <A2UIBlock
        message={a2uiMessage(
          "form",
          {
            title: "请补充参数",
            submit_label: "提交参数",
            fields: [
              { name: "title", label: "标题", type: "text", required: true },
              { name: "confirm", label: "确认执行", type: "boolean", required: true },
            ],
          },
          {
            interaction_id: "int-form-1",
            status: "submitted",
            can_submit: false,
            submit_result: {
              values: { title: "发布活动", confirm: true },
              note: "已确认",
            },
            resume_status: "succeeded",
          },
        )}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const result = within(screen.getByTestId("a2ui-form-result"));
    expect(result.getByText("本次填写已提交")).not.toBeNull();
    expect(result.getByText("发布活动")).not.toBeNull();
    expect(result.getByText("给 Keydex 的补充信息")).not.toBeNull();
    expect(result.getByText("已确认")).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: /标题/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "提交参数" })).toBeNull();
  });

  it("keeps cancelled choices read-only and status scoped to the restored card", () => {
    render(
      <A2UIBlock
        message={a2uiMessage(
          "choice",
          {
            title: "请选择方案",
            options: [
              { label: "方案 A", value: "a" },
              { label: "方案 B", value: "b" },
            ],
          },
          {
            interaction_id: "int-choice-1",
            status: "cancelled",
            can_submit: false,
            cancel_reason: "用户取消",
            resume_status: "succeeded",
          },
        )}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId("a2ui-status").textContent).toBe("已取消");
    expect(screen.getByTestId("a2ui-block").getAttribute("data-interactive-ready")).toBe("false");
    expect(screen.queryByRole("button", { name: "提交选择" })).toBeNull();
    expect(screen.queryByRole("radio", { name: /方案 A/ })).toBeNull();
  });
});

function a2uiMessage(
  renderKey: A2UIRenderKey,
  payload: Record<string, unknown>,
  interaction: A2UIInteractionState | null = renderKey === "chart" ? null : waitingInteraction(),
): ConversationMessage {
  const a2ui = a2uiObject(renderKey, payload, interaction);
  return {
    id: `agent:a2ui-${renderKey}-components`,
    threadId: "ses-1",
    turnId: null,
    itemId: `a2ui-${renderKey}-components`,
    kind: "a2ui",
    status: interaction?.status === "waiting_user_input" ? "pending" : "completed",
    content: "",
    payload: {
      a2ui,
      a2uiDebug: a2uiDebug(a2ui, interaction),
      interaction,
      interactionId: interaction?.interaction_id,
      renderKey,
      streamId: `stream-${renderKey}-components`,
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function a2uiObject(
  renderKey: A2UIRenderKey,
  payload: Record<string, unknown>,
  interaction: A2UIInteractionState | null,
): A2UIObject {
  return {
    render_key: renderKey,
    mode: renderKey === "chart" ? "render" : "interactive",
    stream_id: `stream-${renderKey}-components`,
    tool_call_id: `tool-${renderKey}-components`,
    trace_id: "trace-components",
    turn_index: 1,
    payload,
    input_schema: {},
    submit_schema: {},
    interaction,
  };
}

function a2uiDebug(a2ui: A2UIObject, interaction: A2UIInteractionState | null): A2UIDebugBlockState {
  return {
    id: a2ui.stream_id,
    status: interaction?.status === "waiting_user_input" ? "waiting_input" : interaction?.status === "submitted" ? "submitted" : interaction?.status === "cancelled" ? "cancelled" : "created",
    renderKey: a2ui.render_key,
    mode: a2ui.mode,
    streamId: a2ui.stream_id,
    interactionId: interaction?.interaction_id,
    toolCallId: a2ui.tool_call_id,
    traceId: a2ui.trace_id,
    turnIndex: a2ui.turn_index,
    chunkCount: 0,
    argsBuffer: "",
    argsTextLength: 0,
    jsonParseStatus: "valid",
    a2ui,
    payload: a2ui.payload,
    inputSchema: a2ui.input_schema,
    submitSchema: a2ui.submit_schema,
    interaction: interaction ?? undefined,
    rawEvents: [],
    updatedAt: 1_700_000_000_000,
  };
}

function waitingInteraction(): A2UIInteractionState {
  return {
    interaction_id: "int-1",
    status: "waiting_user_input",
    can_submit: true,
    resume_status: "not_started",
  };
}
