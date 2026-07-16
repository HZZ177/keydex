from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.git import router
from backend.tests.git.conftest import GitRepoFactory


def test_worktree_full_lifecycle_requires_exact_external_grant_and_dirty_confirmation(
    tmp_path: Path,
) -> None:
    repo = GitRepoFactory(tmp_path).create("worktree-parent")
    external_parent = tmp_path / "external-worktrees"
    external_parent.mkdir()
    target = external_parent / "topic"
    unauthorized_target = external_parent / "not-granted"
    data_dir = tmp_path / "worktree-data"

    with _client(data_dir) as client:
        repository_id, scope = _discover(client, repo)
        initial = _state(client, repository_id, scope)
        assert len(initial["worktrees"]) == 1
        assert initial["worktrees"][0]["primary"] is True
        assert initial["worktrees"][0]["authorized"] is True

        denied = _post_action(
            client,
            repository_id,
            _payload(
                repository_id,
                scope,
                "worktree-unauthorized-add",
                action="add",
                worktree_path=str(unauthorized_target),
                revision="HEAD",
                new_branch="topic/unauthorized",
            ),
        )
        assert denied.status_code == 403
        assert denied.json()["detail"]["code"] == "git_access_denied"
        assert not unauthorized_target.exists()

        granted = client.post(
            "/api/git/repositories/worktree-grants",
            json={**scope, "repository_id": repository_id, "worktree_path": str(target)},
        )
        assert granted.status_code == 200, granted.text
        assert granted.json()["scope"] == "git_worktree"
        assert granted.json()["parent_repository_id"] == repository_id
        assert granted.json()["worktree_path"] == str(target)

        added = _wait_action(
            client,
            repository_id,
            _payload(
                repository_id,
                scope,
                "worktree-add",
                action="add",
                worktree_path=str(target),
                revision="HEAD",
                new_branch="topic/worktree",
            ),
        )
        assert added["state"] == "succeeded"
        assert target.is_dir()

        listed = _state(client, repository_id, scope)["worktrees"]
        external = next(item for item in listed if Path(item["path"]) == target)
        assert external["primary"] is False
        assert external["authorization_required"] is True
        assert external["authorized"] is True
        assert external["dirty"] is False
        assert external["branch"] == "refs/heads/topic/worktree"

        locked = _wait_action(
            client,
            repository_id,
            _payload(
                repository_id,
                scope,
                "worktree-lock",
                action="lock",
                worktree_path=str(target),
                lock_reason="owned by Keydex",
            ),
        )
        assert locked["state"] == "succeeded"
        assert next(
            item for item in _state(client, repository_id, scope)["worktrees"]
            if Path(item["path"]) == target
        )["locked_reason"] == "owned by Keydex"
        assert _wait_action(
            client,
            repository_id,
            _payload(
                repository_id,
                scope,
                "worktree-unlock",
                action="unlock",
                worktree_path=str(target),
            ),
        )["state"] == "succeeded"

        (target / "dirty.txt").write_text("uncommitted\n", encoding="utf-8")
        remove_payload = _payload(
            repository_id,
            scope,
            "worktree-remove",
            action="remove",
            worktree_path=str(target),
            force=True,
            dirty_confirmed=False,
        )
        dirty_denied = _post_action(client, repository_id, remove_payload)
        assert dirty_denied.status_code == 409
        assert "dirty confirmation" in dirty_denied.json()["detail"]["message"].lower()

        confirmed_payload = {**remove_payload, "dirty_confirmed": True}
        destructive_denied = _post_action(client, repository_id, confirmed_payload)
        assert destructive_denied.status_code == 409
        assert "confirmation token" in destructive_denied.json()["detail"]["message"].lower()
        removed = _confirmed_action(client, repository_id, confirmed_payload)
        assert removed["state"] == "succeeded"
        assert not target.exists()

        pruned = _confirmed_action(
            client,
            repository_id,
            _payload(repository_id, scope, "worktree-prune", action="prune"),
        )
        assert pruned["state"] == "succeeded"

    # The exact grant survives service/app reconstruction, but never grants a sibling path.
    with _client(data_dir) as client:
        repository_id, scope = _discover(client, repo)
        exact_reused = client.post(
            "/api/git/repositories/worktree-grants",
            json={**scope, "repository_id": repository_id, "worktree_path": str(target)},
        )
        assert exact_reused.status_code == 200
        sibling_denied = _post_action(
            client,
            repository_id,
            _payload(
                repository_id,
                scope,
                "worktree-sibling-denied",
                action="add",
                worktree_path=str(unauthorized_target),
                revision="HEAD",
                new_branch="topic/sibling",
            ),
        )
        assert sibling_denied.status_code == 403


def test_primary_worktree_cannot_be_removed(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("worktree-primary")
    with _client(tmp_path / "data") as client:
        repository_id, scope = _discover(client, repo)
        response = _post_action(
            client,
            repository_id,
            _payload(
                repository_id,
                scope,
                "worktree-primary-remove",
                action="remove",
                worktree_path=str(repo.path),
                force=True,
                dirty_confirmed=True,
            ),
        )
        assert response.status_code == 422
        assert "primary worktree" in response.json()["detail"]["message"].lower()


def _client(data_dir: Path) -> TestClient:
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=data_dir)
    app.include_router(router)
    return TestClient(app)


def _discover(client: TestClient, repo) -> tuple[str, dict[str, str]]:
    scope = {"workspace_id": "workspace-worktree", "project_root": str(repo.path)}
    response = client.post("/api/git/repositories/discover", json=scope)
    assert response.status_code == 200, response.text
    return response.json()["repositories"][0]["id"], scope


def _payload(repository_id: str, scope: dict[str, str], key: str, **values) -> dict:
    return {**scope, "repository_id": repository_id, "idempotency_key": key, **values}


def _state(client: TestClient, repository_id: str, scope: dict[str, str]) -> dict:
    response = client.get(f"/api/git/repositories/{repository_id}/worktrees", params=scope)
    assert response.status_code == 200, response.text
    return response.json()


def _post_action(client: TestClient, repository_id: str, payload: dict):
    return client.post(f"/api/git/repositories/{repository_id}/worktrees/action", json=payload)


def _wait_action(client: TestClient, repository_id: str, payload: dict) -> dict:
    response = _post_action(client, repository_id, payload)
    assert response.status_code == 200, response.text
    operation_id = response.json()["operation_id"]
    for _ in range(400):
        result = client.get(f"/api/git/operations/{operation_id}").json()
        if result["state"] in {"succeeded", "failed", "cancelled"}:
            return result
        time.sleep(0.01)
    raise AssertionError("Worktree action did not finish")


def _confirmed_action(client: TestClient, repository_id: str, payload: dict) -> dict:
    confirmation = client.post(
        "/api/git/confirmations",
        json={"command": "worktree_action", "payload": payload},
    )
    assert confirmation.status_code == 200, confirmation.text
    return _wait_action(
        client,
        repository_id,
        {**payload, "confirmation_token": confirmation.json()["token"]},
    )
