from __future__ import annotations

from pathlib import Path

from backend.packaging import build_agent_server

PROJECT_ROOT = Path(__file__).resolve().parents[3]
RUNBOOK = PROJECT_ROOT / "docs" / "checkpoint-async-sqlite-migration-runbook.md"
RELEASE_NOTES = PROJECT_ROOT / ".github" / "release-notes" / "v0.5.4.md"
RELEASE_WORKFLOW = PROJECT_ROOT / ".github" / "workflows" / "windows-release.yml"


def test_migration_runbook_covers_irreversible_operation_and_recovery_contract() -> None:
    content = RUNBOOK.read_text(encoding="utf-8")

    required_fragments = (
        "不可关闭",
        "只显示一个总进度条和整数百分比",
        "迁移边界之前的指定 checkpoint fork、reverse",
        "64 MiB",
        "checkpoint_migration_insufficient_space",
        "checkpoint_migration_source_changed",
        "checkpoint_migration_hydrate_failed",
        "checkpoint_migration_swap_failed",
        "checkpoint_migration_recovery_required",
        "prepared",
        "source_backed_up",
        "target_active",
        "成功后会立即",
        "不提供 official checkpoint 到 v2",
        "Keydex 会话数据已升级，请使用当前版本或更高版本打开",
        "checkpoint-release-gate.json",
        "checkpoint-storage-growth.json",
    )
    for fragment in required_fragments:
        assert fragment in content


def test_release_notes_explain_visible_migration_and_history_boundary() -> None:
    content = RELEASE_NOTES.read_text(encoding="utf-8")

    assert "AsyncSqliteSaver" in content
    assert "不可跳过" in content
    assert "总进度" in content
    assert "100%" in content
    assert "历史会话的可见对话" in content
    assert "指定历史 checkpoint fork" in content
    assert "旧版 Keydex 写入" in content


def test_release_workflow_and_sidecar_packaging_include_migration_delivery_inputs() -> None:
    workflow = RELEASE_WORKFLOW.read_text(encoding="utf-8")
    sidecar_inputs = {
        path.relative_to(PROJECT_ROOT).as_posix()
        for path in build_agent_server.iter_sidecar_inputs()
    }

    assert ".github/release-notes/v$version.md" in workflow
    assert RELEASE_NOTES.is_file()
    assert "backend.app.agent" in build_agent_server.PYINSTALLER_COLLECT_SUBMODULES
    assert {
        "backend/app/agent/checkpoint_migration.py",
        "backend/app/agent/checkpoint_migration_collapse.py",
        "backend/app/agent/checkpoint_migration_copy.py",
        "backend/app/agent/checkpoint_migration_swap.py",
        "backend/app/api/checkpoint_migration.py",
    } <= sidecar_inputs
