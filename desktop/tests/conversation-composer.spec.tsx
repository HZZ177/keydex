import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { selectedQuoteFromText } from "../src/renderer/components/chat/SendBox";
import type { RuntimeModelSelection } from "../src/renderer/components/model";
import {
  ConversationComposer,
  conversationComposerStatusText,
  isConversationBusy,
} from "../src/renderer/pages/conversation/ConversationComposer";

describe("ConversationComposer", () => {
  it("keeps the shared SendBox implementation and allows surface-specific chrome", () => {
    render(
      <ConversationComposer
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        connectionReady
        modelSelection={modelSelection()}
        workspaceSkills={[]}
        selectedSkill={null}
        externalFileRequest={null}
        externalQuoteRequest={null}
        controls={<button type="button">展开消息</button>}
        className="compact-composer"
        placeholder="工作台输入"
        ariaLabel="工作台助手表单"
        inputLabel="工作台助手输入"
        onChange={vi.fn()}
        onSkillChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const form = screen.getByRole("form", { name: "工作台助手表单" });
    expect(form.getAttribute("data-sendbox-root")).toBe("true");
    expect(form.className).toContain("compact-composer");
    expect(screen.getByRole("textbox", { name: "工作台助手输入" }).getAttribute("data-placeholder")).toBe("工作台输入");
    expect(screen.getByRole("button", { name: "展开消息" })).not.toBeNull();
    expect(screen.getByTestId("context-window-indicator").getAttribute("aria-label")).toContain("等待下一次模型调用");
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("routes text changes and send actions through the supplied handlers", async () => {
    const onChange = vi.fn();
    const onSend = vi.fn();
    render(
      <ConversationComposer
        value=""
        runtimeState="idle"
        canSend
        canStop={false}
        connectionReady
        modelSelection={modelSelection()}
        workspaceSkills={[]}
        selectedSkill={null}
        externalFileRequest={null}
        externalQuoteRequest={null}
        onChange={onChange}
        onSkillChange={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "继续输入" });
    input.textContent = "hello";
    fireEvent.input(input);
    expect(onChange).toHaveBeenLastCalledWith("hello");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    });
    expect(onSend).toHaveBeenCalledWith([], [], []);
  });

  it("uses the page interaction placeholder while A2UI is waiting for input", () => {
    render(
      <ConversationComposer
        value=""
        runtimeState="waiting_input"
        canSend={false}
        canStop={false}
        connectionReady
        modelSelection={modelSelection()}
        workspaceSkills={[]}
        selectedSkill={null}
        externalFileRequest={null}
        externalQuoteRequest={null}
        placeholder="要求后续变更"
        onChange={vi.fn()}
        onSkillChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "继续输入" });
    expect(input.getAttribute("data-placeholder")).toBe("请先完成页面交互");
    expect(input.getAttribute("aria-disabled")).toBe("true");
    expect(input.getAttribute("contenteditable")).toBe("false");
  });

  it("focuses the model search field when opened from the composer toolbar", async () => {
    render(
      <ConversationComposer
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        connectionReady
        modelSelection={modelSelection()}
        workspaceSkills={[]}
        selectedSkill={null}
        externalFileRequest={null}
        externalQuoteRequest={null}
        onChange={vi.fn()}
        onSkillChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "继续输入" });
    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    const search = screen.getByLabelText("筛选模型");

    act(() => {
      editor.focus();
    });
    expect(document.activeElement).toBe(editor);

    await act(async () => {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });

    expect(document.activeElement).toBe(search);
  });

  it("animates the context window ring toward the latest usage", async () => {
    const { rerender } = render(
      <ConversationComposer
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        connectionReady
        modelSelection={modelSelection()}
        workspaceSkills={[]}
        selectedSkill={null}
        externalFileRequest={null}
        externalQuoteRequest={null}
        onChange={vi.fn()}
        onSkillChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    const progress = contextWindowProgressCircle();
    const circumference = 2 * Math.PI * 6;
    expect(Number.parseFloat(progress.style.strokeDashoffset)).toBeCloseTo(circumference);

    rerender(
      <ConversationComposer
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        connectionReady
        modelSelection={modelSelection()}
        workspaceSkills={[]}
        selectedSkill={null}
        externalFileRequest={null}
        externalQuoteRequest={null}
        contextWindowUsage={{
          sessionId: "ses-1",
          activeSessionId: "ses-1",
          tokenCount: 400,
          contextWindow: 1000,
          windowFraction: 0.4,
          thresholdFraction: 0.8,
          thresholdTokenCount: 800,
          thresholdUsageFraction: 0.5,
          remainingToThresholdTokens: 400,
          callPhase: "after",
          callStatus: "completed",
          tokenSource: "usage_metadata",
          updatedAtMs: 1000,
        }}
        onChange={vi.fn()}
        onSkillChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(Number.parseFloat(progress.style.strokeDashoffset)).toBeCloseTo(circumference);

    await act(async () => {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });

    expect(Number.parseFloat(progress.style.strokeDashoffset)).toBeCloseTo(circumference * 0.5);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("上下文压缩进度 50.0%");
    expect(tooltip.textContent).not.toContain("全量压缩进度");

    rerender(
      <ConversationComposer
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        connectionReady
        modelSelection={modelSelection()}
        workspaceSkills={[]}
        selectedSkill={null}
        externalFileRequest={null}
        externalQuoteRequest={null}
        contextWindowUsage={{
          sessionId: "ses-1",
          activeSessionId: "ses-1",
          tokenCount: 820,
          contextWindow: 1000,
          windowFraction: 0.82,
          thresholdFraction: 0.75,
          thresholdTokenCount: 750,
          thresholdUsageFraction: 820 / 750,
          remainingToThresholdTokens: -70,
          callPhase: "after",
          callStatus: "completed",
          tokenSource: "usage_metadata",
          updatedAtMs: 1001,
        }}
        onChange={vi.fn()}
        onSkillChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    await act(async () => {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });

    const indicator = screen.getByTestId("context-window-indicator");
    expect(Number.parseFloat(progress.style.strokeDashoffset)).toBeCloseTo(0);
    expect(indicator.getAttribute("data-level")).toBe("danger");
    expect(indicator.getAttribute("aria-label")).toContain("上下文压缩进度 109.3%");
    expect(tooltip.querySelector('[data-progress-kind="ambient"]')?.getAttribute("data-level")).toBe("danger");
    expect(tooltip.querySelector('[data-progress-kind="blocking"]')).toBeNull();
  });

  it("does not render Workbench dock controls unless the surface supplies them", () => {
    render(
      <ConversationComposer
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        connectionReady
        modelSelection={modelSelection()}
        workspaceSkills={[]}
        selectedSkill={null}
        externalFileRequest={null}
        externalQuoteRequest={null}
        onChange={vi.fn()}
        onSkillChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "展开工作台消息层" })).toBeNull();
    expect(screen.queryByRole("button", { name: "将工作台助手展开到右侧" })).toBeNull();
  });

  it("renders external file and quote chips through the shared SendBox", async () => {
    const quote = selectedQuoteFromText("引用片段内容", {
      source: "annotation",
      file: {
        path: "docs/guide.md",
        name: "guide.md",
        lineStart: 4,
        lineEnd: 4,
      },
    });
    if (!quote) {
      throw new Error("quote not created");
    }
    render(
      <ConversationComposer
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        connectionReady
        modelSelection={modelSelection()}
        workspaceSkills={[]}
        selectedSkill={null}
        externalFileRequest={{
          requestId: 1,
          file: { path: "src/main.ts", name: "main.ts", type: "file", source: "workspace" },
        }}
        externalQuoteRequest={{ requestId: 1, quote }}
        onSearchWorkspace={vi.fn().mockResolvedValue([])}
        onChange={vi.fn()}
        onSkillChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(await screen.findByLabelText("已添加上下文")).not.toBeNull();
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("main.ts");
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("guide.md · L4");
  });

  it("keeps busy semantics shared while suppressing toolbar status copy", () => {
    expect(isConversationBusy("running")).toBe(true);
    expect(isConversationBusy("cancelling")).toBe(true);
    expect(isConversationBusy("idle")).toBe(false);
    expect(conversationComposerStatusText("idle", false)).toBe("");
    expect(conversationComposerStatusText("failed", true)).toBe("");
    expect(conversationComposerStatusText("waiting_approval", true)).toBe("");
    expect(conversationComposerStatusText("running", true)).toBe("");
  });
});

function modelSelection(): RuntimeModelSelection {
  return {
    selectedModel: { providerId: "provider-1", model: "qwen-coder" },
    setSelectedModel: vi.fn(),
    modelOptions: [{ providerId: "provider-1", providerName: "默认模型服务", model: "qwen-coder" }],
    modelLoadState: "ready",
    modelError: null,
  };
}

function contextWindowProgressCircle(): SVGElement {
  const indicator = screen.getByTestId("context-window-indicator");
  const progress = indicator.querySelector("circle[class*='contextWindowProgress']");
  if (!progress) {
    throw new Error("context window progress circle not found");
  }
  return progress as SVGElement;
}
