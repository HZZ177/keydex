from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.git import router
from backend.app.git.access import GitAncestorGrantStore
from backend.app.git.query_service import GitQueryService
from backend.tests.git.conftest import GitRepoFactory


def test_merge_preview_and_fast_forward_no_ff_and_squash_strategies(tmp_path: Path) -> None:
    factory = GitRepoFactory(tmp_path)

    fast_forward = factory.create("merge-ff")
    fast_forward.run("switch", "-c", "topic")
    fast_forward.write("topic.txt", "topic\n")
    topic_oid = fast_forward.commit("topic", "topic.txt")
    fast_forward.run("switch", "main")
    with _client(tmp_path / "ff-data") as client:
        repository_id, scope = _discover(client, fast_forward, "workspace-merge-ff")
        preview = client.get(
            f"/api/git/repositories/{repository_id}/merge-preview",
            params={**scope, "source": "topic"},
        )
        assert preview.status_code == 200
        assert preview.json()["fast_forward"] is True
        assert preview.json()["incoming_commits"] == 1
        merged = _submit_merge(client, fast_forward, repository_id, scope, "merge-ff-key", "topic")
        assert merged["state"] == "succeeded"
    assert fast_forward.run("rev-parse", "HEAD").stdout.strip() == topic_oid

    no_ff = factory.create("merge-no-ff")
    no_ff.run("switch", "-c", "topic")
    no_ff.write("topic.txt", "topic\n")
    no_ff.commit("topic", "topic.txt")
    no_ff.run("switch", "main")
    no_ff.write("main.txt", "main\n")
    no_ff.commit("main", "main.txt")
    with _client(tmp_path / "no-ff-data") as client:
        repository_id, scope = _discover(client, no_ff, "workspace-merge-no-ff")
        merged = _submit_merge(
            client,
            no_ff,
            repository_id,
            scope,
            "merge-no-ff-key",
            "topic",
            strategy="no_ff",
            message="Merge topic with Keydex",
        )
        assert merged["state"] == "succeeded"
    assert len(no_ff.run("show", "-s", "--format=%P", "HEAD").stdout.split()) == 2
    subject = no_ff.run("show", "-s", "--format=%s", "HEAD").stdout.strip()
    assert subject == "Merge topic with Keydex"

    squash = factory.create("merge-squash")
    base_oid = squash.run("rev-parse", "HEAD").stdout.strip()
    squash.run("switch", "-c", "topic")
    squash.write("squashed.txt", "squashed\n")
    squash.commit("squashed", "squashed.txt")
    squash.run("switch", "main")
    with _client(tmp_path / "squash-data") as client:
        repository_id, scope = _discover(client, squash, "workspace-merge-squash")
        result = _submit_merge(
            client,
            squash,
            repository_id,
            scope,
            "merge-squash-key",
            "topic",
            strategy="squash",
        )
        assert result["state"] == "succeeded"
    assert squash.run("rev-parse", "HEAD").stdout.strip() == base_oid
    assert squash.run("diff", "--cached", "--name-only").stdout.strip() == "squashed.txt"


def test_merge_conflict_is_recoverable_and_abort_restores_idle_state(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("merge-conflict")
    repo.write("conflict.txt", "base\n")
    repo.commit("base conflict", "conflict.txt")
    repo.run("switch", "-c", "topic")
    repo.write("conflict.txt", "topic\n")
    repo.commit("topic conflict", "conflict.txt")
    repo.run("switch", "main")
    repo.write("conflict.txt", "main\n")
    repo.commit("main conflict", "conflict.txt")

    with _client(tmp_path / "conflict-data") as client:
        repository_id, scope = _discover(client, repo, "workspace-merge-conflict")
        failed = _submit_merge(
            client,
            repo,
            repository_id,
            scope,
            "merge-conflict-key",
            "topic",
        )
        assert failed["state"] == "failed"
        status = client.get(f"/api/git/repositories/{repository_id}/status", params=scope).json()
        assert status["operation"]["kind"] == "merge"
        assert status["operation"]["state"] == "conflicted"

        abort_payload = _payload(repo, repository_id, scope, "merge-abort-key")
        confirmation = client.post(
            "/api/git/confirmations",
            json={"command": "merge_abort", "payload": abort_payload},
        )
        assert confirmation.status_code == 200
        abort_payload["confirmation_token"] = confirmation.json()["token"]
        abort = client.post(
            f"/api/git/repositories/{repository_id}/merge/abort",
            json=abort_payload,
        )
        assert _wait(client, abort.json()["operation_id"])["state"] == "succeeded"
        clean = client.get(f"/api/git/repositories/{repository_id}/status", params=scope).json()
        assert clean["operation"] is None
        assert clean["files"] == []


def _client(data_dir: Path) -> TestClient:
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=data_dir)
    app.state.git_query_service = GitQueryService(
        grants=GitAncestorGrantStore(data_dir / "grants.json")
    )
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
    return {
        **scope,
        "repository_id": repository_id,
        "idempotency_key": key,
        **values,
    }


def _submit_merge(
    client: TestClient,
    repo,
    repository_id: str,
    scope: dict[str, str],
    key: str,
    source: str,
    *,
    strategy: str = "ff",
    message: str | None = None,
) -> dict:
    response = client.post(
        f"/api/git/repositories/{repository_id}/merge",
        json=_payload(
            repo,
            repository_id,
            scope,
            key,
            source=source,
            strategy=strategy,
            message=message,
        ),
    )
    assert response.status_code == 200
    return _wait(client, response.json()["operation_id"])


def _wait(client: TestClient, operation_id: str) -> dict:
    for _ in range(200):
        payload = client.get(f"/api/git/operations/{operation_id}").json()
        if payload["state"] in {"succeeded", "failed", "cancelled"}:
            return payload
        time.sleep(0.01)
    raise AssertionError("Git operation did not finish")
