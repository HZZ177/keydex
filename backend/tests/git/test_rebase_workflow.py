from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.app.api.git import router
from backend.app.git.models import GitRebaseCommandRequest
from backend.tests.git.conftest import GitRepoFactory


def test_rebase_preview_clean_onto_and_interactive_squash(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("rebase-clean")
    repo.run("switch", "-c", "topic")
    repo.write("one.txt", "one\n")
    first_oid = repo.commit("topic one", "one.txt")
    repo.write("two.txt", "two\n")
    second_oid = repo.commit("topic two", "two.txt")
    repo.run("switch", "main")
    repo.write("main.txt", "main\n")
    repo.commit("main advance", "main.txt")
    repo.run("switch", "topic")

    with _client(tmp_path / "rebase-clean-data") as client:
        repository_id, scope = _discover(client, repo, "workspace-rebase-clean")
        preview = client.get(
            f"/api/git/repositories/{repository_id}/rebase-preview",
            params={**scope, "upstream": "main", "onto": "main"},
        )
        assert preview.status_code == 200
        assert [item["object_id"] for item in preview.json()["commits"]] == [first_oid, second_oid]
        payload = _payload(
            repo,
            repository_id,
            scope,
            "interactive-rebase-key",
            upstream="main",
            onto="main",
            interactive=True,
            todo=[
                {
                    "action": "reword",
                    "object_id": first_oid,
                    "subject": "topic one",
                    "message": "topic one rewritten",
                },
                {"action": "squash", "object_id": second_oid, "subject": "topic two"},
            ],
        )
        result = _submit_rebase(client, repository_id, payload)
        assert result["state"] == "succeeded"

    assert repo.run("rev-list", "--count", "main..topic").stdout.strip() == "1"
    assert repo.run("log", "-1", "--format=%s", "topic").stdout.strip() == "topic one rewritten"
    changed_paths = repo.run("diff", "--name-only", "main..topic").stdout.splitlines()
    assert {line.strip() for line in changed_paths} == {
        "one.txt",
        "two.txt",
    }


@pytest.mark.parametrize("control", ["continue", "skip", "abort"])
def test_rebase_conflict_supports_continue_skip_and_abort(tmp_path: Path, control: str) -> None:
    repo = GitRepoFactory(tmp_path).create(f"rebase-{control}")
    repo.write("conflict.txt", "base\n")
    repo.commit("base conflict", "conflict.txt")
    repo.run("switch", "-c", "topic")
    repo.write("conflict.txt", "topic\n")
    repo.commit("topic conflict", "conflict.txt")
    topic_before = repo.run("rev-parse", "topic").stdout.strip()
    repo.run("switch", "main")
    repo.write("conflict.txt", "main\n")
    main_oid = repo.commit("main conflict", "conflict.txt")
    repo.run("switch", "topic")

    with _client(tmp_path / f"rebase-{control}-data") as client:
        repository_id, scope = _discover(client, repo, f"workspace-rebase-{control}")
        payload = _payload(
            repo,
            repository_id,
            scope,
            f"rebase-{control}-key",
            upstream="main",
            interactive=False,
            todo=[],
        )
        result = _submit_rebase(client, repository_id, payload)
        assert result["state"] == "failed"
        status = client.get(f"/api/git/repositories/{repository_id}/status", params=scope).json()
        assert status["operation"]["kind"] == "rebase"
        assert status["operation"]["state"] == "conflicted"

        if control == "continue":
            repo.write("conflict.txt", "resolved\n")
            repo.run("add", "--", "conflict.txt")
        control_payload = _payload(
            repo,
            repository_id,
            scope,
            f"rebase-control-{control}-key",
            action=control,
        )
        if control != "continue":
            confirmation = client.post(
                "/api/git/confirmations",
                json={"command": "rebase_control", "payload": control_payload},
            )
            assert confirmation.status_code == 200
            control_payload["confirmation_token"] = confirmation.json()["token"]
        command = client.post(
            f"/api/git/repositories/{repository_id}/rebase/control",
            json=control_payload,
        )
        assert _wait(client, command.json()["operation_id"])["state"] == "succeeded"
        status = client.get(f"/api/git/repositories/{repository_id}/status", params=scope).json()
        assert status["operation"] is None

    if control == "abort":
        assert repo.run("rev-parse", "topic").stdout.strip() == topic_before
    else:
        assert repo.run("merge-base", "topic", "main").stdout.strip() == main_oid


def test_rebase_todo_rejects_invalid_squash_and_duplicate_commits() -> None:
    base = {
        "workspace_id": "workspace",
        "project_root": "D:/repo",
        "repository_id": "repo",
        "idempotency_key": "rebase-validation-key",
        "upstream": "main",
        "interactive": True,
    }
    with pytest.raises(ValidationError, match="previous non-dropped"):
        GitRebaseCommandRequest.model_validate({
            **base,
            "todo": [{"action": "squash", "object_id": "a" * 40, "subject": "bad"}],
        })
    with pytest.raises(ValidationError, match="duplicate"):
        GitRebaseCommandRequest.model_validate({
            **base,
            "todo": [
                {"action": "pick", "object_id": "a" * 40, "subject": "one"},
                {"action": "drop", "object_id": "a" * 40, "subject": "again"},
            ],
        })
    with pytest.raises(ValidationError, match="new commit message"):
        GitRebaseCommandRequest.model_validate({
            **base,
            "todo": [
                {"action": "reword", "object_id": "a" * 40, "subject": "one"},
            ],
        })


def test_rebase_continue_rejects_unresolved_index_and_preserves_recovery_state(
    tmp_path: Path,
) -> None:
    repo = GitRepoFactory(tmp_path).create("rebase-unresolved-continue")
    repo.write("conflict.txt", "base\n")
    repo.commit("base", "conflict.txt")
    repo.run("switch", "-c", "topic")
    repo.write("conflict.txt", "topic\n")
    repo.commit("topic", "conflict.txt")
    repo.run("switch", "main")
    repo.write("conflict.txt", "main\n")
    repo.commit("main", "conflict.txt")
    repo.run("switch", "topic")
    with _client(tmp_path / "unresolved-data") as client:
        repository_id, scope = _discover(client, repo, "workspace-unresolved")
        started = _submit_rebase(
            client,
            repository_id,
            _payload(
                repo,
                repository_id,
                scope,
                "rebase-unresolved-key",
                upstream="main",
                interactive=False,
                todo=[],
            ),
        )
        assert started["state"] == "failed"
        continued = client.post(
            f"/api/git/repositories/{repository_id}/rebase/control",
            json=_payload(
                repo,
                repository_id,
                scope,
                "rebase-unresolved-continue-key",
                action="continue",
            ),
        )
        result = _wait(client, continued.json()["operation_id"])
        status = client.get(
            f"/api/git/repositories/{repository_id}/status", params=scope
        ).json()

    assert result["state"] == "failed"
    assert status["operation"]["kind"] == "rebase"
    assert status["operation"]["state"] == "conflicted"


def _client(data_dir: Path) -> TestClient:
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=data_dir)
    app.include_router(router)
    return TestClient(app)


