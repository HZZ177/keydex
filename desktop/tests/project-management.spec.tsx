import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { RuntimeHttpError } from "@/runtime";
import { emitLifecycleEvent } from "@/renderer/events/lifecycleEvents";
import { ProjectManagementPage } from "@/renderer/pages/settings/projects/ProjectManagementPage";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import type { Workspace } from "@/types/protocol";

describe("ProjectManagementPage", () => {
  it("deduplicates active rows, excludes stale archived rows and incrementally shows more than 50 projects", async () => {
    const many = Array.from({ length: 55 }, (_, index) => workspace(`ws-${index}`, `Project ${index}`));
    const runtime = projectRuntime([...many, many[0], workspace("archived", "Archived", "2026-07-14T00:00:00Z")]);
    renderPage(runtime);

    expect(await screen.findByText("Project 0")).not.toBeNull();
    expect(screen.getAllByText("Project 0")).toHaveLength(1);
    expect(screen.queryByText("Project 54")).toBeNull();
    expect(screen.queryByText("Archived")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(screen.getByText("Project 54")).not.toBeNull();
  });

  it("distinguishes load failure from empty state and retries without duplicating rows", async () => {
    const runtime = projectRuntime([]);
    vi.mocked(runtime.workspaces.list)
      .mockRejectedValueOnce(new Error("项目列表暂不可用"))
      .mockResolvedValueOnce({ list: [workspace("ws-1", "Recovered")], total: 1 });
    renderPage(runtime);

    expect((await screen.findByRole("alert")).textContent).toContain("项目列表暂不可用");
    expect(screen.queryByText("暂无项目")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("Recovered")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lists only active projects and supports search, rename, reveal and open", async () => {
    const runtime = projectRuntime([workspace("ws-1", "Keydex"), workspace("ws-archived", "Archived", "2026-07-14T00:00:00Z")]);
    renderPage(runtime);

    expect(await screen.findByText("Keydex")).not.toBeNull();
    expect(screen.queryByText("Archived")).toBeNull();
    expect(screen.getByRole("search").tagName).toBe("DIV");
    expect(screen.getByLabelText("搜索项目").closest("label")).toBeNull();
    fireEvent.change(screen.getByLabelText("搜索项目"), { target: { value: "missing" } });
    expect(screen.getByText("没有匹配的项目")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("搜索项目"), { target: { value: "key" } });

    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "Keydex Next" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(runtime.workspaces.update).toHaveBeenCalledWith("ws-1", { name: "Keydex Next" }));
    expect(await screen.findByText("Keydex Next")).not.toBeNull();

    expect(screen.getByRole("button", { name: "在工作台打开" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /资源管理器/ }));
    await waitFor(() => expect(runtime.desktopPicker.revealPath).toHaveBeenCalledWith("D:/repo/ws-1"));
  });

  it("archives a project as one aggregate command and upgrades to blocker confirmation", async () => {
    const blocked = new RuntimeHttpError({
      code: "archive_requires_stop_confirmation",
      message: "blocked",
      details: { blocker_count: 3 },
      status: 409,
      method: "POST",
      path: "/archive",
      body: {},
      rawText: "",
    });
    const archive = vi.fn()
      .mockRejectedValueOnce(blocked)
      .mockResolvedValueOnce({
        operation_id: "op-1", request_id: "req-1", workspace_id: "ws-1", changed: true,
        archived_at: "2026-07-14T00:00:00Z", newly_archived: 12, manual_preserved: 1,
        project_preserved: 0, event: null,
      });
    const runtime = projectRuntime([workspace("ws-1", "Keydex")], archive);
    renderPage(runtime);
    await screen.findByText("Keydex");

    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "归档项目？" })).getByRole("button", { name: "归档项目" }));
    const blockerDialog = await screen.findByRole("dialog", { name: "停止会话并归档项目？" });
    expect(within(blockerDialog).getByText(/受影响活动 3 项/)).not.toBeNull();
    fireEvent.click(within(blockerDialog).getByRole("button", { name: "停止会话并归档项目" }));

    await waitFor(() => expect(archive).toHaveBeenLastCalledWith("ws-1", expect.objectContaining({ stopActiveSessions: true })));
    expect(screen.queryByText("Keydex")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("搜索项目")));
  });

  it("supports a keyboard-only project archive confirmation", async () => {
    const user = userEvent.setup();
    const archive = vi.fn().mockResolvedValue({
      operation_id: "op-keyboard", request_id: "req-keyboard", workspace_id: "ws-1",
      changed: true, archived_at: "2026-07-14T00:00:00Z", newly_archived: 1,
      manual_preserved: 0, project_preserved: 0, event: null,
    });
    const runtime = projectRuntime([workspace("ws-1", "Keyboard Project")], archive);
    renderPage(runtime);
    await screen.findByText("Keyboard Project");

    screen.getByRole("button", { name: "归档" }).focus();
    await user.keyboard("[Enter]");
    const dialog = await screen.findByRole("dialog", { name: "归档项目？" });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "取消" })));
    await user.keyboard("[Tab][Enter]");

    await waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Keyboard Project")).toBeNull();
  });

  it("reuses picker/create/open bridges and keeps cancelled creation side-effect free", async () => {
    const runtime = projectRuntime([workspace("ws-1", "Keydex")]);
    vi.mocked(runtime.desktopPicker.pickDirectory)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("D:/repo/new");
    vi.mocked(runtime.workspaces.create).mockResolvedValue(workspace("ws-new", "New Project"));
    renderPage(runtime);

    fireEvent.click(screen.getByRole("button", { name: "新增项目" }));
    await waitFor(() => expect(runtime.desktopPicker.pickDirectory).toHaveBeenCalledTimes(1));
    expect(runtime.workspaces.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "新增项目" }));
    expect(await screen.findByText("New Project")).not.toBeNull();
    expect(runtime.workspaces.create).toHaveBeenCalledWith({ rootPath: "D:/repo/new" });

    fireEvent.click(screen.getAllByRole("button", { name: /打开/ })[0]);
    expect(screen.getByTestId("project-location").textContent).toBe("/workbench/ws-new");
  });

  it("opens a manual path dialog when the desktop directory picker is unavailable", async () => {
    const runtime = projectRuntime([]);
    vi.mocked(runtime.desktopPicker.pickDirectory).mockResolvedValue(null);
    vi.mocked(runtime.desktopPicker.isDirectoryPickerAvailable).mockReturnValue(false);
    vi.mocked(runtime.workspaces.create).mockResolvedValue(workspace("ws-manual", "Manual Project"));
    renderPage(runtime);

    fireEvent.click(screen.getByRole("button", { name: "新增项目" }));
    const dialog = await screen.findByRole("dialog", { name: "新增项目" });
    fireEvent.change(within(dialog).getByLabelText("项目路径"), { target: { value: "D:/repo/manual" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加项目" }));

    await waitFor(() => expect(runtime.workspaces.create).toHaveBeenCalledWith({ rootPath: "D:/repo/manual" }));
    expect(await screen.findByText("Manual Project")).not.toBeNull();
  });

  it("applies workspace lifecycle events locally and ignores an older event", async () => {
    const runtime = projectRuntime([workspace("ws-1", "Keydex")]);
    vi.mocked(runtime.workspaces.get).mockResolvedValue(workspace("ws-1", "Keydex Restored"));
    renderPage(runtime);
    await screen.findByText("Keydex");

    act(() => emitLifecycleEvent({ type: "workspace_archived", workspace_id: "ws-1", operation_id: "op-2", revision: 2, occurred_at: "2026-07-14T02:00:00Z" }));
    await waitFor(() => expect(screen.queryByText("Keydex")).toBeNull());
    act(() => emitLifecycleEvent({ type: "workspace_restored", workspace_id: "ws-1", operation_id: "op-1", revision: 1, occurred_at: "2026-07-14T01:00:00Z" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.workspaces.get).not.toHaveBeenCalled();
    expect(screen.queryByText("Keydex Restored")).toBeNull();

    act(() => emitLifecycleEvent({ type: "workspace_restored", workspace_id: "ws-1", operation_id: "op-3", revision: 3, occurred_at: "2026-07-14T03:00:00Z" }));
    expect(await screen.findByText("Keydex Restored")).not.toBeNull();
    expect(runtime.workspaces.list).toHaveBeenCalledTimes(1);
  });
});

function renderPage(runtime: RuntimeBridge) {
  return render(<MemoryRouter><NotificationProvider><ProjectManagementPage runtime={runtime} /><ProjectLocation /></NotificationProvider></MemoryRouter>);
}

function ProjectLocation() {
  const location = useLocation();
  return <span data-testid="project-location">{location.pathname}</span>;
}

function projectRuntime(items: Workspace[], archive = vi.fn()): RuntimeBridge {
  const mutable = [...items];
  return {
    workspaces: {
      list: vi.fn().mockResolvedValue({ list: mutable, total: mutable.length }),
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(async (id: string, payload: { name?: string | null }) => {
        const current = mutable.find((item) => item.id === id) ?? workspace(id, id);
        return { ...current, name: payload.name ?? current.name };
      }),
      archive,
    },
    desktopPicker: {
      isDirectoryPickerAvailable: vi.fn(() => true),
      pickDirectory: vi.fn(),
      revealPath: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as RuntimeBridge;
}

function workspace(id: string, name: string, archivedAt: string | null = null): Workspace {
  return { id, name, root_path: `D:/repo/${id}`, normalized_root_path: `d:/repo/${id}`, type: "project", created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-14T00:00:00Z", last_opened_at: null, archived_at: archivedAt };
}
