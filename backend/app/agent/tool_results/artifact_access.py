from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

from backend.app.storage import StorageRepositories, ToolResultArtifactRecord
from backend.app.tools.base import ToolExecutionError


@dataclass(frozen=True, slots=True)
class VerifiedToolResultArtifact:
    record: ToolResultArtifactRecord
    path: Path


class ToolResultArtifactAccess:
    def __init__(self, *, repositories: StorageRepositories, data_dir: Path | str) -> None:
        self.repositories = repositories
        self.data_dir = Path(data_dir).resolve(strict=False)

    def verify(
        self,
        artifact_id: str,
        *,
        user_id: str,
        session_id: str,
    ) -> VerifiedToolResultArtifact:
        try:
            record = self.repositories.tool_result_artifacts.get(artifact_id)
            if record is None or record.status != "active":
                raise ValueError("inactive artifact")
            if record.owner_user_id != user_id:
                raise ValueError("owner mismatch")
            if not self.repositories.tool_result_artifacts.has_grant(
                artifact_id=artifact_id,
                session_id=session_id,
            ):
                raise ValueError("grant missing")
            path = self._resolve_record_path(record)
            if not path.is_file() or _is_link_like(path, stop=self.data_dir):
                raise ValueError("unsafe artifact file")
            stat = path.stat()
            if stat.st_size != record.content_bytes:
                raise ValueError("artifact size mismatch")
            if hashlib.sha256(path.read_bytes()).hexdigest() != record.content_sha256:
                raise ValueError("artifact digest mismatch")
        except Exception as exc:
            if isinstance(exc, ToolExecutionError):
                raise
            raise ToolExecutionError(
                "工具结果不可用或无权访问",
                code="tool_result_artifact_unavailable",
                details={"artifact_id": artifact_id},
            ) from exc
        return VerifiedToolResultArtifact(record=record, path=path)

    def _resolve_record_path(self, record: ToolResultArtifactRecord) -> Path:
        raw = Path(record.relative_path)
        if raw.is_absolute() or ".." in raw.parts:
            raise ValueError("invalid artifact relative path")
        lexical_path = self.data_dir / raw
        if _is_link_like(lexical_path, stop=self.data_dir):
            raise ValueError("artifact path contains link-like component")
        path = lexical_path.resolve(strict=False)
        expected_root = (
            self.data_dir / "tool-results" / "commands"
            if record.storage_kind == "command_log"
            else self.data_dir / "tool-results" / "context"
        ).resolve(strict=False)
        try:
            path.relative_to(expected_root)
        except ValueError as exc:
            raise ValueError("artifact path escapes managed root") from exc
        return path


def _is_link_like(path: Path, *, stop: Path) -> bool:
    current = path
    stop_resolved = stop.resolve(strict=False)
    while True:
        if current.is_symlink():
            return True
        is_junction = getattr(current, "is_junction", None)
        if callable(is_junction) and is_junction():
            return True
        if current == stop_resolved or current.parent == current:
            return False
        current = current.parent
