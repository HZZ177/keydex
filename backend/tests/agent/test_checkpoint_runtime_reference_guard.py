from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from backend.app.storage import init_database

PROJECT_ROOT = Path(__file__).resolve().parents[3]
APP_ROOT = PROJECT_ROOT / "backend" / "app"
E2E_HELPER = PROJECT_ROOT / "backend" / "tests" / "e2e_keydex_server.py"

LEGACY_V2_ALLOWLIST = {
    Path("agent/checkpoint.py"),
    Path("agent/checkpoint_migration.py"),
    Path("agent/checkpoint_migration_collapse.py"),
    Path("agent/checkpoint_migration_copy.py"),
    Path("agent/checkpoint_migration_swap.py"),
    Path("storage/db.py"),
}


def _python_sources(root: Path) -> dict[Path, str]:
    return {
        path.relative_to(root): path.read_text(encoding="utf-8")
        for path in root.rglob("*.py")
    }


def test_application_runtime_has_no_retired_sync_saver_reference() -> None:
    offenders = [
        str(path)
        for path, source in _python_sources(APP_ROOT).items()
        if re.search(r"\bSQLiteCheckpointSaver\b", source)
    ]
    assert offenders == []


def test_legacy_v2_table_names_are_confined_to_migration_boundary() -> None:
    offenders = [
        str(path)
        for path, source in _python_sources(APP_ROOT).items()
        if (
            "checkpoints_v2" in source or "checkpoint_writes_v2" in source
        )
        and path not in LEGACY_V2_ALLOWLIST
    ]
    assert offenders == []


def test_services_and_api_do_not_construct_or_call_sync_checkpoint_saver() -> None:
    checked_roots = (APP_ROOT / "services", APP_ROOT / "api")
    forbidden = (
        re.compile(r"\bAsyncSqliteSaver\s*\("),
        re.compile(r"\.get_tuple\s*\("),
        re.compile(r"\.put_writes\s*\("),
        re.compile(r"\.delete_thread\s*\("),
    )
    offenders: list[str] = []
    for root in checked_roots:
        for path, source in _python_sources(root).items():
            if any(pattern.search(source) for pattern in forbidden):
                offenders.append(str(root.relative_to(APP_ROOT) / path))
    assert offenders == []


def test_e2e_helper_uses_graph_state_api_only() -> None:
    source = E2E_HELPER.read_text(encoding="utf-8")
    assert "build_checkpoint_state_graph" in source
    assert ".aget_state(" in source
    assert ".aupdate_state(" in source
    assert ".get_tuple(" not in source
    assert "replace_checkpoint_state" not in source
    assert "checkpoints_v2" not in source
    assert "checkpoint_writes_v2" not in source


def test_fresh_database_creates_only_empty_guarded_v2_compatibility_shells(
    tmp_path: Path,
) -> None:
    database = init_database(tmp_path / "app.db")
    with sqlite3.connect(database.path) as connection:
        tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        legacy_rows = connection.execute(
            """
            select
              (select count(*) from checkpoints_v2)
              + (select count(*) from checkpoint_writes_v2)
            """
        ).fetchone()[0]
    assert {
        "checkpoint_backend_guard",
        "checkpoints_v2",
        "checkpoint_writes_v2",
    } <= tables
    assert legacy_rows == 0
