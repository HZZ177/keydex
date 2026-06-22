import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceSelector } from "@/renderer/components/workspace";
import type { Workspace } from "@/types/protocol";

describe("WorkspaceSelector", () => {
  it("opens and closes the Codex style workspace menu", () => {
    render(<WorkspaceSelector value={{ type: "chat" }} workspaces={[workspace("ws-1", "keydex")]} />);

    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    expect(screen.getByRole("dialog", { name: "工作区选择" })).not.toBeNull();
    expect(screen.getByRole("option", { name: /keydex/ })).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "工作区选择" })).toBeNull();
  });

  it("selects a recent workspace and closes the menu", () => {
    const onSelectWorkspace = vi.fn();
    const selected = workspace("ws-1", "keydex");
    const target = workspace("ws-2", "kt-agent-framework");

    render(
      <WorkspaceSelector
        value={{ type: "workspace", workspace: selected }}
        workspaces={[selected, target]}
        onSelectWorkspace={onSelectWorkspace}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    fireEvent.click(screen.getByRole("option", { name: /kt-agent-framework/ }));

    expect(onSelectWorkspace).toHaveBeenCalledWith(target);
    expect(screen.queryByRole("dialog", { name: "工作区选择" })).toBeNull();
  });

  it("selects project-free chat mode", () => {
    const onSelectChat = vi.fn();

    render(
      <WorkspaceSelector
        value={{ type: "workspace", workspace: workspace("ws-1", "keydex") }}
        workspaces={[workspace("ws-1", "keydex")]}
        onSelectChat={onSelectChat}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    fireEvent.click(screen.getByRole("button", { name: /无项目聊天/ }));

    expect(onSelectChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "工作区选择" })).toBeNull();
  });

  it("shows path validation errors when adding a workspace fails", async () => {
    const onAddWorkspace = vi.fn().mockRejectedValue(new Error("工作区路径不存在"));

    render(<WorkspaceSelector value={{ type: "chat" }} workspaces={[]} onAddWorkspace={onAddWorkspace} />);

    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    fireEvent.click(screen.getByRole("button", { name: "添加新项目" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "输入本机路径" }));
    fireEvent.change(screen.getByLabelText("项目路径"), { target: { value: "D:\\missing" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => {
      expect(onAddWorkspace).toHaveBeenCalledWith("D:\\missing");
    });
    expect((await screen.findByRole("alert")).textContent).toContain("工作区路径不存在");
  });

  it("adds a picked directory from the desktop directory picker", async () => {
    const onPickWorkspacePath = vi.fn().mockResolvedValue("D:\\picked-project");
    const onAddWorkspace = vi.fn().mockResolvedValue(undefined);

    render(
      <WorkspaceSelector
        value={{ type: "chat" }}
        workspaces={[]}
        onAddWorkspace={onAddWorkspace}
        onPickWorkspacePath={onPickWorkspacePath}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    fireEvent.click(screen.getByRole("button", { name: "添加新项目" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "使用现有文件夹" }));

    await waitFor(() => {
      expect(onAddWorkspace).toHaveBeenCalledWith("D:\\picked-project");
    });
    expect(screen.queryByRole("dialog", { name: "工作区选择" })).toBeNull();
  });

  it("closes the add-project submenu when the pointer leaves that menu area", async () => {
    render(<WorkspaceSelector value={{ type: "chat" }} workspaces={[]} onAddWorkspace={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    const addButton = screen.getByRole("button", { name: "添加新项目" });
    const addSection = addButton.parentElement as HTMLElement;

    fireEvent.mouseEnter(addSection);
    expect(screen.getByRole("menu", { name: "添加新项目" })).not.toBeNull();

    fireEvent.mouseLeave(addSection);
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "添加新项目" })).toBeNull();
    });
  });

  it("filters recent workspaces by name and path", () => {
    render(
      <WorkspaceSelector
        value={{ type: "chat" }}
        workspaces={[workspace("ws-1", "keydex"), workspace("ws-2", "kt-agent-framework")]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    fireEvent.change(screen.getByLabelText("筛选工作区"), { target: { value: "kt-agent" } });

    expect(screen.getByRole("option", { name: /kt-agent-framework/ })).not.toBeNull();
    expect(screen.queryByRole("option", { name: /keydex/ })).toBeNull();
  });
});

function workspace(id: string, name: string): Workspace {
  return {
    id,
    name,
    root_path: `D:\\Pycharm Projects\\${name}`,
    normalized_root_path: `d:/pycharm projects/${name.toLowerCase()}`,
    type: "project",
    created_at: "2026-06-21T00:00:00Z",
    updated_at: "2026-06-21T00:00:00Z",
    last_opened_at: null,
    is_deleted: false,
  };
}
