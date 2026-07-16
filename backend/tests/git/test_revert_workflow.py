from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.git import router
from backend.tests.git.conftest import GitRepoFactory


def test_revert_creates_new_commits_in_requested_order(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("revert-order")
    repo.write("one.txt", "one\n")
    first_oid = repo.commit("add one", "one.txt")
    repo.write("two.txt", "two\n")
    second_oid = repo.commit("add two", "two.txt")
    original_head = repo.run("rev-parse", "HEAD").stdout.strip()

    with _client(tmp_path / "revert-order-data") as client:
        repository_id, scope = _discover(client, repo, "workspace-revert-order")
        submitted = client.post(
            f"/api/git/repositories/{repository_id}/revert",
            json=_payload(
                repository_id,
                scope,
                "revert-order-key",
                commits=[first_oid, second_oid],
                mainline=None,
            ),
        )
        result = _wait(client, submitted.json()["operation_id"])
        assert result["state"] == "succeeded"
        assert result["result"]["requested_commits"] == [first_oid, second_oid]

    new_head = repo.run("rev-parse", "HEAD").stdout.strip()
    assert new_head != original_head
    assert repo.run("rev-parse", "HEAD~2").stdout.strip() == original_head
    subjects = repo.run(
        "log", "--reverse", "--format=%s", f"{original_head}..HEAD"
    ).stdout.splitlines()
    assert subjects == ['Revert "add one"', 'Revert "add two"']
    assert not (repo.path / "one.txt").exists()
    assert not (repo.path / "two.txt").exists()


def test_merge_revert_requires_explicit_mainline_and_preserves_first_parent(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("revert-merge")
    repo.run("switch", "-c", "side")
    repo.write("side.txt", "side\n")
    repo.commit("side change", "side.txt")
    repo.run("switch", "main")
    repo.write("main.txt", "main\n")
    repo.commit("main change", "main.txt")
    repo.run("merge", "--no-ff", "side", "-m", "merge side")
    merge_oid = repo.run("rev-parse", "HEAD").stdout.strip()

    with _client(tmp_path / "revert-merge-data") as client:
        repository_id, scope = _discover(client, repo, "workspace-revert-merge")
        missing = client.post(
            f"/api/git/repositories/{repository_id}/revert",
            json=_payload(
                repository_id,
                scope,
                "revert-merge-missing",
                commits=[merge_oid],
                mainline=None,
            ),
        )
        missing_result = _wait(client, missing.json()["operation_id"])
        assert missing_result["state"] == "failed"
        assert repo.run("rev-parse", "HEAD").stdout.strip() == merge_oid

        submitted = client.post(
            f"/api/git/repositories/{repository_id}/revert",
            json=_payload(
                repository_id,
                scope,
                "revert-merge-mainline",
                commits=[merge_oid],
                mainline=1,
            ),
        )
        result = _wait(client, submitted.json()["operation_id"])
        assert result["state"] == "succeeded"
        assert result["result"]["mainline"] == 1

    assert (repo.path / "main.txt").read_text(encoding="utf-8") == "main\n"
    assert not (repo.path / "side.txt").exists()
    assert repo.run("rev-parse", "HEAD^").stdout.strip() == merge_oid


@pytest.mark.parametrize("action", ["continue", "abort"])
def test_conflicted_revert_can_continue_or_abort(tmp_path: Path, action: str) -> None:
    repo = GitRepoFactory(tmp_path).create(f"revert-{action}")
    repo.write("conflict.txt", "base\n")
    repo.commit("base", "conflict.txt")
    repo.write("conflict.txt", "target\n")
    target_oid = repo.commit("target", "conflict.txt")
    repo.write("conflict.txt", "later\n")
    original_head = repo.commit("later", "conflict.txt")

    with _client(tmp_path / f"revert-{action}-data") as client:
        repository_id, scope = _discover(client, repo, f"workspace-revert-{action}")
        submitted = client.post(
            f"/api/git/repositories/{repository_id}/revert",
            json=_payload(
                repository_id,
                scope,
                f"revert-{action}-key",
                commits=[target_oid],
                mainline=None,
            ),
        )
        assert _wait(client, submitted.json()["operation_id"])["state"] == "failed"
        status = client.get(f"/api/git/repositories/{repository_id}/status", params=scope).json()
        assert status["operation"]["kind"] == "revert"
        assert status["operation"]["state"] == "conflicted"
        if action == "continue":
            repo.write("conflict.txt", "resolved revert\n")
            repo.run("add", "--", "conflict.txt")
        control_payload = _payload(
            repository_id, scope, f"revert-control-{action}", action=action
        )
        if action == "abort":
            confirmation = client.post(
                "/api/git/confirmations",
                json={"command": "revert_control", "payload": control_payload},
            )
            assert confirmation.status_code == 200
            control_payload["confirmation_token"] = confirmation.json()["token"]
        control = client.post(
            f"/api/git/repositories/{repository_id}/revert/control",
            json=control_payload,
        )
        assert _wait(client, control.json()["operation_id"])["state"] == "succeeded"

    if action == "abort":
        assert repo.run("rev-parse", "HEAD").stdout.strip() == original_head
        assert (repo.path / "conflict.txt").read_text(encoding="utf-8") == "later\n"
    else:
        assert repo.run("rev-parse", "HEAD^").stdout.strip() == original_head
        assert repo.run("show", "-s", "--format=%s", "HEAD").stdout.strip() == 'Revert "target"'


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
