from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.app.agent.checkpoint import KeydexAsyncCheckpointStore
from backend.app.services.file_history_service import (
    FileClassification,
    FileHistoryError,
    FileHistoryErrorCode,
    FileHistoryService,
    FileOperationFileStatus,
    FileOperationStatus,
    FileRestoreDecision,
    FileRestoreMode,
    FileRestoreResult,
)
from backend.app.services.file_resources import FileResourceIdentity
from backend.app.services.session_fork_service import (
    SessionForkService,
    SessionForkServiceError,
    SessionReverseSource,
)
from backend.app.storage import (
    FileHistoryOperationFileRecord,
    FileHistoryOperationRecord,
    StorageRepositories,
)


@dataclass(frozen=True, slots=True)
class SessionReverseExecution:
    operation_id: str
    preview_token: str
    request_id: str
    message_event_id: str
    mode: FileRestoreMode
    decision: FileRestoreDecision
    file_access_mode: str = "workspace_trusted"
    confirm_external_paths: bool = False


class SessionReverseService:
    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        file_history: FileHistoryService,
        checkpointer: KeydexAsyncCheckpointStore | None = None,
        conversation: SessionForkService | None = None,
    ) -> None:
        self.repositories = repositories
        self.file_history = file_history
        self.conversation = (
            conversation
            if conversation is not None
            else (
                SessionForkService(
                    repositories,
                    checkpointer=checkpointer,
                )
                if checkpointer is not None
                else None
            )
        )

    def get_result(self, *, session_id: str, operation_id: str) -> FileRestoreResult:
        operation = self.repositories.file_history.get_operation(operation_id)
        if operation is None or operation.session_id != session_id:
            raise FileHistoryError(
                FileHistoryErrorCode.SNAPSHOT_MISSING,
                "文件回溯 operation 不存在",
                http_status=404,
            )
        return self._result_from_operation(operation)

    async def execute(
        self,
        *,
        session_id: str,
        workspace_root: str | Path,
        request: SessionReverseExecution,
    ) -> FileRestoreResult:
        operation = self._require_operation(session_id, request)
        replay = self.repositories.file_history.get_operation_by_request(
            session_id,
            request.request_id,
        )
        if replay is not None:
            if replay.id != request.operation_id:
                raise FileHistoryError(
                    FileHistoryErrorCode.REQUEST_CONFLICT,
                    "request_id 已用于其他回溯 operation",
                )
            return self._result_from_operation(replay)

        session = self.repositories.sessions.get(session_id)
        if session is None:
            raise FileHistoryError(
                FileHistoryErrorCode.SNAPSHOT_MISSING,
                "session 不存在",
                http_status=404,
            )
        if self.conversation is not None:
            source = await self.conversation.resolve_reverse_source(
                session_id=session_id,
                message_event_id=request.message_event_id,
            )
        else:
            if request.mode in {FileRestoreMode.BOTH, FileRestoreMode.CONVERSATION} or (
                request.decision == FileRestoreDecision.CONVERSATION_ONLY
            ):
                raise FileHistoryError(
                    FileHistoryErrorCode.CONVERSATION_FAILED,
                    "checkpoint runtime 未就绪，不能回溯对话",
                )
            source = self._resolve_file_only_source(
                session_id=session_id,
                message_event_id=request.message_event_id,
            )
        with self.file_history.restore_lease(
            session_id=session_id,
            workspace_root=workspace_root,
            operation_id=operation.id,
        ):
            operation, target, _ = self.file_history.preflight_preview(
                session_id=session_id,
                operation_id=operation.id,
                preview_token=request.preview_token,
                mode=request.mode,
                decision=request.decision,
                workspace_root=workspace_root,
                file_access_mode=request.file_access_mode,
                confirm_external_paths=request.confirm_external_paths,
            )
            selected, forced, skipped = self._select_files(
                operation,
                mode=request.mode,
                decision=request.decision,
            )
            claimed = self.file_history.claim_operation_request(
                session_id=session_id,
                operation_id=operation.id,
                request_id=request.request_id,
                mode=request.mode,
                decision=request.decision,
            )
            if claimed.state != FileOperationStatus.RUNNING:
                return self._result_from_operation(claimed)
            self._mark_skipped(operation.id, skipped)
            if request.decision == FileRestoreDecision.CANCEL:
                completed = self.file_history.complete_operation(
                    operation.id,
                    status=FileOperationStatus.CANCELLED,
                    conversation_rewound=False,
                    active_snapshot_after=operation.active_snapshot_before,
                )
                return self._result_from_operation(completed)

            restore_result_id: str | None = None
            files_changed = False
            if selected:
                if target is None:
                    raise FileHistoryError(
                        FileHistoryErrorCode.SNAPSHOT_MISSING,
                        "文件回溯目标快照不存在",
                    )
                try:
                    self.file_history.create_safety_snapshots(
                        operation_id=operation.id,
                        workspace_root=workspace_root,
                        canonical_paths=selected,
                    )
                    self.file_history.execute_file_restore(
                        operation_id=operation.id,
                        target=target,
                        workspace_root=workspace_root,
                        canonical_paths=selected,
                        forced_paths=forced,
                        mode=request.mode,
                    )
                    files_changed = True
                    materialized = self.file_history.materialize_restore_result(
                        session_id=session_id,
                        active_session_id=session.active_session_id or session.id,
                        target_snapshot_id=target.snapshot.id,
                        workspace_root=workspace_root,
                        trace_id=source.trace_id,
                        changed_canonical_paths=selected,
                    )
                    restore_result_id = materialized.id
                    self.repositories.file_history.update_operation(
                        operation.id,
                        active_snapshot_after=restore_result_id,
                    )
                except Exception as exc:
                    changed_files = self.repositories.file_history.list_operation_files(
                        operation.id
                    )
                    has_changed_file = any(
                        item.result_state
                        in {
                            FileOperationFileStatus.RESTORED,
                            FileOperationFileStatus.FORCED,
                        }
                        for item in changed_files
                    )
                    if files_changed or has_changed_file:
                        self._compensate_and_raise(
                            operation_id=operation.id,
                            workspace_root=workspace_root,
                            cause=exc,
                            error_code=FileHistoryErrorCode.RESTORE_FAILED,
                            message="文件回溯失败，已恢复操作前文件",
                        )
                    self.repositories.file_history.update_operation(
                        operation.id,
                        state=FileOperationStatus.FAILED,
                        error_code=str(
                            getattr(exc, "code", None)
                            or FileHistoryErrorCode.RESTORE_FAILED
                        ),
                        completed=True,
                    )
                    if isinstance(exc, FileHistoryError):
                        raise
                    raise FileHistoryError(
                        FileHistoryErrorCode.RESTORE_FAILED,
                        "文件回溯准备失败",
                    ) from exc

            conversation_result = None
            should_rewind_conversation = request.mode in {
                FileRestoreMode.BOTH,
                FileRestoreMode.CONVERSATION,
            } or request.decision == FileRestoreDecision.CONVERSATION_ONLY
            if should_rewind_conversation:
                if self.conversation is None:
                    raise AssertionError("conversation service must be available")
                try:
                    conversation_result, _, _ = await self.conversation.rewind_conversation(
                        source_session=session,
                        source=source,
                    )
                except Exception as exc:
                    if files_changed:
                        self._compensate_and_raise(
                            operation_id=operation.id,
                            workspace_root=workspace_root,
                            cause=exc,
                            error_code=FileHistoryErrorCode.CONVERSATION_FAILED,
                            message="对话回溯失败，已恢复操作前文件",
                        )
                    self.repositories.file_history.update_operation(
                        operation.id,
                        state=FileOperationStatus.FAILED,
                        error_code=FileHistoryErrorCode.CONVERSATION_FAILED,
                        completed=True,
                    )
                    if isinstance(exc, SessionForkServiceError):
                        raise exc
                    raise FileHistoryError(
                        FileHistoryErrorCode.CONVERSATION_FAILED,
                        "对话回溯失败",
                    ) from exc

            code_was_requested = request.mode in {
                FileRestoreMode.BOTH,
                FileRestoreMode.CODE,
            } and request.decision != FileRestoreDecision.CONVERSATION_ONLY
            final_status = (
                FileOperationStatus.PARTIAL
                if code_was_requested and skipped
                else FileOperationStatus.FULL
            )
            result_detail: dict[str, Any] = {"source": source.to_dict()}
            if conversation_result is not None:
                result_detail["restored_input"] = conversation_result.restored_input
                result_detail["restored_attachments"] = list(
                    conversation_result.restored_attachments
                )
            self.repositories.file_history.update_operation(
                operation.id,
                error_detail=result_detail,
            )
            completed = self.file_history.complete_operation(
                operation.id,
                status=final_status,
                conversation_rewound=conversation_result is not None,
                active_snapshot_after=(
                    restore_result_id
                    if restore_result_id is not None
                    else operation.active_snapshot_before
                ),
            )
            return self._result_from_operation(
                completed,
                restored_input=(
                    conversation_result.restored_input if conversation_result is not None else None
                ),
                source=source.to_dict(),
            )

    def _resolve_file_only_source(
        self,
        *,
        session_id: str,
        message_event_id: str,
    ) -> SessionReverseSource:
        event = self.repositories.message_events.get(message_event_id)
        if event is None or event.session_id != session_id or not event.trace_record_id:
            raise FileHistoryError(
                FileHistoryErrorCode.SNAPSHOT_MISSING,
                "消息事件没有可用 trace",
            )
        trace = self.repositories.trace_records.get(event.trace_record_id)
        if trace is None:
            raise FileHistoryError(
                FileHistoryErrorCode.SNAPSHOT_MISSING,
                "消息事件没有可用 trace",
            )
        return SessionReverseSource(
            session_id=session_id,
            active_session_id=trace.active_session_id or session_id,
            checkpoint_id=trace.input_checkpoint_id,
            checkpoint_ns=trace.input_checkpoint_ns or "",
            trace_id=trace.trace_id,
            turn_index=trace.turn_index,
            message_event_id=event.id,
            source_type="message_event",
        )

    def _require_operation(
        self,
        session_id: str,
        request: SessionReverseExecution,
    ) -> FileHistoryOperationRecord:
        operation = self.repositories.file_history.get_operation(request.operation_id)
        if operation is None or operation.session_id != session_id:
            raise FileHistoryError(
                FileHistoryErrorCode.SNAPSHOT_MISSING,
                "文件回溯 operation 不存在",
                http_status=404,
            )
        if operation.target_message_event_id != request.message_event_id:
            raise FileHistoryError(
                FileHistoryErrorCode.PREVIEW_STALE,
                "operation 与消息锚点不一致",
            )
        return operation

    def _select_files(
        self,
        operation: FileHistoryOperationRecord,
        *,
        mode: FileRestoreMode,
        decision: FileRestoreDecision,
    ) -> tuple[tuple[str, ...], tuple[str, ...], tuple[FileHistoryOperationFileRecord, ...]]:
        files = self.repositories.file_history.list_operation_files(operation.id)
        if mode == FileRestoreMode.CONVERSATION or decision in {
            FileRestoreDecision.CONVERSATION_ONLY,
            FileRestoreDecision.CANCEL,
        }:
            return (), (), tuple(files)
        unrecoverable = [
            item for item in files if item.classification == FileClassification.UNRECOVERABLE
        ]
        conflicts = [
            item
            for item in files
            if item.classification == FileClassification.FORCEABLE_CONFLICT
        ]
        if decision == FileRestoreDecision.FULL and unrecoverable:
            raise FileHistoryError(
                FileHistoryErrorCode.UNRECOVERABLE,
                "部分文件无法回溯，需要二次确认",
                details={"files": [item.display_path for item in unrecoverable]},
            )
        if decision == FileRestoreDecision.FULL and conflicts:
            raise FileHistoryError(
                FileHistoryErrorCode.CONFLICT,
                "部分文件存在冲突，需要二次确认",
                details={"files": [item.display_path for item in conflicts]},
            )
        allowed = {FileClassification.READY}
        if decision == FileRestoreDecision.FORCE_CONFLICTS:
            allowed.add(FileClassification.FORCEABLE_CONFLICT)
        selected_items = [item for item in files if item.classification in allowed]
        selected = tuple(
            FileResourceIdentity(
                item.scope_kind,
                item.scope_identity,
                item.canonical_path,
            ).resource_id
            for item in selected_items
        )
        forced = tuple(
            FileResourceIdentity(
                item.scope_kind,
                item.scope_identity,
                item.canonical_path,
            ).resource_id
            for item in selected_items
            if item.classification == FileClassification.FORCEABLE_CONFLICT
        )
        selected_set = set(selected)
        skipped = tuple(
            item
            for item in files
            if FileResourceIdentity(
                item.scope_kind,
                item.scope_identity,
                item.canonical_path,
            ).resource_id
            not in selected_set
        )
        return selected, forced, skipped

    def _mark_skipped(
        self,
        operation_id: str,
        files: tuple[FileHistoryOperationFileRecord, ...],
    ) -> None:
        for item in files:
            self.repositories.file_history.update_operation_file(
                operation_id,
                item.canonical_path,
                scope_kind=item.scope_kind,
                scope_identity=item.scope_identity,
                result_state=FileOperationFileStatus.SKIPPED,
                error_code=item.reason_code or "not_selected",
            )

    def _compensate_and_raise(
        self,
        *,
        operation_id: str,
        workspace_root: str | Path,
        cause: Exception,
        error_code: FileHistoryErrorCode,
        message: str,
    ) -> None:
        try:
            self.file_history.compensate_operation(
                operation_id=operation_id,
                workspace_root=workspace_root,
            )
        except FileHistoryError:
            raise
        raise FileHistoryError(
            error_code,
            message,
            details={"operation_id": operation_id, "compensated": True},
        ) from cause

    def _result_from_operation(
        self,
        operation: FileHistoryOperationRecord,
        *,
        restored_input: str | None = None,
        source: dict[str, Any] | None = None,
    ) -> FileRestoreResult:
        detail = operation.error_detail or {}
        if restored_input is None and "restored_input" in detail:
            raw_input = detail.get("restored_input")
            restored_input = None if raw_input is None else str(raw_input)
        if source is None and isinstance(detail.get("source"), dict):
            source = dict(detail["source"])
        files = self.repositories.file_history.list_operation_files(operation.id)
        def resource_id(item: FileHistoryOperationFileRecord) -> str:
            return FileResourceIdentity(
                item.scope_kind,
                item.scope_identity,
                item.canonical_path,
            ).resource_id
        restored = tuple(
            resource_id(item)
            for item in files
            if item.result_state == FileOperationFileStatus.RESTORED
        )
        forced = tuple(
            resource_id(item)
            for item in files
            if item.result_state == FileOperationFileStatus.FORCED
        )
        skipped = tuple(
            resource_id(item)
            for item in files
            if item.result_state == FileOperationFileStatus.SKIPPED
        )
        failed = tuple(
            resource_id(item)
            for item in files
            if item.result_state == FileOperationFileStatus.FAILED
        )
        return FileRestoreResult(
            operation_id=operation.id,
            status=FileOperationStatus(operation.state),
            mode=FileRestoreMode(operation.mode or FileRestoreMode.CONVERSATION),
            decision=FileRestoreDecision(operation.decision or FileRestoreDecision.FULL),
            conversation_rewound=operation.conversation_rewound,
            restored_files=restored,
            skipped_files=skipped,
            forced_files=forced,
            failed_files=failed,
            restored_input=restored_input,
            source=dict(source or {}),
            error_code=operation.error_code,
        )
