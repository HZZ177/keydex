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
        with service.controlled_write_lease(
            session_id=context.session_id,
            workspace_root=context.workspace_root,
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
            except Exception:
                service.abort_writes(prepared)
                raise
            try:
                service.commit_writes(prepared, workspace_root=context.workspace_root)
            except Exception:
                service.abort_writes(prepared, error_code="tool_write_commit_failed")
                raise
    except ToolExecutionError:
        raise
    except FileHistoryError as exc:
        raise ToolExecutionError(str(exc), code=exc.code, details=exc.details) from exc
    except Exception as exc:
        raise ToolExecutionError(
            "文件已写入，但文件历史提交失败",
            code="file_history_commit_failed",
            details={"tool": tool_name, "reason": type(exc).__name__},
        ) from exc
