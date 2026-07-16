from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.git import router
from backend.tests.git.conftest import GitRepoFactory


@pytest.mark.parametrize("mode", ["soft", "mixed", "hard"])
def test_reset_modes_move_head_with_expected_index_and_worktree(tmp_path: Path, mode: str) -> None:
    repo = GitRepoFactory(tmp_path).create(f"reset-{mode}")
    repo.write("tracked.txt", "target\n")
    target_oid = repo.commit("target", "tracked.txt")
    repo.write("tracked.txt", "later\n")
    repo.commit("later", "tracked.txt")
    repo.write("tracked.txt", "dirty\n")

    with _client(tmp_path / f"reset-{mode}-data") as client:
        repository_id, scope = _discover(client, repo, f"workspace-reset-{mode}")
        preview = client.get(
            f"/api/git/repositories/{repository_id}/reset-preview",
            params={**scope, "target": target_oid, "mode": mode},
        )
        assert preview.status_code == 200
        assert preview.json()["target_object_id"] == target_oid
        assert preview.json()["files"] == [{"path": "tracked.txt", "change_type": "changed"}]
        payload = _payload(repository_id, scope, f"reset-{mode}-key", target=target_oid, mode=mode)
        result = _submit_confirmed(client, repository_id, "reset", payload)
        assert result["state"] == "succeeded"
        assert result["result"]["new_head"] == target_oid
        assert result["result"]["recovery_head"]

    assert repo.run("rev-parse", "HEAD").stdout.strip() == target_oid
    index_content = repo.run("show", ":tracked.txt").stdout
    worktree_content = (repo.path / "tracked.txt").read_text(encoding="utf-8")
    if mode == "soft":
        assert index_content == "later\n"
        assert worktree_content == "dirty\n"
    elif mode == "mixed":
        assert index_content == "target\n"
        assert worktree_content == "dirty\n"
    else:
        assert index_content == "target\n"
        assert worktree_content == "target\n"


def test_hard_reset_preview_reports_only_untracked_paths_that_will_be_overwritten(
    tmp_path: Path,
) -> None:
    repo = GitRepoFactory(tmp_path).create("reset-untracked")
    repo.write("collision.txt", "tracked target\n")
    target_oid = repo.commit("add collision", "collision.txt")
    repo.run("rm", "collision.txt")
    repo.run("commit", "-m", "remove collision")
    repo.write("collision.txt", "untracked local\n")
    repo.write("safe.txt", "safe untracked\n")

    with _client(tmp_path / "reset-untracked-data") as client:
        repository_id, scope = _discover(client, repo, "workspace-reset-untracked")
        hard = client.get(
            f"/api/git/repositories/{repository_id}/reset-preview",
            params={**scope, "target": target_oid, "mode": "hard"},
        ).json()
        mixed = client.get(
            f"/api/git/repositories/{repository_id}/reset-preview",
            params={**scope, "target": target_oid, "mode": "mixed"},
        ).json()
        assert hard["untracked_overwrites"] == ["collision.txt"]
        assert mixed["untracked_overwrites"] == []
        assert "HEAD@{1}" in hard["reflog_recovery"]
        payload = _payload(
            repository_id,
            scope,
            "reset-hard-collision",
            target=target_oid,
            mode="hard",
        )
        assert _submit_confirmed(client, repository_id, "reset", payload)["state"] == "succeeded"

    assert (repo.path / "collision.txt").read_text(encoding="utf-8") == "tracked target\n"
    assert (repo.path / "safe.txt").read_text(encoding="utf-8") == "safe untracked\n"


def test_restore_index_worktree_both_and_path_isolation(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("restore")
    repo.write("tracked.txt", "base\n")
    base_oid = repo.commit("base", "tracked.txt")
    repo.write("tracked.txt", "head\n")
    repo.commit("head", "tracked.txt")
    repo.write("other.txt", "other head\n")
    repo.commit("other", "other.txt")
    repo.write("tracked.txt", "staged\n")
    repo.run("add", "--", "tracked.txt")
    repo.write("tracked.txt", "worktree\n")
    repo.write("other.txt", "other dirty\n")

    with _client(tmp_path / "restore-data") as client:
        repository_id, scope = _discover(client, repo, "workspace-restore")
        index_payload = _payload(
            repository_id,
            scope,
            "restore-index",
            paths=["tracked.txt"],
            source="HEAD",
            staged=True,
            worktree=False,
        )
        assert _submit(client, repository_id, "restore", index_payload)["state"] == "succeeded"
        assert repo.run("show", ":tracked.txt").stdout == "head\n"
        assert (repo.path / "tracked.txt").read_text(encoding="utf-8") == "worktree\n"

        worktree_payload = _payload(
            repository_id,
            scope,
            "restore-worktree",
            paths=["tracked.txt"],
            source=None,
            staged=False,
            worktree=True,
        )
        assert (
            _submit_confirmed(client, repository_id, "restore", worktree_payload)["state"]
            == "succeeded"
        )
        assert (repo.path / "tracked.txt").read_text(encoding="utf-8") == "head\n"

        both_payload = _payload(
            repository_id,
            scope,
            "restore-both",
            paths=["tracked.txt"],
            source=base_oid,
            staged=True,
            worktree=True,
        )
        result = _submit_confirmed(client, repository_id, "restore", both_payload)
        assert result["state"] == "succeeded"
        assert result["result"]["paths"] == ["tracked.txt"]

    assert repo.run("show", ":tracked.txt").stdout == "base\n"
    assert (repo.path / "tracked.txt").read_text(encoding="utf-8") == "base\n"
    assert (repo.path / "other.txt").read_text(encoding="utf-8") == "other dirty\n"


def test_reset_preview_and_hard_reset_support_an_unborn_head_with_existing_object(
    tmp_path: Path,
) -> None:
    repo = GitRepoFactory(tmp_path).create("reset-unborn")
    target_oid = repo.run("rev-parse", "HEAD").stdout.strip()
    repo.run("update-ref", "-d", "refs/heads/main")

    with _client(tmp_path / "reset-unborn-data") as client:
        repository_id, scope = _discover(client, repo, "workspace-reset-unborn")
        preview = client.get(
            f"/api/git/repositories/{repository_id}/reset-preview",
            params={**scope, "target": target_oid, "mode": "hard"},
        ).json()
        assert preview["head_object_id"] is None
        payload = _payload(repository_id, scope, "reset-unborn-key", target=target_oid, mode="hard")
        assert _submit_confirmed(client, repository_id, "reset", payload)["state"] == "succeeded"

    assert repo.run("rev-parse", "HEAD").stdout.strip() == target_oid


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


def _submit(client: TestClient, repository_id: str, command: str, payload: dict) -> dict:
    response = client.post(f"/api/git/repositories/{repository_id}/{command}", json=payload)
    assert response.status_code == 200
    return _wait(client, response.json()["operation_id"])


def _submit_confirmed(
    client: TestClient,
    repository_id: str,
    command: str,
    payload: dict,
) -> dict:
    confirmation = client.post(
        "/api/git/confirmations",
        json={"command": command, "payload": payload},
    )
    assert confirmation.status_code == 200
    payload["confirmation_token"] = confirmation.json()["token"]
    return _submit(client, repository_id, command, payload)


def _wait(client: TestClient, operation_id: str) -> dict:
    for _ in range(300):
        payload = client.get(f"/api/git/operations/{operation_id}").json()
        if payload["state"] in {"succeeded", "failed", "cancelled"}:
            return payload
        time.sleep(0.01)
    raise AssertionError("Git operation did not finish")
