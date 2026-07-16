from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.app.git.models import (
    GIT_ERROR_HTTP_STATUS,
    GitApiError,
    GitBranchResponse,
    GitChangedFileResponse,
    GitFileStatusCode,
    GitRepositoryKind,
    GitRepositoryResponse,
    GitStatusResponse,
)


def test_git_models_forbid_unknown_fields_and_normalize_paths() -> None:
    repository = GitRepositoryResponse(
        id="repo-a",
        workspace_id="workspace-a",
        root_path="D:/work/repo",
        display_path=".",
        git_dir_path="D:/work/repo/.git",
        kind=GitRepositoryKind.WORKSPACE,
    )
    assert repository.kind == GitRepositoryKind.WORKSPACE
    changed = GitChangedFileResponse(
        path=r"src\main.py",
        index_status=GitFileStatusCode.ADDED,
    )
    assert changed.path == "src/main.py"

    with pytest.raises(ValidationError, match="extra_forbidden"):
        GitRepositoryResponse.model_validate({**repository.model_dump(), "unknown": True})
    with pytest.raises(ValidationError, match="repository-relative"):
        GitChangedFileResponse(path="/outside.txt")


def test_status_contract_keeps_repository_version_and_structured_files() -> None:
    status = GitStatusResponse(
        repository_id="repo-a",
        repository_version="version-1",
        branch=GitBranchResponse(head="main", upstream="origin/main", ahead=1, behind=2),
        files=[GitChangedFileResponse(path="a.txt", worktree_status="modified")],
    )
    assert status.repository_version == "version-1"
    assert status.files[0].worktree_status == GitFileStatusCode.MODIFIED


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("git_invalid_request", 400),
        ("git_access_denied", 403),
        ("git_repository_not_found", 404),
        ("git_operation_conflict", 409),
        ("git_validation_failed", 422),
        ("git_cancelled", 499),
        ("git_unavailable", 503),
        ("git_timeout", 504),
        ("git_failed", 500),
        ("future_error", 500),
    ],
)
def test_git_api_error_status_mapping(code: str, expected: int) -> None:
    error = GitApiError(code, "safe message", retryable=expected in {409, 503, 504})
    assert error.status_code == expected
    assert error.payload.message == "safe message"
    if code in GIT_ERROR_HTTP_STATUS:
        assert GIT_ERROR_HTTP_STATUS[code] == expected
