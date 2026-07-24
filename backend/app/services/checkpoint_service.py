from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver, CheckpointTuple

from backend.app.storage import MessageEventRecord, SessionRecord, StorageRepositories, TraceRecord


class CheckpointServiceError(ValueError):
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
class CheckpointSource:
    session_id: str
    active_session_id: str
    checkpoint_id: str
    checkpoint_ns: str
    trace_id: str | None = None
    turn_index: int | None = None
    message_event_id: str | None = None
    source_type: str = "checkpoint"
    lineage_epoch: int = 0
    history_floor_turn_index: int = 0

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
            "lineage_epoch": self.lineage_epoch,
            "history_floor_turn_index": self.history_floor_turn_index,
        }


class CheckpointService:
    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        checkpointer: BaseCheckpointSaver | None = None,
    ) -> None:
        self.repositories = repositories
        self.checkpointer = checkpointer

    async def latest_for_session(self, session_id: str) -> dict[str, Any]:
        session = self._require_session(session_id)
        active_session_id = self._active_thread_id(session)
        checkpoint = await self._latest_checkpoint(active_session_id, "")
        if checkpoint is None:
            return {
                "exists": False,
                "session_id": session.id,
                "active_session_id": active_session_id,
                "checkpoint": None,
            }
        return {
            "exists": True,
            "session_id": session.id,
            "active_session_id": active_session_id,
            "checkpoint": self._metadata_from_tuple(checkpoint),
        }

    async def list_for_session(
        self,
        session_id: str,
        *,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        session = self._require_session(session_id)
        active_session_id = self._active_thread_id(session)
        checkpointer = self._require_checkpointer()
        items = [
            item
            async for item in checkpointer.alist(
                self._config(active_session_id, ""),
                limit=max(1, min(limit, 100)),
            )
        ]
        return [self._metadata_from_tuple(item) for item in items]

    async def resolve_source(
        self,
        *,
        session_id: str,
        checkpoint_id: str | None = None,
        checkpoint_ns: str | None = None,
        trace_id: str | None = None,
        message_event_id: str | None = None,
        turn_index: int | None = None,
    ) -> CheckpointSource:
        provided = [
            bool((checkpoint_id or "").strip()),
            bool((trace_id or "").strip()),
            bool((message_event_id or "").strip()),
            turn_index is not None,
        ]
        source_count = sum(1 for value in provided if value)
        if source_count > 1:
            raise CheckpointServiceError(
                "checkpoint_source_ambiguous",
                "最多只能提供一种 fork 来源",
                {
                    "checkpoint_id": checkpoint_id,
                    "trace_id": trace_id,
                    "message_event_id": message_event_id,
                    "turn_index": turn_index,
                },
            )
        if source_count == 0:
            return await self.resolve_latest_completed(session_id=session_id)
        if checkpoint_id:
            return await self.resolve_checkpoint(
                session_id=session_id,
                checkpoint_id=checkpoint_id,
                checkpoint_ns=checkpoint_ns or "",
            )
        if trace_id:
            return await self.resolve_trace(session_id=session_id, trace_id=trace_id)
        if message_event_id:
            return await self.resolve_message_event(
                session_id=session_id,
                message_event_id=message_event_id,
            )
        if turn_index is None:
            raise AssertionError("unreachable source state")
        return await self.resolve_turn(session_id=session_id, turn_index=turn_index)

    async def resolve_latest_completed(self, *, session_id: str) -> CheckpointSource:
        session = self._require_session(session_id)
        active_session_id = self._active_thread_id(session)
        with self.repositories.db.connect() as conn:
            rows = conn.execute(
                """
                select trace.trace_id, trace.turn_index, trace.output_checkpoint_id,
                       coalesce(trace.output_checkpoint_ns, '') as output_checkpoint_ns,
                       event.id as message_event_id
                from trace_record as trace
                join message_events as event
                  on event.session_id = trace.session_id
                 and event.trace_record_id = trace.trace_id
                 and event.action in ('ai_message', 'stream_batch')
                 and (
                       event.action = 'ai_message'
                       or coalesce(json_extract(event.data_json, '$.is_subagent'), 0) = 0
                 )
                 and event.is_deleted = 0
                where trace.session_id = ?
                  and trace.status = 'completed'
                  and trace.output_checkpoint_id is not null
                  and trace.is_deleted = 0
                order by trace.turn_index desc, trace.end_time desc,
                         trace.created_at desc, event.seq desc
                """,
                (session.id,),
            ).fetchall()
        for row in rows:
            checkpoint_id = str(row["output_checkpoint_id"])
            checkpoint_ns = str(row["output_checkpoint_ns"] or "")
            if await self._checkpoint_exists(
                active_session_id,
                checkpoint_ns,
                checkpoint_id,
            ):
                return self._source(
                    session=session,
                    active_session_id=active_session_id,
                    checkpoint_id=checkpoint_id,
                    checkpoint_ns=checkpoint_ns,
                    trace_id=str(row["trace_id"]),
                    turn_index=int(row["turn_index"]),
                    message_event_id=str(row["message_event_id"]),
                    source_type="latest_completed",
                )
        if session.checkpoint_root_id:
            root = await self._checkpoint_exists(
                active_session_id,
                "",
                session.checkpoint_root_id,
            )
            if root:
                latest_row = rows[0] if rows else None
                return self._source(
                    session=session,
                    active_session_id=active_session_id,
                    checkpoint_id=session.checkpoint_root_id,
                    checkpoint_ns="",
                    trace_id=(
                        str(latest_row["trace_id"]) if latest_row is not None else None
                    ),
                    turn_index=max(
                        0,
                        session.checkpoint_history_floor_turn_index - 1,
                    ),
                    message_event_id=(
                        str(latest_row["message_event_id"])
                        if latest_row is not None
                        else None
                    ),
                    source_type="migration_root",
                )
        if not rows:
            raise CheckpointServiceError(
                "latest_fork_source_missing",
                "没有可派生的完整回合",
                {
                    "session_id": session.id,
                    "active_session_id": active_session_id,
                },
            )
        raise CheckpointServiceError(
            "checkpoint_not_found",
            "最新完整回合的 checkpoint 不存在",
            {
                "session_id": session.id,
                "active_session_id": active_session_id,
            },
        )

    async def resolve_latest_checkpoint(self, *, session_id: str) -> CheckpointSource:
        session = self._require_session(session_id)
        active_session_id = self._active_thread_id(session)
        checkpoint = await self._latest_checkpoint(active_session_id, "")
        if checkpoint is None:
            raise CheckpointServiceError(
                "latest_checkpoint_missing",
                "当前会话没有可用 checkpoint",
                {
                    "session_id": session.id,
                    "active_session_id": active_session_id,
                },
            )
        configurable = checkpoint.config["configurable"]
        return self._source(
            session=session,
            active_session_id=active_session_id,
            checkpoint_id=str(configurable["checkpoint_id"]),
            checkpoint_ns=str(configurable.get("checkpoint_ns") or ""),
            source_type="latest_checkpoint",
        )

    async def resolve_checkpoint(
        self,
        *,
        session_id: str,
        checkpoint_id: str,
        checkpoint_ns: str = "",
    ) -> CheckpointSource:
        session = self._require_session(session_id)
        active_session_id = self._active_thread_id(session)
        cleaned_checkpoint_id = checkpoint_id.strip()
        if not cleaned_checkpoint_id:
            raise CheckpointServiceError("checkpoint_id_empty", "checkpoint_id 不能为空")
        if not await self._checkpoint_exists(
            active_session_id,
            checkpoint_ns,
            cleaned_checkpoint_id,
        ):
            self._raise_compacted_if_applicable(
                session,
                requested_checkpoint_id=cleaned_checkpoint_id,
            )
            raise CheckpointServiceError(
                "checkpoint_not_found",
                "checkpoint 不存在",
                {
                    "session_id": session_id,
                    "active_session_id": active_session_id,
                    "checkpoint_id": cleaned_checkpoint_id,
                    "checkpoint_ns": checkpoint_ns,
                },
            )
        return self._source(
            session=session,
            active_session_id=active_session_id,
            checkpoint_id=cleaned_checkpoint_id,
            checkpoint_ns=checkpoint_ns,
        )

    async def resolve_trace(
        self,
        *,
        session_id: str,
        trace_id: str,
    ) -> CheckpointSource:
        session = self._require_session(session_id)
        trace = self._require_trace(trace_id)
        if trace.session_id != session.id:
            raise CheckpointServiceError(
                "trace_session_mismatch",
                "trace 不属于当前 session",
                {
                    "session_id": session.id,
                    "trace_id": trace_id,
                    "trace_session_id": trace.session_id,
                },
            )
        return await self._source_from_trace(
            session=session,
            trace=trace,
            active_session_id=trace.active_session_id or self._active_thread_id(session),
            source_type="trace",
        )

    async def resolve_message_event(
        self,
        *,
        session_id: str,
        message_event_id: str,
    ) -> CheckpointSource:
        session = self._require_session(session_id)
        event = self.repositories.message_events.get(message_event_id)
        if event is None or event.session_id != session.id:
            raise CheckpointServiceError(
                "message_event_not_found",
                "消息事件不存在",
                {"session_id": session_id, "message_event_id": message_event_id},
            )
        trace = self._trace_from_event(event)
        return await self._source_from_trace(
            session=session,
            trace=trace,
            active_session_id=self._active_thread_id(session),
            message_event_id=event.id,
            source_type="message_event",
        )

    async def resolve_turn(
        self,
        *,
        session_id: str,
        turn_index: int,
    ) -> CheckpointSource:
        session = self._require_session(session_id)
        self._raise_compacted_if_applicable(
            session,
            requested_turn_index=int(turn_index),
        )
        events = self.repositories.message_events.list_by_turn(session.id, int(turn_index))
        if not events:
            raise CheckpointServiceError(
                "turn_not_found",
                "回合不存在",
                {"session_id": session_id, "turn_index": turn_index},
            )
        for event in reversed(events):
            if event.trace_record_id:
                trace = self._trace_from_event(event)
                return await self._source_from_trace(
                    session=session,
                    trace=trace,
                    active_session_id=self._active_thread_id(session),
                    message_event_id=event.id,
                    source_type="turn",
                )
        raise CheckpointServiceError(
            "turn_checkpoint_missing",
            "该回合没有可用 checkpoint",
            {"session_id": session_id, "turn_index": turn_index},
        )

    async def _source_from_trace(
        self,
        *,
        session: SessionRecord,
        trace: TraceRecord,
        active_session_id: str,
        message_event_id: str | None = None,
        source_type: str,
    ) -> CheckpointSource:
        if trace.status != "completed":
            raise CheckpointServiceError(
                "trace_not_completed",
                "只有已完成回合可以从 checkpoint 继续",
                {"trace_id": trace.trace_id, "status": trace.status},
            )
        self._raise_compacted_if_applicable(
            session,
            requested_turn_index=trace.turn_index,
        )
        if not trace.output_checkpoint_id:
            raise CheckpointServiceError(
                "trace_checkpoint_missing",
                "该回合没有可用 checkpoint",
                {"trace_id": trace.trace_id, "session_id": session.id},
            )
        checkpoint_ns = trace.output_checkpoint_ns or ""
        if not await self._checkpoint_exists(
            active_session_id, checkpoint_ns, trace.output_checkpoint_id
        ):
            raise CheckpointServiceError(
                "checkpoint_not_found",
                "checkpoint 不存在",
                {
                    "session_id": session.id,
                    "active_session_id": active_session_id,
                    "checkpoint_id": trace.output_checkpoint_id,
                    "checkpoint_ns": checkpoint_ns,
                },
            )
        return self._source(
            session=session,
            active_session_id=active_session_id,
            checkpoint_id=trace.output_checkpoint_id,
            checkpoint_ns=checkpoint_ns,
            trace_id=trace.trace_id,
            turn_index=trace.turn_index,
            message_event_id=message_event_id,
            source_type=source_type,
        )

    def _trace_from_event(self, event: MessageEventRecord) -> TraceRecord:
        if not event.trace_record_id:
            raise CheckpointServiceError(
                "message_event_checkpoint_missing",
                "该消息没有可用 checkpoint",
                {"message_event_id": event.id, "turn_index": event.turn_index},
            )
        return self._require_trace(event.trace_record_id)

    def _require_session(self, session_id: str) -> SessionRecord:
        session = self.repositories.sessions.get(session_id)
        if session is None:
            raise CheckpointServiceError(
                "session_not_found",
                "session 不存在",
                {"session_id": session_id},
            )
        return session

    def _require_trace(self, trace_id: str) -> TraceRecord:
        trace = self.repositories.trace_records.get(trace_id)
        if trace is None:
            raise CheckpointServiceError(
                "trace_not_found",
                "trace 不存在",
                {"trace_id": trace_id},
            )
        return trace

    @staticmethod
    def _active_thread_id(session: SessionRecord) -> str:
        return session.active_session_id or session.id

    def _require_checkpointer(self) -> BaseCheckpointSaver:
        if self.checkpointer is None:
            raise CheckpointServiceError(
                "checkpoint_runtime_unavailable",
                "checkpoint runtime 未就绪",
            )
        return self.checkpointer

    @staticmethod
    def _config(
        thread_id: str,
        checkpoint_ns: str,
        checkpoint_id: str | None = None,
    ) -> RunnableConfig:
        configurable: dict[str, Any] = {
            "thread_id": thread_id,
            "checkpoint_ns": checkpoint_ns,
        }
        if checkpoint_id is not None:
            configurable["checkpoint_id"] = checkpoint_id
        return {"configurable": configurable}

    async def _latest_checkpoint(
        self,
        thread_id: str,
        checkpoint_ns: str,
    ) -> CheckpointTuple | None:
        return await self._require_checkpointer().aget_tuple(
            self._config(thread_id, checkpoint_ns)
        )

    async def _checkpoint_exists(
        self,
        thread_id: str,
        checkpoint_ns: str,
        checkpoint_id: str,
    ) -> bool:
        checkpoint = await self._require_checkpointer().aget_tuple(
            self._config(thread_id, checkpoint_ns, checkpoint_id)
        )
        return checkpoint is not None

    @staticmethod
    def _source(
        *,
        session: SessionRecord,
        active_session_id: str,
        checkpoint_id: str,
        checkpoint_ns: str,
        trace_id: str | None = None,
        turn_index: int | None = None,
        message_event_id: str | None = None,
        source_type: str = "checkpoint",
    ) -> CheckpointSource:
        return CheckpointSource(
            session_id=session.id,
            active_session_id=active_session_id,
            checkpoint_id=checkpoint_id,
            checkpoint_ns=checkpoint_ns,
            trace_id=trace_id,
            turn_index=turn_index,
            message_event_id=message_event_id,
            source_type=source_type,
            lineage_epoch=session.checkpoint_lineage_epoch,
            history_floor_turn_index=session.checkpoint_history_floor_turn_index,
        )

    def _raise_compacted_if_applicable(
        self,
        session: SessionRecord,
        *,
        requested_turn_index: int | None = None,
        requested_checkpoint_id: str | None = None,
    ) -> None:
        floor = session.checkpoint_history_floor_turn_index
        is_pre_boundary_turn = (
            requested_turn_index is not None
            and floor > 0
            and requested_turn_index < floor
        )
        is_removed_checkpoint = False
        if (
            requested_checkpoint_id is not None
            and session.checkpoint_lineage_epoch > 0
            and requested_checkpoint_id != session.checkpoint_root_id
        ):
            with self.repositories.db.connect() as connection:
                referenced = connection.execute(
                    """
                    select 1 from trace_record
                    where session_id = ? and turn_index < ?
                      and (
                        input_checkpoint_id = ?
                        or output_checkpoint_id = ?
                      )
                    limit 1
                    """,
                    (
                        session.id,
                        floor,
                        requested_checkpoint_id,
                        requested_checkpoint_id,
                    ),
                ).fetchone()
            is_removed_checkpoint = referenced is not None
        if not is_pre_boundary_turn and not is_removed_checkpoint:
            return
        raise CheckpointServiceError(
            "checkpoint_history_compacted",
            "该历史位置早于 checkpoint 迁移边界，不能回溯",
            {
                "session_id": session.id,
                "lineage_epoch": session.checkpoint_lineage_epoch,
                "history_floor_turn_index": floor,
                "checkpoint_root_id": session.checkpoint_root_id,
                "requested_turn_index": requested_turn_index,
                "requested_checkpoint_id": requested_checkpoint_id,
            },
        )

    @staticmethod
    def _metadata_from_tuple(item: CheckpointTuple) -> dict[str, Any]:
        configurable = item.config["configurable"]
        return {
            "thread_id": configurable["thread_id"],
            "checkpoint_ns": configurable.get("checkpoint_ns") or "",
            "checkpoint_id": configurable["checkpoint_id"],
            "parent_checkpoint_id": (
                item.parent_config["configurable"]["checkpoint_id"]
                if item.parent_config is not None
                else None
            ),
            "created_at": item.checkpoint.get("ts"),
            "metadata": dict(item.metadata),
        }
