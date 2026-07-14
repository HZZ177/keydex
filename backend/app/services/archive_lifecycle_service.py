from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

from backend.app.core.time import to_iso_z, utc_now
from backend.app.storage import LifecycleOperationRecord, SessionRecord, StorageRepositories


class ArchiveLifecycleError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


@dataclass(frozen=True)
class ArchivePreflight:
    session_ids: list[str]
    blockers: list[dict[str, Any]]

    @property
    def blocker_count(self) -> int:
        return sum(int(item["count"]) for item in self.blockers)

    @property
    def ready_to_archive(self) -> bool:
        return self.blocker_count == 0


@dataclass(frozen=True)
class ArchiveStopResult:
    stopped_session_ids: list[str]
    failed_session_ids: list[str]

    @property
    def ready_to_archive(self) -> bool:
        return not self.failed_session_ids


class ArchiveLifecycleService:
    """Explicit archive, restore and catalog orchestration.

    The service owns request replay and entity locking. It returns domain payloads;
    HTTP status mapping and event publication stay at their respective boundaries.
    """

    _LOCK_ORDER = {"workspace": 0, "session": 1}

    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        stop_session_hook: Callable[[str], bool | None] | None = None,
    ) -> None:
        self._repositories = repositories
        self._operations = repositories.lifecycle_operations
        self._workspaces = repositories.workspaces
        self._sessions = repositories.sessions
        self._stop_session_hook = stop_session_hook

    def preflight_sessions(self, session_ids: Iterable[str]) -> ArchivePreflight:
        normalized = sorted({str(session_id).strip() for session_id in session_ids if str(session_id).strip()})
        if not normalized:
            return ArchivePreflight(session_ids=[], blockers=[])
        placeholders = ", ".join("?" for _ in normalized)
        statements = [
            (
                "session_running",
                f"select id as session_id, count(*) as item_count from sessions "
                f"where id in ({placeholders}) and archived_at is null and status = 'running' group by id",
            ),
            (
                "command_approval",
                f"select session_id, count(*) as item_count from command_approval_requests "
                f"where session_id in ({placeholders}) and status = 'pending' and is_deleted = 0 "
                "group by session_id",
            ),
            (
                "a2ui_input",
                f"select session_id, count(*) as item_count from a2ui_interactions "
                f"where session_id in ({placeholders}) and status = 'waiting_user_input' "
                "and is_deleted = 0 group by session_id",
            ),
            (
                "pending_input",
                f"select session_id, count(*) as item_count from session_pending_inputs "
                f"where session_id in ({placeholders}) and status in "
                "('pending_steer', 'queued', 'starting', 'running') and is_deleted = 0 "
                "group by session_id",
            ),
            (
                "thread_task",
                f"select session_id, count(*) as item_count from thread_tasks "
                f"where session_id in ({placeholders}) and status in ('active', 'paused', 'blocked') "
                "and deleted_at is null group by session_id",
            ),
            (
                "thread_task_run",
                f"select session_id, count(*) as item_count from thread_task_runs "
                f"where session_id in ({placeholders}) and status = 'running' group by session_id",
            ),
        ]
        blockers: list[dict[str, Any]] = []
        with self._repositories.db.connect() as conn:
            for blocker_type, statement in statements:
                for row in conn.execute(statement, normalized).fetchall():
                    blockers.append(
                        {
                            "type": blocker_type,
                            "session_id": row["session_id"],
                            "count": int(row["item_count"]),
                        }
                    )
        blockers.sort(key=lambda item: (item["session_id"], item["type"]))
        return ArchivePreflight(session_ids=normalized, blockers=blockers)

    def stop_sessions_for_archive(self, session_ids: Iterable[str]) -> ArchiveStopResult:
        normalized = sorted({str(session_id).strip() for session_id in session_ids if str(session_id).strip()})
        stopped: list[str] = []
        failed: list[str] = []
        for session_id in normalized:
            try:
                hook_result = self._stop_session_hook(session_id) if self._stop_session_hook else True
            except Exception:
                hook_result = False
            if hook_result is False:
                failed.append(session_id)
            else:
                stopped.append(session_id)
        if stopped:
            placeholders = ", ".join("?" for _ in stopped)
            now = to_iso_z(utc_now())
            with self._repositories.db.transaction(immediate=True) as conn:
                conn.execute(
                    f"update sessions set status = 'closed' "
                    f"where id in ({placeholders}) and archived_at is null and status = 'running'",
                    stopped,
                )
                conn.execute(
                    f"""
                    update command_approval_requests
                    set status = 'cancelled', decision = 'rejected',
                        reject_message = coalesce(reject_message, '会话归档前已停止'),
                        resolved_at = ?, updated_at = ?
                    where session_id in ({placeholders})
                      and status = 'pending' and is_deleted = 0
                    """,
                    [now, now, *stopped],
                )
                conn.execute(
                    f"""
                    update a2ui_interactions
                    set status = 'cancelled', cancel_request_id = 'archive-stop',
                        cancel_reason = 'session_archived', cancelled_at = ?, updated_at = ?
                    where session_id in ({placeholders})
                      and status = 'waiting_user_input' and is_deleted = 0
                    """,
                    [now, now, *stopped],
                )
                conn.execute(
                    f"""
                    update session_pending_inputs
                    set status = 'cancelled', error_code = 'session_archived',
                        error_message = '会话归档前已停止', cancelled_at = ?,
                        lock_owner = null, lock_expires_at = null, updated_at = ?
                    where session_id in ({placeholders})
                      and status in ('pending_steer', 'queued', 'starting', 'running')
                      and is_deleted = 0
                    """,
                    [now, now, *stopped],
                )
                conn.execute(
                    f"""
                    update thread_task_runs
                    set status = 'cancelled', finished_at = ?, updated_at = ?
                    where session_id in ({placeholders}) and status = 'running'
                    """,
                    [now, now, *stopped],
                )
                conn.execute(
                    f"""
                    update thread_tasks
                    set status = 'cancelled', system_stop_reason = 'session_archived',
                        current_run_id = null, updated_at = ?
                    where session_id in ({placeholders})
                      and status in ('active', 'paused', 'blocked') and deleted_at is null
                    """,
                    [now, *stopped],
                )
        return ArchiveStopResult(stopped_session_ids=stopped, failed_session_ids=failed)

    def archive_session(
        self,
        session_id: str,
        *,
        request_id: str,
        stop_if_active: bool = False,
    ) -> dict[str, Any]:
        operation, replay = self._begin_operation(
            request_id=request_id,
            entity_type="session",
            entity_id=session_id,
            action="archive",
            payload={"stop_if_active": bool(stop_if_active)},
        )
        if replay is not None:
            return replay
        initial = self._sessions.get(session_id) or self._sessions.get_archived(session_id)
        scopes = [("session", session_id)]
        if initial is not None and initial.workspace_id:
            scopes.append(("workspace", initial.workspace_id))
        self._acquire_scopes(operation, scopes)
        try:
            record = self._sessions.get(session_id)
            archived = self._sessions.get_archived(session_id)
            if record is None and archived is None:
                self._fail(operation.id, "not_found")
                raise ArchiveLifecycleError("not_found", "会话不存在", {"session_id": session_id})
            if archived is not None:
                return self._complete_session_archive(operation, archived, changed=False)
            assert record is not None
            if record.workspace_id:
                archived_workspace = self._workspaces.get_archived(record.workspace_id)
                if archived_workspace is not None:
                    self._fail(operation.id, "workspace_archived")
                    raise self._workspace_archived_error(archived_workspace)
            preflight = self.preflight_sessions([session_id])
            if not preflight.ready_to_archive and not stop_if_active:
                self._fail(
                    operation.id,
                    "archive_requires_stop_confirmation",
                    state="blocked",
                    counts={"blockers": preflight.blocker_count},
                )
                raise ArchiveLifecycleError(
                    "archive_requires_stop_confirmation",
                    "会话仍在运行或等待处理，确认停止后才能归档",
                    {"blockers": preflight.blockers, "blocker_count": preflight.blocker_count},
                )
            if not preflight.ready_to_archive:
                stopped = self.stop_sessions_for_archive([session_id])
                if not stopped.ready_to_archive:
                    self._fail(operation.id, "archive_stop_failed")
                    raise ArchiveLifecycleError(
                        "archive_stop_failed",
                        "会话停止失败，未执行归档",
                        {"failed_count": len(stopped.failed_session_ids)},
                    )
            mutation = self._sessions.archive_manual(
                session_id,
                archived_at=to_iso_z(utc_now()),
            )
            if mutation.record is None:
                self._fail(operation.id, "not_found")
                raise ArchiveLifecycleError("not_found", "会话不存在", {"session_id": session_id})
            return self._complete_session_archive(
                operation,
                mutation.record,
                changed=mutation.changed,
            )
        finally:
            self._operations.release_locks(operation.id)

    def archive_workspace(
        self,
        workspace_id: str,
        *,
        request_id: str,
        stop_active_sessions: bool = False,
    ) -> dict[str, Any]:
        operation, replay = self._begin_operation(
            request_id=request_id,
            entity_type="workspace",
            entity_id=workspace_id,
            action="archive",
            payload={"stop_active_sessions": bool(stop_active_sessions)},
        )
        if replay is not None:
            return replay
        self._acquire_scopes(operation, [("workspace", workspace_id)])
        try:
            active = self._workspaces.get(workspace_id)
            archived = self._workspaces.get_archived(workspace_id)
            if active is None and archived is None:
                self._fail(operation.id, "not_found")
                raise ArchiveLifecycleError("not_found", "项目不存在", {"workspace_id": workspace_id})
            if archived is not None:
                result = {
                    "operation_id": operation.id,
                    "request_id": request_id,
                    "workspace_id": workspace_id,
                    "changed": False,
                    "archived_at": archived.archived_at,
                    "newly_archived": 0,
                    "manual_preserved": 0,
                    "project_preserved": 0,
                    "event": None,
                }
                return self._complete(operation, result)
            session_ids = self._active_workspace_session_ids(workspace_id)
            preflight = self.preflight_sessions(session_ids)
            if not preflight.ready_to_archive and not stop_active_sessions:
                self._fail(
                    operation.id,
                    "archive_requires_stop_confirmation",
                    state="blocked",
                    counts={"blockers": preflight.blocker_count},
                )
                raise ArchiveLifecycleError(
                    "archive_requires_stop_confirmation",
                    "项目中仍有会话在运行或等待处理，确认停止后才能归档",
                    {"blockers": preflight.blockers, "blocker_count": preflight.blocker_count},
                )
            if not preflight.ready_to_archive:
                blocker_session_ids = sorted({item["session_id"] for item in preflight.blockers})
                stopped = self.stop_sessions_for_archive(blocker_session_ids)
                if not stopped.ready_to_archive:
                    self._fail(operation.id, "archive_stop_failed")
                    raise ArchiveLifecycleError(
                        "archive_stop_failed",
                        "部分项目会话停止失败，项目未归档",
                        {
                            "stopped_count": len(stopped.stopped_session_ids),
                            "failed_count": len(stopped.failed_session_ids),
                        },
                    )
            mutation = self._workspaces.archive_project(
                workspace_id,
                archived_at=to_iso_z(utc_now()),
            )
            if mutation.record is None:
                self._fail(operation.id, "not_found")
                raise ArchiveLifecycleError("not_found", "项目不存在", {"workspace_id": workspace_id})
            result = {
                "operation_id": operation.id,
                "request_id": request_id,
                "workspace_id": workspace_id,
                "changed": mutation.changed,
                "archived_at": mutation.record.archived_at,
                "newly_archived": mutation.newly_archived,
                "manual_preserved": mutation.manual_preserved,
                "project_preserved": mutation.project_preserved,
                "event": (
                    {
                        "type": "workspace_archived",
                        "workspace_id": workspace_id,
                        "archived_at": mutation.record.archived_at,
                        "newly_archived": mutation.newly_archived,
                    }
                    if mutation.changed
                    else None
                ),
            }
            return self._complete(operation, result)
        finally:
            self._operations.release_locks(operation.id)

    def restore_session(self, session_id: str, *, request_id: str) -> dict[str, Any]:
        operation, replay = self._begin_operation(
            request_id=request_id,
            entity_type="session",
            entity_id=session_id,
            action="restore",
            payload={},
        )
        if replay is not None:
            return replay
        initial = self._sessions.get(session_id) or self._sessions.get_archived(session_id)
        scopes = [("session", session_id)]
        if initial is not None and initial.workspace_id:
            scopes.append(("workspace", initial.workspace_id))
        self._acquire_scopes(operation, scopes)
        try:
            active = self._sessions.get(session_id)
            archived = self._sessions.get_archived(session_id)
            if active is None and archived is None:
                self._fail(operation.id, "not_found")
                raise ArchiveLifecycleError("not_found", "会话不存在", {"session_id": session_id})
            if active is not None:
                return self._complete_session_restore(operation, active, changed=False)
            assert archived is not None
            if archived.workspace_id:
                archived_workspace = self._workspaces.get_archived(archived.workspace_id)
                if archived_workspace is not None:
                    self._fail(operation.id, "workspace_archived", state="blocked")
                    raise self._workspace_archived_error(archived_workspace)
            mutation = self._sessions.restore(session_id)
            if mutation.record is None:
                self._fail(operation.id, "not_found")
                raise ArchiveLifecycleError("not_found", "会话不存在", {"session_id": session_id})
            return self._complete_session_restore(
                operation,
                mutation.record,
                changed=mutation.changed,
            )
        finally:
            self._operations.release_locks(operation.id)

    def restore_workspace(
        self,
        workspace_id: str,
        *,
        request_id: str,
        mode: str,
    ) -> dict[str, Any]:
        if mode not in {"project_only", "with_project_sessions"}:
            raise ArchiveLifecycleError(
                "restore_mode_invalid",
                "项目恢复模式无效",
                {"allowed_modes": ["project_only", "with_project_sessions"]},
            )
        operation, replay = self._begin_operation(
            request_id=request_id,
            entity_type="workspace",
            entity_id=workspace_id,
            action="restore",
            payload={"mode": mode},
        )
        if replay is not None:
            return replay
        self._acquire_scopes(operation, [("workspace", workspace_id)])
        try:
            active = self._workspaces.get(workspace_id)
            archived = self._workspaces.get_archived(workspace_id)
            if active is None and archived is None:
                self._fail(operation.id, "not_found")
                raise ArchiveLifecycleError("not_found", "项目不存在", {"workspace_id": workspace_id})
            if mode == "project_only":
                mutation = self._workspaces.restore_project_only(workspace_id)
            else:
                mutation = self._workspaces.restore_with_project_sessions(workspace_id)
            if mutation.record is None:
                self._fail(operation.id, "not_found")
                raise ArchiveLifecycleError("not_found", "项目不存在", {"workspace_id": workspace_id})
            counts = self._workspace_archive_origin_counts(workspace_id)
            result = {
                "operation_id": operation.id,
                "request_id": request_id,
                "workspace_id": workspace_id,
                "mode": mode,
                "changed": mutation.changed,
                "restored_project_sessions": mutation.restored_sessions,
                "remaining_manual": counts["manual"],
                "remaining_project": counts["project"],
                "remaining_total": counts["manual"] + counts["project"],
                "event": (
                    {
                        "type": "workspace_restored",
                        "workspace_id": workspace_id,
                        "mode": mode,
                        "restored_project_sessions": mutation.restored_sessions,
                    }
                    if mutation.changed
                    else None
                ),
            }
            return self._complete(operation, result)
        finally:
            self._operations.release_locks(operation.id)

    def list_archived_workspaces(
        self,
        *,
        query: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        page = self._workspaces.list_archived(query=query, cursor=cursor, limit=limit)
        return {
            "list": [
                {
                    "id": item.workspace.id,
                    "name": item.workspace.name,
                    "archived_at": item.workspace.archived_at,
                    "session_total": item.session_total,
                    "manual_session_count": item.manual_session_count,
                    "project_session_count": item.project_session_count,
                    "can_restore_project_only": True,
                    "can_restore_with_project_sessions": item.project_session_count > 0,
                }
                for item in page.items
            ],
            "next_cursor": page.next_cursor,
            "has_more": page.has_more,
            "total": None,
            "total_kind": "not_computed",
        }

    def list_archived_sessions(
        self,
        *,
        query: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
        workspace_id: str | None = None,
        workspace_ids: list[str] | None = None,
        include_archived_workspace: bool = False,
    ) -> dict[str, Any]:
        page = self._sessions.list_archived(
            query=query,
            cursor=cursor,
            limit=limit,
            workspace_id=workspace_id,
            workspace_ids=workspace_ids,
            exclude_archived_workspaces=not include_archived_workspace,
        )
        return {
            "list": [
                {
                    "id": item.session.id,
                    "title": item.session.title or "未命名会话",
                    "archived_at": item.session.archived_at,
                    "archive_origin": item.session.archive_origin,
                    "pinned_at": item.session.pinned_at,
                    "workspace": (
                        {
                            "id": item.session.workspace_id,
                            "name": item.workspace_name,
                            "archived_at": item.workspace_archived_at,
                        }
                        if item.session.workspace_id and item.workspace_name
                        else None
                    ),
                }
                for item in page.items
            ],
            "next_cursor": page.next_cursor,
            "has_more": page.has_more,
            "total": None,
            "total_kind": "not_computed",
        }

    def _begin_operation(
        self,
        *,
        request_id: str,
        entity_type: str,
        entity_id: str,
        action: str,
        payload: dict[str, Any],
    ) -> tuple[LifecycleOperationRecord, dict[str, Any] | None]:
        try:
            created = self._operations.create_or_replay(
                request_id=request_id,
                entity_type=entity_type,
                entity_id=entity_id,
                action=action,
                payload=payload,
            )
        except ValueError as exc:
            raise ArchiveLifecycleError(
                "request_id_conflict",
                "request_id 已用于不同请求",
                {"request_id": request_id},
            ) from exc
        operation = created.operation
        if not created.created and operation.state == "completed":
            replay = dict(operation.result)
            replay["replayed"] = True
            replay["event"] = None
            return operation, replay
        return operation, None

    def _acquire_scopes(
        self,
        operation: LifecycleOperationRecord,
        scopes: Iterable[tuple[str, str]],
    ) -> None:
        ordered = sorted(
            set(scopes),
            key=lambda scope: (self._LOCK_ORDER[scope[0]], scope[1]),
        )
        for entity_type, entity_id in ordered:
            if not self._operations.acquire_lock(
                operation_id=operation.id,
                entity_type=entity_type,
                entity_id=entity_id,
                ttl_seconds=60,
            ):
                self._operations.release_locks(operation.id)
                raise ArchiveLifecycleError(
                    "lifecycle_locked",
                    "对象正在执行其他归档管理操作，请稍后重试",
                    {"entity_type": entity_type},
                )

    def _complete_session_archive(
        self,
        operation: LifecycleOperationRecord,
        record: SessionRecord,
        *,
        changed: bool,
    ) -> dict[str, Any]:
        result = {
            "operation_id": operation.id,
            "request_id": operation.request_id,
            "session_id": record.id,
            "workspace_id": record.workspace_id,
            "changed": changed,
            "archived_at": record.archived_at,
            "archive_origin": record.archive_origin,
            "event": (
                {
                    "type": "session_archived",
                    "session_id": record.id,
                    "workspace_id": record.workspace_id,
                    "archived_at": record.archived_at,
                    "archive_origin": record.archive_origin,
                }
                if changed
                else None
            ),
        }
        return self._complete(operation, result)

    def _complete_session_restore(
        self,
        operation: LifecycleOperationRecord,
        record: SessionRecord,
        *,
        changed: bool,
    ) -> dict[str, Any]:
        workspace = self._workspaces.get(record.workspace_id) if record.workspace_id else None
        result = {
            "operation_id": operation.id,
            "request_id": operation.request_id,
            "session_id": record.id,
            "workspace_id": record.workspace_id,
            "workspace": (
                {"id": workspace.id, "name": workspace.name} if workspace is not None else None
            ),
            "changed": changed,
            "event": (
                {
                    "type": "session_restored",
                    "session_id": record.id,
                    "workspace_id": record.workspace_id,
                }
                if changed
                else None
            ),
        }
        return self._complete(operation, result)

    def _complete(
        self,
        operation: LifecycleOperationRecord,
        result: dict[str, Any],
    ) -> dict[str, Any]:
        latest = self._operations.get(operation.id)
        if latest is None:
            raise ArchiveLifecycleError("operation_missing", "生命周期操作记录不存在")
        event = result.get("event")
        if isinstance(event, dict):
            event.update(
                {
                    "operation_id": operation.id,
                    "request_id": operation.request_id,
                    "occurred_at": to_iso_z(utc_now()),
                    "revision": latest.revision + 1,
                    "changed": bool(result.get("changed", True)),
                }
            )
        stored = self._operations.update(
            operation.id,
            expected_revision=latest.revision,
            state="completed",
            result=result,
            completed=True,
        )
        if stored is None:
            raise ArchiveLifecycleError("operation_conflict", "生命周期操作状态发生变化")
        return result

    def _fail(
        self,
        operation_id: str,
        code: str,
        *,
        state: str = "failed",
        counts: dict[str, int] | None = None,
    ) -> None:
        latest = self._operations.get(operation_id)
        if latest is None:
            return
        self._operations.update(
            operation_id,
            expected_revision=latest.revision,
            state=state,
            counts=counts,
            error_code=code,
            error_detail={"code": code, "state": state},
        )

    def _active_workspace_session_ids(self, workspace_id: str) -> list[str]:
        with self._repositories.db.connect() as conn:
            rows = conn.execute(
                """
                select id from sessions
                where workspace_id = ? and archived_at is null
                order by id asc
                """,
                (workspace_id,),
            ).fetchall()
        return [str(row["id"]) for row in rows]

    def _workspace_archive_origin_counts(self, workspace_id: str) -> dict[str, int]:
        with self._repositories.db.connect() as conn:
            row = conn.execute(
                """
                select
                  coalesce(sum(case when archive_origin = 'manual' then 1 else 0 end), 0)
                    as manual_count,
                  coalesce(sum(case when archive_origin = 'project' then 1 else 0 end), 0)
                    as project_count
                from sessions
                where workspace_id = ? and archived_at is not null
                """,
                (workspace_id,),
            ).fetchone()
        return {"manual": int(row["manual_count"]), "project": int(row["project_count"])}

    @staticmethod
    def _workspace_archived_error(workspace) -> ArchiveLifecycleError:
        return ArchiveLifecycleError(
            "workspace_archived",
            "当前会话所属项目已归档，请先恢复项目",
            {
                "workspace_id": workspace.id,
                "workspace_name": workspace.name,
                "archived_at": workspace.archived_at,
            },
        )
