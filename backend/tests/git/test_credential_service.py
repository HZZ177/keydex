from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.app.git.credential_service import GitCredentialService
from backend.app.git.models import GitApiError, GitCredentialLoginRequest
from backend.app.git.runner import GitCommandResult


class FakeRunner:
    def __init__(self, results: list[GitCommandResult]) -> None:
        self.results = results
        self.calls: list[tuple[list[str], dict[str, object]]] = []

    async def run(self, args, **kwargs):
        self.calls.append((list(args), dict(kwargs)))
        return self.results.pop(0)


class FakeQueries:
    def __init__(self, root: Path, runner: FakeRunner) -> None:
        self.runner = runner
        self.repository_response = SimpleNamespace(id="repo-1", root_path=str(root))

    def repository(self, _request):
        return self.repository_response


def request(*, provider: str = "auto") -> GitCredentialLoginRequest:
    return GitCredentialLoginRequest(
        workspace_id="workspace-1",
        project_root="D:/repo",
        repository_id="repo-1",
        remote="origin",
        provider=provider,
    )


def result(
    root: Path,
    *,
    returncode: int = 0,
    stdout: str = "",
    stderr: str = "",
    timed_out: bool = False,
) -> GitCommandResult:
    return GitCommandResult(
        argv=("git",),
        cwd=root,
        returncode=returncode,
        stdout=stdout,
        stderr=stderr,
        duration_ms=1,
        timed_out=timed_out,
    )


@pytest.mark.asyncio
async def test_login_uses_explicit_gcm_gui_mode_without_receiving_secrets(
    tmp_path: Path,
) -> None:
    runner = FakeRunner(
        [
            result(tmp_path, stdout="https://git.example.test/team/repo.git\n"),
            result(tmp_path, stdout="deadbeef\tHEAD\n"),
        ]
    )
    service = GitCredentialService(query_service=FakeQueries(tmp_path, runner))  # type: ignore[arg-type]

    response = await service.login(request())

    assert response.model_dump() == {
        "repository_id": "repo-1",
        "remote": "origin",
        "host": "git.example.test",
        "authenticated": True,
    }
    assert runner.calls[0][0] == ["remote", "get-url", "origin"]
    assert runner.calls[1][0] == ["ls-remote", "origin"]
    assert runner.calls[1][1]["allow_credential_prompt"] is True
    assert runner.calls[1][1]["env"] == {"GCM_PROVIDER": "generic"}


@pytest.mark.asyncio
async def test_login_rejects_non_https_remote_before_prompting(tmp_path: Path) -> None:
    runner = FakeRunner([result(tmp_path, stdout="git@git.example.test:team/repo.git\n")])
    service = GitCredentialService(query_service=FakeQueries(tmp_path, runner))  # type: ignore[arg-type]

    with pytest.raises(GitApiError) as captured:
        await service.login(request())

    assert captured.value.payload.code == "git_validation_failed"
    assert "HTTPS" in captured.value.payload.message
    assert len(runner.calls) == 1


@pytest.mark.asyncio
async def test_login_returns_sanitized_authentication_failure(tmp_path: Path) -> None:
    runner = FakeRunner(
        [
            result(tmp_path, stdout="https://git.example.test/team/repo.git\n"),
            result(
                tmp_path,
                returncode=128,
                stderr=(
                    "fatal: Authentication failed for "
                    "'https://user:super-secret@git.example.test/team/repo.git'\n"
                ),
            ),
        ]
    )
    service = GitCredentialService(query_service=FakeQueries(tmp_path, runner))  # type: ignore[arg-type]

    with pytest.raises(GitApiError) as captured:
        await service.login(request())

    assert captured.value.payload.code == "git_credentials_missing"
    assert captured.value.payload.details["remote"] == "origin"
    assert captured.value.payload.details["host"] == "git.example.test"
    assert "super-secret" not in str(captured.value.payload.details)


@pytest.mark.asyncio
async def test_login_reports_a_bounded_prompt_timeout(tmp_path: Path) -> None:
    runner = FakeRunner(
        [
            result(tmp_path, stdout="https://git.example.test/team/repo.git\n"),
            result(tmp_path, returncode=-1, timed_out=True),
        ]
    )
    service = GitCredentialService(query_service=FakeQueries(tmp_path, runner))  # type: ignore[arg-type]

    with pytest.raises(GitApiError) as captured:
        await service.login(request())

    assert captured.value.payload.code == "git_timeout"
    assert captured.value.payload.retryable is True
    assert captured.value.payload.details == {
        "remote": "origin",
        "host": "git.example.test",
    }
