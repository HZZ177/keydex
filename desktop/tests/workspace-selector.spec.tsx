import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceSelector } from "@/renderer/components/workspace";
import type { Workspace } from "@/types/protocol";

describe("WorkspaceSelector", () => {
  it("opens and closes the Keydex style workspace menu", () => {
    render(<WorkspaceSelector value={{ type: "chat" }} workspaces={[workspace("ws-1", "keydex")]} />);

    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    expect(screen.getByRole("dialog", { name: "工作区选择" })).not.toBeNull();
    expect(screen.getByRole("option", { name: /keydex/ })).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "工作区选择" })).toBeNull();
  });

  it("limits a bottom-placed menu to the available viewport height", () => {
    const viewportHeightSpy = vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);

    render(
      <WorkspaceSelector
        value={{ type: "chat" }}
        workspaces={[
          workspace("ws-1", "keydex"),
          workspace("ws-2", "kt-agent-framework"),
          workspace("ws-3", "kt-pm-platform"),
          workspace("ws-4", "zed-class"),
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: "选择工作区" });
    const root = trigger.parentElement as HTMLDivElement;
    const rootRectSpy = vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      bottom: 250,
      height: 30,
      left: 0,
      right: 200,
      top: 220,
      width: 200,
      x: 0,
      y: 220,
      toJSON: () => ({}),
    });

    try {
      fireEvent.click(trigger);

      expect(screen.getByRole("dialog", { name: "工作区选择" }).style.maxHeight).toBe("330px");
    } finally {
      rootRectSpy.mockRestore();
      viewportHeightSpy.mockRestore();
    }
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

  it("selects a recent workspace with arrow keys from the search field", async () => {
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
    const search = screen.getByLabelText("筛选工作区");

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /keydex/ }).getAttribute("data-active")).toBe("true");
    });

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /kt-agent-framework/ }).getAttribute("data-active")).toBe("true");

    fireEvent.keyDown(search, { key: "Enter" });

    expect(onSelectWorkspace).toHaveBeenCalledWith(target);
    expect(screen.queryByRole("dialog", { name: "工作区选择" })).toBeNull();
  });

  it("selects project-free chat with arrow keys", async () => {
    const onSelectChat = vi.fn();
    const selected = workspace("ws-1", "keydex");

    render(
      <WorkspaceSelector
        value={{ type: "workspace", workspace: selected }}
        workspaces={[selected]}
        onSelectChat={onSelectChat}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    const search = screen.getByLabelText("筛选工作区");

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /keydex/ }).getAttribute("data-active")).toBe("true");
    });

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: /无项目聊天/ }).getAttribute("data-active")).toBe("true");

    fireEvent.keyDown(search, { key: "Enter" });

    expect(onSelectChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "工作区选择" })).toBeNull();
  });

  it("keeps keyboard selection on matching projects while filtering from chat mode", async () => {
    const onSelectWorkspace = vi.fn();
    const target = workspace("ws-2", "kt-agent-framework");

    render(
      <WorkspaceSelector
        value={{ type: "chat" }}
        workspaces={[workspace("ws-1", "keydex"), target]}
        onSelectWorkspace={onSelectWorkspace}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    const search = screen.getByLabelText("筛选工作区");
    fireEvent.change(search, { target: { value: "kt-agent" } });

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /kt-agent-framework/ }).getAttribute("data-active")).toBe("true");
    });

    fireEvent.keyDown(search, { key: "Enter" });

    expect(onSelectWorkspace).toHaveBeenCalledWith(target);
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

  it("can hide project-free chat for workbench workspace selection", () => {
    const onSelectChat = vi.fn();

    render(
      <WorkspaceSelector
        value={{ type: "chat" }}
        workspaces={[workspace("ws-1", "keydex")]}
        allowProjectFreeChat={false}
        onSelectChat={onSelectChat}
      />,
    );

    expect(screen.getByRole("button", { name: "选择工作区" }).textContent).toContain("选择工作区");

    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));

    expect(screen.getByRole("option", { name: /keydex/ })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /无项目聊天/ })).toBeNull();
    expect(onSelectChat).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole("menuitem", { name: "选择文件夹" }));

    await waitFor(() => {
      expect(onAddWorkspace).toHaveBeenCalledWith("D:\\picked-project");
    });
    expect(screen.queryByRole("dialog", { name: "工作区选择" })).toBeNull();
  });

  it("keeps the add-project submenu open when clicking the add button again", () => {
    render(<WorkspaceSelector value={{ type: "chat" }} workspaces={[]} onAddWorkspace={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    const addButton = screen.getByRole("button", { name: "添加新项目" });

    fireEvent.click(addButton);
    expect(screen.getByRole("menu", { name: "添加新项目" })).not.toBeNull();

    fireEvent.click(addButton);
    expect(screen.getByRole("menu", { name: "添加新项目" })).not.toBeNull();
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
