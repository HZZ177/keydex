import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ArchiveCatalogPage, ArchivedSessionItem, ArchivedWorkspaceItem, RuntimeBridge } from "@/runtime";
import { RuntimeHttpError } from "@/runtime";
import { ArchiveManagementPage } from "@/renderer/pages/settings/archive/ArchiveManagementPage";
import { emitLifecycleEvent } from "@/renderer/events/lifecycleEvents";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";

describe("ArchiveManagementPage", () => {
  beforeEach(() => localStorage.clear());
  it("uses one grouped page and loads projects and sessions without type tabs", async () => {
    const runtime = archiveRuntime();
    renderPage(runtime, "/settings/archive");
    await screen.findByText("归档项目");
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByRole("region", { name: "已归档会话（按项目分组）" })).not.toBeNull();
    expect(runtime.archive.listArchivedWorkspaces).toHaveBeenCalledTimes(1);
    expect(runtime.archive.listArchivedSessions).toHaveBeenCalledTimes(1);
  });

  it("searches session titles without re-querying projects", async () => {
    const runtime = archiveRuntime();
    renderPage(runtime, "/settings/archive");
    await screen.findByText("归档项目");
    fireEvent.change(screen.getByLabelText("搜索归档会话"), { target: { value: "session query" } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 230)); });
    await waitFor(() => expect(runtime.archive.listArchivedSessions).toHaveBeenCalledTimes(2));
    expect(runtime.archive.listArchivedWorkspaces).toHaveBeenCalledTimes(1);
    expect(runtime.archive.listArchivedSessions).toHaveBeenLastCalledWith(expect.objectContaining({ query: "session query", workspaceIds: [], limit: 200 }));
    expect((screen.getByLabelText("搜索归档会话") as HTMLInputElement).value).toBe("session query");
  });

  it("filters archived sessions by multiple selected projects", async () => {
    const runtime = archiveRuntime();
    const secondProject: ArchivedWorkspaceItem = {
      id: "ws-2", name: "第二项目", archived_at: "2026-07-13T00:00:00Z", session_total: 1,
      manual_session_count: 1, project_session_count: 0, can_restore_project_only: true, can_restore_with_project_sessions: false,
    };
    vi.mocked(runtime.archive.listArchivedWorkspaces).mockResolvedValue(page([
      { id: "ws-1", name: "归档项目", archived_at: "2026-07-14T00:00:00Z", session_total: 1, manual_session_count: 1, project_session_count: 0, can_restore_project_only: true, can_restore_with_project_sessions: false },
      secondProject,
    ]));
    renderPage(runtime, "/settings/archive");
    await screen.findByText("归档项目");

    const projectFilter = screen.getByRole("button", { name: "筛选项目：所有项目" });
    const search = screen.getByRole("search");
    expect(search.tagName).toBe("DIV");
    expect(screen.getByLabelText("搜索归档会话").closest("label")).toBeNull();
    expect(projectFilter.parentElement!.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    fireEvent.click(projectFilter);
    const listbox = screen.getByRole("listbox", { name: "项目筛选选项" });
    fireEvent.click(within(listbox).getByRole("option", { name: "归档项目" }));
    fireEvent.click(within(listbox).getByRole("option", { name: "第二项目" }));

    await waitFor(() => expect(runtime.archive.listArchivedSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceIds: ["ws-1", "ws-2"], query: "", limit: 200 }),
    ));
    expect(screen.getByRole("button", { name: "筛选项目：已选 2 个项目" })).not.toBeNull();
    expect(within(listbox).getByRole("option", { name: "归档项目" }).getAttribute("aria-selected")).toBe("true");
    expect(within(listbox).getByRole("option", { name: "第二项目" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector('[data-state="closing"]')).not.toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 130)); });
    expect(document.querySelector('[data-state="closing"]')).toBeNull();
  });

  it("deduplicates session rows and renders no-project, empty-title and origin fallbacks", async () => {
    const runtime = archiveRuntime();
    const noProject: ArchivedSessionItem = { id: "ses-empty", title: "", archived_at: "2026-07-14T00:00:00Z", archive_origin: "manual", pinned_at: null, workspace: null };
    const projectOrigin: ArchivedSessionItem = { id: "ses-project", title: "项目来源会话", archived_at: "2026-07-14T00:00:00Z", archive_origin: "project", pinned_at: null, workspace: { id: "active-ws", name: "活动项目", archived_at: null } };
    vi.mocked(runtime.archive.listArchivedSessions).mockResolvedValue(page([noProject, noProject, projectOrigin]));
    renderPage(runtime, "/settings/archive");

    expect(await screen.findByText("未命名会话")).not.toBeNull();
    expect(screen.getAllByText("未命名会话")).toHaveLength(1);
    expect(screen.getByText(/无项目/)).not.toBeNull();
    expect(screen.getByText("项目来源会话")).not.toBeNull();
    expect(screen.getByText("随项目归档")).not.toBeNull();
    expect(screen.getByText(/活动项目/)).not.toBeNull();
  });

  it("shows sessions inline under their project and sends an explicit restore mode", async () => {
    const runtime = archiveRuntime();
    renderPage(runtime, "/settings/archive");

    expect(await screen.findByText("归档项目")).not.toBeNull();
    expect(screen.getByText("独立归档会话")).not.toBeNull();
    expect(screen.getByText(/随项目 2 · 手动 1/)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "恢复项目" }));
    const dialog = screen.getByRole("dialog", { name: "恢复归档项目" });
    expect(within(dialog).getByText("手动归档，保持归档")).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: "恢复项目及随项目归档的会话" })).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "仅恢复项目" }));
    await waitFor(() => expect(runtime.workspaces.restore).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ mode: "project_only" }),
    ));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("搜索归档会话")));
  });

  it("loads more project groups and sessions with cursor deduplication", async () => {
    const runtime = archiveRuntime();
    const first: ArchivedSessionItem = { id: "ses-a", title: "会话 A", archived_at: "2026-07-14T00:00:00Z", archive_origin: "project", pinned_at: null, workspace: { id: "ws-1", name: "归档项目", archived_at: "2026-07-14T00:00:00Z" } };
    const second: ArchivedSessionItem = { ...first, id: "ses-b", title: "会话 B" };
    vi.mocked(runtime.archive.listArchivedSessions)
      .mockResolvedValueOnce(page([first], "cursor-2"))
      .mockResolvedValueOnce(page([first, second]));
    renderPage(runtime, "/settings/archive");
    expect(await screen.findByText("会话 A")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "加载更多归档内容" }));
    expect(await screen.findByText("会话 B")).not.toBeNull();
    expect(screen.getAllByText("会话 A")).toHaveLength(1);
    expect(runtime.archive.listArchivedSessions).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "cursor-2", limit: 200, signal: expect.any(AbortSignal) }));
  });

  it("archives an active project from its group row and then refreshes the unified catalog", async () => {
    const runtime = archiveRuntime();
    const activeSession: ArchivedSessionItem = {
      id: "ses-active-project",
      title: "活动项目中的手动归档会话",
      archived_at: "2026-07-14T01:00:00Z",
      archive_origin: "manual",
      pinned_at: null,
      workspace: { id: "ws-active", name: "活动项目", archived_at: null },
    };
    vi.mocked(runtime.archive.listArchivedWorkspaces).mockResolvedValue(page([]));
    vi.mocked(runtime.archive.listArchivedSessions).mockResolvedValue(page([activeSession]));
    renderPage(runtime, "/settings/archive");

    await screen.findByText("活动项目中的手动归档会话");
    fireEvent.click(screen.getByRole("button", { name: "归档项目" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "归档项目？" })).getByRole("button", { name: "归档项目" }));

    await waitFor(() => expect(runtime.workspaces.archive).toHaveBeenCalledWith(
      "ws-active",
      expect.objectContaining({ stopActiveSessions: false }),
    ));
  });

  it("diagnoses inconsistent archived-project counts and blocks destructive actions", async () => {
    const runtime = archiveRuntime();
    vi.mocked(runtime.archive.listArchivedWorkspaces).mockResolvedValue(page([{
      id: "ws-bad", name: "计数异常项目", archived_at: "2026-07-14T00:00:00Z", session_total: 9,
      manual_session_count: 1, project_session_count: 2, can_restore_project_only: true, can_restore_with_project_sessions: true,
    }]));
    renderPage(runtime, "/settings/archive");
    expect(await screen.findByRole("alert")).not.toBeNull();
    const badGroup = screen.getByRole("region", { name: "归档分组 计数异常项目" });
    expect((within(badGroup).getByRole("button", { name: "恢复项目" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(badGroup).getByRole("button", { name: "彻底删除项目" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends with-project-sessions explicitly and never auto-restores on dialog open", async () => {
    const runtime = archiveRuntime();
    renderPage(runtime, "/settings/archive");
    await screen.findByText("归档项目");
    fireEvent.click(screen.getByRole("button", { name: "恢复项目" }));
    expect(runtime.workspaces.restore).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog", { name: "恢复归档项目" })).getByRole("button", { name: "恢复项目及随项目归档的会话" }));
    await waitFor(() => expect(runtime.workspaces.restore).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ mode: "with_project_sessions" }),
    ));
  });

  it("keeps project restore context after failure and retries the same explicit mode", async () => {
    const runtime = archiveRuntime();
    vi.mocked(runtime.workspaces.restore)
      .mockRejectedValueOnce(new Error("恢复暂不可用"))
      .mockResolvedValueOnce({ operation_id: "op-w", request_id: "req-w", workspace_id: "ws-1", mode: "project_only", changed: true, restored_project_sessions: 0, remaining_manual: 1, remaining_project: 2, remaining_total: 3, event: null });
    renderPage(runtime, "/settings/archive");
    await screen.findByText("归档项目");
    fireEvent.click(screen.getByRole("button", { name: "恢复项目" }));
    const dialog = screen.getByRole("dialog", { name: "恢复归档项目" });
    fireEvent.click(within(dialog).getByRole("button", { name: "仅恢复项目" }));
    expect(await within(dialog).findByRole("alert")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "仅恢复项目" }));
    await waitFor(() => expect(runtime.workspaces.restore).toHaveBeenCalledTimes(2));
    expect(vi.mocked(runtime.workspaces.restore).mock.calls.every(([, payload]) => payload.mode === "project_only")).toBe(true);
  });

  it("guides an archived-parent conflict through project-only restore then explicit session restore", async () => {
    const conflict = new RuntimeHttpError({
      code: "workspace_archived",
      message: "parent archived",
      details: { workspace_id: "ws-1", workspace_name: "归档项目", archived_at: "2026-07-14T00:00:00Z" },
      status: 409,
      method: "POST",
      path: "/restore",
      body: {},
      rawText: "",
    });
    const restoreSession = vi.fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ operation_id: "op-s", request_id: "req-s", session_id: "ses-1", workspace_id: "ws-1", workspace: null, changed: true, event: null });
    const runtime = archiveRuntime(restoreSession);
    renderPage(runtime, "/settings/archive");
    expect(await screen.findByText("独立归档会话")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    const conflictDialog = await screen.findByRole("dialog", { name: "当前所属项目已归档" });
    fireEvent.click(within(conflictDialog).getByRole("button", { name: "去恢复项目" }));
    const projectDialog = await screen.findByRole("dialog", { name: "恢复归档项目" });
    fireEvent.click(within(projectDialog).getByRole("button", { name: "仅恢复项目" }));

    const continueButton = await screen.findByRole("button", { name: "继续恢复该会话" });
    expect(restoreSession).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(continueButton);
    fireEvent.click(continueButton);
    await waitFor(() => expect(restoreSession).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("独立归档会话")).toBeNull();
  });

  it("lets a project-origin session follow an explicitly confirmed with-project restore", async () => {
    const conflict = new RuntimeHttpError({ code: "workspace_archived", message: "parent archived", details: { workspace_id: "ws-1", workspace_name: "归档项目" }, status: 409, method: "POST", path: "/restore", body: {}, rawText: "" });
    const restoreSession = vi.fn().mockRejectedValueOnce(conflict);
    const runtime = archiveRuntime(restoreSession, "project");
    renderPage(runtime, "/settings/archive");
    await screen.findByText("独立归档会话");
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "当前所属项目已归档" })).getByRole("button", { name: "去恢复项目" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "恢复归档项目" })).getByRole("button", { name: "恢复项目及随项目归档的会话" }));

    await waitFor(() => expect(runtime.workspaces.restore).toHaveBeenCalledWith("ws-1", expect.objectContaining({ mode: "with_project_sessions" })));
    expect(restoreSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "继续恢复该会话" })).toBeNull();
    expect(screen.queryByText("独立归档会话")).toBeNull();
  });

  it.each([
    ["manual" as const, "with_project_sessions" as const, "恢复项目及随项目归档的会话"],
    ["project" as const, "project_only" as const, "仅恢复项目"],
  ])("keeps a %s session archived after %s until the user explicitly continues", async (origin, mode, buttonName) => {
    const conflict = new RuntimeHttpError({ code: "workspace_archived", message: "parent archived", details: { workspace_id: "ws-1", workspace_name: "归档项目" }, status: 409, method: "POST", path: "/restore", body: {}, rawText: "" });
    const restoreSession = vi.fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ operation_id: "op-s", request_id: "req-s", session_id: "ses-1", workspace_id: "ws-1", workspace: null, changed: true, event: null });
    const runtime = archiveRuntime(restoreSession, origin);
    renderPage(runtime, "/settings/archive");
    await screen.findByText("独立归档会话");
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "当前所属项目已归档" })).getByRole("button", { name: "去恢复项目" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "恢复归档项目" })).getByRole("button", { name: buttonName }));

    const continueButton = await screen.findByRole("button", { name: "继续恢复该会话" });
    expect(runtime.workspaces.restore).toHaveBeenCalledWith("ws-1", expect.objectContaining({ mode }));
    expect(restoreSession).toHaveBeenCalledTimes(1);
    fireEvent.click(continueButton);
    await waitFor(() => expect(restoreSession).toHaveBeenCalledTimes(2));
  });

  it("requires exact project name and makes the local-directory boundary visible before purge", async () => {
    const runtime = archiveRuntime();
    renderPage(runtime, "/settings/archive");
    await screen.findByText("归档项目");

    fireEvent.click(screen.getByRole("button", { name: "彻底删除项目" }));
    const dialog = screen.getByRole("dialog", { name: "彻底删除 Keydex 数据" });
    expect(within(dialog).getByText(/不会删除本地目录/)).not.toBeNull();
    const submit = within(dialog).getByRole("button", { name: "彻底删除" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("输入项目名称以确认"), { target: { value: " 归档项目 " } });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("输入项目名称以确认"), { target: { value: "归档项目" } });
    fireEvent.click(submit);

    await waitFor(() => expect(runtime.workspaces.purgeArchived).toHaveBeenCalledWith(
      "ws-1",
      expect.stringMatching(/^workspace-purge:/),
      "归档项目",
    ));
  });

  it("purges every archived session in a project while keeping the project placeholder", async () => {
    const runtime = archiveRuntime();
    renderPage(runtime, "/settings/archive");
    await screen.findByText("独立归档会话");

    fireEvent.click(screen.getByRole("button", { name: "彻底删除项目下全部归档会话" }));
    const dialog = screen.getByRole("dialog", { name: "彻底删除 Keydex 数据" });
    expect(within(dialog).getByText(/项目记录、本地目录和其中的文件都会保留/)).not.toBeNull();
    const submit = within(dialog).getByRole("button", { name: "彻底删除" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("输入项目名称以确认"), { target: { value: "归档项目" } });
    fireEvent.click(submit);

    await waitFor(() => expect(runtime.workspaces.purgeArchivedSessions).toHaveBeenCalledWith(
      "ws-1",
      expect.stringMatching(/^workspace_sessions-purge:/),
      "归档项目",
    ));
    expect(screen.queryByText("独立归档会话")).toBeNull();
    expect(screen.getByText("该项目没有归档会话")).not.toBeNull();
    expect(screen.getByRole("button", { name: "恢复项目" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "彻底删除项目下全部归档会话" })).toBeNull();
  });

  it("requires a session danger checkbox before purge", async () => {
    const runtime = archiveRuntime();
    renderPage(runtime, "/settings/archive");
    await screen.findByText("独立归档会话");
    fireEvent.click(screen.getByRole("button", { name: "彻底删除" }));
    const dialog = screen.getByRole("dialog", { name: "彻底删除 Keydex 数据" });
    const submit = within(dialog).getByRole("button", { name: "彻底删除" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText("确认彻底删除会话"));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(runtime.conversation.purgeArchivedSession).toHaveBeenCalledWith("ses-1", expect.stringMatching(/^session-purge:/)));
  });

  it("supports keyboard-only session restore and purge confirmation", async () => {
    const restoreUser = userEvent.setup();
    const restoreRuntime = archiveRuntime();
    const restoreView = renderPage(restoreRuntime, "/settings/archive");
    await screen.findByText("独立归档会话");
    screen.getByRole("button", { name: "恢复" }).focus();
    await restoreUser.keyboard("[Enter]");
    await waitFor(() => expect(restoreRuntime.conversation.restoreSession).toHaveBeenCalledTimes(1));
    restoreView.unmount();

    const purgeUser = userEvent.setup();
    const purgeRuntime = archiveRuntime();
    renderPage(purgeRuntime, "/settings/archive");
    await screen.findByText("独立归档会话");
    screen.getByRole("button", { name: "彻底删除" }).focus();
    await purgeUser.keyboard("[Enter]");
    const dialog = await screen.findByRole("dialog", { name: "彻底删除 Keydex 数据" });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getAllByRole("button", { name: "关闭" })[0]));
    await purgeUser.keyboard("[Tab][Space][Tab][Tab][Enter]");

    await waitFor(() => expect(purgeRuntime.conversation.purgeArchivedSession).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("独立归档会话")).toBeNull();
  });

  it("removes a committed cleanup failure but retries cleanup with the same request id", async () => {
    const cleanupFailure = new RuntimeHttpError({ code: "cleanup_failed", message: "cleanup failed", details: { retryable: true, operation_id: "op-cleanup" }, status: 500, method: "POST", path: "/purge", body: {}, rawText: "" });
    const runtime = archiveRuntime();
    vi.mocked(runtime.workspaces.purgeArchived)
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce({ operation_id: "op-p", state: "completed", entity_type: "workspace", counts: {}, replayed: true, event: null });
    renderPage(runtime, "/settings/archive");
    await screen.findByText("归档项目");
    fireEvent.click(screen.getByRole("button", { name: "彻底删除项目" }));
    const dialog = screen.getByRole("dialog", { name: "彻底删除 Keydex 数据" });
    fireEvent.change(within(dialog).getByLabelText("输入项目名称以确认"), { target: { value: "归档项目" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "彻底删除" }));
    const cleanupDialog = await screen.findByRole("dialog", { name: "清理尚未完成" });
    expect(screen.queryByRole("button", { name: "恢复项目" })).toBeNull();
    const firstRequestId = vi.mocked(runtime.workspaces.purgeArchived).mock.calls[0][1];
    expect(screen.getByText(/操作 op-cleanup/)).not.toBeNull();
    fireEvent.click(within(cleanupDialog).getAllByRole("button", { name: "关闭" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "重试清理" }));
    await waitFor(() => expect(runtime.workspaces.purgeArchived).toHaveBeenCalledTimes(2));
    expect(vi.mocked(runtime.workspaces.purgeArchived).mock.calls[1][1]).toBe(firstRequestId);
    expect(localStorage.getItem("keydex.pending-purge-cleanups.v1")).toBeNull();
  });

  it("restores a pending cleanup after remount and retries without the deleted catalog item", async () => {
    localStorage.setItem("keydex.pending-purge-cleanups.v1", JSON.stringify([{
      requestId: "workspace-purge:persisted", operationId: "op-persisted", targetType: "workspace",
      entityId: "ws-deleted", displayName: "已删除项目", confirmationName: "已删除项目",
    }]));
    const runtime = archiveRuntime();
    vi.mocked(runtime.archive.listArchivedWorkspaces).mockResolvedValue(page([]));
    renderPage(runtime, "/settings/archive");

    expect(await screen.findByText(/已删除项目.*清理尚未完成/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试清理" }));
    await waitFor(() => expect(runtime.workspaces.purgeArchived).toHaveBeenCalledWith("ws-deleted", "workspace-purge:persisted", "已删除项目"));
    expect(screen.queryByText(/已删除项目.*清理尚未完成/)).toBeNull();
  });

  it("applies restore events locally and ignores their duplicate without refetching", async () => {
    const runtime = archiveRuntime();
    renderPage(runtime, "/settings/archive");
    await screen.findByText("归档项目");
    const event = { type: "workspace_restored" as const, workspace_id: "ws-1", operation_id: "op-event", revision: 3, occurred_at: "2026-07-14T03:00:00Z" };
    act(() => { emitLifecycleEvent(event); emitLifecycleEvent(event); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "恢复项目" })).toBeNull());
    expect(screen.getByText(/项目仍在使用/)).not.toBeNull();
    expect(runtime.archive.listArchivedWorkspaces).toHaveBeenCalledTimes(1);
  });

  it("applies a project-session purge event without removing the project", async () => {
    const runtime = archiveRuntime();
    renderPage(runtime, "/settings/archive");
    await screen.findByText("独立归档会话");

    act(() => emitLifecycleEvent({
      type: "workspace_sessions_purged",
      workspace_id: "ws-1",
      operation_id: "op-workspace-sessions-purge",
      revision: 4,
      occurred_at: "2026-07-14T04:00:00Z",
    }));

    await waitFor(() => expect(screen.queryByText("独立归档会话")).toBeNull());
    expect(screen.getByText("该项目没有归档会话")).not.toBeNull();
    expect(screen.getByRole("button", { name: "恢复项目" })).not.toBeNull();
  });

  it("does not reinsert a restored project when an older catalog response resolves late", async () => {
    const deferred = createDeferred<ArchiveCatalogPage<ArchivedWorkspaceItem>>();
    const runtime = archiveRuntime();
    vi.mocked(runtime.archive.listArchivedWorkspaces).mockReturnValue(deferred.promise);
    renderPage(runtime, "/settings/archive");

    act(() => emitLifecycleEvent({ type: "workspace_restored", workspace_id: "ws-1", operation_id: "op-restore", revision: 8, occurred_at: "2026-07-14T08:00:00Z" }));
    await act(async () => {
      deferred.resolve(page([{ id: "ws-1", name: "旧响应项目", archived_at: "2026-07-14T00:00:00Z", session_total: 0, manual_session_count: 0, project_session_count: 0, can_restore_project_only: true, can_restore_with_project_sessions: false }]));
      await deferred.promise;
    });

    expect(screen.queryByText("旧响应项目")).toBeNull();
    expect(runtime.archive.listArchivedWorkspaces).toHaveBeenCalledTimes(1);
  });
});

