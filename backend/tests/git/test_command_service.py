from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.git.access import GitAncestorGrantStore
from backend.app.git.command_service import (
    GitCommandDefinition,
    GitCommandRegistry,
    GitCommandRisk,
    GitCommandService,
    GitPreparedCommand,
)
from backend.app.git.models import GitCommandRequest, GitDiscoveryRequest
from backend.app.git.query_service import GitQueryService
from backend.app.git.runner import GitCommandResult


def request_payload(repo, repository_id: str, key: str = "command-key") -> GitCommandRequest:
    return GitCommandRequest(
        workspace_id="workspace-command",
        project_root=str(repo.path),
        repository_id=repository_id,
        idempotency_key=key,
    )


@pytest.mark.asyncio
async def test_typed_registry_runs_mutation_lifecycle_and_refresh_scope(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("command")
    query = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "grants.json"))
    repository = query.discover(
        GitDiscoveryRequest(workspace_id="workspace-command", project_root=str(repo.path))
    ).repositories[0]
    definition = GitCommandDefinition(
        name="create-test-branch",
        request_model=GitCommandRequest,
        risk=GitCommandRisk.WRITE,
        refresh_domains=frozenset({"refs", "status"}),
        prepare=lambda _request: GitPreparedCommand(
            argv=("branch", "created-by-service"),
            summary="Created test branch",
        ),
        parse_result=lambda result: {"duration_ms": result.duration_ms},
    )
    service = GitCommandService(
        query_service=query,
        registry=GitCommandRegistry((definition,)),
    )

    handle = service.submit("create-test-branch", request_payload(repo, repository.id))
    duplicate = service.submit("create-test-branch", request_payload(repo, repository.id))
    response = await handle.result()

    assert duplicate.operation_id == handle.operation_id
    assert response is not None and response.state == "succeeded"
    assert response.result["refresh_domains"] == ["refs", "status"]
    assert repo.run("branch", "--list", "created-by-service").stdout.strip()
    operation = service.operation(handle.operation_id)
    assert operation.state == "succeeded"
    assert operation.command == "create-test-branch"
    assert operation.risk == "write"
    assert operation.created_at is not None
    assert operation.started_at is not None
    assert operation.finished_at is not None
    assert operation.duration_ms is not None and operation.duration_ms >= 0
    assert operation.error is None


def test_unknown_and_unconfirmed_high_risk_commands_are_rejected(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("risk")
    query = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "grants.json"))
    repository = query.discover(
        GitDiscoveryRequest(workspace_id="workspace-command", project_root=str(repo.path))
    ).repositories[0]
    definition = GitCommandDefinition(
        name="danger",
        request_model=GitCommandRequest,
        risk=GitCommandRisk.DESTRUCTIVE,
        refresh_domains=frozenset({"status"}),
        prepare=lambda _request: GitPreparedCommand(argv=("status",), summary="danger"),
    )
    service = GitCommandService(
        query_service=query,
        registry=GitCommandRegistry((definition,)),
    )

    with pytest.raises(Exception, match="Unknown Git command"):
        service.submit("raw", request_payload(repo, repository.id))
    with pytest.raises(Exception, match="confirmation token"):
        service.submit("danger", request_payload(repo, repository.id))


@pytest.mark.asyncio
async def test_remote_failure_is_structured_redacted_and_actionable(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("remote-error")
    query = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "grants.json"))
    repository = query.discover(
        GitDiscoveryRequest(workspace_id="workspace-command", project_root=str(repo.path))
    ).repositories[0]
    definition = GitCommandDefinition(
        name="fetch-test",
        request_model=GitCommandRequest,
        risk=GitCommandRisk.WRITE,
        refresh_domains=frozenset({"refs"}),
        prepare=lambda _request: GitPreparedCommand(
            argv=("fetch", "origin"),
            summary="Fetch origin",
        ),
    )

    class FailedRemoteRunner:
        async def run(self, args, **_kwargs):
            return GitCommandResult(
                argv=("git", *args),
                cwd=repo.path,
                returncode=128,
                stdout="",
                stderr="fatal: Authentication failed for https://user:secret@example.test/repo.git",
                duration_ms=1,
            )

    service = GitCommandService(
        query_service=query,
        registry=GitCommandRegistry((definition,)),
        runner=FailedRemoteRunner(),  # type: ignore[arg-type]
    )
    handle = service.submit(
        "fetch-test", request_payload(repo, repository.id, "remote-failure-key")
    )
    assert await handle.result() is None
    operation = service.operation(handle.operation_id)
    assert operation.state == "failed"
    assert operation.result["error_code"] == "git_credentials_missing"
    assert operation.result["retryable"] is True
    assert "credential manager" in str(operation.result["help_action"])
    assert "secret" not in str(operation.result["diagnostic"])
    assert operation.command == "fetch-test"
    assert operation.risk == "write"
    assert operation.retryable is True
    assert operation.error is not None
    assert operation.error.code == "git_credentials_missing"
    assert "secret" not in str(operation.error.details)
