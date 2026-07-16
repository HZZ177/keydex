from __future__ import annotations

from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

from backend.app.core.ids import new_id
from backend.app.services.file_history_service import FileHistoryError, FileMutationSpec
from backend.app.tools.base import ToolExecutionContext, ToolExecutionError


@contextmanager
def tracked_file_mutation(
    context: ToolExecutionContext,
    *,
    tool_name: str,
    changes: Sequence[tuple[Path, str]],
) -> Iterator[None]:
    """Run one controlled tool mutation under the shared history hook."""

    if not context.file_history_tracking:
        yield
        return
    service, snapshot_id = context.require_file_history()
    batch_id = new_id() if len(changes) > 1 else None
    prepared = []
    try:
        resource_keys = service.resolve_resource_keys(
            context.workspace_root,
            [path for path, _ in changes],
        )
        with service.controlled_write_lease(
            session_id=context.session_id,
            workspace_root=context.workspace_root,
            resource_keys=resource_keys,
        ):
            prepared = service.prepare_writes(
                session_id=context.session_id,
                active_session_id=context.active_session_id,
                snapshot_id=snapshot_id,
                trace_id=context.trace_id,
                turn_index=context.turn_index,
                workspace_root=context.workspace_root,
                tool_name=tool_name,
                tool_call_id=context.tool_call_id,
                mutations=[FileMutationSpec(path=path, kind=kind) for path, kind in changes],
                batch_id=batch_id,
            )
            try:
                yield
            except Exception as body_error:
                try:
                    restored = service.compensate_writes(
                        prepared,
                        workspace_root=context.workspace_root,
                        error_code="file_operation_failed_compensated",
                    )
                except FileHistoryError:
                    raise
                compensated_details = {
                    "tool": tool_name,
                    "reason": type(body_error).__name__,
                    "paths": [str(path) for path, _kind in changes],
                    "restored_resource_ids": list(restored),
                    "compensated": True,
                }
                if isinstance(body_error, OSError):
                    compensated_details["os_error"] = str(body_error)
                if isinstance(body_error, ToolExecutionError):
                    raise ToolExecutionError(
                        str(body_error),
                        code=body_error.code,
                        details={**body_error.details, **compensated_details},
                    ) from body_error
                message = (
                    "文件操作未完成：目标路径不可访问或权限不足；"
                    "历史补偿已完成，未保留本次文件变更"
                    if isinstance(body_error, PermissionError)
                    else "文件操作未完成；历史补偿已完成，已恢复全部文件写入前状态"
                )
                raise FileHistoryError(
                    "file_operation_failed_compensated",
                    message,
                    details=compensated_details,
                ) from body_error
            try:
                service.commit_writes(prepared, workspace_root=context.workspace_root)
            except Exception as commit_error:
                restored = service.compensate_writes(
                    prepared,
                    workspace_root=context.workspace_root,
                    error_code="file_history_commit_compensated",
                )
                raise FileHistoryError(
                    "file_history_commit_compensated",
                    "文件操作未完成：历史提交失败，已恢复全部文件写前状态",
                    details={
                        "restored_resource_ids": list(restored),
                        "commit_error": type(commit_error).__name__,
                    },
                ) from commit_error
    except ToolExecutionError:
        raise
    except FileHistoryError as exc:
        raise ToolExecutionError(str(exc), code=exc.code, details=exc.details) from exc
    except Exception as exc:
        if not prepared:
            raise ToolExecutionError(
                "文件操作未开始：写前历史准备失败，目标文件未被修改",
                code="file_history_preflight_failed",
                details={"tool": tool_name, "reason": type(exc).__name__},
            ) from exc
        raise ToolExecutionError(
            "文件操作失败，且无法确认历史事务状态",
            code="file_history_commit_failed",
            details={"tool": tool_name, "reason": type(exc).__name__},
        ) from exc
