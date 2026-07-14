from __future__ import annotations

import os
import stat

import pytest

from backend.app.services.file_history_store import FileHistoryStore, FileHistoryStoreError


def test_file_history_store_distinguishes_missing_empty_and_binary(tmp_path) -> None:
    store = FileHistoryStore(tmp_path / "data")
    missing = store.create_backup(
        session_id="session-1",
        canonical_path="missing.bin",
        source_path=tmp_path / "missing.bin",
        version=1,
    )
    empty_path = tmp_path / "empty.bin"
    empty_path.write_bytes(b"")
    empty = store.create_backup(
        session_id="session-1",
        canonical_path="empty.bin",
        source_path=empty_path,
        version=1,
    )
    binary_path = tmp_path / "binary.bin"
    binary_path.write_bytes(bytes(range(256)) * 4096)
    binary = store.create_backup(
        session_id="session-1",
        canonical_path="binary.bin",
        source_path=binary_path,
        version=1,
    )

    assert missing.state == "missing" and missing.backup_file_name is None
    assert empty.state == "file" and empty.size == 0 and empty.content_hash
    assert binary.state == "file" and binary.size == 256 * 4096


def test_file_history_store_restore_is_atomic_and_restores_mode(tmp_path) -> None:
    store = FileHistoryStore(tmp_path / "data")
    source = tmp_path / "source.txt"
    source.write_bytes(b"before\x00content")
    os.chmod(source, 0o640)
    backup = store.create_backup(
        session_id="session-1",
        canonical_path="source.txt",
        source_path=source,
        version=1,
    )
    source.write_bytes(b"after")
    os.chmod(source, 0o600)

    assert store.restore_backup(
        session_id="session-1", backup=backup, destination=source
    )
    assert source.read_bytes() == b"before\x00content"
    if os.name != "nt":
        assert stat.S_IMODE(source.stat().st_mode) == 0o640


def test_file_history_store_detects_tamper_and_never_overwrites_version(tmp_path) -> None:
    store = FileHistoryStore(tmp_path / "data")
    source = tmp_path / "source.txt"
    source.write_text("version one", encoding="utf-8")
    backup = store.create_backup(
        session_id="session-1",
        canonical_path="source.txt",
        source_path=source,
        version=1,
    )
    source.write_text("different", encoding="utf-8")
    with pytest.raises(FileHistoryStoreError) as collision:
        store.create_backup(
            session_id="session-1",
            canonical_path="source.txt",
            source_path=source,
            version=1,
        )
    assert collision.value.code == "backup_version_collision"

    backup_path = store.resolve_backup_path("session-1", backup.backup_file_name or "")
    backup_path.write_text("tampered!", encoding="utf-8")
    with pytest.raises(FileHistoryStoreError) as corrupt:
        store.verify_backup(
            session_id="session-1",
            backup_file_name=backup.backup_file_name or "",
            expected_hash=backup.content_hash or "",
            expected_size=backup.size or 0,
        )
    assert corrupt.value.code == "backup_corrupt"


def test_file_history_store_safety_backup_uses_operation_scope(tmp_path) -> None:
    store = FileHistoryStore(tmp_path / "data")
    source = tmp_path / "file.txt"
    source.write_text("current", encoding="utf-8")
    backup = store.create_safety_backup(
        operation_id="operation-1",
        canonical_path="file.txt",
        source_path=source,
    )
    assert backup.backup_file_name is not None
    assert backup.backup_file_name.startswith("operations/operation-1/safety/")
    assert store.verify_backup(
        session_id="ignored",
        backup_file_name=backup.backup_file_name,
        expected_hash=backup.content_hash or "",
        expected_size=backup.size or 0,
    ).is_file()
