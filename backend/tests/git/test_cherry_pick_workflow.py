from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.git import router
from backend.tests.git.conftest import GitRepoFactory


def test_cherry_pick_preserves_order_and_records_origin(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("cherry-order")
    base_oid = repo.run("rev-parse", "HEAD").stdout.strip()
    repo.run("switch", "-c", "source")
    repo.write("one.txt", "one\n")
    first_oid = repo.commit("pick one", "one.txt")
    repo.write("two.txt", "two\n")
    second_oid = repo.commit("pick two", "two.txt")
    repo.run("switch", "main")

    with _client(tmp_path / "cherry-order-data") as client:
        repository_id, scope = _discover(client, repo, "workspace-cherry-order")
        submitted = client.post(
            f"/api/git/repositories/{repository_id}/cherry-pick",
            json=_payload(
                repository_id,
                scope,
                "cherry-order-key",
                commits=[first_oid, second_oid],
                record_origin=True,
            ),
        )
        result = _wait(client, submitted.json()["operation_id"])
        assert result["state"] == "succeeded"
        assert result["result"]["requested_commits"] == [first_oid, second_oid]
        assert result["result"]["record_origin"] is True

    subjects = repo.run("log", "--reverse", "--format=%s", f"{base_oid}..HEAD").stdout.splitlines()
    assert subjects == ["pick one", "pick two"]
    body = repo.run("show", "-s", "--format=%B", "HEAD").stdout
    assert f"cherry picked from commit {second_oid}" in body


@pytest.mark.parametrize("action", ["continue", "abort"])
def test_cherry_pick_conflict_can_continue_or_abort(tmp_path: Path, action: str) -> None:
    repo = GitRepoFactory(tmp_path).create(f"cherry-{action}")
    repo.write("conflict.txt", "base\n")
    repo.commit("base conflict", "conflict.txt")
    repo.run("switch", "-c", "source")
    repo.write("conflict.txt", "source\n")
    source_oid = repo.commit("source conflict", "conflict.txt")
    repo.run("switch", "main")
    repo.write("conflict.txt", "main\n")
    main_oid = repo.commit("main conflict", "conflict.txt")

    with _client(tmp_path / f"cherry-{action}-data") as client:
        repository_id, scope = _discover(client, repo, f"workspace-cherry-{action}")
        submitted = client.post(
            f"/api/git/repositories/{repository_id}/cherry-pick",
            json=_payload(
                repository_id,
                scope,
                f"cherry-{action}-key",
                commits=[source_oid],
                record_origin=False,
            ),
        )
        assert _wait(client, submitted.json()["operation_id"])["state"] == "failed"
        status = client.get(f"/api/git/repositories/{repository_id}/status", params=scope).json()
        assert status["operation"]["kind"] == "cherry_pick"
        assert status["operation"]["state"] == "conflicted"
        if action == "continue":
            repo.write("conflict.txt", "resolved\n")
            repo.run("add", "--", "conflict.txt")
        control_payload = _payload(
            repository_id,
            scope,
            f"cherry-control-{action}-key",
            action=action,
        )
        if action != "continue":
            confirmation = client.post(
                "/api/git/confirmations",
                json={"command": "cherry_pick_control", "payload": control_payload},
            )
            assert confirmation.status_code == 200
            control_payload["confirmation_token"] = confirmation.json()["token"]
        control = client.post(
            f"/api/git/repositories/{repository_id}/cherry-pick/control",
            json=control_payload,
        )
        assert _wait(client, control.json()["operation_id"])["state"] == "succeeded"
    if action == "abort":
        assert repo.run("rev-parse", "HEAD").stdout.strip() == main_oid
    else:
        assert repo.run("show", "-s", "--format=%s", "HEAD").stdout.strip() == "source conflict"


def test_empty_cherry_pick_can_be_skipped(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("cherry-empty")
    repo.write("already.txt", "already\n")
    already_oid = repo.commit("already present", "already.txt")
    with _client(tmp_path / "cherry-empty-data") as client:
        repository_id, scope = _discover(client, repo, "workspace-cherry-empty")
        submitted = client.post(
            f"/api/git/repositories/{repository_id}/cherry-pick",
            json=_payload(
                repository_id,
                scope,
                "cherry-empty-key",
                commits=[already_oid],
                record_origin=False,
            ),
        )
        assert _wait(client, submitted.json()["operation_id"])["state"] == "failed"
        status = client.get(f"/api/git/repositories/{repository_id}/status", params=scope).json()
        assert status["operation"]["kind"] == "cherry_pick"
        assert status["operation"]["state"] == "continuable"
        skip_payload = _payload(
            repository_id,
            scope,
            "cherry-empty-skip-key",
            action="skip",
        )
        confirmation = client.post(
            "/api/git/confirmations",
            json={"command": "cherry_pick_control", "payload": skip_payload},
        )
        assert confirmation.status_code == 200
        skip_payload["confirmation_token"] = confirmation.json()["token"]
        skipped = client.post(
            f"/api/git/repositories/{repository_id}/cherry-pick/control",
            json=skip_payload,
        )
        assert _wait(client, skipped.json()["operation_id"])["state"] == "succeeded"


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


def _payload(repository_id: str, scope: dict[str, str], key: str, **values):
    return {**scope, "repository_id": repository_id, "idempotency_key": key, **values}


def _wait(client: TestClient, operation_id: str) -> dict:
    for _ in range(300):
        payload = client.get(f"/api/git/operations/{operation_id}").json()
        if payload["state"] in {"succeeded", "failed", "cancelled"}:
            return payload
        time.sleep(0.01)
    raise AssertionError("Git operation did not finish")
