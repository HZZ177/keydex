from __future__ import annotations

import ast
from pathlib import Path

from backend.app.git.error_contract import GIT_ERROR_CONTRACT
from backend.app.git.models import GIT_ERROR_HTTP_STATUS, GitApiError

EXPECTED_ERROR_CODES = {
    "git_invalid_request",
    "git_access_denied",
    "git_ancestor_not_authorized",
    "git_repository_not_found",
    "git_operation_conflict",
    "git_validation_failed",
    "git_cancelled",
    "git_unavailable",
    "git_timeout",
    "git_failed",
    "git_credentials_missing",
    "git_credential_helper_failed",
    "git_host_key_failed",
    "git_network_unavailable",
    "git_parse_failed",
    "git_output_too_large",
}


def test_git_error_contract_is_complete_and_drives_http_statuses() -> None:
    assert set(GIT_ERROR_CONTRACT) == EXPECTED_ERROR_CODES
    assert GIT_ERROR_HTTP_STATUS == {
        code: entry.http_status for code, entry in GIT_ERROR_CONTRACT.items()
    }
    for code, entry in GIT_ERROR_CONTRACT.items():
        assert 400 <= entry.http_status <= 599
        assert entry.help_action.strip()
        assert GitApiError(code, "safe").status_code == entry.http_status


def test_every_literal_backend_git_error_has_a_contract_entry() -> None:
    git_root = Path(__file__).resolve().parents[2] / "app" / "git"
    emitted_codes: set[str] = set()
    for source in git_root.glob("*.py"):
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and _called_name(node.func) == "GitApiError"
                and node.args
            ):
                first = node.args[0]
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    emitted_codes.add(first.value)
            if isinstance(node, ast.Call) and _called_name(node.func) == "GitRemoteFailure":
                for keyword in node.keywords:
                    if keyword.arg == "code" and isinstance(keyword.value, ast.Constant):
                        emitted_codes.add(str(keyword.value.value))

    assert emitted_codes == EXPECTED_ERROR_CODES


def _called_name(value: ast.expr) -> str | None:
    if isinstance(value, ast.Name):
        return value.id
    if isinstance(value, ast.Attribute):
        return value.attr
    return None
