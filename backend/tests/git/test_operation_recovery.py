from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.git import router
from backend.tests.git.conftest import GitRepoFactory


def test_new_service_instances_recover_all_persisted_operation_kinds(tmp_path: Path) -> None:
    factory = GitRepoFactory(tmp_path)
    cases = [
        (_merge_conflict(factory), "merge", "conflicted"),
        (_cherry_pick_conflict(factory), "cherry_pick", "conflicted"),
        (_revert_conflict(factory), "revert", "conflicted"),
        (_rebase_conflict(factory), "rebase", "conflicted"),
        (_stash_conflict(factory), "stash_apply", "conflicted"),
        (_bisect_running(factory), "bisect", "running"),
    ]
    for index, (repo, expected_kind, expected_state) in enumerate(cases):
        first = _status_from_new_app(
            tmp_path / f"recovery-data-{index}-a", repo, f"workspace-{index}"
        )
        second = _status_from_new_app(
            tmp_path / f"recovery-data-{index}-b", repo, f"workspace-{index}"
        )
        assert first["operation"]["kind"] == expected_kind
        assert first["operation"]["state"] == expected_state
        assert second["operation"] == first["operation"]


def _merge_conflict(factory: GitRepoFactory):
    repo = factory.create("recover-merge")
    repo.create_conflict()
    return repo


def _cherry_pick_conflict(factory: GitRepoFactory):
    repo = factory.create("recover-cherry")
    repo.write("conflict.txt", "base\n")
    repo.commit("base", "conflict.txt")
    repo.run("switch", "-c", "source")
    repo.write("conflict.txt", "source\n")
    source_oid = repo.commit("source", "conflict.txt")
    repo.run("switch", "main")
    repo.write("conflict.txt", "main\n")
    repo.commit("main", "conflict.txt")
    assert repo.run("cherry-pick", source_oid, check=False).returncode != 0
    return repo


def _revert_conflict(factory: GitRepoFactory):
    repo = factory.create("recover-revert")
    repo.write("conflict.txt", "base\n")
    repo.commit("base", "conflict.txt")
    repo.write("conflict.txt", "target\n")
    target_oid = repo.commit("target", "conflict.txt")
    repo.write("conflict.txt", "later\n")
    repo.commit("later", "conflict.txt")
    assert repo.run("revert", "--no-edit", target_oid, check=False).returncode != 0
    return repo


def _rebase_conflict(factory: GitRepoFactory):
    repo = factory.create("recover-rebase")
    repo.write("conflict.txt", "base\n")
    repo.commit("base", "conflict.txt")
    repo.run("switch", "-c", "topic")
    repo.write("conflict.txt", "topic\n")
    repo.commit("topic", "conflict.txt")
    repo.run("switch", "main")
    repo.write("conflict.txt", "main\n")
    repo.commit("main", "conflict.txt")
    repo.run("switch", "topic")
    assert repo.run("rebase", "main", check=False).returncode != 0
    return repo


def _stash_conflict(factory: GitRepoFactory):
    repo = factory.create("recover-stash")
    repo.write("conflict.txt", "base\n")
    repo.commit("base", "conflict.txt")
    repo.write("conflict.txt", "stash\n")
    repo.run("stash", "push", "-m", "recovery stash")
    repo.write("conflict.txt", "current\n")
    repo.commit("current", "conflict.txt")
    assert repo.run("stash", "apply", check=False).returncode != 0
    return repo


def _bisect_running(factory: GitRepoFactory):
    repo = factory.create("recover-bisect")
    good_oid = repo.run("rev-parse", "HEAD").stdout.strip()
    for index in range(4):
        repo.write("bisect.txt", f"{index}\n")
        repo.commit(f"bisect {index}", "bisect.txt")
    repo.run("bisect", "start")
    repo.run("bisect", "bad", "HEAD")
    repo.run("bisect", "good", good_oid)
    return repo


def _status_from_new_app(data_dir: Path, repo, workspace_id: str) -> dict:
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=data_dir)
    app.include_router(router)
    with TestClient(app) as client:
        discovery = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": workspace_id, "project_root": str(repo.path)},
        ).json()
        repository_id = discovery["repositories"][0]["id"]
        return client.get(
            f"/api/git/repositories/{repository_id}/status",
            params={"workspace_id": workspace_id, "project_root": str(repo.path)},
        ).json()