def _discover(client: TestClient, repo, workspace_id: str) -> tuple[str, dict[str, str]]:
    response = client.post(
        "/api/git/repositories/discover",
        json={"workspace_id": workspace_id, "project_root": str(repo.path)},
    )
    return response.json()["repositories"][0]["id"], {
        "workspace_id": workspace_id,
        "project_root": str(repo.path),
    }


def _payload(repo, repository_id: str, scope: dict[str, str], key: str, **values):
    return {**scope, "repository_id": repository_id, "idempotency_key": key, **values}


def _submit_rebase(client: TestClient, repository_id: str, payload: dict) -> dict:
    confirmation = client.post(
        "/api/git/confirmations",
        json={"command": "rebase", "payload": payload},
    )
    assert confirmation.status_code == 200
    payload["confirmation_token"] = confirmation.json()["token"]
    response = client.post(f"/api/git/repositories/{repository_id}/rebase", json=payload)
    assert response.status_code == 200
    return _wait(client, response.json()["operation_id"])


def _wait(client: TestClient, operation_id: str) -> dict:
    for _ in range(300):
        payload = client.get(f"/api/git/operations/{operation_id}").json()
        if payload["state"] in {"succeeded", "failed", "cancelled"}:
            return payload
        time.sleep(0.01)
    raise AssertionError("Git operation did not finish")
