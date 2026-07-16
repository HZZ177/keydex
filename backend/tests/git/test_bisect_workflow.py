from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.git import router
from backend.tests.git.conftest import GitRepoFactory


def test_manual_bisect_finds_culprit_recovers_after_restart_and_resets(tmp_path: Path) -> None:
    repo, commits = _linear_history(tmp_path, "bisect-manual")
    with _client(tmp_path / "bisect-data") as client:
        repository_id, scope = _discover(client, repo, "workspace-bisect")
        started = _submit(
            client,
            repository_id,
            "bisect/start",
            _payload(
                repository_id,
                scope,
                "bisect-start-key",
                good_revision=commits[0],
                bad_revision=commits[-1],
            ),
        )
        assert started["state"] == "succeeded"
        state = _state(client, repository_id, scope)
        assert state["active"] is True
        assert state["remaining_count"] > 0
        assert state["current_revision"] in state["candidate_revisions"]

        for step in range(12):
            current_value = int((repo.path / "bisect.txt").read_text(encoding="utf-8").strip())
            action = "bad" if current_value >= 4 else "good"
            result = _submit(
                client,
                repository_id,
                "bisect/control",
                _payload(repository_id, scope, f"bisect-{action}-{step}", action=action),
            )
            assert result["state"] == "succeeded"
            state = _state(client, repository_id, scope)
            if state["culprit_revision"]:
                break
        else:
            raise AssertionError("Bisect did not identify the first bad commit")

        assert state["culprit_revision"] == commits[4]
        assert state["active"] is True

    with _client(tmp_path / "bisect-restart-data") as restarted:
        restarted_id, restarted_scope = _discover(
            restarted, repo, "workspace-bisect-restarted"
        )
        recovered = _state(restarted, restarted_id, restarted_scope)
        assert recovered["active"] is True
        assert recovered["culprit_revision"] == commits[4]
        reset = _submit(
            restarted,
            restarted_id,
            "bisect/control",
            _payload(restarted_id, restarted_scope, "bisect-reset-key", action="reset"),
        )
        assert reset["state"] == "succeeded"
        assert _state(restarted, restarted_id, restarted_scope)["active"] is False

    assert repo.run("symbolic-ref", "--short", "HEAD").stdout.strip() == "main"
    assert repo.run("rev-parse", "HEAD").stdout.strip() == commits[-1]


def test_bisect_skip_records_revision_and_never_runs_user_commands(tmp_path: Path) -> None:
    repo, commits = _linear_history(tmp_path, "bisect-skip")
    with _client(tmp_path / "bisect-skip-data") as client:
        repository_id, scope = _discover(client, repo, "workspace-bisect-skip")
        _submit(
            client,
            repository_id,
            "bisect/start",
            _payload(
                repository_id,
                scope,
                "bisect-skip-start",
                good_revision=commits[0],
                bad_revision=commits[-1],
            ),
        )
        current = _state(client, repository_id, scope)["current_revision"]
        skipped = _submit(
            client,
            repository_id,
            "bisect/control",
            _payload(repository_id, scope, "bisect-skip-step", action="skip"),
        )
        assert skipped["state"] == "succeeded"
        state = _state(client, repository_id, scope)
        assert current in state["skipped_revisions"]
        _submit(
            client,
            repository_id,
            "bisect/control",
            _payload(repository_id, scope, "bisect-skip-reset", action="reset"),
        )


def _linear_history(tmp_path: Path, name: str):
    repo = GitRepoFactory(tmp_path).create(name)
    commits: list[str] = []
    for value in range(9):
        repo.write("bisect.txt", f"{value}\n")
        commits.append(repo.commit(f"bisect {value}", "bisect.txt"))
    return repo, commits


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
    assert response.status_code == 200, response.text
    return response.json()["repositories"][0]["id"], {
        "workspace_id": workspace_id,
        "project_root": str(repo.path),
    }


def _payload(repository_id: str, scope: dict[str, str], key: str, **values) -> dict:
    return {
        **scope,
        "repository_id": repository_id,
        "idempotency_key": key,
        **values,
    }


def _state(client: TestClient, repository_id: str, scope: dict[str, str]) -> dict:
    response = client.get(f"/api/git/repositories/{repository_id}/bisect", params=scope)
    assert response.status_code == 200, response.text
    return response.json()


def _submit(
    client: TestClient,
    repository_id: str,
    suffix: str,
    payload: dict,
) -> dict:
    response = client.post(
        f"/api/git/repositories/{repository_id}/{suffix}", json=payload
    )
    assert response.status_code == 200, response.text
    operation_id = response.json()["operation_id"]
    for _ in range(300):
        result = client.get(f"/api/git/operations/{operation_id}").json()
        if result["state"] in {"succeeded", "failed", "cancelled"}:
            return result
        time.sleep(0.01)
    raise AssertionError("Bisect operation did not finish")