function renderPage(runtime: RuntimeBridge, path: string) {
  return render(<MemoryRouter initialEntries={[path]}><NotificationProvider><ArchiveManagementPage runtime={runtime} /></NotificationProvider></MemoryRouter>);
}

function archiveRuntime(restoreSession = vi.fn().mockResolvedValue({ operation_id: "op-s", request_id: "req-s", session_id: "ses-1", workspace_id: "ws-1", workspace: null, changed: true, event: null }), sessionOrigin: "manual" | "project" = "manual"): RuntimeBridge {
  const project: ArchivedWorkspaceItem = { id: "ws-1", name: "归档项目", archived_at: "2026-07-14T00:00:00Z", session_total: 3, manual_session_count: 1, project_session_count: 2, can_restore_project_only: true, can_restore_with_project_sessions: true };
  const session: ArchivedSessionItem = { id: "ses-1", title: "独立归档会话", archived_at: "2026-07-14T00:00:00Z", archive_origin: sessionOrigin, pinned_at: null, workspace: { id: "ws-1", name: "归档项目", archived_at: "2026-07-14T00:00:00Z" } };
  const summary: ArchivedSessionItem = { ...session, id: "ses-summary", title: "项目内会话", archive_origin: "project" };
  return {
    archive: {
      listArchivedWorkspaces: vi.fn().mockResolvedValue(page([project])),
      listArchivedSessions: vi.fn().mockResolvedValue(page([session])),
      listWorkspaceArchivedSessions: vi.fn().mockResolvedValue(page([summary])),
    },
    workspaces: {
      archive: vi.fn().mockResolvedValue({ operation_id: "op-a", request_id: "req-a", workspace_id: "ws-active", changed: true, archived_at: "2026-07-14T02:00:00Z", newly_archived: 2, manual_preserved: 1, project_preserved: 0, event: null }),
      restore: vi.fn().mockResolvedValue({ operation_id: "op-w", request_id: "req-w", workspace_id: "ws-1", mode: "project_only", changed: true, restored_project_sessions: 0, remaining_manual: 1, remaining_project: 2, remaining_total: 3, event: null }),
      purgeArchived: vi.fn().mockResolvedValue({ operation_id: "op-p", state: "completed", entity_type: "workspace", counts: {}, replayed: false, event: null }),
      purgeArchivedSessions: vi.fn().mockResolvedValue({ operation_id: "op-ps", state: "completed", entity_type: "workspace_sessions", counts: { sessions: 3 }, replayed: false, event: null }),
    },
    conversation: {
      restoreSession,
      purgeArchivedSession: vi.fn().mockResolvedValue({ operation_id: "op-p", state: "completed", entity_type: "session", counts: {}, replayed: false, event: null }),
    },
  } as unknown as RuntimeBridge;
}

function page<T>(items: T[], nextCursor: string | null = null) { return { items, next_cursor: nextCursor, has_more: nextCursor !== null, total: null, total_kind: "not_computed" as const }; }

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
