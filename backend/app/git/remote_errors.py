from __future__ import annotations

from dataclasses import dataclass

from .runner import redact_git_output


@dataclass(frozen=True)
class GitRemoteFailure:
    code: str
    message: str
    help_action: str
    diagnostic: str
    retryable: bool


def classify_remote_failure(stderr: str) -> GitRemoteFailure:
    diagnostic = redact_git_output(stderr).strip() or "Git remote operation failed"
    normalized = diagnostic.casefold()
    if "host key verification failed" in normalized or "known_hosts" in normalized:
        return GitRemoteFailure(
            code="git_host_key_failed",
            message="SSH host key verification failed.",
            help_action=(
                "Verify the host fingerprint outside Keydex and update known_hosts before retrying."
            ),
            diagnostic=diagnostic,
            retryable=False,
        )
    if (
        "credential helper" in normalized
        or "helper exploded" in normalized
        or "credential-manager" in normalized
    ):
        return GitRemoteFailure(
            code="git_credential_helper_failed",
            message="The configured Git credential helper failed.",
            help_action=(
                "Repair or sign in to the system credential helper outside Keydex, then retry."
            ),
            diagnostic=diagnostic,
            retryable=True,
        )
    if any(
        marker in normalized
        for marker in (
            "authentication failed",
            "could not read username",
            "terminal prompts disabled",
            "permission denied (publickey)",
            "access denied",
        )
    ):
        return GitRemoteFailure(
            code="git_credentials_missing",
            message="Git credentials are unavailable or were rejected.",
            help_action=(
                "Start the explicit Keydex credential login, complete the system prompt, "
                "then retry."
            ),
            diagnostic=diagnostic,
            retryable=True,
        )
    if any(
        marker in normalized
        for marker in (
            "could not resolve host",
            "failed to connect",
            "connection timed out",
            "network is unreachable",
            "connection refused",
        )
    ):
        return GitRemoteFailure(
            code="git_network_unavailable",
            message="The Git remote could not be reached.",
            help_action="Check the remote host, proxy, VPN, and network connection, then retry.",
            diagnostic=diagnostic,
            retryable=True,
        )
    return GitRemoteFailure(
        code="git_failed",
        message=diagnostic,
        help_action="Review the diagnostic and remote configuration before retrying.",
        diagnostic=diagnostic,
        retryable=False,
    )
