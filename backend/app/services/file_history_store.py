from __future__ import annotations

import hashlib
import os
import re
import shutil
import stat
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from backend.app.core.time import to_iso_z, utc_now

_SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9._@-]+$")
_COPY_BUFFER_BYTES = 1024 * 1024


class FileHistoryStoreError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class FileHistoryBackup:
    state: str
    backup_file_name: str | None
    version: int
    backup_time: str
    size: int | None
    mode: int | None
    content_hash: str | None


class FileHistoryStore:
    def __init__(self, data_dir: str | Path) -> None:
        self.root = Path(data_dir).expanduser().resolve() / "file-history"

    @staticmethod
    def backup_file_name(canonical_path: str, version: int) -> str:
        if version < 1:
            raise ValueError("file history version must be positive")
        digest = hashlib.sha256(canonical_path.encode("utf-8")).hexdigest()[:16]
        return f"{digest}@v{version}"

    def create_backup(
        self,
        *,
        session_id: str,
        canonical_path: str,
        source_path: Path,
        version: int,
    ) -> FileHistoryBackup:
        now = to_iso_z(utc_now())
        try:
            before = source_path.stat()
        except FileNotFoundError:
            return FileHistoryBackup(
                state="missing",
                backup_file_name=None,
                version=version,
                backup_time=now,
                size=None,
                mode=None,
                content_hash=None,
            )
        except OSError as exc:
            raise FileHistoryStoreError(
                "source_metadata_unreadable",
                "无法读取待备份文件元数据",
            ) from exc
        if not stat.S_ISREG(before.st_mode):
            raise FileHistoryStoreError(
                "source_not_regular_file",
                "文件回溯只支持普通文件",
            )

        backup_name = self.backup_file_name(canonical_path, version)
        destination = self.resolve_backup_path(session_id, backup_name)
        digest, copied_size = self._copy_immutable(source_path, destination)
        try:
            after = source_path.stat()
        except OSError as exc:
            destination.unlink(missing_ok=True)
            raise FileHistoryStoreError(
                "source_changed_during_backup",
                "备份期间源文件发生变化",
            ) from exc
        if (
            before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
            or copied_size != after.st_size
        ):
            destination.unlink(missing_ok=True)
            raise FileHistoryStoreError(
                "source_changed_during_backup",
                "备份期间源文件发生变化",
            )
        mode = stat.S_IMODE(before.st_mode)
        try:
            os.chmod(destination, mode)
        except OSError as exc:
            destination.unlink(missing_ok=True)
            raise FileHistoryStoreError("backup_mode_failed", "无法保存备份文件权限") from exc
        return FileHistoryBackup(
            state="file",
            backup_file_name=backup_name,
            version=version,
            backup_time=now,
            size=copied_size,
            mode=mode,
            content_hash=digest,
        )

    def create_safety_backup(
        self,
        *,
        operation_id: str,
        canonical_path: str,
        source_path: Path,
    ) -> FileHistoryBackup:
        now = to_iso_z(utc_now())
        try:
            metadata = source_path.stat()
        except FileNotFoundError:
            return FileHistoryBackup("missing", None, 1, now, None, None, None)
        except OSError as exc:
            raise FileHistoryStoreError(
                "safety_source_unreadable",
                "无法读取恢复前文件",
            ) from exc
        if not stat.S_ISREG(metadata.st_mode):
            raise FileHistoryStoreError(
                "safety_source_not_regular_file",
                "恢复前目标不是普通文件",
            )
        path_hash = hashlib.sha256(canonical_path.encode("utf-8")).hexdigest()
        relative_name = f"operations/{self._safe_component(operation_id)}/safety/{path_hash}"
        destination = self.root / Path(relative_name)
        digest, copied_size = self._copy_immutable(source_path, destination)
        mode = stat.S_IMODE(metadata.st_mode)
        os.chmod(destination, mode)
        return FileHistoryBackup(
            "file",
            relative_name.replace("\\", "/"),
            1,
            now,
            copied_size,
            mode,
            digest,
        )

    def resolve_backup_path(self, session_id: str, backup_file_name: str) -> Path:
        session = self._safe_component(session_id)
        name = self._safe_component(backup_file_name)
        return self.root / session / name

    def resolve_artifact_path(self, session_id: str, backup_file_name: str) -> Path:
        normalized = backup_file_name.replace("\\", "/")
        if normalized.startswith("operations/"):
            candidate = (self.root / Path(normalized)).resolve(strict=False)
            if not candidate.is_relative_to(self.root):
                raise FileHistoryStoreError("backup_path_unsafe", "备份路径越界")
            return candidate
        return self.resolve_backup_path(session_id, normalized)

    def verify_backup(
        self,
        *,
        session_id: str,
        backup_file_name: str,
        expected_hash: str,
        expected_size: int,
    ) -> Path:
        path = self.resolve_artifact_path(session_id, backup_file_name)
        try:
            metadata = path.stat()
        except FileNotFoundError as exc:
            raise FileHistoryStoreError("backup_missing", "文件回溯备份不存在") from exc
        except OSError as exc:
            raise FileHistoryStoreError("backup_unreadable", "文件回溯备份无法读取") from exc
        if not stat.S_ISREG(metadata.st_mode):
            raise FileHistoryStoreError("backup_not_regular_file", "文件回溯备份不是普通文件")
        if metadata.st_size != expected_size:
            raise FileHistoryStoreError("backup_corrupt", "文件回溯备份大小校验失败")
        actual_hash, actual_size = self.hash_file(path)
        if actual_size != expected_size or actual_hash != expected_hash:
            raise FileHistoryStoreError("backup_corrupt", "文件回溯备份内容校验失败")
        return path

    def restore_backup(
        self,
        *,
        session_id: str,
        backup: FileHistoryBackup,
        destination: Path,
    ) -> bool:
        if backup.state == "missing":
            try:
                metadata = destination.lstat()
            except FileNotFoundError:
                return False
            if not stat.S_ISREG(metadata.st_mode):
                raise FileHistoryStoreError(
                    "restore_target_not_regular_file",
                    "待删除恢复目标不是普通文件",
                )
            destination.unlink()
            return True
        if (
            backup.backup_file_name is None
            or backup.content_hash is None
            or backup.size is None
        ):
            raise FileHistoryStoreError("backup_metadata_invalid", "文件回溯备份元数据不完整")
        source = self.verify_backup(
            session_id=session_id,
            backup_file_name=backup.backup_file_name,
            expected_hash=backup.content_hash,
            expected_size=backup.size,
        )
        if destination.exists() and destination.is_file():
            current_hash, current_size = self.hash_file(destination)
            if current_hash == backup.content_hash and current_size == backup.size:
                if backup.mode is not None:
                    os.chmod(destination, backup.mode)
                return False
        destination.parent.mkdir(parents=True, exist_ok=True)
        temp = destination.parent / f".{destination.name}.file-history-{uuid.uuid4().hex}.tmp"
        try:
            with source.open("rb") as reader, temp.open("xb") as writer:
                shutil.copyfileobj(reader, writer, length=_COPY_BUFFER_BYTES)
                writer.flush()
                os.fsync(writer.fileno())
            if backup.mode is not None:
                os.chmod(temp, backup.mode)
            os.replace(temp, destination)
        except Exception:
            temp.unlink(missing_ok=True)
            raise
        return True

    @staticmethod
    def hash_file(path: Path) -> tuple[str, int]:
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as stream:
            while chunk := stream.read(_COPY_BUFFER_BYTES):
                digest.update(chunk)
                size += len(chunk)
        return digest.hexdigest(), size

    def usage_bytes(self) -> int:
        total = 0
        if not self.root.exists():
            return total
        for path in self.root.rglob("*"):
            try:
                if path.is_file():
                    total += path.stat().st_size
            except OSError:
                continue
        return total

    def cleanup_orphans(
        self,
        referenced_paths: set[str],
        *,
        orphan_grace_seconds: int = 86_400,
        now: datetime | None = None,
    ) -> tuple[str, ...]:
        """Delete stale temporary or unreferenced artifacts, never pinned files."""

        if not self.root.exists():
            return ()
        current = now or datetime.now(UTC)
        cutoff = current - timedelta(seconds=max(0, orphan_grace_seconds))
        normalized_refs = {item.replace("\\", "/").lstrip("/") for item in referenced_paths}
        deleted: list[str] = []
        for path in sorted(self.root.rglob("*"), key=lambda item: len(item.parts), reverse=True):
            try:
                if path.is_dir():
                    path.rmdir()
                    continue
                relative = path.relative_to(self.root).as_posix()
                modified = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
                is_temp = path.name.endswith(".tmp") or ".tmp" in path.name
                if relative in normalized_refs or modified > cutoff:
                    continue
                if is_temp or relative not in normalized_refs:
                    path.unlink()
                    deleted.append(relative)
            except (FileNotFoundError, OSError):
                continue
        return tuple(sorted(deleted))

    def _copy_immutable(self, source: Path, destination: Path) -> tuple[str, int]:
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            existing_hash, existing_size = self.hash_file(destination)
            source_hash, source_size = self.hash_file(source)
            if existing_hash == source_hash and existing_size == source_size:
                return existing_hash, existing_size
            raise FileHistoryStoreError(
                "backup_version_collision",
                "同一文件版本的不可变备份已存在且内容不同",
            )
        temp = destination.parent / f".{destination.name}.{uuid.uuid4().hex}.tmp"
        digest = hashlib.sha256()
        copied_size = 0
        try:
            with source.open("rb") as reader, temp.open("xb") as writer:
                while chunk := reader.read(_COPY_BUFFER_BYTES):
                    writer.write(chunk)
                    digest.update(chunk)
                    copied_size += len(chunk)
                writer.flush()
                os.fsync(writer.fileno())
            os.replace(temp, destination)
        except Exception:
            temp.unlink(missing_ok=True)
            raise
        return digest.hexdigest(), copied_size

    @staticmethod
    def _safe_component(value: str) -> str:
        if not value or not _SAFE_COMPONENT.fullmatch(value):
            raise FileHistoryStoreError("backup_path_unsafe", "备份路径组件不安全")
        return value
