from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.git import router
from backend.tests.git.conftest import GitRepoFactory


def test_submodule_status_deinit_init_update_sync_and_redaction(tmp_path: Path) -> None:
    factory = GitRepoFactory(tmp_path)
    child = factory.create("submodule-child")
    child.write("child.txt", "child\n")
    child.commit("child content", "child.txt")
    parent = factory.create("submodule-parent")
    parent.run("config", "protocol.file.allow", "always")
    parent.run(
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        str(child.path),
        "modules/child",
    )
    parent.commit("add submodule", ".gitmodules", "modules/child")

    with _client(tmp_path / "submodule-data") as client:
        repository_id, scope = _discover(client, parent, "workspace-submodule")
        initial = _state(client, repository_id, scope)
        assert len(initial["submodules"]) == 1
        module = initial["submodules"][0]
        assert module["path"] == "modules/child"
        assert module["parent_repository_id"] == repository_id
        assert module["child_root_path"] == str(parent.path / "modules" / "child")
        assert module["initialized"] is True

        deinit_payload = _payload(
            repository_id,
            scope,
            "submodule-deinit-key",
            action="deinit",
            paths=["modules/child"],
            recursive=False,
            force=True,
        )
        rejected = client.post(
            f"/api/git/repositories/{repository_id}/submodules/action",
            json=deinit_payload,
        )
        assert rejected.status_code == 409
        deinitialized = _confirmed_action(client, repository_id, deinit_payload)
        assert deinitialized["state"] == "succeeded"
        assert _state(client, repository_id, scope)["submodules"][0]["state"] == "uninitialized"

        initialized = _action(
            client,
            repository_id,
            _payload(
                repository_id,
                scope,
                "submodule-init-key",
                action="init",
                paths=["modules/child"],
                recursive=False,
                force=False,
            ),
        )
        assert initialized["state"] == "succeeded"
        updated = _action(
            client,
            repository_id,
            _payload(
                repository_id,
                scope,
                "submodule-update-key",
                action="update",
                paths=["modules/child"],
                recursive=False,
                force=False,
            ),
        )
        assert updated["state"] == "succeeded"
        assert (parent.path / "modules" / "child" / "child.txt").is_file()

        recursive_sync = _payload(
            repository_id,
            scope,
            "submodule-sync-recursive-key",
            action="sync",
            paths=["modules/child"],
            recursive=True,
            force=False,
        )
        synced = _confirmed_action(client, repository_id, recursive_sync)
        assert synced["state"] == "succeeded"

    parent.run(
        "config",
        "--file",
        ".gitmodules",
        "submodule.modules/child.url",
        "https://user:secret@example.invalid/repo.git",
    )
    parent.run("add", ".gitmodules")
    with _client(tmp_path / "submodule-redaction-data") as client:
        repository_id, scope = _discover(client, parent, "workspace-submodule-redaction")
        redacted = _state(client, repository_id, scope)["submodules"][0]["url"]
    assert redacted == "https://***:***@example.invalid/repo.git"
    assert "secret" not in redacted


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
    return {**scope, "repository_id": repository_id, "idempotency_key": key, **values}


def _state(client: TestClient, repository_id: str, scope: dict[str, str]) -> dict:
    response = client.get(
        f"/api/git/repositories/{repository_id}/submodules", params=scope
    )
    assert response.status_code == 200, response.text
    return response.json()


def _confirmed_action(client: TestClient, repository_id: str, payload: dict) -> dict:
    confirmation = client.post(
        "/api/git/confirmations",
        json={"command": "submodule_action", "payload": payload},
    )
    assert confirmation.status_code == 200, confirmation.text
    return _action(
        client,
        repository_id,
        {**payload, "confirmation_token": confirmation.json()["token"]},
    )


def _action(client: TestClient, repository_id: str, payload: dict) -> dict:
    response = client.post(
        f"/api/git/repositories/{repository_id}/submodules/action", json=payload
    )
    assert response.status_code == 200, response.text
    operation_id = response.json()["operation_id"]
    for _ in range(400):
        result = client.get(f"/api/git/operations/{operation_id}").json()
        if result["state"] in {"succeeded", "failed", "cancelled"}:
            return result
        time.sleep(0.01)
    raise AssertionError("Submodule action did not finish")
