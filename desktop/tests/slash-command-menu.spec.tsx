import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SendBox } from "@/renderer/components/chat/SendBox";
import {
  defaultSlashCommands,
  filterSlashCommands,
  getSlashQuery,
  replaceSlashQuery,
} from "@/renderer/components/chat/SlashCommandMenu";

describe("SlashCommandMenu", () => {
  it("parses and filters slash commands", () => {
    expect(getSlashQuery("/")).toBe("");
    expect(getSlashQuery("请 /mod")).toBe("mod");
    expect(getSlashQuery("没有命令")).toBeNull();
    expect(filterSlashCommands(defaultSlashCommands, "model")).toEqual([]);
    expect(filterSlashCommands(defaultSlashCommands, "clear").map((command) => command.id)).toEqual(["clear"]);
    expect(replaceSlashQuery("请 /cle", "/clear ")).toBe("请 /clear ");
  });

  it("opens from SendBox and selects commands with keyboard", () => {
    const onChange = vi.fn();
    render(
      <SendBox
        value="/"
        runtimeState="idle"
        canSend
        canStop={false}
        onChange={onChange}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByTestId("slash-command-menu")).not.toBeNull();
    expect(screen.getByText("/clear")).not.toBeNull();

    const input = screen.getByLabelText("继续输入");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("");
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
});
