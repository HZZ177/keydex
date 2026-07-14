import { Archive, ExternalLink, FolderOpen, FolderPlus, Pencil, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  createLifecycleRequestId,
  decodeLifecycleRuntimeError,
  runtimeBridge,
  type LifecycleRuntimeError,
  type RuntimeBridge,
} from "@/runtime";
import { AppDialog, ConfirmDialog, DialogButton } from "@/renderer/components/dialog";
import { createLifecycleEventGate, emitLifecycleEvent, subscribeLifecycleEvents } from "@/renderer/events/lifecycleEvents";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import type { Workspace } from "@/types/protocol";

import styles from "../ManagementPages.module.css";

const PAGE_SIZE = 50;

export function ProjectManagementPage({ runtime = runtimeBridge }: { runtime?: RuntimeBridge }) {
  const navigate = useNavigate();
  const notifications = useNotifications();
  const [items, setItems] = useState<Workspace[]>([]);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Workspace | null>(null);
  const [editingName, setEditingName] = useState("");
  const [manualCreateOpen, setManualCreateOpen] = useState(false);
  const [manualCreatePath, setManualCreatePath] = useState("");
  const [archiveTarget, setArchiveTarget] = useState<Workspace | null>(null);
  const [archiveBlocker, setArchiveBlocker] = useState<LifecycleRuntimeError | null>(null);
  const requestRevision = useRef(0);
  const lifecycleEventGateRef = useRef(createLifecycleEventGate());
  const workspaceLifecycleRef = useRef(new Map<string, string>());
  const catalogSearchRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    const revision = ++requestRevision.current;
    setLoading(true);
    setError(null);
    try {
      const response = await runtime.workspaces.list();
      if (revision !== requestRevision.current) return;
      setItems(deduplicate(response.list.filter((workspace) => workspace.archived_at === null)));
    } catch (reason) {
      if (revision === requestRevision.current) setError(errorMessage(reason));
    } finally {
      if (revision === requestRevision.current) setLoading(false);
    }
  }, [runtime]);

  useEffect(() => {
    void load();
    return () => { requestRevision.current += 1; };
  }, [load]);

  useEffect(() => subscribeLifecycleEvents((event) => {
    if (!lifecycleEventGateRef.current(event)) return;
    if ((event.type === "workspace_archived" || event.type === "workspace_purged") && event.workspace_id) {
      workspaceLifecycleRef.current.set(event.workspace_id, event.operation_id ?? `${event.type}:${event.occurred_at ?? ""}`);
      setItems((current) => current.filter((workspace) => workspace.id !== event.workspace_id));
      if (archiveTarget?.id === event.workspace_id) setArchiveTarget(null);
      if (editing?.id === event.workspace_id) setEditing(null);
    }
    if (event.type === "workspace_restored" && event.workspace_id) {
      const eventKey = event.operation_id ?? `${event.type}:${event.occurred_at ?? ""}`;
      workspaceLifecycleRef.current.set(event.workspace_id, eventKey);
      void runtime.workspaces.get(event.workspace_id).then((workspace) => {
        if (workspaceLifecycleRef.current.get(event.workspace_id as string) === eventKey && workspace.archived_at === null) {
          setItems((current) => deduplicate([workspace, ...current]));
        }
      }).catch(() => undefined);
    }
  }), [archiveTarget?.id, editing?.id, runtime]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return keyword
      ? items.filter((workspace) => `${workspace.name}\n${workspace.root_path}`.toLocaleLowerCase().includes(keyword))
      : items;
  }, [items, query]);
  const visible = filtered.slice(0, visibleCount);

  const createProject = async () => {
    if (busyId) return;
    setBusyId("create");
    try {
      const path = await runtime.desktopPicker.pickDirectory();
      if (!path) {
        const pickerAvailable = typeof runtime.desktopPicker.isDirectoryPickerAvailable !== "function"
          || runtime.desktopPicker.isDirectoryPickerAvailable();
        if (!pickerAvailable) {
          setManualCreatePath("");
          setManualCreateOpen(true);
        }
        return;
      }
      const created = await runtime.workspaces.create({ rootPath: path });
      setItems((current) => deduplicate([created, ...current]));
      notifications.success("项目已添加");
    } catch (reason) {
      notifications.error(errorMessage(reason));
    } finally {
      setBusyId(null);
    }
  };

  const createProjectFromPath = async () => {
    if (busyId) return;
    const rootPath = manualCreatePath.trim();
    if (!rootPath) {
      notifications.warning("项目路径不能为空");
      return;
    }
    setBusyId("create");
    try {
      const created = await runtime.workspaces.create({ rootPath });
      setItems((current) => deduplicate([created, ...current]));
      setManualCreateOpen(false);
      setManualCreatePath("");
      notifications.success("项目已添加");
    } catch (reason) {
      notifications.error(errorMessage(reason));
    } finally {
      setBusyId(null);
    }
  };

  const saveRename = async () => {
    if (!editing || busyId) return;
    const name = editingName.trim();
    if (!name) {
      notifications.warning("项目名称不能为空");
      return;
    }
    setBusyId(editing.id);
    try {
      const updated = await runtime.workspaces.update(editing.id, { name });
      setItems((current) => current.map((workspace) => workspace.id === updated.id ? updated : workspace));
      setEditing(null);
      notifications.success("项目已重命名");
    } catch (reason) {
      notifications.error(errorMessage(reason));
    } finally {
      setBusyId(null);
    }
  };

  const archiveProject = async (stopActiveSessions: boolean) => {
    if (!archiveTarget || busyId) return;
    setBusyId(archiveTarget.id);
    try {
      const result = await runtime.workspaces.archive(archiveTarget.id, {
        requestId: createLifecycleRequestId("workspace-archive"),
        stopActiveSessions,
      });
      if (result.event) emitLifecycleEvent(result.event);
      setItems((current) => current.filter((workspace) => workspace.id !== archiveTarget.id));
      setArchiveTarget(null);
      setArchiveBlocker(null);
      window.setTimeout(() => catalogSearchRef.current?.focus(), 0);
      notifications.success(`项目已归档，随项目归档 ${result.newly_archived} 个会话`, {
        actionLabel: "查看归档",
        onAction: () => navigate("/settings/archive"),
      });
    } catch (reason) {
      const decoded = decodeLifecycleRuntimeError(reason);
      if (decoded?.kind === "archive_requires_stop_confirmation") setArchiveBlocker(decoded);
      else notifications.error(errorMessage(reason));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className={styles.page} data-settings-page data-testid="project-management-page">
      <header className={styles.header} data-settings-header>
        <div>
          <h1>项目管理</h1>
          <p>集中管理 Keydex 中的活动项目、工作目录与归档状态。</p>
        </div>
        <button className={styles.primaryButton} data-settings-primary disabled={busyId === "create"} type="button" onClick={() => void createProject()}>
          <FolderPlus size={15} aria-hidden="true" />{busyId === "create" ? "正在添加" : "新增项目"}
        </button>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.search} role="search">
          <Search size={15} aria-hidden="true" />
          <input ref={catalogSearchRef} aria-label="搜索项目" placeholder="搜索项目名称或路径" value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(PAGE_SIZE); }} />
        </div>
        <button className={styles.iconButton} data-settings-icon-button aria-label="刷新项目列表" disabled={loading} type="button" onClick={() => void load()}><RefreshCw size={15} /></button>
      </div>

      <section className={styles.list} aria-busy={loading} aria-label="活动项目列表">
        <div className={styles.listHeader}><strong>活动项目</strong><span>{filtered.length} 个项目</span></div>
        {loading && items.length === 0 ? <div className={styles.state}>正在加载项目…</div> : null}
        {error ? <div className={styles.error} role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>重试</button></div> : null}
        {!loading && !error && visible.length === 0 ? <div className={styles.state}>{query ? "没有匹配的项目" : "暂无项目"}</div> : null}
        {visible.map((workspace) => (
          <article className={styles.row} aria-busy={busyId === workspace.id} key={workspace.id}>
            <span className={styles.rowIcon}><FolderOpen size={16} aria-hidden="true" /></span>
            <div className={styles.rowMain}>
              <strong title={workspace.name}>{workspace.name}</strong>
              <span title={workspace.root_path}>{workspace.root_path}</span>
            </div>
            <time className={styles.time} dateTime={workspace.last_opened_at ?? workspace.updated_at}>{formatTime(workspace.last_opened_at ?? workspace.updated_at)}</time>
            <div className={styles.actions}>
              <button type="button" onClick={() => navigate(`/workbench/${encodeURIComponent(workspace.id)}`)}><ExternalLink size={14} />在工作台打开</button>
              <button type="button" onClick={() => { setEditing(workspace); setEditingName(workspace.name); }}><Pencil size={14} />重命名</button>
              <button type="button" onClick={() => void runtime.desktopPicker.revealPath(workspace.root_path).catch((reason) => notifications.error(errorMessage(reason)))}><FolderOpen size={14} />资源管理器</button>
              <button type="button" onClick={() => { setArchiveTarget(workspace); setArchiveBlocker(null); }}><Archive size={14} />归档</button>
            </div>
          </article>
        ))}
      </section>
      {visibleCount < filtered.length ? <button className={styles.loadMore} type="button" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>加载更多</button> : null}

      {editing ? (
        <AppDialog
          title="重命名项目"
          description="仅修改 Keydex 中显示的名称，不会重命名本地目录。"
          size="form"
          closeOnOverlayClick={false}
          bodyClassName={styles.dialogBody}
          footerClassName={styles.dialogFooter}
          onClose={() => setEditing(null)}
          footer={<><DialogButton type="button" onClick={() => setEditing(null)}>取消</DialogButton><DialogButton form="project-rename-form" tone="primary" type="submit" disabled={busyId === editing.id}>保存</DialogButton></>}
        >
          <form id="project-rename-form" className={styles.form} onSubmit={(event) => { event.preventDefault(); void saveRename(); }}>
            <label>项目名称<input autoFocus aria-label="项目名称" value={editingName} onChange={(event) => setEditingName(event.target.value)} /></label>
          </form>
        </AppDialog>
      ) : null}

      {manualCreateOpen ? (
        <AppDialog
          title="新增项目"
          description="当前环境无法打开文件夹选择器，请输入项目目录的完整路径。"
          size="form"
          closeOnOverlayClick={false}
          bodyClassName={styles.dialogBody}
          footerClassName={styles.dialogFooter}
          onClose={() => setManualCreateOpen(false)}
          footer={<><DialogButton type="button" disabled={busyId === "create"} onClick={() => setManualCreateOpen(false)}>取消</DialogButton><DialogButton form="project-create-form" tone="primary" type="submit" disabled={busyId === "create"}>{busyId === "create" ? "正在添加" : "添加项目"}</DialogButton></>}
        >
          <form id="project-create-form" className={styles.form} onSubmit={(event) => { event.preventDefault(); void createProjectFromPath(); }}>
            <label>项目路径<input autoFocus aria-label="项目路径" placeholder="例如 D:\\Projects\\keydex" value={manualCreatePath} onChange={(event) => setManualCreatePath(event.target.value)} /></label>
          </form>
        </AppDialog>
      ) : null}

      {archiveTarget ? (
        <ConfirmDialog
          title={archiveBlocker ? "停止会话并归档项目？" : "归档项目？"}
          description={archiveBlocker ? "项目中仍有运行、等待、审批、排队输入或任务。确认后会先停止这些活动，再归档项目及其中的会话。" : "项目及其中的会话将移至归档管理。本地目录及文件不会被删除。"}
          preview={archiveBlocker ? `${archiveTarget.name} · 受影响活动 ${blockerCount(archiveBlocker)} 项` : archiveTarget.name}
          confirmLabel={archiveBlocker ? "停止会话并归档项目" : "归档项目"}
          cancelDisabled={busyId === archiveTarget.id}
          confirmDisabled={busyId === archiveTarget.id}
          onCancel={() => { setArchiveTarget(null); setArchiveBlocker(null); }}
          onConfirm={() => void archiveProject(Boolean(archiveBlocker))}
        />
      ) : null}
    </main>
  );
}

function deduplicate(items: Workspace[]): Workspace[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.id) && seen.add(item.id));
}

function blockerCount(error: LifecycleRuntimeError): number {
  return typeof error.details.blocker_count === "number" ? error.details.blocker_count : 1;
}

function formatTime(value: string | null): string {
  if (!value) return "尚未打开";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message : "操作失败";
}
