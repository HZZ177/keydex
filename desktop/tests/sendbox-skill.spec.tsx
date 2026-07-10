import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SendBox } from "@/renderer/components/chat/SendBox";
import type { WorkspaceSkillSummary } from "@/runtime";

const skills: WorkspaceSkillSummary[] = [
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
        workspaceSkills={skills}
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
        workspaceSkills={skills}
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
        workspaceSkills={skills}
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
        workspaceSkills={skills}
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

  it("refreshes workspace skills when a new slash menu session opens", async () => {
    const onRefreshWorkspaceSkills = vi.fn();
    const baseProps = {
      runtimeState: "idle" as const,
      canSend: true,
      canStop: false,
      onChange: vi.fn(),
      onSend: vi.fn(),
      onStop: vi.fn(),
      onRefreshWorkspaceSkills,
    };
    const { rerender } = render(<SendBox value="" {...baseProps} />);

    rerender(<SendBox value="/" {...baseProps} />);
    await waitFor(() => expect(onRefreshWorkspaceSkills).toHaveBeenCalledTimes(1));

    rerender(<SendBox value="/dev" {...baseProps} />);
    expect(onRefreshWorkspaceSkills).toHaveBeenCalledTimes(1);

    rerender(<SendBox value="" {...baseProps} />);
    rerender(<SendBox value="/" {...baseProps} />);
    await waitFor(() => expect(onRefreshWorkspaceSkills).toHaveBeenCalledTimes(2));
  });
});
