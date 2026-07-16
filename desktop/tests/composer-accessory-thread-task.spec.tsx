import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ConversationComposerAccessory } from "@/renderer/pages/conversation/ComposerAccessory";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { AgentPendingInput, ThreadTask, ThreadTaskRun } from "@/types/protocol";

const NativePointerEvent = globalThis.PointerEvent;

beforeAll(() => {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  Object.defineProperty(globalThis, "PointerEvent", {
    configurable: true,
    value: TestPointerEvent,
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, "PointerEvent", {
    configurable: true,
    value: NativePointerEvent,
  });
});

describe("ConversationComposerAccessory thread task", () => {
  it("centers typing metrics in stable four-digit slots", () => {
    const composerAccessoryCss = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/conversation/ComposerAccessory.module.css"),
      "utf8",
    );
    const valueRule = composerAccessoryCss.match(/\.typingSpeedValue\s*{([^}]*)}/s)?.[1] ?? "";

    expect(valueRule).toMatch(/min-width:\s*4ch/);
    expect(valueRule).toMatch(/margin-inline:\s*2px/);
    expect(valueRule).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(valueRule).toMatch(/text-align:\s*center/);
  });

  it("caps goal-related composer capsules to two thirds of the input width", () => {
    const composerAccessoryCss = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/conversation/ComposerAccessory.module.css"),
      "utf8",
    );
    const goalModeCss = readFileSync(
      resolve(process.cwd(), "src/renderer/components/chat/GoalModeAccessory.module.css"),
      "utf8",
    );

    expect(composerAccessoryCss).toMatch(
      /\.composerAccessoryItem\[data-selected-item="thread-task"\]\s*{[^}]*max-width:\s*66\.666%/s,
    );
    expect(goalModeCss).toMatch(/\.goalModeAccessory\s*{[^}]*max-width:\s*66\.666%/s);
  });

  it("keeps an empty slot while the real row follows the pointer", async () => {
    const composerAccessoryCss = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/conversation/ComposerAccessory.module.css"),
      "utf8",
    );
    const rowRule = composerAccessoryCss.match(/\.pendingInputRow\s*{([^}]*)}/s)?.[1] ?? "";
    const floatingRule = composerAccessoryCss.match(
      /\.pendingInputFloatingRow\s*{([^}]*)}/s,
    )?.[1] ?? "";

    expect(rowRule).not.toMatch(/will-change|transform|filter/);
    expect(floatingRule).toMatch(/position:\s*fixed/);
    expect(floatingRule).toMatch(/will-change:\s*transform/);
    expect(floatingRule).not.toMatch(/scale|filter|opacity|visibility/);

    const onReorder = vi.fn();
    render(
      <ConversationComposerAccessory
        messages={[]}
        pendingInputs={[
          pendingInput("pending-visible-1", { message: "拖动中仍然显示我", mode: "queue", status: "queued" }),
          pendingInput("pending-visible-2", { message: "目标消息", mode: "queue", status: "queued" }),
        ]}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
        onPendingInputReorder={onReorder}
      />,
    );

    const pill = screen.getByTestId("pending-inputs-pill");
    const handle = within(pill).getByRole("button", { name: "拖动调整顺序：拖动中仍然显示我" });
    for (const row of pill.querySelectorAll<HTMLElement>("[data-pending-input-id]")) {
      Object.defineProperty(row, "getBoundingClientRect", {
        configurable: true,
        value: () => {
          const index = row.parentElement ? [...row.parentElement.children].indexOf(row) : 0;
          const top = index * 26;
          return { top, bottom: top + 24, height: 24, left: 20, right: 420, width: 400 } as DOMRect;
        },
      });
    }

    fireEvent.pointerDown(handle, { button: 0, pointerId: 10, clientY: 12 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 10, clientY: 38 });

    const placeholder = pill.querySelector('[data-pending-input-id="pending-visible-1"]');
    const floatingRow = document.querySelector('[data-floating-pending-input-id="pending-visible-1"]');
    expect(placeholder?.getAttribute("data-pending-input-placeholder")).toBe("true");
    expect(placeholder?.textContent).toBe("");
    expect(floatingRow?.textContent).toContain("拖动中仍然显示我");
    expect((floatingRow as HTMLElement | null)?.style.transform).toBe("translate3d(0, 26px, 0)");
    expect(onReorder).not.toHaveBeenCalled();

    fireEvent.pointerUp(window, { button: 0, pointerId: 10, clientY: 38 });
    await waitFor(() => expect(onReorder).toHaveBeenCalledWith(["pending-visible-2", "pending-visible-1"]));
    expect(document.querySelector('[data-floating-pending-input-id="pending-visible-1"]')).toBeNull();
    expect(pill.querySelector("[data-pending-input-placeholder]")).toBeNull();
  });

  it("reorders as soon as the floating row center crosses the target midpoint", () => {
    const onReorder = vi.fn();
    render(
      <ConversationComposerAccessory
        messages={[]}
        pendingInputs={[
          pendingInput("pending-threshold-1", { message: "阈值一", mode: "queue", status: "queued" }),
          pendingInput("pending-threshold-2", { message: "阈值二", mode: "queue", status: "queued" }),
          pendingInput("pending-threshold-3", { message: "阈值三", mode: "queue", status: "queued" }),
        ]}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
        onPendingInputReorder={onReorder}
      />,
    );

    const pill = screen.getByTestId("pending-inputs-pill");
    const handle = within(pill).getByRole("button", { name: "拖动调整顺序：阈值一" });
    for (const row of pill.querySelectorAll<HTMLElement>("[data-pending-input-id]")) {
      Object.defineProperty(row, "getBoundingClientRect", {
        configurable: true,
        value: () => {
          const index = row.parentElement ? [...row.parentElement.children].indexOf(row) : 0;
          const top = index * 26;
          return { top, bottom: top + 24, height: 24, left: 20, right: 420, width: 400 } as DOMRect;
        },
      });
    }

    const previewIds = () => [...pill.querySelectorAll("[data-pending-input-id]")]
      .map((row) => row.getAttribute("data-pending-input-id"));
    fireEvent.pointerDown(handle, { button: 0, pointerId: 12, clientY: 12 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 12, clientY: 37 });
    expect(previewIds()).toEqual(["pending-threshold-1", "pending-threshold-2", "pending-threshold-3"]);

    fireEvent.pointerMove(window, { buttons: 1, pointerId: 12, clientY: 39 });
    expect(previewIds()).toEqual(["pending-threshold-2", "pending-threshold-1", "pending-threshold-3"]);
    expect(onReorder).not.toHaveBeenCalled();

    fireEvent.pointerCancel(window, { pointerId: 12 });
    expect(previewIds()).toEqual(["pending-threshold-1", "pending-threshold-2", "pending-threshold-3"]);
  });

  it("shows the compact plan beside an active thread task", () => {
    const view = render(
      <ConversationComposerAccessory
        messages={[planMessage()]}
        activeTask={threadTask({ objective: "完成目标面板", elapsed_seconds: 3661 })}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
      />,
    );

    expect(view.container.querySelector("[data-selected-item]")?.getAttribute("data-selected-item")).toBe(
      "thread-task",
    );
    expect(screen.getByTestId("thread-task-pill").textContent).toContain("完成目标面板");
    expect(screen.getByTestId("thread-task-pill").textContent).toContain("1小时1分");
    expect(screen.getByTestId("plan-summary-pill").textContent).toBe("1/2 步");
  });

  it("keeps the compact plan and falls back to typing when the active thread task disappears", () => {
    const props = {
      messages: [planMessage()],
      showScrollToBottom: false,
      onFilePreview: vi.fn(),
      onScrollToBottom: vi.fn(),
    };
    const view = render(
      <ConversationComposerAccessory
        {...props}
        activeTask={threadTask({ objective: "即将结束的目标" })}
      />,
    );

    view.rerender(<ConversationComposerAccessory {...props} activeTask={null} />);

    expect(view.container.querySelector("[data-selected-item]")?.getAttribute("data-selected-item")).toBe(
      "runtime-typing-speed",
    );
    expect(screen.getByTestId("plan-summary-pill").textContent).toBe("1/2 步");
    expect(screen.getByTestId("typing-speed-pill").textContent).toBe("打字机 0 字符/s - 待输出 0 字");
    expect(screen.queryByTestId("thread-task-pill")).toBeNull();
  });

  it("shows running state from the current task run", () => {
    render(
      <ConversationComposerAccessory
        messages={[]}
        activeTask={threadTask({ id: "task-running", objective: "持续执行" })}
        runningTaskRun={threadTaskRun({ task_id: "task-running" })}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
      />,
    );

    expect(screen.getByTestId("thread-task-pill").textContent).toContain("运行中");
  });

  it("renders the backend-updated running task elapsed display", () => {
    const props = {
      messages: [],
      runningTaskRun: threadTaskRun({ task_id: "task-running" }),
      showScrollToBottom: false,
      onFilePreview: vi.fn(),
      onScrollToBottom: vi.fn(),
    };
    const view = render(
      <ConversationComposerAccessory
        {...props}
        activeTask={threadTask({ id: "task-running", objective: "持续执行", elapsed_seconds: 6 })}
      />,
    );

    expect(screen.getByTestId("thread-task-pill").textContent).toContain("6秒");
    fireEvent.click(screen.getByRole("button", { name: "查看目标详情" }));
    expect(screen.getByTestId("thread-task-panel").textContent).toContain("6秒");

    view.rerender(
      <ConversationComposerAccessory
        {...props}
        activeTask={threadTask({ id: "task-running", objective: "持续执行", elapsed_seconds: 8 })}
      />,
    );

    expect(screen.getByTestId("thread-task-pill").textContent).toContain("8秒");
    expect(screen.getByTestId("thread-task-panel").textContent).toContain("8秒");
  });

  it.each([
    ["paused", "已暂停"],
    ["blocked", "已阻塞"],
    ["system_stopped", "系统停止"],
    ["complete", "已完成"],
    ["cancelled", "已取消"],
  ] as const)("renders %s status label", (status, label) => {
    render(
      <ConversationComposerAccessory
        messages={[]}
        activeTask={threadTask({ status })}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
      />,
    );

    expect(screen.getByTestId("thread-task-pill").textContent).toContain(label);
  });

  it("renders future task type labels with a generic fallback", () => {
    const props = {
      messages: [],
      showScrollToBottom: false,
      onFilePreview: vi.fn(),
      onScrollToBottom: vi.fn(),
    };
    const view = render(
      <ConversationComposerAccessory
        {...props}
        activeTask={threadTask({ type: "research", type_label: "调研" })}
      />,
    );

    expect(screen.getByTestId("thread-task-pill").textContent).toContain("调研");

    view.rerender(
      <ConversationComposerAccessory
        {...props}
        activeTask={threadTask({ type: "research", type_label: "" })}
      />,
    );

    expect(screen.getByTestId("thread-task-pill").textContent).toContain("任务");
  });

  it("edits the task objective from the expanded panel", async () => {
    const onUpdateTask = vi.fn().mockResolvedValue(undefined);
    render(
      <ConversationComposerAccessory
        messages={[]}
        activeTask={threadTask({ objective: "旧目标" })}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
        onUpdateTask={onUpdateTask}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑目标" }));
    fireEvent.change(screen.getByLabelText("编辑目标内容"), { target: { value: "新目标" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onUpdateTask).toHaveBeenCalledWith("task-1", { objective: "新目标" });
    });
  });

  it("opens and closes the task panel on hover", () => {
    render(
      <ConversationComposerAccessory
        messages={[]}
        activeTask={threadTask({ objective: "悬停目标" })}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
      />,
    );

    const wrapper = screen.getByTestId("thread-task-pill").parentElement;
    expect(wrapper).not.toBeNull();
    expect(screen.getByTestId("thread-task-panel").getAttribute("data-open")).toBe("false");

    fireEvent.mouseEnter(wrapper as HTMLElement);

    expect(screen.getByTestId("thread-task-panel").getAttribute("data-open")).toBe("true");

    fireEvent.mouseLeave(wrapper as HTMLElement);

    expect(screen.getByTestId("thread-task-panel").getAttribute("data-open")).toBe("false");
  });

  it("pauses and resumes an open task", async () => {
    const onUpdateTask = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <ConversationComposerAccessory
        messages={[]}
        activeTask={threadTask({ status: "active" })}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
        onUpdateTask={onUpdateTask}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "暂停目标" }));
    await waitFor(() => {
      expect(onUpdateTask).toHaveBeenCalledWith("task-1", { status: "paused" });
    });

    view.rerender(
      <ConversationComposerAccessory
        messages={[]}
        activeTask={threadTask({ status: "paused" })}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
        onUpdateTask={onUpdateTask}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "恢复目标" }));
    await waitFor(() => {
      expect(onUpdateTask).toHaveBeenCalledWith("task-1", { status: "active" });
    });
  });

  it("requires delete confirmation before deleting a task", async () => {
    const onDeleteTask = vi.fn().mockResolvedValue(undefined);
    render(
      <ConversationComposerAccessory
        messages={[]}
        activeTask={threadTask()}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
        onDeleteTask={onDeleteTask}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "删除目标" }));
    expect(onDeleteTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除目标" }));

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenCalledWith("task-1");
    });
  });

  it("does not expose revive-style actions for terminal tasks", () => {
    render(
      <ConversationComposerAccessory
        messages={[]}
        activeTask={threadTask({ status: "system_stopped", is_terminal: true, is_open: false })}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
        onUpdateTask={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看目标详情" }));

    expect(screen.getByText("任务已结束，可创建新目标。")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "恢复目标" })).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑目标" })).toBeNull();
  });

  it("closes the expanded task panel with Escape", () => {
    render(
      <ConversationComposerAccessory
        messages={[]}
        activeTask={threadTask()}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看目标详情" }));
    expect(screen.getByTestId("thread-task-panel").getAttribute("data-open")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.getByTestId("thread-task-panel").getAttribute("data-open")).toBe("false");
    expect(screen.getByTestId("thread-task-panel").getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps long task objectives inside the truncating objective span", () => {
    const longObjective = "这是一个很长很长的目标描述，用来验证目标胶囊不会把输入区撑开或和后续内容重叠";
    const view = render(
      <ConversationComposerAccessory
        messages={[]}
        activeTask={threadTask({ objective: longObjective })}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
      />,
    );

    const objective = view.container.querySelector("[class*='threadTaskObjective']");
    expect(objective?.textContent).toBe(longObjective);
  });

  it("keeps quick actions on the capsule and leaves the panel for details and editing", () => {
    render(
      <ConversationComposerAccessory
        messages={[]}
        activeTask={threadTask({ objective: "胶囊承载快捷操作" })}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
        onUpdateTask={vi.fn()}
        onDeleteTask={vi.fn()}
      />,
    );

    const pill = screen.getByTestId("thread-task-pill");
    expect(within(pill).getByRole("button", { name: "编辑目标" })).not.toBeNull();
    expect(within(pill).getByRole("button", { name: "暂停目标" })).not.toBeNull();
    expect(within(pill).getByRole("button", { name: "删除目标" })).not.toBeNull();
    expect(within(pill).getByRole("button", { name: "展开目标详情" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看目标详情" }));

    const panel = screen.getByTestId("thread-task-panel");
    expect(within(panel).getByText("胶囊承载快捷操作")).not.toBeNull();
    expect(within(panel).queryByRole("button", { name: "暂停目标" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "删除目标" })).toBeNull();
  });

  it("renders pending input rows and exposes mode, edit and delete actions on the capsule", () => {
    const onModeChange = vi.fn();
    const onEdit = vi.fn();
    const onCancel = vi.fn();
    const first = pendingInput("pending-1", {
      message: "补充运行中约束",
      mode: "steer",
      status: "pending_steer",
    });
    const second = pendingInput("pending-2", {
      message: "下一轮再处理",
      mode: "queue",
      status: "queued",
    });

    const view = render(
      <ConversationComposerAccessory
        messages={[planMessage()]}
        activeTask={threadTask({ objective: "低优先级目标" })}
        pendingInputs={[first, second]}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
        onPendingInputModeChange={onModeChange}
        onPendingInputEdit={onEdit}
        onPendingInputCancel={onCancel}
      />,
    );

    expect(view.container.querySelector("[data-selected-item]")?.getAttribute("data-selected-item")).toBe(
      "pending-inputs",
    );
    const pill = screen.getByTestId("pending-inputs-pill");
    expect(within(pill).getByText("补充运行中约束")).not.toBeNull();
    expect(within(pill).getByText("下一轮再处理")).not.toBeNull();
    expect(within(pill).getByText("引导当前轮次")).not.toBeNull();
    expect(within(pill).getByText("等待队列")).not.toBeNull();
    expect(within(pill).getByText("以下消息将在下一次模型请求前一次性发送给 Agent。")).not.toBeNull();
    expect(within(pill).getByText("以下消息会在当前轮次结束后按顺序逐条发送。")).not.toBeNull();

    fireEvent.click(within(pill).getByRole("button", { name: "改为队列：补充运行中约束" }));
    expect(onModeChange).toHaveBeenCalledWith("pending-1", "queue");

    fireEvent.click(within(pill).getByRole("button", { name: "改为引导：下一轮再处理" }));
    expect(onModeChange).toHaveBeenCalledWith("pending-2", "steer");

    fireEvent.click(within(pill).getByRole("button", { name: "编辑待发送消息：下一轮再处理" }));
    expect(onEdit).toHaveBeenCalledWith(second);

    fireEvent.click(within(pill).getByRole("button", { name: "删除待发送消息：下一轮再处理" }));
    expect(onCancel).toHaveBeenCalledWith("pending-2");
  });

  it("reorders waiting rows by drag and keyboard without moving a running row", async () => {
    const onReorder = vi.fn();
    const running = pendingInput("pending-running", {
      message: "正在发送",
      mode: "queue",
      status: "running",
      queue_position: 1,
    });
    const first = pendingInput("pending-1", {
      message: "第一条等待消息",
      mode: "queue",
      status: "queued",
      queue_position: 2,
    });
    const second = pendingInput("pending-2", {
      message: "第二条等待消息",
      mode: "queue",
      status: "queued",
      queue_position: 3,
    });

    render(
      <ConversationComposerAccessory
        messages={[]}
        pendingInputs={[running, first, second]}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
        onPendingInputReorder={onReorder}
      />,
    );

    const pill = screen.getByTestId("pending-inputs-pill");
    expect(
      (within(pill).getByRole("button", { name: "拖动调整顺序：正在发送" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const firstHandle = within(pill).getByRole("button", { name: "拖动调整顺序：第一条等待消息" });
    const secondRow = pill.querySelector('[data-pending-input-id="pending-2"]');
    expect(secondRow).not.toBeNull();
    const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
    for (const row of pill.querySelectorAll<HTMLElement>("[data-pending-input-id]")) {
      Object.defineProperty(row, "animate", { configurable: true, value: animate });
      Object.defineProperty(row, "getBoundingClientRect", {
        configurable: true,
        value: () => {
          const index = row.parentElement ? [...row.parentElement.children].indexOf(row) : 0;
          const top = index * 26;
          return { top, bottom: top + 24, height: 24, left: 20, right: 420, width: 400 } as DOMRect;
        },
      });
    }

    fireEvent.pointerDown(firstHandle, { button: 0, pointerId: 1, clientY: 26 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientY: 1_000 });

    expect(onReorder).not.toHaveBeenCalled();
    expect(animate).toHaveBeenCalled();
    expect(
      [...pill.querySelectorAll("[data-pending-input-id]")].map((row) => row.getAttribute("data-pending-input-id")),
    ).toEqual(["pending-running", "pending-2", "pending-1"]);
    expect(pill.querySelector('[data-pending-input-id="pending-1"]')?.getAttribute("data-pending-input-placeholder"))
      .toBe("true");
    expect(pill.querySelector('[data-pending-input-id="pending-1"]')?.textContent).toBe("");
    expect(document.querySelector('[data-floating-pending-input-id="pending-1"]')?.textContent)
      .toContain("第一条等待消息");

    fireEvent.pointerUp(window, { button: 0, pointerId: 1, clientY: 1_000 });

    await waitFor(() => {
      expect(onReorder).toHaveBeenLastCalledWith(["pending-2", "pending-1"]);
    });
    expect(
      [...pill.querySelectorAll("[data-pending-input-id]")].map((row) => row.getAttribute("data-pending-input-id")),
    ).toEqual(["pending-running", "pending-2", "pending-1"]);

    fireEvent.keyDown(
      within(pill).getByRole("button", { name: "拖动调整顺序：第二条等待消息" }),
      { key: "ArrowDown" },
    );
    await waitFor(() => {
      expect(onReorder).toHaveBeenLastCalledWith(["pending-1", "pending-2"]);
    });
  });

  it("releases finished FLIP transforms after physical-pixel-aligned animation", async () => {
    const originalDevicePixelRatio = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.25 });
    try {
      const onReorder = vi.fn();
      render(
        <ConversationComposerAccessory
          messages={[]}
          pendingInputs={[
            pendingInput("pending-pixel-1", { message: "像素一", mode: "queue", status: "queued" }),
            pendingInput("pending-pixel-2", { message: "像素二", mode: "queue", status: "queued" }),
          ]}
          showScrollToBottom={false}
          onFilePreview={vi.fn()}
          onScrollToBottom={vi.fn()}
          onPendingInputReorder={onReorder}
        />,
      );

      type TestAnimation = Animation & { cancel: ReturnType<typeof vi.fn> };
      const animations: TestAnimation[] = [];
      const animate = vi.fn((_: Keyframe[] | PropertyIndexedKeyframes, __: number | KeyframeAnimationOptions) => {
        const animation = { cancel: vi.fn(), onfinish: null } as unknown as TestAnimation;
        animations.push(animation);
        return animation;
      });
      const pill = screen.getByTestId("pending-inputs-pill");
      const handle = within(pill).getByRole("button", { name: "拖动调整顺序：像素一" });
      for (const row of pill.querySelectorAll<HTMLElement>("[data-pending-input-id]")) {
        Object.defineProperty(row, "animate", { configurable: true, value: animate });
        Object.defineProperty(row, "getBoundingClientRect", {
          configurable: true,
          value: () => {
            const index = row.parentElement ? [...row.parentElement.children].indexOf(row) : 0;
            const top = index * 25.7;
            return { top, bottom: top + 24, height: 24, left: 20, right: 420, width: 400 } as DOMRect;
          },
        });
      }

      fireEvent.pointerDown(handle, { button: 0, pointerId: 11, clientY: 12 });
      fireEvent.pointerMove(window, { buttons: 1, pointerId: 11, clientY: 1_000 });

      expect(animate).toHaveBeenCalledTimes(2);
      const initialTransforms = animate.mock.calls.map(([keyframes]) =>
        (keyframes as Keyframe[])[0]?.transform,
      );
      expect(new Set(initialTransforms)).toEqual(
        new Set(["translateY(-25.6px)", "translateY(25.6px)"]),
      );
      for (const [, options] of animate.mock.calls) {
        expect(options).toMatchObject({ fill: "none" });
      }

      const finishedAnimations = [...animations];
      for (const animation of finishedAnimations) {
        expect(animation.onfinish).toEqual(expect.any(Function));
        animation.onfinish?.call(animation, new Event("finish") as AnimationPlaybackEvent);
        expect(animation.cancel).toHaveBeenCalledTimes(1);
      }

      fireEvent.pointerUp(window, { button: 0, pointerId: 11, clientY: 1_000 });
      await waitFor(() => expect(onReorder).toHaveBeenCalledWith(["pending-pixel-2", "pending-pixel-1"]));
      for (const animation of finishedAnimations) {
        expect(animation.cancel).toHaveBeenCalledTimes(1);
      }
    } finally {
      if (originalDevicePixelRatio) {
        Object.defineProperty(window, "devicePixelRatio", originalDevicePixelRatio);
      }
    }
  });

  it("restores the original order when a live drag preview is cancelled", () => {
    const onReorder = vi.fn();
    const first = pendingInput("pending-1", { message: "第一条", mode: "queue", status: "queued", queue_position: 1 });
    const second = pendingInput("pending-2", { message: "第二条", mode: "queue", status: "queued", queue_position: 2 });

    render(
      <ConversationComposerAccessory
        messages={[]}
        pendingInputs={[first, second]}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
        onPendingInputReorder={onReorder}
      />,
    );

    const pill = screen.getByTestId("pending-inputs-pill");
    const firstHandle = within(pill).getByRole("button", { name: "拖动调整顺序：第一条" });
    for (const row of pill.querySelectorAll<HTMLElement>("[data-pending-input-id]")) {
      Object.defineProperty(row, "getBoundingClientRect", {
        configurable: true,
        value: () => {
          const index = row.parentElement ? [...row.parentElement.children].indexOf(row) : 0;
          const top = index * 26;
          return { top, bottom: top + 24, height: 24, left: 20, right: 420, width: 400 } as DOMRect;
        },
      });
    }
    fireEvent.pointerDown(firstHandle, { button: 0, pointerId: 2, clientY: 12 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 2, clientY: 1_000 });
    expect(
      [...pill.querySelectorAll("[data-pending-input-id]")].map((row) => row.getAttribute("data-pending-input-id")),
    ).toEqual(["pending-2", "pending-1"]);

    fireEvent.pointerCancel(window, { pointerId: 2 });

    expect(
      [...pill.querySelectorAll("[data-pending-input-id]")].map((row) => row.getAttribute("data-pending-input-id")),
    ).toEqual(["pending-1", "pending-2"]);
    expect(document.querySelector("[data-floating-pending-input-id]")).toBeNull();
    expect(pill.querySelector("[data-pending-input-placeholder]")).toBeNull();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("shows stopped guidance and resumes one row or a complete category", () => {
    const onResume = vi.fn();
    render(
      <ConversationComposerAccessory
        messages={[]}
        pendingInputs={[
          pendingInput("pending-steer", {
            message: "暂停引导",
            paused_at: "2026-07-10T01:00:00Z",
            pause_reason: "user_stopped",
            paused: true,
          }),
          pendingInput("pending-queue", {
            message: "暂停队列",
            mode: "queue",
            status: "queued",
            paused_at: "2026-07-10T01:00:00Z",
            pause_reason: "user_stopped",
            paused: true,
          }),
        ]}
        showScrollToBottom={false}
        onFilePreview={vi.fn()}
        onScrollToBottom={vi.fn()}
        onPendingInputResume={onResume}
      />,
    );

    const pill = screen.getByTestId("pending-inputs-pill");
    expect(within(pill).getByText("等待发送时的轮次已被您主动停止，请选择如何处理以下待发送消息。")).not.toBeNull();
    fireEvent.click(within(pill).getByRole("button", { name: "恢复待发送消息：暂停引导" }));
    expect(onResume).toHaveBeenCalledWith({ pendingInputId: "pending-steer" });
    fireEvent.click(within(pill).getByRole("button", { name: "恢复全部等待队列消息" }));
    expect(onResume).toHaveBeenCalledWith({ mode: "queue" });
  });
});

function planMessage(): ConversationMessage {
  return {
    id: "plan-1",
    threadId: "ses-1",
    turnId: "turn-1",
    itemId: "item-1",
    kind: "plan",
    status: "completed",
    content: "",
    payload: {
      entries: [
        { content: "完成目标面板", status: "in_progress" },
        { content: "补充测试", status: "pending" },
      ],
    },
    createdAt: "2026-07-03T00:00:00Z",
    updatedAt: "2026-07-03T00:00:00Z",
  };
}

function threadTask(patch: Partial<ThreadTask> = {}): ThreadTask {
  return {
    id: "task-1",
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
    ...patch,
  };
}

function threadTaskRun(patch: Partial<ThreadTaskRun> = {}): ThreadTaskRun {
  return {
    id: "run-1",
    task_id: "task-1",
    session_id: "ses-1",
    status: "running",
    started_at: "2026-07-03T00:00:00Z",
    finished_at: null,
    turn_index: null,
    trace_id: null,
    summary: {},
    error: {},
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-07-03T00:00:00Z",
    is_running: true,
    ...patch,
  };
}

function pendingInput(id: string, patch: Partial<AgentPendingInput> = {}): AgentPendingInput {
  return {
    id,
    pending_input_id: id,
    session_id: "ses-1",
    client_input_id: `client-${id}`,
    mode: "steer",
    status: "pending_steer",
    message: "待发送消息",
    provider_id: "provider-1",
    model: "qwen-coder",
    user_id: "local-user",
    scene_id: "desktop-agent",
    runtime_params: {},
    attachments: [],
    target_turn_index: null,
    target_trace_id: null,
    promoted_turn_index: null,
    promoted_trace_id: null,
    queue_position: 1,
    error_code: null,
    error_message: null,
    created_at: "2026-07-09T22:00:00Z",
    updated_at: "2026-07-09T22:00:00Z",
    delivered_at: null,
    cancelled_at: null,
    paused_at: null,
    pause_reason: null,
    paused: false,
    ...patch,
  };
}
