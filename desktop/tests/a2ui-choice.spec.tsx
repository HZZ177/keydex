import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { A2UIBlock } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { A2UIDebugBlockState, A2UIInteractionState, A2UIObject } from "@/types/protocol";

const CORRECTION_BUTTON = "以上都不对！我来告诉keydex应该怎么做";
const CORRECTION_LABEL = "我来告诉keydex应该怎么做";

function optionElement(label: RegExp | string): HTMLElement {
  const option = screen.getByText(label).closest<HTMLElement>("[data-option-value]");
  if (!option) {
    throw new Error(`Missing choice option for ${String(label)}`);
  }
  return option;
}

function clickChoiceButton(label: string) {
  fireEvent.click(screen.getByRole("button", { name: `选择 ${label}` }));
}

function mockNotificationDescriptionOverflow(overflowFragments: string[]): () => void {
  const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute("data-a2ui-notification-description") !== "true") {
        return 0;
      }
      return overflowFragments.some((fragment) => this.textContent?.includes(fragment)) ? 64 : 18;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("data-a2ui-notification-description") === "true" ? 18 : 0;
    },
  });

  return () => {
    if (originalScrollHeight) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    }
    if (originalClientHeight) {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    }
  };
}

describe("A2ChoiceBlock", () => {
  it("submits a single selected value", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<A2UIBlock message={choiceMessage()} onSubmit={onSubmit} onCancel={vi.fn()} />);

    const submitButton = screen.getByRole("button", { name: "提交选择" }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    expect(screen.queryByText("请选择一个选项")).toBeNull();
    expect(screen.queryByLabelText(CORRECTION_LABEL)).toBeNull();

    clickChoiceButton("方案 B");
    fireEvent.click(screen.getByRole("button", { name: "提交选择" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("int-choice-1", {
        selected_values: ["b"],
      }, "ses-1");
    });
  });

  it("submits correction note as an exclusive choice", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<A2UIBlock message={choiceMessage()} onSubmit={onSubmit} onCancel={vi.fn()} />);

    const option = optionElement(/方案 A/);
    clickChoiceButton("方案 A");
    expect(option.getAttribute("data-selected")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: CORRECTION_BUTTON }));

    expect(option.getAttribute("data-selected")).toBe("false");
    expect(screen.queryByText("请输入说明")).toBeNull();
    expect((screen.getByRole("button", { name: "提交选择" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(CORRECTION_LABEL), { target: { value: "换一组更稳妥的方案" } });
    fireEvent.click(screen.getByRole("button", { name: "提交选择" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("int-choice-1", {
        selected_values: [],
        result_type: "correction",
        correction_note: "换一组更稳妥的方案",
      }, "ses-1");
    });
  });

  it("validates minimum selection for multiple choice", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <A2UIBlock
        message={choiceMessage({
          payload: { multiple: true, min_selected: 2, max_selected: 2 },
        })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    clickChoiceButton("方案 A");

    expect(screen.getByText("请至少选择 2 个选项")).not.toBeNull();
    expect((screen.getByRole("button", { name: "提交选择" }) as HTMLButtonElement).disabled).toBe(true);

    clickChoiceButton("方案 B");
    fireEvent.click(screen.getByRole("button", { name: "提交选择" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("int-choice-1", {
        selected_values: ["a", "b"],
      }, "ses-1");
    });
  });

  it("renders recommended, default and disabled options as decision metadata", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <A2UIBlock
        message={choiceMessage({
          payload: {
            default_values: ["b"],
            options: [
              { label: "方案 A", value: "a", description: "依赖较多", disabled: true, badge: "暂不可用" },
              { label: "方案 B", value: "b", description: "收益最高", recommended: true },
            ],
          },
        })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("推荐")).not.toBeNull();
    expect(screen.getByText("暂不可用")).not.toBeNull();
    expect(screen.getByText("已选 1 项 / 单选")).not.toBeNull();
    expect((screen.getByRole("button", { name: "选择 方案 A" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "提交选择" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("int-choice-1", {
        selected_values: ["b"],
      }, "ses-1");
    });
  });

  it("expands long card content inside the gallery card without changing selection", async () => {
    const longDescription = "这是一个很长的选项说明，用来解释完整背景、适用条件、执行步骤、风险边界和后续动作，应该在卡片内部完整展示，而不是通过悬浮窗占据页面。它还会继续补充上下文、约束、预期收益、失败处理和用户需要提前确认的信息。";
    render(
      <A2UIBlock
        message={choiceMessage({
          payload: {
            options: Array.from({ length: 10 }, (_, index) => ({
              label: `选项 ${index + 1}`,
              value: `option_${index + 1}`,
              description: longDescription,
            })),
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const options = screen.getByRole("radiogroup", { name: "选项" });
    expect(options.getAttribute("data-choice-density")).toBe("dense");
    expect(options.getAttribute("data-a2ui-choice-layout")).toBe("coverflow");
    expect(screen.queryByTestId("a2ui-choice-detail")).toBeNull();

    const option = options.querySelector<HTMLInputElement>('input[value="option_1"]')?.closest<HTMLElement>("[data-option-value]");
    expect(option).not.toBeNull();
    expect(option?.getAttribute("data-detail-expanded")).toBe("false");
    expect(option?.textContent).not.toContain(longDescription);

    fireEvent.click(within(option as HTMLElement).getByRole("button", { name: "展开 选项 1 完整内容" }));

    await waitFor(() => {
      expect(option?.getAttribute("data-detail-expanded")).toBe("true");
    });
    expect(option?.textContent).toContain(longDescription);
    expect(option?.getAttribute("data-selected")).toBe("false");
    expect(screen.queryByTestId("a2ui-choice-detail")).toBeNull();

    fireEvent.click(within(option as HTMLElement).getByRole("button", { name: "收起 选项 1 完整内容" }));

    await waitFor(() => {
      expect(option?.getAttribute("data-detail-expanded")).toBe("false");
    });
    expect(option?.textContent).not.toContain(longDescription);

    fireEvent.click(within(option as HTMLElement).getByRole("button", { name: "展开 选项 1 完整内容" }));

    await waitFor(() => {
      expect(option?.getAttribute("data-detail-expanded")).toBe("true");
    });
    expect(option?.textContent).toContain(longDescription);
  });

  it("expands long historical gallery cards in place instead of opening a detail popover", async () => {
    const longDescription = "历史选项包含很多完整说明，需要在卡片内部展开展示。这里补充上下文、适用条件、风险说明、预期结果和用户需要确认的信息，确保卡片正文默认会被截断，展开后可以在卡片里滚动查看完整内容。还会继续描述执行顺序、依赖前提、异常兜底、交付物、回溯线索和后续协作方式。";
    render(
      <A2UIBlock
        message={choiceMessage({
          payload: {
            options: [
              { label: "历史长选项", value: "history_long", description: longDescription },
              { label: "历史短选项", value: "history_short", description: "短说明" },
            ],
          },
          interaction: {
            interaction_id: "int-choice-1",
            status: "submitted",
            can_submit: false,
            submit_result: { selected_values: ["history_short"] },
            resume_status: "succeeded",
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const result = within(screen.getByTestId("a2ui-choice-result"));
    const option = result.getByText("历史长选项").closest<HTMLElement>("[data-option-value]");
    expect(option).not.toBeNull();
    expect(option?.getAttribute("data-detail-expanded")).toBe("false");
    expect(option?.textContent).not.toContain(longDescription);

    const gallery = screen.getByTestId("a2ui-choice-result").querySelector<HTMLElement>('[data-a2ui-choice-layout="coverflow"]');
    const expandButton = within(option as HTMLElement).getByRole("button", { name: "展开 历史长选项 完整内容" });
    fireEvent.pointerDown(expandButton, { button: 0, clientX: 120, pointerId: 1 });
    expect(gallery?.dataset.dragging).toBeUndefined();

    fireEvent.click(expandButton);

    await waitFor(() => {
      expect(option?.getAttribute("data-detail-expanded")).toBe("true");
    });
    expect(option?.textContent).toContain(longDescription);
    expect(screen.queryByTestId("a2ui-choice-detail")).toBeNull();
  });

  it("hides the top slider for choice galleries with ten or fewer options", () => {
    render(
      <A2UIBlock
        message={choiceMessage({
          payload: {
            options: Array.from({ length: 10 }, (_, index) => ({
              label: `少量选项 ${index + 1}`,
              value: `compact_${index + 1}`,
              description: `第 ${index + 1} 个选项`,
            })),
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByRole("slider", { name: "快速定位选项" })).toBeNull();
  });

  it("uses a top slider to jump across dense choice galleries with more than ten options", async () => {
    render(
      <A2UIBlock
        message={choiceMessage({
          payload: {
            options: Array.from({ length: 11 }, (_, index) => ({
              label: `密集选项 ${index + 1}`,
              value: `dense_${index + 1}`,
              description: `第 ${index + 1} 个选项`,
            })),
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const slider = screen.getByRole("slider", { name: "快速定位选项" });
    expect(slider.getAttribute("aria-valuemax")).toBe("10");
    expect(slider.getAttribute("aria-valuenow")).toBe("2");
    expect(slider.getAttribute("aria-valuetext")).toBe("3/11");
    expect(slider.textContent).toBe("3/11");

    fireEvent.keyDown(slider, { key: "End" });

    await waitFor(() => {
      expect(optionElement(/密集选项 11/).getAttribute("data-coverflow-position")).toBe("center");
    });
    expect(slider.getAttribute("aria-valuenow")).toBe("10");
    expect(slider.getAttribute("aria-valuetext")).toBe("11/11");
    expect(slider.textContent).toBe("11/11");
  });

  it("uses the interactive motion layer for choice scenes and option selection", async () => {
    render(<A2UIBlock message={choiceMessage()} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByTestId("a2ui-choice").getAttribute("data-a2ui-interactive-motion")).toBe("true");
    expect(screen.getByTestId("a2ui-choice").getAttribute("data-a2ui-motion-state")).toBe("active");
    expect(screen.getByRole("radiogroup", { name: "选项" }).getAttribute("data-a2ui-choice-layout")).toBe("coverflow");

    const option = optionElement(/方案 A/);
    expect(option?.getAttribute("data-a2ui-interactive-item")).toBe("true");
    expect(option?.getAttribute("data-a2ui-motion-variant")).toBe("option");
    expect(option?.getAttribute("data-coverflow-position")).toBe("prev");
    expect(optionElement(/方案 B/).getAttribute("data-coverflow-position")).toBe("center");
    expect(option?.getAttribute("tabindex")).toBeNull();
    expect(option?.querySelector("[data-a2ui-choice-morph]")).not.toBeNull();
    expect(option?.querySelector("[data-a2ui-choice-card]")).not.toBeNull();

    fireEvent.click(option);

    expect(screen.getByTestId("a2ui-choice").getAttribute("data-a2ui-motion-state")).toBe("active");
    expect(option?.getAttribute("data-selected")).toBe("false");
    await waitFor(() => {
      expect(option?.getAttribute("data-coverflow-position")).toBe("center");
    });
    expect((screen.getByRole("button", { name: "提交选择" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(option).getByRole("button", { name: "选择 方案 A" }));

    expect(screen.getByTestId("a2ui-choice").getAttribute("data-a2ui-motion-state")).toBe("dirty");
    expect(option?.getAttribute("data-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "提交选择" }).getAttribute("data-a2ui-action-motion")).toBe("true");

    fireEvent.click(within(option).getByRole("button", { name: "取消选择 方案 A" }));

    expect(screen.getByTestId("a2ui-choice").getAttribute("data-a2ui-motion-state")).toBe("active");
    expect(option?.getAttribute("data-selected")).toBe("false");
    expect((screen.getByRole("button", { name: "提交选择" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("locks parent message auto-follow before interactive A2UI layout changes", () => {
    render(
      <div data-testid="message-list-scroll">
        <A2UIBlock message={choiceMessage()} onSubmit={vi.fn()} onCancel={vi.fn()} />
      </div>,
    );

    const scroller = screen.getByTestId("message-list-scroll");
    expect(scroller.hasAttribute("data-expansion-scroll-lock")).toBe(false);

    fireEvent.pointerDown(screen.getByTestId("a2ui-choice"));

    expect(scroller.getAttribute("data-expansion-scroll-lock")).toBe("true");
  });

  it("renders notification stack choices as expanded live notifications and keeps submit payload unchanged", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const restoreOverflowMock = mockNotificationDescriptionOverflow(["第一条通知的完整说明"]);
    try {
      render(
        <A2UIBlock
          message={choiceMessage({
            payload: {
              presentation_mode: "notification_stack",
              options: [
                { label: "通知 A", value: "notice_a", description: "第一条通知的完整说明", badge: "任务" },
                { label: "通知 B", value: "notice_b", description: "短说明", badge: "提醒" },
              ],
            },
          })}
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />,
      );

      const stack = screen.getByTestId("a2ui-choice-notification-stack");
      expect(stack.getAttribute("data-a2ui-choice-layout")).toBe("notification_stack");
      expect(stack.getAttribute("data-expanded")).toBe("true");
      expect(screen.getByRole("button", { name: "收起选项通知栈" }).getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText("第一条通知的完整说明")).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "收起选项通知栈" }));

      expect(stack.getAttribute("data-expanded")).toBe("false");
      expect(screen.getByRole("button", { name: "展开选项通知栈" }).getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(screen.getByRole("button", { name: "展开选项通知栈" }));

      const noticeAItem = stack.querySelector<HTMLElement>("[data-option-value='notice_a']");
      const noticeACard = noticeAItem?.querySelector<HTMLElement>("[data-a2ui-notification-card='true']");
      await waitFor(() => {
        expect(noticeAItem?.getAttribute("data-message-expandable")).toBe("true");
      });
      expect(noticeAItem?.getAttribute("data-message-expanded")).toBe("false");
      fireEvent.click(noticeACard as HTMLElement);
      expect(stack.getAttribute("data-expanded")).toBe("true");
      expect(noticeAItem?.getAttribute("data-message-expanded")).toBe("true");

      const noticeBItem = stack.querySelector<HTMLElement>("[data-option-value='notice_b']");
      const noticeBCard = noticeBItem?.querySelector<HTMLElement>("[data-a2ui-notification-card='true']");
      expect(noticeBItem?.getAttribute("data-message-expandable")).toBe("false");
      fireEvent.click(noticeBCard as HTMLElement);
      expect(noticeBItem?.getAttribute("data-message-expanded")).toBe("false");

      const noticeBButton = screen.getByRole("button", { name: "选择 通知 B" });
      const noticeBLabel = screen.getByText("通知 B");
      expect(Boolean(noticeBButton.compareDocumentPosition(noticeBLabel) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

      fireEvent.click(noticeBButton);
      fireEvent.click(screen.getByRole("button", { name: "提交选择" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith("int-choice-1", {
          selected_values: ["notice_b"],
        }, "ses-1");
      });
    } finally {
      restoreOverflowMock();
    }
  });

  it("does not keep notification stack cancel loading when another interaction remains pending", async () => {
    vi.useFakeTimers();
    try {
      const onCancel = vi.fn(() => new Promise<void>(() => undefined));
      render(
        <A2UIBlock
          message={choiceMessage({
            payload: {
              presentation_mode: "notification_stack",
              options: [
                { label: "通知 A", value: "notice_a", description: "第一条通知" },
                { label: "通知 B", value: "notice_b", description: "第二条通知" },
              ],
            },
          })}
          onSubmit={vi.fn()}
          onCancel={onCancel}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "取消" }));

      expect(onCancel).toHaveBeenCalledWith("int-choice-1", "用户取消", "ses-1");
      expect(screen.getByRole("button", { name: "取消中" }).getAttribute("data-badge-state")).toBe("loading");

      await act(async () => {
        vi.advanceTimersByTime(120);
        await Promise.resolve();
      });

      expect(screen.getByRole("button", { name: "已取消" }).getAttribute("data-badge-state")).toBe("done");

      await act(async () => {
        vi.advanceTimersByTime(420);
        await Promise.resolve();
      });

      expect(screen.getByRole("button", { name: "已取消" }).getAttribute("data-badge-state")).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not center a card when only its selection button is clicked", async () => {
    render(<A2UIBlock message={choiceMessage()} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    clickChoiceButton("方案 C");

    await waitFor(() => {
      expect(optionElement(/方案 C/).getAttribute("data-selected")).toBe("true");
    });
    expect(optionElement(/方案 B/).getAttribute("data-coverflow-position")).toBe("center");
    expect(optionElement(/方案 C/).getAttribute("data-coverflow-position")).toBe("next");
  });

  it("does not keep the submit badge loading when the transport promise hangs", async () => {
    vi.useFakeTimers();
    try {
      const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
      render(<A2UIBlock message={choiceMessage()} onSubmit={onSubmit} onCancel={vi.fn()} />);

      clickChoiceButton("方案 A");
      fireEvent.click(screen.getByRole("button", { name: "提交选择" }));

      expect(screen.getByRole("button", { name: "提交中" }).getAttribute("data-badge-state")).toBe("loading");

      await act(async () => {
        vi.advanceTimersByTime(120);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByRole("button", { name: "已提交" }).getAttribute("data-badge-state")).toBe("done");

      await act(async () => {
        vi.advanceTimersByTime(420);
        await Promise.resolve();
      });

      expect(screen.getByRole("button", { name: "已提交" }).getAttribute("data-badge-state")).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends cancel with a note reason", async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(<A2UIBlock message={choiceMessage()} onSubmit={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: CORRECTION_BUTTON }));
    fireEvent.change(screen.getByLabelText(CORRECTION_LABEL), { target: { value: "暂不选择" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledWith("int-choice-1", "暂不选择", "ses-1");
    });
  });

  it("sends default cancel reason when correction is not open", async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(<A2UIBlock message={choiceMessage()} onSubmit={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledWith("int-choice-1", "用户取消", "ses-1");
    });
  });

  it("renders submitted choices as read-only labels", () => {
    render(
      <A2UIBlock
        message={choiceMessage({
          interaction: {
            interaction_id: "int-choice-1",
            status: "submitted",
            can_submit: false,
            submit_result: { selected_values: ["a", "c"], correction_note: "组合推进" },
            resume_status: "succeeded",
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const result = within(screen.getByTestId("a2ui-choice-result"));
    expect(result.getByText("方案 A")).not.toBeNull();
    expect(result.getByText("方案 C")).not.toBeNull();
    const historyList = result.getByRole("list", { name: "历史选项" });
    expect(historyList.getAttribute("data-a2ui-choice-track")).toBe("true");
    expect(historyList.querySelectorAll("[data-option-value]").length).toBe(3);
    const historyViewport = historyList.parentElement as HTMLElement;
    expect(historyViewport.getAttribute("data-a2ui-choice-draggable")).toBe("true");
    fireEvent.pointerDown(historyViewport, { button: 0, clientX: 180, pointerId: 1 });
    expect(historyViewport.getAttribute("data-dragging")).toBe("true");
    fireEvent.pointerMove(historyViewport, { clientX: 120, pointerId: 1 });
    fireEvent.pointerUp(historyViewport, { clientX: 120, pointerId: 1 });
    expect(historyViewport.hasAttribute("data-dragging")).toBe(false);
    expect(result.getByText("本次选择已提交 · 2 项")).not.toBeNull();
    expect(result.getByText("给 Keydex 的补充信息")).not.toBeNull();
    expect(result.getByText("组合推进")).not.toBeNull();
    expect(result.queryByText("已提交选择")).toBeNull();
    expect(result.queryByText(/恢复状态/)).toBeNull();
    expect(screen.queryByRole("button", { name: "提交选择" })).toBeNull();
  });

  it("renders historical notification choices collapsed until the user opens them", async () => {
    const restoreOverflowMock = mockNotificationDescriptionOverflow(["历史第一条完整内容"]);
    try {
      render(
        <A2UIBlock
          message={choiceMessage({
            payload: {
              presentation_mode: "notification_stack",
              options: [
                { label: "历史通知 A", value: "history_notice_a", description: "历史第一条完整内容" },
                { label: "历史通知 B", value: "history_notice_b", description: "短历史" },
              ],
            },
            interaction: {
              interaction_id: "int-choice-1",
              status: "submitted",
              can_submit: false,
              submit_result: { selected_values: ["history_notice_b"] },
              resume_status: "succeeded",
            },
          })}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      const result = within(screen.getByTestId("a2ui-choice-result"));
      const stack = screen.getByTestId("a2ui-choice-notification-stack");
      expect(stack.getAttribute("data-a2ui-choice-layout")).toBe("notification_stack");
      expect(stack.getAttribute("data-expanded")).toBe("false");
      expect(result.getByRole("button", { name: "展开选项通知栈" }).getAttribute("aria-expanded")).toBe("false");
      expect(result.queryByText("历史第一条完整内容")).toBeNull();
      expect(result.getByText("已选")).not.toBeNull();
      const collapsedHistoryAItem = stack.querySelector<HTMLElement>("[data-option-value='history_notice_a']");
      const collapsedHistoryBItem = stack.querySelector<HTMLElement>("[data-option-value='history_notice_b']");
      expect(collapsedHistoryAItem?.getAttribute("data-stack-front")).toBe("false");
      expect(collapsedHistoryBItem?.getAttribute("data-stack-front")).toBe("true");
      expect(collapsedHistoryBItem?.querySelector("[data-a2ui-notification-action-slot='true']")).not.toBeNull();

      fireEvent.click(result.getByRole("button", { name: "展开选项通知栈" }));

      expect(stack.getAttribute("data-expanded")).toBe("true");
      expect(result.getByRole("button", { name: "收起选项通知栈" }).getAttribute("aria-expanded")).toBe("true");
      expect(result.getByText("历史第一条完整内容")).not.toBeNull();
      expect(result.getByText("已选")).not.toBeNull();
      expect(
        Boolean(
          result.getByText("历史通知 A").compareDocumentPosition(result.getByText("历史通知 B")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);

      const historyAItem = stack.querySelector<HTMLElement>("[data-option-value='history_notice_a']");
      const historyACard = historyAItem?.querySelector<HTMLElement>("[data-a2ui-notification-card='true']");
      await waitFor(() => {
        expect(historyAItem?.getAttribute("data-message-expandable")).toBe("true");
      });
      expect(historyAItem?.getAttribute("data-message-expanded")).toBe("false");
      fireEvent.click(historyACard as HTMLElement);
      expect(stack.getAttribute("data-expanded")).toBe("true");
      expect(historyAItem?.getAttribute("data-message-expanded")).toBe("true");

      const historyBItem = stack.querySelector<HTMLElement>("[data-option-value='history_notice_b']");
      const historyBCard = historyBItem?.querySelector<HTMLElement>("[data-a2ui-notification-card='true']");
      expect(historyBItem?.querySelector("[data-a2ui-notification-action-slot='true']")).not.toBeNull();
      expect(historyBItem?.getAttribute("data-message-expandable")).toBe("false");
      fireEvent.click(historyBCard as HTMLElement);
      expect(historyBItem?.getAttribute("data-message-expanded")).toBe("false");

      fireEvent.click(result.getByRole("button", { name: "收起选项通知栈" }));
      expect(stack.getAttribute("data-expanded")).toBe("false");

      fireEvent.click(result.getByRole("button", { name: "展开选项通知栈" }));
      expect(historyAItem?.getAttribute("data-message-expanded")).toBe("false");
    } finally {
      restoreOverflowMock();
    }
  });

  it("hides the top slider for historical choice galleries with ten or fewer options", () => {
    render(
      <A2UIBlock
        message={choiceMessage({
          payload: {
            options: Array.from({ length: 10 }, (_, index) => ({
              label: `历史少量选项 ${index + 1}`,
              value: `history_compact_${index + 1}`,
              description: `历史第 ${index + 1} 个选项`,
            })),
          },
          interaction: {
            interaction_id: "int-choice-1",
            status: "submitted",
            can_submit: false,
            submit_result: { selected_values: ["history_compact_4"] },
            resume_status: "succeeded",
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const result = within(screen.getByTestId("a2ui-choice-result"));
    expect(result.queryByRole("slider", { name: "快速定位历史选项" })).toBeNull();
  });

  it("uses a top slider for dense historical choice galleries with more than ten options", async () => {
    render(
      <A2UIBlock
        message={choiceMessage({
          payload: {
            options: Array.from({ length: 11 }, (_, index) => ({
              label: `历史选项 ${index + 1}`,
              value: `history_${index + 1}`,
              description: `历史第 ${index + 1} 个选项`,
            })),
          },
          interaction: {
            interaction_id: "int-choice-1",
            status: "submitted",
            can_submit: false,
            submit_result: { selected_values: ["history_4"] },
            resume_status: "succeeded",
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const result = within(screen.getByTestId("a2ui-choice-result"));
    const slider = result.getByRole("slider", { name: "快速定位历史选项" });
    expect(slider.getAttribute("aria-valuenow")).toBe("3");
    expect(slider.getAttribute("aria-valuetext")).toBe("4/11");
    expect(slider.textContent).toBe("4/11");

    fireEvent.keyDown(slider, { key: "End" });

    await waitFor(() => {
      expect(optionElement(/历史选项 11/).getAttribute("data-coverflow-position")).toBe("center");
    });
    expect(slider.getAttribute("aria-valuenow")).toBe("10");
    expect(slider.getAttribute("aria-valuetext")).toBe("11/11");
    expect(slider.textContent).toBe("11/11");
  });

  it("renders cancelled choices with an explicit interaction outcome", () => {
    render(
      <A2UIBlock
        message={choiceMessage({
          interaction: {
            interaction_id: "int-choice-1",
            status: "cancelled",
            can_submit: false,
            cancel_reason: "用户取消",
            resume_status: "succeeded",
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const result = within(screen.getByTestId("a2ui-choice-result"));
    expect(screen.getByTestId("a2ui-choice-result").getAttribute("data-result-status")).toBe("cancelled");
    expect(result.getByText("方案 A")).not.toBeNull();
    expect(result.getByText("方案 B")).not.toBeNull();
    expect(result.getByText("已取消本次选择")).not.toBeNull();
    expect(result.queryByText(/原因/)).toBeNull();
    expect(result.queryByText(/恢复状态/)).toBeNull();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    expect(screen.queryByRole("button", { name: "提交选择" })).toBeNull();
  });

  it("streams choice options while keeping waiting controls available", () => {
    vi.useFakeTimers();
    try {
      render(<A2UIBlock message={withStreamedDebug(choiceMessage())} onSubmit={vi.fn()} onCancel={vi.fn()} />);

      const choice = screen.getByTestId("a2ui-choice");
      expect(choice.getAttribute("data-a2ui-reveal-enabled")).toBe("true");
      expect(screen.getByText("正在生成选项中，请稍后...")).not.toBeNull();
      expect(screen.getByText(/方案 A/)).not.toBeNull();
      expect(screen.queryByText(/方案 B/)).toBeNull();
      const submitButton = screen.getByRole("button", { name: "提交选择" }) as HTMLButtonElement;
      expect(submitButton.disabled).toBe(true);

      act(() => {
        vi.advanceTimersByTime(1_600);
      });

      expect(screen.getByText(/方案 B/)).not.toBeNull();
      expect(screen.getByRole("button", { name: "提交选择" })).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps streamed cards visible when stream identity upgrades before the next parsable payload", () => {
    const { rerender } = render(
      <A2UIBlock
        message={choiceStreamMessage({
          payload: {
            title: "请选择",
            options: [{ label: "方案 A", value: "a", description: "先出现的选项" }],
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/方案 A/)).not.toBeNull();
    expect(screen.queryByText("正在生成选项")).toBeNull();
    expect(screen.getByText("正在生成选项中，请稍后...")).not.toBeNull();

    rerender(
      <A2UIBlock
        message={choiceStreamMessage({
          argsBuffer: "{\"title\":\"请选择\",\"options\":[",
          chunkCount: 2,
          parsedArgs: undefined,
          streamId: "stream-choice-upgraded",
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/方案 A/)).not.toBeNull();
    expect(screen.queryByText("正在生成选项")).toBeNull();
    expect(screen.getByText("正在生成选项中，请稍后...")).not.toBeNull();
  });

  it("keeps the latest streamed choice card centered while options grow", async () => {
    const { rerender } = render(
      <A2UIBlock
        message={choiceStreamMessage({
          payload: {
            title: "请选择",
            options: [{ label: "方案 A", value: "a", description: "先出现的选项" }],
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(optionElement(/方案 A/).getAttribute("data-coverflow-position")).toBe("center");

    rerender(
      <A2UIBlock
        message={choiceStreamMessage({
          chunkCount: 2,
          payload: {
            title: "请选择",
            options: [
              { label: "方案 A", value: "a", description: "先出现的选项" },
              { label: "方案 B", value: "b", description: "最新生成的选项" },
            ],
          },
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(optionElement(/方案 B/).getAttribute("data-coverflow-position")).toBe("center");
    });
    expect(screen.getByText("正在生成选项中，请稍后...")).not.toBeNull();
  });
});

function choiceMessage(options: {
  payload?: Record<string, unknown>;
  interaction?: A2UIInteractionState;
} = {}): ConversationMessage {
  const interaction = options.interaction ?? {
    interaction_id: "int-choice-1",
    status: "waiting_user_input",
    can_submit: true,
  };
  const a2ui = choiceObject(options.payload ?? {}, interaction);
  return {
    id: "agent:a2ui-choice-1",
    threadId: "ses-1",
    turnId: null,
    itemId: "a2ui-choice-1",
    kind: "a2ui",
    status: interaction.status === "waiting_user_input" ? "pending" : "completed",
    content: "",
    payload: {
      a2ui,
      a2uiDebug: choiceDebug(a2ui, interaction),
      interaction,
      interactionId: interaction.interaction_id,
      renderKey: "choice",
      streamId: "stream-choice-1",
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function choiceObject(payload: Record<string, unknown>, interaction: A2UIInteractionState): A2UIObject {
  return {
    render_key: "choice",
    mode: "interactive",
    stream_id: "stream-choice-1",
    tool_call_id: "tool-choice-1",
    trace_id: "trace-1",
    turn_index: 1,
    payload: {
      title: "请选择方案",
      description: "选择一个后继续",
      options: [
        { label: "方案 A", value: "a", description: "低风险" },
        { label: "方案 B", value: "b", description: "高收益" },
        { label: "方案 C", value: "c", description: "折中" },
      ],
      ...payload,
    },
    input_schema: {},
    submit_schema: {},
    interaction,
  };
}

function choiceDebug(a2ui: A2UIObject, interaction: A2UIInteractionState): A2UIDebugBlockState {
  return {
    id: "stream-choice-1",
    status: interaction.status === "waiting_user_input" ? "waiting_input" : interaction.status === "submitted" ? "submitted" : "cancelled",
    renderKey: "choice",
    mode: "interactive",
    streamId: "stream-choice-1",
    interactionId: interaction.interaction_id,
    toolCallId: "tool-choice-1",
    traceId: "trace-1",
    turnIndex: 1,
    chunkCount: 0,
    argsBuffer: "",
    argsTextLength: 0,
    jsonParseStatus: "valid",
    a2ui,
    payload: a2ui.payload,
    inputSchema: a2ui.input_schema,
    submitSchema: a2ui.submit_schema,
    interaction,
    rawEvents: [],
    updatedAt: 1_700_000_000_000,
  };
}

function withStreamedDebug(message: ConversationMessage): ConversationMessage {
  const a2ui = message.payload.a2ui as A2UIObject;
  const debug = message.payload.a2uiDebug as A2UIDebugBlockState;
  const argsBuffer = JSON.stringify(a2ui.payload);
  return {
    ...message,
    payload: {
      ...message.payload,
      a2uiDebug: {
        ...debug,
        chunkCount: 32,
        argsBuffer,
        argsTextLength: argsBuffer.length,
        jsonParseStatus: "valid",
        parsedArgs: a2ui.payload,
      },
    },
  };
}

function choiceStreamMessage({
  argsBuffer,
  chunkCount = 1,
  parsedArgs,
  payload,
  streamId,
}: {
  argsBuffer?: string;
  chunkCount?: number;
  parsedArgs?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  streamId?: string;
}): ConversationMessage {
  const resolvedPayload = payload ?? parsedArgs;
  return {
    id: "agent:a2ui-choice-streaming",
    threadId: "ses-1",
    turnId: null,
    itemId: "a2ui-choice-streaming",
    kind: "a2ui",
    status: "in_progress",
    content: "",
    payload: {
      a2uiDebug: {
        id: streamId ?? "a2ui:trace-choice-stream:1:choice:a2ui_stream_chunk",
        status: "streaming",
        renderKey: "choice",
        mode: "interactive",
        streamId,
        traceId: "trace-choice-stream",
        turnIndex: 1,
        chunkCount,
        argsBuffer: argsBuffer ?? JSON.stringify(resolvedPayload ?? {}),
        argsTextLength: (argsBuffer ?? JSON.stringify(resolvedPayload ?? {})).length,
        jsonParseStatus: resolvedPayload ? "partial" : "empty",
        parsedArgs: resolvedPayload,
        rawEvents: [{
          id: `stream-choice-event-${chunkCount}`,
          action: "a2ui_stream_chunk",
          timestamp: 1_700_000_000_000 + chunkCount,
          data: {
            render_key: "choice",
            trace_id: "trace-choice-stream",
            turn_index: 1,
            ...(streamId ? { stream_id: streamId } : {}),
            stream: {
              args_delta: "",
              chunk_index: chunkCount,
              status: "streaming",
            },
          },
        }],
        updatedAt: 1_700_000_000_000 + chunkCount,
      },
      renderKey: "choice",
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}
