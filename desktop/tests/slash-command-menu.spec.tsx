import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SendBox } from "@/renderer/components/chat/SendBox";
import {
  buildSlashCommands,
  filterSlashCommands,
  filterSlashSkills,
  getSlashQuery,
  removeSlashQuery,
  replaceSlashQuery,
} from "@/renderer/components/chat/SlashCommandMenu";

describe("SlashCommandMenu", () => {
  it("parses and filters slash commands", () => {
    const rootCommands = buildSlashCommands();

    expect(getSlashQuery("/")).toBe("");
    expect(getSlashQuery("请 /mod")).toBe("mod");
    expect(getSlashQuery("请 /旁路")).toBe("旁路");
    expect(getSlashQuery("没有命令")).toBeNull();
    expect(filterSlashCommands(rootCommands, "model")).toEqual([]);
    expect(filterSlashCommands(rootCommands, "goal").map((command) => command.id)).toEqual(["goal"]);
    expect(filterSlashCommands(rootCommands, "目标").map((command) => command.id)).toEqual(["goal"]);
    expect(filterSlashCommands(rootCommands, "压缩").map((command) => command.id)).toEqual(["context-compression"]);
    expect(replaceSlashQuery("请 /dev", "")).toBe("请 ");
    expect(replaceSlashQuery("请 /旁路", "")).toBe("请 ");
    expect(removeSlashQuery("请 /dev")).toBe("请");
  });

  it("builds a fixed top-level skill command and filters skills locally", () => {
    const skills = [
      {
        name: "dev-plan",
        label: "/dev-plan",
        description: "Plan work from a design doc",
        source: "workspace" as const,
        locator: ".keydex/skills/dev-plan/SKILL.md",
      },
    ];
    const commands = buildSlashCommands(skills);
    const emptyCommands = buildSlashCommands();

    expect(commands.map((command) => command.id)).toEqual([
      "bypass-conversation",
      "goal",
      "context-compression",
      "skill",
    ]);
    expect(emptyCommands.map((command) => command.id)).toEqual([
      "bypass-conversation",
      "goal",
      "context-compression",
      "skill",
    ]);
    expect(commands[0]).toMatchObject({ id: "bypass-conversation", label: "旁路对话" });
    expect(commands[1]).toMatchObject({ id: "goal", label: "目标", kind: "goal" });
    expect(commands[2]).toMatchObject({ id: "context-compression", label: "压缩上下文", kind: "builtin" });
    expect(emptyCommands[3]?.childCount).toBe(0);
    expect(filterSlashCommands(commands, "旁路").map((command) => command.id)).toEqual(["bypass-conversation"]);
    expect(filterSlashCommands(commands, "goal").map((command) => command.id)).toEqual(["goal"]);
    expect(filterSlashCommands(commands, "目标").map((command) => command.id)).toEqual(["goal"]);
    expect(filterSlashCommands(commands, "plan").map((command) => command.id)).toEqual(["skill"]);
    expect(filterSlashSkills(skills, "plan").map((skill) => skill.name)).toEqual(["dev-plan"]);
  });

  it("can hide the bypass conversation command for nested sidecar composers", () => {
    expect(buildSlashCommands([], { includeBypassConversation: false }).map((command) => command.id)).toEqual([
      "goal",
      "context-compression",
      "skill",
    ]);
    expect(buildSlashCommands([], { includeBypassConversation: false, includeGoal: false }).map((command) => command.id)).toEqual([
      "context-compression",
      "skill",
    ]);
    expect(
      buildSlashCommands([], {
        includeBypassConversation: false,
        includeGoal: false,
        includeContextCompression: false,
      }).map((command) => command.id),
    ).toEqual(["skill"]);
  });

  it("keeps Skill visible without workspace skills and shows the project empty state inside it", () => {
    render(
      <SendBox
        value="/"
        runtimeState="idle"
        canSend
        canStop={false}
        workspaceSkills={[]}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByTestId("slash-command-menu")).not.toBeNull();
    expect(screen.queryByText("/旁路对话")).toBeNull();
    expect(screen.getByText("旁路对话")).not.toBeNull();
    expect(screen.getByRole("option", { name: "创建目标" })).not.toBeNull();
    expect(screen.getByRole("option", { name: /Skill/ })).not.toBeNull();

    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "Enter" });

    expect(screen.getByText("当前项目无 Skill")).not.toBeNull();
    expect(screen.queryByText("没有匹配的命令")).toBeNull();
  });

  it("opens again after the dismissed slash query is removed and typed again", () => {
    const { rerender } = render(
      <SendBox
        value="/"
        runtimeState="idle"
        canSend
        canStop={false}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByTestId("slash-command-menu")).not.toBeNull();
    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "Escape" });
    expect(screen.queryByTestId("slash-command-menu")).toBeNull();

    rerender(
      <SendBox
        value=""
        runtimeState="idle"
        canSend
        canStop={false}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    rerender(
      <SendBox
        value="/"
        runtimeState="idle"
        canSend
        canStop={false}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByTestId("slash-command-menu")).not.toBeNull();
  });

  it("shows an empty state and does not send when no command matches", () => {
    const onSend = vi.fn();
    render(
      <SendBox
        value="/missing"
        runtimeState="idle"
        canSend
        canStop={false}
        onChange={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByText("没有匹配的命令")).not.toBeNull();
    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows workspace skills behind the top-level Skill command and reports the selected command", () => {
    const onChange = vi.fn();
    const onSlashCommand = vi.fn();
    render(
      <SendBox
        value="/"
        runtimeState="idle"
        canSend
        canStop={false}
        workspaceSkills={[
          {
            name: "dev-plan",
            label: "/dev-plan",
            description: "Plan work from a design doc",
            source: "workspace",
            locator: ".keydex/skills/dev-plan/SKILL.md",
          },
        ]}
        onChange={onChange}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onSlashCommand={onSlashCommand}
      />,
    );

    expect(screen.getByTestId("slash-command-menu")).not.toBeNull();
    expect(screen.getByRole("option", { name: /^Skill\b/ })).not.toBeNull();

    const input = screen.getByLabelText("继续输入");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("dev-plan")).not.toBeNull();
    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "Enter" });

    expect(onSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "skill:dev-plan",
        kind: "skill",
        label: "/dev-plan",
      }),
    );
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("selects the goal command without sending the current slash query", () => {
    const onChange = vi.fn();
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    render(
      <SendBox
        value="/目标"
        runtimeState="idle"
        canSend
        canStop={false}
        workspaceSkills={[]}
        onChange={onChange}
        onSend={onSend}
        onStop={vi.fn()}
        onSlashCommand={onSlashCommand}
      />,
    );

    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "Enter" });

    expect(onSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "goal",
        kind: "goal",
        label: "目标",
      }),
    );
    expect(onChange).toHaveBeenCalledWith("");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("selects the context compression command without sending the current slash query", () => {
    const onChange = vi.fn();
    const onSend = vi.fn();
    const onSlashCommand = vi.fn();
    render(
      <SendBox
        value="/压缩"
        runtimeState="idle"
        canSend
        canStop={false}
        workspaceSkills={[]}
        onChange={onChange}
        onSend={onSend}
        onStop={vi.fn()}
        onSlashCommand={onSlashCommand}
      />,
    );

    fireEvent.keyDown(screen.getByLabelText("继续输入"), { key: "Enter" });

    expect(onSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "context-compression",
        kind: "builtin",
        label: "压缩上下文",
      }),
    );
    expect(onChange).toHaveBeenCalledWith("");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not show bypass conversation when disabled", () => {
    render(
      <SendBox
        value="/"
        runtimeState="idle"
        canSend
        canStop={false}
        allowBypassConversationSlashCommand={false}
        allowGoalSlashCommand={false}
        allowContextCompressionSlashCommand={false}
        workspaceSkills={[]}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByTestId("slash-command-menu")).not.toBeNull();
    expect(screen.queryByText("旁路对话")).toBeNull();
    expect(screen.queryByText("目标")).toBeNull();
    expect(screen.getByRole("option", { name: /Skill/ })).not.toBeNull();
  });
});
