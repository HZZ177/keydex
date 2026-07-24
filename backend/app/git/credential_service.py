from __future__ import annotations

from urllib.parse import urlsplit

from .models import (
    GitApiError,
    GitCredentialLoginRequest,
    GitCredentialLoginResponse,
)
from .query_service import GitQueryService
from .remote_errors import classify_remote_failure
from .security import GitParameterError, validate_remote_name


class GitCredentialService:
    """Runs an explicit, user-initiated HTTPS credential handshake through GCM."""

    def __init__(self, *, query_service: GitQueryService) -> None:
        self._queries = query_service
        self._runner = query_service.runner

    async def login(
        self,
        request: GitCredentialLoginRequest,
    ) -> GitCredentialLoginResponse:
        repository = self._queries.repository(request)
        try:
            remote = validate_remote_name(request.remote)
        except GitParameterError as exc:
            raise GitApiError("git_validation_failed", str(exc)) from exc

        url_result = await self._runner.run(
            ["remote", "get-url", remote],
            cwd=repository.root_path,
            timeout_seconds=20,
        )
        if not url_result.succeeded:
            raise GitApiError(
                "git_validation_failed",
                f"Git remote {remote} does not have a usable fetch URL",
                repository_id=repository.id,
                details={"diagnostic": url_result.safe_stderr.strip()},
            )

        remote_url = _first_line(url_result.stdout)
        host = _https_host(remote_url)
        provider_env = {
            "GCM_PROVIDER": _credential_provider(request.provider, host),
        }
        result = await self._runner.run(
            ["ls-remote", remote],
            cwd=repository.root_path,
            env=provider_env,
            allow_credential_prompt=True,
            timeout_seconds=300,
        )
        if result.timed_out:
            raise GitApiError(
                "git_timeout",
                "Interactive Git authentication timed out.",
                retryable=True,
                repository_id=repository.id,
                details={"remote": remote, "host": host},
            )
        if not result.succeeded:
            failure = classify_remote_failure(result.safe_stderr)
            code = (
                "git_credentials_missing"
                if failure.code == "git_failed"
                else failure.code
            )
            raise GitApiError(
                code,
                (
                    "Interactive Git authentication did not complete."
                    if failure.code == "git_failed"
                    else failure.message
                ),
                retryable=True,
                repository_id=repository.id,
                details={
                    "remote": remote,
                    "host": host,
                    "help_action": (
                        "Complete the system credential prompt, then retry."
                        if failure.code == "git_failed"
                        else failure.help_action
                    ),
                    "diagnostic": failure.diagnostic,
                },
            )
        return GitCredentialLoginResponse(
            repository_id=repository.id,
            remote=remote,
            host=host,
        )


def _first_line(value: str) -> str:
    for line in value.splitlines():
        normalized = line.strip()
        if normalized:
            return normalized
    raise GitApiError("git_validation_failed", "Git remote URL is empty")


def _https_host(remote_url: str) -> str:
    try:
        parsed = urlsplit(remote_url)
        if parsed.scheme.casefold() != "https" or not parsed.hostname:
            raise ValueError
        if parsed.username is not None or parsed.password is not None:
            raise GitApiError(
                "git_validation_failed",
                "Credential-bearing Git remote URLs are not supported",
            )
        port = parsed.port
    except GitApiError:
        raise
    except ValueError as exc:
        raise GitApiError(
            "git_validation_failed",
            "Interactive login currently supports HTTPS Git remotes only",
        ) from exc
    return f"{parsed.hostname}:{port}" if port is not None else parsed.hostname


def _credential_provider(requested: str, host: str) -> str:
    if requested != "auto":
        return requested
    return {
        "github.com": "github",
        "gitlab.com": "gitlab",
        "bitbucket.org": "bitbucket",
        "dev.azure.com": "azure-repos",
    }.get(host.casefold(), "generic")
