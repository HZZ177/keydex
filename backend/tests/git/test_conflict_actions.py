from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.git import router
from backend.tests.git.conftest import GitRepoFactory


def test_accept_stage_reopen_round_trip_keeps_steps_explicit(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("conflict-action-round-trip")
    repo.create_conflict("both.txt")
    app = _app(tmp_path / "data")
    with TestClient(app) as client:
        repository_id = _discover(client, repo, "workspace-actions")
        conflict = _conflicts(client, repo, repository_id, "workspace-actions")["files"][0]
        action = _action_payload(repo, repository_id, "workspace-actions", conflict)

        rejected = client.post(
            f"/api/git/repositories/{repository_id}/conflicts/action", json=action
        )
        assert rejected.status_code == 409
        accepted = _confirmed_action(client, repository_id, action)
        assert accepted["state"] == "succeeded"
        assert (repo.path / "both.txt").read_text(encoding="utf-8") == "main\n"
        assert repo.run("ls-files", "-u", "--", "both.txt").stdout

        before_continue = repo.run("merge", "--continue", check=False)
        assert before_continue.returncode != 0
        mark = {
            **action,
            "action": "mark_resolved",
            "idempotency_key": "mark-resolved-key",
            "confirmation_token": None,
        }
        marked = _action(client, repository_id, mark)
        assert marked["state"] == "succeeded"
        resolved_index = marked["result"]["resolved_index"]
        assert resolved_index.endswith("\tboth.txt")
        assert repo.run("ls-files", "-u", "--", "both.txt").stdout == ""

        reopen = {
            **mark,
            "action": "reopen",
            "idempotency_key": "reopen-conflict-key",
            "resolved_index_entry": resolved_index,
        }
        reopened = _action(client, repository_id, reopen)
        assert reopened["state"] == "succeeded"
        stage_numbers = {
            line.split()[2]
            for line in repo.run(
                "ls-files", "-u", "--", "both.txt"
            ).stdout.splitlines()
        }
        assert stage_numbers == {"1", "2", "3"}
        visible = _conflicts(client, repo, repository_id, "workspace-actions")
        assert visible["files"][0]["path"] == "both.txt"
        assert visible["files"][0]["result_content"].replace("\r\n", "\n") == "main\n"


def test_accept_delete_uses_special_confirmation_and_resolves_path(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("conflict-action-delete")
    repo.write("deleted.txt", "base\n")
    repo.commit("delete base", "deleted.txt")
    repo.run("switch", "-c", "side")
    repo.write("deleted.txt", "side changed\n")
    repo.commit("side change", "deleted.txt")
    repo.run("switch", "main")
    repo.run("rm", "deleted.txt")
    repo.run("commit", "-m", "main delete")
    assert repo.run("merge", "side", check=False).returncode != 0
    app = _app(tmp_path / "delete-data")
    with TestClient(app) as client:
        repository_id = _discover(client, repo, "workspace-delete-action")
        conflict = _conflicts(
            client, repo, repository_id, "workspace-delete-action"
        )["files"][0]
        action = {
            **_action_payload(
                repo, repository_id, "workspace-delete-action", conflict
            ),
            "action": "accept_delete",
        }
        result = _confirmed_action(client, repository_id, action)

    assert result["state"] == "succeeded"
    assert not (repo.path / "deleted.txt").exists()
    assert repo.run("ls-files", "-u", "--", "deleted.txt").stdout == ""


def test_stale_stage_identity_fails_without_touching_worktree(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("conflict-action-stale")
    repo.create_conflict("both.txt")
    original = (repo.path / "both.txt").read_bytes()
    app = _app(tmp_path / "stale-data")
    with TestClient(app) as client:
        repository_id = _discover(client, repo, "workspace-stale-action")
        conflict = _conflicts(
            client, repo, repository_id, "workspace-stale-action"
        )["files"][0]
        action = _action_payload(
            repo, repository_id, "workspace-stale-action", conflict
        )
        action["expected_stages"][0]["object_id"] = "f" * 40
        result = _confirmed_action(client, repository_id, action)

    assert result["state"] == "failed"
    assert "changed" in result["result"]["error"].lower()
    assert (repo.path / "both.txt").read_bytes() == original


def test_accept_theirs_handles_add_add_and_binary_without_auto_staging(tmp_path: Path) -> None:
    factory = GitRepoFactory(tmp_path)
    add_add = factory.create("conflict-action-add-add")
    add_add.run("switch", "-c", "side")
    add_add.write("added.txt", "side\n")
    add_add.commit("side add", "added.txt")
    add_add.run("switch", "main")
    add_add.write("added.txt", "main\n")
    add_add.commit("main add", "added.txt")
    assert add_add.run("merge", "side", check=False).returncode != 0

    binary = factory.create("conflict-action-binary")
    (binary.path / "binary.dat").write_bytes(b"\x00base")
    binary.commit("binary base", "binary.dat")
    binary.run("switch", "-c", "side")
    (binary.path / "binary.dat").write_bytes(b"\x00side")
    binary.commit("binary side", "binary.dat")
    binary.run("switch", "main")
    (binary.path / "binary.dat").write_bytes(b"\x00main")
    binary.commit("binary main", "binary.dat")
    assert binary.run("merge", "side", check=False).returncode != 0

    for index, (repo, workspace_id, path, expected) in enumerate(
        (
            (add_add, "workspace-add-action", "added.txt", b"side\n"),
            (binary, "workspace-binary-action", "binary.dat", b"\x00side"),
        )
    ):
        app = _app(tmp_path / f"side-data-{index}")
        with TestClient(app) as client:
            repository_id = _discover(client, repo, workspace_id)
            conflict = _conflicts(client, repo, repository_id, workspace_id)["files"][0]
            action = {
                **_action_payload(repo, repository_id, workspace_id, conflict),
                "action": "accept_theirs",
            }
            result = _confirmed_action(client, repository_id, action)
        assert result["state"] == "succeeded"
        assert (repo.path / path).read_bytes().replace(b"\r\n", b"\n") == expected
        assert repo.run("ls-files", "-u", "--", path).stdout


def test_rename_action_only_accepts_a_side_present_for_that_path(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("conflict-action-rename")
    repo.write("old.txt", "base\n")
    repo.commit("rename base", "old.txt")
    repo.run("switch", "-c", "side")
    repo.run("mv", "old.txt", "side.txt")
    repo.run("commit", "-m", "side rename")
    repo.run("switch", "main")
    repo.run("mv", "old.txt", "main.txt")
    repo.run("commit", "-m", "main rename")
    assert repo.run("merge", "side", check=False).returncode != 0
    app = _app(tmp_path / "rename-data")
    with TestClient(app) as client:
        repository_id = _discover(client, repo, "workspace-rename-action")
        files = _conflicts(
            client, repo, repository_id, "workspace-rename-action"
        )["files"]
        ours_file = next(
            file for file in files if any(stage["stage"] == 2 for stage in file["stages"])
        )
        action = _action_payload(
            repo, repository_id, "workspace-rename-action", ours_file
        )
        accepted = _confirmed_action(client, repository_id, action)
        missing_theirs = {
            **action,
            "idempotency_key": "rename-missing-side-key",
            "action": "accept_theirs",
            "confirmation_token": None,
        }
        confirmation = client.post(
            "/api/git/confirmations",
            json={"command": "conflict_action", "payload": missing_theirs},
        )
        assert confirmation.status_code == 200
        missing_theirs["confirmation_token"] = confirmation.json()["token"]
        rejected = client.post(
            f"/api/git/repositories/{repository_id}/conflicts/action",
            json=missing_theirs,
        )

    assert accepted["state"] == "succeeded"
    assert rejected.status_code == 422


def _app(data_dir: Path) -> FastAPI:
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=data_dir)
    app.include_router(router)
    return app


def _discover(client: TestClient, repo, workspace_id: str) -> str:
    response = client.post(
        "/api/git/repositories/discover",
        json={"workspace_id": workspace_id, "project_root": str(repo.path)},
    )
    assert response.status_code == 200
    return response.json()["repositories"][0]["id"]


def _conflicts(client: TestClient, repo, repository_id: str, workspace_id: str) -> dict:
    response = client.get(
        f"/api/git/repositories/{repository_id}/conflicts",
        params={"workspace_id": workspace_id, "project_root": str(repo.path)},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _action_payload(repo, repository_id: str, workspace_id: str, conflict: dict) -> dict:
    return {
        "workspace_id": workspace_id,
        "project_root": str(repo.path),
        "repository_id": repository_id,
        "idempotency_key": "accept-conflict-key",
        "expected_repository_version": None,
        "confirmation_token": None,
        "action": "accept_ours",
        "path": conflict["path"],
        "expected_stages": [
            {
                "stage": stage["stage"],
                "object_id": stage["object_id"],
                "mode": stage["mode"],
            }
            for stage in conflict["stages"]
        ],
        "resolved_index_entry": None,
    }


def _confirmed_action(client: TestClient, repository_id: str, payload: dict) -> dict:
    confirmation = client.post(
        "/api/git/confirmations",
        json={"command": "conflict_action", "payload": payload},
    )
    assert confirmation.status_code == 200, confirmation.text
    payload = {**payload, "confirmation_token": confirmation.json()["token"]}
    return _action(client, repository_id, payload)


def _action(client: TestClient, repository_id: str, payload: dict) -> dict:
    response = client.post(
        f"/api/git/repositories/{repository_id}/conflicts/action", json=payload
    )
    assert response.status_code == 200, response.text
    operation_id = response.json()["operation_id"]
    for _ in range(200):
        result = client.get(f"/api/git/operations/{operation_id}").json()
        if result["state"] in {"succeeded", "failed", "cancelled"}:
            return result
        time.sleep(0.01)
    raise AssertionError("Conflict action did not finish")
