from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.core.ids import new_id
from backend.app.core.logger import logger
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
        try:
            source = self.checkpoint_service.resolve_source(
                session_id=session_id,
                checkpoint_id=checkpoint_id,
                checkpoint_ns=checkpoint_ns,
                trace_id=trace_id,
                message_event_id=message_event_id,
                turn_index=turn_index,
            )
        except CheckpointServiceError as exc:
            raise SessionForkServiceError(exc.code, exc.message, exc.details) from exc

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
                self.repositories.sessions.soft_delete(target_session_id)
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
            self.checkpointer.rollback_thread_to_checkpoint(
                thread_id=source.active_session_id,
                checkpoint_id=source.checkpoint_id,
                checkpoint_ns=source.checkpoint_ns,
            )
            deleted_events = self.repositories.message_events.delete_from_turn(
                source_session.id,
                source.turn_index,
            )
            deleted_traces = self.repositories.trace_records.soft_delete_from_turn(
                source_session.id,
                source.turn_index,
            )
            updated = self.repositories.sessions.update(
                source_session.id,
                active_session_id=source.active_session_id,
                status="active",
            )
            if updated is None:
                raise SessionForkServiceError(
                    "session_not_found",
                    "session 不存在",
                    {"session_id": source_session.id},
                )
            logger.info(
                "[SessionForkService] 回退 session 到历史轮次 | "
                f"session_id={source_session.id} | active_session_id={source.active_session_id} | "
                f"turn_index={source.turn_index} | checkpoint_id={source.checkpoint_id or '-'} | "
                f"deleted_events={deleted_events} | deleted_traces={deleted_traces}"
            )
            return SessionReverseResult(session=updated, source=source)
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
        previous_turns = self.repositories.message_events.list_turn_indexes(
            session_id,
            cursor_turn_index=int(turn_index),
            direction="older",
            limit=1,
        )
        return bool(previous_turns)

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
            raise SessionForkServiceError(
                "session_not_found",
                "session 不存在",
                {"session_id": session_id},
            )
        return session
