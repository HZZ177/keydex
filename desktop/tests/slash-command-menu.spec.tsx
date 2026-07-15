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

  it("keeps Skill visible without effective skills and shows the scope empty state inside it", () => {
    render(
      <SendBox
        value="/"
        runtimeState="idle"
        canSend
        canStop={false}
        skills={[]}
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

    expect(screen.getByText("当前范围无 Skill")).not.toBeNull();
    expect(screen.queryByText("没有匹配的命令")).toBeNull();
  });

  it("shows effective catalog diagnostics inside the Skill view", () => {
    render(
      <SendBox
        value="/"
        runtimeState="idle"
        canSend
        canStop={false}
        skills={[]}
        skillDiagnostics={[{
          code: "keydex_manifest_invalid",
          reason: "keydex.json is not valid JSON",
          path: "keydex.json",
          severity: "error",
          details: {},
        }]}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("继续输入");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("alert").textContent).toContain(
      "Skill 配置错误：keydex.json is not valid JSON",
    );
    expect(screen.getByTestId("skill-diagnostic").getAttribute("data-diagnostic-code")).toBe(
      "keydex_manifest_invalid",
    );
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

  it("shows effective skills behind the top-level Skill command and reports the selected command", () => {
    const onChange = vi.fn();
    const onSlashCommand = vi.fn();
    render(
      <SendBox
        value="/"
        runtimeState="idle"
        canSend
        canStop={false}
        skills={[
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
        id: "skill:workspace:dev-plan",
        kind: "skill",
        label: "/dev-plan",
      }),
    );
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("renders only the effective winner and labels its source without a version submenu", () => {
    render(
      <SendBox
        value="/shared"
        runtimeState="idle"
        canSend
        canStop={false}
        skills={[
          {
            name: "shared",
            label: "/shared",
            description: "Workspace winner",
            source: "workspace",
            locator: ".keydex/skills/shared/SKILL.md",
          },
        ]}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("option", { name: "选择 Skill /shared" })).toHaveLength(1);
    expect(screen.getByText("项目级")).not.toBeNull();
    expect(screen.queryByText("系统级")).toBeNull();
  });

  it("labels a system effective winner as system-level", () => {
    render(
      <SendBox
        value="/review"
        runtimeState="idle"
        canSend
        canStop={false}
        skills={[
          {
            name: "review",
            label: "/review",
            description: "System review policy",
            source: "system",
            locator: ".keydex/skills/review/SKILL.md",
          },
        ]}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("option", { name: "选择 Skill /review" })).toHaveLength(1);
    expect(screen.getByText("系统级")).not.toBeNull();
  });

  it("renders one builtin winner with the builtin source badge", () => {
    render(
      <SendBox
        value="/keydex-guide"
        runtimeState="idle"
        canSend
        canStop={false}
        skills={[
          {
            name: "keydex-guide",
            label: "/keydex-guide",
            description: "Use Keydex",
            source: "builtin",
            locator: "builtin/skills/keydex-guide/SKILL.md",
          },
        ]}
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("option", { name: "选择 Skill /keydex-guide" })).toHaveLength(1);
    expect(screen.getByText("内置")).not.toBeNull();
    expect(screen.queryByText("系统级")).toBeNull();
    expect(screen.queryByText("项目级")).toBeNull();
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
        skills={[]}
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
        skills={[]}
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
        skills={[]}
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
