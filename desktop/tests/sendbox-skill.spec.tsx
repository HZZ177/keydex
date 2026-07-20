import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SendBox } from "@/renderer/components/chat/SendBox";
import type { SkillSummary } from "@/runtime";

const skills: SkillSummary[] = [
  {
    name: "dev-plan",
    label: "/dev-plan",
    description: "Plan work from a design doc",
    source: "workspace",
    locator: ".keydex/skills/dev-plan/SKILL.md",
  },
  {
    name: "review",
    label: "/review",
    description: "Review implementation details",
    source: "workspace",
    locator: ".keydex/skills/review/SKILL.md",
  },
];

describe("SendBox skill capsule", () => {
  it("allows sending a selected skill without message text", async () => {
    const onSend = vi.fn();
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend={false}
        canStop={false}
        selectedSkill={skills[0]}
        onChange={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />,
    );

    const sendButton = screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(sendButton);
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith([], [], [], {});
  });

  it("selects a workspace skill command as a removable capsule", () => {
    const onChange = vi.fn();
    const onSkillChange = vi.fn();
    const onSend = vi.fn();
    render(
      <SendBox
        value="/"
        runtimeState="idle"
        canSend
        canStop={false}
        skills={skills}
        onChange={onChange}
        onSend={onSend}
        onStop={vi.fn()}
        onSkillChange={onSkillChange}
      />,
    );

    fireEvent.mouseDown(screen.getByRole("option", { name: /^Skill/u }));
    fireEvent.mouseDown(screen.getByRole("option", { name: /dev-plan/u }));

    expect(screen.getByText("dev-plan")).not.toBeNull();
    expect(screen.getByLabelText("删除 Skill /dev-plan")).not.toBeNull();
    expect(onSkillChange).toHaveBeenCalledWith(skills[0]);
    expect(onChange).toHaveBeenCalledWith("");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the slash menu available while the runtime accepts pending input", () => {
    render(
      <SendBox
        value="/"
        runtimeState="running"
        canSend
        canStop
        skills={skills}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByTestId("slash-command-menu")).not.toBeNull();
    expect(screen.getByRole("option", { name: /dev-plan/u })).not.toBeNull();
  });

  it("replaces the selected skill when another skill command is selected", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SendBox
        value="/"
        runtimeState="idle"
        canSend
        canStop={false}
        skills={skills}
        onChange={onChange}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    let input = screen.getByLabelText("继续输入");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("dev-plan")).not.toBeNull();

    rerender(
      <SendBox
        value="/rev"
        runtimeState="idle"
        canSend
        canStop={false}
        skills={skills}
        onChange={onChange}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    input = screen.getByLabelText("继续输入");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.queryByText("dev-plan")).toBeNull();
    expect(screen.getByText("review")).not.toBeNull();
  });

  it("removes the skill capsule and reports null", () => {
    const onSkillChange = vi.fn();
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend
        canStop={false}
        selectedSkill={skills[0]}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onSkillChange={onSkillChange}
      />,
    );

    fireEvent.click(screen.getByLabelText("删除 Skill /dev-plan"));

    expect(onSkillChange).toHaveBeenCalledWith(null);
  });

  it("opens the selected skill definition from the capsule main area", () => {
    const onOpenFileReference = vi.fn();
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend
        canStop={false}
        selectedSkill={skills[0]}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onOpenFileReference={onOpenFileReference}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "打开 Skill dev-plan" }));

    expect(onOpenFileReference).toHaveBeenCalledWith({
      path: ".keydex/skills/dev-plan/SKILL.md",
      name: "dev-plan",
      type: "file",
      source: "workspace",
    });
    expect(document.querySelector('[data-context-chip-icon="skill"]')).not.toBeNull();
  });

  it("keeps a system skill capsule out of the workspace file preview path", () => {
    const onOpenFileReference = vi.fn();
    const systemSkill: SkillSummary = {
      ...skills[0],
      source: "system",
    };
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend
        canStop={false}
        selectedSkill={systemSkill}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onOpenFileReference={onOpenFileReference}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "打开 Skill dev-plan" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(document.querySelector('[data-skill-source="system"]')).not.toBeNull();
    expect(screen.queryByText("系统级")).toBeNull();
    expect(onOpenFileReference).not.toHaveBeenCalled();
  });

  it("keeps a builtin skill capsule source-aware and outside workspace files", async () => {
    const onOpenFileReference = vi.fn();
    const builtinSkill: SkillSummary = {
      name: "keydex-guide",
      label: "/keydex-guide",
      description: "Use Keydex",
      source: "builtin",
      locator: "builtin/skills/keydex-guide/SKILL.md",
    };
    render(
      <SendBox
        value=""
        runtimeState="idle"
        canSend
        canStop={false}
        selectedSkill={builtinSkill}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onOpenFileReference={onOpenFileReference}
      />,
    );

    const capsule = document.querySelector('[data-skill-source="builtin"]');
    expect(capsule).not.toBeNull();
    fireEvent.mouseEnter(capsule?.closest('[data-sendbox-hover-anchor="skill"]') as Element);
    await waitFor(() => expect(screen.getByText("Use Keydex")).not.toBeNull());
    expect(screen.queryByText("内置")).toBeNull();
    expect(screen.queryByText("builtin/skills/keydex-guide/SKILL.md")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "打开 Skill keydex-guide" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(onOpenFileReference).not.toHaveBeenCalled();
  });

  it("refreshes effective skills when a new slash menu session opens", async () => {
    const onRefreshSkills = vi.fn();
    const baseProps = {
      runtimeState: "idle" as const,
      canSend: true,
      canStop: false,
      onChange: vi.fn(),
      onSend: vi.fn(),
      onStop: vi.fn(),
      onRefreshSkills,
    };
    const { rerender } = render(<SendBox value="" {...baseProps} />);

    rerender(<SendBox value="/" {...baseProps} />);
    await waitFor(() => expect(onRefreshSkills).toHaveBeenCalledTimes(1));

    rerender(<SendBox value="/dev" {...baseProps} />);
    expect(onRefreshSkills).toHaveBeenCalledTimes(1);

    rerender(<SendBox value="" {...baseProps} />);
    rerender(<SendBox value="/" {...baseProps} />);
    await waitFor(() => expect(onRefreshSkills).toHaveBeenCalledTimes(2));
  });
});
