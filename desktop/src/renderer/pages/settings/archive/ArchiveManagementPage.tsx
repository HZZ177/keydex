import { Archive, Check, ChevronDown, Folder, RefreshCw, RotateCcw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import {
  createLifecycleRequestId,
  decodeLifecycleRuntimeError,
  runtimeBridge,
  type ArchiveCatalogPage,
  type ArchivedSessionItem,
  type ArchivedWorkspaceItem,
  type LifecycleRuntimeError,
  type RuntimeBridge,
  type WorkspaceRestoreMode,
} from "@/runtime";
import { ConfirmDialog } from "@/renderer/components/dialog";
import { FloatingLayer } from "@/renderer/components/floating";
import { createLifecycleEventGate, emitLifecycleEvent, subscribeLifecycleEvents } from "@/renderer/events/lifecycleEvents";
import { useNotifications } from "@/renderer/providers/NotificationProvider";

import styles from "../ManagementPages.module.css";
import { ProjectRestoreDialog } from "./ProjectRestoreDialog";
import { PurgeDialog, type PendingPurgeCleanup } from "./PurgeDialog";

type PurgeTarget =
  | { type: "workspace"; item: ArchivedWorkspaceItem }
  | { type: "workspace_sessions"; item: { id: string; name: string } }
  | { type: "session"; item: ArchivedSessionItem };

interface ArchiveGroup {
  key: string;
  workspace: ArchivedSessionItem["workspace"];
  project: ArchivedWorkspaceItem | null;
  sessions: ArchivedSessionItem[];
  latestArchivedAt: string;
}

interface ActiveProjectTarget {
  id: string;
  name: string;
}

interface ProjectFilterOption {
  id: string;
  name: string;
}

const PENDING_CLEANUPS_KEY = "keydex.pending-purge-cleanups.v1";
const PROJECT_FILTER_EXIT_ANIMATION_MS = 120;

export function ArchiveManagementPage({ runtime = runtimeBridge }: { runtime?: RuntimeBridge }) {
  const notifications = useNotifications();
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(() => new Set());
  const [knownProjectOptions, setKnownProjectOptions] = useState<ProjectFilterOption[]>([]);
  const selectedProjectIdList = useMemo(() => [...selectedProjectIds].sort(), [selectedProjectIds]);
  const loadProjects = useCallback(
    (options: Parameters<RuntimeBridge["archive"]["listArchivedWorkspaces"]>[0]) => runtime.archive.listArchivedWorkspaces(options),
    [runtime],
  );
  const loadSessions = useCallback(
    (options: Parameters<RuntimeBridge["archive"]["listArchivedSessions"]>[0]) => runtime.archive.listArchivedSessions({
      ...options,
      workspaceIds: selectedProjectIdList,
    }),
    [runtime, selectedProjectIdList],
  );
  const projects = useArchiveCatalog<ArchivedWorkspaceItem>({ query: "", load: loadProjects });
  const sessions = useArchiveCatalog<ArchivedSessionItem>({ query: appliedQuery, load: loadSessions });
  const lifecycleEventGateRef = useRef(createLifecycleEventGate());
  const [restoreProject, setRestoreProject] = useState<ArchivedWorkspaceItem | null>(null);
  const [restoreSession, setRestoreSession] = useState<ArchivedSessionItem | null>(null);
  const [sessionConflictProject, setSessionConflictProject] = useState<ArchivedWorkspaceItem | null>(null);
  const [continueSessionRestore, setContinueSessionRestore] = useState<ArchivedSessionItem | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ActiveProjectTarget | null>(null);
  const [archiveBlocker, setArchiveBlocker] = useState<LifecycleRuntimeError | null>(null);
  const [archivingProjectId, setArchivingProjectId] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<PurgeTarget | null>(null);
  const [pendingCleanups, setPendingCleanups] = useState<PendingPurgeCleanup[]>(readPendingCleanups);
  const [retryingCleanupId, setRetryingCleanupId] = useState<string | null>(null);
  const catalogSearchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedQuery(query), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (typeof runtime.workspaces?.list !== "function") return undefined;
    let active = true;
    void runtime.workspaces.list().then((response) => {
      if (!active) return;
      setKnownProjectOptions((current) => mergeProjectOptions(
        current,
        response.list.map((workspace) => ({ id: workspace.id, name: workspace.name })),
      ));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [runtime]);

  useEffect(() => {
    setKnownProjectOptions((current) => {
      const discovered = [
        ...projects.items.map((project) => ({ id: project.id, name: project.name })),
        ...sessions.items.flatMap((session) => session.workspace ? [{ id: session.workspace.id, name: session.workspace.name }] : []),
      ];
      return mergeProjectOptions(current, discovered);
    });
  }, [projects.items, sessions.items]);

  const groups = useMemo(() => buildArchiveGroups(projects.items, sessions.items)
    .filter((group) => selectedProjectIds.size === 0 || Boolean(group.workspace && selectedProjectIds.has(group.workspace.id)))
    .filter((group) => !appliedQuery || group.sessions.length > 0),
  [appliedQuery, projects.items, selectedProjectIds, sessions.items]);

  const focusCatalogAnchor = () => {
    window.setTimeout(() => catalogSearchRef.current?.focus(), 0);
  };

  useEffect(() => subscribeLifecycleEvents((event) => {
    if (!lifecycleEventGateRef.current(event)) return;
    if (event.type === "workspace_purged" && event.workspace_id) {
      projects.remove(event.workspace_id);
      sessions.removeWhere((item) => item.workspace?.id === event.workspace_id);
      setRestoreProject((current) => current?.id === event.workspace_id ? null : current);
      return;
    }
    if (event.type === "workspace_sessions_purged" && event.workspace_id) {
      sessions.removeWhere((item) => item.workspace?.id === event.workspace_id);
      projects.mutate((items) => clearArchivedSessionCounts(items, event.workspace_id as string));
      return;
    }
    if (event.type === "workspace_restored" && event.workspace_id) {
      projects.remove(event.workspace_id);
      sessions.mutate((items) => applyWorkspaceRestore(items, event.workspace_id as string, event.mode));
      setRestoreProject((current) => current?.id === event.workspace_id ? null : current);
      return;
    }
    if (event.type === "workspace_archived" && event.workspace_id) {
      projects.include(event.workspace_id);
      projects.refresh();
      sessions.refresh();
      return;
    }
    if ((event.type === "session_restored" || event.type === "session_purged") && event.session_id) {
      sessions.remove(event.session_id);
      return;
    }
    if (event.type === "session_archived" && event.session_id) {
      sessions.include(event.session_id);
      sessions.refresh();
    }
  }), [projects.include, projects.refresh, projects.remove, sessions.include, sessions.mutate, sessions.refresh, sessions.remove, sessions.removeWhere]);

  const runProjectArchive = async (stopActiveSessions: boolean) => {
    if (!archiveTarget || archivingProjectId) return;
    setArchivingProjectId(archiveTarget.id);
    try {
      const result = await runtime.workspaces.archive(archiveTarget.id, {
        requestId: createLifecycleRequestId("workspace-archive"),
        stopActiveSessions,
      });
      if (result.event) emitLifecycleEvent(result.event);
      else {
        projects.include(archiveTarget.id);
        projects.refresh();
        sessions.refresh();
      }
      setArchiveTarget(null);
      setArchiveBlocker(null);
      notifications.success(`项目已归档，随项目归档 ${result.newly_archived} 个会话`);
      focusCatalogAnchor();
    } catch (reason) {
      const decoded = decodeLifecycleRuntimeError(reason);
      if (decoded?.kind === "archive_requires_stop_confirmation") setArchiveBlocker(decoded);
      else notifications.error(errorMessage(reason));
    } finally {
      setArchivingProjectId(null);
    }
  };

  const runProjectRestore = async (project: ArchivedWorkspaceItem, mode: WorkspaceRestoreMode) => {
    const result = await runtime.workspaces.restore(project.id, {
      requestId: createLifecycleRequestId("workspace-restore"), mode,
    });
    if (result.event) emitLifecycleEvent(result.event);
    projects.remove(project.id);
    sessions.mutate((items) => applyWorkspaceRestore(items, project.id, mode));
    setRestoreProject(null);
    if (!sessionConflictProject) focusCatalogAnchor();
    notifications.success(
      mode === "project_only"
        ? `已恢复项目，仍有 ${result.remaining_total} 个归档会话`
        : `已恢复项目和 ${result.restored_project_sessions} 个随项目归档的会话，手动归档保留 ${result.remaining_manual} 个`,
    );
    return result;
  };

  const runSessionRestore = async (item: ArchivedSessionItem) => {
    try {
      const result = await runtime.conversation.restoreSession(item.id, { requestId: createLifecycleRequestId("session-restore") });
      if (result.event) emitLifecycleEvent(result.event);
      sessions.remove(item.id);
      setRestoreSession(null);
      setContinueSessionRestore(null);
      focusCatalogAnchor();
      notifications.success("会话已恢复");
    } catch (reason) {
      const decoded = decodeLifecycleRuntimeError(reason);
      if (decoded?.kind !== "workspace_archived") throw reason;
      const workspaceId = String(decoded.details.workspace_id ?? item.workspace?.id ?? "");
      const workspaceName = String(decoded.details.workspace_name ?? item.workspace?.name ?? "归档项目");
      setSessionConflictProject(
        projects.items.find((project) => project.id === workspaceId)
        ?? synthesizeArchivedProject(workspaceId, workspaceName, String(decoded.details.archived_at ?? item.workspace?.archived_at ?? item.archived_at), sessions.items),
      );
      setRestoreSession(item);
    }
  };

  const restoreConflictProject = async (mode: WorkspaceRestoreMode) => {
    if (!sessionConflictProject || !restoreSession) throw new Error("恢复上下文已失效");
    const targetSession = restoreSession;
    const result = await runProjectRestore(sessionConflictProject, mode);
    setSessionConflictProject(null);
    if (mode === "with_project_sessions" && targetSession.archive_origin === "project") {
      sessions.remove(targetSession.id);
      setRestoreSession(null);
      focusCatalogAnchor();
    } else {
      setContinueSessionRestore(targetSession);
      setRestoreSession(null);
    }
    return result;
  };

  const rememberPendingCleanup = (cleanup: PendingPurgeCleanup) => {
    setPendingCleanups((current) => {
      const next = [...current.filter((item) => item.requestId !== cleanup.requestId), cleanup];
      writePendingCleanups(next);
      return next;
    });
  };

  const forgetPendingCleanup = (requestId: string) => {
    setPendingCleanups((current) => {
      const next = current.filter((item) => item.requestId !== requestId);
      writePendingCleanups(next);
      return next;
    });
  };

  const retryPendingCleanup = async (cleanup: PendingPurgeCleanup) => {
    if (retryingCleanupId) return;
    setRetryingCleanupId(cleanup.requestId);
    try {
      if (cleanup.targetType === "workspace") {
        await runtime.workspaces.purgeArchived(cleanup.entityId, cleanup.requestId, cleanup.confirmationName ?? cleanup.displayName);
      } else if (cleanup.targetType === "workspace_sessions") {
        await runtime.workspaces.purgeArchivedSessions(cleanup.entityId, cleanup.requestId, cleanup.confirmationName ?? cleanup.displayName);
      } else {
        await runtime.conversation.purgeArchivedSession(cleanup.entityId, cleanup.requestId);
      }
      forgetPendingCleanup(cleanup.requestId);
      notifications.success("受管隔离区已清理完成");
    } catch (reason) {
      const decoded = decodeLifecycleRuntimeError(reason);
      notifications.error(decoded?.kind === "cleanup_failed" ? "隔离区仍未清理完成，可稍后使用同一操作重试" : errorMessage(reason));
    } finally {
      setRetryingCleanupId(null);
    }
  };

  const refreshAll = () => {
    projects.refresh();
    sessions.refresh();
  };

  const loadMore = () => {
    if (projects.hasMore) projects.loadMore();
    if (sessions.hasMore) sessions.loadMore();
  };

  const loading = projects.loading || sessions.loading;
  const loadingMore = projects.loadingMore || sessions.loadingMore;
  const hasMore = projects.hasMore || sessions.hasMore;

  return (
    <main className={styles.page} data-settings-page data-testid="archive-management-page">
      <header className={styles.header} data-settings-header>
        <div><h1>归档管理</h1><p>所有已归档会话按项目归组；可在项目行管理项目状态，也可单独恢复或彻底删除会话。</p></div>
      </header>
      <div className={styles.toolbar}>
        <ProjectMultiSelect options={knownProjectOptions} selectedIds={selectedProjectIds} onChange={setSelectedProjectIds} />
        <div className={styles.search} role="search"><Search size={15} aria-hidden="true" /><input ref={catalogSearchRef} aria-label="搜索归档会话" placeholder="搜索已归档会话" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <button className={styles.iconButton} data-settings-icon-button aria-label="刷新归档列表" disabled={loading} type="button" onClick={refreshAll}><RefreshCw size={15} /></button>
      </div>
      {pendingCleanups.map((cleanup) => <div className={styles.notice} role="status" key={cleanup.requestId}><span>{cleanup.displayName} 的 Keydex 数据已删除，但隔离区清理尚未完成{cleanup.operationId ? `（操作 ${cleanup.operationId}）` : ""}。</span><button className={styles.secondaryButton} disabled={Boolean(retryingCleanupId)} type="button" onClick={() => void retryPendingCleanup(cleanup)}>{retryingCleanupId === cleanup.requestId ? "正在重试清理" : "重试清理"}</button></div>)}
      {continueSessionRestore ? <div className={styles.notice} role="status"><span>项目已恢复，该会话仍处于归档状态。</span><button autoFocus className={styles.secondaryButton} type="button" onClick={() => void runSessionRestore(continueSessionRestore).catch((reason) => notifications.error(errorMessage(reason)))}>继续恢复该会话</button></div> : null}
      <section aria-busy={loading} aria-label="已归档会话（按项目分组）" className={`${styles.list} ${styles.archiveGroupList}`}>
        <div className={styles.listHeader}><strong>已归档会话</strong><span>{groups.length} 个分组 · 已加载 {sessions.items.length} 个会话</span></div>
        {loading && groups.length === 0 ? <div className={styles.state}>正在加载归档内容…</div> : null}
        {projects.error ? <div className={styles.error} role="alert"><span>项目归档信息：{projects.error}</span><button type="button" onClick={projects.refresh}>重试</button></div> : null}
        {sessions.error ? <div className={styles.error} role="alert"><span>归档会话：{sessions.error}</span><button type="button" onClick={sessions.refresh}>重试</button></div> : null}
        {!loading && !projects.error && !sessions.error && groups.length === 0 ? <div className={styles.state}>{query || selectedProjectIds.size > 0 ? "没有匹配的归档内容" : "暂无归档内容"}</div> : null}
        {groups.map((group) => {
          const archivedProject = archivedProjectForGroup(group);
          const countsConsistent = !archivedProject || archivedProject.session_total === archivedProject.manual_session_count + archivedProject.project_session_count;
          const groupName = group.workspace?.name ?? "无项目会话";
          const archivedSessionCount = archivedProject?.session_total ?? group.sessions.length;
          return (
            <section className={styles.archiveGroup} aria-label={`归档分组 ${groupName}`} key={group.key}>
              <header className={styles.archiveGroupHeader}>
                <span className={styles.archiveGroupIcon}><Folder size={16} aria-hidden="true" /></span>
                <div className={styles.archiveGroupMain}>
                  <strong title={groupName}>{groupName}</strong>
                  <span>
                    {archivedProject
                      ? `项目已归档 · 随项目 ${archivedProject.project_session_count} · 手动 ${archivedProject.manual_session_count} · ${formatTime(archivedProject.archived_at)}`
                      : group.workspace
                        ? "项目仍在使用"
                        : "无所属项目"}
                  </span>
                  {!countsConsistent ? <span className={styles.inlineError} role="alert">归档计数暂不一致，请刷新后再操作</span> : null}
                </div>
                <div className={styles.archiveGroupAside}>
                  <span className={styles.archiveGroupCount}>{archivedSessionCount} 个会话</span>
                  <div className={styles.groupActions}>
                    {group.workspace && archivedSessionCount > 0 ? (
                      <button className={styles.dangerButton} disabled={!countsConsistent} type="button" onClick={() => setPurgeTarget({ type: "workspace_sessions", item: { id: group.workspace!.id, name: group.workspace!.name } })}><Trash2 size={14} />彻底删除项目下全部归档会话</button>
                    ) : null}
                    {archivedProject ? (
                      <>
                        <button disabled={!countsConsistent} type="button" onClick={() => setRestoreProject(archivedProject)}><RotateCcw size={14} />恢复项目</button>
                        <button className={styles.dangerButton} disabled={!countsConsistent} type="button" onClick={() => setPurgeTarget({ type: "workspace", item: archivedProject })}><Trash2 size={14} />彻底删除项目</button>
                      </>
                    ) : group.workspace ? (
                      <button type="button" onClick={() => { setArchiveTarget({ id: group.workspace!.id, name: group.workspace!.name }); setArchiveBlocker(null); }}><Archive size={14} />归档项目</button>
                    ) : null}
                  </div>
                </div>
              </header>
              <div className={styles.archiveSessionList}>
                {group.sessions.length === 0 ? <div className={styles.groupEmpty}>该项目没有归档会话</div> : group.sessions.map((session) => (
                  <article className={styles.archiveSessionRow} data-archive-id={session.id} key={session.id}>
                    <div className={styles.rowMain}><strong title={session.title || "未命名会话"}>{session.title || "未命名会话"}</strong><span><span className={styles.badge}>{session.archive_origin === "manual" ? "手动归档" : "随项目归档"}</span></span></div>
                    <time className={styles.time} dateTime={session.archived_at}>{formatTime(session.archived_at)}</time>
                    <div className={styles.actions}><button type="button" onClick={() => void runSessionRestore(session).catch((reason) => notifications.error(errorMessage(reason)))}><RotateCcw size={14} />恢复</button><button className={styles.dangerButton} type="button" onClick={() => setPurgeTarget({ type: "session", item: session })}><Trash2 size={14} />彻底删除</button></div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </section>
      {hasMore ? <button className={styles.loadMore} disabled={loadingMore} type="button" onClick={loadMore}>{loadingMore ? "正在加载" : "加载更多归档内容"}</button> : null}

      {archiveTarget ? <ConfirmDialog title={archiveBlocker ? "停止会话并归档项目？" : "归档项目？"} description={archiveBlocker ? "项目中仍有运行、等待、审批、排队输入或任务。确认后会先停止这些活动，再归档项目及其中的会话。" : "项目及其中的活动会话将移入当前归档列表；手动归档的会话保持原状态，本地文件不会被删除。"} preview={archiveBlocker ? `${archiveTarget.name} · 受影响活动 ${blockerCount(archiveBlocker)} 项` : archiveTarget.name} confirmLabel={archiveBlocker ? "停止会话并归档项目" : "归档项目"} cancelDisabled={archivingProjectId === archiveTarget.id} confirmDisabled={archivingProjectId === archiveTarget.id} onCancel={() => { setArchiveTarget(null); setArchiveBlocker(null); }} onConfirm={() => void runProjectArchive(Boolean(archiveBlocker))} /> : null}
      {restoreProject && !sessionConflictProject ? <ProjectRestoreDialog project={restoreProject} onCancel={() => setRestoreProject(null)} onRestore={(mode) => runProjectRestore(restoreProject, mode)} /> : null}
      {sessionConflictProject && !restoreProject ? <ConfirmDialog title="当前所属项目已归档" description="恢复该会话前，需要先恢复所属项目。项目恢复时可选择仅恢复项目，或同时恢复随项目归档的会话。" preview={sessionConflictProject.name} confirmLabel="去恢复项目" onCancel={() => { setSessionConflictProject(null); setRestoreSession(null); }} onConfirm={() => setRestoreProject(sessionConflictProject)} /> : null}
      {restoreProject && sessionConflictProject?.id === restoreProject.id ? <ProjectRestoreDialog project={restoreProject} onCancel={() => { setRestoreProject(null); setSessionConflictProject(null); }} onRestore={restoreConflictProject} /> : null}
      {purgeTarget ? <PurgeDialog target={purgeTarget} onCancel={() => setPurgeTarget(null)} onDatabasePurged={() => { if (purgeTarget.type === "workspace") { projects.remove(purgeTarget.item.id); sessions.removeWhere((item) => item.workspace?.id === purgeTarget.item.id); } else if (purgeTarget.type === "workspace_sessions") { sessions.removeWhere((item) => item.workspace?.id === purgeTarget.item.id); projects.mutate((items) => clearArchivedSessionCounts(items, purgeTarget.item.id)); } else sessions.remove(purgeTarget.item.id); focusCatalogAnchor(); }} onCleanupPending={rememberPendingCleanup} onCleanupCompleted={forgetPendingCleanup} onPurge={(requestId, confirmationName) => purgeTarget.type === "workspace" ? runtime.workspaces.purgeArchived(purgeTarget.item.id, requestId, confirmationName ?? "") : purgeTarget.type === "workspace_sessions" ? runtime.workspaces.purgeArchivedSessions(purgeTarget.item.id, requestId, confirmationName ?? "") : runtime.conversation.purgeArchivedSession(purgeTarget.item.id, requestId)} /> : null}
    </main>
  );
}

function ProjectMultiSelect({
  options,
  selectedIds,
  onChange,
}: {
  options: ProjectFilterOption[];
  selectedIds: ReadonlySet<string>;
  onChange: (ids: Set<string>) => void;
}) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const selectedOptions = options.filter((option) => selectedIds.has(option.id));
  const summary = selectedOptions.length === 0
    ? "所有项目"
    : selectedOptions.length === 1
      ? selectedOptions[0].name
      : `已选 ${selectedOptions.length} 个项目`;

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const openMenu = () => {
    clearCloseTimer();
    setClosing(false);
    setOpen(true);
  };

  const closeMenu = () => {
    if (!open && !closing) return;
    clearCloseTimer();
    setOpen(false);
    if (prefersReducedMotion()) {
      setClosing(false);
      return;
    }
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      setClosing(false);
      closeTimerRef.current = null;
    }, PROJECT_FILTER_EXIT_ANIMATION_MS);
  };

  useEffect(() => {
    if (!open) return undefined;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => () => clearCloseTimer(), []);

  const toggle = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  const menuVisible = open || closing;

  return (
    <div className={styles.projectFilter} ref={rootRef}>
      <button
        aria-controls={menuVisible ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`筛选项目：${summary}`}
        className={styles.projectFilterTrigger}
        onClick={() => open ? closeMenu() : openMenu()}
        type="button"
      >
        <span>{summary}</span>
        <ChevronDown data-open={open ? "true" : "false"} size={15} strokeWidth={1.9} aria-hidden="true" />
      </button>
      {menuVisible ? (
        <FloatingLayer
          alignment="start"
          anchorRef={rootRef}
          aria-hidden={closing ? "true" : undefined}
          className={styles.projectFilterMenu}
          data-state={closing ? "closing" : "open"}
          floatingRef={menuRef}
          matchAnchorWidth
        >
          <div className={styles.projectFilterMenuHeader}>
            <span>选择项目</span>
            {selectedIds.size > 0 ? <button type="button" onClick={() => onChange(new Set())}>清空</button> : null}
          </div>
          <div aria-label="项目筛选选项" aria-multiselectable="true" className={styles.projectFilterOptions} id={menuId} role="listbox">
            {options.length === 0 ? <div className={styles.projectFilterEmpty}>暂无可筛选项目</div> : options.map((option) => {
              const selected = selectedIds.has(option.id);
              return (
                <button
                  aria-selected={selected}
                  className={styles.projectFilterOption}
                  key={option.id}
                  onClick={() => toggle(option.id)}
                  role="option"
                  type="button"
                >
                  <span title={option.name}>{option.name}</span>
                  <span className={styles.projectFilterCheck}>{selected ? <Check size={14} strokeWidth={1.9} aria-hidden="true" /> : null}</span>
                </button>
              );
            })}
          </div>
        </FloatingLayer>
      ) : null}
    </div>
  );
}

function useArchiveCatalog<T extends { id: string }>({ query, load }: { query: string; load: (options: { query?: string; cursor?: string | null; limit?: number; signal?: AbortSignal }) => Promise<ArchiveCatalogPage<T>> }) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const excludedIds = useRef(new Set<string>());

  const fetchPage = useCallback(async (append: boolean) => {
    const currentRevision = ++revision.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    append ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      const page = await load({ query, cursor: append ? cursor : null, limit: 200, signal: controller.signal });
      if (currentRevision !== revision.current) return;
      const visibleItems = page.items.filter((item) => !excludedIds.current.has(item.id));
      setItems((current) => uniqueById(append ? [...current, ...visibleItems] : visibleItems));
      setCursor(page.next_cursor);
      setHasMore(page.has_more);
    } catch (reason) {
      if (currentRevision === revision.current && !controller.signal.aborted) setError(errorMessage(reason));
    } finally {
      if (currentRevision === revision.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [cursor, load, query]);

  useEffect(() => {
    void fetchPage(false);
    return () => { revision.current += 1; activeController.current?.abort(); };
  }, [load, query]);

  const remove = useCallback((id: string) => { excludedIds.current.add(id); setItems((current) => current.filter((item) => item.id !== id)); }, []);
  const include = useCallback((id: string) => { excludedIds.current.delete(id); }, []);
  const mutate = useCallback((updater: (items: T[]) => T[]) => setItems((current) => updater(current)), []);
  const removeWhere = useCallback((predicate: (item: T) => boolean) => setItems((current) => current.filter((item) => { if (!predicate(item)) return true; excludedIds.current.add(item.id); return false; })), []);
  const refresh = useCallback(() => { excludedIds.current.clear(); void fetchPage(false); }, [fetchPage]);
  const loadMore = useCallback(() => { void fetchPage(true); }, [fetchPage]);
  return { items, hasMore, loading, loadingMore, error, refresh, loadMore, remove, include, mutate, removeWhere };
}

function buildArchiveGroups(projects: ArchivedWorkspaceItem[], sessions: ArchivedSessionItem[]): ArchiveGroup[] {
  const groups = new Map<string, ArchiveGroup>();
  for (const project of projects) {
    groups.set(`workspace:${project.id}`, {
      key: `workspace:${project.id}`,
      workspace: { id: project.id, name: project.name, archived_at: project.archived_at },
      project,
      sessions: [],
      latestArchivedAt: project.archived_at,
    });
  }
  for (const session of sessions) {
    const key = session.workspace ? `workspace:${session.workspace.id}` : "workspace:none";
    const existing = groups.get(key) ?? {
      key,
      workspace: session.workspace,
      project: null,
      sessions: [],
      latestArchivedAt: session.archived_at,
    };
    existing.workspace = existing.workspace ?? session.workspace;
    existing.sessions.push(session);
    existing.latestArchivedAt = maxTime(existing.latestArchivedAt, session.archived_at);
    groups.set(key, existing);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, sessions: uniqueById(group.sessions).sort((left, right) => right.archived_at.localeCompare(left.archived_at)) }))
    .sort((left, right) => right.latestArchivedAt.localeCompare(left.latestArchivedAt));
}

function archivedProjectForGroup(group: ArchiveGroup): ArchivedWorkspaceItem | null {
  if (group.project) return group.project;
  if (!group.workspace?.archived_at) return null;
  return synthesizeArchivedProject(group.workspace.id, group.workspace.name, group.workspace.archived_at, group.sessions);
}

function synthesizeArchivedProject(workspaceId: string, name: string, archivedAt: string, sessions: ArchivedSessionItem[]): ArchivedWorkspaceItem {
  const related = sessions.filter((session) => session.workspace?.id === workspaceId);
  const manualCount = related.filter((session) => session.archive_origin === "manual").length;
  const projectCount = related.filter((session) => session.archive_origin === "project").length;
  return {
    id: workspaceId,
    name,
    archived_at: archivedAt,
    session_total: related.length,
    manual_session_count: manualCount,
    project_session_count: projectCount,
    can_restore_project_only: true,
    can_restore_with_project_sessions: projectCount > 0,
  };
}

function applyWorkspaceRestore(items: ArchivedSessionItem[], workspaceId: string, mode?: WorkspaceRestoreMode): ArchivedSessionItem[] {
  return items
    .filter((session) => !(session.workspace?.id === workspaceId && mode === "with_project_sessions" && session.archive_origin === "project"))
    .map((session) => session.workspace?.id === workspaceId
      ? { ...session, workspace: { ...session.workspace, archived_at: null } }
      : session);
}

function clearArchivedSessionCounts(items: ArchivedWorkspaceItem[], workspaceId: string): ArchivedWorkspaceItem[] {
  return items.map((project) => project.id === workspaceId
    ? {
        ...project,
        session_total: 0,
        manual_session_count: 0,
        project_session_count: 0,
        can_restore_with_project_sessions: false,
      }
    : project);
}

function uniqueById<T extends { id: string }>(items: T[]): T[] { const seen = new Set<string>(); return items.filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id))); }
function sameProjectOptions(left: ProjectFilterOption[], right: ProjectFilterOption[]): boolean { return left.length === right.length && left.every((item, index) => item.id === right[index]?.id && item.name === right[index]?.name); }
function mergeProjectOptions(current: ProjectFilterOption[], discovered: ProjectFilterOption[]): ProjectFilterOption[] { const byId = new Map(current.map((item) => [item.id, item])); discovered.forEach((item) => byId.set(item.id, item)); const next = [...byId.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN")); return sameProjectOptions(current, next) ? current : next; }
function maxTime(left: string, right: string): string { return left.localeCompare(right) >= 0 ? left : right; }
function blockerCount(error: LifecycleRuntimeError): number { return typeof error.details.blocker_count === "number" ? error.details.blocker_count : 1; }
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
function errorMessage(reason: unknown): string { return reason instanceof Error && reason.message ? reason.message : "操作失败"; }
function prefersReducedMotion(): boolean { return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }

function readPendingCleanups(): PendingPurgeCleanup[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(PENDING_CLEANUPS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter(isPendingCleanup) : [];
  } catch {
    return [];
  }
}

function writePendingCleanups(items: PendingPurgeCleanup[]): void {
  if (typeof window === "undefined") return;
  if (items.length === 0) window.localStorage.removeItem(PENDING_CLEANUPS_KEY);
  else window.localStorage.setItem(PENDING_CLEANUPS_KEY, JSON.stringify(items));
}

function isPendingCleanup(value: unknown): value is PendingPurgeCleanup {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PendingPurgeCleanup>;
  return typeof item.requestId === "string" && typeof item.entityId === "string" && typeof item.displayName === "string" && (item.targetType === "workspace" || item.targetType === "workspace_sessions" || item.targetType === "session");
}
