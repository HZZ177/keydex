from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.app.agent.tool_results.budgets import approximate_tokens
from backend.app.agent.tool_results.projectors import make_json_serializable
from backend.app.core.ids import new_id
from backend.app.storage import StorageRepositories, ToolResultArtifactRecord
from backend.app.tools.base import ToolExecutionContext


@dataclass(frozen=True, slots=True)
class PersistedToolResultRef:
    artifact_id: str
    storage_kind: str
    content_type: str
    content_bytes: int
    content_sha256: str
    is_complete: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifact_id": self.artifact_id,
            "storage_kind": self.storage_kind,
            "content_type": self.content_type,
            "content_bytes": self.content_bytes,
            "content_sha256": self.content_sha256,
            "is_complete": self.is_complete,
        }


class ToolResultArtifactRepository:
    def __init__(self, *, repositories: StorageRepositories, data_dir: Path | str) -> None:
        self.repositories = repositories
        self.data_dir = Path(data_dir).resolve(strict=False)
        self.context_root = (self.data_dir / "tool-results" / "context").resolve(strict=False)
        self.command_root = (self.data_dir / "tool-results" / "commands").resolve(strict=False)

    def ensure_persisted(
        self,
        value: Any,
        *,
        context: ToolExecutionContext,
        tool_name: str,
        is_complete: bool = True,
    ) -> PersistedToolResultRef:
        payload, storage_kind, suffix, content_type = _serialize_value(value)
        sha256 = hashlib.sha256(payload).hexdigest()
        tool_call_id = _tool_call_id(context, sha256)
        existing = self.repositories.tool_result_artifacts.find_by_source(
            source_session_id=context.session_id,
            tool_call_id=tool_call_id,
            content_sha256=sha256,
        )
        if existing is not None and existing.status == "active":
            self.repositories.tool_result_artifacts.grant(
                artifact_id=existing.id,
                session_id=context.session_id,
            )
            return _ref(existing)

        artifact_id = f"tra_{new_id()}"
        relative_path = Path("tool-results") / "context" / f"{artifact_id}{suffix}"
        final_path = self._managed_path(relative_path)
        temp_path = final_path.with_name(f".{final_path.name}.{new_id()}.tmp")
        final_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with temp_path.open("xb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            temp_path.replace(final_path)
            record = self.repositories.tool_result_artifacts.create_or_get(
                artifact_id=artifact_id,
                owner_user_id=context.user_id,
                source_session_id=context.session_id,
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                storage_kind=storage_kind,
                relative_path=relative_path.as_posix(),
                content_type=content_type,
                content_sha256=sha256,
                content_bytes=len(payload),
                approximate_tokens=approximate_tokens(len(payload)),
                is_complete=is_complete,
            )
            if record.id != artifact_id:
                final_path.unlink(missing_ok=True)
            self.repositories.tool_result_artifacts.grant(
                artifact_id=record.id,
                session_id=context.session_id,
            )
            return _ref(record)
        except Exception:
            temp_path.unlink(missing_ok=True)
            final_path.unlink(missing_ok=True)
            raise

    def register_command_log(
        self,
        path: Path | str,
        *,
        context: ToolExecutionContext,
        tool_name: str,
        is_complete: bool,
    ) -> PersistedToolResultRef:
        command_path = Path(path).resolve(strict=True)
        _require_within(command_path, self.command_root)
        payload = command_path.read_bytes()
        sha256 = hashlib.sha256(payload).hexdigest()
        tool_call_id = _tool_call_id(context, sha256)
        relative_path = command_path.relative_to(self.data_dir).as_posix()
        record = self.repositories.tool_result_artifacts.create_or_get(
            artifact_id=f"tra_{new_id()}",
            owner_user_id=context.user_id,
            source_session_id=context.session_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            storage_kind="command_log",
            relative_path=relative_path,
            content_type="text/plain; charset=utf-8",
            content_sha256=sha256,
            content_bytes=len(payload),
            approximate_tokens=approximate_tokens(len(payload)),
            is_complete=is_complete,
        )
        self.repositories.tool_result_artifacts.grant(
            artifact_id=record.id,
            session_id=context.session_id,
        )
        return _ref(record)

    def _managed_path(self, relative_path: Path) -> Path:
        candidate = (self.data_dir / relative_path).resolve(strict=False)
        _require_within(candidate, self.context_root)
        return candidate


def artifact_repository_from_context(
    context: ToolExecutionContext,
) -> ToolResultArtifactRepository | None:
    explicit = context.metadata.get("tool_result_artifact_repository")
    if isinstance(explicit, ToolResultArtifactRepository):
        return explicit
    repositories = context.metadata.get("repositories")
    data_dir = context.metadata.get("data_dir")
    if isinstance(repositories, StorageRepositories) and data_dir:
        return ToolResultArtifactRepository(repositories=repositories, data_dir=Path(str(data_dir)))
    return None


def _serialize_value(value: Any) -> tuple[bytes, str, str, str]:
    if isinstance(value, str):
        return value.encode("utf-8"), "managed_text", ".txt", "text/plain; charset=utf-8"
    payload = json.dumps(
        make_json_serializable(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return payload, "managed_json", ".json", "application/json"


def _tool_call_id(context: ToolExecutionContext, sha256: str) -> str:
    return context.tool_call_id or str(context.metadata.get("run_id") or f"unbound:{sha256[:24]}")


def _require_within(path: Path, root: Path) -> None:
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise ValueError("tool result artifact path escapes its managed root") from exc


def _ref(record: ToolResultArtifactRecord) -> PersistedToolResultRef:
    return PersistedToolResultRef(
        artifact_id=record.id,
        storage_kind=record.storage_kind,
        content_type=record.content_type,
        content_bytes=record.content_bytes,
        content_sha256=record.content_sha256,
        is_complete=record.is_complete,
    )
