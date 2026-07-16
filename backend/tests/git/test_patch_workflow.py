from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.git import router
from backend.tests.git.conftest import GitRepoFactory


def test_exports_worktree_index_commit_range_and_selected_paths(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("patch-export")
    base_oid = repo.run("rev-parse", "HEAD").stdout.strip()
    repo.write("one.txt", "one\n")
    first_oid = repo.commit("add one", "one.txt")
    repo.write("two.txt", "two\n")
    second_oid = repo.commit("add two", "two.txt")
    repo.write("one.txt", "one worktree\n")
    repo.write("two.txt", "two index\n")
    repo.run("add", "--", "two.txt")

    with _client(tmp_path / "patch-export-data") as client:
        repository_id, scope = _discover(client, repo, "workspace-patch-export")
        worktree = _export(client, repository_id, scope, "working_tree", paths=["one.txt"])
        index = _export(client, repository_id, scope, "index", paths=["two.txt"])
        commit = _export(client, repository_id, scope, "commit", left=first_oid)
        range_patch = _export(
            client,
            repository_id,
            scope,
            "range",
            left=base_oid,
            right=second_oid,
            paths=["one.txt"],
        )

    assert "one worktree" in worktree["patch"]
    assert "two.txt" not in worktree["patch"]
    assert "two index" in index["patch"]
    assert "Subject: [PATCH] add one" in commit["patch"]
    assert "one.txt" in range_patch["patch"]
    assert "two.txt" not in range_patch["patch"]
    assert commit["filename"].startswith("keydex-commit-")
    assert commit["filename"].endswith(".patch")


def test_patch_dry_run_precedes_cached_apply_and_reverse(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("patch-apply")
    repo.write("apply.txt", "old\n")
    repo.commit("add apply file", "apply.txt")
    patch = _single_file_patch("apply.txt", "old", "new")

    with _client(tmp_path / "patch-apply-data") as client:
        repository_id, scope = _discover(client, repo, "workspace-patch-apply")
        check = _apply(
            client,
            repository_id,
            scope,
            "patch-check",
            patch,
            cached=True,
            reverse=False,
            check_only=True,
            reject=False,
        )
        assert check["state"] == "succeeded"
        assert check["result"]["check_only"] is True
        assert repo.run("show", ":apply.txt").stdout == "old\n"
        applied = _apply(
            client,
            repository_id,
            scope,
            "patch-apply",
            patch,
            cached=True,
            reverse=False,
            check_only=False,
            reject=False,
        )
        assert applied["state"] == "succeeded"
        assert repo.run("show", ":apply.txt").stdout == "new\n"
        reversed_result = _apply(
            client,
            repository_id,
            scope,
            "patch-reverse",
            patch,
            cached=True,
            reverse=True,
            check_only=False,
            reject=False,
        )
        assert reversed_result["state"] == "succeeded"
        assert repo.run("show", ":apply.txt").stdout == "old\n"


def test_failed_dry_run_is_atomic_and_reject_mode_exposes_partial_reject_files(
    tmp_path: Path,
) -> None:
    repo = GitRepoFactory(tmp_path).create("patch-reject")
    repo.write("good.txt", "old\n")
    repo.write("bad.txt", "current\n")
    repo.commit("patch targets", "good.txt", "bad.txt")
    patch = _single_file_patch("good.txt", "old", "new") + _single_file_patch(
        "bad.txt", "old", "new"
    )

    with _client(tmp_path / "patch-reject-data") as client:
        repository_id, scope = _discover(client, repo, "workspace-patch-reject")
        dry_run = _apply(
            client,
            repository_id,
            scope,
            "patch-reject-check",
            patch,
            cached=False,
            reverse=False,
            check_only=True,
            reject=False,
        )
        assert dry_run["state"] == "failed"
        assert (repo.path / "good.txt").read_text(encoding="utf-8") == "old\n"
        assert not (repo.path / "bad.txt.rej").exists()

        rejected = _apply(
            client,
            repository_id,
            scope,
            "patch-reject-apply",
            patch,
            cached=False,
            reverse=False,
            check_only=False,
            reject=True,
        )
        assert rejected["state"] == "failed"
        status = client.get(f"/api/git/repositories/{repository_id}/status", params=scope).json()

    assert (repo.path / "good.txt").read_text(encoding="utf-8") == "new\n"
    assert (repo.path / "bad.txt").read_text(encoding="utf-8") == "current\n"
    assert (repo.path / "bad.txt.rej").exists()
    assert any(file["path"] == "bad.txt.rej" for file in status["files"])


def _single_file_patch(path: str, old: str, new: str) -> str:
    return (
        f"diff --git a/{path} b/{path}\n"
        f"--- a/{path}\n"
        f"+++ b/{path}\n"
        "@@ -1 +1 @@\n"
        f"-{old}\n"
        f"+{new}\n"
    )


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


def _export(client: TestClient, repository_id: str, scope: dict, mode: str, **params) -> dict:
    response = client.get(
        f"/api/git/repositories/{repository_id}/patch-export",
        params={**scope, "mode": mode, **params},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _apply(
    client: TestClient,
    repository_id: str,
    scope: dict,
    key: str,
    patch: str,
    **options,
) -> dict:
    response = client.post(
        f"/api/git/repositories/{repository_id}/patch",
        json={
            **scope,
            "repository_id": repository_id,
            "idempotency_key": key,
            "patch": patch,
            **options,
        },
    )
    assert response.status_code == 200, response.text
    return _wait(client, response.json()["operation_id"])


def _wait(client: TestClient, operation_id: str) -> dict:
    for _ in range(300):
        payload = client.get(f"/api/git/operations/{operation_id}").json()
        if payload["state"] in {"succeeded", "failed", "cancelled"}:
            return payload
        time.sleep(0.01)
    raise AssertionError("Git operation did not finish")
