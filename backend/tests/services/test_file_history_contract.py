from __future__ import annotations

from backend.app.services.file_history_service import (
    FileClassification,
    FileHistoryError,
    FileHistoryErrorCode,
    FileOperationStatus,
    FilePreviewItem,
    FileRestoreDecision,
    FileRestoreMode,
    FileRestorePreview,
    FileRestoreResult,
)


def test_file_history_contract_uses_stable_enum_values() -> None:
    assert {item.value for item in FileRestoreMode} == {"both", "code", "conversation"}
    assert {item.value for item in FileRestoreDecision} == {
        "full",
        "safe_partial",
        "force_conflicts",
        "conversation_only",
        "cancel",
    }
    assert {item.value for item in FileClassification} == {
        "ready",
        "forceable_conflict",
        "unrecoverable",
    }


def test_file_history_preview_and_result_do_not_expose_backup_paths() -> None:
    item = FilePreviewItem(
        path="src/file.txt",
        current_state="file",
        target_state="missing",
        classification=FileClassification.FORCEABLE_CONFLICT,
        reason_code="other_session_write",
        current_hash="current",
    )
    preview = FileRestorePreview(
        operation_id="operation-1",
        source={"message_event_id": "message-1"},
        conversation_available=True,
        code_available=True,
        default_mode=FileRestoreMode.BOTH,
        snapshot_id="snapshot-1",
        preview_token="token",
        files=(item,),
    ).to_dict()
    result = FileRestoreResult(
        operation_id="operation-1",
        status=FileOperationStatus.PARTIAL,
        mode=FileRestoreMode.BOTH,
        decision=FileRestoreDecision.SAFE_PARTIAL,
        conversation_rewound=True,
        restored_files=("src/file.txt",),
    ).to_dict()

    assert preview["files"][0]["classification"] == "forceable_conflict"
    assert result["status"] == "partial"
    assert "backup" not in repr(preview).lower()
    assert "backup" not in repr(result).lower()


def test_file_history_error_exposes_code_not_message_for_branching() -> None:
    error = FileHistoryError(
        FileHistoryErrorCode.PREVIEW_STALE,
        "预览已过期",
        details={"operation_id": "operation-1"},
    )
    assert error.code == "file_preview_stale"
    assert error.details == {"operation_id": "operation-1"}
    assert error.http_status == 409
