from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Any

from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.core.time import to_iso_z, utc_now
from backend.app.services.checkpoint_service import (
    CheckpointService,
    CheckpointServiceError,
    CheckpointSource,
)
from backend.app.storage import MessageEventRecord, SessionRecord, StorageRepositories


class SessionForkServiceError(ValueError):
    def __init__(
        self,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


@dataclass(frozen=True)
class SessionForkResult:
    session: SessionRecord
    source: CheckpointSource


@dataclass(frozen=True)
class SessionReverseSource:
    session_id: str
    active_session_id: str
    checkpoint_id: str | None
    checkpoint_ns: str
    trace_id: str
    turn_index: int
    message_event_id: str | None = None
    source_type: str = "message_event"

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "active_session_id": self.active_session_id,
            "checkpoint_id": self.checkpoint_id,
            "checkpoint_ns": self.checkpoint_ns,
            "trace_id": self.trace_id,
            "turn_index": self.turn_index,
            "message_event_id": self.message_event_id,
            "source_type": self.source_type,
        }


@dataclass(frozen=True)
class SessionReverseResult:
    session: SessionRecord
    source: SessionReverseSource
    restored_input: str | None = None
    restored_attachments: tuple[dict[str, Any], ...] = ()


class SessionForkService:
    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        checkpointer: SQLiteCheckpointSaver | None = None,
        checkpoint_service: CheckpointService | None = None,
    ) -> None:
        self.repositories = repositories
        self.checkpointer = checkpointer or SQLiteCheckpointSaver(repositories.db)
        self.checkpoint_service = checkpoint_service or CheckpointService(
            repositories,
            checkpointer=self.checkpointer,
        )

    def fork_session(
        self,
        *,
        session_id: str,
        user_id: str,
        title: str | None = None,
        session_tag: str | None = None,
        checkpoint_id: str | None = None,
        checkpoint_ns: str | None = None,
        trace_id: str | None = None,
        message_event_id: str | None = None,
        turn_index: int | None = None,
    ) -> SessionForkResult:
        source_session = self._require_session(session_id)
        checkpoint_only = self._is_checkpoint_only_fork(session_tag)
        try:
            source = (
                self.checkpoint_service.resolve_latest_checkpoint(session_id=session_id)
                if checkpoint_only
                else self.checkpoint_service.resolve_source(
                    session_id=session_id,
                    checkpoint_id=checkpoint_id,
                    checkpoint_ns=checkpoint_ns,
                    trace_id=trace_id,
                    message_event_id=message_event_id,
                    turn_index=turn_index,
                )
            )
        except CheckpointServiceError as exc:
            raise SessionForkServiceError(exc.code, exc.message, exc.details) from exc

        if not checkpoint_only:
            self._validate_fork_source(source_session=source_session, source=source)
        target_session_id = new_id()
        try:
            self.checkpointer.clone_checkpoint_to_thread(
                source_thread_id=source.active_session_id,
                target_thread_id=target_session_id,
                checkpoint_id=source.checkpoint_id,
                checkpoint_ns=source.checkpoint_ns,
            )
            target = self.repositories.sessions.create(
                session_id=target_session_id,
                user_id=user_id or source_session.user_id,
                scene_id=source_session.scene_id,
                title=self._fork_title(source_session, title),
                status="active",
                session_tag=self._fork_session_tag(source_session, session_tag),
                scene_version_seq=source_session.scene_version_seq,
                active_session_id=target_session_id,
                workspace_id=source_session.workspace_id,
                session_type=source_session.session_type,
                cwd=source_session.cwd,
                workspace_roots=source_session.workspace_roots,
                current_model_provider_id=source_session.current_model_provider_id,
                current_model=source_session.current_model,
                context_compression_epoch=source_session.context_compression_epoch,
                title_source="manual",
            )
            if checkpoint_only:
                logger.info(
                    "[SessionForkService] 创建 checkpoint-only session 分支 | "
                    f"source_session_id={source_session.id} | target_session_id={target.id} | "
                    f"checkpoint_id={source.checkpoint_id}"
                )
                return SessionForkResult(session=target, source=source)
            copied_events = self._copy_visible_history(
                source_session=source_session,
                target_session=target,
                cutoff_turn_index=source.turn_index,
            )
            target_event = copied_events.get(source.message_event_id or "")
            if target_event is None:
                raise SessionForkServiceError(
                    "fork_target_message_missing",
                    "未能在派生会话中定位 fork 消息",
                    {
                        "session_id": source_session.id,
                        "target_session_id": target.id,
                        "message_event_id": source.message_event_id,
                    },
                )
            self._record_fork_relation(
                source_session=source_session,
                target_session=target,
                source=source,
                target_event=target_event,
            )
            target = self._require_session(target.id)
            logger.info(
                "[SessionForkService] 创建 session 分支 | "
                f"source_session_id={source_session.id} | target_session_id={target.id} | "
                f"checkpoint_id={source.checkpoint_id}"
            )
            return SessionForkResult(session=target, source=source)
        except Exception as exc:
            self.checkpointer.delete_thread(target_session_id)
            self.repositories.session_forks.soft_delete_by_target(target_session_id)
            if self.repositories.sessions.get(target_session_id) is not None:
                self.repositories.sessions.hard_delete_internal(target_session_id)
            if isinstance(exc, SessionForkServiceError):
                raise
            raise SessionForkServiceError(
                "session_fork_failed",
                "创建 session 分支失败",
                {"session_id": session_id, "target_session_id": target_session_id},
            ) from exc

    def reverse_session(
        self,
        *,
        session_id: str,
        user_id: str,
        title: str | None = None,
        checkpoint_id: str | None = None,
        checkpoint_ns: str | None = None,
        trace_id: str | None = None,
        message_event_id: str | None = None,
        turn_index: int | None = None,
    ) -> SessionReverseResult:
        _ = user_id, title, checkpoint_ns
        source_session = self._require_session(session_id)
        source = self._resolve_reverse_source(
            source_session=source_session,
            checkpoint_id=checkpoint_id,
            trace_id=trace_id,
            message_event_id=message_event_id,
            turn_index=turn_index,
        )
        try:
            result, deleted_events, deleted_traces = self.rewind_conversation(
                source_session=source_session,
                source=source,
            )
            logger.info(
                "[SessionForkService] 回退 session 到历史轮次 | "
                f"session_id={source_session.id} | active_session_id={source.active_session_id} | "
                f"turn_index={source.turn_index} | checkpoint_id={source.checkpoint_id or '-'} | "
                f"deleted_events={deleted_events} | deleted_traces={deleted_traces}"
            )
            return result
        except Exception as exc:
            if isinstance(exc, SessionForkServiceError):
                raise
            raise SessionForkServiceError(
                "session_reverse_failed",
                "回退 session 失败",
                {
                    "session_id": source_session.id,
                    "turn_index": source.turn_index,
                    "checkpoint_id": source.checkpoint_id,
                },
            ) from exc

    def rewind_conversation(
        self,
        *,
        source_session: SessionRecord,
        source: SessionReverseSource,
    ) -> tuple[SessionReverseResult, int, int]:
        target_event = (
            self.repositories.message_events.get(source.message_event_id)
            if source.message_event_id
            else None
        )
        restored_input = None
        restored_attachments: tuple[dict[str, Any], ...] = ()
        if target_event is not None:
            restored_input = str((target_event.data or {}).get("content") or "")
            raw_attachments = (target_event.data or {}).get("attachments")
            if isinstance(raw_attachments, list):
                restored_attachments = tuple(
                    item for item in raw_attachments if isinstance(item, dict)
                )
        with self.repositories.db.transaction(immediate=True) as conn:
            self.checkpointer.rollback_thread_to_checkpoint(
                thread_id=source.active_session_id,
                checkpoint_id=source.checkpoint_id,
                checkpoint_ns=source.checkpoint_ns,
                conn=conn,
            )
            deleted_events, deleted_traces = self._rewind_turn_artifacts(
                conn,
                session_id=source_session.id,
                turn_index=source.turn_index,
            )
            conn.execute(
                """
                update sessions
                   set active_session_id = ?, status = 'active', updated_at = ?
                 where id = ? and archived_at is null
                """,
                (source.active_session_id, to_iso_z(utc_now()), source_session.id),
            )
        updated = self._require_session(source_session.id)
        return (
            SessionReverseResult(
                session=updated,
                source=source,
                restored_input=restored_input,
                restored_attachments=restored_attachments,
            ),
            deleted_events,
            deleted_traces,
        )

    def _rewind_turn_artifacts(
        self,
        conn: sqlite3.Connection,
        *,
        session_id: str,
        turn_index: int,
    ) -> tuple[int, int]:
        now = to_iso_z(utc_now())
        event_rows = conn.execute(
            """
            select data_json from message_events
             where session_id = ? and turn_index > ? and is_deleted = 0
            """,
            (session_id, turn_index),
        ).fetchall()
        attachment_ids = self._attachment_ids(event_rows)
        trace_rows = conn.execute(
            """
            select trace_id from trace_record
             where session_id = ? and turn_index >= ? and is_deleted = 0
            """,
            (session_id, turn_index),
        ).fetchall()
        trace_ids = tuple(str(row[0]) for row in trace_rows)
        deleted_subagents = self._rewind_subagent_instances(
            conn,
            parent_session_id=session_id,
            parent_trace_ids=trace_ids,
        )
        if trace_ids:
            placeholders = ",".join("?" for _ in trace_ids)
            deleted_events = conn.execute(
                f"""
                delete from message_events
                 where session_id = ?
                   and (
                     turn_index >= ?
                     or trace_record_id in ({placeholders})
                   )
                """,
                (session_id, turn_index, *trace_ids),
            ).rowcount
        else:
            deleted_events = conn.execute(
                "delete from message_events where session_id = ? and turn_index >= ?",
                (session_id, turn_index),
            ).rowcount
        if trace_ids:
            placeholders = ",".join("?" for _ in trace_ids)
            conn.execute(
                f"delete from trace_event_log where trace_record_id in ({placeholders})",
                trace_ids,
            )
        conn.execute(
            "delete from llm_request_logs where session_id = ? and turn_index >= ?",
            (session_id, turn_index),
        )
        conn.execute(
            """
            update a2ui_interactions set is_deleted = 1, updated_at = ?
             where session_id = ? and turn_index >= ? and is_deleted = 0
            """,
            (now, session_id, turn_index),
        )
        conn.execute(
            """
            update command_approval_requests set is_deleted = 1, updated_at = ?
             where session_id = ? and turn_index >= ? and is_deleted = 0
            """,
            (now, session_id, turn_index),
        )
        conn.execute(
            "delete from thread_task_runs where session_id = ? and turn_index >= ?",
            (session_id, turn_index),
        )
        conn.execute(
            """
            update session_pending_inputs
               set is_deleted = 1, status = 'cancelled', cancelled_at = ?, updated_at = ?
             where session_id = ? and promoted_turn_index >= ? and is_deleted = 0
            """,
            (now, now, session_id, turn_index),
        )
        if attachment_ids:
            placeholders = ",".join("?" for _ in attachment_ids)
            conn.execute(
                f"update attachments set is_deleted = 1, updated_at = ? "
                f"where id in ({placeholders})",
                (now, *attachment_ids),
            )
        deleted_traces = conn.execute(
            """
            update trace_record set is_deleted = 1, updated_at = ?
             where session_id = ? and turn_index >= ? and is_deleted = 0
            """,
            (now, session_id, turn_index),
        ).rowcount
        if deleted_subagents:
            logger.info(
                "[SessionForkService] 回退派生 Sub-Agent 实例 | "
                f"session_id={session_id} | deleted_subagents={deleted_subagents}"
            )
        return int(deleted_events), int(deleted_traces)

    def _rewind_subagent_instances(
        self,
        conn: sqlite3.Connection,
        *,
        parent_session_id: str,
        parent_trace_ids: tuple[str, ...],
    ) -> int:
        if not parent_trace_ids:
            return 0
        placeholders = ",".join("?" for _ in parent_trace_ids)
        rows = conn.execute(
            f"""
            select distinct s.id
              from sessions s
              join subagent_run r on r.child_session_id = s.id
             where r.parent_session_id = ?
               and r.parent_trace_id in ({placeholders})
               and r.initiated_by = 'main_agent'
               and s.parent_session_id = ?
               and s.visibility = 'internal'
               and s.agent_kind = 'subagent'
            """,
            (parent_session_id, *parent_trace_ids, parent_session_id),
        ).fetchall()
        child_session_ids = tuple(str(row[0]) for row in rows)
        if not child_session_ids:
            return 0

        for child_session_id in child_session_ids:
            self.checkpointer.delete_thread(child_session_id, conn=conn)
        child_placeholders = ",".join("?" for _ in child_session_ids)
        conn.execute(
            f"""
            delete from session_forks
             where source_session_id in ({child_placeholders})
                or target_session_id in ({child_placeholders})
            """,
            (*child_session_ids, *child_session_ids),
        )
        deleted = conn.execute(
            f"""
            delete from sessions
             where id in ({child_placeholders})
               and parent_session_id = ?
               and visibility = 'internal'
               and agent_kind = 'subagent'
            """,
            (*child_session_ids, parent_session_id),
        ).rowcount
        return int(deleted)

    @staticmethod
    def _attachment_ids(rows: list[sqlite3.Row]) -> tuple[str, ...]:
        values: set[str] = set()
        for row in rows:
            try:
                payload = json.loads(row[0] or "{}")
            except (TypeError, json.JSONDecodeError):
                continue
            attachments = payload.get("attachments") if isinstance(payload, dict) else None
            if not isinstance(attachments, list):
                continue
            for item in attachments:
                if isinstance(item, dict):
                    attachment_id = str(item.get("id") or "").strip()
                    if attachment_id:
                        values.add(attachment_id)
        return tuple(sorted(values))

    def resolve_reverse_source(
        self,
        *,
        session_id: str,
        message_event_id: str,
    ) -> SessionReverseSource:
        source_session = self._require_session(session_id)
        return self._resolve_reverse_source(
            source_session=source_session,
            checkpoint_id=None,
            trace_id=None,
            message_event_id=message_event_id,
            turn_index=None,
        )

    def _copy_visible_history(
        self,
        *,
        source_session: SessionRecord,
        target_session: SessionRecord,
        cutoff_turn_index: int | None,
    ) -> dict[str, MessageEventRecord]:
        copied_events: dict[str, MessageEventRecord] = {}
        events = self.repositories.message_events.list_by_session(source_session.id, limit=5000)
        for event in events:
            if cutoff_turn_index is not None and event.turn_index > cutoff_turn_index:
                continue
            copied = self.repositories.message_events.append(
                event_id=new_id(),
                session_id=target_session.id,
                trace_record_id=event.trace_record_id,
                turn_index=event.turn_index,
                action=event.action,
                data=self._copy_event_data(
                    event,
                    source_session=source_session,
                    target_session=target_session,
                ),
            )
            copied_events[event.id] = copied
        return copied_events

    @staticmethod
    def _copy_event_data(
        event: MessageEventRecord,
        *,
        source_session: SessionRecord,
        target_session: SessionRecord,
    ) -> dict[str, Any]:
        data = dict(event.data or {})
        if data.get("session_id") == source_session.id:
            data["session_id"] = target_session.id
        if data.get("original_session_id") == source_session.id:
            data["original_session_id"] = target_session.id
        if data.get("active_session_id") == (source_session.active_session_id or source_session.id):
            data["active_session_id"] = target_session.id
        return data

    @staticmethod
    def _fork_title(source_session: SessionRecord, title: str | None) -> str:
        cleaned = (title or "").strip()
        if cleaned:
            return cleaned
        base = (source_session.title or "新会话").strip() or "新会话"
        return f"{base} 分支"

    @staticmethod
    def _fork_session_tag(source_session: SessionRecord, session_tag: str | None) -> str:
        cleaned = (session_tag or "").strip()
        return cleaned or source_session.session_tag

    @staticmethod
    def _is_checkpoint_only_fork(session_tag: str | None) -> bool:
        return (session_tag or "").strip() == "btw"

    @staticmethod
    def _validate_fork_source(*, source_session: SessionRecord, source: CheckpointSource) -> None:
        if not source.message_event_id:
            raise SessionForkServiceError(
                "fork_message_event_missing",
                "fork 必须绑定到具体消息事件",
                {
                    "session_id": source_session.id,
                    "source_type": source.source_type,
                },
            )
        if source.turn_index is None:
            raise SessionForkServiceError(
                "fork_turn_index_missing",
                "fork 必须绑定到具体回合",
                {
                    "session_id": source_session.id,
                    "message_event_id": source.message_event_id,
                },
            )

    def _record_fork_relation(
        self,
        *,
        source_session: SessionRecord,
        target_session: SessionRecord,
        source: CheckpointSource,
        target_event: MessageEventRecord,
    ) -> None:
        self.repositories.session_forks.create(
            fork_id=new_id(),
            source_session_id=source_session.id,
            target_session_id=target_session.id,
            source_message_event_id=source.message_event_id or "",
            target_message_event_id=target_event.id,
            source_turn_index=source.turn_index or 0,
            target_turn_index=target_event.turn_index,
            source_trace_id=source.trace_id,
            source_active_session_id=source.active_session_id,
            source_checkpoint_id=source.checkpoint_id,
            source_checkpoint_ns=source.checkpoint_ns,
        )

    def _resolve_reverse_source(
        self,
        *,
        source_session: SessionRecord,
        checkpoint_id: str | None,
        trace_id: str | None,
        message_event_id: str | None,
        turn_index: int | None,
    ) -> SessionReverseSource:
        if (checkpoint_id or "").strip():
            raise SessionForkServiceError(
                "reverse_checkpoint_source_unsupported",
                "reverse 必须从用户消息、trace 或回合定位，不能只提供 checkpoint_id",
                {"session_id": source_session.id, "checkpoint_id": checkpoint_id},
            )
        provided = [
            bool((trace_id or "").strip()),
            bool((message_event_id or "").strip()),
            turn_index is not None,
        ]
        if sum(1 for value in provided if value) != 1:
            raise SessionForkServiceError(
                "checkpoint_source_ambiguous",
                "必须且只能提供一种 reverse 来源",
                {
                    "trace_id": trace_id,
                    "message_event_id": message_event_id,
                    "turn_index": turn_index,
                },
            )
        if message_event_id:
            return self._resolve_reverse_message_event(
                source_session=source_session,
                message_event_id=message_event_id,
            )
        if trace_id:
            trace = self._require_trace(trace_id)
            if trace.session_id != source_session.id:
                raise SessionForkServiceError(
                    "trace_session_mismatch",
                    "trace 不属于当前 session",
                    {
                        "session_id": source_session.id,
                        "trace_id": trace_id,
                        "trace_session_id": trace.session_id,
                    },
                )
            return self._reverse_source_from_trace(
                source_session=source_session,
                trace=trace,
                source_type="trace",
            )
        if turn_index is None:
            raise AssertionError("unreachable reverse source state")
        return self._resolve_reverse_turn(source_session=source_session, turn_index=turn_index)

    def _resolve_reverse_message_event(
        self,
        *,
        source_session: SessionRecord,
        message_event_id: str,
    ) -> SessionReverseSource:
        event = self.repositories.message_events.get(message_event_id)
        if event is None or event.session_id != source_session.id:
            raise SessionForkServiceError(
                "message_event_not_found",
                "消息事件不存在",
                {"session_id": source_session.id, "message_event_id": message_event_id},
            )
        if self._event_action(event) != "user_message":
            raise SessionForkServiceError(
                "reverse_source_must_be_user_message",
                "reverse 只能从用户消息回退",
                {
                    "session_id": source_session.id,
                    "message_event_id": message_event_id,
                    "action": self._event_action(event),
                },
            )
        if not event.trace_record_id:
            raise SessionForkServiceError(
                "message_event_checkpoint_missing",
                "该消息没有可用 checkpoint",
                {"message_event_id": event.id, "turn_index": event.turn_index},
            )
        trace = self._require_trace(event.trace_record_id)
        return self._reverse_source_from_trace(
            source_session=source_session,
            trace=trace,
            message_event_id=event.id,
            source_type="message_event",
        )

    def _resolve_reverse_turn(
        self,
        *,
        source_session: SessionRecord,
        turn_index: int,
    ) -> SessionReverseSource:
        events = self.repositories.message_events.list_by_turn(source_session.id, int(turn_index))
        for event in events:
            if self._event_action(event) == "user_message" and event.trace_record_id:
                trace = self._require_trace(event.trace_record_id)
                return self._reverse_source_from_trace(
                    source_session=source_session,
                    trace=trace,
                    message_event_id=event.id,
                    source_type="turn",
                )
        raise SessionForkServiceError(
            "turn_checkpoint_missing",
            "该回合没有可用 checkpoint",
            {"session_id": source_session.id, "turn_index": turn_index},
        )

    def _reverse_source_from_trace(
        self,
        *,
        source_session: SessionRecord,
        trace,
        message_event_id: str | None = None,
        source_type: str,
    ) -> SessionReverseSource:
        if trace.session_id != source_session.id:
            raise SessionForkServiceError(
                "trace_session_mismatch",
                "trace 不属于当前 session",
                {
                    "session_id": source_session.id,
                    "trace_id": trace.trace_id,
                    "trace_session_id": trace.session_id,
                },
            )
        if trace.status == "running":
            raise SessionForkServiceError(
                "trace_not_completed",
                "运行中的回合不能 reverse",
                {"trace_id": trace.trace_id, "status": trace.status},
            )
        active_session_id = (
            trace.active_session_id
            or source_session.active_session_id
            or source_session.id
        )
        checkpoint_id = (trace.input_checkpoint_id or "").strip() or None
        checkpoint_ns = trace.input_checkpoint_ns or ""
        if checkpoint_id is None and self._has_visible_history_before_turn(
            source_session.id,
            trace.turn_index,
        ):
            raise SessionForkServiceError(
                "reverse_input_checkpoint_missing",
                "该轮缺少输入前 checkpoint，不能安全回退",
                {
                    "session_id": source_session.id,
                    "trace_id": trace.trace_id,
                    "turn_index": trace.turn_index,
                },
            )
        if checkpoint_id and not self._checkpoint_exists(
            active_session_id,
            checkpoint_ns,
            checkpoint_id,
        ):
            raise SessionForkServiceError(
                "checkpoint_not_found",
                "checkpoint 不存在",
                {
                    "session_id": source_session.id,
                    "active_session_id": active_session_id,
                    "checkpoint_id": checkpoint_id,
                    "checkpoint_ns": checkpoint_ns,
                },
            )
        return SessionReverseSource(
            session_id=source_session.id,
            active_session_id=active_session_id,
            checkpoint_id=checkpoint_id,
            checkpoint_ns=checkpoint_ns,
            trace_id=trace.trace_id,
            turn_index=trace.turn_index,
            message_event_id=message_event_id,
            source_type=source_type,
        )

    def _require_trace(self, trace_id: str):
        trace = self.repositories.trace_records.get(trace_id)
        if trace is None:
            raise SessionForkServiceError(
                "trace_not_found",
                "trace 不存在",
                {"trace_id": trace_id},
            )
        return trace

    def _has_visible_history_before_turn(self, session_id: str, turn_index: int) -> bool:
        with self.repositories.db.connect() as conn:
            row = conn.execute(
                """
                select 1
                  from message_events
                 where session_id = ?
                   and turn_index < ?
                   and action = 'user_message'
                   and is_deleted = 0
                 limit 1
                """,
                (session_id, int(turn_index)),
            ).fetchone()
        return row is not None

    def _checkpoint_exists(self, thread_id: str, checkpoint_ns: str, checkpoint_id: str) -> bool:
        with self.repositories.db.connect() as conn:
            row = conn.execute(
                """
                select 1
                from checkpoints_v2
                where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
                limit 1
                """,
                (thread_id, checkpoint_ns, checkpoint_id),
            ).fetchone()
        return row is not None

    @staticmethod
    def _event_action(event: MessageEventRecord) -> str:
        canonical = (event.data or {}).get("_canonical")
        if isinstance(canonical, dict) and canonical.get("action"):
            return str(canonical["action"])
        return event.action

    def _require_session(self, session_id: str) -> SessionRecord:
        session = self.repositories.sessions.get(session_id)
        if session is None:
            if self.repositories.sessions.get_archived(session_id) is not None:
                raise SessionForkServiceError(
                    "entity_archived",
                    "session 已归档",
                    {"session_id": session_id},
                )
            raise SessionForkServiceError(
                "session_not_found",
                "session 不存在",
                {"session_id": session_id},
            )
        return session
