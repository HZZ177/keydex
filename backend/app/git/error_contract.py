from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

GitRetryAction = Literal["immediate", "after_fix", "refresh", "never"]
GitConfirmationAction = Literal["none", "grant", "repreview", "reconfirm"]


@dataclass(frozen=True)
class GitErrorContractEntry:
    http_status: int
    retry_action: GitRetryAction
    confirmation_action: GitConfirmationAction
    help_action: str


# Backend source of truth. The renderer owns translated presentation, while
# cross-language tests keep both exhaustive code lists in lockstep.
GIT_ERROR_CONTRACT: dict[str, GitErrorContractEntry] = {
    "git_invalid_request": GitErrorContractEntry(
        400, "never", "none", "Review the requested Git action and payload."
    ),
    "git_access_denied": GitErrorContractEntry(
        403, "after_fix", "grant", "Review the project and repository access grant."
    ),
    "git_ancestor_not_authorized": GitErrorContractEntry(
        403, "after_fix", "grant", "Authorize the exact ancestor repository before retrying."
    ),
    "git_repository_not_found": GitErrorContractEntry(
        404, "refresh", "none", "Refresh repository discovery or select an existing revision."
    ),
    "git_operation_conflict": GitErrorContractEntry(
        409, "refresh", "repreview", "Refresh repository state and preview the action again."
    ),
    "git_validation_failed": GitErrorContractEntry(
        422, "never", "none", "Correct the highlighted Git input before retrying."
    ),
    "git_cancelled": GitErrorContractEntry(
        499, "never", "none", "Start the action again only if it is still needed."
    ),
    "git_unavailable": GitErrorContractEntry(
        503, "after_fix", "none", "Install or repair the system Git executable, then retry."
    ),
    "git_timeout": GitErrorContractEntry(
        504, "immediate", "none", "Check repository and network responsiveness, then retry."
    ),
    "git_failed": GitErrorContractEntry(
        500, "never", "none", "Review the sanitized diagnostic before deciding whether to retry."
    ),
    "git_credentials_missing": GitErrorContractEntry(
        401,
        "after_fix",
        "none",
        "Start explicit credential login, complete the system prompt, then retry.",
    ),
    "git_credential_helper_failed": GitErrorContractEntry(
        502, "after_fix", "none", "Repair or sign in to the configured system credential helper."
    ),
    "git_host_key_failed": GitErrorContractEntry(
        409,
        "after_fix",
        "none",
        "Verify the host fingerprint outside Keydex and update known_hosts.",
    ),
    "git_network_unavailable": GitErrorContractEntry(
        503, "immediate", "none", "Check the remote host, proxy, VPN, and network connection."
    ),
    "git_parse_failed": GitErrorContractEntry(
        500, "never", "none", "Copy the sanitized diagnostic and report the unsupported Git output."
    ),
    "git_output_too_large": GitErrorContractEntry(
        422, "after_fix", "none", "Narrow the selected revisions, paths, or line range."
    ),
}


def git_error_http_status(code: str) -> int:
    entry = GIT_ERROR_CONTRACT.get(code)
    return entry.http_status if entry is not None else 500
